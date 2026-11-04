/**
 * Pure Telegram message formatting primitives.
 *
 * This module owns the ASCII/Unicode layout used by the *text* views:
 *
 *   ├─ tree branching (`├─` / `└─`) for per-position rows
 *   ━━━ section dividers between header, body and summary
 *   [██████░░░░] 65%  progress bars for range concentration
 *   <code>…</code>    monospace blocks for values, prices, PnL and symbols
 *
 * Hard rules:
 *   1. **Zero I/O.** No `fetch`, no RPC, no `config`, no imports at all. Every
 *      helper is synchronous and operates on the caller's in-memory snapshot, so
 *      a `/positions` render or a management alert can never add latency.
 *   2. **Escaping safety.** Every interpolated value goes through
 *      {@link escapeHtml} (via {@link code} / {@link bold}) so Telegram's HTML
 *      parser can never reject the message because a token symbol contains
 *      `&`, `<` or `>`.
 *
 * The plain-text management report uses the same primitives without the HTML
 * wrappers (Telegram's plain `sendMessage` path does not parse markup).
 */

/** Section rule used to separate header, position blocks and summaries. */
export const SECTION_DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━━━━━";

/** Default number of slots in a range-concentration progress bar. */
export const PROGRESS_BAR_SLOTS = 10;

/** Telegram hard-caps `sendMessage.text` at 4096 characters. */
export const MESSAGE_LIMIT = 4_000;

/** Branch glyphs for every row but the last / for the last row. */
const TREE_TEE = "├─";
const TREE_ELBOW = "└─";

// ─── Escaping + monospace wrappers ────────────────────────────────
/**
 * Escape the three characters Telegram's HTML parser treats as markup.
 * Applied to every dynamic value before it reaches the Bot API.
 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** `<code>…</code>` — monospace block for values, prices, PnL and symbols. */
export function code(value) {
  return `<code>${escapeHtml(value)}</code>`;
}

/** `<b>…</b>` — escaped bold text. */
export function bold(value) {
  return `<b>${escapeHtml(value)}</b>`;
}

// ─── Number formatting ────────────────────────────────────────────
export function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "$0";
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export function formatSolAmount(value, digits = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "?";
  if (n === 0) return "0";
  if (n < 0.001) return n.toExponential(2);
  return n.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

/** `$4.20` / `0.42 SOL` — `?` for missing values. */
export function formatMoney(value, mode = "USD") {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return "?";
  return mode === "SOL" ? `${formatSolAmount(n)} SOL` : formatUsd(n);
}

/** `$1.25M` / `$940.0K` / `$12.30` (null for missing/zero values). */
export function formatCompactUsd(value) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

/** Finite number or `null` — `Number(null)` / `Number("")` are 0, which would fake data. */
function toFiniteNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** `+8.10%` / `-8.10%` / `?` — signed PnL percentage. */
export function formatSignedPct(value) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return "?";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

// ─── Range geometry + progress bars ───────────────────────────────
/**
 * Relative position (0-100 %) of the active bin inside the user's min/max bins.
 * 0 % = active bin sits on the lower bound, 100 % = on/above the upper bound.
 *
 * Single-sided SOL limit ranges (both bounds BELOW the active price) correctly
 * read 100 %: the price is above the whole range, so the position is filled to
 * the top. Ranges entirely above the active price read 0 %.
 */
export function computeRangePositionPct({ lowerBinId = null, upperBinId = null, activeBinId = null } = {}) {
  // `Number(null)` is 0 — guard missing bins explicitly so an unknown range can
  // never masquerade as "active bin at the bottom of the range".
  const toBin = (value) => {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  const lower = toBin(lowerBinId);
  const upper = toBin(upperBinId);
  const active = toBin(activeBinId);
  if (lower == null || upper == null || active == null) return null;
  const min = Math.min(lower, upper);
  const max = Math.max(lower, upper);
  // Single-bin range: 100 % only once the price reached that bin.
  if (max === min) return active >= max ? 100 : 0;
  const pct = ((active - min) / (max - min)) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/** `[██████░░░░]` — 10 slots, floored so 65 % fills 6 blocks. */
export function renderProgressBar(pct, slots = PROGRESS_BAR_SLOTS) {
  const total = Math.max(1, Math.round(Number(slots) || PROGRESS_BAR_SLOTS));
  const value = Number(pct);
  const ratio = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  const filled = Math.max(0, Math.min(total, Math.floor((ratio / 100) * total)));
  return `[${"█".repeat(filled)}${"░".repeat(total - filled)}]`;
}

/** `[██████████] 100%` (null when the percentage is unknown). */
export function formatProgressBar(pct, slots = PROGRESS_BAR_SLOTS) {
  if (pct == null || pct === "") return null;
  const value = Number(pct);
  if (!Number.isFinite(value)) return null;
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return `${renderProgressBar(clamped, slots)} ${clamped}%`;
}

/** Bold range badge for OPEN positions (text only — PnL cards are for closes). */
export function formatRangeStatus(inRange) {
  if (inRange === true) return "🟢 <b>IN RANGE</b>";
  if (inRange === false) return "🔴 <b>OUT OF RANGE</b>";
  return "⚪ <b>RANGE UNKNOWN</b>";
}

/** Plain-text range badge (management report — that path does not parse HTML). */
export function rangeStatusText(inRange, minutesOutOfRange = null) {
  if (inRange === true) return "🟢 IN RANGE";
  if (inRange === false) {
    const minutes = Number(minutesOutOfRange);
    return Number.isFinite(minutes) ? `🔴 OUT OF RANGE ${minutes}m` : "🔴 OUT OF RANGE";
  }
  return "⚪ RANGE UNKNOWN";
}

// ─── Tree layout ──────────────────────────────────────────────────
/**
 * Render rows as a tree: every row is prefixed with `├─` except the last one,
 * which uses `└─`. Rows may be plain strings or `{ label, value }` objects;
 * `null`/empty rows are dropped so optional metrics never leave a dangling
 * branch behind.
 */
export function formatTreeRows(rows = []) {
  const entries = (Array.isArray(rows) ? rows : [])
    .map((row) => {
      if (row == null) return null;
      if (typeof row === "string") return row.trim() ? row.trim() : null;
      const label = row.label == null ? "" : String(row.label);
      const value = row.value == null ? "" : String(row.value);
      const text = value ? `${label} ${value}` : label;
      return text.trim() ? text : null;
    })
    .filter(Boolean);

  return entries
    .map((text, index) => `${index === entries.length - 1 ? TREE_ELBOW : TREE_TEE} ${text}`)
    .join("\n");
}

// ─── Message builders ─────────────────────────────────────────────
/**
 * One open position as a tree block (HTML):
 *
 *   <b>1</b> · <code>Anakin/SOL</code> · 🟢 <b>IN RANGE</b>
 *   ├─ 💵 Value <code>$52.40</code>
 *   ├─ 📈 PnL <code>+$4.20</code> <code>+8.10%</code>
 *   ├─ 🎁 Fees <code>$1.15</code>
 *   ├─ 📍 Range <code>[██████████]</code> <code>100%</code>
 *   ├─ 🧢 MC <code>$1.25M</code>
 *   └─ ⏱ Age <code>42m</code> · 🆔 <code>AbCdEfGh…</code>
 */
export function formatOpenPositionBlock(position, index = 0, mode = "USD") {
  const pnlUsd = toFiniteNumber(position?.pnl_usd);
  const pnlPct = toFiniteNumber(position?.pnl_pct);
  const pnlLabel = pnlUsd != null
    ? `${pnlUsd < 0 ? "-" : pnlUsd > 0 ? "+" : ""}${formatMoney(Math.abs(pnlUsd), mode)}`
    : "?";
  const rangePct = computeRangePositionPct({
    lowerBinId: position?.lower_bin,
    upperBinId: position?.upper_bin,
    activeBinId: position?.active_bin,
  });
  const mcap = formatCompactUsd(position?.mcap);
  const age = toFiniteNumber(position?.age_minutes);
  const oorMinutes = toFiniteNumber(position?.minutes_out_of_range);
  const positionId = position?.position ? `${String(position.position).slice(0, 8)}…` : null;

  const rows = [
    { label: "💵 Value", value: code(formatMoney(position?.total_value_usd, mode)) },
    {
      label: "📈 PnL",
      value: `${code(pnlLabel)}${pnlPct != null ? ` ${code(formatSignedPct(pnlPct))}` : ""}`,
    },
    { label: "🎁 Fees", value: code(formatMoney(position?.unclaimed_fees_usd, mode)) },
    rangePct != null
      ? { label: "📍 Range", value: `${code(renderProgressBar(rangePct))} ${code(`${rangePct}%`)}` }
      : null,
    mcap ? { label: "🧢 MC", value: code(mcap) } : null,
    position?.in_range === false && oorMinutes != null
      ? { label: "🚨 OOR", value: code(`${oorMinutes}m`) }
      : null,
    {
      label: "⏱ Age",
      value: `${code(age != null ? `${age}m` : "?")}${positionId ? ` · 🆔 ${code(positionId)}` : ""}`,
    },
  ];

  return [
    `<b>${index + 1}</b> · ${code(position?.pair || "unknown pool")} · ${formatRangeStatus(position?.in_range)}`,
    formatTreeRows(rows),
  ].join("\n");
}

/**
 * `/positions` — open positions in the structured tree layout (HTML).
 *
 * Pure local formatting: the caller passes the already-fetched snapshots
 * (optionally enriched with `mcap`), nothing here touches the network.
 */
export function formatOpenPositionsMessage({
  positions = [],
  totalPositions = null,
  mode = "USD",
  maxPositions = 0,
} = {}) {
  const list = Array.isArray(positions) ? positions : [];
  const reportedTotal = Number(totalPositions);
  const total = Number.isFinite(reportedTotal) ? reportedTotal : list.length;
  const cap = Number(maxPositions) > 0 ? `/${Number(maxPositions)}` : "";
  const header = [`📊 ${bold("OPEN POSITIONS")} · ${code(`${total}${cap}`)}`, SECTION_DIVIDER];

  if (list.length === 0) {
    return [...header, "", "🫙 <b>No open positions.</b>", "", "/pool to screen for a new entry"].join("\n");
  }

  const totalValue = list.reduce((sum, position) => sum + (Number(position?.total_value_usd) || 0), 0);
  const totalFees = list.reduce((sum, position) => sum + (Number(position?.unclaimed_fees_usd) || 0), 0);
  const blocks = list.map((position, index) => formatOpenPositionBlock(position, index, mode));

  const footer = [
    SECTION_DIVIDER,
    `💼 ${code(`${total}${cap}`)} open · 💵 ${code(formatMoney(totalValue, mode))} · 🎁 ${code(formatMoney(totalFees, mode))}`,
    "/close &lt;n&gt; to close · /set &lt;n&gt; &lt;note&gt; to set instruction",
  ];
  const compose = (visibleBlocks, hiddenCount) => [
    ...header,
    "",
    [...visibleBlocks, hiddenCount > 0 ? `… +${hiddenCount} more` : null].filter(Boolean).join("\n\n"),
    "",
    ...footer,
  ].join("\n");

  // Telegram rejects messages over 4096 characters. Drop WHOLE position blocks
  // (never slice through a tag) and leave a "+N more" counter, so the message can
  // never be truncated mid-markup by `sendHTML`.
  for (let visibleCount = blocks.length; visibleCount > 0; visibleCount -= 1) {
    const text = compose(blocks.slice(0, visibleCount), blocks.length - visibleCount);
    if (text.length <= MESSAGE_LIMIT || visibleCount === 1) return text;
  }
  return compose([], blocks.length);
}

/**
 * `⚠️ Out of Range` alert (HTML) with the same tree layout as `/positions`.
 *
 * Accepts either the flat `{ pair, minutesOOR }` pair or the full in-memory
 * position snapshot (`position`), which adds the range bar, PnL and value rows.
 */
export function formatOutOfRangeAlert({
  pair = null,
  minutesOOR = null,
  position = null,
  mode = "USD",
  waitMinutes = null,
} = {}) {
  const snapshot = position && typeof position === "object" ? position : {};
  const minutes = toFiniteNumber(minutesOOR) ?? toFiniteNumber(snapshot.minutes_out_of_range);
  const rangePct = computeRangePositionPct({
    lowerBinId: snapshot.lower_bin,
    upperBinId: snapshot.upper_bin,
    activeBinId: snapshot.active_bin,
  });
  const pnlPct = toFiniteNumber(snapshot.pnl_pct);
  const value = toFiniteNumber(snapshot.total_value_usd);

  const rows = [
    minutes != null ? { label: "⏱ Drifting", value: code(`${minutes}m`) } : null,
    rangePct != null
      ? { label: "📍 Range", value: `${code(renderProgressBar(rangePct))} ${code(`${rangePct}%`)}` }
      : null,
    pnlPct != null ? { label: "📈 PnL", value: code(formatSignedPct(pnlPct)) } : null,
    value != null ? { label: "💵 Value", value: code(formatMoney(value, mode)) } : null,
  ];

  const wait = toFiniteNumber(waitMinutes);
  const footer = wait != null && wait > 0
    ? `Close rule fires at ${code(`${wait}m`)} out of range`
    : "Monitoring — no action taken yet";

  return [
    `⚠️ ${bold("OUT OF RANGE")}${pair ? ` · ${code(pair)}` : ""}`,
    SECTION_DIVIDER,
    formatTreeRows(rows),
    SECTION_DIVIDER,
    footer,
  ].filter((line) => line != null && line !== "").join("\n");
}

