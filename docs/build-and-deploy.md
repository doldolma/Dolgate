# Dolgate Build and Deployment Guide

This page covers the repository-wide version policy and the build/deployment procedures.
For desktop features see [desktop](./desktop.md); for runtime boundaries see [architecture](./architecture.md).

## At a glance

- The whole repository releases under a single `vX.Y.Z` version.
- One GitHub Release carries the desktop artifacts and the Android APK together.
- The `sync-api` container is also published against the same `vX.Y.Z` tag.
- The version's source of truth is the root `package.json`.

## Prerequisites

- Node.js 24+
- npm 11+
- Go 1.26+

Initial setup:

```bash
npm ci
(cd services/ssh-core && go build ./...)
(cd services/sync-api && go build ./...)
```

## Running locally for development

```bash
npm run dev
npm run dev:desktop
npm run dev:mobile:ios
npm run dev:mobile:android
npm run dev:api
```

## Local verification

Full tests:

```bash
npm run check:js   # Node only. Version consistency + typecheck + desktop/mobile tests
npm run check      # The above + Go service tests (requires the Go toolchain)
```

Additional checks:

```bash
npm run typecheck                      # desktop + mobile
npm run test:mobile                    # mobile only
(cd services/ssh-core && go test ./...)
(cd services/sync-api && go test ./...)
```

## Repository-wide versioning

The source of truth for release versions is the root `package.json`.

- Root `package.json`
- `apps/desktop/package.json`
- `apps/mobile/package.json`
- Android `versionName`
- iOS `MARKETING_VERSION`

All of these must be the same version, matching the `vX.Y.Z` tag.

Root version sync scripts:

```bash
npm run version:set -- 1.4.3
npm run version:check
npm run version:bump:patch
npm run version:bump:minor
npm run version:bump:major
```

Bumped manually:

- Android `defaultAndroidVersionCode`
- iOS `CURRENT_PROJECT_VERSION`

## Unified GitHub Release

The whole repository ships as one `vX.Y.Z` tag and one GitHub Release.

- Desktop artifacts
- Android signed APK
- `sync-api` container publish

All three work off the same `vX.Y.Z`.

- [release.yml](../.github/workflows/release.yml): the repository-wide release workflow for `v*` tags
- [test.yml](../.github/workflows/test.yml): the shared test workflow for `main`/PRs

Android release artifact:

- `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`
- GitHub Release upload name: `Dolgate-android-vX.Y.Z.apk`

For per-platform build commands, see [Desktop release builds](#desktop-release-builds) and [Mobile builds and runs](#mobile-builds-and-runs) below.

### Signing for public distribution

`build:mobile:android` requires a dedicated release keystore, not the debug keystore.

Local builds:

- Create `apps/mobile/android/signing.local.properties` following the format of `apps/mobile/android/signing.local.properties.example`.

CI/GitHub Actions:

- `ANDROID_RELEASE_KEYSTORE_BASE64`
- `ANDROID_RELEASE_STORE_PASSWORD`
- `ANDROID_RELEASE_KEY_ALIAS`
- `ANDROID_RELEASE_KEY_PASSWORD`

The workflow restores the keystore to a temp file, builds the signed APK, and must pass `apksigner verify` to succeed.

### Release procedure

1. `npm run version:set -- X.Y.Z` or `npm run version:bump:*`
2. Bump `defaultAndroidVersionCode` in `apps/mobile/android/app/build.gradle`.
3. Bump `CURRENT_PROJECT_VERSION` in `apps/mobile/ios/Dolgate.xcodeproj/project.pbxproj`.
4. `npm run version:check`
5. `git tag vX.Y.Z`
6. `git push origin vX.Y.Z`

GitHub Actions creates one `vX.Y.Z` GitHub Release, uploading the desktop artifacts together with `Dolgate-android-vX.Y.Z.apk`.

`sync-api` container publishing is keyed off the same `v*` tag.

The release workflow must pass `desktop test`, `ssh-core test`, `mobile typecheck`, and `mobile Jest` before publishing.

- Pushing a tag like `vX.Y.Z` produces `ghcr.io/doldolma/dolgate-sync-api:X.Y.Z`, `:X.Y`, and `:latest` on GHCR together.
- Pushing to `main` alone does not build a new production `sync-api` image.

## Desktop release builds

macOS universal:

```bash
npm run release:dist:mac
```

Windows x64:

```bash
npm run release:dist:win
```

Linux x64/arm64 (deb, rpm):

```bash
npm run release:dist:linux
```

Linux installer packages are only produced on a Linux host — macOS's `ar` corrupts deb archives (fpm reports success while quietly emitting an empty 96-byte archive), and rpm needs separate tooling as well. Running this command on any other host stops with an error. Official packages are built by GitHub Actions when a release tag is pushed.

GitHub Release upload:

```bash
npm run release:publish:mac
npm run release:publish:win
npm run release:publish:linux
npm run release:all
```

## Mobile builds and runs

Local runs:

```bash
npm run dev:mobile:ios
npm run dev:mobile:android
```

- Running iOS and Android at the same time shares one Metro (`:8081`). The first session starts Metro, later sessions reuse it, and Metro is cleaned up when the last session quits.

Builds:

```bash
npm run build:mobile:ios
npm run build:mobile:android
```

Artifacts:

- iOS: `apps/mobile/ios/build/derived-data/Build/Products/Release-iphoneos/Dolgate.app`
- Android: `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`

Android release keystore setup follows [Signing for public distribution](#signing-for-public-distribution) above. iOS automation currently goes as far as producing the release `.app`; the Android APK is uploaded to the unified GitHub Release.

## Building sync-api

```bash
cd services/sync-api
mkdir -p dist
go build -o dist/sync-api ./cmd/api
```

## sync-api Docker deployment

### Included files

- Docker image definition: [services/sync-api/Dockerfile](../services/sync-api/Dockerfile)
- Docker ignore: [services/sync-api/.dockerignore](../services/sync-api/.dockerignore)
- Compose example: [services/sync-api/deploy/docker-compose.example.yml](../services/sync-api/deploy/docker-compose.example.yml)
- Compose example with MySQL: [services/sync-api/deploy/docker-compose.mysql.example.yml](../services/sync-api/deploy/docker-compose.mysql.example.yml)
- Compose example with OIDC + MySQL: [services/sync-api/deploy/docker-compose.oidc-mysql.example.yml](../services/sync-api/deploy/docker-compose.oidc-mysql.example.yml)
- GHCR publish workflow: [.github/workflows/sync-api-container.yml](../.github/workflows/sync-api-container.yml)
- Self-hosting operations guide: [sync-api-self-hosting.md](./sync-api-self-hosting.md)

### Deployment notes

- The simplest way to start self-hosting is to use the public GHCR image as-is.
- The example compose files use `latest` for a quick start, but production should pin an explicit version tag like `ghcr.io/doldolma/dolgate-sync-api:X.Y.Z`.
- If you stay on `latest`, apply updates in this order:

```bash
docker compose pull
docker compose up -d
```

- GitHub Actions publishes `ghcr.io/doldolma/dolgate-sync-api` as a `linux/amd64`, `linux/arm64` multi-arch image.
- All of `sync-api`'s AWS features (the SSM session broker, the mobile SSO browser flow, SFTP) run on the AWS SDK and the built-in SSM data channel.
- `sync-api` uses a pure-Go SQLite driver, so Docker builds assume `CGO_ENABLED=0`.
- Pushing to `main` alone does not build a new production image; publishing happens only on release tags.
- Actual self-host operations, MySQL/OIDC setup, signing keys, and reverse proxy caveats live in the [sync-api self-hosting guide](./sync-api-self-hosting.md).

## Manual verification checklist

- External browser login and session exchange work
- With the network blocked, offline-authenticated entry and re-sync recovery work
- Session Share creation, viewer access, viewer chat, and the owner's `chat history` window work
- AWS import region selection rules and `Check SSH info` behave correctly
- AWS SFTP progress, host key verification, and re-entry fallback work
- Warpgate import login, cancel, and retry work
