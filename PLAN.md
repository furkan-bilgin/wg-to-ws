# wg-to-ws — WireGuard over WebSocket Tunnel

## Goal

Tunnel WireGuard UDP packets over WebSocket connections so WireGuard can work
through firewalls/proxies that block UDP or deep-inspect WireGuard's protocol.

## Architecture

```
┌─────────────┐   UDP    ┌──────────────┐  WebSocket  ┌──────────────┐   UDP    ┌──────────────┐
│  WireGuard  │ ──────── │ wg-to-ws     │ ──────────► │ wg-to-ws     │ ──────── │  WireGuard   │
│  Client     │ ◄─────── │ Client       │ ◄────────── │ Server       │ ◄─────── │  Server      │
└─────────────┘          └──────────────┘             └──────────────┘          └──────────────┘
```

- **wg-to-ws Client** listens on a local UDP port. The real WireGuard client thinks it is talking
  directly to the remote peer. Received UDP packets are forwarded over a WebSocket connection.
- **wg-to-ws Server** accepts WebSocket connections (on a configurable base path). Each connection
  gets a dedicated UDP socket to the real WireGuard server. Bidirectional forwarding between
  WebSocket <-> UDP.
- The **base path** lets you mount the server behind a reverse proxy alongside other services.

## Files & Modules (target: < 1000 lines total)

```
wg-to-ws/
├── package.json        # dependencies: none (Bun built-ins only)
├── tsconfig.json       # strict TS config for Bun
├── src/
│   ├── shared.ts       # config types, message framing helpers
│   ├── client.ts       # client entry: UDP listener + WS forwarder
│   └── server.ts       # server entry: WS listener + UDP forwarder
```

Zero npm dependencies — uses Bun's built-in `Bun.listen` (UDP) and `Bun.serve`
(WebSocket). Under 600 lines of actual code.

## Data Flow

### Client

1. Bind UDP socket to `127.0.0.1:<localPort>` (default 51820).
2. Connect WebSocket to `ws://<server>:<serverPort><basePath>`.
3. **UDP → WS**: on each UDP datagram, send the raw bytes as a binary WebSocket message.
4. **WS → UDP**: on each binary WebSocket message, write the bytes to the UDP socket
   (destined for the local WireGuard client).
5. On WebSocket disconnect → reconnect with exponential backoff (100ms – 10s).
6. On UDP error → log and continue.

### Server

1. Listen for WebSocket connections on `{basePath}` (default `/wg`).
2. On `open`: create a UDP socket to the target WireGuard server
   (`<wgHost>:<wgPort>`, default `127.0.0.1:51820`). Store the mapping.
3. **WS → UDP**: on binary message, send the bytes to the WireGuard server via UDP.
4. **UDP → WS**: on UDP datagram, send the bytes as a binary WebSocket message.
5. On `close` / `error`: close the UDP socket, clean up the mapping.

### Base path handling

- The server uses `fetch`-style path matching so it only accepts connections under the
  configured base path (e.g. `/wg`, `/wg/`, `/tunnel/wg`).
- Any path segment after the base path is ignored (allows room for future per-connection
  routing without breaking existing clients).
- A reverse proxy can place the server at `/wg/` and serve other routes from the same
  origin.

## Configuration

All config is read from environment variables at startup. No config file needed.

| Variable         | Default            | Description                          |
|------------------|--------------------|--------------------------------------|
| `WG_MODE`        | `client`           | `client` or `server`                 |
| `WG_LOCAL_ADDR`  | `127.0.0.1`        | Local UDP bind address (client)      |
| `WG_LOCAL_PORT`  | `51820`            | Local UDP port (client)              |
| `WG_SERVER_ADDR` | `127.0.0.1:51820`  | Target WireGuard server (server)     |
| `WS_URL`         | `ws://localhost:8080/wg` | WebSocket server URL (client)   |
| `WS_BIND`        | `0.0.0.0:8080`     | WebSocket listen address (server)    |
| `WS_BASE_PATH`   | `/wg`              | WebSocket base path (server)         |

## Key Design Decisions

1. **One WS connection per UDP socket (1:1 mapping).** Each incoming WebSocket connection
   gets its own dedicated UDP socket to the WireGuard server. This avoids multiplexing
   framing overhead and keeps the code trivial.

2. **Raw binary pass-through.** No extra envelope or length prefix — each WebSocket
   binary message is exactly one UDP datagram. Bun's WebSocket API already preserves
   message boundaries.

3. **Bun built-ins only.** `Bun.listen({socket})` for UDP and `Bun.serve({websocket})`.
   Zero npm dependencies.

4. **Environment variables for config.** No config parser, no YAML/TOML, no CLI args.
   Five env vars, one helper function.

## Edge Cases Handled

- **Reconnection**: client reconnects on WS close with exponential backoff.
- **Orderly shutdown**: server closes UDP socket on WS close; client closes UDP on WS
  close and retries.
- **Base path normalization**: trailing slash stripped, double slashes collapsed.
- **Large packets**: WireGuard MTU is 1420 bytes, safely within Bun's default WS
  message limit.
- **Concurrent sessions**: server handles N simultaneous WS → UDP pairs via a `Map`.

## Future Considerations (not in v1)

- TLS support (just prefix URL with `wss://` or use Bun's TLS options).
- Multiplexed session IDs over a single WebSocket (saves connections).
- Authentication / token handshake on connect.
- Metrics (active sessions, bytes transferred).
- Dockerfile for easy deployment.
