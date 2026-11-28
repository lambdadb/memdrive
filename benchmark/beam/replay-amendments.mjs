// Recorded corrections to defective BEAM rubric items and questions. The dataset and its
// scores stay as they are: the question stage and rejudge always judge the original rubric,
// and judge amended items again with their replacement text for a separate amended score.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hash } from './replay-sessions.mjs';

export const amendmentsProtocol = 'memdrive-beam-amendments-v1';
/** The committed amendments; the CLI always uses this file. */
export const amendmentsFile = new URL('./amendments.json', import.meta.url);
export const amendmentSettings = Object.freeze(['on', 'off']);

const nonempty = value => typeof value === 'string' && value.trim() !== '';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function exactKeys(value, required, what) {
    assert(isObject(value), `${what} must be an object`);
    const unknown = Object.keys(value).filter(key => !required.includes(key)), missing = required.filter(key => !Object.hasOwn(value, key));
    assert(!unknown.length, `${what} has unknown keys: ${unknown.join(', ')}`);
    assert(!missing.length, `${what} lacks ${missing.join(', ')}`);
}
function replacement(entry, what) {
    assert(nonempty(entry.original), `${what}: original must be nonempty text`);
    assert(nonempty(entry.replacement) && entry.replacement !== entry.original, `${what}: replacement must be nonempty and differ from original`);
    assert(nonempty(entry.reason), `${what}: reason must be nonempty text`);
}

/** Check the file's own structure, which needs no dataset. Returns the value unchanged. */
export function parseAmendments(value) {
    exactKeys(value, ['protocol', 'split', 'datasetRevision', 'rules', 'questions'], 'Amendments');
    assert.equal(value.protocol, amendmentsProtocol, `Amendments protocol must be ${amendmentsProtocol}`);
    assert(nonempty(value.split) && nonempty(value.datasetRevision), 'Amendments need split and datasetRevision');
    assert(Array.isArray(value.rules), 'Amendment rules must be a list');
    const ids = new Set(), targets = new Set();
    for (const [position, rule] of value.rules.entries()) {
        const what = `Amendment rule ${nonempty(rule?.id) ? rule.id : position}`;
        exactKeys(rule, ['id', 'category', 'original', 'replacement', 'reason'], what);
        assert(nonempty(rule.id) && !ids.has(rule.id), `${what}: id must be nonempty and unique`);
        assert(nonempty(rule.category), `${what}: category must be nonempty text`);
        replacement(rule, what);
        // Two rules with one target would amend the same items twice.
        const target = JSON.stringify([rule.category, rule.original]);
        assert(!targets.has(target), `${what} amends the same items as an earlier rule`);
        ids.add(rule.id);
        targets.add(target);
    }
    assert(isObject(value.questions), 'Amendment questions must be an object keyed by question ID');
    for (const [id, entry] of Object.entries(value.questions)) {
        const what = `Amendment of ${id}`;
        assert(isObject(entry), `${what} must be an object`);
        const unknown = Object.keys(entry).filter(key => !['exclude', 'rubric'].includes(key));
        assert(!unknown.length, `${what} has unknown keys: ${unknown.join(', ')}`);
        assert(Object.hasOwn(entry, 'exclude') !== Object.hasOwn(entry, 'rubric'), `${what} needs exactly one of exclude and rubric`);
        if (Object.hasOwn(entry, 'exclude')) {
            assert(nonempty(entry.exclude), `${what}: exclude must be a nonempty reason`);
            continue;
        }
        assert(Array.isArray(entry.rubric) && entry.rubric.length, `${what}: rubric must be a nonempty list`);
        const indexes = new Set();
        for (const change of entry.rubric) {
            exactKeys(change, ['index', 'original', 'replacement', 'reason'], `${what} rubric entry`);
            assert(Number.isSafeInteger(change.index) && change.index >= 0, `${what}: index must be a zero-based integer`);
            assert(!indexes.has(change.index), `${what}: rubric item ${change.index} is amended twice`);
            indexes.add(change.index);
            replacement(change, `${what} rubric item ${change.index}`);
        }
    }
    return value;
}

/** Read and check the amendments file; `sha256` is of its bytes. */
export async function loadAmendments(file = amendmentsFile) {
    const bytes = await readFile(file);
    let value;
    try { value = JSON.parse(bytes); } catch { assert.fail('The amendments file is not valid JSON'); }
    return { sha256: hash(bytes), amendments: parseAmendments(value) };
}

/**
 * The amendments that apply to one conversation, by question ID: `{ excluded: reason }` or
 * `{ items }`, its amended rubric items in rubric order as `{ index, replacement, rule }` or
 * `{ index, replacement, reason }`. A rule replaces every item of its category whose text is
 * exactly `original`. BEAM question IDs start with their conversation ID and `_`: an entry with
 * this conversation's prefix must name one of its questions and quote the item exactly, and
 * other entries belong to other conversations. Whether a rule matches anything in the whole
 * dataset is not checked here: one conversation can legitimately have no match.
 */
export function amendmentsFor(amendments, prepared, conversationId, evaluation) {
    assert(amendments.split === prepared.split && amendments.datasetRevision === prepared.datasetRevision,
        `The amendments are for split ${amendments.split} at revision ${amendments.datasetRevision}, not ${prepared.split} at ${prepared.datasetRevision}`);
    const prefix = `${conversationId}_`;
    assert(evaluation.every(question => question.id.startsWith(prefix)), 'Evaluation question IDs do not start with their conversation ID');
    const amended = new Map();
    const add = (id, item) => {
        const items = amended.get(id) ?? new Map();
        assert(!items.has(item.index), `Rubric item ${item.index} of ${id} is amended twice`);
        amended.set(id, items.set(item.index, item));
    };
    for (const rule of amendments.rules) for (const question of evaluation) if (question.category === rule.category)
        for (const [index, item] of question.rubric.entries()) if (item === rule.original) add(question.id, { index, replacement: rule.replacement, rule: rule.id });
    const questions = new Map(evaluation.map(question => [question.id, question])), excluded = new Map();
    for (const [id, entry] of Object.entries(amendments.questions)) {
        if (!id.startsWith(prefix)) continue;
        const question = questions.get(id);
        assert(question, `Amendment of ${id}: conversation ${conversationId} has no such question`);
        if (Object.hasOwn(entry, 'exclude')) { excluded.set(id, entry.exclude); continue; }
        for (const { index, original, replacement, reason } of entry.rubric) {
            assert(index < question.rubric.length, `Amendment of ${id}: rubric item ${index} does not exist`);
            assert(question.rubric[index] === original, `Amendment of ${id}: rubric item ${index} is not the quoted original text`);
            add(id, { index, replacement, reason });
        }
    }
    // An excluded question has no amended score, so its amended items are not judged.
    return new Map(evaluation.filter(question => excluded.has(question.id) || amended.has(question.id)).map(question => [question.id,
        excluded.has(question.id) ? { excluded: excluded.get(question.id) } : { items: [...amended.get(question.id).values()].sort((a, b) => a.index - b.index) }]));
}

/** The question's rubric outcomes with each amended item's outcome in its place. */
export const withAmended = (outcomes, amended) => outcomes.map(outcome => amended.find(item => item.index === outcome.index) ?? outcome);
