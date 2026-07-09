#!/usr/bin/env python3
# 每日行情快照:抓 TradingView scanner 的收盤價,累積到 data/history.json
# (格式 {sym: {date: close}},與前端 localStorage 的 moneylai-scanner-history 同構)。
# 由 GitHub Actions 每個交易日收盤後執行一次;前端以相對路徑讀取並與本機累積合併,
# 讓熱力圖的逐週歷史不再綁定單一瀏覽器。
# 注意:標的清單必須與 app.js 的 SCANNER_ALL 保持同步(兩邊都有註記)。

import json
import urllib.request
from datetime import date, timedelta
from pathlib import Path

GLOBAL = [
    'OANDA:XCUUSD',    # 銅
    'NASDAQ:ICLN',     # 綠能
    'NASDAQ:AIQ',      # AI
    'SP:SPX',          # 美股 S&P 500
    'NASDAQ:IXIC',     # 美股 NASDAQ
    'NASDAQ:SOX',      # 美股 費半
    'TVC:NI225',       # 日股
    'TVC:SX5E',        # 歐股
    'SSE:000001',      # 中國股 上證
    'SZSE:399001',     # 中國股 深證
    'TVC:HSI',         # 香港 恒生
    'NASDAQ:TLT',      # 債市
    'TVC:US02Y',       # 美債 2 年
    'TVC:US10Y',       # 美債 10 年
    'TVC:US30Y',       # 美債 30 年
    'TVC:VIX',         # VIX
    'FX_IDC:USDTWD',   # 美元兌台幣
    'TVC:JP10Y',       # 日債 10 年(美日利差)
    'TVC:GOLD',        # 黃金現貨(銅金比)
    'AMEX:HYG',        # 高收益債
    'AMEX:LQD',        # 投資級債
    'FX_IDC:USDCNH',   # 美元兌離岸人民幣(CNH−CNY 價差)
    'FX_IDC:USDCNY',   # 美元兌在岸人民幣
    'FX_IDC:USDJPY',   # 美元兌日圓(台幣卡即時交叉價)
    'FX_IDC:EURUSD',   # 歐元兌美元(台幣卡即時交叉價)
]
FUTURES = ['NYMEX:CL1!', 'ICEEUR:BRN1!']   # 原油 WTI / 布蘭特
COLS = ['close', 'Perf.W', 'Perf.1M', 'Perf.3M']

OUT = Path(__file__).resolve().parent.parent / 'data' / 'history.json'
KEEP_DAYS = 200   # 保留天數(熱力圖最長只需 12 週,多留供未來使用)


def scan(market, tickers):
    req = urllib.request.Request(
        f'https://scanner.tradingview.com/{market}/scan',
        data=json.dumps({'symbols': {'tickers': tickers, 'query': {'types': []}},
                         'columns': COLS}).encode(),
        headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r).get('data') or []


def main():
    hist = json.loads(OUT.read_text()) if OUT.exists() else {}
    today = date.today()   # runner 為 UTC,與前端 isoDate 的 UTC 日一致
    rows = scan('global', GLOBAL) + scan('futures', FUTURES)
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

    # 修剪:只留 KEEP_DAYS 天,並汰除已不在清單的孤兒標的
    cutoff = (today - timedelta(days=KEEP_DAYS)).isoformat()
    tracked = set(GLOBAL) | set(FUTURES)
    hist = {sym: {dt: v for dt, v in sorted(days.items()) if dt >= cutoff}
            for sym, days in hist.items() if sym in tracked}

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(hist, ensure_ascii=False,
                              separators=(',', ':'), sort_keys=True) + '\n')
    print(f'快照完成:{len(hist)} 檔標的,{today}')


if __name__ == '__main__':
    main()
