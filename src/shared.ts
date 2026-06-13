import crypto from "crypto";

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
  maxConnections: number;
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
export const MAX_SENDERS = 100;

/** Max concurrent sessions (default, overridable via --max-connections). */
export const DEFAULT_MAX_CONNECTIONS = 100;

/** Salt used for key derivation (domain-separated, not secret). */
const KDF_SALT = "wg-to-ws-v1";

/**
 * Derive a 32-byte AES-256-GCM key from a shared secret using scrypt.
 *
 * scrypt is deliberately slow and memory-hard, making offline brute-force
 * infeasible compared to the previous single-round SHA-256.
 */
export function deriveKey(secret: string): Buffer {
  return crypto.scryptSync(secret, KDF_SALT, 32, { N: 16384, r: 8, p: 1 });
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

// ── Encryption / Decryption (AES-256-GCM + AAD) ──────────────

/**
 * Encrypt a buffer with AES-256-GCM.
 *
 * Format: [seq_num (4 bytes)][nonce (12 bytes)][ciphertext (N bytes)][auth_tag (16 bytes)]
 *
 * The sequence number is included as AAD so GCM's integrity check
 * prevents replay or reordering of ciphertexts.
 */
export function encrypt(
  plaintext: Buffer,
  key: Buffer,
  seqNumBuf: Buffer,
): Buffer {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(seqNumBuf);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([seqNumBuf, nonce, encrypted, tag]);
}

/**
 * Decrypt a buffer produced by encrypt().
 * Returns the plaintext buffer, or null on authentication failure.
 */
export function decrypt(data: Buffer, key: Buffer): Buffer | null {
  const seqNumBuf = data.subarray(0, SEQ_NUM_BYTES);
  const nonce = data.subarray(SEQ_NUM_BYTES, SEQ_NUM_BYTES + 12);
  const tag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(SEQ_NUM_BYTES + 12, data.length - 16);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce, {
      authTagLength: 16,
    });
    decipher.setAAD(seqNumBuf);
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
  const b64 = msg.slice(CHALLENGE_TAG.length);
  try {
    return Buffer.from(b64, "base64url");
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
  const b64 = msg.slice(AUTH_TAG.length);
  try {
    return Buffer.from(b64, "base64url");
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
  "max-connections": "WG_MAX_CONNECTIONS",
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
      if (!longKey) continue;

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
    if (envName) overrides[envName] = val;
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
    WG_MAX_CONNECTIONS: process.env.WG_MAX_CONNECTIONS,
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
      sharedKey = require("fs")
        .readFileSync(env.WG_SHARED_KEY_FILE, "utf-8")
        .trim();
    } catch (err) {
      console.error(
        `Failed to read shared key file "${env.WG_SHARED_KEY_FILE}": ${err}`,
      );
      process.exit(1);
    }
  }

  const noAuth = env.WG_NO_AUTH === "true" || env.WG_NO_AUTH === "1";
  const maxConnections = parseInt(env.WG_MAX_CONNECTIONS || "", 10) || DEFAULT_MAX_CONNECTIONS;
  const allowOrigin = env.WG_ALLOW_ORIGIN || "";

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
    maxConnections,
    allowOrigin,
  };
}

/** Normalise a path: strip trailing slashes and collapse double slashes. */
export function normalizePath(p: string): string {
  return "/" + p.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}
