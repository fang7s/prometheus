/**
 * Scheduler helpers: cron-expression building and the single-flight/dedupe
 * decision used by every screening-cycle trigger.
 *
 * Both helpers are pure and side-effect free so the cron cadence and the
 * duplicate-trigger rules are unit-testable without starting the daemon.
 */

/** Minimum cadence for any cron-driven cycle (minutes). */
export const MIN_CRON_INTERVAL_MIN = 1;
/** A trigger that arrives sooner than this after an accepted one is a duplicate. */
export const SCREENING_TRIGGER_DEDUPE_MS = 30_000;

/**
 * Build a *minute-granularity* cron expression.
 *
 * The expression is always 5 fields and the interval is always >= 1 minute, so a
 * mis-typed config value (e.g. `0`, `0.2`, `"11s"`) can never turn the scheduler
 * into a multi-second timer — the classic cause of cycles firing every few
 * seconds. Anything outside 1..59 is clamped (and reported by the caller).
 *
 * @param {number|string} minutes - desired interval in minutes
 * @param {number} [fallback=1] - used when `minutes` is not numeric
 * @returns {string} a 5-field cron expression (minute granularity, interval >= 1m)
 */
export function cronExprForInterval(minutes, fallback = MIN_CRON_INTERVAL_MIN) {
  const raw = Number(minutes);
  const base = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  const clamped = Math.min(59, Math.max(MIN_CRON_INTERVAL_MIN, Math.round(base)));
  return `*/${clamped} * * * *`;
}

/** Clamp an interval to the supported minute range (for logging/reporting). */
export function clampIntervalMin(minutes, fallback = MIN_CRON_INTERVAL_MIN) {
  const raw = Number(minutes);
  const base = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  return Math.min(59, Math.max(MIN_CRON_INTERVAL_MIN, Math.round(base)));
}

// ─── Hour-granularity schedules (Hot Fees digest etc.) ─────────────
/** Supported cadences for the Hot Fees digest (`config.screener.intervalHours`). */
export const SCREENER_INTERVAL_HOURS = Object.freeze([3, 6]);
/** Cadence used when nothing valid is configured. */
export const DEFAULT_SCREENER_INTERVAL_HOURS = 6;

/**
 * Normalize a digest cadence to one of {@link SCREENER_INTERVAL_HOURS}.
 *
 * The Hot Fees digest is a *summary* broadcast, so only 3 h and 6 h are
 * supported; any other value (including `0`, `"abc"`, `null`) snaps to the
 * closest supported option. Ties go to the **longer** interval — sending a
 * summary less often is always the safer failure mode.
 *
 * @param {number|string} value
 * @param {number} [fallback] - used when `value` is not numeric
 * @returns {number} 3 or 6
 */
export function normalizeScreenerIntervalHours(value, fallback = DEFAULT_SCREENER_INTERVAL_HOURS) {
  const allowed = SCREENER_INTERVAL_HOURS;
  const fallbackHours = allowed.includes(Number(fallback)) ? Number(fallback) : DEFAULT_SCREENER_INTERVAL_HOURS;
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return fallbackHours;

  let best = fallbackHours;
  let bestDistance = Infinity;
  for (const option of allowed) {
    const distance = Math.abs(option - raw);
    // `<=` makes a tie pick the later (longer) option.
    if (distance <= bestDistance) {
      best = option;
      bestDistance = distance;
    }
  }
  return best;
}

/** Clamp an hour interval to 1..24 (for logging/reporting). */
export function clampIntervalHours(hours, fallback = DEFAULT_SCREENER_INTERVAL_HOURS) {
  const raw = Number(hours);
  const base = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  return Math.min(24, Math.max(1, Math.round(base)));
}

/**
 * Build an *hour-granularity* cron expression: minute 0, every N hours.
 *
 * `N` is clamped to 1..23; `24` collapses to a once-a-day expression, so a
 * "daily digest" config can never produce an out-of-range hour field. Callers
 * pass the result straight to `cron.schedule(expr, …)`.
 *
 * @param {number|string} hours - desired interval in hours
 * @param {number} [fallback=6] - used when `hours` is not numeric
 * @returns {string} a 5-field cron expression (minute 0 of the selected hours)
 */
export function cronExprForHours(hours, fallback = DEFAULT_SCREENER_INTERVAL_HOURS) {
  const raw = Number(hours);
  const base = Number.isFinite(raw) && raw > 0 ? raw : fallback;
  const rounded = Math.round(base);
  if (rounded >= 24) return "0 0 * * *";
  const clamped = Math.min(23, Math.max(1, rounded));
  return `0 */${clamped} * * *`;
}

/**
 * Decide whether a screening trigger may run.
 *
 * Two independent guards:
 *   1. **single flight** — never spawn a cycle while one is already active
 *      (`isScreeningRunning`), and
 *   2. **dedupe** — a trigger that arrives within `dedupeMs` of the last accepted
 *      one is dropped, so overlapping cron/opportunity/hand-off triggers can't
 *      pile up (the "duplicate cron" symptom).
 *
 * @param {object} state
 * @param {boolean} [state.isRunning]
 * @param {number} [state.lastAcceptedAt] - epoch ms of the last accepted trigger
 * @param {number} [state.now]
 * @param {number} [state.dedupeMs]
 * @returns {{ accept: boolean, reason: string }}
 */
export function shouldAcceptScreeningTrigger({
  isRunning = false,
  lastAcceptedAt = 0,
  now = Date.now(),
  dedupeMs = SCREENING_TRIGGER_DEDUPE_MS,
} = {}) {
  if (isRunning) return { accept: false, reason: "screening cycle already running" };

  const wait = Number(dedupeMs);
  const since = now - Number(lastAcceptedAt || 0);
  if (Number.isFinite(wait) && wait > 0 && since >= 0 && since < wait) {
    return {
      accept: false,
      reason: `duplicate trigger ${Math.round(since / 1000)}s after the last one (dedupe ${Math.round(wait / 1000)}s)`,
    };
  }
  return { accept: true, reason: "ok" };
}
