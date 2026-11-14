import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const jsonHash = value => hash(JSON.stringify(value));
export const metadataSchema = {
    role: { type: 'string', description: 'Original message author: user or assistant.' },
    sessionId: { type: 'string', description: 'Original conversation session identifier.' },
    session: { type: 'number', description: 'One-based chronological session position.' },
    message: { type: 'number', description: 'Zero-based message position across this history.' },
    date: { type: 'string', description: 'Original dataset session clock; timestamp interprets it as UTC.' },
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
            return { id: jsonHash([row.question_id, message]), content: turn.content, timestamp: time,
                metadata: { role: turn.role, sessionId, session: sessionIndex + 1, message, date } };
        });
    });
    let boundary = Math.max(0, messages.length - config.retrieval.recentMessagesIncludingQuestion + 1);
    // Keep the immediately preceding user/assistant pair whole at the recent boundary.
    if (boundary > 0 && messages[boundary].metadata.role === 'assistant'
        && messages[boundary - 1].metadata.role === 'user' && messages[boundary - 1].content.trim()) boundary--;
    return { id: row.question_id, question: row.question, questionTimestamp: timestamp(row.question_date), boundary,
        mems: messages.slice(0, boundary).filter(mem => mem.content.trim()), recent: messages.slice(boundary) };
}

export const spanKey = span => JSON.stringify([span.memId, span.start, span.end]);
const splitSurrogate = (text, offset) => offset > 0 && offset < text.length
    && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset]);
export function validateSpan(span, prepared) {
    const original = prepared.mems.find(mem => mem.id === span.memId);
    assert(original, 'Evidence does not belong to the archived source');
    assert(integer(span.start) && integer(span.end) && span.start < span.end && span.end <= original.content.length,
        'Invalid evidence bounds');
    assert(!splitSurrogate(original.content, span.start) && !splitSurrogate(original.content, span.end), 'Split Unicode character');
    assert.equal(span.content, original.content.slice(span.start, span.end), 'Evidence text differs from source');
    assert.equal(span.timestamp, original.timestamp, 'Evidence timestamp differs');
    assert.deepEqual(span.metadata, original.metadata, 'Evidence metadata differs');
    return { memId: span.memId, start: span.start, end: span.end, content: span.content,
        timestamp: span.timestamp, metadata: span.metadata };
}

export function resultSpans(name, result, prepared, resolveId = id => id, resolveEvidence) {
    if (!result.ok) return [];
    const checkReference = (id, span) => {
        if (resolveEvidence) assert.deepEqual(resolveEvidence(id), { memId: span.memId, start: span.start, end: span.end });
        return span;
    };
    if (name === 'memdrive_recall') return result.value.results.flatMap(item => item.error ? []
        : item.matches.map(match => {
            assert(['mem', 'chunk'].includes(match.kind));
            const span = validateSpan({ ...match, memId: resolveId(match.memId) }, prepared);
            assert.equal(match.kind, span.start === 0 && span.end === prepared.mems.find(mem => mem.id === span.memId).content.length
                ? 'mem' : 'chunk');
            return checkReference(match.evidenceId, span);
        }));
    if (name === 'memdrive_read' || name === 'memdrive_list') return result.value.mems.map(mem => {
        const { evidenceId, ...source } = mem;
        mem = { ...(resolveEvidence ? source : mem), id: resolveId(mem.id) };
        const original = prepared.mems.find(source => source.id === mem.id);
        assert.deepEqual(mem, original, 'Read original differs from source');
        return checkReference(evidenceId, validateSpan({ memId: mem.id, start: 0, end: mem.content.length, ...mem }, prepared));
    });
    return [];
}

export function selectEvidence(selection, available) {
    assert(selection && Object.keys(selection).length === 1 && Array.isArray(selection.evidence), 'Expected evidence selection JSON');
    const byKey = new Map(available.map(span => [spanKey(span), span]));
    const selected = [], seen = new Set();
    for (const ref of selection.evidence) {
        assert(ref && Object.keys(ref).every(key => ['memId', 'start', 'end'].includes(key)));
        let span;
        if (Object.keys(ref).length === 1 && typeof ref.memId === 'string') {
            // Full originals are distinguishable from excerpts by their original length in metadata-free refs below.
            span = available.find(item => item.memId === ref.memId && item.fullOriginal);
        } else span = byKey.get(spanKey(ref));
        assert(span, 'Selected evidence was not delivered to the model');
        const key = spanKey(span);
        if (!seen.has(key)) { selected.push(span); seen.add(key); }
    }
    return selected;
}

function merged(spans) {
    const sorted = [...spans].sort((a, b) => a.metadata.message - b.metadata.message || a.start - b.start);
    const result = [];
    for (const span of sorted) {
        const last = result.at(-1);
        if (last && last.memId === span.memId && span.start <= last.end) {
            if (span.end > last.end) { last.content += span.content.slice(last.end - span.start); last.end = span.end; }
        } else result.push({ ...span });
    }
    return result;
}
function render(spans) {
    return JSON.stringify(merged(spans).map(span => ({ memId: span.memId, role: span.metadata.role,
        session: span.metadata.session, timestamp: span.timestamp, start: span.start, end: span.end, content: span.content })));
}
export function context(prepared) {
    return { question: prepared.question, questionTimestamp: prepared.questionTimestamp,
        recentDialogue: prepared.recent.map(mem => ({ role: mem.metadata.role, timestamp: mem.timestamp, content: mem.content })) };
}
export function packEvidence(prepared, ranked, config, countTokens) {
    const admitted = [];
    for (const candidate of ranked) {
        validateSpan(candidate, prepared);
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
    for (const mem of targets) {
        const matches = joined.filter(span => span.memId === mem.id);
        if (matches.length) any++;
        if (matches.some(span => span.start === 0 && span.end === mem.content.length)) full++;
    }
    return { annotatedTurns: targets.length, anyTurnRecall: any / targets.length, fullTurnRecall: full / targets.length };
}
export function evidenceMetrics(row, prepared, stages) {
    if (row.question_id.endsWith('_abs')) return { applicable: false, reason: 'abstention' };
    const all = [...prepared.mems, ...prepared.recent], goldIndexes = [];
    let index = 0;
    for (const session of row.haystack_sessions) for (const turn of session) { if (turn.has_answer === true) goldIndexes.push(index); index++; }
    const gold = all.filter(mem => goldIndexes.includes(mem.metadata.message));
    const archived = gold.filter(mem => mem.metadata.message < prepared.boundary);
    const recent = prepared.recent.filter(mem => goldIndexes.includes(mem.metadata.message));
    const recentSpans = prepared.recent.filter(mem => mem.content.length).map(mem => ({ memId: mem.id, start: 0,
        end: mem.content.length, content: mem.content, metadata: mem.metadata, timestamp: mem.timestamp }));
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
