#!/bin/sh

set -eu

REPO="${ANYA_REPO:-xrehpicx/anya}"
RELEASE="${ANYA_RELEASE:-latest}"
BIN_DIR="${ANYA_INSTALL_DIR:-$HOME/.local/bin}"
BIN_PATH="$BIN_DIR/anya"
TMP_DIR=""

usage() {
  cat <<EOF
Usage: install-anya.sh [--release VERSION] [--repo OWNER/REPO]

Environment:
  ANYA_INSTALL_DIR  Install directory. Defaults to \$HOME/.local/bin.
  ANYA_RELEASE      Release tag or "latest". Defaults to latest.
  ANYA_REPO         GitHub repository. Defaults to xrehpicx/anya.
EOF
}

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}

trap cleanup EXIT INT TERM

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release)
      if [ "$#" -lt 2 ]; then
        echo "--release requires a value." >&2
        exit 1
      fi
      RELEASE="$2"
      shift
      ;;
    --repo)
      if [ "$#" -lt 2 ]; then
        echo "--repo requires OWNER/REPO." >&2
        exit 1
      fi
      REPO="$2"
      shift
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

download() {
  url="$1"
  output="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$output"
    return
  fi

  if command -v wget >/dev/null 2>&1; then
    wget -q -O "$output" "$url"
    return
  fi

  echo "curl or wget is required to install Anya." >&2
  exit 1
}

resolve_target() {
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Linux)
      os_part="unknown-linux-gnu"
      ;;
    Darwin)
      os_part="apple-darwin"
      ;;
    *)
      echo "Unsupported operating system: $os" >&2
      exit 1
      ;;
  esac

  case "$arch" in
    x86_64 | amd64)
      arch_part="x86_64"
      ;;
    arm64 | aarch64)
      arch_part="aarch64"
      ;;
    *)
      echo "Unsupported CPU architecture: $arch" >&2
      exit 1
      ;;
  esac

  printf '%s-%s\n' "$arch_part" "$os_part"
}

release_base_url() {
  if [ "$RELEASE" = "latest" ]; then
    printf 'https://github.com/%s/releases/latest/download\n' "$REPO"
  else
    printf 'https://github.com/%s/releases/download/%s\n' "$REPO" "$RELEASE"
  fi
}

TARGET="$(resolve_target)"
ASSET="anya-$TARGET.tar.gz"
URL="$(release_base_url)/$ASSET"

TMP_DIR="$(mktemp -d)"
ARCHIVE="$TMP_DIR/$ASSET"

printf 'Installing Anya for %s from %s\n' "$TARGET" "$URL"
download "$URL" "$ARCHIVE"

tar -xzf "$ARCHIVE" -C "$TMP_DIR"

if [ ! -f "$TMP_DIR/anya" ]; then
  echo "Downloaded archive did not contain an anya binary." >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
install -m 0755 "$TMP_DIR/anya" "$BIN_PATH"

printf 'Installed %s\n' "$BIN_PATH"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    printf 'Add %s to PATH to run anya from any shell.\n' "$BIN_DIR"
    ;;
esac
