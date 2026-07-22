/**
 * Technical Indicators Module
 * Pure calculation functions – no DOM manipulation.
 * All functions accept an array of OHLCV objects: [{time, open, high, low, close, volume}]
 */

const Indicators = {

    /**
     * Simple Moving Average
     * @param {Array} data - OHLCV array
     * @param {number} period - look-back window
     * @returns {Array<{time, value}>}
     */
    SMA(data, period) {
        const result = [];
        if (!data || data.length < period) return result;

        let sum = 0;
        for (let i = 0; i < period; i++) {
            sum += data[i].close;
        }
        result.push({ time: data[period - 1].time, value: parseFloat((sum / period).toFixed(4)) });

        for (let i = period; i < data.length; i++) {
            sum += data[i].close - data[i - period].close;
            result.push({ time: data[i].time, value: parseFloat((sum / period).toFixed(4)) });
        }
        return result;
    },

    /**
     * Exponential Moving Average
     * Uses the first `period` values as the SMA seed.
     * @param {Array} data - OHLCV array
     * @param {number} period
     * @returns {Array<{time, value}>}
     */
    EMA(data, period) {
        const result = [];
        if (!data || data.length < period) return result;

        // Seed with SMA of first `period` closes
        let sum = 0;
        for (let i = 0; i < period; i++) {
            sum += data[i].close;
        }
        let ema = sum / period;
        result.push({ time: data[period - 1].time, value: parseFloat(ema.toFixed(4)) });

        const k = 2 / (period + 1);
        for (let i = period; i < data.length; i++) {
            ema = data[i].close * k + ema * (1 - k);
            result.push({ time: data[i].time, value: parseFloat(ema.toFixed(4)) });
        }
        return result;
    },

    /**
     * Relative Strength Index – Wilder's smoothing method
     * @param {Array} data - OHLCV array
     * @param {number} period - default 14
     * @returns {Array<{time, value}>}  value is 0-100
     */
    RSI(data, period = 14) {
        const result = [];
        if (!data || data.length < period + 1) return result;

        const changes = [];
        for (let i = 1; i < data.length; i++) {
            changes.push(data[i].close - data[i - 1].close);
        }

        // First average gain / loss (SMA over first `period` changes)
        let avgGain = 0;
        let avgLoss = 0;
        for (let i = 0; i < period; i++) {
            if (changes[i] >= 0) {
                avgGain += changes[i];
            } else {
                avgLoss += Math.abs(changes[i]);
            }
        }
        avgGain /= period;
        avgLoss /= period;

        let rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        let rsi = avgLoss === 0 ? 100 : parseFloat((100 - 100 / (1 + rs)).toFixed(2));
        // changes[period-1] corresponds to data[period], so RSI is for data[period]
        result.push({ time: data[period].time, value: rsi });

        // Wilder's smoothing
        for (let i = period; i < changes.length; i++) {
            const gain = changes[i] >= 0 ? changes[i] : 0;
            const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;

            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;

            rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
            rsi = avgLoss === 0 ? 100 : parseFloat((100 - 100 / (1 + rs)).toFixed(2));
            result.push({ time: data[i + 1].time, value: rsi });
        }

        return result;
    },

    /**
     * MACD (Moving Average Convergence Divergence)
     * @param {Array} data - OHLCV array
     * @param {number} fastPeriod - default 12
     * @param {number} slowPeriod - default 26
     * @param {number} signalPeriod - default 9
     * @returns {{macdLine: Array, signalLine: Array, histogram: Array}}
     */
    MACD(data, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        const emptyResult = { macdLine: [], signalLine: [], histogram: [] };
        if (!data || data.length < slowPeriod + signalPeriod) return emptyResult;

        const emaFast = this.EMA(data, fastPeriod);
        const emaSlow = this.EMA(data, slowPeriod);

        // Align the two EMA arrays by time
        const slowTimeSet = new Map();
        emaSlow.forEach(p => slowTimeSet.set(p.time, p.value));

        const macdLine = [];
        for (const point of emaFast) {
            if (slowTimeSet.has(point.time)) {
                macdLine.push({
                    time: point.time,
                    value: parseFloat((point.value - slowTimeSet.get(point.time)).toFixed(4)),
                });
            }
        }

        if (macdLine.length < signalPeriod) return emptyResult;

        // Signal line = EMA of MACD line
        const signalLine = [];
        let sum = 0;
        for (let i = 0; i < signalPeriod; i++) {
            sum += macdLine[i].value;
        }
        let signalEma = sum / signalPeriod;
        signalLine.push({ time: macdLine[signalPeriod - 1].time, value: parseFloat(signalEma.toFixed(4)) });

        const kSignal = 2 / (signalPeriod + 1);
        for (let i = signalPeriod; i < macdLine.length; i++) {
            signalEma = macdLine[i].value * kSignal + signalEma * (1 - kSignal);
            signalLine.push({ time: macdLine[i].time, value: parseFloat(signalEma.toFixed(4)) });
        }

        // Histogram = MACD - Signal, aligned by time
        const signalMap = new Map();
        signalLine.forEach(p => signalMap.set(p.time, p.value));

        const histogram = [];
        for (const point of macdLine) {
            if (signalMap.has(point.time)) {
                const val = parseFloat((point.value - signalMap.get(point.time)).toFixed(4));
                histogram.push({
                    time: point.time,
                    value: val,
                    color: val >= 0 ? '#00c9a7' : '#ef5350',
                });
            }
        }

        return { macdLine, signalLine, histogram };
    },

    /**
     * Bollinger Bands
     * @param {Array} data - OHLCV array
     * @param {number} period - default 20
     * @param {number} multiplier - default 2  (number of std deviations)
     * @returns {{upper: Array, middle: Array, lower: Array}}
     */
    BollingerBands(data, period = 20, multiplier = 2) {
        const upper = [];
        const middle = [];
        const lower = [];
        if (!data || data.length < period) return { upper, middle, lower };

        for (let i = period - 1; i < data.length; i++) {
            let sum = 0;
            for (let j = i - period + 1; j <= i; j++) {
                sum += data[j].close;
            }
            const sma = sum / period;

            let sqSum = 0;
            for (let j = i - period + 1; j <= i; j++) {
                sqSum += (data[j].close - sma) ** 2;
            }
            const stdDev = Math.sqrt(sqSum / period); // population std dev

            const time = data[i].time;
            middle.push({ time, value: parseFloat(sma.toFixed(4)) });
            upper.push({ time, value: parseFloat((sma + multiplier * stdDev).toFixed(4)) });
            lower.push({ time, value: parseFloat((sma - multiplier * stdDev).toFixed(4)) });
        }

        return { upper, middle, lower };
    },

    /**
     * Volume histogram data
     * @param {Array} data - OHLCV array
     * @returns {Array<{time, value, color}>}
     */
    Volume(data) {
        if (!data) return [];
        return data.map(d => ({
            time: d.time,
            value: d.volume,
            color: d.close >= d.open
                ? 'rgba(0, 201, 167, 0.35)'
                : 'rgba(239, 83, 80, 0.35)',
        }));
    },

    /**
     * Volume Moving Average — for volume confirmation analysis
     * @param {Array} data - OHLCV array
     * @param {number} period - default 20
     * @returns {Array<{time, value}>}
     */
    VolumeMA(data, period = 20) {
        const result = [];
        if (!data || data.length < period) return result;

        let sum = 0;
        for (let i = 0; i < period; i++) {
            sum += data[i].volume;
        }
        result.push({ time: data[period - 1].time, value: sum / period });

        for (let i = period; i < data.length; i++) {
            sum += data[i].volume - data[i - period].volume;
            result.push({ time: data[i].time, value: sum / period });
        }
        return result;
    },

    /**
     * Stochastic Oscillator (%K and %D)
     * %K = (Close - Lowest Low) / (Highest High - Lowest Low) * 100
     * %D = SMA of %K
     * @param {Array} data - OHLCV array
     * @param {number} kPeriod - %K look-back (default 14)
     * @param {number} dPeriod - %D smoothing (default 3)
     * @returns {{k: Array<{time, value}>, d: Array<{time, value}>}}
     */
    Stochastic(data, kPeriod = 14, dPeriod = 3) {
        const k = [];
        const d = [];
        if (!data || data.length < kPeriod) return { k, d };

        // Calculate raw %K
        for (let i = kPeriod - 1; i < data.length; i++) {
            let lowestLow = Infinity;
            let highestHigh = -Infinity;
            for (let j = i - kPeriod + 1; j <= i; j++) {
                if (data[j].low < lowestLow) lowestLow = data[j].low;
                if (data[j].high > highestHigh) highestHigh = data[j].high;
            }
            const range = highestHigh - lowestLow;
            const kVal = range > 0
                ? parseFloat(((data[i].close - lowestLow) / range * 100).toFixed(2))
                : 50;
            k.push({ time: data[i].time, value: kVal });
        }

        // %D = SMA of %K
        if (k.length >= dPeriod) {
            let sum = 0;
            for (let i = 0; i < dPeriod; i++) {
                sum += k[i].value;
            }
            d.push({ time: k[dPeriod - 1].time, value: parseFloat((sum / dPeriod).toFixed(2)) });

            for (let i = dPeriod; i < k.length; i++) {
                sum += k[i].value - k[i - dPeriod].value;
                d.push({ time: k[i].time, value: parseFloat((sum / dPeriod).toFixed(2)) });
            }
        }

        return { k, d };
    },

    /**
     * Average True Range (ATR) — measures volatility
     * TR = max(High-Low, |High-PrevClose|, |Low-PrevClose|)
     * ATR = Wilder's smoothed average of TR
     * @param {Array} data - OHLCV array
     * @param {number} period - default 14
     * @returns {Array<{time, value}>}
     */
    ATR(data, period = 14) {
        const result = [];
        if (!data || data.length < period + 1) return result;

        // Calculate True Range values
        const trValues = [];
        for (let i = 1; i < data.length; i++) {
            const high = data[i].high;
            const low = data[i].low;
            const prevClose = data[i - 1].close;
            const tr = Math.max(
                high - low,
                Math.abs(high - prevClose),
                Math.abs(low - prevClose)
            );
            trValues.push({ time: data[i].time, value: tr });
        }

        if (trValues.length < period) return result;

        // First ATR = simple average of first `period` TR values
        let atr = 0;
        for (let i = 0; i < period; i++) {
            atr += trValues[i].value;
        }
        atr /= period;
        result.push({ time: trValues[period - 1].time, value: parseFloat(atr.toFixed(4)) });

        // Wilder's smoothing for subsequent values
        for (let i = period; i < trValues.length; i++) {
            atr = (atr * (period - 1) + trValues[i].value) / period;
            result.push({ time: trValues[i].time, value: parseFloat(atr.toFixed(4)) });
        }

        return result;
    },

    /**
     * Average Directional Index (ADX) with +DI and -DI
     * Measures trend strength (ADX > 25 = strong trend)
     * @param {Array} data - OHLCV array
     * @param {number} period - default 14
     * @returns {{adx: Array<{time, value}>, plusDI: Array<{time, value}>, minusDI: Array<{time, value}>}}
     */
    ADX(data, period = 14) {
        const adx = [];
        const plusDI = [];
        const minusDI = [];
        if (!data || data.length < period * 2 + 1) return { adx, plusDI, minusDI };

        // Step 1: Calculate +DM, -DM, and TR
        const dmPlus = [];
        const dmMinus = [];
        const tr = [];

        for (let i = 1; i < data.length; i++) {
            const highDiff = data[i].high - data[i - 1].high;
            const lowDiff = data[i - 1].low - data[i].low;

            dmPlus.push(highDiff > lowDiff && highDiff > 0 ? highDiff : 0);
            dmMinus.push(lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0);

            const trVal = Math.max(
                data[i].high - data[i].low,
                Math.abs(data[i].high - data[i - 1].close),
                Math.abs(data[i].low - data[i - 1].close)
            );
            tr.push(trVal);
        }

        if (tr.length < period) return { adx, plusDI, minusDI };

        // Step 2: Wilder's smoothed +DM, -DM, TR
        let smoothTR = 0, smoothDMPlus = 0, smoothDMMinus = 0;
        for (let i = 0; i < period; i++) {
            smoothTR += tr[i];
            smoothDMPlus += dmPlus[i];
            smoothDMMinus += dmMinus[i];
        }

        // Calculate first +DI, -DI
        let pdi = smoothTR > 0 ? (smoothDMPlus / smoothTR) * 100 : 0;
        let mdi = smoothTR > 0 ? (smoothDMMinus / smoothTR) * 100 : 0;
        plusDI.push({ time: data[period].time, value: parseFloat(pdi.toFixed(2)) });
        minusDI.push({ time: data[period].time, value: parseFloat(mdi.toFixed(2)) });

        // Calculate DX values for ADX
        const dxValues = [];
        let dxVal = (pdi + mdi) > 0 ? Math.abs(pdi - mdi) / (pdi + mdi) * 100 : 0;
        dxValues.push(dxVal);

        // Continue for remaining data points
        for (let i = period; i < tr.length; i++) {
            smoothTR = smoothTR - (smoothTR / period) + tr[i];
            smoothDMPlus = smoothDMPlus - (smoothDMPlus / period) + dmPlus[i];
            smoothDMMinus = smoothDMMinus - (smoothDMMinus / period) + dmMinus[i];

            pdi = smoothTR > 0 ? (smoothDMPlus / smoothTR) * 100 : 0;
            mdi = smoothTR > 0 ? (smoothDMMinus / smoothTR) * 100 : 0;

            plusDI.push({ time: data[i + 1].time, value: parseFloat(pdi.toFixed(2)) });
            minusDI.push({ time: data[i + 1].time, value: parseFloat(mdi.toFixed(2)) });

            dxVal = (pdi + mdi) > 0 ? Math.abs(pdi - mdi) / (pdi + mdi) * 100 : 0;
            dxValues.push(dxVal);
        }

        // Step 3: ADX = Wilder's smoothed average of DX
        if (dxValues.length >= period) {
            let adxVal = 0;
            for (let i = 0; i < period; i++) {
                adxVal += dxValues[i];
            }
            adxVal /= period;
            // ADX starts at index (period-1) of dxValues, which corresponds to plusDI[period-1]
            adx.push({ time: plusDI[period - 1].time, value: parseFloat(adxVal.toFixed(2)) });

            for (let i = period; i < dxValues.length; i++) {
                adxVal = (adxVal * (period - 1) + dxValues[i]) / period;
                adx.push({ time: plusDI[i].time, value: parseFloat(adxVal.toFixed(2)) });
            }
        }

        return { adx, plusDI, minusDI };
    },

    /**
     * VWAP (Volume Weighted Average Price) — intraday indicator
     * VWAP = cumulative(Typical Price * Volume) / cumulative(Volume)
     * @param {Array} data - OHLCV array
     * @returns {Array<{time, value}>}
     */
    VWAP(data) {
        const result = [];
        if (!data || data.length === 0) return result;

        let cumTPV = 0;  // cumulative (Typical Price * Volume)
        let cumVol = 0;  // cumulative volume

        for (let i = 0; i < data.length; i++) {
            const tp = (data[i].high + data[i].low + data[i].close) / 3;
            cumTPV += tp * data[i].volume;
            cumVol += data[i].volume;

            const vwap = cumVol > 0 ? cumTPV / cumVol : tp;
            result.push({ time: data[i].time, value: parseFloat(vwap.toFixed(4)) });
        }

        return result;
    },
};
