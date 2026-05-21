"""
A股数据获取模块
- 实时行情：新浪财经接口（稳定，无需登录）
- K线数据：akshare stock_zh_a_daily (stooq)
- 股票搜索：新浪 suggest 接口
"""
from __future__ import annotations
import urllib.request
import urllib.parse
import re
import datetime
from typing import Optional

try:
    import akshare as ak
    _AK_OK = True
except Exception:
    _AK_OK = False


# ── Code normalization ──────────────────────────────────────

def _normalize_code(code: str) -> tuple[str, str]:
    """返回 (market_prefix, pure_code)，prefix = 'sh' | 'sz'"""
    code = code.strip().lower()
    if code.startswith('sh') or code.startswith('sz'):
        return code[:2], code[2:]
    pure = code
    if pure.startswith('6') or pure.startswith('9') or pure.startswith('5'):
        return 'sh', pure
    return 'sz', pure


# ── Sina real-time quote ────────────────────────────────────

_SINA_URL = 'http://hq.sinajs.cn/list='
_SINA_HEADERS = {
    'Referer': 'http://finance.sina.com.cn',
    'User-Agent': 'Mozilla/5.0',
}

def _fetch_sina(full_codes: list[str]) -> dict[str, dict]:
    """批量拉取新浪行情，返回 {full_code: quote_dict}"""
    joined = ','.join(full_codes)
    url = _SINA_URL + joined
    req = urllib.request.Request(url, headers=_SINA_HEADERS)
    try:
        resp = urllib.request.urlopen(req, timeout=8)
        # Sina returns GBK
        raw = resp.read().decode('gbk', errors='replace')
    except Exception as e:
        return {}

    result = {}
    for line in raw.strip().split('\n'):
        m = re.match(r'var hq_str_(\w+)="(.*?)"', line.strip())
        if not m:
            continue
        fc = m.group(1)          # e.g. sh600519
        fields = m.group(2).split(',')
        if len(fields) < 10:
            continue
        try:
            name       = fields[0]
            prev_close = float(fields[2]) if fields[2] else 0.0
            price      = float(fields[3]) if fields[3] else 0.0
            high       = float(fields[4]) if fields[4] else 0.0
            low        = float(fields[5]) if fields[5] else 0.0
            open_      = float(fields[1]) if fields[1] else 0.0
            volume     = float(fields[8]) if fields[8] else 0.0   # 手
            amount     = float(fields[9]) if fields[9] else 0.0   # 元
            change     = round(price - prev_close, 4)
            change_pct = round(change / prev_close * 100, 2) if prev_close else 0.0
            prefix, pure = _normalize_code(fc)
            result[fc] = {
                'code': pure,
                'full_code': fc,
                'name': name,
                'price': price,
                'open': open_,
                'high': high,
                'low': low,
                'prev_close': prev_close,
                'change': change,
                'change_pct': change_pct,
                'volume': volume * 100,   # 手 -> 股
                'amount': amount,
                'atr': None,
            }
        except (ValueError, IndexError):
            continue
    return result


def get_realtime_quotes_batch(codes: list[str]) -> list[dict]:
    """批量获取实时行情"""
    norm = [p + c for p, c in (_normalize_code(code) for code in codes)]
    data = _fetch_sina(norm)
    results = []
    for fc in norm:
        if fc in data:
            results.append(data[fc])
        else:
            prefix, pure = _normalize_code(fc)
            results.append({'code': pure, 'full_code': fc, 'error': '无数据'})
    return results


# ── K-line (Sina finance) ───────────────────────────────────

_SINA_KLINE_URL = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData'

def get_kline(code: str, period: str = 'daily', count: int = 120) -> list[dict]:
    """获取K线数据，使用新浪财经接口"""
    prefix, pure = _normalize_code(code)
    sym = prefix + pure
    scale_map = {'daily': 240, 'weekly': 1200, 'monthly': 4800}
    scale = scale_map.get(period, 240)
    url = (f'{_SINA_KLINE_URL}?symbol={sym}&scale={scale}'
           f'&datalen={count}&ma=no')
    req = urllib.request.Request(url, headers={'Referer': 'http://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0'})
    try:
        resp = urllib.request.urlopen(req, timeout=10)
        raw = resp.read().decode('utf-8', errors='replace')
    except Exception:
        return []

    # Response: [{"d":"2024-01-02","o":"...","h":"...","l":"...","c":"...","v":"..."},...]
    import json
    try:
        items = json.loads(raw)
    except Exception:
        return []

    result = []
    prev_close = None
    for item in items:
        try:
            o = float(item.get('o', 0) or 0)
            c = float(item.get('c', 0) or 0)
            h = float(item.get('h', 0) or 0)
            l = float(item.get('l', 0) or 0)
            v = float(item.get('v', 0) or 0)
            chg = round((c - prev_close) / prev_close * 100, 2) if prev_close else 0.0
            prev_close = c
            result.append({
                'date': item.get('d', ''),
                'open': o, 'close': c, 'high': h, 'low': l,
                'volume': v, 'amount': 0.0, 'change_pct': chg,
            })
        except (ValueError, TypeError):
            continue
    return result


def calc_atr(kline_data: list[dict], period: int = 14) -> Optional[float]:
    """计算 ATR(14)"""
    if not kline_data or len(kline_data) < period + 1:
        return None
    trs = []
    for i in range(1, len(kline_data)):
        high      = kline_data[i]['high']
        low       = kline_data[i]['low']
        prev_close = kline_data[i - 1]['close']
        tr = max(high - low, abs(prev_close - high), abs(prev_close - low))
        trs.append(tr)
    if len(trs) < period:
        return None
    atr = sum(trs[:period]) / period
    for tr in trs[period:]:
        atr = (atr * (period - 1) + tr) / period
    return round(atr, 2)


# ── Search ──────────────────────────────────────────────────

def search_stock(keyword: str) -> list[dict]:
    """搜索股票，使用新浪 suggest 接口"""
    url = f'https://suggest3.sinajs.cn/suggest/type=11,12&key={urllib.parse.quote(keyword)}'
    headers = {'Referer': 'http://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0'}
    try:
        req = urllib.request.Request(url, headers=headers)
        resp = urllib.request.urlopen(req, timeout=6)
        raw = resp.read().decode('gbk', errors='replace')
        # Format: var suggestvalue="name,type,code,pinyin,code,...|..."
        m = re.search(r'"(.*?)"', raw)
        if not m:
            return []
        items = m.group(1).split(';')
        results = []
        for item in items[:20]:
            parts = item.split(',')
            if len(parts) < 3:
                continue
            name, itype, code = parts[0], parts[1], parts[2]
            if itype not in ('11', '12'):   # 11=沪，12=深
                continue
            code = code.strip()
            if not code or not code.isdigit():
                continue
            prefix = 'sh' if (code.startswith('6') or code.startswith('9') or code.startswith('5')) else 'sz'
            results.append({
                'code': code,
                'full_code': prefix + code,
                'name': name,
                'price': 0.0,
                'change_pct': 0.0,
            })
        # Enrich with live prices
        if results:
            fcs = [r['full_code'] for r in results]
            quotes = _fetch_sina(fcs)
            for r in results:
                q = quotes.get(r['full_code'])
                if q:
                    r['price'] = q['price']
                    r['change_pct'] = q['change_pct']
        return results
    except Exception as e:
        return []
