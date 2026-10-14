// ─── Evil Panda Strategy Module ───────────────────────────────────
// Implements screening filters and technical indicator exit engine for the Evil Panda Strategy

import { log } from "../logger.js";

/**
 * Calculate RSI (Relative Strength Index)
 */
export function calculateRSI(prices, period = 2) {
  try {
    if (!prices || prices.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const change = prices[prices.length - i] - prices[prices.length - i - 1];
      if (change > 0) gains += change;
      else losses -= change;
    }
    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - (100 / (1 + rs));
  } catch (error) {
    log("error", `Error calculating RSI: ${error.message}`);
    return null;
  }
}

/**
 * Calculate Bollinger Bands
 */
export function calculateBollingerBands(prices, period = 20, stdDev = 2) {
  try {
    if (!prices || prices.length < period) return null;
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += prices[prices.length - 1 - i];
    }
    const sma = sum / period;
    let squaredDeviations = 0;
    for (let i = 0; i < period; i++) {
      const deviation = prices[prices.length - 1 - i] - sma;
      squaredDeviations += deviation * deviation;
    }
    const stdDeviation = Math.sqrt(squaredDeviations / period);
    return {
      sma,
      upperBand: sma + (stdDev * stdDeviation),
      lowerBand: sma - (stdDev * stdDeviation),
      stdDeviation
    };
  } catch (error) {
    log("error", `Error calculating Bollinger Bands: ${error.message}`);
    return null;
  }
}

/**
 * Calculate MACD
 */
export function calculateMACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  try {
    if (!prices || prices.length < slowPeriod + signalPeriod) return null;
    const fastEMA = calculateEMA(prices, fastPeriod);
    const slowEMA = calculateEMA(prices, slowPeriod);
    if (fastEMA.length < 1 || slowEMA.length < 1) return null;

    const macdLine = fastEMA[fastEMA.length - 1] - slowEMA[slowEMA.length - 1];
    const macdLineArray = fastEMA.slice(-signalPeriod).map((_, i) => 
      fastEMA[fastEMA.length - signalPeriod + i] - slowEMA[slowEMA.length - signalPeriod + i]
    );
    const signalLine = calculateEMA(macdLineArray, signalPeriod)[0];
    const histogram = macdLine - signalLine;

    return { macdLine, signalLine, histogram };
  } catch (error) {
    log("error", `Error calculating MACD: ${error.message}`);
    return null;
  }
}

function calculateEMA(prices, period) {
  try {
    if (!prices || prices.length < period) return [];
    const multiplier = 2 / (period + 1);
    const emaValues = [];
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += prices[prices.length - period + i];
    }
    let ema = sum / period;
    emaValues.push(ema);
    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema;
      emaValues.push(ema);
    }
    return emaValues;
  } catch (error) {
    log("error", `Error calculating EMA: ${error.message}`);
    return [];
  }
}

/**
 * Evaluate Evil Panda Screening Candidate
 */
export function evaluateEvilPandaCandidate(poolData) {
  try {
    const mcap = poolData?.mcap || poolData?.marketCap || 0;
    const volume24h = poolData?.volume24h || poolData?.volume || 0;
    
    const mcapPassed = mcap >= 250000;
    const volumePassed = volume24h >= 1000000;
    const passed = mcapPassed && volumePassed;

    return {
      passed,
      mcap,
      volume24h,
      reasons: [
        mcapPassed ? "MCAP >= $250k" : `MCAP $${mcap} < $250k`,
        volumePassed ? "Vol 24h >= $1M" : `Vol 24h $${volume24h} < $1M`
      ]
    };
  } catch (error) {
    log("error", `Error evaluating Evil Panda candidate: ${error.message}`);
    return { passed: false, reasons: [error.message] };
  }
}

/**
 * Check Evil Panda Confluence Exit Conditions
 */
export function checkEvilPandaExitConfluence(prices, currentPrice) {
  try {
    if (!prices || prices.length < 35) {
      return { shouldExit: false, reason: "Insufficient price history for technical indicators" };
    }

    const rsi = calculateRSI(prices, 2);
    const bb = calculateBollingerBands(prices, 20, 2);
    const macd = calculateMACD(prices, 12, 26, 9);

    if (rsi === null || !bb || !macd) {
      return { shouldExit: false, reason: "Failed to calculate indicators" };
    }

    const rsiTriggered = rsi > 90;
    const bbTriggered = currentPrice >= bb.upperBand;
    const macdTriggered = macd.histogram > 0;

    const confluence = rsiTriggered && (bbTriggered || macdTriggered);

    return {
      shouldExit: confluence,
      rsi,
      bbUpper: bb.upperBand,
      macdHistogram: macd.histogram,
      reason: confluence 
        ? `EXIT CONFLUENCE HIT: RSI(2)=${rsi.toFixed(2)} (>90) with BB/MACD confirmation`
        : "Hold position"
    };
  } catch (error) {
    log("error", `Error checking Evil Panda exit: ${error.message}`);
    return { shouldExit: false, reason: error.message };
  }
}

/**
 * Recommended DLMM Parameters for Evil Panda
 */
export function getEvilPandaRecommendedParams() {
  return {
    strategy: "SPOT / Bid-Ask",
    bins: [80, 100, 125],
    rangeMinPercent: -94,
    rangeMaxPercent: -86
  };
}