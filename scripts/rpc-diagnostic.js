#!/usr/bin/env node
/**
 * Helius / Solana RPC health diagnostic.
 *
 * Usage:
 *   node scripts/rpc-diagnostic.js             # env audit + live checks
 *   node scripts/rpc-diagnostic.js --offline   # env audit only (no network)
 *   node scripts/rpc-diagnostic.js --fallback  # also probe the fallback endpoint
 *   node scripts/rpc-diagnostic.js --strict    # exit 1 when the PRIMARY endpoint fails
 *   node scripts/rpc-diagnostic.js --json      # machine-readable report
 *
 * Checks per endpoint:
 *   getHealth   → endpoint authorization (HTTP 401 = bad/missing/revoked API key)
 *   getBalance  → live read for 11111111111111111111111111111111
 *   getSlot     → the chain is advancing
 *
 * Exit codes:
 *   0 = live read path verified (primary, or fallback when configured)
 *   1 = no endpoint worked, or --strict and the primary endpoint failed
 */

import "../envcrypt.js"; // loads .env (and decrypts envrypt values) before anything reads process.env
import {
  extractHeliusApiKey,
  getFallbackRpcUrl,
  isEnabledFlag,
  isHeliusEndpoint,
  looksLikeHeliusKey,
  looksLikeUrl,
  maskSecret,
  redactRpcUrl,
  resolveRpcUrl,
  rpcCall,
  sanitizeEnvValue,
} from "../utils/rpc.js";

const KNOWN_PUBLIC_ADDRESS = "11111111111111111111111111111111";
const HELIUS_DASHBOARD = "https://dashboard.helius.dev";

const argv = new Set(process.argv.slice(2));
const OFFLINE = argv.has("--offline");
const JSON_OUTPUT = argv.has("--json");
const FORCE_FALLBACK = argv.has("--fallback");
const STRICT = argv.has("--strict");

function say(line = "") {
  if (!JSON_OUTPUT) console.log(line);
}

/** Inspect the raw env values and report what was repaired / is missing. */
function auditEnv() {
  const rawRpcUrl = process.env.RPC_URL ?? "";
  const rawHeliusKey = process.env.HELIUS_API_KEY ?? "";
  const rpcUrl = resolveRpcUrl();
  const heliusKey = extractHeliusApiKey(rawHeliusKey);
  const fallbackUrl = getFallbackRpcUrl();
  const notes = [];

  if (!rawRpcUrl) {
    notes.push({ level: "error", message: "RPC_URL is not set in .env" });
  } else if (sanitizeEnvValue(rawRpcUrl) !== rawRpcUrl) {
    notes.push({
      level: "warn",
      message: "RPC_URL contained quotes/whitespace/trailing punctuation — sanitized automatically",
    });
  }

  if (rawHeliusKey && looksLikeUrl(rawHeliusKey)) {
    notes.push({
      level: "warn",
      message:
        "HELIUS_API_KEY contained a full RPC URL — extracted the bare key automatically " +
        "(this is what caused HTTP 401 Unauthorized)",
    });
  }
  if (!heliusKey) {
    notes.push({
      level: "error",
      message: "HELIUS_API_KEY is missing — Helius endpoints answer HTTP 401 Unauthorized",
    });
  } else if (!looksLikeHeliusKey(heliusKey)) {
    notes.push({
      level: "warn",
      message: "HELIUS_API_KEY does not look like a Helius key (expected a uuid such as 1234abcd-…-…-…-…)",
    });
  }
  if (!rpcUrl) {
    notes.push({ level: "error", message: "RPC_URL could not be parsed into a valid URL" });
  }
  if (!fallbackUrl) {
    notes.push({
      level: "info",
      message:
        "No fallback RPC configured (set RPC_FALLBACK_URL or ENABLE_PUBLIC_RPC_FALLBACK=true " +
        "for read-only fallback to the public mainnet RPC)",
    });
  }

  return { rawRpcUrl, rawHeliusKey, rpcUrl, heliusKey, fallbackUrl, notes };
}

function printEnv(audit) {
  say("=== Prometheus RPC diagnostic ===");
  say("");
  say("Environment");
  say(`  RPC_URL              : ${audit.rpcUrl ? redactRpcUrl(audit.rpcUrl) : "<unset>"}`);
  say(
    `  HELIUS_API_KEY       : ${
      audit.heliusKey ? maskSecret(audit.heliusKey) : "<unset>"
    }${looksLikeHeliusKey(audit.heliusKey) ? " [uuid]" : ""}`,
  );
  say(`  Fallback RPC         : ${audit.fallbackUrl ? redactRpcUrl(audit.fallbackUrl) : "<disabled>"}`);
  say(`  Public fallback flag : ${isEnabledFlag(process.env.ENABLE_PUBLIC_RPC_FALLBACK) ? "enabled" : "disabled"}`);
  say(`  Node                 : ${process.version}`);
  if (audit.notes.length) {
    say("");
    say("Findings");
    for (const note of audit.notes) {
      const icon = note.level === "error" ? "✗" : note.level === "warn" ? "⚠" : "ℹ";
      say(`  ${icon} ${note.message}`);
    }
  }
}

/** Run getHealth + getBalance + getSlot against one endpoint. */
async function probeEndpoint(url) {
  const checks = [];

  const health = await rpcCall(url, "getHealth");
  checks.push({
    name: "getHealth",
    ok: health.ok && health.result === "ok",
    httpStatus: health.httpStatus,
    detail: health.ok ? `result=${JSON.stringify(health.result)}` : health.error,
    durationMs: health.durationMs,
  });

  const balance = await rpcCall(url, "getBalance", [KNOWN_PUBLIC_ADDRESS]);
  checks.push({
    name: "getBalance(111111…)",
    ok: balance.ok && typeof balance.result?.value === "number",
    httpStatus: balance.httpStatus,
    detail: balance.ok ? `lamports=${balance.result?.value}` : balance.error,
    durationMs: balance.durationMs,
  });

  const slot = await rpcCall(url, "getSlot");
  checks.push({
    name: "getSlot",
    ok: slot.ok && Number.isFinite(slot.result),
    httpStatus: slot.httpStatus,
    detail: slot.ok ? `slot=${slot.result}` : slot.error,
    durationMs: slot.durationMs,
  });

  return {
    url: redactRpcUrl(url),
    helius: isHeliusEndpoint(url),
    ok: checks.every((check) => check.ok),
    checks,
  };
}

function printProbe(label, probe) {
  say("");
  say(`${label} — ${probe.url}`);
  for (const check of probe.checks) {
    const status = check.httpStatus != null ? `HTTP ${check.httpStatus}` : "no HTTP";
    say(
      `  ${check.ok ? "✓" : "✗"} ${check.name.padEnd(20)} ${status.padEnd(9)} ` +
        `${check.detail} (${check.durationMs}ms)`,
    );
  }
}

function printSummary({ audit, primary, fallback, readPathOk, exitCode }) {
  say("");
  say("Summary");
  if (primary?.ok) {
    say("  ✓ Primary RPC authorized — getHealth, getBalance and getSlot all succeeded.");
  } else if (primary) {
    const first = primary.checks.find((check) => !check.ok);
    say(`  ✗ Primary RPC failed: ${first?.detail ?? "unknown error"}`);
    if (isHeliusEndpoint(audit.rpcUrl)) {
      say(`    → HELIUS_API_KEY is invalid, revoked, or missing. Generate a key at ${HELIUS_DASHBOARD}`);
      say("    → .env must contain the BARE key, e.g. HELIUS_API_KEY=1234abcd-12ab-34cd-56ef-1234567890ab");
      say("    → RPC_URL should be https://mainnet.helius-rpc.com/?api-key=<same key>");
    }
  }

  if (fallback) {
    if (fallback.ok) {
      say(`  ✓ Fallback RPC responded — ${fallback.url}`);
      say("    → Wallet/balance reads work; signed transactions still use the primary RPC.");
    } else {
      say(`  ✗ Fallback RPC failed: ${fallback.checks.find((check) => !check.ok)?.detail ?? "unknown error"}`);
    }
  } else if (!primary?.ok && !OFFLINE) {
    say("  ℹ No fallback endpoint configured — set RPC_FALLBACK_URL or ENABLE_PUBLIC_RPC_FALLBACK=true");
  }

  say(
    readPathOk
      ? "  ✓ Live Solana read path verified."
      : "  ✗ Live Solana read path NOT verified.",
  );
  say(`  Exit code: ${exitCode}`);
}

async function main() {
  const audit = auditEnv();
  printEnv(audit);

  if (OFFLINE) {
    const exitCode = audit.notes.some((note) => note.level === "error") ? 1 : 0;
    if (JSON_OUTPUT) {
      console.log(JSON.stringify({ generatedAt: new Date().toISOString(), offline: true, env: audit, exitCode }, null, 2));
    } else {
      say("");
      say("Summary");
      say("  ℹ Offline mode — skipped live RPC checks (run without --offline to test the endpoint).");
      say(`  Exit code: ${exitCode}`);
    }
    return exitCode;
  }

  if (!audit.rpcUrl) {
    if (JSON_OUTPUT) {
      console.log(JSON.stringify({ generatedAt: new Date().toISOString(), env: audit, primary: null, exitCode: 1 }, null, 2));
    } else {
      say("");
      printSummary({ audit, primary: null, fallback: null, readPathOk: false, exitCode: 1 });
    }
    return 1;
  }

  say("");
  say("Live checks");
  const primary = await probeEndpoint(audit.rpcUrl);
  printProbe("Primary endpoint", primary);

  let fallback = null;
  const shouldProbeFallback =
    audit.fallbackUrl && (FORCE_FALLBACK || !primary.ok) && audit.fallbackUrl !== audit.rpcUrl;
  if (shouldProbeFallback) {
    fallback = await probeEndpoint(audit.fallbackUrl);
    printProbe("Fallback endpoint", fallback);
  }

  const readPathOk = primary.ok || Boolean(fallback?.ok);
  let exitCode = readPathOk ? 0 : 1;
  if (STRICT && !primary.ok) exitCode = 1;

  printSummary({ audit, primary, fallback, readPathOk, exitCode });

  if (JSON_OUTPUT) {
    console.log(
      JSON.stringify(
        { generatedAt: new Date().toISOString(), env: audit, primary, fallback, readPathOk, exitCode },
        null,
        2,
      ),
    );
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
      console.error(`RPC diagnostic crashed: ${error.stack || error.message}`);
    }
    process.exitCode = 1;
  });

