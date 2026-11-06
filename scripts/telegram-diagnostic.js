#!/usr/bin/env node
/**
 * Telegram Bot API reachability diagnostic.
 *
 * `TELEGRAM_ERROR … fetch failed` says nothing on its own: Node's `fetch`
 * collapses DNS, TCP, TLS and proxy failures into one message. This script runs
 * each layer of the Bot API call separately on the host that runs the bot and
 * prints the decoded transport cause + the fix.
 *
 * Usage:
 *   node scripts/telegram-diagnostic.js              # env audit + live checks
 *   node scripts/telegram-diagnostic.js --offline    # env audit only (no network)
 *   node scripts/telegram-diagnostic.js --json       # machine-readable report
 *   node scripts/telegram-diagnostic.js --timeout=5000
 *
 * Checks:
 *   DNS     — A/AAAA records for the Bot API host (TELEGRAM_API_BASE or api.telegram.org)
 *   TCP     — connect to the resolved address(es) on 443
 *   TLS     — certificate handshake against the Bot API host name
 *   getMe   — the same `fetch` the bot uses (token validity + egress path)
 *
 * Exit codes:
 *   0 = getMe succeeded (the bot can talk to Telegram from this host)
 *   1 = the call failed (see the hint on each failed check)
 */

import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import "../envcrypt.js"; // loads .env (and decrypts envrypt values) before anything reads process.env
import {
  TELEGRAM_HTTP_TIMEOUT_MS,
  describeTelegramError,
  maskBotToken,
  parseApiBaseTarget,
  telegramBotUrl,
  telegramErrorDetails,
  telegramErrorHint,
} from "../utils/telegramNet.js";

const argv = new Set(process.argv.slice(2));
const OFFLINE = argv.has("--offline");
const JSON_OUTPUT = argv.has("--json");
// Mirrors the production Bot API deadline (15 s) so a probe failure here means
// the bot itself would fail too. Override with `--timeout=<ms>`.
const TIMEOUT_MS = (() => {
  const raw = [...argv].find((arg) => arg.startsWith("--timeout="));
  const value = Number(raw?.split("=")[1]);
  return Number.isFinite(value) && value >= 1_000 ? value : TELEGRAM_HTTP_TIMEOUT_MS;
})();

function say(line = "") {
  if (!JSON_OUTPUT) console.log(line);
}

function icon(ok) {
  return ok ? "✓" : "✗";
}

/** Read the token exactly the way telegram.js does (no trimming of the value). */
function readToken() {
  return process.env.TELEGRAM_BOT_TOKEN || null;
}

function readChatId() {
  return String(process.env.TELEGRAM_CHAT_ID || "").trim();
}

function proxyEnv() {
  return Object.keys(process.env)
    .filter((key) => /^(https?_proxy|all_proxy|no_proxy)$/i.test(key))
    .map((key) => `${key}=${process.env[key]}`);
}

/** Probe a TCP connect (no TLS) and report the ms it took or the error code. */
function probeTcp(host, port, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.connect({ host, port });
    const finish = (ok, code) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, code: code || null, durationMs: Date.now() - startedAt });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "ETIMEDOUT"));
    socket.once("error", (error) => finish(false, error.code || error.message));
  });
}

/** Full TLS handshake against `servername` (SNI), reporting the certificate subject. */
function probeTls(host, port, servername, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let socket;
    const finish = (ok, code, extra = {}) => {
      socket?.removeAllListeners?.();
      socket?.destroy?.();
      resolve({ ok, code: code || null, durationMs: Date.now() - startedAt, ...extra });
    };
    // SNI must be a host name — an IP literal is rejected synchronously.
    const sni = net.isIP(String(servername)) ? undefined : servername;
    try {
      socket = tls.connect({
        host,
        port,
        ...(sni ? { servername: sni } : {}),
        timeout: timeoutMs,
        rejectUnauthorized: false,
      });
    } catch (error) {
      finish(false, error.code || error.message);
      return;
    }
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      finish(true, null, {
        protocol: socket.getProtocol(),
        authorized: socket.authorized,
        authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
        subject: cert?.subject?.CN || null,
        validTo: cert?.valid_to || null,
      });
    });
    socket.once("timeout", () => finish(false, "ETIMEDOUT"));
    socket.once("error", (error) => finish(false, error.code || error.message));
  });
}

async function resolveHost(host) {
  const records = { lookup: [], a: [], aaaa: [], errors: [] };
  try {
    records.lookup = await dns.lookup(host, { all: true });
  } catch (error) {
    records.errors.push(`lookup: ${error.code || error.message}`);
  }
  try {
    records.a = (await dns.resolve4(host)).map((address) => ({ address, family: 4 }));
  } catch (error) {
    records.errors.push(`A: ${error.code || error.message}`);
  }
  try {
    records.aaaa = (await dns.resolve6(host)).map((address) => ({ address, family: 6 }));
  } catch (error) {
    records.errors.push(`AAAA: ${error.code || error.message}`);
  }
  return records;
}

async function probeGetMe(base, token) {
  const startedAt = Date.now();
  try {
    const res = await fetch(telegramBotUrl("getMe", { apiBase: base, token }), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const payload = await res.json().catch(() => null);
    return {
      ok: res.ok && payload?.ok === true,
      httpStatus: res.status,
      detail: payload?.ok
        ? `@${payload.result?.username ?? "?"} (id ${payload.result?.id ?? "?"})`
        : String(payload?.description || `HTTP ${res.status}`),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const { codes, endpoints } = telegramErrorDetails(error);
    return {
      ok: false,
      httpStatus: null,
      detail: describeTelegramError(error),
      codes,
      endpoints,
      durationMs: Date.now() - startedAt,
    };
  }
}

/** Inspect the raw env values and report what is missing or suspicious. */
function auditEnv() {
  const token = readToken();
  const chatId = readChatId();
  const target = parseApiBaseTarget();
  const proxies = proxyEnv();
  const notes = [];

  if (!token) {
    notes.push({ level: "error", message: "TELEGRAM_BOT_TOKEN is not set — no command or notification can work" });
  } else if (token !== token.trim()) {
    notes.push({ level: "warn", message: "TELEGRAM_BOT_TOKEN carries leading/trailing whitespace (stray quotes in .env?)" });
  } else if (!/^\d+:[\w-]+$/.test(token)) {
    notes.push({ level: "warn", message: "TELEGRAM_BOT_TOKEN does not look like <bot id>:<secret>" });
  }
  if (!chatId) {
    notes.push({
      level: "warn",
      message: "TELEGRAM_CHAT_ID is not set — outbound notifications and inbound commands stay disabled",
    });
  }
  if (process.env.TELEGRAM_API_BASE) {
    notes.push({ level: "info", message: `TELEGRAM_API_BASE override active — probing ${target.base}` });
  }
  if (proxies.length) {
    notes.push({
      level: "warn",
      message:
        `Proxy env detected (${proxies.join(", ")}). Node's built-in fetch ignores HTTPS_PROXY/HTTP_PROXY, ` +
        "so egress that depends on them still fails — point TELEGRAM_API_BASE at a reachable relay instead.",
    });
  }

  return { token, chatId, target, proxies, notes };
}

function printEnv(audit) {
  say("=== Prometheus Telegram diagnostic ===");
  say("");
  say("Environment");
  say(`  TELEGRAM_BOT_TOKEN   : ${audit.token ? maskBotToken(audit.token) : "<unset>"}`);
  say(`  TELEGRAM_CHAT_ID     : ${audit.chatId || "<unset>"}`);
  say(`  Telegram API base    : ${audit.target.base}${process.env.TELEGRAM_API_BASE ? " [override]" : " [default]"}`);
  say(`  Target               : ${audit.target.host}:${audit.target.port} (${audit.target.protocol})`);
  say(`  Proxy env            : ${audit.proxies.length ? audit.proxies.join(", ") : "<none>"}`);
  say(`  Node                 : ${process.version} (${process.platform})`);
  if (audit.notes.length) {
    say("");
    say("Findings");
    for (const note of audit.notes) {
      const mark = note.level === "error" ? "✗" : note.level === "warn" ? "⚠" : "ℹ";
      say(`  ${mark} ${note.message}`);
    }
  }
}

async function runNetworkChecks(audit) {
  const host = audit.target.host;
  const port = audit.target.port;

  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    apiBase: audit.target.base,
    host,
    port,
    tokenPresent: Boolean(audit.token),
    chatIdPresent: Boolean(audit.chatId),
    proxyEnv: audit.proxies,
    notes: audit.notes,
    dns: null,
    tcp: [],
    tls: null,
    getMe: null,
  };

  say("");
  say("Live checks");

  report.dns = await resolveHost(host);
  const addresses = [...report.dns.lookup];
  say(
    `  ${icon(addresses.length > 0)} DNS lookup          ` +
      (addresses.length
        ? addresses.map((entry) => `${entry.address} (v${entry.family})`).join(", ")
        : report.dns.errors.join("; ") || "no addresses"),
  );

  for (const entry of addresses.slice(0, 4)) {
    const result = await probeTcp(entry.address, port);
    report.tcp.push({ address: entry.address, family: entry.family, ...result });
    say(
      `  ${icon(result.ok)} TCP ${String(entry.address).padEnd(16)} ` +
        (result.ok ? `connected in ${result.durationMs}ms` : `${result.code} after ${result.durationMs}ms`),
    );
  }

  if (audit.target.protocol === "https:" && addresses.length > 0) {
    const reachable = report.tcp.find((entry) => entry.ok);
    if (!reachable) {
      say("  ⚠ TLS handshake       skipped — no TCP connection succeeded");
    } else {
      report.tls = await probeTls(reachable.address, port, host);
      say(
        `  ${icon(report.tls.ok)} TLS handshake       ` +
          (report.tls.ok
            ? `${report.tls.protocol} — CN=${report.tls.subject ?? "?"}, ` +
              `${report.tls.authorized ? "trusted" : `untrusted (${report.tls.authorizationError ?? "unknown"})`}, ` +
              `valid to ${report.tls.validTo ?? "?"}`
            : `${report.tls.code} after ${report.tls.durationMs}ms`),
      );
    }
  }

  if (!audit.token) {
    say("  ⚠ getMe              skipped — TELEGRAM_BOT_TOKEN is not set");
    report.getMe = { ok: false, skipped: true, detail: "TELEGRAM_BOT_TOKEN is not set" };
    return report;
  }

  report.getMe = await probeGetMe(audit.target.base, audit.token);
  const status = report.getMe.httpStatus != null ? `HTTP ${report.getMe.httpStatus}` : "no HTTP";
  say(
    `  ${icon(report.getMe.ok)} getMe               ${status} — ${report.getMe.detail} (${report.getMe.durationMs}ms)`,
  );

  return report;
}
function printSummary(report, exitCode) {
  say("");
  say("Summary");
  if (report.getMe?.ok) {
    say("  ✓ Bot API reachable and the token is valid — the bot can send and receive.");
    say(`  Exit code: ${exitCode}`);
    return;
  }

  const dnsEmpty = !report.dns?.lookup?.length;
  const tcpOk = (report.tcp || []).some((entry) => entry.ok);
  const tcpCodes = [...new Set((report.tcp || []).map((entry) => entry.code).filter(Boolean))];
  const tlsFailed = Boolean(report.tls && !report.tls.ok);

  say("  ✗ The bot cannot reach Telegram from this host.");
  if (dnsEmpty) {
    say(`    → DNS: ${report.dns?.errors?.join("; ") || "no address for the Bot API host"}`);
    say("    → Fix /etc/resolv.conf (or systemd-resolved) and re-run this script.");
  } else if (!tcpOk) {
    say(`    → TCP ${report.port} refused/blackholed (${tcpCodes.join(", ") || "no code"}).`);
    say(`    → ${telegramErrorHint(tcpCodes) || "Egress to the Bot API host is blocked from this network."}`);
  } else if (tlsFailed) {
    say(`    → TLS failed (${report.tls.code}).`);
    say(`    → ${telegramErrorHint([report.tls.code]) || "Check the host clock and any TLS-intercepting proxy."}`);
  } else if (report.getMe?.detail) {
    say(`    → getMe: ${report.getMe.detail}`);
    if (report.getMe.httpStatus === 401) {
      say("    → TELEGRAM_BOT_TOKEN is invalid, revoked, or still encrypted (missing .envrypt key).");
    }
  }
  say("    → If api.telegram.org is blocked by the network, run a relay that forwards");
  say("      https://your-relay.example.com/bot<token>/<method> to api.telegram.org, set");
  say("      TELEGRAM_API_BASE=https://your-relay.example.com in .env and restart the agent.");
  say(`  Exit code: ${exitCode}`);
}

async function main() {
  const audit = auditEnv();
  printEnv(audit);

  if (OFFLINE) {
    const exitCode = audit.notes.some((note) => note.level === "error") ? 1 : 0;
    if (JSON_OUTPUT) {
      console.log(
        JSON.stringify({ generatedAt: new Date().toISOString(), offline: true, notes: audit.notes, exitCode }, null, 2),
      );
    } else {
      say("");
      say("Summary");
      say("  ℹ Offline mode — skipped live checks (run without --offline to test the Bot API).");
      say(`  Exit code: ${exitCode}`);
    }
    return exitCode;
  }

  const report = await runNetworkChecks(audit);
  const exitCode = report.getMe?.ok ? 0 : 1;
  printSummary(report, exitCode);
  if (JSON_OUTPUT) {
    console.log(JSON.stringify({ ...report, exitCode }, null, 2));
  }
  return exitCode;
}

main()
  .then((exitCode) => {
    // Set the code instead of process.exit() so piped stdout is never truncated.
    process.exitCode = exitCode;
  })
  .catch((error) => {
    if (JSON_OUTPUT) {
      console.log(JSON.stringify({ error: error.message, stack: error.stack }, null, 2));
    } else {
      console.error(`Telegram diagnostic crashed: ${error.stack || error.message}`);
    }
    process.exitCode = 1;
  });

