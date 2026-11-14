import { MemDriveError } from '../errors.js';
import type { EvidenceReference } from './types.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

/** References identify returned source spans, not model delivery or answer selection. */
export function evidenceIds(external: boolean) {
    const references = new Map<string, EvidenceReference>();
    const sources = new Map<string, { alias: string; signature: string }>();
    const resolve = (id: string): EvidenceReference => {
        const reference = references.get(id);
        if (!reference) throw new MemDriveError('INVALID_INPUT', 'Use an evidence ID returned by this tool session.');
        return { ...reference };
    };
    const attach = (items: unknown[], originals: boolean): void => {
        const pending = new Map<string, { reference: EvidenceReference; signature: string }>();
        const rows = items.map(value => {
            if (!object(value)) throw new MemDriveError('INVALID_RESULT', 'Memory tool returned invalid evidence.');
            const memId = originals ? value.id : value.memId;
            if (typeof memId !== 'string') throw new MemDriveError('INVALID_RESULT', 'Memory tool returned invalid evidence.');
            const start = originals ? 0 : value.start, end = originals && typeof value.content === 'string' ? value.content.length : value.end;
            if (!external && !(typeof value.content === 'string' && Number.isSafeInteger(start) && Number.isSafeInteger(end)
                && (start as number) >= 0 && (end as number) > (start as number) && value.content.length === (end as number) - (start as number)))
                throw new MemDriveError('INVALID_RESULT', 'Memory tool returned invalid evidence bounds.');
            const reference: EvidenceReference = external ? { memId } : { memId, start: start as number, end: end as number };
            const key = JSON.stringify(reference);
            const signature = JSON.stringify(canonical({ content: value.content, timestamp: value.timestamp, metadata: value.metadata }));
            const previous = sources.get(key) ?? pending.get(key);
            if (previous && previous.signature !== signature)
                throw new MemDriveError('INVALID_RESULT', 'Source changed for an evidence ID in this tool session.');
            pending.set(key, { reference, signature });
            return { value, key };
        });
        // Validate the whole result first: a failed item must not allocate unreturned aliases.
        for (const [key, entry] of pending) if (!sources.has(key)) {
            const alias = `e${references.size + 1}`;
            sources.set(key, { alias, signature: entry.signature }); references.set(alias, entry.reference);
        }
        for (const { value, key } of rows) value.evidenceId = sources.get(key)!.alias;
    };
    const output = (name: string, value: Record<string, unknown>): void => {
        if (name === 'memdrive_recall' && Array.isArray(value.results)) {
            value.results = value.results.map(item => {
                if (!object(item) || !Array.isArray(item.matches)) return item;
                try { attach(item.matches, false); return item; }
                catch (cause) {
                    if (!(cause instanceof MemDriveError)) throw cause;
                    return { error: { code: cause.code, message: cause.message }, usage: item.usage,
                        ...(item.completion === undefined ? {} : { completion: { status: 'failed', reason: cause.code } }) };
                }
            });
        } else if ((name === 'memdrive_read' || name === 'memdrive_list') && Array.isArray(value.mems)) attach(value.mems, true);
    };
    return { resolve, output };
}
