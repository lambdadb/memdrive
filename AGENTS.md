# Repository instructions

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changes and [RELEASING.md](RELEASING.md) before version or distribution work.

- Write code, comments, documentation and repository artifacts in English. Follow the user's language in direct conversation.
- Start new work from the latest `origin/main` in a task branch and dedicated worktree. Continue related work in its existing branch and worktree unless Steven requests otherwise; ask before switching when task continuity is unclear. Preserve unrelated changes.
- Target `main` and use squash merges for ordinary work. Do not merge, tag, publish or deploy without explicit authorization.
- Preserve browser-compatible runtime code. Node-only code belongs in development scripts and tests.
- Keep MemDrive independent of evaluation harnesses, benchmark annotations, application prompt assembly and provider-specific agent adapters.
- Keep TypeScript strict. Do not suppress migration errors with `@ts-nocheck`, blanket `any` or weaker compiler options.
- Keep the LambdaDB dependency pinned and use its public API. Adapt the SDK deliberately when the native client changes.
- Keep credentials and personal memory content out of source, logs, fixtures and package archives.
- Validate changed behavior, public types and the installed package. Distinguish unit tests, package checks and live integration; one does not establish the others.
- Development publication is explicit and uses the `dev` npm tag only. Keep committed versions stable or RC; derive dev versions in disposable publication checkouts. Follow RELEASING.md and do not enable stable/RC publication incidentally.

Before submission, inspect all changed files against the base and run the applicable commands in CONTRIBUTING.md. Do not commit generated distributions, tarballs, local reports or scratch scripts.
