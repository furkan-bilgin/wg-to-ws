#!/usr/bin/env bun
/**
 * wg-to-ws — Tunnel WireGuard UDP traffic over WebSocket.
 *
 * Usage:
 *   wg-to-ws server [options]
 *   wg-to-ws client [options]
 *
 * Options override the equivalent environment variables.
 *
 * Server:
 *   --bind <addr>            WS_BIND           (default 0.0.0.0:8080)
 *   --base-path <path>       WS_BASE_PATH      (default /wg)
 *   --wg-addr <addr>         WG_SERVER_ADDR    (default 127.0.0.1:51820)
 *
 * Client:
 *   --listen <addr:port>     WG_LOCAL_ADDR + WG_LOCAL_PORT  (127.0.0.1:51820)
 *   --local-addr <addr>      WG_LOCAL_ADDR     (default 127.0.0.1)
 *   --local-port <port>      WG_LOCAL_PORT     (default 51820)
 *   --ws-url <url>           WS_URL            (default ws://localhost:8080/wg)
 *
 * Both:
 *   --shared-key <secret>    WG_SHARED_KEY     (default none)
 *   --mode <server|client>   WG_MODE           (default client)
 *
 * Short flags:  -b, -p, -w, -l, -u, -a, -P, -k
 *
 * Examples:
 *   wg-to-ws server -b 0.0.0.0:443 -p /wg -w 10.0.0.1:51820 -k mysecret
 *   wg-to-ws client -l 127.0.0.1:51820 -u wss://vps.example.com/wg -k mysecret
 */

import { parseCLIArgs } from "./shared";

const args = process.argv.slice(2);

let mode = "";
const flagArgs: string[] = [];

for (const a of args) {
  if (!mode && !a.startsWith("-")) {
    mode = a;
  } else {
    flagArgs.push(a);
  }
}

const cliOverrides = parseCLIArgs(flagArgs);

if (cliOverrides["WG_MODE"]) mode = cliOverrides["WG_MODE"];
if (!mode) mode = process.env.WG_MODE || "client";

for (const [k, v] of Object.entries(cliOverrides)) {
  process.env[k] = v;
}

if (mode === "server") {
  await import("./server");
} else {
  await import("./client");
}
