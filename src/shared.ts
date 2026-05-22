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
}

/** WebSocket ping interval in ms — keeps connection alive through proxies. */
export const PING_INTERVAL = 25_000;

/** Normalise a path: strip trailing slashes and collapse double slashes. */
export function normalizePath(p: string): string {
  return "/" + p.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

// ── Shared-key auth + encryption ──────────────────────────────

export const AUTH_TAG = "AUTH:";
export const AUTH_OK = "AUTH:OK";

/**
 * Derive a 32-byte AES-256 key from a shared secret using SHA-256.
 */
export function deriveKey(secret: string): Buffer {
  return crypto.createHash("sha256").update(secret).digest();
}

/**
 * Encrypt a buffer with AES-256-GCM.
 * Returns nonce + ciphertext + auth tag (12 + N + 16 bytes).
 */
export function encrypt(plaintext: Buffer, key: Buffer): Buffer {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, encrypted, tag]);
}

/**
 * Decrypt a buffer produced by encrypt().
 */
export function decrypt(data: Buffer, key: Buffer): Buffer {
  const nonce = data.subarray(0, 12);
  const tag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(12, data.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function makeAuthMessage(key: string): string {
  return AUTH_TAG + key;
}

export function parseAuthMessage(msg: string): string | null {
  if (!msg.startsWith(AUTH_TAG)) return null;
  return msg.slice(AUTH_TAG.length);
}

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

  return {
    mode,
    localAddr: localAddr.trim(),
    localPort,
    wgServerAddr: env.WG_SERVER_ADDR || "127.0.0.1:51820",
    wsUrl: env.WS_URL || "ws://localhost:8080/wg",
    wsBind: env.WS_BIND || "0.0.0.0:8080",
    wsBasePath: normalizePath(env.WS_BASE_PATH || "/wg"),
    sharedKey: env.WG_SHARED_KEY || "",
  };
}
