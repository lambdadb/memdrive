import type { CreateToolsOptions, MemoryTools } from './types.js';

/** Internal model-session identities, never public memory-tool arguments or results. */
export type EvidenceReference = { memId: string; start: number; end: number } | { memId: string };
export interface InternalToolsOptions extends CreateToolsOptions {
    shortIds?: boolean;
    evidenceIds?: boolean;
}
export interface InternalMemoryTools extends MemoryTools {
    resolveId(id: string): string;
    resolveEvidence(id: string): EvidenceReference;
}
