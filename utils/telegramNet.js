/**
 * Bot API addressing + transport-error decoding.
 *
 * `fetch()` collapses every network failure into `TypeError: fetch failed`; the
 * actionable code (ENOTFOUND, ECONNREFUSED, ETIMEDOUT, CERT_*) only lives on
 * `error.cause` (sometimes nested inside an `AggregateError` for multi-address
 * hosts). Without decoding it, a log line reads "sendMessage failed: fetch
 * failed" and says nothing about whether DNS, TCP, TLS, an egress firewall or a
 * bad token is the problem — which is exactly the ambiguity `TELEGRAM_ERROR`
 * used to have in production.
 *
 * Everything here is pure and dependency-free so it can be unit-tested without
 * network access and reused by `scripts/telegram-diagnostic.js`.
 */

/** Bot API origin used when `TELEGRAM_API_BASE` is unset. */
export const DEFAULT_TELEGRAM_API_BASE = "https://api.telegram.org";

/**
 * Deadline for every non-polling Bot API request (`sendMessage`,
 * `editMessageText`, `answerCallbackQuery`, media edits …) — 15 s.
 *
 * The budget is deliberately generous: inline-keyboard taps used to die with
 * `timed out (no response from the Bot API)` when Telegram's gateway or an
 * intermediate relay was slow, leaving the user on a stale card even though the
 * handler had already finished. `editMessageText` in particular now retries once
 * after this deadline expires (see `telegram.js#postTelegramUi`).
 *
 * `getUpdates` is the single exception: long polling keeps its own 40 s window.
 */
export const TELEGRAM_HTTP_TIMEOUT_MS = 15_000;

const DEFAULT_PORTS = { "https:": 443, "http:": 80 };

/**
 * Resolve the Bot API origin from `TELEGRAM_API_BASE` (default
 * `https://api.telegram.org`).
 *
 * Some hosts cannot reach `api.telegram.org` at all (country-level block or a
 * hosting-provider egress firewall). Pointing `TELEGRAM_API_BASE` at a reachable
 * reverse proxy / Cloudflare Worker that forwards to Telegram restores the bot
 * without touching a single call site. Invalid values fall back to the default
 * instead of taking the bot offline; a pasted full bot URL keeps only its origin.
 */
export function resolveTelegramApiBase(raw = process.env.TELEGRAM_API_BASE) {
  const value = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return DEFAULT_TELEGRAM_API_BASE;
  // Tolerate a pasted bot URL (https://host/bot<id>:<secret>) — keep the origin.
  const origin = value.replace(/\/bot\d+:[^/]+$/i, "");
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return DEFAULT_TELEGRAM_API_BASE;
    }
    if (!parsed.hostname) return DEFAULT_TELEGRAM_API_BASE;
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return DEFAULT_TELEGRAM_API_BASE;
  }
}

/** Full Bot API method URL (`<base>/bot<token>/<method>`). */
export function telegramBotUrl(method, { apiBase, token } = {}) {
  const base = resolveTelegramApiBase(apiBase);
  return `${base}/bot${String(token ?? "")}/${String(method ?? "").replace(/^\/+/, "")}`;
}

/** Host/port the client must reach — used by the diagnostic probe. */
export function parseApiBaseTarget(apiBase = process.env.TELEGRAM_API_BASE) {
  const base = resolveTelegramApiBase(apiBase);
  const url = new URL(base);
  const port = Number(url.port) || DEFAULT_PORTS[url.protocol] || 443;
  return { base, protocol: url.protocol, host: url.hostname, port };
}

/** Mask a bot token for logs/diagnostics: `8920…4OqA`. */
export function maskBotToken(token) {
  const value = String(token ?? "").trim();
  if (!value) return "<unset>";
  if (value.length <= 8) return `${value.slice(0, 2)}…${value.slice(-2)}`;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

const ERROR_CODE_PRIORITY = [
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "EPROTO",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
];

/**
 * Flatten an error (plus `cause` and `AggregateError.errors`, recursively) into
 * the transport codes and endpoints undici tried.
 */
export function telegramErrorDetails(error) {
  const codes = [];
  const endpoints = [];

  const pushUnique = (list, value) => {
    const text = String(value ?? "").trim();
    if (text && !list.includes(text)) list.push(text);
  };

  const walk = (err, depth = 0) => {
    if (!err || depth > 5 || typeof err !== "object") return;
    pushUnique(codes, err.code);
    // DNS lookup failures carry the host name but no address.
    if (err.address) {
      pushUnique(endpoints, `${err.address}${err.port ? `:${err.port}` : ""}`);
    } else if (err.hostname) {
      pushUnique(endpoints, String(err.hostname));
    }
    for (const nested of Array.isArray(err.errors) ? err.errors : []) walk(nested, depth + 1);
    walk(err.cause, depth + 1);
  };
  walk(error);

  const rank = (code) => {
    const index = ERROR_CODE_PRIORITY.indexOf(code);
    return index === -1 ? ERROR_CODE_PRIORITY.length : index;
  };
  const ordered = [...codes].sort((a, b) => rank(a) - rank(b));

  return { codes: ordered, endpoints };
}

/**
 * Transport codes that mean "no usable response" — the socket timed out, the
 * request was aborted at its deadline, or the connection died mid-flight.
 * Every Bot API edit/ack is idempotent, so these can be retried safely.
 */
export const TELEGRAM_TRANSIENT_CODES = Object.freeze([
  "ETIMEDOUT",
  "ABORT_ERR",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "ECONNRESET",
  "EPIPE",
]);

/** `AbortSignal.timeout()` / classic abort error names. */
const TRANSIENT_ERROR_NAMES = Object.freeze(["TimeoutError", "AbortError"]);

/**
 * True when a Bot API failure is transient — a timeout (`AbortSignal.timeout()`
 * surfaces as a DOMException named `TimeoutError`), an `AbortError`, `ETIMEDOUT`
 * or a socket that died mid-request.
 *
 * Such failures must never break the active UI: `telegram.js` retries UI edits
 * once and then logs a warning instead of tearing the view down. Pure and
 * offline-testable — accepts the raw undici `TypeError("fetch failed")` (the real
 * code lives on `error.cause`, sometimes inside an `AggregateError`).
 */
export function isTransientTelegramError(error) {
  if (!error) return false;

  let transientByName = false;
  const walk = (err, depth = 0) => {
    if (!err || depth > 5 || typeof err !== "object") return;
    if (!transientByName && TRANSIENT_ERROR_NAMES.includes(String(err.name || ""))) {
      transientByName = true;
    }
    for (const nested of Array.isArray(err.errors) ? err.errors : []) walk(nested, depth + 1);
    walk(err.cause, depth + 1);
  };
  walk(error);
  if (transientByName) return true;

  const { codes } = telegramErrorDetails(error);
  return codes.some((code) => TELEGRAM_TRANSIENT_CODES.includes(code));
}

/**
 * One-line, actionable explanation for a transport code.
 * Returns `""` for unknown codes so callers can skip the hint entirely.
 */
export function telegramErrorHint(codes) {
  const list = (Array.isArray(codes) ? codes : [codes]).map((code) => String(code || "").toUpperCase());
  const has = (predicate) => list.some(predicate);

  if (has((code) => /^CERT_|^ERR_TLS|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/.test(code) || code === "EPROTO")) {
    return "TLS handshake rejected — check the host clock (date -u) and any TLS-intercepting proxy/firewall";
  }
  if (has((code) => code === "ENOTFOUND" || code === "EAI_AGAIN")) {
    return "DNS cannot resolve the Bot API host — fix /etc/resolv.conf or set TELEGRAM_API_BASE to a reachable proxy";
  }
  if (has((code) => code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "EADDRNOTAVAIL")) {
    return "no route to the Bot API host — the host is offline, IPv6-only or firewalled; set TELEGRAM_API_BASE to a reachable proxy";
  }
  if (has((code) => code === "ECONNREFUSED")) {
    return "connection refused — an egress firewall/blocking middlebox is rejecting the Bot API port";
  }
  if (has((code) => code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET" || code === "UND_ERR_CLOSED")) {
    return "connection dropped mid-request — egress to the Bot API is being filtered; set TELEGRAM_API_BASE to a reachable proxy";
  }
  if (
    has(
      (code) =>
        code === "ETIMEDOUT" ||
        code === "UND_ERR_CONNECT_TIMEOUT" ||
        code === "UND_ERR_HEADERS_TIMEOUT" ||
        code === "UND_ERR_BODY_TIMEOUT",
    )
  ) {
    return "connect/read timeout — the Bot API is blocked or unreachable from this host; set TELEGRAM_API_BASE to a reachable proxy";
  }
  return "";
}

/**
 * Deepest distinct `cause.message` — `fetch failed` alone is useless, the real
 * text ("getaddrinfo ENOTFOUND api.telegram.org", "connect ECONNREFUSED …")
 * lives one or two levels down.
 */
function deepestCauseMessage(error) {
  let message = "";
  let current = error?.cause ?? (Array.isArray(error?.errors) ? error.errors[0] : null);
  let depth = 0;
  while (current && depth < 5 && typeof current === "object") {
    if (typeof current.message === "string" && current.message) message = current.message;
    const next = current.cause ?? (Array.isArray(current.errors) ? current.errors[0] : null);
    if (!next || next === current) break;
    current = next;
    depth += 1;
  }
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

/**
 * `fetch failed: getaddrinfo ENOTFOUND api.telegram.org [ENOTFOUND] — DNS cannot resolve …`.
 * Never throws, and errors carry hosts/addresses, never the bot token.
 */
export function describeTelegramError(error) {
  if (!error) return "unknown error";
  const name = String(error.name || "");
  const code = String(error.code || "");
  const timedOut =
    name === "TimeoutError" || name === "AbortError" || code === "ETIMEDOUT" || code === "ABORT_ERR";

  const base = timedOut ? "timed out (no response from the Bot API)" : String(error.message || error);

  const { codes, endpoints } = telegramErrorDetails(error);
  const cause = deepestCauseMessage(error);
  const causeDetail = cause && cause !== base ? `: ${cause}` : "";
  const bracket = [codes.join(", "), endpoints.length ? `@ ${endpoints.join(", ")}` : ""]
    .filter(Boolean)
    .join(" ");
  const hint = telegramErrorHint(codes);

  return `${base}${causeDetail}${bracket ? ` [${bracket}]` : ""}${hint ? ` — ${hint}` : ""}`;
}
