/* ============================================================
   A股股票监控 - 主应用逻辑
   ============================================================ */

// ── Toast ──────────────────────────────────────────────────
const UI = {
  toast(msg, type = 'info', duration = 2500) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    document.getElementById('toastContainer').appendChild(el);
    setTimeout(() => el.remove(), duration);
  },
  showLogin() {
    document.getElementById('loginModal').classList.remove('hidden');
    document.getElementById('loginUser').focus();
  },
  hideLogin() {
    document.getElementById('loginModal').classList.add('hidden');
    document.getElementById('loginError').classList.remove('show');
  },
};

// ── Chart ──────────────────────────────────────────────────
let klineChart = null;
let currentCode = null;
let currentPeriod = 'daily';

function initChart() {
  const el = document.getElementById('kline-chart');
  if (klineChart) { klineChart.dispose(); }
  klineChart = echarts.init(el, 'dark');
  window.addEventListener('resize', () => klineChart && klineChart.resize());
}

function renderKline(data, name) {
  if (!data || data.length === 0) return;
  const dates = data.map(d => d.date);
  const ohlc  = data.map(d => [d.open, d.close, d.low, d.high]);
  const vols  = data.map(d => d.volume);
  const maData = (n) => data.map((_, i) => {
    if (i < n - 1) return null;
    const slice = data.slice(i - n + 1, i + 1);
    return +(slice.reduce((s, d) => s + d.close, 0) / n).toFixed(2);
  });

  const option = {
    backgroundColor: 'transparent',
    animation: false,
    tooltip: {
      trigger: 'axis', axisPointer: { type: 'cross' },
      backgroundColor: 'rgba(30,32,53,0.95)',
      borderColor: '#2e3155', textStyle: { color: '#e8eaf0', fontSize: 12 },
    },
    legend: { data: ['K线', 'MA5', 'MA10', 'MA20'], top: 4, textStyle: { color: '#9ca3c0', fontSize: 11 } },
    grid: [
      { left: 60, right: 20, top: 36, bottom: 120 },
      { left: 60, right: 20, bottom: 30, height: 70 },
    ],
    xAxis: [
      { type: 'category', data: dates, gridIndex: 0, axisLine: { lineStyle: { color: '#2e3155' } }, axisLabel: { color: '#6b7299', fontSize: 11 }, splitLine: { show: false } },
      { type: 'category', data: dates, gridIndex: 1, axisLabel: { show: false }, axisLine: { lineStyle: { color: '#2e3155' } }, splitLine: { show: false } },
    ],
    yAxis: [
      { scale: true, gridIndex: 0, axisLine: { lineStyle: { color: '#2e3155' } }, axisLabel: { color: '#6b7299', fontSize: 11 }, splitLine: { lineStyle: { color: '#1e2035' } } },
      { scale: true, gridIndex: 1, axisLabel: { color: '#6b7299', fontSize: 10 }, splitLine: { lineStyle: { color: '#1e2035' } } },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], start: 60, end: 100 },
      { type: 'slider', xAxisIndex: [0, 1], bottom: 5, height: 22, borderColor: '#2e3155', fillerColor: 'rgba(79,142,247,0.1)', textStyle: { color: '#6b7299' } },
    ],
    series: [
      {
        name: 'K线', type: 'candlestick', xAxisIndex: 0, yAxisIndex: 0, data: ohlc,
        itemStyle: {
          color: '#e74c3c', color0: '#2ecc71',
          borderColor: '#e74c3c', borderColor0: '#2ecc71',
        },
      },
      { name: 'MA5',  type: 'line', data: maData(5),  xAxisIndex: 0, yAxisIndex: 0, smooth: true, lineStyle: { width: 1, color: '#f39c12' }, showSymbol: false },
      { name: 'MA10', type: 'line', data: maData(10), xAxisIndex: 0, yAxisIndex: 0, smooth: true, lineStyle: { width: 1, color: '#9b59b6' }, showSymbol: false },
      { name: 'MA20', type: 'line', data: maData(20), xAxisIndex: 0, yAxisIndex: 0, smooth: true, lineStyle: { width: 1, color: '#4f8ef7' }, showSymbol: false },
      {
        name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: vols,
        itemStyle: { color: (p) => data[p.dataIndex]?.close >= data[p.dataIndex]?.open ? '#e74c3c' : '#2ecc71' },
      },
    ],
  };
  klineChart.setOption(option);
}

// ── Main App ───────────────────────────────────────────────
const App = {
  user: null,
  stocks: [],         // ordered list of full_codes
  quotes: {},         // code -> quote data
  buyPrices: {},      // code -> buy price
  refreshInterval: null,
  refreshCountdown: 30,
  contextTarget: null,

  async init() {
    await this.checkAuth();
    this.bindEvents();
    this.bindSearch();
    this.updateMarketStatus();
    setInterval(() => this.updateMarketStatus(), 60000);

    // Enter key on login
    document.getElementById('loginPass').addEventListener('keydown', e => {
      if (e.key === 'Enter') this.login();
    });
    document.getElementById('addStockInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') this.addStock();
    });
  },

  async checkAuth() {
    try {
      const r = await fetch('/api/auth/check', { credentials: 'include' });
      const data = await r.json();
      if (data.logged_in) {
        this.setUser(data.user);
        await this.loadWatchlist();
        this.startRefresh();
      }
    } catch {}
  },

  setUser(user) {
    this.user = user;
    document.getElementById('btnLogin').style.display = 'none';
    document.getElementById('navUser').style.display = 'flex';
    document.getElementById('userAvatar').textContent = user.username[0].toUpperCase();
    document.getElementById('userName').textContent = user.username;
    if (user.role === 'admin') {
      document.getElementById('btnAdminMgr').style.display = 'inline-flex';
    } else {
      document.getElementById('btnProfile').style.display = 'inline-flex';
    }
    document.getElementById('watchlistAdd').style.display = 'flex';
    UI.hideLogin();
  },

  async login() {
    const username = document.getElementById('loginUser').value.trim();
    const password = document.getElementById('loginPass').value;
    const errEl = document.getElementById('loginError');
    errEl.classList.remove('show');
    if (!username || !password) { errEl.textContent = '请输入用户名和密码'; errEl.classList.add('show'); return; }
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await r.json();
      if (data.success) {
        this.setUser(data.user);
        await this.loadWatchlist();
        this.startRefresh();
        UI.toast('登录成功', 'success');
      } else {
        errEl.textContent = data.message || '登录失败';
        errEl.classList.add('show');
      }
    } catch { errEl.textContent = '网络错误'; errEl.classList.add('show'); }
  },

  async logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    this.user = null;
    this.stocks = [];
    this.quotes = {};
    this.buyPrices = {};
    this.stopRefresh();
    document.getElementById('btnLogin').style.display = '';
    document.getElementById('navUser').style.display = 'none';
    document.getElementById('btnAdminMgr').style.display = 'none';
    document.getElementById('btnProfile').style.display = 'none';
    document.getElementById('watchlistAdd').style.display = 'none';
    document.getElementById('watchlistBody').innerHTML = '<tr><td colspan="8"><div class="watchlist-empty">请先登录后添加自选股</div></td></tr>';
    document.getElementById('quoteDetailCard').style.display = 'none';
    document.getElementById('chartPlaceholder').style.display = 'flex';
    document.getElementById('kline-chart').style.display = 'none';
    currentCode = null;
    UI.toast('已退出登录', 'info');
  },

  async loadWatchlist() {
    const r = await fetch('/api/watchlist', { credentials: 'include' });
    const data = await r.json();
    if (data.success) {
      this.stocks = data.stocks;
      const bp = await fetch('/api/watchlist/buy_prices', { credentials: 'include' });
      const bpData = await bp.json();
      if (bpData.success) this.buyPrices = bpData.buy_prices;
    }
  },

  async addStock() {
    const input = document.getElementById('addStockInput');
    const code = input.value.trim();
    if (!code) return;
    const r = await fetch('/api/watchlist', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await r.json();
    if (data.success) {
      this.stocks = data.stocks;
      input.value = '';
      await this.fetchQuotes();
      UI.toast('已添加', 'success');
    } else {
      UI.toast(data.message || '添加失败', 'error');
    }
  },

  async removeStock(code) {
    const r = await fetch(`/api/watchlist/${code}`, { method: 'DELETE', credentials: 'include' });
    const data = await r.json();
    if (data.success) {
      this.stocks = data.stocks;
      await this.fetchQuotes();
      if (currentCode === code || currentCode === this._pureCode(code)) {
        currentCode = null;
        document.getElementById('chartPlaceholder').style.display = 'flex';
        document.getElementById('kline-chart').style.display = 'none';
        document.getElementById('quoteDetailCard').style.display = 'none';
      }
      UI.toast('已删除', 'success');
    }
  },

  async pinToTop(code) {
    const r = await fetch(`/api/watchlist/top/${code}`, { method: 'POST', credentials: 'include' });
    const data = await r.json();
    if (data.success) {
      this.stocks = data.stocks;
      await this.fetchQuotes();
      UI.toast('已置顶', 'success');
    }
  },

  _pureCode(fullCode) {
    return fullCode.startsWith('sh') || fullCode.startsWith('sz') ? fullCode.slice(2) : fullCode;
  },

  async fetchQuotes() {
    if (!this.stocks.length) {
      this.renderTable([]);
      return;
    }
    try {
      const r = await fetch('/api/quotes', { credentials: 'include' });
      const data = await r.json();
      if (data.success) {
        // index by pure code and full code
        this.quotes = {};
        for (const q of data.data) {
          this.quotes[q.code] = q;
          this.quotes[q.full_code] = q;
        }
        // maintain order from this.stocks
        const ordered = this.stocks.map(s => this.quotes[s] || this.quotes[this._pureCode(s)]).filter(Boolean);
        this.renderTable(ordered);
        // update chart if active
        if (currentCode) {
          const q = this.quotes[currentCode] || this.quotes[this._pureCode(currentCode)];
          if (q) this.updateChartHeader(q);
        }
      }
    } catch (e) { console.error(e); }
  },

  renderTable(rows) {
    const tbody = document.getElementById('watchlistBody');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8"><div class="watchlist-empty">暂无自选股，请搜索添加</div></td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(q => {
      const pct = q.change_pct || 0;
      const cls = pct > 0 ? 'rise' : pct < 0 ? 'fall' : 'flat';
      const sign = pct > 0 ? '+' : '';
      const atr = q.atr != null ? q.atr.toFixed(2) : '--';
      const buyPrice = this.buyPrices[q.full_code] || this.buyPrices[q.code] || '';
      const stopProfit = (q.atr != null && q.price) ? (q.price - 1.5 * q.atr).toFixed(2) : '--';
      const stopLoss   = (q.atr != null && buyPrice) ? (parseFloat(buyPrice) - 1.5 * q.atr).toFixed(2) : '--';

      // Border logic
      let spClass = 'stop-price', slClass = 'stop-price';
      if (stopProfit !== '--' && stopLoss !== '--') {
        const sp = parseFloat(stopProfit), sl = parseFloat(stopLoss);
        const higher = Math.max(sp, sl), lower = Math.min(sp, sl);
        if (q.price <= higher) {
          if (sp === higher) spClass += ' border-blue'; else slClass += ' border-blue';
        }
        if (q.price <= lower) {
          if (sp === lower) spClass += ' border-red'; else slClass += ' border-red';
        }
      }

      return `<tr data-code="${q.code}" data-full="${q.full_code}" onclick="App.selectStock('${q.code}','${q.full_code}')" oncontextmenu="App.showContextMenu(event,'${q.code}','${q.full_code}')">
        <td class="stock-code">${q.code}</td>
        <td class="stock-name">${q.name || '--'}</td>
        <td class="price ${cls}">${q.price != null ? q.price.toFixed(2) : '--'}</td>
        <td class="${cls}">${sign}${pct.toFixed(2)}%</td>
        <td><input class="buy-price-input" type="number" step="0.01" value="${buyPrice}" placeholder="买入价"
             onchange="App.saveBuyPrice('${q.code}','${q.full_code}',this.value)"
             onclick="event.stopPropagation()"></td>
        <td class="atr-val">${atr}</td>
        <td class="${spClass}">${stopProfit}</td>
        <td class="${slClass}">${stopLoss}</td>
      </tr>`;
    }).join('');

    // Scroll visibility
    const container = document.getElementById('watchlistContainer');
    container.style.overflowY = rows.length > 5 ? 'auto' : 'hidden';

    // Restore scroll position
    const saved = localStorage.getItem('watchlist_scroll');
    if (saved) container.scrollTop = parseInt(saved);
    container.addEventListener('scroll', () => {
      localStorage.setItem('watchlist_scroll', container.scrollTop);
    }, { passive: true });

    // Highlight active row
    if (currentCode) {
      document.querySelectorAll(`#watchlistBody tr[data-code="${currentCode}"], #watchlistBody tr[data-full="${currentCode}"]`).forEach(r => r.classList.add('active'));
    }
  },

  async selectStock(code, fullCode) {
    currentCode = code;
    // highlight
    document.querySelectorAll('#watchlistBody tr').forEach(r => r.classList.remove('active'));
    document.querySelectorAll(`#watchlistBody tr[data-code="${code}"]`).forEach(r => r.classList.add('active'));

    const q = this.quotes[code] || this.quotes[fullCode];
    if (q) {
      this.updateChartHeader(q);
      this.showQuoteDetail(q);
    }
    await this.loadKline(code);
  },

  updateChartHeader(q) {
    const pct = q.change_pct || 0;
    const cls = pct > 0 ? 'rise' : pct < 0 ? 'fall' : 'flat';
    document.getElementById('chartName').textContent = q.name || q.code;
    document.getElementById('chartPrice').textContent = q.price != null ? q.price.toFixed(2) : '';
    document.getElementById('chartPrice').className = `chart-stock-price ${cls}`;
    document.getElementById('chartChange').textContent = `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
    document.getElementById('chartChange').className = `chart-change ${cls}`;
  },

  showQuoteDetail(q) {
    document.getElementById('quoteDetailCard').style.display = '';
    document.getElementById('detailName').textContent = q.name || q.code;
    document.getElementById('detailCode').textContent = q.full_code || q.code;
    document.getElementById('dOpen').textContent      = q.open?.toFixed(2) ?? '--';
    document.getElementById('dHigh').textContent      = q.high?.toFixed(2) ?? '--';
    document.getElementById('dLow').textContent       = q.low?.toFixed(2)  ?? '--';
    document.getElementById('dPrevClose').textContent = q.prev_close?.toFixed(2) ?? '--';
    document.getElementById('dVolume').textContent    = q.volume ? (q.volume / 10000).toFixed(0) + '万手' : '--';
    document.getElementById('dAmount').textContent    = q.amount ? (q.amount / 100000000).toFixed(2) + '亿' : '--';
    document.getElementById('dAtr').textContent       = q.atr != null ? q.atr.toFixed(2) : '--';
    const chg = q.change || 0;
    const chgEl = document.getElementById('dChange');
    chgEl.textContent = `${chg > 0 ? '+' : ''}${chg.toFixed(2)}`;
    chgEl.className = `quote-value ${chg > 0 ? 'rise' : chg < 0 ? 'fall' : ''}`;
  },

  async loadKline(code) {
    document.getElementById('chartPlaceholder').style.display = 'none';
    document.getElementById('kline-chart').style.display = 'block';
    if (!klineChart) initChart();
    try {
      const r = await fetch(`/api/kline?code=${code}&period=${currentPeriod}&count=200`, { credentials: 'include' });
      const data = await r.json();
      if (data.success && data.data.length) {
        renderKline(data.data, code);
      } else {
        UI.toast('K线数据获取失败', 'error');
      }
    } catch (e) { UI.toast('网络错误', 'error'); }
  },

  async changePeriod(btn) {
    document.querySelectorAll('.period-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentPeriod = btn.dataset.period;
    if (currentCode) await this.loadKline(currentCode);
  },

  async saveBuyPrice(code, fullCode, value) {
    const price = value ? parseFloat(value) : null;
    const key = fullCode || code;
    if (price != null) this.buyPrices[key] = price; else delete this.buyPrices[key];
    await fetch('/api/watchlist/buy_price', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: key, price }),
    });
    // re-render current row
    const q = this.quotes[code] || this.quotes[fullCode];
    if (q) {
      const ordered = this.stocks.map(s => this.quotes[s] || this.quotes[this._pureCode(s)]).filter(Boolean);
      this.renderTable(ordered);
    }
  },

  // ── Context Menu ─────────────────────────────────────────
  showContextMenu(e, code, fullCode) {
    e.preventDefault();
    e.stopPropagation();
    this.contextTarget = { code, fullCode };
    const menu = document.getElementById('contextMenu');
    menu.style.left = e.pageX + 'px';
    menu.style.top  = e.pageY + 'px';
    menu.classList.add('show');
  },

  hideContextMenu() {
    document.getElementById('contextMenu').classList.remove('show');
    this.contextTarget = null;
  },

  bindEvents() {
    document.addEventListener('click', () => this.hideContextMenu());
    document.addEventListener('contextmenu', e => {
      if (!e.target.closest('#watchlistBody')) this.hideContextMenu();
    });
    document.getElementById('contextMenu').addEventListener('click', e => {
      e.stopPropagation();
      const item = e.target.closest('.context-menu-item');
      if (!item || !this.contextTarget) return;
      const { code, fullCode } = this.contextTarget;
      this.hideContextMenu();
      if (item.dataset.action === 'top')    this.pinToTop(fullCode || code);
      if (item.dataset.action === 'delete') this.removeStock(fullCode || code);
    });
  },

  // ── Search ───────────────────────────────────────────────
  bindSearch() {
    const input = document.getElementById('searchInput');
    const dropdown = document.getElementById('searchDropdown');
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { dropdown.classList.remove('show'); return; }
      timer = setTimeout(async () => {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { credentials: 'include' });
        const data = await r.json();
        if (!data.results?.length) { dropdown.classList.remove('show'); return; }
        dropdown.innerHTML = data.results.map(s => {
          const pct = s.change_pct || 0;
          const cls = pct > 0 ? 'rise' : pct < 0 ? 'fall' : '';
          return `<div class="search-item" onclick="App.addFromSearch('${s.full_code}')">
            <span>${s.name} <span class="s-code">${s.code}</span></span>
            <span><span class="s-price">${s.price?.toFixed(2) || '--'}</span> <span class="s-chg ${cls}">${pct > 0 ? '+' : ''}${pct.toFixed(2)}%</span></span>
          </div>`;
        }).join('');
        dropdown.classList.add('show');
      }, 350);
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('.navbar-search')) dropdown.classList.remove('show');
    });
  },

  async addFromSearch(fullCode) {
    document.getElementById('searchInput').value = '';
    document.getElementById('searchDropdown').classList.remove('show');
    if (!this.user) { UI.showLogin(); return; }
    const r = await fetch('/api/watchlist', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: fullCode }),
    });
    const data = await r.json();
    if (data.success) {
      this.stocks = data.stocks;
      await this.fetchQuotes();
      UI.toast('已添加到自选股', 'success');
    }
  },

  // ── Refresh ──────────────────────────────────────────────
  startRefresh() {
    this.fetchQuotes();
    this.refreshCountdown = 30;
    this.refreshInterval = setInterval(() => {
      this.refreshCountdown--;
      document.getElementById('refreshTimer').textContent = `${this.refreshCountdown}s 后刷新`;
      if (this.refreshCountdown <= 0) {
        this.fetchQuotes();
        this.refreshCountdown = 30;
      }
    }, 1000);
  },

  stopRefresh() {
    clearInterval(this.refreshInterval);
    document.getElementById('refreshTimer').textContent = '';
  },

  updateMarketStatus() {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    const day = now.getDay();
    const isWeekend = day === 0 || day === 6;
    const inAM = h === 9 && m >= 30 || h === 10 || h === 11 && m < 30;
    const inPM = h === 13 || h === 14 || h === 14 && m < 57;
    const isOpen = !isWeekend && (inAM || inPM);
    const el = document.getElementById('marketStatus');
    el.textContent = isOpen ? '● 交易中' : '○ 已收盘';
    el.style.color = isOpen ? 'var(--accent-green)' : 'var(--text-muted)';
  },
};

document.addEventListener('DOMContentLoaded', () => App.init());
