/* ============================================================
   选股器前端逻辑
   ============================================================ */

const FIELD_LABELS = {
  price:      '现价',
  change_pct: '涨跌幅(%)',
  high:       '最高价',
  low:        '最低价',
  amount:     '成交额(亿)',
  turnover:   '换手率(%)',
  pe:         '市盈率PE',
  pb:         '市净率PB',
  mktcap:     '总市值(亿)',
  ma5:        'MA5',
  ma10:       'MA10',
  ma20:       'MA20',
  ma60:       'MA60',
};

const MA_FIELDS = new Set(['ma5', 'ma10', 'ma20', 'ma60']);

const PRESETS = {
  momentum: {
    name: '价格突破MA60',
    factors: [
      { field: 'ma60',    op: 'price_above', value: 0 },
      { field: 'amount',  op: '>=',          value: 1 },
      { field: 'change_pct', op: '>=',       value: 0 },
    ],
  },
  value: {
    name: '低估值蓝筹',
    factors: [
      { field: 'pe',     op: '>',  value: 0 },
      { field: 'pe',     op: '<=', value: 20 },
      { field: 'pb',     op: '<=', value: 3 },
      { field: 'mktcap', op: '>=', value: 100 },
      { field: 'amount', op: '>=', value: 1 },
    ],
  },
  growth: {
    name: '高换手强势股',
    factors: [
      { field: 'turnover',   op: '>=', value: 5 },
      { field: 'change_pct', op: '>=', value: 3 },
      { field: 'amount',     op: '>=', value: 2 },
    ],
  },
  small: {
    name: '小市值成长',
    factors: [
      { field: 'mktcap',     op: '>=', value: 10 },
      { field: 'mktcap',     op: '<=', value: 50 },
      { field: 'change_pct', op: '>=', value: 0 },
      { field: 'amount',     op: '>=', value: 0.5 },
    ],
  },
};

// ── Toast ──────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// ── Main ───────────────────────────────────────────────────
const SCR = {
  strategies: [],
  activeIdx: -1,
  currentFactors: [],
  results: [],

  async init() {
    await this.checkAuth();
    await this.loadStrategies();
    this.renderFactors();
  },

  async checkAuth() {
    try {
      const r = await fetch('/api/auth/check', { credentials: 'include' });
      const d = await r.json();
      if (d.logged_in) {
        document.getElementById('btnLogin').style.display = 'none';
        document.getElementById('navUser').style.display = 'flex';
        document.getElementById('userAvatar').textContent = d.user.username[0].toUpperCase();
        document.getElementById('userName').textContent = d.user.username;
      }
    } catch {}
  },

  async logout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    location.href = '/';
  },

  // ── Strategies ─────────────────────────────────────────
  async loadStrategies() {
    try {
      const r = await fetch('/api/screener/strategies', { credentials: 'include' });
      const d = await r.json();
      if (d.success) {
        this.strategies = d.strategies || [];
        this.renderStrategyList();
        if (this.strategies.length) this.selectStrategy(0);
      }
    } catch {}
  },

  renderStrategyList() {
    const el = document.getElementById('strategyList');
    if (!this.strategies.length) {
      el.innerHTML = '<div class="scr-empty">暂无策略，点击新建</div>';
      return;
    }
    el.innerHTML = this.strategies.map((s, i) => `
      <div class="scr-strategy-item ${i === this.activeIdx ? 'active' : ''}" onclick="SCR.selectStrategy(${i})">
        <div>
          <div>${s.name || '未命名策略'}</div>
          <div class="scr-strategy-meta">${(s.factors || []).length} 个条件</div>
        </div>
        <span class="scr-del" onclick="event.stopPropagation();SCR.deleteStrategy(${i})">✕</span>
      </div>`).join('');
  },

  selectStrategy(idx) {
    this.activeIdx = idx;
    const s = this.strategies[idx];
    document.getElementById('strategyName').value = s.name || '未命名策略';
    this.currentFactors = JSON.parse(JSON.stringify(s.factors || []));
    this.renderFactors();
    this.renderStrategyList();
    // clear results
    document.getElementById('resultsBody').innerHTML = '<div class="scr-empty" style="padding:60px 0">点击"运行选股"查看结果</div>';
    document.getElementById('resultCount').textContent = '';
    document.getElementById('addAllBtn').style.display = 'none';
  },

  newStrategy() {
    const s = { name: '新策略', factors: [] };
    this.strategies.push(s);
    this.selectStrategy(this.strategies.length - 1);
    this.saveStrategies();
    document.getElementById('strategyName').focus();
    document.getElementById('strategyName').select();
  },

  deleteStrategy(idx) {
    if (!confirm(`删除策略"${this.strategies[idx].name}"？`)) return;
    this.strategies.splice(idx, 1);
    this.activeIdx = -1;
    this.currentFactors = [];
    this.renderStrategyList();
    this.renderFactors();
    this.saveStrategies();
    if (this.strategies.length) this.selectStrategy(0);
  },

  saveStrategy() {
    const name = document.getElementById('strategyName').value.trim() || '未命名策略';
    if (this.activeIdx < 0) {
      this.strategies.push({ name, factors: this.currentFactors });
      this.activeIdx = this.strategies.length - 1;
    } else {
      this.strategies[this.activeIdx] = { name, factors: this.currentFactors };
    }
    this.renderStrategyList();
    this.saveStrategies();
    toast('策略已保存', 'success');
  },

  async saveStrategies() {
    try {
      await fetch('/api/screener/strategies', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategies: this.strategies }),
      });
    } catch {}
  },

  // ── Factors ────────────────────────────────────────────
  addFactor() {
    const field = document.getElementById('addField').value;
    const isMA = MA_FIELDS.has(field);
    this.currentFactors.push({
      field,
      op: isMA ? 'price_above' : '>=',
      value: 0,
    });
    this.renderFactors();
  },

  removeFactor(idx) {
    this.currentFactors.splice(idx, 1);
    this.renderFactors();
  },

  renderFactors() {
    const el = document.getElementById('factorList');
    document.getElementById('factorCount').textContent = `${this.currentFactors.length} 个条件`;

    if (!this.currentFactors.length) {
      el.innerHTML = '<div class="scr-empty">暂无条件，请添加筛选因子</div>';
      return;
    }

    el.innerHTML = this.currentFactors.map((f, i) => {
      const isMA = MA_FIELDS.has(f.field);
      const opHtml = isMA
        ? `<select class="scr-select scr-ma-op" onchange="SCR.updateFactor(${i},'op',this.value)">
            <option value="price_above" ${f.op==='price_above'?'selected':''}>价格 > 均线</option>
            <option value="price_below" ${f.op==='price_below'?'selected':''}>价格 < 均线</option>
           </select>`
        : `<select class="scr-op-select" onchange="SCR.updateFactor(${i},'op',this.value)">
            <option value=">=" ${f.op==='>='?'selected':''}>≥</option>
            <option value="<=" ${f.op==='<='?'selected':''}>≤</option>
            <option value=">"  ${f.op==='>'?'selected':''}>></option>
            <option value="<"  ${f.op==='<'?'selected':''}>＜</option>
           </select>`;

      const valueHtml = isMA
        ? ''
        : `<input class="scr-value-input" type="number" step="any" value="${f.value}"
             onchange="SCR.updateFactor(${i},'value',this.value)">`;

      return `<div class="scr-factor-row">
        <span class="scr-factor-label">${FIELD_LABELS[f.field] || f.field}</span>
        ${opHtml}
        ${valueHtml}
        <span class="scr-factor-del" onclick="SCR.removeFactor(${i})">✕</span>
      </div>`;
    }).join('');
  },

  updateFactor(idx, key, val) {
    this.currentFactors[idx][key] = key === 'value' ? parseFloat(val) || 0 : val;
  },

  loadPreset(key) {
    const p = PRESETS[key];
    if (!p) return;
    document.getElementById('strategyName').value = p.name;
    this.currentFactors = JSON.parse(JSON.stringify(p.factors));
    this.renderFactors();
    toast(`已加载模板：${p.name}`, 'info');
  },

  // ── Run ────────────────────────────────────────────────
  async run() {
    if (!this.currentFactors.length) {
      toast('请先添加至少一个筛选条件', 'error'); return;
    }
    document.getElementById('scrOverlay').classList.remove('hidden');
    document.getElementById('runBtn').disabled = true;

    const start = Date.now();
    try {
      const r = await fetch('/api/screener/run', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ factors: this.currentFactors, limit: 200 }),
      });
      const d = await r.json();
      if (d.success) {
        this.results = d.results;
        this.renderResults(d.results);
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        toast(`找到 ${d.results.length} 只股票（${elapsed}s）`, 'success');
      } else {
        toast(d.message || '选股失败', 'error');
      }
    } catch (e) {
      toast('网络错误', 'error');
    } finally {
      document.getElementById('scrOverlay').classList.add('hidden');
      document.getElementById('runBtn').disabled = false;
    }
  },

  renderResults(rows) {
    const countEl = document.getElementById('resultCount');
    const addAllBtn = document.getElementById('addAllBtn');
    const body = document.getElementById('resultsBody');

    if (!rows.length) {
      countEl.textContent = '无符合条件的股票';
      addAllBtn.style.display = 'none';
      body.innerHTML = '<div class="scr-empty" style="padding:60px 0">没有找到符合条件的股票，请调整筛选条件</div>';
      return;
    }

    countEl.textContent = `共 ${rows.length} 只`;
    addAllBtn.style.display = '';

    body.innerHTML = `<table class="scr-table">
      <thead><tr>
        <th>#</th><th>代码 / 名称</th>
        <th>现价</th><th>涨跌幅</th>
        <th>成交额(亿)</th><th>换手率%</th>
        <th>市值(亿)</th><th>PE</th><th>PB</th>
        <th></th>
      </tr></thead>
      <tbody>${rows.map((r, i) => {
        const cls = r.change_pct > 0 ? 'rise' : r.change_pct < 0 ? 'fall' : 'flat';
        const sign = r.change_pct > 0 ? '+' : '';
        return `<tr onclick="SCR.openStock('${r.code}','${r.symbol}')">
          <td class="scr-rank">${i + 1}</td>
          <td><div class="scr-name">${r.name}</div><div class="scr-code">${r.code}</div></td>
          <td class="price ${cls}">${r.price.toFixed(2)}</td>
          <td class="${cls}">${sign}${r.change_pct.toFixed(2)}%</td>
          <td>${r.amount.toFixed(2)}</td>
          <td>${r.turnover.toFixed(2)}</td>
          <td>${r.mktcap.toFixed(0)}</td>
          <td>${r.pe > 0 ? r.pe.toFixed(1) : '--'}</td>
          <td>${r.pb > 0 ? r.pb.toFixed(2) : '--'}</td>
          <td><button class="scr-add-btn" onclick="event.stopPropagation();SCR.addToWatchlist('${r.symbol}')">+自选</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  },

  openStock(code, symbol) {
    // Open main page with this stock selected
    sessionStorage.setItem('openStock', symbol || code);
    location.href = '/';
  },

  async addToWatchlist(symbol) {
    try {
      const r = await fetch('/api/watchlist', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: symbol }),
      });
      const d = await r.json();
      toast(d.success ? '已加入自选股' : (d.message || '添加失败'), d.success ? 'success' : 'error');
    } catch { toast('网络错误', 'error'); }
  },

  async addAllToWatchlist() {
    if (!this.results.length) return;
    if (!confirm(`将 ${this.results.length} 只股票全部加入自选股？`)) return;
    let ok = 0;
    for (const r of this.results.slice(0, 50)) {
      try {
        const res = await fetch('/api/watchlist', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: r.symbol }),
        });
        const d = await res.json();
        if (d.success) ok++;
      } catch {}
    }
    toast(`已添加 ${ok} 只到自选股`, 'success');
  },
};

document.addEventListener('DOMContentLoaded', () => SCR.init());
