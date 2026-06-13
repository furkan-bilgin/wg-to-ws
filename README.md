# wg-to-ws

Tunnel WireGuard UDP traffic over WebSocket connections — lets WireGuard work
through firewalls, corporate proxies, and NATs that block UDP or deep-inspect
WireGuard's protocol.

**Zero runtime dependencies** — built entirely on Bun's built-in UDP and WebSocket APIs.

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
./wg-to-ws server --bind 127.0.0.1:8080 --base-path /wg --wg-addr 10.0.0.1:51820 --shared-key mysecret
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
./wg-to-ws client --listen 127.0.0.1:51820 --ws-url wss://vps.example.com/wg --shared-key mysecret
```

WireGuard now connects through the encrypted WebSocket tunnel. No changes to WireGuard's
own config beyond the endpoint address.

## Options

| CLI flag | Short | Env var | Default | Description |
|----------|-------|---------|---------|-------------|
| `--bind` | `-b` | `WS_BIND` | `127.0.0.1:8080` | WebSocket listen address (server) |
| `--base-path` | `-p` | `WS_BASE_PATH` | `/wg` | WebSocket base path (server) |
| `--wg-addr` | `-w` | `WG_SERVER_ADDR` | `127.0.0.1:51820` | Target WireGuard server (server) |
| `--listen` | `-l` | `WG_LOCAL_ADDR` + `WG_LOCAL_PORT` | `127.0.0.1:51820` | UDP listen address (client) |
| `--local-addr` | `-a` | `WG_LOCAL_ADDR` | `127.0.0.1` | UDP bind address (client) |
| `--local-port` | `-P` | `WG_LOCAL_PORT` | `51820` | UDP port (client) |
| `--ws-url` | `-u` | `WS_URL` | `ws://localhost:8080/wg` | WebSocket server URL (client) |
| `--shared-key` | `-k` | `WG_SHARED_KEY` | _(none)_ | Pre-shared key for auth + AES-256-GCM encryption |
| `--shared-key-file` | `-K` | `WG_SHARED_KEY_FILE` | _(none)_ | Read shared key from file (more secure than CLI) |
| `--no-auth` | `-n` | `WG_NO_AUTH` | _(none)_ | Explicitly disable authentication (open relay) |
| `--max-connections` | `-m` | `WG_MAX_CONNECTIONS` | `100` | Max concurrent WebSocket connections (server) |
| `--allow-origin` | `-o` | `WG_ALLOW_ORIGIN` | _(none)_ | Allowed Origin header value (defense-in-depth) |
| `--mode` | | `WG_MODE` | `client` | `server` or `client` |

All flags can also be set via environment variables. CLI flags take precedence.

## Security

### Authentication & Encryption

When `--shared-key` (or `-k`) is provided, the tunnel is protected by:

1. **Challenge-response authentication** — the server sends a random nonce,
   the client responds with `HMAC-SHA256(nonce, key)`. The shared key is
   **never transmitted** over the wire, and comparison uses
   `crypto.timingSafeEqual()` to prevent timing side-channel attacks.

2. **AES-256-GCM encryption** — all tunnel data is encrypted with a key derived
   from the shared secret via **scrypt** (memory-hard KDF), replacing the
   previous single-round SHA-256. Sequence numbers are included as GCM
   associated data for replay protection.

3. **Replay protection** — every encrypted message carries a monotonic
   sequence number authenticated by GCM. Duplicate or out-of-order messages
   are silently dropped.

4. **Rate limiting** — the server tracks failed authentication attempts per IP.
   After 5 failed attempts within 60 seconds, the IP is banned for 15 minutes.

5. **Max connections** — configurable limit (default 100) prevents
   resource-exhaustion attacks.

6. **Origin validation** — optional `--allow-origin` checks the `Origin` header
   as defense-in-depth against cross-origin WebSocket hijacking.

### Without authentication

If neither `--shared-key` nor `--shared-key-file` is provided, the connection
is **unauthenticated and unencrypted**. A warning is shown at startup.
Pass `--no-auth` explicitly to suppress the warning and opt into open-relay mode.

### Key management

- Prefer `--shared-key-file` / `WG_SHARED_KEY_FILE` over CLI flags or
  environment variables — the key won't appear in `ps aux` or `/proc/self/environ`.
- Use a strong, randomly generated key (e.g., `openssl rand -base64 32`).
- Always use `wss://` (TLS) for internet-facing deployments.

### TLS (production)

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
  shared.ts   — Config types, env-var parsing, CLI arg parsing, crypto, protocol
  server.ts   — WebSocket server with challenge-response auth, UDP forwarding
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
- **Plain WebSocket by default:** Switch to `wss://` + TLS for internet-facing
  deployments.
- **MTU:** WireGuard default MTU is 1420 bytes. WebSocket binary frames handle
  this comfortably.

## License

MIT
