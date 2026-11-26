# Releasing MemDrive

`@functional-systems/memdrive` uses a release flow derived from the LambdaDB
TypeScript SDK flow, with manually created dev prereleases instead of automatic
dev builds on every main push. All packages come from reviewed commits on `main`.
The publication workflow uses npm Trusted Publishing; ordinary pull request CI
has no credentials and cannot publish.

## Channels and triggers

| Trigger | Mode | Live environment | npm channel |
| --- | --- | --- | --- |
| Main push, committed version tagged on origin | Development verification | `dev` | None |
| Main push, committed version not tagged on origin | Release verification | `prod` | None |
| Published prerelease `vX.Y.Z-dev.N` | Development build | `dev` | `dev` |
| Published prerelease `vX.Y.Z-rc.N` | Release candidate | `prod` | `rc` |
| Published release `vX.Y.Z` | Stable release | `prod` | `latest` |

The workflow reads origin tags rather than assuming local tags are current.
Main pushes never publish: development verification prepares the dev version of
the pushed commit and validates its installed archive against dev, and release
verification validates the committed version against production. Dev, RC and
stable packages publish only from GitHub Releases. Creating any release tag or
GitHub Release, including a dev prerelease, requires explicit authorization.

## Versions

Keep `package.json`, `package-lock.json` and its root package record aligned.
Committed versions are canonical `X.Y.Z` or `X.Y.Z-rc.N`, with N starting at 1.
Use the version helper in release pull requests:

```sh
node scripts/version.mjs get
node scripts/version.mjs set 0.1.0-rc.1
```

Between releases, the committed version remains the last tagged RC or stable
version. A release pull request changes it to the next intended version. Never
commit development versions; CI derives them only in its disposable checkout:

- After stable `X.Y.Z`, the version is `X.Y.(Z+1)-dev.N`.
- After `X.Y.Z-rc.M`, the version is `X.Y.Z-dev.N`.

N counts first-parent commits since the newest stable release tag on origin that
is reachable from the commit, or from the root when there is no stable tag. It
restarts after a stable release and continues across RCs. Numbering reads origin
tags, so missing, stale or local-only tags in a checkout do not change it. A stable
release commit itself has N = 0 and no dev version: rerunning its main push after
tagging skips development verification, and a dev prerelease of it is rejected.
The dev core must be newer than the newest reachable stable release, and the
committed version must be tagged on origin and reachable from the commit.

Print the dev tag of a main commit (default `HEAD`) with the same derivation the
workflow uses. The helper fetches origin `main` and rejects commits that are not
on its first-parent history, where each dev number names exactly one commit:

```sh
node scripts/version.mjs dev
node scripts/version.mjs dev <commit>
```

Every published package includes `memdriveSourceCommit`. Development versions
are deterministic for a source commit. Publication skips an identical previously
published archive or a dev version below the current `dev` tag. A dev prerelease
may name any first-parent commit of `main`, not only its tip, provided the commit
includes this manual dev prerelease workflow; a release runs the workflow of the
tagged commit, and earlier commits reject dev tags. A version collision
with a different source or archive fails. Versions and release tags are immutable;
fixes require a new dev, RC or stable version.
Prerelease publication preserves the existing `latest` pointer.

The shared tool guide `version` changes only in release pull requests, not for
each development change. Development builds are identified by their package
version and `memdriveSourceCommit`, and evaluations record the exact guide text.
The first release containing the file-SDK guide resets the guide version to `1`;
the current unreleased value stays until that release pull request.

## Release cycle

1. Open a release pull request targeting `main` with the intended version and
   changelog. Complete the validation below and merge with squash.
2. The untagged version's main push validates the installed archive against
   production without publishing. Wait for this verification to pass.
3. With authorization, tag that exact reviewed commit `v<version>` and publish
   its GitHub Release. RC versions must have the prerelease flag; stable versions
   must not. Avoid unrelated merges until tagging, or explicitly select the
   verified release commit.
4. The Release workflow repeats validation against production and publishes the
   tested archive with `--tag rc` or `--tag latest`. Later main pushes verify the
   derived dev version against dev without publishing.
5. Verify npm metadata and install the exact published version independently:

   ```sh
   npm view @functional-systems/memdrive dist-tags --json
   npm view @functional-systems/memdrive@0.1.0-rc.1 version
   npm install @functional-systems/memdrive@0.1.0-rc.1
   ```

An unqualified install follows `latest`; consumers can explicitly select `@dev`,
`@rc` or an exact version. Moving dist-tags, deprecating or unpublishing packages
requires explicit authorization. Never overwrite a published version or move its
release tag.

## Dev prereleases

A dev build publishes only when a maintainer, with authorization, creates a GitHub
prerelease for a reviewed `main` commit whose committed version is tagged on origin.

1. Pick a commit on `main`, normally one whose main push passed development
   verification. Its log names the prepared dev version.
2. Run `node scripts/version.mjs dev <commit>` in an up-to-date clone. It prints the
   only accepted tag, such as `v0.1.1-dev.3`.
3. Tag that exact commit with the printed name, push the tag and publish a GitHub
   Release for it with the prerelease flag set. Dev prereleases share one
   concurrency group, so their publications are serialized; GitHub may cancel a
   pending dev prerelease run when a newer one is queued.
4. The workflow rejects a tag that differs from the derived name, a release without
   the prerelease flag, a commit off the first-parent history of `main`, a commit
   whose committed version is untagged on origin and a tagged stable release
   commit (N = 0). It validates the
   installed archive against dev and publishes it with `--tag dev`. A dev version
   below the current `dev` tag is not published; `latest` is never changed.
5. Verify the registry and install the exact version independently:

   ```sh
   npm view @functional-systems/memdrive dist-tags --json
   npm view @functional-systems/memdrive@0.1.1-dev.3 memdriveSourceCommit
   npm install @functional-systems/memdrive@0.1.1-dev.3
   ```

Dev tags and their GitHub prereleases are immutable like RC and stable releases.

## Validation and archive identity

Every mode validates the exact event SHA, package/lock agreement and containment
in origin's `main`. Release validation, including dev prereleases, also checks the
tag on origin and locally, its package version and its GitHub prerelease flag.
Mode selection rejects a dev prerelease with the wrong tag name, prerelease flag
or a commit off the first-parent history of `main` before the job enters an
environment. Only generated version/source metadata may
differ from the reviewed checkout. Verification modes have no npm channel and
cannot publish.

```sh
npm ci
npm run check:version
npm run lint
npm run typecheck
npm test
npm run check:package
npm run test:live
```

The runtime supports Node.js 20.12+; release and live tooling use Node.js 24.
Ordinary CI covers Node.js 20.12 and 24 without live credentials.

The publication workflow packs once, checks the archive allowlist, installs into
a clean project, verifies ESM, CommonJS, TypeScript and browser consumers, and
runs live tests against that installed archive. It retains the tarball and npm
pack manifest only after validation succeeds. Publication checks the retained
SHA-512 digest and embedded source identity, then verifies registry integrity,
source SHA and the selected dist-tag after publishing with provenance. npm can
acknowledge publication before registry metadata is visible; verification polls
read-only metadata every five seconds for up to five minutes and never retries
publication. Source, archive or unexpected `latest` changes fail immediately.
Reruns validate an existing version and report when its channel has advanced,
without moving the tag.

The basic live scenario creates an isolated collection, checks that native
snapshot retention is one day and that no other collection was created, and
forks main. It writes a few short synthetic originals on the fork and on main,
verifies reads by path and file ID through a freshly opened drive, checks fork
isolation and duplicate path rejection, follows `list` to completion, checks
that `tree` and `list` see files written just before and
exercises managed embeddings and searches with and without native reranking.
Requests have 60-second limits. Cleanup verifies a native not-found response.
Missing settings or failed cleanup fail the run. Record the pinned LambdaDB
client version and test environment. Unit tests, installed-package checks, live
integration and registry verification establish different facts.

The default suite also creates a separate structured-text store using local
Docling Hybrid and a synthetic tokenizer. It verifies exact originals and
rendered search previews, checkpoints the fork and reads that checkpoint through
a reader without a parser, writes on main, rolls the fork back to the checkpoint
and verifies the restored content, deletes the refs it created and destroys the
store. With `MEMDRIVE_RUN_LIVE_CHECKPOINT_TESTS=1`, the basic scenario also
creates checkpoints, reads and forks them, rejects writes to a checkpoint and
rolls another fork back to a checkpoint. Failure output names the stage and HTTP status without request headers
or bodies.

## GitHub and npm configuration

Set these repository variables; missing values never fall back across environments:

| Variable | Purpose |
| --- | --- |
| `LAMBDADB_DEV_BASE_URL` | Dev LambdaDB endpoint |
| `LAMBDADB_DEV_PROJECT_NAME` | Dedicated dev smoke project |
| `LAMBDADB_PROD_BASE_URL` | Production LambdaDB endpoint |
| `LAMBDADB_PROD_PROJECT_NAME` | Dedicated production smoke project |

Each GitHub Environment stores its own `LAMBDADB_PROJECT_API_KEY` secret:

| Environment | Allowed deployment refs |
| --- | --- |
| `dev` | Branch `main`, tags `v*-dev.*` |
| `prod` | Branch `main`, tags `v*` |

The `prod` tag pattern `v*` also matches dev tags. Mode selection therefore never
selects `prod` for a dev tag: it selects `dev` for every canonical `vX.Y.Z-dev.N`
tag, and `prod` only for the committed version's own tag, which can never be a dev
version. Any other tag fails before an environment is used. These checks run from
the tagged commit, so they hold only for reviewed `main` code: a tag on an
unreviewed commit runs that commit's workflow and can reach either environment.
The effective boundary is who can create `v*` tags and publish GitHub Releases;
restrict `v*` tag creation to authorized maintainers with a tag ruleset.

Use dedicated test projects and project keys, not administrator keys or user
memory data. Keys are passed only to the live-test step. Local smoke runs read
`LAMBDADB_BASE_URL`, `LAMBDADB_PROJECT_NAME` and `LAMBDADB_PROJECT_API_KEY` from
exported variables or `.env.local`; keep credentials outside Git.

Configure npm Trusted Publishing for GitHub organization `lambdadb`, repository
`memdrive`, workflow filename `publish.yaml`, with direct `npm publish` allowed.
Leave its Environment restriction unset so both `dev` and `prod` jobs can publish,
as in the LambdaDB SDK. GitHub environment policies still restrict secret access.
The workflow runs on GitHub-hosted Ubuntu with Node.js 24, npm 11.5.1+ and
`id-token: write`. The package repository URL must match the public source for
provenance. No long-lived npm token is stored in the workflow.

Main pushes share one concurrency group; GitHub may replace a pending push with a
newer one. Dev prereleases share one group; RC and stable releases are grouped by
immutable tag.
A successful workflow start or artifact upload is not publication completion:
verify the registry and report unperformed checks explicitly.

## References

- [LambdaDB TypeScript SDK release policy](https://github.com/lambdadb/lambdadb-typescript-client/blob/main/RELEASING.md)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements/)
- [npm dist-tags](https://docs.npmjs.com/adding-dist-tags-to-packages)
