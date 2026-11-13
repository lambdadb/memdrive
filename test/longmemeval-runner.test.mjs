import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { row, keys } from './helpers/longmemeval-http.mjs';

test('isolated synthetic CLI lifecycle verifies both modes and rejects source-valid forged tool results', () => {
    // The child alone substitutes a tiny dataset profile; no global configuration or clock state escapes this test.
    const program = `
        import assert from 'node:assert/strict';
        import { mkdtemp, writeFile, rm } from 'node:fs/promises';
        import { tmpdir } from 'node:os';
        import path from 'node:path';
        import { config, prepare, run, verify } from './benchmark/longmemeval/run.mjs';
        import { hash, jsonHash } from './benchmark/longmemeval/protocol.mjs';
        import { readJSON, atomic } from './benchmark/longmemeval/runtime.mjs';
        import { nativeFixture } from './test/helpers/longmemeval-http.mjs';
        const row = ${JSON.stringify(row())};
        const bytes = JSON.stringify([row]);
        Object.assign(config.dataset, { bytes: Buffer.byteLength(bytes), sha256: hash(bytes), questions: 1 });
        const keys = ${JSON.stringify(keys)};
        keys.connection = jsonHash([keys.database, keys.project]);
        const originalNow = Date.now;
        for (const mode of ['single', 'tools']) {
            const root = await mkdtemp(path.join(tmpdir(), 'memdrive-lme-full-'));
            try {
                await writeFile(path.join(root, 'dataset.json'), bytes);
                await prepare(root, mode, 1);
                const wire = nativeFixture();
                let clock = originalNow(); Date.now = () => clock;
                const fetcher = async (url, options) => {
                    if (url.startsWith(keys.database)) return wire.fetcher(url, options);
                    const request = JSON.parse(options.body);
                    if (url === config.judge.endpoint) return new Response(JSON.stringify({ model: config.judge.model,
                        answers: { correct: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 10 } }), { status: 200 });
                    let message = { role: 'assistant', content: 'cedar' }, finish_reason = 'stop';
                    if (request.tools) {
                        const outputs = request.messages.filter(message => message.role === 'tool');
                        const tool = outputs.find(message => JSON.parse(message.content).value?.results);
                        if (!tool) {
                            const step = outputs.length;
                            const name = step < 3 ? 'memdrive_count_values' : 'memdrive_recall';
                            const args = step < 3 ? { fields: ['metadata.role'] } : { requests: [{ query: 'key' }] };
                            // Exercise value-cache expiry and then schema-cache expiry without real waiting.
                            clock += step === 1 ? 61000 : step === 2 ? 301000 : 0;
                            message = { role: 'assistant', content: null, tool_calls: [{ id: 'search-' + step, type: 'function',
                                function: { name, arguments: JSON.stringify(args) } }] };
                            finish_reason = 'tool_calls';
                        } else {
                            const match = JSON.parse(tool.content).value.results[0].matches[0];
                            message.content = JSON.stringify({ evidence: [{ memId: match.memId, start: match.start, end: match.end }] });
                        }
                    }
                    return new Response(JSON.stringify({ model: config.model.model, choices: [{ message, finish_reason }],
                        usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 });
                };
                const result = await run(root, keys, { fetcher }); Date.now = originalNow;
                assert.equal(result.accuracy, 1); assert.equal(result.complete, true);
                assert.deepEqual(await verify(root), result); assert.equal(Date.now, originalNow);
                const file = path.join(root, 'questions', hash(row.question_id), 'tools.json');
                const events = await readJSON(file);
                events.find(event => event.name === 'memdrive_recall').raw.value.results[0].matches.reverse();
                await atomic(file, events);
                await assert.rejects(verify(root), /native receipt replay/); assert.equal(Date.now, originalNow);
            } finally { Date.now = originalNow; await rm(root, { recursive: true, force: true }); }
        }
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', program], { cwd: new URL('..', import.meta.url), stdio: 'pipe' });
});
