/**
 * StockPulse — Journal & Authentication Module (journal.js)
 * Menangani Login, Registrasi, Jurnal Transaksi Saham, Kalkulasi Evaluasi P&L, dan Ekspor Laporan Excel/CSV
 */

const JournalManager = {
    token: null,
    user: null,
    evaluationData: null,
    transactions: [],

    init() {
        this.token = localStorage.getItem('stockpulse_jwt');
        this.bindHeaderEvents();
        if (this.token) {
            this.verifySession();
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

    async verifySession() {
        try {
            const res = await fetch('/api/auth/me', {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (!res.ok) {
                this.logout(false);
                return;
            }
            const data = await res.json();
            this.user = data.user;
            this.updateAuthUI();
        } catch (e) {
            console.warn('[Session Error]:', e.message);
            this.logout(false);
        }
    },

    updateAuthUI() {
        const authBtn = document.getElementById('btnAuthToggle');
        if (!authBtn) return;

        if (this.user && this.token) {
            authBtn.innerHTML = `<span>👤 ${this.user.username.toUpperCase()}</span>`;
            authBtn.classList.add('logged-in');
        } else {
            authBtn.innerHTML = `<span>🔐 Login / Register</span>`;
            authBtn.classList.remove('logged-in');
        }
    },

    // ─── Modal Autentikasi (Login & Register) ──────────────────────────────────
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
                    <h3> Akses Akun StockPulse</h3>
                    <button class="modal-close" onclick="JournalManager.closeModal('authModal')">×</button>
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
        btns[0].classList.toggle('active', tab === 'login');
        btns[1].classList.toggle('active', tab === 'register');
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
                <div id="authErrorMsg" class="auth-error" style="display:none;"></div>
                <button type="submit" class="btn-submit-neon">⚡ Masuk ke Dashboard</button>
            </form>
        `;
    },

    getRegisterFormHTML() {
        return `
            <form onsubmit="JournalManager.handleRegister(event)" class="auth-form">
                <div class="form-group">
                    <label>Username</label>
                    <input type="text" id="regUsername" placeholder="Contoh: trader_elite" required autofocus>
                </div>
                <div class="form-group">
                    <label>Alamat Email</label>
                    <input type="email" id="regEmail" placeholder="nama@email.com" required>
                </div>
                <div class="form-group">
                    <label>Kata Sandi (Min. 6 Karakter)</label>
                    <input type="password" id="regPassword" placeholder="Minimal 6 karakter" minlength="6" required>
                </div>
                <div id="authErrorMsg" class="auth-error" style="display:none;"></div>
                <button type="submit" class="btn-submit-neon" style="background: linear-gradient(135deg, #00e676, #00b0ff);">🚀 Daftar Akun Baru</button>
            </form>
        `;
    },

    async handleLogin(e) {
        e.preventDefault();
        const loginVal = document.getElementById('loginInput').value;
        const passVal = document.getElementById('passwordInput').value;
        const errorDiv = document.getElementById('authErrorMsg');

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ login: loginVal, password: passVal })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Login gagal.');

            this.token = data.token;
            this.user = data.user;
            localStorage.setItem('stockpulse_jwt', this.token);
            this.updateAuthUI();
            this.closeModal('authModal');
            this.showToast('✅ Welcome back, ' + this.user.username.toUpperCase() + '!');
            
            // Refresh halaman jurnal jika sedang terbuka
            if (document.getElementById('journalTabContent')?.style.display !== 'none') {
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
        const errorDiv = document.getElementById('authErrorMsg');

        try {
            const res = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: userVal, email: emailVal, password: passVal })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Registrasi gagal.');

            this.token = data.token;
            this.user = data.user;
            localStorage.setItem('stockpulse_jwt', this.token);
            this.updateAuthUI();
            this.closeModal('authModal');
            this.showToast('🎉 Akun baru berhasil didaftarkan! Selamat datang di StockPulse.');
            
            if (document.getElementById('journalTabContent')?.style.display !== 'none') {
                this.loadAndRenderJournal();
            }
        } catch (err) {
            errorDiv.innerText = err.message;
            errorDiv.style.display = 'block';
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
        modal.innerHTML = `
            <div class="modal-card profile-modal-card">
                <div class="modal-header">
                    <h3>👤 Profil & Status Akun</h3>
                    <button class="modal-close" onclick="JournalManager.closeModal('profileModal')">×</button>
                </div>
                <div class="modal-body profile-info">
                    <div class="profile-avatar">🛡️</div>
                    <h4>${this.user.username.toUpperCase()}</h4>
                    <p class="email-text">${this.user.email}</p>
                    <p class="joined-text">Terdaftar sejak: ${new Date(this.user.created_at || Date.now()).toLocaleDateString('id-ID')}</p>
                    
                    <hr class="profile-divider">
                    
                    <button class="btn-logout" onclick="JournalManager.logout(true)">🚪 Logout Akun</button>
                </div>
            </div>
        `;
        modal.style.display = 'flex';
    },

    logout(showMessage = true) {
        this.token = null;
        this.user = null;
        localStorage.removeItem('stockpulse_jwt');
        this.updateAuthUI();
        this.closeModal('profileModal');
        if (showMessage) {
            this.showToast('ℹ️ Anda telah berhasil keluar (logout).');
        }
        if (document.getElementById('journalTabContent')?.style.display !== 'none') {
            this.renderLoginWarning();
        }
    },

    // ─── Render Tab Jurnal & Evaluasi ─────────────────────────────────────────
    async loadAndRenderJournal() {
        const container = document.getElementById('journalTabContent');
        if (!container) return;

        if (!this.token || !this.user) {
            this.renderLoginWarning();
            return;
        }

        container.innerHTML = `<div class="journal-loading"><div class="spinner"></div> Mengambil riwayat transaksi dan kalkulasi evaluasi...</div>`;

        try {
            const res = await fetch('/api/transactions', {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (!res.ok) throw new Error('Gagal mengambil data dari database PostgreSQL');
            const data = await res.json();
            this.transactions = data.transactions || [];
            this.evaluationData = data.evaluation || {};
            
            this.renderJournalDashboard(container);
        } catch (e) {
            container.innerHTML = `
                <div class="journal-error-card">
                    <h3>❌ Gangguan Koneksi Database</h3>
                    <p>${e.message}. Pastikan koneksi PostgreSQL beroperasi atau coba reload halaman.</p>
                </div>
            `;
        }
    },

    renderLoginWarning() {
        const container = document.getElementById('journalTabContent');
        if (!container) return;
        container.innerHTML = `
            <div class="journal-login-warning-card">
                <div class="warning-icon">🔒</div>
                <h2>Akses Eksklusif Khusus Member</h2>
                <p>Fitur <strong>Jurnal & Evaluasi Trading</strong> serta <strong>Download Laporan Evaluasi (Excel/CSV)</strong> tersertifikasi aman dan diikat ke database akun PostgreSQL Anda.</p>
                <button class="btn-submit-neon login-prompt-btn" onclick="JournalManager.showAuthAuthModal('login')">⚡ Klik di sini untuk Login / Daftar Akun</button>
            </div>
        `;
    },

    showAuthAuthModal(tab) {
        this.showAuthModal(tab);
    },

    renderJournalDashboard(container) {
        const ev = this.evaluationData;
        const pnlCls = ev.realizedPnL > 0 ? 'pnl-positive' : ev.realizedPnL < 0 ? 'pnl-negative' : 'pnl-neutral';
        const winCls = ev.winRate >= 50 ? 'win-green' : 'win-red';
        const fmtRp = val => 'Rp ' + (val ? val.toLocaleString('id-ID') : '0');

        container.innerHTML = `
            <div class="journal-dashboard-wrapper">
                <!-- 1. EVALUATION PERFORMANCE SUMMARY CARDS -->
                <div class="evaluation-summary-grid">
                    <div class="eval-card eval-winrate ${winCls}">
                        <div class="eval-title">🏆 Win Rate (Performa)</div>
                        <div class="eval-value">${ev.winRate}%</div>
                        <div class="eval-subtitle">${ev.totalSellTrades} Transaksi Jual Selesai</div>
                    </div>
                    <div class="eval-card eval-pnl ${pnlCls}">
                        <div class="eval-title">💰 Total Realized Profit / Loss</div>
                        <div class="eval-value">${ev.realizedPnL >= 0 ? '+' : ''}${fmtRp(ev.realizedPnL)}</div>
                        <div class="eval-subtitle">Kalkulasi akurat atas penutupan posisi</div>
                    </div>
                    <div class="eval-card eval-trades">
                        <div class="eval-title">📊 Aktivitas Portfolio</div>
                        <div class="eval-value">${ev.totalTrades} <span style="font-size:16px;">Order</span></div>
                        <div class="eval-subtitle">Total akumulasi order BUY & SELL</div>
                    </div>
                    <div class="eval-card eval-extremes">
                        <div class="eval-title">🌟 Best Win vs Worst Loss</div>
                        <div class="eval-value-sm">
                            <span style="color:#00e676;">⬆️ Max: +${fmtRp(ev.bestWin)}</span>
                            <span style="color:#ff3d00; display:block; margin-top:2px;">⬇️ Min: ${ev.worstLoss !== 0 ? fmtRp(ev.worstLoss) : 'Rp 0'}</span>
                        </div>
                    </div>
                </div>

                <!-- 2. ACTION BAR & TOOLBAR -->
                <div class="journal-action-bar">
                    <div class="action-bar-title">📋 Buku Jurnal Transaksi Saham</div>
                    <div class="action-bar-buttons">
                        <button class="btn-action-add" onclick="JournalManager.showAddTradeModal()">➕ Catat Transaksi Baru</button>
                        <button class="btn-action-export" onclick="JournalManager.exportReport()">📥 Unduh Laporan Evaluasi (Excel / CSV)</button>
                    </div>
                </div>

                <!-- 3. TRANSACTION TABLE -->
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
            </div>
        `;
    },

    renderTableRows() {
        if (!this.transactions || this.transactions.length === 0) {
            return `<tr><td colspan="10" class="empty-table-msg">📭 Jurnal transaksi masih kosong. Klik '➕ Catat Transaksi Baru' atau masukkan dari analisa saham Anda!</td></tr>`;
        }

        const fmtRp = val => 'Rp ' + Number(val).toLocaleString('id-ID');

        return this.transactions.map(t => {
            const dateStr = new Date(t.transaction_date).toLocaleString('id-ID', {
                day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
            });
            const typeBadge = t.type === 'BUY' 
                ? '<span class="tx-badge badge-buy">🟢 BUY</span>' 
                : '<span class="tx-badge badge-sell">🔴 SELL</span>';
                
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
                        <button class="btn-del-tx" onclick="JournalManager.deleteTransaction(${t.id})" title="Hapus Transaksi">🗑️</button>
                    </td>
                </tr>
            `;
        }).join('');
    },

    // ─── Modal Tambah Transaksi ───────────────────────────────────────────────
    showAddTradeModal(defaultSymbol = '', defaultPrice = '') {
        if (!this.token) {
            this.showToast('⚠️ Silakan login terlebih dahulu untuk mencatat ke Jurnal.');
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

        modal.innerHTML = `
            <div class="modal-card tx-modal-card">
                <div class="modal-header">
                    <h3>➕ Catat Jurnal Transaksi Baru</h3>
                    <button class="modal-close" onclick="JournalManager.closeModal('addTxModal')">×</button>
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
                                <option value="BUY">🟢 BUY (Beli)</option>
                                <option value="SELL">🔴 SELL (Jual & Evaluasi P&L)</option>
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
                            <input type="number" id="txQty" required placeholder="1000" oninput="JournalManager.calcLotPreview()">
                            <small id="lotPreviewText" class="lot-preview">Equivalent: 10 Lot</small>
                        </div>
                    </div>

                    <div class="form-group">
                        <label>Tag Strategi / Metode Analisa</label>
                        <select id="txStrategy">
                            <option value="⚡ TV Screener Strong Buy">⚡ TV Screener Strong Buy</option>
                            <option value="💎 OBV Smart Money Accumulation">💎 OBV Smart Money Accumulation</option>
                            <option value="🌊 Breakout VWAP & RSI Rebound">🌊 Breakout VWAP & RSI Rebound</option>
                            <option value="🛡️ Techno-Fundamental Value">🛡️ Techno-Fundamental Value</option>
                            <option value="🚀 Scalping Momentum / Fast Trade">🚀 Scalping Momentum / Fast Trade</option>
                            <option value="Standard Trade">Standard Trade</option>
                        </select>
                    </div>

                    <div class="form-group">
                        <label>Catatan Evaluasi / Alasan Trade</label>
                        <textarea id="txNotes" rows="3" placeholder="Tuliskan evaluasi: contoh 'Beli karena konfirmasi Multi-Agent AI dan MACD Golden Cross, target profit +8%'..."></textarea>
                    </div>

                    <button type="submit" class="btn-submit-neon" style="margin-top:10px;">💾 Simpan ke Database Jurnal</button>
                </form>
            </div>
        `;
        modal.style.display = 'flex';
        this.calcLotPreview();
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
            this.showToast('✅ Transaksi ' + payload.symbol + ' (' + payload.type + ') berhasil dicatat ke database!');
            this.loadAndRenderJournal();
        } catch (err) {
            alert('❌ Eror: ' + err.message);
        }
    },

    async deleteTransaction(id) {
        if (!confirm('Apakah Anda yakin ingin menghapus catatan transaksi ini dari Jurnal?')) return;
        try {
            const res = await fetch(`/api/transactions/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (!res.ok) throw new Error('Gagal menghapus dari database.');
            this.showToast('🗑️ Catatan transaksi berhasil dihapus.');
            this.loadAndRenderJournal();
        } catch (e) {
            alert('❌ Eror: ' + e.message);
        }
    },

    exportReport() {
        if (!this.token) {
            this.showToast('⚠️ Silakan login untuk mengunduh laporan.');
            return;
        }
        // Redirect browser to download export endpoint with token in parameter
        window.location.href = `/api/transactions/export?token=${encodeURIComponent(this.token)}`;
        this.showToast('📥 Laporan Evaluasi Trading (Excel / CSV) sedang diunduh...');
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
