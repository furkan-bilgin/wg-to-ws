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
| `--no-auth` | `-n` | `WG_NO_AUTH` | _(none)_ | Explicitly disable authentication (open relay; refused on non-loopback bind unless `WG_ALLOW_INSECURE_NO_AUTH=1`) |
| `--no-ban` | | `WG_NO_BAN` | `false` | Disable auth-failure bans (must be set on the server) |
| `--max-connections` | `-m` | `WG_MAX_CONNECTIONS` | `100` | Max concurrent WebSocket connections, global (server; clamped 1–10000) |
| `--trust-proxy` | | `WG_TRUST_PROXY` | `false` | Take the client IP from the last `X-Forwarded-For` hop (server behind a reverse proxy) |
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
   previous single-round SHA-256. The frame header (epoch + sequence) is GCM
   associated data, so header tampering fails authentication.

2a. **Per-packet rekey rotation** — each direction carries an `epoch` key
   generation plus a per-epoch sequence counter. The sender rotates to a new
   epoch (fresh `scrypt`-derived key, counter reset) every 500,000 packets or
   every hour, whichever comes first. The receiver only accepts the current
   epoch or the next epoch; older epochs and epoch skips are dropped. This
   bounds how much ciphertext any single key protects.

3. **Replay protection** — every message carries an `(epoch, sequence)` header
   authenticated by GCM. Within an epoch the sequence must be strictly
   monotonic; implausible forward jumps (>1,000,000) are dropped. A new epoch
   restarts the counter and is only accepted as the immediate next epoch with
   a small starting sequence. Duplicate, replayed, or cross-epoch stale
   messages are silently dropped.

4. **Rate limiting** — the server tracks failed authentication attempts per IP
   (normalized: `::ffff:` stripped, lowercased). After 5 failed attempts
   within 60 seconds, the IP is banned for 15 minutes. The tracking map is
   capped at 10,000 entries with oldest-first eviction. Malformed `AUTH` and
   oversize frames also count as failures. `--no-ban` disables the ban
   (restart the server to clear active bans).

5. **Max connections** — configurable global limit (default 100, clamped
   1–10000) plus a per-IP cap (10). Oversize WebSocket frames
   (`MAX_FRAME_BYTES` = 70,000) are dropped and the sender is
   rate-limit-counted. Behind a reverse proxy, set `--trust-proxy` so the
   per-IP cap and auth bans use the real client IP, not the proxy's.

6. **Origin validation** — optional `--allow-origin` checks the `Origin` header
   as defense-in-depth against cross-origin WebSocket hijacking.

### Without authentication

If neither `--shared-key` nor `--shared-key-file` is provided, the connection
is **unauthenticated and unencrypted**. A warning is shown at startup.
Pass `--no-auth` explicitly to suppress the warning. As a fail-closed guard,
`--no-auth` on a non-loopback bind is **refused** unless
`WG_ALLOW_INSECURE_NO_AUTH=1` is set — otherwise the server would be an
unauthenticated UDP relay.

### Key management

- Prefer `--shared-key-file` / `WG_SHARED_KEY_FILE` over CLI flags or
  environment variables — the key won't appear in `ps aux` or `/proc/self/environ`.
  Key files over 4 KB are rejected, empty files are rejected, and
  group/other-readable files trigger a `chmod 600` warning. Empty
  `--shared-key` values are rejected at startup.
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
    # Overwrite, so clients cannot pre-seed the header
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

Then start the server with `--trust-proxy`. Without it, every connection
enters the per-IP limit and the auth ban under `127.0.0.1` (the proxy), so
10 concurrent peers lock out the server. Only enable it when the server is
not directly reachable; otherwise clients can spoof the header and bypass
per-IP limits and bans.

## Integration test

```bash
bash test/integration.sh   # end-to-end smoke test (UDP echo through tunnel)
bun test                   # wire-level replay-window + rekey tests (test/replay.test.ts)
bunx tsc --noEmit          # typecheck
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
  replay.test.ts — Wire-level replay-window + epoch rekey tests (`bun test`)
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

- **Single-peer client:** Pins the first UDP sender (address:port) and routes
  replies only to that peer; spoofed sources are ignored. The pin refreshes
  after 60 s idle or on reconnect, so a legit peer change recovers. The
  sender map is bounded (`MAX_SENDERS` = 8) and the pre-auth buffer is capped
  (`MAX_PENDING_QUEUE` = 100).
- **Plain WebSocket by default:** Switch to `wss://` + TLS for internet-facing
  deployments. `wss://` is required (not optional) for Internet use.
- **MTU:** WireGuard default MTU is 1420 bytes. WebSocket binary frames handle
  this comfortably. UDP payloads over 65507 bytes are dropped.
- **Install verification:** `install.sh` / `install.ps1` verify SHA-256
  checksums fail-closed (abort on mismatch, missing file, or fetch failure).
  CI pins third-party actions by SHA and publishes build provenance.

## License

MIT
