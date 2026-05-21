"""
多因子选股引擎
数据源：新浪财经全市场接口（含PE/PB/市值/换手率/实时行情）
"""
from __future__ import annotations
import json
import time
import threading
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Optional

# ── 全市场数据缓存（5分钟有效） ─────────────────────────────
_MARKET_CACHE: tuple[list, float] | None = None
_MARKET_LOCK = threading.Lock()
_MARKET_TTL = 300  # 5 minutes


# ── 全市场数据获取 ──────────────────────────────────────────

def _fetch_page(node: str, page: int, num: int = 80) -> list[dict]:
    url = (
        f'http://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php'
        f'/Market_Center.getHQNodeData?page={page}&num={num}'
        f'&sort=symbol&asc=1&node={node}&symbol=&_s_r_a=page'
    )
    try:
        result = subprocess.run(
            ['curl', '-s', '--max-time', '10', url,
             '-H', 'Referer: http://finance.sina.com.cn',
             '-H', 'User-Agent: Mozilla/5.0'],
            capture_output=True, text=True, timeout=12
        )
        if result.returncode != 0 or not result.stdout.strip():
            return []
        return json.loads(result.stdout) or []
    except Exception:
        return []


def fetch_all_stocks() -> list[dict]:
    """
    并发拉取沪深A股全市场数据（约5000只），带5分钟缓存。
    """
    global _MARKET_CACHE
    now = time.time()
    with _MARKET_LOCK:
        if _MARKET_CACHE and now - _MARKET_CACHE[1] < _MARKET_TTL:
            return _MARKET_CACHE[0]

    # 先拉第1页确认总数
    first = _fetch_page('hs_a', 1, 80)
    if not first:
        return []

    # 估算总页数：A股约5500只，每页80条 → 约70页，并发拉取
    max_pages = 70
    pages_data: dict[int, list] = {1: first}

    with ThreadPoolExecutor(max_workers=15) as pool:
        futures = {pool.submit(_fetch_page, 'hs_a', p, 80): p for p in range(2, max_pages + 1)}
        for fut in as_completed(futures):
            p = futures[fut]
            try:
                data = fut.result()
                if data:
                    pages_data[p] = data
            except Exception:
                pass

    # 按页码顺序合并
    results = []
    for p in sorted(pages_data):
        results.extend(pages_data[p])

    with _MARKET_LOCK:
        _MARKET_CACHE = (results, time.time())

    return results


# ── 均线计算（需要K线，用新浪日K接口） ─────────────────────

_KLINE_CACHE: dict[str, tuple[list, float]] = {}
_KLINE_LOCK = threading.Lock()
_KLINE_TTL = 3600  # 1 hour


def _get_ma(symbol: str, period: int) -> Optional[float]:
    """获取最新收盘价的N日均线值（用新浪日K）"""
    now = time.time()
    with _KLINE_LOCK:
        entry = _KLINE_CACHE.get(symbol)
        if entry and now - entry[1] < _KLINE_TTL:
            closes = entry[0]
        else:
            closes = None

    if closes is None:
        url = (
            f'http://money.finance.sina.com.cn/quotes_service/api/json_v2.php'
            f'/CN_MarketData.getKLineData?symbol={symbol}&scale=240&datalen=80&ma=no'
        )
        try:
            result = subprocess.run(
                ['curl', '-s', '--max-time', '8', url,
                 '-H', 'Referer: http://finance.sina.com.cn',
                 '-H', 'User-Agent: Mozilla/5.0'],
                capture_output=True, text=True, timeout=10
            )
            data = json.loads(result.stdout)
            closes = [float(d['close']) for d in data if d.get('close')]
        except Exception:
            return None
        with _KLINE_LOCK:
            _KLINE_CACHE[symbol] = (closes, time.time())

    if len(closes) < period:
        return None
    return round(sum(closes[-period:]) / period, 3)


# ── 因子计算 ────────────────────────────────────────────────

def _safe_float(v, default=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def evaluate_stock(stock: dict, factors: list[dict]) -> bool:
    """
    对单只股票评估所有因子，全部满足返回 True。
    stock 字段来自新浪接口。
    factor 结构：{field, op, value}
    """
    price      = _safe_float(stock.get('trade'))
    change_pct = _safe_float(stock.get('changepercent'))
    volume     = _safe_float(stock.get('volume'))        # 手
    amount     = _safe_float(stock.get('amount')) / 1e8  # 亿元
    pe         = _safe_float(stock.get('per'))
    pb         = _safe_float(stock.get('pb'))
    mktcap     = _safe_float(stock.get('mktcap')) / 1e4  # 亿元
    turnover   = _safe_float(stock.get('turnoverratio'))
    high       = _safe_float(stock.get('high'))
    low        = _safe_float(stock.get('low'))
    open_      = _safe_float(stock.get('open'))

    symbol = stock.get('symbol', '')

    field_map = {
        'price':      price,
        'change_pct': change_pct,
        'amount':     amount,
        'volume':     volume,
        'pe':         pe,
        'pb':         pb,
        'mktcap':     mktcap,
        'turnover':   turnover,
        'high':       high,
        'low':        low,
        'open':       open_,
    }

    for factor in factors:
        field = factor.get('field', '')
        op    = factor.get('op', '>=')
        value = _safe_float(factor.get('value', 0))

        # MA factors need K-line fetch
        if field in ('ma5', 'ma10', 'ma20', 'ma60'):
            n = int(field[2:])
            ma_val = _get_ma(symbol, n)
            if ma_val is None:
                return False
            lhs = price
            rhs = ma_val
            # op: price_above_ma / price_below_ma / ma_value
            if op == 'price_above':
                if not (lhs > rhs):
                    return False
            elif op == 'price_below':
                if not (lhs < rhs):
                    return False
            else:
                # treat as numeric comparison on MA value
                lhs = ma_val
                if not _compare(lhs, op, value):
                    return False
            continue

        lhs = field_map.get(field)
        if lhs is None:
            continue
        if not _compare(lhs, op, value):
            return False

    return True


def _compare(lhs: float, op: str, rhs: float) -> bool:
    if op == '>=': return lhs >= rhs
    if op == '<=': return lhs <= rhs
    if op == '>':  return lhs > rhs
    if op == '<':  return lhs < rhs
    if op == '==': return abs(lhs - rhs) < 1e-9
    if op == '!=': return abs(lhs - rhs) >= 1e-9
    return False


# ── 主入口 ──────────────────────────────────────────────────

def run_screener(factors: list[dict], limit: int = 100) -> list[dict]:
    """
    运行选股，返回符合条件的股票列表（最多 limit 只）。
    """
    all_stocks = fetch_all_stocks()
    results = []
    for stock in all_stocks:
        if not stock.get('trade') or _safe_float(stock.get('trade')) <= 0:
            continue
        if evaluate_stock(stock, factors):
            price      = _safe_float(stock.get('trade'))
            change_pct = _safe_float(stock.get('changepercent'))
            results.append({
                'code':       stock.get('code', ''),
                'symbol':     stock.get('symbol', ''),
                'name':       stock.get('name', ''),
                'price':      round(price, 2),
                'change_pct': round(change_pct, 2),
                'amount':     round(_safe_float(stock.get('amount')) / 1e8, 2),
                'mktcap':     round(_safe_float(stock.get('mktcap')) / 1e4, 2),
                'pe':         round(_safe_float(stock.get('per')), 2),
                'pb':         round(_safe_float(stock.get('pb')), 2),
                'turnover':   round(_safe_float(stock.get('turnoverratio')), 2),
            })
        if len(results) >= limit:
            break
    # sort by change_pct desc
    results.sort(key=lambda x: x['change_pct'], reverse=True)
    return results
