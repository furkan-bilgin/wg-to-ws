WG_VERSION := $(shell git describe --tags --abbrev=0 2>/dev/null || echo dev)

.PHONY: all check clean linux darwin windows all-platforms

all: wg-to-ws

# ── macOS arm64 (native) ──────────────────────────────────────

wg-to-ws: src/index.ts src/server.ts src/client.ts src/shared.ts
	bun build --compile --outfile=$@ --define WG_VERSION="$(WG_VERSION)" src/index.ts

darwin-arm64: wg-to-ws-darwin-arm64

wg-to-ws-darwin-arm64: src/index.ts
	bun build --compile --target=bun-darwin-arm64 --outfile=$@ --define WG_VERSION="$(WG_VERSION)" src/index.ts

# ── Linux AMD64 ───────────────────────────────────────────────

linux: wg-to-ws-linux-x64

wg-to-ws-linux-x64: src/index.ts
	bun build --compile --target=bun-linux-x64 --outfile=$@ --define WG_VERSION="$(WG_VERSION)" src/index.ts

# ── Windows x64 ───────────────────────────────────────────────

windows: wg-to-ws-windows-x64.exe

wg-to-ws-windows-x64.exe: src/index.ts
	bun build --compile --target=bun-windows-x64 --outfile=$@ --define WG_VERSION="$(WG_VERSION)" src/index.ts

# ── All platforms ─────────────────────────────────────────────

all-platforms: darwin-arm64 linux windows

# ── Utilities ─────────────────────────────────────────────────

check:
	bun run tsc --noEmit

clean:
	rm -f wg-to-ws
	rm -f wg-to-ws-darwin-arm64
	rm -f wg-to-ws-linux-x64
	rm -f wg-to-ws-windows-x64.exe
