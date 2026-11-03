/**
 * Strict promise deadlines for network-bound work (RPC, HTTP APIs, canvas).
 *
 * The interactive Telegram menu must never hang on a stalled RPC or API call:
 * every such call is raced against a hard deadline (`withTimeout`) so the caller
 * — and therefore the poll loop — is released immediately. The underlying
 * request is not force-cancelled (web3/HTTP clients do not expose a cancel
 * handle), but nothing downstream waits for it any more.
 */

/** Raised when an awaited operation misses its deadline. */
export class TimeoutError extends Error {
  constructor(label = "operation", timeoutMs = 0) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.code = "ETIMEDOUT";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * True for our own TimeoutError, `AbortSignal.timeout()` (DOMException named
 * "TimeoutError") and classic abort errors.
 */
export function isTimeoutError(error) {
  if (!error) return false;
  if (error instanceof TimeoutError) return true;
  const name = String(error.name || "");
  if (name === "TimeoutError" || name === "AbortError") return true;
  const code = String(error.code || "");
  return code === "ETIMEDOUT" || code === "ABORT_ERR" || code === "UND_ERR_CONNECT_TIMEOUT";
}

/**
 * Race `promise` against a strict deadline.
 *
 * @param {Promise|any} promise - work to bound
 * @param {number} timeoutMs - deadline in ms (non-positive disables the guard)
 * @param {string} [label] - operation name used in the error/log
 * @returns {Promise} the promise result, or rejects with {@link TimeoutError}
 */
export function withTimeout(promise, timeoutMs, label = "operation") {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(promise);

  let timer = null;
  const deadline = new Promise((_, reject) => {
    // Deliberately NOT unref'd: the deadline must fire even when the stalled
    // operation holds no other handles (otherwise the awaited promise could be
    // abandoned instead of rejected). It is cleared as soon as either side settles.
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });

  return Promise.race([Promise.resolve(promise), deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Convenience wrapper: run `fn` (sync or async) under a deadline.
 */
export function runWithTimeout(fn, timeoutMs, label = "operation") {
  let result;
  try {
    result = typeof fn === "function" ? fn() : fn;
  } catch (error) {
    return Promise.reject(error);
  }
  return withTimeout(result, timeoutMs, label);
}
