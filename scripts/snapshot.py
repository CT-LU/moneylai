#!/usr/bin/env python3
# 每日行情快照:抓 TradingView scanner 的收盤價,累積到 data/history.json
# (格式 {sym: {date: close}},與前端 localStorage 的 moneylai-scanner-history 同構)。
# 另抓 ETF 的申贖基礎資料(流通股數/NAV/AUM)累積到 data/etf.json —— scanner 的
# fund_flows.* 只有 1M/3M/YTD/1Y/5Y 區間,日頻流量要靠「Δ流通股數 × NAV」自己累積。
# 由 GitHub Actions 每個交易日收盤後執行一次;前端以相對路徑讀取並與本機累積合併。
# 注意:GLOBAL/FUTURES 必須與 app.js 的 SCANNER_ALL、ETF_TICKERS 必須與
# app.js 的 ETF_FLOW_LIST 保持同步(兩邊都有註記)。

import json
import urllib.request
from datetime import date, timedelta
from pathlib import Path

GLOBAL = [
    'SP:SPX',          # 美股 S&P 500(股債比)
    'NASDAQ:TLT',      # 債市 TLT
    'TVC:US02Y',       # 美債 2 年
    'TVC:US10Y',       # 美債 10 年
    'TVC:US30Y',       # 美債 30 年
    'TVC:VIX',         # VIX
    'FX_IDC:USDTWD',   # 美元兌台幣
    'TVC:JP10Y',       # 日債 10 年(美日利差)
    'AMEX:HYG',        # 高收益債
    'AMEX:LQD',        # 投資級債
    'AMEX:XLK',        # 科技(週期/防禦類股比:週期籃)
    'AMEX:XLF',        # 金融(週期籃)
    'AMEX:XLI',        # 工業(週期籃)
    'AMEX:XLY',        # 非必需消費(週期籃)
    'AMEX:XLV',        # 醫療(週期/防禦類股比:防禦籃)
    'AMEX:XLP',        # 必需消費(防禦籃)
    'AMEX:XLU',        # 公用事業(防禦籃)
    'FX_IDC:USDCNH',   # 美元兌離岸人民幣(CNH−CNY 價差)
    'FX_IDC:USDCNY',   # 美元兌在岸人民幣
    'FX_IDC:USDJPY',   # 美元兌日圓(台幣卡即時交叉價)
    'FX_IDC:EURUSD',   # 歐元兌美元(台幣卡即時交叉價)
]
FUTURES = ['CBOE:VX1!']   # VIX 近月期貨(期限結構)
COLS = ['close', 'Perf.W', 'Perf.1M', 'Perf.3M']

# ETF 真實資金流卡的標的(與 app.js 的 ETF_FLOW_LIST 同步)
ETF_TICKERS = [
    'NASDAQ:SOXX', 'NASDAQ:AIQ', 'NASDAQ:IBIT', 'AMEX:IWM', 'AMEX:KWEB',
    'CBOE:ITA', 'AMEX:XLV', 'NASDAQ:ICLN', 'AMEX:XLE', 'AMEX:USO',
    'AMEX:BNO', 'AMEX:URA', 'AMEX:GLD', 'AMEX:GDX', 'AMEX:SLV',
    'AMEX:COPX', 'AMEX:REMX', 'NASDAQ:TLT', 'AMEX:TIP', 'NYSE:SGOV',
    'AMEX:HYG', 'AMEX:LQD', 'AMEX:KRE', 'NASDAQ:EMB', 'AMEX:EEM',
]
ETF_COLS = ['shares_outstanding', 'nav', 'aum']

ROOT = Path(__file__).resolve().parent.parent / 'data'
OUT = ROOT / 'history.json'
OUT_ETF = ROOT / 'etf.json'
KEEP_DAYS = 200   # 保留天數


def scan(market, tickers, cols):
    req = urllib.request.Request(
        f'https://scanner.tradingview.com/{market}/scan',
        data=json.dumps({'symbols': {'tickers': tickers, 'query': {'types': []}},
                         'columns': cols}).encode(),
        headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r).get('data') or []


def prune(hist, tracked, cutoff):
    # 修剪:只留 KEEP_DAYS 天,並汰除已不在清單的孤兒標的
    return {sym: {dt: v for dt, v in sorted(days.items()) if dt >= cutoff}
            for sym, days in hist.items() if sym in tracked}


def main():
    today = date.today()   # runner 為 UTC,與前端 isoDate 的 UTC 日一致
    cutoff = (today - timedelta(days=KEEP_DAYS)).isoformat()

    # --- 收盤價快照(聯準會卡迷你趨勢的逐日歷史) ---
    hist = json.loads(OUT.read_text()) if OUT.exists() else {}
    rows = scan('global', GLOBAL, COLS) + scan('futures', FUTURES, COLS)
    if not rows:
        raise SystemExit('scanner 無資料,不更新檔案')
    for item in rows:
        sym, d = item['s'], item['d']
        close = d[0]
        if not isinstance(close, (int, float)):
            continue
        h = hist.setdefault(sym, {})
        h[today.isoformat()] = close   # 直接觀測,一律更新
        # 反推 7/30/90 天前的估值(不覆蓋既有紀錄,實際觀測日後會自然取代)
        for perf, days in ((d[1], 7), (d[2], 30), (d[3], 90)):
            if isinstance(perf, (int, float)):
                key = (today - timedelta(days=days)).isoformat()
                h.setdefault(key, round(close / (1 + perf / 100), 6))
    hist = prune(hist, set(GLOBAL) | set(FUTURES), cutoff)

    ROOT.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(hist, ensure_ascii=False,
                              separators=(',', ':'), sort_keys=True) + '\n')

    # --- ETF 申贖基礎資料快照(日流量 ≈ Δ流通股數 × NAV,累積後供前端使用) ---
    etf = json.loads(OUT_ETF.read_text()) if OUT_ETF.exists() else {}
    n_etf = 0
    for item in scan('global', ETF_TICKERS, ETF_COLS):
        so, nav, aum = item['d']
        if not isinstance(so, (int, float)) or not isinstance(nav, (int, float)):
            continue
        etf.setdefault(item['s'], {})[today.isoformat()] = {
            'so': round(so), 'nav': round(nav, 4),
            'aum': round(aum) if isinstance(aum, (int, float)) else None,
        }
        n_etf += 1
    etf = prune(etf, set(ETF_TICKERS), cutoff)
    OUT_ETF.write_text(json.dumps(etf, ensure_ascii=False,
                                  separators=(',', ':'), sort_keys=True) + '\n')

    print(f'快照完成:{len(hist)} 檔標的、ETF {n_etf} 檔,{today}')


if __name__ == '__main__':
    main()
