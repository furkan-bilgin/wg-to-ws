# Sprint Plans — wg-to-ws

Three 2-day sprints. Each sprint produces a working, testable increment.

---

## Sprint 1 — Project scaffold + shared config

**Goal:** bootable project with env-var config and a smoke-test script.

### Tasks

| # | Task | Acceptance criteria |
|---|------|-------------------|
| 1.1 | Create `package.json` with `bun` type module, no dependencies, `"type": "module"` | `bun install` succeeds; no dependencies installed |
| 1.2 | Create `tsconfig.json` — strict mode, ES2022 target, moduleResolution bundler | `bun check` type-checks an empty file |
| 1.3 | Write `src/shared.ts` — `Config` type, `loadConfig()` that reads env vars with defaults, `normalizePath()` for base-path cleaning | `loadConfig()` returns correct values for both modes; `normalizePath("/wg//")` returns `"/wg"` |
| 1.4 | Write `src/server.ts` (stub) — parse args, call `loadConfig()`, print config and exit | `WG_MODE=server bun run src/server.ts` prints parsed config and exits cleanly |
| 1.5 | Write `src/client.ts` (stub) — same stub pattern | `WG_MODE=client bun run src/client.ts` prints parsed config and exits cleanly |
| 1.6 | Add `package.json` scripts: `dev:server`, `dev:client`, `check` (type-check) | `bun run check` passes |

**Definition of done:** both stubs run, print config, type-check passes.

**Estimated lines added:** ~100.

---

## Sprint 2 — Server implementation

**Goal:** fully functional server that accepts WebSocket connections at a configurable
base path and forwards binary messages to/from a target WireGuard UDP endpoint.

### Tasks

| # | Task | Acceptance criteria |
|---|------|-------------------|
| 2.1 | Implement full `src/server.ts` — create `Bun.serve` with `fetch` handler, WebSocket `open`/`message`/`close` handlers | Server starts and logs listen address |
| 2.2 | Implement base-path matching in `fetch` — reject paths that don't start with `WS_BASE_PATH`, upgrade others | `ws://host:port/wg` upgrades; `ws://host:port/other` returns 404 |
| 2.3 | On WebSocket `open`, create a UDP socket (`Bun.udpSocket()`) to `WG_SERVER_ADDR`; store in a `Map<WebSocket, udpSocket>` | Logged "new session from <ip>" with assigned UDP socket |
| 2.4 | On WebSocket `binary` message, forward bytes to the UDP socket | Server sends exactly the received bytes to `WG_SERVER_ADDR` |
| 2.5 | On UDP datagram received, forward bytes to the owning WebSocket | Client receives exactly the bytes sent by the WireGuard server |
| 2.6 | On WebSocket `close` / error, close and clean up the UDP socket; remove from Map | No dangling UDP sockets after disconnect |
| 2.7 | Graceful shutdown — `SIGINT` / `SIGTERM` closes all WebSocket connections and UDP sockets | Server exits without ECONNRESET spam |

**Definition of done:** manual test with `websocat` — connect to `/wg`, send binary
data, confirm it reaches a local UDP echo server; echo response comes back via WS.

**Estimated lines added:** ~250.

---

## Sprint 3 — Client implementation + integration smoke-test

**Goal:** fully functional client that listens on a local UDP port, connects to
the server via WebSocket, and forwards bidirectionally with reconnection logic.

### Tasks

| # | Task | Acceptance criteria |
|---|------|-------------------|
| 3.1 | Implement full `src/client.ts` — create UDP listener via `Bun.udpSocket()` on `WG_LOCAL_PORT` | Client binds and logs "listening on UDP <port>" |
| 3.2 | Implement WebSocket connection to `WS_URL` with binary type | Client connects and logs "connected to <url>" |
| 3.3 | On UDP datagram, send bytes via WebSocket binary message | Server receives the datagram bytes |
| 3.4 | On WebSocket binary message, send bytes via UDP to the local sender | Local WireGuard client receives the response |
| 3.5 | Implement reconnection — on WebSocket close, reconnect with exponential backoff (100ms initial, 10s cap, 1.5x multiplier) | Client retries after kill/restart of server; backoff is observable in logs |
| 3.6 | Track UDP sender per-datagram — each outgoing UDP datagram must target the correct local address/port that sent the original packet | Client sends responses to the correct origin |
| 3.7 | Graceful shutdown — `SIGINT` / `SIGTERM` closes WebSocket and UDP socket | Client exits cleanly |
| 3.8 | Integration smoke-test — `bash` script that starts a UDP echo server, starts wg-to-ws server, starts wg-to-ws client, sends a known payload via UDP, confirms it echoes back | End-to-end: client → WS → server → UDP echo → server → WS → client → original sender |

**Definition of done:** integration smoke-test passes. Running `WG_MODE=server` on
a VPS and `WG_MODE=client` on a laptop successfully tunnels real WireGuard handshake
packets (observed via `tcpdump`).

**Estimated lines added:** ~250.

---

## Summary

| Sprint | Focus | Est. lines | Depends on |
|--------|-------|------------|------------|
| 1 | Project scaffold + shared config | ~100 | Nothing |
| 2 | Server (WS → UDP) | ~250 | Sprint 1 |
| 3 | Client (UDP → WS) + integration test | ~250 | Sprint 2 |

**Total ~600 lines** across 3 source files, well under the 1000-line budget.
