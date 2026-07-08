'use strict';

/* ============================================================
   全球資金流向儀表板 — 主程式(D3.js 版)
   資料源:
   - Frankfurter API(ECB 匯率,每交易日更新)→ 美元指數近似、日圓、
     新興市場貨幣籃、區域資金流向(抓 92 天,供最長 12 週熱力圖)
   - CoinGecko market_chart(days=95,回日資料)→ BTC / ETH / 黃金(PAXG)
   - TWSE rwd API → 台灣加權指數(本月 + 前三個月的每日收盤)
   - TradingView scanner → 原油、銅、綠能(ICLN)、AI(AIQ)即時報價與
     近一週/近一月表現;美債 2Y/10Y/30Y 殖利率
   - TradingView widget → DXY / VIX / 各國股市 / 加密與 AI 即時報價
   原則:各資料源獨立抓取,單一來源失敗不影響其他區塊;
        重新抓取時保留前一次渲染(降透明度),不跳版。
   ============================================================ */

// ===== 常數設定 =====

// ICE 美元指數(DXY)權重,用 ECB 匯率計算近似值
const DXY_WEIGHTS = { EUR: 0.576, JPY: 0.136, GBP: 0.119, CAD: 0.091, SEK: 0.042, CHF: 0.036 };
const DXY_CONST = 50.14348112;

// 新興市場貨幣籃(等權幾何平均)
const EM_BASKET = ['KRW', 'INR', 'CNY', 'MXN', 'ZAR'];

// 區域資金流向的貨幣(ECB 有提供的清單;無 TWD)
const REGIONS = [
  { code: 'EUR', name: '歐元區', pair: 'EUR/USD' },
  { code: 'JPY', name: '日本',   pair: 'USD/JPY' },
  { code: 'GBP', name: '英國',   pair: 'GBP/USD' },
  { code: 'CHF', name: '瑞士',   pair: 'USD/CHF' },
  { code: 'AUD', name: '澳洲',   pair: 'AUD/USD' },
  { code: 'CNY', name: '中國',   pair: 'USD/CNY' },
  { code: 'KRW', name: '南韓',   pair: 'USD/KRW' },
  { code: 'INR', name: '印度',   pair: 'USD/INR' },
  { code: 'MXN', name: '墨西哥', pair: 'USD/MXN' },
  { code: 'ZAR', name: '南非',   pair: 'USD/ZAR' },
];

const ALL_FX = [...new Set([...Object.keys(DXY_WEIGHTS), ...EM_BASKET, ...REGIONS.map(r => r.code)])];

// TradingView scanner:資產流向用(即期價 + 近一週/近一月表現;
// 更早的逐週資料靠 localStorage 跨日累積,初期會缺格)
const SCANNER_FLOWS = [
  { sym: 'NYMEX:CL1!',   ep: 'futures', name: '原油 WTI' },
  { sym: 'OANDA:XCUUSD', ep: 'global',  name: '銅(綠色通膨)' },
  { sym: 'NASDAQ:ICLN',  ep: 'global',  name: '綠能(ICLN)' },
  { sym: 'NASDAQ:AIQ',   ep: 'global',  name: 'AI(AIQ)' },
];

// 美債殖利率(scanner 同一批抓)
const BOND_TENORS = [
  { sym: 'TVC:US02Y', label: '2 年',  short: '2Y' },
  { sym: 'TVC:US10Y', label: '10 年', short: '10Y' },
  { sym: 'TVC:US30Y', label: '30 年', short: '30Y' },
];

const SCANNER_ALL = [
  ...SCANNER_FLOWS,
  ...BOND_TENORS.map(t => ({ sym: t.sym, ep: 'global', name: `美債 ${t.label}` })),
];

const FX_POLL_MS = 60 * 60 * 1000;       // ECB 一天更新一次,每小時輪詢即可
const TAIEX_POLL_MS = 60 * 60 * 1000;    // TWSE 盤後資料,每小時輪詢即可
const SCANNER_POLL_MS = 2 * 60 * 1000;   // scanner 非官方 API,保守輪詢
const HISTORY_POLL_MS = 60 * 60 * 1000;  // CoinGecko 歷史,每小時

const DAY_MS = 86400e3;

// ===== 全域狀態 =====
const state = {
  fxDates: [],      // 排序後的日期字串
  fxRates: null,    // { date: { EUR: .., JPY: .. } },base = USD
  taiex: [],        // TWSE 日收盤 [{ date, value, chg }]
  scanner: null,    // { sym: { close, change, perfW, perf1M } }
  cryptoHist: null, // { coinId: [{ date, value }] } 95 日日收盤
};

// 介面狀態:兩張熱力圖各自的觀察週數與檢視模式
const ui = {
  assetWeeks: 4,  assetView: 'chart',
  regionWeeks: 4, regionView: 'chart',
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

// 台股加權指數:TWSE 市場成交資訊(本月 + 前三個月,供 12 週熱力圖)
async function fetchTaiex() {
  const now = new Date();
  const months = [3, 2, 1, 0].map(k => new Date(now.getFullYear(), now.getMonth() - k, 1));
  const results = await Promise.all(months.map(d => {
    const ym = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}01`;
    return fetch(`https://www.twse.com.tw/rwd/zh/afterTrading/FMTQIK?date=${ym}&response=json`)
      .then(r => { if (!r.ok) throw new Error(`TWSE ${r.status}`); return r.json(); });
  }));
  const rows = [];
  for (const res of results) {
    if (res.stat !== 'OK' || !Array.isArray(res.data)) continue;  // 月初可能尚無本月資料
    for (const row of res.data) {
      // 日期是民國年(115/07/01),數值含千分位逗號
      const [y, m, d] = String(row[0]).split('/').map(Number);
      const value = Number(String(row[4]).replace(/,/g, ''));
      if (!Number.isFinite(value)) continue;
      rows.push({
        date: `${y + 1911}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        value,
      });
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) throw new Error('TWSE 無資料');
  state.taiex = rows;
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
  if (state.taiex.length) add('台股加權指數', state.taiex, 'TWSE');
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
  if (!state.fxRates) return [];
  const rows = REGIONS.map(r => ({
    name: r.name,
    src: r.pair,
    cells: weeklyChanges(toSeries(state.fxDates, fxSeries(r.code).map(v => 1 / v)), nWeeks),
  }));
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
  pat.append('rect').attr('width', 6).attr('height', 6).attr('fill', cMid);
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
      g.append('rect').attr('width', 6).attr('height', 6).attr('fill', cMid);
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

function renderAssetCard() {
  const rows = assetRows(ui.assetWeeks);
  if (!rows.length) return;
  $('#asset-summary').textContent = flowSummary(rows, '本週資金停泊處', '本週撤出');
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

// ===== 美債長短天期趨勢卡 =====

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

// 牛陡/熊陡/牛平/熊平 + 資金含義
function renderBondRead(data) {
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

  p.replaceChildren(
    el('span', 'bond-tag', tag),
    document.createTextNode(`${text}${spreadBp < 0 ? ' ' : ' '}`),
    el('span', spreadBp < 0 ? 'warn' : '', spreadText),
    document.createTextNode(' 一週前與一月前為以 TradingView 表現欄位反推的估值。'),
  );
}

function renderBondCard() {
  const data = bondPoints();
  if (!data) return;
  renderBondChart(data);
  renderBondStats(data);
  renderBondRead(data);
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
          { s: 'TWSE:IND', d: '台灣加權' },
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
  renderAssetCard();
  renderRegionCard();
  renderBondCard();
}

async function refreshFX() {
  const card = $('#region-card');
  card.classList.add('refreshing');
  try {
    await fetchFX();
    setStatus('dot-fx', 'ts-fx', true);
  } catch (e) {
    console.error('FX 更新失敗:', e);
    setStatus('dot-fx', 'ts-fx', false);
  } finally {
    card.classList.remove('refreshing');
    renderAll();
  }
}

async function refreshTaiex() {
  try {
    await fetchTaiex();
    setStatus('dot-taiex', 'ts-taiex', true);
  } catch (e) {
    console.error('台股更新失敗:', e);
    setStatus('dot-taiex', 'ts-taiex', false);
  } finally {
    renderAll();
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
  await Promise.allSettled([refreshFX(), refreshTaiex(), refreshScanner()]);
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
  setInterval(refreshTaiex, TAIEX_POLL_MS);
  setInterval(refreshScanner, SCANNER_POLL_MS);
  setInterval(refreshCryptoHistory, HISTORY_POLL_MS);
}

main();
