# Releasing MemDrive

`@functional-systems/memdrive` follows the LambdaDB TypeScript SDK release flow.
All packages come from reviewed commits on `main`. The publication workflow uses
npm Trusted Publishing; ordinary pull request CI has no credentials and cannot
publish.

## Channels and triggers

| Trigger | Mode | Live environment | npm channel |
| --- | --- | --- | --- |
| Main push, committed version tagged on origin | Development build | `dev` | `dev` |
| Main push, committed version not tagged on origin | Release verification | `prod` | None |
| Published prerelease `vX.Y.Z-rc.N` | Release candidate | `prod` | `rc` |
| Published release `vX.Y.Z` | Stable release | `prod` | `latest` |

The workflow reads origin tags rather than assuming local tags are current.
An untagged committed version is verified but not published. Reviewed merges
whose version is already tagged authorize the configured automatic dev build.
RC/stable tags and GitHub Releases require explicit authorization. There are no
development Git tags or GitHub Releases.

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

N counts first-parent commits since the newest reachable stable release tag, or
from the root when there is no stable tag. It restarts after a stable release and
continues across RCs. A stable release commit itself has N = 0: rerunning its main
push after tagging skips development validation and publication. If the committed
version tag appeared after checkout, preparation fetches it before numbering.
The dev core must be newer than the newest reachable stable release.

Every published package includes `memdriveSourceCommit`. Development versions
are deterministic for a source commit. Publication skips a superseded main SHA,
an identical previously published archive, or a dev version below the current
`dev` tag. A version collision with a different source or archive fails. Versions
and release tags are immutable; fixes require a new dev, RC or stable version.
Prerelease publication preserves the existing `latest` pointer.

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
   tested archive with `--tag rc` or `--tag latest`. Later main pushes derive dev
   builds from the tagged version and test against dev.
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

## Validation and archive identity

Every mode validates the exact event SHA, package/lock agreement and containment
in origin's `main`. Release validation also checks the tag on origin and locally,
its package version and its GitHub prerelease flag. Only generated version/source
metadata may differ from the reviewed checkout. Verification mode has no npm
channel and cannot publish.

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
source SHA and the selected dist-tag after publishing with provenance.

The live suite creates three isolated collections containing less than 6 KiB of
synthetic text. It performs eight managed recalls (two with default reranking),
two facet requests, one external-vector recall and one branch operation, with no
answer-model calls or retry loop. Calls have 60-second limits and the suite has a
ten-minute limit. Cleanup verifies native not-found responses. Missing settings
or failed cleanup fail the run. Record the pinned LambdaDB client version and
test environment; unit tests, installed-package checks, live integration and
registry verification establish different facts.

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
| `dev` | Branch `main` |
| `prod` | Branch `main`, tags `v*` |

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
newer one. Release jobs are grouped by immutable tag. A successful workflow start
or artifact upload is not publication completion: verify the registry and report
unperformed checks explicitly.

## References

- [LambdaDB TypeScript SDK release policy](https://github.com/lambdadb/lambdadb-typescript-client/blob/main/RELEASING.md)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements/)
- [npm dist-tags](https://docs.npmjs.com/adding-dist-tags-to-packages)
