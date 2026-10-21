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
  initialSenderPin,
  updateSenderPin,
  parseChallengeMessage,
  makeAuthResponseMessage,
  isAuthOk,
  PING_INTERVAL,
  AUTH_TIMEOUT,
  MAX_SENDERS,
  MAX_PENDING_QUEUE,
  MAX_FRAME_BYTES,
  MAX_PAYLOAD_BYTES,
  HEADER_BYTES,
  type Config,
  type RekeyState,
} from "./shared";

const config: Config = loadConfig();
const secret = config.sharedKey;
const getKey = (epoch: number) => deriveKey(secret, epoch);

let ws: WebSocket | null = null;
let udpSocket: import("bun").udp.Socket<"buffer"> | null = null;
let reconnectAttempt = 0;
let authed = false;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let authTimer: ReturnType<typeof setTimeout> | null = null;

// M3: Single-peer sender pinning — first sender wins; spoofed sources ignored.
// Tracks UDP senders by source address:port so we can route responses back.
const senders = new Map<string, { addr: string; port: number }>();
let pin = initialSenderPin();
const PIN_TTL_MS = 60_000;

// Buffer outgoing UDP packets until auth completes
let pendingQueue: Array<{ buf: Buffer; port: number; addr: string }> = [];

// H3: Replay/rekey state — receive window (server -> client)
let rx: RekeyState = initialRekeyState();
// Send side (client -> server) with per-packet rotation
let txEpoch = 0;
let txSeq = 0;
let txCount = 0;
let txStartedAt = Date.now();

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
  rx = initialRekeyState();
  txEpoch = 0;
  txSeq = 0;
  txCount = 0;
  txStartedAt = Date.now();
  pendingQueue = [];
  senders.clear();
  pin = initialSenderPin();

  console.log(`Connecting to ${config.wsUrl}...`);
  ws = new WebSocket(config.wsUrl);

  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    console.log("WebSocket connected");

    if (!secret) {
      // No auth mode
      authed = true;
      startPing();
    }
    // With auth: wait for challenge from server
  };

  ws.onmessage = (event: MessageEvent) => {
    const data = event.data;

    // Handle auth handshake
    if (!authed && secret) {
      if (typeof data !== "string") return;

      // C1: Parse challenge from server
      const challenge = parseChallengeMessage(data);
      if (challenge) {
        // Compute HMAC response
        const hmac = computeAuthHmac(getKey(0), challenge);
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
      if (data.length > MAX_FRAME_BYTES) return;
      payload = Buffer.from(data);
    } else {
      const len = (data as ArrayBuffer).byteLength;
      if (len > MAX_FRAME_BYTES) return;
      payload = Buffer.from(data as ArrayBuffer);
    }

    if (secret) {
      // Epoch-keyed decrypt + replay window
      const header = decodeHeader(payload);
      if (!header) return;
      const decrypted = decrypt(payload, getKey(header.epoch));
      if (!decrypted) return;
      const res = acceptFrame(rx, header.epoch, header.seq);
      if (!res.ok) return;
      rx = res.state;
      payload = decrypted;
    } else {
      // No-auth framing: header(8) + plaintext
      if (payload.length < HEADER_BYTES || payload.length > MAX_FRAME_BYTES) return;
      const header = decodeHeader(payload);
      if (!header) return;
      const res = acceptFrame(rx, header.epoch, header.seq);
      if (!res.ok) return;
      rx = res.state;
      payload = payload.subarray(HEADER_BYTES);
    }
    if (payload.length > MAX_PAYLOAD_BYTES) return;

    // Forward to the pinned sender (single-peer)
    if (!udpSocket || !pin.pinned) return;

    const sender = senders.get(pin.pinned);
    if (sender) {
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
  if (buf.length > MAX_PAYLOAD_BYTES) return;
  // Per-packet rotation: new epoch key every N packets or 1h.
  if (shouldRotate(txCount, Date.now() - txStartedAt)) {
    txEpoch++;
    txSeq = 0;
    txCount = 0;
    txStartedAt = Date.now();
  }
  let payload = buf;
  if (secret) {
    try {
      const epoch = txEpoch;
      const seq = txSeq++;
      txCount++;
      payload = encrypt(payload, getKey(epoch), epoch, seq);
    } catch {
      return;
    }
  } else {
    const epoch = txEpoch;
    const seq = txSeq++;
    txCount++;
    payload = Buffer.concat([encodeHeader(epoch, seq), payload]);
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

        // M3: Pin first sender; ignore spoofed sources. Re-pin after TTL
        // or when pinned entry was evicted, so a legit peer change recovers.
        const now = Date.now();
        const decided = updateSenderPin(pin, senders.has(pin.pinned ?? ""), key, now, PIN_TTL_MS);
        pin = decided.state;
        if (!decided.accepted) return;
        if (!senders.has(key) && senders.size >= MAX_SENDERS) {
          // Evict the oldest entry (first inserted)
          const oldestKey = senders.keys().next().value;
          if (oldestKey !== undefined && oldestKey !== pin.pinned) senders.delete(oldestKey);
        }
        senders.set(key, { addr, port });

        const rawBuf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        if (rawBuf.length > MAX_PAYLOAD_BYTES) return;

        if (!authed && secret) {
          if (pendingQueue.length >= MAX_PENDING_QUEUE) pendingQueue.shift();
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
