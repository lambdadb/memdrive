// Session view of a prepared original-BEAM conversation for the write-path replay.
// Only user utterances are replayed; evaluation annotations are never read here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const config = JSON.parse(await readFile(new URL('./original-config.json', import.meta.url), 'utf8'));
export const hash = value => createHash('sha256').update(value).digest('hex');

/** SHA-256 of every file below `directory`, keyed by its path relative to `base`. */
export async function fingerprint(directory, base) {
    const result = {};
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) Object.assign(result, await fingerprint(file, base));
        else result[path.relative(base, file)] = hash(await readFile(file));
    }
    return result;
}

const nonblank = text => typeof text === 'string' && Boolean(text.trim()) && !/\p{Surrogate}/u.test(text);

/**
 * Group messages by their original batch and keep each batch's user utterances in order.
 * Only the list layout (`<conversation>_s###_t####`) carries a batch per source ID.
 */
export function groupSessions(conversation) {
    assert.equal(conversation?.protocol, config.protocol, 'Use original BEAM conversation input');
    const { id, messages } = conversation;
    assert(typeof id === 'string' && /^\d+$/.test(id), 'Invalid conversation identity');
    assert(Array.isArray(messages) && messages.length > 0, 'Missing conversation messages');
    const sessions = [], seen = new Set();
    let lastBatch = -1;
    for (const [ordinal, message] of messages.entries()) {
        assert.equal(message?.ordinal, ordinal, 'Messages must retain original order');
        const { sourceId, turnId, content, author, timestamp } = message;
        assert(nonblank(sourceId) && !seen.has(sourceId), 'Invalid or duplicate source ID');
        seen.add(sourceId);
        const match = sourceId.startsWith(`${id}_`) && /^s(\d{3})_t\d{4}$/.exec(sourceId.slice(id.length + 1));
        assert(match, 'Unsupported BEAM conversation layout: sessions require <conversation>_s###_t#### source IDs');
        assert(nonblank(content) && typeof turnId === 'string', 'Invalid message content or original turn ID');
        assert(['user', 'assistant'].includes(author?.role), 'Invalid source author');
        assert(timestamp === null || typeof timestamp === 'string', 'Invalid batch timestamp');
        const batch = Number(match[1]);
        if (batch !== lastBatch) {
            assert(batch > lastBatch, 'Session batches must appear in ascending order');
            sessions.push({ id: `s${match[1]}`, index: sessions.length, timestamp: null, messages: 0, turns: [] });
            lastBatch = batch;
        }
        const session = sessions.at(-1);
        session.messages++;
        session.timestamp ??= timestamp;
        if (author.role === 'user') session.turns.push({ sourceId, turnId, content });
    }
    for (const session of sessions) assert(session.turns.length > 0, 'A session has no user utterance');
    return sessions;
}

/** Load one conversation after checking the prepared manifest, pinned source hashes and runtime checksum. */
export async function loadSessions(manifestFile, id) {
    assert(typeof id === 'string' && /^\d+$/.test(id), 'Choose one prepared numeric conversation ID');
    const manifestBytes = await readFile(manifestFile);
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.protocol, config.protocol, 'Use an original-BEAM manifest');
    const cohort = Object.hasOwn(config.cohorts, manifest.split) && config.cohorts[manifest.split];
    assert(cohort, 'Unknown original BEAM split');
    assert.equal(manifest.datasetRevision, cohort.datasetRevision, 'Unexpected dataset revision');
    assert.deepEqual(manifest.sourceFiles, Object.fromEntries(cohort.files.map(file => [file.name, file.sha256])),
        'Unexpected prepared dataset source hashes');
    const entries = Array.isArray(manifest.conversations) ? manifest.conversations.filter(entry => entry.id === id) : [];
    assert.equal(entries.length, 1, 'Choose one conversation from the prepared manifest');
    const [entry] = entries;
    assert.equal(entry.runtime, `conversations/${id}.json`, 'Unexpected runtime path');
    const bytes = await readFile(path.join(path.dirname(manifestFile), entry.runtime));
    const runtimeSha256 = hash(bytes);
    assert(runtimeSha256 === entry.runtimeSha256, 'Prepared runtime checksum changed');
    const source = JSON.parse(bytes);
    assert.equal(source.id, id, 'Conversation identity changed');
    return { id, split: manifest.split, manifestSha256: hash(manifestBytes), runtimeSha256, sessions: groupSessions(source) };
}
