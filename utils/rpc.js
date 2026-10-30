/**
 * Solana RPC helpers: endpoint / API-key normalization + JSON-RPC probing.
 *
 * Why this exists:
 *  - `HELIUS_API_KEY` is often pasted as a full RPC URL
 *    (`https://mainnet.helius-rpc.com/?api-key=<uuid>`). Every Helius call then
 *    fails with HTTP 401 Unauthorized because the key is not a bare uuid.
 *  - Wrapping quotes / stray whitespace in `.env` or `user-config.json` corrupt
 *    the URL silently and also surface as 401 / 403.
 *  - One shared `fetch`-based JSON-RPC caller so diagnostics can print clean
 *    HTTP status codes instead of throwing opaque errors.
 *
 * This module intentionally has no imports: `config.js` and every tool load it,
 * so it must stay dependency-free (no cycles, no heavy web3 import at boot).
 */

export const PUBLIC_SOLANA_RPC = "https://api.mainnet-beta.solana.com";
export const HELIUS_RPC_BASE = "https://mainnet.helius-rpc.com";
export const DEFAULT_RPC_TIMEOUT_MS = 15_000;

const HELIUS_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC_KEY_PATTERN = /^[A-Za-z0-9_-]{16,}$/;
const API_KEY_PARAM = /^api[-_]?key$/i;

/** True for `http(s)://…` strings (case-insensitive, whitespace-tolerant). */
export function looksLikeUrl(value) {
  return /^https?:\/\//i.test(sanitizeEnvValue(value));
}

/** True when the value looks like a Helius key (uuid, or a long opaque token). */
export function looksLikeHeliusKey(value) {
  const v = sanitizeEnvValue(value);
  if (!v) return false;
  return HELIUS_KEY_PATTERN.test(v) || GENERIC_KEY_PATTERN.test(v);
}

/** True when the endpoint is served by Helius. */
export function isHeliusEndpoint(url) {
  const v = sanitizeEnvValue(url);
  if (!v) return false;
  return /helius/i.test(v);
}

/** Parse a boolean-ish env flag (`1/true/yes/on`). */
export function isEnabledFlag(value) {
  return /^(1|true|yes|on)$/i.test(sanitizeEnvValue(value));
}

/**
 * Strip the things that silently break `.env` values: wrapping quotes, BOM,
 * zero-width / non-breaking spaces, internal whitespace and trailing `;,`.
 */
export function sanitizeEnvValue(raw) {
  if (raw == null) return "";
  let v = String(raw).replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "").trim();

  let previous;
  do {
    previous = v;
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).trim();
    else if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).trim();
  } while (v !== previous);

  v = v.replace(/[;,]+$/, "").trim();
  // API keys and URLs never contain whitespace — drop any that survived.
  return v.replace(/\s+/g, "");
}

/** Mask a secret for logs: keeps the first 4 and last 4 characters. */
export function maskSecret(value) {
  const v = sanitizeEnvValue(value);
  if (!v) return "<empty>";
  if (v.length <= 8) return `${v.slice(0, 2)}…(${v.length} chars)`;
  return `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} chars)`;
}

/**
 * Extract a bare Helius API key from whatever the user pasted.
 * Handles: bare key, quoted key, full RPC URL, `?api-key=…` fragment,
 * and the double-paste case where the *value* of api-key is itself a URL.
 * Returns "" when no key can be recovered.
 */
export function extractHeliusApiKey(raw) {
  const v = sanitizeEnvValue(raw);
  if (!v) return "";

  const match = v.match(/[?&]api[-_]?key=([^&#]+)/i);
  if (match) {
    let candidate = sanitizeEnvValue(match[1]);
    try {
      candidate = sanitizeEnvValue(decodeURIComponent(candidate));
    } catch {
      /* leave the raw candidate when it is not valid percent-encoding */
    }
    if (looksLikeUrl(candidate)) return extractHeliusApiKey(candidate);
    return candidate.replace(/^api[-_]?key=/i, "");
  }

  if (looksLikeUrl(v)) return "";
  return v.replace(/^api[-_]?key=/i, "").replace(/^bearer\s+/i, "");
}

/**
 * Normalize an RPC endpoint into a usable URL.
 *
 * - trims quotes / whitespace / trailing punctuation
 * - accepts a bare Helius key and expands it to the mainnet RPC URL
 * - repairs `?api-key=<full url>` double-pastes
 * - injects `apiKey` into keyless Helius URLs when one is available
 *
 * Returns `null` when the value is empty or cannot be repaired.
 */
export function normalizeRpcUrl(raw, { apiKey } = {}) {
  const value = sanitizeEnvValue(raw);
  if (!value) return null;

  if (!looksLikeUrl(value)) {
    // A bare Helius key pasted into RPC_URL.
    if (looksLikeHeliusKey(value)) return buildHeliusRpcUrl(value);
    const key = extractHeliusApiKey(apiKey);
    return key ? buildHeliusRpcUrl(key) : null;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const paramName = [...url.searchParams.keys()].find((k) => API_KEY_PARAM.test(k));
  const bareKey = extractHeliusApiKey(apiKey);

  if (paramName) {
    const current = url.searchParams.get(paramName);
    const repaired = extractHeliusApiKey(current) || bareKey;
    if (repaired) url.searchParams.set(paramName, repaired);
    else url.searchParams.delete(paramName);
  } else if (isHeliusEndpoint(url.hostname) && bareKey) {
    url.searchParams.set("api-key", bareKey);
  }

  return url.toString();
}

/** Redacted endpoint for logs: `?api-key=…` values are masked (not URL-encoded). */
export function redactRpcUrl(raw) {
  const value = sanitizeEnvValue(raw);
  if (!value) return "<unset>";
  let url;
  try {
    url = new URL(value);
  } catch {
    return `<invalid:${value.slice(0, 24)}>`;
  }
  const params = [...url.searchParams.entries()].map(([key, paramValue]) =>
    /key|token|secret|pass/i.test(key) ? `${key}=${maskSecret(paramValue)}` : `${key}=${paramValue}`,
  );
  const query = params.length ? `?${params.join("&")}` : "";
  return `${url.origin}${url.pathname}${query}${url.hash || ""}`;
}

/** Primary endpoint from `RPC_URL` (repaired), or `null`. */
export function resolveRpcUrl() {
  return normalizeRpcUrl(process.env.RPC_URL, { apiKey: process.env.HELIUS_API_KEY });
}

/**
 * Optional read-only fallback endpoint.
 * `RPC_FALLBACK_URL` / `FALLBACK_RPC_URL` wins; otherwise the public mainnet
 * RPC is used when `ENABLE_PUBLIC_RPC_FALLBACK` is truthy.
 */
export function getFallbackRpcUrl() {
  const explicit = normalizeRpcUrl(
    process.env.RPC_FALLBACK_URL || process.env.FALLBACK_RPC_URL,
    { apiKey: process.env.HELIUS_API_KEY },
  );
  if (explicit) return explicit;
  return isEnabledFlag(process.env.ENABLE_PUBLIC_RPC_FALLBACK) ? PUBLIC_SOLANA_RPC : null;
}

/** Human-readable explanation for a non-2xx HTTP response. */
export function describeHttpStatus(status, endpoint = "") {
  const helius = isHeliusEndpoint(endpoint);
  switch (status) {
    case 401:
      return helius
        ? "HTTP 401 Unauthorized — Helius rejected the API key: it is missing, malformed, or revoked. " +
          "HELIUS_API_KEY must be the bare key (uuid) from https://dashboard.helius.dev, not a URL."
        : "HTTP 401 Unauthorized — the RPC rejected the request. Check the API key / auth header.";
    case 403:
      return "HTTP 403 Forbidden — the key is valid but not allowed to call this endpoint (plan/permissions).";
    case 404:
      return "HTTP 404 Not Found — wrong RPC host or path (check the URL format).";
    case 429:
      return "HTTP 429 Too Many Requests — RPC rate limit hit. Back off, or use a paid Helius plan.";
    case 502:
    case 503:
    case 504:
      return `HTTP ${status} — RPC provider is temporarily unavailable. Retry shortly.`;
    default:
      return `HTTP ${status} — unexpected RPC response.`;
  }
}

function truncate(text, limit = 300) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}


/** Build the canonical Helius mainnet RPC URL from a bare key. */
export function buildHeliusRpcUrl(apiKey) {
  const key = extractHeliusApiKey(apiKey);
  if (!key || looksLikeUrl(key)) return null;
  return `${HELIUS_RPC_BASE}/?api-key=${encodeURIComponent(key)}`;
}

/**
 * Perform a single JSON-RPC call and report the outcome instead of throwing.
 *
 * @returns {Promise<{
 *   ok: boolean, kind: "ok"|"http"|"rpc"|"network"|"timeout"|"config",
 *   httpStatus: number|null, status: number|null, result: any, error: string|null,
 *   body: any, method: string, endpoint: string|null, durationMs: number,
 * }>}
 */
export async function rpcCall(url, method, params = [], { timeoutMs = DEFAULT_RPC_TIMEOUT_MS } = {}) {
  const startedAt = Date.now();
  const endpoint = normalizeRpcUrl(url, { apiKey: process.env.HELIUS_API_KEY });
  const elapsed = () => Date.now() - startedAt;

  if (!endpoint) {
    return {
      ok: false,
      kind: "config",
      httpStatus: null,
      status: null,
      result: null,
      error: "RPC URL is not set or could not be parsed (check RPC_URL in .env).",
      body: null,
      method,
      endpoint: null,
      durationMs: 0,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });

    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    if (!res.ok) {
      return {
        ok: false,
        kind: "http",
        httpStatus: res.status,
        status: res.status,
        result: null,
        error: describeHttpStatus(res.status, endpoint),
        body: body ?? truncate(text),
        method,
        endpoint,
        durationMs: elapsed(),
      };
    }

    if (body && body.error) {
      return {
        ok: false,
        kind: "rpc",
        httpStatus: res.status,
        status: res.status,
        result: null,
        error: `JSON-RPC error ${body.error.code ?? "?"}: ${body.error.message ?? "unknown error"}`,
        body,
        method,
        endpoint,
        durationMs: elapsed(),
      };
    }

    return {
      ok: true,
      kind: "ok",
      httpStatus: res.status,
      status: res.status,
      result: body?.result ?? null,
      error: null,
      body,
      method,
      endpoint,
      durationMs: elapsed(),
    };
  } catch (error) {
    const aborted = error?.name === "AbortError";
    return {
      ok: false,
      kind: aborted ? "timeout" : "network",
      httpStatus: null,
      status: null,
      result: null,
      error: aborted
        ? `Request timed out after ${timeoutMs}ms`
        : `Network error: ${error?.message || String(error)}`,
      body: null,
      method,
      endpoint,
      durationMs: elapsed(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** One-line summary of a failed `rpcCall` result (safe for logs). */
export function formatRpcFailure(result) {
  if (!result || result.ok) return "";
  const status = result.httpStatus ? `HTTP ${result.httpStatus} — ` : "";
  const where = result.endpoint ? ` (${redactRpcUrl(result.endpoint)})` : "";
  return `${result.method} failed: ${status}${result.error}${where}`;
}

