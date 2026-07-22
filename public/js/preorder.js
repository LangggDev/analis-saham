/**
 * Pre-Order Manager Module
 * Manages pre-orders during off-market hours.
 * Orders are stored in localStorage for persistence.
 */

const PreOrderManager = {

    STORAGE_KEY: 'stockpulse_preorders',
    orders: [],
    _onUpdate: null, // callback when orders change

    /**
     * Initialize the pre-order manager
     * @param {Function} onUpdate - Callback(orders) when orders change
     */
    init(onUpdate) {
        this._onUpdate = onUpdate;
        this._load();
        this._checkExpired();
    },

    /**
     * Create a new pre-order
     * @param {Object} order - Order details
     * @returns {Object} The created order with generated ID
     */
    createOrder({ symbol, type, targetPrice, quantity, stopLoss, takeProfitPrice, notes }) {
        const order = {
            id: this._generateId(),
            symbol: (symbol || '').toUpperCase().trim(),
            type: type || 'BUY', // BUY or SELL
            targetPrice: parseFloat(targetPrice) || 0,
            quantity: parseInt(quantity) || 0,
            stopLoss: stopLoss ? parseFloat(stopLoss) : null,
            takeProfitPrice: takeProfitPrice ? parseFloat(takeProfitPrice) : null,
            notes: notes || '',
            status: 'PENDING', // PENDING, READY, EXECUTED, CANCELLED, EXPIRED
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            executedAt: null,
        };

        // Validate
        if (!order.symbol) throw new Error('Symbol wajib diisi');
        if (order.targetPrice <= 0) throw new Error('Target harga harus > 0');
        if (order.quantity <= 0) throw new Error('Jumlah lot harus > 0');

        this.orders.unshift(order);
        this._save();
        this._notify();
        return order;
    },

    /**
     * Update an existing order
     * @param {string} id - Order ID
     * @param {Object} updates - Fields to update
     */
    updateOrder(id, updates) {
        const idx = this.orders.findIndex(o => o.id === id);
        if (idx === -1) throw new Error('Order tidak ditemukan');

        const order = this.orders[idx];
        if (order.status === 'EXECUTED' || order.status === 'CANCELLED') {
            throw new Error('Order yang sudah dieksekusi/dibatalkan tidak bisa diubah');
        }

        // Apply updates
        if (updates.targetPrice !== undefined) order.targetPrice = parseFloat(updates.targetPrice) || 0;
        if (updates.quantity !== undefined) order.quantity = parseInt(updates.quantity) || 0;
        if (updates.stopLoss !== undefined) order.stopLoss = updates.stopLoss ? parseFloat(updates.stopLoss) : null;
        if (updates.takeProfitPrice !== undefined) order.takeProfitPrice = updates.takeProfitPrice ? parseFloat(updates.takeProfitPrice) : null;
        if (updates.notes !== undefined) order.notes = updates.notes;
        if (updates.type !== undefined) order.type = updates.type;
        order.updatedAt = new Date().toISOString();

        this._save();
        this._notify();
    },

    /**
     * Mark an order as executed
     * @param {string} id - Order ID
     */
    markExecuted(id) {
        const order = this.orders.find(o => o.id === id);
        if (!order) throw new Error('Order tidak ditemukan');
        order.status = 'EXECUTED';
        order.executedAt = new Date().toISOString();
        order.updatedAt = new Date().toISOString();
        this._save();
        this._notify();
    },

    /**
     * Cancel an order
     * @param {string} id - Order ID
     */
    cancelOrder(id) {
        const order = this.orders.find(o => o.id === id);
        if (!order) throw new Error('Order tidak ditemukan');
        order.status = 'CANCELLED';
        order.updatedAt = new Date().toISOString();
        this._save();
        this._notify();
    },

    /**
     * Delete an order permanently
     * @param {string} id - Order ID
     */
    deleteOrder(id) {
        this.orders = this.orders.filter(o => o.id !== id);
        this._save();
        this._notify();
    },

    /**
     * Get active (non-completed) orders
     * @returns {Array}
     */
    getActiveOrders() {
        return this.orders.filter(o => o.status === 'PENDING' || o.status === 'READY');
    },

    /**
     * Get all orders
     * @returns {Array}
     */
    getAllOrders() {
        return [...this.orders];
    },

    /**
     * Get orders for a specific symbol
     * @param {string} symbol
     * @returns {Array}
     */
    getOrdersBySymbol(symbol) {
        return this.orders.filter(o => o.symbol === symbol.toUpperCase());
    },

    /**
     * Get order count badge text
     * @returns {string}
     */
    getActiveCount() {
        return this.getActiveOrders().length;
    },

    /**
     * Update order statuses based on market state
     * @param {string} marketState - 'OPEN', 'CLOSED', 'PRE_MARKET'
     */
    updateMarketState(marketState) {
        let changed = false;
        for (const order of this.orders) {
            if (order.status === 'PENDING' && marketState === 'OPEN') {
                order.status = 'READY';
                order.updatedAt = new Date().toISOString();
                changed = true;
            } else if (order.status === 'READY' && marketState !== 'OPEN') {
                order.status = 'PENDING';
                order.updatedAt = new Date().toISOString();
                changed = true;
            }
        }
        if (changed) {
            this._save();
            this._notify();
        }
    },

    /**
     * Export orders as CSV text
     * @returns {string}
     */
    exportCSV() {
        const headers = ['Symbol', 'Type', 'Target Price', 'Quantity', 'Stop Loss', 'Take Profit', 'Status', 'Notes', 'Created At'];
        const rows = this.orders.map(o => [
            o.symbol,
            o.type,
            o.targetPrice,
            o.quantity,
            o.stopLoss || '',
            o.takeProfitPrice || '',
            o.status,
            `"${(o.notes || '').replace(/"/g, '""')}"`,
            o.createdAt,
        ].join(','));

        return [headers.join(','), ...rows].join('\n');
    },

    /**
     * Download orders as CSV file
     */
    downloadCSV() {
        const csv = this.exportCSV();
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `preorders_${new Date().toISOString().slice(0, 10)}.csv`;
        link.click();
        URL.revokeObjectURL(url);
    },

    /**
     * Calculate estimated total cost/value for an order
     * @param {Object} order
     * @param {boolean} isIDR - Whether the stock is IDR-denominated
     * @returns {number}
     */
    calculateTotal(order, isIDR = false) {
        const lotSize = isIDR ? 100 : 1; // IDX: 1 lot = 100 shares
        return order.targetPrice * order.quantity * lotSize;
    },

    /**
     * Calculate potential profit/loss
     * @param {Object} order
     * @param {number} currentPrice
     * @param {boolean} isIDR
     * @returns {{profit: number, profitPct: number, risk: number, riskPct: number, riskReward: string}}
     */
    calculateRiskReward(order, currentPrice, isIDR = false) {
        const lotSize = isIDR ? 100 : 1;
        const totalShares = order.quantity * lotSize;

        let profit = 0, risk = 0;
        if (order.type === 'BUY') {
            if (order.takeProfitPrice) {
                profit = (order.takeProfitPrice - order.targetPrice) * totalShares;
            }
            if (order.stopLoss) {
                risk = (order.targetPrice - order.stopLoss) * totalShares;
            }
        } else {
            // SELL
            if (order.takeProfitPrice) {
                profit = (order.targetPrice - order.takeProfitPrice) * totalShares;
            }
            if (order.stopLoss) {
                risk = (order.stopLoss - order.targetPrice) * totalShares;
            }
        }

        const profitPct = order.targetPrice > 0 && order.takeProfitPrice
            ? ((order.takeProfitPrice - order.targetPrice) / order.targetPrice * 100 * (order.type === 'BUY' ? 1 : -1))
            : 0;

        const riskPct = order.targetPrice > 0 && order.stopLoss
            ? ((order.targetPrice - order.stopLoss) / order.targetPrice * 100 * (order.type === 'BUY' ? 1 : -1))
            : 0;

        const rr = risk > 0 ? (profit / risk).toFixed(2) : '∞';

        return {
            profit,
            profitPct: parseFloat(profitPct.toFixed(2)),
            risk: Math.abs(risk),
            riskPct: parseFloat(Math.abs(riskPct).toFixed(2)),
            riskReward: `1:${rr}`,
        };
    },

    /* ─── Internal Methods ──────────────────────────────────────── */

    _load() {
        try {
            const saved = localStorage.getItem(this.STORAGE_KEY);
            if (saved) {
                this.orders = JSON.parse(saved);
            }
        } catch (e) {
            console.warn('Failed to load pre-orders from localStorage:', e);
            this.orders = [];
        }
    },

    _save() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.orders));
        } catch (e) {
            console.warn('Failed to save pre-orders to localStorage:', e);
        }
    },

    _notify() {
        if (this._onUpdate) {
            this._onUpdate(this.orders);
        }
    },

    _checkExpired() {
        const now = new Date();
        let changed = false;
        for (const order of this.orders) {
            if (order.status === 'PENDING' || order.status === 'READY') {
                const created = new Date(order.createdAt);
                const age = now - created;
                // Expire orders older than 7 days
                if (age > 7 * 24 * 60 * 60 * 1000) {
                    order.status = 'EXPIRED';
                    order.updatedAt = now.toISOString();
                    changed = true;
                }
            }
        }
        if (changed) {
            this._save();
            this._notify();
        }
    },

    _generateId() {
        return 'po_' + Date.now().toString(36) + '_' + Math.random().toString(36).substr(2, 6);
    },

    /**
     * Get status badge config
     * @param {string} status
     * @returns {{label: string, class: string, icon: string}}
     */
    getStatusConfig(status) {
        const configs = {
            'PENDING': { label: 'Menunggu', class: 'status-pending', icon: '⏳' },
            'READY': { label: 'Siap Eksekusi', class: 'status-ready', icon: '🟢' },
            'EXECUTED': { label: 'Tereksekusi', class: 'status-executed', icon: '✅' },
            'CANCELLED': { label: 'Dibatalkan', class: 'status-cancelled', icon: '❌' },
            'EXPIRED': { label: 'Kedaluwarsa', class: 'status-expired', icon: '⏰' },
        };
        return configs[status] || configs['PENDING'];
    },
};
