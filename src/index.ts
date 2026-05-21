#!/usr/bin/env bun
/**
 * wg-to-ws — Tunnel WireGuard UDP traffic over WebSocket.
 *
 * Usage:
 *   wg-to-ws server   # run the server
 *   wg-to-ws client   # run the client
 *
 * Or set WG_MODE=server|client and run without arguments.
 */

const mode = process.argv[2] || process.env.WG_MODE || "client";

if (mode === "server") {
  await import("./server");
} else {
  await import("./client");
}

export {};
