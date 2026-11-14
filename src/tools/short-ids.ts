import { MemDriveError } from '../errors.js';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** One read-only tool registry owns this map; never inspect arbitrary text for IDs. */
export function shortIds() {
    const canonical = new Map<string, string>(), aliases = new Map<string, string>();
    const resolve = (id: unknown): string => {
        const value = typeof id === 'string' ? canonical.get(id) : undefined;
        if (value === undefined) throw new MemDriveError('INVALID_INPUT', 'Use a memory ID returned by this tool session.');
        return value;
    };
    const encode = (id: unknown): string => {
        if (typeof id !== 'string') throw new MemDriveError('INVALID_RESULT', 'Memory tool returned an invalid ID.');
        let alias = aliases.get(id);
        if (alias === undefined) {
            alias = `m${aliases.size + 1}`;
            aliases.set(id, alias); canonical.set(alias, id);
        }
        return alias;
    };
    const filter = (root: unknown): void => {
        const pending = [root], seen = new Set<object>();
        while (pending.length) {
            const value = pending.pop();
            if (!object(value) || seen.has(value)) continue;
            seen.add(value);
            const keys = Object.keys(value);
            // Leave malformed/cyclic expressions for the SDK's normal validation.
            if (keys.length === 1 && ['and', 'or'].includes(keys[0]!)) {
                const children = value[keys[0]!];
                if (Array.isArray(children)) for (const child of children) pending.push(child);
            } else if (keys.length === 3 && keys.every(key => ['field', 'op', 'value'].includes(key)) && value.field === 'id') {
                if (value.op === 'eq' || value.op === 'neq') value.value = resolve(value.value);
                else if (value.op === 'in' && Array.isArray(value.value)) value.value = value.value.map(resolve);
            }
        }
    };
    const query = (value: unknown): void => {
        if (!object(value)) return;
        if (Array.isArray(value.excludeIds)) value.excludeIds = value.excludeIds.map(resolve);
        filter(value.filter);
    };
    const output = (name: string, value: Record<string, unknown>): void => {
        if (name === 'memdrive_recall' && Array.isArray(value.results)) {
            for (const item of value.results) if (object(item) && Array.isArray(item.matches))
                for (const match of item.matches) if (object(match)) match.memId = encode(match.memId);
        } else if ((name === 'memdrive_read' || name === 'memdrive_list') && Array.isArray(value.mems)) {
            for (const mem of value.mems) if (object(mem)) mem.id = encode(mem.id);
        } else if (name === 'memdrive_count_values' && object(value.values) && object(value.values.id)
            && Array.isArray(value.values.id.buckets)) {
            for (const bucket of value.values.id.buckets) if (object(bucket)) bucket.value = encode(bucket.value);
        }
    };
    return { resolve, query, output, read: (args: Record<string, unknown>) => {
        if (Array.isArray(args.ids)) args.ids = args.ids.map(resolve);
    } };
}
