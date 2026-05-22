import {
  loadConfig,
  deriveKey,
  encrypt,
  decrypt,
  makeAuthMessage,
  isAuthOk,
  PING_INTERVAL,
  type Config,
} from "./shared";

const config: Config = loadConfig();
const encKey = config.sharedKey ? deriveKey(config.sharedKey) : null;

let ws: WebSocket | null = null;
let udpSocket: import("bun").udp.Socket<"buffer"> | null = null;
let reconnectAttempt = 0;
let authed = false;
let pingTimer: ReturnType<typeof setInterval> | null = null;

// Track UDP senders by source address:port so we can route responses back correctly,
// even if the WireGuard client changes ports mid-session.
const senders = new Map<string, { addr: string; port: number }>();

// Buffer outgoing UDP packets until auth completes
let pendingQueue: Array<{ buf: Buffer; port: number; addr: string }> = [];

// ── WebSocket connection with exponential backoff ──────────────

function connectWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  authed = false;
  pendingQueue = [];
  senders.clear();

  console.log(`Connecting to ${config.wsUrl}...`);
  ws = new WebSocket(config.wsUrl);

  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log("WebSocket connected");
    startPing();

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
        for (const p of pendingQueue) sendEncrypted(p.buf);
        pendingQueue = [];
      } else {
        console.error("Authentication failed");
        ws?.close();
      }
      return;
    }

    // Handle pong from server (no-op, just a keepalive)
    if (typeof data === "string" && data === "PONG") return;

    // Decrypt incoming data
    let payload: Buffer;
    if (typeof data === "string") {
      payload = Buffer.from(data);
    } else {
      payload = Buffer.from(data as ArrayBuffer);
    }

    if (encKey) {
      try { payload = decrypt(payload, encKey); } catch { return; }
    }

    // Forward to the most recent sender
    if (!udpSocket || senders.size === 0) return;

    // Try the most recently seen sender first
    const entries = [...senders.entries()];
    const last = entries[entries.length - 1];
    if (last) {
      const [, sender] = last;
      udpSocket.send(payload, sender.port, sender.addr);
    }
  };

  ws.onclose = () => {
    console.log("WebSocket disconnected — reconnecting...");
    stopPing();
    ws = null;
    authed = false;
    pendingQueue = [];
    const delay = Math.min(100 * Math.pow(2, reconnectAttempt), 10_000);
    reconnectAttempt++;
    setTimeout(connectWs, delay);
  };

  ws.onerror = () => { ws?.close(); };
}

// ── WebSocket ping/pong ───────────────────────────────────────

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send("PING");
  }, PING_INTERVAL);
}

function stopPing() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

// ── Encrypt and send via WebSocket ────────────────────────────

function sendEncrypted(buf: Buffer) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  let payload = buf;
  if (encKey) { try { payload = encrypt(payload, encKey); } catch { return; } }
  ws.send(payload as unknown as ArrayBuffer);
}

// ── UDP listener ───────────────────────────────────────────────

async function startUdp() {
  udpSocket = await Bun.udpSocket({
    hostname: config.localAddr,
    port: config.localPort,
    socket: {
      data(_socket, buf, port, addr) {
        const key = `${addr}:${port}`;
        senders.set(key, { addr, port });

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
    stopPing();
    ws?.close();
    udpSocket?.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
