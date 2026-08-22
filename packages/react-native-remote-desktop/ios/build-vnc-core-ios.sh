#!/bin/bash
# build-vnc-core-ios.sh — Build vnc-core Rust static library for iOS.
#
# Called by the podspec's script_phase during `pod install`.
# Produces: ${BUILT_PRODUCTS_DIR}/libvnc_core.a
#
# Supports:
#   - Device: arm64 (aarch64-apple-ios)
#   - Simulator: arm64 (aarch64-apple-ios-sim)
#   - Simulator: x86_64 (x86_64-apple-ios)
#
# Prerequisites:
#   - rustup in ${CARGO_HOME:-$HOME/.cargo}/bin or PATH
#   - Rust toolchain channel from services/vnc-core/rust-toolchain.toml
#
# Environment (set by Xcode/CocoaPods):
#   PLATFORM_NAME — iphoneos | iphonesimulator
#   ARCHS — target architectures (for example "arm64 x86_64")
#   CONFIGURATION — Debug | Release
#   BUILT_PRODUCTS_DIR — output directory
#   PODS_TARGET_SRCROOT — this package root

set -euo pipefail

# Xcode does not inherit the interactive shell PATH.
CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
if [ -d "$CARGO_HOME/bin" ]; then
  export PATH="$CARGO_HOME/bin:$PATH"
fi
for tool in cargo rustc rustup; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool is required to build vnc-core; install rustup first" >&2
    exit 1
  fi
done

# Resolve paths relative to the monorepo. PODS_TARGET_SRCROOT points through
# node_modules for workspace packages, so resolve that symlink before walking up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PACKAGE_ROOT="$(cd "${PODS_TARGET_SRCROOT:-$SCRIPT_DIR/..}" && pwd -P)"
REPO_ROOT="$(cd "$PACKAGE_ROOT/../.." && pwd -P)"
CARGO_PROJECT="$REPO_ROOT/services/vnc-core"

if [ ! -f "$CARGO_PROJECT/Cargo.toml" ]; then
  echo "error: Cannot find vnc-core at $CARGO_PROJECT" >&2
  exit 1
fi

PLATFORM_NAME="${PLATFORM_NAME:-iphoneos}"
XCODE_ARCHS="${ARCHS:-arm64}"
RUST_TARGETS=()
for xcode_arch in $XCODE_ARCHS; do
  case "$PLATFORM_NAME:$xcode_arch" in
    iphoneos:arm64)
      RUST_TARGETS+=("aarch64-apple-ios")
      ;;
    iphonesimulator:arm64)
      RUST_TARGETS+=("aarch64-apple-ios-sim")
      ;;
    iphonesimulator:x86_64)
      RUST_TARGETS+=("x86_64-apple-ios")
      ;;
    *)
      echo "error: Unsupported iOS build architecture: $PLATFORM_NAME/$xcode_arch" >&2
      exit 1
      ;;
  esac
done

if [ "${#RUST_TARGETS[@]}" -eq 0 ]; then
  echo "error: ARCHS did not contain a supported iOS architecture: $XCODE_ARCHS" >&2
  exit 1
fi

if [ "${CONFIGURATION:-Release}" = "Debug" ]; then
  CARGO_PROFILE="debug"
else
  CARGO_PROFILE="release"
fi

REQUIRED_CHANNEL="$(sed -n 's/^[[:space:]]*channel[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$CARGO_PROJECT/rust-toolchain.toml" | head -n 1)"
if [ -z "$REQUIRED_CHANNEL" ]; then
  echo "error: Cannot read the pinned Rust channel from $CARGO_PROJECT/rust-toolchain.toml" >&2
  exit 1
fi

if ! rustup toolchain list | grep -Eq "^${REQUIRED_CHANNEL}(-|[[:space:]])"; then
  echo "note: Installing Rust toolchain $REQUIRED_CHANNEL..."
  rustup toolchain install "$REQUIRED_CHANNEL" --profile minimal
fi

ARTIFACTS=()
for rust_target in "${RUST_TARGETS[@]}"; do
  if ! rustup target list --installed --toolchain "$REQUIRED_CHANNEL" | grep -Fxq "$rust_target"; then
    echo "note: Installing Rust target $rust_target for $REQUIRED_CHANNEL..."
    rustup target add "$rust_target" --toolchain "$REQUIRED_CHANNEL"
  fi

  echo "Building vnc-core for $rust_target ($CARGO_PROFILE)..."
  (
    cd "$CARGO_PROJECT"
    if [ "$CARGO_PROFILE" = "debug" ]; then
      cargo "+$REQUIRED_CHANNEL" build --target "$rust_target" --lib
    else
      cargo "+$REQUIRED_CHANNEL" build --target "$rust_target" --lib --release
    fi
  )

  artifact="$CARGO_PROJECT/target/$rust_target/$CARGO_PROFILE/libvnc_core.a"
  if [ ! -f "$artifact" ]; then
    echo "error: Build succeeded but artifact not found at $artifact" >&2
    exit 1
  fi
  ARTIFACTS+=("$artifact")
done

OUTPUT_DIR="${BUILT_PRODUCTS_DIR:-$CARGO_PROJECT/target/ios-$PLATFORM_NAME-$CARGO_PROFILE}"
OUTPUT_LIBRARY="$OUTPUT_DIR/libvnc_core.a"
mkdir -p "$OUTPUT_DIR"

if [ "${#ARTIFACTS[@]}" -eq 1 ]; then
  cp "${ARTIFACTS[0]}" "$OUTPUT_LIBRARY"
else
  xcrun lipo -create "${ARTIFACTS[@]}" -output "$OUTPUT_LIBRARY"
fi

echo "Built: $OUTPUT_LIBRARY"
