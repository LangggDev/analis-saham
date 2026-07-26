/**
 * Stock Recommendation Module
 * Provides stock recommendations for today and tomorrow morning.
 * Tomorrow morning recommendations are time-gated (available after 19:00 WIB).
 */

const StockRecommendation = {
    _todayData: null,
    _tomorrowData: null,
    _isLoadingToday: false,
    _isLoadingTomorrow: false,
    _refreshInterval: null,
    _countdownInterval: null,
    _onSelectCallback: null,

    // ─── Init ──────────────────────────────────────────────────────────
    init(onSelectCallback) {
        this._onSelectCallback = onSelectCallback;
        this._setupEventListeners();
    },

    _setupEventListeners() {
        const refreshTodayBtn = document.getElementById('recRefreshTodayBtn');
        const refreshTomorrowBtn = document.getElementById('recRefreshTomorrowBtn');

        if (refreshTodayBtn) {
            refreshTodayBtn.addEventListener('click', () => this.loadToday(true));
        }
        if (refreshTomorrowBtn) {
            refreshTomorrowBtn.addEventListener('click', () => this.loadTomorrow(true));
        }
    },

    // ─── Load Recommendations ──────────────────────────────────────────
    async loadToday(forceRefresh = false) {
        if (this._isLoadingToday) return;
        this._isLoadingToday = true;
        this._renderTodayLoading();

        try {
            const res = await fetch('/api/recommendations/today');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            this._todayData = data;
            this._renderToday(data);
        } catch (err) {
            console.error('[Recommendation] Failed to load today:', err);
            this._renderTodayError(err.message);
        } finally {
            this._isLoadingToday = false;
        }
    },

    async loadTomorrow(forceRefresh = false) {
        if (this._isLoadingTomorrow) return;
        this._isLoadingTomorrow = true;
        this._renderTomorrowLoading();

        try {
            const res = await fetch('/api/recommendations/tomorrow');
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            this._tomorrowData = data;

            if (data.locked) {
                this._renderTomorrowLocked(data);
            } else {
                this._renderTomorrow(data);
            }
        } catch (err) {
            console.error('[Recommendation] Failed to load tomorrow:', err);
            this._renderTomorrowError(err.message);
        } finally {
            this._isLoadingTomorrow = false;
        }
    },

    // ─── Start Auto-Refresh ────────────────────────────────────────────
    startAutoRefresh() {
        // Refresh every 30 minutes
        if (this._refreshInterval) clearInterval(this._refreshInterval);
        this._refreshInterval = setInterval(() => {
            this.loadToday();
            this.loadTomorrow();
        }, 30 * 60 * 1000);

        // Start countdown for tomorrow unlock
        this._startCountdown();
    },

    _startCountdown() {
        if (this._countdownInterval) clearInterval(this._countdownInterval);
        this._countdownInterval = setInterval(() => {
            const countdownEl = document.getElementById('recTomorrowCountdown');
            if (!countdownEl) return;

            const now = new Date();
            // WIB = UTC + 7
            const wibHours = (now.getUTCHours() + 7) % 24;
            const wibMinutes = now.getUTCMinutes();

            if (wibHours >= 19 || wibHours < 5) {
                // Unlocked
                countdownEl.textContent = '✅ Tersedia sekarang';
                countdownEl.className = 'rec-countdown unlocked';
                // If still showing locked, reload
                if (this._tomorrowData?.locked) {
                    this.loadTomorrow();
                }
                return;
            }

            // Calculate remaining time
            const targetMinutes = 19 * 60;
            const currentMinutes = wibHours * 60 + wibMinutes;
            const remainingMinutes = targetMinutes - currentMinutes;
            const hours = Math.floor(remainingMinutes / 60);
            const mins = remainingMinutes % 60;

            countdownEl.textContent = `⏳ Tersedia dalam ${hours} jam ${mins} menit`;
            countdownEl.className = 'rec-countdown locked';
        }, 30000); // Update every 30 seconds
    },

    // ─── Render: Today's Recommendations ──────────────────────────────
    _renderTodayLoading() {
        const container = document.getElementById('recTodayContent');
        if (!container) return;
        container.innerHTML = `
            <div class="rec-loading">
                <div class="rec-loading-spinner"></div>
                <span>Menganalisis ${this._getStockCount()} saham blue chip...</span>
            </div>
        `;
    },

    _renderTodayError(message) {
        const container = document.getElementById('recTodayContent');
        if (!container) return;
        container.innerHTML = `
            <div class="rec-empty-state">
                <span class="rec-empty-icon">⚠️</span>
                <span class="rec-empty-title">Gagal memuat rekomendasi</span>
                <span class="rec-empty-text">${message}</span>
                <button class="rec-retry-btn" onclick="StockRecommendation.loadToday(true)">🔄 Coba Lagi</button>
            </div>
        `;
    },

    _renderToday(data) {
        const container = document.getElementById('recTodayContent');
        if (!container) return;

        const timestamp = new Date(data.timestamp);
        const timeStr = timestamp.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        const dateStr = timestamp.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });

        let html = `
            <div class="rec-meta">
                <span class="rec-meta-info">📊 ${data.totalAnalyzed} saham dianalisis · Update: ${dateStr} ${timeStr}</span>
            </div>
        `;

        // Buy Picks
        if (data.buyPicks && data.buyPicks.length > 0) {
            html += `<div class="rec-section">
                <h4 class="rec-section-title rec-buy-title">
                    <span class="rec-section-icon">🟢</span> Rekomendasi Beli (${data.buyPicks.length})
                </h4>
                <div class="rec-cards-grid">
                    ${data.buyPicks.map((pick, idx) => this._renderPickCard(pick, 'buy', idx)).join('')}
                </div>
            </div>`;
        }

        // Hold Picks
        if (data.holdPicks && data.holdPicks.length > 0) {
            html += `<div class="rec-section">
                <h4 class="rec-section-title rec-hold-title">
                    <span class="rec-section-icon">🟡</span> Hold / Pantau (${data.holdPicks.length})
                </h4>
                <div class="rec-cards-grid">
                    ${data.holdPicks.map((pick, idx) => this._renderPickCard(pick, 'hold', idx)).join('')}
                </div>
            </div>`;
        }

        // Sell/Avoid Picks
        if (data.sellPicks && data.sellPicks.length > 0) {
            html += `<div class="rec-section">
                <h4 class="rec-section-title rec-sell-title">
                    <span class="rec-section-icon">🔴</span> Hindari / Jual (${data.sellPicks.length})
                </h4>
                <div class="rec-cards-grid rec-cards-compact">
                    ${data.sellPicks.map((pick, idx) => this._renderPickCard(pick, 'sell', idx)).join('')}
                </div>
            </div>`;
        }

        if (!data.buyPicks?.length && !data.holdPicks?.length && !data.sellPicks?.length) {
            html += `
                <div class="rec-empty-state">
                    <span class="rec-empty-icon">📋</span>
                    <span class="rec-empty-title">Tidak ada rekomendasi saat ini</span>
                    <span class="rec-empty-text">Coba lagi nanti</span>
                </div>
            `;
        }

        container.innerHTML = html;
        this._bindCardClicks(container);
    },

    // ─── Render: Tomorrow's Recommendations ──────────────────────────
    _renderTomorrowLoading() {
        const container = document.getElementById('recTomorrowContent');
        if (!container) return;
        container.innerHTML = `
            <div class="rec-loading">
                <div class="rec-loading-spinner"></div>
                <span>Menganalisis setup untuk besok pagi...</span>
            </div>
        `;
    },

    _renderTomorrowError(message) {
        const container = document.getElementById('recTomorrowContent');
        if (!container) return;
        container.innerHTML = `
            <div class="rec-empty-state">
                <span class="rec-empty-icon">⚠️</span>
                <span class="rec-empty-title">Gagal memuat rekomendasi</span>
                <span class="rec-empty-text">${message}</span>
                <button class="rec-retry-btn" onclick="StockRecommendation.loadTomorrow(true)">🔄 Coba Lagi</button>
            </div>
        `;
    },

    _renderTomorrowLocked(data) {
        const container = document.getElementById('recTomorrowContent');
        if (!container) return;

        container.innerHTML = `
            <div class="rec-locked-overlay">
                <div class="rec-locked-card">
                    <div class="rec-locked-icon">🔒</div>
                    <h3 class="rec-locked-title">Rekomendasi Besok Pagi</h3>
                    <p class="rec-locked-desc">${data.message}</p>
                    <div class="rec-locked-time-info">
                        <div class="rec-locked-current">
                            <span class="rec-locked-label">Waktu saat ini</span>
                            <span class="rec-locked-value">${data.currentTimeWIB}</span>
                        </div>
                        <div class="rec-locked-divider">→</div>
                        <div class="rec-locked-target">
                            <span class="rec-locked-label">Tersedia mulai</span>
                            <span class="rec-locked-value">${data.availableAt}</span>
                        </div>
                    </div>
                    <div class="rec-countdown locked" id="recTomorrowCountdown">⏳ Menghitung...</div>
                    <p class="rec-locked-hint">💡 Rekomendasi besok pagi berisi analisis end-of-day untuk menemukan saham terbaik yang bisa dibeli saat pembukaan pasar besok.</p>
                </div>
            </div>
        `;

        // Trigger countdown update
        this._startCountdown();
    },

    _renderTomorrow(data) {
        const container = document.getElementById('recTomorrowContent');
        if (!container) return;

        const timestamp = new Date(data.timestamp);
        const timeStr = timestamp.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

        let html = `
            <div class="rec-meta">
                <span class="rec-meta-info">🌙 Analisis end-of-day · ${data.totalAnalyzed} saham · Update: ${timeStr} WIB</span>
                <span class="rec-countdown unlocked" id="recTomorrowCountdown">✅ Tersedia sekarang</span>
            </div>
        `;

        // Morning Picks
        if (data.morningPicks && data.morningPicks.length > 0) {
            html += `<div class="rec-section">
                <h4 class="rec-section-title rec-morning-title">
                    <span class="rec-section-icon">🌅</span> Top Picks Besok Pagi (${data.morningPicks.length})
                </h4>
                <div class="rec-cards-grid">
                    ${data.morningPicks.map((pick, idx) => this._renderPickCard(pick, 'morning', idx)).join('')}
                </div>
            </div>`;
        }

        // Avoid Picks
        if (data.avoidPicks && data.avoidPicks.length > 0) {
            html += `<div class="rec-section">
                <h4 class="rec-section-title rec-avoid-title">
                    <span class="rec-section-icon">⛔</span> Hindari Besok (${data.avoidPicks.length})
                </h4>
                <div class="rec-cards-grid rec-cards-compact">
                    ${data.avoidPicks.map((pick, idx) => this._renderPickCard(pick, 'avoid', idx)).join('')}
                </div>
            </div>`;
        }

        container.innerHTML = html;
        this._bindCardClicks(container);
    },

    // ─── Render: Pick Card ─────────────────────────────────────────────
    _renderPickCard(pick, type, index) {
        const signalClass = pick.signal?.toLowerCase()?.replace(/_/g, '-') || 'neutral';
        const signalText = pick.signal?.replace(/_/g, ' ') || 'NEUTRAL';
        const isIDR = pick.symbol?.endsWith('.JK');
        const fmtPrice = (v) => {
            if (v == null || isNaN(v)) return '—';
            if (isIDR) return new Intl.NumberFormat('id-ID').format(Math.round(v));
            return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
        };

        const changeCls = (pick.changePercent || 0) >= 0 ? 'positive' : 'negative';
        const changeSign = (pick.changePercent || 0) >= 0 ? '+' : '';
        const priorityBadge = pick.priority ? `<span class="rec-priority-badge">P${pick.priority}</span>` : '';

        const isBuyType = type === 'buy' || type === 'morning';
        const cardClass = type === 'sell' || type === 'avoid' ? 'rec-card-sell' : type === 'hold' ? 'rec-card-hold' : 'rec-card-buy';

        let detailsHTML = '';
        if (isBuyType) {
            detailsHTML = `
                <div class="rec-card-levels">
                    <div class="rec-level rec-level-entry">
                        <span class="rec-level-label">📈 Entry</span>
                        <span class="rec-level-value">${fmtPrice(pick.entryLow)} - ${fmtPrice(pick.entryHigh)}</span>
                    </div>
                    <div class="rec-level rec-level-sl">
                        <span class="rec-level-label">🛑 Stop Loss</span>
                        <span class="rec-level-value">${fmtPrice(pick.stopLoss)}</span>
                    </div>
                    <div class="rec-level rec-level-tp">
                        <span class="rec-level-label">🎯 Take Profit</span>
                        <span class="rec-level-value">${fmtPrice(pick.takeProfit)}</span>
                    </div>
                </div>
            `;
        }

        return `
            <div class="rec-card ${cardClass}" data-symbol="${pick.symbol}" style="animation-delay: ${index * 0.08}s">
                <div class="rec-card-header">
                    <div class="rec-card-symbol-group">
                        ${priorityBadge}
                        <span class="rec-card-symbol">${pick.symbol}</span>
                        <span class="rec-card-name">${pick.name || ''}</span>
                    </div>
                    <span class="rec-signal-badge rec-signal-${signalClass}">${signalText}</span>
                </div>
                <div class="rec-card-price-row">
                    <span class="rec-card-price">${fmtPrice(pick.price)}</span>
                    <span class="rec-card-change ${changeCls}">${changeSign}${(pick.changePercent || 0).toFixed(2)}%</span>
                    <span class="rec-card-score">Skor: <strong>${pick.score}</strong></span>
                </div>
                ${detailsHTML}
                <div class="rec-card-indicators">
                    <span class="rec-indicator" title="RSI">RSI: ${pick.rsi || '—'}</span>
                    <span class="rec-indicator" title="Volume Ratio">Vol: ${pick.volRatio || '—'}x</span>
                    <span class="rec-indicator" title="Support">S: ${fmtPrice(pick.support)}</span>
                    <span class="rec-indicator" title="Resistance">R: ${fmtPrice(pick.resistance)}</span>
                </div>
                <div class="rec-card-reasoning">
                    <span class="rec-reasoning-icon">💡</span>
                    <span class="rec-reasoning-text">${pick.reasoning || ''}</span>
                </div>
            </div>
        `;
    },

    // ─── Bind card clicks ──────────────────────────────────────────────
    _bindCardClicks(container) {
        container.querySelectorAll('.rec-card[data-symbol]').forEach(card => {
            card.addEventListener('click', () => {
                const symbol = card.dataset.symbol;
                if (symbol && this._onSelectCallback) {
                    this._onSelectCallback(symbol);
                }
            });
            card.style.cursor = 'pointer';
        });
    },

    // ─── Helpers ───────────────────────────────────────────────────────
    getRecommendationForSymbol(symbol) {
        if (!symbol) return null;
        if (this._todayData) {
            const all = [
                ...(this._todayData.buyPicks || []),
                ...(this._todayData.holdPicks || []),
                ...(this._todayData.sellPicks || [])
            ];
            const found = all.find(p => p.symbol === symbol);
            if (found) return found;
        }
        if (this._tomorrowData && !this._tomorrowData.locked) {
            const all = [
                ...(this._tomorrowData.morningPicks || []),
                ...(this._tomorrowData.avoidPicks || [])
            ];
            const found = all.find(p => p.symbol === symbol);
            if (found) return found;
        }
        return null;
    },

    _getStockCount() {
        return '300+'; // Number of liquid IDX stocks analyzed
    },
};

