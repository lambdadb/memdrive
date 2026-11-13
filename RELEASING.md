# Releasing MemDrive

## Bootstrap status

MemDrive is not released. Its package name is `@functional-systems/memdrive` and its license is Apache-2.0. `private: true` and the `prepublishOnly` guard block publication. Do not publish, create release tags or remove these safeguards without the user's authorization.

This repository follows the LambdaDB TypeScript client's main-branch, squash-merge, immutable-version and distribution-channel conventions. It does not copy the native client's publication automation: a remote repository, registry identity, trusted publisher, protected environments and standalone live checks have not been configured here. CI performs local validation only.

## Version policy

Committed versions use `X.Y.Z` or `X.Y.Z-rc.N`, where `N` starts at 1. A committed stable version describes the intended release and does not mean it has already been published. Keep unreleased status explicit in CHANGELOG.md.

| Version | npm distribution tag | Purpose |
| --- | --- | --- |
| `X.Y.Z-dev.N` | `dev` | Development builds derived in a disposable publication checkout |
| `X.Y.Z-rc.N` | `rc` | Explicit release candidates |
| `X.Y.Z` | `latest` | Authorized stable releases |

Never publish a prerelease to `latest`. Never reuse a published version, move a release tag or overwrite a release asset. A correction requires a new version. Dist-tag changes require explicit authorization.

The version is synchronized in `package.json`, `package-lock.json` and the lockfile's root package record. Use:

```sh
node scripts/version.mjs get
node scripts/version.mjs set 0.1.0-rc.1
```

The helper rejects inconsistent input files and does not change dependency versions. It deliberately rejects committed development versions. There is no JSR manifest or independent runtime version constant to synchronize.

## Before enabling distribution

Complete a reviewed release-setup change that:

1. Verifies npm ownership and the confirmed package name, Apache-2.0 license and required attribution files.
2. Configures the actual GitHub repository metadata, npm trusted publisher and protected release environments without repository secrets in source.
3. Adds maintained standalone live smoke tests for the supported storage and retrieval contracts, with isolated test resources and explicit cost limits.
4. Defines authorized `dev`, `rc` and stable workflows, including collision-safe development version derivation and exact commit selection. The native client's automatic main-branch development publication is a reference policy, not an active MemDrive feature.
5. Replaces the bootstrap publication guard with channel and version checks, and removes `private: true` only as part of enabling authorized distribution.

Do not add JSR metadata or additional package registries unless that distribution is requested.

## Release validation

Use a clean dedicated worktree at the reviewed release commit. Inspect the complete diff and run:

```sh
npm ci
npm run check:version
npm run lint
npm run typecheck
npm test
npm run check:package
```

Run the applicable maintained live checks once those exist. Record the native LambdaDB version, test commands and results, and any unperformed checks. Source inspection, mock/unit tests, clean package installation and live integration are separate evidence.

Inspect `npm pack --dry-run --json` and the actual release archive. Confirm that the package contains only the intended distributions, source maps/source files, package metadata, documentation and license notices. No test data, credentials, `.env` files, development scripts or artifacts may ship. Validate the exact archive that will be published, then publish that immutable archive through the authorized workflow. Create the matching immutable release tag and release notes only after successful publication. Verification of registry version and channel must follow publication; a successful workflow start is not sufficient.

This document defines the intended release contract. No publishing command or automated publisher is operational in the bootstrap repository.
