import {
  loadConfig,
  deriveKey,
  encrypt,
  decrypt,
  makeAuthMessage,
  isAuthOk,
  type Config,
} from "./shared";

const config: Config = loadConfig();
const encKey = config.sharedKey ? deriveKey(config.sharedKey) : null;

let ws: WebSocket | null = null;
let udpSocket: import("bun").udp.Socket<"buffer"> | null = null;
let peerAddr = "";
let peerPort = 0;
let reconnectAttempt = 0;
let authed = false;

// Buffer outgoing UDP packets until auth completes
let pendingQueue: Array<{ buf: Buffer; port: number; addr: string }> = [];

// ── WebSocket connection with exponential backoff ──────────────

function connectWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  authed = false;
  pendingQueue = [];

  console.log(`Connecting to ${config.wsUrl}...`);
  ws = new WebSocket(config.wsUrl);

  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log("WebSocket connected");

    // Send auth if shared key is configured
    if (encKey) {
      ws!.send(makeAuthMessage(config.sharedKey));
    } else {
      authed = true;
    }
  };

  ws.onmessage = (event: MessageEvent) => {
    const data = event.data;

    // Handle auth response
    if (!authed && encKey && typeof data === "string") {
      if (isAuthOk(data)) {
        authed = true;
        console.log("Authenticated");
        // Flush queued packets
        for (const p of pendingQueue) {
          sendEncrypted(p.buf);
        }
        pendingQueue = [];
      } else {
        console.error("Authentication failed");
        ws?.close();
      }
      return;
    }

    // Decrypt incoming data
    let payload: Buffer;
    if (typeof data === "string") {
      payload = Buffer.from(data);
    } else {
      payload = Buffer.from(data as ArrayBuffer);
    }

    if (encKey) {
      try {
        payload = decrypt(payload, encKey);
      } catch {
        return; // drop malformed
      }
    }

    // Forward to local WireGuard client
    if (udpSocket && peerPort) {
      udpSocket.send(payload, peerPort, peerAddr);
    }
  };

  ws.onclose = () => {
    console.log("WebSocket disconnected — reconnecting...");
    ws = null;
    authed = false;
    pendingQueue = [];
    const delay = Math.min(100 * Math.pow(2, reconnectAttempt), 10_000);
    reconnectAttempt++;
    setTimeout(connectWs, delay);
  };

  ws.onerror = () => {
    ws?.close();
  };
}

// ── Encrypt and send via WebSocket ────────────────────────────

function sendEncrypted(buf: Buffer) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  let payload = buf;
  if (encKey) {
    try {
      payload = encrypt(payload, encKey);
    } catch {
      return;
    }
  }

  ws.send(payload as unknown as ArrayBuffer);
}

// ── UDP listener ───────────────────────────────────────────────

async function startUdp() {
  udpSocket = await Bun.udpSocket({
    hostname: config.localAddr,
    port: config.localPort,
    socket: {
      data(_socket, buf, port, addr) {
        peerAddr = addr;
        peerPort = port;

        const rawBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

        if (!authed && encKey) {
          pendingQueue.push({ buf: rawBuf, port, addr });
        } else {
          sendEncrypted(rawBuf);
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
