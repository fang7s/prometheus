/**
 * Regression tests for utils/rpc.js (no network required).
 * Run: node test/test-rpc-utils.js
 */

import assert from "node:assert/strict";
import {
  PUBLIC_SOLANA_RPC,
  describeHttpStatus,
  extractHeliusApiKey,
  getFallbackRpcUrl,
  isEnabledFlag,
  looksLikeHeliusKey,
  normalizeRpcUrl,
  redactRpcUrl,
  rpcCall,
  sanitizeEnvValue,
} from "../utils/rpc.js";

const KEY = "90b8d4f0-2265-4bdc-81c9-1131c6b75f4f";
const HELIUS_URL = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("=== utils/rpc.js ===\n");

test("sanitizeEnvValue strips quotes, whitespace and trailing punctuation", () => {
  assert.equal(sanitizeEnvValue(`  "${HELIUS_URL}"  `), HELIUS_URL);
  assert.equal(sanitizeEnvValue(`' ${KEY} '`), KEY);
  assert.equal(sanitizeEnvValue(`${HELIUS_URL};`), HELIUS_URL);
  assert.equal(sanitizeEnvValue(null), "");
});

test("extractHeliusApiKey handles bare keys, quotes and full URLs", () => {
  assert.equal(extractHeliusApiKey(KEY), KEY);
  assert.equal(extractHeliusApiKey(` "${KEY}" `), KEY);
  assert.equal(extractHeliusApiKey(HELIUS_URL), KEY);
  assert.equal(extractHeliusApiKey(`https://rpc.helius.xyz/?api-key=${KEY}`), KEY);
  assert.equal(extractHeliusApiKey("https://mainnet.helius-rpc.com/"), "");
  assert.equal(extractHeliusApiKey(""), "");
});

test("extractHeliusApiKey repairs the api-key=<url> double paste", () => {
  const doublePasted = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_URL}`;
  assert.equal(extractHeliusApiKey(doublePasted), KEY);
});

test("looksLikeHeliusKey only accepts key-shaped values", () => {
  assert.equal(looksLikeHeliusKey(KEY), true);
  assert.equal(looksLikeHeliusKey("not-a-key"), false);
  assert.equal(looksLikeHeliusKey(HELIUS_URL), false);
  assert.equal(looksLikeHeliusKey(""), false);
});

test("normalizeRpcUrl trims, repairs and preserves valid URLs", () => {
  assert.equal(normalizeRpcUrl(` ${HELIUS_URL} `), HELIUS_URL);
  assert.equal(normalizeRpcUrl(`"${HELIUS_URL}"`), HELIUS_URL);
  assert.equal(
    normalizeRpcUrl(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_URL}`),
    HELIUS_URL,
  );
  assert.equal(normalizeRpcUrl(KEY), HELIUS_URL);
  assert.equal(normalizeRpcUrl("https://api.mainnet-beta.solana.com"), `${PUBLIC_SOLANA_RPC}/`);
  assert.equal(normalizeRpcUrl(""), null);
  assert.equal(normalizeRpcUrl(null), null);
});

test("normalizeRpcUrl injects a key into keyless Helius URLs", () => {
  assert.equal(
    normalizeRpcUrl("https://mainnet.helius-rpc.com/", { apiKey: KEY }),
    HELIUS_URL,
  );
  assert.equal(
    normalizeRpcUrl("https://mainnet.helius-rpc.com/?api-key=", { apiKey: KEY }),
    HELIUS_URL,
  );
});

test("normalizeRpcUrl refuses garbage instead of inventing an endpoint", () => {
  assert.equal(normalizeRpcUrl("ht!tp://mainnet.helius-rpc.com"), null);
  assert.equal(normalizeRpcUrl("not-a-key"), null);
});

test("redactRpcUrl never leaks the API key", () => {
  const redacted = redactRpcUrl(HELIUS_URL);
  assert.equal(redacted.includes(KEY), false);
  assert.match(redacted, /api-key=/);
  assert.equal(redactRpcUrl(""), "<unset>");
});

test("describeHttpStatus explains 401 as a bad/missing Helius key", () => {
  const message = describeHttpStatus(401, HELIUS_URL);
  assert.match(message, /401/);
  assert.match(message, /API key/i);
  assert.match(message, /dashboard\.helius\.dev/);
  assert.match(describeHttpStatus(429, HELIUS_URL), /rate limit/i);
});

test("isEnabledFlag parses boolean-ish env values", () => {
  for (const value of ["1", "true", "TRUE", "yes", "on", " on "]) {
    assert.equal(isEnabledFlag(value), true, `expected truthy for ${value}`);
  }
  for (const value of ["0", "false", "", "nope", undefined]) {
    assert.equal(isEnabledFlag(value), false, `expected falsy for ${value}`);
  }
});

test("getFallbackRpcUrl honours RPC_FALLBACK_URL and the public fallback flag", () => {
  const saved = {
    RPC_FALLBACK_URL: process.env.RPC_FALLBACK_URL,
    FALLBACK_RPC_URL: process.env.FALLBACK_RPC_URL,
    ENABLE_PUBLIC_RPC_FALLBACK: process.env.ENABLE_PUBLIC_RPC_FALLBACK,
  };
  try {
    delete process.env.RPC_FALLBACK_URL;
    delete process.env.FALLBACK_RPC_URL;
    delete process.env.ENABLE_PUBLIC_RPC_FALLBACK;
    assert.equal(getFallbackRpcUrl(), null);

    process.env.ENABLE_PUBLIC_RPC_FALLBACK = "true";
    assert.equal(getFallbackRpcUrl(), PUBLIC_SOLANA_RPC);

    process.env.RPC_FALLBACK_URL = "https://api.mainnet-beta.solana.com/";
    assert.equal(getFallbackRpcUrl(), "https://api.mainnet-beta.solana.com/");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

// rpcCall is async — assert through a promise so a regression exits non-zero.
rpcCall("", "getHealth")
  .then((result) => {
    assert.equal(result.ok, false);
    assert.equal(result.kind, "config");
    assert.match(result.error, /RPC URL/i);
    passed += 1;
    console.log("  ✓ rpcCall resolves (never throws) on a missing endpoint");
    console.log(`\n✓ ${passed} tests passed`);
  })
  .catch((error) => {
    console.error("\n✗ rpcCall regression:", error.message);
    process.exit(1);
  });
