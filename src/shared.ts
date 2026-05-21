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

export function loadConfig(): Config {
  const modeRaw = (process.env.WG_MODE || "client").trim().toLowerCase();
  const mode: Mode = modeRaw === "server" ? "server" : "client";

  return {
    mode,
    localAddr: (process.env.WG_LOCAL_ADDR || "127.0.0.1").trim(),
    localPort: parseInt(process.env.WG_LOCAL_PORT || "51820", 10) || 51820,
    wgServerAddr: process.env.WG_SERVER_ADDR || "127.0.0.1:51820",
    wsUrl: process.env.WS_URL || "ws://localhost:8080/wg",
    wsBind: process.env.WS_BIND || "0.0.0.0:8080",
    wsBasePath: normalizePath(process.env.WS_BASE_PATH || "/wg"),
  };
}
