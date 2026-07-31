/**
 * Stock Recommendation Module (Multi-Strategy Stockbit UI)
 * Supports 4 professional trading strategies without emojis:
 * 1. Scalping (Today Live & Tomorrow Pre-Open)
 * 2. Swing Trading (With entry date advice & target profit range)
 * 3. BSJP (Beli Sore Jual Pagi)
 * 4. BPJS (Beli Pagi Jual Sore)
 */

const StockRecommendation = {
    _currentStrategy: 'scalping',
    _scalpingSub: 'today',
    _data: {
        today: null,
        tomorrow: null,
        swing: null,
        bsjp: null,
        bpjs: null
    },
    _isLoading: {
        today: false,
        tomorrow: false,
        swing: false,
        bsjp: false,
        bpjs: false
    },
    _refreshInterval: null,
    _countdownInterval: null,
    _onSelectCallback: null,

    // ─── Init ──────────────────────────────────────────────────────────
    init(onSelectCallback) {
        this._onSelectCallback = onSelectCallback;
        this._setupEventListeners();
    },

    _setupEventListeners() {
        // Strategy tabs switcher
        const strategyBtns = document.querySelectorAll('.rec-strategy-btn');
        strategyBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const strat = btn.dataset.strategy;
                if (strat && strat !== this._currentStrategy) {
                    strategyBtns.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    this._currentStrategy = strat;
                    this._onStrategyChanged();
                }
            });
        });

        // Scalping sub-tabs switcher (Hari Ini vs Besok Pagi)
        const subBtns = document.querySelectorAll('.rec-sub-btn');
        subBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const sub = btn.dataset.sub;
                if (sub && sub !== this._scalpingSub) {
                    subBtns.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    this._scalpingSub = sub;
                    this.renderCurrentView();
                }
            });
        });

        // Refresh button
        const refreshBtn = document.getElementById('recRefreshBtn');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
                const currentKey = this._getActiveDataKey();
                this.fetchData(currentKey, true);
            });
        }
    },

    _onStrategyChanged() {
        const subNav = document.getElementById('recScalpingSubNav');
        const bannerTitle = document.getElementById('recBannerTitle');
        const bannerDesc = document.getElementById('recBannerDesc');

        if (this._currentStrategy === 'scalping') {
            if (subNav) subNav.style.display = 'flex';
            if (bannerTitle) bannerTitle.textContent = 'Scalping — Intraday Real-Time';
            if (bannerDesc) bannerDesc.textContent = 'Analisis momentum cepat dan likuiditas tinggi untuk ambil cuan harian pada saham bervolatilitas aktif.';
        } else if (this._currentStrategy === 'swing') {
            if (subNav) subNav.style.display = 'none';
            if (bannerTitle) bannerTitle.textContent = 'Swing Trading — Multi-Day Trend Hold';
            if (bannerDesc) bannerDesc.textContent = 'Strategi memanfaatkan tren pergerakan harga 3 - 10 hari bursa dengan saran tanggal masuk dan target persen profit matematis.';
        } else if (this._currentStrategy === 'bsjp') {
            if (subNav) subNav.style.display = 'none';
            if (bannerTitle) bannerTitle.textContent = 'BSJP — Beli Sore Jual Pagi';
            if (bannerDesc) bannerDesc.textContent = 'Akumulasi saham momentum pada penutupan sesi II bursa (15.45 WIB) dan lepas saat pembukaan dorongan gap-up esok paginya (09.00 WIB).';
        } else if (this._currentStrategy === 'bpjs') {
            if (subNav) subNav.style.display = 'none';
            if (bannerTitle) bannerTitle.textContent = 'BPJS — Beli Pagi Jual Sore';
            if (bannerDesc) bannerDesc.textContent = 'Trading intraday murni tanpa menginap. Beli saat konfirmasi lonjakan volume pagi hari dan jual sebelum penutupan sesi II di sore hari.';
        }

        this.renderCurrentView();
    },

    _getActiveDataKey() {
        if (this._currentStrategy === 'scalping') {
            return this._scalpingSub; // 'today' or 'tomorrow'
        }
        return this._currentStrategy; // 'swing', 'bsjp', or 'bpjs'
    },

    // ─── Compatibility methods for app.js ──────────────────────────────
    async loadToday(forceRefresh = false) {
        const currentKey = this._getActiveDataKey();
        this.fetchData(currentKey, forceRefresh);

        // Prefetch strategi lain secara perlahan di belakang agar tab aktif dimuat sekejap tanpa antrean network
        setTimeout(() => {
            const others = ['today', 'swing', 'bsjp', 'bpjs'].filter(k => k !== currentKey);
            others.forEach(k => this.fetchData(k, forceRefresh));
        }, 800);
    },

    async loadTomorrow(forceRefresh = false) {
        setTimeout(() => {
            this.fetchData('tomorrow', forceRefresh);
        }, 1200);
    },

    startAutoRefresh() {
        if (this._refreshInterval) clearInterval(this._refreshInterval);
        this._refreshInterval = setInterval(() => {
            const currentKey = this._getActiveDataKey();
            this.fetchData(currentKey, true);
        }, 15 * 60 * 1000); // 15 menit

        this._startCountdown();
    },

    _startCountdown() {
        if (this._countdownInterval) clearInterval(this._countdownInterval);
        this._countdownInterval = setInterval(() => {
            const countdownEl = document.getElementById('recTomorrowCountdown');
            if (!countdownEl) return;

            const now = new Date();
            const wibHours = (now.getUTCHours() + 7) % 24;
            const wibMinutes = now.getUTCMinutes();

            if (wibHours >= 19 || wibHours < 5) {
                countdownEl.textContent = '[Aktif] Tersedia Untuk Dibuka';
                countdownEl.className = 'rec-countdown unlocked';
                if (this._data.tomorrow?.locked) {
                    this.fetchData('tomorrow', true);
                }
                return;
            }

            const targetMinutes = 19 * 60;
            const currentMinutes = wibHours * 60 + wibMinutes;
            const remainingMinutes = targetMinutes - currentMinutes;
            const hours = Math.floor(remainingMinutes / 60);
            const mins = remainingMinutes % 60;

            countdownEl.textContent = `Tersedia dalam ${hours} jam ${mins} menit menuju 19:00 WIB`;
            countdownEl.className = 'rec-countdown locked';
        }, 30000);
    },

    // ─── Fetching Data ─────────────────────────────────────────────────
    async fetchData(key, forceRefresh = false) {
        if (this._isLoading[key]) return;
        
        // If we already have data and not forcing refresh, just render if it's current view
        if (this._data[key] && !forceRefresh) {
            if (this._getActiveDataKey() === key) {
                this.renderCurrentView();
            }
            return;
        }

        this._isLoading[key] = true;
        if (this._getActiveDataKey() === key) {
            this._renderLoadingState();
        }

        try {
            const res = await fetch(`/api/recommendations/${key}`);
            if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
            const data = await res.json();
            this._data[key] = data;

            if (this._getActiveDataKey() === key) {
                this.renderCurrentView();
            }
        } catch (err) {
            console.error(`[Recommendation] Gagal memuat strategi ${key}:`, err);
            if (this._getActiveDataKey() === key) {
                this._renderErrorState(err.message, key);
            }
        } finally {
            this._isLoading[key] = false;
        }
    },

    // ─── Render View Controller ────────────────────────────────────────
    renderCurrentView() {
        const key = this._getActiveDataKey();
        const data = this._data[key];

        if (this._isLoading[key]) {
            this._renderLoadingState();
            return;
        }

        if (!data) {
            this.fetchData(key);
            return;
        }

        if (key === 'tomorrow' && data.locked) {
            this._renderTomorrowLocked(data);
            return;
        }

        const container = document.getElementById('recMainContent');
        if (!container) return;

        const timestamp = new Date(data.timestamp);
        const timeStr = timestamp.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        const dateStr = timestamp.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });

        let html = `
            <div class="rec-meta">
                <span class="rec-meta-info">Total ${data.totalAnalyzed || 320} saham teranalisis · Pembaruan Terakhir: ${dateStr} ${timeStr} WIB</span>
                ${key === 'tomorrow' ? `<span class="rec-countdown unlocked" id="recTomorrowCountdown">[Aktif] Tersedia Untuk Dibuka</span>` : ''}
            </div>
        `;

        // Handle specific strategy data structures
        let picks = [];
        let sectionTitle = '';
        let sectionClass = 'rec-buy-title';

        if (key === 'today') {
            picks = data.buyPicks || [];
            sectionTitle = `Rekomendasi Utama Scalping Hari Ini (${picks.length})`;
            
            // Render Buy Picks
            if (picks.length > 0) {
                html += this._renderCardsSection(sectionTitle, sectionClass, picks, key);
            }
            // Render Hold Picks
            if (data.holdPicks && data.holdPicks.length > 0) {
                html += this._renderCardsSection(`Daftar Pantau / Hold (${data.holdPicks.length})`, 'rec-hold-title', data.holdPicks, key, 'hold');
            }
            // Render Sell Picks
            if (data.sellPicks && data.sellPicks.length > 0) {
                html += this._renderCardsSection(`Hindari / Jual (${data.sellPicks.length})`, 'rec-sell-title', data.sellPicks, key, 'sell', true);
            }
        } else if (key === 'tomorrow') {
            picks = data.morningPicks || [];
            sectionTitle = `Top Picks Pembukaan Besok Pagi (${picks.length})`;
            if (picks.length > 0) {
                html += this._renderCardsSection(sectionTitle, 'rec-morning-title', picks, key);
            }
            if (data.avoidPicks && data.avoidPicks.length > 0) {
                html += this._renderCardsSection(`Hindari Saat Pembukaan Besok (${data.avoidPicks.length})`, 'rec-avoid-title', data.avoidPicks, key, 'avoid', true);
            }
        } else if (key === 'swing') {
            picks = data.picks || [];
            sectionTitle = `Pilihan Terbaik Swing Trading (${picks.length})`;
            if (picks.length > 0) {
                html += this._renderCardsSection(sectionTitle, 'rec-buy-title', picks, key);
            }
        } else if (key === 'bsjp') {
            picks = data.picks || [];
            sectionTitle = `Saham Pilihan Beli Sore Jual Pagi (${picks.length})`;
            if (picks.length > 0) {
                html += this._renderCardsSection(sectionTitle, 'rec-buy-title', picks, key);
            }
        } else if (key === 'bpjs') {
            picks = data.picks || [];
            sectionTitle = `Saham Pilihan Beli Pagi Jual Sore (${picks.length})`;
            if (picks.length > 0) {
                html += this._renderCardsSection(sectionTitle, 'rec-buy-title', picks, key);
            }
        }

        if (picks.length === 0 && !data.holdPicks?.length && !data.sellPicks?.length && !data.avoidPicks?.length) {
            html += `
                <div class="rec-empty-state">
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                    <span class="rec-empty-title">Belum ada sinyal saham untuk strategi ini</span>
                    <span class="rec-empty-text">Filter ketat proteksi risiko AI belum menemukan setup yang cukup layak saat ini</span>
                </div>
            `;
        }

        container.innerHTML = html;
        this._bindCardClicks(container);
    },

    _renderCardsSection(title, titleClass, list, strategyKey, overrideType = 'buy', compact = false) {
        return `
            <div class="rec-section">
                <h4 class="rec-section-title ${titleClass}">
                    ${title}
                </h4>
                <div class="rec-cards-grid ${compact ? 'rec-cards-compact' : ''}">
                    ${list.map((pick, idx) => this._renderPickCard(pick, overrideType, idx, strategyKey)).join('')}
                </div>
            </div>
        `;
    },

    _renderLoadingState() {
        const container = document.getElementById('recMainContent');
        if (!container) return;
        container.innerHTML = `
            <div class="rec-loading">
                <div class="rec-loading-spinner"></div>
                <span>Menganalisis indikator teknikal & arus volume institusi untuk 300+ saham IDX...</span>
            </div>
        `;
    },

    _renderErrorState(msg, key) {
        const container = document.getElementById('recMainContent');
        if (!container) return;
        container.innerHTML = `
            <div class="rec-empty-state">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="1.5"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"></polygon><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                <span class="rec-empty-title">Gagal Memuat Analisis</span>
                <span class="rec-empty-text">${msg}</span>
                <button class="rec-refresh-btn" onclick="StockRecommendation.fetchData('${key}', true)">Muat Ulang</button>
            </div>
        `;
    },

    _renderTomorrowLocked(data) {
        const container = document.getElementById('recMainContent');
        if (!container) return;

        container.innerHTML = `
            <div class="rec-locked-overlay">
                <div class="rec-locked-card">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#4f46e5" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
                    <h3 class="rec-locked-title">Rekomendasi Besok Pagi Terkunci</h3>
                    <p class="rec-locked-desc">${data.message}</p>
                    <div class="rec-locked-time-info">
                        <div class="rec-locked-current">
                            <span class="rec-locked-label">Waktu Sekarang</span>
                            <span class="rec-locked-value">${data.currentTimeWIB || '15:00 WIB'}</span>
                        </div>
                        <div class="rec-locked-divider">→</div>
                        <div class="rec-locked-target">
                            <span class="rec-locked-label">Tersedia Mulai</span>
                            <span class="rec-locked-value">${data.availableAt || '19:00 WIB'}</span>
                        </div>
                    </div>
                    <div class="rec-countdown locked" id="recTomorrowCountdown">Menghitung waktu tunggu...</div>
                    <p class="rec-locked-hint">[Info]: Rekomendasi besok pagi berisi analisis pasca penutupan pasar (end-of-day) guna mendeteksi saham terbaik untuk open posisi saat pembukaan pasar pagi hari berikutnya.</p>
                </div>
            </div>
        `;
        this._startCountdown();
    },

    // ─── Render: Pick Card ─────────────────────────────────────────────
    _renderPickCard(pick, type, index, strategyKey) {
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

        const pe = pick.profitEstimation || {};
        const hasEstimation = pe.profitPercent != null && pe.winProbability != null;

        let detailsHTML = '';
        if (isBuyType) {
            const confClass = pe.confidenceLevel === 'HIGH' ? 'conf-high' : pe.confidenceLevel === 'MEDIUM' ? 'conf-medium' : 'conf-low';
            const winProbClass = (pe.winProbability || 0) >= 65 ? 'wp-high' : (pe.winProbability || 0) >= 50 ? 'wp-medium' : 'wp-low';

            detailsHTML = `
                <div class="rec-card-levels">
                    <div class="rec-level rec-level-entry">
                        <span class="rec-level-label">Area Beli (Entry)</span>
                        <span class="rec-level-value">${fmtPrice(pick.entryLow)} - ${fmtPrice(pick.entryHigh)}</span>
                    </div>
                    <div class="rec-level rec-level-sl">
                        <span class="rec-level-label">Batas Rugi (SL)</span>
                        <span class="rec-level-value">${fmtPrice(pick.stopLoss)}${pe.lossPercent ? ` <small class="rec-loss-pct">(-${pe.lossPercent}%)</small>` : ''}</span>
                    </div>
                    <div class="rec-level rec-level-tp">
                        <span class="rec-level-label">Target Cuan (TP)</span>
                        <span class="rec-level-value">${fmtPrice(pick.takeProfit)}${pe.profitPercent ? ` <small class="rec-profit-pct">(+${pe.profitPercent}%)</small>` : ''}</span>
                    </div>
                </div>
            `;

            if (hasEstimation) {
                detailsHTML += `
                <div class="rec-card-estimation">
                    <div class="rec-est-header">
                        <span class="rec-est-title">Statistik Probabilitas Cuan</span>
                        <span class="rec-est-confidence ${confClass}">${pe.confidenceLevel || 'OPTIMAL'}</span>
                    </div>
                    <div class="rec-est-grid">
                        <div class="rec-est-item">
                            <span class="rec-est-label">Durasi</span>
                            <span class="rec-est-value">${pe.timeEstimateLabel || '—'}</span>
                        </div>
                        <div class="rec-est-item">
                            <span class="rec-est-label">Potensi Profit</span>
                            <span class="rec-est-value rec-profit-pct">+${pe.profitPercent || 0}%</span>
                        </div>
                        <div class="rec-est-item">
                            <span class="rec-est-label">Risk/Reward</span>
                            <span class="rec-est-value">1:${pe.riskRewardRatio || 0}</span>
                        </div>
                        <div class="rec-est-item">
                            <span class="rec-est-label">Win Rate</span>
                            <span class="rec-est-value ${winProbClass}">${pe.winProbability || 0}%</span>
                        </div>
                    </div>
                    <div class="rec-est-progress">
                        <div class="rec-est-progress-label">
                            <span>Laju Cuan/Hari: <strong>+${pe.profitPerDay || 0}%</strong></span>
                            <span>Volatilitas ATR: ${pe.atrPercent || 0}%</span>
                        </div>
                        <div class="rec-est-bar">
                            <div class="rec-est-bar-fill" style="width: ${Math.min(100, (pe.winProbability || 0))}%"></div>
                        </div>
                    </div>
                </div>
                `;
            }
        }

        // Exclusive Strategy Guidance Box (Swing, BSJP, BPJS)
        let guidanceBoxHTML = '';
        if (strategyKey === 'swing') {
            guidanceBoxHTML = `
            <div class="rec-guidance-box">
                <div class="rec-guidance-row">
                    <svg class="rec-guidance-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 2v4"></path><path d="M16 2v4"></path><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><path d="M3 10h18"></path></svg>
                    <span class="rec-guidance-text"><span class="rec-guidance-label">Saran Masuk:</span> ${pick.entryDateAdvice || 'Masuk pada hari bursa berikutnya'}</span>
                </div>
                <div class="rec-guidance-row">
                    <svg class="rec-guidance-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline><polyline points="17 6 23 6 23 12"></polyline></svg>
                    <span class="rec-guidance-text"><span class="rec-guidance-label">Target Jual (${pick.targetProfitPct || '+6.5% - +11.0%'}):</span> ${pick.sellProfitAdvice || 'Jual bertahap saat target profit tercapai'}</span>
                </div>
            </div>`;
        } else if (strategyKey === 'bsjp') {
            guidanceBoxHTML = `
            <div class="rec-guidance-box">
                <div class="rec-guidance-row">
                    <svg class="rec-guidance-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                    <span class="rec-guidance-text"><span class="rec-guidance-label">Waktu Beli:</span> ${pick.entryTimeAdvice || 'Beli pukul 15.45 - 15.50 WIB jelang penutupan sesi akhir'}</span>
                </div>
                <div class="rec-guidance-row">
                    <svg class="rec-guidance-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20"></path><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>
                    <span class="rec-guidance-text"><span class="rec-guidance-label">Waktu Jual:</span> ${pick.sellTimeAdvice || 'Jual pada menit awal esok hari (09.00 - 09.15 WIB) saat gap-up (+1.5% - +3.0%)'}</span>
                </div>
            </div>`;
        } else if (strategyKey === 'bpjs') {
            guidanceBoxHTML = `
            <div class="rec-guidance-box">
                <div class="rec-guidance-row">
                    <svg class="rec-guidance-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                    <span class="rec-guidance-text"><span class="rec-guidance-label">Waktu Beli:</span> ${pick.entryTimeAdvice || 'Beli pada sesi I pukul 09.00 - 09.30 WIB saat konfirmasi volume'}</span>
                </div>
                <div class="rec-guidance-row">
                    <svg class="rec-guidance-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20"></path><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>
                    <span class="rec-guidance-text"><span class="rec-guidance-label">Waktu Jual:</span> ${pick.sellTimeAdvice || 'Jual sebelum penutupan sesi II di sore hari (Pukul 15.20 - 15.45 WIB)'}</span>
                </div>
            </div>`;
        }

        return `
            <div class="rec-card ${cardClass}" data-symbol="${pick.symbol}" style="animation-delay: ${index * 0.06}s">
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
                    <span class="rec-card-score">Skor Analisis: <strong>${pick.score}</strong></span>
                </div>
                ${detailsHTML}
                ${guidanceBoxHTML}
                <div class="rec-card-indicators">
                    ${pick.tradingViewRating && pick.tradingViewRating !== 'N/A' ? `<span class="rec-indicator rec-ind-tv rec-ind-tv-${pick.tradingViewRating.toLowerCase().replace(/_/g, '-')}" title="TradingView Official Screener Rating">TV: ${pick.tradingViewRating.replace(/_/g, ' ')}</span>` : ''}
                    <span class="rec-indicator" title="RSI">RSI: ${pick.rsi || '—'}</span>
                    <span class="rec-indicator" title="Volume Ratio">Vol: ${pick.volRatio || '—'}x</span>
                    ${pick.vwap ? `<span class="rec-indicator" title="VWAP">VWAP: ${fmtPrice(pick.vwap)}</span>` : ''}
                    ${pick.obvDivergence === 'ACCUMULATION' ? `<span class="rec-indicator" style="color:#00b972;" title="OBV Accumulation (Smart Money)">OBV Akumulasi</span>` : pick.obvDivergence === 'DISTRIBUTION' ? `<span class="rec-indicator" style="color:#f43f5e;" title="OBV Distribution">OBV Distribusi</span>` : pick.obvTrend && pick.obvTrend !== 'FLAT' ? `<span class="rec-indicator" title="OBV Trend">OBV: ${pick.obvTrend}</span>` : ''}
                    ${pick.candlestickPattern && pick.candlestickPattern !== 'NONE' ? `<span class="rec-indicator" style="border-color:#f59e0b;" title="Candlestick Pattern">${pick.candlestickPattern.replace(/_/g, ' ')}</span>` : ''}
                    <span class="rec-indicator" title="Support">S: ${fmtPrice(pick.support)}</span>
                    <span class="rec-indicator" title="Resistance">R: ${fmtPrice(pick.resistance)}</span>
                </div>
                <div class="rec-card-reasoning">
                    <span class="rec-reasoning-text">${pick.reasoning || ''}</span>
                </div>
            </div>
        `;
    },

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

    // ─── Global Helper ─────────────────────────────────────────────────
    getRecommendationForSymbol(symbol) {
        if (!symbol) return null;
        for (const key in this._data) {
            const data = this._data[key];
            if (!data) continue;
            const all = [
                ...(data.buyPicks || []),
                ...(data.holdPicks || []),
                ...(data.sellPicks || []),
                ...(data.morningPicks || []),
                ...(data.avoidPicks || []),
                ...(data.picks || [])
            ];
            const found = all.find(p => p.symbol === symbol);
            if (found) return found;
        }
        return null;
    }
};
