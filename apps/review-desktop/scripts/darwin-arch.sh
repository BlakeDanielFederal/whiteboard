# shellcheck shell=bash
# Sets DARWIN_ARCH/DARWIN_TARGET from Node's arch, which native builds follow.
DARWIN_ARCH="$(node -p process.arch)"
case "$DARWIN_ARCH" in
  arm64 | x64) ;;
  *) echo "Unsupported macOS arch $DARWIN_ARCH" >&2; exit 1 ;;
esac
DARWIN_TARGET="darwin-$DARWIN_ARCH"
export DARWIN_ARCH DARWIN_TARGET
