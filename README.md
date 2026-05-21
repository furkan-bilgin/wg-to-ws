# wg-to-ws

> **Disclaimer:** This project is vibecoded. It works (integration test passes),
> but don't expect production-grade error handling, security hardening, or
> aesthetic code. Review before deploying to production.

Tunnel WireGuard UDP traffic over WebSocket connections — lets WireGuard work
through firewalls, corporate proxies, and NATs that block UDP or deep-inspect
WireGuard's protocol.

**Zero dependencies** — built entirely on Bun's built-in UDP and WebSocket APIs.
~260 lines of TypeScript.

## Install

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/furkan-bilgin/wg-to-ws/main/install.sh | sh
```

```powershell
# Windows
iwr -useb https://raw.githubusercontent.com/furkan-bilgin/wg-to-ws/main/install.ps1 | iex
```

Or download a binary from the [latest release](https://github.com/furkan-bilgin/wg-to-ws/releases/latest).

## How it works

```
┌─────────────┐   UDP    ┌──────────────┐  WebSocket  ┌──────────────┐   UDP    ┌──────────────┐
│  WireGuard  │ ──────── │ wg-to-ws     │ ──────────► │ wg-to-ws     │ ──────── │  WireGuard   │
│  Client     │ ◄─────── │ Client       │ ◄────────── │ Server       │ ◄─────── │  Server      │
└─────────────┘          └──────────────┘             └──────────────┘          └──────────────┘
```

- **Client** listens on a local UDP port. WireGuard sends packets there thinking
  it's the remote peer. The client forwards each datagram as a binary WebSocket
  message to the server.
- **Server** accepts WebSocket connections (on a configurable base path). Each
  connection gets a dedicated UDP socket to the real WireGuard server. Data flows
  bidirectionally with no protocol inspection.
- When the WebSocket drops, the client reconnects with exponential backoff
  (100 ms → 10 s cap), so transient network issues self-heal.

## Usage

A single binary serves both modes — just pass `server` or `client`:

```bash
./wg-to-ws server [options]
./wg-to-ws client [options]
```

### Server (VPS)

```bash
# WireGuard server is already running on, say, 10.0.0.1:51820
./wg-to-ws server --bind 0.0.0.0:443 --base-path /wg --wg-addr 10.0.0.1:51820
```

### Client (laptop)

First, point WireGuard's peer endpoint to the wg-to-ws client:

```ini
# /etc/wireguard/wg0.conf
[Peer]
Endpoint = 127.0.0.1:51820
PublicKey = ...
AllowedIPs = ...
```

Then start the tunnel:

```bash
./wg-to-ws client --listen 127.0.0.1:51820 --ws-url wss://vps.example.com/wg
```

WireGuard now connects through the WebSocket tunnel. No changes to WireGuard's
own config beyond the endpoint address.

### Options

| CLI flag | Short | Env var | Default | Description |
|----------|-------|---------|---------|-------------|
| `--bind` | `-b` | `WS_BIND` | `0.0.0.0:8080` | WebSocket listen address (server) |
| `--base-path` | `-p` | `WS_BASE_PATH` | `/wg` | WebSocket base path (server) |
| `--wg-addr` | `-w` | `WG_SERVER_ADDR` | `127.0.0.1:51820` | Target WireGuard server (server) |
| `--listen` | `-l` | `WG_LOCAL_ADDR` + `WG_LOCAL_PORT` | `127.0.0.1:51820` | UDP listen address (client) |
| `--local-addr` | `-a` | `WG_LOCAL_ADDR` | `127.0.0.1` | UDP bind address (client) |
| `--local-port` | `-P` | `WG_LOCAL_PORT` | `51820` | UDP port (client) |
| `--ws-url` | `-u` | `WS_URL` | `ws://localhost:8080/wg` | WebSocket server URL (client) |
| `--shared-key` | `-k` | `WG_SHARED_KEY` | _(none)_ | Pre-shared key for auth + AES-256-GCM encryption |
| `--mode` | | `WG_MODE` | `client` | `server` or `client` |

All flags can also be set via environment variables. CLI flags take precedence.

## Running with TLS (production)

Use `wss://` in `--ws-url` — Bun's WebSocket client handles TLS natively.

For the server, put Caddy, nginx, or Traefik in front of wg-to-ws:

```nginx
# nginx example
location /wg {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

## Integration test

```bash
bash test/integration.sh
```

Starts a UDP echo server, the wg-to-ws server, the wg-to-ws client, sends a
known payload over UDP, and confirms the echo comes back through the tunnel.

## Project structure

```
src/
  index.ts    — Entry point: parses CLI args, dispatches to server or client
  shared.ts   — Config types, env-var parsing, CLI arg parsing, path normalisation
  server.ts   — WebSocket server with base-path routing, UDP forwarding
  client.ts   — UDP listener, WebSocket forwarding, reconnection
test/
  integration.sh — End-to-end smoke test
```

## Build

```bash
bun run build                   # native (macOS arm64)
bun run build:linux             # cross-compile: Linux x86-64
bun run build:darwin-arm64      # cross-compile: macOS arm64
bun run build:windows-x64       # cross-compile: Windows x86-64
make all-platforms              # all three at once
```

## Caveats

- **Single-peer client:** Tracks one sender address at a time. Works for
  standard single-interface WireGuard setups. For multi-peer or multi-interface
  machines, the client needs a per-source-port socket map.
- **No authentication:** Any client that reaches the WebSocket endpoint can
  tunnel UDP through your server. Add a reverse-proxy auth layer or a token
  handshake for production use.
- **Plain WebSocket by default:** Switch to `wss://` + TLS for internet-facing
  deployments (see "Running with TLS" above).
- **MTU:** WireGuard default MTU is 1420 bytes. WebSocket binary frames handle
  this comfortably.

## License

MIT
