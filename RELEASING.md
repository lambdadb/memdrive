# Releasing MemDrive

The npm package is `@functional-systems/memdrive`, licensed under Apache-2.0,
with source at [lambdadb/memdrive](https://github.com/lambdadb/memdrive).
Only development publication is automated. A maintainer explicitly dispatches
`publish.yaml` on `main`; ordinary pushes and pull requests do not publish.
RC/stable automation and GitHub Releases are outside this initial release cycle.

## Versions and channels

Committed versions are canonical `X.Y.Z` or `X.Y.Z-rc.N` (N starts at 1).
The initial `0.1.0` identifies the intended release, not an existing stable package.
`node scripts/version.mjs get` verifies package.json and both lockfile version
locations; `set VERSION` changes them together without changing dependencies.
Never commit a development version.

The workflow checks out its exact dispatch SHA and derives `X.Y.Z-dev.N` only in
that disposable checkout. N is the number of first-parent commits from the root
through that SHA, making retries deterministic. Before the committed stable
version is tagged, its core is the target; after `vX.Y.Z` is tagged and reachable,
the target becomes `X.Y.(Z+1)`. An RC keeps its core. The published package records
`memdriveSourceCommit`. History and published versions must remain immutable.

Development builds publish with `--tag dev`, with no Git tag or GitHub Release.
After initial bootstrap, automated dev publications preserve the existing `latest`
tag. The publication guard rejects stable/RC versions,
unprepared metadata and other channels. A superseded main SHA or lower dev
version is skipped. An already published version from the same source is an
idempotent retry; a different source under that version is a hard failure.
Never move a published tag, reuse a version or unpublish a failed experiment.

## GitHub and npm setup

Configure the GitHub Environment `dev` to allow only branch `main`:

| Setting | Kind | Meaning |
| --- | --- | --- |
| `LAMBDADB_BASE_URL` | Environment variable | Deployed LambdaDB test endpoint |
| `LAMBDADB_PROJECT_NAME` | Environment variable | Dedicated smoke-test project |
| `LAMBDADB_PROJECT_API_KEY` | Environment secret | Project key allowed to create/delete test collections |

Do not use an administrative key or production memory data. The live suite has
three unique collections, less than 6 KiB of synthetic text, eight managed recalls
(two with default reranking), two facet requests, one external-vector recall and
one branch. It has no answer-model calls or retry loop. Each call has a 60-second
limit and the suite has a ten-minute limit. Cleanup verifies native collection
not-found responses. Missing configuration or failed cleanup fails publication.

Configure npm Trusted Publishing for GitHub organization `lambdadb`, repository
`memdrive`, workflow filename `publish.yaml`, Environment `dev`, with direct
`npm publish` allowed. The job runs on GitHub-hosted Ubuntu with Node.js 24 and
OIDC permission `id-token: write`. npm must be at least 11.5.1 and Node at least
22.14 for trusted publishing; verify the bundled npm before enabling publication.
The package repository URL must match the public GitHub source for provenance.
No long-lived npm token is stored in this workflow.

For a new npm package whose trusted publisher cannot yet be configured, first run
the workflow with `dry_run=true`. Download its tested tarball and manifest, verify
the SHA-512 integrity from the manifest, and publish that exact archive from an
authorized local npm session with `npm publish PATH.tgz --access public --tag dev`.
This initial local publish does not claim CI provenance. npm may assign both
`dev` and `latest` on a package's first publication despite `--tag dev`, as
[reported and confirmed in npm/cli#8490](https://github.com/npm/cli/issues/8490).
MemDrive's first `0.1.0-dev.5` publication received both tags; removing `latest`
was rejected by the registry with HTTP 400. Do not treat that tag as evidence of
a stable release. Install explicitly with `@dev` or an exact prerelease version,
for example `@functional-systems/memdrive@0.1.0-dev.5`.

Verify registry version, source SHA, archive integrity and both dist-tags, then
configure the trusted publisher. Subsequent dev publications must preserve the
existing `latest` pointer, including when it still identifies the bootstrap build.
Future publications use OIDC and provenance. Authentication or 2FA may require
maintainer interaction; do not place tokens in source or artifacts.

## Development release cycle

1. Review the exact source commit and merge it into `main`. Use the existing task
   worktree for preparation; the publication job itself supplies a clean checkout.
2. Dispatch **Publish development package** on `main`. `dry_run` defaults to true:
   it validates and retains an archive without publishing. Set it to false only
   for an authorized publication with npm Trusted Publishing configured.
3. The workflow validates committed metadata, installs pinned dependencies, lints,
   typechecks, prepares the dev version and runs the unit/public-type tests.
4. `check:package --live --output-directory artifacts/release` packs once, checks
   the archive allowlist, installs it into a clean project with normal registry resolution, verifies ESM,
   CommonJS, TypeScript and browser consumers, and runs the deployed live tests
   using that installation. It retains the exact tarball and npm pack manifest
   only after all checks pass. Artifacts contain no credentials or live data.
5. Publication checks archive integrity, current main SHA, existing registry
   versions and dev ordering. It publishes that archive with `--tag dev` and
   provenance, then verifies registry source SHA, integrity and unchanged `latest`.
6. Independently install the published exact version and verify public imports.
   A green workflow start or successful upload alone is not release completion.

Local validation:

```sh
npm ci
npm run check:version
npm run lint
npm run typecheck
npm test
npm run check:package
npm run test:live
```

The runtime supports Node.js 20.12+, while live/release tooling uses Node.js 24.
Ordinary CI runs Node.js 20.12 and 24 without credentials. Live tests use the pinned
LambdaDB client version in package.json; record it and the deployed environment
in release evidence. Unit, package, deployed integration and registry checks are
distinct evidence. Never claim an unperformed check passed.

## References

- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements/)
- [npm dist-tags](https://docs.npmjs.com/adding-dist-tags-to-packages)
- [GitHub environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
