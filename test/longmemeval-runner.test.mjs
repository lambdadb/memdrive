import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { row, keys } from './helpers/longmemeval-http.mjs';

test('reusable corpus grows once, serves both retrieval modes and verifies after explicit deletion', () => {
    // A child substitutes a tiny dataset profile and virtual cache clock; no global state escapes the test.
    const program = `
        import assert from 'node:assert/strict';
        import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
        import { tmpdir } from 'node:os';
        import path from 'node:path';
        import { config, prepare, recall, score, verify } from './benchmark/longmemeval/run.mjs';
        import { initialize, ingestCorpus, cleanupCorpus, compatible, lease } from './benchmark/longmemeval/corpus.mjs';
        import { hash, jsonHash } from './benchmark/longmemeval/protocol.mjs';
        import { readJSON, atomic } from './benchmark/longmemeval/runtime.mjs';
        import { nativeFixture } from './test/helpers/longmemeval-http.mjs';
        const first = ${JSON.stringify(row())}, second = { ...structuredClone(first), question_id: 'synthetic-b' };
        const bytes = JSON.stringify([first, second]);
        Object.assign(config.dataset, { bytes: Buffer.byteLength(bytes), sha256: hash(bytes), questions: 2 });
        const keys = ${JSON.stringify(keys)}; keys.connection = jsonHash([keys.database, keys.project]);
        const databaseKeys = { ...keys, modelKey: undefined, judgeKey: undefined };
        const originalNow = Date.now;
        const base = await mkdtemp(path.join(tmpdir(), 'memdrive-lme-reuse-'));
        try {
            const corpus = path.join(base, 'corpus'); await mkdir(corpus); await writeFile(path.join(corpus, 'dataset.json'), bytes);
            const { manifest, rows } = await initialize(corpus, config); assert.equal(manifest.ids.length, 2);
            // Receipt and cache timestamps must share the virtual clock, regardless of the real wall clock.
            const wire = nativeFixture(); let modelCalls = 0, clock = Date.parse('2020-01-01T00:00:00Z'), emptySelection = false;
            const fetcher = async (url, options) => {
                if (url.startsWith(keys.database)) return wire.fetcher(url, options);
                modelCalls++;
                const request = JSON.parse(options.body);
                if (url === config.judge.endpoint) return new Response(JSON.stringify({ model: request.model,
                    answers: { correct: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 10 } }), { status: 200 });
                let message = { role: 'assistant', content: 'cedar' }, finish_reason = 'stop';
                if (request.tools && emptySelection) message.content = JSON.stringify({ evidence: [] });
                else if (request.tools) {
                    const outputs = request.input.filter(item => item.type === 'function_call_output');
                    const tool = outputs.find(item => JSON.parse(item.output).value?.results);
                    if (!tool) {
                        const step = outputs.length, name = step < 3 ? 'memdrive_count_values' : 'memdrive_recall';
                        const args = step < 3 ? { fields: ['metadata.role'] } : { requests: [{ query: 'key' }] };
                        clock += step === 1 ? 61000 : step === 2 ? 301000 : 0;
                        message = { role: 'assistant', content: null, tool_calls: [{ id: 'search-' + step, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
                        finish_reason = 'tool_calls';
                    } else {
                        const match = JSON.parse(tool.output).value.results[0].matches[0];
                        message.content = JSON.stringify({ evidence: [{ memId: match.memId, start: match.start, end: match.end }] });
                    }
                }
                if (request.tools) {
                    assert.equal(url, config.collectorEndpoint); assert.equal(request.store, false);
                    const output = [{ type: 'reasoning', id: 'reason-' + modelCalls, encrypted_content: 'opaque-test-state', summary: [] },
                        ...(message.tool_calls?.map(call => ({ type: 'function_call', id: 'item-' + call.id, call_id: call.id,
                            name: call.function.name, arguments: call.function.arguments }))
                            ?? [{ type: 'message', id: 'message-' + modelCalls, role: 'assistant', status: 'completed', phase: 'final_answer',
                                content: [{ type: 'output_text', text: message.content, annotations: [] }] }])];
                    return new Response(JSON.stringify({ model: request.model, status: 'completed', output,
                        usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200 });
                }
                return new Response(JSON.stringify({ model: request.model, choices: [{ message, finish_reason }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 });
            };
            await ingestCorpus(corpus, config, databaseKeys, 1, { fetcher });
            assert.equal(wire.collections.size, 1); assert.equal(modelCalls, 0);
            const initialCalls = wire.requests.length;
            config.model.model = 'another-test-model'; config.prompts.collect += ' A different search policy.';
            await ingestCorpus(corpus, config, databaseKeys, 1, { fetcher });
            assert.equal(wire.requests.length, initialCalls, 'Ready ingest must be a complete native no-op');
            await ingestCorpus(corpus, config, databaseKeys, 2, { fetcher });
            assert.equal(wire.collections.size, 2);
            assert.equal(wire.requests.filter(r => r.pathname.endsWith('/collections') && r.method === 'POST').length, 2);
            assert.equal(wire.requests.filter(r => r.pathname.endsWith('/docs/upsert')).length, 2);
            assert.deepEqual((await readJSON(path.join(corpus, 'corpus.json'))), manifest);
            // Native descriptors need not preserve creation-time metadata field ordering.
            for (const stored of wire.collections.values())
                stored.metadata.indexConfigs = Object.fromEntries(Object.entries(stored.metadata.indexConfigs).reverse());
            assert.throws(() => compatible({ ...manifest, storage: {} }, rows, config), /storage/);
            assert.throws(() => compatible(manifest, rows, { ...config, retrieval: { ...config.retrieval, recentMessagesIncludingQuestion: 3 } }), /originals/);
            const baseline = path.join(base, 'baseline'), agent = path.join(base, 'agent');
            await prepare(baseline, corpus, 'single_pass', 1);
            config.model.model = 'new-agent-model'; config.prompts.answer += ' A different reader policy.';
            await prepare(agent, corpus, 'agentic', 1);
            const beforeReuse = wire.requests.length;
            const baselineResult = await recall(baseline, databaseKeys, { fetcher });
            assert.equal(modelCalls, 0, 'single_pass recall requires neither model nor judge');
            assert.equal(baselineResult.accuracy, null); assert.equal(baselineResult.phase, 'recall');
            assert.equal(baselineResult.complete, true); assert.equal(baselineResult.retrieval.databaseOperations, 1);
            assert(baselineResult.validation.databaseOperations > 0);
            Date.now = () => clock;
            const agentResult = await recall(agent, { ...keys, judgeKey: undefined }, { fetcher }); Date.now = originalNow;
            assert(agentResult.models.collector.calls > 0); assert.equal(agentResult.models.answer, undefined); assert.equal(agentResult.models.judge, undefined);
            assert.equal(agentResult.accuracy, null);
            assert(wire.requests.slice(beforeReuse).every(r => r.method !== 'DELETE' && !r.pathname.endsWith('/collections') && !r.pathname.endsWith('/docs/upsert')));
            assert.equal(wire.collections.size, 2);
            assert.deepEqual(await verify(baseline), baselineResult); assert.deepEqual(await verify(agent), agentResult); assert.equal(Date.now, originalNow);
            const empty = path.join(base, 'empty'); await prepare(empty, corpus, 'agentic', 1);
            emptySelection = true;
            const emptyResult = await recall(empty, { ...keys, judgeKey: undefined }, { fetcher });
            emptySelection = false;
            assert.equal(emptyResult.retrieval.databaseOperations, 0);
            assert.equal(emptyResult.models.collector.calls, 1);
            assert.equal(emptyResult.models.answer, undefined); assert.equal(emptyResult.models.judge, undefined);
            assert.deepEqual(await readJSON(path.join(empty, 'questions', hash(first.question_id), 'tools.json')), []);
            assert.deepEqual(await verify(empty), emptyResult);
            await lease(corpus, async () => { await assert.rejects(cleanupCorpus(corpus, keys, { fetcher }), { code: 'EEXIST' }); });
            assert.equal(wire.collections.size, 2);
            // A changed expected original fails validation, does not run retrieval, and leaves the corpus intact.
            const corrupted = path.join(base, 'corrupted'); await prepare(corrupted, corpus, 'single_pass', 1);
            const stored = wire.collections.get(manifest.collections[first.question_id].collection);
            const source = [...stored.docs.values()].find(doc => doc.kind === 'mem'), original = structuredClone(source);
            source.content = 'externally changed';
            const failed = await recall(corrupted, databaseKeys, { fetcher });
            assert.equal(failed.failed, 1); assert.equal(failed.retrieval.databaseOperations, 0); assert.equal(failed.accuracy, null);
            assert.equal((await verify(corrupted)).complete, true);
            stored.docs.set(original.id, original);
            const modelCount = modelCalls;
            const failedScore = await score(corrupted, { modelKey: keys.modelKey, judgeKey: keys.judgeKey }, { fetcher });
            assert.equal(failedScore.accuracy, 0); assert.equal(modelCalls, modelCount); assert.equal(failedScore.questions, 1);
            // Ownership mismatches never delete; explicit cleanup can be retried after correcting the mismatch.
            stored.metadata.tags['eval.owner'] = 'foreign'; const deletes = wire.requests.filter(r => r.method === 'DELETE').length;
            await assert.rejects(cleanupCorpus(corpus, keys, { fetcher }));
            assert.equal(wire.requests.filter(r => r.method === 'DELETE').length, deletes);
            stored.metadata.tags['eval.owner'] = manifest.owner;
            await cleanupCorpus(corpus, keys, { fetcher }); assert.equal(wire.collections.size, 0);
            assert.deepEqual(await readJSON(path.join(corpus, 'corpus.json')), manifest, 'Deletion cannot change immutable corpus identity');
            // Run snapshots/hard-linked input remain self-contained even if original corpus files disappear.
            await rm(path.join(corpus, 'dataset.json')); await rm(path.join(corpus, 'corpus.json'));
            config.model.model = 'different-current-setting'; config.prompts.answer = 'different-current-prompt'; config.rulesSha256 = 'not-the-run-rules';
            const beforeScore = wire.requests.length;
            for (const root of [baseline, agent, empty]) {
                const result = await score(root, { modelKey: keys.modelKey, judgeKey: keys.judgeKey }, { fetcher });
                assert.equal(result.accuracy, 1); assert.equal(result.scoringComplete, true);
                assert.deepEqual(await verify(root), result); assert.equal(Date.now, originalNow);
            }
            assert.equal(wire.requests.length, beforeScore, 'score and verify must not access a database');
            const toolsFile = path.join(agent, 'questions', hash(first.question_id), 'tools.json');
            const events = await readJSON(toolsFile); events.find(event => event.name === 'memdrive_recall').raw.value.results[0].matches.reverse();
            await atomic(toolsFile, events); await assert.rejects(verify(agent), /native receipt replay/); assert.equal(Date.now, originalNow);
            // An uncertain ingestion is never silently replayed or automatically deleted.
            const partial = path.join(base, 'partial'); await mkdir(partial); await writeFile(path.join(partial, 'dataset.json'), bytes);
            const other = nativeFixture();
            const failingFetch = async (url, options) => { if (new URL(url).pathname.endsWith('/docs/upsert')) throw new Error('Interrupted write'); return other.fetcher(url, options); };
            await assert.rejects(ingestCorpus(partial, config, databaseKeys, 1, { fetcher: failingFetch }));
            assert.equal(other.collections.size, 1); const attempts = other.requests.length;
            await assert.rejects(ingestCorpus(partial, config, databaseKeys, 1, { fetcher: other.fetcher }), /Prior ingestion/);
            assert.equal(other.requests.length, attempts);
            await cleanupCorpus(partial, keys, { fetcher: other.fetcher }); assert.equal(other.collections.size, 0);
        } finally { Date.now = originalNow; await rm(base, { recursive: true, force: true }); }
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', program], { cwd: new URL('..', import.meta.url), stdio: 'pipe' });
});
