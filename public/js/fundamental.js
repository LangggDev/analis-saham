/**
 * Fundamental Analysis Module
 * Scores fundamental metrics and produces an overall rating.
 * Used alongside technical analysis for combined scoring.
 */

const FundamentalAnalysis = {

    /**
     * Analyze fundamental data and return scored metrics + overall rating
     * @param {Object} data - Fundamental data from /api/fundamental/:symbol
     * @returns {{overall: string, score: number, grade: string, metrics: Array, recommendation: string}}
     */
    analyze(data) {
        if (!data) {
            return { overall: 'N/A', score: 0, grade: 'N/A', metrics: [], recommendation: 'Data fundamental tidak tersedia.' };
        }

        const metrics = [];
        let totalScore = 0;
        let totalWeight = 0;

        // ── PER (Price to Earnings Ratio) ──
        const perResult = this._scorePER(data.per);
        if (perResult) {
            metrics.push(perResult);
            totalScore += perResult._score * perResult._weight;
            totalWeight += perResult._weight;
        }

        // ── PBV (Price to Book Value) ──
        const pbvResult = this._scorePBV(data.pbv);
        if (pbvResult) {
            metrics.push(pbvResult);
            totalScore += pbvResult._score * pbvResult._weight;
            totalWeight += pbvResult._weight;
        }

        // ── ROE (Return on Equity) ──
        const roeResult = this._scoreROE(data.roe);
        if (roeResult) {
            metrics.push(roeResult);
            totalScore += roeResult._score * roeResult._weight;
            totalWeight += roeResult._weight;
        }

        // ── DER (Debt to Equity Ratio) ──
        const derResult = this._scoreDER(data.der);
        if (derResult) {
            metrics.push(derResult);
            totalScore += derResult._score * derResult._weight;
            totalWeight += derResult._weight;
        }

        // ── EPS ──
        const epsResult = this._scoreEPS(data.eps);
        if (epsResult) {
            metrics.push(epsResult);
            totalScore += epsResult._score * epsResult._weight;
            totalWeight += epsResult._weight;
        }

        // ── Dividend Yield ──
        const divResult = this._scoreDividendYield(data.dividendYield);
        if (divResult) {
            metrics.push(divResult);
            totalScore += divResult._score * divResult._weight;
            totalWeight += divResult._weight;
        }

        // ── Revenue Growth ──
        const rgResult = this._scoreRevenueGrowth(data.revenueGrowth);
        if (rgResult) {
            metrics.push(rgResult);
            totalScore += rgResult._score * rgResult._weight;
            totalWeight += rgResult._weight;
        }

        // ── Profit Margin ──
        const pmResult = this._scoreProfitMargin(data.profitMargin);
        if (pmResult) {
            metrics.push(pmResult);
            totalScore += pmResult._score * pmResult._weight;
            totalWeight += pmResult._weight;
        }

        // ── Current Ratio ──
        const crResult = this._scoreCurrentRatio(data.currentRatio);
        if (crResult) {
            metrics.push(crResult);
            totalScore += crResult._score * crResult._weight;
            totalWeight += crResult._weight;
        }

        // Minimum metrics threshold: need at least 3 valid metrics for a meaningful score
        const MIN_METRICS = 3;
        const hasEnoughData = metrics.length >= MIN_METRICS;

        // Normalize score to 0-100
        const score = (totalWeight > 0 && hasEnoughData) ? Math.round((totalScore / totalWeight) * 100) : null;
        const grade = score !== null ? this._scoreToGrade(score) : 'N/A';
        const recommendation = score !== null ? this._getRecommendation(score, metrics) : 'Data fundamental tidak cukup untuk analisis (butuh minimal 3 metrik).';

        // Strip internal scores from public output
        const cleanMetrics = metrics.map(({ _score, _weight, ...rest }) => rest);

        return {
            overall: grade,
            score,
            grade,
            metrics: cleanMetrics,
            recommendation,
            metricsCount: metrics.length,
            hasRealData: hasEnoughData,
        };
    },

    /**
     * Get combined score from technical, fundamental, and sentiment analysis
     * @param {number} technicalScore - Technical analysis score (-100 to +100)
     * @param {number} fundamentalScore - Fundamental analysis score (0 to 100)
     * @param {number} sentimentScore - Sentiment analysis score (0 to 100), can be null
     * @param {number} techWeight - Technical weight (default 0.5)
     * @param {number} fundWeight - Fundamental weight (default 0.3)
     * @param {number} sentWeight - Sentiment weight (default 0.2)
     * @returns {{combinedScore: number, signal: string, label: string}}
     */
    getCombinedScore(technicalScore, fundamentalScore, sentimentScore = null) {
        // Normalize technical score from -100..+100 to 0..100
        const normalizedTech = (technicalScore + 100) / 2;

        const hasFund = fundamentalScore !== null && fundamentalScore !== undefined;
        const hasSent = sentimentScore !== null && sentimentScore !== undefined;

        let combined;
        const dataSources = ['technical'];

        if (hasFund && hasSent) {
            // All 3 sources available: 50% tech, 30% fund, 20% sent
            combined = Math.round(normalizedTech * 0.5 + fundamentalScore * 0.3 + sentimentScore * 0.2);
            dataSources.push('fundamental', 'sentiment');
        } else if (hasFund) {
            // Tech + Fund only: 60% tech, 40% fund
            combined = Math.round(normalizedTech * 0.6 + fundamentalScore * 0.4);
            dataSources.push('fundamental');
        } else if (hasSent) {
            // Tech + Sent only: 70% tech, 30% sent
            combined = Math.round(normalizedTech * 0.7 + sentimentScore * 0.3);
            dataSources.push('sentiment');
        } else {
            // Only technical — just normalize, don't mix with anything
            combined = Math.round(normalizedTech);
        }

        let signal, label;
        if (combined >= 80) {
            signal = 'STRONG_BUY';
            label = 'Sangat Layak Beli';
        } else if (combined >= 65) {
            signal = 'BUY';
            label = 'Layak Beli';
        } else if (combined >= 45) {
            signal = 'NEUTRAL';
            label = 'Netral / Hold';
        } else if (combined >= 30) {
            signal = 'SELL';
            label = 'Pertimbangkan Jual';
        } else {
            signal = 'STRONG_SELL';
            label = 'Hindari / Jual';
        }

        // Generate human-readable source label
        const sourceLabels = {
            1: '📈 Hanya Teknikal',
            2: dataSources.includes('fundamental')
                ? '📈📋 Teknikal + Fundamental'
                : '📈💬 Teknikal + Sentimen',
            3: '📈📋💬 Analisis Lengkap'
        };
        const sourceLabel = sourceLabels[dataSources.length] || '📈 Teknikal';

        return { combinedScore: combined, signal, label, dataSources, sourceLabel };
    },

    /* ─── Individual Metric Scorers ─────────────────────────────────── */

    _scorePER(value) {
        if (value == null || isNaN(value) || value <= 0) return null;
        let score, rating, desc;

        if (value < 10) {
            score = 1.0; rating = 'EXCELLENT';
            desc = 'Sangat murah — valuasi sangat atraktif';
        } else if (value < 15) {
            score = 0.85; rating = 'GOOD';
            desc = 'Valuasi wajar — harga terdiskon';
        } else if (value < 20) {
            score = 0.65; rating = 'FAIR';
            desc = 'Valuasi moderat';
        } else if (value < 30) {
            score = 0.4; rating = 'HIGH';
            desc = 'Valuasi cukup mahal';
        } else {
            score = 0.15; rating = 'EXPENSIVE';
            desc = 'Valuasi sangat mahal';
        }

        return {
            name: 'PER',
            fullName: 'Price to Earnings Ratio',
            value: parseFloat(value.toFixed(2)),
            displayValue: value.toFixed(2) + 'x',
            rating,
            description: desc,
            _score: score,
            _weight: 20,
        };
    },

    _scorePBV(value) {
        if (value == null || isNaN(value) || value <= 0) return null;
        let score, rating, desc;

        if (value < 1) {
            score = 1.0; rating = 'EXCELLENT';
            desc = 'Di bawah nilai buku — sangat murah';
        } else if (value < 1.5) {
            score = 0.85; rating = 'GOOD';
            desc = 'Mendekati nilai buku — wajar';
        } else if (value < 3) {
            score = 0.6; rating = 'FAIR';
            desc = 'Di atas nilai buku — moderat';
        } else if (value < 5) {
            score = 0.35; rating = 'HIGH';
            desc = 'Valuasi tinggi terhadap aset';
        } else {
            score = 0.1; rating = 'EXPENSIVE';
            desc = 'Valuasi sangat tinggi';
        }

        return {
            name: 'PBV',
            fullName: 'Price to Book Value',
            value: parseFloat(value.toFixed(2)),
            displayValue: value.toFixed(2) + 'x',
            rating,
            description: desc,
            _score: score,
            _weight: 15,
        };
    },

    _scoreROE(value) {
        if (value == null || isNaN(value)) return null;
        const pct = value > 1 ? value : value * 100; // handle both 0.15 and 15
        let score, rating, desc;

        if (pct > 20) {
            score = 1.0; rating = 'EXCELLENT';
            desc = 'Pengembalian ekuitas sangat tinggi';
        } else if (pct > 15) {
            score = 0.8; rating = 'GOOD';
            desc = 'Pengembalian ekuitas baik';
        } else if (pct > 10) {
            score = 0.6; rating = 'FAIR';
            desc = 'Pengembalian ekuitas moderat';
        } else if (pct > 5) {
            score = 0.35; rating = 'LOW';
            desc = 'Pengembalian ekuitas rendah';
        } else {
            score = 0.1; rating = 'POOR';
            desc = 'Pengembalian ekuitas sangat rendah';
        }

        return {
            name: 'ROE',
            fullName: 'Return on Equity',
            value: parseFloat(pct.toFixed(2)),
            displayValue: pct.toFixed(2) + '%',
            rating,
            description: desc,
            _score: score,
            _weight: 20,
        };
    },

    _scoreDER(value) {
        if (value == null || isNaN(value) || value < 0) return null;
        let score, rating, desc;

        if (value < 0.5) {
            score = 1.0; rating = 'EXCELLENT';
            desc = 'Hutang sangat rendah — finansial sangat sehat';
        } else if (value < 1.0) {
            score = 0.8; rating = 'GOOD';
            desc = 'Hutang terkendali — sehat';
        } else if (value < 2.0) {
            score = 0.55; rating = 'FAIR';
            desc = 'Hutang moderat';
        } else if (value < 3.0) {
            score = 0.3; rating = 'HIGH';
            desc = 'Hutang tinggi — perlu perhatian';
        } else {
            score = 0.1; rating = 'DANGER';
            desc = 'Hutang sangat tinggi — risiko besar';
        }

        return {
            name: 'DER',
            fullName: 'Debt to Equity Ratio',
            value: parseFloat(value.toFixed(2)),
            displayValue: value.toFixed(2) + 'x',
            rating,
            description: desc,
            _score: score,
            _weight: 15,
        };
    },

    _scoreEPS(value) {
        if (value == null || isNaN(value)) return null;
        let score, rating, desc;

        if (value > 0) {
            if (value > 500) {
                score = 1.0; rating = 'EXCELLENT';
                desc = 'Laba per saham sangat tinggi';
            } else if (value > 100) {
                score = 0.8; rating = 'GOOD';
                desc = 'Laba per saham baik';
            } else {
                score = 0.6; rating = 'FAIR';
                desc = 'Laba per saham positif';
            }
        } else {
            score = 0.1; rating = 'LOSS';
            desc = 'Perusahaan merugi';
        }

        return {
            name: 'EPS',
            fullName: 'Earnings Per Share',
            value: parseFloat(value.toFixed(2)),
            displayValue: value.toFixed(2),
            rating,
            description: desc,
            _score: score,
            _weight: 10,
        };
    },

    _scoreDividendYield(value) {
        if (value == null || isNaN(value)) return null;
        const pct = value > 1 ? value : value * 100;
        let score, rating, desc;

        if (pct > 5) {
            score = 1.0; rating = 'EXCELLENT';
            desc = 'Dividen sangat menarik';
        } else if (pct > 3) {
            score = 0.8; rating = 'GOOD';
            desc = 'Dividen baik';
        } else if (pct > 1) {
            score = 0.55; rating = 'FAIR';
            desc = 'Dividen moderat';
        } else if (pct > 0) {
            score = 0.3; rating = 'LOW';
            desc = 'Dividen rendah';
        } else {
            score = 0.15; rating = 'NONE';
            desc = 'Tidak membagikan dividen';
        }

        return {
            name: 'Div Yield',
            fullName: 'Dividend Yield',
            value: parseFloat(pct.toFixed(2)),
            displayValue: pct.toFixed(2) + '%',
            rating,
            description: desc,
            _score: score,
            _weight: 10,
        };
    },

    _scoreRevenueGrowth(value) {
        if (value == null || isNaN(value)) return null;
        const pct = Math.abs(value) > 1 ? value : value * 100;
        let score, rating, desc;

        if (pct > 20) {
            score = 1.0; rating = 'EXCELLENT';
            desc = 'Pertumbuhan pendapatan sangat tinggi';
        } else if (pct > 10) {
            score = 0.8; rating = 'GOOD';
            desc = 'Pertumbuhan pendapatan baik';
        } else if (pct > 0) {
            score = 0.55; rating = 'FAIR';
            desc = 'Pendapatan masih bertumbuh';
        } else if (pct > -10) {
            score = 0.3; rating = 'DECLINING';
            desc = 'Pendapatan menurun';
        } else {
            score = 0.1; rating = 'POOR';
            desc = 'Pendapatan menurun drastis';
        }

        return {
            name: 'Rev Growth',
            fullName: 'Revenue Growth (YoY)',
            value: parseFloat(pct.toFixed(2)),
            displayValue: (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%',
            rating,
            description: desc,
            _score: score,
            _weight: 15,
        };
    },

    _scoreProfitMargin(value) {
        if (value == null || isNaN(value)) return null;
        const pct = Math.abs(value) > 1 ? value : value * 100;
        let score, rating, desc;

        if (pct > 20) {
            score = 1.0; rating = 'EXCELLENT';
            desc = 'Margin laba sangat tinggi';
        } else if (pct > 10) {
            score = 0.8; rating = 'GOOD';
            desc = 'Margin laba baik';
        } else if (pct > 5) {
            score = 0.55; rating = 'FAIR';
            desc = 'Margin laba moderat';
        } else if (pct > 0) {
            score = 0.3; rating = 'LOW';
            desc = 'Margin laba tipis';
        } else {
            score = 0.1; rating = 'LOSS';
            desc = 'Margin negatif — merugi';
        }

        return {
            name: 'Profit Margin',
            fullName: 'Net Profit Margin',
            value: parseFloat(pct.toFixed(2)),
            displayValue: pct.toFixed(2) + '%',
            rating,
            description: desc,
            _score: score,
            _weight: 10,
        };
    },

    _scoreCurrentRatio(value) {
        if (value == null || isNaN(value) || value <= 0) return null;
        let score, rating, desc;

        if (value > 2.0) {
            score = 0.9; rating = 'EXCELLENT';
            desc = 'Likuiditas sangat baik';
        } else if (value > 1.5) {
            score = 0.75; rating = 'GOOD';
            desc = 'Likuiditas baik';
        } else if (value > 1.0) {
            score = 0.55; rating = 'FAIR';
            desc = 'Likuiditas cukup';
        } else {
            score = 0.2; rating = 'DANGER';
            desc = 'Likuiditas rendah — risiko gagal bayar';
        }

        return {
            name: 'Current Ratio',
            fullName: 'Current Ratio',
            value: parseFloat(value.toFixed(2)),
            displayValue: value.toFixed(2) + 'x',
            rating,
            description: desc,
            _score: score,
            _weight: 10,
        };
    },

    /* ─── Helpers ────────────────────────────────────────────────── */

    _scoreToGrade(score) {
        if (score >= 80) return 'EXCELLENT';
        if (score >= 65) return 'GOOD';
        if (score >= 45) return 'FAIR';
        if (score >= 25) return 'POOR';
        return 'VERY_POOR';
    },

    _getRecommendation(score, metrics) {
        const strengths = metrics.filter(m => m._score >= 0.7).map(m => m.name);
        const weaknesses = metrics.filter(m => m._score < 0.4).map(m => m.name);

        let rec = '';
        if (score >= 80) {
            rec = '🟢 Fundamental sangat kuat. ';
        } else if (score >= 65) {
            rec = '🟢 Fundamental baik. ';
        } else if (score >= 45) {
            rec = '🟡 Fundamental cukup. ';
        } else if (score >= 25) {
            rec = '🟠 Fundamental lemah. ';
        } else {
            rec = '🔴 Fundamental sangat lemah. ';
        }

        if (strengths.length > 0) {
            rec += `Kekuatan: ${strengths.join(', ')}. `;
        }
        if (weaknesses.length > 0) {
            rec += `Perhatian: ${weaknesses.join(', ')}.`;
        }

        return rec.trim();
    },

    /**
     * Get color class for a rating
     */
    getRatingClass(rating) {
        const map = {
            'EXCELLENT': 'excellent',
            'GOOD': 'good',
            'FAIR': 'fair',
            'HIGH': 'warning',
            'LOW': 'warning',
            'POOR': 'danger',
            'VERY_POOR': 'danger',
            'DANGER': 'danger',
            'LOSS': 'danger',
            'EXPENSIVE': 'danger',
            'DECLINING': 'warning',
            'NONE': 'muted',
        };
        return map[rating] || 'neutral';
    },
};
