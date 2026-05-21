"""
A股股票监控 - Flask 后端
"""
from __future__ import annotations
from flask import Flask, request, jsonify, session, send_from_directory
from flask_cors import CORS
import os
import json
import time
import threading

import auth
import stock_api
import screener as screener_engine

# ATR cache: code -> (atr_value, timestamp)
_atr_cache: dict = {}
_atr_cache_ttl = 1800  # 30 minutes
_atr_lock = threading.Lock()

def _fetch_atr_bg(code: str):
    """Fetch ATR in a background thread and store in cache."""
    try:
        kline = stock_api.get_kline(code, 'daily', 60)
        atr = stock_api.calc_atr(kline)
    except Exception:
        atr = None
    with _atr_lock:
        _atr_cache[code] = (atr, time.time())

def _get_atr_cached(code: str) -> float | None:
    now = time.time()
    with _atr_lock:
        entry = _atr_cache.get(code)
        if entry:
            if now - entry[1] < _atr_cache_ttl:
                return entry[0]   # fresh cache hit
            # stale — refresh in background, return old value for now
            threading.Thread(target=_fetch_atr_bg, args=(code,), daemon=True).start()
            return entry[0]
    # Not in cache at all — trigger background fetch, return None for this call
    threading.Thread(target=_fetch_atr_bg, args=(code,), daemon=True).start()
    return None

app = Flask(__name__, static_folder='../frontend', static_url_path='')
app.secret_key = 'stock-monitor-secret-key-2024'
CORS(app, supports_credentials=True)

WATCHLIST_DIR = os.path.join(os.path.dirname(__file__), 'data', 'watchlists')
os.makedirs(WATCHLIST_DIR, exist_ok=True)

auth.ensure_default_admin()


# ── Static pages ────────────────────────────────────────────

@app.route('/')
def index():
    return send_from_directory('../frontend', 'index.html')


@app.route('/<path:path>')
def static_files(path):
    return send_from_directory('../frontend', path)


# ── Auth APIs ───────────────────────────────────────────────

@app.route('/api/auth/login', methods=['POST'])
def login():
    data = request.get_json() or {}
    user = auth.login(data.get('username', ''), data.get('password', ''))
    if not user:
        return jsonify({'success': False, 'message': '用户名或密码错误'}), 401
    session['user'] = user
    return jsonify({'success': True, 'user': user})


@app.route('/api/auth/logout', methods=['POST'])
def logout():
    session.pop('user', None)
    return jsonify({'success': True})


@app.route('/api/auth/check')
def check_auth():
    user = session.get('user')
    if user:
        return jsonify({'logged_in': True, 'user': user})
    return jsonify({'logged_in': False})


@app.route('/api/auth/users', methods=['GET'])
def list_users():
    user = session.get('user')
    if not user or user['role'] != 'admin':
        return jsonify({'success': False, 'message': '无权限'}), 403
    return jsonify({'success': True, 'users': auth.get_all_users()})


@app.route('/api/auth/users', methods=['POST'])
def create_user():
    user = session.get('user')
    if not user or user['role'] != 'admin':
        return jsonify({'success': False, 'message': '无权限'}), 403
    data = request.get_json() or {}
    ok, msg = auth.create_user(data.get('username', ''), data.get('password', ''), data.get('role', 'user'))
    return jsonify({'success': ok, 'message': msg})


@app.route('/api/auth/users/<username>', methods=['DELETE'])
def delete_user(username):
    user = session.get('user')
    if not user or user['role'] != 'admin':
        return jsonify({'success': False, 'message': '无权限'}), 403
    ok, msg = auth.delete_user(username)
    return jsonify({'success': ok, 'message': msg})


@app.route('/api/auth/password', methods=['POST'])
def change_password():
    user = session.get('user')
    if not user:
        return jsonify({'success': False, 'message': '请先登录'}), 401
    data = request.get_json() or {}
    ok, msg = auth.change_password(user['username'], data.get('old_password', ''), data.get('new_password', ''))
    return jsonify({'success': ok, 'message': msg})


# ── Watchlist APIs ──────────────────────────────────────────

def _watchlist_path(username: str) -> str:
    return os.path.join(WATCHLIST_DIR, f'{username}.json')


def _load_watchlist(username: str) -> list:
    path = _watchlist_path(username)
    if not os.path.exists(path):
        return []
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def _save_watchlist(username: str, stocks: list):
    with open(_watchlist_path(username), 'w', encoding='utf-8') as f:
        json.dump(stocks, f, ensure_ascii=False, indent=2)


@app.route('/api/watchlist', methods=['GET'])
def get_watchlist():
    user = session.get('user')
    if not user:
        return jsonify({'success': False, 'message': '请先登录'}), 401
    stocks = _load_watchlist(user['username'])
    return jsonify({'success': True, 'stocks': stocks})


@app.route('/api/watchlist', methods=['POST'])
def add_to_watchlist():
    user = session.get('user')
    if not user:
        return jsonify({'success': False, 'message': '请先登录'}), 401
    data = request.get_json() or {}
    code = data.get('code', '').strip()
    if not code:
        return jsonify({'success': False, 'message': '股票代码不能为空'})
    stocks = _load_watchlist(user['username'])
    # normalize
    prefix, pure = stock_api._normalize_code(code)
    full_code = prefix + pure
    if full_code not in stocks and pure not in stocks:
        stocks.append(full_code)
        _save_watchlist(user['username'], stocks)
    return jsonify({'success': True, 'stocks': stocks})


@app.route('/api/watchlist/<code>', methods=['DELETE'])
def remove_from_watchlist(code):
    user = session.get('user')
    if not user:
        return jsonify({'success': False, 'message': '请先登录'}), 401
    stocks = _load_watchlist(user['username'])
    prefix, pure = stock_api._normalize_code(code)
    full_code = prefix + pure
    stocks = [s for s in stocks if s != full_code and s != pure and s != code]
    _save_watchlist(user['username'], stocks)
    return jsonify({'success': True, 'stocks': stocks})


@app.route('/api/watchlist/top/<code>', methods=['POST'])
def pin_to_top(code):
    user = session.get('user')
    if not user:
        return jsonify({'success': False, 'message': '请先登录'}), 401
    stocks = _load_watchlist(user['username'])
    prefix, pure = stock_api._normalize_code(code)
    full_code = prefix + pure
    # find by either format
    idx = next((i for i, s in enumerate(stocks) if s == full_code or s == pure or s == code), -1)
    if idx > 0:
        item = stocks.pop(idx)
        stocks.insert(0, item)
        _save_watchlist(user['username'], stocks)
    return jsonify({'success': True, 'stocks': stocks})


@app.route('/api/watchlist/order', methods=['POST'])
def save_order():
    user = session.get('user')
    if not user:
        return jsonify({'success': False, 'message': '请先登录'}), 401
    data = request.get_json() or {}
    stocks = data.get('stocks', [])
    _save_watchlist(user['username'], stocks)
    return jsonify({'success': True})


@app.route('/api/watchlist/buy_price', methods=['POST'])
def save_buy_price():
    user = session.get('user')
    if not user:
        return jsonify({'success': False, 'message': '请先登录'}), 401
    data = request.get_json() or {}
    code = data.get('code', '')
    price = data.get('price')
    # Store buy prices in a separate file
    bp_path = os.path.join(WATCHLIST_DIR, f'{user["username"]}_buy_prices.json')
    if os.path.exists(bp_path):
        with open(bp_path, encoding='utf-8') as f:
            buy_prices = json.load(f)
    else:
        buy_prices = {}
    if price is not None:
        buy_prices[code] = price
    else:
        buy_prices.pop(code, None)
    with open(bp_path, 'w', encoding='utf-8') as f:
        json.dump(buy_prices, f, ensure_ascii=False)
    return jsonify({'success': True})


@app.route('/api/watchlist/buy_prices', methods=['GET'])
def get_buy_prices():
    user = session.get('user')
    if not user:
        return jsonify({'success': False, 'message': '请先登录'}), 401
    bp_path = os.path.join(WATCHLIST_DIR, f'{user["username"]}_buy_prices.json')
    if os.path.exists(bp_path):
        with open(bp_path, encoding='utf-8') as f:
            buy_prices = json.load(f)
    else:
        buy_prices = {}
    return jsonify({'success': True, 'buy_prices': buy_prices})


# ── Stock data APIs ─────────────────────────────────────────

@app.route('/api/quotes', methods=['GET'])
def get_quotes():
    user = session.get('user')
    if not user:
        return jsonify({'success': False, 'message': '请先登录'}), 401
    codes_param = request.args.get('codes', '')
    if not codes_param:
        stocks = _load_watchlist(user['username'])
    else:
        stocks = [c.strip() for c in codes_param.split(',') if c.strip()]
    if not stocks:
        return jsonify({'success': True, 'data': []})
    quotes = stock_api.get_realtime_quotes_batch(stocks)
    # Attach ATR from cache (non-blocking)
    for q in quotes:
        if 'error' not in q:
            q['atr'] = _get_atr_cached(q['code'])
    return jsonify({'success': True, 'data': quotes})


@app.route('/api/kline', methods=['GET'])
def get_kline():
    code = request.args.get('code', '')
    period = request.args.get('period', 'daily')
    count = int(request.args.get('count', 120))
    if not code:
        return jsonify({'success': False, 'message': '缺少股票代码'}), 400
    data = stock_api.get_kline(code, period, count)
    if not data:
        return jsonify({'success': False, 'message': '获取K线数据失败'})
    return jsonify({'success': True, 'data': data, 'atr': stock_api.calc_atr(data)})


@app.route('/api/search', methods=['GET'])
def search():
    keyword = (request.args.get('keyword') or request.args.get('q') or '').strip()
    if not keyword:
        return jsonify({'success': True, 'results': []})
    results = stock_api.search_stock(keyword)
    return jsonify({'success': True, 'results': results})


# ── DeepSeek Chat API ───────────────────────────────────────

DEEPSEEK_API_KEY = 'sk-f1a461e497fd4fb492a1b4b43bd8b48b'
DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions'

@app.route('/api/deepseek/chat', methods=['POST'])
def deepseek_chat():
    data = request.get_json() or {}
    messages = data.get('messages', [])
    if not messages:
        return jsonify({'success': False, 'message': '消息不能为空'}), 400

    try:
        import requests as _requests
        resp = _requests.post(
            DEEPSEEK_API_URL,
            headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {DEEPSEEK_API_KEY}',
            },
            json={
                'model': 'deepseek-chat',
                'messages': messages,
                'stream': False,
                'max_tokens': 1024,
            },
            timeout=30,
        )
        resp.raise_for_status()
        content = resp.json()['choices'][0]['message']['content']
        return jsonify({'success': True, 'content': content})
    except Exception as e:
        return jsonify({'success': False, 'message': f'DeepSeek API 调用失败: {e}'}), 500


# ── Screener APIs ────────────────────────────────────────────

STRATEGIES_PATH = os.path.join(os.path.dirname(__file__), 'data', 'strategies.json')

def _load_strategies(username: str) -> list:
    if not os.path.exists(STRATEGIES_PATH):
        return []
    with open(STRATEGIES_PATH, encoding='utf-8') as f:
        all_s = json.load(f)
    return all_s.get(username, [])

def _save_strategies(username: str, strategies: list):
    all_s = {}
    if os.path.exists(STRATEGIES_PATH):
        with open(STRATEGIES_PATH, encoding='utf-8') as f:
            all_s = json.load(f)
    all_s[username] = strategies
    with open(STRATEGIES_PATH, 'w', encoding='utf-8') as f:
        json.dump(all_s, f, ensure_ascii=False, indent=2)

@app.route('/api/screener/strategies', methods=['GET'])
def get_strategies():
    user = session.get('user')
    if not user:
        return jsonify({'success': False, 'message': '请先登录'}), 401
    return jsonify({'success': True, 'strategies': _load_strategies(user['username'])})

@app.route('/api/screener/strategies', methods=['POST'])
def save_strategies():
    user = session.get('user')
    if not user:
        return jsonify({'success': False, 'message': '请先登录'}), 401
    data = request.get_json() or {}
    _save_strategies(user['username'], data.get('strategies', []))
    return jsonify({'success': True})

@app.route('/api/screener/run', methods=['POST'])
def run_screener():
    user = session.get('user')
    if not user:
        return jsonify({'success': False, 'message': '请先登录'}), 401
    data = request.get_json() or {}
    factors = data.get('factors', [])
    limit   = min(int(data.get('limit', 200)), 500)
    try:
        results = screener_engine.run_screener(factors, limit)
        return jsonify({'success': True, 'results': results, 'total': len(results)})
    except Exception as e:
        return jsonify({'success': False, 'message': str(e)}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080, debug=True, threaded=True)
