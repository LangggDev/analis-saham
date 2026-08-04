
class DataService {
    static async getQuote(symbol) {
        const res = await fetch(`/api/quote/${encodeURIComponent(symbol)}`);
        if (!res.ok) throw new Error(`Quote fetch failed (${res.status})`);
        return res.json();
    }

    static async getChart(symbol, interval = '1d') {
        const res = await fetch(
            `/api/chart/${encodeURIComponent(symbol)}?interval=${encodeURIComponent(interval)}`,
        );
        if (!res.ok) throw new Error(`Chart fetch failed (${res.status})`);
        return res.json();
    }

    static async searchSymbol(query) {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        if (!res.ok) throw new Error(`Search failed (${res.status})`);
        return res.json();
    }

    static async getNews(symbol) {
        const res = await fetch(`/api/news/${encodeURIComponent(symbol)}`);
        if (!res.ok) throw new Error(`News fetch failed (${res.status})`);
        return res.json();
    }

    static async getSentiment(symbol) {
        const res = await fetch(`/api/sentiment/${encodeURIComponent(symbol)}`);
        if (!res.ok) throw new Error(`Sentiment fetch failed (${res.status})`);
        return res.json();
    }

    static async getSummary(symbol) {
        const res = await fetch(`/api/summary/${encodeURIComponent(symbol)}`);
        if (!res.ok) throw new Error(`Summary fetch failed (${res.status})`);
        return res.json();
    }

    static async getFundamental(symbol) {
        const res = await fetch(`/api/fundamental/${encodeURIComponent(symbol)}`);
        if (!res.ok) throw new Error(`Fundamental fetch failed (${res.status})`);
        return res.json();
    }

    static async getMarketStatus(exchange) {
        const res = await fetch(`/api/market-status/${encodeURIComponent(exchange)}`);
        if (!res.ok) throw new Error(`Market status fetch failed (${res.status})`);
        return res.json();
    }
}

/* ======================================================================
   2. ChartManager – Lightweight Charts (real-time OHLCV from our backend)
   ====================================================================== */

class ChartManager {
    constructor() {
        this.chart = null;
        this.candleSeries = null;
        this.volumeSeries = null;
        this.smaSeries = null;
        this.sma50Series = null;
        this.container = null;
        this.customWrap = null;
        this.tvWrap = null;
        this.mode = 'tv'; // 'tv' (TradingView Widget) or 'custom' (Lightweight Charts)
        this.currentSymbol = 'BBRI.JK';
        this.currentInterval = '1d';
        this._lastData = [];           // Full OHLCV array
        this._legendEl = null;
        this._resizeObserver = null;
    }

    init(containerId) {
        this.container = document.getElementById(containerId);
        this.tvWrap = document.getElementById('tradingview_widget_wrap');
        this.customWrap = document.getElementById('custom_chart_wrap');

        // Explicitly enforce visibility of initial mode to prevent stacking
        if (this.tvWrap && this.customWrap) {
            if (this.mode === 'tv') {
                this.tvWrap.style.display = 'flex';
                this.tvWrap.classList.add('active');
                this.customWrap.style.display = 'none';
                this.customWrap.classList.remove('active');
            } else {
                this.customWrap.style.display = 'flex';
                this.customWrap.classList.add('active');
                this.tvWrap.style.display = 'none';
                this.tvWrap.classList.remove('active');
            }
        }

        this._setupModeToggle();
        this._createCustomChart();
    }

    _setupModeToggle() {
        const tvBtn = document.getElementById('chartModeTvBtn');
        const customBtn = document.getElementById('chartModeCustomBtn');
        const statusText = document.getElementById('chartStatusText');

        if (tvBtn && customBtn) {
            tvBtn.addEventListener('click', () => {
                this.mode = 'tv';
                tvBtn.classList.add('active');
                customBtn.classList.remove('active');
                if (this.tvWrap) {
                    this.tvWrap.style.display = 'flex';
                    this.tvWrap.classList.add('active');
                }
                if (this.customWrap) {
                    this.customWrap.style.display = 'none';
                    this.customWrap.classList.remove('active');
                }
                if (statusText) statusText.textContent = 'TradingView Widget Live';
                this.renderTradingView(this.currentSymbol, this.currentInterval);
            });

            customBtn.addEventListener('click', () => {
                this.mode = 'custom';
                customBtn.classList.add('active');
                tvBtn.classList.remove('active');
                if (this.customWrap) {
                    this.customWrap.style.display = 'flex';
                    this.customWrap.classList.add('active');
                }
                if (this.tvWrap) {
                    this.tvWrap.style.display = 'none';
                    this.tvWrap.classList.remove('active');
                    this.tvWrap.innerHTML = ''; // Clean up TV widget iframe to free resources & prevent stacking
                }
                if (statusText) statusText.textContent = 'Pro Chart + Indikator Live';
                if (this.chart && this.customWrap) {
                    setTimeout(() => {
                        const width = this.customWrap.clientWidth || this.container?.clientWidth || 800;
                        const height = this.customWrap.clientHeight || 520;
                        this.chart.applyOptions({ width, height });
                    }, 50);
                }
                this.loadData(this.currentSymbol, this.currentInterval);
            });
        }
    }

    renderTradingView(symbol, interval) {
        if (!this.tvWrap) return;
        this.tvWrap.innerHTML = '';

        const tvSymbol = symbol.endsWith('.JK') ? `IDX:${symbol.replace('.JK', '')}` : symbol;
        const tvIntervalMap = {
            '1m': '1', '5m': '5', '15m': '15', '60m': '60',
            '1d': 'D', '1wk': 'W', '1mo': 'M'
        };
        const tvInt = tvIntervalMap[interval] || 'D';

        if (typeof TradingView !== 'undefined') {
            try {
                new TradingView.widget({
                    "autosize": true,
                    "symbol": tvSymbol,
                    "interval": tvInt,
                    "timezone": "Asia/Jakarta",
                    "theme": "dark",
                    "style": "1",
                    "locale": "id",
                    "toolbar_bg": "#0d121c",
                    "enable_publishing": false,
                    "allow_symbol_change": false,
                    "container_id": "tradingview_widget_wrap"
                });
            } catch (e) {
                console.warn('[ChartManager] TV Widget Embed error:', e);
            }
        } else {
            this.tvWrap.innerHTML = '<div style="padding:40px;text-align:center;color:#64748b;">Memuat TradingView Widget...</div>';
        }
    }

    _createCustomChart() {
        if (!this.customWrap) return;

        // Clear previous
        if (this.chart) {
            this.chart.remove();
            this.chart = null;
        }
        this.customWrap.innerHTML = '';

        // Create chart
        this.chart = LightweightCharts.createChart(this.customWrap, {
            width: this.customWrap.clientWidth || 800,
            height: this.customWrap.clientHeight || 450,
            layout: {
                background: { type: 'solid', color: '#0d121c' },
                textColor: '#cbd5e1',
                fontFamily: "'Plus Jakarta Sans', 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif",
                fontSize: 12,
            },
            grid: {
                vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
                horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
            },
            crosshair: {
                mode: LightweightCharts.CrosshairMode.Normal,
                vertLine: { color: '#64748b', width: 1, style: 2, labelBackgroundColor: '#4f46e5' },
                horzLine: { color: '#64748b', width: 1, style: 2, labelBackgroundColor: '#4f46e5' },
            },
            rightPriceScale: {
                borderColor: 'rgba(255, 255, 255, 0.12)',
                scaleMargins: { top: 0.1, bottom: 0.25 },
            },
            timeScale: {
                borderColor: 'rgba(255, 255, 255, 0.12)',
                timeVisible: true,
                secondsVisible: false,
                rightOffset: 5,
                barSpacing: 8,
                fixLeftEdge: false,
                fixRightEdge: false,
            },
            handleScroll: { vertTouchDrag: false },
            handleScale: { axisPressedMouseMove: true },
        });

        // Candlestick series
        this.candleSeries = this.chart.addCandlestickSeries({
            upColor: '#00e676',
            downColor: '#ff5252',
            borderUpColor: '#00e676',
            borderDownColor: '#ff5252',
            wickUpColor: '#00e676',
            wickDownColor: '#ff5252',
        });

        // Volume series
        this.volumeSeries = this.chart.addHistogramSeries({
            priceFormat: { type: 'volume' },
            priceScaleId: 'volume',
        });

        this.chart.priceScale('volume').applyOptions({
            scaleMargins: { top: 0.82, bottom: 0 },
        });

        // SMA 20 overlay
        this.smaSeries = this.chart.addLineSeries({
            color: '#38bdf8',
            lineWidth: 2,
            lineStyle: 0,
            crosshairMarkerVisible: false,
            priceLineVisible: false,
            lastValueVisible: false,
        });

        // SMA 50 overlay
        this.sma50Series = this.chart.addLineSeries({
            color: '#ffab00',
            lineWidth: 2,
            lineStyle: 0,
            crosshairMarkerVisible: false,
            priceLineVisible: false,
            lastValueVisible: false,
        });

        // Legend overlay
        this._createLegend();

        // Crosshair move → update legend
        this.chart.subscribeCrosshairMove((param) => this._updateLegend(param));

        // Responsive resize
        this._resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                if (width > 0 && height > 0) {
                    this.chart.applyOptions({ width, height });
                }
            }
        });
        this._resizeObserver.observe(this.customWrap);
    }

    _createLegend() {
        if (!this.customWrap) return;
        this._legendEl = document.createElement('div');
        this._legendEl.className = 'chart-legend';
        this._legendEl.innerHTML = '<span class="chart-legend-symbol"></span>';
        this.customWrap.style.position = 'relative';
        this.customWrap.appendChild(this._legendEl);
    }

    _updateLegend(param) {
        if (!this._legendEl) return;

        if (!param || !param.time || !param.seriesData) {
            if (this._lastData.length > 0) {
                const last = this._lastData[this._lastData.length - 1];
                this._renderLegendValues(last);
            }
            return;
        }

        const candleData = param.seriesData.get(this.candleSeries);
        const volumeData = param.seriesData.get(this.volumeSeries);

        if (candleData) {
            this._renderLegendValues({
                ...candleData,
                volume: volumeData?.value || 0,
            });
        }
    }

    _renderLegendValues(d) {
        if (!d || !this._legendEl) return;
        const chg = d.close - d.open;
        const chgPct = d.open !== 0 ? (chg / d.open) * 100 : 0;
        const cls = chg >= 0 ? 'positive' : 'negative';
        const sign = chg >= 0 ? '+' : '';

        const fmt = (v) => {
            if (v == null) return '—';
            return v >= 1000 ? new Intl.NumberFormat('id-ID').format(v) : v.toFixed(2);
        };
        const fmtVol = (v) => {
            if (!v) return '0';
            if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
            if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
            if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
            return String(v);
        };

        this._legendEl.innerHTML = `
            <span class="chart-legend-symbol">${this.currentSymbol}</span>
            <span class="chart-legend-item">O <b>${fmt(d.open)}</b></span>
            <span class="chart-legend-item">H <b>${fmt(d.high)}</b></span>
            <span class="chart-legend-item">L <b>${fmt(d.low)}</b></span>
            <span class="chart-legend-item">C <b class="${cls}">${fmt(d.close)}</b></span>
            <span class="chart-legend-item ${cls}">${sign}${chg.toFixed(2)} (${sign}${chgPct.toFixed(2)}%)</span>
            <span class="chart-legend-item vol">Vol ${fmtVol(d.volume)}</span>
        `;
    }

    // ─── Load data from backend ───────────────────────────────────────
    async loadData(symbol, interval) {
        this.currentSymbol = symbol;
        this.currentInterval = interval;

        // Render TradingView Widget if mode is 'tv'
        if (this.mode === 'tv') {
            this.renderTradingView(symbol, interval);
        }

        try {
            const chartData = await DataService.getChart(symbol, interval);
            const ohlcv = this._normalizeData(chartData);

            if (ohlcv.length === 0) {
                console.warn('[Chart] No data for', symbol);
                return;
            }

            this._lastData = ohlcv;

            if (this.candleSeries && this.volumeSeries) {
                // Set candlestick data
                this.candleSeries.setData(ohlcv.map(d => ({
                    time: d.time,
                    open: d.open,
                    high: d.high,
                    low: d.low,
                    close: d.close,
                })));

                // Set volume data with colors
                this.volumeSeries.setData(ohlcv.map(d => ({
                    time: d.time,
                    value: d.volume,
                    color: d.close >= d.open ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)',
                })));

                // Compute and set SMA 20 & SMA 50
                const smaData = this._computeSMA(ohlcv, 20);
                if (this.smaSeries) this.smaSeries.setData(smaData);

                const sma50Data = this._computeSMA(ohlcv, 50);
                if (this.sma50Series) this.sma50Series.setData(sma50Data);

                // Fit content
                if (this.chart) this.chart.timeScale().fitContent();

                // Update legend with last bar
                if (ohlcv.length > 0) {
                    this._renderLegendValues(ohlcv[ohlcv.length - 1]);
                }
            }
        } catch (err) {
            console.error('[Chart] loadData error:', err);
        }
    }

    _getTimezone() {
        const sym = this.currentSymbol.toUpperCase();
        if (sym.endsWith('.JK') || sym.includes('.JK')) {
            return 'Asia/Jakarta';
        }
        return 'America/New_York';
    }

    _getMarketOpenTimestamp(date, timezone) {
        const isUS = timezone === 'America/New_York';
        const openHour = isUS ? 9 : 9;
        const openMin = isUS ? 30 : 0;

        // Format to YYYY-MM-DD
        const fmt = new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        });
        const dateStr = fmt.format(date); // "YYYY-MM-DD"

        const targetDate = new Date(`${dateStr}T${String(openHour).padStart(2, '0')}:${String(openMin).padStart(2, '0')}:00`);
        const browserDate = new Date();
        const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

        const getTzOffset = (tz, d) => {
            try {
                const s = d.toLocaleString('en-US', { timeZone: tz });
                return new Date(s).getTime() - d.getTime();
            } catch (_) {
                return 0;
            }
        };

        const diff = getTzOffset(timezone, targetDate) - getTzOffset(browserTz, targetDate);
        return Math.floor((targetDate.getTime() - diff) / 1000);
    }

    _isSameBar(lastTime, nowTime, interval) {
        const tz = this._getTimezone();
        const lastDate = new Date(lastTime * 1000);
        const nowDate = new Date(nowTime * 1000);

        const formatOptions = { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' };

        if (interval === '1d') {
            const fmt = new Intl.DateTimeFormat('en-US', formatOptions);
            return fmt.format(lastDate) === fmt.format(nowDate);
        } else if (interval === '1wk') {
            // Monday-to-Monday check
            const getMonday = (d) => {
                const day = d.getDay();
                const diff = d.getDate() - day + (day === 0 ? -6 : 1);
                const temp = new Date(d);
                temp.setDate(diff);
                return temp;
            };
            const fmt = new Intl.DateTimeFormat('en-US', formatOptions);
            return fmt.format(getMonday(lastDate)) === fmt.format(getMonday(nowDate));
        } else if (interval === '1mo') {
            const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric' });
            return fmt.format(lastDate) === fmt.format(nowDate);
        }
        return false;
    }

    // ─── Real-time update from quote polling ──────────────────────────
    updateRealtime(quote) {
        if (!this.candleSeries || !quote || !quote.price) return;

        const isIntraday = ['1m', '5m', '15m', '60m'].includes(this.currentInterval);

        // Build updated candle from current quote
        const now = Math.floor(Date.now() / 1000);
        let candleTime;

        const lastCandle = this._lastData.length > 0
            ? this._lastData[this._lastData.length - 1]
            : null;

        if (isIntraday) {
            // Round to interval bucket
            const intervalSeconds = {
                '1m': 60, '5m': 300, '15m': 900, '60m': 3600,
            }[this.currentInterval] || 300;
            candleTime = Math.floor(now / intervalSeconds) * intervalSeconds;
        } else {
            // Daily/Weekly/Monthly
            const tz = this._getTimezone();
            if (lastCandle && this._isSameBar(lastCandle.time, now, this.currentInterval)) {
                candleTime = lastCandle.time; // Use the exact same timestamp to update the bar
            } else {
                // Compute start of day/week/month in exchange timezone
                candleTime = this._getMarketOpenTimestamp(new Date(), tz);
            }
        }

        // Update existing candle or create new one
        if (lastCandle && lastCandle.time === candleTime) {
            // Update existing last candle
            lastCandle.high = Math.max(lastCandle.high, quote.price);
            lastCandle.low = Math.min(lastCandle.low, quote.price);
            lastCandle.close = quote.price;
            if (quote.volume) lastCandle.volume = quote.volume;
        } else if (!lastCandle || candleTime > lastCandle.time) {
            // New candle
            const newCandle = {
                time: candleTime,
                open: quote.price,
                high: quote.price,
                low: quote.price,
                close: quote.price,
                volume: quote.volume || 0,
            };
            this._lastData.push(newCandle);
        }

        // Get the candle to update
        const updateCandle = this._lastData[this._lastData.length - 1];
        if (!updateCandle) return;

        // Push update to series
        this.candleSeries.update({
            time: updateCandle.time,
            open: updateCandle.open,
            high: updateCandle.high,
            low: updateCandle.low,
            close: updateCandle.close,
        });

        this.volumeSeries.update({
            time: updateCandle.time,
            value: updateCandle.volume,
            color: updateCandle.close >= updateCandle.open
                ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)',
        });

        // Update SMA
        const smaData = this._computeSMA(this._lastData, 20);
        if (smaData.length > 0) {
            this.smaSeries.update(smaData[smaData.length - 1]);
        }

        // Update legend
        this._renderLegendValues(updateCandle);
    }

    // ─── Change interval ──────────────────────────────────────────────
    async changeInterval(interval) {
        this.currentInterval = interval;
        await this.loadData(this.currentSymbol, interval);
    }

    // ─── Change symbol ────────────────────────────────────────────────
    async changeSymbol(symbol) {
        this.currentSymbol = symbol;
        await this.loadData(symbol, this.currentInterval);
    }

    // ─── Compute SMA ──────────────────────────────────────────────────
    _computeSMA(data, period) {
        const result = [];
        for (let i = period - 1; i < data.length; i++) {
            let sum = 0;
            for (let j = i - period + 1; j <= i; j++) {
                sum += data[j].close;
            }
            result.push({
                time: data[i].time,
                value: sum / period,
            });
        }
        return result;
    }

    // ─── Normalize backend data ───────────────────────────────────────
    _normalizeData(raw) {
        let arr = [];
        if (Array.isArray(raw)) {
            arr = raw;
        } else if (raw?.data && Array.isArray(raw.data)) {
            arr = raw.data;
        } else if (raw?.chart?.result?.[0]) {
            const r = raw.chart.result[0];
            const ts = r.timestamp ?? [];
            const q = r.indicators?.quote?.[0] ?? {};
            arr = ts.map((t, i) => ({
                time: t,
                open: q.open?.[i] ?? 0,
                high: q.high?.[i] ?? 0,
                low: q.low?.[i] ?? 0,
                close: q.close?.[i] ?? 0,
                volume: q.volume?.[i] ?? 0,
            }));
        }

        return arr
            .filter(d => d && d.close != null && d.close !== 0)
            .map(d => ({
                time: typeof d.time === 'number' && d.time > 1e12
                    ? Math.floor(d.time / 1000)
                    : d.time,
                open: Number(d.open),
                high: Number(d.high),
                low: Number(d.low),
                close: Number(d.close),
                volume: Number(d.volume ?? 0),
            }))
            .sort((a, b) => a.time - b.time);
    }
}

/* ======================================================================
   3. NotificationManager – toast + browser notifications for signals
   ====================================================================== */

class NotificationManager {
    constructor() {
        this.permission = 'default';
        this.notifiedSignals = new Map(); // symbol -> { signal, timestamp }
        this.notifications = []; // history of all notifications
        this.toastContainer = null;
        this.enabled = true;
        this.COOLDOWN_MS = 5 * 60 * 1000; // 5 min cooldown per symbol
    }

    async init() {
        this.toastContainer = document.getElementById('toastContainer');

        // Request browser notification permission
        if ('Notification' in window) {
            if (Notification.permission === 'default') {
                this.permission = await Notification.requestPermission();
            } else {
                this.permission = Notification.permission;
            }
        }

        // Setup bell button
        const bellBtn = document.getElementById('notifBellBtn');
        const panel = document.getElementById('notifPanel');
        const closeBtn = document.getElementById('notifCloseBtn');

        if (bellBtn && panel) {
            bellBtn.addEventListener('click', () => {
                panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
            });
        }
        if (closeBtn && panel) {
            closeBtn.addEventListener('click', () => { panel.style.display = 'none'; });
        }

        // Close panel on outside click
        document.addEventListener('click', (e) => {
            if (panel && !e.target.closest('.notif-panel') && !e.target.closest('.notif-bell')) {
                panel.style.display = 'none';
            }
        });
    }

    /**
     * Check signal result and send notification if STRONG_BUY or STRONG_SELL
     */
    checkAndNotify(symbol, signalResult, currentPrice) {
        if (!this.enabled) return;
        const current = signalResult.overall;

        // Only notify on strong signals OR buy/sell
        if (current === 'NEUTRAL') return;

        // Check cooldown
        const lastNotified = this.notifiedSignals.get(symbol);
        if (lastNotified) {
            if (lastNotified.signal === current && (Date.now() - lastNotified.timestamp) < this.COOLDOWN_MS) {
                return; // Still in cooldown
            }
        }

        // Only send push notification for STRONG signals
        const isStrong = current === 'STRONG_BUY' || current === 'STRONG_SELL';

        // Record this notification
        this.notifiedSignals.set(symbol, { signal: current, timestamp: Date.now() });

        const notifData = {
            symbol,
            signal: current,
            score: signalResult.score,
            price: currentPrice,
            signals: signalResult.signals,
            timestamp: new Date(),
        };

        this.notifications.unshift(notifData);
        if (this.notifications.length > 50) this.notifications.pop();

        // Show toast in app
        this._showToast(notifData);

        // Send browser notification for strong signals
        if (isStrong) {
            this._sendBrowserNotification(notifData);
        }

        // Update bell badge
        this._updateBadge();

        // Update notification panel
        this._updatePanel();
    }

    _sendBrowserNotification(data) {
        if (this.permission !== 'granted') return;

        const icon = data.signal === 'STRONG_BUY' ? '[BUY]' : '[SELL]';
        const signalText = data.signal.replace(/_/g, ' ');
        const title = `${icon} ${signalText} — ${data.symbol}`;

        const topSignals = data.signals.slice(0, 4).map(s => `${s.name}: ${s.signal}`).join(', ');
        const body = `Harga: ${data.price} | Skor: ${data.score}\n${topSignals}`;

        try {
            const notif = new Notification(title, {
                body,
                tag: `signal-${data.symbol}`,
                renotify: true,
                requireInteraction: false,
            });
            // Auto close after 10 seconds
            setTimeout(() => notif.close(), 10000);
        } catch (e) {
            console.warn('Browser notification failed:', e);
        }
    }

    _showToast(data) {
        if (!this.toastContainer) return;

        const signalText = data.signal.replace(/_/g, ' ');
        const signalClass = data.signal.toLowerCase();
        const icon = data.signal.includes('BUY') ? '[+]' : '[-]';
        const time = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

        const toast = document.createElement('div');
        toast.className = `toast toast-${signalClass}`;
        toast.innerHTML = `
            <div class="toast-header">
                <span class="toast-title">${icon} ${data.symbol}</span>
                <span class="toast-time">${time}</span>
            </div>
            <div class="toast-body">
                <span class="toast-signal-badge ${signalClass}">${signalText}</span>
                Skor: ${data.score} | Harga: ${typeof data.price === 'number' ? data.price.toLocaleString() : data.price}
            </div>
        `;

        toast.addEventListener('click', () => toast.remove());
        this.toastContainer.appendChild(toast);

        // Auto remove after 8 seconds
        setTimeout(() => {
            if (toast.parentNode) toast.remove();
        }, 8000);
    }

    _updateBadge() {
        const badge = document.getElementById('notifBadge');
        if (!badge) return;
        const count = this.notifications.length;
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.style.display = count > 0 ? 'flex' : 'none';
    }

    _updatePanel() {
        const list = document.getElementById('notifList');
        if (!list) return;

        if (this.notifications.length === 0) {
            list.innerHTML = `
                <div class="empty-state">
                    <span class="empty-state-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg></span>
                    <span class="empty-state-title">Belum ada notifikasi</span>
                    <span class="empty-state-text">Notifikasi muncul saat ada sinyal kuat</span>
                </div>
            `;
            return;
        }

        list.innerHTML = this.notifications.slice(0, 20).map(n => {
            const signalText = n.signal.replace(/_/g, ' ');
            const isBuy = n.signal.includes('BUY');
            const icon = isBuy ? '[+]' : '[-]';
            const timeStr = n.timestamp.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
            const dateStr = n.timestamp.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });

            return `
                <div class="notif-item ${isBuy ? 'notif-buy' : 'notif-sell'}" data-symbol="${n.symbol}">
                    <div class="notif-item-header">
                        <span class="notif-item-symbol">${icon} ${n.symbol}</span>
                        <span class="notif-item-time">${dateStr} ${timeStr}</span>
                    </div>
                    <div class="notif-item-signal">
                        <span class="toast-signal-badge ${n.signal.toLowerCase()}">${signalText}</span>
                        Skor: ${n.score}
                    </div>
                    <div class="notif-item-details">
                        ${n.signals.slice(0, 3).map(s => `${s.name}: ${s.signal}`).join(' · ')}
                    </div>
                </div>
            `;
        }).join('');

        // Click notification to load symbol
        list.querySelectorAll('.notif-item').forEach(el => {
            el.addEventListener('click', () => {
                const sym = el.dataset.symbol;
                if (sym && window.__app) {
                    window.__app.loadSymbol(sym);
                    document.getElementById('notifPanel').style.display = 'none';
                }
            });
        });
    }
}

/* ======================================================================
   4. WatchlistManager
   ====================================================================== */

class WatchlistManager {
    constructor(onSelect) {
        this.STORAGE_KEY = 'stock_analyzer_watchlist';
        this.symbols = [];
        this._onSelect = onSelect; // callback(symbol)
        this._container = null;
        this._priceCache = {};
    }

    async init() {
        this._container = document.getElementById('watchlist');
        const saved = localStorage.getItem(this.STORAGE_KEY);
        if (saved) {
            try {
                this.symbols = JSON.parse(saved);
            } catch (_) {
                this.symbols = [];
            }
        }
        if (this.symbols.length === 0) {
            this.symbols = ['BBRI.JK', 'TLKM.JK', 'BBCA.JK', 'AAPL', 'GOOGL'];
        }
        this.render();
        this.updatePrices();

        // Sync with PostgreSQL Cloud if user is logged in
        await this.syncWithCloud();
    }

    async syncWithCloud() {
        const token = window.JournalManager?.token || localStorage.getItem('stockpulse_jwt');
        if (!token) return;

        try {
            const res = await fetch('/api/watchlist', {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data.watchlist) && data.watchlist.length > 0) {
                    this.symbols = data.watchlist;
                    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.symbols));
                    this.render();
                    this.updatePrices();
                }
            }
        } catch (err) {
            console.warn('[Watchlist Cloud Sync Error]:', err.message);
        }
    }

    add(symbol) {
        const sym = symbol.toUpperCase().trim();
        if (!sym || this.symbols.includes(sym)) return;
        this.symbols.push(sym);
        this._save();
        this.render();
        this._fetchPrice(sym);
    }

    remove(symbol) {
        this.symbols = this.symbols.filter(s => s !== symbol);
        this._save();
        this.render();
    }

    _save() {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.symbols));
        const token = window.JournalManager?.token || localStorage.getItem('stockpulse_jwt');
        if (token) {
            fetch('/api/watchlist', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ watchlist: this.symbols })
            }).catch(err => console.warn('[Watchlist Cloud Push Error]:', err.message));
        }
    }

    render() {
        if (!this._container) return;
        this._container.innerHTML = '';

        const activeHoldings = window.JournalManager?.activeHoldings || JSON.parse(localStorage.getItem('stockpulse_active_holdings') || '{}');

        // Prioritaskan saham yang dibeli / dipunyai agar berada di posisi paling atas Watchlist!
        const sortedSymbols = [...this.symbols].sort((a, b) => {
            const aHolding = !!(activeHoldings[a] && activeHoldings[a].qty > 0);
            const bHolding = !!(activeHoldings[b] && activeHoldings[b].qty > 0);
            if (aHolding && !bHolding) return -1;
            if (!aHolding && bHolding) return 1;
            return 0;
        });

        sortedSymbols.forEach(sym => {
            const item = document.createElement('div');
            const isHolding = !!(activeHoldings[sym] && activeHoldings[sym].qty > 0);
            item.className = 'watchlist-item' + (isHolding ? ' is-portfolio-item' : '') + (sym === (window.app?.currentSymbol) ? ' active' : '');
            item.dataset.symbol = sym;

            const cached = this._priceCache[sym];
            const price = cached ? this._formatPrice(cached.price, sym) : '—';
            const changePct = cached ? cached.changePct : null;
            const changeClass = changePct !== null
                ? (changePct >= 0 ? 'positive' : 'negative')
                : '';
            const changeText = changePct !== null
                ? `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`
                : '';

            const badgeHtml = isHolding ? `<span class="watchlist-badge-portfolio" title="Saham Dibeli / Dipunyai di Portofolio">PORTFOLIO</span>` : '';

            item.innerHTML = `
                <div class="watchlist-item-info">
                    <span class="watchlist-symbol">${sym} ${badgeHtml}</span>
                    <span class="watchlist-price">${price}</span>
                </div>
                <div class="watchlist-item-actions">
                    <span class="watchlist-change ${changeClass}">${changeText}</span>
                    <button class="watchlist-remove" data-remove="${sym}" title="Hapus">×</button>
                </div>
            `;

            item.addEventListener('click', (e) => {
                if (e.target.classList.contains('watchlist-remove')) {
                    e.stopPropagation();
                    this.remove(e.target.dataset.remove);
                    return;
                }
                // Highlight selected
                this._container.querySelectorAll('.watchlist-item').forEach(el => el.classList.remove('active'));
                item.classList.add('active');
                if (this._onSelect) this._onSelect(sym);
            });

            this._container.appendChild(item);
        });
    }

    async updatePrices() {
        for (const sym of this.symbols) {
            await this._fetchPrice(sym);
        }
        this.render();
    }

    async _fetchPrice(symbol) {
        try {
            const q = await DataService.getQuote(symbol);
            this._priceCache[symbol] = {
                price: q.price ?? q.regularMarketPrice ?? 0,
                changePct: q.changePercent ?? q.regularMarketChangePercent ?? 0,
            };
        } catch (_) {
            // silently ignore – will show "—"
        }
    }

    _formatPrice(price, symbol) {
        if (symbol && symbol.endsWith('.JK')) {
            return new Intl.NumberFormat('id-ID', { style: 'decimal', minimumFractionDigits: 0 }).format(price);
        }
        return new Intl.NumberFormat('en-US', { style: 'decimal', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(price);
    }
}

/* ======================================================================
   5. App – main controller
   ====================================================================== */

class App {
    constructor() {
        this.currentSymbol = 'BBRI.JK';
        this.currentInterval = '1d';
        this.currentExchange = 'JKT';
        this.pollingInterval = null;
        this.POLL_INTERVAL_OPEN_MS = 10000;   // 10 seconds when market is open
        this.POLL_INTERVAL_CLOSED_MS = 60000; // 60 seconds when market is closed
        this.SCAN_INTERVAL_MS = 60000;         // 60 seconds for full watchlist scan
        this.scanInterval = null;
        this.marketStatusInterval = null;
        this._currentMarketState = 'CLOSED';   // Track current market state for adaptive polling

        // Last analysis results for combined scoring
        this._lastTechnicalScore = null;
        this._lastFundamentalScore = null;  // null means not available
        this._lastSentimentScore = null;    // null means not available
        this._lastFundamentalData = null;
        this._lastFundamentalHasData = false; // Whether fundamental data is real or fallback

        this.tvChart = new ChartManager();
        this.watchlist = new WatchlistManager((sym) => this.loadSymbol(sym));
        this.notifications = new NotificationManager();

        this._searchTimeout = null;
        this._currentOrderType = 'BUY';
    }

    /* ---- Bootstrap ---- */

    async init() {
        // TradingView Chart
        this.tvChart.init('tradingview_chart');

        // Watchlist
        this.watchlist.init();

        // Notifications
        await this.notifications.init();

        // Pre-Order Manager
        PreOrderManager.init((orders) => this._renderPreOrders(orders));

        // Stock Screener
        StockScreener.init((symbol) => {
            this.loadSymbol(symbol);
            this._switchTab('quote'); // Switch to chart view when selecting from screener
        });

        // Stock Recommendation
        StockRecommendation.init((symbol) => {
            this.loadSymbol(symbol);
            this._switchTab('quote');
        });

        // Event listeners
        this._setupAutoTheme();
        this._setupSearch();
        this._setupTimeframeButtons();
        this._setupKeyboard();
        this._setupTabs();
        this._setupPreOrderForm();

        // Add watchlist button
        const addBtn = document.getElementById('addWatchlistBtn');
        if (addBtn) {
            addBtn.addEventListener('click', () => {
                const sym = prompt('Masukkan simbol saham (contoh: BBRI.JK, AAPL):');
                if (sym) this.watchlist.add(sym);
            });
        }

        // Mobile Watchlist Toggle
        const mobileWatchlistBtn = document.getElementById('mobileWatchlistBtn');
        const sidebarBackdrop = document.getElementById('sidebarBackdrop');
        const sidebar = document.getElementById('sidebar');

        const toggleMobileSidebar = (show) => {
            if (!sidebar) return;
            const shouldShow = show !== undefined ? show : (!sidebar.classList.contains('active') && !sidebar.classList.contains('open'));
            sidebar.classList.toggle('active', shouldShow);
            sidebar.classList.toggle('open', shouldShow);
            if (sidebarBackdrop) sidebarBackdrop.classList.toggle('active', shouldShow);
        };

        if (mobileWatchlistBtn) {
            mobileWatchlistBtn.addEventListener('click', () => toggleMobileSidebar());
        }
        if (sidebarBackdrop) {
            sidebarBackdrop.addEventListener('click', () => toggleMobileSidebar(false));
        }

        // Close mobile drawer when stock item in watchlist is clicked
        const watchlistEl = document.getElementById('watchlist');
        if (watchlistEl) {
            watchlistEl.addEventListener('click', (e) => {
                if (window.innerWidth <= 1024) {
                    toggleMobileSidebar(false);
                }
            });
        }

        // Pre-order badge click → switch to preorder tab
        const poBadgeBtn = document.getElementById('preorderBadgeBtn');
        if (poBadgeBtn) {
            poBadgeBtn.addEventListener('click', () => {
                this._switchTab('preorder');
            });
        }

        // AUTO-MONITORING: Jika ada saham yang dibeli / dimiliki di portofolio, utamakan langsung tampil di chart saat pertama dibuka!
        try {
            const savedHoldings = JSON.parse(localStorage.getItem('stockpulse_active_holdings') || '{}');
            const holdingSymbols = Object.keys(savedHoldings).filter(s => savedHoldings[s]?.qty > 0);
            if (holdingSymbols.length > 0) {
                this.currentSymbol = holdingSymbols[0];
                console.log('[Auto-Monitor]: Memuat saham portofolio aktif pertama saat startup:', this.currentSymbol);
            }
        } catch(e) { /* fallback ke default */ }

        window.updateQuickMonitoringBar = () => this._updateQuickMonitoringBar();

        // Initial load
        await this.loadSymbol(this.currentSymbol);

        // Start polling current symbol
        this.startPolling();

        // Start watchlist scanning for signals
        this.startWatchlistScan();

        // Start market status polling
        this._startMarketStatusPolling();

        // Render existing pre-orders
        this._renderPreOrders(PreOrderManager.getAllOrders());
        this._updatePreOrderBadge();
    }

    _setupAutoTheme() {
        const updateThemeByTime = () => {
            const manualTheme = sessionStorage.getItem('stockpulse_manual_theme');
            if (manualTheme) {
                document.documentElement.setAttribute('data-theme', manualTheme);
                return;
            }

            const now = new Date();
            const hours = now.getHours(); // 0-23
            // 06:00 to 17:59 => light, 18:00 to 05:59 => dark
            const isDay = hours >= 6 && hours < 18;
            const theme = isDay ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', theme);

            const btn = document.getElementById('themeToggleBtn');
            if (btn) {
                btn.title = `Mode Otomatis Jam: ${theme.toUpperCase()} (06:00-17:59 Light / 18:00-05:59 Dark)`;
            }
        };

        updateThemeByTime();
        setInterval(updateThemeByTime, 60000);

        const btn = document.getElementById('themeToggleBtn');
        if (btn) {
            btn.addEventListener('click', () => {
                const current = document.documentElement.getAttribute('data-theme') || 'dark';
                const next = current === 'light' ? 'dark' : 'light';
                sessionStorage.setItem('stockpulse_manual_theme', next);
                document.documentElement.setAttribute('data-theme', next);
                btn.title = `Mode Manual: ${next.toUpperCase()} (Klik untuk toggle)`;
            });
        }
    }

    /* ---- Load Symbol ---- */

    async loadSymbol(symbol) {
        this.currentSymbol = symbol;

        // Auto-close mobile sidebar drawer
        const sidebar = document.getElementById('sidebar');
        const sidebarBackdrop = document.getElementById('sidebarBackdrop');
        if (sidebar) sidebar.classList.remove('active');
        if (sidebarBackdrop) sidebarBackdrop.classList.remove('active');

        // Update chart
        await this.tvChart.changeSymbol(symbol);

        // Update header
        this._setText('symbolName', symbol);

        // Auto-fill pre-order symbol
        const poSymbol = document.getElementById('poSymbol');
        if (poSymbol) poSymbol.value = symbol;

        try {
            // Fetch quote and chart data for signals
            const [quote, chartData] = await Promise.all([
                DataService.getQuote(symbol),
                DataService.getChart(symbol, this.currentInterval),
            ]);

            // Update header info
            this._setText('symbolFullName', quote.name || symbol);
            this._setText('symbolExchange', quote.exchange || '');
            this.currentExchange = quote.exchange || 'JKT';

            // Update quote panel
            this.updateQuotePanel(quote);
            this._updateQuickMonitoringBar();

            // Auto-fill target price
            const poPrice = document.getElementById('poPrice');
            if (poPrice && quote.price) poPrice.value = quote.price;

            // Normalize chart data for signals
            const ohlcv = this._normalizeChartData(chartData);

            // Update signal panel
            this.updateSignalPanel(symbol, ohlcv, quote.price);

            // Fetch fundamental data
            this._loadFundamental(symbol, quote.price);

            // Fetch news
            DataService.getNews(symbol)
                .then(news => this.updateNewsPanel(news))
                .catch(() => this.updateNewsPanel([]));

            // Fetch sentiment data
            this._loadSentiment(symbol);

            // Update market status
            this._updateMarketStatus(this.currentExchange);

        } catch (err) {
            console.error('loadSymbol error:', err);
            this._showError(`Gagal memuat data untuk ${symbol}`);
        }
    }

    _updateQuickMonitoringBar() {
        const bar = document.getElementById('quickMonitoringBar');
        if (!bar) return;
        const sym = this.currentSymbol;
        const activeHoldings = window.JournalManager?.activeHoldings || JSON.parse(localStorage.getItem('stockpulse_active_holdings') || '{}');
        const pos = activeHoldings[sym];
        const price = this.watchlist?._priceCache?.[sym]?.price || '';

        if (pos && pos.qty > 0) {
            const lots = Math.floor(pos.qty / 100);
            bar.innerHTML = `
                <div class="monitoring-bar-content in-portfolio">
                    <div class="mon-status">
                        <span class="mon-pulse"></span>
                        <span class="mon-tag">POSISI AKTIF PORTOFOLIO:</span>
                        <strong class="mon-lots">${lots} Lot <small>(${pos.qty.toLocaleString('id-ID')} lbr)</small></strong>
                        <span class="mon-avg">Avg Beli: Rp ${pos.avgPrice?.toLocaleString('id-ID') || 0}</span>
                    </div>
                    <div class="mon-actions">
                        <button class="btn-mon-action btn-sell-eval" onclick="JournalManager.showAddTradeModal('${sym}', '${price || pos.avgPrice}', 'SELL', '${pos.qty}')">
                            Jual & Evaluasi P&L
                        </button>
                        <button class="btn-mon-action btn-add-buy" onclick="JournalManager.showAddTradeModal('${sym}', '${price || pos.avgPrice}', 'BUY')">
                            Beli Tambahan
                        </button>
                        <button class="btn-mon-action btn-to-journal" onclick="window.app?._switchTab('journal')">
                            Buka Jurnal & Evaluasi
                        </button>
                    </div>
                </div>
            `;
            bar.style.display = 'block';
        } else {
            bar.innerHTML = `
                <div class="monitoring-bar-content no-portfolio">
                    <div class="mon-status">
                        <span class="mon-tag-grey">Saham Ini Belum Ada di Portofolio Anda</span>
                    </div>
                    <div class="mon-actions">
                        <button class="btn-mon-action btn-add-buy-neon" onclick="JournalManager.showAddTradeModal('${sym}', '${price}', 'BUY')">
                            Catat Pembelian di Jurnal
                        </button>
                    </div>
                </div>
            `;
            bar.style.display = 'block';
        }
    }

    /* ---- Fundamental Data Loading ---- */

    async _loadFundamental(symbol, currentPrice) {
        try {
            const data = await DataService.getFundamental(symbol);
            this._lastFundamentalData = data;

            // Check if this is real fundamental data or just chart_fallback
            const isChartFallback = data?._source === 'chart_fallback';
            const hasNoFundData = data?._hasData === false;

            if (isChartFallback || hasNoFundData) {
                // Chart fallback = no real fundamental data
                this._lastFundamentalScore = null;
                this._lastFundamentalHasData = false;
                const grid = document.getElementById('fundamentalMetricsGrid');
                if (grid) {
                    grid.innerHTML = `
                        <div class="empty-state" style="grid-column: 1 / -1;">
                            <span class="empty-state-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path></svg></span>
                            <span class="empty-state-title">Data fundamental tidak tersedia</span>
                            <span class="empty-state-text">Yahoo Finance tidak menyediakan data fundamental untuk simbol ini. Analisis hanya menggunakan teknikal.</span>
                        </div>
                    `;
                }
                // Update rating badge to N/A
                const ratingBadge = document.getElementById('fundamentalRatingBadge');
                const ratingText = document.getElementById('fundamentalRatingText');
                const scoreValue = document.getElementById('fundamentalScoreValue');
                if (ratingBadge) ratingBadge.className = 'fundamental-rating-badge n-a';
                if (ratingText) ratingText.textContent = '— Tidak tersedia';
                if (scoreValue) scoreValue.textContent = '—';
            } else {
                const result = FundamentalAnalysis.analyze(data);
                this._lastFundamentalScore = result.score; // can be null if < 3 metrics
                this._lastFundamentalHasData = result.hasRealData;
                this.updateFundamentalPanel(result, data);
            }
            this._updateCombinedScore();
        } catch (err) {
            console.warn('Fundamental data load failed:', err.message);
            // Show fallback state
            const grid = document.getElementById('fundamentalMetricsGrid');
            if (grid) {
                grid.innerHTML = `
                    <div class="empty-state" style="grid-column: 1 / -1;">
                        <span class="empty-state-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path></svg></span>
                        <span class="empty-state-title">Data fundamental tidak tersedia</span>
                        <span class="empty-state-text">Gagal mengambil data dari server</span>
                    </div>
                `;
            }
            this._lastFundamentalScore = null;
            this._lastFundamentalHasData = false;
            this._updateCombinedScore();
        }
    }

    async _loadSentiment(symbol) {
        try {
            const data = await DataService.getSentiment(symbol);
            const result = SentimentAnalysis.processData(data);
            // result.score is now null when no articles are available
            this._lastSentimentScore = result.score;
            this.updateSentimentPanel(result);
            this._updateCombinedScore();
        } catch (err) {
            console.warn('Sentiment load failed:', err.message);
            this._lastSentimentScore = null;
            this.updateSentimentPanel(SentimentAnalysis.processData(null));
            this._updateCombinedScore();
        }
    }

    /* ---- Market Status ---- */

    async _updateMarketStatus(exchange) {
        try {
            const status = await DataService.getMarketStatus(exchange);

            const badge = document.getElementById('marketStatusBadge');
            const dot = document.getElementById('marketStatusDot');
            const text = document.getElementById('marketStatusText');

            if (badge) {
                badge.className = 'market-status-badge ' + status.state.toLowerCase().replace('_', '-');
                badge.title = `${status.name} — ${status.tradingHours}`;
            }
            if (text) {
                text.textContent = status.state === 'OPEN' ? '• BUKA' :
                    status.state === 'PRE_MARKET' ? '• PRE' : '• TUTUP';
            }

            // Update night banner
            const banner = document.getElementById('preorderNightBanner');
            const bannerDesc = document.getElementById('nightBannerDesc');
            const bannerTime = document.getElementById('nightBannerTime');

            if (banner) {
                if (status.isPreOrderMode) {
                    banner.style.display = 'flex';
                    if (bannerDesc) bannerDesc.textContent = status.label + (status.nextOpen ? ` — ${status.nextOpen}` : '');
                    if (bannerTime) bannerTime.textContent = status.localTime;
                } else {
                    banner.style.display = 'none';
                }
            }

            // Update pre-order statuses
            PreOrderManager.updateMarketState(status.state);

            // Adaptive polling: restart with new interval if market state changed
            const newState = status.state || 'CLOSED';
            if (newState !== this._currentMarketState) {
                console.log(`[Market] State changed: ${this._currentMarketState} → ${newState}`);
                this._currentMarketState = newState;
                this.startPolling(); // Restart with appropriate interval
            }
        } catch (err) {
            console.warn('Market status update failed:', err.message);
        }
    }

    _startMarketStatusPolling() {
        // Check market status every 30 seconds
        this._updateMarketStatus(this.currentExchange);
        this.marketStatusInterval = setInterval(() => {
            this._updateMarketStatus(this.currentExchange);
        }, 30000);
    }

    /* ---- Polling (current symbol) — Adaptive based on market state ---- */

    startPolling() {
        this.stopPolling();
        const intervalMs = this._currentMarketState === 'OPEN'
            ? this.POLL_INTERVAL_OPEN_MS
            : this.POLL_INTERVAL_CLOSED_MS;

        console.log(`[Polling] Interval: ${intervalMs / 1000}s (market: ${this._currentMarketState})`);

        this.pollingInterval = setInterval(async () => {
            try {
                const quote = await DataService.getQuote(this.currentSymbol);
                this.updateQuotePanel(quote);

                // Real-time chart update
                this.tvChart.updateRealtime(quote);

                const statusEl = document.getElementById('connectionStatus');
                if (statusEl) statusEl.classList.add('connected');
            } catch (_) {
                const statusEl = document.getElementById('connectionStatus');
                if (statusEl) statusEl.classList.remove('connected');
            }
        }, intervalMs);
    }

    stopPolling() {
        if (this.pollingInterval) {
            clearInterval(this.pollingInterval);
            this.pollingInterval = null;
        }
    }

    /* ---- Watchlist Signal Scanning ---- */

    startWatchlistScan() {
        if (this.scanInterval) clearInterval(this.scanInterval);

        // Run initial scan after 5 seconds
        setTimeout(() => this._scanWatchlist(), 5000);

        // Then scan every 60 seconds
        this.scanInterval = setInterval(() => this._scanWatchlist(), this.SCAN_INTERVAL_MS);
    }

    async _scanWatchlist() {
        console.log('[Scanner] Scanning watchlist for signals...');
        const symbols = this.watchlist.symbols;

        for (const symbol of symbols) {
            try {
                const [quote, chartData] = await Promise.all([
                    DataService.getQuote(symbol),
                    DataService.getChart(symbol, '1d'),
                ]);

                const ohlcv = this._normalizeChartData(chartData);
                if (ohlcv.length < 30) continue;

                const signalResult = SignalEngine.analyze(ohlcv);
                const price = quote.price ?? 0;

                // Check if notification should be sent
                this.notifications.checkAndNotify(symbol, signalResult, price);

                console.log(`[Scanner] ${symbol}: ${signalResult.overall} (score: ${signalResult.score})`);

                // Increased delay between symbols to avoid rate limits (2 seconds instead of 500ms)
                await new Promise(r => setTimeout(r, 2000));
            } catch (err) {
                console.warn(`[Scanner] Failed to scan ${symbol}:`, err.message);
            }
        }

        // Also update watchlist prices
        this.watchlist.updatePrices();
    }

    /* ---- UI Updates ---- */

    updateQuotePanel(quote) {
        const price = quote.price ?? quote.regularMarketPrice ?? 0;
        const change = quote.change ?? quote.regularMarketChange ?? 0;
        const changePct = quote.changePercent ?? quote.regularMarketChangePercent ?? 0;
        const isPositive = change >= 0;
        const isIDR = this.currentSymbol.endsWith('.JK');

        const fmt = (v, dec = 2) => {
            if (v == null || isNaN(v)) return '—';
            if (isIDR) return new Intl.NumberFormat('id-ID', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(v);
            return new Intl.NumberFormat('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(v);
        };

        this._setText('currentPrice', fmt(price));
        const changeText = `${isPositive ? '+' : ''}${fmt(change)} (${isPositive ? '+' : ''}${changePct.toFixed(2)}%)`;
        this._setText('priceChange', changeText);

        const changeEl = document.getElementById('priceChange');
        if (changeEl) changeEl.className = `price-change ${isPositive ? 'positive' : 'negative'}`;

        this._setText('statOpen', fmt(quote.open ?? 0));
        this._setText('statHigh', fmt(quote.dayHigh ?? 0));
        this._setText('statLow', fmt(quote.dayLow ?? 0));
        this._setText('statPrevClose', fmt(quote.previousClose ?? 0));
        this._setText('statVolume', this._formatVolume(quote.volume ?? 0));
        this._setText('statMarketCap', this._formatLargeNumber(quote.marketCap ?? 0));
        this._setText('stat52wHigh', fmt(quote.fiftyTwoWeekHigh ?? 0));
        this._setText('stat52wLow', fmt(quote.fiftyTwoWeekLow ?? 0));
        if (typeof window.OrderbookManager !== 'undefined') {
            window.OrderbookManager.update(this.currentSymbol, price, quote.volume ?? 0);
        }
        if (typeof window.PortfolioManager !== 'undefined') {
            window.PortfolioManager.updateCurrentStock(this.currentSymbol, price);
        }
    }

    updateSignalPanel(symbol, data, price) {
        if (!data || data.length < 30) return;
        const result = SignalEngine.analyze(data);

        // Sync with official recommendation pick score if symbol is currently recommended
        const recPick = typeof StockRecommendation !== 'undefined' ? StockRecommendation.getRecommendationForSymbol(symbol) : null;
        this._lastTechnicalScore = recPick && typeof recPick.score === 'number' ? recPick.score : result.score;
        const displaySignal = recPick && recPick.signal ? recPick.signal : result.overall;

        const badgeEl = document.getElementById('signalBadge');
        if (badgeEl) {
            badgeEl.textContent = displaySignal.replace(/_/g, ' ');
            badgeEl.className = `signal-badge signal-${displaySignal.toLowerCase()}`;
        }

        const needleEl = document.getElementById('signalGaugeNeedle');
        if (needleEl) {
            const pct = Math.max(0, Math.min(100, this._lastTechnicalScore));
            needleEl.style.left = `${pct}%`;
        }

        const signalMap = {};
        result.signals.forEach(s => {
            const key = s.name.toLowerCase();
            if (key.includes('sma 20') || key.includes('sma 50') || key.includes('sma 200')) {
                // Use the shortest SMA for the summary display
                if (!signalMap.sma || key.includes('sma 50')) signalMap.sma = s;
            }
            if (key.includes('ema')) signalMap.ema = s;
            if (key.includes('rsi')) signalMap.rsi = s;
            if (key.includes('macd')) signalMap.macd = s;
            if (key.includes('bollinger') || key.includes('bb')) signalMap.bb = s;
            if (key.includes('stochastic') || key.includes('stoch')) signalMap.stoch = s;
            if (key.includes('adx')) signalMap.adx = s;
            if (key.includes('volume')) signalMap.vol = s;
            if (key.includes('cross 50')) signalMap.cross = s;
        });

        // Update existing indicator slots
        ['sma', 'ema', 'rsi', 'macd', 'bb'].forEach(key => {
            const el = document.getElementById(`signal${key.charAt(0).toUpperCase() + key.slice(1)}`);
            if (el && signalMap[key]) {
                el.textContent = signalMap[key].signal;
                el.className = `signal-detail-value ${signalMap[key].signal.toLowerCase()}`;
                el.title = signalMap[key].description || '';
            }
        });

        // Update new indicator slots if they exist in DOM
        const newIndicators = { stoch: 'signalStoch', adx: 'signalAdx', vol: 'signalVol', cross: 'signalCross' };
        Object.entries(newIndicators).forEach(([key, elId]) => {
            const el = document.getElementById(elId);
            if (el && signalMap[key]) {
                el.textContent = signalMap[key].signal;
                el.className = `signal-detail-value ${signalMap[key].signal.toLowerCase()}`;
                el.title = signalMap[key].description || '';
            }
        });

        // Update trend strength badge if it exists
        const trendEl = document.getElementById('trendStrengthBadge');
        if (trendEl && result.trendStrength) {
            const trendLabels = {
                'VERY_STRONG': 'Sangat Kuat',
                'STRONG': 'Kuat',
                'MODERATE': 'Moderat',
                'WEAK': 'Lemah/Sideways',
                'UNKNOWN': '— N/A'
            };
            trendEl.textContent = trendLabels[result.trendStrength] || result.trendStrength;
        }

        // ── Update Profit Estimation Panel ──
        const pe = result.profitEstimation;
        if (pe) {
            const isIDR = symbol.endsWith('.JK');
            const fmtP = (v) => {
                if (v == null || isNaN(v)) return '—';
                if (isIDR) return new Intl.NumberFormat('id-ID').format(Math.round(v));
                return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
            };

            this._setText('peTimeEstimate', pe.timeEstimateLabel || '—');
            this._setText('peProfitPercent', `+${pe.profitPercent || 0}%`);
            this._setText('peLossPercent', `-${pe.lossPercent || 0}%`);
            this._setText('peRRR', `1:${pe.riskRewardRatio || 0}`);
            this._setText('peWinProb', `${pe.winProbability || 0}%`);
            this._setText('peProfitPerDay', `+${pe.profitPerDay || 0}%`);
            this._setText('peATRPercent', `${pe.atrPercent || 0}%`);
            this._setText('peStopLoss', fmtP(result.atrStopLoss));
            this._setText('peTakeProfit', fmtP(result.atrTakeProfit));

            // Win prob bar fill
            const wpFill = document.getElementById('peWinProbFill');
            if (wpFill) {
                wpFill.style.width = `${Math.min(100, pe.winProbability || 0)}%`;
                if (pe.winProbability >= 65) wpFill.className = 'pe-bar-fill wp-high';
                else if (pe.winProbability >= 50) wpFill.className = 'pe-bar-fill wp-medium';
                else wpFill.className = 'pe-bar-fill wp-low';
            }

            // Confidence badge
            const confEl = document.getElementById('peConfidence');
            if (confEl) {
                confEl.textContent = pe.confidenceLevel || 'N/A';
                confEl.className = `pe-confidence-badge ${pe.confidenceLevel === 'HIGH' ? 'conf-high' : pe.confidenceLevel === 'MEDIUM' ? 'conf-medium' : 'conf-low'}`;
            }

            // Show the panel
            const pePanel = document.getElementById('profitEstimationPanel');
            if (pePanel) pePanel.style.display = 'block';
        }

        // ── Update Fibonacci Levels ──
        const fib = result.fibonacci;
        if (fib) {
            this._setText('fibLevel0', fmtP(fib.level0));
            this._setText('fibLevel236', fmtP(fib.level236));
            this._setText('fibLevel382', fmtP(fib.level382));
            this._setText('fibLevel500', fmtP(fib.level500));
            this._setText('fibLevel618', fmtP(fib.level618));
            this._setText('fibLevel786', fmtP(fib.level786));
            this._setText('fibLevel1', fmtP(fib.level1));

            const fibPanel = document.getElementById('fibonacciPanel');
            if (fibPanel) fibPanel.style.display = 'block';
        }

        // Formatter for Fibonacci
        function fmtP(v) {
            if (v == null || isNaN(v)) return '—';
            if (symbol.endsWith('.JK')) return new Intl.NumberFormat('id-ID').format(Math.round(v));
            return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
        }

        // Update combined score
        this._updateCombinedScore();

        // Check for notifications (on current symbol analysis)
        this.notifications.checkAndNotify(symbol, result, price);
    }

    updateFundamentalPanel(result, rawData) {
        // Update rating badge
        const ratingBadge = document.getElementById('fundamentalRatingBadge');
        const ratingText = document.getElementById('fundamentalRatingText');
        const scoreValue = document.getElementById('fundamentalScoreValue');

        if (ratingBadge) {
            ratingBadge.className = `fundamental-rating-badge ${result.grade.toLowerCase()}`;
        }
        if (ratingText) {
            const gradeLabels = {
                'EXCELLENT': 'Excellent',
                'GOOD': 'Good',
                'FAIR': 'Fair',
                'POOR': 'Poor',
                'VERY_POOR': 'Very Poor',
                'N/A': '— N/A',
            };
            ratingText.textContent = gradeLabels[result.grade] || result.grade;
        }
        if (scoreValue) {
            scoreValue.textContent = result.score + '/100';
        }

        // Render metrics grid
        const grid = document.getElementById('fundamentalMetricsGrid');
        if (grid && result.metrics.length > 0) {
            grid.innerHTML = result.metrics.map(m => {
                const colorClass = FundamentalAnalysis.getRatingClass(m.rating);
                return `
                    <div class="metric-card ${colorClass}" title="${m.description}">
                        <div class="metric-name">${m.name}</div>
                        <div class="metric-value">${m.displayValue}</div>
                        <span class="metric-rating ${colorClass}">${m.rating}</span>
                        <div class="metric-desc">${m.description}</div>
                    </div>
                `;
            }).join('');
        } else if (grid && result.metrics.length === 0) {
            grid.innerHTML = `
                <div class="empty-state" style="grid-column: 1 / -1;">
                    <span class="empty-state-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path></svg></span>
                    <span class="empty-state-title">Data fundamental terbatas</span>
                    <span class="empty-state-text">Beberapa metrik mungkin tidak tersedia untuk simbol ini</span>
                </div>
            `;
        }

        // Recommendation
        const recContainer = document.getElementById('fundamentalRecommendation');
        const recText = document.getElementById('fundamentalRecText');
        if (recContainer && recText && result.recommendation) {
            recContainer.style.display = 'block';
            recText.textContent = result.recommendation;
        }
    }

    _updateCombinedScore() {
        const techScore = this._lastTechnicalScore;
        const fundScore = this._lastFundamentalScore;  // null if not available
        const sentScore = this._lastSentimentScore;    // null if not available

        const scoreEl = document.getElementById('combinedScoreValue');
        const fillEl = document.getElementById('combinedGaugeFill');
        const badgeEl = document.getElementById('combinedSignalBadge');
        const subTech = document.getElementById('subScoreTechnical');
        const subFund = document.getElementById('subScoreFundamental');
        const subSent = document.getElementById('subScoreSentiment');

        // Show sub-scores with availability indicator
        if (subTech) subTech.textContent = `T: ${techScore != null ? techScore : '—'}`;
        if (subFund) {
            if (fundScore != null) {
                subFund.textContent = `F: ${fundScore}`;
                subFund.style.opacity = '1';
            } else {
                subFund.textContent = `F: —`;
                subFund.style.opacity = '0.4';
            }
        }
        if (subSent) {
            if (sentScore != null) {
                subSent.textContent = `S: ${sentScore}`;
                subSent.style.opacity = '1';
            } else {
                subSent.textContent = `S: —`;
                subSent.style.opacity = '0.4';
            }
        }

        if (techScore == null) return; // Need at least technical

        // Use the unified getCombinedScore — it handles null fund/sent internally
        const combined = FundamentalAnalysis.getCombinedScore(techScore, fundScore, sentScore);

        if (scoreEl) scoreEl.textContent = combined.combinedScore;
        if (fillEl) {
            fillEl.style.width = `${combined.combinedScore}%`;
            // Color the gauge based on score
            if (combined.combinedScore >= 65) fillEl.style.background = 'linear-gradient(90deg, #10b981, #34d399)';
            else if (combined.combinedScore >= 45) fillEl.style.background = 'linear-gradient(90deg, #f59e0b, #fbbf24)';
            else fillEl.style.background = 'linear-gradient(90deg, #ef4444, #f87171)';
        }
        if (badgeEl) {
            badgeEl.textContent = combined.sourceLabel + ' — ' + combined.label;
            badgeEl.className = `combined-signal-badge ${combined.signal.toLowerCase()}`;
            badgeEl.title = `Sumber data: ${combined.dataSources.join(', ')}`;
        }
    }

    updateNewsPanel(news) {
        const container = document.getElementById('newsFeed');
        if (!container) return;

        if (!news || news.length === 0) {
            container.innerHTML = '<p class="no-data">Tidak ada berita terbaru.</p>';
            return;
        }

        const items = Array.isArray(news) ? news : (news.items ?? news.news ?? []);

        container.innerHTML = items.slice(0, 10).map(item => {
            const timeAgo = this._timeAgo(item.publishedAt ?? item.providerPublishTime ?? item.date);
            const thumbnail = item.thumbnail?.resolutions?.[0]?.url ?? item.thumbnail ?? '';
            const thumbHTML = thumbnail
                ? `<img class="news-thumb" src="${thumbnail}" alt="" loading="lazy">`
                : '';
            return `
                <a class="news-item" href="${item.link ?? item.url ?? '#'}" target="_blank" rel="noopener">
                    ${thumbHTML}
                    <div class="news-body">
                        <h4 class="news-title">${item.title ?? ''}</h4>
                        <span class="news-meta">${item.publisher ?? item.source ?? ''} · ${timeAgo}</span>
                    </div>
                </a>
            `;
        }).join('');
    }

    updateSentimentPanel(result) {
        const container = document.getElementById('sentimentArticlesList');
        const badge = document.getElementById('sentimentOverallBadge');
        const methodBadge = document.getElementById('sentimentMethodBadge');
        const scoreVal = document.getElementById('sentimentScoreValue');
        const gaugeFill = document.getElementById('sentimentGaugeFill');

        if (badge) {
            badge.textContent = result.label;
            badge.className = `sentiment-overall-badge ${SentimentAnalysis.getSentimentClass(result.overall)}`;
        }
        if (methodBadge) methodBadge.textContent = result.methodLabel;
        if (scoreVal) scoreVal.textContent = result.score != null ? result.score : '—';
        if (gaugeFill) gaugeFill.style.width = result.score != null ? `${result.score}%` : '0%';

        if (!container) return;

        if (result.isEmpty) {
            container.innerHTML = `
                <div class="empty-state">
                    <span class="empty-state-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg></span>
                    <span class="empty-state-title">Data sentimen tidak tersedia</span>
                    <span class="empty-state-text">Tidak ada berita terbaru untuk dianalisis</span>
                </div>
            `;
            return;
        }

        container.innerHTML = result.articles.map(article => `
            <a class="sentiment-article-card" href="${article.link || '#'}" target="_blank" rel="noopener">
                <div class="sentiment-article-info">
                    <div class="sentiment-article-title" title="${article.title}">${article.title}</div>
                    <div class="sentiment-article-meta">${article.publisher || 'Berita'} · ${this._timeAgo(article.publishedAt)}</div>
                </div>
                <div class="sentiment-article-badge">
                    <span class="news-sentiment-badge ${article.labelClass}">${article.labelText}</span>
                </div>
            </a>
        `).join('');
    }

    /* ---- Tab Navigation ---- */

    _setupTabs() {
        const tabs = document.querySelectorAll('.panel-tab');
        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const target = tab.dataset.tab;
                this._switchTab(target);
            });
        });
    }

    _switchTab(tabName) {
        // Deactivate all tabs
        document.querySelectorAll('.panel-tab').forEach(t => {
            t.classList.remove('active');
            t.setAttribute('aria-selected', 'false');
        });
        document.querySelectorAll('.tab-panel').forEach(p => {
            p.classList.remove('active');
        });

        // Activate selected
        const tab = document.querySelector(`.panel-tab[data-tab="${tabName}"]`);
        const panel = document.querySelector(`.tab-panel[data-panel="${tabName}"]`);
        if (tab) {
            tab.classList.add('active');
            tab.setAttribute('aria-selected', 'true');
        }
        if (panel) {
            panel.classList.add('active');
        }

        // Lazy-load recommendation data when tab is first opened
        if (tabName === 'recommendation' && !this._recLoaded) {
            this._recLoaded = true;
            StockRecommendation.loadToday();
            StockRecommendation.loadTomorrow();
            StockRecommendation.startAutoRefresh();
        }

        // Load trading journal & evaluation when journal tab is selected
        if (tabName === 'journal' && typeof window.JournalManager !== 'undefined') {
            window.JournalManager.loadAndRenderJournal();
        }
        if (tabName === 'orderbook' && typeof window.OrderbookManager !== 'undefined') {
            window.OrderbookManager.render();
        }
        if (tabName === 'portfolio' && typeof window.PortfolioManager !== 'undefined') {
            window.PortfolioManager.render();
        }
    }

    /* ---- Pre-Order Form ---- */

    _setupPreOrderForm() {
        // Type toggle (BUY/SELL)
        const buyBtn = document.getElementById('poBuyBtn');
        const sellBtn = document.getElementById('poSellBtn');

        if (buyBtn && sellBtn) {
            buyBtn.addEventListener('click', () => {
                this._currentOrderType = 'BUY';
                buyBtn.classList.add('active');
                sellBtn.classList.remove('active');
            });
            sellBtn.addEventListener('click', () => {
                this._currentOrderType = 'SELL';
                sellBtn.classList.add('active');
                buyBtn.classList.remove('active');
            });
        }

        // Calculate total on input change
        const priceInput = document.getElementById('poPrice');
        const qtyInput = document.getElementById('poQty');

        const updateTotal = () => {
            const price = parseFloat(priceInput?.value) || 0;
            const qty = parseInt(qtyInput?.value) || 0;
            const symbol = document.getElementById('poSymbol')?.value || '';
            const isIDR = symbol.toUpperCase().endsWith('.JK');
            const lotSize = isIDR ? 100 : 1;
            const total = price * qty * lotSize;
            const totalEl = document.getElementById('preorderTotalValue');
            if (totalEl) {
                totalEl.textContent = isIDR
                    ? `Rp ${new Intl.NumberFormat('id-ID').format(total)}`
                    : `$${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(total)}`;
            }
        };

        if (priceInput) priceInput.addEventListener('input', updateTotal);
        if (qtyInput) qtyInput.addEventListener('input', updateTotal);

        // Submit order
        const submitBtn = document.getElementById('poSubmitBtn');
        if (submitBtn) {
            submitBtn.addEventListener('click', () => {
                try {
                    const order = PreOrderManager.createOrder({
                        symbol: document.getElementById('poSymbol')?.value || '',
                        type: this._currentOrderType,
                        targetPrice: document.getElementById('poPrice')?.value || 0,
                        quantity: document.getElementById('poQty')?.value || 0,
                        stopLoss: document.getElementById('poStopLoss')?.value || null,
                        takeProfitPrice: document.getElementById('poTakeProfit')?.value || null,
                        notes: document.getElementById('poNotes')?.value || '',
                    });

                    // Clear form (except symbol and price)
                    const qtyEl = document.getElementById('poQty');
                    const slEl = document.getElementById('poStopLoss');
                    const tpEl = document.getElementById('poTakeProfit');
                    const notesEl = document.getElementById('poNotes');
                    if (qtyEl) qtyEl.value = '';
                    if (slEl) slEl.value = '';
                    if (tpEl) tpEl.value = '';
                    if (notesEl) notesEl.value = '';

                    this._updatePreOrderBadge();

                    // Show success toast
                    this.notifications._showToast({
                        symbol: order.symbol,
                        signal: order.type === 'BUY' ? 'BUY' : 'SELL',
                        score: 0,
                        price: order.targetPrice,
                        signals: [],
                    });
                } catch (err) {
                    alert(err.message);
                }
            });
        }

        // Export button
        const exportBtn = document.getElementById('poExportBtn');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => {
                PreOrderManager.downloadCSV();
            });
        }

        // Clear executed button
        const clearBtn = document.getElementById('poClearExecutedBtn');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                const orders = PreOrderManager.getAllOrders();
                orders.filter(o => o.status === 'EXECUTED' || o.status === 'CANCELLED' || o.status === 'EXPIRED')
                    .forEach(o => PreOrderManager.deleteOrder(o.id));
                this._updatePreOrderBadge();
            });
        }
    }

    _renderPreOrders(orders) {
        const container = document.getElementById('preorderList');
        const emptyState = document.getElementById('preorderEmptyState');
        if (!container) return;

        if (!orders || orders.length === 0) {
            container.innerHTML = `
                <div class="empty-state" id="preorderEmptyState">
                    <span class="empty-state-icon">🛒</span>
                    <span class="empty-state-title">Belum ada pre-order</span>
                    <span class="empty-state-text">Buat pre-order di atas untuk mempersiapkan transaksi</span>
                </div>
            `;
            return;
        }

        const isIDR = (sym) => sym && sym.toUpperCase().endsWith('.JK');

        container.innerHTML = orders.map(order => {
            const statusCfg = PreOrderManager.getStatusConfig(order.status);
            const idr = isIDR(order.symbol);
            const lotSize = idr ? 100 : 1;
            const total = order.targetPrice * order.quantity * lotSize;
            const totalStr = idr
                ? `Rp ${new Intl.NumberFormat('id-ID').format(total)}`
                : `$${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(total)}`;

            const priceStr = idr
                ? new Intl.NumberFormat('id-ID').format(order.targetPrice)
                : new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(order.targetPrice);

            const detailsParts = [];
            detailsParts.push(`${order.quantity} lot`);
            if (order.stopLoss) detailsParts.push(`SL: ${order.stopLoss}`);
            if (order.takeProfitPrice) detailsParts.push(`TP: ${order.takeProfitPrice}`);

            const canAct = order.status === 'PENDING' || order.status === 'READY';

            return `
                <div class="order-card ${order.type.toLowerCase()}-order" data-order-id="${order.id}">
                    <span class="order-type-badge ${order.type.toLowerCase()}">${order.type}</span>
                    <div class="order-info">
                        <span class="order-symbol">${order.symbol}</span>
                        <span class="order-details">${detailsParts.join(' · ')}</span>
                        ${order.notes ? `<span class="order-notes">${order.notes}</span>` : ''}
                    </div>
                    <div class="order-price-info">
                        <div class="order-target-price">${priceStr}</div>
                        <div class="order-total">${totalStr}</div>
                    </div>
                    <div class="order-status">
                        <span class="order-status-badge ${statusCfg.class}">${statusCfg.icon} ${statusCfg.label}</span>
                    </div>
                    <div class="order-actions">
                        ${canAct ? `
                            <button class="order-action-btn execute" title="Tandai Tereksekusi" data-action="execute" data-id="${order.id}">Eksekusi</button>
                            <button class="order-action-btn delete" title="Batalkan" data-action="cancel" data-id="${order.id}">Batal</button>
                        ` : `
                            <button class="order-action-btn delete" title="Hapus" data-action="delete" data-id="${order.id}">Hapus</button>
                        `}
                    </div>
                </div>
            `;
        }).join('');

        // Bind action buttons
        container.querySelectorAll('.order-action-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = btn.dataset.action;
                const id = btn.dataset.id;

                if (action === 'execute') {
                    PreOrderManager.markExecuted(id);
                } else if (action === 'cancel') {
                    PreOrderManager.cancelOrder(id);
                } else if (action === 'delete') {
                    PreOrderManager.deleteOrder(id);
                }
                this._updatePreOrderBadge();
            });
        });

        // Click order card to load that symbol
        container.querySelectorAll('.order-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (e.target.closest('.order-action-btn')) return;
                const orderId = card.dataset.orderId;
                const order = PreOrderManager.getAllOrders().find(o => o.id === orderId);
                if (order) this.loadSymbol(order.symbol);
            });
        });
    }

    _updatePreOrderBadge() {
        const count = PreOrderManager.getActiveCount();
        const badge1 = document.getElementById('preorderCountBadge');
        const badge2 = document.getElementById('tabPreorderBadge');

        if (badge1) {
            badge1.textContent = count;
            badge1.style.display = count > 0 ? 'flex' : 'none';
        }
        if (badge2) {
            badge2.textContent = count;
            badge2.style.display = count > 0 ? 'flex' : 'none';
        }
    }

    /* ---- Search ---- */

    _setupSearch() {
        const input = document.getElementById('searchInput');
        const dropdown = document.getElementById('searchResults');
        if (!input || !dropdown) return;

        const hideDropdown = () => {
            dropdown.classList.remove('visible');
            dropdown.classList.remove('active');
        };

        const showDropdown = () => {
            dropdown.classList.add('visible');
            dropdown.classList.add('active');
        };

        input.addEventListener('input', () => {
            clearTimeout(this._searchTimeout);
            const q = input.value.trim();
            if (q.length < 1) {
                hideDropdown();
                return;
            }
            this._searchTimeout = setTimeout(async () => {
                try {
                    const results = await DataService.searchSymbol(q);
                    this._renderSearchResults(results, dropdown, showDropdown, hideDropdown);
                } catch (_) {
                    hideDropdown();
                }
            }, 300);
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const q = input.value.trim().toUpperCase();
                if (q) {
                    this.loadSymbol(q);
                    hideDropdown();
                    input.blur();
                }
            }
            if (e.key === 'Escape') {
                hideDropdown();
                input.blur();
            }
        });

        // Close dropdown on outside click
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.search-container')) {
                hideDropdown();
            }
        });
    }

    _renderSearchResults(results, dropdown, showDropdown, hideDropdown) {
        const items = Array.isArray(results) ? results : (results.quotes ?? results.results ?? []);
        if (!items.length) {
            if (hideDropdown) hideDropdown();
            return;
        }
        dropdown.innerHTML = items.slice(0, 8).map(r => {
            const sym = r.symbol ?? r.ticker ?? '';
            const name = r.shortname ?? r.longname ?? r.name ?? '';
            const exchange = r.exchange ?? r.exchDisp ?? '';
            return `
                <div class="search-result-item" data-symbol="${sym}">
                    <span class="search-result-symbol result-symbol">${sym}</span>
                    <span class="search-result-name result-name">${name}</span>
                    <span class="search-result-exchange result-exchange">${exchange}</span>
                </div>
            `;
        }).join('');

        if (showDropdown) showDropdown();

        dropdown.querySelectorAll('.search-result-item').forEach(el => {
            el.addEventListener('click', () => {
                const sym = el.dataset.symbol;
                this.loadSymbol(sym);
                if (hideDropdown) hideDropdown();
                document.getElementById('searchInput').value = '';
            });
        });
    }

    /* ---- Timeframe buttons ---- */

    _setupTimeframeButtons() {
        const btns = document.querySelectorAll('[data-interval]');
        btns.forEach(btn => {
            btn.addEventListener('click', () => {
                btns.forEach(b => { b.classList.remove('active'); b.setAttribute('aria-pressed', 'false'); });
                btn.classList.add('active');
                btn.setAttribute('aria-pressed', 'true');
                this.currentInterval = btn.dataset.interval;
                // Update TradingView chart interval
                this.tvChart.changeInterval(this.currentInterval);
                // Reload signal data
                this.loadSymbol(this.currentSymbol);
            });
        });
    }

    /* ---- Keyboard shortcuts ---- */

    _setupKeyboard() {
        document.addEventListener('keydown', (e) => {
            // Don't intercept when typing in input
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            if (e.key === '/') {
                e.preventDefault();
                const input = document.getElementById('searchInput');
                if (input) input.focus();
            }
            if (e.key === 'Escape') {
                const dropdown = document.getElementById('searchResults');
                if (dropdown) dropdown.classList.remove('visible');
            }
        });
    }

    /* ---- Data normalisation ---- */

    _normalizeChartData(raw) {
        // Accept array directly or nested structure
        let arr = [];
        if (Array.isArray(raw)) {
            arr = raw;
        } else if (raw.data && Array.isArray(raw.data)) {
            arr = raw.data;
        } else if (raw.chart?.result?.[0]) {
            // Yahoo-style nested response
            const r = raw.chart.result[0];
            const ts = r.timestamp ?? [];
            const q = r.indicators?.quote?.[0] ?? {};
            arr = ts.map((t, i) => ({
                time: t,
                open: q.open?.[i] ?? 0,
                high: q.high?.[i] ?? 0,
                low: q.low?.[i] ?? 0,
                close: q.close?.[i] ?? 0,
                volume: q.volume?.[i] ?? 0,
            }));
        }

        // Ensure time is in the right format & filter out invalid entries
        return arr
            .filter(d => d && d.close != null && d.close !== 0)
            .map(d => ({
                time: typeof d.time === 'number' && d.time > 1e12
                    ? Math.floor(d.time / 1000) // ms → s
                    : d.time,
                open: Number(d.open),
                high: Number(d.high),
                low: Number(d.low),
                close: Number(d.close),
                volume: Number(d.volume ?? 0),
            }))
            .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
    }

    /* ---- Helpers ---- */

    _setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    _formatVolume(v) {
        if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
        if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
        if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
        return String(v);
    }

    _formatLargeNumber(v) {
        if (!v) return '—';
        if (v >= 1e12) return (v / 1e12).toFixed(2) + 'T';
        if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
        if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
        return new Intl.NumberFormat('en-US').format(v);
    }

    _timeAgo(dateInput) {
        if (!dateInput) return '';
        const date = typeof dateInput === 'number'
            ? new Date(dateInput > 1e12 ? dateInput : dateInput * 1000)
            : new Date(dateInput);

        const now = Date.now();
        const diffMs = now - date.getTime();
        const diffSec = Math.floor(diffMs / 1000);
        const diffMin = Math.floor(diffSec / 60);
        const diffHour = Math.floor(diffMin / 60);
        const diffDay = Math.floor(diffHour / 24);

        if (diffSec < 60) return 'baru saja';
        if (diffMin < 60) return `${diffMin} menit lalu`;
        if (diffHour < 24) return `${diffHour} jam lalu`;
        if (diffDay < 7) return `${diffDay} hari lalu`;
        return date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    _showError(msg) {
        // Try to show a toast / inline message
        const toast = document.getElementById('errorToast');
        if (toast) {
            toast.textContent = msg;
            toast.classList.add('visible');
            setTimeout(() => toast.classList.remove('visible'), 4000);
        } else {
            console.error(msg);
        }
    }
}

/* ======================================================================
   Bootstrap
   ====================================================================== */

document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init().catch(err => console.error('App init failed:', err));
    window.__app = app;
});
