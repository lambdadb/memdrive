#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import { fileToolGuide, fileToolGuideTopics } from '@functional-systems/memdrive';
import { createHost } from './host.mjs';
import { prepareScenario, scenarios, evaluate } from './scenarios.mjs';
import { runAgent, openAI, AgentFailure, agentFailureCodes, protocol, limits, serverInstructions, workflowInstructions, userReminder } from './agent.mjs';
import { scriptedAgent } from './scripted.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = value => createHash('sha256').update(value).digest('hex');
const writeJSON = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
async function fingerprint(directory) {
    const result = {};
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) Object.assign(result, await fingerprint(file));
        else result[path.relative(root, file)] = hash(await readFile(file));
    }
    return result;
}
export function summarize(manifest, cases) {
    const groups = {};
    for (const result of cases) {
        const group = groups[result.guide] ??= { attempted: 0, passed: 0, failed: 0, errors: 0, modelResponses: 0, unknownUsageRequests: 0, inputTokens: 0, outputTokens: 0 };
        group.attempted++;
        group[result.status === 'passed' ? 'passed' : result.status === 'failed' ? 'failed' : 'errors']++;
        group.modelResponses += manifest.transport === 'openai-responses' ? result.receipts.filter(item => item.status === 'completed').length : 0;
        for (const receipt of result.receipts) {
            const usage = receipt.response?.usage;
            if (!Number.isSafeInteger(usage?.input_tokens) || usage.input_tokens < 0 || !Number.isSafeInteger(usage?.output_tokens) || usage.output_tokens < 0) group.unknownUsageRequests++;
            else { group.inputTokens += usage.input_tokens; group.outputTokens += usage.output_tokens; }
        }
    }
    const passed = cases.filter(item => item.status === 'passed').length;
    return { protocol, mode: manifest.mode, transport: manifest.transport, backend: 'native-client-fixture', instruction: manifest.instruction,
        planned: manifest.plan.length, attempted: cases.length, complete: cases.length === manifest.plan.length,
        passed, failed: cases.filter(item => item.status === 'failed').length, errors: cases.filter(item => item.status === 'error').length,
        modelTasksPassed: manifest.transport === 'openai-responses' ? passed : null,
        scriptedSmokePassed: manifest.mode === 'scripted' ? passed : null, groups,
        limitations: ['Synthetic six-scenario task checks with literal final-answer checks, not general model quality or a semantic judge.',
            'Real public SDK on an immediate-visibility native-client fixture; not live LambdaDB retrieval or consistency.',
            'Resource content is fetched and injected by the host, not autonomously fetched by the model.',
            'No MCP wire server/client compatibility, bundled-skill discovery, or automatic conflict resolution is tested.'] };
}

export async function runEvaluation({ output, mode = 'model', guide = 'all', instruction = 'server', scenario = 'all', repeats = 1,
    model = 'gpt-6.1-sol', key, askFactory, prepare = prepareScenario }) {
    assert(['model', 'scripted'].includes(mode), 'Invalid mode');
    assert(['all', 'none', 'tool', 'resource'].includes(guide), 'Invalid guide delivery');
    assert(['server', 'workflow', 'user'].includes(instruction), 'Invalid instruction profile');
    assert(Number.isInteger(repeats) && repeats >= 1 && repeats <= 5, 'repeats must be 1..5');
    assert(typeof model === 'string' && model.length > 0 && model.length <= 100, 'Invalid model');
    const selected = scenario === 'all' ? scenarios : scenarios.filter(item => item.id === scenario);
    assert(selected.length, 'Unknown scenario');
    // Validate credentials before creating an artifact directory or any SDK state.
    const modelAsk = mode === 'model' && !askFactory ? openAI({ key }) : undefined;
    const guides = guide === 'all' ? ['none', 'tool', 'resource'] : [guide];
    const plan = [];
    for (let repetition = 0; repetition < repeats; repetition++) for (const item of selected) for (const delivery of guides)
        plan.push({ id: `${String(plan.length + 1).padStart(3, '0')}-${item.id}-${delivery}`, scenario: item.id, guide: delivery, repetition });
    const sources = { ...await fingerprint(path.join(root, 'benchmark/tool-use')), ...await fingerprint(path.join(root, 'dist/esm')),
        'test/helpers/file-client.mjs': hash(await readFile(path.join(root, 'test/helpers/file-client.mjs'))),
        'package-lock.json': hash(await readFile(path.join(root, 'package-lock.json'))) };
    const manifest = { protocol, mode, transport: askFactory ? 'injected-test' : mode === 'model' ? 'openai-responses' : 'scripted', model, instruction, plan, limits, startedAt: new Date().toISOString(),
        node: process.version, backend: 'native-client-fixture', package: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')),
        sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        sources, guide: fileToolGuide, guideTopics: fileToolGuideTopics, prompts: { serverInstructions, workflowInstructions, userReminder }, scenarios };
    output = path.resolve(output);
    await mkdir(path.dirname(output), { recursive: true });
    await mkdir(output); // Existing runs cannot be overwritten or replayed as fresh measurements.
    await writeJSON(path.join(output, 'manifest.json'), manifest);
    const results = [];
    for (const entry of plan) {
        const directory = path.join(output, entry.id);
        await mkdir(directory);
        const result = { ...entry, status: 'error', stage: 'prepare', receipts: [], cleanup: 'not_started' };
        let context, host, signal;
        try {
            context = await prepare(entry.scenario);
            result.initial = context.initial;
            host = createHost({ drive: context.drive, client: context.client, writable: context.scenario.writable,
                guide: entry.guide, rebindFork: context.scenario.rebindFork });
            const transport = askFactory ? askFactory(context.scenario, entry.guide)
                : mode === 'scripted' ? scriptedAgent(context.scenario, entry.guide) : modelAsk;
            signal = AbortSignal.timeout(900_000);
            const ask = async (request, options) => {
                const receipt = { round: options.round, status: 'pending', request };
                const file = path.join(directory, `request-${options.round}.json`);
                result.receipts.push(receipt);
                await writeJSON(file, receipt);
                try {
                    receipt.response = await transport(request, options);
                    receipt.status = 'completed';
                } catch (error) {
                    receipt.status = 'failed_or_uncertain';
                    receipt.error = error.code === 'MODEL_HTTP_ERROR' && Number.isInteger(error.status)
                        ? { code: 'MODEL_HTTP_ERROR', status: error.status } : { code: 'REQUEST_FAILED' };
                    throw new AgentFailure(signal.aborted ? 'MODEL_PHASE_TIMEOUT' : 'MODEL_REQUEST_FAILED');
                } finally { await writeJSON(file, receipt); }
                return receipt.response;
            };
            result.stage = 'agent';
            result.agent = await runAgent({ host, scenario: context.scenario, ask, model, guide: entry.guide, instruction,
                signal });
            result.stage = 'evaluate';
            result.evaluation = await evaluate(context, host, result.agent.finalText);
            result.status = result.evaluation.passed ? 'passed' : 'failed';
        } catch (error) {
            let code = 'EVALUATION_ERROR';
            if (error instanceof AgentFailure && agentFailureCodes.includes(error.code)) code = error.code;
            else if (signal?.aborted && error === signal.reason) code = 'MODEL_PHASE_TIMEOUT';
            result.error = { code, message: 'Inspect the stage, request receipts and tool events; no automatic retry was attempted.' };
        } finally {
            result.events = host?.events ?? [];
            if (context) {
                try { await context.cleanup(); result.cleanup = 'completed'; }
                catch { result.cleanup = 'failed'; result.status = 'error'; }
            }
            await writeJSON(path.join(directory, 'result.json'), result);
            results.push(result);
            await writeJSON(path.join(output, 'summary.json'), summarize(manifest, results));
        }
    }
    return { manifest, results, summary: summarize(manifest, results) };
}

async function main() {
    const { values } = parseArgs({ options: Object.fromEntries(['output', 'mode', 'guide', 'instruction', 'scenario', 'repeats', 'model'].map(key => [key, { type: 'string' }])) });
    assert(values.output, 'Pass --output artifacts/tool-use/<new-run>');
    let local = {};
    try { local = parseEnv(await readFile(path.join(root, '.env.local'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const env = { ...local, ...process.env };
    const { summary } = await runEvaluation({ ...values, repeats: values.repeats === undefined ? 1 : Number(values.repeats), key: env.LLM_API_KEY });
    console.log(JSON.stringify(summary, null, 2));
    if (summary.failed || summary.errors) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
    main().catch(() => { console.error('Tool-use evaluation could not complete. Check arguments, LLM_API_KEY and run receipts; use a new output directory.'); process.exitCode = 1; });
