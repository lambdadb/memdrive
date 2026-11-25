import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileToolGuide, fileToolGuideTopics } from '@functional-systems/memdrive';
import { createHost, guideURI } from '../benchmark/tool-use/host.mjs';
import { prepareScenario, scenarios, selectScenarios, evaluate, retrievalMetrics, aggregateRetrieval, paraphraseTargets, enumeratedCode, faq,
    enumeratedPaths, handoff, junk, policy } from '../benchmark/tool-use/scenarios.mjs';
import { runAgent, openAI, limits } from '../benchmark/tool-use/agent.mjs';
import { scriptedAgent } from '../benchmark/tool-use/scripted.mjs';
import { runEvaluation } from '../benchmark/tool-use/run.mjs';
import { formatEvaluationSummary, readEvaluationReport } from '../benchmark/tool-use/report.mjs';

const final = (model, text = 'done') => ({ model, status: 'completed', usage: { input_tokens: 10, output_tokens: 5 },
    output: [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] }] });
const response = (model, output) => ({ ...final(model), output });
const call = (name, args, id = 'call-1') => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: id });
async function usingScenario(id, guide, run) {
    const context = await prepareScenario(id);
    const host = createHost({ drive: context.drive, writable: context.scenario.writable, guide, afterCall: context.afterCall });
    try { await run(context, host); } finally { await context.cleanup(); }
}

test('scripted smoke exercises actual SDK state across eight scenarios, three guide channels and three instruction profiles', async () => {
    assert.equal(scenarios.length, 8);
    for (const scenario of scenarios) for (const guide of ['none', 'tool', 'resource']) for (const instruction of ['server', 'workflow', 'user'])
        await usingScenario(scenario.id, guide, async (context, host) => {
            const result = await runAgent({ host, scenario, guide, instruction, ask: scriptedAgent(scenario, guide) });
            const scored = await evaluate(context, host, result.finalText);
            assert(scored.passed, JSON.stringify({ scenario: scenario.id, guide, instruction, checks: scored.checks }));
            assert.equal(scored.behavior.guideCalls, guide === 'tool' ? 2 : 0);
            assert.equal(scored.behavior.resourceReadsByHost, guide === 'resource' ? 1 + Object.keys(fileToolGuideTopics).length : 0);
            // Scripted paraphrase recall uses ranked search; the literal control uses findText.
            const { firstTool, usedSearch } = retrievalMetrics(host.events);
            if (scenario.group === 'retrieval') assert.deepEqual([firstTool, usedSearch],
                scenario.id === 'enumerate' ? ['findText', false] : ['search', true], scenario.id);
        });
});

test('recall sees consistent current retention on main while preserving the dated decision', async () => {
    await usingScenario('recall', 'none', async context => {
        assert.match((await context.main.read({ path: '/policy.md' })).content, /Retention is 42 days/);
        assert.match((await context.main.read({ path: '/faq.md' })).content, /Retention is 42 days/);
        assert.match((await context.main.read({ path: '/decisions/2026-01-01.md' })).content, /Retention was 30 days/);
    });
});

test('the host offers the six main-only tools, read-only tasks get no write and every write is checkpointed by the host', async () => {
    await usingScenario('recall', 'tool', async (context, host) => {
        const offered = host.toolsList().tools.map(tool => tool.name);
        assert.deepEqual(offered, ['guide', 'read', 'list', 'search', 'findText']);
        assert.equal((await host.toolsCall('write', { op: 'delete', fileId: context.ids['/faq.md'] })).error.code, 'TOOL_NOT_ALLOWED');
        for (const name of ['fork', 'checkpoint', 'rollback', 'listCheckpoints'])
            assert.equal((await host.toolsCall(name, { name: 'escape' })).error.code, 'TOOL_NOT_ALLOWED', name);
        assert.equal((await host.toolsCall('read', { at: { kind: 'fork', name: 'other' }, path: '/faq.md' })).error.code, 'INVALID_INPUT');
    });
    await usingScenario('maintain', 'none', async (context, host) => {
        const before = JSON.stringify(host.toolsList());
        assert.deepEqual(host.toolsList().tools.map(tool => tool.name), ['read', 'list', 'search', 'findText', 'write']);
        assert(host.toolsList().tools.every(tool => !JSON.stringify(tool.inputSchema).includes('"at"')));
        assert.deepEqual((await context.main.describe()).latestCheckpoint, { at: { kind: 'checkpoint', name: 'setup' } });
        const file = await host.toolsCall('write', { op: 'create', path: '/late.md', content: 'draft' });
        assert.equal(file.path, '/late.md');
        assert.equal(file.checkpoint, undefined, 'the model sees a plain write result');
        assert.deepEqual((await context.main.describe()).latestCheckpoint, { at: { kind: 'checkpoint', name: 'turn-1' } });
        assert.equal((await host.toolsCall('write', { op: 'create', path: '/late-2.md', content: 'x', checkpoint: { name: 'mine' } })).error.code, 'INVALID_INPUT');
        assert.equal((await host.toolsCall('write', { at: { kind: 'main' }, op: 'create', path: '/late-2.md', content: 'x' })).error.code, 'INVALID_INPUT');
        assert.equal(JSON.stringify(host.toolsList()), before, 'Definitions never change');
    });
});

test('resource guide is unchanged SDK text and is recorded as host delivery, not a model tool call', async () => {
    await usingScenario('recall', 'resource', async (_, host) => {
        assert.equal(host.resourcesList().resources[0].uri, guideURI);
        const read = host.resourcesRead(guideURI);
        assert.equal(read.version, fileToolGuide.version);
        assert.equal(read.contents[0].text, fileToolGuide.content);
        assert.equal(host.resourcesList().resources.length, 1 + Object.keys(fileToolGuideTopics).length);
        for (const [topic, document] of Object.entries(fileToolGuideTopics)) {
            const detail = host.resourcesRead(`memdrive://docs/${topic}`);
            assert.equal(detail.version, fileToolGuide.version);
            assert.equal(detail.contents[0].text, document.content);
        }
        await runAgent({ host, scenario: { task: 'Inspect the guide.' }, guide: 'resource', ask: async request => {
            for (const document of [fileToolGuide, ...Object.values(fileToolGuideTopics)])
                assert(request.input.some(message => message.role === 'developer' && message.content === document.content));
            return final(request.model);
        } });
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

test('the conflict scenario injects one concurrent change after the first FAQ read and the scripted edit is rejected', async () => {
    await usingScenario('conflict', 'none', async (context, host) => {
        const result = await runAgent({ host, scenario: context.scenario, guide: 'none', ask: scriptedAgent(context.scenario, 'none') });
        const write = host.events.find(event => event.name === 'write');
        assert.equal(write.result.error.code, 'EDIT_CONFLICT');
        assert.equal((await context.main.read({ path: '/faq.md' })).content, faq(14));
        // A validation error changes nothing, so no checkpoint was taken and the concurrent change stays.
        assert.deepEqual((await context.main.describe()).latestCheckpoint, { at: { kind: 'checkpoint', name: 'setup' } });
        assert.equal((await evaluate(context, host, result.finalText)).passed, true);
    });
});

test('record scoring requires the user\'s wording in one checkpointed write', async () => {
    const recorded = async (writes, text = 'Saved.') => {
        let scored;
        await usingScenario('record', 'none', async (context, host) => {
            for (const args of writes) await host.toolsCall('write', args);
            scored = await evaluate(context, host, text);
        });
        return scored;
    };
    const verbatim = await recorded([{ op: 'create', path: '/notes/handoff.md', content: `# Handoff\n\n> ${handoff}\n` }]);
    assert.deepEqual([verbatim.passed, verbatim.checks.verbatimRecorded, verbatim.checks.singleWrite, verbatim.checks.checkpointedWrites], [true, true, true, true]);
    const paraphrased = await recorded([{ op: 'create', path: '/notes/handoff.md', content: 'Handoff is Monday morning; the backup covers.' }]);
    assert.deepEqual([paraphrased.passed, paraphrased.checks.verbatimRecorded], [false, false]);
    const split = await recorded([{ op: 'create', path: '/notes/a.md', content: handoff }, { op: 'create', path: '/notes/b.md', content: 'More.' }]);
    assert.deepEqual([split.passed, split.checks.verbatimRecorded, split.checks.singleWrite], [false, true, false]);
});

test('cleanup scoring requires the junk deleted after reading it, with other files unchanged', async () => {
    await usingScenario('cleanup', 'none', async (context, host) => {
        // Deleting without reading the originals does not earn read-before-write credit.
        const listed = await host.toolsCall('list', { prefix: '/import/' });
        await host.toolsCall('write', { operations: listed.files.map(file => ({ op: 'delete', fileId: file.fileId })) });
        const scored = await evaluate(context, host, 'Deleted.');
        assert.deepEqual([scored.checks.junkRemoved, scored.checks.otherFilesUnchanged, scored.checks.readOriginalBeforeWrite, scored.passed],
            [true, true, false, false]);
        assert.deepEqual(Object.keys(context.initial.main).filter(path => path in junk), Object.keys(junk));
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
        assert.deepEqual(run.manifest.guide, fileToolGuide);
        assert.deepEqual(run.manifest.guideTopics, fileToolGuideTopics);
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
        assert.equal(passed.evaluation.behavior.resourceReadsByHost, 1 + Object.keys(fileToolGuideTopics).length);
        assert(passed.finalTextLength > 0);
        assert.equal(passed.events[0].actor, 'host');
        const toolEvents = passed.events.filter(event => event.kind === 'tool');
        assert.equal(toolEvents[0].errorCode, 'INVALID_INPUT');
        assert.equal(toolEvents[1].outcome, 'ok');
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

test('evaluation export identifies edit conflicts and removed tools', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tool-write-errors-'));
    try {
        const output = path.join(directory, 'run');
        // The read's fileId feeds an exact edit that the injected concurrent change makes stale.
        const calls = [() => call('read', { path: '/faq.md' }, 'read'),
            previous => call('write', { op: 'update', fileId: previous.fileId, edits: [{ oldText: 'Retention is 30 days.', newText: 'Retention is 42 days.' }] }, 'write'),
            () => call('rollback', { at: { kind: 'main' }, to: { kind: 'checkpoint', name: 'setup' } }, 'rollback')];
        await runEvaluation({ output, scenario: 'conflict', guide: 'none',
            askFactory: () => async (request, { round }) => calls[round]
                ? response(request.model, [calls[round](JSON.parse(request.input.findLast(item => item.type === 'function_call_output')?.output ?? '{}'))])
                : final(request.model) });
        const { cases: [conflict] } = await readEvaluationReport(output);
        assert.deepEqual(conflict.events.filter(event => event.outcome === 'error').map(event => [event.name, event.errorCode]),
            [['write', 'EDIT_CONFLICT'], ['rollback', 'TOOL_NOT_ALLOWED']]);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a convincing text answer cannot replace the required main state and instruction profiles remain separate', async () => {
    for (const instruction of ['server', 'workflow', 'user']) await usingScenario('maintain', 'none', async (context, host) => {
        const result = await runAgent({ host, scenario: context.scenario, guide: 'none', instruction, ask: async request => {
            assert.equal(request.input.some(item => item.role === 'developer' && item.content?.startsWith('Workflow guidance:')), instruction === 'workflow');
            assert.equal(request.input.some(item => item.role === 'user' && item.content.includes('Use MemDrive to check')), instruction === 'user');
            return final(request.model, 'Main now has 42 days retention everywhere.');
        } });
        assert.equal((await evaluate(context, host, result.finalText)).passed, false);
    });
});

test('conflict scoring rejects an overwrite of the concurrent change even when a blocker is claimed', async () => {
    await usingScenario('conflict', 'none', async (context, host) => {
        // Overwriting the concurrent change after reading it is not a blocker report.
        const file = await host.toolsCall('read', { path: '/faq.md' });
        const current = await host.toolsCall('read', { path: '/faq.md' });
        assert.equal(current.content, faq(14));
        await host.toolsCall('write', { op: 'update', fileId: file.fileId, content: current.content.replace('14 days', '42 days') });
        const scored = await evaluate(context, host, 'A concurrent change was noticed; my change was not applied.');
        assert.deepEqual([scored.checks.conflictObserved, scored.checks.blockerReported, scored.checks.concurrentChangeKept, scored.passed],
            [true, true, false, false]);
    });
});

test('maintain scoring requires both updated originals and the host checkpoint of the final write', async () => {
    await usingScenario('maintain', 'none', async (context, host) => {
        const files = await host.toolsCall('read', { paths: ['/faq.md', '/policy.md'] });
        await host.toolsCall('write', { op: 'update', fileId: files[0].fileId, edits: [{ oldText: 'Retention is 30 days.', newText: 'Retention is 42 days.' }] });
        // A direct SDK write behind the host's back leaves main ahead of its latest checkpoint.
        await context.main.write({ op: 'update', fileId: files[1].fileId, content: policy(42) });
        const scored = await evaluate(context, host, 'Updated.');
        assert.deepEqual([scored.checks.mainExpectedContent, scored.checks.readOriginalBeforeWrite, scored.checks.checkpointedWrites, scored.passed],
            [true, true, false, false]);
    });
});

test('paraphrase targets are ranked candidates for any query while the question wording has no literal hit', async () => {
    for (const id of ['paraphrase', 'cross-language']) await usingScenario(id, 'none', async (context, host) => {
        const { task } = context.scenario, target = paraphraseTargets[id];
        const candidates = async args => (await host.toolsCall('search', args)).hits.map(hit => hit.path);
        const ranked = await candidates({ query: task });
        assert.equal(ranked.length, 9, 'the default limit returns every chunk of the drive');
        assert.equal(ranked.indexOf(target), id === 'paraphrase' ? 2 : 4);
        // The fixture ignores the query and the mode: this measures tool selection, not retrieval relevance.
        for (const mode of ['semantic', 'keyword', 'hybrid'])
            assert.deepEqual(await candidates({ query: 'unrelated wording', mode }), ranked, mode);
        const words = [...new Set(task.match(/\p{L}{2,}/gu).filter(word => /\P{ASCII}/u.test(word) || word.length >= 4))];
        assert(words.length >= 10, 'the question has distinctive words to try');
        for (const query of [task, ...task.split(/(?<=[?.]) /), ...words]) {
            const found = await host.toolsCall('findText', { query });
            assert.deepEqual([found.hits, found.next], [[], undefined], query);
        }
        // The stored wording itself is literally findable, so the miss comes from the paraphrase.
        const stored = await host.toolsCall('findText', { query: id === 'paraphrase' ? 'overdue' : 'laptop' });
        assert.deepEqual(stored.hits.map(hit => hit.path), [target]);
    });
});

test('the literal control is fully enumerated only by an unscoped findText', async () => {
    await usingScenario('enumerate', 'none', async (context, host) => {
        assert(context.scenario.task.includes(enumeratedCode));
        assert.deepEqual([...enumeratedPaths].sort(), ['/notes/2026-02-10.md', '/runbooks/export.md', '/runbooks/import.md']);
        const paths = async args => [...new Set((await host.toolsCall('findText', { query: enumeratedCode, ...args })).hits.map(hit => hit.path))].sort();
        assert.deepEqual(await paths({}), [...enumeratedPaths].sort());
        assert.deepEqual(await paths({ prefix: '/runbooks/' }), ['/runbooks/export.md', '/runbooks/import.md']);
        assert.deepEqual(await paths({ query: 'E-4127' }), ['/notes/2026-02-24.md', '/runbooks/import.md']);
    });
});

test('retrieval scoring requires the stored fact, complete literal enumeration and unchanged main', async () => {
    const scored = async (id, text, prepare = async () => {}) => {
        let result;
        await usingScenario(id, 'none', async (context, host) => {
            await prepare(context);
            result = await evaluate(context, host, text);
        });
        return result;
    };
    const english = await scored('paraphrase', 'Access ends 21 days after the unpaid invoice; write to renewals@example.test (/notes/2026-02-03.md).');
    assert.deepEqual([english.passed, english.checks.correctAnswer, english.checks.mainUnchanged], [true, true, true]);
    for (const wrong of ['Refunds take 14 days; write to refunds@example.test.', 'It takes 21 days.', '210 days; renewals@example.test', 'Retention is 30 days; help@example.test'])
        assert.equal((await scored('paraphrase', wrong)).checks.correctAnswer, false, wrong);
    const korean = await scored('cross-language', '입사일 9영업일 전까지 kit-desk@example.test 로 요청합니다. 근거: /notes/2026-02-17.md');
    assert.equal(korean.passed, true);
    for (const wrong of ['2영업일 전까지 front-desk@example.test 로 요청합니다.', '19영업일 전까지 kit-desk@example.test', '9영업일 전까지 신청합니다.'])
        assert.equal((await scored('cross-language', wrong)).checks.correctAnswer, false, wrong);
    const published = await scored('paraphrase', '21 days; renewals@example.test', async ({ main }) => {
        await main.write({ op: 'create', path: '/late.md', content: 'late' });
    });
    assert.deepEqual([published.checks.correctAnswer, published.checks.mainUnchanged, published.passed], [true, false, false]);

    const listed = await scored('enumerate', enumeratedPaths.join('\n'));
    assert.deepEqual([listed.passed, listed.checks.allOccurrencesListed, listed.checks.noOtherFilesListed], [true, true, true]);
    const partial = await scored('enumerate', enumeratedPaths.filter(path => path.startsWith('/runbooks/')).join('\n'));
    assert.deepEqual([partial.passed, partial.checks.allOccurrencesListed, partial.checks.noOtherFilesListed], [false, false, true]);
    const overbroad = await scored('enumerate', [...enumeratedPaths, '/notes/2026-02-24.md'].join('\n'));
    assert.deepEqual([overbroad.passed, overbroad.checks.allOccurrencesListed, overbroad.checks.noOtherFilesListed], [false, true, false]);
});

test('retrieval metrics count tool selection from ordered events without keeping arguments', () => {
    const tool = (name, args = {}) => ({ kind: 'tool', name, args, result: {} });
    const literalFirst = retrievalMetrics([{ kind: 'resource_read', actor: 'host' }, tool('guide'), tool('listForks'),
        tool('findText', { query: 'one' }), tool('findText', { query: 'two' }), tool('findText', { query: 'three' }),
        tool('search', { query: 'meaning' }), tool('findText', { query: 'four', prefix: '/notes/' }), tool('read', { path: '/faq.md' })]);
    assert.deepEqual(literalFirst, { search: 1, findText: 4, read: 1, list: 0, firstTool: 'findText', usedSearch: true,
        findTextBeforeSearch: 3, findTextUnscoped: 3, findTextContinuations: 0 });
    // Without any search, every findText call counts; a continuation is not a new unscoped scan.
    const neverRanked = retrievalMetrics([tool('list'), tool('findText', { query: 'one', at: { kind: 'main' } }),
        tool('findText', { at: { kind: 'main' }, cursor: 'opaque' }), tool('read'),
        { kind: 'tool', name: 'findText', rawArguments: '{broken', result: { ok: false, error: { code: 'INVALID_JSON' } } }]);
    assert.deepEqual(neverRanked, { search: 0, findText: 3, read: 1, list: 1, firstTool: 'list', usedSearch: false,
        findTextBeforeSearch: 3, findTextUnscoped: 1, findTextContinuations: 1 });
    const scope = args => retrievalMetrics([tool('search'), tool('findText', { query: 'one', ...args })]);
    for (const scoped of [{ prefix: '/notes/' }, { filter: { field: 'metadata.project', op: 'eq', value: 'one' } }])
        assert.deepEqual([scope(scoped).findTextUnscoped, scope(scoped).findTextBeforeSearch], [0, 0], JSON.stringify(scoped));
    for (const unscoped of [{}, { prefix: '' }, { prefix: '/' }, { limit: 100 }])
        assert.equal(scope(unscoped).findTextUnscoped, 1, JSON.stringify(unscoped));
    const none = retrievalMetrics([tool('guide'), tool('fork'), tool('write'), { kind: 'resource_read' }]);
    assert.deepEqual(none, { search: 0, findText: 0, read: 0, list: 0, firstTool: 'none', usedSearch: false,
        findTextBeforeSearch: 0, findTextUnscoped: 0, findTextContinuations: 0 });
    assert.deepEqual(aggregateRetrieval([literalFirst, neverRanked, none]), { cases: 3, search: 1, findText: 7, read: 2, list: 1,
        findTextBeforeSearch: 6, findTextUnscoped: 4, findTextContinuations: 1,
        firstTool: { search: 0, findText: 1, list: 1, read: 0, none: 1 }, casesUsingSearch: 1, casesUsingFindText: 2, casesWithUnscopedFindText: 2 });
    assert.doesNotMatch(JSON.stringify([literalFirst, neverRanked]), /one|two|meaning|notes|opaque|broken/);
});

test('scenario groups select the pilot, the retrieval scenarios or every scenario', async () => {
    const ids = selection => selectScenarios(selection).map(item => item.id);
    assert.deepEqual(ids('recall'), ['recall']);
    assert.deepEqual(ids('retrieval'), ['paraphrase', 'cross-language', 'enumerate']);
    assert.deepEqual(ids('all'), ['recall', 'maintain', 'record', 'conflict', 'cleanup', ...ids('retrieval')]);
    assert(selectScenarios('retrieval').every(item => item.writable === false));
    assert.throws(() => selectScenarios('findText'), /Unknown scenario/);
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tool-groups-'));
    try {
        await assert.rejects(runEvaluation({ output: path.join(directory, 'unknown'), mode: 'scripted', scenario: 'unknown' }), /Unknown scenario/);
        const retrieval = await runEvaluation({ output: path.join(directory, 'retrieval'), mode: 'scripted', scenario: 'retrieval' });
        assert.deepEqual(retrieval.manifest.plan.map(entry => entry.id).slice(0, 4),
            ['001-paraphrase-none', '002-paraphrase-tool', '003-paraphrase-resource', '004-cross-language-none']);
        assert.deepEqual([retrieval.summary.planned, retrieval.summary.passed], [9, 9]);
        const all = await runEvaluation({ output: path.join(directory, 'all'), mode: 'scripted', repeats: 2 });
        assert.deepEqual([all.summary.planned, all.summary.passed, all.summary.scriptedSmokePassed, all.summary.modelTasksPassed], [48, 48, 48, null]);
        assert.match(formatEvaluationSummary(await readEvaluationReport(path.join(directory, 'all'))), /Scripted smoke test with predetermined requests/);
    } finally { await rm(directory, { recursive: true, force: true }); }
});

test('retrieval metrics reach receipts, summaries and the exported report without arguments, including failed and older runs', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tool-retrieval-'));
    try {
        const output = path.join(directory, 'run');
        const steps = { paraphrase: [call('findText', { query: 'private-literal-one' }, 'a'), call('findText', { query: 'private-literal-two', prefix: '/private-prefix/' }, 'b'),
            call('search', { query: 'private-ranked-query' }, 'c'), call('read', { path: paraphraseTargets.paraphrase }, 'd')],
        'cross-language': [call('list', { prefix: '/private-prefix/' }, 'a')], enumerate: [call('findText', { query: enumeratedCode }, 'a')] };
        const run = await runEvaluation({ output, mode: 'model', scenario: 'retrieval', guide: 'none',
            askFactory: scenario => async (request, { round }) => steps[scenario.id][round] ? response(request.model, [steps[scenario.id][round]])
                // The control conversation ends in an agent failure after its tool call.
                : scenario.id === 'enumerate' ? { ...final(request.model), status: 'incomplete' }
                    : final(request.model, '21 days; renewals@example.test private-final-text') });
        assert.deepEqual(run.results.map(result => result.status), ['passed', 'failed', 'error']);
        const expected = [
            { search: 1, findText: 2, read: 1, list: 0, firstTool: 'findText', usedSearch: true, findTextBeforeSearch: 2, findTextUnscoped: 1, findTextContinuations: 0 },
            { search: 0, findText: 0, read: 0, list: 1, firstTool: 'list', usedSearch: false, findTextBeforeSearch: 0, findTextUnscoped: 0, findTextContinuations: 0 },
            { search: 0, findText: 1, read: 0, list: 0, firstTool: 'findText', usedSearch: false, findTextBeforeSearch: 1, findTextUnscoped: 1, findTextContinuations: 0 },
        ];
        assert.deepEqual(run.results.map(result => result.retrieval), expected);
        const receipt = JSON.parse(await readFile(path.join(output, run.manifest.plan[2].id, 'result.json'), 'utf8'));
        assert.deepEqual([receipt.error.code, receipt.retrieval], ['MODEL_RESPONSE_INCOMPLETE', expected[2]]);
        const saved = JSON.parse(await readFile(path.join(output, 'summary.json'), 'utf8'));
        assert.deepEqual(saved.groups.none.retrieval, aggregateRetrieval(expected));
        assert.deepEqual(saved.groups.none.retrievalByScenario, { paraphrase: aggregateRetrieval([expected[0]]),
            'cross-language': aggregateRetrieval([expected[1]]), enumerate: aggregateRetrieval([expected[2]]) });
        assert.equal(saved.modelTasksPassed, null);

        const report = await readEvaluationReport(output);
        assert.deepEqual(report.cases.map(item => item.retrieval), expected);
        assert.deepEqual(report.summary.groups, saved.groups);
        assert.deepEqual(report.manifest.readOnlyScenarios, ['paraphrase', 'cross-language', 'enumerate']);
        const text = formatEvaluationSummary(report);
        assert(text.includes('| paraphrase | none | 1 | 0 / 1 / 0 / 0 / 0 | 1 | 2 | 2 | 0 | 1 |'), text);
        assert(text.includes('| enumerate | none | 1 | 0 / 1 / 0 / 0 / 0 | 0 | 1 | 1 | 1 | 1 |'), text);
        assert.doesNotMatch(JSON.stringify(report) + text, /private-|E-4172|\/notes\/|renewals@/);

        // A run directory written before these metrics has no receipt field or scenario group.
        const manifestFile = path.join(output, 'manifest.json');
        const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
        await writeFile(manifestFile, JSON.stringify({ ...manifest, scenarios: manifest.scenarios.map(({ group: _, ...scenario }) => scenario) }));
        for (const entry of manifest.plan) {
            const file = path.join(output, entry.id, 'result.json');
            const { retrieval: _, ...older } = JSON.parse(await readFile(file, 'utf8'));
            await writeFile(file, JSON.stringify(older));
        }
        assert.deepEqual(await readEvaluationReport(output), report);
        // An interrupted case has no recorded events and stays out of the retrieval counts.
        await writeFile(path.join(output, manifest.plan[0].id, 'result.json'), '{');
        const partial = await readEvaluationReport(output);
        assert.deepEqual([partial.cases[0].status, partial.cases[0].retrieval], ['interrupted', undefined]);
        assert.deepEqual(partial.summary.groups.none.retrieval, aggregateRetrieval(expected.slice(1)));
        assert.equal(partial.summary.groups.none.retrievalByScenario.paraphrase, undefined);
        assert.doesNotMatch(formatEvaluationSummary(partial), /\| paraphrase \|/);
    } finally { await rm(directory, { recursive: true, force: true }); }
});
