/** Shared immutable documents for guide tools and host-provided resources. No drive reads are needed. */
const version = '7';

/**
 * Optional, transport-neutral supplement to the tool descriptions, which carry
 * everything ordinary use needs. It states how the tools relate and mentions only
 * searching and reading before writing, so it names no tool that only some hosts
 * offer, such as tree, findText or guide.
 */
export const fileToolInstructions = 'This drive keeps the user\'s information across conversations and is shared with their other agents; a later conversation knows only what the drive holds. Search and read before writing, and update a file you have read instead of creating a duplicate.';

export const fileToolGuideTopics = Object.freeze({
    retrieval: Object.freeze({ version, topic: 'retrieval' as const, title: 'Retrieval and navigation', description: 'When results are missing or too many, when unsure which search mode fits, when a tree is truncated or a listing spans several pages, or when reading a long file in parts.',
        content: `# Retrieval and navigation

Writes are visible to tree, list, read, search and findText as soon as they succeed.

Choose a search mode by intent: for example, semantic for "how we hand over on-call duty", keyword for "on-call handoff" and findText for an exact string such as "E-4172". Keyword search analyzes terms; it does not guarantee literal occurrences or interpret query syntax, so do not send an entire conversation as a keyword query. findText, available only in text mode, checks originals, so it also finds strings that span chunk boundaries. Retrieval never switches modes by itself: when results miss what you expect, rephrase, or try another mode or findText. When there are too many, add a declared-metadata filter, or use findText or list with a prefix.

Enable rerank only when additional model scoring of the retrieved candidates is worth the inference cost and latency; it cannot recover evidence outside the retrieved candidate pool. An optional embeddingQuery replaces the embedding and enabled reranking input, while hybrid still uses query for keyword matching. In keyword mode, embeddingQuery requires reranking and is used only for that scoring, without query embedding. Reranking errors fail the request unless onFailure is explicitly returnOriginal; that fallback preserves the selected retrieval mode and reports reranked: false. External-vector search has no mode, embeddingQuery or rerank options.

The file count tree reports for its prefix is always exact, even when folders are truncated. If tree fails on a large drive, list with delimiter "/" to find folder prefixes or take candidate folders from the paths of search hits, then call tree with one of them as prefix. Follow each list page's next unchanged to enumerate the full listing. On a live drive, files written or deleted while you list can appear or disappear on later pages. Entries already returned do not repeat, except that a file moved meanwhile can appear again at its new path. Two files can share a path after concurrent creates; they are listed in fileId order. File IDs remain stable across path changes.

A ranged read page includes totalLines, source offsets, revision and, while more remains, next, which also continues within a long line. Ranges preserve line endings and never silently truncate. READ_VERSION_CHANGED means the original changed between pages; restart without offset and revision.

List and findText cursors are self-contained and do not expire by time, but they are not durable bookmarks. Because findText scans live data, do not present its matches as a complete snapshot.`,
    }),
    editing: Object.freeze({ version, topic: 'editing' as const, title: 'Saving and editing', description: 'When a write fails or its outcome is unclear, when deleting or moving files, when new information conflicts with what is saved, or when recording long conversation content.',
        content: `# Saving and editing

A new file duplicates an existing one when it serves the same purpose; separate files can serve different audiences or purposes, such as an internal policy and a customer FAQ. Link related files when it helps readers find supporting context. Keep the reason, scope and supported date of a decision alongside the decision. Follow the user's request and the host's save policy.

In text mode, /preferences.md holds only what the user says they want in your answers always or from now on, one per line; when the user changes one, replace its line. Keep the file short, since it is read before the first answer of every conversation, and save facts, plans and decisions in other files. It is an ordinary file that the user can read and edit like any other.

Keeping a differing earlier statement beside the new one, each with when it was said, lets both be found and reported. Do not rewrite or delete the earlier statement as a mistake: it records what was said then. In text mode, add the new statement as an entry at the end of a file and leave earlier entries as they are, without noting which is correct or current. When the later statement updates the earlier one, such as a changed plan or preference, the later one is current; in /preferences.md, replace the changed line instead. When the user asks to change a document, such as a policy or FAQ, change it as asked.

When saving conversation content, preserve the original wording, examples, qualifications, corrections and useful surrounding exchanges. Light structure and descriptive titles may make it easier to find, but do not aggressively compress detailed passages into generic summaries or replace meaningful expressions with paraphrases. Clearly distinguish any added summary from quoted speaker wording. Preserve what was said, why it matters and when it applies; do not invent missing dates or present an untested idea as a decision. Keep each passage understandable when retrieved on its own. This does not require extra metadata fields or saving every utterance. Use ranged reads for long originals instead of shortening the stored source merely to fit a tool response.

Each oldText must match exactly once in the current original and edits must not overlap; otherwise the write fails with EDIT_CONFLICT. A full-content replacement overwrites whatever another writer saved in between. Validation errors such as INVALID_INPUT, PATH_EXISTS or EDIT_CONFLICT change nothing. WRITE_UNCONFIRMED and CHECKPOINT_RESTORE_FAILED mean part of the call may have been applied. An error at stage cleanup-chunks lists applied files in completedFileIds. To resolve PATH_AMBIGUOUS, move or delete one of the files that share the path by fileId.

To move a file, update it by fileId with newPath; its fileId stays the same, and a move onto another file's path fails with PATH_EXISTS. For a requested deletion, find the relevant files with search, findText or list, read them to confirm, delete them by fileId and verify the result. Deletion removes a file from the drive you can see; the host may keep earlier versions, so do not claim permanent erasure. You cannot restore earlier versions yourself: if something was lost or overwritten, report what you checked and let the user or host decide.`,
    }),
});

export type FileToolGuideTopic = keyof typeof fileToolGuideTopics;

/** The default guide response is a small index; details are fetched by topic. */
export const fileToolGuide = Object.freeze({
    version,
    topics: Object.freeze(Object.entries(fileToolGuideTopics).map(([topic, document]) =>
        Object.freeze({ topic: topic as FileToolGuideTopic, title: document.title, description: document.description }))),
    content: `# Using MemDrive file tools

Reference for unusual cases; the tool descriptions cover ordinary searching, reading and saving. The host connects the tools to one drive and authorizes each call. Authentication, permissions, save policy, versions and recovery belong to the host. Hosts may also expose these versioned documents as resources. Guide availability does not grant additional tools or permissions.

Pass a topic ID as the topic argument to read it:

${Object.entries(fileToolGuideTopics).map(([topic, document]) => `- ${topic}: ${document.description}`).join('\n')}`,
});
