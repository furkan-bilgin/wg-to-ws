import type { ServerWebSocket } from "bun";
import {
  loadConfig,
  deriveKey,
  encrypt,
  decrypt,
  parseAuthMessage,
  AUTH_OK,
  type Config,
} from "./shared";

const config: Config = loadConfig();
const basePath = config.wsBasePath;
const encKey = config.sharedKey ? deriveKey(config.sharedKey) : null;

interface Session {
  udp: import("bun").udp.ConnectedSocket<"buffer">;
  addr: string;
  authed: boolean;
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

          // Encrypt if shared key is configured
          if (encKey) {
            try {
              payload = encrypt(payload, encKey);
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

function sendAuthFail(ws: ServerWebSocket) {
  ws.close(4001, "AUTH:FAIL");
}

const server = Bun.serve({
  port: parseInt(config.wsBind.split(":")[1] || "8080", 10),
  hostname: config.wsBind.split(":")[0] || "0.0.0.0",
  fetch(req, server) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(basePath)) {
      return new Response("Not found", { status: 404 });
    }
    const success = server.upgrade(req);
    if (success) return undefined;
    return new Response("Upgrade failed", { status: 400 });
  },
  websocket: {
    async open(ws) {
      const udp = await createUdpSocket(ws, config.wgServerAddr);
      if (!udp) {
        ws.close(1011, "Failed to create UDP socket");
        return;
      }

      const session: Session = { udp, addr: config.wgServerAddr, authed: !encKey };
      sessions.set(ws, session);

      if (!encKey) {
        console.log(`New session — WS connected, UDP → ${config.wgServerAddr}`);
      }
      // If encKey is set, we wait for auth message before logging
    },

    message(ws, raw) {
      const session = sessions.get(ws);
      if (!session) return;

      const data = typeof raw === "string" ? Buffer.from(raw) : (raw as Buffer);

      // Handle auth handshake
      if (!session.authed && encKey) {
        const msg = typeof raw === "string" ? raw : raw.toString();
        const key = parseAuthMessage(msg);
        if (key === config.sharedKey) {
          session.authed = true;
          ws.sendText(AUTH_OK);
          console.log(`New session — WS connected, UDP → ${config.wgServerAddr}`);
        } else {
          sendAuthFail(ws);
        }
        return;
      }

      // Decrypt if shared key is configured
      let payload = data;
      if (encKey) {
        try {
          payload = decrypt(data, encKey);
        } catch {
          return; // drop malformed messages
        }
      }

      session.udp.send(payload);
    },

    close(ws) {
      const session = sessions.get(ws);
      if (session) {
        session.udp.close();
        sessions.delete(ws);
        console.log("Session closed");
      }
    },
  },
});

console.log(`Server listening on ${config.wsBind}, base path "${basePath}"`);

function shutdown() {
  console.log("\nShutting down...");
  for (const [ws, session] of sessions) {
    session.udp.close();
    ws.close(1001, "Server shutting down");
  }
  server.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
