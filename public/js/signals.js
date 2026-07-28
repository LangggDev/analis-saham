/**
 * Signal Engine Module v2.0
 * Analyzes technical indicator values and produces trading signals.
 * Now with proportional scoring, volume confirmation, and additional indicators.
 * Depends on: Indicators (indicators.js)
 */

const SignalEngine = {

    /**
     * Analyze all indicators and return an aggregate signal.
     * @param {Array} data - OHLCV array (needs ≥ 30 data points minimum)
     * @returns {{overall: string, score: number, signals: Array, trendStrength: string}}
     */
    analyze(data) {
        if (!data || data.length < 30) {
            return {
                overall: 'NEUTRAL',
                score: 0,
                signals: [],
                trendStrength: 'UNKNOWN',
            };
        }

        const signals = [];
        let totalScore = 0;
        let totalWeight = 0;

        const lastPrice = data[data.length - 1].close;
        const lastVolume = data[data.length - 1].volume;

        // --- RSI (Proportional) ---
        const rsiValues = Indicators.RSI(data, 14);
        if (rsiValues.length > 0) {
            const rsiSignal = this._analyzeRSI(rsiValues);
            signals.push(rsiSignal);
            totalScore += rsiSignal._score * 20;
            totalWeight += 20;
        }

        // --- MACD (with histogram momentum) ---
        const macdData = Indicators.MACD(data);
        if (macdData.macdLine.length > 0 && macdData.signalLine.length > 0) {
            const macdSignal = this._analyzeMACD(macdData);
            signals.push(macdSignal);
            totalScore += macdSignal._score * 18;
            totalWeight += 18;
        }

        // --- SMA 20 ---
        const sma20 = Indicators.SMA(data, 20);
        if (sma20.length > 0) {
            const sig = this._analyzeSMA(data, sma20, 20);
            signals.push(sig);
            totalScore += sig._score * 8;
            totalWeight += 8;
        }

        // --- SMA 50 ---
        const sma50 = Indicators.SMA(data, 50);
        if (sma50.length > 0) {
            const sig = this._analyzeSMA(data, sma50, 50);
            signals.push(sig);
            totalScore += sig._score * 10;
            totalWeight += 10;
        }

        // --- SMA 200 ---
        const sma200 = Indicators.SMA(data, 200);
        if (sma200.length > 0) {
            const sig = this._analyzeSMA(data, sma200, 200);
            signals.push(sig);
            totalScore += sig._score * 12;
            totalWeight += 12;
        }

        // --- Golden/Death Cross (SMA 50/200) ---
        if (sma50.length > 2 && sma200.length > 2) {
            const crossSig = this._analyzeGoldenDeathCross(sma50, sma200);
            if (crossSig) {
                signals.push(crossSig);
                totalScore += crossSig._score * 10;
                totalWeight += 10;
            }
        }

        // --- Bollinger Bands (with %B) ---
        const bbData = Indicators.BollingerBands(data);
        if (bbData.upper.length > 0) {
            const bbSignal = this._analyzeBollinger(data, bbData);
            signals.push(bbSignal);
            totalScore += bbSignal._score * 8;
            totalWeight += 8;
        }

        // --- EMA Cross 12/26 ---
        const ema12 = Indicators.EMA(data, 12);
        const ema26 = Indicators.EMA(data, 26);
        if (ema12.length > 0 && ema26.length > 0) {
            const emaSig = this._analyzeEMACross(ema12, ema26);
            signals.push(emaSig);
            totalScore += emaSig._score * 8;
            totalWeight += 8;
        }

        // --- Stochastic Oscillator ---
        const stochData = Indicators.Stochastic(data, 14, 3);
        if (stochData.k.length > 0 && stochData.d.length > 0) {
            const stochSig = this._analyzeStochastic(stochData);
            signals.push(stochSig);
            totalScore += stochSig._score * 10;
            totalWeight += 10;
        }

        // --- ADX (Trend Strength) ---
        let trendStrength = 'UNKNOWN';
        const adxData = Indicators.ADX(data, 14);
        if (adxData.adx.length > 0) {
            const adxSig = this._analyzeADX(adxData);
            signals.push(adxSig);
            trendStrength = adxSig._trendStrength;
            // ADX doesn't predict direction, so weight is lower
            totalScore += adxSig._score * 6;
            totalWeight += 6;
        }

        // --- Volume Confirmation ---
        const volMA = Indicators.VolumeMA(data, 20);
        if (volMA.length > 0) {
            const volSig = this._analyzeVolume(data, volMA);
            signals.push(volSig);
            // Volume confirms trend but doesn't predict direction alone
            totalScore += volSig._score * 5;
            totalWeight += 5;
        }

        // --- ATR (Average True Range) & Volatility Risk/Reward ---
        const atrValues = Indicators.ATR(data, 14);
        const lastATR = atrValues.length > 0 ? atrValues[atrValues.length - 1].value : lastPrice * 0.02;
        const atrStopLoss = Math.max(1, Math.round(lastPrice - 1.5 * lastATR));
        const riskDistance = Math.max(lastPrice - atrStopLoss, lastPrice * 0.015);
        const atrTakeProfit = Math.round(lastPrice + Math.max(riskDistance * 2, 3 * lastATR));

        // --- Bull Trap & Divergence Scanner (Last 20 bars) ---
        let divergence = 'NONE';
        const rsiValLast = rsiValues && rsiValues.length > 0 ? rsiValues[rsiValues.length - 1].value : 50;
        if (data.length >= 20) {
            const pastSlice = data.slice(-20, -3);
            const maxPastClose = Math.max(...pastSlice.map(d => d.close));
            const minPastClose = Math.min(...pastSlice.map(d => d.close));
            
            if (lastPrice >= maxPastClose * 0.995 && rsiValLast < 58) {
                divergence = 'BEARISH_BULL_TRAP';
                signals.push({
                    name: 'Divergence Scanner',
                    signal: 'SELL',
                    value: `RSI ${rsiValLast.toFixed(1)}`,
                    desc: '🚨 Waspada Bull Trap (Bearish Divergence): Harga melaju tinggi tanpa didukung momentum RSI',
                    _score: -0.8
                });
            } else if (lastPrice <= minPastClose * 1.005 && rsiValLast > 35) {
                divergence = 'BULLISH_ACCUMULATION';
                signals.push({
                    name: 'Divergence Scanner',
                    signal: 'BUY',
                    value: `RSI ${rsiValLast.toFixed(1)}`,
                    desc: '🟢 Bullish Divergence terdeteksi: Akumulasi di area bottom, potensi reversal tajam',
                    _score: 0.8
                });
            }
        }

        // --- Liquidity & Anti-Penny Stock Trap Protection ---
        const avgVolVal = volMA && volMA.length > 0 ? volMA[volMA.length - 1].value : lastVolume;
        const dailyTurnover = avgVolVal * lastPrice;
        const isIlliquidTrap = lastPrice <= 60 || (dailyTurnover < 250000000 && lastPrice < 5000) || avgVolVal < 15000;
        if (isIlliquidTrap) {
            signals.push({
                name: 'Liquidity Filter',
                signal: 'NEUTRAL',
                value: `Turnover ${Math.round(dailyTurnover / 1000000)}M`,
                desc: '⚠️ Proteksi Likuiditas: Volume/transaksi rendah (rawan jebakan volatilitas saham gila/penny stock)',
                _score: -0.5
            });
        }

        // Multi-Factor Precision Technical & Momentum Scoring (0-100 Scale, unified with Recommendation Engine)
        let precisionScore = 50;

        // 1. RSI Factor (+/- 20)
        if (rsiValues && rsiValues.length > 0) {
            const rsiVal = rsiValues[rsiValues.length - 1].value;
            if (rsiVal <= 30) precisionScore += 20;
            else if (rsiVal <= 40) precisionScore += 10;
            else if (rsiVal >= 70) precisionScore -= 20;
            else if (rsiVal >= 60) precisionScore -= 10;
        }

        // 2. Moving Average Trend Factor (+/- 20)
        const getVal = (arr) => arr && arr.length > 0 ? arr[arr.length - 1].value : null;
        const s20 = getVal(sma20);
        const s50 = getVal(sma50);
        const s200 = getVal(sma200);

        if (s20 && lastPrice > s20) precisionScore += 6;
        else if (s20) precisionScore -= 6;
        if (s50 && lastPrice > s50) precisionScore += 7;
        else if (s50) precisionScore -= 7;
        if (s200 && lastPrice > s200) precisionScore += 7;
        else if (s200) precisionScore -= 7;

        // 3. Golden / Death Cross Factor (+/- 10)
        if (s50 && s200) {
            if (s50 > s200) precisionScore += 10;
            else precisionScore -= 10;
        }

        // 4. MACD Momentum (+/- 15)
        if (macdData && macdData.macdLine.length > 0 && macdData.signalLine.length > 0) {
            const mLine = macdData.macdLine[macdData.macdLine.length - 1].value;
            const sigLine = macdData.signalLine[macdData.signalLine.length - 1].value;
            const mHist = macdData.histogram && macdData.histogram.length > 0 ? macdData.histogram[macdData.histogram.length - 1].value : 0;
            if (mLine > sigLine) {
                precisionScore += 10;
                if (mHist > 0) precisionScore += 5;
            } else {
                precisionScore -= 10;
                if (mHist < 0) precisionScore -= 5;
            }
        }

        // 5. Volume Breakout Factor (+/- 15, nullified if illiquid trap)
        if (!isIlliquidTrap && volMA && volMA.length > 0) {
            const avgVol = volMA[volMA.length - 1].value;
            const volRatio = avgVol > 0 ? lastVolume / avgVol : 1;
            const prevPrice = data.length >= 2 ? data[data.length - 2].close : lastPrice;
            if (volRatio > 1.5 && lastPrice > prevPrice) precisionScore += 15;
            else if (volRatio > 1.5 && lastPrice < prevPrice) precisionScore -= 15;
            else if (volRatio > 1.2 && lastPrice > prevPrice) precisionScore += 8;
        }

        // 6. Stochastic Factor (+/- 10)
        if (stochData && stochData.k.length > 0) {
            const stochK = stochData.k[stochData.k.length - 1].value;
            if (stochK < 20) precisionScore += 10;
            else if (stochK > 80) precisionScore -= 10;
        }

        // 7. Divergence Synergy (+/- 15)
        if (divergence === 'BULLISH_ACCUMULATION') precisionScore += 15;
        else if (divergence === 'BEARISH_BULL_TRAP') precisionScore -= 15;

        // 8. Liquidity Trap Safety Override (Cap score at 45)
        if (isIlliquidTrap) {
            precisionScore = Math.min(precisionScore - 20, 45);
        }

        // Clamp final normalized technical score to 0-100 scale
        const score = Math.max(0, Math.min(100, Math.round(precisionScore)));

        // Strip internal fields from public output
        const cleanSignals = signals.map(({ _score, _trendStrength, ...rest }) => rest);

        // ── Fibonacci Retracement Levels ──
        const fibLookback = Math.min(60, data.length);
        const fibSlice = data.slice(-fibLookback);
        const fibHigh = Math.max(...fibSlice.map(d => d.high));
        const fibLow = Math.min(...fibSlice.map(d => d.low));
        const fibRange = fibHigh - fibLow;
        const fibonacci = {
            level0: parseFloat(fibHigh.toFixed(0)),
            level236: parseFloat((fibHigh - fibRange * 0.236).toFixed(0)),
            level382: parseFloat((fibHigh - fibRange * 0.382).toFixed(0)),
            level500: parseFloat((fibHigh - fibRange * 0.5).toFixed(0)),
            level618: parseFloat((fibHigh - fibRange * 0.618).toFixed(0)),
            level786: parseFloat((fibHigh - fibRange * 0.786).toFixed(0)),
            level1: parseFloat(fibLow.toFixed(0)),
        };

        // ── Profit Estimation Engine ──
        const profitEstimation = this._calculateProfitEstimation(
            data, lastPrice, lastATR, atrStopLoss, atrTakeProfit,
            score, rsiValLast, divergence, isIlliquidTrap,
            volMA, lastVolume
        );

        return {
            overall: this._scoreToSignal(score),
            score,
            signals: cleanSignals,
            trendStrength,
            atr: parseFloat(lastATR.toFixed(2)),
            atrStopLoss,
            atrTakeProfit,
            fibonacci,
            profitEstimation,
            divergence,
            isIlliquidTrap,
            dailyTurnover: Math.round(dailyTurnover)
        };
    },

    /* ------------------------------------------------------------------ */
    /*  Individual signal analysers — PROPORTIONAL SCORING                  */
    /* ------------------------------------------------------------------ */

    /**
     * RSI analysis — proportional scoring
     * RSI 15 → +0.9, RSI 29 → +0.5, RSI 35 → +0.2, RSI 50 → 0, RSI 65 → -0.2, RSI 71 → -0.5, RSI 85 → -0.9
     */
    _analyzeRSI(rsiValues) {
        const lastRSI = rsiValues[rsiValues.length - 1].value;
        // Check recent RSI for divergence context
        const prevRSI = rsiValues.length >= 3 ? rsiValues[rsiValues.length - 3].value : lastRSI;
        let signal, description, score;

        if (lastRSI >= 80) {
            signal = 'STRONG_SELL';
            description = `RSI ${lastRSI.toFixed(1)} — sangat overbought, potensi reversal kuat`;
            score = -0.9;
        } else if (lastRSI >= 70) {
            signal = 'SELL';
            // Proportional: 70→-0.5, 80→-0.9 (linear interpolation)
            score = -0.5 - ((lastRSI - 70) / 10) * 0.4;
            description = `RSI ${lastRSI.toFixed(1)} — overbought`;
        } else if (lastRSI >= 60) {
            signal = 'NEUTRAL';
            // 60→-0.1, 70→-0.5
            score = -0.1 - ((lastRSI - 60) / 10) * 0.4;
            description = `RSI ${lastRSI.toFixed(1)} — condong overbought`;
        } else if (lastRSI > 40) {
            signal = 'NEUTRAL';
            // 40→+0.1, 50→0, 60→-0.1 (centered at 50)
            score = (50 - lastRSI) / 100;
            description = `RSI ${lastRSI.toFixed(1)} — zona netral`;
        } else if (lastRSI > 30) {
            signal = 'NEUTRAL';
            // 30→+0.5, 40→+0.1
            score = 0.1 + ((40 - lastRSI) / 10) * 0.4;
            description = `RSI ${lastRSI.toFixed(1)} — condong oversold`;
        } else if (lastRSI > 20) {
            signal = 'BUY';
            // 20→+0.9, 30→+0.5
            score = 0.5 + ((30 - lastRSI) / 10) * 0.4;
            description = `RSI ${lastRSI.toFixed(1)} — oversold`;
        } else {
            signal = 'STRONG_BUY';
            description = `RSI ${lastRSI.toFixed(1)} — sangat oversold, potensi rebound kuat`;
            score = 0.9;
        }

        // Add RSI momentum context
        if (lastRSI < 40 && prevRSI < lastRSI) {
            description += ' ↑ mulai naik';
        } else if (lastRSI > 60 && prevRSI > lastRSI) {
            description += ' ↓ mulai turun';
        }

        return {
            name: 'RSI (14)',
            value: parseFloat(lastRSI.toFixed(1)),
            signal,
            description,
            _score: score,
        };
    },

    /**
     * MACD analysis — with histogram momentum
     */
    _analyzeMACD(macdData) {
        const lastMACD = macdData.macdLine[macdData.macdLine.length - 1].value;
        const lastSignal = macdData.signalLine[macdData.signalLine.length - 1].value;
        const histogram = macdData.histogram;

        let signal, description, score;
        const diff = lastMACD - lastSignal;

        // Check histogram momentum (is it growing or shrinking?)
        let histMomentum = 'flat';
        if (histogram.length >= 3) {
            const h1 = histogram[histogram.length - 1].value;
            const h2 = histogram[histogram.length - 2].value;
            const h3 = histogram[histogram.length - 3].value;
            if (h1 > h2 && h2 > h3) histMomentum = 'growing';
            else if (h1 < h2 && h2 < h3) histMomentum = 'shrinking';
        }

        // Detect fresh crossover (within last 3 bars)
        let freshCrossover = false;
        if (macdData.macdLine.length >= 3 && macdData.signalLine.length >= 3) {
            const prevMACD = macdData.macdLine[macdData.macdLine.length - 3].value;
            const prevSig = macdData.signalLine[macdData.signalLine.length - 3].value;
            if ((prevMACD <= prevSig && lastMACD > lastSignal) ||
                (prevMACD >= prevSig && lastMACD < lastSignal)) {
                freshCrossover = true;
            }
        }

        if (lastMACD > lastSignal) {
            // Bullish
            const strength = Math.min(Math.abs(diff) / (Math.abs(lastMACD) + 0.001), 1);
            score = 0.3 + strength * 0.5;
            if (histMomentum === 'growing') {
                score = Math.min(score + 0.15, 1);
                signal = 'BUY';
                description = 'MACD bullish & momentum menguat ↑';
            } else if (histMomentum === 'shrinking') {
                score = Math.max(score - 0.2, 0.1);
                signal = 'NEUTRAL';
                description = 'MACD bullish tapi momentum melemah ↓';
            } else {
                signal = 'BUY';
                description = 'MACD di atas signal line';
            }
            if (freshCrossover) {
                score = Math.min(score + 0.2, 1);
                description = '🔥 MACD baru saja bullish crossover!';
                signal = 'BUY';
            }
        } else if (lastMACD < lastSignal) {
            // Bearish
            const strength = Math.min(Math.abs(diff) / (Math.abs(lastMACD) + 0.001), 1);
            score = -(0.3 + strength * 0.5);
            if (histMomentum === 'growing') {
                // Histogram growing (less negative) = bearish momentum weakening
                score = Math.min(score + 0.2, -0.1);
                signal = 'NEUTRAL';
                description = 'MACD bearish tapi momentum melemah ↑';
            } else if (histMomentum === 'shrinking') {
                // Histogram shrinking (more negative) = bearish momentum strengthening
                score = Math.max(score - 0.15, -1);
                signal = 'SELL';
                description = 'MACD bearish & momentum menguat ↓';
            } else {
                signal = 'SELL';
                description = 'MACD di bawah signal line';
            }
            if (freshCrossover) {
                score = Math.max(score - 0.2, -1);
                description = '⚠️ MACD baru saja bearish crossover!';
                signal = 'SELL';
            }
        } else {
            signal = 'NEUTRAL';
            description = 'MACD sama dengan signal line';
            score = 0;
        }

        return {
            name: 'MACD',
            value: parseFloat(lastMACD.toFixed(2)),
            signal,
            description,
            _score: score,
        };
    },

    /**
     * SMA analysis — proportional distance scoring
     */
    _analyzeSMA(data, smaValues, period) {
        const lastPrice = data[data.length - 1].close;
        const lastSMA = smaValues[smaValues.length - 1].value;

        let signal, description, score;

        // Calculate percentage distance from SMA
        const pctDistance = ((lastPrice - lastSMA) / lastSMA) * 100;

        if (pctDistance > 0) {
            // Above SMA — bullish, but strength depends on distance
            if (pctDistance > 10) {
                score = 0.3; // Too far above — potential pullback, reduced bullish score
                description = `Harga ${pctDistance.toFixed(1)}% di atas SMA ${period} — terlalu jauh, waspada pullback`;
                signal = 'NEUTRAL';
            } else {
                score = 0.3 + Math.min(pctDistance / 10, 1) * 0.5;
                description = `Harga ${pctDistance.toFixed(1)}% di atas SMA ${period}`;
                signal = 'BUY';
            }
        } else if (pctDistance < 0) {
            const absDist = Math.abs(pctDistance);
            if (absDist > 10) {
                score = -0.3; // Too far below — potential bounce, reduced bearish score
                description = `Harga ${absDist.toFixed(1)}% di bawah SMA ${period} — potensi bounce`;
                signal = 'NEUTRAL';
            } else {
                score = -(0.3 + Math.min(absDist / 10, 1) * 0.5);
                description = `Harga ${absDist.toFixed(1)}% di bawah SMA ${period}`;
                signal = 'SELL';
            }
        } else {
            signal = 'NEUTRAL';
            description = `Harga tepat di SMA ${period}`;
            score = 0;
        }

        return {
            name: `SMA ${period}`,
            value: parseFloat(lastSMA.toFixed(2)),
            signal,
            description,
            _score: score,
        };
    },

    /**
     * Golden Cross / Death Cross detection (SMA 50 vs SMA 200)
     */
    _analyzeGoldenDeathCross(sma50, sma200) {
        // Align by time
        const len50 = sma50.length;
        const len200 = sma200.length;
        if (len50 < 3 || len200 < 3) return null;

        const curr50 = sma50[len50 - 1].value;
        const curr200 = sma200[len200 - 1].value;
        const prev50 = sma50[len50 - 5] ? sma50[len50 - 5].value : sma50[len50 - 2].value;
        const prev200 = sma200[len200 - 5] ? sma200[len200 - 5].value : sma200[len200 - 2].value;

        let signal, description, score;

        // Check for recent crossover
        const wasBelow = prev50 < prev200;
        const isAbove = curr50 > curr200;
        const wasAbove = prev50 > prev200;
        const isBelow = curr50 < curr200;

        if (wasBelow && isAbove) {
            // Golden Cross — very bullish
            signal = 'STRONG_BUY';
            description = '✨ Golden Cross! SMA 50 menembus di atas SMA 200';
            score = 0.9;
        } else if (wasAbove && isBelow) {
            // Death Cross — very bearish
            signal = 'STRONG_SELL';
            description = '💀 Death Cross! SMA 50 jatuh di bawah SMA 200';
            score = -0.9;
        } else if (isAbove) {
            signal = 'BUY';
            description = 'SMA 50 di atas SMA 200 — trend bullish';
            score = 0.5;
        } else {
            signal = 'SELL';
            description = 'SMA 50 di bawah SMA 200 — trend bearish';
            score = -0.5;
        }

        return {
            name: 'Cross 50/200',
            value: isAbove ? 'Golden' : 'Death',
            signal,
            description,
            _score: score,
        };
    },

    /**
     * Bollinger Bands analysis — with %B position
     */
    _analyzeBollinger(data, bbData) {
        const lastPrice = data[data.length - 1].close;
        const lastUpper = bbData.upper[bbData.upper.length - 1].value;
        const lastLower = bbData.lower[bbData.lower.length - 1].value;
        const lastMiddle = bbData.middle[bbData.middle.length - 1].value;

        const bandWidth = lastUpper - lastLower;

        // Calculate %B: (Price - Lower) / (Upper - Lower) * 100
        const percentB = bandWidth > 0
            ? ((lastPrice - lastLower) / bandWidth) * 100
            : 50;

        // Detect Bollinger Squeeze (low volatility → potential breakout)
        let squeeze = false;
        if (bbData.upper.length >= 20) {
            const recentBW = lastUpper - lastLower;
            let avgBW = 0;
            for (let i = bbData.upper.length - 20; i < bbData.upper.length; i++) {
                avgBW += bbData.upper[i].value - bbData.lower[i].value;
            }
            avgBW /= 20;
            squeeze = recentBW < avgBW * 0.7;
        }

        let signal, description, score, positionLabel;

        if (percentB >= 95) {
            signal = 'SELL';
            description = 'Harga menembus upper BB — overbought (%B: ' + percentB.toFixed(0) + ')';
            score = -0.8;
            positionLabel = 'Upper';
        } else if (percentB >= 80) {
            signal = 'SELL';
            // 80→-0.3, 95→-0.8
            score = -0.3 - ((percentB - 80) / 15) * 0.5;
            description = `Harga mendekati upper BB (%B: ${percentB.toFixed(0)})`;
            positionLabel = 'Upper';
        } else if (percentB >= 55) {
            signal = 'NEUTRAL';
            score = (60 - percentB) / 100;
            description = `Harga di tengah-atas BB (%B: ${percentB.toFixed(0)})`;
            positionLabel = 'Middle+';
        } else if (percentB >= 45) {
            signal = 'NEUTRAL';
            score = 0;
            description = `Harga tepat di tengah BB (%B: ${percentB.toFixed(0)})`;
            positionLabel = 'Middle';
        } else if (percentB >= 20) {
            signal = 'BUY';
            // 20→+0.8, 45→+0.1
            score = 0.1 + ((45 - percentB) / 25) * 0.7;
            description = `Harga mendekati lower BB (%B: ${percentB.toFixed(0)})`;
            positionLabel = 'Lower';
        } else {
            signal = 'BUY';
            description = 'Harga menembus lower BB — oversold (%B: ' + percentB.toFixed(0) + ')';
            score = 0.8;
            positionLabel = 'Lower';
        }

        if (squeeze) {
            description += ' ⚡ Squeeze terdeteksi!';
        }

        return {
            name: 'Bollinger',
            value: `%B: ${percentB.toFixed(0)} (${positionLabel})`,
            signal,
            description,
            _score: score,
        };
    },

    /**
     * EMA Cross analysis (12 / 26) — with crossover detection
     */
    _analyzeEMACross(ema12, ema26) {
        const last12 = ema12[ema12.length - 1];
        const last26 = ema26[ema26.length - 1];

        // Check for recent crossover
        let freshCross = false;
        if (ema12.length >= 3 && ema26.length >= 3) {
            const prev12 = ema12[ema12.length - 3].value;
            const prev26 = ema26[ema26.length - 3].value;
            if ((prev12 <= prev26 && last12.value > last26.value) ||
                (prev12 >= prev26 && last12.value < last26.value)) {
                freshCross = true;
            }
        }

        let signal, description, score;
        const pctDiff = ((last12.value - last26.value) / last26.value) * 100;

        if (last12.value > last26.value) {
            score = 0.3 + Math.min(Math.abs(pctDiff) / 5, 0.5);
            signal = 'BUY';
            description = `EMA 12 di atas EMA 26 (+${pctDiff.toFixed(2)}%)`;
            if (freshCross) {
                score = Math.min(score + 0.2, 1);
                description = '🔥 EMA 12/26 baru bullish crossover!';
            }
        } else if (last12.value < last26.value) {
            score = -(0.3 + Math.min(Math.abs(pctDiff) / 5, 0.5));
            signal = 'SELL';
            description = `EMA 12 di bawah EMA 26 (${pctDiff.toFixed(2)}%)`;
            if (freshCross) {
                score = Math.max(score - 0.2, -1);
                description = '⚠️ EMA 12/26 baru bearish crossover!';
            }
        } else {
            signal = 'NEUTRAL';
            description = 'EMA 12 sama dengan EMA 26';
            score = 0;
        }

        return {
            name: 'EMA Cross',
            value: '12/26',
            signal,
            description,
            _score: score,
        };
    },

    /**
     * Stochastic Oscillator analysis — proportional scoring
     */
    _analyzeStochastic(stochData) {
        const lastK = stochData.k[stochData.k.length - 1].value;
        const lastD = stochData.d[stochData.d.length - 1].value;

        let signal, description, score;

        // Check for %K/%D crossover
        let crossover = '';
        if (stochData.k.length >= 2 && stochData.d.length >= 2) {
            const prevK = stochData.k[stochData.k.length - 2].value;
            const prevD = stochData.d[stochData.d.length - 2].value;
            if (prevK <= prevD && lastK > lastD) crossover = 'bullish';
            else if (prevK >= prevD && lastK < lastD) crossover = 'bearish';
        }

        if (lastK >= 80) {
            // Overbought zone
            if (crossover === 'bearish') {
                signal = 'STRONG_SELL';
                score = -0.9;
                description = `Stoch overbought (%K:${lastK.toFixed(0)}) + bearish cross`;
            } else {
                signal = 'SELL';
                score = -0.5 - ((lastK - 80) / 20) * 0.3;
                description = `Stoch overbought (%K:${lastK.toFixed(0)}, %D:${lastD.toFixed(0)})`;
            }
        } else if (lastK <= 20) {
            // Oversold zone
            if (crossover === 'bullish') {
                signal = 'STRONG_BUY';
                score = 0.9;
                description = `Stoch oversold (%K:${lastK.toFixed(0)}) + bullish cross`;
            } else {
                signal = 'BUY';
                score = 0.5 + ((20 - lastK) / 20) * 0.3;
                description = `Stoch oversold (%K:${lastK.toFixed(0)}, %D:${lastD.toFixed(0)})`;
            }
        } else {
            // Middle zone — slight bias based on position
            signal = 'NEUTRAL';
            score = (50 - lastK) / 100;
            description = `Stoch netral (%K:${lastK.toFixed(0)}, %D:${lastD.toFixed(0)})`;
            if (crossover === 'bullish') {
                score += 0.3;
                signal = 'BUY';
                description += ' + bullish cross ↑';
            } else if (crossover === 'bearish') {
                score -= 0.3;
                signal = 'SELL';
                description += ' + bearish cross ↓';
            }
        }

        return {
            name: 'Stochastic',
            value: `%K:${lastK.toFixed(0)} %D:${lastD.toFixed(0)}`,
            signal,
            description,
            _score: Math.max(-1, Math.min(1, score)),
        };
    },

    /**
     * ADX analysis — measures trend strength, not direction
     */
    _analyzeADX(adxData) {
        const lastADX = adxData.adx[adxData.adx.length - 1].value;
        const lastPDI = adxData.plusDI[adxData.plusDI.length - 1].value;
        const lastMDI = adxData.minusDI[adxData.minusDI.length - 1].value;

        let signal, description, score, trendStrength;

        // ADX tells strength, +DI vs -DI tells direction
        const isBullish = lastPDI > lastMDI;

        if (lastADX >= 40) {
            trendStrength = 'VERY_STRONG';
            if (isBullish) {
                signal = 'BUY';
                score = 0.6;
                description = `ADX ${lastADX.toFixed(0)} — trend naik sangat kuat (+DI:${lastPDI.toFixed(0)} > -DI:${lastMDI.toFixed(0)})`;
            } else {
                signal = 'SELL';
                score = -0.6;
                description = `ADX ${lastADX.toFixed(0)} — trend turun sangat kuat (-DI:${lastMDI.toFixed(0)} > +DI:${lastPDI.toFixed(0)})`;
            }
        } else if (lastADX >= 25) {
            trendStrength = 'STRONG';
            if (isBullish) {
                signal = 'BUY';
                score = 0.4;
                description = `ADX ${lastADX.toFixed(0)} — trend naik kuat`;
            } else {
                signal = 'SELL';
                score = -0.4;
                description = `ADX ${lastADX.toFixed(0)} — trend turun kuat`;
            }
        } else if (lastADX >= 20) {
            trendStrength = 'MODERATE';
            signal = 'NEUTRAL';
            score = isBullish ? 0.15 : -0.15;
            description = `ADX ${lastADX.toFixed(0)} — trend moderat`;
        } else {
            trendStrength = 'WEAK';
            signal = 'NEUTRAL';
            score = 0;
            description = `ADX ${lastADX.toFixed(0)} — tidak ada trend jelas (sideways)`;
        }

        return {
            name: 'ADX',
            value: parseFloat(lastADX.toFixed(1)),
            signal,
            description,
            _score: score,
            _trendStrength: trendStrength,
        };
    },

    /**
     * Volume analysis — confirms trend strength
     */
    _analyzeVolume(data, volMA) {
        const lastVolume = data[data.length - 1].volume;
        const avgVolume = volMA[volMA.length - 1].value;
        const lastPrice = data[data.length - 1].close;
        const prevPrice = data.length >= 2 ? data[data.length - 2].close : lastPrice;

        const volRatio = avgVolume > 0 ? lastVolume / avgVolume : 1;
        const priceUp = lastPrice > prevPrice;

        let signal, description, score;

        if (volRatio >= 2.0) {
            // Very high volume — strong confirmation
            if (priceUp) {
                signal = 'BUY';
                score = 0.6;
                description = `Volume ${volRatio.toFixed(1)}x rata-rata + harga naik — akumulasi kuat`;
            } else {
                signal = 'SELL';
                score = -0.6;
                description = `Volume ${volRatio.toFixed(1)}x rata-rata + harga turun — distribusi kuat`;
            }
        } else if (volRatio >= 1.3) {
            // Above average
            if (priceUp) {
                signal = 'BUY';
                score = 0.3;
                description = `Volume di atas rata-rata (${volRatio.toFixed(1)}x) + harga naik`;
            } else {
                signal = 'SELL';
                score = -0.3;
                description = `Volume di atas rata-rata (${volRatio.toFixed(1)}x) + harga turun`;
            }
        } else if (volRatio >= 0.7) {
            signal = 'NEUTRAL';
            score = 0;
            description = `Volume normal (${volRatio.toFixed(1)}x rata-rata)`;
        } else {
            // Low volume — trend is weak
            signal = 'NEUTRAL';
            score = 0;
            description = `Volume rendah (${volRatio.toFixed(1)}x rata-rata) — trend lemah`;
        }

        return {
            name: 'Volume',
            value: `${volRatio.toFixed(1)}x avg`,
            signal,
            description,
            _score: score,
        };
    },

    /* ------------------------------------------------------------------ */
    /*  Profit Estimation Engine                                            */
    /* ------------------------------------------------------------------ */

    /**
     * Calculate time-based profit estimation with win probability
     */
    _calculateProfitEstimation(data, lastPrice, atr, stopLoss, takeProfit, score, rsi, divergence, isIlliquidTrap, volMA, lastVolume) {
        const atrPercent = lastPrice > 0 ? (atr / lastPrice) * 100 : 1;

        // MACD direction from data
        const prevPrice = data.length >= 2 ? data[data.length - 2].close : lastPrice;
        const priceUp = lastPrice > prevPrice;

        // Volume ratio
        const avgVol = volMA && volMA.length > 0 ? volMA[volMA.length - 1].value : lastVolume;
        const volRatio = avgVol > 0 ? lastVolume / avgVol : 1;

        // Trend direction multiplier
        let trendMult = 1.0;
        if (score >= 65 && rsi < 70) {
            trendMult = 1.3;
        } else if (score >= 55 && rsi < 65) {
            trendMult = 1.1;
        } else if (score <= 35) {
            trendMult = 0.5;
        } else if (rsi >= 70) {
            trendMult = 0.3;
        }

        // Volume confirmation
        const volConf = volRatio >= 1.5 ? 1.3 : volRatio >= 1.0 ? 1.0 : 0.7;

        // Daily movement estimate
        const dailyMovement = atr * trendMult * volConf;

        // Distances
        const distTP = Math.abs(takeProfit - lastPrice);
        const distSL = Math.abs(lastPrice - stopLoss);

        // Risk:Reward
        const rrr = distSL > 0 ? parseFloat((distTP / distSL).toFixed(2)) : 0;

        // Time estimates
        const rawDays = dailyMovement > 0 ? distTP / dailyMovement : 999;
        const confMult = Math.max(0.3, Math.min(2.0, score / 60));
        const estDays = Math.max(1, Math.round(rawDays / confMult));
        const estHours = Math.round(estDays * 6.5);
        const estWeeks = parseFloat((estDays / 5).toFixed(1));

        // Profit/Loss percentages
        const profitPct = lastPrice > 0 ? parseFloat(((distTP / lastPrice) * 100).toFixed(2)) : 0;
        const lossPct = lastPrice > 0 ? parseFloat(((distSL / lastPrice) * 100).toFixed(2)) : 0;
        const profitPerDay = estDays > 0 ? parseFloat((profitPct / estDays).toFixed(2)) : 0;

        // Win probability
        let winProb = 50;
        if (rsi <= 30) winProb += 12;
        else if (rsi <= 40) winProb += 6;
        else if (rsi >= 70) winProb -= 12;
        else if (rsi >= 60) winProb -= 6;

        if (score >= 70) winProb += 10;
        else if (score >= 60) winProb += 5;
        else if (score <= 30) winProb -= 10;
        else if (score <= 40) winProb -= 5;

        if (volRatio > 1.5 && priceUp) winProb += 7;
        else if (volRatio > 1.5 && !priceUp) winProb -= 7;

        if (divergence === 'BULLISH_ACCUMULATION') winProb += 8;
        else if (divergence === 'BEARISH_BULL_TRAP') winProb -= 8;

        if (rrr >= 3) winProb += 5;
        else if (rrr >= 2) winProb += 3;
        else if (rrr < 1) winProb -= 5;

        if (isIlliquidTrap) winProb -= 10;

        winProb = Math.max(5, Math.min(95, winProb));

        // Human readable label
        let timeLabel;
        if (estDays <= 1) {
            timeLabel = `~${estHours} jam`;
        } else if (estDays <= 5) {
            timeLabel = `~${estDays} hari`;
        } else if (estWeeks <= 4) {
            timeLabel = `~${estWeeks} minggu`;
        } else {
            timeLabel = `~${Math.round(estWeeks)} minggu`;
        }

        return {
            estimatedHours: estHours,
            estimatedDays: estDays,
            estimatedWeeks: estWeeks,
            timeEstimateLabel: timeLabel,
            profitPercent: profitPct,
            profitPerDay,
            lossPercent: lossPct,
            riskRewardRatio: rrr,
            winProbability: winProb,
            dailyMovement: parseFloat(dailyMovement.toFixed(2)),
            atrPercent: parseFloat(atrPercent.toFixed(2)),
            confidenceLevel: confMult >= 1.2 ? 'HIGH' : confMult >= 0.8 ? 'MEDIUM' : 'LOW',
        };
    },

    /* ------------------------------------------------------------------ */
    /*  Helpers                                                            */
    /* ------------------------------------------------------------------ */

    /**
     * Map aggregate score (0 … 100) to an overall signal label.
     * Unified scale matching recommendation engine and combined scoring.
     */
    _scoreToSignal(score) {
        if (score >= 75) return 'STRONG_BUY';
        if (score >= 60) return 'BUY';
        if (score >= 40) return 'NEUTRAL';
        if (score >= 25) return 'SELL';
        return 'STRONG_SELL';
    },
};
