import { isObject } from './config.js';
import { MemDriveError } from './errors.js';
import { contentHash } from './records.js';

// Opaque, versioned continuation tokens. They carry position only: callers can
// decode them, so every field is revalidated and never grants authority.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function base64url(bytes: Uint8Array) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function encodeToken(prefix: string, value: Record<string, unknown>) {
    return `${prefix}.${base64url(encoder.encode(JSON.stringify(value)))}`;
}

/** Decode a token's JSON object, or undefined when it is malformed. */
export function decodeToken(prefix: string, token: unknown): Record<string, unknown> | undefined {
    if (typeof token !== 'string' || !token.startsWith(`${prefix}.`)) return undefined;
    const body = token.slice(prefix.length + 1);
    if (!/^[A-Za-z0-9_-]+$/.test(body)) return undefined;
    try {
        const binary = globalThis.atob(body.replace(/-/g, '+').replace(/_/g, '/'));
        const value: unknown = JSON.parse(decoder.decode(Uint8Array.from(binary, char => char.charCodeAt(0))));
        return isObject(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

/**
 * A short store-generation tag, so a token cannot continue on a replaced or
 * different store. A recreated collection with the same name has a new creation time.
 */
export async function storeTag(name: string, collection: { projectName?: unknown; createdAt?: unknown }) {
    const { projectName, createdAt } = collection ?? {};
    if (typeof projectName !== 'string' || !(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime()))
        throw new MemDriveError('INVALID_RESULT', 'Collection lookup did not identify the file store generation.');
    return (await contentHash(`memdrive-cursor:${JSON.stringify([name, projectName, createdAt.toISOString()])}`)).slice(0, 16);
}
