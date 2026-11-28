import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { amendmentsFor, amendmentsProtocol, loadAmendments, parseAmendments } from '../benchmark/beam/replay-amendments.mjs';
import { hash } from '../benchmark/beam/replay-sessions.mjs';

const config = JSON.parse(await readFile(new URL('../benchmark/beam/original-config.json', import.meta.url), 'utf8'));
const prepared = { split: '100k', datasetRevision: config.cohorts['100k'].datasetRevision };
const file = ({ rules = [], questions = {}, ...rest } = {}) => ({ protocol: amendmentsProtocol, ...prepared, rules, questions, ...rest });
const rule = (overrides = {}) => ({ id: 'ask', category: 'contradiction', original: 'Says which is correct', replacement: 'Asks which is correct',
    reason: 'Read both ways', ...overrides });
const change = (overrides = {}) => ({ index: 1, original: 'B', replacement: 'B, as the answer key says', reason: 'Contradicts the answer key', ...overrides });

// Conversation 3, synthetic: the rule's text appears in both contradiction questions, in another
// category and as a near miss.
const evaluation = [
    { id: '3_contradiction_0', category: 'contradiction', rubric: ['Says which is correct', 'Names both statements'] },
    { id: '3_contradiction_1', category: 'contradiction', rubric: ['Mentions the date', 'Says which is correct'] },
    { id: '3_summary_0', category: 'summary', rubric: ['Says which is correct'] },
    { id: '3_contradiction_2', category: 'contradiction', rubric: ['Says which is correct.', 'says which is correct'] },
    { id: '3_extraction_0', category: 'extraction', rubric: ['A', 'B', 'C'] },
];
const apply = value => Object.fromEntries(amendmentsFor(parseAmendments(value), prepared, '3', evaluation));

test('a rule replaces every item of its category with exactly its text, and nothing else', () => {
    assert.deepEqual(apply(file({ rules: [rule()] })), {
        '3_contradiction_0': { items: [{ index: 0, replacement: 'Asks which is correct', rule: 'ask' }] },
        '3_contradiction_1': { items: [{ index: 1, replacement: 'Asks which is correct', rule: 'ask' }] } });
    // Question entries amend single items or exclude a question; entries for other conversations do not apply.
    assert.deepEqual(apply(file({ rules: [rule()], questions: { '3_extraction_0': { rubric: [change({ index: 2, original: 'C', replacement: 'C or D' }), change()] },
        '3_contradiction_1': { exclude: 'The premise does not hold' }, '4_extraction_0': { exclude: 'Another conversation' },
        '30_extraction_0': { rubric: [change({ index: 9 })] } } })), {
        '3_contradiction_0': { items: [{ index: 0, replacement: 'Asks which is correct', rule: 'ask' }] },
        '3_contradiction_1': { excluded: 'The premise does not hold' },
        '3_extraction_0': { items: [{ index: 1, replacement: 'B, as the answer key says', reason: 'Contradicts the answer key' },
            { index: 2, replacement: 'C or D', reason: 'Contradicts the answer key' }] } });
    assert.deepEqual(apply(file()), {});
});

test('amendments are refused with a reason when their structure or their quotes are wrong', () => {
    const refused = (value, pattern) => assert.throws(() => apply(value), pattern);
    refused({ ...file(), extra: 1 }, /Amendments has unknown keys: extra/);
    const { questions, ...withoutQuestions } = file();
    assert.deepEqual(questions, {});
    refused(withoutQuestions, /Amendments lacks questions/);
    refused(file({ protocol: 'memdrive-beam-amendments-v0' }), /protocol must be memdrive-beam-amendments-v1/);
    refused(file({ rules: [{ ...rule(), note: 'x' }] }), /rule ask has unknown keys: note/);
    refused(file({ rules: [rule(), rule({ id: 'again', replacement: 'Other' })] }), /rule again amends the same items as an earlier rule/);
    refused(file({ rules: [rule(), rule({ category: 'summary' })] }), /rule ask: id must be nonempty and unique/);
    refused(file({ rules: [rule({ replacement: 'Says which is correct' })] }), /replacement must be nonempty and differ from original/);
    refused(file({ rules: [rule({ replacement: ' ' })] }), /replacement must be nonempty/);
    refused(file({ questions: { '3_extraction_0': { exclude: 'x', rubric: [change()] } } }), /needs exactly one of exclude and rubric/);
    refused(file({ questions: { '3_extraction_0': {} } }), /needs exactly one of exclude and rubric/);
    refused(file({ questions: { '3_extraction_0': { drop: 'x' } } }), /unknown keys: drop/);
    refused(file({ questions: { '3_extraction_0': { exclude: '' } } }), /exclude must be a nonempty reason/);
    refused(file({ questions: { '3_extraction_0': { rubric: [{ ...change(), weight: 1 }] } } }), /rubric entry has unknown keys: weight/);
    refused(file({ questions: { '3_extraction_0': { rubric: [change({ index: -1 })] } } }), /zero-based integer/);
    refused(file({ questions: { '3_extraction_0': { rubric: [change(), change()] } } }), /rubric item 1 is amended twice/);
    refused(file({ questions: { '3_extraction_0': { rubric: [change({ replacement: 'B' })] } } }), /differ from original/);
    // Against the conversation: the dataset, the question, the item and its exact text.
    refused(file({ split: '500k' }), /for split 500k at revision .*, not 100k at/);
    refused(file({ datasetRevision: 'other' }), /at revision other, not 100k/);
    refused(file({ questions: { '3_extraction_9': { exclude: 'x' } } }), /3_extraction_9: conversation 3 has no such question/);
    refused(file({ questions: { '3_extraction_0': { rubric: [change({ index: 3 })] } } }), /rubric item 3 does not exist/);
    refused(file({ questions: { '3_extraction_0': { rubric: [change({ original: 'B ' })] } } }), /rubric item 1 is not the quoted original text/);
    // A rule and a question entry may not amend the same item.
    refused(file({ rules: [rule()], questions: { '3_contradiction_0': { rubric: [change({ index: 0, original: 'Says which is correct' })] } } }),
        /Rubric item 0 of 3_contradiction_0 is amended twice/);
});

test('the committed amendments file validates against the committed configuration', async t => {
    const { sha256, amendments } = await loadAmendments();
    assert.equal(sha256, hash(await readFile(new URL('../benchmark/beam/amendments.json', import.meta.url))));
    assert.equal(config.cohorts[amendments.split]?.datasetRevision, amendments.datasetRevision);
    // Every rule applies to a synthetic question of its category that quotes it.
    const synthetic = amendments.rules.map((entry, index) => ({ id: `synthetic_${index}`, category: entry.category, rubric: ['Other item', entry.original] }));
    const applied = amendmentsFor(amendments, { split: amendments.split, datasetRevision: amendments.datasetRevision }, 'synthetic', synthetic);
    assert.deepEqual([...applied.values()], amendments.rules.map(entry => ({ items: [{ index: 1, replacement: entry.replacement, rule: entry.id }] })));
    // Unreadable JSON is refused as such.
    const directory = await mkdtemp(path.join(tmpdir(), 'beam-amendments-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(path.join(directory, 'amendments.json'), '{');
    await assert.rejects(loadAmendments(path.join(directory, 'amendments.json')), /not valid JSON/);
});
