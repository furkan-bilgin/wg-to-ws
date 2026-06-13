import crypto from "crypto";
import type { ServerWebSocket } from "bun";
import {
  loadConfig,
  deriveKey,
  computeAuthHmac,
  encrypt,
  decrypt,
  encodeSeqNum,
  decodeSeqNum,
  makeChallengeMessage,
  parseAuthResponseMessage,
  PING_INTERVAL,
  AUTH_TIMEOUT,
  MAX_AUTH_ATTEMPTS,
  AUTH_WINDOW_MS,
  BAN_DURATION_MS,
  SEQ_NUM_BYTES,
  type Config,
} from "./shared";

const config: Config = loadConfig();
const basePath = config.wsBasePath;
const encKey = config.sharedKey ? deriveKey(config.sharedKey) : null;

// ── Rate limiting state ───────────────────────────────────────

interface AuthRecord {
  count: number;
  firstAttempt: number;
  banUntil: number;
}

const authFailures = new Map<string, AuthRecord>();

function checkRateLimit(ip: string): boolean {
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
  const now = Date.now();
  let rec = authFailures.get(ip);

  if (!rec || now - rec.firstAttempt > AUTH_WINDOW_MS) {
    rec = { count: 1, firstAttempt: now, banUntil: 0 };
    authFailures.set(ip, rec);
    return true;
  }

  rec.count++;
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
  // Replay protection: last received sequence number (client→server)
  lastSeqReceived: number;
  // Send counter (server→client)
  sendCounter: number;
}

const sessions = new Map<ServerWebSocket, Session>();

async function createUdpSocket(
  ws: ServerWebSocket,
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

          let payload = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

          if (encKey) {
            try {
              const seqBuf = encodeSeqNum(session.sendCounter);
              session.sendCounter++;
              payload = encrypt(payload, encKey, seqBuf);
            } catch {
              return;
            }
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

function startPing(ws: ServerWebSocket) {
  return setInterval(() => {
    if (ws.readyState === 1) ws.sendText("PING");
  }, PING_INTERVAL);
}

// ── Auth challenge timer ──────────────────────────────────────

function startAuthTimer(ws: ServerWebSocket, session: Session) {
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

const server = Bun.serve({
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

    // M2: Cap max connections
    if (sessions.size >= config.maxConnections) {
      return new Response("Server at capacity", { status: 503 });
    }

    const success = server.upgrade(req);
    if (success) return undefined;
    return new Response("Upgrade failed", { status: 400 });
  },
  websocket: {
    async open(ws) {
      // Get client IP
      const clientIp =
        ws.remoteAddress || "unknown";

      // C2: Rate limiting check
      if (!checkRateLimit(clientIp)) {
        ws.close(4001, "AUTH:BANNED");
        return;
      }

      // H4: Don't allocate UDP yet — defer until after auth
      const session: Session = {
        udp: null,
        addr: config.wgServerAddr,
        authed: !encKey,
        authNonce: null,
        authTimer: null,
        pingTimer: null,
        clientIp,
        lastSeqReceived: -1,
        sendCounter: 0,
      };

      if (encKey) {
        // C1: Send challenge to client
        session.authNonce = crypto.randomBytes(32);
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

      sessions.set(ws, session);
    },

    message(ws, raw) {
      const session = sessions.get(ws);
      if (!session) return;

      const data =
        typeof raw === "string" ? Buffer.from(raw) : (raw as Buffer);

      // Handle ping from client — respond with pong
      if (typeof raw === "string" && raw === "PING") {
        ws.sendText("PONG");
        return;
      }
      // Handle pong from client — no-op
      if (typeof raw === "string" && raw === "PONG") return;

      // C1: Handle auth handshake
      if (!session.authed && encKey) {
        const msg = typeof raw === "string" ? raw : raw.toString();

        // Parse auth response: AUTH:<base64(hmac)>
        const clientHmac = parseAuthResponseMessage(msg);
        if (!clientHmac || !session.authNonce) {
          ws.close(4001, "AUTH:FAIL");
          return;
        }

        // Compute expected HMAC and compare in constant time
        const expectedHmac = computeAuthHmac(encKey, session.authNonce);

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

      if (encKey) {
        // H3: Decrypt and verify sequence number (replay protection)
        const decrypted = decrypt(data, encKey);
        if (!decrypted) return;

        // Extract and verify sequence number
        const seqBuf = data.subarray(0, SEQ_NUM_BYTES);
        const seqNum = decodeSeqNum(seqBuf);
        if (seqNum <= session.lastSeqReceived) {
          // Replay or out-of-order — drop
          return;
        }
        session.lastSeqReceived = seqNum;

        payload = decrypted;
      }

      session.udp.send(payload);
    },

    close(ws) {
      const session = sessions.get(ws);
      if (session) {
        cleanupSession(session);
        sessions.delete(ws);
        console.log(`Session closed — ${session.clientIp}`);
      }
    },
  },
});

console.log(
  `Server listening on ${config.wsBind}, base path "${basePath}"` +
    (encKey ? ", auth enabled" : ", NO AUTH — open relay"),
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
