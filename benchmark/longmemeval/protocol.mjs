import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const jsonHash = value => hash(JSON.stringify(value));
export const metadataSchema = {
    role: { type: 'string', description: 'Original message author: user or assistant.' },
    sessionId: { type: 'string', description: 'Original conversation session identifier.' },
    session: { type: 'number', description: 'One-based chronological session position.' },
    message: { type: 'number', description: 'Zero-based message position across this history.' },
    timestamp: { type: 'string', description: 'Original dataset session clock interpreted as UTC.' },
};
export const integer = value => Number.isSafeInteger(value) && value >= 0;

export function timestamp(value) {
    assert.equal(typeof value, 'string');
    const parts = /^(\d{4})\/(\d{2})\/(\d{2}) \([A-Za-z]+\) (\d{2}):(\d{2})$/.exec(value);
    assert(parts, 'Invalid dataset date');
    const [year, month, day, hour, minute] = parts.slice(1).map(Number);
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day); date.setUTCHours(hour, minute, 0, 0);
    assert(date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
        && date.getUTCHours() === hour && date.getUTCMinutes() === minute, 'Invalid calendar date');
    return date.toISOString();
}

// Only this allowlist crosses into storage or model input. Evaluation labels stay in the original row.
export function prepareCase(row, config) {
    assert.equal(typeof row.question_id, 'string'); assert.equal(typeof row.question, 'string');
    assert(row.question.trim());
    assert(Array.isArray(row.haystack_sessions) && row.haystack_sessions.length > 0);
    assert.equal(row.haystack_sessions.length, row.haystack_dates.length);
    assert.equal(row.haystack_sessions.length, row.haystack_session_ids.length);
    let index = 0;
    const messages = row.haystack_sessions.flatMap((session, sessionIndex) => {
        assert(Array.isArray(session) && session.length > 0);
        const date = row.haystack_dates[sessionIndex], time = timestamp(date);
        const sessionId = row.haystack_session_ids[sessionIndex]; assert.equal(typeof sessionId, 'string');
        return session.map(turn => {
            assert(['user', 'assistant'].includes(turn.role)); assert.equal(typeof turn.content, 'string');
            const message = index++;
            return { path: `/sessions/${sessionIndex + 1}/messages/${message}.txt`, content: turn.content,
                metadata: { role: turn.role, sessionId, session: sessionIndex + 1, message, timestamp: time } };
        });
    });
    let boundary = Math.max(0, messages.length - config.retrieval.recentMessagesIncludingQuestion + 1);
    // Keep the immediately preceding user/assistant pair whole at the recent boundary.
    if (boundary > 0 && messages[boundary].metadata.role === 'assistant'
        && messages[boundary - 1].metadata.role === 'user' && messages[boundary - 1].content.trim()) boundary--;
    return { id: row.question_id, question: row.question, questionTimestamp: timestamp(row.question_date), boundary,
        files: messages.slice(0, boundary).filter(file => file.content.trim()), recent: messages.slice(boundary) };
}

export const fileIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const spanKey = span => JSON.stringify([span.fileId, span.start, span.end]);
const splitSurrogate = (text, offset) => offset > 0 && offset < text.length
    && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]);

export function sourceFiles(prepared, fileIds) {
    assert(Array.isArray(fileIds), 'Corpus file IDs must be an array');
    assert.equal(fileIds.length, prepared.files.length, 'Corpus file ID count differs');
    assert(fileIds.every(fileId => typeof fileId === 'string' && fileIdPattern.test(fileId)), 'Invalid corpus file ID');
    assert.equal(new Set(fileIds).size, fileIds.length, 'Duplicate corpus file ID');
    return new Map(prepared.files.map((file, i) => [fileIds[i], file]));
}

export function validateSpan(span, sources) {
    const original = sources.get(span.fileId);
    assert(original, 'Evidence does not belong to the archived source');
    assert.equal(span.path, original.path, 'Evidence file path differs');
    assert(integer(span.start) && integer(span.end) && span.start < span.end && span.end <= original.content.length,
        'Invalid evidence bounds');
    assert(!splitSurrogate(original.content, span.start) && !splitSurrogate(original.content, span.end), 'Split Unicode character');
    assert.equal(span.content, original.content.slice(span.start, span.end), 'Evidence text differs from source');
    assert.deepEqual(span.metadata, original.metadata, 'Evidence metadata differs');
    return span;
}

export function resultSpans(name, result, sources) {
    if (!result.ok) return [];
    assert(['search_files', 'read_file'].includes(name), 'Unexpected file tool result');
    const values = name === 'search_files' ? result.value.hits : [result.value];
    return values.flatMap(file => {
        const { fileId, path, content, metadata, range } = file;
        assert.equal(typeof content, 'string', 'Expected original or excerpt text');
        const original = sources.get(fileId);
        assert(original, 'Evidence does not belong to the archived source');
        assert.equal(path, original.path, 'Evidence file path differs');
        assert.deepEqual(metadata, original.metadata, 'Evidence metadata differs');
        if (name === 'read_file') assert.equal(content, original.content, 'Read original differs from source');
        // A range-free hit is attributable only when its text has a unique position in the original.
        if (range !== undefined) {
            assert(range && typeof range === 'object', 'Invalid evidence bounds');
            return [validateSpan({ fileId, path, content, metadata, start: range.start, end: range.end }, sources)];
        }
        const start = original.content.indexOf(content);
        if (!content || start < 0 || original.content.indexOf(content, start + 1) >= 0) return [];
        return [validateSpan({ fileId, path, content, metadata, start, end: start + content.length }, sources)];
    });
}

export function selectEvidence(selection, available) {
    assert(selection && Object.keys(selection).length === 1 && Array.isArray(selection.evidence), 'Expected evidence selection JSON');
    const byKey = new Map(available.map(span => [spanKey(span), span]));
    const selected = [], seen = new Set();
    for (const ref of selection.evidence) {
        assert(ref && Object.keys(ref).length === 3 && Object.keys(ref).every(key => ['fileId', 'start', 'end'].includes(key)),
            'Expected file ID and range in evidence selection');
        const key = spanKey(ref), span = byKey.get(key);
        assert(span, 'Selected evidence was not delivered to the model');
        if (!seen.has(key)) { selected.push(span); seen.add(key); }
    }
    return selected;
}

function merged(spans) {
    const sorted = [...spans].sort((a, b) => a.metadata.message - b.metadata.message || a.start - b.start);
    const result = [];
    for (const span of sorted) {
        const last = result.at(-1);
        if (last && last.path === span.path && span.start <= last.end) {
            if (span.end > last.end) { last.content += span.content.slice(last.end - span.start); last.end = span.end; }
        } else result.push({ ...span });
    }
    return result;
}
function render(spans) {
    return JSON.stringify(merged(spans).map(span => ({ path: span.path, role: span.metadata.role,
        session: span.metadata.session, timestamp: span.metadata.timestamp, start: span.start, end: span.end, content: span.content })));
}
export function context(prepared) {
    return { question: prepared.question, questionTimestamp: prepared.questionTimestamp,
        recentDialogue: prepared.recent.map(file => ({ role: file.metadata.role, timestamp: file.metadata.timestamp, content: file.content })) };
}
export function packEvidence(prepared, ranked, config, countTokens, sources) {
    const admitted = [];
    for (const candidate of ranked) {
        validateSpan(candidate, sources);
        const next = [...admitted, candidate];
        if (countTokens(render(next)) <= config.retrieval.memoryTokens) admitted.push(candidate);
    }
    const spans = merged(admitted), evidence = render(spans);
    return { spans, memoryTokens: countTokens(evidence), request: { ...config.model, messages: [
        { role: 'system', content: config.prompts.answer },
        { role: 'user', content: JSON.stringify({ ...context(prepared), evidence: JSON.parse(evidence) }) },
    ] } };
}

function coverage(targets, spans) {
    if (!targets.length) return { annotatedTurns: 0, anyTurnRecall: null, fullTurnRecall: null };
    const joined = merged(spans);
    let any = 0, full = 0;
    for (const file of targets) {
        const matches = joined.filter(span => span.path === file.path);
        if (matches.length) any++;
        if (matches.some(span => span.start === 0 && span.end === file.content.length)) full++;
    }
    return { annotatedTurns: targets.length, anyTurnRecall: any / targets.length, fullTurnRecall: full / targets.length };
}
export function evidenceMetrics(row, prepared, stages) {
    if (row.question_id.endsWith('_abs')) return { applicable: false, reason: 'abstention' };
    const all = [...prepared.files, ...prepared.recent], goldIndexes = [];
    let index = 0;
    for (const session of row.haystack_sessions) for (const turn of session) { if (turn.has_answer === true) goldIndexes.push(index); index++; }
    const gold = all.filter(file => goldIndexes.includes(file.metadata.message));
    const archived = gold.filter(file => file.metadata.message < prepared.boundary);
    const recent = prepared.recent.filter(file => goldIndexes.includes(file.metadata.message));
    const recentSpans = prepared.recent.filter(file => file.content.length).map(file => ({ ...file, start: 0, end: file.content.length }));
    const sessions = [...new Set(row.answer_session_ids ?? [])];
    return { applicable: true, recentAnnotatedTurns: recent.length, stages: Object.fromEntries(Object.entries(stages).map(([name, spans]) => {
        const combined = [...spans, ...recentSpans];
        const seen = new Set(combined.map(span => span.metadata.sessionId));
        return [name, { archived: coverage(archived, spans), includingRecent: coverage(gold, combined),
            annotatedSessionRecall: sessions.length ? sessions.filter(id => seen.has(id)).length / sessions.length : null }];
    })) };
}
export function judgeRequest(row, answer, config, rules) {
    const rule = rules[row.question_type + (row.question_id.endsWith('_abs') ? ':abstention' : '')];
    assert(rule, 'Unsupported question type');
    return { model: config.judge.model, state: { Question: row.question, [rule.referenceField]: row.answer, 'Model Response': answer },
        questions: { correct: { type: 'noul', instructions: rule.instructions } } };
}
export function verdict(response, config) {
    assert.equal(response.model, config.judge.model); assert.deepEqual(Object.keys(response.answers), ['correct']);
    assert.equal(response.answers.correct.type, 'noul');
    const probability = response.answers.correct.noul;
    assert(Number.isFinite(probability) && probability >= 0 && probability <= 1);
    assert(integer(response.usage.input_tokens));
    return { probability, correct: probability >= config.judge.threshold };
}
