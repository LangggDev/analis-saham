/**
 * StockPulse — Journal & Authentication & Pre-Order Integration Module (journal.js)
 * Clean Stockbit-style UI: Zero Emojis, Pure Professional Vector SVG Icons.
 */

const JournalManager = {
    token: null,
    user: null,
    evaluationData: null,
    transactions: [],
    preOrders: [],
    activeHoldings: {},
    activeSubTab: 'realized',

    init() {
        this.token = localStorage.getItem('stockpulse_jwt');
        try {
            const cachedUser = localStorage.getItem('stockpulse_user');
            if (cachedUser) this.user = JSON.parse(cachedUser);
            const cachedHoldings = localStorage.getItem('stockpulse_active_holdings');
            if (cachedHoldings) this.activeHoldings = JSON.parse(cachedHoldings);
        } catch (e) {
            this.user = null;
            this.activeHoldings = {};
        }
        this.loadPreOrders();
        this.bindHeaderEvents();
        if (this.token) {
            if (this.user) {
                this.updateAuthUI();
            }
            this.verifySession();
            this.syncHoldingsInBackground();
        } else {
            this.updateAuthUI();
        }
    },

    bindHeaderEvents() {
        const authBtn = document.getElementById('btnAuthToggle');
        if (authBtn) {
            authBtn.addEventListener('click', () => {
                if (this.token && this.user) {
                    this.showProfileModal();
                } else {
                    this.showAuthModal('login');
                }
            });
        }
    },

    loadPreOrders() {
        try {
            const saved = localStorage.getItem('stockpulse_preorders');
            this.preOrders = saved ? JSON.parse(saved) : [];
        } catch (e) {
            this.preOrders = [];
        }
    },

    savePreOrders() {
        localStorage.setItem('stockpulse_preorders', JSON.stringify(this.preOrders));
    },

    async verifySession() {
        try {
            const res = await fetch('/api/auth/me', {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (res.status === 401 || res.status === 403) {
                this.logout(false);
                return;
            }
            if (!res.ok) {
                console.warn('[Session Sync]: Server merespons dengan error, tetap menggunakan cache sesi lokal.');
                return;
            }
            const data = await res.json();
            this.user = data.user;
            localStorage.setItem('stockpulse_user', JSON.stringify(this.user));
            this.updateAuthUI();
        } catch (e) {
            console.warn('[Session Offline]: Gagal terhubung ke server, tetap mempertahankan sesi lokal:', e.message);
        }
    },

    async syncHoldingsInBackground() {
        if (!this.token || !this.user) return;
        try {
            const res = await fetch('/api/transactions', {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (res.ok) {
                const data = await res.json();
                this.transactions = data.transactions || [];
                this.evaluationData = data.evaluation || {};
                this.updateHoldingsCache(data.evaluation?.holdings || {});
            }
        } catch (e) {
            console.warn('[Holdings Sync Offline]: Menggunakan cache posisi aktif lokal.');
        }
    },

    updateHoldingsCache(rawHoldings) {
        const active = {};
        Object.keys(rawHoldings || {}).forEach(sym => {
            const h = rawHoldings[sym];
            if (h && h.qty > 0) {
                active[sym] = {
                    qty: Number(h.qty),
                    cost: Number(h.cost || 0),
                    avgPrice: Number(h.avgPrice || Math.round(h.cost / h.qty))
                };
            }
        });
        this.activeHoldings = active;
        localStorage.setItem('stockpulse_active_holdings', JSON.stringify(active));
        
        // Auto-insert any purchased stock into Watchlist and trigger resort
        if (window.app && window.app.watchlist) {
            let changed = false;
            Object.keys(active).forEach(sym => {
                if (!window.app.watchlist.symbols.includes(sym)) {
                    window.app.watchlist.symbols.push(sym);
                    changed = true;
                }
            });
            if (changed) window.app.watchlist._save();
            window.app.watchlist.render();
        }
        
        // Update quick monitoring bar in symbol header if available
        if (typeof window.updateQuickMonitoringBar === 'function') {
            window.updateQuickMonitoringBar();
        }
    },

    monitorStock(symbol) {
        if (window.app) {
            window.app.loadSymbol(symbol);
            window.app._switchTab('quote');
            this.showToast('Memantau chart dan analisa real-time saham ' + symbol);
        }
    },

    updateAuthUI() {
        const authBtn = document.getElementById('btnAuthToggle');
        if (!authBtn) return;

        if (this.user && this.token) {
            authBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg> <span>${this.user.username.toUpperCase()}</span>`;
            authBtn.classList.add('logged-in');
            if (window.app && window.app.watchlist) {
                window.app.watchlist.syncWithCloud();
            }
        } else {
            authBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg> <span>Login / Register</span>`;
            authBtn.classList.remove('logged-in');
        }
    },

    showAuthModal(activeTab = 'login') {
        let modal = document.getElementById('authModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'authModal';
            modal.className = 'modal-backdrop';
            document.body.appendChild(modal);
        }

        modal.innerHTML = `
            <div class="modal-card auth-modal-card">
                <div class="modal-header">
                    <h3>Akses Akun StockPulse</h3>
                    <button class="modal-close" onclick="JournalManager.closeModal('authModal')">&times;</button>
                </div>
                <div class="auth-tabs">
                    <button class="auth-tab-btn ${activeTab === 'login' ? 'active' : ''}" onclick="JournalManager.switchAuthTab('login')">Masuk (Login)</button>
                    <button class="auth-tab-btn ${activeTab === 'register' ? 'active' : ''}" onclick="JournalManager.switchAuthTab('register')">Daftar (Register)</button>
                </div>
                
                <div id="authFormContent" class="modal-body">
                    ${activeTab === 'login' ? this.getLoginFormHTML() : this.getRegisterFormHTML()}
                </div>
            </div>
        `;
        modal.style.display = 'flex';
    },

    switchAuthTab(tab) {
        const btns = document.querySelectorAll('.auth-tab-btn');
        if (btns.length >= 2) {
            btns[0].classList.toggle('active', tab === 'login');
            btns[1].classList.toggle('active', tab === 'register');
        }
        const content = document.getElementById('authFormContent');
        if (content) {
            content.innerHTML = tab === 'login' ? this.getLoginFormHTML() : this.getRegisterFormHTML();
        }
    },

    getLoginFormHTML() {
        return `
            <form onsubmit="JournalManager.handleLogin(event)" class="auth-form">
                <div class="form-group">
                    <label>Username atau Email</label>
                    <input type="text" id="loginInput" placeholder="Masukkan username atau email Anda..." required autofocus>
                </div>
                <div class="form-group">
                    <label>Kata Sandi (Password)</label>
                    <input type="password" id="passwordInput" placeholder="••••••••" required>
                </div>
                <div class="form-group form-remember-me">
                    <label class="checkbox-remember">
                        <input type="checkbox" id="rememberMeInput" checked>
                        <span>Ingat Saya (Tetap login di perangkat ini)</span>
                    </label>
                </div>
                <div id="authErrorMsg" class="auth-error" style="display:none;"></div>
                <button type="submit" class="btn-submit-neon">Masuk ke Dashboard</button>
            </form>
        `;
    },

    getRegisterFormHTML() {
        return `
            <form onsubmit="JournalManager.handleRegister(event)" class="auth-form">
                <div class="form-group">
                    <label>Username</label>
                    <input type="text" id="regUsername" placeholder="Contoh: trader_pro" required autofocus pattern="[a-zA-Z0-9_]{3,30}" title="3-30 karakter alfanumerik">
                </div>
                <div class="form-group">
                    <label>Alamat Email</label>
                    <input type="email" id="regEmail" placeholder="nama@email.com" required>
                </div>
                <div class="form-group">
                    <label>Kata Sandi (Min. 8 Karakter + Kombinasi Angka)</label>
                    <input type="password" id="regPassword" placeholder="Minimal 8 karakter (huruf & angka)" minlength="8" required>
                    <small class="form-hint" style="color:var(--text-muted); font-size:0.75rem; display:block; margin-top:2px;">Contoh: Rahasia123</small>
                </div>

                <div class="form-group tier-selector-group">
                    <label>Pilih Paket Keanggotaan</label>
                    <div class="tier-cards">
                        <label class="tier-card active">
                            <input type="radio" name="regTier" value="FREE" checked onchange="JournalManager.togglePaymentMethodUI(false)">
                            <div class="tier-info">
                                <strong>Free Starter</strong>
                                <span>Rp 0 / Selamanya</span>
                            </div>
                        </label>
                        <label class="tier-card tier-pro-card">
                            <input type="radio" name="regTier" value="PRO" onchange="JournalManager.togglePaymentMethodUI(true)">
                            <div class="tier-info">
                                <strong>PRO Member <span class="badge-pro">POPULER</span></strong>
                                <span>Rp 99.000 / bulan</span>
                            </div>
                        </label>
                    </div>
                </div>

                <div id="paymentMethodGroup" class="form-group" style="display:none;">
                    <label>Metode Pembayaran</label>
                    <select id="regPaymentMethod">
                        <option value="QRIS">QRIS (GoPay, OVO, Dana, ShopeePay, BCA, All Bank)</option>
                        <option value="VA_BCA">Virtual Account BCA</option>
                        <option value="VA_MANDIRI">Virtual Account Mandiri</option>
                    </select>
                </div>

                <div id="authErrorMsg" class="auth-error" style="display:none;"></div>
                <button type="submit" class="btn-submit-neon">Daftar Akun Baru</button>
            </form>
        `;
    },

    togglePaymentMethodUI(show) {
        const pmGroup = document.getElementById('paymentMethodGroup');
        if (pmGroup) pmGroup.style.display = show ? 'block' : 'none';
    },

    async handleLogin(e) {
        e.preventDefault();
        const loginVal = document.getElementById('loginInput').value;
        const passVal = document.getElementById('passwordInput').value;
        const rememberVal = document.getElementById('rememberMeInput')?.checked ?? true;
        const errorDiv = document.getElementById('authErrorMsg');

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ login: loginVal, password: passVal, remember_me: rememberVal })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Login gagal.');

            this.token = data.token;
            this.user = data.user;
            localStorage.setItem('stockpulse_jwt', this.token);
            localStorage.setItem('stockpulse_user', JSON.stringify(this.user));
            this.updateAuthUI();
            this.closeModal('authModal');
            this.showToast('Selamat datang kembali, ' + this.user.username.toUpperCase());

            if (this.user.tier === 'PRO' && this.user.payment_status === 'UNPAID') {
                this.initiateCheckout(this.user.payment_method || 'QRIS');
            } else if (document.getElementById('journalTabContent')?.style.display !== 'none') {
                this.loadAndRenderJournal();
            }
        } catch (err) {
            errorDiv.innerText = err.message;
            errorDiv.style.display = 'block';
        }
    },

    async handleRegister(e) {
        e.preventDefault();
        const userVal = document.getElementById('regUsername').value;
        const emailVal = document.getElementById('regEmail').value;
        const passVal = document.getElementById('regPassword').value;
        const selectedTier = document.querySelector('input[name="regTier"]:checked')?.value || 'FREE';
        const paymentMethod = document.getElementById('regPaymentMethod')?.value || 'QRIS';
        const errorDiv = document.getElementById('authErrorMsg');

        try {
            const res = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: userVal,
                    email: emailVal,
                    password: passVal,
                    selected_tier: selectedTier,
                    payment_method: paymentMethod
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Registrasi gagal.');

            this.token = data.token;
            this.user = data.user;
            localStorage.setItem('stockpulse_jwt', this.token);
            localStorage.setItem('stockpulse_user', JSON.stringify(this.user));
            this.updateAuthUI();
            this.closeModal('authModal');

            if (selectedTier === 'PRO') {
                this.initiateCheckout(paymentMethod);
            } else {
                this.showToast('Akun Free Starter berhasil terdaftar.');
                if (document.getElementById('journalTabContent')?.style.display !== 'none') {
                    this.loadAndRenderJournal();
                }
            }
        } catch (err) {
            errorDiv.innerText = err.message;
            errorDiv.style.display = 'block';
        }
    },

    async initiateCheckout(method = 'QRIS') {
        try {
            const res = await fetch('/api/payment/checkout', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({ method })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Gagal menyiapkan tagihan pembayaran.');

            // Jika Midtrans Snap aktif, buka jendela popup pembayaran asli
            if (data.useSnap && window.snap) {
                window.snap.pay(data.snapToken, {
                    onSuccess: async (result) => {
                        this.showToast('Pembayaran Midtrans berhasil! Mengaktifkan lisensi PRO...');
                        await this.confirmPayment(data.orderId);
                    },
                    onPending: (result) => {
                        this.showToast('Menunggu konfirmasi penyelesaian pembayaran Anda di bank.');
                    },
                    onError: (result) => {
                        alert('Terjadi kesalahan pada transaksi pembayaran Midtrans Anda.');
                    },
                    onClose: () => {
                        this.showToast('Jendela pembayaran tertutup sebelum transaksi diselesaikan.');
                    }
                });
                return;
            }

            // Jika belum diatur API key asli di .env, tampilkan modal simulasi
            this.showPaymentModal(data);
        } catch (e) {
            alert('Error Pembayaran: ' + e.message);
        }
    },

    showPaymentModal(payData) {
        let modal = document.getElementById('paymentModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'paymentModal';
            modal.className = 'modal-backdrop';
            document.body.appendChild(modal);
        }

        const isQris = payData.method === 'QRIS';
        const methodTitle = isQris ? 'Scan Kode QRIS' : payData.method === 'VA_BCA' ? 'Virtual Account BCA' : 'Virtual Account Mandiri';

        modal.innerHTML = `
            <div class="modal-card payment-modal-card">
                <div class="modal-header">
                    <h3>Pembayaran Berlangganan PRO</h3>
                    <button class="modal-close" onclick="JournalManager.closeModal('paymentModal')">&times;</button>
                </div>
                <div class="modal-body payment-body">
                    <div class="pay-amount-box">
                        <span class="pay-amount-label">Total Tagihan</span>
                        <h2 class="pay-amount-val">Rp ${Number(payData.amount).toLocaleString('id-ID')}</h2>
                        <span class="pay-method-badge">${methodTitle}</span>
                    </div>

                    ${isQris ? `
                        <div class="qris-box">
                            <img src="${payData.qrisUrl}" alt="QRIS Code" class="qris-img">
                            <p class="qris-instruction">Buka aplikasi e-Wallet / Mobile Banking Anda, pilih Scan QRIS lalu bayar.</p>
                        </div>
                    ` : `
                        <div class="va-box">
                            <span class="va-label">Nomor Virtual Account</span>
                            <div class="va-num-copy">
                                <span class="va-number">${payData.vaNumber}</span>
                                <button class="btn-copy" onclick="navigator.clipboard.writeText('${payData.vaNumber}'); JournalManager.showToast('Nomor VA berhasil disalin!');">Salin</button>
                            </div>
                            <p class="va-instruction">Transfer melalui ATM / M-Banking ke nomor VA di atas sebelum waktu habis.</p>
                        </div>
                    `}

                    <button class="btn-submit-neon btn-confirm-pay" onclick="JournalManager.confirmPayment('${payData.orderId || ''}')">Konfirmasi Pembayaran Selesai</button>
                </div>
            </div>
        `;
        modal.style.display = 'flex';
    },

    async confirmPayment(orderId = null) {
        try {
            const res = await fetch('/api/payment/confirm', {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}` 
                },
                body: JSON.stringify({ orderId: typeof orderId === 'string' ? orderId : null })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Konfirmasi pembayaran gagal.');

            this.user.tier = 'PRO';
            this.user.payment_status = 'PAID';
            this.user.tier_expires = data.expiresAt;
            localStorage.setItem('stockpulse_user', JSON.stringify(this.user));
            this.updateAuthUI();
            this.closeModal('paymentModal');
            this.showToast('Pembayaran berhasil! Akun Anda aktif sebagai PRO Member.');

            if (document.getElementById('journalTabContent')?.style.display !== 'none') {
                this.loadAndRenderJournal();
            }
        } catch (e) {
            alert('Error: ' + e.message);
        }
    },

    showProfileModal() {
        let modal = document.getElementById('profileModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'profileModal';
            modal.className = 'modal-backdrop';
            document.body.appendChild(modal);
        }

        const isPro = this.user.tier === 'PRO' && this.user.payment_status === 'PAID';
        const statusBadge = isPro 
            ? `<span class="badge-status-pro">PRO MEMBER</span>` 
            : `<span class="badge-status-free">FREE STARTER</span>`;

        const expiryText = isPro && this.user.tier_expires 
            ? `<p class="tier-expiry">Berlaku s/d: ${new Date(this.user.tier_expires).toLocaleDateString('id-ID')}</p>` 
            : '';

        modal.innerHTML = `
            <div class="modal-card profile-modal-card">
                <div class="modal-header">
                    <h3>Profil Pengguna</h3>
                    <button class="modal-close" onclick="JournalManager.closeModal('profileModal')">&times;</button>
                </div>
                <div class="modal-body profile-info">
                    <div class="profile-avatar"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#00b972" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg></div>
                    <h4>${this.user.username.toUpperCase()} ${statusBadge}</h4>
                    <p class="email-text">${this.user.email}</p>
                    ${expiryText}
                    <p class="joined-text">Terdaftar sejak: ${new Date(this.user.created_at || Date.now()).toLocaleDateString('id-ID')}</p>
                    
                    ${!isPro ? `<button class="btn-upgrade-pro" onclick="JournalManager.closeModal('profileModal'); JournalManager.initiateCheckout('QRIS');">Upgrade ke PRO Member (Rp 99.000)</button>` : ''}
                    
                    <hr class="profile-divider">
                    
                    <button class="btn-logout" onclick="JournalManager.logout(true)">Logout Akun</button>
                </div>
            </div>
        `;
        modal.style.display = 'flex';
    },

    logout(showMessage = true) {
        this.token = null;
        this.user = null;
        localStorage.removeItem('stockpulse_jwt');
        localStorage.removeItem('stockpulse_user');
        this.updateAuthUI();
        this.closeModal('profileModal');
        if (showMessage) {
            this.showToast('Anda telah keluar dari akun.');
        }
        if (document.getElementById('journalTabContent')?.style.display !== 'none') {
            this.renderLoginWarning();
        }
    },

    async loadAndRenderJournal() {
        const container = document.getElementById('journalTabContent');
        if (!container) return;

        if (!this.token || !this.user) {
            this.renderLoginWarning();
            return;
        }

        container.innerHTML = `<div class="journal-loading"><div class="spinner"></div> Memuat riwayat transaksi...</div>`;

        try {
            const res = await fetch('/api/transactions', {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (!res.ok) throw new Error('Gagal mengambil data dari database');
            const data = await res.json();
            this.transactions = data.transactions || [];
            this.evaluationData = data.evaluation || {};
            this.updateHoldingsCache(data.evaluation?.holdings || {});
            
            this.renderJournalDashboard(container);
        } catch (e) {
            container.innerHTML = `
                <div class="journal-error-card">
                    <h3>Gangguan Koneksi Database</h3>
                    <p>${e.message}. Pastikan koneksi database aktif.</p>
                </div>
            `;
        }
    },

    renderLoginWarning() {
        const container = document.getElementById('journalTabContent');
        if (!container) return;
        container.innerHTML = `
            <div class="journal-login-warning-card">
                <div class="warning-icon"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#00b972" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg></div>
                <h2>Akses Jurnal & Evaluasi</h2>
                <p>Fitur <strong>Jurnal Transaksi & Download Laporan</strong> memerlukan akun terdaftar.</p>
                <button class="btn-submit-neon login-prompt-btn" onclick="JournalManager.showAuthModal('login')">Login / Register Akun</button>
            </div>
        `;
    },

    setJournalSubTab(subTab) {
        this.activeSubTab = subTab;
        const container = document.getElementById('journalTabContent');
        if (container) this.renderJournalDashboard(container);
    },

    renderJournalDashboard(container) {
        const ev = this.evaluationData || {};
        const pnlCls = (ev.realizedPnL || 0) > 0 ? 'pnl-positive' : (ev.realizedPnL || 0) < 0 ? 'pnl-negative' : 'pnl-neutral';
        const winCls = (ev.winRate || 0) >= 50 ? 'win-green' : 'win-red';
        const fmtRp = val => 'Rp ' + (val ? val.toLocaleString('id-ID') : '0');

        const pendingPreOrderCount = this.preOrders.filter(o => o.status === 'PENDING').length;

        container.innerHTML = `
            <div class="journal-dashboard-wrapper">
                <div class="journal-subnav">
                    <button class="journal-subnav-btn ${this.activeSubTab === 'realized' ? 'active' : ''}" onclick="JournalManager.setJournalSubTab('realized')">
                        Realisasi Transaksi (${this.transactions.length})
                    </button>
                    <button class="journal-subnav-btn ${this.activeSubTab === 'preorder' ? 'active' : ''}" onclick="JournalManager.setJournalSubTab('preorder')">
                        Rencana Pre-Order ${pendingPreOrderCount > 0 ? `<span class="badge-count">${pendingPreOrderCount}</span>` : ''}
                    </button>
                </div>

                ${this.activeSubTab === 'realized' ? this.getRealizedViewHTML(ev, pnlCls, winCls, fmtRp) : this.getPreOrderViewHTML(fmtRp)}
            </div>
        `;
    },

    getRealizedViewHTML(ev, pnlCls, winCls, fmtRp) {
        return `
            ${this.getActiveHoldingsSectionHTML(fmtRp)}

            <div class="evaluation-summary-grid">
                <div class="eval-card eval-winrate ${winCls}">
                    <div class="eval-title">Win Rate</div>
                    <div class="eval-value">${ev.winRate || 0}%</div>
                    <div class="eval-subtitle">${ev.totalSellTrades || 0} Transaksi Jual Selesai</div>
                </div>
                <div class="eval-card eval-pnl ${pnlCls}">
                    <div class="eval-title">Total Realized Profit / Loss</div>
                    <div class="eval-value">${(ev.realizedPnL || 0) >= 0 ? '+' : ''}${fmtRp(ev.realizedPnL)}</div>
                    <div class="eval-subtitle">Kalkulasi penutupan posisi</div>
                </div>
                <div class="eval-card eval-trades">
                    <div class="eval-title">Total Order</div>
                    <div class="eval-value">${ev.totalTrades || 0} <span style="font-size:14px;">Order</span></div>
                    <div class="eval-subtitle">Order Beli & Jual</div>
                </div>
                <div class="eval-card eval-extremes">
                    <div class="eval-title">Best Win vs Worst Loss</div>
                    <div class="eval-value-sm">
                        <span style="color:#00b972;">Max Win: +${fmtRp(ev.bestWin)}</span>
                        <span style="color:#f43f5e; display:block; margin-top:2px;">Max Loss: ${ev.worstLoss !== 0 ? fmtRp(ev.worstLoss) : 'Rp 0'}</span>
                    </div>
                </div>
            </div>

            <div class="journal-action-bar">
                <div class="action-bar-title">Jurnal Transaksi Saham</div>
                <div class="action-bar-buttons">
                    <button class="btn-action-add" onclick="JournalManager.showAddTradeModal()">Catat Transaksi Baru</button>
                    <button class="btn-action-export" onclick="JournalManager.exportReport()">Unduh Laporan (CSV)</button>
                </div>
            </div>

            <div class="journal-table-container">
                <table class="journal-table">
                    <thead>
                        <tr>
                            <th>Tanggal & Waktu</th>
                            <th>Saham</th>
                            <th>Tipe</th>
                            <th>Harga Beli/Jual</th>
                            <th>Qty (Lembar/Lot)</th>
                            <th>Total Nilai</th>
                            <th>Realized P&L</th>
                            <th>Strategi / Tag</th>
                            <th>Catatan Evaluasi</th>
                            <th>Aksi</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${this.renderTableRows()}
                    </tbody>
                </table>
            </div>
        `;
    },

    getActiveHoldingsSectionHTML(fmtRp) {
        const holdingSymbols = Object.keys(this.activeHoldings || {});
        if (holdingSymbols.length === 0) {
            return `
                <div class="active-portfolio-container empty-portfolio-card">
                    <div class="portfolio-header">
                        <div class="portfolio-title">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#00b972" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l-7-4A2 2 0 0 0 21 16z"></path></svg>
                            <span>Posisi Portofolio Aktif (Saham Diprioritaskan Pantau)</span>
                        </div>
                        <span class="badge-status-free" style="padding:4px 10px; font-size:0.75rem;">0 Posisi Terbuka</span>
                    </div>
                    <p class="portfolio-empty-text">Belum ada saham yang sedang dimiliki saat ini. Ketika Anda mencatat transaksi BUY di jurnal, saham tersebut akan otomatis diprioritaskan di Watchlist dan langsung ditayangkan saat aplikasi dibuka.</p>
                </div>
            `;
        }

        const cardsHtml = holdingSymbols.map(sym => {
            const pos = this.activeHoldings[sym];
            const lots = Math.floor(pos.qty / 100);
            
            const livePriceObj = window.app?.watchlist?._priceCache?.[sym];
            const livePrice = livePriceObj ? livePriceObj.price : pos.avgPrice;
            
            let pnlHtml = '<span style="color:#9ca3af; font-size:0.85rem;">Harga Live Menunggu...</span>';
            if (livePrice && pos.avgPrice > 0) {
                const totalCurrentValue = pos.qty * livePrice;
                const floatingPnL = totalCurrentValue - pos.cost;
                const floatingPct = ((livePrice - pos.avgPrice) / pos.avgPrice) * 100;
                const sign = floatingPnL >= 0 ? '+' : '';
                const color = floatingPnL > 0 ? '#00b972' : floatingPnL < 0 ? '#f43f5e' : '#9ca3af';
                pnlHtml = `
                    <div style="color:${color}; font-weight:700; font-size:1.05rem;">
                        ${sign}${fmtRp(Math.round(floatingPnL))} 
                        <span style="font-size:0.85rem;">(${sign}${floatingPct.toFixed(2)}%)</span>
                    </div>
                `;
            }

            return `
                <div class="portfolio-card-item">
                    <div class="card-item-header">
                        <span class="holding-symbol">${sym}</span>
                        <span class="holding-lot-badge">${lots} Lot <small>(${pos.qty.toLocaleString('id-ID')} lbr)</small></span>
                    </div>
                    <div class="card-item-body">
                        <div class="holding-metric">
                            <span class="metric-label">Harga Rata-rata Beli</span>
                            <span class="metric-val">${fmtRp(pos.avgPrice)}</span>
                        </div>
                        <div class="holding-metric">
                            <span class="metric-label">Harga Pasar Live</span>
                            <span class="metric-val" style="color:#60a5fa;">${fmtRp(livePrice)}</span>
                        </div>
                        <div class="holding-metric holding-pnl-box">
                            <span class="metric-label">Estimasi P/L (Floating)</span>
                            ${pnlHtml}
                        </div>
                    </div>
                    <div class="card-item-actions">
                        <button class="btn-card-action btn-monitor" onclick="JournalManager.monitorStock('${sym}')" title="Buka chart dan analisa teknikal saham ini">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>
                            <span>Pantau Chart</span>
                        </button>
                        <button class="btn-card-action btn-sell-action" onclick="JournalManager.showAddTradeModal('${sym}', '${livePrice || pos.avgPrice}', 'SELL', '${pos.qty}')" title="Jual atau evaluasi penutupan posisi">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>
                            <span>Jual / Evaluasi</span>
                        </button>
                        <button class="btn-card-action btn-buy-more" onclick="JournalManager.showAddTradeModal('${sym}', '${livePrice || pos.avgPrice}', 'BUY')" title="Catat pembelian baru / average up/down">
                            <span>+ Beli Lagi</span>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        return `
            <div class="active-portfolio-container">
                <div class="portfolio-header">
                    <div class="portfolio-title">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#00b972" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l-7-4A2 2 0 0 0 21 16z"></path></svg>
                        <span>Posisi Portofolio Aktif (Utama Dipantau)</span>
                    </div>
                    <span class="badge-holding-count">${holdingSymbols.length} Saham Dimiliki</span>
                </div>
                <div class="portfolio-cards-grid">
                    ${cardsHtml}
                </div>
            </div>
        `;
    },

    getPreOrderViewHTML(fmtRp) {
        const curSym = (window.app && window.app.currentSymbol) || 'BBCA.JK';

        return `
            <div class="preorder-container-integrated">
                <div class="eval-card preorder-form-card">
                    <h3 style="color:#fff; margin-bottom:12px; font-size:1.05rem;">Buat Rencana Pre-Order</h3>
                    <form onsubmit="JournalManager.handleCreatePreOrder(event)" class="tx-form">
                        <div class="form-row-2">
                            <div class="form-group">
                                <label>Simbol Saham</label>
                                <input type="text" id="poPlanSymbol" value="${curSym.toUpperCase()}" required placeholder="BBCA.JK">
                            </div>
                            <div class="form-group">
                                <label>Tipe Plan</label>
                                <select id="poPlanType">
                                    <option value="BUY">BUY (Rencana Beli)</option>
                                    <option value="SELL">SELL (Rencana Jual)</option>
                                </select>
                            </div>
                        </div>

                        <div class="form-row-2">
                            <div class="form-group">
                                <label>Target Harga Beli/Jual (Rp)</label>
                                <input type="number" step="0.01" id="poPlanPrice" required placeholder="10000">
                            </div>
                            <div class="form-group">
                                <label>Jumlah Lot (1 Lot = 100 Lbr)</label>
                                <input type="number" id="poPlanLot" required placeholder="10" min="1">
                            </div>
                        </div>

                        <div class="form-row-2">
                            <div class="form-group">
                                <label>Stop Loss (Opsional)</label>
                                <input type="number" step="0.01" id="poPlanSL" placeholder="0">
                            </div>
                            <div class="form-group">
                                <label>Take Profit (Opsional)</label>
                                <input type="number" step="0.01" id="poPlanTP" placeholder="0">
                            </div>
                        </div>

                        <div class="form-group">
                            <label>Catatan Rencana Trade</label>
                            <input type="text" id="poPlanNotes" placeholder="Analisa pembentukan Support / Breakout Resistance...">
                        </div>

                        <button type="submit" class="btn-submit-neon">Simpan Rencana Order</button>
                    </form>
                </div>

                <div class="journal-table-container" style="margin-top:20px;">
                    <div style="padding:14px; background:#111827; color:#fff; font-weight:700; display:flex; justify-content:space-between; align-items:center;">
                        <span>Daftar Rencana Pre-Order (${this.preOrders.length})</span>
                        ${this.preOrders.length > 0 ? `<button class="btn-del-tx" style="font-size:0.8rem; color:#f43f5e;" onclick="JournalManager.clearPreOrders()">Hapus Semua Rencana</button>` : ''}
                    </div>
                    <table class="journal-table">
                        <thead>
                            <tr>
                                <th>Status</th>
                                <th>Saham</th>
                                <th>Tipe</th>
                                <th>Target Harga</th>
                                <th>Jumlah Lot</th>
                                <th>Stop Loss / TP</th>
                                <th>Catatan Plan</th>
                                <th>Eksekusi ke Jurnal</th>
                                <th>Aksi</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${this.renderPreOrderRows(fmtRp)}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    },

    renderPreOrderRows(fmtRp) {
        if (!this.preOrders || this.preOrders.length === 0) {
            return `<tr><td colspan="9" class="empty-table-msg">Belum ada rencana Pre-Order tersimpan. Gunakan form di atas untuk merencanakan transaksi.</td></tr>`;
        }

        return this.preOrders.map((po, idx) => {
            const isPending = po.status === 'PENDING';
            const statusBadge = isPending 
                ? '<span class="tx-badge badge-pending">PENDING</span>'
                : '<span class="tx-badge badge-buy">EXECUTED</span>';

            const typeBadge = po.type === 'BUY' 
                ? '<span class="tx-badge badge-buy">BUY</span>' 
                : '<span class="tx-badge badge-sell">SELL</span>';

            const slTpText = `SL: ${po.stopLoss ? fmtRp(po.stopLoss) : '—'}<br>TP: ${po.takeProfitPrice ? fmtRp(po.takeProfitPrice) : '—'}`;

            return `
                <tr>
                    <td>${statusBadge}</td>
                    <td><strong>${po.symbol}</strong></td>
                    <td>${typeBadge}</td>
                    <td>${fmtRp(po.targetPrice)}</td>
                    <td>${po.quantity} Lot (${(po.quantity * 100).toLocaleString('id-ID')} lbr)</td>
                    <td style="font-size:0.75rem; color:#9ca3af;">${slTpText}</td>
                    <td>${po.notes || '—'}</td>
                    <td>
                        ${isPending ? `<button class="btn-action-add" style="padding:4px 10px; font-size:0.75rem;" onclick="JournalManager.convertPreOrderToJournal(${idx})">Eksekusi ke Jurnal</button>` : '<span style="color:#00b972; font-size:0.8rem;">Sudah Masuk Jurnal</span>'}
                    </td>
                    <td>
                        <button class="btn-del-tx" onclick="JournalManager.deletePreOrder(${idx})">Hapus</button>
                    </td>
                </tr>
            `;
        }).join('');
    },

    handleCreatePreOrder(e) {
        e.preventDefault();
        const newPo = {
            id: Date.now().toString(),
            symbol: document.getElementById('poPlanSymbol').value.toUpperCase().trim(),
            type: document.getElementById('poPlanType').value,
            targetPrice: Number(document.getElementById('poPlanPrice').value),
            quantity: Number(document.getElementById('poPlanLot').value),
            stopLoss: document.getElementById('poPlanSL').value ? Number(document.getElementById('poPlanSL').value) : null,
            takeProfitPrice: document.getElementById('poPlanTP').value ? Number(document.getElementById('poPlanTP').value) : null,
            notes: document.getElementById('poPlanNotes').value,
            status: 'PENDING',
            createdAt: new Date().toISOString()
        };

        this.preOrders.unshift(newPo);
        this.savePreOrders();
        this.showToast('Rencana Pre-Order ' + newPo.symbol + ' disimpan.');
        const container = document.getElementById('journalTabContent');
        if (container) this.renderJournalDashboard(container);
    },

    async convertPreOrderToJournal(index) {
        const po = this.preOrders[index];
        if (!po) return;

        const payload = {
            symbol: po.symbol,
            type: po.type,
            price: po.targetPrice,
            quantity: po.quantity * 100,
            strategy_tag: 'Pre-Order Plan',
            notes: po.notes || ('Rencana SL: ' + (po.stopLoss || '—') + ', TP: ' + (po.takeProfitPrice || '—'))
        };

        try {
            const res = await fetch('/api/transactions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Gagal menyimpan transaksi.');

            this.preOrders[index].status = 'EXECUTED';
            this.savePreOrders();

            this.showToast('Pre-Order ' + po.symbol + ' berhasil dieksekusi ke Jurnal.');
            this.loadAndRenderJournal();
        } catch (err) {
            alert('Error: ' + err.message);
        }
    },

    deletePreOrder(index) {
        this.preOrders.splice(index, 1);
        this.savePreOrders();
        const container = document.getElementById('journalTabContent');
        if (container) this.renderJournalDashboard(container);
    },

    clearPreOrders() {
        if (!confirm('Apakah Anda yakin ingin menghapus seluruh rencana Pre-Order?')) return;
        this.preOrders = [];
        this.savePreOrders();
        const container = document.getElementById('journalTabContent');
        if (container) this.renderJournalDashboard(container);
    },

    renderTableRows() {
        if (!this.transactions || this.transactions.length === 0) {
            return `<tr><td colspan="10" class="empty-table-msg">Jurnal transaksi masih kosong. Klik 'Catat Transaksi Baru' untuk menambahkan.</td></tr>`;
        }

        const fmtRp = val => 'Rp ' + Number(val).toLocaleString('id-ID');

        return this.transactions.map(t => {
            const dateStr = new Date(t.transaction_date).toLocaleString('id-ID', {
                day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
            });
            const typeBadge = t.type === 'BUY' 
                ? '<span class="tx-badge badge-buy">BUY</span>' 
                : '<span class="tx-badge badge-sell">SELL</span>';
                
            const lots = Math.floor(t.quantity / 100);
            const qtyDisplay = `${Number(t.quantity).toLocaleString('id-ID')} lbr (${lots} lot)`;

            let pnlDisplay = '<span class="pnl-na">—</span>';
            if (t.type === 'SELL' && t.pnl !== null) {
                const pnlVal = Number(t.pnl);
                const pnlPct = Number(t.pnl_percent || 0).toFixed(1);
                if (pnlVal > 0) {
                    pnlDisplay = `<span class="pnl-cell-win">+${fmtRp(pnlVal)}<br><small>(${pnlPct}%)</small></span>`;
                } else if (pnlVal < 0) {
                    pnlDisplay = `<span class="pnl-cell-loss">${fmtRp(pnlVal)}<br><small>(${pnlPct}%)</small></span>`;
                } else {
                    pnlDisplay = `<span class="pnl-cell-zero">Rp 0 (0%)</span>`;
                }
            }

            return `
                <tr>
                    <td class="col-date">${dateStr}</td>
                    <td class="col-symbol"><strong>${t.symbol}</strong></td>
                    <td class="col-type">${typeBadge}</td>
                    <td class="col-price">${fmtRp(t.price)}</td>
                    <td class="col-qty">${qtyDisplay}</td>
                    <td class="col-total">${fmtRp(t.total_value)}</td>
                    <td class="col-pnl">${pnlDisplay}</td>
                    <td class="col-tag"><span class="tag-chip">${t.strategy_tag || 'Standard'}</span></td>
                    <td class="col-notes">${t.notes || '—'}</td>
                    <td class="col-action">
                        <button class="btn-del-tx" onclick="JournalManager.deleteTransaction(${t.id})" title="Hapus Transaksi">Hapus</button>
                    </td>
                </tr>
            `;
        }).join('');
    },

    showAddTradeModal(defaultSymbol = '', defaultPrice = '', defaultType = 'BUY', defaultQty = '') {
        if (!this.token) {
            this.showToast('Silakan login terlebih dahulu.');
            this.showAuthModal('login');
            return;
        }

        let modal = document.getElementById('addTxModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'addTxModal';
            modal.className = 'modal-backdrop';
            document.body.appendChild(modal);
        }

        const symValue = defaultSymbol || (window.app && window.app.currentSymbol) || 'BBCA.JK';
        const isSell = defaultType === 'SELL';

        modal.innerHTML = `
            <div class="modal-card tx-modal-card">
                <div class="modal-header">
                    <h3>${isSell ? 'Tutup Posisi / Evaluasi Jual Saham' : 'Catat Jurnal Transaksi Baru'}</h3>
                    <button class="modal-close" onclick="JournalManager.closeModal('addTxModal')">&times;</button>
                </div>
                <form onsubmit="JournalManager.handleSubmitTrade(event)" class="tx-form">
                    <div class="form-row-2">
                        <div class="form-group">
                            <label>Simbol Saham</label>
                            <input type="text" id="txSymbol" value="${symValue.toUpperCase()}" required placeholder="BBCA.JK">
                        </div>
                        <div class="form-group">
                            <label>Tipe Transaksi</label>
                            <select id="txType">
                                <option value="BUY" ${!isSell ? 'selected' : ''}>BUY (Beli Saham)</option>
                                <option value="SELL" ${isSell ? 'selected' : ''}>SELL (Jual & Evaluasi P&L)</option>
                            </select>
                        </div>
                    </div>

                    <div class="form-row-2">
                        <div class="form-group">
                            <label>Harga per Lembar (Rp)</label>
                            <input type="number" step="0.01" id="txPrice" value="${defaultPrice}" required placeholder="10000">
                        </div>
                        <div class="form-group">
                            <label>Jumlah Lembar (1 Lot = 100 Lbr)</label>
                            <input type="number" id="txQty" value="${defaultQty}" required placeholder="1000" oninput="JournalManager.calcLotPreview()">
                            <small id="lotPreviewText" class="lot-preview">Equivalent: 0 Lot</small>
                        </div>
                    </div>

                    <div class="form-group">
                        <label style="font-size:0.8rem; color:var(--text-secondary);">Pilihan Cepat Lot:</label>
                        <div class="quick-lot-chips">
                            <button type="button" class="chip-lot" onclick="JournalManager.setQuickLot(1)">1 Lot</button>
                            <button type="button" class="chip-lot" onclick="JournalManager.setQuickLot(5)">5 Lot</button>
                            <button type="button" class="chip-lot" onclick="JournalManager.setQuickLot(10)">10 Lot</button>
                            <button type="button" class="chip-lot" onclick="JournalManager.setQuickLot(20)">20 Lot</button>
                            <button type="button" class="chip-lot" onclick="JournalManager.setQuickLot(50)">50 Lot</button>
                            <button type="button" class="chip-lot" onclick="JournalManager.setQuickLot(100)">100 Lot</button>
                            ${isSell && defaultQty ? `<button type="button" class="chip-lot chip-max" onclick="JournalManager.setQuickLot(${Math.floor(Number(defaultQty)/100)})">Max (${Math.floor(Number(defaultQty)/100)} Lot)</button>` : ''}
                        </div>
                    </div>

                    <div class="form-group">
                        <label>Tag Strategi / Metode Analisa</label>
                        <select id="txStrategy">
                            <option value="TV Screener Strong Buy">TV Screener Strong Buy</option>
                            <option value="OBV Smart Money Accumulation">OBV Smart Money Accumulation</option>
                            <option value="Breakout VWAP & RSI Rebound">Breakout VWAP & RSI Rebound</option>
                            <option value="Techno-Fundamental Value">Techno-Fundamental Value</option>
                            <option value="Scalping Momentum / Fast Trade">Scalping Momentum / Fast Trade</option>
                            <option value="Standard Trade">Standard Trade</option>
                        </select>
                    </div>

                    <div class="form-group">
                        <label>Catatan Evaluasi / Alasan Trade</label>
                        <textarea id="txNotes" rows="3" placeholder="Tuliskan evaluasi transaksi atau alasan beli/jual..."></textarea>
                    </div>

                    <button type="submit" class="btn-submit-neon" style="margin-top:10px;">Simpan Transaksi</button>
                </form>
            </div>
        `;
        modal.style.display = 'flex';
        this.calcLotPreview();
    },

    setQuickLot(lots) {
        const el = document.getElementById('txQty');
        if (el) {
            el.value = lots * 100;
            this.calcLotPreview();
        }
    },

    calcLotPreview() {
        const qty = Number(document.getElementById('txQty')?.value || 0);
        const lotText = document.getElementById('lotPreviewText');
        if (lotText) {
            const lots = Math.floor(qty / 100);
            lotText.innerText = `Ekuivalen: ${lots} Lot (${qty.toLocaleString('id-ID')} lembar)`;
        }
    },

    async handleSubmitTrade(e) {
        e.preventDefault();
        const payload = {
            symbol: document.getElementById('txSymbol').value,
            type: document.getElementById('txType').value,
            price: document.getElementById('txPrice').value,
            quantity: document.getElementById('txQty').value,
            strategy_tag: document.getElementById('txStrategy').value,
            notes: document.getElementById('txNotes').value
        };

        try {
            const res = await fetch('/api/transactions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Gagal menyimpan transaksi.');

            this.closeModal('addTxModal');
            this.showToast('Transaksi ' + payload.symbol + ' (' + payload.type + ') dicatat.');
            this.loadAndRenderJournal();
        } catch (err) {
            alert('Error: ' + err.message);
        }
    },

    async deleteTransaction(id) {
        if (!confirm('Apakah Anda yakin ingin menghapus catatan transaksi ini?')) return;
        try {
            const res = await fetch(`/api/transactions/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (!res.ok) throw new Error('Gagal menghapus dari database.');
            this.showToast('Catatan transaksi dihapus.');
            this.loadAndRenderJournal();
        } catch (e) {
            alert('Error: ' + e.message);
        }
    },

    exportReport() {
        if (!this.token) {
            this.showToast('Silakan login terlebih dahulu.');
            return;
        }
        window.location.href = `/api/transactions/export?token=${encodeURIComponent(this.token)}`;
        this.showToast('Laporan Evaluasi Trading sedang diunduh...');
    },

    closeModal(id) {
        const m = document.getElementById(id);
        if (m) m.style.display = 'none';
    },

    showToast(msg) {
        let toast = document.getElementById('journalToast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'journalToast';
            toast.className = 'journal-toast-popup';
            document.body.appendChild(toast);
        }
        toast.innerText = msg;
        toast.style.display = 'block';
        setTimeout(() => { toast.style.display = 'none'; }, 3500);
    }
};

window.JournalManager = JournalManager;
document.addEventListener('DOMContentLoaded', () => {
    JournalManager.init();
});
