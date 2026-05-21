export type Mode = "client" | "server";

export interface Config {
  mode: Mode;
  localAddr: string;
  localPort: number;
  wgServerAddr: string;
  wsUrl: string;
  wsBind: string;
  wsBasePath: string;
}

/** Normalise a path: strip trailing slashes and collapse double slashes. */
export function normalizePath(p: string): string {
  return "/" + p.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

// Map of CLI flag names to env-var names
const FLAG_TO_ENV: Record<string, string> = {
  "mode": "WG_MODE",
  "bind": "WS_BIND",
  "base-path": "WS_BASE_PATH",
  "wg-addr": "WG_SERVER_ADDR",
  "ws-url": "WS_URL",
  "local-addr": "WG_LOCAL_ADDR",
  "local-port": "WG_LOCAL_PORT",
};

const CLI_ALIASES: Record<string, string> = {
  "b": "bind",
  "p": "base-path",
  "w": "wg-addr",
  "u": "ws-url",
  "l": "listen",
  "a": "local-addr",
  "P": "local-port",
};

/**
 * Parse CLI arguments into a map of env-var → value.
 * Supports `--key=value` and `--key value` forms, plus short aliases.
 * Special flag `--listen` (or `-l`) sets both localAddr and localPort
 * from an `addr:port` string.
 */
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
          i--; // put back
        }
      }
    } else {
      // short flag: -l, -b, etc.
      const shortKey = arg.slice(1);
      const longKey = CLI_ALIASES[shortKey];
      if (!longKey) continue;

      if (shortKey === "l") {
        // --listen addr:port → parsed below after collecting value
        val = argv[++i];
        if (!val || val.startsWith("-")) {
          val = "true";
          i--;
        }
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
      if (val === undefined || val.startsWith("-")) {
        val = "true";
        i--;
      }
      key = longKey;
    }

    const envName = FLAG_TO_ENV[key];
    if (envName) {
      overrides[envName] = val;
    }
  }

  return overrides;
}

export function loadConfig(cliArgs?: string[]): Config {
  // Start with env vars
  const env: Record<string, string | undefined> = {
    WG_MODE: process.env.WG_MODE,
    WG_LOCAL_ADDR: process.env.WG_LOCAL_ADDR,
    WG_LOCAL_PORT: process.env.WG_LOCAL_PORT,
    WG_SERVER_ADDR: process.env.WG_SERVER_ADDR,
    WS_URL: process.env.WS_URL,
    WS_BIND: process.env.WS_BIND,
    WS_BASE_PATH: process.env.WS_BASE_PATH,
  };

  // Merge CLI overrides on top
  if (cliArgs && cliArgs.length > 0) {
    const cli = parseCLIArgs(cliArgs);
    for (const [k, v] of Object.entries(cli)) {
      env[k] = v;
    }
  }

  const modeRaw = (env.WG_MODE || "client").trim().toLowerCase();
  const mode: Mode = modeRaw === "server" ? "server" : "client";
  const listenRaw = env.WG_LOCAL_ADDR || "127.0.0.1";

  // If listen address contains a port, split it
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
  };
}
