# Security Audit — wg-to-ws

## Summary

| Risk Level | Medium |
|---|---|
| **Critical findings** | 0 |
| **High findings** | 2 |
| **Medium findings** | 4 |
| **Low findings** | 4 |

The project is a wire‑protocol tunnel (WireGuard UDP ↔ WebSocket) and is
explicitly marked as "vibecoded" and not production‑ready.  The most serious
issues are the lack of authentication (anyone who reaches the WebSocket endpoint
can tunnel arbitrary traffic) and the absence of resource limits (an attacker can
exhaust server sockets with a handful of connections).  The use of plain
`ws://` by default means WireGuard metadata (public keys, handshake timing) is
visible in transit.  All findings are fixable with moderate effort.

---

## Findings

### [F-001] No authentication — arbitrary tunnel access

- **Severity:** High
- **Location:** `src/server.ts:27–62` (WebSocket `open` / `message` handlers)
- **Description:**
  The server accepts every WebSocket connection that reaches the configured base
  path.  There is no token, origin header check, TLS client certificate, or any
  other form of authentication.  Once the WebSocket is open the client can
  forward arbitrary UDP datagrams to the configured `WG_SERVER_ADDR`.
- **Impact:**
  Anyone who discovers or guesses the WebSocket URL (e.g. `wss://vps.example.com/wg`)
  can:
  - Send arbitrary UDP traffic to the internal WireGuard server.
  - Receive responses from that server, leaking WireGuard handshake messages
    and encrypted payload metadata.
  - Use the tunnel as an open UDP proxy to the target.
- **Recommendation:**
  Add an authentication layer.  Options (least to most effort):
  1. Rely on a reverse proxy (nginx/Caddy) to enforce HTTP Basic Auth, client
     certificates, or IP allowlisting before the upgrade.
  2. Add a shared‑secret token handshake on WebSocket open.
  3. Implement a short‑lived JWT or similar challenge‑response in the first
     message.

---

### [F-002] No connection or resource limits (DoS)

- **Severity:** High
- **Location:** `src/server.ts:27–62` (WebSocket `open` — no cap on sessions)
- **Description:**
  The server creates a dedicated UDP socket for every incoming WebSocket
  connection and stores the mapping in an unbounded `Map`.  There is no:
  - Maximum number of concurrent sessions.
  - Idle timeout (connections can stay open forever with no traffic).
  - per‑IP connection limit.
  - Message rate limit.
- **Impact:**
  An attacker can open thousands of WebSocket connections, causing the server
  to exhaust file descriptors (one UDP socket + one TCP socket per connection)
  and memory, effectively denying service to legitimate clients.
- **Recommendation:**
  1. Add a `maxSessions` cap (configurable via env var, e.g. `MAX_SESSIONS=256`).
  2. Enforce per‑source‑IP connection limits.
  3. Add an idle timeout — close sessions that have sent no data for N minutes.
  4. Consider a message rate limiter in the `message` handler.

---

### [F-003] WireGuard metadata exposed in plaintext by default

- **Severity:** Medium
- **Location:** `src/shared.ts:25` (`WS_URL` default is `ws://`), `src/server.ts:13`
  (`WS_BIND` with no TLS)
- **Description:**
  The default WebSocket URL is `ws://` (plaintext).  While WireGuard encrypts
  its data plane, the initial handshake messages contain public keys and
  handshake initiators.  An adversary who can observe the WebSocket traffic
  (e.g. on a shared network, or via a compromised upstream router) learns:
  - WireGuard public keys (both client and server).
  - Peer identity and handshake timing (traffic analysis).
  - Encrypted tunnel payload metadata (packet sizes, timing patterns).
- **Impact:**
  Loss of forward secrecy at the tunnel‑transport layer: an attacker who
  records the `ws://` traffic and later compromises the WireGuard private keys
  can correlate handshakes.  More practically, public‑key leakage helps
  fingerprint WireGuard peers and aids targeted attacks.
- **Recommendation:**
  1. Change the default `WS_URL` to `wss://` once TLS support is wired in.
  2. Document strongly that production deployments MUST use `wss://` with a
     valid TLS certificate (or a reverse proxy that terminates TLS).
  3. Add a startup warning when the server is listening without TLS.

---

### [F-004] No origin validation on WebSocket upgrade

- **Severity:** Medium
- **Location:** `src/server.ts:38–45` (`fetch` handler — no `Origin` check)
- **Description:**
  The server does not inspect the `Origin` header before upgrading a
  connection.  A malicious website can make a cross‑origin WebSocket connection
  from a browser to the wg-to-ws server if the server's CORS policy permits it
  (or if the browser does not enforce same‑origin for WebSockets in all
  scenarios).
- **Impact:**
  Low in practice because WireGuard clients are native binaries, not browser
  JavaScript.  However, if an attacker finds another vector (e.g. a XSS‑vulnerable
  page on the same origin as a reverse‑proxy that forwards to wg-to-ws), they
  could tunnel data through the victim's browser origin context.
- **Recommendation:**
  Add an optional `ORIGIN_ALLOWLIST` environment variable.  If set, validate
  that the WebSocket upgrade request's `Origin` header matches.

---

### [F-005] Information disclosure in connection log

- **Severity:** Medium
- **Location:** `src/server.ts:54` (`console.log("New session — WS connected, UDP → ...")`)
- **Description:**
  The server logs the internal WireGuard server address (`config.wgServerAddr`)
  on every successful connection.  If logs are shipped to a central logging
  system or viewed by an unauthorized party, the backend WireGuard server
  address is leaked.
- **Impact:**
  An attacker with read access to logs learns the internal WireGuard server
  endpoint.  Combined with the authentication gap (F-001), this reduces the
  attacker's reconnaissance effort.
- **Recommendation:**
  Log the peer's remote address instead, or use a generic message like
  `"New session established"`.

---

### [F-006] No input validation on forwarded binary data

- **Severity:** Medium
- **Location:** `src/server.ts:57–61` (`message` handler), `src/client.ts:35–42`
  (`ws.onmessage`)
- **Description:**
  Binary data received from either direction is forwarded with no inspection or
  size validation.  While a WireGuard‑specific gateway could theoretically
  benefit from protocol‑aware filtering, the current pass‑through model means
  a compromised or malicious client can inject arbitrary UDP datagrams into the
  WireGuard server's network.
- **Impact:**
  Limited because the UDP destination is hard‑coded to the WireGuard server and
  WireGuard itself drops malformed packets.  However, an attacker could
  potentially exploit buffer‑handling bugs in Bun's UDP stack by sending
  oversized or malformed datagrams.
- **Recommendation:**
  1. Enforce a maximum message size consistent with WireGuard MTU (1420 bytes +
     overhead).  Reject oversized messages.
  2. Optionally, add a sanity check that the message starts with a valid
     WireGuard message type byte (though this ties the code to protocol details).

---

### [F-007] Exponential backoff enables reconnection‑amplification attacks

- **Severity:** Low
- **Location:** `src/client.ts:50–52` (reconnect delay calculation)
- **Description:**
  The client reconnects with exponential backoff (100 ms → 10 s cap).  If the
  server closes connections immediately (e.g. due to a reject policy), the
  client will keep reconnecting at an increasing rate, generating unnecessary
  traffic and load on both the server and client.
- **Impact:**
  An attacker who can spoof TCP RST or trigger WebSocket closure can cause the
  client to generate a sustained reconnect stream.  The impact is low because
  the backoff caps at 10 s, and each reconnect is a single TCP handshake.
- **Recommendation:**
  Add a maximum number of consecutive reconnect attempts before giving up
  (e.g. 20 attempts ≈ 35 min of retrying).

---

### [F-008] Single‑peer client design allows traffic redirection

- **Severity:** Low
- **Location:** `src/client.ts:12–13` (`peerAddr` / `peerPort` globals)
- **Description:**
  The client stores the most recent UDP sender address and routes all WebSocket
  responses back to that single address.  If multiple local processes or peers
  send UDP datagrams to the client's listener, traffic intended for one peer
  could be delivered to the most recent sender.
- **Impact:**
  In a standard single‑client WireGuard setup this is not exploitable.  On a
  multi‑peer or multi‑interface machine (or if an attacker on the same host
  sends a UDP packet to the client's port), responses may be misrouted.
- **Recommendation:**
  Document that only single‑peer mode is supported (already in README) and,
  for multi‑peer setups, maintain a per‑source‑address socket map.

---

### [F-009] Environment variable parsing lacks validation

- **Severity:** Low
- **Location:** `src/shared.ts:20–27` (`loadConfig` function)
- **Description:**
  Port numbers are parsed with `parseInt` but not validated for range
  (0–65535).  Invalid input falls back to the default via `||`.  The
  `WG_SERVER_ADDR` format is not validated beyond splitting on `:`.  No
  validation of hostname formats or IP address syntax.
- **Impact:**
  A misconfigured `WG_SERVER_ADDR` (e.g. `10.0.0.1:abc`) would silently use
  default port 51820.  A port of 0 or 65536+ would produce similarly
  unexpected defaults.  In practice the defaults are safe, but silent fallback
  hides configuration errors.
- **Recommendation:**
  Validate port range after parsing; emit a warning or exit on out‑of‑range
  values.  Validate that `WG_SERVER_ADDR` matches `host:port` format.

---

### [F-010] Default bind to all interfaces on server

- **Severity:** Low
- **Location:** `src/shared.ts:26` (`WS_BIND` defaults to `0.0.0.0:8080`),
  `src/server.ts:34` (`hostname: config.wsBind.split(":")[0] || "0.0.0.0"`)
- **Description:**
  The server binds to `0.0.0.0` (all network interfaces) by default.  This is
  documented and intentional for server deployments, but a user who runs the
  server locally without a firewall may unintentionally expose the WebSocket
  endpoint to the LAN or internet.
- **Impact:**
  Low — the default is appropriate for a public VPS deployment and is clearly
  documented.  Users on a laptop should override `WS_BIND` to `127.0.0.1:8080`.
- **Recommendation:**
  Add a startup log line that shows which interface the server is listening on,
  and optionally warn if binding to `0.0.0.0` without TLS.

---

## Positive observations

- **Zero npm dependencies.**  No risk of malicious or compromised packages in
  the dependency tree.
- **Graceful shutdown.**  Both `SIGINT` and `SIGTERM` are handled, UDP sockets
  are closed, and WebSocket connections are properly terminated.
- **Exponential backoff on reconnection.**  Prevents reconnect storm and self-
  heals transient network failures.
- **Base‑path routing.**  The server only accepts connections under a
  configurable path, which allows co‑location with other services behind a
  reverse proxy.
- **No sensitive data in client logs.**  The client does not log key material,
  packet contents, or internal addresses.
- **UDP socket per session isolation.**  Each WebSocket connection has an
  independent UDP socket; a misbehaving client cannot affect other sessions'
  UDP sockets.

## Conclusion

**Risk level: Medium**

The project is a straightforward, low‑dependency tunnel with a clearly scoped
design.  The two highest‑severity findings — **no authentication** and **no
resource limits** — are inherent to the current "vibecoded" state and are
explicitly acknowledged in the README.  For a personal tunnel behind a
reverse‑proxy that terminates TLS and enforces authentication, the practical
risk is low.  For any multi‑tenant or internet‑facing deployment, the
following should be addressed before production use:

1. Add authentication (shared secret / reverse‑proxy auth / token handshake).
2. Add a connection cap and idle timeout.
3. Enforce TLS (`wss://`) for the transport layer.

With these three changes the tunnel would be suitable for production
single‑tenant use.
