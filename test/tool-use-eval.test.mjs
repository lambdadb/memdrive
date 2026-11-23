import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileToolGuide } from '@functional-systems/memdrive';
import { createHost, guideURI } from '../benchmark/tool-use/host.mjs';
import { prepareScenario, scenarios, evaluate } from '../benchmark/tool-use/scenarios.mjs';
import { runAgent, openAI, limits } from '../benchmark/tool-use/agent.mjs';
import { scriptedAgent } from '../benchmark/tool-use/scripted.mjs';
import { runEvaluation } from '../benchmark/tool-use/run.mjs';
import { formatEvaluationSummary, readEvaluationReport } from '../benchmark/tool-use/report.mjs';

const final = (model, text = 'done') => ({ model, status: 'completed', usage: { input_tokens: 10, output_tokens: 5 },
    output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] }] });
const response = (model, output) => ({ ...final(model), output });
const call = (name, args, id = 'call-1') => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id });
const bindingNotices = request => request.input.filter(item => item.role === 'developer' && item.content.startsWith('Current host binding: '));
async function usingScenario(id, guide, run) {
    const context = await prepareScenario(id);
    const host = createHost({ drive: context.drive, client: context.client, writable: context.scenario.writable,
        rebindFork: context.scenario.rebindFork, guide });
    try { await run(context, host); } finally { await context.cleanup(); }
}

test('scripted smoke exercises actual SDK state across six scenarios and three guide channels', async () => {
    for (const scenario of scenarios) for (const guide of ['none', 'tool', 'resource'])
        await usingScenario(scenario.id, guide, async (context, host) => {
            const result = await runAgent({ host, scenario, guide, ask: scriptedAgent(scenario, guide) });
            const scored = await evaluate(context, host, result.finalText);
            assert(scored.passed, JSON.stringify({ scenario: scenario.id, guide, checks: scored.checks }));
            assert.equal(scored.behavior.guideCalls, guide === 'tool' ? 1 : 0);
            assert.equal(scored.behavior.resourceReadsByHost, guide === 'resource' ? 1 : 0);
        });
});

test('recall publishes consistent current retention while preserving the dated decision', async () => {
    await usingScenario('recall', 'none', async context => {
        assert.match((await context.main.read({ path: '/policy.md' })).content, /Retention is 42 days/);
        assert.match((await context.main.read({ path: '/faq.md' })).content, /Retention is 42 days/);
        assert.match((await context.main.read({ path: '/decisions/2026-01-01.md' })).content, /Retention was 30 days/);
    });
});

test('allowlists enforce read-only access and the host rebinds only a newly returned authorized fork', async () => {
    await usingScenario('recall', 'none', async (context, host) => {
        assert(!host.toolsList().tools.some(tool => tool.name === 'write'));
        assert.equal((await host.toolsCall('write', { op: 'delete', fileId: context.ids['/faq.md'] })).error.code, 'TOOL_NOT_ALLOWED');
        assert.equal((await host.toolsCall('fork', { name: 'escape' })).error.code, 'TOOL_NOT_ALLOWED');
    });
    await usingScenario('draft-checkpoint', 'tool', async (context, host) => {
        assert(!host.toolsList().tools.some(tool => tool.name === 'write'));
        const created = await host.toolsCall('fork', { name: 'trial' }, { expectedGeneration: 0 });
        assert.deepEqual(created, { name: context.name, at: { kind: 'fork', name: 'trial' } });
        assert.equal(host.binding.generation, 1);
        assert(host.toolsList().tools.some(tool => tool.name === 'write'));
        assert.equal((await host.toolsCall('write', { op: 'create', path: '/late', content: 'bad' }, { expectedGeneration: 0 })).error.code, 'BINDING_CHANGED');
        assert.equal((await host.toolsCall('read', { path: '/late' })), null);
        assert.equal((await host.toolsCall('fork', { name: 'other', store: 'escape' })).error.code, 'INVALID_INPUT');
    });
});

test('resource guide is unchanged SDK text and is recorded as host delivery, not a model tool call', async () => {
    await usingScenario('recall', 'resource', async (_, host) => {
        assert.equal(host.resourcesList().resources[0].uri, guideURI);
        const read = host.resourcesRead(guideURI);
        assert.equal(read.version, fileToolGuide.version);
        assert.equal(read.contents[0].text, fileToolGuide.content);
        assert.throws(() => host.resourcesRead('memdrive://other'));
        assert.equal(host.events[0].actor, 'host');
        assert(!host.toolsList().tools.some(tool => tool.name === 'guide'));
    });
});

test('model continuation preserves reasoning items and message phases and delivers actionable invalid JSON', async () => {
    await usingScenario('recall', 'none', async (context, host) => {
        let round = 0;
        const opaque = { type: 'reasoning', id: 'reason', encrypted_content: 'opaque-test', summary: [] };
        const ask = async request => {
            assert.equal(request.store, false);
            assert.deepEqual(request.include, ['reasoning.encrypted_content']);
            assert.deepEqual(bindingNotices(request), [request.input[2]]);
            if (round++ === 0) return response(request.model, [opaque,
                { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking.' }] },
                { ...call('read', {}), arguments: '{broken' }]);
            assert.deepEqual(request.input.find(item => item.type === 'reasoning'), opaque);
            assert.equal(request.input.find(item => item.phase === 'commentary').phase, 'commentary');
            assert.equal(JSON.parse(request.input.find(item => item.type === 'function_call_output').output).error.code, 'INVALID_JSON');
            return final(request.model);
        };
        await runAgent({ host, scenario: context.scenario, guide: 'none', ask });
        assert.equal(host.events[0].result.error.code, 'INVALID_JSON');
    });
});

test('binding changes are announced once and retained with stateless tool results', async () => {
    await usingScenario('draft-checkpoint', 'none', async (context, host) => {
        const requests = [];
        const script = scriptedAgent(context.scenario, 'none');
        const result = await runAgent({ host, scenario: context.scenario, guide: 'none', ask: async request => {
            requests.push(request);
            return script(request);
        } });
        const [mainRequest, forkRequest, afterCheckpoint] = requests;
        const mainNotice = { role: 'developer', content: 'Current host binding: ' + JSON.stringify({
            name: context.name, at: { kind: 'main' }, generation: 0,
        }) };
        const forkNotice = { role: 'developer', content: 'Current host binding: ' + JSON.stringify({
            name: context.name, at: { kind: 'fork', name: 'trial' }, generation: 1,
        }) };
        assert.deepEqual(bindingNotices(mainRequest), [mainNotice]);
        assert.equal(mainRequest.tools.some(tool => tool.name === 'write'), false);
        assert.equal(forkRequest.tools.some(tool => tool.name === 'write'), true);
        assert.deepEqual(forkRequest.input.at(-1), forkNotice);
        assert.deepEqual(JSON.parse(forkRequest.input.at(-2).output), { name: context.name, at: { kind: 'fork', name: 'trial' } });
        for (const request of requests.slice(1)) assert.deepEqual(bindingNotices(request), [mainNotice, forkNotice]);
        assert.deepEqual(JSON.parse(afterCheckpoint.input.at(-1).output), { name: context.name, at: { kind: 'checkpoint', name: 'before-edit' } });
        assert.equal((await evaluate(context, host, result.finalText)).passed, true);
    });
});

test('duplicate IDs, request budgets and incomplete model responses stop without extra mutations', async () => {
    await usingScenario('recall', 'none', async (context, host) => {
        let requests = 0;
        const ask = async request => { requests++; return response(request.model, [call('read', { path: '/faq.md' })]); };
        await assert.rejects(runAgent({ host, scenario: context.scenario, guide: 'none', ask }), /Duplicate/);
        assert.equal(host.events.filter(e => e.kind === 'tool').length, 1);
        assert.equal(requests, 2);
        requests = 0;
        await assert.rejects(runAgent({ host, scenario: context.scenario, guide: 'none', ask, budget: { ...limits, totalTokens: 1 } }), /budget/);
        assert.equal(requests, 0);
        await assert.rejects(runAgent({ host, scenario: context.scenario, guide: 'none', ask: async r => ({ ...final(r.model), status: 'incomplete' }) }), /Incomplete/);
        await assert.rejects(runAgent({ host, scenario: context.scenario, guide: 'none', ask: async r => response(r.model, [{ type: 'web_search_call' }]) }), /Unsupported/);
        await assert.rejects(runAgent({ host, scenario: context.scenario, guide: 'none', ask, budget: { ...limits, toolCalls: 0 } }), /budget/);
    });
});

test('oversized delivered reads cannot earn read-before-write credit', async () => {
    await usingScenario('maintain', 'none', async (context, host) => {
        let round = 0;
        const ask = async request => {
            if (round++ === 0) return response(request.model, [call('read', { path: '/faq.md' })]);
            assert.equal(JSON.parse(request.input.find(i => i.type === 'function_call_output').output).error.code, 'TOOL_RESULT_TOO_LARGE');
            return final(request.model);
        };
        await runAgent({ host, scenario: context.scenario, guide: 'none', ask, budget: { ...limits, resultBytes: 1 } });
        await host.toolsCall('write', { op: 'update', fileId: context.ids['/faq.md'], edits: [{ oldText: '30 days', newText: '42 days' }] });
        const result = await evaluate(context, host, 'done');
        assert.equal(result.behavior.readBeforeWrite, false);
    });
});

test('Responses adapter uses stateless requests and never retries HTTP failures or saves credential echoes', async () => {
    let requests = 0;
    const key = 'synthetic-secret';
    const ask = openAI({ key, fetcher: async (url, options) => {
        requests++;
        assert.equal(url, 'https://api.openai.com/v1/responses');
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers.authorization, `Bearer ${key}`);
        return new Response('sensitive error', { status: 500 });
    } });
    await assert.rejects(ask({ model: 'test' }, {}), /Model HTTP 500/);
    assert.equal(requests, 1);
    const echo = openAI({ key, fetcher: async () => new Response(JSON.stringify({ value: key })) });
    await assert.rejects(echo({}, {}), /credential/);
});

test('run reports preserve planned denominators, uncertain usage and cleanup, and distinguish injected transport', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tool-eval-'));
    try {
        const output = path.join(directory, 'run');
        const run = await runEvaluation({ output, mode: 'model', guide: 'all', scenario: 'recall',
            askFactory: () => async () => { throw new Error('sensitive transport error'); } });
        assert.equal(run.summary.planned, 3);
        assert.equal(run.summary.errors, 3);
        assert.equal(run.summary.complete, true);
        assert.equal(run.summary.modelTasksPassed, null);
        assert.equal(run.summary.transport, 'injected-test');
        assert(run.results.every(result => result.cleanup === 'completed'));
        assert.equal(run.summary.groups.tool.unknownUsageRequests, 1);
        const saved = await readFile(path.join(output, run.manifest.plan[0].id, 'request-0.json'), 'utf8');
        assert(!saved.includes('sensitive transport error'));
        assert.equal(JSON.parse(saved).status, 'failed_or_uncertain');
        await assert.rejects(runEvaluation({ output, mode: 'scripted', guide: 'none', scenario: 'recall' }), { code: 'EEXIST' });
        await assert.rejects(runEvaluation({ output: path.join(directory, 'missing-key'), mode: 'model' }), /LLM_API_KEY/);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('evaluation export preserves diagnostic outcomes without provider payloads or model text', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tool-report-'));
    try {
        const output = path.join(directory, 'run');
        const run = await runEvaluation({ output, mode: 'model', scenario: 'recall',
            askFactory: (_, guide) => {
                if (guide === 'none') return async () => ({ ...final('private-returned-model'), id: 'private-response-id' });
                if (guide === 'tool') return async () => {
                    throw Object.assign(new Error('private-response-body'), { code: 'MODEL_HTTP_ERROR', status: 429,
                        headers: { authorization: 'private-header' } });
                };
                return async (request, { round }) => round === 0 ? response(request.model, [
                    { type: 'reasoning', id: 'private-reasoning-id', encrypted_content: 'private-reasoning' },
                    call('read', { path: '/faq.md', extra: 'private-tool-argument' }, 'private-call-id'),
                    call('read', { path: '/faq.md' }, 'private-call-id-2'),
                ]) : final(request.model, '42 days, help@example.test. private-final-text');
            } });
        const report = await readEvaluationReport(output);
        const [mismatch, http, passed] = report.cases;
        assert.equal(report.summary.modelTasksPassed, null);
        assert.equal(report.summary.passed, 1);
        assert.equal(report.summary.errors, 2);
        assert.match(formatEvaluationSummary(report), /Injected test transport/);
        assert.equal(report.manifest.sources['package-lock.json'], run.manifest.sources['package-lock.json']);
        assert.equal(mismatch.errorCode, 'MODEL_IDENTITY_MISMATCH');
        assert.equal(mismatch.requests[0].expectedModelMatched, false);
        assert.equal(http.errorCode, 'MODEL_REQUEST_FAILED');
        assert.equal(http.requests[0].httpStatus, 429);
        assert.equal(passed.evaluation.checks.correctAnswer, true);
        assert.equal(passed.evaluation.behavior.resourceReadsByHost, 1);
        assert(passed.finalTextLength > 0);
        assert.equal(passed.events[0].actor, 'host');
        assert.equal(passed.events[1].errorCode, 'INVALID_INPUT');
        assert.equal(passed.events[2].outcome, 'ok');
        assert(passed.offered[0].tools.includes('read'));
        assert.equal(passed.requests[1].inputTokens, 10);
        assert.doesNotMatch(JSON.stringify(report), /private-|encrypted_content|requestId|authorization|\/faq\.md/);

        const interrupted = path.join(output, passed.id);
        await writeFile(path.join(interrupted, 'result.json'), '{');
        const { round, request } = run.results[2].receipts[1];
        await writeFile(path.join(interrupted, 'request-1.json'), JSON.stringify({ round, request, status: 'pending' }));
        const partial = await readEvaluationReport(output);
        assert.equal(partial.summary.attempted, 3);
        assert.equal(partial.summary.planned, 3);
        assert.equal(partial.summary.complete, false);
        assert.equal(partial.summary.errors, 3);
        assert.equal(partial.summary.interrupted, 1);
        assert.equal(partial.summary.groups.resource.inputTokens, 10);
        assert.equal(partial.summary.groups.resource.unknownUsageRequests, 1);
        assert.equal(partial.cases[2].status, 'interrupted');
        assert.equal(partial.cases[2].requests[1].status, 'pending');
        assert(partial.cases[2].offered[1].tools.includes('read'));
        assert.doesNotMatch(JSON.stringify(partial), /private-|encrypted_content|authorization/);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('evaluation export identifies duplicate fork and checkpoint errors', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tool-ref-conflicts-'));
    try {
        const output = path.join(directory, 'run');
        const calls = [call('fork', { name: 'trial' }, 'fork'), call('fork', { name: 'trial' }, 'duplicate-fork'),
            call('checkpoint', { name: 'before-edit' }, 'checkpoint'),
            call('checkpoint', { name: 'before-edit' }, 'duplicate-checkpoint')];
        await runEvaluation({ output, scenario: 'draft-checkpoint', guide: 'none',
            askFactory: () => async (request, { round }) => calls[round] ? response(request.model, [calls[round]]) : final(request.model) });
        const { cases: [draft] } = await readEvaluationReport(output);
        assert.deepEqual(draft.events.filter(event => event.outcome === 'error').map(event => [event.name, event.errorCode]),
            [['fork', 'BRANCH_CONFLICT'], ['checkpoint', 'CHECKPOINT_CONFLICT']]);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a convincing text answer cannot replace required SDK publication and instruction profiles remain separate', async () => {
    for (const instruction of ['server', 'workflow', 'user']) await usingScenario('maintain', 'none', async (context, host) => {
        const result = await runAgent({ host, scenario: context.scenario, guide: 'none', instruction, ask: async request => {
            assert.equal(request.input.some(item => item.role === 'developer' && item.content?.startsWith('Workflow guidance:')), instruction === 'workflow');
            assert.equal(request.input.some(item => item.role === 'user' && item.content.includes('Use MemDrive to check')), instruction === 'user');
            return final(request.model, 'Everything is published with 42 days retention.');
        } });
        assert.equal((await evaluate(context, host, result.finalText)).passed, false);
    });
});

test('conflict scoring rejects a destroyed draft even when main is unchanged and the blocker is reported', async () => {
    await usingScenario('conflict', 'none', async (context, host) => {
        await host.toolsCall('write', { op: 'delete', fileId: context.ids['/faq.md'] });
        assert.equal((await host.toolsCall('merge', { requestId: 'wrong-edit', summary: 'Publish FAQ edit' })).error.code, 'MERGE_CONFLICT');
        const scored = await evaluate(context, host, 'Concurrent conflict blocked publication; not published.');
        assert.equal(scored.checks.conflictObserved, true);
        assert.equal(scored.checks.mainUnchanged, true);
        assert.equal(scored.checks.blockerReported, true);
        assert.equal(scored.checks.unpublishedExpectedContent, false);
        assert.equal(scored.passed, false);
    });
});

test('checkpoint scoring requires draft provenance before its first mutation', async () => {
    for (const timing of ['main-before-fork', 'main-after-edit', 'draft-after-edit'])
        await usingScenario('draft-checkpoint', 'none', async (context, host) => {
            if (timing === 'main-before-fork') await host.toolsCall('checkpoint', { name: 'before-edit' });
            await host.toolsCall('fork', { name: 'trial' });
            await host.toolsCall('read', { path: '/faq.md' });
            // A same-content write still mutates the draft and must follow its before-edit checkpoint.
            if (timing === 'draft-after-edit') {
                await host.toolsCall('write', { op: 'update', fileId: context.ids['/faq.md'], content: context.initial.main['/faq.md'] });
                await host.toolsCall('checkpoint', { name: 'before-edit' });
            }
            await host.toolsCall('write', { op: 'update', fileId: context.ids['/faq.md'], edits: [{ oldText: '30 days', newText: '42 days' }] });
            if (timing === 'main-after-edit') {
                const mainHost = createHost({ drive: context.main, client: context.client, writable: true, guide: 'none' });
                await mainHost.toolsCall('checkpoint', { name: 'before-edit' });
                host.events.push(...mainHost.events);
            }
            const scored = await evaluate(context, host, 'The private draft is ready.');
            assert.equal(scored.checks.checkpointContent, true, timing);
            assert.equal(scored.checks.forkContent, true, timing);
            assert.equal(scored.checks.checkpointOfDraftBeforeEditing, false, timing);
            assert.equal(scored.passed, false, timing);
        });
});
