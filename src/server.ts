import crypto from "crypto";
import type { ServerWebSocket } from "bun";
import {
  loadConfig,
  deriveKey,
  computeAuthHmac,
  encrypt,
  decrypt,
  encodeHeader,
  decodeHeader,
  acceptFrame,
  shouldRotate,
  initialRekeyState,
  normalizeIp,
  forwardedClientIp,
  makeChallengeMessage,
  parseAuthResponseMessage,
  PING_INTERVAL,
  AUTH_TIMEOUT,
  MAX_AUTH_ATTEMPTS,
  AUTH_WINDOW_MS,
  BAN_DURATION_MS,
  HEADER_BYTES,
  MAX_FRAME_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_CONN_PER_IP,
  CHALLENGE_BYTES,
  type Config,
  type RekeyState,
} from "./shared";

interface WsData {
  clientIp: string;
}

type ServerWS = ServerWebSocket<WsData>;

const config: Config = loadConfig();
const basePath = config.wsBasePath;
const secret = config.sharedKey;
const getKey = (epoch: number) => deriveKey(secret, epoch);

// ── Rate limiting state ───────────────────────────────────────

interface AuthRecord {
  count: number;
  firstAttempt: number;
  banUntil: number;
}

const authFailures = new Map<string, AuthRecord>();

function checkRateLimit(ip: string): boolean {
  ip = normalizeIp(ip);
  const now = Date.now();
  const rec = authFailures.get(ip);

  // Check if currently banned
  if (rec && rec.banUntil > now) {
    return false; // banned
  }

  // Clear expired records
  if (rec && now - rec.firstAttempt > AUTH_WINDOW_MS) {
    authFailures.delete(ip);
    return true;
  }

  return true;
}

function recordAuthFailure(ip: string): boolean {
  ip = normalizeIp(ip);
  const now = Date.now();
  let rec = authFailures.get(ip);

  if (!rec || now - rec.firstAttempt > AUTH_WINDOW_MS) {
    rec = { count: 1, firstAttempt: now, banUntil: 0 };
    authFailures.set(ip, rec);
    return true;
  }

  rec.count++;
  if (authFailures.size > 10000) {
    const oldest = authFailures.keys().next().value;
    if (oldest) authFailures.delete(oldest);
  }
  if (rec.count >= MAX_AUTH_ATTEMPTS) {
    rec.banUntil = now + BAN_DURATION_MS;
    console.warn(`Rate limit: banned ${ip} for ${BAN_DURATION_MS / 1000}s`);
    return false;
  }

  return true;
}

// ── Periodic cleanup of expired rate-limit records ────────────

setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of authFailures) {
    if (now > rec.banUntil && now - rec.firstAttempt > AUTH_WINDOW_MS * 2) {
      authFailures.delete(ip);
    }
  }
}, 60_000);

// ── Session management ────────────────────────────────────────

interface Session {
  udp: import("bun").udp.ConnectedSocket<"buffer"> | null;
  addr: string;
  authed: boolean;
  authNonce: Buffer | null;
  authTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  clientIp: string;
  // Replay/rekey state: receive window (client→server)
  rx: RekeyState;
  // Send side (server→client) with per-packet rotation
  txEpoch: number;
  txSeq: number;
  txCount: number;
  txStartedAt: number;
}

const sessions = new Map<ServerWS, Session>();
const connPerIp = new Map<string, number>();

function incConn(ip: string): number {
  const n = (connPerIp.get(ip) || 0) + 1;
  connPerIp.set(ip, n);
  return n;
}
function decConn(ip: string): void {
  const n = (connPerIp.get(ip) || 0) - 1;
  if (n <= 0) connPerIp.delete(ip);
  else connPerIp.set(ip, n);
}

async function createUdpSocket(
  ws: ServerWS,
  remoteAddr: string,
): Promise<import("bun").udp.ConnectedSocket<"buffer"> | null> {
  const [host, portStr] = remoteAddr.split(":");
  const port = parseInt(portStr, 10) || 51820;

  try {
    const udp = await Bun.udpSocket({
      connect: { hostname: host, port },
      socket: {
        data(_socket, buf) {
          const session = sessions.get(ws);
          if (!session || !session.authed) return;
          // Per-packet rotation: new epoch key every N packets or 1h.
          if (shouldRotate(session.txCount, Date.now() - session.txStartedAt)) {
            session.txEpoch++;
            session.txSeq = 0;
            session.txCount = 0;
            session.txStartedAt = Date.now();
          }

          let payload = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

          if (secret) {
            try {
              if (payload.length > MAX_PAYLOAD_BYTES) return;
              const epoch = session.txEpoch;
              const seq = session.txSeq++;
              session.txCount++;
              payload = encrypt(payload, getKey(epoch), epoch, seq);
            } catch {
              return;
            }
          } else {
            if (payload.length > MAX_PAYLOAD_BYTES) return;
            const epoch = session.txEpoch;
            const seq = session.txSeq++;
            session.txCount++;
            payload = Buffer.concat([encodeHeader(epoch, seq), payload]);
          }

          if (ws.readyState === 1) ws.sendBinary(payload as Buffer);
        },
        error(_socket, err) {
          console.error("UDP error:", err);
        },
      },
    });
    return udp;
  } catch (err) {
    console.error("Failed to create UDP socket:", err);
    return null;
  }
}

function startPing(ws: ServerWS) {
  return setInterval(() => {
    if (ws.readyState === 1) ws.sendText("PING");
  }, PING_INTERVAL);
}

// ── Auth challenge timer ──────────────────────────────────────

function startAuthTimer(ws: ServerWS, session: Session) {
  session.authTimer = setTimeout(() => {
    if (!session.authed) {
      console.warn(
        `Auth timeout for ${session.clientIp} — closing`,
      );
      ws.close(4001, "AUTH:TIMEOUT");
    }
  }, AUTH_TIMEOUT);
}

function cleanupSession(session: Session) {
  if (session.authTimer) clearTimeout(session.authTimer);
  if (session.pingTimer) clearInterval(session.pingTimer);
  if (session.udp) session.udp.close();
}

// ── HTTP / WebSocket server ───────────────────────────────────

const server = Bun.serve<WsData>({
  port: parseInt(config.wsBind.split(":")[1] || "8080", 10),
  hostname: config.wsBind.split(":")[0] || "127.0.0.1",
  fetch(req, server) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(basePath)) {
      return new Response("Not found", { status: 404 });
    }

    // L2: Optional Origin header validation
    if (config.allowOrigin) {
      const origin = req.headers.get("Origin") || "";
      if (origin && origin !== config.allowOrigin) {
        return new Response("Origin not allowed", { status: 403 });
      }
    }

    // M2: Cap max connections (global + per-IP, normalized)
    const peerIp = normalizeIp(server.requestIP(req)?.address || "unknown");
    const clientIp = config.trustProxy
      ? forwardedClientIp(req.headers.get("x-forwarded-for")) ?? peerIp
      : peerIp;
    if (
      sessions.size >= config.maxConnections ||
      (connPerIp.get(clientIp) || 0) >= Math.min(MAX_CONN_PER_IP, config.maxConnections)
    ) {
      return new Response("Server at capacity", { status: 503 });
    }

    const success = server.upgrade(req, { data: { clientIp } });
    if (success) return undefined;
    return new Response("Upgrade failed", { status: 400 });
  },
  websocket: {
    async open(ws) {
      // Resolved in fetch: peer address, or X-Forwarded-For when --trust-proxy is set
      const clientIp = ws.data.clientIp;
      if (sessions.size >= config.maxConnections) {
        ws.close(1013, "SERVER:FULL");
        return;
      }
      if ((connPerIp.get(clientIp) || 0) >= Math.min(MAX_CONN_PER_IP, config.maxConnections)) {
        ws.close(1013, "SERVER:FULL");
        return;
      }
      // C2: Rate limiting check (before accounting so rejects never leak the counter)
      if (!checkRateLimit(clientIp)) {
        ws.close(4001, "AUTH:BANNED");
        return;
      }

      // H4: Don't allocate UDP yet — defer until after auth
      const session: Session = {
        udp: null,
        addr: config.wgServerAddr,
        authed: !secret,
        authNonce: null,
        authTimer: null,
        pingTimer: null,
        clientIp,
        rx: initialRekeyState(),
        txEpoch: 0,
        txSeq: 0,
        txCount: 0,
        txStartedAt: Date.now(),
      };

      // Register before any await: every close path must release the slot.
      sessions.set(ws, session);
      incConn(clientIp);

      if (secret) {
        // C1: Send challenge to client
        session.authNonce = crypto.randomBytes(CHALLENGE_BYTES);
        ws.sendText(makeChallengeMessage(session.authNonce));
        startAuthTimer(ws, session);
      } else {
        // No auth — immediately mark as authenticated
        session.authed = true;
        session.udp = await createUdpSocket(ws, config.wgServerAddr);
        if (!session.udp) {
          ws.close(1011, "Failed to create UDP socket");
          return;
        }
        session.pingTimer = startPing(ws);
        console.log(
          `New session — ${clientIp} connected (no auth), UDP → ${config.wgServerAddr}`,
        );
      }
    },

    message(ws, raw) {
      const session = sessions.get(ws);
      if (!session) return;

      // Drop oversize frames early (large-frame DoS guard).
      const frameLen = typeof raw === "string" ? raw.length : (raw as Buffer).length;
      if (frameLen > MAX_FRAME_BYTES) {
        recordAuthFailure(session.clientIp);
        ws.close(1009, "FRAME:TOO-LARGE");
        return;
      }

      const data =
        typeof raw === "string" ? Buffer.from(raw) : (raw as Buffer);

      // Pre-auth: ignore PING/PONG (no unauthenticated keepalive oracle).
      if (!session.authed && secret) {
        if (typeof raw === "string" && (raw === "PING" || raw === "PONG")) return;
      } else {
        // Handle ping from client — respond with pong
        if (typeof raw === "string" && raw === "PING") {
          ws.sendText("PONG");
          return;
        }
        // Handle pong from client — no-op
        if (typeof raw === "string" && raw === "PONG") return;
      }

      // C1: Handle auth handshake
      if (!session.authed && secret) {
        const msg = typeof raw === "string" ? raw : raw.toString();

        // Parse auth response: AUTH:<base64(hmac)>
        const clientHmac = parseAuthResponseMessage(msg);
        if (!clientHmac || !session.authNonce) {
          recordAuthFailure(session.clientIp);
          ws.close(4001, "AUTH:FAIL");
          return;
        }

        // Compute expected HMAC and compare in constant time
        const expectedHmac = computeAuthHmac(getKey(0), session.authNonce);

        if (
          clientHmac.length === expectedHmac.length &&
          crypto.timingSafeEqual(clientHmac, expectedHmac)
        ) {
          // Auth success
          session.authed = true;
          if (session.authTimer) clearTimeout(session.authTimer);
          session.authTimer = null;

          // H4: Create UDP socket now that client is authenticated
          createUdpSocket(ws, config.wgServerAddr).then((udp) => {
            if (!udp) {
              ws.close(1011, "Failed to create UDP socket");
              return;
            }
            session.udp = udp;

            // Start ping keepalive
            session.pingTimer = startPing(ws);

            ws.sendText("AUTH:OK");
            console.log(
              `New session — ${session.clientIp} authenticated, UDP → ${config.wgServerAddr}`,
            );
          });
        } else {
          // Auth failure
          recordAuthFailure(session.clientIp);
          ws.close(4001, "AUTH:FAIL");
        }
        return;
      }

      // After auth — handle data forwarding
      if (!session.authed || !session.udp) return;

      let payload = data;

      if (secret) {
        // Epoch-keyed decrypt + replay window
        const header = decodeHeader(data);
        if (!header) return;
        const decrypted = decrypt(data, getKey(header.epoch));
        if (!decrypted) return;
        const res = acceptFrame(session.rx, header.epoch, header.seq);
        if (!res.ok) return;
        session.rx = res.state;

        payload = decrypted;
        if (payload.length > MAX_PAYLOAD_BYTES) return;
      } else {
        // No-auth framing: header(8) + plaintext
        if (data.length < HEADER_BYTES || data.length > MAX_FRAME_BYTES) return;
        const header = decodeHeader(data);
        if (!header) return;
        const res = acceptFrame(session.rx, header.epoch, header.seq);
        if (!res.ok) return;
        session.rx = res.state;
        payload = data.subarray(HEADER_BYTES);
        if (payload.length > MAX_PAYLOAD_BYTES) return;
      }

      if (!session.udp) return;
      session.udp.send(payload);
    },

    close(ws) {
      const session = sessions.get(ws);
      if (session) {
        cleanupSession(session);
        sessions.delete(ws);
        decConn(session.clientIp);
        console.log(`Session closed — ${session.clientIp}`);
      }
    },
  },
});

console.log(
  `Server listening on ${config.wsBind}, base path "${basePath}"` +
    (secret ? ", auth enabled" : ", NO AUTH — open relay"),
);

// ── Graceful shutdown ─────────────────────────────────────────

function shutdown() {
  console.log("\nShutting down...");
  for (const [ws, session] of sessions) {
    cleanupSession(session);
    ws.close(1001, "Server shutting down");
  }
  server.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
