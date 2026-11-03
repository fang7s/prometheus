/**
 * Isolation + fallback plumbing for the interactive `/pool` command.
 *
 * `/pool` can touch an LLM, the Meteora API, Solana RPC and smart-wallet lookups.
 * None of those may hold the Telegram handler hostage: the whole command runs as
 * an *isolated task* raced against a hard 8 s deadline. When the deadline wins,
 * the caller replies with the timeout notice and a cheap metrics snapshot
 * (`formatBasicPoolMetrics`) while the abandoned task finishes in the background.
 *
 * Everything here is pure/promise-based and side-effect free (only logging), so
 * the time-out contract is unit-testable without Telegram or an LLM.
 */

import { log } from "../logger.js";

/** Absolute ceiling for one interactive `/pool` command. */
export const POOL_TIMEOUT_MS = 8_000;

/** Exact user-facing notice required when the deadline is hit. */
export const POOL_TIMEOUT_MESSAGE =
  "⚠️ Screening timed out (RPC/LLM slow). Showing basic pool metrics instead.";

/**
 * Run `task` in isolation, raced against `timeoutMs`.
 *
 * - The task is never force-cancelled (an in-flight LLM HTTP call cannot be), but
 *   the awaited promise resolves at the deadline, so the Telegram handler — and
 *   therefore the event loop — is released immediately.
 * - The task's own settlement is always handled (mapped to `{ok:false}`), so a
 *   late failure can never surface as an unhandled rejection and kill the process.
 * - The deadline timer is cleared on settle, so nothing is left on the loop.
 *
 * @param {() => Promise<any>} task
 * @param {{ timeoutMs?: number, label?: string, onDeadline?: () => void }} [options]
 *   `onDeadline` runs the moment the budget is exhausted — pass
 *   `() => controller.abort()` so the detached work stops before it can act
 *   (e.g. deploy) after the user was told the run timed out.
 * @returns {Promise<
 *   { ok: true, value: any, ms: number } |
 *   { ok: false, error: Error, ms: number } |
 *   { ok: false, timedOut: true, label: string, ms: number }
 * >}
 */
export function runIsolatedTask(task, { timeoutMs = POOL_TIMEOUT_MS, label = "task", onDeadline = null } = {}) {
  const startedAt = Date.now();

  const settled = Promise.resolve()
    .then(() => task())
    .then(
      (value) => ({ ok: true, value, ms: Date.now() - startedAt }),
      (error) => ({ ok: false, error, ms: Date.now() - startedAt }),
    );

  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      try {
        onDeadline?.();
      } catch (error) {
        log("pool_warn", `[${label}] onDeadline handler failed: ${error?.message || error}`);
      }
      resolve({ timedOut: true });
    }, Math.max(1, Number(timeoutMs) || POOL_TIMEOUT_MS));
  });

  return Promise.race([settled, deadline])
    .then((result) => {
      if (result?.timedOut) {
        log("pool_warn", `[${label}] exceeded ${timeoutMs}ms — detached, event loop released`);
        return { ok: false, timedOut: true, label, ms: Date.now() - startedAt };
      }
      if (result.ok === false) {
        log("pool_warn", `[${label}] failed after ${result.ms}ms: ${result.error?.message || result.error}`);
      }
      return result;
    })
    .finally(() => {
      if (timer) clearTimeout(timer);
    });
}

/**
 * Cooperative cancellation token for isolated work.
 * `runIsolatedTask(..., { onDeadline: () => token.abort() })` flips `aborted` so the
 * detached task can bail out before performing any side effect (deploy/close).
 */
export function createAbortToken() {
  let aborted = false;
  return {
    get aborted() {
      return aborted;
    },
    abort() {
      aborted = true;
    },
    /** Throws if the deadline already fired — call before side effects. */
    throwIfAborted(label = "task") {
      if (aborted) {
        const error = new Error(`${label} aborted after the deadline`);
        error.name = "AbortError";
        error.code = "ABORT_ERR";
        throw error;
      }
    },
  };
}

/**
 * Cheap "basic pool metrics" block used as the `/pool` fallback UI.
 * Reads whatever the screener already cached — no network calls, so it is always
 * fast enough to answer right after a timeout.
 *
 * @param {object[]} candidates - cached screening candidates (raw API shape)
 * @param {{ limit?: number, updatedAt?: string|null, reason?: string|null }} [options]
 * @returns {string} plain-text block for Telegram
 */
export function formatBasicPoolMetrics(candidates = [], { limit = 5, updatedAt = null, reason = null } = {}) {
  const list = (Array.isArray(candidates) ? candidates : []).filter(Boolean);
  const head = reason ? `📊 Basic pool metrics (${reason})` : "📊 Basic pool metrics";

  if (list.length === 0) {
    return [
      head,
      "",
      "No cached pool metrics yet — the screener has not produced a snapshot.",
      "Try /pool again in a moment, or /lp to browse pools.",
    ].join("\n");
  }

  const lines = list.slice(0, Math.max(1, Number(limit) || 5)).map((pool, index) => {
    const name = pool.name || pool.pool_name || "unknown";
    const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? pool.feeTvl ?? "?";
    const volume = pool.volume_window ?? pool.volume_24h ?? pool.volume ?? "?";
    const tvl = pool.tvl ?? pool.active_tvl ?? "?";
    const inRange = pool.active_pct ?? "?";
    const organic = pool.organic_score ?? pool.organic ?? "?";
    return `${index + 1}. ${name} | fee/aTVL ${feeTvl}% | vol $${volume} | TVL $${tvl} | in-range ${inRange}% | organic ${organic}`;
  });

  const age = updatedAt ? ` — snapshot from ${new Date(updatedAt).toLocaleString("en-US", { hour12: false })}` : "";
  return `${head}${age}\n\n${lines.join("\n")}`;
}
