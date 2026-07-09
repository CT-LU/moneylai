'use strict';

/* ============================================================
   全球資金流向儀表板 — 主程式(D3.js 版)
   資料源:
   - Frankfurter API(ECB 匯率,每交易日更新)→ 美元指數近似、日圓、
     新興市場貨幣籃、區域資金流向(抓 92 天,供最長 12 週熱力圖)
   - CoinGecko market_chart(days=95,回日資料)→ BTC / ETH / 黃金(PAXG)
   - TradingView scanner → 原油 WTI/布蘭特、銅、綠能(ICLN)、AI(AIQ)
     即時報價與近一週/近一月表現;美債 2Y/10Y/30Y 殖利率、VIX、美元兌台幣;
     日債 10 年殖利率(美日利差)、黃金現貨(銅金比)、HYG/LQD(信用風險胃納)
   - TWSE 三大法人買賣金額統計表 → 台股外資每日買賣超(熱錢進出台灣的直接觀測)
   - data/history.json(GitHub Actions 每交易日快照)→ scanner 標的的每日收盤,
     與本機 localStorage 累積合併,歷史不再綁定單一瀏覽器
   - BLS 官方 API → 非農就業、失業率;DBnomics(BEA 鏡像)→ 核心 PCE 物價指數
   - fawazahmed0 currency-api(jsDelivr / pages.dev 備援)→ 新台幣對美元、
     日圓、歐元、人民幣的歷史匯率(ECB 沒有 TWD)
   原則:各資料源獨立抓取,單一來源失敗不影響其他區塊;
        重新抓取時保留前一次渲染(降透明度),不跳版。
   ============================================================ */

// ===== 常數設定 =====

// ICE 美元指數(DXY)權重,用 ECB 匯率計算近似值
const DXY_WEIGHTS = { EUR: 0.576, JPY: 0.136, GBP: 0.119, CAD: 0.091, SEK: 0.042, CHF: 0.036 };
const DXY_CONST = 50.14348112;

// 新興市場貨幣籃(等權幾何平均)
const EM_BASKET = ['KRW', 'INR', 'CNY', 'MXN', 'ZAR'];

// 區域資金流向的貨幣(ECB 有提供的清單;台灣的 TWD ECB 沒有,
// 改走 TradingView scanner + localStorage 累積,見 TWD_REGION)
const REGIONS = [
  { code: 'EUR', name: '歐元區', pair: 'EUR/USD' },
  { code: 'JPY', name: '日本',   pair: 'USD/JPY' },
  { code: 'GBP', name: '英國',   pair: 'GBP/USD' },
  { code: 'CHF', name: '瑞士',   pair: 'USD/CHF' },
  { code: 'AUD', name: '澳洲',   pair: 'AUD/USD' },
  { code: 'CNY', name: '中國',   pair: 'USD/CNY' },
  { code: 'KRW', name: '南韓',   pair: 'USD/KRW' },
  { code: 'SGD', name: '新加坡', pair: 'USD/SGD' },
  { code: 'INR', name: '印度',   pair: 'USD/INR' },
  { code: 'MXN', name: '墨西哥', pair: 'USD/MXN' },
  { code: 'ZAR', name: '南非',   pair: 'USD/ZAR' },
];

// ECB 沒有的區域貨幣(台灣、越南):走 scanner 即時報價,
// 舊欄靠 localStorage/每日快照跨日累積(初期會缺格)
const TWD_REGION = { sym: 'FX_IDC:USDTWD', name: '台灣', pair: 'USD/TWD', usdName: '美元兌台幣' };
const VND_REGION = { sym: 'FX_IDC:USDVND', name: '越南', pair: 'USD/VND', usdName: '美元兌越南盾' };
const SCANNER_REGIONS = [TWD_REGION, VND_REGION];

const ALL_FX = [...new Set([...Object.keys(DXY_WEIGHTS), ...EM_BASKET, ...REGIONS.map(r => r.code)])];

// TradingView scanner:資產流向用(即期價 + 近一週/近一月表現;
// 更早的逐週資料 = repo 每日快照 + localStorage 跨日累積,初期會缺格)。
// 注意:SCANNER_ALL 的標的清單必須與 scripts/snapshot.py 保持同步
const SCANNER_FLOWS = [
  { sym: 'NYMEX:CL1!',    ep: 'futures', name: '原油 WTI' },
  { sym: 'ICEEUR:BRN1!',  ep: 'futures', name: '原油 布蘭特' },
  { sym: 'OANDA:XCUUSD',  ep: 'global',  name: '銅(綠色通膨)' },
  { sym: 'NASDAQ:ICLN',   ep: 'global',  name: '綠能(ICLN)' },
  { sym: 'NASDAQ:AIQ',    ep: 'global',  name: 'AI(AIQ)' },
  // 全球主要股指(scanner 直接支援指數本尊;TVC:SHCOMP 不存在,上證用 SSE:000001)
  { sym: 'SP:SPX',        ep: 'global',  name: '美股(S&P 500)' },
  { sym: 'NASDAQ:IXIC',   ep: 'global',  name: '美股(NASDAQ)' },
  { sym: 'NASDAQ:SOX',    ep: 'global',  name: '美股(費半)' },
  { sym: 'TVC:NI225',     ep: 'global',  name: '日股(日經 225)' },
  { sym: 'TVC:SX5E',      ep: 'global',  name: '歐股(STOXX 50)' },
  { sym: 'SSE:000001',    ep: 'global',  name: '中國股(上證)' },
  { sym: 'SZSE:399001',   ep: 'global',  name: '中國股(深證)' },
  { sym: 'TVC:HSI',       ep: 'global',  name: '香港(恒生)' },
  // 債市:TLT(20 年期以上美債 ETF),漲=資金流入債市避險、跌=流出
  { sym: 'NASDAQ:TLT',    ep: 'global',  name: '債市(美債 TLT)' },
];

// 美債殖利率(scanner 同一批抓)
const BOND_TENORS = [
  { sym: 'TVC:US02Y', label: '2 年',  short: '2Y' },
  { sym: 'TVC:US10Y', label: '10 年', short: '10Y' },
  { sym: 'TVC:US30Y', label: '30 年', short: '30Y' },
];

const VIX_SYM = 'TVC:VIX';

// 熱錢驅動因子與比率指標(不進熱力圖,供判讀用):
// 美日 10 年利差(套利資金的引擎)、銅金比(增長 vs 避險)、HYG/LQD(信用風險胃納)
const JP10Y_SYM = 'TVC:JP10Y';
const GOLD_SYM  = 'TVC:GOLD';
const HYG_SYM   = 'AMEX:HYG';
const LQD_SYM   = 'AMEX:LQD';

// 人民幣離岸/在岸(CNH−CNY 價差:離岸比在岸貶得多 = 資金外流壓力)
const CNH_SYM = 'FX_IDC:USDCNH';
const CNY_SYM = 'FX_IDC:USDCNY';

// 台幣匯率卡即時交叉價用:配 USDTWD/USDCNY 推「1 單位外幣兌台幣」
//(FX_IDC 外匯為 streaming 即時報價,已驗證存在)
const USDJPY_SYM = 'FX_IDC:USDJPY';
const EURUSD_SYM = 'FX_IDC:EURUSD';

const SCANNER_ALL = [
  ...SCANNER_FLOWS,
  ...BOND_TENORS.map(t => ({ sym: t.sym, ep: 'global', name: `美債 ${t.label}` })),
  { sym: VIX_SYM, ep: 'global', name: 'VIX' },
  ...SCANNER_REGIONS.map(r => ({ sym: r.sym, ep: 'global', name: r.usdName })),
  { sym: JP10Y_SYM, ep: 'global', name: '日債 10 年' },
  { sym: GOLD_SYM,  ep: 'global', name: '黃金現貨' },
  { sym: HYG_SYM,   ep: 'global', name: '高收益債 HYG' },
  { sym: LQD_SYM,   ep: 'global', name: '投資級債 LQD' },
  { sym: CNH_SYM,   ep: 'global', name: '美元兌離岸人民幣' },
  { sym: CNY_SYM,   ep: 'global', name: '美元兌在岸人民幣' },
  { sym: USDJPY_SYM, ep: 'global', name: '美元兌日圓' },
  { sym: EURUSD_SYM, ep: 'global', name: '歐元兌美元' },
];

// 總經月資料(聯準會雙重使命:物價 + 就業)
const BLS_NFP = 'CES0000000001';   // 非農就業人數(千人,季調)
const BLS_UNRATE = 'LNS14000000';  // 失業率(%,季調)

// 新台幣對主要貨幣(currency-api,日更;歷史每週取樣一點)
// 固定順序與線色(cssVar 淺深兩組皆通過 dataviz 色彩驗證),不因缺線重排
const TWDFX_CURRENCIES = [
  { code: 'usd', name: '美元',   digits: 3, color: '--twd-usd' },
  { code: 'jpy', name: '日圓',   digits: 4, color: '--twd-jpy' },
  { code: 'eur', name: '歐元',   digits: 3, color: '--twd-eur' },
  { code: 'cny', name: '人民幣', digits: 3, color: '--twd-cny' },
];
const TWDFX_KEY = 'moneylai-twdfx-history';

// 台股外資買賣超(TWSE 三大法人買賣金額統計表 BFI82U):
// 一次只回單日,歷史單日用 dayDate=YYYYMMDD 查(date 參數無效、type=month 只回整月合計);
// 非交易日 stat != OK;當日資料收盤後(約 15:00 台灣時間)才發布
// key 帶版本:v1 曾把 TWSE 限流回應(HTTP 200 + stat「線上人數過多」)誤存成休市,直接棄用
const BFI_KEY = 'moneylai-bfi-history-v2';
const FOREIGN_TRADING_DAYS = 20;   // 顯示近 20 個交易日

const FX_POLL_MS = 60 * 60 * 1000;       // ECB 一天更新一次,每小時輪詢即可
const SCANNER_POLL_MS = 2 * 60 * 1000;   // scanner 非官方 API,保守輪詢
const HISTORY_POLL_MS = 60 * 60 * 1000;  // CoinGecko 歷史,每小時
const MACRO_POLL_MS = 6 * 60 * 60 * 1000; // 總經是月資料,6 小時輪詢綽綽有餘
const FOREIGN_POLL_MS = 60 * 60 * 1000;   // 外資買賣超一天更新一次,每小時輪詢即可
const SNAP_POLL_MS = 6 * 60 * 60 * 1000;  // 每日快照(repo 靜態檔)一天更新一次
const CHINA_POLL_MS = 60 * 60 * 1000;     // 兩融/南向/日K 皆為日資料,每小時輪詢即可
const ETF_POLL_MS = 3 * 60 * 1000;        // 510300 分時:A 股盤中每 3 分鐘(收盤後不打)

const DAY_MS = 86400e3;

// ===== 全域狀態 =====
const state = {
  fxDates: [],      // 排序後的日期字串
  fxRates: null,    // { date: { EUR: .., JPY: .. } },base = USD
  scanner: null,    // { sym: { close, change, perfW, perf1M } }
  cryptoHist: null, // { coinId: [{ date, value }] } 95 日日收盤
  macro: null,      // { pce, nfp, unrate } 各為 [{ date:'YYYY-MM', value }]
  twdfx: null,      // [{ date, usd, jpy, eur, cny }] 升冪,值 = 1 單位外幣兌台幣
  foreign: null,    // [{ date, net }] 台股外資買賣超(億元,升冪,僅交易日)
  snapHist: null,   // { sym: { date: close } } repo 內每日快照(GitHub Actions 產出)
  china: {          // 中國資金流向(東方財富):
    margin: null,   //   [{ date, net, balance }] 兩融融資淨買入/餘額(億元,升冪)
    south: null,    //   [{ date, net }] 港股通南向淨買入(億港元,升冪)
    etf: null,      //   { date, preClose, points: [{ time, price, vol }] } 510300 分時
    etfDaily: null, //   [{ date, vol }] 510300 日成交量(算量比用)
  },
};

// 介面狀態:兩張熱力圖各自的觀察週數、檢視模式、排序欄(sortAgo=k 欄前,0=最新)
// 與色階(pct=原始漲跌 %、z=除以自身波動度的標準化;預設 z);台幣匯率卡的觀察週數
// 觀察週數 1 = 逐日模式(欄=近 7 天的每日漲跌);預設一律 1 週(使用者指定)
const ui = {
  assetWeeks: 1,  assetView: 'chart',  assetSortAgo: 0,  assetScale: 'z',
  regionWeeks: 1, regionView: 'chart', regionSortAgo: 0, regionScale: 'z',
  twdWeeks: 1,
};

// ===== 小工具 =====
const $ = (sel) => document.querySelector(sel);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// 結論子區塊:粉紅標籤 + 白底黑粗體結論;多於一項時以數字編號逐行條列。
// items 的元素可為字串或 DOM 節點(null/空字串自動略過);note 為非結論的補充說明(細字)
function setRead(p, tag, items, note) {
  const list = items.filter(Boolean);
  if (!list.length) { p.textContent = ''; return; }
  const kids = [el('span', 'bond-tag', tag)];
  list.forEach((it, i) => {
    const line = el('span', 'read-item');
    if (list.length > 1) line.append(`${i + 1}. `);
    line.append(it);
    kids.push(line);
  });
  if (note) kids.push(el('span', 'read-note', note));
  p.replaceChildren(...kids);
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtPct(n, digits = 2) {
  if (!Number.isFinite(n)) return '—';
  const fixed = n.toFixed(digits);
  if (Number(fixed) === 0) return `${(0).toFixed(digits)}%`;   // 避免 -0.00%
  return `${n > 0 ? '+' : ''}${fixed}%`;
}

function fmtBp(n, digits = 1) {
  if (!Number.isFinite(n)) return '—';
  const fixed = n.toFixed(digits);
  if (Number(fixed) === 0) return `0 bp`;
  return `${n > 0 ? '+' : ''}${fixed} bp`;
}

function pctChange(from, to) { return (to / from - 1) * 100; }

function fmtZ(z) {
  if (!Number.isFinite(z)) return '—';
  return `${z > 0 ? '+' : ''}${z.toFixed(1)}σ`;
}

// 讀 CSS 變數(深淺模式切換時重讀即可拿到當前值)
function cssVar(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function setStatus(dotId, tsId, ok) {
  const dot = document.getElementById(dotId);
  dot.classList.toggle('ok', ok);
  dot.classList.toggle('err', !ok);
  document.getElementById(tsId).textContent =
    new Date().toLocaleTimeString('zh-TW', { hour12: false });
}

// ===== tooltip(整頁共用一個)=====
const tooltip = document.getElementById('tooltip');

// lines: [{ text, cls }],cls 可為 'tt-label' / 'tt-value'
function showTooltip(lines, x, y) {
  tooltip.replaceChildren(...lines.map(l => el('div', l.cls || '', l.text)));
  tooltip.hidden = false;
  const rect = tooltip.getBoundingClientRect();
  const px = Math.min(x + 14, window.innerWidth - rect.width - 8);
  const py = Math.max(8, y - rect.height - 12);
  tooltip.style.left = `${px}px`;
  tooltip.style.top = `${py}px`;
}

function hideTooltip() { tooltip.hidden = true; }

// ===== 資料抓取 =====

async function fetchFX() {
  const start = isoDate(new Date(Date.now() - 92 * DAY_MS));   // 供最長 12 週
  const url = `https://api.frankfurter.dev/v1/${start}..?base=USD&symbols=${ALL_FX.join(',')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Frankfurter ${res.status}`);
  const data = await res.json();
  state.fxRates = data.rates;
  state.fxDates = Object.keys(data.rates).sort();
}

// ===== 新台幣匯率(currency-api)=====
// Frankfurter(ECB)沒有 TWD,台幣歷史匯率走 fawazahmed0 currency-api:
// jsDelivr 為主、pages.dev 備援;@{YYYY-MM-DD} 可查任意歷史日、@latest 為當日

async function fetchTwdFxDate(tag) {
  const path = 'v1/currencies/usd.min.json';
  const urls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${tag}/${path}`,
    `https://${tag}.currency-api.pages.dev/${path}`,
  ];
  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`currency-api ${res.status}`);
      return await res.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// 由 USD 基準交叉推算「1 單位外幣兌多少台幣」
function twdRatesFrom(data) {
  const u = data && data.usd;
  if (!u || !u.twd) return null;
  const out = {};
  for (const { code } of TWDFX_CURRENCIES) {
    if (!u[code]) return null;
    out[code] = code === 'usd' ? u.twd : u.twd / u[code];
  }
  return out;
}

function loadTwdHist() {
  try { return JSON.parse(localStorage.getItem(TWDFX_KEY)) || {}; }
  catch { return {}; }
}

async function fetchTwdFx() {
  const hist = loadTwdHist();

  // 最新一筆一定重抓(latest 每日更新)
  const latest = await fetchTwdFxDate('latest');
  const latestRates = twdRatesFrom(latest);
  if (!latestRates) throw new Error('currency-api 缺台幣匯率');
  hist[latest.date] = latestRates;

  // 錨點:最近 1–6 天每日一點(供「1 週」視窗畫日趨勢)+ 往回每 7 天一點 × 12 週;
  // 歷史匯率不會變,快取命中就不再請求 —— 首次載入約 19 個請求,之後每天只新增 1–2 個
  const baseMs = new Date(latest.date).getTime();
  const anchors = [];
  for (let d = 1; d <= 6; d++) anchors.push(isoDate(new Date(baseMs - d * DAY_MS)));
  for (let w = 1; w <= 12; w++) anchors.push(isoDate(new Date(baseMs - w * 7 * DAY_MS)));
  await Promise.allSettled(anchors.filter(d => !hist[d]).map(async (d) => {
    const rates = twdRatesFrom(await fetchTwdFxDate(d));
    if (rates) hist[d] = rates;   // 單日失敗只缺一點,不影響整體
  }));

  // 修剪:超過 100 天的日期刪除,不無限累積
  const cutoff = isoDate(new Date(baseMs - 100 * DAY_MS));
  for (const d of Object.keys(hist)) if (d < cutoff) delete hist[d];
  try { localStorage.setItem(TWDFX_KEY, JSON.stringify(hist)); }
  catch { /* 隱私模式寫入失敗:僅影響下次載入速度 */ }

  state.twdfx = Object.keys(hist).sort().map(d => ({ date: d, ...hist[d] }));
}

// ===== 台股外資買賣超(TWSE 三大法人買賣金額統計表)=====
// 熱錢進出台灣少數可「直接觀測」的數字(其餘皆為價格代理)。
// 歷史值收盤後即定案 → localStorage 永久快取(null = 已確認的非交易日);
// 首次載入逐日回補約一個月,TWSE 有頻率限制,請求之間要間隔。

// 台灣時區(UTC+8)往前 offsetDays 天的日曆日:瀏覽器不一定在台灣
function twDate(offsetDays) {
  const d = new Date(Date.now() + 8 * 3600e3 - offsetDays * DAY_MS);
  return { iso: d.toISOString().slice(0, 10), dow: d.getUTCDay() };
}

function loadBfiHist() {
  try {
    localStorage.removeItem('moneylai-bfi-history');   // 清掉可能被限流回應污染的舊版快取
    return JSON.parse(localStorage.getItem(BFI_KEY)) || {};
  }
  catch { return {}; }
}

function saveBfiHist(hist) {
  const cutoff = twDate(60).iso;   // 只留 60 天,不無限累積
  for (const d of Object.keys(hist)) if (d < cutoff) delete hist[d];
  try { localStorage.setItem(BFI_KEY, JSON.stringify(hist)); }
  catch { /* 隱私模式寫入失敗:僅影響下次載入速度 */ }
}

function updateForeignState(hist) {
  state.foreign = Object.entries(hist)
    .filter(([, v]) => Number.isFinite(v))
    .map(([date, net]) => ({ date, net }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-FOREIGN_TRADING_DAYS);
}

// 單日外資買賣差額(億元);null = 非交易日或當日尚未發布
async function fetchBfiDay(iso) {
  const url = `https://www.twse.com.tw/rwd/zh/fund/BFI82U?type=day&dayDate=${iso.replaceAll('-', '')}&response=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TWSE ${res.status}`);
  const json = await res.json();
  if (json.stat === 'OK' && Array.isArray(json.data)) {
    // 「外資及陸資(不含外資自營商)」+「外資自營商」;部分日期的格式只有單一「外資」列
    let sum = 0, found = false;
    for (const row of json.data) {
      if (typeof row[0] === 'string' && row[0].startsWith('外資')) {
        const v = Number(String(row[3]).replace(/,/g, ''));
        if (Number.isFinite(v)) { sum += v; found = true; }
      }
    }
    if (found) return Math.round(sum / 1e6) / 100;   // 元 → 億元
    return null;
  }
  // 只有「沒有符合條件的資料」才是確認的非交易日;
  // 其他非 OK(如限流的「線上人數過多」,一樣回 HTTP 200)是暫時性錯誤,絕不可當休市快取
  if (String(json.stat).includes('沒有符合條件')) return null;
  throw new Error(`TWSE 暫時無法服務:${json.stat}`);
}

// 回補缺漏的交易日;部分失敗回傳第一個錯誤(顯示既有快取,下次輪詢再補)
async function fetchForeign() {
  const hist = loadBfiHist();
  updateForeignState(hist);
  renderForeignCard();               // 先用快取畫,回補中逐步補齊
  const today = twDate(0).iso;
  let firstErr = null, fetched = 0;
  for (let k = 0; k < 35; k++) {     // 近 35 個日曆日,足以湊滿 20 個交易日
    const { iso, dow } = twDate(k);
    if (dow === 0 || dow === 6) continue;      // 跳過週六日
    if (hist[iso] !== undefined) continue;     // 已快取(含確認休市的 null)
    if (fetched > 0) await sleep(1100);        // TWSE 頻率限制:逐日間隔抓
    try {
      let v;
      try { v = await fetchBfiDay(iso); }
      catch {
        await sleep(3000);                     // 暫時性錯誤(限流等):稍候重試一次
        v = await fetchBfiDay(iso);
      }
      fetched++;
      if (v !== null) hist[iso] = v;
      else if (iso !== today) hist[iso] = null; // 當日可能只是尚未發布,不快取
      saveBfiHist(hist);
      updateForeignState(hist);
      renderForeignCard();
    } catch (e) { firstErr ??= e; }
  }
  if (firstErr && !state.foreign?.length) throw firstErr;
  return firstErr;
}

// ===== 中國資金流向(東方財富:兩融 + 南向 + 滬深300 ETF)=====
// A 股主力是內資,且陸港通北向的每日淨買入自 2024-08-18 起停止披露
//(MUTUAL_TYPE 001/003/005 的買賣與淨買欄位全為 null),無法直接觀測外資。
// 改看:兩融融資淨買入(內資槓桿情緒)、港股通南向淨買入(內地資金出海)、
// CNH−CNY 價差(資金外流壓力,走 scanner)、510300 分時價量(國家隊護盤跡象)。
// 東方財富為非官方介面:各端點獨立抓,單一失敗只缺對應區塊。

async function fetchEmRows(params) {
  const res = await fetch(`https://datacenter-web.eastmoney.com/api/data/v1/get?${params}`);
  if (!res.ok) throw new Error(`東方財富 ${res.status}`);
  const rows = (await res.json()).result?.data;
  if (!Array.isArray(rows) || !rows.length) throw new Error('東方財富無資料');
  return rows;
}

// 兩融(滬深合計):融資淨買額 = 內資槓桿的日頻風險偏好;融資餘額 = 槓桿水位
async function fetchChinaMargin() {
  const rows = await fetchEmRows(
    'reportName=RPTA_RZRQ_LSHJ&columns=ALL&source=WEB&sortColumns=DIM_DATE&sortTypes=-1&pageNumber=1&pageSize=40');
  state.china.margin = rows
    .map(r => ({
      date: String(r.DIM_DATE).slice(0, 10),
      net: r.RZJME / 1e8,        // 元 → 億元
      balance: r.RZYE / 1e8,     // 元 → 億元(顯示時再換兆)
    }))
    .filter(r => Number.isFinite(r.net) && Number.isFinite(r.balance))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-FOREIGN_TRADING_DAYS);
}

// 港股通南向合計(MUTUAL_TYPE=006):內地資金南下買港股的每日淨買入
async function fetchChinaSouth() {
  const rows = await fetchEmRows(
    'reportName=RPT_MUTUAL_DEAL_HISTORY&columns=ALL&source=WEB&sortColumns=TRADE_DATE&sortTypes=-1' +
    '&pageNumber=1&pageSize=40&filter=(MUTUAL_TYPE%3D%22006%22)');
  state.china.south = rows
    .map(r => ({ date: String(r.TRADE_DATE).slice(0, 10), net: r.NET_DEAL_AMT / 100 }))  // 百萬港元 → 億港元
    .filter(r => Number.isFinite(r.net))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-FOREIGN_TRADING_DAYS);
}

// 滬深300 ETF(510300,國家隊護盤主要工具)分時:1 分鐘價量;
// 非交易時段回最近交易日的全天 241 點
async function fetchEtfTrends() {
  const res = await fetch('https://push2his.eastmoney.com/api/qt/stock/trends2/get' +
    '?secid=1.510300&fields1=f1,f2,f3,f7,f8&fields2=f51,f53,f56,f58&iscr=0&ndays=1');
  if (!res.ok) throw new Error(`東方財富分時 ${res.status}`);
  const d = (await res.json()).data;
  if (!d || !Array.isArray(d.trends) || d.trends.length < 2) throw new Error('分時無資料');
  const points = d.trends.map(s => {
    const [dt, price, vol] = s.split(',');
    return { time: dt.slice(11, 16), price: Number(price), vol: Number(vol) };
  }).filter(p => Number.isFinite(p.price) && Number.isFinite(p.vol));
  if (points.length < 2) throw new Error('分時無資料');
  state.china.etf = { date: d.trends[0].slice(0, 10), preClose: d.preClose, points };
}

// 510300 日 K(只取成交量,單位「手」與分時一致):供量比 = 當日量 ÷ 20 日均量
async function fetchEtfDaily() {
  const res = await fetch('https://push2his.eastmoney.com/api/qt/stock/kline/get' +
    '?secid=1.510300&klt=101&fqt=1&lmt=25&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57');
  if (!res.ok) throw new Error(`東方財富日K ${res.status}`);
  const d = (await res.json()).data;
  if (!d || !Array.isArray(d.klines) || !d.klines.length) throw new Error('日K無資料');
  state.china.etfDaily = d.klines
    .map(s => { const f = s.split(','); return { date: f[0], vol: Number(f[5]) }; })
    .filter(r => Number.isFinite(r.vol));
}

// TradingView scanner:一次 POST 拿多檔報價
// (close、當日變化 %、近一週表現 %、近一月表現 %、今日量比)
// 量比 = 今日成交量 ÷ 近 10 日均量,無因次所以跨標的可比;
// TVC 指數/外匯/現貨金沒有集中成交量,該欄回 null,屬正常
async function fetchScanner() {
  const groups = {};
  for (const a of SCANNER_ALL) (groups[a.ep] ||= []).push(a.sym);
  const lists = await Promise.all(Object.entries(groups).map(async ([ep, tickers]) => {
    // 不設 Content-Type:維持「簡單請求」避免 CORS preflight
    //(scanner 的 Access-Control-Allow-Headers 不含 content-type)
    const res = await fetch(`https://scanner.tradingview.com/${ep}/scan`, {
      method: 'POST',
      body: JSON.stringify({
        symbols: { tickers, query: { types: [] } },
        columns: ['close', 'change', 'Perf.W', 'Perf.1M', 'relative_volume_10d_calc'],
      }),
    });
    if (!res.ok) throw new Error(`scanner ${res.status}`);
    return (await res.json()).data || [];
  }));
  const out = {};
  for (const item of lists.flat()) {
    out[item.s] = { close: item.d[0], change: item.d[1], perfW: item.d[2], perf1M: item.d[3], relVol: item.d[4] };
  }
  if (!Object.keys(out).length) throw new Error('scanner 無資料');
  state.scanner = out;
  recordScannerHistory();
}

// 總經月資料:非農與失業率走 BLS 官方 API(有 CORS;它擋 OPTIONS preflight,
// 所以只能用免 preflight 的 GET,一序列一請求,不能 POST JSON);
// 核心 PCE 走 DBnomics 的 BEA 鏡像(FRED 無 CORS、BEA 官方要 key)
async function fetchMacro() {
  const year = new Date().getFullYear();
  const blsUrl = (id) =>
    `https://api.bls.gov/publicAPI/v2/timeseries/data/${id}?startyear=${year - 2}&endyear=${year}`;
  const [nfpRes, urRes, pceRes] = await Promise.all([
    fetch(blsUrl(BLS_NFP)).then(r => { if (!r.ok) throw new Error(`BLS ${r.status}`); return r.json(); }),
    fetch(blsUrl(BLS_UNRATE)).then(r => { if (!r.ok) throw new Error(`BLS ${r.status}`); return r.json(); }),
    fetch('https://api.db.nomics.world/v22/series/BEA/NIPA-T20804/DPCCRG-M?observations=1&format=json')
      .then(r => { if (!r.ok) throw new Error(`DBnomics ${r.status}`); return r.json(); }),
  ]);

  const bls = {};
  for (const res of [nfpRes, urRes]) {
    if (res.status !== 'REQUEST_SUCCEEDED') throw new Error('BLS 回應異常');
    for (const s of res.Results?.series || []) {
      bls[s.seriesID] = s.data
        .filter(x => /^M(0\d|1[0-2])$/.test(x.period))   // 排除年度值 M13
        .map(x => ({ date: `${x.year}-${x.period.slice(1)}`, value: Number(x.value) }))
        .filter(p => Number.isFinite(p.value))
        .sort((a, b) => a.date.localeCompare(b.date));
    }
  }

  // 非農取「月增」(千人):就業市場動能看的是每月新增而非總量
  const nfpLevels = bls[BLS_NFP] || [];
  const nfp = nfpLevels.slice(1).map((p, i) => ({ date: p.date, value: p.value - nfpLevels[i].value }));

  // 核心 PCE:BEA 給的是指數,轉成年增率(聯準會 2% 目標即以此衡量)
  const doc = pceRes.series?.docs?.[0];
  if (!doc) throw new Error('DBnomics 無資料');
  const idx = doc.period
    .map((d, i) => ({ date: d, value: Number(doc.value[i]) }))
    .filter(p => Number.isFinite(p.value));
  const byDate = new Map(idx.map(p => [p.date, p.value]));
  const pce = idx.flatMap(p => {
    const [y, m] = p.date.split('-');
    const prev = byDate.get(`${Number(y) - 1}-${m}`);
    return prev ? [{ date: p.date, value: (p.value / prev - 1) * 100 }] : [];
  });

  if (!nfp.length && !pce.length) throw new Error('總經無資料');
  state.macro = {
    nfp: nfp.slice(-13),
    unrate: (bls[BLS_UNRATE] || []).slice(-13),
    pce: pce.slice(-13),
  };
}

// BTC / ETH / 黃金(PAXG)的 95 日歷史(>90 天 CoinGecko 直接回日資料)
async function fetchCryptoHistory() {
  const ids = ['bitcoin', 'ethereum', 'pax-gold'];
  const lists = await Promise.all(ids.map(id =>
    fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=95`)
      .then(r => { if (!r.ok) throw new Error(`CoinGecko ${r.status}`); return r.json(); })
  ));
  const hist = {};
  const relVol = {};
  ids.forEach((id, i) => {
    const daily = new Map();   // 同一 UTC 日取最後一筆(最後一點是盤中即時值)
    for (const [ms, price] of lists[i].prices || []) {
      daily.set(new Date(ms).toISOString().slice(0, 10), price);
    }
    hist[id] = [...daily.entries()].map(([date, value]) => ({ date, value }));
    // 量比:total_volumes 是滾動 24 小時量,最後一點 ÷ 前 10 個日點均量
    const vols = (lists[i].total_volumes || []).map(v => v[1]).filter(Number.isFinite);
    const last = vols[vols.length - 1];
    const base = vols.slice(-11, -1);
    relVol[id] = (base.length >= 5 && last > 0)
      ? last / (base.reduce((s, v) => s + v, 0) / base.length) : null;
  });
  state.cryptoHist = hist;
  state.cryptoRelVol = relVol;
}

// ===== scanner 資產的逐週歷史:localStorage 跨日累積 =====
// scanner 只給近一週(Perf.W)與近一月(Perf.1M)表現,拿不到逐週切分。
// 每次抓到資料就存「今天」的收盤,並補上反推的 7 天前、30 天前估值
//(不覆蓋既有的直接觀測值);跨日累積約四週後,熱力圖的舊週格即可補齊。
const SCAN_HIST_KEY = 'moneylai-scanner-history';

function loadScanHist() {
  try { return JSON.parse(localStorage.getItem(SCAN_HIST_KEY)) || {}; }
  catch { return {}; }
}

function recordScannerHistory() {
  const hist = loadScanHist();
  const today = new Date();
  for (const [sym, q] of Object.entries(state.scanner)) {
    if (!Number.isFinite(q.close)) continue;
    const h = (hist[sym] ||= {});
    h[isoDate(today)] = q.close;                      // 直接觀測,一律更新
    if (Number.isFinite(q.perfW)) {
      const d7 = isoDate(new Date(today.getTime() - 7 * DAY_MS));
      h[d7] ??= q.close / (1 + q.perfW / 100);        // 反推估值,不覆蓋既有紀錄
    }
    if (Number.isFinite(q.perf1M)) {
      const d30 = isoDate(new Date(today.getTime() - 30 * DAY_MS));
      h[d30] ??= q.close / (1 + q.perf1M / 100);
    }
    for (const d of Object.keys(h)) {                 // 只留 100 天
      if (new Date(d).getTime() < today.getTime() - 100 * DAY_MS) delete h[d];
    }
  }
  // 汰除已不再追蹤的標的:改代碼或移除標的後,孤兒紀錄不能永遠留著
  const tracked = new Set(SCANNER_ALL.map(a => a.sym));
  for (const sym of Object.keys(hist)) {
    if (!tracked.has(sym)) delete hist[sym];
  }
  try { localStorage.setItem(SCAN_HIST_KEY, JSON.stringify(hist)); }
  catch { /* 隱私模式等寫入失敗,略過即可 */ }
}

// 每日快照(repo 的 data/history.json,GitHub Actions 每交易日更新):
// 讓 scanner 標的的逐週歷史不再綁定單一瀏覽器;首次部署前檔案可能不存在(404),失敗靜默略過
async function fetchSnapHist() {
  const res = await fetch(`data/history.json?d=${isoDate(new Date())}`);   // 相對路徑;以日期破快取
  if (!res.ok) throw new Error(`快照 ${res.status}`);
  state.snapHist = await res.json();
}

async function refreshSnapshot() {
  try {
    await fetchSnapHist();
    renderAll();
  } catch (e) {
    console.warn('每日快照載入失敗(不影響其他資料):', e);
  }
}

// 把某 scanner 標的的「每日快照 + 本機累積」合併成升冪日序列
function scannerSeries(sym) {
  const h = loadScanHist()[sym];
  const q = state.scanner?.[sym];
  const map = new Map(Object.entries(h || {}));
  // 快照是伺服端記錄的實際收盤,蓋過本機同日的反推估值
  for (const [d, v] of Object.entries(state.snapHist?.[sym] || {})) {
    if (Number.isFinite(v)) map.set(d, v);
  }
  // 即時報價是「今天」最新的觀測,一律蓋過快照/本機的當日值;
  // 反推錨點只補缺(localStorage 寫入失敗的隱私模式也因此至少有三個點)
  if (q && Number.isFinite(q.close)) {
    const now = Date.now();
    map.set(isoDate(new Date(now)), q.close);
    if (Number.isFinite(q.perfW)) {
      const d7 = isoDate(new Date(now - 7 * DAY_MS));
      if (!map.has(d7)) map.set(d7, q.close / (1 + q.perfW / 100));
    }
    if (Number.isFinite(q.perf1M)) {
      const d30 = isoDate(new Date(now - 30 * DAY_MS));
      if (!map.has(d30)) map.set(d30, q.close / (1 + q.perf1M / 100));
    }
  }
  return [...map.entries()]
    .map(([date, value]) => ({ date, value }))
    .filter(p => Number.isFinite(p.value))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ===== 衍生序列 =====

// 由 ECB 匯率籃計算 DXY 近似值的時間序列
function dxySeries() {
  return state.fxDates.map(d => {
    const r = state.fxRates[d];
    let v = DXY_CONST;
    for (const [cur, w] of Object.entries(DXY_WEIGHTS)) v *= Math.pow(r[cur], w);
    return v;
  });
}

function fxSeries(code) {
  return state.fxDates.map(d => state.fxRates[d][code]);
}

// 新興市場貨幣強弱指數:起日 = 100,上升 = EM 貨幣兌美元走強
function emIndexSeries() {
  const first = state.fxRates[state.fxDates[0]];
  return state.fxDates.map(d => {
    const r = state.fxRates[d];
    let prod = 1;
    for (const cur of EM_BASKET) prod *= first[cur] / r[cur];
    return Math.pow(prod, 1 / EM_BASKET.length) * 100;
  });
}

function toSeries(dates, values) {
  return dates.map((d, i) => ({ date: d, value: values[i] }));
}

// ===== 週切分 =====

// 在日序列裡找最接近 target 時間(容差 ±4.5 天)的點
function valueNear(series, targetMs) {
  let best = null, bestDiff = 4.5 * DAY_MS;
  for (const p of series) {
    const diff = Math.abs(new Date(p.date).getTime() - targetMs);
    if (diff < bestDiff) { best = p; bestDiff = diff; }
  }
  return best;
}

// series: [{ date, value }] 升冪 → 近 nWeeks 週的每週漲跌 %
// 回 [{ pct|null, from, to }],由舊到新;算不出來的週為 null
function weeklyChanges(series, nWeeks) {
  const now = Date.now();
  const cells = [];
  for (let k = nWeeks - 1; k >= 0; k--) {
    const endMs = now - k * 7 * DAY_MS;
    const startMs = endMs - 7 * DAY_MS;
    const p1 = series ? valueNear(series, endMs) : null;
    const p0 = series ? valueNear(series, startMs) : null;
    const ok = p0 && p1 && p0.date < p1.date;
    cells.push({
      pct: ok ? pctChange(p0.value, p1.value) : null,
      from: isoDate(new Date(startMs)),
      to: isoDate(new Date(endMs)),
    });
  }
  return cells;
}

// series → 近 nDays 天的逐日漲跌 %(觀察期間選 1 週時,欄=日)
// 每格 = 當日值對「前一個有值日」的漲跌;前一有值日往回最多找 5 天
//(涵蓋週末與單日假期,但擋掉 7 天前反推錨點——那是週資料,不能當日漲跌賣)
// 缺當日資料(休市、快照尚未累積)為 null,由熱力圖顯示斜線格
function dailyChanges(series, nDays) {
  const byDate = new Map((series || []).map(p => [p.date, p.value]));
  const now = Date.now();
  const cells = [];
  for (let k = nDays - 1; k >= 0; k--) {
    const dayMs = now - k * DAY_MS;
    const to = isoDate(new Date(dayMs));
    const v1 = byDate.get(to);
    let from = null, v0 = null;
    for (let b = 1; b <= 5; b++) {
      const d = isoDate(new Date(dayMs - b * DAY_MS));
      if (byDate.has(d)) { from = d; v0 = byDate.get(d); break; }
    }
    const ok = Number.isFinite(v0) && Number.isFinite(v1);
    cells.push({
      pct: ok ? pctChange(v0, v1) : null,
      from: from ?? isoDate(new Date(dayMs - DAY_MS)),
      to,
    });
  }
  return cells;
}

// 資金動向的文字判讀(最近兩欄):讓「錢往哪跑、停在哪」一眼可讀
// unit = 最新一欄的稱呼(週模式「本週」、逐日模式「今日」)
function flowVerdict(thisW, prevW, unit = '本週') {
  if (thisW === null) return '—';
  if (prevW === null) {
    if (Math.abs(thisW) <= 0.3) return '持平';
    return thisW > 0 ? `${unit}流入` : `${unit}流出`;
  }
  const nowIn = thisW > 0.3, nowOut = thisW < -0.3;
  const wasIn = prevW > 0.3, wasOut = prevW < -0.3;
  if (nowIn && wasOut) return '由流出轉流入';
  if (nowOut && wasIn) return '由流入轉流出';
  if (nowIn && wasIn) return thisW > prevW ? '流入加速' : '流入放緩';
  if (nowOut && wasOut) return thisW < prevW ? '流出加速' : '流出趨緩';
  if (nowIn) return `${unit}流入`;
  if (nowOut) return `${unit}流出`;
  return '持平';
}

// ===== 熱力圖資料列 =====

// 週漲跌波動度(σ,對 0 的均方根):一律以最長 12 週估計(不受觀察期間影響);
// 非空樣本 <3 不可靠,回 null(由 attachZ 用全體中位數補)
function weeklySigma12(series) {
  const pcts = weeklyChanges(series, 12).map(c => c.pct).filter(Number.isFinite);
  if (pcts.length < 3) return null;
  return Math.sqrt(pcts.reduce((s, v) => s + v * v, 0) / pcts.length) || null;
}

// 日漲跌波動度(σ):以序列裡所有相鄰 ≤5 天的日漲跌估計(對 0 均方根);
// 反推錨點(相鄰間隔 ≥7 天)自然被排除,不會混入週幅度
function dailySigma(series) {
  const pcts = [];
  for (let i = 1; i < (series?.length ?? 0); i++) {
    const gap = (new Date(series[i].date) - new Date(series[i - 1].date)) / DAY_MS;
    const v = pctChange(series[i - 1].value, series[i].value);
    if (gap <= 5 && Number.isFinite(v)) pcts.push(v);
  }
  if (pcts.length < 3) return null;
  return Math.sqrt(pcts.reduce((s, v) => s + v * v, 0) / pcts.length) || null;
}

// scanner 的官方今日漲跌(change):逐日模式「今天」格的即時補值——
// scanner 標的的逐日歷史要靠快照跨日累積,初期算不出「今天 vs 昨天」,
// 但 change 本來就是今日漲跌,直接可用。invert = 序列取了倒數(台幣列 = 1/USDTWD)
function scannerTodayPct(sym, invert = false) {
  const c = state.scanner?.[sym]?.change;
  if (!Number.isFinite(c)) return null;
  return invert ? (1 / (1 + c / 100) - 1) * 100 : c;
}

// 每格掛上標準化值 z = 該週漲跌 ÷ 自身 σ:「這個動作對該資產有多不尋常」,跨資產可比
function attachZ(rows) {
  const sigmas = rows.map(r => r.sigma).filter(Number.isFinite).sort((a, b) => a - b);
  const fallback = sigmas.length ? sigmas[Math.floor(sigmas.length / 2)] : null;
  for (const r of rows) {
    const s = r.sigma ?? fallback;   // 累積中的列先用全體中位數當尺
    for (const c of r.cells) c.z = (c.pct !== null && s) ? c.pct / s : null;
  }
}

// 資產列:name、src(資料源)、cells(每欄漲跌)、relVol(今日量比,無量能資料為 null)
// relVol 欄位只有資產列有(區域卡是外匯,沒有集中成交量,整個欄位不存在)
// daily = 逐日模式(觀察期間 1 週):cells=近 nCols 天的日漲跌、σ 用日波動度,
// scanner 列的「今天」格算不出時用官方今日漲跌(change)補
function assetRows(nCols, daily = false) {
  const rows = [];
  const cut = (series) => daily ? dailyChanges(series, nCols) : weeklyChanges(series, nCols);
  const sig = (series) => daily ? dailySigma(series) : weeklySigma12(series);
  const add = (name, series, src, relVol = null, todaySym = null) => {
    if (!series || series.length < 2) return;
    const cells = cut(series);
    if (daily && todaySym) {
      const last = cells[cells.length - 1];
      if (last.pct === null) last.pct = scannerTodayPct(todaySym);
    }
    rows.push({ name, src, relVol, cells, sigma: sig(series) });
  };

  if (state.fxRates) {
    add('美元(DXY 近似)', toSeries(state.fxDates, dxySeries()), 'ECB 匯率');
    // 反轉 USD/JPY 成「日圓的價值」:升 = 套利平倉、資金回流日圓
    add('日圓(兌美元)', toSeries(state.fxDates, fxSeries('JPY').map(v => 1 / v)), 'ECB 匯率');
    add('新興市場貨幣籃', toSeries(state.fxDates, emIndexSeries()), 'ECB 匯率');
  }
  if (state.cryptoHist) {
    add('黃金(PAXG)', state.cryptoHist['pax-gold'], 'CoinGecko', state.cryptoRelVol?.['pax-gold']);
    add('比特幣', state.cryptoHist['bitcoin'], 'CoinGecko', state.cryptoRelVol?.['bitcoin']);
    add('以太幣', state.cryptoHist['ethereum'], 'CoinGecko', state.cryptoRelVol?.['ethereum']);
  }
  if (state.scanner) {
    for (const a of SCANNER_FLOWS) {
      const rv = state.scanner[a.sym]?.relVol;
      add(a.name, scannerSeries(a.sym), 'TradingView', Number.isFinite(rv) ? rv : null, a.sym);
    }
  }

  for (const r of rows) r.latest = r.cells[r.cells.length - 1]?.pct ?? null;
  attachZ(rows);
  return rows;
}

// 區域列:貨幣兌美元的每欄升貶值(1/匯率 → 升 = 該貨幣升值 = 流入傾向)
function regionRows(nCols, daily = false) {
  const rows = [];
  const cut = (series) => daily ? dailyChanges(series, nCols) : weeklyChanges(series, nCols);
  const sig = (series) => daily ? dailySigma(series) : weeklySigma12(series);
  if (state.fxRates) {
    for (const r of REGIONS) {
      const series = toSeries(state.fxDates, fxSeries(r.code).map(v => 1 / v));
      rows.push({ name: r.name, src: r.pair, cells: cut(series), sigma: sig(series) });
    }
  }
  // 台灣、越南:ECB 沒有 TWD/VND,改用 scanner 的美元兌該幣(取倒數 = 該幣價值)
  for (const r of SCANNER_REGIONS) {
    const series = scannerSeries(r.sym)
      .map(p => ({ date: p.date, value: 1 / p.value }));
    if (series.length < 2) continue;
    const cells = cut(series);
    if (daily) {
      const last = cells[cells.length - 1];
      // 序列取了倒數,今日漲跌方向要跟著反轉
      if (last.pct === null) last.pct = scannerTodayPct(r.sym, true);
    }
    rows.push({ name: r.name, src: r.pair, cells, sigma: sig(series) });
  }
  for (const r of rows) r.latest = r.cells[r.cells.length - 1]?.pct ?? null;
  attachZ(rows);
  return rows;
}

// 依「ago 週前」該欄排序(高→低,無資料排最後);useZ 時以標準化值為準。
// 該欄值掛到 r.sortVal 供右欄數字用(pct 模式=漲跌 %、z 模式=σ)
function sortRowsByWeek(rows, nWeeks, ago, useZ) {
  const idx = nWeeks - 1 - ago;
  for (const r of rows) r.sortVal = (useZ ? r.cells[idx]?.z : r.cells[idx]?.pct) ?? null;
  return rows.sort((a, b) => (b.sortVal ?? -Infinity) - (a.sortVal ?? -Infinity));
}

// ===== 熱力圖(D3)=====

// 欄標:週模式=本週/-N週;逐日模式=今天/M/D(dateIso 取該欄的日期)
function colLabel(idx, nCols, daily, dateIso) {
  if (!daily) return idx === nCols - 1 ? '本週' : `-${nCols - 1 - idx}週`;
  if (idx === nCols - 1) return '今天';
  const [, m, d] = (dateIso || '').split('-');
  return m ? `${Number(m)}/${Number(d)}` : `-${nCols - 1 - idx}日`;
}

const REL_VOL_HIGH = 1.5;   // 今日量比 ≥1.5 = 放量(價格動作有量在背書)

function renderHeatmap(containerSel, legendSel, rows, nWeeks, patId, sortAgo, onSortAgo, useZ, daily = false) {
  const container = $(containerSel);
  if (!rows.length) { container.replaceChildren(); return; }
  const cellVal = (c) => (useZ ? c.z : c.pct) ?? null;   // 色階取值:原始 % 或標準化 σ
  const hasVol = rows.some(r => 'relVol' in r);          // 只有資產卡的列帶量比欄位
  const colWord = daily ? '日' : '週';                    // tooltip/欄語彙跟著模式走

  const width = Math.max(320, container.clientWidth || 800);
  const labelW = Math.min(132, Math.max(88, Math.round(width * 0.16)));
  const valueW = 64;
  const gap = 3;
  const headerH = 22;
  const rowH = 32, cellH = rowH - 6;
  const cellW = (width - labelW - valueW - gap * nWeeks) / nWeeks;
  const height = headerH + rows.length * rowH + 2;
  const colX = (j) => labelW + j * (cellW + gap);

  const ink = cssVar('--ink');
  const cIn = cssVar('--series-in');
  const cOut = cssVar('--series-out');
  const cMid = cssVar('--neutral-mid');
  const cText = cssVar('--text-primary');
  const cSub = cssVar('--text-secondary');
  const cMuted = cssVar('--text-muted');
  const surface = cssVar('--surface-1');   // 「資料累積中」格用白底(卡片底色),與資料格區分

  // 色階:對稱 diverging。原始 % 依資料絕對值決定上限(1.5%~8% 夾住);
  // 標準化固定 ±2.5σ(z 本身就是共同尺度,|σ|>2 = 不尋常)
  const absVals = rows.flatMap(r => r.cells.map(cellVal).filter(v => v !== null).map(Math.abs));
  const maxAbs = useZ ? 2.5 : Math.min(8, Math.max(1.5, d3.max(absVals) ?? 1.5));
  const color = d3.scaleLinear()
    .domain([-maxAbs, 0, maxAbs])
    .range([cOut, cMid, cIn])
    .interpolate(d3.interpolateLab)
    .clamp(true);

  // 每週名次(輪動語意):該週有資料的列依當前色階值由高到低排;
  // 列序本身就是依「選中排序週」的同一套值排的,所以 hover 列的名次線
  // 在排序欄必然穿過它自己的格子——疊加線有視覺錨點
  const rankAt = new Map(rows.map(r => [r.name, Array(nWeeks).fill(null)]));
  for (let j = 0; j < nWeeks; j++) {
    const wk = rows.filter(r => cellVal(r.cells[j]) !== null)
      .sort((a, b) => cellVal(b.cells[j]) - cellVal(a.cells[j]));
    wk.forEach((r, i) => { rankAt.get(r.name)[j] = { rank: i + 1, of: wk.length }; });
  }

  // svg 骨架持久化:同一骨架下切換排序週,列的位移才做得了 transition;
  // 版面參數變了(改觀察期間、列數增減、視窗寬度變)才整棵重建
  const sig = `${width}|${nWeeks}|${rows.length}`;
  let svg = d3.select(container).select('svg.hm-svg');
  if (svg.empty() || svg.attr('data-sig') !== sig) {
    svg = d3.create('svg').attr('class', 'hm-svg').attr('data-sig', sig);
    const pat = svg.append('defs').append('pattern')
      .attr('id', patId).attr('width', 6).attr('height', 6)
      .attr('patternUnits', 'userSpaceOnUse').attr('patternTransform', 'rotate(45)');
    pat.append('rect').attr('width', 6).attr('height', 6);
    pat.append('line').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 6)
      .attr('stroke-width', 1.4).attr('opacity', 0.6);
    svg.append('g').attr('class', 'hm-cols');
    svg.append('g').attr('class', 'hm-rows');
    // 名次疊加線的畫布:最上層、不吃滑鼠事件(格子的 tooltip/點擊照常)
    svg.append('g').attr('class', 'hm-overlay').attr('pointer-events', 'none');
    container.replaceChildren(svg.node());
  }
  svg.attr('viewBox', `0 0 ${width} ${height}`).attr('role', 'img');
  svg.select('g.hm-overlay').selectAll('*').remove();   // 重繪時清掉殘留的疊加線
  // 格紋顏色每次同步(跟著深淺色主題)
  svg.select(`#${patId} rect`).attr('fill', surface);
  svg.select(`#${patId} line`).attr('stroke', cMuted);

  const sortIdx = nWeeks - 1 - sortAgo;
  // 點已選中的欄 → 回到預設「本週」
  const clickSort = (ago) => { hideTooltip(); onSortAgo(ago === sortAgo ? 0 : ago); };

  // 欄標(週)與整欄點擊目標:每次重建(選中欄樣式、標籤密度會變)
  // 格子太窄時隔一格標一次;「本週」與選中欄永遠標
  const cols = svg.select('g.hm-cols');
  cols.selectAll('*').remove();
  const labelEvery = cellW >= 34 ? 1 : 2;
  for (let j = 0; j < nWeeks; j++) {
    const ago = nWeeks - 1 - j;
    const isSel = j === sortIdx;
    const isLast = j === nWeeks - 1;
    if (isLast || isSel || ago % labelEvery === 0) {
      cols.append('text')
        .attr('class', 'hm-colhead')
        .attr('x', colX(j) + cellW / 2)
        .attr('y', headerH - 8)
        .attr('text-anchor', 'middle')
        .attr('font-size', 11)
        .attr('font-weight', isSel ? 800 : 400)  // 粗體跟著選中欄(預設=本週)
        .attr('fill', isSel ? cText : cMuted)
        .attr('pointer-events', 'none')
        .text(colLabel(j, nWeeks, daily, rows[0].cells[j].to));
    }
    if (isSel) {
      // 選中欄:標籤底線 + 整欄圓角外框(粗墨框語彙)
      cols.append('rect')
        .attr('x', colX(j) + cellW / 2 - 14).attr('y', headerH - 5)
        .attr('width', 28).attr('height', 3).attr('rx', 1.5)
        .attr('fill', ink).attr('pointer-events', 'none');
      cols.append('rect')
        .attr('x', colX(j) - 2).attr('y', headerH - 2)
        .attr('width', Math.max(2, cellW) + 4)
        .attr('height', (rows.length - 1) * rowH + cellH + 4)
        .attr('rx', 7).attr('fill', 'none')
        .attr('stroke', ink).attr('stroke-width', 2)
        .attr('pointer-events', 'none');
    }
    // 欄標列的點擊區(窄格沒文字標籤的欄也點得到)
    const span = rows[0].cells[j];
    cols.append('rect')
      .attr('x', colX(j)).attr('y', 0)
      .attr('width', Math.max(2, cellW) + gap).attr('height', headerH)
      .attr('fill', 'transparent').attr('cursor', 'pointer')
      .on('mouseenter mousemove', (ev) => {
        showTooltip([
          { text: `${colLabel(j, nWeeks, daily, span.to)}(${span.from} → ${span.to})`, cls: 'tt-label' },
          { text: isSel && !isLast ? `點擊:回到依${daily ? '今天' : '本週'}排序` : `點擊:依此${colWord}排序`, cls: 'tt-label' },
        ], ev.clientX, ev.clientY);
      })
      .on('mouseleave', hideTooltip)
      .on('click', () => clickSort(ago));
  }
  // 右欄數字的小字頭:標明顯示的是選中週的漲跌(pct 模式=%、z 模式=σ)
  cols.append('text')
    .attr('x', colX(nWeeks) + 8)
    .attr('y', headerH - 8)
    .attr('font-size', 10)
    .attr('fill', cMuted)
    .text(`${colLabel(sortIdx, nWeeks, daily, rows[0].cells[sortIdx].to)} ${useZ ? 'σ' : '%'}`);

  // 列:keyed join——排序切換時列的 y 位移做 transition,列內容(顏色、數字、tooltip)每次重建
  const rowY = new Map(rows.map((r, i) => [r.name, headerH + i * rowH]));
  const rowSel = svg.select('g.hm-rows').selectAll('g.hm-row')
    .data(rows, d => d.name);
  rowSel.exit().remove();
  const rowEnter = rowSel.enter().append('g').attr('class', 'hm-row')
    .attr('transform', d => `translate(0,${rowY.get(d.name)})`);  // 新列直接落定,不動畫
  rowSel.transition().duration(500).ease(d3.easeCubicInOut)
    .attr('transform', d => `translate(0,${rowY.get(d.name)})`);

  // hover 列 → 疊加該項的名次軌跡線(輪動圖合併進熱力圖):
  // x=各週欄中心、y=該週名次對應的列位;其餘列淡出讓格網退成背景。
  // 白色 casing 讓墨線壓在任何 diverging 格色上都讀得到;節點色=該週幅度(同一套色階)
  const overlay = svg.select('g.hm-overlay');
  const rankLine = d3.line()
    .defined(p => p !== null)
    .x(p => colX(p.j) + Math.max(2, cellW) / 2)
    .y(p => headerH + (p.rank - 1) * rowH + cellH / 2)
    .curve(d3.curveBumpX);   // 名次間的平滑水平過渡,輪動圖的標準曲線
  const clearRankLine = () => {
    overlay.selectAll('*').remove();
    svg.selectAll('g.hm-row').attr('opacity', 1);
  };
  const showRankLine = (row) => {
    clearRankLine();
    const pts = rankAt.get(row.name).map((rk, j) =>
      rk ? { j, rank: rk.rank, v: cellVal(row.cells[j]) } : null);
    if (!pts.some(Boolean)) return;
    svg.selectAll('g.hm-row').attr('opacity', d => d.name === row.name ? 1 : 0.25);
    overlay.append('path')
      .attr('d', rankLine(pts))
      .attr('fill', 'none').attr('stroke', surface).attr('stroke-width', 7);
    overlay.append('path')
      .attr('d', rankLine(pts))
      .attr('fill', 'none').attr('stroke', ink).attr('stroke-width', 2.5);
    for (const p of pts) {
      if (!p) continue;
      overlay.append('circle')
        .attr('cx', colX(p.j) + Math.max(2, cellW) / 2)
        .attr('cy', headerH + (p.rank - 1) * rowH + cellH / 2)
        .attr('r', 4.5)
        .attr('fill', color(p.v)).attr('stroke', ink).attr('stroke-width', 1.4);
    }
  };

  rowEnter.merge(rowSel).each(function (row) {
    const g = d3.select(this);
    g.selectAll('*').remove();
    g.attr('opacity', 1)   // 洗掉上一輪 hover 殘留的淡出狀態(g 跨 render 存活)
      .on('mouseenter', () => showRankLine(row))
      .on('mouseleave', clearRankLine);
    g.append('text')
      .attr('x', labelW - 10)
      .attr('y', cellH / 2 + 4)
      .attr('text-anchor', 'end')
      .attr('font-size', 12.5)
      .attr('fill', cSub)
      .text(row.name);

    row.cells.forEach((cell, j) => {
      const v = cellVal(cell);
      const isLatest = j === nWeeks - 1;
      const rect = g.append('rect')
        .attr('x', colX(j))
        .attr('y', 0)
        .attr('width', Math.max(2, cellW))
        .attr('height', cellH)
        .attr('rx', 5)
        .attr('fill', v === null ? `url(#${patId})` : color(v))
        .attr('stroke', ink)
        .attr('stroke-width', 1.4)
        .attr('cursor', 'pointer');
      // 量比是「今日」的即時值,只標在本週格;tooltip 一律顯示數字避免誤讀
      const volLines = (isLatest && 'relVol' in row) ? [{
        text: Number.isFinite(row.relVol)
          ? `今日量比 ${row.relVol.toFixed(2)}${row.relVol >= REL_VOL_HIGH ? '(放量)' : ''}`
          : '今日量比 —(此標的無量能資料)',
        cls: 'tt-label',
      }] : [];
      // 該週名次(疊加線的 y 語意):tooltip 一律標示,不只在 hover 疊加時
      const rk = rankAt.get(row.name)[j];
      rect.on('mouseenter mousemove', (ev) => {
        showTooltip([
          { text: `${row.name} · ${colLabel(j, nWeeks, daily, cell.to)}`, cls: 'tt-label' },
          { text: `${cell.from} → ${cell.to}` , cls: 'tt-label' },
          { text: cell.pct === null ? (daily ? '—(休市或資料累積中)' : '—(資料累積中)')
            : useZ ? `${fmtPct(cell.pct)}(${fmtZ(cell.z)})` : fmtPct(cell.pct), cls: 'tt-value' },
          ...(rk ? [{ text: `該${colWord}第 ${rk.rank} 名(共 ${rk.of} 項)`, cls: 'tt-label' }] : []),
          ...volLines,
          { text: `點擊:依此${colWord}排序`, cls: 'tt-label' },
        ], ev.clientX, ev.clientY);
      }).on('mouseleave', hideTooltip)
        .on('click', () => clickSort(nWeeks - 1 - j));
      // 放量標記:本週格右上角小圓點(白底墨框,任何格色上都讀得到)
      if (isLatest && Number.isFinite(row.relVol) && row.relVol >= REL_VOL_HIGH) {
        g.append('circle')
          .attr('cx', colX(j) + Math.max(2, cellW) - 7)
          .attr('cy', 7)
          .attr('r', 3.2)
          .attr('fill', surface)
          .attr('stroke', ink)
          .attr('stroke-width', 1.4)
          .attr('pointer-events', 'none');
      }
    });

    // 最右:選中週的數字(pct 模式=漲跌 %、z 模式=σ)
    g.append('text')
      .attr('x', colX(nWeeks) + 8)
      .attr('y', cellH / 2 + 4)
      .attr('font-size', 12.5)
      .attr('font-weight', 700)
      .attr('fill', row.sortVal === null ? cMuted : cText)
      .attr('font-variant-numeric', 'tabular-nums')
      .text(row.sortVal === null ? '—' : useZ ? fmtZ(row.sortVal) : fmtPct(row.sortVal));
  });

  // 圖例:漸層色帶 + 累積中格紋
  const legend = $(legendSel);
  const lw = 170, lh = 14;
  const lsvg = d3.create('svg').attr('width', lw).attr('height', lh).attr('viewBox', `0 0 ${lw} ${lh}`);
  const gradId = `${patId}-grad`;
  const grad = lsvg.append('defs').append('linearGradient').attr('id', gradId);
  [[0, -maxAbs], [0.5, 0], [1, maxAbs]].forEach(([o, v]) =>
    grad.append('stop').attr('offset', `${o * 100}%`).attr('stop-color', color(v)));
  lsvg.append('rect').attr('x', 1).attr('y', 1).attr('width', lw - 2).attr('height', lh - 2)
    .attr('rx', 4).attr('fill', `url(#${gradId})`).attr('stroke', ink).attr('stroke-width', 1.4);
  const swatch = d3.create('svg').attr('width', 18).attr('height', 14);
  swatch.append('defs').append('pattern')
    .attr('id', `${patId}-leg`).attr('width', 6).attr('height', 6)
    .attr('patternUnits', 'userSpaceOnUse').attr('patternTransform', 'rotate(45)')
    .call(g => {
      g.append('rect').attr('width', 6).attr('height', 6).attr('fill', surface);
      g.append('line').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 6)
        .attr('stroke', cMuted).attr('stroke-width', 1.4).attr('opacity', 0.6);
    });
  swatch.append('rect').attr('x', 1).attr('y', 1).attr('width', 16).attr('height', 12)
    .attr('rx', 4).attr('fill', `url(#${patId}-leg)`).attr('stroke', ink).attr('stroke-width', 1.4);

  const legendParts = [
    el('span', '', useZ ? `−${maxAbs}σ(異常流出)` : `${fmtPct(-maxAbs, 1)}(流出)`),
    lsvg.node(),
    el('span', '', useZ ? `+${maxAbs}σ(異常流入)` : `${fmtPct(maxAbs, 1)}(流入)`),
    swatch.node(),
    el('span', '', daily ? '休市或資料累積中' : '資料累積中'),
  ];
  if (hasVol) {
    // 放量標記的圖例:一個色格 + 右上角小圓點,與熱力圖上的樣子一致
    const volSwatch = d3.create('svg').attr('width', 18).attr('height', 14);
    volSwatch.append('rect').attr('x', 1).attr('y', 1).attr('width', 16).attr('height', 12)
      .attr('rx', 4).attr('fill', color(maxAbs / 2)).attr('stroke', ink).attr('stroke-width', 1.4);
    volSwatch.append('circle').attr('cx', 12).attr('cy', 5).attr('r', 2.6)
      .attr('fill', surface).attr('stroke', ink).attr('stroke-width', 1.2);
    legendParts.push(volSwatch.node(), el('span', '', `今日放量(量比 ≥${REL_VOL_HIGH})`));
  }
  legend.replaceChildren(...legendParts);
}

// 表格檢視(熱力圖的無障礙等價版本)
function renderFlowTable(sel, rows, nWeeks, headLabel, withSrc, daily = false) {
  const wrap = $(sel);
  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  hr.appendChild(el('th', '', headLabel));
  for (let j = 0; j < nWeeks; j++) hr.appendChild(el('th', '', colLabel(j, nWeeks, daily, rows[0]?.cells[j]?.to)));
  hr.appendChild(el('th', '', '資金動向'));
  if (withSrc) hr.appendChild(el('th', '', '資料源'));
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const row of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', '', row.name));
    row.cells.forEach(cell => {
      const cls = cell.pct === null ? 'num na' : cell.pct > 0 ? 'num up' : cell.pct < 0 ? 'num down' : 'num';
      tr.appendChild(el('td', cls, cell.pct === null ? '—' : fmtPct(cell.pct)));
    });
    const prev = row.cells[row.cells.length - 2]?.pct ?? null;
    tr.appendChild(el('td', '', flowVerdict(row.latest, prev, daily ? '今日' : '本週')));
    if (withSrc) tr.appendChild(el('td', '', row.src));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.replaceChildren(table);
}

// 卡內摘要:最新一欄方向翻轉的列(由流出轉流入/由流入轉流出)——翻轉比持續更值得注意
// unit = 最新一欄的稱呼(週模式「本週」、逐日模式「今日」)
function flipSummary(rows, unit = '本週') {
  const toIn = [], toOut = [];
  for (const r of rows) {
    const prev = r.cells[r.cells.length - 2]?.pct ?? null;
    const v = flowVerdict(r.latest, prev);
    if (v === '由流出轉流入') toIn.push(r.name);
    if (v === '由流入轉流出') toOut.push(r.name);
  }
  const cap = (arr) => arr.length > 4 ? `${arr.slice(0, 4).join('、')} 等 ${arr.length} 項` : arr.join('、');
  let s = '';
  if (toIn.length) s += `${unit}轉為流入:${cap(toIn)}。`;
  if (toOut.length) s += `${unit}轉為流出:${cap(toOut)}。`;
  return s;
}

// 卡內摘要:最新一欄錢停在哪、從哪撤出(呼叫端須傳入「按最新欄漲幅排序」的列,不可餵其他排序)
function flowSummary(rows, inText, outText, emptyText = '本週各項變動有限,資金呈觀望。') {
  const inflow = rows.filter(r => r.latest !== null && r.latest > 0.3).slice(0, 3).map(r => r.name);
  const outflow = rows.filter(r => r.latest !== null && r.latest < -0.3).slice(-3).map(r => r.name);
  let s = '';
  if (inflow.length) s += `${inText}:${inflow.join('、')}。`;
  if (outflow.length) s += `${outText}:${outflow.join('、')}。`;
  return s || emptyText;
}

// ===== 兩張流向卡 =====

// 布蘭特 − WTI 價差:反映地緣/運輸溢酬,差距走闊常見於供給面緊張
function oilSpreadText() {
  const wti = state.scanner?.['NYMEX:CL1!'];
  const brent = state.scanner?.['ICEEUR:BRN1!'];
  if (!Number.isFinite(wti?.close) || !Number.isFinite(brent?.close)) return '';
  const spread = brent.close - wti.close;
  return `布蘭特 $${brent.close.toFixed(2)} − WTI $${wti.close.toFixed(2)},價差 $${spread.toFixed(2)}。`;
}

// 銅金比:銅=實體增長需求、金=避險;比值升 = 增長預期壓過避險(經典 risk-on 領先訊號)
function copperGoldText() {
  const cu = state.scanner?.['OANDA:XCUUSD'];
  const au = state.scanner?.[GOLD_SYM];
  if (!Number.isFinite(cu?.perfW) || !Number.isFinite(au?.perfW)) return '';
  const dW = ((1 + cu.perfW / 100) / (1 + au.perfW / 100) - 1) * 100;
  const verdict = dW > 0.5 ? '增長預期壓過避險(偏 risk-on)'
    : dW < -0.5 ? '避險需求壓過增長(偏 risk-off)' : '增長與避險大致平衡';
  return `銅金比本週 ${fmtPct(dW)},${verdict}。`;
}

function renderAssetCard() {
  // 觀察期間 1 週 = 逐日模式:欄=近 7 天的每日漲跌;其餘為每週漲跌
  const daily = ui.assetWeeks === 1;
  const nCols = daily ? 7 : ui.assetWeeks;
  const rows = assetRows(nCols, daily);
  if (!rows.length) return;
  // 摘要固定用「最新一欄」語意(用按最新欄排序的複本算),不隨排序欄改變
  const byLatest = [...rows].sort((a, b) => (b.latest ?? -Infinity) - (a.latest ?? -Infinity));
  setRead($('#asset-summary'), daily ? '今日流向' : '本週流向', [
    daily
      ? flowSummary(byLatest, '今日資金停泊處', '今日撤出', '今日各項變動有限,資金呈觀望。')
      : flowSummary(byLatest, '本週資金停泊處', '本週撤出'),
    flipSummary(rows, daily ? '今日' : '本週'),
    copperGoldText(),
  ], oilSpreadText());
  if (ui.assetSortAgo > nCols - 1) ui.assetSortAgo = 0;  // 切短觀察期間時,超出範圍的排序欄回到最新
  const useZ = ui.assetScale === 'z';
  const sorted = sortRowsByWeek(rows, nCols, ui.assetSortAgo, useZ);
  if (ui.assetView === 'chart') {
    renderHeatmap('#asset-heatmap', '#asset-legend', sorted, nCols, 'hatch-asset',
      ui.assetSortAgo, (k) => { ui.assetSortAgo = k; renderAssetCard(); }, useZ, daily);
  } else {
    renderFlowTable('#asset-table', sorted, nCols, '資產', true, daily);
  }
}

function renderRegionCard() {
  const daily = ui.regionWeeks === 1;
  const nCols = daily ? 7 : ui.regionWeeks;
  const rows = regionRows(nCols, daily);
  if (!rows.length) return;
  const byLatest = [...rows].sort((a, b) => (b.latest ?? -Infinity) - (a.latest ?? -Infinity));
  setRead($('#region-summary'), daily ? '今日流向' : '本週流向', [
    daily
      ? flowSummary(byLatest, '今日資金傾向流入', '傾向流出', '今日各項變動有限,資金呈觀望。')
      : flowSummary(byLatest, '近一週資金傾向流入', '傾向流出'),
    flipSummary(rows, daily ? '今日' : '本週'),
  ]);
  if (ui.regionSortAgo > nCols - 1) ui.regionSortAgo = 0;
  const useZ = ui.regionScale === 'z';
  const sorted = sortRowsByWeek(rows, nCols, ui.regionSortAgo, useZ);
  if (ui.regionView === 'chart') {
    renderHeatmap('#region-heatmap', '#region-legend', sorted, nCols, 'hatch-region',
      ui.regionSortAgo, (k) => { ui.regionSortAgo = k; renderRegionCard(); }, useZ, daily);
  } else {
    renderFlowTable('#region-table', sorted, nCols, '區域', false, daily);
  }
}

// ===== 股債趨勢卡(美債殖利率曲線 + VIX)=====

// 由 scanner 報價整理三個天期的「今天 / 一週前 / 一月前」殖利率
function bondPoints() {
  if (!state.scanner) return null;
  const out = [];
  for (const t of BOND_TENORS) {
    const q = state.scanner[t.sym];
    if (!q || !Number.isFinite(q.close)) return null;   // 三檔都要有才畫
    const wAgo = Number.isFinite(q.perfW) ? q.close / (1 + q.perfW / 100) : null;
    const mAgo = Number.isFinite(q.perf1M) ? q.close / (1 + q.perf1M / 100) : null;
    out.push({
      ...t,
      now: q.close,
      wAgo, mAgo,
      dwBp: wAgo !== null ? (q.close - wAgo) * 100 : null,   // 週變化,基點
    });
  }
  return out;
}

// VIX 現值與週變化(點數;wAgo 由 Perf.W 反推)
function vixPoint() {
  const q = state.scanner?.[VIX_SYM];
  if (!q || !Number.isFinite(q.close)) return null;
  const wAgo = Number.isFinite(q.perfW) ? q.close / (1 + q.perfW / 100) : null;
  return { now: q.close, dW: wAgo !== null ? q.close - wAgo : null };
}

// 美日 10 年利差(百分點):日圓套利交易的引擎;收窄 = 平倉壓力(risk-off 前哨)
function usJpSpread() {
  const us = state.scanner?.['TVC:US10Y'];
  const jp = state.scanner?.[JP10Y_SYM];
  if (!Number.isFinite(us?.close) || !Number.isFinite(jp?.close)) return null;
  const now = us.close - jp.close;
  const dW = (Number.isFinite(us.perfW) && Number.isFinite(jp.perfW))
    ? now - (us.close / (1 + us.perfW / 100) - jp.close / (1 + jp.perfW / 100))
    : null;   // 一週前利差由兩檔的 Perf.W 反推
  return { now, dW };
}

// 美日利差的跨日累積序列(兩檔同日都有紀錄才算得出來;啟用初期只有少數點)
function usJpSpreadSeries() {
  const jp = new Map(scannerSeries(JP10Y_SYM).map(p => [p.date, p.value]));
  return scannerSeries('TVC:US10Y')
    .flatMap(p => jp.has(p.date) ? [{ date: p.date, value: p.value - jp.get(p.date) }] : []);
}

function renderBondChart(data) {
  const container = $('#bond-chart');
  const width = Math.max(300, container.clientWidth || 520);
  const height = 268;
  const m = { top: 16, right: 92, bottom: 30, left: 46 };

  const ink = cssVar('--ink');
  const cGrid = cssVar('--grid');
  const cSub = cssVar('--text-secondary');
  const cMuted = cssVar('--text-muted');
  const surface = cssVar('--surface-1');
  const seriesDefs = [
    { key: 'mAgo', label: '一月前', color: cssVar('--bond-month'), w: 2.25, dash: '6 5', r: 4 },
    { key: 'wAgo', label: '一週前', color: cssVar('--bond-week'),  w: 2.25, dash: null,  r: 4 },
    { key: 'now',  label: '今天',   color: cssVar('--bond-today'), w: 3.5,  dash: null,  r: 5 },
  ];

  const x = d3.scalePoint()
    .domain(BOND_TENORS.map(t => t.label))
    .range([m.left, width - m.right])
    .padding(0.35);

  const all = data.flatMap(d => [d.now, d.wAgo, d.mAgo]).filter(Number.isFinite);
  const pad = Math.max(0.06, (d3.max(all) - d3.min(all)) * 0.18);
  const y = d3.scaleLinear()
    .domain([d3.min(all) - pad, d3.max(all) + pad])
    .range([height - m.bottom, m.top])
    .nice();

  const svg = d3.create('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('role', 'img');

  // 退位的網格線與座標軸
  const ticks = y.ticks(5);
  for (const t of ticks) {
    svg.append('line')
      .attr('x1', m.left).attr('x2', width - m.right)
      .attr('y1', y(t)).attr('y2', y(t))
      .attr('stroke', cGrid).attr('stroke-width', 1);
    svg.append('text')
      .attr('x', m.left - 8).attr('y', y(t) + 4)
      .attr('text-anchor', 'end').attr('font-size', 11).attr('fill', cMuted)
      .text(`${t.toFixed(2)}%`);
  }
  for (const t of BOND_TENORS) {
    svg.append('text')
      .attr('x', x(t.label)).attr('y', height - 8)
      .attr('text-anchor', 'middle').attr('font-size', 12.5).attr('fill', cSub)
      .text(t.label);
  }

  const endLabels = [];
  for (const s of seriesDefs) {
    const pts = data.filter(d => Number.isFinite(d[s.key]));
    if (pts.length < 2) continue;
    const line = d3.line().x(d => x(d.label)).y(d => y(d[s.key]));
    const path = svg.append('path')
      .attr('d', line(pts))
      .attr('fill', 'none')
      .attr('stroke', s.color)
      .attr('stroke-width', s.w)
      .attr('stroke-linecap', 'round');
    if (s.dash) path.attr('stroke-dasharray', s.dash);

    for (const d of pts) {
      svg.append('circle')
        .attr('cx', x(d.label)).attr('cy', y(d[s.key])).attr('r', s.r)
        .attr('fill', s.color).attr('stroke', surface).attr('stroke-width', 2)
        .on('mouseenter mousemove', (ev) => {
          showTooltip([
            { text: `美債 ${d.label} · ${s.label}`, cls: 'tt-label' },
            { text: `${d[s.key].toFixed(3)}%`, cls: 'tt-value' },
          ], ev.clientX, ev.clientY);
        })
        .on('mouseleave', hideTooltip);
    }

    const lastPt = pts[pts.length - 1];
    endLabels.push({ y: y(lastPt[s.key]), color: s.color, label: s.label });
  }

  // 線尾直接標名(色塊 + 墨色文字,不讓文字本身穿系列色);
  // 線尾太近時往下推開,避免標籤重疊
  endLabels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < endLabels.length; i++) {
    if (endLabels[i].y - endLabels[i - 1].y < 16) endLabels[i].y = endLabels[i - 1].y + 16;
  }
  for (const lab of endLabels) {
    svg.append('rect')
      .attr('x', width - m.right + 10).attr('y', lab.y - 5)
      .attr('width', 10).attr('height', 10).attr('rx', 3)
      .attr('fill', lab.color).attr('stroke', ink).attr('stroke-width', 1.2);
    svg.append('text')
      .attr('x', width - m.right + 25).attr('y', lab.y + 4)
      .attr('font-size', 11.5).attr('fill', cSub)
      .text(lab.label);
  }

  container.replaceChildren(svg.node());
}

function renderBondStats(data) {
  const wrap = $('#bond-stats');
  const boxes = [];

  for (const d of data) {
    const box = el('div', 'bond-stat');
    box.appendChild(el('div', 'label', `美債 ${d.label}期殖利率`));
    box.appendChild(el('div', 'value', `${d.now.toFixed(2)}%`));
    const delta = el('div', 'delta');
    const cls = !Number.isFinite(d.dwBp) || Math.abs(d.dwBp) < 0.05 ? 'flat' : d.dwBp > 0 ? 'up' : 'down';
    delta.appendChild(el('span', cls, fmtBp(d.dwBp)));
    delta.appendChild(el('span', 'period', ' / 週'));
    box.appendChild(delta);
    boxes.push(box);
  }

  // 10Y − 2Y 利差
  const t2 = data.find(d => d.short === '2Y');
  const t10 = data.find(d => d.short === '10Y');
  if (t2 && t10) {
    const spreadBp = (t10.now - t2.now) * 100;
    const spreadWkBp = (Number.isFinite(t10.wAgo) && Number.isFinite(t2.wAgo))
      ? (t10.wAgo - t2.wAgo) * 100 : null;
    const dSpread = spreadWkBp !== null ? spreadBp - spreadWkBp : null;
    const box = el('div', `bond-stat${spreadBp < 0 ? ' inverted' : ''}`);
    box.appendChild(el('div', 'label', `10Y − 2Y 利差${spreadBp < 0 ? '(⚠ 倒掛)' : ''}`));
    box.appendChild(el('div', 'value', fmtBp(spreadBp, 0)));
    const delta = el('div', 'delta');
    const cls = !Number.isFinite(dSpread) || Math.abs(dSpread) < 0.05 ? 'flat' : dSpread > 0 ? 'up' : 'down';
    delta.appendChild(el('span', cls, dSpread === null ? '—' : `${fmtBp(dSpread)}`));
    delta.appendChild(el('span', 'period', ' / 週(正=變陡)'));
    box.appendChild(delta);
    boxes.push(box);
  }

  wrap.replaceChildren(...boxes);
}

// 牛陡/熊陡/牛平/熊平 + VIX 股市情緒 + 資金含義
function renderBondRead(data, vix) {
  const t2 = data.find(d => d.short === '2Y');
  const t10 = data.find(d => d.short === '10Y');
  const p = $('#bond-read');
  if (!t2 || !t10 || !Number.isFinite(t2.dwBp) || !Number.isFinite(t10.dwBp)) {
    p.textContent = '';
    return;
  }
  const d2 = t2.dwBp, d10 = t10.dwBp;
  const TH = 2;   // 基點門檻
  const steepening = d10 - d2 > 1.5;
  const flattening = d10 - d2 < -1.5;

  let tag, text;
  if (d10 > TH && steepening) {
    tag = '熊陡'; text = '長天期殖利率升得比短天期快:市場拋售長債(通膨或公債供給壓力),資金正離開債市。';
  } else if (d2 > TH && flattening) {
    tag = '熊平'; text = '短天期殖利率上升較快:升息(或延後降息)預期升溫,資金轉向短存續期與現金類資產。';
  } else if (d10 < -TH && flattening) {
    tag = '牛平'; text = '資金湧入長債、壓低長天期殖利率:避險需求升溫,市場對增長轉趨保守。';
  } else if (d2 < -TH && steepening) {
    tag = '牛陡'; text = '短天期殖利率下降較快:降息預期升溫,資金先卡位短債。';
  } else if (d10 > TH || d2 > TH) {
    tag = '殖利率上行'; text = '長短天期殖利率同步走升,資金溫和流出債市(偏風險偏好或通膨擔憂)。';
  } else if (d10 < -TH || d2 < -TH) {
    tag = '殖利率下行'; text = '長短天期殖利率同步走低,資金溫和流入債市(偏避險)。';
  } else {
    tag = '持平'; text = '本週長短天期殖利率變動有限,債市資金流向中性。';
  }

  const spreadBp = (t10.now - t2.now) * 100;
  let spreadText;
  if (spreadBp < 0) {
    spreadText = `目前 10Y−2Y 利差 ${fmtBp(spreadBp, 0)},殖利率曲線倒掛——歷史上常出現在衰退之前,資金以防禦為主。`;
  } else {
    spreadText = `目前 10Y−2Y 利差 ${fmtBp(spreadBp, 0)},曲線為正斜率。`;
  }

  // 股市端:VIX 水位 + 與債市方向合讀
  let vixText = '';
  if (vix && Number.isFinite(vix.dW)) {
    const level = vix.now >= 30 ? 'VIX 高於 30,市場處於恐慌'
      : vix.now >= 20 ? 'VIX 高於 20,股市避險情緒升溫'
      : vix.now >= 15 ? 'VIX 在正常區間,股市情緒平穩'
      : 'VIX 低於 15,股市情緒偏樂觀';
    let combo = '';
    if (vix.dW > 1 && d10 < -TH) combo = '——與資金湧入長債同向,股債同步發出避險訊號';
    else if (vix.dW < -1 && d10 > TH) combo = '——與殖利率走升同向,整體偏風險偏好';
    vixText = `股市端:${level}(週${vix.dW > 0 ? '+' : ''}${vix.dW.toFixed(1)} 點)${combo}。`;
  }

  setRead(p, tag, [
    text,
    el('span', spreadBp < 0 ? 'warn' : '', spreadText),
    vixText || null,
  ], '一週前與一月前為以 TradingView 表現欄位反推的估值。');
}

// 風險胃納合讀:套利端(美日利差)、信用端(HYG 相對 LQD)、股債比(SPX 相對 TLT)
function renderRiskRead() {
  const p = $('#risk-read');
  const parts = [];

  const sp = usJpSpread();
  if (sp) {
    const bp = Number.isFinite(sp.dW) ? sp.dW * 100 : null;
    const verdict = bp === null || Math.abs(bp) < 3 ? '變化有限'
      : bp > 0 ? '利差走闊,借日圓買美元資產的套利誘因升溫(偏 risk-on)'
      : '利差收窄,套利平倉壓力升溫——留意資金回流日圓引發的避險連鎖';
    parts.push(`套利端:美日 10 年利差 ${sp.now.toFixed(2)} 個百分點` +
      (bp === null ? '' : `(週${fmtBp(bp, 0)})`) + `,${verdict}。`);
  }

  const hyg = state.scanner?.[HYG_SYM], lqd = state.scanner?.[LQD_SYM];
  if (Number.isFinite(hyg?.perfW) && Number.isFinite(lqd?.perfW)) {
    const rel = hyg.perfW - lqd.perfW;
    const verdict = rel > 0.3 ? '高收益債相對強,信用市場的風險胃納偏強'
      : rel < -0.3 ? '高收益債相對弱,信用市場先行轉趨保守(常領先股市)'
      : '信用市場中性';
    parts.push(`信用端:高收益債(HYG)本週 ${fmtPct(hyg.perfW)}、相對投資級(LQD)` +
      `${rel > 0 ? '+' : ''}${rel.toFixed(1)} 個百分點,${verdict}。`);
  }

  const spx = state.scanner?.['SP:SPX'], tlt = state.scanner?.['NASDAQ:TLT'];
  if (Number.isFinite(spx?.perfW) && Number.isFinite(tlt?.perfW)) {
    const rel = spx.perfW - tlt.perfW;
    const verdict = rel > 0.5 ? '資金偏股(risk-on)' : rel < -0.5 ? '資金偏債(避險)' : '股債均衡';
    parts.push(`股債比:S&P 500 本週 ${fmtPct(spx.perfW)}、債市 TLT ${fmtPct(tlt.perfW)},${verdict}。`);
  }

  setRead(p, '風險胃納', parts);
}

function renderBondCard() {
  const data = bondPoints();
  if (data) {
    renderBondChart(data);
    renderBondStats(data);
    renderBondRead(data, vixPoint());
  }
  renderRiskRead();
  renderMacroTrends();
  renderMacroRead();
}

// ===== 迷你時間趨勢圖(VIX 與總經月資料共用)=====

// series: [{ date, value }] 升冪;def: { fmt, ref, refLabel }
function renderMiniTrend(container, def, series) {
  const width = Math.max(200, container.clientWidth || 240);
  const height = 92;
  const m = { top: 8, right: 12, bottom: 16, left: 38 };

  const ink = cssVar('--ink');
  const cGrid = cssVar('--grid');
  const cMuted = cssVar('--text-muted');
  const surface = cssVar('--surface-1');
  const accent = cssVar('--mem-yellow');

  const pts = series.map(p => ({ ...p, t: new Date(p.date).getTime() }));
  const x = d3.scaleTime()
    .domain(d3.extent(pts, p => p.t))
    .range([m.left, width - m.right]);

  const vals = pts.map(p => p.value);
  if (def.ref !== null) vals.push(def.ref);          // 參考線(2% 目標、零線)一定要在視野內
  const span = d3.max(vals) - d3.min(vals) || 1;
  const y = d3.scaleLinear()
    .domain([d3.min(vals) - span * 0.15, d3.max(vals) + span * 0.15])
    .range([height - m.bottom, m.top])
    .nice();

  const svg = d3.create('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('role', 'img');

  for (const t of y.ticks(3)) {
    svg.append('line')
      .attr('x1', m.left).attr('x2', width - m.right)
      .attr('y1', y(t)).attr('y2', y(t))
      .attr('stroke', cGrid).attr('stroke-width', 1);
    svg.append('text')
      .attr('x', m.left - 5).attr('y', y(t) + 3.5)
      .attr('text-anchor', 'end').attr('font-size', 10).attr('fill', cMuted)
      .text(def.fmt(t));
  }

  // 參考線(通膨 2% 目標 / 非農零線)
  if (def.ref !== null) {
    svg.append('line')
      .attr('x1', m.left).attr('x2', width - m.right)
      .attr('y1', y(def.ref)).attr('y2', y(def.ref))
      .attr('stroke', cMuted).attr('stroke-width', 1.5).attr('stroke-dasharray', '5 4');
    if (def.refLabel) {
      svg.append('text')
        .attr('x', width - m.right).attr('y', y(def.ref) - 4)
        .attr('text-anchor', 'end').attr('font-size', 9.5).attr('fill', cMuted)
        .text(def.refLabel);
    }
  }

  // 首尾日期標示(月資料顯示 YYYY-MM,日資料顯示 MM-DD)
  const [d0, d1] = [pts[0], pts[pts.length - 1]];
  for (const [p, anchor] of [[d0, 'start'], [d1, 'end']]) {
    svg.append('text')
      .attr('x', x(p.t)).attr('y', height - 4)
      .attr('text-anchor', anchor).attr('font-size', 9.5).attr('fill', cMuted)
      .text(p.date.length > 7 ? p.date.slice(5) : p.date.slice(0, 7));
  }

  const line = d3.line().x(p => x(p.t)).y(p => y(p.value));
  svg.append('path')
    .attr('d', line(pts))
    .attr('fill', 'none')
    .attr('stroke', ink)
    .attr('stroke-width', 2.5)
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round');

  pts.forEach((p, i) => {
    const last = i === pts.length - 1;
    svg.append('circle')
      .attr('cx', x(p.t)).attr('cy', y(p.value))
      .attr('r', last ? 4.5 : 2.6)
      .attr('fill', last ? accent : ink)
      .attr('stroke', last ? ink : surface)
      .attr('stroke-width', last ? 1.8 : 1.2)
      .on('mouseenter mousemove', (ev) => {
        showTooltip([
          { text: `${def.label} · ${p.date}`, cls: 'tt-label' },
          { text: def.fmt(p.value), cls: 'tt-value' },
        ], ev.clientX, ev.clientY);
      })
      .on('mouseleave', hideTooltip);
  });

  container.replaceChildren(svg.node());
}

// 五張迷你趨勢:VIX、美日 10 年利差(皆 scanner 跨日累積)+ 核心 PCE / 非農 / 失業率(月資料)
function macroTrendDefs() {
  const vix = scannerSeries(VIX_SYM);
  const defs = [];
  if (vix.length >= 2) {
    defs.push({
      key: 'vix', label: 'VIX 恐慌指數', series: vix,
      fmt: v => v.toFixed(1), deltaUnit: ' 點', ref: 20, refLabel: '20 警戒',
      note: vix.length < 6 ? '跨日累積中,趨勢點會逐日增加' : '',
    });
  }
  const usjp = usJpSpreadSeries();
  if (usjp.length >= 2) {
    defs.push({
      key: 'usjp', label: '美日 10 年利差(百分點)', series: usjp,
      fmt: v => v.toFixed(2), deltaUnit: ' 百分點', digits: 2, ref: null,
      note: usjp.length < 6 ? '跨日累積中,趨勢點會逐日增加' : '',
    });
  }
  if (state.macro) {
    const { pce, nfp, unrate } = state.macro;
    if (pce.length >= 2) defs.push({
      key: 'pce', label: '核心 PCE 年增率', series: pce,
      fmt: v => `${v.toFixed(1)}%`, deltaUnit: ' 百分點', digits: 2,
      ref: 2, refLabel: '聯準會 2% 目標',
    });
    if (nfp.length >= 2) defs.push({
      key: 'nfp', label: '非農新增就業(千人)', series: nfp,
      fmt: v => `${v > 0 ? '+' : ''}${Math.round(v)}`, deltaUnit: ' 千人', digits: 0,
      ref: 0, refLabel: '',
    });
    if (unrate.length >= 2) defs.push({
      key: 'unrate', label: '失業率', series: unrate,
      fmt: v => `${v.toFixed(1)}%`, deltaUnit: ' 百分點',
      ref: null,
    });
  }
  return defs;
}

function renderMacroTrends() {
  const grid = $('#macro-grid');
  const defs = macroTrendDefs();
  if (!defs.length) { grid.replaceChildren(); return; }

  const boxes = defs.map(def => {
    const box = el('div', 'macro-box');
    const head = el('div', 'macro-head');
    head.appendChild(el('span', 'label', def.label));
    const latest = def.series[def.series.length - 1];
    const prev = def.series[def.series.length - 2];
    head.appendChild(el('span', 'value', def.fmt(latest.value)));
    const d = latest.value - prev.value;
    const cls = Math.abs(d) < 0.005 ? 'flat' : d > 0 ? 'up' : 'down';
    const digits = def.digits ?? 1;
    head.appendChild(el('span', `delta ${cls}`,
      `${d > 0 ? '+' : ''}${d.toFixed(digits)}${def.deltaUnit}`));
    box.appendChild(head);
    const chart = el('div', 'macro-chart');
    box.appendChild(chart);
    if (def.note) box.appendChild(el('div', 'macro-note', def.note));
    return { box, chart, def };
  });
  grid.replaceChildren(...boxes.map(b => b.box));
  // 先掛進 DOM 再畫,才能量到實際容器寬度
  for (const b of boxes) renderMiniTrend(b.chart, b.def, b.def.series);
}

// 通膨 × 就業的聯準會處境判讀
function renderMacroRead() {
  const p = $('#macro-read');
  if (!state.macro) { p.textContent = ''; return; }
  const { pce, nfp, unrate } = state.macro;
  const pceNow = pce[pce.length - 1];
  const urNow = unrate[unrate.length - 1];
  const urPrev6 = unrate[unrate.length - 7] ?? unrate[0];
  const nfp3m = nfp.slice(-3).reduce((s, x) => s + x.value, 0) / Math.min(3, nfp.length);
  if (!pceNow || !urNow || !Number.isFinite(nfp3m)) { p.textContent = ''; return; }

  const inflHot = pceNow.value > 2.5;
  const inflNear = pceNow.value <= 2.5 && pceNow.value > 2.1;
  const jobsWeak = (urNow.value - urPrev6.value) >= 0.2 || nfp3m < 100;

  const inflText = inflHot ? `仍明顯高於聯準會 2% 目標`
    : inflNear ? `接近聯準會 2% 目標` : `已落在聯準會 2% 目標附近`;
  const jobsText = jobsWeak ? `就業市場降溫(失業率走高或非農轉弱)` : `就業市場仍具韌性`;

  let verdict;
  if (inflHot && !jobsWeak) verdict = '通膨未回目標而就業尚穩,聯準會傾向把利率維持在高檔更久。';
  else if (inflHot && jobsWeak) verdict = '通膨偏高但就業轉弱,聯準會陷入兩難,市場對政策路徑的分歧會加大波動。';
  else if (!inflHot && jobsWeak) verdict = '通膨降溫且就業轉弱,降息的空間與壓力同時上升,利多債市。';
  else verdict = '通膨受控且就業穩健,政策可保持耐心,市場主軸回到基本面。';

  setRead(p, '雙重使命', [
    `通膨端:核心 PCE 年增 ${pceNow.value.toFixed(1)}%(${pceNow.date}),${inflText}。`,
    `就業端:失業率 ${urNow.value.toFixed(1)}%、近三月非農平均月增 ${Math.round(nfp3m)} 千人,${jobsText}。`,
    verdict,
  ]);
}

// ===== 新台幣匯率卡 =====

function fmtTwdRate(v, digits) {
  return Number.isFinite(v) ? v.toFixed(digits) : '—';
}

// 即時交叉價:scanner(每 2 分鐘輪詢)的 USDTWD 配 USDJPY/EURUSD/USDCNY
// 推「1 單位外幣兌台幣」;任一報價缺就回 null,整卡退回 currency-api 日更值
function twdLiveRates() {
  const s = state.scanner;
  const c = (sym) => (s && Number.isFinite(s[sym]?.close) && s[sym].close > 0) ? s[sym].close : null;
  const twd = c(TWD_REGION.sym), jpy = c(USDJPY_SYM), eur = c(EURUSD_SYM), cny = c(CNY_SYM);
  if (!twd || !jpy || !eur || !cny) return null;
  return { usd: twd, jpy: twd / jpy, eur: twd * eur, cny: twd / cny };
}

// 折線點的時間:即時點帶 t(毫秒),歷史日更點只有日期字串
const twdPtMs = (p) => p.t ?? new Date(p.date).getTime();

// 每 5 秒隨機挑一個數字盒,讓它的數字與「即時」標籤呼吸一次
//(使用者指定:隨機單顆,不要四個一起呼吸)。動畫結束就移除 class,
// 下次再加才會重播;每次 tick 重查 DOM,所以重繪換新節點也不受影響
let twdBreatheTimer = null;

function startTwdBreathe() {
  if (twdBreatheTimer) return;
  twdBreatheTimer = setInterval(() => {
    const boxes = document.querySelectorAll('#twd-stats .twd-box');
    if (!boxes.length || !$('#twd-stats .live-tag')) return;   // 非即時模式不呼吸
    const box = boxes[Math.floor(Math.random() * boxes.length)];
    for (const sel of ['.value', '.live-tag']) {
      const n = box.querySelector(sel);
      if (!n) continue;
      n.classList.add('breathe-once');
      n.addEventListener('animationend', () => n.classList.remove('breathe-once'), { once: true });
    }
  }, 5000);
}

// 卡頭四個數字盒:1 單位外幣 = 多少台幣 + 一週變化(匯率升 = 台幣貶)
// 有 scanner 即時交叉價時優先顯示(標「即時」,隨機呼吸見 startTwdBreathe);
// 沒有才退回日更最新值
function renderTwdStats(series, live) {
  const grid = $('#twd-stats');
  const latest = series[series.length - 1];
  const latestMs = new Date(latest.date).getTime();
  const boxes = TWDFX_CURRENCIES.map((c) => {
    const cur = live ? live[c.code] : latest[c.code];
    const box = el('div', 'macro-box twd-box');
    const head = el('div', 'macro-head');
    const label = el('span', 'label');
    label.appendChild(el('span', 'twd-swatch'));
    label.lastChild.style.background = cssVar(c.color);
    label.appendChild(document.createTextNode(`1 ${c.name}`));
    if (live) label.appendChild(el('span', 'live-tag', '即時'));
    head.appendChild(label);
    head.appendChild(el('span', 'value', `${fmtTwdRate(cur, c.digits)} 台幣`));

    // 一週變化:匯率漲 = 要花更多台幣 = 台幣走貶
    const one = toSeries(series.map(p => p.date), series.map(p => p[c.code]));
    const wk = valueNear(one.slice(0, -1), latestMs - 7 * DAY_MS);
    if (wk) {
      const pct = pctChange(wk.value, cur);
      const cls = Math.abs(pct) < 0.05 ? 'flat' : pct > 0 ? 'up' : 'down';
      const word = Math.abs(pct) < 0.05 ? '台幣持平' : pct > 0 ? '台幣貶' : '台幣升';
      head.appendChild(el('span', `delta ${cls}`, `${fmtPct(pct)} /週(${word})`));
    }
    box.appendChild(head);
    return box;
  });
  grid.replaceChildren(...boxes);
  if (live) startTwdBreathe();
}

// 指數化多線圖:期初 = 100,線往上 = 要花更多台幣換 1 單位外幣 = 台幣走貶
function renderTwdChart(win) {
  const container = $('#twd-chart');
  const width = Math.max(320, container.clientWidth || 640);
  const height = 260;
  const m = { top: 16, right: 86, bottom: 26, left: 44 };

  const ink = cssVar('--ink');
  const cGrid = cssVar('--grid');
  const cMuted = cssVar('--text-muted');
  const cText = cssVar('--text-primary');
  const surface = cssVar('--surface-1');

  // 指數化:每條線以視窗第一點為 100
  const lines = TWDFX_CURRENCIES.map((c) => ({
    ...c,
    hex: cssVar(c.color),
    pts: win.map(p => ({
      date: p.date,
      t: twdPtMs(p),
      live: !!p.live,
      rate: p[c.code],
      idx: p[c.code] / win[0][c.code] * 100,
    })),
  }));

  const x = d3.scaleTime()
    .domain(d3.extent(win, p => twdPtMs(p)))
    .range([m.left, width - m.right]);
  const allIdx = lines.flatMap(l => l.pts.map(p => p.idx)).concat([100]);
  const span = d3.max(allIdx) - d3.min(allIdx) || 1;
  const y = d3.scaleLinear()
    .domain([d3.min(allIdx) - span * 0.12, d3.max(allIdx) + span * 0.12])
    .range([height - m.bottom, m.top])
    .nice();

  const svg = d3.create('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('role', 'img');

  for (const t of y.ticks(4)) {
    svg.append('line')
      .attr('x1', m.left).attr('x2', width - m.right)
      .attr('y1', y(t)).attr('y2', y(t))
      .attr('stroke', cGrid).attr('stroke-width', 1);
    svg.append('text')
      .attr('x', m.left - 6).attr('y', y(t) + 3.5)
      .attr('text-anchor', 'end').attr('font-size', 10.5).attr('fill', cMuted)
      .text(t.toFixed(1));
  }
  for (const t of x.ticks(5)) {
    svg.append('text')
      .attr('x', x(t)).attr('y', height - 8)
      .attr('text-anchor', 'middle').attr('font-size', 10.5).attr('fill', cMuted)
      .text(d3.timeFormat('%m-%d')(t));
  }

  // 期初 = 100 參考線
  svg.append('line')
    .attr('x1', m.left).attr('x2', width - m.right)
    .attr('y1', y(100)).attr('y2', y(100))
    .attr('stroke', cMuted).attr('stroke-width', 1.5).attr('stroke-dasharray', '5 4');
  svg.append('text')
    .attr('x', m.left + 2).attr('y', y(100) - 5)
    .attr('font-size', 9.5).attr('fill', cMuted)
    .text('期初 = 100');

  const lineGen = d3.line().x(p => x(p.t)).y(p => y(p.idx));
  for (const l of lines) {
    svg.append('path')
      .attr('d', lineGen(l.pts))
      .attr('fill', 'none')
      .attr('stroke', l.hex)
      .attr('stroke-width', 2.5)
      .attr('stroke-linecap', 'round')
      .attr('stroke-linejoin', 'round');
    for (const p of l.pts) {
      // 即時端點放大,與歷史日更點區分
      svg.append('circle')
        .attr('cx', x(p.t)).attr('cy', y(p.idx)).attr('r', p.live ? 4 : 2.6)
        .attr('fill', l.hex).attr('stroke', surface).attr('stroke-width', 1.2);
    }
  }

  // 線尾直接標籤(色點 + 墨色文字);縱向錯開避免重疊
  const ends = lines.map((l) => {
    const last = l.pts[l.pts.length - 1];
    return { l, ty: y(last.idx), cy: y(last.idx) };
  }).sort((a, b) => a.ty - b.ty);
  for (let i = 1; i < ends.length; i++) {
    if (ends[i].ty - ends[i - 1].ty < 14) ends[i].ty = ends[i - 1].ty + 14;
  }
  for (const e of ends) {
    svg.append('circle')
      .attr('cx', width - m.right + 10).attr('cy', e.ty)
      .attr('r', 4).attr('fill', e.l.hex).attr('stroke', ink).attr('stroke-width', 1.5);
    svg.append('text')
      .attr('x', width - m.right + 18).attr('y', e.ty + 3.5)
      .attr('font-size', 11).attr('font-weight', 700).attr('fill', cText)
      .text(e.l.name);
  }

  // hover 十字線:顯示該日四幣實際匯率與指數變化
  const hover = svg.append('g').style('display', 'none');
  hover.append('line')
    .attr('y1', m.top).attr('y2', height - m.bottom)
    .attr('stroke', cMuted).attr('stroke-width', 1).attr('stroke-dasharray', '3 3');
  svg.append('rect')
    .attr('x', m.left).attr('y', m.top)
    .attr('width', width - m.left - m.right).attr('height', height - m.top - m.bottom)
    .attr('fill', 'transparent')
    .on('mousemove', (ev) => {
      const [mx] = d3.pointer(ev);
      const tMs = x.invert(mx).getTime();
      let bi = 0, bd = Infinity;
      win.forEach((p, i) => {
        const d = Math.abs(twdPtMs(p) - tMs);
        if (d < bd) { bd = d; bi = i; }
      });
      const px = x(twdPtMs(win[bi]));
      hover.style('display', null).select('line').attr('x1', px).attr('x2', px);
      showTooltip([
        { text: win[bi].date, cls: 'tt-label' },
        ...lines.map(l => ({
          text: `${l.name} ${fmtTwdRate(l.pts[bi].rate, l.digits)} 台幣(${fmtPct(l.pts[bi].idx - 100)})`,
          cls: 'tt-value',
        })),
      ], ev.clientX, ev.clientY);
    })
    .on('mouseleave', () => { hover.style('display', 'none'); hideTooltip(); });

  container.replaceChildren(svg.node());
}

function renderTwdLegend() {
  const box = $('#twd-legend');
  box.replaceChildren(...TWDFX_CURRENCIES.map((c) => {
    const chip = el('span', 'twd-chip');
    const sw = el('span', 'twd-swatch');
    sw.style.background = cssVar(c.color);
    chip.appendChild(sw);
    chip.appendChild(document.createTextNode(c.name));
    return chip;
  }));
}

// 視窗首尾的台幣升貶判讀(對齊區域卡語彙:台幣貶 = 資金流出傾向)
function renderTwdRead(win, nWeeks) {
  const p = $('#twd-read');
  const first = win[0], last = win[win.length - 1];
  const moves = TWDFX_CURRENCIES.map((c) => ({
    name: c.name,
    pct: pctChange(first[c.code], last[c.code]),   // 匯率漲 = 台幣貶
  }));
  const parts = moves.map(mv =>
    `對${mv.name}${Math.abs(mv.pct) < 0.1 ? '持平' : mv.pct > 0 ? '貶值' : '升值'} ${Math.abs(mv.pct).toFixed(1)}%`);
  const nDep = moves.filter(mv => mv.pct > 0.1).length;
  const nApp = moves.filter(mv => mv.pct < -0.1).length;
  const verdict = nDep >= 3 ? '台幣全面走貶,熱錢流出台灣的傾向明顯。'
    : nApp >= 3 ? '台幣全面走升,資金流入台灣的傾向明顯。'
    : '台幣漲跌互見,主要反映各貨幣自身強弱,資金進出台灣的訊號不明顯。';
  setRead(p, `近 ${nWeeks} 週`, [
    `台幣${parts.join('、')}。`,
    verdict,
  ]);
}

function renderTwdCard() {
  const series = state.twdfx;
  if (!series || series.length < 2) return;   // 資料未到:保留前一次渲染
  const nWeeks = ui.twdWeeks;
  const latestMs = new Date(series[series.length - 1].date).getTime();
  const startMs = latestMs - nWeeks * 7 * DAY_MS - DAY_MS / 2;
  const win = series.filter(p => new Date(p.date).getTime() >= startMs);
  if (win.length < 2) return;

  // 折線延伸到當下:尾端補一個 scanner 即時交叉價的點(歷史日更點不動;
  // 兩來源差異 <0.3%,銜接平順)
  const live = twdLiveRates();
  const nowMs = Date.now();
  if (live && nowMs > new Date(win[win.length - 1].date).getTime()) {
    const hhmm = new Date(nowMs).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
    win.push({ date: `即時 ${hhmm}`, t: nowMs, live: true, ...live });
  }
  renderTwdStats(series, live);
  renderTwdChart(win);
  renderTwdLegend();
  renderTwdRead(win, nWeeks);
}

// ===== 台股外資買賣超卡 =====

function fmtNetBillions(v) {
  // 億元,千分位;帶 +/- 符號(不靠顏色單獨表意)
  return `${v > 0 ? '+' : ''}${Math.round(v).toLocaleString('zh-TW')} 億`;
}

// 卡頭三個數字盒:最新交易日、近 5 日累計、近 20 日累計
// (方向用文字「買超/賣超」標示,不用紅綠 —— 避免與圖上藍=流入/紅=流出的語彙打架)
function renderForeignStats(rows) {
  const grid = $('#foreign-stats');
  const latest = rows[rows.length - 1];
  const sum = (n) => rows.slice(-n).reduce((s, r) => s + r.net, 0);
  const items = [
    { label: `最新交易日(${latest.date.slice(5)})`, v: latest.net },
    { label: '近 5 個交易日累計', v: sum(5) },
    { label: `近 ${rows.length} 個交易日累計`, v: sum(rows.length) },
  ];
  grid.replaceChildren(...items.map(({ label, v }) => {
    const box = el('div', 'macro-box');
    const head = el('div', 'macro-head');
    head.appendChild(el('span', 'label', label));
    head.appendChild(el('span', 'value', fmtNetBillions(v)));
    head.appendChild(el('span', 'delta flat',
      Math.abs(v) < 1 ? '大致平衡' : v > 0 ? '買超(流入)' : '賣超(流出)'));
    box.appendChild(head);
    return box;
  }));
}

// 每日淨額長條圖(台股外資、中國兩融與南向共用):
// 藍=淨買入(流入)、紅=淨賣出(流出),與熱力圖同一組 diverging 資料色
// opts:{ unitLabel, tooltipText(r), height?, minAbs? }
function renderNetBarChart(containerSel, rows, opts) {
  const container = $(containerSel);
  const width = Math.max(280, container.clientWidth || 640);
  const height = opts.height ?? 190;
  const m = { top: 18, right: 12, bottom: 24, left: 56 };

  const ink = cssVar('--ink');
  const cGrid = cssVar('--grid');
  const cMuted = cssVar('--text-muted');
  const cText = cssVar('--text-primary');
  const cIn = cssVar('--series-in');
  const cOut = cssVar('--series-out');

  const x = d3.scaleBand()
    .domain(rows.map(r => r.date))
    .range([m.left, width - m.right])
    .paddingInner(0.3).paddingOuter(0.1);
  const maxAbs = Math.max(opts.minAbs ?? 50, d3.max(rows, r => Math.abs(r.net)));
  const y = d3.scaleLinear()
    .domain([-maxAbs * 1.15, maxAbs * 1.15])
    .range([height - m.bottom, m.top]);

  const svg = d3.create('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('role', 'img');

  for (const t of y.ticks(4)) {
    if (t === 0) continue;
    svg.append('line')
      .attr('x1', m.left).attr('x2', width - m.right)
      .attr('y1', y(t)).attr('y2', y(t))
      .attr('stroke', cGrid).attr('stroke-width', 1);
    svg.append('text')
      .attr('x', m.left - 6).attr('y', y(t) + 3.5)
      .attr('text-anchor', 'end').attr('font-size', 10).attr('fill', cMuted)
      .text(t.toLocaleString('zh-TW'));
  }
  svg.append('text')
    .attr('x', m.left - 6).attr('y', m.top - 6)
    .attr('text-anchor', 'end').attr('font-size', 9.5).attr('fill', cMuted)
    .text(opts.unitLabel ?? '億元');
  // 零線(基準線,比網格線重)
  svg.append('line')
    .attr('x1', m.left).attr('x2', width - m.right)
    .attr('y1', y(0)).attr('y2', y(0))
    .attr('stroke', ink).attr('stroke-width', 1.5);

  // 日期標籤:約五個,最後一天永遠標
  const every = Math.max(1, Math.ceil(rows.length / 5));
  rows.forEach((r, i) => {
    const isLast = i === rows.length - 1;
    if (!isLast && (i % every !== 0 || rows.length - 1 - i < every / 2)) return;
    svg.append('text')
      .attr('x', x(r.date) + x.bandwidth() / 2).attr('y', height - 6)
      .attr('text-anchor', 'middle').attr('font-size', 10).attr('fill', cMuted)
      .text(r.date.slice(5));
  });

  for (const r of rows) {
    const pos = r.net >= 0;
    svg.append('rect')
      .attr('x', x(r.date))
      .attr('y', pos ? y(r.net) : y(0))
      .attr('width', x.bandwidth())
      .attr('height', Math.max(1.5, Math.abs(y(r.net) - y(0))))
      .attr('rx', 2.5)
      .attr('fill', pos ? cIn : cOut)
      .attr('stroke', ink).attr('stroke-width', 1.2)
      .on('mouseenter mousemove', (ev) => {
        showTooltip([
          { text: r.date, cls: 'tt-label' },
          { text: opts.tooltipText(r), cls: 'tt-value' },
        ], ev.clientX, ev.clientY);
      })
      .on('mouseleave', hideTooltip);
  }

  // 只直接標最新一根(選擇性標示,不在每根上放數字)
  const last = rows[rows.length - 1];
  const ly = last.net >= 0
    ? Math.max(m.top - 6, y(last.net) - 5)
    : Math.min(height - m.bottom - 3, y(last.net) + 12);
  svg.append('text')
    .attr('x', x(last.date) + x.bandwidth() / 2).attr('y', ly)
    .attr('text-anchor', 'middle').attr('font-size', 10.5).attr('font-weight', 700)
    .attr('fill', cText)
    .text(fmtNetBillions(last.net).replace(' 億', ''));

  container.replaceChildren(svg.node());
}

// 台股外資每日買賣超長條
function renderForeignChart(rows) {
  renderNetBarChart('#foreign-chart', rows, {
    unitLabel: '億元',
    tooltipText: (r) => `外資${r.net >= 0 ? '買超' : '賣超'} ${Math.abs(r.net).toLocaleString('zh-TW', { maximumFractionDigits: 1 })} 億`,
  });
}

function renderForeignLegend() {
  const box = $('#foreign-legend');
  const mk = (color, text) => {
    const chip = el('span', 'twd-chip');
    const sw = el('span', 'twd-swatch');
    sw.style.background = color;
    chip.appendChild(sw);
    chip.appendChild(document.createTextNode(text));
    return chip;
  };
  box.replaceChildren(
    mk(cssVar('--series-in'), '買超=資金流入'),
    mk(cssVar('--series-out'), '賣超=資金流出'),
  );
}

// 外資動向判讀:連續同向天數 + 近 5 日累計,並與台幣一週升貶對照(雙重確認才算數)
function renderForeignRead(rows) {
  const p = $('#foreign-read');
  const sum5 = rows.slice(-5).reduce((s, r) => s + r.net, 0);
  const dir = Math.sign(rows[rows.length - 1].net);
  let streak = 0;
  for (let i = rows.length - 1; i >= 0 && dir !== 0 && Math.sign(rows[i].net) === dir; i--) streak++;

  // 台幣近一週對美元升貶(正 = 台幣貶;與台幣匯率卡同一份資料)
  let twdPct = null;
  if (state.twdfx && state.twdfx.length >= 2) {
    const s = state.twdfx;
    const latest = s[s.length - 1];
    const wk = valueNear(
      s.slice(0, -1).map(q => ({ date: q.date, value: q.usd })),
      new Date(latest.date).getTime() - 7 * DAY_MS);
    if (wk) twdPct = pctChange(wk.value, latest.usd);
  }

  const streakText = streak >= 3 ? `已連續 ${streak} 個交易日${dir > 0 ? '買超' : '賣超'};` : '';
  const sumText = `近 5 個交易日累計${sum5 >= 0 ? '買超' : '賣超'} ${Math.abs(Math.round(sum5)).toLocaleString('zh-TW')} 億`;

  let verdict;
  if (sum5 < -50 && twdPct !== null && twdPct > 0.1) {
    verdict = '外資賣超與台幣走貶同向——熱錢流出台灣的訊號獲得雙重確認。';
  } else if (sum5 > 50 && twdPct !== null && twdPct < -0.1) {
    verdict = '外資買超與台幣走升同向——資金流入台灣的訊號獲得雙重確認。';
  } else if (sum5 < -50 && twdPct !== null && twdPct < -0.1) {
    verdict = '外資賣超但台幣走升,兩個訊號分歧(可能有出口商拋匯或央行調節),先別急著下結論。';
  } else if (sum5 > 50 && twdPct !== null && twdPct > 0.1) {
    verdict = '外資買超但台幣走貶,兩個訊號分歧,資金面與匯率面暫時脫鉤。';
  } else {
    verdict = '外資進出與台幣波動都有限,資金面對台灣暫呈觀望。';
  }

  setRead(p, '外資動向', [
    `${streakText}${sumText}。`,
    verdict,
  ]);
}

function renderForeignCard() {
  const rows = state.foreign;
  if (!rows || !rows.length) return;   // 資料未到:保留前一次渲染
  renderForeignStats(rows);
  renderForeignChart(rows);
  renderForeignLegend();
  renderForeignRead(rows);
}

// ===== 中國資金流向卡 =====

// CNH−CNY 價差(%):正 = 離岸較弱 = 資金外流壓力;dW = 一週變化(由 Perf.W 反推)
function cnhCnySpread() {
  const h = state.scanner?.[CNH_SYM];
  const n = state.scanner?.[CNY_SYM];
  if (!Number.isFinite(h?.close) || !Number.isFinite(n?.close)) return null;
  const now = (h.close / n.close - 1) * 100;
  const dW = (Number.isFinite(h.perfW) && Number.isFinite(n.perfW))
    ? now - ((h.close / (1 + h.perfW / 100)) / (n.close / (1 + n.perfW / 100)) - 1) * 100
    : null;
  return { now, dW };
}

// 量比:當日累計量 ÷ 20 日均量(盤中按已開盤分鐘數比例折算,收盤後即全日對全日)
function etfVolumeRatio() {
  const etf = state.china.etf;
  const daily = state.china.etfDaily;
  if (!etf || !daily) return null;
  const past = daily.filter(d => d.date !== etf.date).slice(-20);
  if (past.length < 5) return null;
  const avg = past.reduce((s, d) => s + d.vol, 0) / past.length;
  const todayVol = etf.points.reduce((s, p) => s + p.vol, 0);
  const expected = avg * Math.min(1, etf.points.length / 241);   // 全天分時共 241 點
  return expected > 0 ? todayVol / expected : null;
}

// 卡頭四個數字盒:融資餘額、融資淨買入、南向淨買入、CNH−CNY 價差
//(方向用文字標示不用紅綠,與台股外資卡同一原則)
function renderChinaStats() {
  const grid = $('#china-stats');
  const boxes = [];
  const mkBox = (label, value, deltaText) => {
    const box = el('div', 'macro-box');
    const head = el('div', 'macro-head');
    head.appendChild(el('span', 'label', label));
    head.appendChild(el('span', 'value', value));
    head.appendChild(el('span', 'delta flat', deltaText));
    box.appendChild(head);
    return box;
  };

  const mg = state.china.margin;
  if (mg?.length) {
    const latest = mg[mg.length - 1];
    const prev = mg[mg.length - 2];
    const dBal = prev ? latest.balance - prev.balance : null;
    boxes.push(mkBox(`融資餘額(${latest.date.slice(5)})`,
      `${(latest.balance / 1e4).toFixed(2)} 兆元`,
      dBal === null ? '—'
        : `${fmtNetBillions(dBal)} /日(${Math.abs(dBal) < 10 ? '持平' : dBal > 0 ? '加槓桿' : '去槓桿'})`));
    const sum5 = mg.slice(-5).reduce((s, r) => s + r.net, 0);
    boxes.push(mkBox(`融資淨買入(${latest.date.slice(5)})`,
      fmtNetBillions(latest.net),
      `近 5 日累計 ${fmtNetBillions(sum5)}`));
  }

  const so = state.china.south;
  if (so?.length) {
    const latest = so[so.length - 1];
    const sum5 = so.slice(-5).reduce((s, r) => s + r.net, 0);
    boxes.push(mkBox(`南向淨買入(${latest.date.slice(5)})`,
      `${fmtNetBillions(latest.net)}港元`,
      `近 5 日累計 ${fmtNetBillions(sum5)}港元`));
  }

  const sp = cnhCnySpread();
  if (sp) {
    const word = sp.now > 0.15 ? '外流壓力' : sp.now < -0.15 ? '偏流入' : '壓力有限';
    boxes.push(mkBox('CNH−CNY 價差', fmtPct(sp.now, 2),
      sp.dW === null ? `離岸${word}`
        : `週${sp.dW > 0 ? '+' : ''}${sp.dW.toFixed(2)} 百分點(${word})`));
  }

  if (boxes.length) grid.replaceChildren(...boxes);
}

// 510300 分時價量圖:上=價格線(昨收虛線參考),下=量能長條;
// 放量分鐘(> 3 × 當日中位)染藍——大跌時放巨量拉回 = 疑似國家隊護盤
function renderChinaEtf() {
  const etf = state.china.etf;
  const container = $('#china-etf');
  const width = Math.max(320, container.clientWidth || 640);
  const height = 240;
  const m = { top: 20, right: 14, bottom: 22, left: 50 };
  const volH = 54;                                  // 量能區高度
  const priceB = height - m.bottom - volH - 10;     // 價格區底

  const ink = cssVar('--ink');
  const cGrid = cssVar('--grid');
  const cMuted = cssVar('--text-muted');
  const cText = cssVar('--text-primary');
  const cIn = cssVar('--series-in');

  const pts = etf.points;
  const x = d3.scaleLinear().domain([0, Math.max(240, pts.length - 1)]).range([m.left, width - m.right]);
  const prices = pts.map(p => p.price).concat([etf.preClose]).filter(Number.isFinite);
  const span = d3.max(prices) - d3.min(prices) || etf.preClose * 0.002 || 0.01;
  const y = d3.scaleLinear()
    .domain([d3.min(prices) - span * 0.12, d3.max(prices) + span * 0.12])
    .range([priceB, m.top]).nice();
  const maxVol = d3.max(pts, p => p.vol) || 1;
  const yv = d3.scaleLinear().domain([0, maxVol]).range([height - m.bottom, height - m.bottom - volH]);

  const svg = d3.create('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('role', 'img');

  // 價格區:退位網格 + 刻度
  for (const t of y.ticks(4)) {
    svg.append('line')
      .attr('x1', m.left).attr('x2', width - m.right)
      .attr('y1', y(t)).attr('y2', y(t))
      .attr('stroke', cGrid).attr('stroke-width', 1);
    svg.append('text')
      .attr('x', m.left - 6).attr('y', y(t) + 3.5)
      .attr('text-anchor', 'end').attr('font-size', 10).attr('fill', cMuted)
      .text(t.toFixed(3));
  }

  // 昨收虛線參考
  if (Number.isFinite(etf.preClose)) {
    svg.append('line')
      .attr('x1', m.left).attr('x2', width - m.right)
      .attr('y1', y(etf.preClose)).attr('y2', y(etf.preClose))
      .attr('stroke', cMuted).attr('stroke-width', 1.5).attr('stroke-dasharray', '5 4');
    svg.append('text')
      .attr('x', m.left + 2).attr('y', y(etf.preClose) - 4)
      .attr('font-size', 9.5).attr('fill', cMuted)
      .text(`昨收 ${etf.preClose.toFixed(3)}`);
  }

  // x 軸時間錨點(中午休市 11:30/13:00 相鄰,合標一次)
  const anchors = { '09:30': '09:30', '10:30': '10:30', '11:30': '11:30/13:00', '14:00': '14:00', '15:00': '15:00' };
  pts.forEach((p, i) => {
    const lab = anchors[p.time];
    if (!lab) return;
    svg.append('text')
      .attr('x', x(i)).attr('y', height - 6)
      .attr('text-anchor', i === 0 ? 'start' : 'middle')
      .attr('font-size', 10).attr('fill', cMuted)
      .text(lab);
  });

  // 量能長條:一般=中性灰,放量(> 3 × 當日中位)=藍
  const sortedVol = pts.map(p => p.vol).filter(v => v > 0).sort((a, b) => a - b);
  const medVol = sortedVol.length ? sortedVol[Math.floor(sortedVol.length / 2)] : 0;
  const isSpike = (v) => medVol > 0 && v > 3 * medVol;
  const bw = Math.max(1, (width - m.left - m.right) / Math.max(240, pts.length) - 0.5);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!(p.vol > 0)) continue;
    svg.append('rect')
      .attr('x', x(i) - bw / 2).attr('y', yv(p.vol))
      .attr('width', bw).attr('height', Math.max(0.5, yv(0) - yv(p.vol)))
      .attr('fill', isSpike(p.vol) ? cIn : cMuted)
      .attr('opacity', isSpike(p.vol) ? 1 : 0.55);
  }

  // 價格線(墨色,與迷你趨勢同語彙)
  const line = d3.line().x((p, i) => x(i)).y(p => y(p.price));
  svg.append('path')
    .attr('d', line(pts))
    .attr('fill', 'none')
    .attr('stroke', ink)
    .attr('stroke-width', 2.2)
    .attr('stroke-linecap', 'round')
    .attr('stroke-linejoin', 'round');

  // 右上角:日期 + 最新價與相對昨收
  const last = pts[pts.length - 1];
  const chg = Number.isFinite(etf.preClose) ? pctChange(etf.preClose, last.price) : null;
  svg.append('text')
    .attr('x', width - m.right).attr('y', m.top - 7)
    .attr('text-anchor', 'end').attr('font-size', 10.5).attr('font-weight', 700).attr('fill', cText)
    .text(`${etf.date} 最新 ${last.price.toFixed(3)}${chg === null ? '' : `(${fmtPct(chg)})`}`);

  // hover 十字線:時間 / 價 / 量
  const hover = svg.append('g').style('display', 'none');
  hover.append('line')
    .attr('y1', m.top).attr('y2', height - m.bottom)
    .attr('stroke', cMuted).attr('stroke-width', 1).attr('stroke-dasharray', '3 3');
  svg.append('rect')
    .attr('x', m.left).attr('y', m.top)
    .attr('width', width - m.left - m.right).attr('height', height - m.top - m.bottom)
    .attr('fill', 'transparent')
    .on('mousemove', (ev) => {
      const [mx] = d3.pointer(ev);
      const i = Math.max(0, Math.min(pts.length - 1, Math.round(x.invert(mx))));
      const p = pts[i];
      hover.style('display', null).select('line').attr('x1', x(i)).attr('x2', x(i));
      const pc = Number.isFinite(etf.preClose) ? `(較昨收 ${fmtPct(pctChange(etf.preClose, p.price))})` : '';
      showTooltip([
        { text: `${etf.date} ${p.time}`, cls: 'tt-label' },
        { text: `${p.price.toFixed(3)} ${pc}`, cls: 'tt-value' },
        { text: `量 ${(p.vol / 1e4).toFixed(1)} 萬手${isSpike(p.vol) ? '(異常放量)' : ''}`, cls: 'tt-value' },
      ], ev.clientX, ev.clientY);
    })
    .on('mouseleave', () => { hover.style('display', 'none'); hideTooltip(); });

  container.replaceChildren(svg.node());
}

function renderChinaEtfLegend() {
  const box = $('#china-etf-legend');
  const mk = (color, text) => {
    const chip = el('span', 'twd-chip');
    const sw = el('span', 'twd-swatch');
    sw.style.background = color;
    chip.appendChild(sw);
    chip.appendChild(document.createTextNode(text));
    return chip;
  };
  box.replaceChildren(
    mk(cssVar('--text-muted'), '一般量能'),
    mk(cssVar('--series-in'), '異常放量(> 3 倍當日中位)'),
  );
}

// 國家隊護盤判讀:大跌(盤中低點 ≤ −1%)+ 放量(量比 ≥ 1.8)+ 自低點拉回 ≥ 0.8%
function renderChinaEtfRead() {
  const p = $('#china-etf-read');
  const etf = state.china.etf;
  if (!etf || etf.points.length < 5) { p.textContent = ''; return; }
  const prices = etf.points.map(q => q.price);
  const last = prices[prices.length - 1];
  const low = d3.min(prices);
  const dipPct = Number.isFinite(etf.preClose) ? pctChange(etf.preClose, low) : null;
  const reboundPct = pctChange(low, last);
  const ratio = etfVolumeRatio();

  const nums = `盤中最低 ${dipPct === null ? '—' : fmtPct(dipPct)}、自低點回升 ${fmtPct(reboundPct)}` +
    (ratio === null ? '' : `、量比(相對 20 日均量)${ratio.toFixed(1)}`);
  let verdict;
  if (dipPct !== null && dipPct <= -1 && reboundPct >= 0.8 && ratio !== null && ratio >= 1.8) {
    verdict = '大跌中放出巨量並自低點明顯拉回——高機率是國家隊進場護盤。';
  } else if (dipPct !== null && dipPct <= -1 && ratio !== null && ratio >= 1.5) {
    verdict = '放量下跌、尚未見護盤式拉回,留意後續量價。';
  } else if (ratio !== null && ratio < 0.8) {
    verdict = '量能清淡,多空都不積極,無護盤跡象。';
  } else {
    verdict = '量能與走勢正常,無護盤跡象。';
  }
  setRead(p, '國家隊', [`${nums}。`, verdict]);
}

function renderChinaLegend() {
  const box = $('#china-legend');
  const mk = (color, text) => {
    const chip = el('span', 'twd-chip');
    const sw = el('span', 'twd-swatch');
    sw.style.background = color;
    chip.appendChild(sw);
    chip.appendChild(document.createTextNode(text));
    return chip;
  };
  box.replaceChildren(
    mk(cssVar('--series-in'), '淨買入=資金投入'),
    mk(cssVar('--series-out'), '淨賣出=資金撤出'),
  );
}

// 三路合讀:槓桿端(兩融)× 出海端(南向)× 匯率端(CNH−CNY)
function renderChinaRead() {
  const p = $('#china-read');
  const parts = [];
  const mg = state.china.margin;
  const so = state.china.south;
  let mgSum = null, soSum = null;

  if (mg && mg.length >= 5) {
    mgSum = mg.slice(-5).reduce((s, r) => s + r.net, 0);
    const v = mgSum > 150 ? '內資加槓桿進場,境內風險偏好升溫'
      : mgSum < -150 ? '內資去槓桿,境內風險偏好收縮' : '內資槓桿變動有限';
    parts.push(`槓桿端:融資近 5 日累計${mgSum >= 0 ? '淨買入' : '淨賣出'} ` +
      `${Math.abs(Math.round(mgSum)).toLocaleString('zh-TW')} 億元,${v}。`);
  }
  if (so && so.length >= 5) {
    soSum = so.slice(-5).reduce((s, r) => s + r.net, 0);
    const v = soSum > 200 ? '內地資金大舉南下買港股'
      : soSum < -200 ? '南向資金回流境內' : '南向進出有限';
    parts.push(`出海端:南向近 5 日累計${soSum >= 0 ? '淨買入' : '淨賣出'} ` +
      `${Math.abs(Math.round(soSum)).toLocaleString('zh-TW')} 億港元,${v}。`);
  }
  const sp = cnhCnySpread();
  if (sp) {
    const v = sp.now > 0.15 ? '離岸較在岸明顯偏貶,匯率端存在資金外流壓力'
      : sp.now < -0.15 ? '離岸較在岸偏升,外流壓力不明顯' : '離岸與在岸大致貼合,匯率端壓力有限';
    parts.push(`匯率端:CNH−CNY 價差 ${fmtPct(sp.now, 2)},${v}。`);
  }

  // 合讀:訊號同向才下結論
  let combo = '';
  if (soSum !== null && sp && soSum > 200 && sp.now > 0.15) {
    combo = ' 南向大買與離岸偏貶同向——中國資金外流的訊號獲得雙重確認。';
  } else if (mgSum !== null && mgSum > 150 && soSum !== null && Math.abs(soSum) <= 200) {
    combo = ' 內資加槓桿而南向平淡,資金的風險偏好留在境內市場。';
  } else if (mgSum !== null && mgSum < -150 && soSum !== null && soSum > 200) {
    combo = ' 境內去槓桿疊加資金南下,留意 A 股的資金面壓力。';
  }

  setRead(p, '三路合讀', [...parts, combo.trim()]);
}

function renderChinaCard() {
  const { margin, south, etf } = state.china;
  if (!margin?.length && !south?.length && !etf) return;   // 全缺:保留前一次渲染
  renderChinaStats();
  $('#china-etf-block').hidden = !etf;   // 分時抓不到時整塊收起,不留孤立小標
  if (etf) {
    renderChinaEtf();
    renderChinaEtfLegend();
    renderChinaEtfRead();
  }
  if (margin?.length) {
    renderNetBarChart('#china-margin-chart', margin, {
      unitLabel: '億元',
      height: 180,
      minAbs: 100,
      tooltipText: (r) => `融資${r.net >= 0 ? '淨買入' : '淨賣出'} ${Math.abs(r.net).toLocaleString('zh-TW', { maximumFractionDigits: 1 })} 億元`,
    });
  }
  if (south?.length) {
    renderNetBarChart('#china-south-chart', south, {
      unitLabel: '億港元',
      height: 180,
      minAbs: 100,
      tooltipText: (r) => `南向${r.net >= 0 ? '淨買入' : '淨賣出'} ${Math.abs(r.net).toLocaleString('zh-TW', { maximumFractionDigits: 1 })} 億港元`,
    });
  }
  if (margin?.length || south?.length) renderChinaLegend();
  renderChinaRead();
}

// ===== 更新流程 =====

function renderAll() {
  renderTwdCard();
  renderForeignCard();
  renderChinaCard();
  renderAssetCard();
  renderRegionCard();
  renderBondCard();
}

// 匯率兩來源一起抓(Frankfurter + 台幣 currency-api,皆為日更、每小時輪詢);
// 任一失敗匯率燈轉紅,畫面各自保留上次成功的渲染
async function refreshFX() {
  const card = $('#region-card');
  card.classList.add('refreshing');
  const results = await Promise.allSettled([fetchFX(), fetchTwdFx()]);
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`${['FX', '台幣匯率'][i]} 更新失敗:`, r.reason);
  });
  setStatus('dot-fx', 'ts-fx', results.every(r => r.status === 'fulfilled'));
  card.classList.remove('refreshing');
  renderAll();
}

async function refreshScanner() {
  try {
    await fetchScanner();
    setStatus('dot-scanner', 'ts-scanner', true);
  } catch (e) {
    console.error('scanner 更新失敗:', e);
    setStatus('dot-scanner', 'ts-scanner', false);
  } finally {
    renderAll();
  }
}

async function refreshMacro() {
  try {
    await fetchMacro();
    setStatus('dot-macro', 'ts-macro', true);
  } catch (e) {
    console.error('總經更新失敗:', e);
    setStatus('dot-macro', 'ts-macro', false);
  } finally {
    renderMacroTrends();
    renderMacroRead();
  }
}

// 外資買賣超:更新狀態直接標在卡的註腳(TWSE 波動不該把頁首「匯率資料」燈拉紅);
// 首次回補受 TWSE 限速要跑數十秒,以旗標避免重複觸發
let foreignBusy = false;

async function refreshForeign() {
  if (foreignBusy) return;
  foreignBusy = true;
  const status = $('#foreign-status');
  const t = () => new Date().toLocaleTimeString('zh-TW', { hour12: false });
  try {
    const partialErr = await fetchForeign();
    status.textContent = partialErr
      ? ` ⚠ 部分日期抓取失敗,顯示既有快取(${t()})`
      : ` 更新於 ${t()}。`;
  } catch (e) {
    console.error('外資買賣超更新失敗:', e);
    status.textContent = ' ⚠ 更新失敗,顯示上次快取。';
  } finally {
    foreignBusy = false;
    renderForeignCard();
  }
}

// 中國資金流向:四個端點獨立抓,狀態標在卡的註腳(東方財富波動不佔頁首狀態燈)
let chinaBusy = false;

async function refreshChina() {
  if (chinaBusy) return;
  chinaBusy = true;
  const status = $('#china-status');
  const t = () => new Date().toLocaleTimeString('zh-TW', { hour12: false });
  const results = await Promise.allSettled([
    fetchChinaMargin(), fetchChinaSouth(), fetchEtfDaily(), fetchEtfTrends(),
  ]);
  const nFail = results.filter(r => r.status === 'rejected').length;
  for (const r of results) {
    if (r.status === 'rejected') console.error('中國資金流向更新失敗:', r.reason);
  }
  status.textContent = nFail === 0 ? ` 更新於 ${t()}。`
    : nFail === results.length ? ' ⚠ 更新失敗,顯示上次內容。'
    : ` ⚠ 部分資料抓取失敗(${t()})`;
  chinaBusy = false;
  renderChinaCard();
}

// A 股盤中(UTC+8 週一至五 09:25–15:05)才刷新分時;收盤後資料不會變,不再打
async function refreshEtfIntraday() {
  const d = new Date(Date.now() + 8 * 3600e3);
  const hm = d.getUTCHours() * 100 + d.getUTCMinutes();
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6 || hm < 925 || hm > 1505) return;
  try {
    await fetchEtfTrends();
    renderChinaCard();
  } catch (e) { console.warn('510300 分時更新失敗(下次輪詢再試):', e); }
}

let historyRetryTimer = null;

async function refreshCryptoHistory() {
  try {
    await fetchCryptoHistory();
    setStatus('dot-crypto', 'ts-crypto', true);
  } catch (e) {
    console.error('加密歷史更新失敗:', e);
    setStatus('dot-crypto', 'ts-crypto', false);
    // CoinGecko 免費層限流:45 秒後重試一次(不疊加計時器)
    if (String(e).includes('429') && !historyRetryTimer) {
      historyRetryTimer = setTimeout(() => {
        historyRetryTimer = null;
        refreshCryptoHistory();
      }, 45 * 1000);
    }
  } finally {
    renderAll();
  }
}

async function refreshAll() {
  const btn = $('#refresh-btn');
  btn.disabled = true;
  refreshForeign();   // 不 await:首次回補逐日限速要跑數十秒,不佔住更新按鈕
  refreshChina();     // 不 await:與其他來源獨立,失敗只影響自己的卡
  await Promise.allSettled([refreshSnapshot(), refreshFX(), refreshScanner(), refreshMacro()]);
  await refreshCryptoHistory();
  btn.disabled = false;
}

// ===== 介面事件 =====

function initWeekToggle(sel, key, rerender) {
  const box = $(sel);
  box.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-weeks]');
    if (!btn) return;
    ui[key] = Number(btn.dataset.weeks);
    for (const b of box.querySelectorAll('button')) b.classList.toggle('active', b === btn);
    rerender();
  });
}

// 色階切換:原始漲跌 % ↔ 波動標準化(σ)
function initScaleToggle(sel, key, rerender) {
  const box = $(sel);
  box.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-scale]');
    if (!btn) return;
    ui[key] = btn.dataset.scale;
    for (const b of box.querySelectorAll('button')) b.classList.toggle('active', b === btn);
    rerender();
  });
}

// 檢視切換(熱力圖/表格):defs = [{ btn, view, panels }],panels = 該檢視顯示的元素
//(#*-legend 可同時掛在多個檢視下,由當前檢視的 render 負責填內容)
function initViewToggle(defs, viewKey, rerender) {
  const allPanels = [...new Set(defs.flatMap(d => d.panels))];
  const setView = (view) => {
    ui[viewKey] = view;
    const show = new Set(defs.find(d => d.view === view).panels);
    for (const sel of allPanels) $(sel).hidden = !show.has(sel);
    for (const d of defs) {
      const active = d.view === view;
      $(d.btn).classList.toggle('active', active);
      $(d.btn).setAttribute('aria-pressed', String(active));
    }
    rerender();
  };
  for (const d of defs) $(d.btn).addEventListener('click', () => setView(d.view));
}

function main() {
  $('#refresh-btn').addEventListener('click', refreshAll);

  initWeekToggle('#twd-weeks', 'twdWeeks', renderTwdCard);
  initWeekToggle('#asset-weeks', 'assetWeeks', renderAssetCard);
  initWeekToggle('#region-weeks', 'regionWeeks', renderRegionCard);
  initScaleToggle('#asset-scale', 'assetScale', renderAssetCard);
  initScaleToggle('#region-scale', 'regionScale', renderRegionCard);
  initViewToggle([
    { btn: '#btn-asset-chart', view: 'chart', panels: ['#asset-heatmap', '#asset-legend'] },
    { btn: '#btn-asset-table', view: 'table', panels: ['#asset-table'] },
  ], 'assetView', renderAssetCard);
  initViewToggle([
    { btn: '#btn-region-chart', view: 'chart', panels: ['#region-heatmap', '#region-legend'] },
    { btn: '#btn-region-table', view: 'table', panels: ['#region-table'] },
  ], 'regionView', renderRegionCard);

  // 卡片說明折疊:滑鼠 hover 走純 CSS,點擊切換 .open 供觸控裝置開合
  for (const p of document.querySelectorAll('.card-desc')) {
    p.addEventListener('click', () => p.classList.toggle('open'));
  }

  // 視窗縮放:重畫(D3 圖以當下容器寬度繪製)
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderAll, 200);
  });

  // 深淺模式切換:重讀 CSS 變數重畫
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', renderAll);

  refreshAll();
  setInterval(refreshFX, FX_POLL_MS);
  setInterval(refreshScanner, SCANNER_POLL_MS);
  setInterval(refreshCryptoHistory, HISTORY_POLL_MS);
  setInterval(refreshMacro, MACRO_POLL_MS);
  setInterval(refreshForeign, FOREIGN_POLL_MS);
  setInterval(refreshSnapshot, SNAP_POLL_MS);
  setInterval(refreshChina, CHINA_POLL_MS);
  setInterval(refreshEtfIntraday, ETF_POLL_MS);
}

main();
