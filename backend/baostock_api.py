# baostock_api.py — baostock 数据拉取封装，带 PostgreSQL + 本地 CSV 双层缓存
import os
import threading
import pandas as pd

try:
    import baostock as bs
    BAOSTOCK_AVAILABLE = True
except ImportError:
    BAOSTOCK_AVAILABLE = False

CACHE_DIR = os.path.join(os.path.dirname(__file__), 'data', 'baostock_cache')
os.makedirs(CACHE_DIR, exist_ok=True)

_bs_lock = threading.Lock()
_bs_logged_in = False

# Lazy import of DB helpers from app to avoid circular import
def _db_save(code, rows):
    try:
        from app import _pg_save_ohlc
        _pg_save_ohlc(code, rows)
    except Exception:
        pass

def _db_load(code, start_date, end_date):
    try:
        from app import _pg_load_ohlc
        return _pg_load_ohlc(code, start_date, end_date)
    except Exception:
        return None


def _ensure_login():
    global _bs_logged_in
    if not BAOSTOCK_AVAILABLE:
        raise RuntimeError('baostock 未安装，请运行: pip install baostock')
    if not _bs_logged_in:
        lg = bs.login()
        if lg.error_code != '0':
            raise RuntimeError(f'baostock 登录失败: {lg.error_msg}')
        _bs_logged_in = True


def _normalize_code(code: str) -> str:
    """统一转为 baostock 格式: sh.600519 / sz.000001"""
    code = code.strip()
    if '.' in code:
        return code.lower()
    # 6位数字
    digits = code.lstrip('shSZsz')
    if digits.startswith('6') or digits.startswith('5') or digits.startswith('9'):
        return 'sh.' + digits
    return 'sz.' + digits


def _cache_path(code: str, start: str, end: str) -> str:
    safe = code.replace('.', '_')
    return os.path.join(CACHE_DIR, f'{safe}_{start}_{end}.csv')


def get_stock_history(code: str, start_date: str, end_date: str) -> pd.DataFrame | None:
    """
    返回 DataFrame，columns: date,open,high,low,close,volume,amount,pct_chg
    优先从 PostgreSQL 读取，其次本地 CSV，最后从 baostock 拉取
    """
    bs_code = _normalize_code(code)

    # 1. Try PostgreSQL
    db_rows = _db_load(bs_code, start_date, end_date)
    if db_rows:
        df = pd.DataFrame(db_rows)
        return _cast_ohlc(df)

    # 2. Try local CSV
    cache_file = _cache_path(bs_code, start_date, end_date)
    if os.path.exists(cache_file):
        try:
            df = pd.read_csv(cache_file, dtype=str)
            result = _cast_ohlc(df)
            # Backfill to DB
            _db_save(bs_code, result.to_dict('records'))
            return result
        except Exception:
            pass

    # 3. Fetch from baostock
    with _bs_lock:
        _ensure_login()
        rs = bs.query_history_k_data_plus(
            bs_code,
            'date,open,high,low,close,volume,amount,pctChg',
            start_date=start_date,
            end_date=end_date,
            frequency='d',
            adjustflag='3'  # 后复权
        )
        rows = []
        while rs.error_code == '0' and rs.next():
            rows.append(rs.get_row_data())

    if not rows:
        return None

    df = pd.DataFrame(rows, columns=['date', 'open', 'high', 'low', 'close', 'volume', 'amount', 'pct_chg'])
    df.to_csv(cache_file, index=False)
    result = _cast_ohlc(df)
    # Save to DB
    _db_save(bs_code, result.to_dict('records'))
    return result


def _cast_ohlc(df: pd.DataFrame) -> pd.DataFrame:
    for col in ['open', 'high', 'low', 'close', 'volume', 'amount', 'pct_chg']:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors='coerce')
    df = df[df['close'].notna() & (df['close'] > 0)]
    df = df.reset_index(drop=True)
    return df


def get_index_history(index_code: str, start_date: str, end_date: str) -> pd.DataFrame | None:
    """
    获取指数历史数据，index_code 如 'sh.000300'（沪深300）
    """
    # 1. Try PostgreSQL
    db_rows = _db_load(index_code, start_date, end_date)
    if db_rows:
        return _cast_ohlc(pd.DataFrame(db_rows))

    # 2. Try local CSV
    cache_file = _cache_path(index_code.replace('.', '_') + '_idx', start_date, end_date)
    if os.path.exists(cache_file):
        try:
            df = pd.read_csv(cache_file, dtype=str)
            result = _cast_ohlc(df)
            _db_save(index_code, result.to_dict('records'))
            return result
        except Exception:
            pass

    # 3. Fetch from baostock
    with _bs_lock:
        _ensure_login()
        rs = bs.query_history_k_data_plus(
            index_code,
            'date,open,high,low,close,volume,amount,pctChg',
            start_date=start_date,
            end_date=end_date,
            frequency='d',
            adjustflag='3'
        )
        rows = []
        while rs.error_code == '0' and rs.next():
            rows.append(rs.get_row_data())

    if not rows:
        return None

    df = pd.DataFrame(rows, columns=['date', 'open', 'high', 'low', 'close', 'volume', 'amount', 'pct_chg'])
    df.to_csv(cache_file, index=False)
    result = _cast_ohlc(df)
    _db_save(index_code, result.to_dict('records'))
    return result


def get_hs300_stocks(date: str = None) -> list[str]:
    """返回沪深300成分股列表，格式 ['sh.600519', ...]"""
    with _bs_lock:
        _ensure_login()
        kwargs = {}
        if date:
            kwargs['date'] = date
        rs = bs.query_hs300_stocks(**kwargs)
        codes = []
        while rs.error_code == '0' and rs.next():
            row = rs.get_row_data()
            if row:
                codes.append(row[1])  # index 1 = code
    return codes


def get_zz500_stocks(date: str = None) -> list[str]:
    """返回中证500成分股列表，格式 ['sz.000001', ...]"""
    with _bs_lock:
        _ensure_login()
        kwargs = {}
        if date:
            kwargs['date'] = date
        rs = bs.query_zz500_stocks(**kwargs)
        codes = []
        while rs.error_code == '0' and rs.next():
            row = rs.get_row_data()
            if row:
                codes.append(row[1])
    return codes


def get_stock_name(code: str) -> str:
    """获取股票名称"""
    with _bs_lock:
        _ensure_login()
        rs = bs.query_stock_basic(code=_normalize_code(code))
        if rs.error_code == '0' and rs.next():
            row = rs.get_row_data()
            return row[1] if len(row) > 1 else code
    return code


# 预加载成分股缓存（进程级，避免每次重新拉取）
_hs300_cache: list[str] = []
_zz500_cache: list[str] = []


def get_hs300_stocks_cached() -> list[str]:
    global _hs300_cache
    if not _hs300_cache:
        _hs300_cache = get_hs300_stocks()
    return _hs300_cache


def get_zz500_stocks_cached() -> list[str]:
    global _zz500_cache
    if not _zz500_cache:
        _zz500_cache = get_zz500_stocks()
    return _zz500_cache
