#!/usr/bin/env sh
# wg-to-ws — one-line install
#   curl -fsSL https://raw.githubusercontent.com/furkan-bilgin/wg-to-ws/main/install.sh | sh
#
# Windows:
#   iwr -useb https://raw.githubusercontent.com/furkan-bilgin/wg-to-ws/main/install.ps1 | iex
set -eu

REPO="furkan-bilgin/wg-to-ws"
VERSION="${VERSION:-latest}"

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)  SUFFIX="linux-x64" ;;
  Darwin)
    case "$ARCH" in
      arm64|aarch64) SUFFIX="darwin-arm64" ;;
      *)             echo "Unsupported arch: $ARCH on macOS"; exit 1 ;;
    esac
    ;;
  *)      echo "Unsupported OS: $OS"; exit 1 ;;
esac

# Determine latest release tag if not specified
if [ "$VERSION" = "latest" ]; then
  echo "Fetching latest release..."
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | cut -d'"' -f4)"
  if [ -z "$VERSION" ]; then
    echo "Failed to fetch latest release tag"
    exit 1
  fi
fi

BINARY="wg-to-ws-$SUFFIX"
URL="https://github.com/$REPO/releases/download/$VERSION/$BINARY"
CHECKSUM_URL="https://github.com/$REPO/releases/download/$VERSION/checksums.txt"
DEST="${DEST:-/usr/local/bin/wg-to-ws}"

echo "Downloading $BINARY ($VERSION)..."
curl -fsSL "$URL" -o /tmp/wg-to-ws

# M4: Verify SHA-256 checksum
echo "Verifying checksum..."
CHECKSUMS=$(curl -fsSL "$CHECKSUM_URL" 2>/dev/null || true)
if [ -n "$CHECKSUMS" ]; then
  EXPECTED=$(echo "$CHECKSUMS" | grep "$BINARY" | cut -d' ' -f1)
  if [ -n "$EXPECTED" ]; then
    ACTUAL=$(sha256sum /tmp/wg-to-ws | cut -d' ' -f1)
    if [ "$ACTUAL" != "$EXPECTED" ]; then
      echo "ERROR: Checksum mismatch for $BINARY"
      echo "  Expected: $EXPECTED"
      echo "  Actual:   $ACTUAL"
      rm -f /tmp/wg-to-ws
      exit 1
    fi
    echo "Checksum OK"
  else
    echo "WARNING: $BINARY not found in checksums.txt — skipping verification"
  fi
else
  echo "WARNING: Could not fetch checksums.txt — skipping verification"
fi

chmod +x /tmp/wg-to-ws

if [ -w "$(dirname "$DEST")" ]; then
  mv /tmp/wg-to-ws "$DEST"
else
  echo "Need sudo to install to $DEST"
  sudo mv /tmp/wg-to-ws "$DEST"
fi

echo "Installed wg-to-ws to $DEST"
echo "Run 'wg-to-ws server' or 'wg-to-ws client' to get started."
