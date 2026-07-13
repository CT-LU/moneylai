# 錢錢流向儀表板（MoneyLai）

[繁體中文](#繁體中文) | [English](#english)

---

## 繁體中文

觀測全球「熱錢」流向的純靜態儀表板：資金正從哪裡流出、往哪裡流入（risk-on / risk-off），目前大多停泊在哪類資產（美元、美債、股市、黃金、加密貨幣、新興市場）。

**線上網址：https://ct-lu.github.io/moneylai/**

### 功能特色

由上而下五大區塊：

- **新台幣匯率** — 台幣對美元／日圓／歐元／人民幣的指數化折線圖（期初 = 100，1／4／8／12 週可切換），卡頭數字盒接即時報價、每 5 秒隨機呼吸提示更新中；對多數貨幣走貶 = 熱錢流出台灣傾向
- **台股外資買賣超** — 台灣證交所每日外資買賣差額長條圖（近 20 個交易日），附連續同向天數判讀，並與台幣升貶雙重確認（賣超 + 台幣貶 = 熱錢流出確認）
- **中國資金流向** — 兩融餘額與融資淨買入（內資槓桿）、港股通南向淨買入（資金出海）、CNH−CNY 價差（離岸貶值壓力），加上滬深 300 ETF（510300）分時價量圖的「國家隊護盤」觀測，三路合讀
- **聯準會美國風向** — 美債 2Y／10Y／30Y 殖利率曲線（今天／一週前／一月前）、牛陡熊陡判讀、股債合讀、風險胃納（美日利差／HYG-LQD 信用差／股債比），以及 VIX、美日利差、信用風險胃納（HYG/LQD）、核心 PCE、非農、失業率迷你趨勢圖與雙重使命判讀
- **資產／區域熱力圖** — 約 20 項資產（美元、日圓、黃金、BTC、ETH、原油、銅、綠能、AI、全球主要股指、美債 TLT）與 13 個區域貨幣的週漲跌熱力圖：藍 = 流入、紅 = 流出，支援波動標準化色階（z-score，預設）、點欄排序、hover 名次軌跡疊加、放量標記、翻轉訊號摘要

### 技術架構

- **純靜態網頁**：`index.html` + `app.js` + `style.css` + vendored `d3.v7.min.js`，無框架、無 build step、無後端
- **圖表全部使用 D3.js v7**
- **資料全部由瀏覽器端直接 fetch**（僅使用支援 CORS 的免費 API），依各來源更新頻率分別輪詢，來源掛掉時 graceful degradation（顯示快取值 + 錯誤標記）
- **視覺風格**：Neo-Memphis（高飽和撞色、粗墨框、硬偏移陰影），支援深色模式；資料色皆通過色覺辨認度驗證

### 資料來源

| 資料 | 來源 | 更新頻率 |
|---|---|---|
| 匯率（USD 基準，供熱力圖與區域卡） | Frankfurter API（ECB 資料） | 每小時 |
| BTC／ETH／黃金（PAXG）歷史與量能 | CoinGecko | 每小時 |
| 股指、債券、殖利率、VIX、原油、銅、外匯即時報價 | TradingView scanner（非官方） | 每 2 分鐘 |
| 非農就業、失業率 | 美國勞工統計局（BLS）官方 API | 每 6 小時 |
| 核心 PCE 物價指數 | DBnomics（BEA 鏡像） | 每 6 小時 |
| 台股外資每日買賣超 | 台灣證交所（TWSE） | 每小時 |
| 中國兩融、港股通南向、510300 分時 | 東方財富（非官方） | 每小時／盤中每 3 分鐘 |
| 新台幣歷史匯率 | fawazahmed0 currency-api | 每小時 |

### 每日快照

TradingView scanner 拿不到逐週歷史，因此由 GitHub Actions（`.github/workflows/snapshot.yml`）於每個交易日收盤後執行 `scripts/snapshot.py`，將當日報價寫入 `data/history.json` 並 commit 回 main；前端讀取快照補齊熱力圖的歷史週格，不依賴單一瀏覽器的 localStorage。

### 本機執行

```bash
python3 -m http.server 8000
# 瀏覽器開 http://localhost:8000
```

### 免責聲明

本專案僅供資訊參考與技術展示，不構成任何投資建議。部分資料來自非官方 API，可能隨時變動或失效。

### 授權

[MIT License](LICENSE)

---

## English

A pure-static dashboard for tracking global "hot money" flows: where capital is flowing out of and into (risk-on / risk-off), and which asset classes it is currently parked in (USD, US Treasuries, equities, gold, crypto, emerging markets).

**Live site: https://ct-lu.github.io/moneylai/**

### Features

Five sections, top to bottom:

- **TWD exchange rates** — Indexed line chart (start = 100) of TWD against USD/JPY/EUR/CNY with 1/4/8/12-week windows; header stat boxes show live quotes with a subtle breathing cue every 5 seconds. Broad TWD depreciation suggests hot money leaving Taiwan.
- **Taiwan foreign institutional net buy/sell** — Daily net foreign trading on TWSE as a bar chart (last 20 trading days), with streak-based interpretation cross-confirmed against the TWD trend (net selling + weakening TWD = confirmed outflow).
- **China capital flows** — Margin balance and net margin buying (domestic leverage), southbound Stock Connect net buying (capital going offshore), the CNH−CNY spread (offshore depreciation pressure), plus an intraday price/volume chart of the CSI 300 ETF (510300) watching for "national team" support — read together as a three-way signal.
- **Fed watch** — US Treasury 2Y/10Y/30Y yield curves (today / a week ago / a month ago), bull/bear steepening classification, stock-bond joint reading, risk appetite gauges (US-JP 10Y spread, HYG vs LQD credit spread, SPX vs TLT), and mini trend charts for VIX, core PCE, nonfarm payrolls, and unemployment with a dual-mandate verdict.
- **Asset / region heatmaps** — Weekly performance heatmaps for ~20 assets (USD, JPY, gold, BTC, ETH, crude oil, copper, clean energy, AI, major global equity indices, TLT) and 13 regional currencies: blue = inflow, red = outflow, with volatility-normalized coloring (z-score, default), click-to-sort by any week, hover rank-trajectory overlay, high-volume markers, and flip-signal summaries.

### Architecture

- **Pure static site**: `index.html` + `app.js` + `style.css` + vendored `d3.v7.min.js` — no framework, no build step, no backend
- **All charts rendered with D3.js v7**
- **All data fetched directly from the browser** (free CORS-enabled APIs only), polled at per-source intervals with graceful degradation (cached values + error badges) when a source fails
- **Visual style**: Neo-Memphis (saturated clashing colors, thick ink borders, hard offset shadows) with dark mode; all data colors validated for color-vision accessibility

### Data sources

| Data | Source | Polling |
|---|---|---|
| FX rates (USD base, for heatmaps and region card) | Frankfurter API (ECB data) | hourly |
| BTC/ETH/gold (PAXG) history and volume | CoinGecko | hourly |
| Equity indices, bonds, yields, VIX, crude, copper, live FX | TradingView scanner (unofficial) | every 2 min |
| Nonfarm payrolls, unemployment rate | US BLS official API | every 6 h |
| Core PCE price index | DBnomics (BEA mirror) | every 6 h |
| Taiwan daily foreign net buy/sell | TWSE | hourly |
| China margin data, southbound flows, 510300 intraday | East Money (unofficial) | hourly / 3 min intraday |
| TWD historical rates | fawazahmed0 currency-api | hourly |

### Daily snapshots

The TradingView scanner offers no week-by-week history, so a GitHub Actions workflow (`.github/workflows/snapshot.yml`) runs `scripts/snapshot.py` after each trading day, appending that day's quotes to `data/history.json` and committing back to main. The frontend reads these snapshots to backfill historical heatmap cells, independent of any single browser's localStorage.

### Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

### Disclaimer

This project is for informational and technical-demonstration purposes only and does not constitute investment advice. Some data comes from unofficial APIs that may change or break at any time.

### License

[MIT License](LICENSE)
