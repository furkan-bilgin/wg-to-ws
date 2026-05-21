# wg-to-ws

> **Disclaimer:** This project is vibecoded. It works (integration test passes),
> but don't expect production-grade error handling, security hardening, or
> aesthetic code. Review before deploying to production.

Tunnel WireGuard UDP traffic over WebSocket connections — lets WireGuard work
through firewalls, corporate proxies, and NATs that block UDP or deep-inspect
WireGuard's protocol.

**Zero dependencies** — built entirely on Bun's built-in UDP and WebSocket APIs.
~250 lines of TypeScript.

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

### Server (VPS)

```bash
# WireGuard server is already running on, say, 10.0.0.1:51820
WG_MODE=server \
  WS_BIND="0.0.0.0:443" \
  WS_BASE_PATH="/wg" \
  WG_SERVER_ADDR="10.0.0.1:51820" \
  bun src/server.ts
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
WG_MODE=client \
  WG_LOCAL_PORT=51820 \
  WS_URL="wss://vps.example.com/wg" \
  bun src/client.ts
```

WireGuard now connects through the WebSocket tunnel. No changes to WireGuard's
own config beyond the endpoint address.

## Environment variables

| Variable         | Default                  | Description                               |
|------------------|--------------------------|-------------------------------------------|
| `WG_MODE`        | `client`                 | `client` or `server`                      |
| `WG_LOCAL_ADDR`  | `127.0.0.1`              | UDP bind address for the client listener  |
| `WG_LOCAL_PORT`  | `51820`                  | UDP port for the client listener          |
| `WG_SERVER_ADDR` | `127.0.0.1:51820`        | Target WireGuard server (server mode)     |
| `WS_URL`         | `ws://localhost:8080/wg` | WebSocket server URL (client mode)        |
| `WS_BIND`        | `0.0.0.0:8080`           | WebSocket listen address (server mode)    |
| `WS_BASE_PATH`   | `/wg`                    | Base path for WebSocket (server mode)     |

## Running with TLS (production)

Bun's `WebSocket` client supports `wss://` natively. For the server, you have
two options:

**Option A — reverse proxy (recommended):** Put Caddy, nginx, or Traefik in
front of wg-to-ws. They handle TLS termination and let wg-to-ws stay simple.

```nginx
# nginx example
location /wg {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

**Option B — Bun TLS:** Pass TLS options to `Bun.serve` (requires a certificate
file — not yet wired in this project; easy to add).

## Integration test

```bash
bash test/integration.sh
```

Starts a UDP echo server, the wg-to-ws server, the wg-to-ws client, sends a
known payload over UDP, and finally confirms the echo comes back through the tunnel.

## Project structure

```
src/
  shared.ts   — Config types, env-var parsing, path normalisation
  server.ts   — WebSocket server with base-path routing, UDP forwarding
  client.ts   — UDP listener, WebSocket forwarding, reconnection
test/
  integration.sh — End-to-end smoke test
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
