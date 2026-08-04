/**
 * StockPulse / Stockbit Pro — Orderbook & Market Depth Manager
 * Simulates real-time IDX 10-level orderbook depth and Bandarology flow.
 */
class OrderbookManager {
    constructor() {
        this.currentSymbol = 'BBRI.JK';
        this.currentPrice = 4520;
        this.currentVolume = 50000000;
        this.bidRows = [];
        this.offerRows = [];
        this._init();
    }

    _init() {
        document.addEventListener('DOMContentLoaded', () => {
            this.render();
        });
    }

    _getIdxTickSize(price) {
        if (price < 200) return 1;
        if (price < 500) return 2;
        if (price < 2000) return 5;
        if (price < 5000) return 10;
        return 25;
    }

    _formatNumber(val) {
        return new Intl.NumberFormat('id-ID').format(Math.round(val));
    }

    update(symbol, price, volume) {
        this.currentSymbol = symbol || 'BBRI.JK';
        this.currentPrice = price > 0 ? price : 4520;
        this.currentVolume = volume > 0 ? volume : 50000000;
        this._generateDepth();
        this.render();
    }

    _generateDepth() {
        const isIdx = this.currentSymbol.endsWith('.JK');
        const tick = isIdx ? this._getIdxTickSize(this.currentPrice) : +(this.currentPrice * 0.002).toFixed(2);
        
        // Generate pseudo-random consistent lot depth based on symbol characters
        let seed = 0;
        for (let i = 0; i < this.currentSymbol.length; i++) {
            seed += this.currentSymbol.charCodeAt(i) * (i + 1);
        }

        const baseLot = isIdx ? Math.max(500, Math.floor(this.currentVolume / 50000)) : Math.floor(this.currentVolume / 500);
        
        this.bidRows = [];
        this.offerRows = [];
        
        let totalBidLot = 0;
        let totalOfferLot = 0;

        for (let i = 1; i <= 10; i++) {
            const bidPrice = isIdx ? (this.currentPrice - (i * tick)) : +(this.currentPrice - (i * tick)).toFixed(2);
            const offerPrice = isIdx ? (this.currentPrice + ((i - 1) * tick)) : +(this.currentPrice + ((i - 1) * tick)).toFixed(2);
            
            // Vary lot sizes
            const bidLot = Math.floor(baseLot * (1 + ((seed * i * 7) % 15) / 5));
            const offerLot = Math.floor(baseLot * (1 + ((seed * i * 11) % 15) / 5));

            totalBidLot += bidLot;
            totalOfferLot += offerLot;

            this.bidRows.push({ price: bidPrice > 0 ? bidPrice : tick, lot: bidLot });
            this.offerRows.push({ price: offerPrice, lot: offerLot });
        }

        this.totalBidLot = totalBidLot;
        this.totalOfferLot = totalOfferLot;

        // Bandarology calculation
        const brokers = ['YP', 'ZP', 'CC', 'BK', 'AK', 'PD', 'NI', 'MG', 'XL', 'RX', 'CS', 'KZ', 'DX'];
        const topB1 = brokers[seed % brokers.length];
        const topB2 = brokers[(seed + 3) % brokers.length];
        const topB3 = brokers[(seed + 7) % brokers.length];
        
        const topS1 = brokers[(seed + 2) % brokers.length];
        const topS2 = brokers[(seed + 5) % brokers.length];
        const topS3 = brokers[(seed + 9) % brokers.length];

        this.bandarData = {
            topBuyer: `${topB1}, ${topB2}, ${topB3}`,
            topSeller: `${topS1}, ${topS2}, ${topS3}`,
            netFlow: totalBidLot > totalOfferLot ? `+ Rp ${(totalBidLot * this.currentPrice * 100 / 1e9).toFixed(1)} M` : `- Rp ${(totalOfferLot * this.currentPrice * 100 / 1e9).toFixed(1)} M`,
            isPositive: totalBidLot >= totalOfferLot,
            status: totalBidLot > totalOfferLot * 1.2 ? 'BIG ACCUMULATION' : (totalOfferLot > totalBidLot * 1.2 ? 'BIG DISTRIBUTION' : 'NEUTRAL / NORMAL FLOW')
        };
    }

    render() {
        const tbody = document.getElementById('orderbookBody');
        if (!tbody) return;

        if (this.bidRows.length === 0) {
            this._generateDepth();
        }

        let html = '';
        for (let i = 0; i < 10; i++) {
            const bid = this.bidRows[i];
            const offer = this.offerRows[i];
            html += `
                <tr>
                    <td class="text-left bid-lot">${this._formatNumber(bid.lot)}</td>
                    <td class="text-center bid-price">${this._formatNumber(bid.price)}</td>
                    <td class="text-center offer-price">${this._formatNumber(offer.price)}</td>
                    <td class="text-right offer-lot">${this._formatNumber(offer.lot)}</td>
                </tr>
            `;
        }
        tbody.innerHTML = html;

        // Update Total Bars
        const bidText = document.getElementById('obTotalBidText');
        const offerText = document.getElementById('obTotalOfferText');
        const bidBar = document.getElementById('obTotalBidBar');
        const offerBar = document.getElementById('obTotalOfferBar');

        if (bidText && offerText && bidBar && offerBar) {
            bidText.textContent = `${this._formatNumber(this.totalBidLot)} Lot`;
            offerText.textContent = `${this._formatNumber(this.totalOfferLot)} Lot`;

            const total = this.totalBidLot + this.totalOfferLot;
            const bidPct = total > 0 ? Math.round((this.totalBidLot / total) * 100) : 50;
            const offerPct = 100 - bidPct;

            bidBar.style.width = `${bidPct}%`;
            offerBar.style.width = `${offerPct}%`;
        }

        // Update Bandarology Summary
        const tbEl = document.getElementById('topBuyerCode');
        const tsEl = document.getElementById('topSellerCode');
        const nfEl = document.getElementById('netForeignFlow');
        const bvEl = document.getElementById('bandarVolumeStatus');

        if (tbEl && tsEl && nfEl && bvEl && this.bandarData) {
            tbEl.textContent = this.bandarData.topBuyer;
            tsEl.textContent = this.bandarData.topSeller;
            nfEl.textContent = this.bandarData.netFlow;
            nfEl.className = this.bandarData.isPositive ? 'text-green font-bold' : 'text-red font-bold';
            bvEl.textContent = this.bandarData.status;
            bvEl.className = this.bandarData.isPositive ? 'text-green font-bold' : (this.bandarData.status.includes('DISTRIBUTION') ? 'text-red font-bold' : 'text-secondary font-bold');
        }
    }
}

window.OrderbookManager = new OrderbookManager();
