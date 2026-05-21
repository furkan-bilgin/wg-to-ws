import { loadConfig, type Config } from "./shared";

const config: Config = loadConfig();

let ws: WebSocket | null = null;
let udpSocket: import("bun").udp.Socket<"buffer"> | null = null;
// Track the last sender (address + port) so we can route responses back
let peerAddr = "";
let peerPort = 0;
let reconnectAttempt = 0;

// ── WebSocket connection with exponential backoff ──────────────

function connectWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  console.log(`Connecting to ${config.wsUrl}...`);
  ws = new WebSocket(config.wsUrl);

  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log("WebSocket connected");
    reconnectAttempt = 0;
  };

  ws.onmessage = (event: MessageEvent) => {
    // Forward binary data from WebSocket back to the local WireGuard client via UDP
    if (!udpSocket || !peerPort) return;

    const data = event.data;
    if (typeof data === "string") {
      udpSocket.send(Buffer.from(data), peerPort, peerAddr);
    } else {
      udpSocket.send(new Uint8Array(data as ArrayBuffer), peerPort, peerAddr);
    }
  };

  ws.onclose = () => {
    console.log("WebSocket disconnected — reconnecting...");
    ws = null;
    // Exponential backoff: 100ms -> 200ms -> 400ms -> ... -> 10s cap
    const delay = Math.min(100 * Math.pow(2, reconnectAttempt), 10_000);
    reconnectAttempt++;
    setTimeout(connectWs, delay);
  };

  ws.onerror = () => {
    ws?.close();
  };
}

// ── UDP listener ───────────────────────────────────────────────

async function startUdp() {
  udpSocket = await Bun.udpSocket({
    hostname: config.localAddr,
    port: config.localPort,
    socket: {
      data(_socket, buf, port, addr) {
        // Remember where this packet came from so we can send responses back
        peerAddr = addr;
        peerPort = port;

        // Forward to WebSocket
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(buf as unknown as ArrayBuffer);
        }
      },
      error(_socket, err) {
        console.error("UDP error:", err);
      },
    },
  });

  console.log(`Listening on UDP ${config.localAddr}:${config.localPort}`);
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  await startUdp();
  connectWs();

  // Graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down...");
    ws?.close();
    udpSocket?.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
