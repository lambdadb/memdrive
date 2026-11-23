import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const readLocalJSON = async name => JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'));
const config = await readLocalJSON('./original-config.json');
const prompts = await readLocalJSON('./original-prompts.json');
assert.equal(prompts.upstreamRevision, config.upstream.revision);

export const hash = value => createHash('sha256').update(value).digest('hex');
export const estimate = text => Math.ceil(Array.from(text).length / 4);
export const metadataSchema = Object.freeze(Object.fromEntries([
    ['sourceId', 'string'], ['turnId', 'string'], ['role', 'string'], ['author', 'string'],
    ['sourceKind', 'string'], ['ordinal', 'number'], ['timestamp', 'datetime'],
].map(([name, type]) => [name, Object.freeze({ type })])));

const nonblank = text => typeof text === 'string' && Boolean(text.trim()) && !/\p{Surrogate}/u.test(text);
const exactKeys = (value, keys) => value && typeof value === 'object'
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const batchTimestamp = text => typeof text === 'string' && /^\d{4}-\d{2}-\d{2}T12:00:00\.000Z$/.test(text)
    && !Number.isNaN(Date.parse(text)) && new Date(text).toISOString() === text;

export async function frozenConversation(manifestFile, id) {
    assert(/^\d+$/.test(id), 'Choose one prepared numeric conversation ID');
    const manifestBytes = await readFile(manifestFile);
    const manifest = JSON.parse(manifestBytes);
    assert.equal(manifest.protocol, config.protocol, 'Use an original-BEAM manifest');
    assert.equal(manifest.questionPosition, 'after_complete_conversation');
    const cohort = Object.hasOwn(config.cohorts, manifest.split) && config.cohorts[manifest.split];
    assert(cohort, 'Unknown original BEAM split');
    assert.equal(manifest.datasetRevision, cohort.datasetRevision, 'Unexpected dataset revision');
    assert.deepEqual(manifest.sourceFiles, Object.fromEntries(cohort.files.map(file => [file.name, file.sha256])),
        'Unexpected prepared dataset source hashes');
    const entries = manifest.conversations.filter(entry => entry.id === id);
    assert.equal(entries.length, 1, 'Choose one conversation from the prepared manifest');
    const [entry] = entries;
    assert.equal(entry.runtime, `conversations/${id}.json`, 'Unexpected runtime path');
    const bytes = await readFile(path.join(path.dirname(manifestFile), entry.runtime));
    const runtimeSha256 = hash(bytes);
    assert(runtimeSha256 === entry.runtimeSha256, 'Prepared runtime checksum changed');
    const source = JSON.parse(bytes);
    assert.equal(source.id, id, 'Conversation identity changed');
    assert.equal(source.questions.length, entry.questions, 'Question count changed');
    return { manifestSha256: hash(manifestBytes), runtimeSha256, ...prepareConversation(source) };
}

export function prepareConversation(conversation) {
    assert.equal(conversation.protocol, config.protocol, 'Use original BEAM conversation input');
    const { id, userIdentity, messages, questions, userTraits } = conversation;
    assert(typeof id === 'string' && /^\d+$/.test(id) && nonblank(userIdentity), 'Invalid conversation identity');
    assert(exactKeys(userTraits, []) || (exactKeys(userTraits, ['profile']) && nonblank(userTraits.profile)), 'Invalid profile');
    assert(Array.isArray(messages) && messages.length > 0, 'Missing conversation messages');
    const sourceIds = new Set();
    for (const [ordinal, message] of messages.entries()) {
        assert(exactKeys(message, ['sourceId', 'ordinal', 'content', 'author', 'timestamp', 'turnId']), 'Invalid message fields');
        assert.equal(message.ordinal, ordinal, 'Messages must retain original order');
        assert(nonblank(message.sourceId) && !sourceIds.has(message.sourceId), 'Invalid or duplicate source ID');
        sourceIds.add(message.sourceId);
        assert(nonblank(message.content) && typeof message.turnId === 'string', 'Invalid message content or original turn ID');
        assert(exactKeys(message.author, ['role', 'name']) && ['user', 'assistant'].includes(message.author.role)
            && nonblank(message.author.name), 'Invalid source author');
        assert(message.timestamp === null || batchTimestamp(message.timestamp), 'Invalid batch timestamp');
    }
    assert(Array.isArray(questions) && questions.length > 0, 'Missing questions');
    const questionIds = new Set();
    for (const question of questions) {
        assert(exactKeys(question, ['id', 'text']), 'Only question ID and text enter the runtime');
        assert(nonblank(question.id) && nonblank(question.text) && !questionIds.has(question.id), 'Invalid or duplicate question');
        questionIds.add(question.id);
    }

    // A hypothetical question is always the fifth retained item. BEAM histories
    // have no generation IDs; if the boundary cuts the first reply, keep its input.
    let boundary = Math.max(0, messages.length - 4);
    if (boundary > 0 && messages[boundary].author.role === 'assistant' && messages[boundary - 1].author.role === 'user') boundary--;
    const recent = messages.slice(boundary).map(({ sourceId, turnId, author, content }) => ({
        sourceId, turnId, role: author.role, content,
    }));
    const files = messages.slice(0, boundary).map(({ sourceId, ordinal, content, author, timestamp, turnId }) => ({
        path: `/messages/${ordinal}.txt`, content, metadata: { sourceId, turnId, ordinal, role: author.role, author: author.name,
            sourceKind: 'conversation', ...(timestamp === null ? {} : { timestamp }) },
    }));
    if (Object.hasOwn(userTraits, 'profile')) files.push({
        path: '/profile.json', content: JSON.stringify(userTraits),
        metadata: { sourceId: `${id}_profile`, turnId: '', ordinal: -1, role: 'user', author: userIdentity, sourceKind: 'profile' },
    });
    return { boundary, recent, files, questions, profile: userTraits,
        fingerprint: hash(JSON.stringify(files)) };
}

export function searchRequest(question, prepared, { retrievalInput, limit, rerank }) {
    const { recent, profile } = prepared;
    const embeddingQuery = retrievalInput === 'contextual' ? JSON.stringify({
        question: question.text,
        ...(recent.length ? { recent_dialogue: recent.map(({ role, content }) => ({ role, content })) } : {}),
        context: JSON.stringify(profile),
    }) : undefined;
    assert(Buffer.byteLength(question.text) <= 8192 && (embeddingQuery === undefined || Buffer.byteLength(embeddingQuery) <= 8192),
        'BEAM search input exceeds 8192 UTF-8 bytes; use --retrieval-input question if the recent dialogue or profile is too large');
    return { query: question.text, mode: 'hybrid', ...(embeddingQuery === undefined ? {} : { embeddingQuery }), limit, rerank };
}

const splitsSurrogate = (text, at) => at > 0 && at < text.length
    && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]);

export function packEvidence(hits, originals, budget, countTokens) {
    const results = [], omitted = [], seen = new Set();
    let units = 0;
    for (const hit of hits) {
        const { fileId, path, content, metadata, range } = hit;
        const original = originals.get(fileId);
        assert(original && path === original.path, 'Evidence refers to an ineligible BEAM file');
        assert.deepEqual(metadata, original.metadata, 'Evidence metadata differs from the archived source');
        assert(nonblank(content), 'Missing evidence excerpt');
        const start = range === undefined ? original.content.indexOf(content) : range.start;
        const end = range === undefined ? start + content.length : range.end;
        if (range === undefined && (start < 0 || original.content.indexOf(content, start + 1) >= 0)) {
            omitted.push({ fileId, path, reason: 'unattributed' });
            continue;
        }
        assert(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start && end <= original.content.length
            && !splitsSurrogate(original.content, start) && !splitsSurrogate(original.content, end), 'Invalid UTF-16 source span');
        assert(content === original.content.slice(start, end), 'Evidence differs from the archived source');
        const key = JSON.stringify([fileId, start, end]);
        if (seen.has(key)) { omitted.push({ fileId, path, start, end, reason: 'duplicate' }); continue; }
        seen.add(key);
        const size = estimate(content);
        if (units + size > budget) { omitted.push({ fileId, path, start, end, reason: 'budget' }); continue; }
        units += size;
        const { timestamp, ...source } = metadata;
        results.push({ fileId, path, ...source, passage: results.length, start, end, content,
            ...(timestamp ? { conversationTimestamp: timestamp } : {}) });
    }
    const context = { usedEvidenceTokens: units, results };
    return { context, omitted, serializedTokens: countTokens(JSON.stringify(context)) };
}

export function answerRequest(question, prepared, delivery) {
    const values = { question: question.text, context: JSON.stringify({
        recent_dialogue: prepared.recent, profile: prepared.profile, evidence: delivery.context,
    }) };
    // Source content containing placeholders remains literal.
    const prompt = prompts.answer_generation_for_rag.replace(/<(context|question)>/g, (_, key) => values[key]);
    return { model: 'gpt-6.1-sol', reasoning_effort: 'medium', messages: [{ role: 'user', content: prompt }] };
}
