/**
 * Sentiment Analysis Module
 * Processes sentiment data fetched from the backend.
 */

const SentimentAnalysis = {
    /**
     * Get label for a sentiment score
     * @param {number} score 0-100
     */
    getSentimentLabel(score) {
        if (score >= 80) return 'VERY_POSITIVE';
        if (score >= 60) return 'POSITIVE';
        if (score > 40) return 'NEUTRAL';
        if (score > 20) return 'NEGATIVE';
        return 'VERY_NEGATIVE';
    },

    /**
     * Get CSS class for sentiment
     * @param {string} sentiment 
     */
    getSentimentClass(sentiment) {
        if (!sentiment) return 'neutral';
        const s = sentiment.toUpperCase();
        if (s.includes('POSITIVE')) return 'positive';
        if (s.includes('NEGATIVE')) return 'negative';
        return 'neutral';
    },
    
    /**
     * Get human readable text for sentiment
     */
    getSentimentText(sentiment) {
        const map = {
            'VERY_POSITIVE': 'Sangat Positif',
            'POSITIVE': 'Positif',
            'NEUTRAL': 'Netral',
            'NEGATIVE': 'Negatif',
            'VERY_NEGATIVE': 'Sangat Negatif'
        };
        return map[sentiment] || sentiment;
    },

    /**
     * Process API response and return UI-ready object
     * @param {Object} data 
     */
    processData(data) {
        if (!data || !data.articles || data.articlesAnalyzed === 0) {
            return {
                overall: 'NEUTRAL',
                label: 'Tidak Ada Data',
                score: null,
                articles: [],
                method: 'none',
                methodLabel: 'Tidak ada data',
                isEmpty: true
            };
        }

        const methodMap = {
            'gemini': '🤖 AI Analysis (Gemini)',
            'keyword': '📝 Keyword Matching',
            'none': 'Tidak ada data'
        };

        const overallLabel = this.getSentimentLabel(data.score);

        return {
            overall: data.overallSentiment,
            label: this.getSentimentText(overallLabel),
            score: data.score,
            articles: data.articles.map(a => ({
                ...a,
                labelClass: this.getSentimentClass(a.sentiment),
                labelText: this.getSentimentText(a.sentiment)
            })),
            method: data._method,
            methodLabel: methodMap[data._method] || 'Unknown',
            isEmpty: false
        };
    }
};
