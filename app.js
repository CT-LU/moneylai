'use strict';

/* ============================================================
   全球資金流向儀表板 — 主程式(D3.js 版)
   資料源:
   - TradingView scanner → 美債 2Y/10Y/30Y 殖利率、VIX(現貨+近月期貨)、
     S&P 500 與 TLT(股債比)、美元兌台幣、日債 10 年殖利率(美日利差)、
     HYG/LQD(信用風險胃納)、週期/防禦類股籃、CNH/CNY(人民幣價差);
     另以 ETF 申贖欄位(fund_flows.* / aum)抓 18 檔主題 ETF 的真實資金流
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

// 美元兌台幣(台幣匯率卡即時交叉價、外資動向雙重確認用)
const USDTWD_SYM = 'FX_IDC:USDTWD';

// 股債比(SPX 相對 TLT)用;TLT 亦為聯準會卡迷你趨勢的債市端
const SPX_SYM = 'SP:SPX';
const TLT_SYM = 'NASDAQ:TLT';

// 美債殖利率(scanner 同一批抓)
const BOND_TENORS = [
  { sym: 'TVC:US02Y', label: '2 年',  short: '2Y' },
  { sym: 'TVC:US10Y', label: '10 年', short: '10Y' },
  { sym: 'TVC:US30Y', label: '30 年', short: '30Y' },
];

const VIX_SYM = 'TVC:VIX';

// VIX 近月期貨(期限結構:現貨/近月 >1 = backwardation,恐慌集中在當下)。
// 註:CBOE:VIX3M 與 CBOE:VX2! 在 scanner 查不到,精確的「現貨/三個月期貨」只能用
// 每月換代碼的遠月合約(歷史累積會碎),故採符號固定的近月連續合約當代理
const VX1_SYM = 'CBOE:VX1!';

// 熱錢驅動因子與比率指標(供判讀用):
// 美日 10 年利差(套利資金的引擎)、HYG/LQD(信用風險胃納)
const JP10Y_SYM = 'TVC:JP10Y';
const HYG_SYM   = 'AMEX:HYG';
const LQD_SYM   = 'AMEX:LQD';

// 週期性 vs 防禦性類股 ETF(Cyclicals/Defensives Ratio:
// 資金在「景氣好才賺錢的生意」與「景氣再差也得買的東西」之間的移動,risk-on/off 最敏感的溫度計)
const CYC_SYMS = [
  { sym: 'AMEX:XLK', name: '科技 XLK' },
  { sym: 'AMEX:XLF', name: '金融 XLF' },
  { sym: 'AMEX:XLI', name: '工業 XLI' },
  { sym: 'AMEX:XLY', name: '非必需消費 XLY' },
];
const DEF_SYMS = [
  { sym: 'AMEX:XLV', name: '醫療 XLV' },
  { sym: 'AMEX:XLP', name: '必需消費 XLP' },
  { sym: 'AMEX:XLU', name: '公用事業 XLU' },
];

// 人民幣離岸/在岸(CNH−CNY 價差:離岸比在岸貶得多 = 資金外流壓力)
const CNH_SYM = 'FX_IDC:USDCNH';
const CNY_SYM = 'FX_IDC:USDCNY';

// 台幣匯率卡即時交叉價用:配 USDTWD/USDCNY 推「1 單位外幣兌台幣」
//(FX_IDC 外匯為 streaming 即時報價,已驗證存在)
const USDJPY_SYM = 'FX_IDC:USDJPY';
const EURUSD_SYM = 'FX_IDC:EURUSD';

// TradingView scanner 報價標的(即期價 + 近一週/近一月表現;逐日歷史 =
// repo 每日快照 + localStorage 跨日累積,供聯準會卡的迷你趨勢)。
// 注意:SCANNER_ALL 的標的清單必須與 scripts/snapshot.py 保持同步
const SCANNER_ALL = [
  { sym: SPX_SYM, ep: 'global', name: '美股 S&P 500' },
  { sym: TLT_SYM, ep: 'global', name: '債市 TLT' },
  ...BOND_TENORS.map(t => ({ sym: t.sym, ep: 'global', name: `美債 ${t.label}` })),
  { sym: VIX_SYM, ep: 'global', name: 'VIX' },
  { sym: VX1_SYM, ep: 'futures', name: 'VIX 近月期貨' },
  { sym: USDTWD_SYM, ep: 'global', name: '美元兌台幣' },
  { sym: JP10Y_SYM, ep: 'global', name: '日債 10 年' },
  { sym: HYG_SYM,   ep: 'global', name: '高收益債 HYG' },
  { sym: LQD_SYM,   ep: 'global', name: '投資級債 LQD' },
  ...CYC_SYMS.map(s => ({ ...s, ep: 'global' })),
  ...DEF_SYMS.map(s => ({ ...s, ep: 'global' })),
  { sym: CNH_SYM,   ep: 'global', name: '美元兌離岸人民幣' },
  { sym: CNY_SYM,   ep: 'global', name: '美元兌在岸人民幣' },
  { sym: USDJPY_SYM, ep: 'global', name: '美元兌日圓' },
  { sym: EURUSD_SYM, ep: 'global', name: '歐元兌美元' },
];

// ===== ETF 真實資金流 =====
// 價格是投票器,申購/贖回是真金白銀:scanner 的 fund_flows.* 是各 ETF 的
// 實際申贖金額(美元;僅 1M/3M/YTD/1Y/5Y 區間,無週/日欄位——已驗證)。
// 跨檔比較一律用「流量佔 AUM %」:SGOV 一天的量可能比 REMX 整年還大。
// group:attack=進攻端(風險偏好前緣)、safe=避險端(用於合讀)。
// 注意:清單必須與 scripts/snapshot.py 的 ETF_TICKERS 保持同步
const ETF_FLOW_LIST = [
  { sym: 'NASDAQ:SOXX', name: '半導體 SOXX',    group: 'attack' },
  { sym: 'NASDAQ:AIQ',  name: 'AI AIQ',         group: 'attack' },
  { sym: 'NASDAQ:IBIT', name: '比特幣 IBIT',    group: 'attack' },
  { sym: 'AMEX:KWEB',   name: '中國網路 KWEB' },
  { sym: 'CBOE:ITA',    name: '國防 ITA' },
  { sym: 'AMEX:XLV',    name: '醫療 XLV' },
  { sym: 'NASDAQ:ICLN', name: '綠能 ICLN' },
  { sym: 'AMEX:XLE',    name: '傳統能源 XLE' },
  { sym: 'AMEX:URA',    name: '鈾/核能 URA' },
  { sym: 'AMEX:GLD',    name: '黃金 GLD',       group: 'safe' },
  { sym: 'AMEX:SLV',    name: '白銀 SLV' },
  { sym: 'AMEX:COPX',   name: '銅礦 COPX' },
  { sym: 'AMEX:REMX',   name: '稀土 REMX' },
  { sym: 'NASDAQ:TLT',  name: '美長債 TLT',     group: 'safe' },
  { sym: 'NYSE:SGOV',   name: '現金停泊 SGOV',  group: 'safe' },
  { sym: 'AMEX:HYG',    name: '非投等債 HYG' },
  { sym: 'AMEX:LQD',    name: '投資級債 LQD' },
  { sym: 'NASDAQ:EMB',  name: '新興市場債 EMB' },
];

const ETF_FLOW_PERIODS = [
  { key: '1M',  col: 'fund_flows.1M',  label: '近 1 月' },
  { key: '3M',  col: 'fund_flows.3M',  label: '近 3 月' },
  { key: 'YTD', col: 'fund_flows.YTD', label: '今年以來' },
  { key: '1Y',  col: 'fund_flows.1Y',  label: '近 1 年' },
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

const FX_POLL_MS = 60 * 60 * 1000;       // currency-api 一天更新一次,每小時輪詢即可
const SCANNER_POLL_MS = 2 * 60 * 1000;   // scanner 非官方 API,保守輪詢
const ETFFLOW_POLL_MS = 60 * 60 * 1000;  // ETF 申贖為日頻統計,每小時輪詢即可
const MACRO_POLL_MS = 6 * 60 * 60 * 1000; // 總經是月資料,6 小時輪詢綽綽有餘
const FOREIGN_POLL_MS = 60 * 60 * 1000;   // 外資買賣超一天更新一次,每小時輪詢即可
const SNAP_POLL_MS = 6 * 60 * 60 * 1000;  // 每日快照(repo 靜態檔)一天更新一次
const CHINA_POLL_MS = 60 * 60 * 1000;     // 兩融/南向/日K 皆為日資料,每小時輪詢即可
const ETF_POLL_MS = 3 * 60 * 1000;        // 510300 分時:A 股盤中每 3 分鐘(收盤後不打)

const DAY_MS = 86400e3;

// ===== 全域狀態 =====
const state = {
  scanner: null,    // { sym: { close, change, perfW, perf1M } }
  etfFlows: null,   // { sym: { close, aum, flows: { '1M': 美元, ... } } }
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

// 介面狀態:台幣匯率卡的觀察週數(1 週=每日取樣視窗)、ETF 資金流卡的統計期間
const ui = {
  twdWeeks: 1,
  etfPeriod: '1M',
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


// ===== 新台幣匯率(currency-api)=====
// ECB 等免費匯率源沒有 TWD,台幣歷史匯率走 fawazahmed0 currency-api:
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

// ETF 真實資金流:同一個 scanner 端點,但抓申贖欄位(fund_flows.*/aum)。
// 這些欄位只有 ETF 有,獨立一支請求與輪詢,失敗只影響自己的卡
async function fetchEtfFlows() {
  const res = await fetch('https://scanner.tradingview.com/global/scan', {
    method: 'POST',   // 同樣不設 Content-Type,維持簡單請求
    body: JSON.stringify({
      symbols: { tickers: ETF_FLOW_LIST.map(e => e.sym), query: { types: [] } },
      columns: ['close', 'aum', ...ETF_FLOW_PERIODS.map(p => p.col)],
    }),
  });
  if (!res.ok) throw new Error(`scanner ETF ${res.status}`);
  const rows = (await res.json()).data || [];
  const out = {};
  for (const item of rows) {
    const flows = {};
    ETF_FLOW_PERIODS.forEach((p, i) => { flows[p.key] = item.d[2 + i]; });
    out[item.s] = { close: item.d[0], aum: item.d[1], flows };
  }
  if (!Object.keys(out).length) throw new Error('scanner ETF 無資料');
  state.etfFlows = out;
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


// ===== scanner 標的的逐日歷史:localStorage 跨日累積 =====
// scanner 只給近一週(Perf.W)與近一月(Perf.1M)表現,拿不到逐日切分。
// 每次抓到資料就存「今天」的收盤,並補上反推的 7 天前、30 天前估值
//(不覆蓋既有的直接觀測值);跨日累積供聯準會卡的迷你趨勢圖。
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

// ===== 序列小工具 =====

function toSeries(dates, values) {
  return dates.map((d, i) => ({ date: d, value: values[i] }));
}

// 在日序列裡找最接近 target 時間(容差 ±4.5 天)的點
function valueNear(series, targetMs) {
  let best = null, bestDiff = 4.5 * DAY_MS;
  for (const p of series) {
    const diff = Math.abs(new Date(p.date).getTime() - targetMs);
    if (diff < bestDiff) { best = p; bestDiff = diff; }
  }
  return best;
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

// 美日 10 年利差(百分點):日圓套利交易的引擎;收窄 = 平倉壓力(risk-off 前哨)。
// 走闊只代表套利誘因升溫,不等於 risk-on(常來自美債殖利率上升,對股債反而是壓力)
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

// N 檔 scanner 跨日累積序列的同日交集,值 = fn(各檔當日值,依 syms 順序);
// 每一天要所有檔都有紀錄才算得出來,啟用初期只有少數點
function joinSeries(syms, fn) {
  const [first, ...rest] = syms.map(sym =>
    new Map(scannerSeries(sym).map(p => [p.date, p.value])));
  return [...first.entries()]
    .filter(([date]) => rest.every(m => m.has(date)))
    .map(([date, v]) => ({ date, value: fn([v, ...rest.map(m => m.get(date))]) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// 幾何平均:讓籃內各 ETF 的價格量級不失真地等權
const gm = vs => Math.exp(vs.reduce((s, v) => s + Math.log(v), 0) / vs.length);

// 美日利差的跨日累積序列
const usJpSpreadSeries = () => joinSeries(['TVC:US10Y', JP10Y_SYM], ([us, jp]) => us - jp);

// 信用風險胃納:HYG/LQD 比值 ×100(升 = 資金敢買高收益債)
const hygLqdSeries = () => joinSeries([HYG_SYM, LQD_SYM], ([h, l]) => h / l * 100);

// 股債比:S&P 500 對 TLT 的比值(升 = 資金偏股)
const spxTltSeries = () => joinSeries([SPX_SYM, TLT_SYM], ([spx, tlt]) => spx / tlt);

// 週期/防禦類股比 ×100:兩籃各取幾何平均再相除(升 = 資金衝向進攻型類股)
const cycDefSeries = () => joinSeries(
  [...CYC_SYMS, ...DEF_SYMS].map(s => s.sym),
  vs => gm(vs.slice(0, CYC_SYMS.length)) / gm(vs.slice(CYC_SYMS.length)) * 100);

// VIX 期限結構:現貨 ÷ 近月期貨(平時 <1 contango;>1 = backwardation 恐慌結構)
const vixTermSeries = () => joinSeries([VIX_SYM, VX1_SYM], ([spot, fut]) => spot / fut);

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

  // 10Y−2Y = 借錢給政府 10 年 vs 2 年的利率差:正常世界借愈久該多拿利息(正斜率);
  // 水位級距:<0 倒掛(衰退前兆)、0–50bp 偏平、50–150bp 正常、>150bp 陡峭
  const spreadBp = (t10.now - t2.now) * 100;
  const lvl = spreadBp < 0 ? '殖利率曲線倒掛:借 2 年的利息反而比借 10 年高——市場押注未來將大幅降息(通常是預期景氣要壞),歷史上常出現在衰退之前,資金以防禦為主'
    : spreadBp < 50 ? '曲線偏平:多借 8 年只多拿一點點利息,市場對長期景氣的信心不足(或剛從倒掛修復),定價仍謹慎'
    : spreadBp <= 150 ? '曲線斜率正常:借愈久利息愈高的健康狀態,債市對景氣的定價平穩'
    : '曲線陡峭:長期利息比短期高出一大截——常見於降息週期(短端被壓低)或通膨/公債供給疑慮(長端被推高),搭配上方牛陡/熊陡判讀分辨是哪一種';
  const spreadText = `目前 10Y−2Y 利差 ${fmtBp(spreadBp, 0)}(借給政府 10 年比 2 年多拿的利息),${lvl}。`;

  // 股市端:VIX 水位 + 與債市方向合讀。VIX = 幫美股買保險的價格
  // (由 S&P 500 選擇權反推的未來 30 天預期波動):愈高 = 愈多人花錢防跌
  let vixText = '';
  if (vix && Number.isFinite(vix.dW)) {
    const level = vix.now >= 30 ? '恐慌區(>30):保險不計價格地搶買,常見於暴跌當下——歷史上這種極端有時反而離底部不遠'
      : vix.now >= 20 ? '避險區(20–30):幫股票買保險明顯變貴,投資人正花錢防跌,情緒轉向防禦'
      : vix.now >= 15 ? '正常區(15–20):該有的緊張都在價格裡,股市情緒平穩'
      : '樂觀區(<15):保險便宜到沒什麼人覺得會出事,情緒偏樂觀(過度平靜有時是自滿的訊號)';
    let combo = '';
    if (vix.dW > 1 && d10 < -TH) combo = '——與資金湧入長債同向,股債同步發出避險訊號';
    else if (vix.dW < -1 && d10 > TH) combo = '——與殖利率走升同向,整體偏風險偏好';
    vixText = `股市端:VIX ${vix.now.toFixed(1)}(週${vix.dW > 0 ? '+' : ''}${vix.dW.toFixed(1)} 點)` +
      `——幫美股買保險的價格,愈高=愈多人花錢防跌。${level}${combo}。`;
    // 期限結構:現貨 ÷ 近月期貨。平時期貨比現貨貴(contango,比值 <1);
    // 現貨飆過期貨(>1,backwardation)= 市場最怕的是「現在」,經典的恐慌結構
    const fut = state.scanner?.[VX1_SYM];
    if (Number.isFinite(fut?.close) && fut.close > 0) {
      const ratio = vix.now / fut.close;
      const read = ratio > 1 ? '現貨飆過期貨(backwardation):市場最怕的是「現在」,恐慌集中在當下的經典結構'
        : ratio > 0.97 ? '現貨逼近期貨,結構偏平——恐慌再升溫就會翻進 backwardation'
        : '期貨比現貨貴(contango):市場覺得眼前還好、波動之後才會變高,屬常態結構';
      vixText += `期限結構(現貨/近月期貨)${ratio.toFixed(2)}:${read}。`;
    }
  }

  setRead(p, tag, [
    text,
    el('span', spreadBp < 0 ? 'warn' : '', spreadText),
    vixText || null,
  ], '一週前與一月前為以 TradingView 表現欄位反推的估值。');
}

// 風險胃納合讀:套利端(美日利差)、信用端(HYG 相對 LQD)、股債比(SPX 相對 TLT)、
// 類股端(週期籃相對防禦籃)
function renderRiskRead() {
  const p = $('#risk-read');
  const parts = [];

  // 日圓套利:借低利率的日圓、換成美元買高息資產,美日利差就是這門生意的毛利。
  // 水位級距:>3 毛利肥厚、2–3 仍有利可圖、1–2 毛利偏薄、<1 幾乎無利可圖
  const sp = usJpSpread();
  if (sp) {
    const bp = Number.isFinite(sp.dW) ? sp.dW * 100 : null;
    const lvl = sp.now >= 3 ? '毛利肥厚,套利盤最活絡'
      : sp.now >= 2 ? '仍有利可圖'
      : sp.now >= 1 ? '毛利偏薄,部位對再收窄更敏感'
      : '幾乎無利可圖,資金回流日本壓力大';
    const verdict = bp === null || Math.abs(bp) < 3 ? '本週變化有限,套利盤按兵不動'
      : bp > 0 ? '本週走闊:誘因升溫但不等於 risk-on——常來自美債殖利率上升,對股債反而是壓力,真正警訊在收窄端'
      : '本週收窄:平倉壓力升溫,收得又快又急時常拖累全球風險資產(2024-08 即一例)';
    parts.push(`套利端:美日 10 年利差 ${sp.now.toFixed(2)} 個百分點` +
      (bp === null ? '' : `(週${fmtBp(bp, 0)})`) +
      `=借日圓買美元資產這門套利的毛利。${lvl};${verdict}。`);
  }

  // HYG=借錢給體質較差公司的債(利息高、怕倒帳)、LQD=借給績優公司;
  // 敢不敢多賺那點利息去承擔倒帳風險,是比股市更早說真話的風險偏好溫度計
  const hyg = state.scanner?.[HYG_SYM], lqd = state.scanner?.[LQD_SYM];
  if (Number.isFinite(hyg?.perfW) && Number.isFinite(lqd?.perfW)) {
    const rel = hyg.perfW - lqd.perfW;
    const verdict = rel > 0.3 ? '資金敢買體質較差公司的債去多賺利息,信用市場的風險胃納偏強'
      : rel < -0.3 ? '資金從高風險債退回績優公司債,信用市場先轉保守——這個訊號常走在股市轉弱之前'
      : '兩者表現相當,信用市場中性';
    parts.push(`信用端:高收益債(HYG,借錢給體質較差的公司、利息高)本週 ${fmtPct(hyg.perfW)}、` +
      `相對投資級公司債(LQD,借給績優公司)${rel > 0 ? '+' : ''}${rel.toFixed(1)} 個百分點,${verdict}。`);
  }

  const spx = state.scanner?.[SPX_SYM], tlt = state.scanner?.[TLT_SYM];
  if (Number.isFinite(spx?.perfW) && Number.isFinite(tlt?.perfW)) {
    const rel = spx.perfW - tlt.perfW;
    const verdict = rel > 0.5 ? '資金偏股,敢冒險(risk-on)' : rel < -0.5 ? '資金偏債,躲進避險資產(risk-off)' : '股債均衡';
    parts.push(`股債比:S&P 500 本週 ${fmtPct(spx.perfW)}、債市 TLT ${fmtPct(tlt.perfW)},${verdict}。`);
  }

  // 類股端:週期籃 vs 防禦籃的本週相對表現(各取籃內 ETF 的 Perf.W 平均),
  // 資金在兩籃間的移動是風險偏好最敏感的溫度計
  const basketPerfW = syms => {
    const ps = syms.map(s => state.scanner?.[s.sym]?.perfW).filter(Number.isFinite);
    return ps.length === syms.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null;
  };
  const cyc = basketPerfW(CYC_SYMS), def = basketPerfW(DEF_SYMS);
  if (cyc !== null && def !== null) {
    const rel = cyc - def;
    const verdict = rel > 0.5 ? '資金衝向進攻型類股,風險偏好升溫(risk-on)'
      : rel < -0.5 ? '資金縮回防禦型類股,市場轉向避險(risk-off)'
      : '兩籃表現相當,類股輪動中性';
    parts.push(`類股端:週期股(科技/金融/工業/非必需消費——景氣好才賺錢的生意)本週 ${fmtPct(cyc)}、` +
      `相對防禦股(醫療/必需消費/公用事業——景氣再差也得買的東西)${rel > 0 ? '+' : ''}${rel.toFixed(1)} 個百分點,` +
      `${verdict}。資金在這兩籃之間的移動,是風險偏好最敏感的溫度計。`);
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

// 八張迷你趨勢:VIX 期限結構、美日 10 年利差、信用風險胃納 HYG/LQD、
// 股債比 SPX/TLT、週期/防禦類股比(皆 scanner 跨日累積)+ 核心 PCE / 非農 / 失業率(月資料)。
// 現貨 VIX 不做小卡(2026-07 使用者決定只留期限結構——水位門檻在不同波動環境會漂移,
// 判斷力不如翻過 1.0 的結構訊號;VIX 現值/週變化/四區判讀仍在股市端文字)
function macroTrendDefs() {
  const defs = [];
  const vixTerm = vixTermSeries();
  if (vixTerm.length >= 2) {
    defs.push({
      key: 'vixterm', label: 'VIX 期限結構(現貨/近月期貨)', series: vixTerm,
      fmt: v => v.toFixed(2), deltaUnit: ' 點', digits: 2, ref: 1, refLabel: '1.0 恐慌結構',
      note: vixTerm.length < 6 ? '跨日累積中,趨勢點會逐日增加' : '',
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
  const credit = hygLqdSeries();
  if (credit.length >= 2) {
    defs.push({
      key: 'credit', label: '信用風險胃納 HYG/LQD(×100)', series: credit,
      fmt: v => v.toFixed(2), deltaUnit: ' 點', digits: 2, ref: null,
      note: credit.length < 6 ? '跨日累積中,趨勢點會逐日增加' : '',
    });
  }
  const spxTlt = spxTltSeries();
  if (spxTlt.length >= 2) {
    defs.push({
      key: 'spxtlt', label: '股債比 S&P 500/TLT', series: spxTlt,
      fmt: v => v.toFixed(2), deltaUnit: ' 點', digits: 2, ref: null,
      note: spxTlt.length < 6 ? '跨日累積中,趨勢點會逐日增加' : '',
    });
  }
  const cycDef = cycDefSeries();
  if (cycDef.length >= 2) {
    defs.push({
      key: 'cycdef', label: '週期/防禦類股比(×100)', series: cycDef,
      fmt: v => v.toFixed(2), deltaUnit: ' 點', digits: 2, ref: null,
      note: cycDef.length < 6 ? '跨日累積中,趨勢點會逐日增加' : '',
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
  const twd = c(USDTWD_SYM), jpy = c(USDJPY_SYM), eur = c(EURUSD_SYM), cny = c(CNY_SYM);
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

// 視窗首尾的台幣升貶判讀(台幣貶 = 資金流出傾向)
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
// 藍=淨買入(流入)、紅=淨賣出(流出),與全站同一組 diverging 資料色
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
  // 在岸價(CNY)受央行中間價管制、離岸價(CNH)在香港自由交易——價差就是
  // 「管不到的市場」對人民幣的真實出價:離岸貶愈多 = 看貶押注/換匯出走的需求愈強
  const sp = cnhCnySpread();
  if (sp) {
    const v = sp.now > 0.5 ? '離岸比在岸貶超過 0.5%,自由市場重手押注人民幣走貶,資金外流壓力沉重(2015–16 匯改動盪時價差曾破 1%)'
      : sp.now > 0.15 ? '離岸比在岸貶得多:不受管制的離岸市場看貶人民幣,換匯出走的需求浮現,價差愈闊外流壓力愈大'
      : sp.now < -0.15 ? '離岸反而比在岸強:自由市場看升人民幣,不但沒有外流壓力,還偏向資金回流'
      : '離岸與在岸幾乎同價(±0.15% 內),自由市場沒有明顯的看貶押注,匯率端壓力有限';
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

// ===== ETF 真實資金流卡 =====

// 美元 → 億美元;帶 +/- 符號(不靠顏色單獨表意)
function fmtUsdBillions(v) {
  const b = v / 1e8;
  const abs = Math.abs(b);
  const txt = abs >= 100 ? Math.round(b).toLocaleString('zh-TW') : b.toFixed(abs >= 10 ? 0 : 1);
  return `${v > 0 ? '+' : ''}${txt} 億美元`;
}

// 目前選定期間的資料列(依「流量佔規模 %」降冪;缺料的檔略過)
function etfFlowRows() {
  const q = state.etfFlows;
  if (!q) return [];
  const rows = [];
  for (const e of ETF_FLOW_LIST) {
    const d = q[e.sym];
    const flow = d?.flows[ui.etfPeriod];
    if (!d || !Number.isFinite(d.aum) || d.aum <= 0 || !Number.isFinite(flow)) continue;
    rows.push({ ...e, flow, aum: d.aum, pct: flow / d.aum * 100 });
  }
  return rows.sort((a, b) => b.pct - a.pct);
}

const etfPeriodLabel = () => ETF_FLOW_PERIODS.find(x => x.key === ui.etfPeriod).label;

// 進攻端/避險端合計:籃內各檔流量加總 ÷ 規模加總
function etfBasket(rows, group) {
  const rs = rows.filter(r => r.group === group);
  if (!rs.length) return null;
  const flow = d3.sum(rs, r => r.flow);
  const aum = d3.sum(rs, r => r.aum);
  return { flow, pct: flow / aum * 100 };
}

// 卡頭四個數字盒:進攻端合計、避險端合計、最強流入、最強流出
//(方向用文字標示不用紅綠,與台股外資卡同一原則)
function renderEtfFlowStats(rows) {
  const grid = $('#etfflow-stats');
  const per = etfPeriodLabel();
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

  const word = (pct) => Math.abs(pct) < 0.3 ? '大致持平' : pct > 0 ? '新錢流入' : '資金撤出';
  const atk = etfBasket(rows, 'attack');
  if (atk) boxes.push(mkBox(`進攻端合計(${per})`, fmtUsdBillions(atk.flow),
    `半導體+AI+比特幣,佔規模 ${fmtPct(atk.pct)}(${word(atk.pct)})`));
  const safe = etfBasket(rows, 'safe');
  if (safe) boxes.push(mkBox(`避險端合計(${per})`, fmtUsdBillions(safe.flow),
    `黃金+美長債+現金,佔規模 ${fmtPct(safe.pct)}(${word(safe.pct)})`));

  const top = rows[0], bottom = rows[rows.length - 1];
  if (top && top.pct > 0) boxes.push(mkBox(`最強流入(${per})`, top.name,
    `${fmtUsdBillions(top.flow)},佔自身規模 ${fmtPct(top.pct)}`));
  if (bottom && bottom.pct < 0) boxes.push(mkBox(`最強流出(${per})`, bottom.name,
    `${fmtUsdBillions(bottom.flow)},佔自身規模 ${fmtPct(bottom.pct)}`));

  if (boxes.length) grid.replaceChildren(...boxes);
}

// 橫向 diverging 長條:每檔一列,長度 = 流量佔自身規模 %(跨檔可比),
// 藍=淨申購(流入)、紅=淨贖回(流出),與全站資料色一致;列依流量佔比排序
function renderEtfFlowChart(rows) {
  const container = $('#etfflow-chart');
  const width = Math.max(320, container.clientWidth || 720);
  const rowH = 27;
  const m = { top: 6, right: 10, bottom: 6, left: 10 };
  const labelW = Math.min(122, Math.max(98, Math.round(width * 0.17)));
  const valueW = 62;
  const height = m.top + m.bottom + rows.length * rowH;

  const ink = cssVar('--ink');
  const cGrid = cssVar('--grid');
  const cText = cssVar('--text-primary');
  const cIn = cssVar('--series-in');
  const cOut = cssVar('--series-out');

  const x0 = m.left + labelW;
  const x1 = width - m.right - valueW;
  const maxAbs = Math.max(0.5, d3.max(rows, r => Math.abs(r.pct)));
  const x = d3.scaleLinear().domain([-maxAbs, maxAbs]).range([x0, x1]);

  const svg = d3.create('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('role', 'img');

  // 退位垂直網格(不標數字,長條本身直接標值)
  for (const t of x.ticks(4)) {
    if (t === 0) continue;
    svg.append('line')
      .attr('x1', x(t)).attr('x2', x(t))
      .attr('y1', m.top).attr('y2', height - m.bottom)
      .attr('stroke', cGrid).attr('stroke-width', 1);
  }

  const per = etfPeriodLabel();
  rows.forEach((r, i) => {
    const y = m.top + i * rowH;
    const pos = r.pct >= 0;

    svg.append('text')
      .attr('x', m.left + labelW - 10).attr('y', y + rowH / 2 + 4)
      .attr('text-anchor', 'end').attr('font-size', 12.5).attr('font-weight', 650)
      .attr('fill', cText)
      .text(r.name);

    svg.append('rect')
      .attr('x', pos ? x(0) : x(r.pct))
      .attr('y', y + 4.5)
      .attr('width', Math.max(1.5, Math.abs(x(r.pct) - x(0))))
      .attr('height', rowH - 9)
      .attr('rx', 2.5)
      .attr('fill', pos ? cIn : cOut)
      .attr('stroke', ink).attr('stroke-width', 1.2);

    svg.append('text')
      .attr('x', width - m.right - valueW + 8).attr('y', y + rowH / 2 + 4)
      .attr('font-size', 12).attr('font-weight', 700)
      .attr('fill', cText).style('font-variant-numeric', 'tabular-nums')
      .text(fmtPct(r.pct, Math.abs(r.pct) >= 10 ? 1 : 2));

    // 整列透明熱區:滑到哪一列都有 tooltip
    svg.append('rect')
      .attr('x', m.left).attr('y', y)
      .attr('width', width - m.left - m.right).attr('height', rowH)
      .attr('fill', 'transparent')
      .on('mouseenter mousemove', (ev) => {
        showTooltip([
          { text: `${r.name} · ${per}`, cls: 'tt-label' },
          { text: `${r.flow >= 0 ? '淨申購' : '淨贖回'} ${fmtUsdBillions(Math.abs(r.flow)).replace('+', '')}`, cls: 'tt-value' },
          { text: `佔基金規模 ${fmtPct(r.pct)}`, cls: 'tt-value' },
          { text: `目前規模 ${fmtUsdBillions(r.aum).replace('+', '')}`, cls: 'tt-value' },
        ], ev.clientX, ev.clientY);
      })
      .on('mouseleave', hideTooltip);
  });

  // 零線(基準線,比網格線重)
  svg.append('line')
    .attr('x1', x(0)).attr('x2', x(0))
    .attr('y1', m.top).attr('y2', height - m.bottom)
    .attr('stroke', ink).attr('stroke-width', 1.5);

  container.replaceChildren(svg.node());
}

function renderEtfFlowLegend() {
  const box = $('#etfflow-legend');
  const mk = (color, text) => {
    const chip = el('span', 'twd-chip');
    const sw = el('span', 'twd-swatch');
    sw.style.background = color;
    chip.appendChild(sw);
    chip.appendChild(document.createTextNode(text));
    return chip;
  };
  box.replaceChildren(
    mk(cssVar('--series-in'), '淨申購=真金白銀流入'),
    mk(cssVar('--series-out'), '淨贖回=資金撤出'),
  );
}

// 申贖合讀:進攻端 vs 避險端、信用端(HYG vs LQD)、現金端(SGOV)、對照組亮點
function renderEtfFlowRead(rows) {
  const p = $('#etfflow-read');
  if (!rows.length) { p.textContent = ''; return; }
  const per = etfPeriodLabel();
  const bySym = new Map(rows.map(r => [r.sym, r]));
  const items = [];

  // 進攻端 vs 避險端:兩籃的申贖方向是 risk-on/off 最直白的資金面證據
  const atk = etfBasket(rows, 'attack');
  const safe = etfBasket(rows, 'safe');
  if (atk && safe) {
    const aIn = atk.pct > 0.3, aOut = atk.pct < -0.3;
    const sIn = safe.pct > 0.3, sOut = safe.pct < -0.3;
    const verdict = aIn && sOut ? '新錢湧向進攻型資產、同時贖回避險部位——risk-on 獲得資金面確認'
      : aOut && sIn ? '贖回進攻型資產、轉進避險部位——risk-off 獲得資金面確認'
      : aIn && sIn ? '進攻與避險兩頭都在進錢:市場資金充沛,但避險意識沒有放下'
      : aOut && sOut ? '進攻與避險兩頭都在失血,資金整體離開這些 ETF'
      : atk.pct - safe.pct > 0.3 ? '新錢相對偏向進攻端(偏 risk-on)'
      : safe.pct - atk.pct > 0.3 ? '新錢相對偏向避險端(偏 risk-off)'
      : '兩籃申贖相當,資金面方向未明';
    items.push(`進攻端(半導體/AI/比特幣)${per}合計 ${fmtUsdBillions(atk.flow)}(佔規模 ${fmtPct(atk.pct)})、` +
      `避險端(黃金/美長債/現金)${fmtUsdBillions(safe.flow)}(${fmtPct(safe.pct)}),${verdict}。`);
  }

  // 現金端:SGOV(0–3 月國庫券)就是美元市場的現金停車場,
  // 大額進駐 = 資金選擇觀望領息,是避險最直白的動作
  const sgov = bySym.get('NYSE:SGOV');
  if (sgov) {
    const v = sgov.pct > 0.5 ? '資金明顯進駐現金停車場,觀望情緒濃'
      : sgov.pct < -0.5 ? '資金離開現金停車場——這些錢通常正在找風險資產的去處'
      : '現金停泊變化有限';
    items.push(`現金端:停泊型國庫券 ETF(SGOV)${per} ${fmtUsdBillions(sgov.flow)}(佔規模 ${fmtPct(sgov.pct)}),${v}。`);
  }

  // 信用端:敢不敢把債從績優公司換到體質較差公司多賺利息
  const hyg = bySym.get('AMEX:HYG');
  const lqd = bySym.get('AMEX:LQD');
  if (hyg && lqd) {
    const d = hyg.pct - lqd.pct;
    const v = d > 0.5 ? '資金往高風險債移動,信用市場的風險胃納偏強'
      : d < -0.5 ? '資金從高風險債退回投資級,信用市場先轉保守(常走在股市轉弱之前)'
      : '高收益與投資級的申贖相當,信用端中性';
    items.push(`信用端:非投等債 HYG ${fmtPct(hyg.pct)}、投資級 LQD ${fmtPct(lqd.pct)}(佔各自規模),${v}。`);
  }

  // 對照組亮點:同主題兩端的申贖分歧(差距 ≥1 個百分點才提)
  const contrasts = [];
  const pair = (aSym, bSym, text) => {
    const a = bySym.get(aSym), b = bySym.get(bSym);
    if (a && b && Math.abs(a.pct - b.pct) >= 1) contrasts.push(text(a, b));
  };
  pair('AMEX:GLD', 'AMEX:SLV', (g, s) => g.pct > s.pct
    ? `黃金(${fmtPct(g.pct)})比白銀(${fmtPct(s.pct)})吸金——買的是避險而非貴金屬投機`
    : `白銀(${fmtPct(s.pct)})比黃金(${fmtPct(g.pct)})吸金——貴金屬買盤偏投機端`);
  pair('NASDAQ:ICLN', 'AMEX:XLE', (i, e) => i.pct > e.pct
    ? `綠能(${fmtPct(i.pct)})壓過傳統能源(${fmtPct(e.pct)}),能源資金偏向轉型敘事`
    : `傳統能源(${fmtPct(e.pct)})壓過綠能(${fmtPct(i.pct)}),能源資金回頭擁抱油氣現金流`);
  if (contrasts.length) items.push(`對照組:${contrasts.join(';')}。`);

  setRead(p, 'ETF 申贖合讀', items,
    '資金流=該期間「申購−贖回」的真實金額(TradingView 統計,約 T+1 更新);' +
    '佔規模 % 才能跨檔比較——現金停泊 SGOV 一天的量可能比稀土 REMX 整年還大。');
}

function renderEtfFlowCard() {
  const rows = etfFlowRows();
  if (!rows.length) return;   // 資料未到:保留前一次渲染
  renderEtfFlowStats(rows);
  renderEtfFlowChart(rows);
  renderEtfFlowLegend();
  renderEtfFlowRead(rows);
}

// ===== 更新流程 =====

function renderAll() {
  renderTwdCard();
  renderForeignCard();
  renderChinaCard();
  renderEtfFlowCard();
  renderBondCard();
}

// 台幣匯率(currency-api,日更、每小時輪詢);失敗匯率燈轉紅,保留上次渲染
async function refreshFX() {
  const card = $('#twd-card');
  card.classList.add('refreshing');
  try {
    await fetchTwdFx();
    setStatus('dot-fx', 'ts-fx', true);
  } catch (e) {
    console.error('台幣匯率更新失敗:', e);
    setStatus('dot-fx', 'ts-fx', false);
  } finally {
    card.classList.remove('refreshing');
    renderAll();
  }
}

// ETF 資金流:更新狀態標在卡的註腳(與外資/中國卡同一原則)
async function refreshEtfFlows() {
  const status = $('#etfflow-status');
  try {
    await fetchEtfFlows();
    status.textContent = ` 更新於 ${new Date().toLocaleTimeString('zh-TW', { hour12: false })}。`;
  } catch (e) {
    console.error('ETF 資金流更新失敗:', e);
    status.textContent = ' ⚠ 更新失敗,顯示上次內容。';
  } finally {
    renderEtfFlowCard();
  }
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


async function refreshAll() {
  const btn = $('#refresh-btn');
  btn.disabled = true;
  refreshForeign();   // 不 await:首次回補逐日限速要跑數十秒,不佔住更新按鈕
  refreshChina();     // 不 await:與其他來源獨立,失敗只影響自己的卡
  await Promise.allSettled([refreshSnapshot(), refreshFX(), refreshScanner(), refreshEtfFlows(), refreshMacro()]);
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

// ETF 資金流卡的統計期間切換(1M / 3M / YTD / 1Y)
function initPeriodToggle(sel, key, rerender) {
  const box = $(sel);
  box.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-period]');
    if (!btn) return;
    ui[key] = btn.dataset.period;
    for (const b of box.querySelectorAll('button')) b.classList.toggle('active', b === btn);
    rerender();
  });
}

function main() {
  $('#refresh-btn').addEventListener('click', refreshAll);

  initWeekToggle('#twd-weeks', 'twdWeeks', renderTwdCard);
  initPeriodToggle('#etfflow-period', 'etfPeriod', renderEtfFlowCard);

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
  setInterval(refreshEtfFlows, ETFFLOW_POLL_MS);
  setInterval(refreshMacro, MACRO_POLL_MS);
  setInterval(refreshForeign, FOREIGN_POLL_MS);
  setInterval(refreshSnapshot, SNAP_POLL_MS);
  setInterval(refreshChina, CHINA_POLL_MS);
  setInterval(refreshEtfIntraday, ETF_POLL_MS);
}

main();
