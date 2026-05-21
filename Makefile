.PHONY: all check clean linux darwin windows all-platforms

all: wg-to-ws

# ── macOS arm64 (native) ──────────────────────────────────────

wg-to-ws: src/index.ts
	bun build --compile --outfile=$@ src/index.ts

wg-to-ws-server: src/server.ts
	bun build --compile --outfile=$@ src/server.ts

wg-to-ws-client: src/client.ts
	bun build --compile --outfile=$@ src/client.ts

darwin-arm64: wg-to-ws-darwin-arm64 wg-to-ws-server-darwin-arm64 wg-to-ws-client-darwin-arm64

wg-to-ws-darwin-arm64: src/index.ts
	bun build --compile --target=bun-darwin-arm64 --outfile=$@ src/index.ts

wg-to-ws-server-darwin-arm64: src/server.ts
	bun build --compile --target=bun-darwin-arm64 --outfile=$@ src/server.ts

wg-to-ws-client-darwin-arm64: src/client.ts
	bun build --compile --target=bun-darwin-arm64 --outfile=$@ src/client.ts

# ── Linux AMD64 ───────────────────────────────────────────────

linux: wg-to-ws-linux-x64 wg-to-ws-server-linux-x64 wg-to-ws-client-linux-x64

wg-to-ws-linux-x64: src/index.ts
	bun build --compile --target=bun-linux-x64 --outfile=$@ src/index.ts

wg-to-ws-server-linux-x64: src/server.ts
	bun build --compile --target=bun-linux-x64 --outfile=$@ src/server.ts

wg-to-ws-client-linux-x64: src/client.ts
	bun build --compile --target=bun-linux-x64 --outfile=$@ src/client.ts

# ── Windows x64 ───────────────────────────────────────────────

windows: wg-to-ws-windows-x64.exe wg-to-ws-server-windows-x64.exe wg-to-ws-client-windows-x64.exe

wg-to-ws-windows-x64.exe: src/index.ts
	bun build --compile --target=bun-windows-x64 --outfile=$@ src/index.ts

wg-to-ws-server-windows-x64.exe: src/server.ts
	bun build --compile --target=bun-windows-x64 --outfile=$@ src/server.ts

wg-to-ws-client-windows-x64.exe: src/client.ts
	bun build --compile --target=bun-windows-x64 --outfile=$@ src/client.ts

# ── All platforms ─────────────────────────────────────────────

all-platforms: darwin-arm64 linux windows

# ── Utilities ─────────────────────────────────────────────────

check:
	bun run tsc --noEmit

clean:
	rm -f wg-to-ws wg-to-ws-server wg-to-ws-client
	rm -f wg-to-ws-darwin-arm64 wg-to-ws-server-darwin-arm64 wg-to-ws-client-darwin-arm64
	rm -f wg-to-ws-linux-x64 wg-to-ws-server-linux-x64 wg-to-ws-client-linux-x64
	rm -f wg-to-ws-windows-x64.exe wg-to-ws-server-windows-x64.exe wg-to-ws-client-windows-x64.exe
