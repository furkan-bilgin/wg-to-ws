import type { ServerWebSocket } from "bun";
import { loadConfig, type Config } from "./shared";

const config: Config = loadConfig();
const basePath = config.wsBasePath;

// Map from ServerWebSocket to its dedicated UDP connected-socket
const sessions = new Map<
  ServerWebSocket,
  { udp: import("bun").udp.ConnectedSocket<"buffer">; addr: string }
>();

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
          // Forward UDP response back to the WebSocket client
          if (ws.readyState === 1) {
            // OPEN
            ws.sendBinary(buf as Buffer);
          }
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

const server = Bun.serve({
  port: parseInt(config.wsBind.split(":")[1] || "8080", 10),
  hostname: config.wsBind.split(":")[0] || "0.0.0.0",
  fetch(req, server) {
    const url = new URL(req.url);

    // Base-path check: the pathname must start with basePath
    if (!url.pathname.startsWith(basePath)) {
      return new Response("Not found", { status: 404 });
    }

    // Upgrade to WebSocket
    const success = server.upgrade(req);
    if (success) {
      return undefined;
    }

    return new Response("Upgrade failed", { status: 400 });
  },
  websocket: {
    async open(ws) {
      const udp = await createUdpSocket(ws, config.wgServerAddr);
      if (!udp) {
        ws.close(1011, "Failed to create UDP socket");
        return;
      }
      sessions.set(ws, { udp, addr: config.wgServerAddr });
      console.log(`New session — WS connected, UDP → ${config.wgServerAddr}`);
    },

    message(ws, raw) {
      const session = sessions.get(ws);
      if (!session) return;

      // Forward binary data to WireGuard via UDP
      const data = typeof raw === "string" ? Buffer.from(raw) : raw;
      session.udp.send(data);
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

// Graceful shutdown
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
