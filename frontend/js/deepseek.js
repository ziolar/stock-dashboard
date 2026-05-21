/* ============================================================
   DeepSeek AI 对话模块
   ============================================================ */

const DS = {
  history: [],   // {role, content}
  loading: false,

  send() {
    const input = document.getElementById('dsInput');
    const text = input.value.trim();
    if (!text || this.loading) return;
    input.value = '';
    input.style.height = '';

    this._hideWelcome();
    this._appendMsg('user', text);
    this.history.push({ role: 'user', content: text });
    this._doRequest();
  },

  clear() {
    this.history = [];
    this.loading = false;
    const el = document.getElementById('dsMessages');
    el.innerHTML = `
      <div class="ds-welcome">
        <div class="ds-welcome-icon">🤖</div>
        <div>你好！我是 DeepSeek AI 助手</div>
        <div class="ds-welcome-sub">可以问我股票分析、技术指标、投资策略等问题</div>
      </div>`;
    document.getElementById('dsSendBtn').disabled = false;
  },

  // Inject current stock context into system prompt
  _systemPrompt() {
    let ctx = '你是一个专业的A股投资分析助手，擅长技术分析、基本面分析和风险管理。回答简洁专业，使用中文。';
    if (typeof currentCode !== 'undefined' && currentCode && typeof App !== 'undefined') {
      const q = App.quotes[currentCode] || App.quotes[App._pureCode?.(currentCode)];
      if (q) {
        ctx += `\n\n当前用户正在查看的股票：${q.name}（${q.code}），现价 ${q.price?.toFixed(2)}，涨跌幅 ${q.change_pct?.toFixed(2)}%，ATR(14)=${q.atr ?? '--'}。`;
      }
    }
    return ctx;
  },

  async _doRequest() {
    this.loading = true;
    document.getElementById('dsSendBtn').disabled = true;

    const thinkingId = 'ds-thinking-' + Date.now();
    this._appendThinking(thinkingId);

    const messages = [
      { role: 'system', content: this._systemPrompt() },
      ...this.history,
    ];

    try {
      const r = await fetch('/api/deepseek/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      });
      const data = await r.json();
      this._removeThinking(thinkingId);
      if (data.success) {
        this._appendMsg('assistant', data.content);
        this.history.push({ role: 'assistant', content: data.content });
      } else {
        this._appendError(data.message || '请求失败');
      }
    } catch (e) {
      this._removeThinking(thinkingId);
      this._appendError('网络错误，请重试');
    } finally {
      this.loading = false;
      document.getElementById('dsSendBtn').disabled = false;
    }
  },

  _hideWelcome() {
    const w = document.querySelector('.ds-welcome');
    if (w) w.remove();
  },

  _appendMsg(role, content) {
    const el = document.getElementById('dsMessages');
    const div = document.createElement('div');
    div.className = `ds-msg ds-msg-${role}`;
    // Simple markdown: bold, code blocks, line breaks
    div.innerHTML = this._renderMarkdown(content);
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  },

  _appendThinking(id) {
    const el = document.getElementById('dsMessages');
    const div = document.createElement('div');
    div.className = 'ds-msg ds-msg-assistant ds-thinking';
    div.id = id;
    div.innerHTML = '<span class="ds-dot"></span><span class="ds-dot"></span><span class="ds-dot"></span>';
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  },

  _removeThinking(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
  },

  _appendError(msg) {
    const el = document.getElementById('dsMessages');
    const div = document.createElement('div');
    div.className = 'ds-msg ds-msg-error';
    div.textContent = '⚠ ' + msg;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  },

  _renderMarkdown(text) {
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  },

  init() {
    const input = document.getElementById('dsInput');
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        DS.send();
      }
    });
    // Auto-resize textarea
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    });
  },
};

document.addEventListener('DOMContentLoaded', () => DS.init());
