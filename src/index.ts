#!/usr/bin/env bun
/**
 * wg-to-ws — Tunnel WireGuard UDP traffic over WebSocket.
 */

import { parseArgs } from "util";

const VERSION = "0.1.0";

interface OptionDef {
  name: string;
  type: "boolean" | "string";
  short?: string;
  desc: string;
  default?: string;
  placeholder?: string;
}

const CLI_OPTIONS: OptionDef[] = [
  { name: "help",       type: "boolean", short: "h", desc: "Print this help" },
  { name: "version",    type: "boolean", short: "v", desc: "Print version" },
  { name: "bind",       type: "string",  short: "b", desc: "WebSocket listen address",        placeholder: "addr",     default: "0.0.0.0:8080" },
  { name: "base-path",  type: "string",  short: "p", desc: "WebSocket base path",             placeholder: "path",     default: "/wg" },
  { name: "wg-addr",    type: "string",  short: "w", desc: "Target WireGuard server",         placeholder: "addr",     default: "127.0.0.1:51820" },
  { name: "listen",     type: "string",  short: "l", desc: "UDP listen address:port",         placeholder: "addr:port",default: "127.0.0.1:51820" },
  { name: "local-addr", type: "string",  short: "a", desc: "UDP bind address",                placeholder: "addr",     default: "127.0.0.1" },
  { name: "local-port", type: "string",  short: "P", desc: "UDP port",                        placeholder: "port",     default: "51820" },
  { name: "ws-url",     type: "string",  short: "u", desc: "WebSocket server URL",            placeholder: "url",      default: "ws://localhost:8080/wg" },
  { name: "shared-key", type: "string",  short: "k", desc: "Pre-shared key for auth + encryption", placeholder: "secret" },
  { name: "mode",       type: "string",               desc: "server or client",               placeholder: "mode",     default: "client" },
];

function buildParseOptions(defs: OptionDef[]) {
  const options: Record<string, { type: "boolean" | "string"; short?: string }> = {};
  for (const d of defs) {
    const entry: { type: "boolean" | "string"; short?: string } = { type: d.type };
    if (d.short) entry.short = d.short;
    options[d.name] = entry;
  }
  return options;
}

function printHelp(defs: OptionDef[]) {
  const lines: string[] = [
    "wg-to-ws — Tunnel WireGuard UDP traffic over WebSocket.",
    "",
    "Usage:",
    "  wg-to-ws [mode] [options]",
    "",
    "Modes:",
    "  server    Run as server",
    "  client    Run as client (default)",
    "",
    "Options:",
  ];

  for (const d of defs) {
    const flag = d.short
      ? `  -${d.short}, --${d.name}`
      : `      --${d.name}`;
    const withArg = d.type === "string" && d.placeholder
      ? ` <${d.placeholder}>`
      : "";
    const flagPart = `${flag}${withArg}`.padEnd(40);
    let descPart = d.desc;
    if (d.default) descPart += ` (default ${d.default})`;
    lines.push(`${flagPart}${descPart}`);
  }

  lines.push(
    "",
    "Examples:",
    "  wg-to-ws server -b 0.0.0.0:443 -p /wg -w 10.0.0.1:51820 -k secret",
    "  wg-to-ws client -l 127.0.0.1:51820 -u wss://example.com/wg -k secret",
  );

  console.log(lines.join("\n"));
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: buildParseOptions(CLI_OPTIONS),
  strict: false,
  allowPositionals: true,
});

// ── Help / Version ────────────────────────────────────────────

if (values.help) {
  printHelp(CLI_OPTIONS);
  process.exit(0);
}

if (values.version) {
  console.log(`wg-to-ws v${VERSION}`);
  process.exit(0);
}

// ── Determine mode ────────────────────────────────────────────

let mode = typeof values.mode === "string" ? values.mode : "";

for (const p of positionals) {
  if (p === "server" || p === "client") {
    mode = p;
    break;
  }
}

if (!mode) mode = process.env.WG_MODE || "client";

// ── Inject CLI values into env (overrides) ────────────────────

const CLI_TO_ENV: Record<string, string> = {
  bind:       "WS_BIND",
  "base-path":"WS_BASE_PATH",
  "wg-addr":  "WG_SERVER_ADDR",
  "local-addr":"WG_LOCAL_ADDR",
  "local-port":"WG_LOCAL_PORT",
  "ws-url":   "WS_URL",
  "shared-key":"WG_SHARED_KEY",
  mode:       "WG_MODE",
};

for (const [cliKey, envKey] of Object.entries(CLI_TO_ENV)) {
  const val = values[cliKey as keyof typeof values];
  if (val !== undefined) {
    process.env[envKey] = String(val);
  }
}

// Special: --listen sets both local-addr and local-port
const listenVal = values.listen;
if (listenVal && typeof listenVal === "string") {
  const idx = listenVal.lastIndexOf(":");
  if (idx !== -1 && idx > 0) {
    process.env.WG_LOCAL_ADDR = listenVal.slice(0, idx);
    process.env.WG_LOCAL_PORT = listenVal.slice(idx + 1);
  } else {
    process.env.WG_LOCAL_ADDR = listenVal;
  }
}

// ── Dispatch ──────────────────────────────────────────────────

if (mode === "server") {
  await import("./server");
} else {
  await import("./client");
}
