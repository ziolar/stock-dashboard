// backtest.js — 回测页面前端逻辑
const BKT = (() => {
  // 每个模块的生成代码存储
  const codes = { select: '', buy: '', sell: '', loop: '' };
  let chart = null;
  let strategies = [];
  let currentStrategyId = null;

  // ── 初始化 ────────────────────────────────────────────────
  async function init() {
    // 设置默认结束日期为今天
    const today = new Date().toISOString().slice(0, 10);
    document.getElementById('bkt-end-date').value = today;

    // 检查登录状态
    try {
      const res = await fetch('/api/auth/check', { credentials: 'include' });
      const data = await res.json();
      if (data.logged_in) {
        document.getElementById('navUser').style.display = 'flex';
        document.getElementById('userAvatar').textContent = data.user.username[0].toUpperCase();
        document.getElementById('userName').textContent = data.user.username;
        document.getElementById('btnLogin').style.display = 'none';
        await loadStrategies();
      }
    } catch (e) {
      console.warn('auth check failed', e);
    }

    // 初始化 ECharts
    chart = echarts.init(document.getElementById('bkt-chart'));
    window.addEventListener('resize', () => chart && chart.resize());
  }

  // ── Auth ──────────────────────────────────────────────────
  function logout() {
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
      .then(() => location.href = '/');
  }

  // ── 策略管理 ──────────────────────────────────────────────
  async function loadStrategies() {
    try {
      const res = await fetch('/api/backtest/strategies', { credentials: 'include' });
      const data = await res.json();
      if (data.success) {
        strategies = data.strategies || [];
        renderStrategyList();
      }
    } catch (e) {
      console.warn('load strategies failed', e);
    }
  }

  function renderStrategyList() {
    const sel = document.getElementById('bkt-strategy-list');
    const cur = sel.value;
    sel.innerHTML = '<option value="">— 选择已保存策略 —</option>';
    strategies.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      if (s.id === currentStrategyId) opt.selected = true;
      sel.appendChild(opt);
    });
    if (cur) sel.value = cur;
  }

  function loadStrategy(id) {
    if (!id) return;
    const s = strategies.find(s => s.id === id);
    if (!s) return;
    currentStrategyId = id;
    document.getElementById('bkt-strategy-name').value = s.name || '';
    document.getElementById('txt-select').value = s.txt_select || '';
    document.getElementById('txt-buy').value = s.txt_buy || '';
    document.getElementById('txt-sell').value = s.txt_sell || '';
    document.getElementById('txt-loop').value = s.txt_loop || '';
    codes.select = s.code_select || '';
    codes.buy    = s.code_buy    || '';
    codes.sell   = s.code_sell   || '';
    codes.loop   = s.code_loop   || '';
    // Render code previews
    ['select', 'buy', 'sell', 'loop'].forEach(m => {
      const el = document.getElementById('code-' + m);
      if (codes[m]) {
        el.textContent = codes[m];
        el.classList.add('visible');
      }
    });
    // Restore config
    if (s.universe) document.getElementById('bkt-universe').value = s.universe;
    if (s.start_date) document.getElementById('bkt-start-date').value = s.start_date;
    if (s.end_date)   document.getElementById('bkt-end-date').value   = s.end_date;
    if (s.capital)    document.getElementById('bkt-capital').value    = s.capital;
    onUniverseChange();
  }

  async function saveStrategy() {
    const name = document.getElementById('bkt-strategy-name').value.trim();
    if (!name) { showError('请输入策略名称'); return; }
    const strategy = {
      id: currentStrategyId || undefined,
      name,
      txt_select: document.getElementById('txt-select').value,
      txt_buy:    document.getElementById('txt-buy').value,
      txt_sell:   document.getElementById('txt-sell').value,
      txt_loop:   document.getElementById('txt-loop').value,
      code_select: codes.select,
      code_buy:    codes.buy,
      code_sell:   codes.sell,
      code_loop:   codes.loop,
      universe:   document.getElementById('bkt-universe').value,
      start_date: document.getElementById('bkt-start-date').value,
      end_date:   document.getElementById('bkt-end-date').value,
      capital:    document.getElementById('bkt-capital').value,
    };
    try {
      const res = await fetch('/api/backtest/strategies', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ strategy }),
      });
      const data = await res.json();
      if (data.success) {
        currentStrategyId = data.strategy.id;
        await loadStrategies();
        document.getElementById('bkt-strategy-list').value = currentStrategyId;
        showToast('策略已保存');
      } else {
        showError(data.message || '保存失败');
      }
    } catch (e) {
      showError('保存失败: ' + e.message);
    }
  }

  async function deleteStrategy() {
    const id = document.getElementById('bkt-strategy-list').value;
    if (!id) return;
    const s = strategies.find(s => s.id === id);
    if (!confirm(`确认删除策略「${s?.name || id}」？`)) return;
    try {
      await fetch('/api/backtest/strategies/' + id, { method: 'DELETE', credentials: 'include' });
      currentStrategyId = null;
      await loadStrategies();
    } catch (e) {
      showError('删除失败: ' + e.message);
    }
  }

  // ── AI 转换 ───────────────────────────────────────────────
  async function translate(module) {
    const text = document.getElementById('txt-' + module).value.trim();
    if (!text) { setStatus(module, '请先输入策略描述', 'error'); return; }

    const btn = document.querySelector(`#mod-${module} .bkt-btn-translate`);
    btn.disabled = true;
    btn.textContent = '生成中…';
    setStatus(module, '正在调用 AI…');

    try {
      const res = await fetch('/api/backtest/translate', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module, text }),
      });
      const data = await res.json();
      if (data.success) {
        codes[module] = data.code;
        const codeEl = document.getElementById('code-' + module);
        codeEl.textContent = data.code;
        codeEl.classList.add('visible');
        setStatus(module, '✓ 代码已生成', 'ok');
      } else {
        setStatus(module, data.message || '生成失败', 'error');
      }
    } catch (e) {
      setStatus(module, '生成失败: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '✨ 生成代码';
    }
  }

  function toggleCode(module) {
    const el = document.getElementById('code-' + module);
    el.classList.toggle('visible');
    const btn = document.querySelector(`#mod-${module} .bkt-btn-toggle-code`);
    btn.textContent = el.classList.contains('visible') ? '隐藏代码' : '查看代码';
  }

  function setStatus(module, msg, type = '') {
    const el = document.getElementById('st-' + module);
    el.textContent = msg;
    el.className = 'bkt-translate-status' + (type ? ' ' + type : '');
  }

  // ── 回测运行 ──────────────────────────────────────────────
  function onUniverseChange() {
    const val = document.getElementById('bkt-universe').value;
    const wrap = document.getElementById('bkt-custom-wrap');
    wrap.classList.toggle('visible', val === 'custom');
  }

  async function run() {
    hideError();
    clearResults();

    // 如果有未生成代码的模块但有文字描述，先生成
    const modules = ['select', 'buy', 'sell', 'loop'];
    for (const m of modules) {
      const txt = document.getElementById('txt-' + m).value.trim();
      if (txt && !codes[m]) {
        await translate(m);
      }
    }

    // 检查至少有选股代码
    if (!codes.select) {
      showError('请先输入选股策略并生成代码');
      return;
    }

    const universeType = document.getElementById('bkt-universe').value;
    const customInput  = document.getElementById('bkt-custom-codes').value;
    const customCodes  = universeType === 'custom'
      ? customInput.split(',').map(s => s.trim()).filter(Boolean)
      : [];
    const startDate     = document.getElementById('bkt-start-date').value;
    const endDate       = document.getElementById('bkt-end-date').value;
    const capitalWan    = parseFloat(document.getElementById('bkt-capital').value) || 100;
    const initialCapital = capitalWan * 10000;

    if (!startDate || !endDate) { showError('请选择回测时间区间'); return; }
    if (startDate >= endDate)   { showError('开始日期必须早于结束日期'); return; }

    setRunning(true);
    showProgress(0, '准备中…');

    const body = {
      strategy: {
        select_code: codes.select,
        buy_code:    codes.buy,
        sell_code:   codes.sell,
        loop_code:   codes.loop,
      },
      universe:        universeType,
      custom_codes:    customCodes,
      start_date:      startDate,
      end_date:        endDate,
      initial_capital: initialCapital,
    };

    try {
      const res = await fetch('/api/backtest/run', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const json = line.slice(6).trim();
          if (!json) continue;
          let msg;
          try { msg = JSON.parse(json); } catch { continue; }
          handleSSE(msg);
        }
      }
    } catch (e) {
      showError('回测失败: ' + e.message);
    } finally {
      setRunning(false);
      hideProgress();
    }
  }

  function handleSSE(msg) {
    if (msg.type === 'progress') {
      showProgress(msg.pct, msg.msg);
    } else if (msg.type === 'done') {
      renderResults(msg.result);
    } else if (msg.type === 'error') {
      showError(msg.message || '回测出错');
    }
    // heartbeat: ignore
  }

  // ── 结果渲染 ──────────────────────────────────────────────
  function renderResults(result) {
    renderMetrics(result.metrics || {});
    renderChart(result.equity_curve || [], result.benchmark || []);
    renderTrades(result.trades || []);
  }

  function renderMetrics(m) {
    const grid = document.getElementById('bkt-metrics');
    grid.innerHTML = '';
    const items = [
      { label: '策略总收益', value: m.total_return, fmt: 'pct' },
      { label: '年化收益率', value: m.annual_return, fmt: 'pct' },
      { label: '基准收益',   value: m.benchmark_return, fmt: 'pct' },
      { label: '最大回撤',   value: m.max_drawdown, fmt: 'pct', invert: true },
      { label: '夏普比率',   value: m.sharpe, fmt: 'num2' },
      { label: '胜率',       value: m.win_rate, fmt: 'pct' },
      { label: '总交易次数', value: m.total_trades, fmt: 'int' },
      { label: '回测天数',   value: m.trading_days, fmt: 'int' },
    ];
    items.forEach(({ label, value, fmt, invert }) => {
      if (value == null) return;
      const card = document.createElement('div');
      card.className = 'bkt-metric-card';
      let display, cls = '';
      if (fmt === 'pct') {
        display = (value >= 0 ? '+' : '') + (value * 100).toFixed(2) + '%';
        const pos = invert ? value < 0 : value > 0;
        cls = pos ? 'positive' : (value < 0 ? 'negative' : '');
      } else if (fmt === 'num2') {
        display = value.toFixed(2);
        cls = value > 0 ? 'positive' : '';
      } else {
        display = String(value);
      }
      card.innerHTML = `<div class="bkt-metric-label">${label}</div>
        <div class="bkt-metric-value ${cls}">${display}</div>`;
      grid.appendChild(card);
    });
    grid.classList.add('visible');
  }

  function renderChart(equity, benchmark) {
    const card = document.getElementById('bkt-chart-card');
    card.classList.add('visible');
    chart.resize();

    const dates = equity.map(e => e.date);
    const eqVals = equity.map(e => ((e.value - 1) * 100).toFixed(2));
    const bmVals = benchmark.map(e => ((e.value - 1) * 100).toFixed(2));

    chart.setOption({
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'var(--bg-secondary)',
        borderColor: 'var(--border)',
        textStyle: { color: 'var(--text-primary)', fontSize: 12 },
        formatter: params => {
          let html = `<div style="margin-bottom:4px;color:var(--text-muted);font-size:11px">${params[0].axisValue}</div>`;
          params.forEach(p => {
            const sign = p.value >= 0 ? '+' : '';
            html += `<div>${p.marker}${p.seriesName}: <b>${sign}${p.value}%</b></div>`;
          });
          return html;
        }
      },
      legend: {
        data: ['策略收益', '沪深300基准'],
        textStyle: { color: 'var(--text-muted)', fontSize: 12 },
        top: 0, right: 0,
      },
      grid: { top: 36, right: 16, bottom: 36, left: 60 },
      xAxis: {
        type: 'category', data: dates,
        axisLabel: { color: 'var(--text-muted)', fontSize: 11 },
        axisLine: { lineStyle: { color: 'var(--border)' } },
        splitLine: { show: false },
        // Show fewer labels for readability
        axisLabel: { interval: Math.floor(dates.length / 6), color: 'var(--text-muted)', fontSize: 11 },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: 'var(--text-muted)', fontSize: 11, formatter: v => v + '%' },
        axisLine: { show: false },
        splitLine: { lineStyle: { color: 'var(--border)', type: 'dashed' } },
      },
      series: [
        {
          name: '策略收益', type: 'line', data: eqVals,
          smooth: true, symbol: 'none',
          lineStyle: { color: '#60a5fa', width: 2 },
          areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [{ offset: 0, color: 'rgba(96,165,250,0.2)' }, { offset: 1, color: 'rgba(96,165,250,0)' }] } },
        },
        {
          name: '沪深300基准', type: 'line', data: bmVals,
          smooth: true, symbol: 'none',
          lineStyle: { color: '#f59e0b', width: 1.5, type: 'dashed' },
        },
      ],
    });
  }

  function renderTrades(trades) {
    if (!trades.length) return;
    const card = document.getElementById('bkt-trades-card');
    card.classList.add('visible');
    document.getElementById('bkt-trade-count').textContent = `共 ${trades.length} 笔`;
    const tbody = document.getElementById('bkt-trades-body');
    tbody.innerHTML = '';
    trades.slice(0, 500).forEach(t => {
      const tr = document.createElement('tr');
      const pnl = t.pnl != null
        ? `<span class="${t.pnl >= 0 ? 'trade-pnl-pos' : 'trade-pnl-neg'}">${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(0)}</span>`
        : '—';
      tr.innerHTML = `
        <td>${t.date}</td>
        <td>${t.code}</td>
        <td>${t.name}</td>
        <td class="${t.action === 'buy' ? 'trade-buy' : 'trade-sell'}">${t.action === 'buy' ? '买入' : '卖出'}</td>
        <td>${t.price.toFixed(2)}</td>
        <td>${t.shares.toLocaleString()}</td>
        <td>${(t.amount / 10000).toFixed(2)}万</td>
        <td>${pnl}</td>`;
      tbody.appendChild(tr);
    });
  }

  // ── 工具函数 ──────────────────────────────────────────────
  function clearResults() {
    document.getElementById('bkt-metrics').innerHTML = '';
    document.getElementById('bkt-metrics').classList.remove('visible');
    document.getElementById('bkt-chart-card').classList.remove('visible');
    document.getElementById('bkt-trades-card').classList.remove('visible');
    document.getElementById('bkt-trades-body').innerHTML = '';
    if (chart) chart.clear();
  }

  function setRunning(on) {
    ['bkt-run-btn', 'bkt-run-btn-sidebar'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) { btn.disabled = on; btn.textContent = on ? '回测中…' : '▶ 运行回测'; }
    });
  }

  function showProgress(pct, msg) {
    const wrap = document.getElementById('bkt-progress');
    wrap.classList.add('visible');
    document.getElementById('bkt-progress-bar').style.width = (pct * 100) + '%';
    document.getElementById('bkt-progress-msg').textContent = msg || '';
  }

  function hideProgress() {
    document.getElementById('bkt-progress').classList.remove('visible');
  }

  function showError(msg) {
    const el = document.getElementById('bkt-error');
    el.textContent = msg;
    el.classList.add('visible');
  }

  function hideError() {
    document.getElementById('bkt-error').classList.remove('visible');
  }

  let _toastTimer = null;
  function showToast(msg) {
    let el = document.getElementById('bkt-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'bkt-toast';
      el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--accent-blue);color:#fff;padding:8px 20px;border-radius:4px;font-size:13px;z-index:999;pointer-events:none';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2000);
  }

  // Public API
  return { init, logout, translate, toggleCode, onUniverseChange, run,
           saveStrategy, loadStrategy, loadStrategies, deleteStrategy };
})();

document.addEventListener('DOMContentLoaded', BKT.init);
