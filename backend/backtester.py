# backtester.py — 逐日回测引擎
import math
import traceback
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

from baostock_api import (
    get_stock_history, get_index_history,
    get_hs300_stocks_cached, get_zz500_stocks_cached,
    get_stock_name, _normalize_code
)

# ── 安全沙箱 ──────────────────────────────────────────────────────────────────

_SAFE_BUILTINS = {
    'abs': abs, 'round': round, 'min': min, 'max': max,
    'len': len, 'range': range, 'sorted': sorted,
    'enumerate': enumerate, 'zip': zip, 'isinstance': isinstance,
    'int': int, 'float': float, 'str': str,
    'list': list, 'dict': dict, 'tuple': tuple, 'bool': bool,
    'sum': sum, 'any': any, 'all': all, 'print': print,
    'None': None, 'True': True, 'False': False,
}


def _exec_strategy(code_str: str, extra_globals: dict) -> dict:
    """在沙箱中执行策略代码，返回函数命名空间"""
    ns = {'__builtins__': _SAFE_BUILTINS, 'pd': pd, 'np': np, 'math': math}
    ns.update(extra_globals)
    exec(compile(code_str, '<strategy>', 'exec'), ns)  # noqa: S102
    return ns


# ── 默认策略函数（用户未提供时的回退）────────────────────────────────────────

_DEFAULT_SELECT = '''
def select_stocks(date, context):
    return context['universe'][:10]
'''

_DEFAULT_BUY = '''
def should_buy(date, code, context):
    positions = context['positions']
    if code in positions:
        return 0.0
    n_pos = len(positions)
    if n_pos >= 5:
        return 0.0
    return 1.0 / (5 - n_pos)
'''

_DEFAULT_SELL = '''
def should_sell(date, code, position, context):
    return 0.0
'''

_DEFAULT_LOOP = '''
def loop_condition(date, context):
    return True
'''


# ── 主回测函数 ────────────────────────────────────────────────────────────────

def run_backtest(
    select_code: str,
    buy_code: str,
    sell_code: str,
    loop_code: str,
    universe_type: str,       # 'hs300' | 'zz500' | 'custom'
    custom_codes: list,
    start_date: str,
    end_date: str,
    initial_capital: float = 1_000_000,
    progress_cb=None,         # callable(pct: float, msg: str)
) -> dict:
    """
    运行策略回测，返回结果字典。
    progress_cb(pct, msg) 在关键阶段被调用，pct 为 0~1。
    """

    def _progress(pct, msg):
        if progress_cb:
            progress_cb(pct, msg)

    # 1. 准备股票池
    _progress(0.02, '正在获取股票池…')
    if universe_type == 'hs300':
        universe = get_hs300_stocks_cached()
    elif universe_type == 'zz500':
        universe = get_zz500_stocks_cached()
    elif universe_type == 'custom' and custom_codes:
        universe = [_normalize_code(c) for c in custom_codes]
    else:
        universe = get_hs300_stocks_cached()

    if not universe:
        raise ValueError('股票池为空，请检查 baostock 连接')

    # 2. 预加载历史数据（分批，带进度）
    _progress(0.05, f'正在拉取 {len(universe)} 只股票历史数据…')
    hist_cache: dict[str, pd.DataFrame] = {}
    total = len(universe)
    for i, code in enumerate(universe):
        df = get_stock_history(code, start_date, end_date)
        if df is not None and len(df) > 0:
            hist_cache[code] = df.set_index('date')
        if i % 20 == 0:
            _progress(0.05 + 0.35 * i / total, f'加载数据 {i}/{total}…')

    # 3. 拉取基准（沪深300）
    _progress(0.40, '正在拉取基准数据…')
    bm_df = get_index_history('sh.000300', start_date, end_date)
    benchmark_series = {}
    if bm_df is not None:
        for _, row in bm_df.iterrows():
            benchmark_series[row['date']] = float(row['close'])

    # 4. 生成交易日序列
    all_dates = sorted({
        d for df in hist_cache.values() for d in df.index
    })
    if not all_dates:
        raise ValueError('指定日期范围内无有效交易数据')

    # 5. 编译策略代码
    _progress(0.42, '正在编译策略代码…')
    full_code = '\n\n'.join([
        select_code or _DEFAULT_SELECT,
        buy_code    or _DEFAULT_BUY,
        sell_code   or _DEFAULT_SELL,
        loop_code   or _DEFAULT_LOOP,
    ])
    try:
        strategy_ns = _exec_strategy(full_code, {})
    except Exception as e:
        raise ValueError(f'策略代码编译失败: {e}')

    select_fn = strategy_ns.get('select_stocks')
    buy_fn    = strategy_ns.get('should_buy')
    sell_fn   = strategy_ns.get('should_sell')
    loop_fn   = strategy_ns.get('loop_condition')

    if not all([select_fn, buy_fn, sell_fn, loop_fn]):
        missing = [n for n, f in [('select_stocks', select_fn), ('should_buy', buy_fn),
                                   ('should_sell', sell_fn), ('loop_condition', loop_fn)] if not f]
        raise ValueError(f'策略代码缺少函数: {missing}')

    # 6. 逐日回测
    _progress(0.45, '开始回测…')
    cash = float(initial_capital)
    positions: dict[str, dict] = {}  # code → {shares, cost, entry_date}
    equity_curve = []
    benchmark_curve = []
    trades = []
    closed_trades = []

    bm_start = None

    def _get_price(code: str, date: str) -> float | None:
        df = hist_cache.get(code)
        if df is None or date not in df.index:
            return None
        val = df.loc[date, 'close']
        return float(val) if pd.notna(val) else None

    def _get_history_ctx(code: str, n: int, current_date: str) -> pd.DataFrame | None:
        df = hist_cache.get(code)
        if df is None:
            return None
        before = df[df.index <= current_date]
        if len(before) == 0:
            return None
        return before.tail(n).reset_index()

    n_dates = len(all_dates)
    for di, date in enumerate(all_dates):
        if di % 10 == 0:
            _progress(0.45 + 0.50 * di / n_dates, f'回测进度 {di}/{n_dates}…')

        # 更新持仓市值
        total_pos_value = 0.0
        for code, pos in list(positions.items()):
            p = _get_price(code, date)
            if p:
                pos['value'] = pos['shares'] * p
                pos['price'] = p
            total_pos_value += pos.get('value', 0.0)

        total_value = cash + total_pos_value

        ctx = {
            'get_history': lambda c, n, d=date: _get_history_ctx(c, n, d),
            'universe': [c for c in universe if c in hist_cache],
            'positions': positions,
            'cash': cash,
            'total_value': total_value,
            'date': date,
        }

        try:
            should_run = loop_fn(date, ctx)
        except Exception:
            should_run = True

        if should_run:
            # 卖出检查
            for code in list(positions.keys()):
                pos = positions[code]
                try:
                    sell_ratio = float(sell_fn(date, code, pos, ctx))
                except Exception:
                    sell_ratio = 0.0
                if sell_ratio > 0:
                    price = _get_price(code, date)
                    if price and price > 0:
                        sell_shares = int(pos['shares'] * sell_ratio // 100) * 100
                        if sell_shares <= 0:
                            sell_shares = pos['shares']
                        proceeds = sell_shares * price
                        cash += proceeds
                        pnl = (price - pos['cost']) * sell_shares
                        trades.append({
                            'date': date, 'code': code,
                            'name': pos.get('name', code),
                            'action': 'sell', 'price': round(price, 2),
                            'shares': sell_shares,
                            'amount': round(proceeds, 2),
                            'pnl': round(pnl, 2),
                        })
                        closed_trades.append(pnl)
                        pos['shares'] -= sell_shares
                        if pos['shares'] <= 0:
                            del positions[code]
                        else:
                            pos['value'] = pos['shares'] * price

            # 更新 ctx（卖出后）
            ctx['cash'] = cash
            ctx['total_value'] = cash + sum(p.get('value', 0) for p in positions.values())

            # 选股
            try:
                candidates = list(select_fn(date, ctx) or [])
            except Exception:
                candidates = []

            # 买入
            for code in candidates:
                if code in positions:
                    continue
                price = _get_price(code, date)
                if not price or price <= 0:
                    continue
                try:
                    buy_ratio = float(buy_fn(date, code, ctx))
                except Exception:
                    buy_ratio = 0.0
                if buy_ratio <= 0:
                    continue
                invest = ctx['total_value'] * buy_ratio
                invest = min(invest, cash * 0.99)
                if invest < price * 100:
                    continue
                shares = int(invest / price // 100) * 100
                if shares <= 0:
                    continue
                cost = shares * price
                cash -= cost
                name = _get_stock_name_safe(code)
                positions[code] = {
                    'shares': shares, 'cost': price,
                    'value': cost, 'price': price,
                    'entry_date': date, 'name': name,
                }
                trades.append({
                    'date': date, 'code': code, 'name': name,
                    'action': 'buy', 'price': round(price, 2),
                    'shares': shares, 'amount': round(cost, 2), 'pnl': None,
                })
                ctx['cash'] = cash
                ctx['total_value'] = cash + sum(p.get('value', 0) for p in positions.values())

        # 记录每日净值
        total_pos_value = sum(p.get('value', 0) for p in positions.values())
        day_total = cash + total_pos_value
        equity_curve.append({'date': date, 'value': round(day_total / initial_capital, 6)})

        # 基准
        bm_price = benchmark_series.get(date)
        if bm_price:
            if bm_start is None:
                bm_start = bm_price
            benchmark_curve.append({'date': date, 'value': round(bm_price / bm_start, 6)})

    # 7. 计算指标
    _progress(0.96, '计算回测指标…')
    metrics = _calc_metrics(equity_curve, benchmark_curve, closed_trades)

    _progress(1.0, '回测完成')
    return {
        'equity_curve': equity_curve,
        'benchmark': benchmark_curve,
        'metrics': metrics,
        'trades': trades,
    }


def _get_stock_name_safe(code: str) -> str:
    try:
        return get_stock_name(code)
    except Exception:
        return code


def _calc_metrics(equity: list, benchmark: list, closed_trades: list) -> dict:
    if not equity or len(equity) < 2:
        return {}

    values = [e['value'] for e in equity]
    n = len(values)
    final = values[-1]
    initial = values[0]

    # 年化收益率
    annual_return = (final / initial) ** (252 / max(n, 1)) - 1

    # 最大回撤
    peak = values[0]
    max_dd = 0.0
    for v in values:
        if v > peak:
            peak = v
        dd = (peak - v) / peak if peak > 0 else 0
        if dd > max_dd:
            max_dd = dd

    # 日收益率
    daily_rets = [(values[i] - values[i - 1]) / values[i - 1] for i in range(1, n)]
    rf_daily = 0.03 / 252
    excess = [r - rf_daily for r in daily_rets]
    sharpe = 0.0
    if len(excess) > 1:
        mean_e = sum(excess) / len(excess)
        std_e = math.sqrt(sum((x - mean_e) ** 2 for x in excess) / len(excess))
        sharpe = (mean_e / std_e * math.sqrt(252)) if std_e > 0 else 0.0

    # 胜率
    win_rate = 0.0
    if closed_trades:
        wins = sum(1 for p in closed_trades if p > 0)
        win_rate = wins / len(closed_trades)

    # 基准收益
    bm_return = 0.0
    if benchmark and len(benchmark) >= 2:
        bm_return = benchmark[-1]['value'] - 1.0

    return {
        'annual_return': round(annual_return, 4),
        'total_return': round(final - 1.0, 4),
        'benchmark_return': round(bm_return, 4),
        'max_drawdown': round(-max_dd, 4),
        'sharpe': round(sharpe, 2),
        'win_rate': round(win_rate, 4),
        'total_trades': len(closed_trades),
        'trading_days': n,
    }
