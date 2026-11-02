/**
 * Liquidity distribution chart for the Telegram Quick Zap dashboard.
 *
 * Responsibilities:
 *   1. Pull bins around the active bin from `@meteora-ag/dlmm`
 *      (`getBinsAroundActiveBin`) and convert each bin to a SOL-equivalent
 *      liquidity value (`buildLiquiditySeries`, pure + unit-tested).
 *   2. Draw a dark Zenith-style bar chart onto a canvas
 *      (`drawLiquidityChart`) with the user's `minBinId → maxBinId` highlighted
 *      and an "active bin" marker showing the current price.
 *   3. Return a PNG `Buffer` (`generateLiquidityDistributionChart`).
 *
 * The renderer is loaded lazily from `@napi-rs/canvas` (falling back to the
 * `canvas` package) so a missing native build only disables the chart — the
 * dashboard itself keeps working.
 */

import { log } from "../logger.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const DEFAULT_BINS_EACH_SIDE = 60;
/** Guard rail: a -50 % range on a 20 bps pool is ~350 bins per side. */
export const MAX_BINS_EACH_SIDE = 400;
/** Wide ranges are bucketed so bars stay readable at 900 px. */
export const MAX_CHART_BARS = 180;
const SERIES_CACHE_TTL_MS = 60_000;

export const CHART_DEFAULT_WIDTH = 900;
export const CHART_DEFAULT_HEIGHT = 420;
/** Telegram rejects photo captions longer than this. */
export const PHOTO_CAPTION_LIMIT = 1024;

const _seriesCache = new Map(); // pool address -> { at, data }

// ─── Canvas loader (lazy, cached) ─────────────────────────────────
let _canvasModule = null;
let _canvasFailure = null;

export async function loadCanvas() {
  if (_canvasModule) return _canvasModule;
  if (_canvasFailure) throw _canvasFailure;
  let lastError = null;
  for (const specifier of ["@napi-rs/canvas", "canvas"]) {
    try {
      const mod = await import(specifier);
      const resolved = mod?.createCanvas ? mod : mod?.default ?? null;
      if (resolved?.createCanvas) {
        _canvasModule = resolved;
        return _canvasModule;
      }
    } catch (error) {
      lastError = error;
    }
  }
  _canvasFailure = new Error(
    `Canvas renderer unavailable (${lastError?.message || "install @napi-rs/canvas"})`,
  );
  throw _canvasFailure;
}

// ─── Range normalisation ──────────────────────────────────────────
/**
 * Accepts `{ minBinId, maxBinId }` (from `computeBinRange`) or
 * `{ binsBelow, binsAbove }` plus the active bin, and returns bin bounds.
 */
export function normalizeUserRange(userRange = null, activeBinId = null) {
  if (!userRange) return { minBinId: null, maxBinId: null };
  const min = Number(userRange.minBinId);
  const max = Number(userRange.maxBinId);
  if (Number.isFinite(min) && Number.isFinite(max)) {
    return { minBinId: Math.min(min, max), maxBinId: Math.max(min, max) };
  }
  const below = Number(userRange.binsBelow);
  const above = Number(userRange.binsAbove ?? 0);
  const active = Number(activeBinId);
  if (Number.isFinite(below) && Number.isFinite(active)) {
    return {
      minBinId: active - Math.max(0, Math.round(below)),
      maxBinId: active + Math.max(0, Math.round(Number.isFinite(above) ? above : 0)),
    };
  }
  return { minBinId: null, maxBinId: null };
}

/**
 * How many bins to load either side of the active bin so the whole user range
 * is visible (with ~8 % headroom). Without a range we use the default window.
 * Capped by `MAX_BINS_EACH_SIDE` to keep the RPC payload sane.
 */
export function deriveBinsEachSide(activeBinId, userRange = null, defaultEachSide = DEFAULT_BINS_EACH_SIDE) {
  const fallback = Math.max(1, Math.round(Number(defaultEachSide) || DEFAULT_BINS_EACH_SIDE));
  const active = Number(activeBinId);
  const { minBinId, maxBinId } = normalizeUserRange(userRange, active);
  if (!Number.isFinite(active) || minBinId == null || maxBinId == null) {
    return { left: fallback, right: fallback };
  }
  const pad = (bins) => Math.max(8, Math.ceil(bins * 0.08));
  const below = Math.max(0, active - minBinId);
  const above = Math.max(0, maxBinId - active);
  return {
    left: Math.min(MAX_BINS_EACH_SIDE, Math.max(fallback, below + pad(below))),
    right: Math.min(MAX_BINS_EACH_SIDE, Math.max(fallback, above + pad(above))),
  };
}

// ─── Series builder (pure) ────────────────────────────────────────
/**
 * Convert SDK bins into chart-ready SOL-equivalent values.
 *
 * `valueSol` is the bin's total liquidity expressed in SOL:
 *   - SOL is token Y → `y + x * price`  (price = token Y per token X)
 *   - SOL is token X → `x + y / price`
 *
 * `pct` is the bin price relative to the active bin price, which drives the
 * "-80% / -50% / Active / +20% / +40%" axis labels.
 */
export function buildLiquiditySeries({
  bins = [],
  activeBinId = null,
  binStep = 0,
  xDecimals = 9,
  yDecimals = 9,
  yIsSol = true,
  userRange = null,
  baseSymbol = null,
  quoteSymbol = null,
  poolAddress = null,
} = {}) {
  const { minBinId, maxBinId } = normalizeUserRange(userRange, activeBinId);
  const list = Array.isArray(bins) ? bins : [];
  const xScale = 10 ** Number(xDecimals ?? 9);
  const yScale = 10 ** Number(yDecimals ?? 9);

  const series = list.map((bin) => {
    const price = Number(bin?.price);
    const x = Number(bin?.xAmount?.toString?.() ?? bin?.xAmount ?? 0) / xScale;
    const y = Number(bin?.yAmount?.toString?.() ?? bin?.yAmount ?? 0) / yScale;
    const xValue = Number.isFinite(x) ? x : 0;
    const yValue = Number.isFinite(y) ? y : 0;
    const valueSol = yIsSol
      ? yValue + (Number.isFinite(price) ? xValue * price : 0)
      : xValue + (Number.isFinite(price) && price > 0 ? yValue / price : 0);
    const binId = Number(bin?.binId);
    return {
      binId,
      price: Number.isFinite(price) ? price : null,
      valueSol: Number.isFinite(valueSol) ? Number(valueSol.toFixed(8)) : 0,
      inRange: minBinId != null && Number.isFinite(binId) && binId >= minBinId && binId <= maxBinId,
    };
  }).filter((bin) => Number.isFinite(bin.binId)).sort((a, b) => a.binId - b.binId);

  const activeEntry = series.find((bin) => bin.binId === Number(activeBinId))
    || series.reduce((best, bin) => (best == null ? bin : best), null);
  const activePrice = activeEntry?.price ?? null;
  const withPct = series.map((bin) => ({
    ...bin,
    pct: activePrice && bin.price ? Number(((bin.price / activePrice - 1) * 100).toFixed(2)) : null,
  }));

  const totalSol = withPct.reduce((sum, bin) => sum + bin.valueSol, 0);
  const maxSol = withPct.reduce((max, bin) => Math.max(max, bin.valueSol), 0);

  return {
    poolAddress: poolAddress || null,
    baseSymbol: baseSymbol || null,
    quoteSymbol: quoteSymbol || "SOL",
    activeBinId: Number.isFinite(Number(activeBinId)) ? Number(activeBinId) : null,
    activePrice,
    binStep: Number(binStep) || 0,
    minBinId,
    maxBinId,
    bins: withPct,
    totalSol: Number(totalSol.toFixed(6)),
    maxSol: Number(maxSol.toFixed(6)),
    inRangeBins: withPct.filter((bin) => bin.inRange).length,
  };
}
// ─── SDK fetch (cached) ───────────────────────────────────────────
/**
 * Fetch bins around the active bin and return chart-ready values.
 * Cached for 60 s per pool so range tweaks only re-draw, never re-fetch.
 */
export async function fetchLiquiditySeries(
  poolData,
  userRange = null,
  { binsEachSide = DEFAULT_BINS_EACH_SIDE, force = false } = {},
) {
  const address = typeof poolData === "string"
    ? poolData
    : poolData?.address || poolData?.poolAddress || null;
  if (!address) throw new Error("Liquidity chart: pool address is required.");

  let cached = _seriesCache.get(address);
  const needsRefresh = force || !cached || Date.now() - cached.at >= SERIES_CACHE_TTL_MS;
  let sides = { left: binsEachSide, right: binsEachSide };
  if (needsRefresh || !cached || cached.data.left < sides.left || cached.data.right < sides.right) {
    const { getDlmmPool } = await import("./meteoraService.js");
    const pool = await getDlmmPool(address);
    const poolActiveId = Number(pool.lbPair?.activeId ?? 0);
    sides = deriveBinsEachSide(poolActiveId, userRange, binsEachSide);
    const left = Math.max(sides.left, cached?.data?.left ?? 0);
    const right = Math.max(sides.right, cached?.data?.right ?? 0);
    const { activeBin, bins } = await pool.getBinsAroundActiveBin(left, right);
    const tokenYMint = pool.lbPair?.tokenYMint?.toString?.() ?? null;
    cached = {
      at: Date.now(),
      data: {
        poolAddress: address,
        baseSymbol: typeof poolData === "object" ? poolData?.baseSymbol ?? null : null,
        quoteSymbol: tokenYMint === SOL_MINT
          ? "SOL"
          : (typeof poolData === "object" ? poolData?.quoteSymbol ?? null : null),
        activeBinId: Number(activeBin),
        binStep: Number(pool.lbPair?.binStep ?? 0),
        xDecimals: Number(pool.tokenX?.mint?.decimals ?? 9),
        yDecimals: Number(pool.tokenY?.mint?.decimals ?? 9),
        yIsSol: tokenYMint === SOL_MINT,
        left,
        right,
        bins: Array.isArray(bins) ? bins : [],
      },
    };
    _seriesCache.set(address, cached);
    if (_seriesCache.size > 50) _seriesCache.clear();
  }

  return buildLiquiditySeries({ ...cached.data, userRange });
}

export function clearLiquiditySeriesCache(poolAddress = null) {
  if (poolAddress == null) _seriesCache.clear();
  else _seriesCache.delete(String(poolAddress));
}

// ─── Drawing helpers ──────────────────────────────────────────────
const COLORS = {
  background: "#0b1220",
  panel: "#0f172a",
  grid: "#1e293b",
  text: "#e2e8f0",
  muted: "#94a3b8",
  bar: "#334e79",
  barInRange: "#22c55e",
  barActive: "#f59e0b",
  rangeShade: "rgba(34, 197, 94, 0.10)",
  marker: "#f59e0b",
};

export function formatChartPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1000) return n.toFixed(2);
  if (abs >= 1) return n.toFixed(4);
  if (abs >= 0.001) return n.toFixed(6);
  return n.toExponential(3);
}

export function formatChartSol(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.001) return n.toFixed(4);
  return n.toExponential(2);
}

/**
 * Pick the bins used for the x-axis ticks: the bin closest to each target
 * percentage (-80, -50, 0, +20, +40) plus the active bin.
 */
export function selectAxisTicks(series) {
  const bins = Array.isArray(series?.bins) ? series.bins : [];
  if (!bins.length) return [];
  const targets = [-80, -50, 0, 20, 40];
  const ticks = [];
  const seen = new Set();
  const pick = (bin) => {
    if (!bin || seen.has(bin.binId)) return;
    seen.add(bin.binId);
    ticks.push(bin);
  };
  if (series.activeBinId != null) pick(bins.find((bin) => bin.binId === series.activeBinId));
  const withPct = bins.filter((bin) => bin.pct != null);
  for (const target of targets) {
    if (!withPct.length) break;
    const closest = withPct.reduce((best, bin) =>
      Math.abs(bin.pct - target) < Math.abs(best.pct - target) ? bin : best, withPct[0]);
    pick(closest);
  }
  return ticks.sort((a, b) => a.binId - b.binId);
}

/** Group bins into at most `maxBars` buckets so wide ranges stay readable. */
export function bucketChartBins(bins = [], maxBars = MAX_CHART_BARS) {
  const list = Array.isArray(bins) ? bins : [];
  const limit = Math.max(1, Number(maxBars) || MAX_CHART_BARS);
  if (list.length <= limit) {
    return list.map((bin) => ({ ...bin, lastBinId: bin.binId }));
  }
  const size = Math.ceil(list.length / limit);
  const buckets = [];
  for (let i = 0; i < list.length; i += size) {
    const group = list.slice(i, i + size);
    buckets.push({
      binId: group[0].binId,
      lastBinId: group[group.length - 1].binId,
      price: group[0].price,
      pct: group[0].pct,
      valueSol: group.reduce((sum, bin) => sum + (Number(bin.valueSol) || 0), 0),
      inRange: group.some((bin) => bin.inRange),
    });
  }
  return buckets;
}

/**
 * Draw the chart with an injected canvas factory (so tests can run offline).
 * @returns {Buffer} PNG
 */
export function drawLiquidityChart(series, {
  createCanvas,
  width = CHART_DEFAULT_WIDTH,
  height = CHART_DEFAULT_HEIGHT,
} = {}) {
  if (typeof createCanvas !== "function") {
    throw new Error("drawLiquidityChart: a canvas factory is required.");
  }
  const sourceBins = Array.isArray(series?.bins) ? series.bins : [];
  if (!sourceBins.length) throw new Error("drawLiquidityChart: no bins to draw.");
  const bins = bucketChartBins(sourceBins);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const padLeft = 58;
  const padRight = 22;
  const padTop = 74;
  const padBottom = 74;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = COLORS.panel;
  ctx.fillRect(padLeft, padTop, plotW, plotH);

  const base = series.baseSymbol || "TOKEN";
  const quote = series.quoteSymbol || "SOL";
  ctx.fillStyle = COLORS.text;
  ctx.font = "bold 22px sans-serif";
  ctx.fillText(`${base}/${quote} · Liquidity Distribution`, padLeft, 36);

  ctx.font = "13px sans-serif";
  ctx.fillStyle = COLORS.muted;
  const rangeLabel = series.minBinId != null && series.maxBinId != null
    ? `Your range: ${series.minBinId} → ${series.maxBinId} (${series.inRangeBins} bins)`
    : "No range selected";
  ctx.fillText(rangeLabel, padLeft, 58);

  if (series.activePrice != null) {
    ctx.fillStyle = COLORS.barActive;
    const priceLabel = `now 1 ${base} = ${formatChartPrice(series.activePrice)} ${quote}`;
    const priceWidth = ctx.measureText(priceLabel).width;
    ctx.fillText(priceLabel, Math.max(padLeft, width - padRight - priceWidth), 58);
  }

  const maxSol = Math.max(...bins.map((bin) => Number(bin.valueSol) || 0), 1e-9);
  const slot = plotW / bins.length;
  const barW = Math.max(1, slot * 0.78);

  // Horizontal grid + y-axis labels (SOL per bin).
  ctx.font = "11px sans-serif";
  for (let i = 0; i <= 4; i += 1) {
    const y = padTop + plotH - (plotH * i) / 4;
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.stroke();
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(formatChartSol((maxSol * i) / 4), 6, y + 4);
  }

  const activeId = Number(series.activeBinId);
  let activeIndex = Number.isFinite(activeId)
    ? bins.findIndex((bin) => bin.binId <= activeId && (bin.lastBinId ?? bin.binId) >= activeId)
    : -1;
  if (activeIndex < 0) activeIndex = bins.findIndex((bin) => bin.binId === series.activeBinId);
  const inRangeIndexes = bins.map((bin, index) => (bin.inRange ? index : -1)).filter((index) => index >= 0);
  if (inRangeIndexes.length) {
    const first = Math.min(...inRangeIndexes);
    const last = Math.max(...inRangeIndexes);
    ctx.fillStyle = COLORS.rangeShade;
    ctx.fillRect(padLeft + first * slot, padTop, (last - first + 1) * slot, plotH);
  }

  bins.forEach((bin, index) => {
    const barHeight = Math.max(1, ((Number(bin.valueSol) || 0) / maxSol) * plotH);
    const x = padLeft + index * slot + (slot - barW) / 2;
    const y = padTop + plotH - barHeight;
    ctx.fillStyle = index === activeIndex
      ? COLORS.barActive
      : bin.inRange ? COLORS.barInRange : COLORS.bar;
    ctx.fillRect(x, y, barW, barHeight);
  });

  if (activeIndex >= 0) {
    const x = padLeft + activeIndex * slot + slot / 2;
    ctx.strokeStyle = COLORS.marker;
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, padTop + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // X-axis ticks: percentage delta + bin price.
  ctx.font = "11px sans-serif";
  for (const tick of selectAxisTicks(series)) {
    const index = bins.findIndex((bin) => tick.binId >= bin.binId && tick.binId <= (bin.lastBinId ?? bin.binId));
    if (index < 0) continue;
    const x = padLeft + index * slot + slot / 2;
    const isActive = tick.binId === series.activeBinId;
    ctx.fillStyle = isActive ? COLORS.barActive : COLORS.text;
    const heading = isActive ? "Active 0%" : `${tick.pct > 0 ? "+" : ""}${Number(tick.pct).toFixed(0)}%`;
    const headingWidth = ctx.measureText(heading).width;
    ctx.fillText(heading, Math.min(Math.max(x - headingWidth / 2, 2), width - headingWidth - 2), padTop + plotH + 20);
    ctx.fillStyle = COLORS.muted;
    const price = formatChartPrice(tick.price);
    const priceWidth = ctx.measureText(price).width;
    ctx.fillText(price, Math.min(Math.max(x - priceWidth / 2, 2), width - priceWidth - 2), padTop + plotH + 36);
  }

  // Legend.
  ctx.font = "12px sans-serif";
  const legendY = height - 18;
  let legendX = padLeft;
  for (const item of [
    { color: COLORS.barInRange, label: "Your range" },
    { color: COLORS.barActive, label: "Active bin" },
    { color: COLORS.bar, label: "Outside range" },
  ]) {
    ctx.fillStyle = item.color;
    ctx.fillRect(legendX, legendY - 9, 10, 10);
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(item.label, legendX + 15, legendY);
    legendX += 15 + ctx.measureText(item.label).width + 18;
  }

  return canvas.toBuffer("image/png");
}

/**
 * Generate the dashboard chart.
 *
 * @param {string|{address?: string, poolAddress?: string, baseSymbol?: string}} poolData
 * @param {{minBinId?: number, maxBinId?: number, binsBelow?: number, binsAbove?: number}|null} userRange
 * @param {{series?: object, createCanvas?: Function, width?: number, height?: number, binsEachSide?: number}} [options]
 * @returns {Promise<Buffer>} PNG buffer
 */
export async function generateLiquidityDistributionChart(poolData, userRange = null, options = {}) {
  const { series = null, createCanvas = null, binsEachSide = DEFAULT_BINS_EACH_SIDE, ...drawOptions } = options;
  try {
    const data = series || await fetchLiquiditySeries(poolData, userRange, { binsEachSide });
    const canvasFactory = createCanvas || (await loadCanvas()).createCanvas;
    return drawLiquidityChart(data, { ...drawOptions, createCanvas: canvasFactory });
  } catch (error) {
    log("chart_warn", `Liquidity chart failed: ${error.message}`);
    throw error;
  }
}

/**
 * Telegram photo captions are capped at 1024 chars, so keep whole HTML lines
 * and append an ellipsis instead of cutting a tag in half.
 */
export function buildPhotoCaption(text, limit = PHOTO_CAPTION_LIMIT) {
  const max = Math.max(16, Number(limit) || PHOTO_CAPTION_LIMIT);
  const raw = String(text ?? "");
  if (raw.length <= max) return raw;
  const reserved = 2; // "\n…"
  const lines = raw.split("\n");
  let caption = "";
  for (const line of lines) {
    const candidate = caption ? `${caption}\n${line}` : line;
    if (candidate.length > max - reserved) break;
    caption = candidate;
  }
  if (!caption) caption = raw.slice(0, max - reserved);
  return `${caption.replace(/\n+$/, "")}\n…`;
}

