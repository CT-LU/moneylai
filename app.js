'use strict';

/* ============================================================
   全球資金流向儀表板 — 主程式(D3.js 版)
   資料源:
   - Frankfurter API(ECB 匯率,每交易日更新)→ 美元指數近似、日圓、
     新興市場貨幣籃、區域資金流向(抓 92 天,供最長 12 週熱力圖)
   - CoinGecko market_chart(days=95,回日資料)→ BTC / ETH / 黃金(PAXG)
   - TradingView scanner → 原油 WTI/布蘭特、銅、綠能(ICLN)、AI(AIQ)
     即時報價與近一週/近一月表現;美債 2Y/10Y/30Y 殖利率、VIX、美元兌台幣
   - BLS 官方 API → 非農就業、失業率;DBnomics(BEA 鏡像)→ 核心 PCE 物價指數
   - fawazahmed0 currency-api(jsDelivr / pages.dev 備援)→ 新台幣對美元、
     日圓、歐元、人民幣的歷史匯率(ECB 沒有 TWD)
   - TradingView widget → DXY / VIX / 各國股市(含台灣加權)/ 加密與 AI 即時報價
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

// 台灣列:美元兌台幣(scanner 即時報價,舊週格靠 localStorage 跨日累積)
const TWD_REGION = { sym: 'FX_IDC:USDTWD', name: '台灣', pair: 'USD/TWD' };

const ALL_FX = [...new Set([...Object.keys(DXY_WEIGHTS), ...EM_BASKET, ...REGIONS.map(r => r.code)])];

// TradingView scanner:資產流向用(即期價 + 近一週/近一月表現;
// 更早的逐週資料靠 localStorage 跨日累積,初期會缺格)
const SCANNER_FLOWS = [
  { sym: 'NYMEX:CL1!',    ep: 'futures', name: '原油 WTI' },
  { sym: 'ICEEUR:BRN1!',  ep: 'futures', name: '原油 布蘭特' },
  { sym: 'OANDA:XCUUSD',  ep: 'global',  name: '銅(綠色通膨)' },
  { sym: 'NASDAQ:ICLN',   ep: 'global',  name: '綠能(ICLN)' },
  { sym: 'NASDAQ:AIQ',    ep: 'global',  name: 'AI(AIQ)' },
];

// 美債殖利率(scanner 同一批抓)
const BOND_TENORS = [
  { sym: 'TVC:US02Y', label: '2 年',  short: '2Y' },
  { sym: 'TVC:US10Y', label: '10 年', short: '10Y' },
  { sym: 'TVC:US30Y', label: '30 年', short: '30Y' },
];

const VIX_SYM = 'TVC:VIX';

const SCANNER_ALL = [
  ...SCANNER_FLOWS,
  ...BOND_TENORS.map(t => ({ sym: t.sym, ep: 'global', name: `美債 ${t.label}` })),
  { sym: VIX_SYM, ep: 'global', name: 'VIX' },
  { sym: TWD_REGION.sym, ep: 'global', name: '美元兌台幣' },
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

const FX_POLL_MS = 60 * 60 * 1000;       // ECB 一天更新一次,每小時輪詢即可
const SCANNER_POLL_MS = 2 * 60 * 1000;   // scanner 非官方 API,保守輪詢
const HISTORY_POLL_MS = 60 * 60 * 1000;  // CoinGecko 歷史,每小時
const MACRO_POLL_MS = 6 * 60 * 60 * 1000; // 總經是月資料,6 小時輪詢綽綽有餘

const DAY_MS = 86400e3;

// ===== 全域狀態 =====
const state = {
  fxDates: [],      // 排序後的日期字串
  fxRates: null,    // { date: { EUR: .., JPY: .. } },base = USD
  scanner: null,    // { sym: { close, change, perfW, perf1M } }
  cryptoHist: null, // { coinId: [{ date, value }] } 95 日日收盤
  macro: null,      // { pce, nfp, unrate } 各為 [{ date:'YYYY-MM', value }]
  twdfx: null,      // [{ date, usd, jpy, eur, cny }] 升冪,值 = 1 單位外幣兌台幣
};

// 介面狀態:兩張熱力圖各自的觀察週數與檢視模式;台幣匯率卡的觀察週數
const ui = {
  assetWeeks: 4,  assetView: 'chart',
  regionWeeks: 4, regionView: 'chart',
  twdWeeks: 12,
};

// ===== 小工具 =====
const $ = (sel) => document.querySelector(sel);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

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

  // 由最新日期往回每 7 天一個錨點(供最長 12 週折線);
  // 歷史匯率不會變,快取命中就不再請求 —— 首次載入約 13 個請求,之後每小時只抓 latest
  const baseMs = new Date(latest.date).getTime();
  const anchors = [];
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

// TradingView scanner:一次 POST 拿多檔報價
// (close、當日變化 %、近一週表現 %、近一月表現 %)
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
        columns: ['close', 'change', 'Perf.W', 'Perf.1M'],
      }),
    });
    if (!res.ok) throw new Error(`scanner ${res.status}`);
    return (await res.json()).data || [];
  }));
  const out = {};
  for (const item of lists.flat()) {
    out[item.s] = { close: item.d[0], change: item.d[1], perfW: item.d[2], perf1M: item.d[3] };
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
  ids.forEach((id, i) => {
    const daily = new Map();   // 同一 UTC 日取最後一筆(最後一點是盤中即時值)
    for (const [ms, price] of lists[i].prices || []) {
      daily.set(new Date(ms).toISOString().slice(0, 10), price);
    }
    hist[id] = [...daily.entries()].map(([date, value]) => ({ date, value }));
  });
  state.cryptoHist = hist;
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

// 把某 scanner 標的的累積紀錄整理成升冪日序列
function scannerSeries(sym) {
  const h = loadScanHist()[sym];
  const q = state.scanner?.[sym];
  const map = new Map(Object.entries(h || {}));
  // localStorage 寫入失敗時(隱私模式),至少用當下報價補三個點
  if (q && Number.isFinite(q.close)) {
    const now = Date.now();
    if (!map.size) map.set(isoDate(new Date(now)), q.close);
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

// 資金動向的文字判讀(最近兩週):讓「錢往哪跑、停在哪」一眼可讀
function flowVerdict(thisW, prevW) {
  if (thisW === null) return '—';
  if (prevW === null) {
    if (Math.abs(thisW) <= 0.3) return '持平';
    return thisW > 0 ? '本週流入' : '本週流出';
  }
  const nowIn = thisW > 0.3, nowOut = thisW < -0.3;
  const wasIn = prevW > 0.3, wasOut = prevW < -0.3;
  if (nowIn && wasOut) return '由流出轉流入';
  if (nowOut && wasIn) return '由流入轉流出';
  if (nowIn && wasIn) return thisW > prevW ? '流入加速' : '流入放緩';
  if (nowOut && wasOut) return thisW < prevW ? '流出加速' : '流出趨緩';
  if (nowIn) return '本週流入';
  if (nowOut) return '本週流出';
  return '持平';
}

// ===== 熱力圖資料列 =====

// 資產列:name、src(資料源)、cells(每週漲跌)
function assetRows(nWeeks) {
  const rows = [];
  const add = (name, series, src) => {
    if (!series || series.length < 2) return;
    rows.push({ name, src, cells: weeklyChanges(series, nWeeks) });
  };

  if (state.fxRates) {
    add('美元(DXY 近似)', toSeries(state.fxDates, dxySeries()), 'ECB 匯率');
    // 反轉 USD/JPY 成「日圓的價值」:升 = 套利平倉、資金回流日圓
    add('日圓(兌美元)', toSeries(state.fxDates, fxSeries('JPY').map(v => 1 / v)), 'ECB 匯率');
    add('新興市場貨幣籃', toSeries(state.fxDates, emIndexSeries()), 'ECB 匯率');
  }
  if (state.cryptoHist) {
    add('黃金(PAXG)', state.cryptoHist['pax-gold'], 'CoinGecko');
    add('比特幣', state.cryptoHist['bitcoin'], 'CoinGecko');
    add('以太幣', state.cryptoHist['ethereum'], 'CoinGecko');
  }
  if (state.scanner) {
    for (const a of SCANNER_FLOWS) add(a.name, scannerSeries(a.sym), 'TradingView');
  }

  for (const r of rows) r.latest = r.cells[r.cells.length - 1]?.pct ?? null;
  // 本週漲幅由高到低排:最上面就是「錢現在停的地方」
  return rows.sort((a, b) => (b.latest ?? -Infinity) - (a.latest ?? -Infinity));
}

// 區域列:貨幣兌美元的每週升貶值(1/匯率 → 升 = 該貨幣升值 = 流入傾向)
function regionRows(nWeeks) {
  const rows = [];
  if (state.fxRates) {
    for (const r of REGIONS) {
      rows.push({
        name: r.name,
        src: r.pair,
        cells: weeklyChanges(toSeries(state.fxDates, fxSeries(r.code).map(v => 1 / v)), nWeeks),
      });
    }
  }
  // 台灣:ECB 沒有 TWD,改用 scanner 的美元兌台幣(取倒數 = 台幣價值)
  const twdSeries = scannerSeries(TWD_REGION.sym)
    .map(p => ({ date: p.date, value: 1 / p.value }));
  if (twdSeries.length >= 2) {
    rows.push({ name: TWD_REGION.name, src: TWD_REGION.pair, cells: weeklyChanges(twdSeries, nWeeks) });
  }
  for (const r of rows) r.latest = r.cells[r.cells.length - 1]?.pct ?? null;
  return rows.sort((a, b) => (b.latest ?? -Infinity) - (a.latest ?? -Infinity));
}

// ===== 熱力圖(D3)=====

function weekLabel(idx, nWeeks) {
  return idx === nWeeks - 1 ? '本週' : `-${nWeeks - 1 - idx}週`;
}

function renderHeatmap(containerSel, legendSel, rows, nWeeks, patId) {
  const container = $(containerSel);
  if (!rows.length) { container.replaceChildren(); return; }

  const width = Math.max(320, container.clientWidth || 800);
  const labelW = Math.min(132, Math.max(88, Math.round(width * 0.16)));
  const valueW = 64;
  const gap = 3;
  const headerH = 22;
  const rowH = 32, cellH = rowH - 6;
  const cellW = (width - labelW - valueW - gap * nWeeks) / nWeeks;
  const height = headerH + rows.length * rowH + 2;

  const ink = cssVar('--ink');
  const cIn = cssVar('--series-in');
  const cOut = cssVar('--series-out');
  const cMid = cssVar('--neutral-mid');
  const cText = cssVar('--text-primary');
  const cSub = cssVar('--text-secondary');
  const cMuted = cssVar('--text-muted');
  const surface = cssVar('--surface-1');   // 「資料累積中」格用白底(卡片底色),與資料格區分

  // 色階:對稱 diverging,依資料絕對值決定上限(1.5%~8% 之間夾住)
  const absVals = rows.flatMap(r => r.cells.filter(c => c.pct !== null).map(c => Math.abs(c.pct)));
  const maxAbs = Math.min(8, Math.max(1.5, d3.max(absVals) ?? 1.5));
  const color = d3.scaleLinear()
    .domain([-maxAbs, 0, maxAbs])
    .range([cOut, cMid, cIn])
    .interpolate(d3.interpolateLab)
    .clamp(true);

  const svg = d3.create('svg')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('role', 'img');

  // 「資料累積中」的斜線格紋
  const pat = svg.append('defs').append('pattern')
    .attr('id', patId).attr('width', 6).attr('height', 6)
    .attr('patternUnits', 'userSpaceOnUse').attr('patternTransform', 'rotate(45)');
  pat.append('rect').attr('width', 6).attr('height', 6).attr('fill', surface);
  pat.append('line').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 6)
    .attr('stroke', cMuted).attr('stroke-width', 1.4).attr('opacity', 0.6);

  // 欄標(週):格子太窄時隔一格標一次,「本週」永遠標
  const labelEvery = cellW >= 34 ? 1 : 2;
  for (let j = 0; j < nWeeks; j++) {
    const isLast = j === nWeeks - 1;
    if (!isLast && (nWeeks - 1 - j) % labelEvery !== 0) continue;
    svg.append('text')
      .attr('x', labelW + j * (cellW + gap) + cellW / 2)
      .attr('y', headerH - 8)
      .attr('text-anchor', 'middle')
      .attr('font-size', 11)
      .attr('font-weight', isLast ? 800 : 400)
      .attr('fill', isLast ? cText : cMuted)
      .text(weekLabel(j, nWeeks));
  }

  rows.forEach((row, i) => {
    const y = headerH + i * rowH;
    svg.append('text')
      .attr('x', labelW - 10)
      .attr('y', y + cellH / 2 + 4)
      .attr('text-anchor', 'end')
      .attr('font-size', 12.5)
      .attr('fill', cSub)
      .text(row.name);

    row.cells.forEach((cell, j) => {
      const rect = svg.append('rect')
        .attr('x', labelW + j * (cellW + gap))
        .attr('y', y)
        .attr('width', Math.max(2, cellW))
        .attr('height', cellH)
        .attr('rx', 5)
        .attr('fill', cell.pct === null ? `url(#${patId})` : color(cell.pct))
        .attr('stroke', ink)
        .attr('stroke-width', 1.4);
      rect.on('mouseenter mousemove', (ev) => {
        showTooltip([
          { text: `${row.name} · ${weekLabel(j, nWeeks)}`, cls: 'tt-label' },
          { text: `${cell.from} → ${cell.to}` , cls: 'tt-label' },
          { text: cell.pct === null ? '—(資料累積中)' : fmtPct(cell.pct), cls: 'tt-value' },
        ], ev.clientX, ev.clientY);
      }).on('mouseleave', hideTooltip);
    });

    // 最右:本週數字
    svg.append('text')
      .attr('x', labelW + nWeeks * (cellW + gap) + 8)
      .attr('y', y + cellH / 2 + 4)
      .attr('font-size', 12.5)
      .attr('font-weight', 700)
      .attr('fill', row.latest === null ? cMuted : cText)
      .attr('font-variant-numeric', 'tabular-nums')
      .text(row.latest === null ? '—' : fmtPct(row.latest));
  });

  container.replaceChildren(svg.node());

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

  legend.replaceChildren(
    el('span', '', `${fmtPct(-maxAbs, 1)}(流出)`),
    lsvg.node(),
    el('span', '', `${fmtPct(maxAbs, 1)}(流入)`),
    swatch.node(),
    el('span', '', '資料累積中'),
  );
}

// 表格檢視(熱力圖的無障礙等價版本)
function renderFlowTable(sel, rows, nWeeks, headLabel, withSrc) {
  const wrap = $(sel);
  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  hr.appendChild(el('th', '', headLabel));
  for (let j = 0; j < nWeeks; j++) hr.appendChild(el('th', '', weekLabel(j, nWeeks)));
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
    tr.appendChild(el('td', '', flowVerdict(row.latest, prev)));
    if (withSrc) tr.appendChild(el('td', '', row.src));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.replaceChildren(table);
}

// 卡內摘要:本週錢停在哪、從哪撤出(rows 已按本週漲幅排序)
function flowSummary(rows, inText, outText) {
  const inflow = rows.filter(r => r.latest !== null && r.latest > 0.3).slice(0, 3).map(r => r.name);
  const outflow = rows.filter(r => r.latest !== null && r.latest < -0.3).slice(-3).map(r => r.name);
  let s = '';
  if (inflow.length) s += `${inText}:${inflow.join('、')}。`;
  if (outflow.length) s += `${outText}:${outflow.join('、')}。`;
  return s || '本週各項變動有限,資金呈觀望。';
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

function renderAssetCard() {
  const rows = assetRows(ui.assetWeeks);
  if (!rows.length) return;
  $('#asset-summary').textContent =
    flowSummary(rows, '本週資金停泊處', '本週撤出') + oilSpreadText();
  if (ui.assetView === 'chart') {
    renderHeatmap('#asset-heatmap', '#asset-legend', rows, ui.assetWeeks, 'hatch-asset');
  } else {
    renderFlowTable('#asset-table', rows, ui.assetWeeks, '資產', true);
  }
}

function renderRegionCard() {
  const rows = regionRows(ui.regionWeeks);
  if (!rows.length) return;
  $('#region-summary').textContent = flowSummary(rows, '近一週資金傾向流入', '傾向流出');
  if (ui.regionView === 'chart') {
    renderHeatmap('#region-heatmap', '#region-legend', rows, ui.regionWeeks, 'hatch-region');
  } else {
    renderFlowTable('#region-table', rows, ui.regionWeeks, '區域', false);
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

  p.replaceChildren(
    el('span', 'bond-tag', tag),
    document.createTextNode(`${text} `),
    el('span', spreadBp < 0 ? 'warn' : '', spreadText),
    document.createTextNode(` ${vixText}一週前與一月前為以 TradingView 表現欄位反推的估值。`),
  );
}

function renderBondCard() {
  const data = bondPoints();
  if (data) {
    renderBondChart(data);
    renderBondStats(data);
    renderBondRead(data, vixPoint());
  }
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

// 四張迷你趨勢:VIX(scanner 累積)+ 核心 PCE / 非農 / 失業率(月資料)
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

  p.replaceChildren(
    el('span', 'bond-tag', '雙重使命'),
    document.createTextNode(
      `通膨端:核心 PCE 年增 ${pceNow.value.toFixed(1)}%(${pceNow.date}),${inflText};` +
      `就業端:失業率 ${urNow.value.toFixed(1)}%、近三月非農平均月增 ${Math.round(nfp3m)} 千人,${jobsText}。${verdict}`
    ),
  );
}

// ===== 新台幣匯率卡 =====

function fmtTwdRate(v, digits) {
  return Number.isFinite(v) ? v.toFixed(digits) : '—';
}

// 卡頭四個數字盒:1 單位外幣 = 多少台幣 + 一週變化(匯率升 = 台幣貶)
function renderTwdStats(series) {
  const grid = $('#twd-stats');
  const latest = series[series.length - 1];
  const latestMs = new Date(latest.date).getTime();
  const boxes = TWDFX_CURRENCIES.map((c) => {
    const box = el('div', 'macro-box twd-box');
    const head = el('div', 'macro-head');
    const label = el('span', 'label');
    label.appendChild(el('span', 'twd-swatch'));
    label.lastChild.style.background = cssVar(c.color);
    label.appendChild(document.createTextNode(`1 ${c.name}`));
    head.appendChild(label);
    head.appendChild(el('span', 'value', `${fmtTwdRate(latest[c.code], c.digits)} 台幣`));

    // 一週變化:匯率漲 = 要花更多台幣 = 台幣走貶
    const one = toSeries(series.map(p => p.date), series.map(p => p[c.code]));
    const wk = valueNear(one.slice(0, -1), latestMs - 7 * DAY_MS);
    if (wk) {
      const pct = pctChange(wk.value, latest[c.code]);
      const cls = Math.abs(pct) < 0.05 ? 'flat' : pct > 0 ? 'up' : 'down';
      const word = Math.abs(pct) < 0.05 ? '台幣持平' : pct > 0 ? '台幣貶' : '台幣升';
      head.appendChild(el('span', `delta ${cls}`, `${fmtPct(pct)} /週(${word})`));
    }
    box.appendChild(head);
    return box;
  });
  grid.replaceChildren(...boxes);
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
      t: new Date(p.date).getTime(),
      rate: p[c.code],
      idx: p[c.code] / win[0][c.code] * 100,
    })),
  }));

  const x = d3.scaleTime()
    .domain(d3.extent(win, p => new Date(p.date).getTime()))
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
      svg.append('circle')
        .attr('cx', x(p.t)).attr('cy', y(p.idx)).attr('r', 2.6)
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
        const d = Math.abs(new Date(p.date).getTime() - tMs);
        if (d < bd) { bd = d; bi = i; }
      });
      const px = x(new Date(win[bi].date).getTime());
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
  p.replaceChildren(
    el('span', 'bond-tag', `近 ${nWeeks} 週`),
    document.createTextNode(`台幣${parts.join('、')}。${verdict}`),
  );
}

function renderTwdCard() {
  const series = state.twdfx;
  if (!series || series.length < 2) return;   // 資料未到:保留前一次渲染
  const nWeeks = ui.twdWeeks;
  const latestMs = new Date(series[series.length - 1].date).getTime();
  const startMs = latestMs - nWeeks * 7 * DAY_MS - DAY_MS / 2;
  const win = series.filter(p => new Date(p.date).getTime() >= startMs);
  if (win.length < 2) return;
  renderTwdStats(series);
  renderTwdChart(win);
  renderTwdLegend();
  renderTwdRead(win, nWeeks);
}

// ===== TradingView widget =====

function mountTradingView() {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const container = $('#tv-widget');
  container.replaceChildren();

  const wrap = el('div', 'tradingview-widget-container');
  wrap.appendChild(el('div', 'tradingview-widget-container__widget'));
  const script = document.createElement('script');
  script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-market-overview.js';
  script.async = true;
  script.text = JSON.stringify({
    colorTheme: dark ? 'dark' : 'light',
    dateRange: '1M',
    showChart: true,
    locale: 'zh_TW',
    width: '100%',
    height: 420,
    isTransparent: true,
    showSymbolLogo: true,
    tabs: [
      {
        title: '避險與利率',
        symbols: [
          { s: 'CAPITALCOM:DXY', d: '美元指數 DXY' },
          { s: 'TVC:US10Y', d: '美債 10 年殖利率' },
          { s: 'TVC:US02Y', d: '美債 2 年殖利率' },
          { s: 'TVC:GOLD', d: '黃金現貨' },
          { s: 'CBOE:VIX', d: 'VIX 恐慌指數' },
          { s: 'FX_IDC:USDTWD', d: '美元兌台幣' },
        ],
      },
      {
        title: '全球股市',
        symbols: [
          { s: 'SP:SPX', d: '標普 500' },
          { s: 'NASDAQ:IXIC', d: '那斯達克' },
          { s: 'TVC:NI225', d: '日經 225' },
          { s: 'TVC:HSI', d: '恆生指數' },
          { s: 'TWSE:IX0001', d: '台灣加權' },
          { s: 'XETR:DAX', d: '德國 DAX' },
        ],
      },
      {
        title: '能源與綠色轉型',
        symbols: [
          { s: 'TVC:USOIL', d: 'WTI 原油' },
          { s: 'TVC:UKOIL', d: '布蘭特原油' },
          { s: 'CAPITALCOM:NATURALGAS', d: '天然氣' },
          { s: 'CAPITALCOM:COPPER', d: '銅' },
          { s: 'NASDAQ:ICLN', d: '全球綠能 ETF' },
          { s: 'AMEX:TAN', d: '太陽能 ETF' },
          { s: 'AMEX:LIT', d: '鋰電池 ETF' },
        ],
      },
      {
        title: '加密與 AI',
        symbols: [
          { s: 'BITSTAMP:BTCUSD', d: '比特幣' },
          { s: 'BITSTAMP:ETHUSD', d: '以太幣' },
          { s: 'NASDAQ:NVDA', d: '輝達' },
          { s: 'NASDAQ:AIQ', d: 'AI ETF(AIQ)' },
          { s: 'NASDAQ:BOTZ', d: '機器人與 AI ETF' },
        ],
      },
    ],
  });
  wrap.appendChild(script);
  container.appendChild(wrap);
}

// ===== 更新流程 =====

function renderAll() {
  renderTwdCard();
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
  await Promise.allSettled([refreshFX(), refreshScanner(), refreshMacro()]);
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

function initViewToggle(btnChartSel, btnTableSel, viewKey, chartSels, tableSel, rerender) {
  const btnChart = $(btnChartSel), btnTable = $(btnTableSel);
  const setView = (view) => {
    ui[viewKey] = view;
    const chart = view === 'chart';
    btnChart.classList.toggle('active', chart);
    btnTable.classList.toggle('active', !chart);
    btnChart.setAttribute('aria-pressed', String(chart));
    btnTable.setAttribute('aria-pressed', String(!chart));
    for (const s of chartSels) $(s).hidden = !chart;
    $(tableSel).hidden = chart;
    rerender();
  };
  btnChart.addEventListener('click', () => setView('chart'));
  btnTable.addEventListener('click', () => setView('table'));
}

function main() {
  mountTradingView();

  $('#refresh-btn').addEventListener('click', refreshAll);

  initWeekToggle('#twd-weeks', 'twdWeeks', renderTwdCard);
  initWeekToggle('#asset-weeks', 'assetWeeks', renderAssetCard);
  initWeekToggle('#region-weeks', 'regionWeeks', renderRegionCard);
  initViewToggle('#btn-asset-chart', '#btn-asset-table', 'assetView',
    ['#asset-heatmap', '#asset-legend'], '#asset-table', renderAssetCard);
  initViewToggle('#btn-region-chart', '#btn-region-table', 'regionView',
    ['#region-heatmap', '#region-legend'], '#region-table', renderRegionCard);

  // 視窗縮放:重畫(D3 圖以當下容器寬度繪製)
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderAll, 200);
  });

  // 深淺模式切換:重掛 widget、重讀 CSS 變數重畫
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    mountTradingView();
    renderAll();
  });

  refreshAll();
  setInterval(refreshFX, FX_POLL_MS);
  setInterval(refreshScanner, SCANNER_POLL_MS);
  setInterval(refreshCryptoHistory, HISTORY_POLL_MS);
  setInterval(refreshMacro, MACRO_POLL_MS);
}

main();
