# Building Dolgate from source

Use this guide to run Dolgate from a checkout or build your own app. Ready-to-install packages are available on [GitHub Releases](https://github.com/doldolma/dolgate/releases).
To run your own login and sync server, see the [self-hosting guide](./sync-api-self-hosting.md).

## Prerequisites

- Node.js 24.15.0 or later and npm 11 or later, as specified in the root [package.json](../package.json).
- Go 1.26.5 or later for the SSH engine and sync server; see [go.mod](../services/ssh-core/go.mod).
- Rust installed through `rustup` for RDP/VNC. The repository selects the pinned version automatically through [rust-toolchain.toml](../services/rdp-core/rust-toolchain.toml).
- A C/C++ toolchain, Make, and Perl for native dependencies: Xcode Command Line Tools on macOS, Visual Studio C++ Build Tools on Windows, or the compiler/build tools for your Linux distribution.
- For Android: JDK 17, Android SDK, and NDK. Required SDK/NDK versions are listed in [android/build.gradle](../apps/mobile/android/build.gradle).
- For iOS: macOS with Xcode and CocoaPods.

After cloning the repository, install dependencies from its root:

```bash
npm ci
```

## Run locally

Run these commands from the repository root:

| What to run | Command |
|---|---|
| Desktop app and local sync server together | `npm run dev` |
| Desktop app only | `npm run dev:desktop` |
| Local sync server only | `npm run dev:api` |
| Android app on a device or emulator | `npm run dev:mobile:android` |
| iOS app on a simulator | `npm run dev:mobile:ios` |

The desktop command prepares the SSH engine and RDP/VNC binaries automatically. The first run can take a while because it compiles their native dependencies. If Rust is unavailable or a remote desktop core fails to build, the desktop app can still start, but the affected RDP/VNC feature will not work.

To use the local sync server, set **Login Server** to `http://127.0.0.1:8080` through the gear icon on the desktop login screen. See [connecting the desktop app](./sync-api-self-hosting.md#connecting-the-desktop-app) for details.

Android and iOS local runs can share one Metro server on port `8081` when started together.

## Build a desktop app

Build on the operating system you are targeting. Each package includes the SSH, RDP, and VNC engines and the bundled AI runtime.

For a macOS Universal app, run:

```bash
cd apps/desktop
npm run generate:icons
npm run release:prepare:ssh:mac
npm run release:prepare:rdp:mac
npm run release:prepare:vnc:mac
npm run release:prepare:codex:mac
npm run release:package:mac
```

For Windows or Linux, use the same sequence with the `:mac` suffix replaced by `:win` or `:linux`. Output paths below are relative to the repository root:

| Platform | Output |
|---|---|
| macOS Universal | `apps/desktop/out/dolgate-darwin-universal/dolgate.app` |
| Windows x64 | `apps/desktop/out/dolgate-win32-x64/dolgate.exe` |
| Linux x64 / arm64 | `apps/desktop/out/dolgate-linux-x64/` and `apps/desktop/out/dolgate-linux-arm64/` |

These commands package a local app without the public-release signing and notarization steps. For Linux, use an x64 host with `gcc-aarch64-linux-gnu` and `g++-aarch64-linux-gnu` installed; the scripts build both architectures.

To create Windows or Linux installers, run the corresponding command from the repository root. Each command also performs the app build above:

```bash
npm run release:dist:win
# or, on Linux:
npm run release:dist:linux
```

Installers are written to `apps/desktop/release/dist/`. Linux produces deb and rpm packages for both architectures and requires `rpmbuild` (provided by the `rpm` package on Ubuntu). Linux installers must be built on Linux.

## Build a mobile app

Run from the repository root:

| Platform | Command | Output |
|---|---|---|
| Android | `npm run build:mobile:android` | `apps/mobile/android/app/build/outputs/apk/release/app-release.apk` |
| iOS | `npm run build:mobile:ios` | `apps/mobile/ios/build/derived-data/Build/Products/Release-iphoneos/Dolgate.app` |

Android release builds require your own release keystore; the repository includes a [local configuration example](../apps/mobile/android/signing.local.properties.example). For a local test run, use `dev:mobile:android` above.

The iOS build command produces an unsigned device `.app`. To try the app in the simulator, use `dev:mobile:ios` above.

## Build the sync server

From the repository root:

```bash
cd services/sync-api
mkdir -p dist
go build -o dist/sync-api ./cmd/api
```

See the [self-hosting guide](./sync-api-self-hosting.md) for database settings, login configuration, and server deployment.
