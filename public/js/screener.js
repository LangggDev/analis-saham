/**
 * Stock Screener Module
 * Provides Stockbit-style stock screening with filter builder,
 * sortable table, batch scanning, and CSV export.
 * Depends on: DataService (app.js), FundamentalAnalysis (fundamental.js), SignalEngine (signals.js), Indicators (indicators.js)
 */

const StockScreener = {

    // ─── 11 Official IDX Sectors (Stockbit Category Classification) ───
    IDX_SECTORS: {
        'BASIC-IND': {
            name: 'Basic Materials',
            icon: '',
            symbols: [
                'BRPT.JK', 'TPIA.JK', 'INKP.JK', 'TKIM.JK', 'ANTM.JK', 'INCO.JK', 'MDKA.JK', 'NCKL.JK',
                'MBMA.JK', 'SMGR.JK', 'INTP.JK', 'AVIA.JK', 'TINS.JK', 'PSAB.JK', 'DKFT.JK', 'NIKL.JK',
                'CITA.JK', 'SMCB.JK', 'SMBR.JK', 'ARCI.JK', 'IFSH.JK', 'MCOL.JK', 'SOLA.JK', 'AGII.JK',
                'ALDO.JK', 'AMFG.JK', 'BTON.JK', 'FASW.JK', 'GDST.JK', 'INCF.JK', 'ISSP.JK', 'KRAS.JK',
                'LION.JK', 'LMSH.JK', 'PBSA.JK', 'TDPM.JK', 'TRST.JK', 'UNIC.JK', 'BRMS.JK', 'SMGA.JK',
                'NICE.JK', 'HILL.JK', 'ZINC.JK', 'DAAZ.JK', 'CHEM.JK', 'PBID.JK', 'EKAD.JK', 'FPNI.JK', 'IGAR.JK'
            ]
        },
        'ENERGY': {
            name: 'Energy',
            icon: '',
            symbols: [
                'ADRO.JK', 'PTBA.JK', 'PGAS.JK', 'MEDC.JK', 'AKRA.JK', 'ESSA.JK', 'AMMN.JK', 'BREN.JK',
                'CUAN.JK', 'PGEO.JK', 'HRUM.JK', 'ITMG.JK', 'DOID.JK', 'INDY.JK', 'PTRO.JK', 'BYAN.JK',
                'GEMS.JK', 'BUMI.JK', 'ELSA.JK', 'MBSS.JK', 'ENRG.JK', 'TOBA.JK', 'ABMM.JK', 'APEX.JK',
                'ARTI.JK', 'BIPI.JK', 'BSSR.JK', 'DEWA.JK', 'FIRE.JK', 'GTBO.JK', 'IATA.JK', 'KOBX.JK',
                'MYOH.JK', 'RUIS.JK', 'SMMT.JK', 'SURE.JK', 'TEBE.JK', 'WINS.JK', 'DSSA.JK', 'ADMR.JK',
                'AADI.JK', 'RAJA.JK', 'PSSI.JK', 'SGER.JK', 'HUMI.JK', 'GTRA.JK', 'KKGI.JK', 'BSML.JK', 'RGAS.JK'
            ]
        },
        'CYCLICAL': {
            name: 'Consumer Cyclicals',
            icon: '',
            symbols: [
                'ACES.JK', 'MAPI.JK', 'MAPA.JK', 'ERAA.JK', 'RALS.JK', 'LPPF.JK', 'AUTO.JK', 'DRMA.JK',
                'ASLC.JK', 'MPPA.JK', 'CINT.JK', 'WOOD.JK', 'PANR.JK', 'SCMA.JK', 'MNCN.JK', 'MSIN.JK',
                'MDIA.JK', 'BELL.JK', 'BIKA.JK', 'BIPP.JK', 'BLTZ.JK', 'BOLA.JK', 'CSAP.JK', 'DFAM.JK',
                'FAST.JK', 'FILM.JK', 'GLOB.JK', 'HERO.JK', 'KOCI.JK', 'MABA.JK', 'BMTR.JK', 'CARS.JK',
                'IMAS.JK', 'IMJS.JK', 'MSKY.JK', 'ZONE.JK'
            ]
        },
        'FINANCE': {
            name: 'Finance',
            icon: '',
            symbols: [
                'BBRI.JK', 'BBCA.JK', 'BMRI.JK', 'BBNI.JK', 'BRIS.JK', 'ARTO.JK', 'BBHI.JK', 'BNGA.JK',
                'BDMN.JK', 'BJBR.JK', 'BJTM.JK', 'BTPS.JK', 'NISP.JK', 'PNLF.JK', 'BFIN.JK', 'SRTG.JK',
                'BBTN.JK', 'AGRO.JK', 'BCIC.JK', 'BNLI.JK', 'BSIM.JK', 'MAHA.JK', 'MFIN.JK', 'CFIN.JK',
                'AMAG.JK', 'BABP.JK', 'BACA.JK', 'BBKP.JK', 'BBMD.JK', 'BCAP.JK', 'BEKS.JK', 'BGTG.JK',
                'BINA.JK', 'BNBA.JK', 'BNII.JK', 'BSWD.JK', 'BTPN.JK', 'DNAR.JK', 'MASB.JK', 'ADMF.JK',
                'WOMF.JK', 'AMAR.JK', 'BBYB.JK', 'BANK.JK', 'TUGU.JK', 'PNBN.JK', 'PNIN.JK', 'MEGA.JK',
                'NOBU.JK', 'MLPL.JK'
            ]
        },
        'INFRASTRUC': {
            name: 'Infrastructure',
            icon: '',
            symbols: [
                'TLKM.JK', 'ISAT.JK', 'EXCL.JK', 'TOWR.JK', 'TBIG.JK', 'JSMR.JK', 'FREN.JK', 'CENT.JK',
                'GHON.JK', 'GOLD.JK', 'META.JK', 'CMNP.JK', 'KEEN.JK', 'POWR.JK', 'TGRA.JK', 'ACST.JK',
                'BALI.JK', 'BPII.JK', 'BUKK.JK', 'DADA.JK', 'IBST.JK', 'IDPR.JK', 'KBLV.JK', 'LINK.JK',
                'MCTA.JK', 'MTPS.JK', 'PPRE.JK', 'SSIA.JK', 'SUPR.JK', 'TLDN.JK', 'MORI.JK', 'OASA.JK',
                'KARW.JK', 'MTEL.JK'
            ]
        },
        'HEALTH': {
            name: 'Healthcare',
            icon: '',
            symbols: [
                'KLBF.JK', 'KAEF.JK', 'MIKA.JK', 'HEAL.JK', 'SILO.JK', 'SIDO.JK', 'INAF.JK', 'SAME.JK',
                'PRDA.JK', 'TSPC.JK', 'PEHA.JK', 'DVLA.JK', 'PYFA.JK', 'BMHS.JK', 'CARE.JK', 'DGNS.JK',
                'MEDS.JK', 'OMED.JK', 'PRAY.JK', 'PRIM.JK', 'RDTX.JK', 'SCPI.JK', 'SOHO.JK', 'RSGK.JK',
                'MTMH.JK', 'HALO.JK'
            ]
        },
        'INDUSTRIAL': {
            name: 'Industrials',
            icon: '',
            symbols: [
                'ASII.JK', 'UNTR.JK', 'HEXA.JK', 'PTPP.JK', 'WIKA.JK', 'ADHI.JK', 'WEGE.JK', 'TOTL.JK',
                'MARK.JK', 'IMPC.JK', 'KBLI.JK', 'JECC.JK', 'ARNA.JK', 'BHIT.JK', 'CCSI.JK', 'GMFI.JK',
                'INAI.JK', 'KBLM.JK', 'KMTR.JK', 'KPII.JK', 'SPTO.JK', 'BNBR.JK', 'VKTR.JK', 'MLIA.JK',
                'LABA.JK', 'HYGN.JK', 'SKRN.JK', 'JTPE.JK'
            ]
        },
        'NON-CYCLICAL': {
            name: 'Consumer Non-Cyclicals',
            icon: '',
            symbols: [
                'UNVR.JK', 'ICBP.JK', 'INDF.JK', 'CPIN.JK', 'JPFA.JK', 'CMRY.JK', 'CLEO.JK', 'MYOR.JK',
                'AMRT.JK', 'GGRM.JK', 'HMSP.JK', 'STTP.JK', 'AALI.JK', 'LSIP.JK', 'TAPG.JK', 'DSNG.JK',
                'SSMS.JK', 'BWPT.JK', 'SIMP.JK', 'VICI.JK', 'MAIN.JK', 'BEEF.JK', 'BTEK.JK', 'CEKA.JK',
                'DLTA.JK', 'DMND.JK', 'FOOD.JK', 'GOOD.JK', 'HOKI.JK', 'IKAN.JK', 'KEJU.JK', 'BOBA.JK',
                'STRK.JK', 'ROTI.JK', 'ULTJ.JK', 'ADES.JK', 'CAMP.JK', 'TBLA.JK'
            ]
        },
        'PROPERTY': {
            name: 'Property & Real Estate',
            icon: '',
            symbols: [
                'BSDE.JK', 'CTRA.JK', 'PWON.JK', 'SMRA.JK', 'ASRI.JK', 'APLN.JK', 'DUTI.JK', 'MKPI.JK',
                'DILD.JK', 'KIJA.JK', 'BEST.JK', 'LPKR.JK', 'LPCK.JK', 'PPRO.JK', 'JRPT.JK', 'BKSL.JK',
                'ARMY.JK', 'BAPA.JK', 'BBSS.JK', 'BCIP.JK', 'CITY.JK', 'COWL.JK', 'CPRI.JK', 'DMAS.JK',
                'ELTY.JK', 'FMII.JK', 'FORZ.JK', 'GAMA.JK', 'GPRA.JK', 'GWSA.JK', 'IPAC.JK', 'PANI.JK',
                'REAL.JK', 'SWID.JK', 'TRIN.JK', 'URBN.JK', 'VAST.JK'
            ]
        },
        'TRANSPORT': {
            name: 'Transportation & Logistics',
            icon: '',
            symbols: [
                'BIRD.JK', 'SMDR.JK', 'ASSA.JK', 'TMAS.JK', 'HELI.JK', 'HAIS.JK', 'GIAA.JK', 'CMPP.JK',
                'IPCC.JK', 'IPCM.JK', 'SAFE.JK', 'BPTR.JK', 'TRUK.JK', 'WEHA.JK', 'AKSI.JK', 'BLTA.JK',
                'CASS.JK', 'DEAL.JK', 'HITS.JK', 'JKSW.JK', 'LEAD.JK', 'LRNA.JK', 'NELY.JK', 'SOCI.JK',
                'KLAS.JK', 'PTMP.JK', 'PJAA.JK'
            ]
        },
        'TECHNOLOGY': {
            name: 'Technology',
            icon: '',
            symbols: [
                'GOTO.JK', 'BUKA.JK', 'EMTK.JK', 'MLPT.JK', 'DCII.JK', 'MTDL.JK', 'WIFI.JK', 'BELI.JK',
                'AXIO.JK', 'MCAS.JK', 'NFCX.JK', 'DMMX.JK', 'ENVY.JK', 'ATIC.JK', 'CASH.JK', 'DIVA.JK',
                'GLVA.JK', 'HDIT.JK', 'JSPT.JK', 'LUCK.JK', 'MTECH.JK', 'PTSN.JK', 'WIRE.JK', 'AWAN.JK',
                'ZYRX.JK', 'CYBR.JK', 'CHIP.JK', 'EDGE.JK', 'ELIT.JK', 'TECH.JK', 'TRON.JK', 'AREA.JK'
            ]
        }
    },

    // ─── Get Default Symbols (Covering all 11 sectors) ───────────────
    get DEFAULT_SYMBOLS() {
        const set = new Set();
        Object.values(this.IDX_SECTORS).forEach(sec => {
            sec.symbols.forEach(sym => set.add(sym));
        });
        return Array.from(set);
    },

    // Helper: Lookup Sector for a given symbol
    getSectorForSymbol(symbol) {
        if (!symbol) return 'BASIC-IND';
        const sym = symbol.toUpperCase().trim();
        for (const [sectorKey, sectorObj] of Object.entries(this.IDX_SECTORS)) {
            if (sectorObj.symbols.includes(sym)) {
                return sectorKey;
            }
        }
        return 'BASIC-IND'; // fallback
    },

    // ─── Filter Definitions ────────────────────────────────────────────
    FILTER_DEFS: [
        { key: 'sector', label: 'Sektor IDX', type: 'select', options: ['BASIC-IND', 'ENERGY', 'CYCLICAL', 'FINANCE', 'INFRASTRUC', 'HEALTH', 'INDUSTRIAL', 'NON-CYCLICAL', 'PROPERTY', 'TRANSPORT', 'TECHNOLOGY'], group: 'Umum' },
        { key: 'per', label: 'PER', type: 'range', unit: 'x', group: 'Fundamental' },
        { key: 'pbv', label: 'PBV', type: 'range', unit: 'x', group: 'Fundamental' },
        { key: 'roe', label: 'ROE', type: 'range', unit: '%', isPercent: true, group: 'Fundamental' },
        { key: 'der', label: 'DER', type: 'range', unit: 'x', group: 'Fundamental' },
        { key: 'dividendYield', label: 'Div Yield', type: 'range', unit: '%', isPercent: true, group: 'Fundamental' },
        { key: 'profitMargin', label: 'Profit Margin', type: 'range', unit: '%', isPercent: true, group: 'Fundamental' },
        { key: 'revenueGrowth', label: 'Rev Growth', type: 'range', unit: '%', isPercent: true, group: 'Fundamental' },
        { key: 'currentRatio', label: 'Current Ratio', type: 'range', unit: 'x', group: 'Fundamental' },
        { key: 'eps', label: 'EPS', type: 'range', unit: '', group: 'Fundamental' },
        { key: 'changePercent', label: 'Change %', type: 'range', unit: '%', group: 'Harga' },
        { key: 'marketCap', label: 'Market Cap', type: 'range', unit: '', group: 'Harga', isBig: true },
        { key: 'fundamentalScore', label: 'Skor Fund.', type: 'range', unit: '', group: 'Fundamental' },
        { key: 'technicalSignal', label: 'Sinyal Teknikal', type: 'select', options: ['STRONG_BUY', 'BUY', 'NEUTRAL', 'SELL', 'STRONG_SELL'], group: 'Teknikal' },
    ],

    // ─── Preset Filter Templates ────────────────────────────────────────
    PRESETS: [
        {
            name: 'Value Stocks',
            desc: 'PER rendah, PBV rendah, dividen tinggi',
            filters: [
                { key: 'per', op: '<=', value: 15 },
                { key: 'pbv', op: '<=', value: 2 },
                { key: 'dividendYield', op: '>=', value: 3 },
            ],
        },
        {
            name: 'Growth Stocks',
            desc: 'ROE tinggi, revenue growth positif',
            filters: [
                { key: 'roe', op: '>=', value: 15 },
                { key: 'revenueGrowth', op: '>=', value: 10 },
            ],
        },
        {
            name: 'Safe & Stable',
            desc: 'DER rendah, current ratio tinggi, profit margin baik',
            filters: [
                { key: 'der', op: '<=', value: 1 },
                { key: 'currentRatio', op: '>=', value: 1.5 },
                { key: 'profitMargin', op: '>=', value: 10 },
            ],
        },
        {
            name: 'Strong Buy Signal',
            desc: 'Sinyal teknikal & fundamental kuat',
            filters: [
                { key: 'technicalSignal', op: '==', value: 'STRONG_BUY' },
                { key: 'fundamentalScore', op: '>=', value: 60 },
            ],
        },
    ],

    // ─── State ─────────────────────────────────────────────────────────
    _results: [],           // Full scan results
    _filteredResults: [],   // After applying filters
    _activeFilters: [],     // Currently active filters [{key, op, value}]
    _sortColumn: null,
    _sortDirection: 'asc',
    _isScanning: false,
    _scanProgress: 0,
    _lastScanTime: null,
    _customSymbols: [],     // User-added symbols
    _onSelectCallback: null,

    // ─── Column Definitions for Table ──────────────────────────────────
    COLUMNS: [
        { key: 'symbol', label: 'Simbol', type: 'text', width: '95px' },
        { key: 'name', label: 'Nama', type: 'text', width: '130px' },
        { key: 'sector', label: 'Sektor', type: 'sector', width: '105px' },
        { key: 'price', label: 'Harga', type: 'price', width: '85px' },
        { key: 'changePercent', label: 'Chg%', type: 'percent', width: '75px' },
        { key: 'volume', label: 'Volume', type: 'volume', width: '85px' },
        { key: 'marketCap', label: 'M.Cap', type: 'bignum', width: '85px' },
        { key: 'per', label: 'PER', type: 'number', width: '65px' },
        { key: 'pbv', label: 'PBV', type: 'number', width: '65px' },
        { key: 'roe', label: 'ROE', type: 'percent', width: '65px' },
        { key: 'der', label: 'DER', type: 'number', width: '65px' },
        { key: 'dividendYield', label: 'Div%', type: 'percent', width: '65px' },
        { key: 'fundamentalScore', label: 'F.Skor', type: 'score', width: '70px' },
        { key: 'technicalSignal', label: 'Sinyal', type: 'signal', width: '105px' },
    ],

    // ─── Init ──────────────────────────────────────────────────────────
    init(onSelectCallback) {
        this._onSelectCallback = onSelectCallback;

        // Load custom symbols from localStorage
        try {
            const saved = localStorage.getItem('screener_custom_symbols');
            if (saved) this._customSymbols = JSON.parse(saved);
        } catch (_) { /* ignore */ }

        // Load saved filters
        try {
            const savedFilters = localStorage.getItem('screener_filters');
            if (savedFilters) this._activeFilters = JSON.parse(savedFilters);
        } catch (_) { /* ignore */ }

        this._setupEventListeners();
        this._renderFilterChips();
        this._renderPresets();
        this._renderSectorCards();
    },

    // ─── Get All Symbols ───────────────────────────────────────────────
    getAllSymbols() {
        const combined = [...this.DEFAULT_SYMBOLS, ...this._customSymbols];
        return [...new Set(combined)]; // deduplicate
    },

    // ─── Add Custom Symbol ─────────────────────────────────────────────
    addSymbol(symbol) {
        const sym = symbol.toUpperCase().trim();
        if (!sym) return;
        if (this.DEFAULT_SYMBOLS.includes(sym) || this._customSymbols.includes(sym)) return;
        this._customSymbols.push(sym);
        localStorage.setItem('screener_custom_symbols', JSON.stringify(this._customSymbols));
    },

    // ─── Scan All Stocks ───────────────────────────────────────────────
    async scan() {
        if (this._isScanning) return;
        this._isScanning = true;
        this._scanProgress = 0;
        this._results = [];

        const symbols = this.getAllSymbols();
        const total = symbols.length;

        this._updateScanUI(true, 0, total);

        for (let i = 0; i < symbols.length; i++) {
            const symbol = symbols[i];
            try {
                const row = await this._fetchStockData(symbol);
                if (row) {
                    this._results.push(row);
                }
            } catch (err) {
                console.warn(`[Screener] Failed to fetch ${symbol}:`, err.message);
            }

            this._scanProgress = i + 1;
            this._updateScanUI(true, this._scanProgress, total);

            // Throttle: delay between requests to avoid rate limiting
            if (i < symbols.length - 1) {
                await new Promise(r => setTimeout(r, 1500));
            }
        }

        this._isScanning = false;
        this._lastScanTime = new Date();
        this._applyFiltersAndSort();
        this._updateScanUI(false, total, total);
        this._renderTable();
        this._renderStatusBar();
    },

    // ─── Fetch Stock Data ──────────────────────────────────────────────
    async _fetchStockData(symbol) {
        try {
            // Fetch quote, fundamental, and chart data in parallel
            const [quote, fundamental, chartData] = await Promise.all([
                DataService.getQuote(symbol).catch(() => null),
                DataService.getFundamental(symbol).catch(() => null),
                DataService.getChart(symbol, '1d').catch(() => null),
            ]);

            if (!quote) return null;

            // Analyze fundamental
            let fundResult = null;
            if (fundamental) {
                fundResult = FundamentalAnalysis.analyze(fundamental);
            }

            // Analyze technical signals from chart data
            let techSignal = null;
            let techScore = null;
            if (chartData) {
                const ohlcv = this._normalizeChartData(chartData);
                if (ohlcv.length >= 30) {
                    const signalResult = SignalEngine.analyze(ohlcv);
                    techSignal = signalResult.overall;
                    techScore = signalResult.score;
                }
            }

            // Normalize ROE, profitMargin, dividendYield etc. to percentage
            const toPercent = (v) => {
                if (v == null || isNaN(v)) return null;
                return Math.abs(v) > 1 ? v : v * 100;
            };

            return {
                symbol: symbol,
                name: quote.name || symbol,
                price: quote.price ?? 0,
                change: quote.change ?? 0,
                changePercent: quote.changePercent ?? 0,
                volume: quote.volume ?? 0,
                marketCap: quote.marketCap ?? null,
                dayHigh: quote.dayHigh ?? 0,
                dayLow: quote.dayLow ?? 0,
                open: quote.open ?? 0,
                previousClose: quote.previousClose ?? 0,
                fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh ?? 0,
                fiftyTwoWeekLow: quote.fiftyTwoWeekLow ?? 0,

                // Sector
                sector: this.getSectorForSymbol(symbol),

                // Fundamental
                per: fundamental?.per ?? null,
                pbv: fundamental?.pbv ?? null,
                roe: toPercent(fundamental?.roe),
                der: fundamental?.der ?? null,
                eps: fundamental?.eps ?? null,
                dividendYield: toPercent(fundamental?.dividendYield),
                profitMargin: toPercent(fundamental?.profitMargin),
                revenueGrowth: toPercent(fundamental?.revenueGrowth),
                currentRatio: fundamental?.currentRatio ?? null,

                // Scores
                fundamentalScore: fundResult?.score ?? null,
                fundamentalGrade: fundResult?.grade ?? null,

                // Technical signals (now computed from chart data)
                technicalSignal: techSignal,
                technicalScore: techScore,
            };
        } catch (err) {
            console.warn(`[Screener] Error fetching ${symbol}:`, err.message);
            return null;
        }
    },

    // ─── Render Sector Cards (Stockbit Category UI) ──────────────────────
    _renderSectorCards() {
        const container = document.getElementById('screenerSectorsGrid');
        if (!container) return;

        let html = '';
        Object.entries(this.IDX_SECTORS).forEach(([sectorKey, sec]) => {
            // Calculate real-time average % change for this sector from _results if available
            let avgChange = 0;
            let count = 0;
            if (this._results && this._results.length > 0) {
                const sectorStocks = this._results.filter(r => r.sector === sectorKey);
                if (sectorStocks.length > 0) {
                    const totalChange = sectorStocks.reduce((sum, r) => sum + (r.changePercent || 0), 0);
                    avgChange = totalChange / sectorStocks.length;
                    count = sectorStocks.length;
                }
            }
            if (count === 0) count = sec.symbols.length;

            const changeCls = avgChange > 0 ? 'positive' : avgChange < 0 ? 'negative' : 'neutral';
            const changeSign = avgChange > 0 ? '+' : '';
            const changeText = avgChange !== 0 ? `${changeSign}${avgChange.toFixed(2)}%` : '0.00%';

            const isActive = this._activeFilters.some(f => f.key === 'sector' && f.value === sectorKey);

            html += `
                <div class="screener-sector-card ${isActive ? 'active' : ''}" data-sector="${sectorKey}">
                    <div class="sector-card-icon-wrap">
                        <span class="sector-card-emoji">${sec.icon}</span>
                    </div>
                    <div class="sector-card-info">
                        <span class="sector-card-title">${sectorKey}</span>
                        <span class="sector-card-pct ${changeCls}">${changeText}</span>
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;

        // Bind clicks on sector cards
        container.querySelectorAll('.screener-sector-card').forEach(card => {
            card.addEventListener('click', () => {
                const sec = card.dataset.sector;
                const activeSecFilter = this._activeFilters.find(f => f.key === 'sector');
                if (activeSecFilter && activeSecFilter.value === sec) {
                    // Deselect if already active
                    this.removeFilter('sector');
                    document.getElementById('screenerResetSectorBtn')?.classList.add('active');
                } else {
                    // Filter by sector
                    this.addFilter('sector', '==', sec);
                    document.getElementById('screenerResetSectorBtn')?.classList.remove('active');
                }
                this._renderSectorCards();
            });
        });

        // Reset Sector Button
        const resetSecBtn = document.getElementById('screenerResetSectorBtn');
        if (resetSecBtn) {
            const hasSectorFilter = this._activeFilters.some(f => f.key === 'sector');
            resetSecBtn.classList.toggle('active', !hasSectorFilter);
            resetSecBtn.onclick = () => {
                this.removeFilter('sector');
                this._renderSectorCards();
            };
        }
    },

    // ─── Normalize chart data for signal analysis ─────────────────────
    _normalizeChartData(raw) {
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
                time: t, open: q.open?.[i] ?? 0, high: q.high?.[i] ?? 0,
                low: q.low?.[i] ?? 0, close: q.close?.[i] ?? 0, volume: q.volume?.[i] ?? 0,
            }));
        }
        return arr
            .filter(d => d && d.close != null && d.close !== 0)
            .map(d => ({
                time: typeof d.time === 'number' && d.time > 1e12 ? Math.floor(d.time / 1000) : d.time,
                open: Number(d.open), high: Number(d.high), low: Number(d.low),
                close: Number(d.close), volume: Number(d.volume ?? 0),
            }))
            .sort((a, b) => a.time - b.time);
    },

    // ─── Filter Engine ─────────────────────────────────────────────────
    addFilter(key, op, value) {
        // Remove existing filter for same key
        this._activeFilters = this._activeFilters.filter(f => f.key !== key);
        this._activeFilters.push({ key, op, value });
        this._saveFilters();
        this._applyFiltersAndSort();
        this._renderFilterChips();
        this._renderTable();
        this._renderStatusBar();
    },

    removeFilter(key) {
        this._activeFilters = this._activeFilters.filter(f => f.key !== key);
        this._saveFilters();
        this._applyFiltersAndSort();
        this._renderFilterChips();
        this._renderTable();
        this._renderStatusBar();
    },

    clearFilters() {
        this._activeFilters = [];
        this._saveFilters();
        this._applyFiltersAndSort();
        this._renderFilterChips();
        this._renderTable();
        this._renderStatusBar();
    },

    applyPreset(presetIndex) {
        const preset = this.PRESETS[presetIndex];
        if (!preset) return;
        this._activeFilters = [...preset.filters];
        this._saveFilters();
        this._applyFiltersAndSort();
        this._renderFilterChips();
        this._renderTable();
        this._renderStatusBar();
    },

    _saveFilters() {
        localStorage.setItem('screener_filters', JSON.stringify(this._activeFilters));
    },

    _applyFiltersAndSort() {
        let filtered = [...this._results];

        // Apply each filter
        for (const filter of this._activeFilters) {
            filtered = filtered.filter(row => {
                const val = row[filter.key];
                if (val == null) return false;

                switch (filter.op) {
                    case '>=': return val >= filter.value;
                    case '<=': return val <= filter.value;
                    case '>': return val > filter.value;
                    case '<': return val < filter.value;
                    case '==': return val === filter.value;
                    case '!=': return val !== filter.value;
                    default: return true;
                }
            });
        }

        // Apply sort
        if (this._sortColumn) {
            const dir = this._sortDirection === 'asc' ? 1 : -1;
            filtered.sort((a, b) => {
                let va = a[this._sortColumn];
                let vb = b[this._sortColumn];

                // Handle nulls
                if (va == null && vb == null) return 0;
                if (va == null) return 1;
                if (vb == null) return -1;

                // String comparison
                if (typeof va === 'string') {
                    return va.localeCompare(vb) * dir;
                }

                return (va - vb) * dir;
            });
        }

        this._filteredResults = filtered;
    },

    // ─── Sort ──────────────────────────────────────────────────────────
    toggleSort(column) {
        if (this._sortColumn === column) {
            this._sortDirection = this._sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            this._sortColumn = column;
            this._sortDirection = 'asc';
        }
        this._applyFiltersAndSort();
        this._renderTable();
    },

    // ─── UI Setup ──────────────────────────────────────────────────────
    _setupEventListeners() {
        // Scan button
        const scanBtn = document.getElementById('screenerScanBtn');
        if (scanBtn) {
            scanBtn.addEventListener('click', () => this.scan());
        }

        // Reset filters button
        const resetBtn = document.getElementById('screenerResetBtn');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => this.clearFilters());
        }

        // Export button
        const exportBtn = document.getElementById('screenerExportBtn');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => this.exportCSV());
        }

        // Add symbol button
        const addSymBtn = document.getElementById('screenerAddSymbolBtn');
        if (addSymBtn) {
            addSymBtn.addEventListener('click', () => {
                const sym = prompt('Masukkan simbol saham (contoh: BBRI.JK, AAPL):');
                if (sym) {
                    this.addSymbol(sym);
                    // Optionally re-scan just the new symbol
                }
            });
        }

        // Add filter button
        const addFilterBtn = document.getElementById('screenerAddFilterBtn');
        if (addFilterBtn) {
            addFilterBtn.addEventListener('click', () => this._showFilterModal());
        }

        // Filter modal apply
        const applyFilterBtn = document.getElementById('filterModalApply');
        if (applyFilterBtn) {
            applyFilterBtn.addEventListener('click', () => this._applyFilterFromModal());
        }

        // Filter modal cancel
        const cancelFilterBtn = document.getElementById('filterModalCancel');
        if (cancelFilterBtn) {
            cancelFilterBtn.addEventListener('click', () => this._hideFilterModal());
        }

        // Close modal on backdrop click
        const modal = document.getElementById('screenerFilterModal');
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) this._hideFilterModal();
            });
        }

        // Filter metric select change — update operator/value options
        const metricSelect = document.getElementById('filterMetricSelect');
        if (metricSelect) {
            metricSelect.addEventListener('change', () => this._updateFilterModalOptions());
        }
    },

    // ─── Filter Modal ──────────────────────────────────────────────────
    _showFilterModal() {
        const modal = document.getElementById('screenerFilterModal');
        if (!modal) return;
        modal.classList.add('active');

        // Populate metric options
        const select = document.getElementById('filterMetricSelect');
        if (select) {
            select.innerHTML = '';
            const groups = {};
            this.FILTER_DEFS.forEach(fd => {
                if (!groups[fd.group]) groups[fd.group] = [];
                groups[fd.group].push(fd);
            });

            Object.entries(groups).forEach(([groupName, items]) => {
                const optgroup = document.createElement('optgroup');
                optgroup.label = groupName;
                items.forEach(item => {
                    const opt = document.createElement('option');
                    opt.value = item.key;
                    opt.textContent = item.label;
                    optgroup.appendChild(opt);
                });
                select.appendChild(optgroup);
            });
        }

        this._updateFilterModalOptions();
    },

    _hideFilterModal() {
        const modal = document.getElementById('screenerFilterModal');
        if (modal) modal.classList.remove('active');
    },

    _updateFilterModalOptions() {
        const metricKey = document.getElementById('filterMetricSelect')?.value;
        const def = this.FILTER_DEFS.find(f => f.key === metricKey);
        if (!def) return;

        const opSelect = document.getElementById('filterOpSelect');
        const valueInput = document.getElementById('filterValueInput');
        const valueSelect = document.getElementById('filterValueSelect');

        if (def.type === 'select') {
            // Show select options
            if (opSelect) opSelect.style.display = 'none';
            if (valueInput) valueInput.style.display = 'none';
            if (valueSelect) {
                valueSelect.style.display = 'block';
                valueSelect.innerHTML = '';
                def.options.forEach(opt => {
                    const o = document.createElement('option');
                    o.value = opt;
                    o.textContent = opt.replace(/_/g, ' ');
                    valueSelect.appendChild(o);
                });
            }
        } else {
            // Show range operators + number input
            if (opSelect) {
                opSelect.style.display = 'block';
                opSelect.innerHTML = `
                    <option value=">=">&ge; Minimal</option>
                    <option value="<=">&le; Maksimal</option>
                    <option value=">"> &gt; Lebih dari</option>
                    <option value="<"> &lt; Kurang dari</option>
                `;
            }
            if (valueInput) {
                valueInput.style.display = 'block';
                valueInput.placeholder = `Nilai ${def.unit}`;
                valueInput.value = '';
            }
            if (valueSelect) valueSelect.style.display = 'none';
        }
    },

    _applyFilterFromModal() {
        const metricKey = document.getElementById('filterMetricSelect')?.value;
        const def = this.FILTER_DEFS.find(f => f.key === metricKey);
        if (!def) return;

        let op, value;
        if (def.type === 'select') {
            op = '==';
            value = document.getElementById('filterValueSelect')?.value;
        } else {
            op = document.getElementById('filterOpSelect')?.value || '>=';
            const rawValue = document.getElementById('filterValueInput')?.value;
            value = parseFloat(rawValue);
            if (isNaN(value)) {
                alert('Masukkan nilai angka yang valid');
                return;
            }
        }

        this.addFilter(metricKey, op, value);
        this._hideFilterModal();
    },

    // ─── Render Filter Chips ───────────────────────────────────────────
    _renderFilterChips() {
        const container = document.getElementById('screenerActiveFilters');
        if (!container) return;

        if (this._activeFilters.length === 0) {
            container.innerHTML = '<span class="screener-no-filters">Tidak ada filter aktif — tampilkan semua</span>';
            return;
        }

        container.innerHTML = this._activeFilters.map(f => {
            const def = this.FILTER_DEFS.find(d => d.key === f.key);
            const label = def?.label || f.key;
            const unit = def?.unit || '';
            const opSymbol = { '>=': '≥', '<=': '≤', '>': '>', '<': '<', '==': '=', '!=': '≠' }[f.op] || f.op;
            const displayVal = typeof f.value === 'string' ? f.value.replace(/_/g, ' ') : f.value;

            return `
                <span class="screener-filter-chip" data-filter-key="${f.key}">
                    <span class="chip-label">${label}</span>
                    <span class="chip-op">${opSymbol}</span>
                    <span class="chip-value">${displayVal}${unit}</span>
                    <button class="chip-remove" data-remove-key="${f.key}" title="Hapus filter">×</button>
                </span>
            `;
        }).join('');

        // Bind remove buttons
        container.querySelectorAll('.chip-remove').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeFilter(btn.dataset.removeKey);
            });
        });
    },

    // ─── Render Presets ────────────────────────────────────────────────
    _renderPresets() {
        const container = document.getElementById('screenerPresets');
        if (!container) return;

        container.innerHTML = this.PRESETS.map((preset, idx) => `
            <button class="screener-preset-btn" data-preset="${idx}" title="${preset.desc}">
                ${preset.name}
            </button>
        `).join('');

        container.querySelectorAll('.screener-preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.preset);
                this.applyPreset(idx);
            });
        });
    },

    // ─── Render Table ──────────────────────────────────────────────────
    _renderTable() {
        const container = document.getElementById('screenerTableContainer');
        if (!container) return;

        if (this._results.length === 0) {
            container.innerHTML = `
                <div class="screener-empty-state">
                    <span class="empty-state-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg></span>
                    <span class="empty-state-title">Belum ada data screening</span>
                    <span class="empty-state-text">Klik tombol "Scan Saham" untuk memulai screening</span>
                </div>
            `;
            return;
        }

        if (this._filteredResults.length === 0) {
            container.innerHTML = `
                <div class="screener-empty-state">
                    <span class="empty-state-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg></span>
                    <span class="empty-state-title">Tidak ada saham yang cocok</span>
                    <span class="empty-state-text">Ubah filter untuk menampilkan hasil</span>
                </div>
            `;
            return;
        }

        // Build table
        const sortIcon = (colKey) => {
            if (this._sortColumn !== colKey) return '<span class="sort-icon">⇅</span>';
            return this._sortDirection === 'asc'
                ? '<span class="sort-icon active">↑</span>'
                : '<span class="sort-icon active">↓</span>';
        };

        let html = '<div class="screener-table-wrapper"><table class="screener-table">';

        // Header
        html += '<thead><tr>';
        html += '<th class="screener-th row-num">#</th>';
        this.COLUMNS.forEach(col => {
            html += `<th class="screener-th sortable" data-sort="${col.key}" style="min-width:${col.width}">${col.label} ${sortIcon(col.key)}</th>`;
        });
        html += '</tr></thead>';

        // Body
        html += '<tbody>';
        this._filteredResults.forEach((row, idx) => {
            html += `<tr class="screener-row" data-symbol="${row.symbol}">`;
            html += `<td class="screener-td row-num">${idx + 1}</td>`;
            this.COLUMNS.forEach(col => {
                html += `<td class="screener-td">${this._formatCell(row, col)}</td>`;
            });
            html += '</tr>';
        });
        html += '</tbody></table></div>';

        container.innerHTML = html;

        // Bind sort headers
        container.querySelectorAll('.screener-th.sortable').forEach(th => {
            th.addEventListener('click', () => {
                this.toggleSort(th.dataset.sort);
            });
        });

        // Bind row clicks
        container.querySelectorAll('.screener-row').forEach(row => {
            row.addEventListener('click', () => {
                const sym = row.dataset.symbol;
                if (sym && this._onSelectCallback) {
                    this._onSelectCallback(sym);
                }
            });
        });
    },

    // ─── Cell Formatter ────────────────────────────────────────────────
    _formatCell(row, col) {
        const val = row[col.key];

        switch (col.type) {
            case 'text':
                if (col.key === 'symbol') {
                    return `<span class="screener-symbol">${val || '—'}</span>`;
                }
                return `<span class="screener-text">${val || '—'}</span>`;

            case 'price': {
                if (val == null) return '<span class="text-muted">—</span>';
                const isIDR = row.symbol?.endsWith('.JK');
                const formatted = isIDR
                    ? new Intl.NumberFormat('id-ID').format(val)
                    : new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);
                return `<span class="mono">${formatted}</span>`;
            }

            case 'percent': {
                if (val == null) return '<span class="text-muted">—</span>';
                const cls = val > 0 ? 'positive' : val < 0 ? 'negative' : '';
                const prefix = val > 0 ? '+' : '';
                return `<span class="mono ${cls}">${prefix}${val.toFixed(2)}%</span>`;
            }

            case 'number': {
                if (val == null) return '<span class="text-muted">—</span>';
                const numCls = this._getMetricColorClass(col.key, val);
                return `<span class="mono ${numCls}">${val.toFixed(2)}</span>`;
            }

            case 'volume': {
                if (val == null) return '<span class="text-muted">—</span>';
                return `<span class="mono">${this._formatVolume(val)}</span>`;
            }

            case 'bignum': {
                if (val == null) return '<span class="text-muted">—</span>';
                return `<span class="mono">${this._formatLargeNumber(val)}</span>`;
            }

            case 'score': {
                if (val == null) return '<span class="text-muted">—</span>';
                const scoreCls = val >= 65 ? 'score-good' : val >= 45 ? 'score-fair' : 'score-poor';
                return `<span class="screener-score-badge ${scoreCls}">${val}</span>`;
            }

            case 'signal': {
                if (!val) return '<span class="text-muted">—</span>';
                const sigCls = val.toLowerCase().replace(/_/g, '-');
                return `<span class="screener-signal-badge ${sigCls}">${val.replace(/_/g, ' ')}</span>`;
            }

            case 'sector': {
                if (!val) return '<span class="text-muted">—</span>';
                return `<span class="screener-sector-tag sector-${val.toLowerCase()}">${val}</span>`;
            }

            default:
                return val != null ? String(val) : '—';
        }
    },

    // ─── Metric Color Logic ────────────────────────────────────────────
    _getMetricColorClass(key, val) {
        switch (key) {
            case 'per':
                if (val < 10) return 'metric-excellent';
                if (val < 15) return 'metric-good';
                if (val < 25) return 'metric-fair';
                return 'metric-poor';
            case 'pbv':
                if (val < 1) return 'metric-excellent';
                if (val < 2) return 'metric-good';
                if (val < 3) return 'metric-fair';
                return 'metric-poor';
            case 'der':
                if (val < 0.5) return 'metric-excellent';
                if (val < 1) return 'metric-good';
                if (val < 2) return 'metric-fair';
                return 'metric-poor';
            default:
                return '';
        }
    },

    // ─── Update Scan Progress UI ───────────────────────────────────────
    _updateScanUI(isScanning, current, total) {
        const btn = document.getElementById('screenerScanBtn');
        const progress = document.getElementById('screenerProgress');
        const progressFill = document.getElementById('screenerProgressFill');
        const progressText = document.getElementById('screenerProgressText');

        if (btn) {
            if (isScanning) {
                btn.disabled = true;
                btn.innerHTML = '<span class="scan-spinner"></span> Scanning...';
            } else {
                btn.disabled = false;
                btn.innerHTML = 'Scan Saham';
            }
        }

        if (progress) {
            progress.style.display = isScanning ? 'flex' : 'none';
        }
        if (progressFill) {
            const pct = total > 0 ? (current / total) * 100 : 0;
            progressFill.style.width = `${pct}%`;
        }
        if (progressText) {
            progressText.textContent = `${current} / ${total}`;
        }
    },

    // ─── Status Bar ────────────────────────────────────────────────────
    _renderStatusBar() {
        const statusEl = document.getElementById('screenerStatus');
        if (!statusEl) return;

        const total = this._results.length;
        const filtered = this._filteredResults.length;
        const lastScan = this._lastScanTime
            ? this._lastScanTime.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
            : '—';

        statusEl.innerHTML = `
            <span>Menampilkan <strong>${filtered}</strong> dari <strong>${total}</strong> saham</span>
            <span class="screener-status-divider">|</span>
            <span>Scan terakhir: <strong>${lastScan}</strong></span>
        `;
    },

    // ─── CSV Export ────────────────────────────────────────────────────
    exportCSV() {
        if (this._filteredResults.length === 0) {
            alert('Tidak ada data untuk di-export');
            return;
        }

        const headers = this.COLUMNS.map(c => c.label);
        const rows = this._filteredResults.map(row => {
            return this.COLUMNS.map(col => {
                const val = row[col.key];
                if (val == null) return '';
                return typeof val === 'number' ? val.toFixed(2) : String(val);
            });
        });

        let csv = headers.join(',') + '\n';
        rows.forEach(r => {
            csv += r.map(v => `"${v}"`).join(',') + '\n';
        });

        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `stock_screener_${new Date().toISOString().slice(0, 10)}.csv`;
        link.click();
        URL.revokeObjectURL(url);
    },

    // ─── Helpers ───────────────────────────────────────────────────────
    _formatVolume(v) {
        if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
        if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
        if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
        return String(v);
    },

    _formatLargeNumber(v) {
        if (!v) return '—';
        if (v >= 1e12) return (v / 1e12).toFixed(1) + 'T';
        if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
        if (v >= 1e6) return (v / 1e6).toFixed(0) + 'M';
        return new Intl.NumberFormat('en-US').format(v);
    },
};
