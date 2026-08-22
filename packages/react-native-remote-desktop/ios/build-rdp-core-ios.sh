#!/bin/bash
# Build rdp-core as an iOS static library. A cdylib is intentionally not linked on iOS.

set -euo pipefail

CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export PATH="$CARGO_HOME/bin:$PATH"
for tool in cargo rustc rustup; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: $tool is required to build rdp-core; install rustup first" >&2
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PACKAGE_ROOT="$(cd "${PODS_TARGET_SRCROOT:-$SCRIPT_DIR/..}" && pwd -P)"
REPO_ROOT="$(cd "$PACKAGE_ROOT/../.." && pwd -P)"
CARGO_PROJECT="$REPO_ROOT/services/rdp-core"

if [ ! -f "$CARGO_PROJECT/Cargo.toml" ]; then
  echo "error: Cannot find rdp-core at $CARGO_PROJECT" >&2
  exit 1
fi

PLATFORM_NAME="${PLATFORM_NAME:-iphoneos}"
XCODE_ARCHS="${ARCHS:-arm64}"
RUST_TARGETS=()
for xcode_arch in $XCODE_ARCHS; do
  case "$PLATFORM_NAME:$xcode_arch" in
    iphoneos:arm64) RUST_TARGETS+=("aarch64-apple-ios") ;;
    iphonesimulator:arm64) RUST_TARGETS+=("aarch64-apple-ios-sim") ;;
    iphonesimulator:x86_64) RUST_TARGETS+=("x86_64-apple-ios") ;;
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
  rustup toolchain install "$REQUIRED_CHANNEL" --profile minimal
fi

# Keep C dependencies (AWS-LC/OpenH264) at the same deployment floor as the app.
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-15.1}"

ARTIFACTS=()
for rust_target in "${RUST_TARGETS[@]}"; do
  if ! rustup target list --installed --toolchain "$REQUIRED_CHANNEL" | grep -Fxq "$rust_target"; then
    rustup target add "$rust_target" --toolchain "$REQUIRED_CHANNEL"
  fi

  echo "Building rdp-core staticlib for $rust_target ($CARGO_PROFILE)..."
  (
    cd "$CARGO_PROJECT"
    if [ "$CARGO_PROFILE" = "release" ]; then
      cargo "+$REQUIRED_CHANNEL" rustc --lib --target "$rust_target" --release -- --crate-type staticlib
    else
      cargo "+$REQUIRED_CHANNEL" rustc --lib --target "$rust_target" -- --crate-type staticlib
    fi
  )

  artifact="$CARGO_PROJECT/target/$rust_target/$CARGO_PROFILE/librdp_core.a"
  if [ ! -f "$artifact" ]; then
    echo "error: Build succeeded but artifact not found at $artifact" >&2
    exit 1
  fi
  ARTIFACTS+=("$artifact")
done

OUTPUT_DIR="${BUILT_PRODUCTS_DIR:-$CARGO_PROJECT/target/ios-$PLATFORM_NAME-$CARGO_PROFILE}"
OUTPUT_LIBRARY="$OUTPUT_DIR/librdp_core.a"
mkdir -p "$OUTPUT_DIR"
if [ "${#ARTIFACTS[@]}" -eq 1 ]; then
  cp "${ARTIFACTS[0]}" "$OUTPUT_LIBRARY"
else
  xcrun lipo -create "${ARTIFACTS[@]}" -output "$OUTPUT_LIBRARY"
fi

echo "Built: $OUTPUT_LIBRARY"
