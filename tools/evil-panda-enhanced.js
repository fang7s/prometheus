// ─── Evil Panda Strategy Module ───────────────────────────────────
// Implements screening filters and technical indicator exit engine for the Evil Panda Strategy

// Note: getPoolMetadata is commented out since it doesn't exist in dlmm.js exports
// import { getPoolMetadata } from "./dlmm.js";
import { log } from "../logger.js";

/**
 * Calculate RSI (Relative Strength Index)
 * @param {number[]} prices - Array of price values
 * @param {number} period - RSI calculation period (default: 2)
 * @returns {number|null} RSI value or null if insufficient data
 */
export function calculateRSI(prices, period = 2) {
  try {
    if (!prices || prices.length < period + 1) {
      return null;
    }

    let gains = 0;
    let losses = 0;
    
    // Calculate gains and losses for the last 'period' days
    for (let i = 1; i <= period; i++) {
      const change = prices[prices.length - i] - prices[prices.length - i - 1];
      if (change > 0) {
        gains += change;
      } else {
        losses -= change;
      }
    }
    
    if (losses === 0) return 100; // No loss = perfect gain
    
    const rs = gains / losses;
    return 100 - (100 / (1 + rs));
  } catch (error) {
    log("error", `Error calculating RSI: ${error.message}`);
    return null;
  }
}

/**
 * Calculate Bollinger Bands
 * @param {number[]} prices - Array of price values
 * @param {number} period - Bollinger Bands period (default: 20)
 * @param {number} stdDev - Standard deviation multiplier (default: 2)
 * @returns {Object|null} Bollinger Bands data or null if insufficient data
 */
export function calculateBollingerBands(prices, period = 20, stdDev = 2) {
  try {
    if (!prices || prices.length < period) {
      return null;
    }

    // Calculate simple moving average
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += prices[prices.length - 1 - i];
    }
    const sma = sum / period;

    // Calculate standard deviation
    let squaredDeviations = 0;
    for (let i = 0; i < period; i++) {
      const deviation = prices[prices.length - 1 - i] - sma;
      squaredDeviations += deviation * deviation;
    }
    const stdDeviation = Math.sqrt(squaredDeviations / period);

    // Calculate bands
    const upperBand = sma + (stdDev * stdDeviation);
    const lowerBand = sma - (stdDev * stdDeviation);

    return {
      sma,
      upperBand,
      lowerBand,
      stdDeviation
    };
  } catch (error) {
    log("error", `Error calculating Bollinger Bands: ${error.message}`);
    return null;
  }
}

/**
 * Calculate MACD (Moving Average Convergence Divergence)
 * @param {number[]} prices - Array of price values
 * @param {number} fastPeriod - Fast EMA period (default: 12)
 * @param {number} slowPeriod - Slow EMA period (default: 26)
 * @param {number} signalPeriod - Signal line period (default: 9)
 * @returns {Object|null} MACD data or null if insufficient data
 */
export function calculateMACD(prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  try {
    if (!prices || prices.length < slowPeriod + signalPeriod) {
      return null;
    }

    // Calculate EMAs
    const fastEMA = calculateEMA(prices, fastPeriod);
    const slowEMA = calculateEMA(prices, slowPeriod);

    if (fastEMA.length < 1 || slowEMA.length < 1) {
      return null;
    }

    // Calculate MACD line
    const macdLine = fastEMA[fastEMA.length - 1] - slowEMA[slowEMA.length - 1];

    // Calculate Signal line (EMA of MACD line)
    const macdLineArray = fastEMA.slice(-signalPeriod).map((_, i) => 
      fastEMA[fastEMA.length - signalPeriod + i] - slowEMA[slowEMA.length - signalPeriod + i]
    );
    const signalLine = calculateEMA(macdLineArray, signalPeriod)[0];
    
    // Calculate Histogram
    const histogram = macdLine - signalLine;

    return {
      macdLine,
      signalLine,
      histogram
    };
  } catch (error) {
    log("error", `Error calculating MACD: ${error.message}`);
    return null;
  }
}

/**
 * Helper function to calculate Exponential Moving Average
 * @param {number[]} prices - Array of price values
 * @param {number} period - EMA period
 * @returns {number[]} EMA values
 */
function calculateEMA(prices, period) {
  try {
    if (!prices || prices.length < period) {
      return [];
    }
    
    const multiplier = 2 / (period + 1);
    const emaValues = [];
    
    // Start with SMA for the first value
    let sum = 0;
    for (let i = 0; i < period; i++) {
      sum += prices[prices.length - period + i];
    }
    let ema = sum / period;
    emaValues.push(ema);
    
    // Calculate subsequent EMA values
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