/**
 * StockPulse / Stockbit Pro — Virtual Portfolio & Trading Engine
 * Manages virtual brokerage cash, portfolio holdings, and instant BUY/SELL execution.
 */
class PortfolioManager {
    constructor() {
        this.storageKey = 'stockpulse_virtual_portfolio_v2';
        this.currentSymbol = 'BBRI.JK';
        this.currentPrice = 4520;
        this.livePrices = {};
        this._load();
        this._initEvents();
    }

    _load() {
        try {
            const data = localStorage.getItem(this.storageKey);
            if (data) {
                const parsed = JSON.parse(data);
                this.cash = parsed.cash ?? 100000000;
                this.holdings = parsed.holdings ?? {};
            } else {
                this.reset();
            }
        } catch (e) {
            this.reset();
        }
    }

    _save() {
        localStorage.setItem(this.storageKey, JSON.stringify({
            cash: this.cash,
            holdings: this.holdings
        }));
        this.render();
    }

    reset() {
        this.cash = 100000000; // Rp 100,000,000 starter virtual funds
        this.holdings = {
            'BBRI.JK': { symbol: 'BBRI.JK', lot: 50, avgPrice: 4420 },
            'BBCA.JK': { symbol: 'BBCA.JK', lot: 30, avgPrice: 6350 }
        };
        this.livePrices['BBRI.JK'] = 4520;
        this.livePrices['BBCA.JK'] = 6500;
        this._save();
    }

    _initEvents() {
        document.addEventListener('DOMContentLoaded', () => {
            const btnBuy = document.getElementById('btnExecuteBuy');
            const btnSell = document.getElementById('btnExecuteSell');
            const btnReset = document.getElementById('btnResetPortfolio');
            const inputPrice = document.getElementById('orderPriceInput');
            const inputLot = document.getElementById('orderLotInput');

            if (btnBuy) btnBuy.addEventListener('click', () => this.executeOrder('BUY'));
            if (btnSell) btnSell.addEventListener('click', () => this.executeOrder('SELL'));
            if (btnReset) btnReset.addEventListener('click', () => {
                if (confirm('Reset akun trading virtual kembali ke modal Rp 100,000,000?')) {
                    this.reset();
                    this._showToast('Akun berhasil direset ke Rp 100.000.000', 'info');
                }
            });

            if (inputPrice && inputLot) {
                const updateEst = () => this._updateEstValue();
                inputPrice.addEventListener('input', updateEst);
                inputLot.addEventListener('input', updateEst);
            }

            this.render();
        });
    }

    updateCurrentStock(symbol, price) {
        this.currentSymbol = symbol || 'BBRI.JK';
        if (price > 0) {
            this.currentPrice = price;
            this.livePrices[symbol] = price;
        }

        const symbolInput = document.getElementById('orderSymbolInput');
        const priceInput = document.getElementById('orderPriceInput');
        if (symbolInput) symbolInput.value = this.currentSymbol;
        if (priceInput) priceInput.value = this.currentPrice;

        this._updateEstValue();
        this.render();
    }

    _updateEstValue() {
        const priceInput = document.getElementById('orderPriceInput');
        const lotInput = document.getElementById('orderLotInput');
        const estValueEl = document.getElementById('orderEstValue');

        if (!priceInput || !lotInput || !estValueEl) return;

        const price = parseFloat(priceInput.value) || 0;
        const lot = parseInt(lotInput.value) || 0;
        const isIdx = this.currentSymbol.endsWith('.JK');
        const total = price * lot * (isIdx ? 100 : 1);

        estValueEl.textContent = this._formatCurrency(total, isIdx);
    }

    _formatCurrency(val, isIdx = true) {
        if (isNaN(val)) return 'Rp 0';
        if (isIdx) {
            return 'Rp ' + new Intl.NumberFormat('id-ID').format(Math.round(val));
        }
        return '$ ' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);
    }

    executeOrder(type) {
        const priceInput = document.getElementById('orderPriceInput');
        const lotInput = document.getElementById('orderLotInput');

        if (!priceInput || !lotInput) return;

        const price = parseFloat(priceInput.value) || 0;
        const lot = parseInt(lotInput.value) || 0;

        if (price <= 0 || lot <= 0) {
            this._showToast('Harga dan jumlah lot harus lebih besar dari 0!', 'error');
            return;
        }

        const isIdx = this.currentSymbol.endsWith('.JK');
        const orderValue = price * lot * (isIdx ? 100 : 1);

        if (type === 'BUY') {
            if (this.cash < orderValue) {
                this._showToast(`Cash tidak mencukupi! Dibutuhkan: ${this._formatCurrency(orderValue, isIdx)}`, 'error');
                return;
            }

            // Execute BUY
            this.cash -= orderValue;
            const existing = this.holdings[this.currentSymbol];
            if (existing) {
                const totalLot = existing.lot + lot;
                const totalSpend = (existing.lot * existing.avgPrice) + (lot * price);
                existing.avgPrice = totalSpend / totalLot;
                existing.lot = totalLot;
            } else {
                this.holdings[this.currentSymbol] = {
                    symbol: this.currentSymbol,
                    lot: lot,
                    avgPrice: price
                };
            }
            this._showToast(`BUY ${lot} Lot ${this.currentSymbol} Berhasil!`, 'success');
            this._save();

        } else if (type === 'SELL') {
            const existing = this.holdings[this.currentSymbol];
            if (!existing || existing.lot < lot) {
                const owned = existing ? existing.lot : 0;
                this._showToast(`Lot tidak mencukupi untuk jual! Kamu hanya memiliki ${owned} Lot.`, 'error');
                return;
            }

            // Execute SELL
            this.cash += orderValue;
            existing.lot -= lot;
            if (existing.lot === 0) {
                delete this.holdings[this.currentSymbol];
            }
            this._showToast(`SELL ${lot} Lot ${this.currentSymbol} Berhasil!`, 'success');
            this._save();
        }
    }

    _showToast(msg, type = 'info') {
        const container = document.getElementById('toastContainer');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = msg;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }

    render() {
        const elTotalAsset = document.getElementById('portTotalAsset');
        const elCash = document.getElementById('portCashAvailable');
        const elInvested = document.getElementById('portInvested');
        const elFloating = document.getElementById('portFloatingPL');
        const tbody = document.getElementById('holdingsTableBody');

        let totalInvested = 0;
        let totalMarketValue = 0;
        let html = '';

        const keys = Object.keys(this.holdings);
        if (keys.length === 0) {
            if (tbody) {
                tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted py-4">Belum ada posisi saham aktif. Mulai trading di menu Form Order!</td></tr>';
            }
        } else {
            for (const sym of keys) {
                const item = this.holdings[sym];
                const livePrice = this.livePrices[sym] || item.avgPrice;
                const isIdx = sym.endsWith('.JK');
                const multiplier = isIdx ? 100 : 1;

                const investedValue = item.lot * item.avgPrice * multiplier;
                const marketValue = item.lot * livePrice * multiplier;
                const floatingPL = marketValue - investedValue;
                const floatingPct = investedValue > 0 ? (floatingPL / investedValue) * 100 : 0;

                totalInvested += investedValue;
                totalMarketValue += marketValue;

                const plClass = floatingPL >= 0 ? 'text-green font-bold' : 'text-red font-bold';
                const sign = floatingPL >= 0 ? '+' : '';

                html += `
                    <tr>
                        <td class="font-bold text-primary">${sym}</td>
                        <td class="mono">${new Intl.NumberFormat('id-ID').format(Math.round(item.avgPrice))}</td>
                        <td class="mono">${new Intl.NumberFormat('id-ID').format(Math.round(livePrice))}</td>
                        <td class="mono text-center">${item.lot} Lot</td>
                        <td class="mono">${this._formatCurrency(marketValue, isIdx)}</td>
                        <td class="mono ${plClass}">${sign}${this._formatCurrency(floatingPL, isIdx)}</td>
                        <td class="mono ${plClass}">${sign}${floatingPct.toFixed(2)}%</td>
                        <td class="text-center">
                            <button class="chip-lot" onclick="window.PortfolioManager.selectForOrder('${sym}')">Pilih Order</button>
                        </td>
                    </tr>
                `;
            }
            if (tbody) tbody.innerHTML = html;
        }

        const totalAsset = this.cash + totalMarketValue;
        const totalFloatingPL = totalMarketValue - totalInvested;
        const totalFloatingPct = totalInvested > 0 ? (totalFloatingPL / totalInvested) * 100 : 0;

        if (elTotalAsset) elTotalAsset.textContent = this._formatCurrency(totalAsset, true);
        if (elCash) elCash.textContent = this._formatCurrency(this.cash, true);
        if (elInvested) elInvested.textContent = this._formatCurrency(totalInvested, true);
        
        if (elFloating) {
            const sign = totalFloatingPL >= 0 ? '+' : '';
            elFloating.textContent = `${sign}${this._formatCurrency(totalFloatingPL, true)} (${sign}${totalFloatingPct.toFixed(2)}%)`;
            elFloating.className = `mono ${totalFloatingPL >= 0 ? 'text-green font-bold' : 'text-red font-bold'}`;
        }
    }

    selectForOrder(symbol) {
        const live = this.livePrices[symbol] || 0;
        this.updateCurrentStock(symbol, live > 0 ? live : 4520);
        const orderInput = document.getElementById('orderLotInput');
        if (orderInput) orderInput.focus();
    }
}

window.PortfolioManager = new PortfolioManager();
