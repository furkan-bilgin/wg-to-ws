import {
  loadConfig,
  deriveKey,
  computeAuthHmac,
  encrypt,
  decrypt,
  encodeSeqNum,
  decodeSeqNum,
  parseChallengeMessage,
  makeAuthResponseMessage,
  isAuthOk,
  PING_INTERVAL,
  AUTH_TIMEOUT,
  MAX_SENDERS,
  SEQ_NUM_BYTES,
  type Config,
} from "./shared";

const config: Config = loadConfig();
const encKey = config.sharedKey ? deriveKey(config.sharedKey) : null;

let ws: WebSocket | null = null;
let udpSocket: import("bun").udp.Socket<"buffer"> | null = null;
let reconnectAttempt = 0;
let authed = false;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let authTimer: ReturnType<typeof setTimeout> | null = null;

// M3: Bounded sender map — LRU-style, caps at MAX_SENDERS entries.
// Tracks UDP senders by source address:port so we can route responses back.
const senders = new Map<string, { addr: string; port: number }>();

// Buffer outgoing UDP packets until auth completes
let pendingQueue: Array<{ buf: Buffer; port: number; addr: string }> = [];

// H3: Replay protection — last received sequence number (server -> client)
let lastSeqReceived = -1;
// Send counter (client -> server)
let sendCounter = 0;

// ── WebSocket connection with exponential backoff ──────────────

function connectWs() {
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  authed = false;
  lastSeqReceived = -1;
  sendCounter = 0;
  pendingQueue = [];
  senders.clear();

  console.log(`Connecting to ${config.wsUrl}...`);
  ws = new WebSocket(config.wsUrl);

  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log("WebSocket connected");

    if (!encKey) {
      // No auth mode
      authed = true;
      startPing();
    }
    // With auth: wait for challenge from server
  };

  ws.onmessage = (event: MessageEvent) => {
    const data = event.data;

    // Handle auth handshake
    if (!authed && encKey) {
      if (typeof data !== "string") return;

      // C1: Parse challenge from server
      const challenge = parseChallengeMessage(data);
      if (challenge) {
        // Compute HMAC response
        const hmac = computeAuthHmac(encKey, challenge);
        ws!.send(makeAuthResponseMessage(hmac));

        // Set auth timeout
        if (authTimer) clearTimeout(authTimer);
        authTimer = setTimeout(() => {
          if (!authed) {
            console.error("Auth handshake timed out");
            ws?.close();
          }
        }, AUTH_TIMEOUT);
        return;
      }

      // C1: Parse auth OK
      if (isAuthOk(data)) {
        authed = true;
        if (authTimer) clearTimeout(authTimer);
        authTimer = null;
        console.log("Authenticated");
        startPing();

        // Flush buffered UDP packets
        for (const p of pendingQueue) sendUdpPayload(p.buf);
        pendingQueue = [];
        return;
      }

      console.error("Authentication failed");
      ws?.close();
      return;
    }

    // Handle pong from server (keepalive)
    if (typeof data === "string" && data === "PONG") return;
    if (typeof data === "string" && data === "PING") {
      ws?.send("PONG");
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
      // H3: Decrypt and verify sequence number
      const decrypted = decrypt(payload, encKey);
      if (!decrypted) return;

      // Extract and verify sequence number (replay protection)
      const seqBuf = payload.subarray(0, SEQ_NUM_BYTES);
      const seqNum = decodeSeqNum(seqBuf);
      if (seqNum <= lastSeqReceived) {
        // Replay or out-of-order — drop
        return;
      }
      lastSeqReceived = seqNum;

      payload = decrypted;
    }

    // Forward to the most recent sender
    if (!udpSocket || senders.size === 0) return;

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
    if (authTimer) clearTimeout(authTimer);
    authTimer = null;
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

// ── WebSocket ping/pong ───────────────────────────────────────

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send("PING");
  }, PING_INTERVAL);
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

// ── Encrypt and send via WebSocket ────────────────────────────

function sendUdpPayload(buf: Buffer) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  let payload = buf;
  if (encKey) {
    try {
      const seqBuf = encodeSeqNum(sendCounter);
      sendCounter++;
      payload = encrypt(payload, encKey, seqBuf);
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
        const key = `${addr}:${port}`;

        // M3: Bounded sender map — maintain most recent sender, cap size
        if (!senders.has(key) && senders.size >= MAX_SENDERS) {
          // Evict the oldest entry (first inserted)
          const oldestKey = senders.keys().next().value;
          if (oldestKey !== undefined) senders.delete(oldestKey);
        }
        senders.set(key, { addr, port });

        const rawBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

        if (!authed && encKey) {
          pendingQueue.push({ buf: rawBuf, port, addr });
        } else {
          sendUdpPayload(rawBuf);
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
    if (authTimer) clearTimeout(authTimer);
    ws?.close();
    udpSocket?.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
