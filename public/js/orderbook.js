/**
 * StockPulse / Stockbit Pro — Orderbook & Market Depth Manager
 * Institutional real-time IDX 10-level orderbook depth simulation with live breathing queues and Bandarology flow.
 */
class OrderbookManager {
    constructor() {
        this.currentSymbol = 'BBRI.JK';
        this.currentPrice = 4520;
        this.currentVolume = 50000000;
        this.bidRows = [];
        this.offerRows = [];
        this.tickerInterval = null;
        this._init();
    }

    _init() {
        document.addEventListener('DOMContentLoaded', () => {
            this.render();
            this._startLiveTicker();
        });
    }

    // Aturan Resmi Fraksi Harga Bursa Efek Indonesia (IDX)
    _getIdxTickSize(price) {
        if (price < 200) return 1;
        if (price < 500) return 2;
        if (price < 2000) return 5;
        if (price < 5000) return 10;
        return 25;
    }

    // Algoritma penelusuran level antrean mematuhi perpindahan batas fraksi harga IDX
    _stepPrice(startPrice, steps, isIdx = true) {
        if (!isIdx) {
            return parseFloat((startPrice + (steps * startPrice * 0.002)).toFixed(2));
        }
        let curr = startPrice;
        if (steps < 0) {
            for (let s = 0; s < Math.abs(steps); s++) {
                let tick = this._getIdxTickSize(curr - 0.01);
                curr = Math.max(1, curr - tick);
            }
        } else {
            for (let s = 0; s < steps; s++) {
                let tick = this._getIdxTickSize(curr);
                curr = curr + tick;
            }
        }
        return Math.round(curr);
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
        
        // Generate seed yang konsisten berdasarkan nama simbol
        let seed = 0;
        for (let i = 0; i < this.currentSymbol.length; i++) {
            seed += this.currentSymbol.charCodeAt(i) * (i + 1);
        }

        const baseLot = isIdx ? Math.max(800, Math.floor(this.currentVolume / 25000)) : Math.floor(this.currentVolume / 300);
        
        this.bidRows = [];
        this.offerRows = [];
        
        let totalBidLot = 0;
        let totalOfferLot = 0;

        for (let i = 1; i <= 10; i++) {
            const bidPrice = this._stepPrice(this.currentPrice, -i, isIdx);
            const offerPrice = this._stepPrice(this.currentPrice, (i - 1), isIdx);
            
            // Simulasi Tembok Bandar (Order Wall) pada angka bulat psikologis
            let bidMultiplier = (1 + ((seed * i * 7) % 18) / 5);
            let offerMultiplier = (1 + ((seed * i * 11) % 18) / 5);

            if (bidPrice % 500 === 0 || bidPrice % 100 === 0) bidMultiplier *= 3.8;
            else if (bidPrice % 50 === 0) bidMultiplier *= 2.1;

            if (offerPrice % 500 === 0 || offerPrice % 100 === 0) offerMultiplier *= 3.8;
            else if (offerPrice % 50 === 0) offerMultiplier *= 2.1;

            const bidLot = Math.floor(baseLot * bidMultiplier);
            const offerLot = Math.floor(baseLot * offerMultiplier);

            totalBidLot += bidLot;
            totalOfferLot += offerLot;

            this.bidRows.push({ price: bidPrice, lot: bidLot });
            this.offerRows.push({ price: offerPrice, lot: offerLot });
        }

        this.totalBidLot = totalBidLot;
        this.totalOfferLot = totalOfferLot;

        this._calculateBandarology(seed);
    }

    _calculateBandarology(seed) {
        // Broker Institusional & Asing Tertentu
        const foreignBrokers = ['ZP', 'BK', 'RX', 'AK', 'CS', 'KZ', 'MG', 'BB', 'CC', 'DX'];
        const retailBrokers = ['YP', 'PD', 'NI', 'SQ', 'KK', 'XL', 'XC', 'GR', 'HP'];
        
        const isAccumulation = this.totalBidLot > this.totalOfferLot;
        
        let topBuyer, topSeller;
        if (isAccumulation) {
            const b1 = foreignBrokers[seed % foreignBrokers.length];
            const b2 = foreignBrokers[(seed + 3) % foreignBrokers.length];
            const b3 = foreignBrokers[(seed + 6) % foreignBrokers.length];
            const s1 = retailBrokers[(seed + 2) % retailBrokers.length];
            const s2 = retailBrokers[(seed + 4) % retailBrokers.length];
            const s3 = retailBrokers[(seed + 7) % retailBrokers.length];
            topBuyer = `${b1}, ${b2}, ${b3}`;
            topSeller = `${s1}, ${s2}, ${s3}`;
        } else {
            const b1 = retailBrokers[seed % retailBrokers.length];
            const b2 = retailBrokers[(seed + 3) % retailBrokers.length];
            const b3 = retailBrokers[(seed + 5) % retailBrokers.length];
            const s1 = foreignBrokers[(seed + 1) % foreignBrokers.length];
            const s2 = foreignBrokers[(seed + 4) % foreignBrokers.length];
            const s3 = foreignBrokers[(seed + 7) % foreignBrokers.length];
            topBuyer = `${b1}, ${b2}, ${b3}`;
            topSeller = `${s1}, ${s2}, ${s3}`;
        }

        const netValRp = (Math.abs(this.totalBidLot - this.totalOfferLot) * this.currentPrice * 100) / 1e9;
        const formattedNet = netValRp >= 1 ? `Rp ${netValRp.toFixed(1)} Miliar` : `Rp ${(netValRp * 1000).toFixed(0)} Juta`;
        
        let status = 'NEUTRAL / NORMAL FLOW';
        if (this.totalBidLot > this.totalOfferLot * 1.35) status = '🔥 BIG ACCUMULATION';
        else if (this.totalBidLot > this.totalOfferLot * 1.05) status = '🟢 MODERATE ACCUMULATION';
        else if (this.totalOfferLot > this.totalBidLot * 1.35) status = '⚠️ BIG DISTRIBUTION';
        else if (this.totalOfferLot > this.totalBidLot * 1.05) status = '🔴 MODERATE DISTRIBUTION';

        this.bandarData = {
            topBuyer,
            topSeller,
            netFlow: isAccumulation ? `+ ${formattedNet}` : `- ${formattedNet}`,
            isPositive: isAccumulation,
            status
        };
    }

    // Simulasi antrean aktif berdenyut (Live Order Flow Animation)
    _startLiveTicker() {
        if (this.tickerInterval) clearInterval(this.tickerInterval);
        this.tickerInterval = setInterval(() => {
            const tbody = document.getElementById('orderbookBody');
            if (!tbody || this.bidRows.length === 0 || this.offerRows.length === 0) return;

            const isBid = Math.random() > 0.45;
            const idx = Math.floor(Math.random() * 10);
            const deltaPct = (Math.random() * 0.12) - 0.05; // -5% hingga +7% perubahan lot
            
            if (isBid) {
                const row = this.bidRows[idx];
                const oldLot = row.lot;
                row.lot = Math.max(100, Math.floor(oldLot * (1 + deltaPct)));
                this.totalBidLot += (row.lot - oldLot);
                this._updateRowDom(tbody, idx, 'bid', row.lot, row.lot >= oldLot ? 'flash-bid' : 'flash-offer');
            } else {
                const row = this.offerRows[idx];
                const oldLot = row.lot;
                row.lot = Math.max(100, Math.floor(oldLot * (1 + deltaPct)));
                this.totalOfferLot += (row.lot - oldLot);
                this._updateRowDom(tbody, idx, 'offer', row.lot, row.lot >= oldLot ? 'flash-offer' : 'flash-bid');
            }
            this._updateSummaryDom();
        }, 1800);
    }

    _updateRowDom(tbody, rowIndex, side, newLot, flashClass) {
        const trs = tbody.getElementsByTagName('tr');
        if (!trs || !trs[rowIndex]) return;
        const cellIdx = side === 'bid' ? 0 : 3;
        const td = trs[rowIndex].getElementsByTagName('td')[cellIdx];
        if (td) {
            td.textContent = this._formatNumber(newLot);
            td.classList.add(flashClass);
            setTimeout(() => td.classList.remove(flashClass), 600);
        }
    }

    _updateSummaryDom() {
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
        this._updateSummaryDom();

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
