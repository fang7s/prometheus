/**
 * Zenith-style closed-position PnL card (PNG) for Telegram close summaries.
 *
 * This renderer is used **only** for closed positions (manual `/close`,
 * `/closeall`, rule-engine exits: TP/SL, range-out, 15m Supertrend break) and for
 * PnL history. Open positions always stay text-only (see `lp-menu.js`).
 *
 * Layers:
 *   1. Pure helpers — `priceAtBin`, `formatHoldDuration`, `normalizePnlCardData`,
 *      `buildPricePath`, `buildClosedPositionCaption`. No canvas, no network.
 *   2. `drawPnlCard` — paints the card onto an injected canvas factory
 *      (`@napi-rs/canvas`, falling back to `canvas` through `chartService`), so
 *      unit tests render a real PNG without touching Telegram.
 *   3. `generatePnlCard` / `sendClosedPositionPnlCard` — async wrappers used by
 *      the close paths. Sending is best-effort: a canvas or Telegram failure can
 *      never break a close.
 *
 * Header: `PROMETHEUS LP` + `CLOSED • Meteora DLMM x.xx%` + hold duration.
 * Main: large signed USD PnL (green/red) with the percentage.
 * Side panel: TOP / BOTTOM / ENTRY / CLOSE price lines + the price path curve.
 * Grid: OPENED, CLOSED, DEPOSITED, RETURNED, FEES EARNED (+ the bin range).
 */

import { log } from "../logger.js";
import { sendPhotoWithCaption } from "../telegram.js";
import { buildPhotoCaption, loadCanvas } from "./chartService.js";

export const PNL_CARD_DEFAULT_WIDTH = 900;
export const PNL_CARD_DEFAULT_HEIGHT = 540;
/** Telegram rejects photo captions longer than this. */
export const PNL_CARD_CAPTION_LIMIT = 1024;

/** In-memory price-path samples (bin id → price), one per position. */
const MAX_PRICE_SAMPLES = 240;
const MIN_SAMPLE_INTERVAL_MS = 15_000;
const MAX_TRACKED_PATHS = 200;
const _priceSamples = new Map(); // position -> { at, samples: [{ at, price }] }

const COLORS = {
  background: "#0b1220",
  panel: "#0f172a",
  border: "#1e293b",
  grid: "#1e293b",
  text: "#e2e8f0",
  muted: "#94a3b8",
  profit: "#22c55e",
  loss: "#ef4444",
  entry: "#f59e0b",
  range: "#60a5fa",
  band: "rgba(34, 197, 94, 0.10)",
  bandLoss: "rgba(239, 68, 68, 0.10)",
};

// ─── Formatting helpers (pure) ────────────────────────────────────
function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toNumberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function escapeCardHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Meteora DLMM bin id → raw price ratio, mirroring the SDK's
 * `getPriceOfBinByBinId(binId, binStep) = (1 + binStep / 10_000) ** binId`.
 * Kept local + pure so the card (and its tests) never need the DLMM SDK.
 */
export function priceAtBin(binId, binStep) {
  const bin = Number(binId);
  const step = Number(binStep);
  if (!Number.isFinite(bin) || !Number.isFinite(step) || step <= 0) return null;
  const price = Math.pow(1 + step / 10_000, bin);
  return Number.isFinite(price) && price > 0 ? price : null;
}

export function formatCardPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000) return n.toFixed(2);
  if (abs >= 1) return n.toFixed(4);
  if (abs >= 0.001) return n.toFixed(6);
  return n.toExponential(3);
}

/** "5h 15m" style hold duration (days are collapsed into hours for >1d). */
export function formatHoldDuration(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n < 0) return "0m";
  const total = Math.round(n);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** `2026-03-01 12:30 UTC` (empty input → em dash). */
export function formatCardDate(value) {
  if (value == null || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function formatCardUsd(value) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${sign}$${(abs / 1_000).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

export function formatSignedUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "$0.00";
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

export function formatSignedPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0.00%";
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}${Math.abs(n).toFixed(2)}%`;
}

// ─── Price path sampling ──────────────────────────────────────────
/**
 * Record a price sample for an open position (bin id → price). Called from the
 * fast PnL poller / management cycle so the closed card can draw a real path
 * instead of a straight line. Throttled + capped, all in memory.
 */
export function recordPriceSample(positionAddress, binId, binStep, at = Date.now()) {
  const address = String(positionAddress ?? "").trim();
  if (!address) return false;
  const price = priceAtBin(binId, binStep);
  if (price == null) return false;
  const entry = _priceSamples.get(address) || { at: 0, samples: [] };
  if (at - entry.at < MIN_SAMPLE_INTERVAL_MS) return false;
  entry.samples.push({ at, price });
  if (entry.samples.length > MAX_PRICE_SAMPLES) {
    entry.samples = entry.samples.slice(-MAX_PRICE_SAMPLES);
  }
  entry.at = at;
  _priceSamples.set(address, entry);
  if (_priceSamples.size > MAX_TRACKED_PATHS) {
    const oldest = [..._priceSamples.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) _priceSamples.delete(oldest[0]);
  }
  return true;
}

export function getPriceSamples(positionAddress) {
  const entry = _priceSamples.get(String(positionAddress ?? "").trim());
  return (entry?.samples || []).map((sample) => ({ ...sample }));
}

export function clearPriceSamples(positionAddress = null) {
  if (positionAddress == null) _priceSamples.clear();
  else _priceSamples.delete(String(positionAddress).trim());
}

/**
 * Normalise a path to `[{ t: 0..1, price }]`. Accepts samples
 * (`{ at, price }`), plain numbers, or `{ t, price }` points. Falls back to the
 * entry → close segment when no history was recorded (never invents movement).
 */
export function buildPricePath(pricePath = null, { entryPrice = null, closePrice = null } = {}) {
  const raw = Array.isArray(pricePath) ? pricePath : [];
  const points = [];
  for (const item of raw) {
    const price = Number(typeof item === "object" && item !== null ? item.price : item);
    if (!Number.isFinite(price) || price <= 0) continue;
    const at = typeof item === "object" && item !== null ? Number(item.at ?? item.t) : NaN;
    points.push({ at: Number.isFinite(at) ? at : null, price });
  }
  if (points.length >= 2) {
    const first = points[0].at;
    const last = points[points.length - 1].at;
    const span = first != null && last != null && last > first ? last - first : points.length - 1;
    return points.map((point, index) => ({
      t: first != null && last != null && last > first
        ? (point.at - first) / span
        : index / (points.length - 1),
      price: point.price,
    }));
  }
  const fallback = [entryPrice, closePrice]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (fallback.length === 2) {
    return [
      { t: 0, price: fallback[0] },
      { t: 1, price: fallback[1] },
    ];
  }
  if (fallback.length === 1) {
    return [
      { t: 0, price: fallback[0] },
      { t: 1, price: fallback[0] },
    ];
  }
  return [];
}

// ─── Payload normalisation (pure) ─────────────────────────────────
/**
 * Accepts a `closePosition()` result (preferred), a lessons history record, or a
 * hand-built payload and returns the exact shape the renderer expects.
 *
 * Price lines are derived from bin ids + bin step (`priceAtBin`) when explicit
 * prices are absent — that is what makes single-sided (below-price) SOL limit
 * ranges render correctly: TOP is the max-bin price, BOTTOM the min-bin price.
 */
export function normalizePnlCardData(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const binRange = source.bin_range && typeof source.bin_range === "object" ? source.bin_range : {};
  const pnlUsd = toNumber(source.pnl_usd ?? source.pnlUsd, 0);
  const pnlPct = toNumber(source.pnl_pct ?? source.pnlPct, 0);
  const binStep = toNumberOrNull(source.bin_step ?? source.binStep);
  const minBinId = toNumberOrNull(source.min_bin_id ?? source.minBinId ?? binRange.min);
  const maxBinId = toNumberOrNull(source.max_bin_id ?? source.maxBinId ?? binRange.max);
  const entryBinId = toNumberOrNull(
    source.entry_bin_id ?? source.entryBinId ?? source.active_bin_at_deploy ?? binRange.active,
  );
  const closeBinId = toNumberOrNull(
    source.close_bin_id ?? source.closeBinId ?? source.active_bin ?? source.close_active_bin,
  );

  const derived = (bin) => (binStep != null && bin != null ? priceAtBin(bin, binStep) : null);
  const prices = {
    top: toNumberOrNull(source.top_price ?? source.topPrice) ?? derived(maxBinId),
    bottom: toNumberOrNull(source.bottom_price ?? source.bottomPrice) ?? derived(minBinId),
    entry: toNumberOrNull(source.entry_price ?? source.entryPrice) ?? derived(entryBinId),
    close: toNumberOrNull(source.close_price ?? source.closePrice) ?? derived(closeBinId),
  };

  const openedAt = source.opened_at ?? source.openedAt ?? source.deployed_at ?? null;
  // `recorded_at` is the lessons.js history timestamp (PnL history cards).
  const closedAt = source.closed_at ?? source.closedAt ?? source.recorded_at ?? null;
  let minutesHeld = toNumberOrNull(source.minutes_held ?? source.minutesHeld ?? source.hold_minutes);
  if (minutesHeld == null && openedAt) {
    const start = new Date(openedAt).getTime();
    const end = closedAt ? new Date(closedAt).getTime() : Date.now();
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      minutesHeld = Math.floor((end - start) / 60_000);
    }
  }
  const holdMinutes = minutesHeld != null && minutesHeld >= 0 ? minutesHeld : 0;

  return {
    pair: String(source.pair || source.pool_name || source.poolName || source.pool || "POSITION"),
    position: source.position ? String(source.position) : null,
    pnlUsd,
    pnlPct,
    profit: pnlUsd >= 0,
    depositedUsd: toNumberOrNull(source.deposited_usd ?? source.initial_value_usd ?? source.deposited),
    returnedUsd: toNumberOrNull(source.returned_usd ?? source.final_value_usd ?? source.returned),
    feesUsd: toNumberOrNull(source.fees_earned_usd ?? source.fees_earned ?? source.fees_usd) ?? 0,
    openedAt,
    closedAt,
    minutesHeld: holdMinutes,
    holdLabel: formatHoldDuration(holdMinutes),
    binStep,
    minBinId,
    maxBinId,
    entryBinId,
    closeBinId,
    prices,
    pricePath: buildPricePath(source.price_path ?? source.pricePath, {
      entryPrice: prices.entry,
      closePrice: prices.close,
    }),
    baseFeePct: toNumberOrNull(source.base_fee_pct ?? source.baseFeePct ?? source.base_fee ?? source.baseFee),
    closeReason: source.close_reason ?? source.reason ?? null,
  };
}

/** HTML caption that accompanies the card in the Telegram close summary. */
export function buildClosedPositionCaption(input = {}) {
  const card = normalizePnlCardData(input);
  const lines = [
    `🔒 <b>Closed</b> ${escapeCardHtml(card.pair)}`,
    `${card.profit ? "🟢" : "🔴"} PnL: <b>${formatSignedUsd(card.pnlUsd)}</b> (${formatSignedPct(card.pnlPct)})`,
    `💰 Deposited ${formatCardUsd(card.depositedUsd)} → Returned ${formatCardUsd(card.returnedUsd)}`,
    `🎁 Fees ${formatCardUsd(card.feesUsd)} · ⏱ ${card.holdLabel} held`,
  ];
  if (card.closeReason) lines.push(`⚡ ${escapeCardHtml(card.closeReason)}`);
  return buildPhotoCaption(lines.join("\n"), PNL_CARD_CAPTION_LIMIT);
}

// ─── Canvas drawing helpers ───────────────────────────────────────
function roundedRect(ctx, x, y, w, h, radius = 12) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function drawPanel(ctx, { x, y, w, h, radius = 14, fill = COLORS.panel }) {
  roundedRect(ctx, x, y, w, h, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function fitText(ctx, text, maxWidth) {
  const value = String(text ?? "");
  if (ctx.measureText(value).width <= maxWidth) return value;
  let trimmed = value;
  while (trimmed.length > 1 && ctx.measureText(`${trimmed}…`).width > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed}…`;
}

function drawMetricCell(ctx, { x, y, w, h, label, value, accent = null }) {
  drawPanel(ctx, { x, y, w, h, radius: 10 });
  ctx.fillStyle = COLORS.muted;
  ctx.font = "10px sans-serif";
  ctx.fillText(label, x + 14, y + 20);
  ctx.fillStyle = accent || COLORS.text;
  ctx.font = "bold 14px sans-serif";
  ctx.fillText(fitText(ctx, value, w - 28), x + 14, y + 46);
}

/**
 * Side panel: TOP / BOTTOM / ENTRY / CLOSE price lines + the price path curve.
 * Prices are raw bin prices (token X per token Y) — the same scale the LP
 * dashboard chart uses — so a single-sided below-price SOL limit range renders
 * correctly (TOP sits closer to the active price than BOTTOM).
 */
function drawPricePanel(ctx, card, { x, y, w, h }) {
  drawPanel(ctx, { x, y, w, h });

  ctx.textAlign = "left";
  ctx.fillStyle = COLORS.muted;
  ctx.font = "11px sans-serif";
  ctx.fillText("PRICE RANGE", x + 18, y + 26);
  if (card.minBinId != null && card.maxBinId != null) {
    ctx.textAlign = "right";
    ctx.fillStyle = COLORS.text;
    ctx.font = "bold 11px sans-serif";
    ctx.fillText(`${card.minBinId} → ${card.maxBinId}`, x + w - 18, y + 26);
    ctx.textAlign = "left";
  }

  const plot = { x: x + 18, y: y + 46, w: w - 36, h: h - 100 };
  drawPanel(ctx, { ...plot, radius: 8, fill: "#0a1120" });

  const values = [
    card.prices.top,
    card.prices.bottom,
    card.prices.entry,
    card.prices.close,
    ...card.pricePath.map((point) => point.price),
  ]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);

  if (values.length === 0) {
    ctx.fillStyle = COLORS.muted;
    ctx.font = "12px sans-serif";
    ctx.fillText("price data unavailable", plot.x + 14, plot.y + plot.h / 2);
  } else {
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (!(max > min)) {
      const drift = Math.max(max * 0.02, 1e-9);
      min = Math.max(0, min - drift);
      max += drift;
    }
    const headroom = (max - min) * 0.08;
    min = Math.max(0, min - headroom);
    max += headroom;
    const scaleY = (price) => plot.y + plot.h - ((Number(price) - min) / (max - min)) * plot.h;

    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i += 1) {
      const gy = plot.y + (plot.h * i) / 4;
      ctx.beginPath();
      ctx.moveTo(plot.x, gy);
      ctx.lineTo(plot.x + plot.w, gy);
      ctx.stroke();
    }

    // Deposit range band (BOTTOM → TOP bin price).
    if (card.prices.top != null && card.prices.bottom != null) {
      const topY = scaleY(card.prices.top);
      const bottomY = scaleY(card.prices.bottom);
      ctx.fillStyle = card.profit ? COLORS.band : COLORS.bandLoss;
      ctx.fillRect(plot.x, Math.min(topY, bottomY), plot.w, Math.abs(bottomY - topY));
    }

    // Price path curve.
    if (card.pricePath.length >= 2) {
      const pathColor = card.profit ? COLORS.profit : COLORS.loss;
      ctx.strokeStyle = pathColor;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = "round";
      ctx.beginPath();
      card.pricePath.forEach((point, index) => {
        const px = plot.x + Math.min(1, Math.max(0, point.t)) * plot.w;
        const py = scaleY(point.price);
        if (index === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
      const last = card.pricePath[card.pricePath.length - 1];
      ctx.fillStyle = pathColor;
      ctx.beginPath();
      ctx.arc(plot.x + Math.min(1, Math.max(0, last.t)) * plot.w, scaleY(last.price), 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Horizontal price guides. Labels are de-overlapped so TOP/ENTRY/BOTTOM/
    // CLOSE stay readable even when the range is only a few bins wide.
    const guides = [
      { label: "TOP", price: card.prices.top, color: COLORS.range },
      { label: "ENTRY", price: card.prices.entry, color: COLORS.entry },
      { label: "CLOSE", price: card.prices.close, color: card.profit ? COLORS.profit : COLORS.loss },
      { label: "BOTTOM", price: card.prices.bottom, color: COLORS.range },
    ]
      .map((guide) => {
        const price = Number(guide.price);
        if (guide.price == null || !Number.isFinite(price) || price <= 0) return null;
        return { ...guide, price, lineY: scaleY(price) };
      })
      .filter(Boolean);

    for (const guide of guides) {
      ctx.strokeStyle = guide.color;
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(plot.x, guide.lineY);
      ctx.lineTo(plot.x + plot.w, guide.lineY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const minLabelGap = 12;
    let nextLabelY = plot.y + 9;
    for (const guide of guides.slice().sort((a, b) => a.lineY - b.lineY)) {
      guide.labelY = Math.max(guide.lineY - 3, nextLabelY);
      nextLabelY = guide.labelY + minLabelGap;
    }
    const overflow = nextLabelY - minLabelGap - (plot.y + plot.h - 5);
    if (overflow > 0) {
      for (const guide of guides) guide.labelY -= overflow;
    }

    ctx.font = "bold 9px sans-serif";
    for (const guide of guides) {
      const text = `${guide.label} ${formatCardPrice(guide.price)}`;
      const textWidth = ctx.measureText(text).width;
      const chipX = plot.x + plot.w - textWidth - 12;
      roundedRect(ctx, chipX, guide.labelY - 9, textWidth + 8, 12, 3);
      ctx.fillStyle = "rgba(10, 17, 32, 0.82)";
      ctx.fill();
      ctx.fillStyle = guide.color;
      ctx.textAlign = "left";
      ctx.fillText(text, chipX + 4, guide.labelY);
    }
    ctx.textAlign = "left";
  }

  ctx.fillStyle = COLORS.muted;
  ctx.font = "10px sans-serif";
  ctx.fillText("OPEN", plot.x, plot.y + plot.h + 16);
  ctx.textAlign = "right";
  ctx.fillText(`${card.holdLabel} held`, plot.x + plot.w, plot.y + plot.h + 16);
  ctx.textAlign = "left";

  let legendX = x + 18;
  const legendY = y + h - 14;
  ctx.font = "9px sans-serif";
  for (const [label, color] of [
    ["TOP", COLORS.range],
    ["BOTTOM", COLORS.range],
    ["ENTRY", COLORS.entry],
    ["CLOSE", card.profit ? COLORS.profit : COLORS.loss],
  ]) {
    ctx.fillStyle = color;
    ctx.fillRect(legendX, legendY - 7, 8, 8);
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(label, legendX + 12, legendY);
    legendX += 12 + ctx.measureText(label).width + 14;
  }
}

// ─── Card renderer ────────────────────────────────────────────────
/**
 * Render the Zenith-style PnL card.
 *
 * @param {object} input close result / history record / hand-built payload
 * @param {{createCanvas: Function, width?: number, height?: number}} options
 * @returns {Buffer} PNG buffer
 */
export function drawPnlCard(input = {}, {
  createCanvas,
  width = PNL_CARD_DEFAULT_WIDTH,
  height = PNL_CARD_DEFAULT_HEIGHT,
} = {}) {
  if (typeof createCanvas !== "function") {
    throw new Error("drawPnlCard: a canvas factory is required.");
  }
  const card = normalizePnlCardData(input);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const pnlColor = card.profit ? COLORS.profit : COLORS.loss;

  const pad = Math.round(width * 0.029);
  const headerBottom = Math.round(height * 0.156);
  const panelY = headerBottom + 14;
  const leftW = Math.round(width * 0.522);
  const pnlH = Math.round(height * 0.31);
  const gridY = panelY + pnlH + 16;
  const gridH = Math.round(height * 0.122);
  const gridGap = 12;
  const contentBottom = gridY + gridH * 3 + gridGap * 2;
  const chartX = pad + leftW + 16;
  const chartW = width - pad - chartX;
  const chartH = contentBottom - panelY;

  // Background + accent strip (green on profit, red on loss).
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = pnlColor;
  ctx.fillRect(0, 0, width, 4);

  // ── Header ──────────────────────────────────────────────────────
  ctx.textAlign = "left";
  ctx.fillStyle = COLORS.text;
  ctx.font = `bold ${Math.round(width * 0.029)}px sans-serif`;
  ctx.fillText("PROMETHEUS LP", pad, Math.round(height * 0.085));

  ctx.font = "13px sans-serif";
  ctx.fillStyle = COLORS.muted;
  const subtitle = card.closeReason ? `${card.pair} · ${card.closeReason}` : card.pair;
  ctx.fillText(fitText(ctx, subtitle, Math.round(width * 0.5)), pad, Math.round(height * 0.132));

  const feeLabel = card.baseFeePct != null
    ? `CLOSED • Meteora DLMM ${card.baseFeePct.toFixed(2)}%`
    : "CLOSED • Meteora DLMM";
  ctx.textAlign = "right";
  ctx.fillStyle = pnlColor;
  ctx.font = "bold 14px sans-serif";
  ctx.fillText(feeLabel, width - pad, Math.round(height * 0.068));
  ctx.fillStyle = COLORS.muted;
  ctx.font = "13px sans-serif";
  ctx.fillText(`${card.holdLabel} held`, width - pad, Math.round(height * 0.112));
  ctx.textAlign = "left";

  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, headerBottom);
  ctx.lineTo(width - pad, headerBottom);
  ctx.stroke();

  // ── Main PnL display ────────────────────────────────────────────
  drawPanel(ctx, { x: pad, y: panelY, w: leftW, h: pnlH });
  ctx.fillStyle = COLORS.muted;
  ctx.font = "11px sans-serif";
  ctx.fillText("NET PnL", pad + 20, panelY + 28);

  const pnlValue = formatSignedUsd(card.pnlUsd);
  const pnlPctLabel = `(${formatSignedPct(card.pnlPct)})`;
  ctx.font = `bold ${Math.round(width * 0.058)}px sans-serif`;
  const valueWidth = ctx.measureText(pnlValue).width;
  const valueBaseline = panelY + Math.round(pnlH * 0.52);
  ctx.fillStyle = pnlColor;
  ctx.fillText(pnlValue, pad + 20, valueBaseline);

  ctx.font = `bold ${Math.round(width * 0.022)}px sans-serif`;
  ctx.globalAlpha = 0.85;
  if (valueWidth + 16 + ctx.measureText(pnlPctLabel).width <= leftW - 40) {
    ctx.fillText(pnlPctLabel, pad + 20 + valueWidth + 16, valueBaseline);
  } else {
    ctx.fillText(pnlPctLabel, pad + 20, valueBaseline + Math.round(pnlH * 0.17));
  }
  ctx.globalAlpha = 1;

  ctx.fillStyle = COLORS.muted;
  ctx.font = "12px sans-serif";
  // Canvas fonts have no emoji fallback on most hosts — keep the card text ASCII.
  const feesText = `Fees ${formatCardUsd(card.feesUsd)}  ·  ${card.holdLabel} held`;
  ctx.fillText(fitText(ctx, feesText, leftW - 40), pad + 20, panelY + pnlH - 22);

  // ── Metrics grid ────────────────────────────────────────────────
  const cellW = Math.round((leftW - gridGap) / 2);
  const cells = [
    { label: "OPENED", value: formatCardDate(card.openedAt) },
    { label: "CLOSED", value: formatCardDate(card.closedAt) },
    { label: "DEPOSITED", value: formatCardUsd(card.depositedUsd) },
    { label: "RETURNED", value: formatCardUsd(card.returnedUsd) },
    { label: "FEES EARNED", value: formatCardUsd(card.feesUsd), accent: COLORS.profit },
    {
      label: "RANGE",
      value: card.prices.bottom != null && card.prices.top != null
        ? `${formatCardPrice(card.prices.bottom)} → ${formatCardPrice(card.prices.top)}`
        : "—",
    },
  ];
  cells.forEach((cell, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    drawMetricCell(ctx, {
      x: pad + col * (cellW + gridGap),
      y: gridY + row * (gridH + gridGap),
      w: cellW,
      h: gridH,
      label: cell.label,
      value: cell.value,
      accent: cell.accent ?? null,
    });
  });

  // ── Price range panel ───────────────────────────────────────────
  drawPricePanel(ctx, card, { x: chartX, y: panelY, w: chartW, h: chartH });

  return canvas.toBuffer("image/png");
}

/**
 * Generate the PNG (loads the native canvas lazily). Throws only when the
 * renderer is unavailable — callers that must not fail use
 * `sendClosedPositionPnlCard`.
 */
export async function generatePnlCard(input = {}, { createCanvas = null, width, height } = {}) {
  try {
    const canvasFactory = createCanvas || (await loadCanvas()).createCanvas;
    return drawPnlCard(input, { createCanvas: canvasFactory, width, height });
  } catch (error) {
    log("pnl_card_warn", `PnL card render failed: ${error.message}`);
    throw error;
  }
}

/**
 * Merge a close result with tracked position metadata (opened date, bin step,
 * bin range, entry bin) and attach any recorded price samples.
 */
export function buildClosedPositionCardPayload(closeResult = {}, tracked = null) {
  const result = closeResult && typeof closeResult === "object" ? closeResult : {};
  const positionAddress = result.position ? String(result.position) : null;
  return {
    ...result,
    opened_at: result.opened_at ?? tracked?.deployed_at ?? null,
    closed_at: result.closed_at ?? null,
    bin_step: result.bin_step ?? tracked?.bin_step ?? null,
    bin_range: result.bin_range ?? tracked?.bin_range ?? null,
    entry_bin_id: result.entry_bin_id ?? tracked?.active_bin_at_deploy ?? null,
    price_path: Array.isArray(result.price_path) && result.price_path.length > 1
      ? result.price_path
      : (positionAddress ? getPriceSamples(positionAddress) : null),
  };
}

/**
 * Render + send the closed-position card. Best-effort: never throws, so a close
 * path can always await it without risking the transaction flow.
 * @returns {Promise<number|null>} Telegram message id, or null
 */
export async function sendClosedPositionPnlCard(
  closeResult = {},
  { tracked = null, caption = null, keyboard = null, createCanvas = null } = {},
) {
  const payload = buildClosedPositionCardPayload(closeResult, tracked);
  const positionAddress = payload.position ? String(payload.position) : null;
  try {
    const png = await generatePnlCard(payload, { createCanvas });
    const html = caption || buildClosedPositionCaption(payload);
    const messageId = await sendPhotoWithCaption(buildPhotoCaption(html, PNL_CARD_CAPTION_LIMIT), png, keyboard);
    if (positionAddress) clearPriceSamples(positionAddress);
    return messageId ?? null;
  } catch (error) {
    log("pnl_card_warn", `Closed PnL card skipped: ${error.message}`);
    return null;
  }
}
