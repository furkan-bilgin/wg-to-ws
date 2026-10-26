import crypto from "crypto";
import { isIP } from "node:net";

export type Mode = "client" | "server";

export interface Config {
  mode: Mode;
  localAddr: string;
  localPort: number;
  wgServerAddr: string;
  wsUrl: string;
  wsBind: string;
  wsBasePath: string;
  sharedKey: string;
  noAuth: boolean;
  noBan: boolean;
  maxConnections: number;
  trustProxy: boolean;
  allowOrigin: string;
}

/** WebSocket ping interval in ms. */
export const PING_INTERVAL = 25_000;

/** Maximum time (ms) to wait for a client to complete auth handshake. */
export const AUTH_TIMEOUT = 10_000;

/** Maximum number of failed auth attempts per IP before a temporary ban. */
export const MAX_AUTH_ATTEMPTS = 5;

/** Auth attempt tracking window in ms. */
export const AUTH_WINDOW_MS = 60_000;

/** Ban duration in ms after too many failed auth attempts. */
export const BAN_DURATION_MS = 15 * 60_000;

/** Max entries in the client sender map. */
export const MAX_SENDERS = 8;

/** Max buffered UDP packets before WS auth completes. */
export const MAX_PENDING_QUEUE = 100;
/** Max UDP payload (65507) — larger datagrams are dropped. */
export const MAX_PAYLOAD_BYTES = 65507;
/** Max WS frame: seq(4)+nonce(12)+payload+tag(16) with headroom. */
export const MAX_FRAME_BYTES = 70_000;
/** Challenge nonce length. */
export const CHALLENGE_BYTES = 32;
/** Force reconnect before 32-bit seq wraps (replay safety). */
export const REKEY_AFTER_PACKETS = 500_000;
/** Rotate epoch at least this often (ms), even on idle sessions. */
export const REKEY_AFTER_MS = 3_600_000;
/** Per-IP connection cap (also bounded by global max-connections). */
export const MAX_CONN_PER_IP = 10;

/** Max concurrent sessions (default, overridable via --max-connections). */
export const DEFAULT_MAX_CONNECTIONS = 100;

/** Salt used for key derivation (domain-separated, not secret). */
const KDF_SALT = "wg-to-ws-v1";

/** Epoch key cache (bounded, per process). */
const epochKeyCache = new Map<string, Buffer>();

/**
 * Derive a 32-byte AES-256-GCM key from a shared secret using scrypt.
 *
 * scrypt is deliberately slow and memory-hard, making offline brute-force
 * infeasible compared to the previous single-round SHA-256. Each epoch
 * gets its own key via domain separation, so rotation bounds how much
 * ciphertext any single key protects.
 */
export function deriveKey(secret: string, epoch = 0): Buffer {
  const cacheKey = `${epoch}:${secret.length}:${secret.slice(0, 8)}`;
  const hit = epochKeyCache.get(cacheKey);
  if (hit) return hit;
  const key = crypto.scryptSync(secret, `${KDF_SALT}|e${epoch}`, 32, {
    N: 16384,
    r: 8,
    p: 1,
  });
  if (epochKeyCache.size > 8) epochKeyCache.clear();
  epochKeyCache.set(cacheKey, key);
  return key;
}

/**
 * Compute HMAC-SHA256 for challenge-response authentication.
 * Uses the derived key (from scrypt) as the HMAC key.
 */
export function computeAuthHmac(derivedKey: Buffer, challenge: Buffer): Buffer {
  return crypto.createHmac("sha256", derivedKey).update(challenge).digest();
}

// ── Replay protection (monotonic sequence numbers) ────────────

/** Size of the sequence number prefix in bytes (4 = uint32). */
export const SEQ_NUM_BYTES = 4;
/** Epoch field length (uint32 BE) prepended to every frame. */
export const EPOCH_BYTES = 4;
/** Wire header: epoch(4) + seq(4). */
export const HEADER_BYTES = EPOCH_BYTES + SEQ_NUM_BYTES;

/** Encode epoch+seq header (8 bytes big-endian). */
export function encodeHeader(epoch: number, seq: number): Buffer {
  const buf = Buffer.alloc(HEADER_BYTES);
  buf.writeUInt32BE(epoch >>> 0, 0);
  buf.writeUInt32BE(seq >>> 0, EPOCH_BYTES);
  return buf;
}

/** Decode epoch+seq header. Returns null on short buffers. */
export function decodeHeader(buf: Buffer): { epoch: number; seq: number } | null {
  if (buf.length < HEADER_BYTES) return null;
  return { epoch: buf.readUInt32BE(0), seq: buf.readUInt32BE(EPOCH_BYTES) };
}

/**
 * Encode a uint32 sequence number into a 4-byte big-endian buffer.
 * This is used as AAD in AES-256-GCM to bind each ciphertext to its
 * position in the stream, preventing reordering and replay.
 */
export function encodeSeqNum(n: number): Buffer {
  const buf = Buffer.alloc(SEQ_NUM_BYTES);
  buf.writeUInt32BE(n, 0);
  return buf;
}

/**
 * Decode a 4-byte big-endian buffer back into a uint32.
 */
export function decodeSeqNum(buf: Buffer): number {
  return buf.readUInt32BE(0);
}

/** Max uint32 seq value. */
export const MAX_SEQ = 0xffffffff;

/** Validate next seq against last accepted (strict monotonic + wrap guard). */
export function isValidSeq(last: number, seq: number): boolean {
  if (seq <= last) return false;
  // Reject implausible forward jumps (spoofed AAD). WS is ordered TCP,
  // so legitimate gaps stay small.
  if (seq - last > 1_000_000) return false;
  return true;
}

/** Receiver replay state per direction (one epoch active at a time). */
export interface RekeyState {
  epoch: number;
  lastSeq: number;
}

export function initialRekeyState(): RekeyState {
  return { epoch: 0, lastSeq: -1 };
}

/**
 * Validate an incoming (epoch, seq) against receiver state.
 * WS transport is ordered, so the sender never has old-epoch frames in
 * flight after rotation: only current epoch (monotonic seq) or the next
 * epoch (fresh counter) is accepted. Anything else is dropped.
 */
export function acceptFrame(
  state: RekeyState,
  epoch: number,
  seq: number,
): { ok: boolean; state: RekeyState } {
  if (epoch < state.epoch || epoch > state.epoch + 1) return { ok: false, state };
  if (epoch === state.epoch + 1) {
    // Fresh epoch restarts the counter; allow only a small starting seq.
    if (seq > 1000) return { ok: false, state };
    return { ok: true, state: { epoch, lastSeq: seq } };
  }
  if (!isValidSeq(state.lastSeq, seq)) return { ok: false, state };
  return { ok: true, state: { epoch, lastSeq: seq } };
}

/** Sender rotation check: packet count or wall-clock age. */
export function shouldRotate(packetsSinceRotate: number, msSinceRotate: number): boolean {
  return packetsSinceRotate >= REKEY_AFTER_PACKETS || msSinceRotate >= REKEY_AFTER_MS;
}

/** Normalize client IP for rate-limit keys (strip ::ffff:, brackets, case). */
export function normalizeIp(ip: string): string {
  let s = ip.trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  if (s.startsWith("::ffff:")) s = s.slice(7);
  return s;
}

/**
 * Client IP from the last X-Forwarded-For hop: the value the trusted proxy
 * appended. Earlier hops are client-supplied and must not be trusted.
 * Returns null when the header is absent or malformed.
 */
export function forwardedClientIp(xff: string | null): string | null {
  if (!xff || xff.length > 1024) return null;
  const last = xff.split(",").pop()?.trim();
  if (!last) return null;
  const ip = normalizeIp(last);
  return isIP(ip) ? ip : null;
}

/** Validate upstream host (IP or DNS name), no spaces/control chars. */
export function isValidHost(host: string): boolean {
  if (!host || host.length > 253) return false;
  if (/[\s\0<>"'`\\]/.test(host)) return false;
  return /^[A-Za-z0-9._-]+$/.test(host);
}

/** True if bind address is loopback-only. */
export function isLoopbackBind(bind: string): boolean {
  const host = bind.split(":")[0];
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** Sender-pin state for single-peer client reply routing. */
export interface SenderPinState {
  pinned: string | null;
  pinnedAt: number;
}

export function initialSenderPin(): SenderPinState {
  return { pinned: null, pinnedAt: 0 };
}

/**
 * Decide whether a UDP datagram source is accepted for reply routing.
 * First sender wins; spoofed sources are ignored. Re-pins after TTL or
 * when the pinned entry was evicted, so a legit peer change recovers.
 */
export function updateSenderPin(
  state: SenderPinState,
  hasPinnedEntry: boolean,
  key: string,
  now: number,
  ttlMs: number,
): { state: SenderPinState; accepted: boolean } {
  let s = state;
  if (!s.pinned || !hasPinnedEntry || now - s.pinnedAt > ttlMs) {
    s = { pinned: key, pinnedAt: now };
  }
  return { state: s, accepted: key === s.pinned };
}

// ── Encryption / Decryption (AES-256-GCM + AAD) ──────────────

/**
 * Encrypt a buffer with AES-256-GCM.
 *
 * Format: [epoch (4)][seq (4)][nonce (12)][ciphertext (N)][auth_tag (16)]
 *
 * The epoch+sequence header is included as AAD so GCM's integrity check
 * prevents replay or reordering of ciphertexts.
 */
export function encrypt(
  plaintext: Buffer,
  key: Buffer,
  epoch: number,
  seqNum: number,
): Buffer {
  const header = encodeHeader(epoch, seqNum);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(header);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([header, nonce, encrypted, tag]);
}

/**
 * Decrypt a buffer produced by encrypt().
 * Returns the plaintext buffer, or null on authentication failure.
 */
export function decrypt(data: Buffer, key: Buffer): Buffer | null {
  const minLen = HEADER_BYTES + 12 + 16;
  if (data.length < minLen || data.length > MAX_FRAME_BYTES) return null;
  const header = data.subarray(0, HEADER_BYTES);
  const nonce = data.subarray(HEADER_BYTES, HEADER_BYTES + 12);
  const tag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(HEADER_BYTES + 12, data.length - 16);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}

// ── Auth message helpers ──────────────────────────────────────

export const AUTH_TAG = "AUTH:";
export const AUTH_OK = "AUTH:OK";
export const CHALLENGE_TAG = "CHALLENGE:";
export const AUTH_RESP_TAG = "AUTH:";

/** Server sends CHALLENGE:<base64(nonce)> to client on open. */
export function makeChallengeMessage(nonce: Buffer): string {
  return CHALLENGE_TAG + nonce.toString("base64url");
}

/** Client parses CHALLENGE:<base64(nonce)> from server. */
export function parseChallengeMessage(msg: string): Buffer | null {
  if (!msg.startsWith(CHALLENGE_TAG)) return null;
  if (msg.length > 128) return null;
  const b64 = msg.slice(CHALLENGE_TAG.length);
  if (!/^[A-Za-z0-9_-]+$/.test(b64)) return null;
  try {
    const buf = Buffer.from(b64, "base64url");
    if (buf.length !== CHALLENGE_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

/** Client sends AUTH:<base64(hmac)> in response to challenge. */
export function makeAuthResponseMessage(hmac: Buffer): string {
  return AUTH_RESP_TAG + hmac.toString("base64url");
}

/** Server parses AUTH:<base64(hmac)> from client. */
export function parseAuthResponseMessage(msg: string): Buffer | null {
  if (!msg.startsWith(AUTH_TAG)) return null;
  if (msg.length > 128) return null;
  const b64 = msg.slice(AUTH_TAG.length);
  if (!/^[A-Za-z0-9_-]+$/.test(b64)) return null;
  try {
    const buf = Buffer.from(b64, "base64url");
    if (buf.length !== 32) return null;
    return buf;
  } catch {
    return null;
  }
}

/** Check if a message is AUTH:OK. */
export function isAuthOk(msg: string): boolean {
  return msg === AUTH_OK;
}

// ── CLI arg parsing ───────────────────────────────────────────

const FLAG_TO_ENV: Record<string, string> = {
  "mode": "WG_MODE",
  "bind": "WS_BIND",
  "base-path": "WS_BASE_PATH",
  "wg-addr": "WG_SERVER_ADDR",
  "ws-url": "WS_URL",
  "local-addr": "WG_LOCAL_ADDR",
  "local-port": "WG_LOCAL_PORT",
  "shared-key": "WG_SHARED_KEY",
  "shared-key-file": "WG_SHARED_KEY_FILE",
  "no-auth": "WG_NO_AUTH",
  "no-ban": "WG_NO_BAN",
  "max-connections": "WG_MAX_CONNECTIONS",
  "trust-proxy": "WG_TRUST_PROXY",
  "allow-origin": "WG_ALLOW_ORIGIN",
};

const CLI_ALIASES: Record<string, string> = {
  "b": "bind",
  "p": "base-path",
  "w": "wg-addr",
  "u": "ws-url",
  "l": "listen",
  "a": "local-addr",
  "P": "local-port",
  "k": "shared-key",
  "K": "shared-key-file",
  "n": "no-auth",
  "m": "max-connections",
  "o": "allow-origin",
};

export function parseCLIArgs(argv: string[]): Record<string, string> {
  const overrides: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--") && !arg.startsWith("-")) continue;

    let key: string;
    let val: string;

    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        key = arg.slice(2, eqIdx);
        val = arg.slice(eqIdx + 1);
      } else {
        key = arg.slice(2);
        val = argv[++i];
        if (val === undefined || val.startsWith("-")) {
          val = "true";
          i--;
        }
      }
    } else {
      const shortKey = arg.slice(1);
      const longKey = CLI_ALIASES[shortKey];
      if (!longKey) throw new Error(`Unknown option -${shortKey}`);

      if (shortKey === "l") {
        val = argv[++i];
        if (!val || val.startsWith("-")) { val = "true"; i--; }
        const idx = val.lastIndexOf(":");
        if (idx !== -1 && idx > 0) {
          overrides["WG_LOCAL_ADDR"] = val.slice(0, idx);
          overrides["WG_LOCAL_PORT"] = val.slice(idx + 1);
        } else {
          overrides["WG_LOCAL_ADDR"] = val;
        }
        continue;
      }

      val = argv[++i];
      if (val === undefined || val.startsWith("-")) { val = "true"; i--; }
      key = longKey;
    }

    const envName = FLAG_TO_ENV[key];
    if (!envName) throw new Error(`Unknown option --${key}`);
    overrides[envName] = val;
  }

  return overrides;
}

// ── Config loading ────────────────────────────────────────────

export function loadConfig(cliArgs?: string[]): Config {
  const env: Record<string, string | undefined> = {
    WG_MODE: process.env.WG_MODE,
    WG_LOCAL_ADDR: process.env.WG_LOCAL_ADDR,
    WG_LOCAL_PORT: process.env.WG_LOCAL_PORT,
    WG_SERVER_ADDR: process.env.WG_SERVER_ADDR,
    WS_URL: process.env.WS_URL,
    WS_BIND: process.env.WS_BIND,
    WS_BASE_PATH: process.env.WS_BASE_PATH,
    WG_SHARED_KEY: process.env.WG_SHARED_KEY,
    WG_SHARED_KEY_FILE: process.env.WG_SHARED_KEY_FILE,
    WG_NO_AUTH: process.env.WG_NO_AUTH,
    WG_NO_BAN: process.env.WG_NO_BAN,
    WG_MAX_CONNECTIONS: process.env.WG_MAX_CONNECTIONS,
    WG_TRUST_PROXY: process.env.WG_TRUST_PROXY,
    WG_ALLOW_ORIGIN: process.env.WG_ALLOW_ORIGIN,
  };

  if (cliArgs && cliArgs.length > 0) {
    const cli = parseCLIArgs(cliArgs);
    for (const [k, v] of Object.entries(cli)) env[k] = v;
  }

  const modeRaw = (env.WG_MODE || "client").trim().toLowerCase();
  const mode: Mode = modeRaw === "server" ? "server" : "client";
  const listenRaw = env.WG_LOCAL_ADDR || "127.0.0.1";

  let localAddr = listenRaw;
  let localPort = parseInt(env.WG_LOCAL_PORT || "51820", 10) || 51820;
  const idx = listenRaw.lastIndexOf(":");
  if (idx !== -1 && idx > 0) {
    const portVal = parseInt(listenRaw.slice(idx + 1), 10);
    if (!isNaN(portVal) && portVal > 0 && portVal <= 65535) {
      localPort = portVal;
      localAddr = listenRaw.slice(0, idx);
    }
  }

  // Resolve shared-key-file if provided
  let sharedKey = env.WG_SHARED_KEY || "";
  if (!sharedKey && env.WG_SHARED_KEY_FILE) {
    try {
      const fs = require("fs") as typeof import("fs");
      const st = fs.statSync(env.WG_SHARED_KEY_FILE);
      if (st.size > 4096) {
        console.error("Shared key file too large (max 4KB)");
        process.exit(1);
      }
      // Warn on world/group-readable key files (POSIX).
      if (typeof st.mode === "number" && st.mode & 0o077) {
        console.warn(
          `Warning: shared key file "${env.WG_SHARED_KEY_FILE}" is readable by group/other — chmod 600 recommended`,
        );
      }
      sharedKey = fs.readFileSync(env.WG_SHARED_KEY_FILE, "utf-8").trim();
      if (!sharedKey) {
        console.error("Shared key file is empty");
        process.exit(1);
      }
    } catch (err) {
      console.error(
        `Failed to read shared key file: ${(err as Error).message}`,
      );
      process.exit(1);
    }
  }

  const noAuth = env.WG_NO_AUTH === "true" || env.WG_NO_AUTH === "1";
  const noBan = env.WG_NO_BAN === "true" || env.WG_NO_BAN === "1";
  let maxConnections = parseInt(env.WG_MAX_CONNECTIONS || "", 10) || DEFAULT_MAX_CONNECTIONS;
  if (!Number.isFinite(maxConnections)) maxConnections = DEFAULT_MAX_CONNECTIONS;
  maxConnections = Math.min(10000, Math.max(1, maxConnections));
  const trustProxy = env.WG_TRUST_PROXY === "true" || env.WG_TRUST_PROXY === "1";
  const allowOrigin = env.WG_ALLOW_ORIGIN || "";

  // Validate upstream + bind formats (SSRF / misconfig guard).
  const wgHost = (env.WG_SERVER_ADDR || "127.0.0.1:51820").split(":")[0];
  if (!isValidHost(wgHost)) {
    console.error("Invalid WG_SERVER_ADDR host");
    process.exit(1);
  }
  if (localPort <= 0 || localPort > 65535) {
    console.error("Invalid local port");
    process.exit(1);
  }

  return {
    mode,
    localAddr: localAddr.trim(),
    localPort,
    wgServerAddr: env.WG_SERVER_ADDR || "127.0.0.1:51820",
    wsUrl: env.WS_URL || "ws://localhost:8080/wg",
    wsBind: env.WS_BIND || "127.0.0.1:8080",
    wsBasePath: normalizePath(env.WS_BASE_PATH || "/wg"),
    sharedKey,
    noAuth,
    noBan,
    maxConnections,
    trustProxy,
    allowOrigin,
  };
}

/** Normalise a path: strip trailing slashes and collapse double slashes. */
export function normalizePath(p: string): string {
  if (p.includes("\0") || p.includes("..")) return "/wg";
  const clean = "/" + p.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  if (clean.length > 256) return "/wg";
  return clean;
}
