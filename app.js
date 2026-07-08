'use strict';

/* ============================================================
   全球資金流向儀表板 — 主程式
   資料源:
   - Frankfurter API(ECB 匯率,每交易日更新)→ 美元指數近似、USD/JPY、
     新興市場貨幣籃、區域資金流向
   - CoinGecko free API → BTC、加密總市值、BTC 市佔率、黃金代理(PAXG)
   - TradingView widget → DXY / 美債殖利率 / VIX / 各國股市即時報價
   原則:各資料源獨立抓取,單一來源失敗不影響其他區塊,
        重新抓取時保留前一次渲染(降透明度),不跳版。
   ============================================================ */

// ===== 常數設定 =====

// ICE 美元指數(DXY)權重,用 ECB 匯率計算近似值
const DXY_WEIGHTS = { EUR: 0.576, JPY: 0.136, GBP: 0.119, CAD: 0.091, SEK: 0.042, CHF: 0.036 };
const DXY_CONST = 50.14348112;

// 新興市場貨幣籃(等權幾何平均)
const EM_BASKET = ['KRW', 'INR', 'CNY', 'MXN', 'ZAR'];

// 區域資金流向圖的貨幣(ECB 有提供的清單;無 TWD)
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

const CRYPTO_POLL_MS = 60 * 1000;        // CoinGecko 每 60 秒
const FX_POLL_MS = 60 * 60 * 1000;       // ECB 一天更新一次,每小時輪詢即可

// ===== 全域狀態 =====
const state = {
  fxDates: [],      // 排序後的日期字串
  fxRates: null,    // { date: { EUR: .., JPY: .. } },base = USD
  btc: null,        // CoinGecko markets 的 bitcoin 項目
  gold: null,       // pax-gold 項目(黃金代理)
  global: null,     // CoinGecko /global
};

// ===== 小工具 =====
const $ = (sel) => document.querySelector(sel);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;  // 一律 textContent,不用 innerHTML 塞資料
  return node;
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

function fmtNum(n, maxDigits = 2, minDigits) {
  return n.toLocaleString('zh-TW', {
    maximumFractionDigits: maxDigits,
    minimumFractionDigits: minDigits ?? 0,
  });
}

// 價格:大數少小數、小數多位數
function fmtPrice(n) {
  if (n >= 1000) return fmtNum(n, 0);
  if (n >= 10) return fmtNum(n, 2, 2);
  return fmtNum(n, 4, 2);
}

// 大金額 → 兆 / 億(美元)
function fmtBigUSD(n) {
  if (n >= 1e12) return `$${fmtNum(n / 1e12, 2, 2)} 兆`;
  if (n >= 1e8) return `$${fmtNum(n / 1e8, 0)} 億`;
  return `$${fmtNum(n, 0)}`;
}

function fmtPct(n, digits = 2) {
  const s = n > 0 ? '+' : '';
  return `${s}${n.toFixed(digits)}%`;
}

function pctChange(from, to) { return (to / from - 1) * 100; }

// 把變化幅度換算成 -1 ~ +1 的分級訊號
function grade(chg, threshold) {
  return Math.max(-1, Math.min(1, chg / threshold));
}

function setStatus(dotId, tsId, ok) {
  const dot = $(dotId);
  dot.classList.toggle('ok', ok);
  dot.classList.toggle('err', !ok);
  if (ok) $(tsId).textContent = new Date().toLocaleTimeString('zh-TW', { hour12: false });
}

// ===== 共用 tooltip =====
const tooltip = $('#tooltip');

function showTooltip(lines, x, y) {
  // lines: [{ value, label }],value 為主、label 為輔
  tooltip.replaceChildren();
  for (const line of lines) {
    if (line.value) tooltip.appendChild(el('div', 'tt-value', line.value));
    if (line.label) tooltip.appendChild(el('div', 'tt-label', line.label));
  }
  tooltip.hidden = false;
  const pad = 14;
  const rect = tooltip.getBoundingClientRect();
  let left = x + pad;
  if (left + rect.width > window.innerWidth - 8) left = x - rect.width - pad;
  let top = y + pad;
  if (top + rect.height > window.innerHeight - 8) top = y - rect.height - pad;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideTooltip() { tooltip.hidden = true; }

// ===== 抓資料 =====

async function fetchFX() {
  const start = isoDate(new Date(Date.now() - 30 * 86400e3));
  const url = `https://api.frankfurter.dev/v1/${start}..?base=USD&symbols=${ALL_FX.join(',')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Frankfurter ${res.status}`);
  const data = await res.json();
  state.fxRates = data.rates;
  state.fxDates = Object.keys(data.rates).sort();
}

async function fetchCrypto() {
  const base = 'https://api.coingecko.com/api/v3';
  const [markets, global] = await Promise.all([
    fetch(`${base}/coins/markets?vs_currency=usd&ids=bitcoin,pax-gold&sparkline=true&price_change_percentage=24h,7d`)
      .then(r => { if (!r.ok) throw new Error(`CoinGecko ${r.status}`); return r.json(); }),
    fetch(`${base}/global`)
      .then(r => { if (!r.ok) throw new Error(`CoinGecko ${r.status}`); return r.json(); }),
  ]);
  state.btc = markets.find(c => c.id === 'bitcoin') || null;
  state.gold = markets.find(c => c.id === 'pax-gold') || null;
  state.global = global.data || null;
}

// ===== 衍生計算 =====

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

// 新興市場貨幣強弱指數:起日 = 100,上升 = EM 貨幣兌美元走強(資金流入傾向)
function emIndexSeries() {
  const first = state.fxRates[state.fxDates[0]];
  return state.fxDates.map(d => {
    const r = state.fxRates[d];
    let prod = 1;
    for (const cur of EM_BASKET) prod *= first[cur] / r[cur];
    return Math.pow(prod, 1 / EM_BASKET.length) * 100;
  });
}

// 各區域貨幣近 30 日兌美元升貶值 %(正 = 升值 = 資金流入傾向)
function regionChanges() {
  const first = state.fxRates[state.fxDates[0]];
  const last = state.fxRates[state.fxDates[state.fxDates.length - 1]];
  // 匯率是「每 1 美元換多少該貨幣」,數字變小 = 該貨幣升值
  return REGIONS.map(r => ({
    ...r,
    chg: (first[r.code] / last[r.code] - 1) * 100,
  })).sort((a, b) => b.chg - a.chg);
}

// ===== Sparkline(SVG 折線 + 10% 面積 + 端點)=====

function sparkline(values, dates, formatValue) {
  const W = 200, H = 36, PAD = 5;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const x = (i) => PAD + (i / (values.length - 1)) * (W - PAD * 2);
  const y = (v) => H - PAD - ((v - min) / span) * (H - PAD * 2);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.classList.add('tile-spark');

  const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  area.setAttribute('d', `M${pts[0]} L${pts.join(' L')} L${x(values.length - 1)},${H - PAD} L${x(0)},${H - PAD} Z`);
  area.setAttribute('fill', 'var(--series-blue)');
  area.setAttribute('opacity', '0.1');
  svg.appendChild(area);

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', pts.join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'var(--series-blue)');
  line.setAttribute('stroke-width', '2');
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(line);

  // 端點:8px 圓點 + 2px 表面色外環
  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', x(values.length - 1));
  dot.setAttribute('cy', y(values[values.length - 1]));
  dot.setAttribute('r', '4');
  dot.setAttribute('fill', 'var(--series-blue)');
  dot.setAttribute('stroke', 'var(--surface-1)');
  dot.setAttribute('stroke-width', '2');
  svg.appendChild(dot);

  // 游標線(hover 時顯示)
  const cursor = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  cursor.setAttribute('stroke', 'var(--baseline)');
  cursor.setAttribute('stroke-width', '1');
  cursor.setAttribute('y1', '0');
  cursor.setAttribute('y2', String(H));
  cursor.setAttribute('visibility', 'hidden');
  svg.appendChild(cursor);

  // 十字游標:吸附最近的資料點,顯示日期 + 數值
  svg.addEventListener('pointermove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const relX = ((ev.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((relX - PAD) / (W - PAD * 2)) * (values.length - 1));
    const idx = Math.max(0, Math.min(values.length - 1, i));
    cursor.setAttribute('x1', x(idx));
    cursor.setAttribute('x2', x(idx));
    cursor.setAttribute('visibility', 'visible');
    showTooltip(
      [{ value: formatValue(values[idx]), label: dates[idx] }],
      ev.clientX, ev.clientY
    );
  });
  svg.addEventListener('pointerleave', () => {
    cursor.setAttribute('visibility', 'hidden');
    hideTooltip();
  });

  return svg;
}

// ===== 指標卡片 =====

function makeTile({ label, value, deltaPct, deltaPeriod, spark, note }) {
  const tile = el('div', 'tile');
  tile.appendChild(el('div', 'tile-label', label));
  tile.appendChild(el('div', 'tile-value', value));

  if (deltaPct !== undefined && deltaPct !== null) {
    const d = el('div', 'tile-delta');
    const cls = deltaPct > 0.005 ? 'up' : deltaPct < -0.005 ? 'down' : 'flat';
    d.appendChild(el('span', cls, fmtPct(deltaPct)));
    d.appendChild(el('span', 'period', ` vs ${deltaPeriod}`));
    tile.appendChild(d);
  }
  if (spark) tile.appendChild(spark);
  if (note) tile.appendChild(el('div', 'tile-note', note));
  return tile;
}

function renderTiles() {
  const grid = $('#tile-grid');
  const tiles = [];

  // --- 匯率類 ---
  if (state.fxRates) {
    const dxy = dxySeries();
    tiles.push(makeTile({
      label: '美元指數(近似)',
      value: fmtNum(dxy[dxy.length - 1], 1, 1),
      deltaPct: pctChange(dxy[0], dxy[dxy.length - 1]),
      deltaPeriod: '30 日前',
      spark: sparkline(dxy, state.fxDates, v => fmtNum(v, 2, 2)),
      note: '由 ECB 匯率籃計算,升 = 資金回流美元',
    }));

    const jpy = fxSeries('JPY');
    tiles.push(makeTile({
      label: 'USD/JPY(套利交易溫度計)',
      value: fmtNum(jpy[jpy.length - 1], 2, 2),
      deltaPct: pctChange(jpy[0], jpy[jpy.length - 1]),
      deltaPeriod: '30 日前',
      spark: sparkline(jpy, state.fxDates, v => fmtNum(v, 2, 2)),
      note: '升 = 借日圓買風險資產的套利活絡',
    }));

    const em = emIndexSeries();
    tiles.push(makeTile({
      label: '新興市場貨幣籃',
      value: fmtNum(em[em.length - 1], 1, 1),
      deltaPct: em[em.length - 1] - 100,
      deltaPeriod: '30 日前(=100)',
      spark: sparkline(em, state.fxDates, v => fmtNum(v, 2, 2)),
      note: 'KRW·INR·CNY·MXN·ZAR,升 = 熱錢流入新興市場',
    }));
  }

  // --- 加密貨幣類 ---
  if (state.btc) {
    const sparkVals = state.btc.sparkline_in_7d?.price || [];
    const sparkDates = sparkVals.map((_, i) => {
      const t = new Date(Date.now() - (sparkVals.length - 1 - i) * 3600e3);
      return t.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: 'numeric', hour12: false });
    });
    tiles.push(makeTile({
      label: '比特幣 BTC',
      value: `$${fmtPrice(state.btc.current_price)}`,
      deltaPct: state.btc.price_change_percentage_24h_in_currency,
      deltaPeriod: '24 小時前',
      spark: sparkVals.length ? sparkline(sparkVals, sparkDates, v => `$${fmtPrice(v)}`) : null,
      note: '投機熱錢風險偏好的最前緣指標',
    }));
  }

  if (state.global) {
    tiles.push(makeTile({
      label: '加密貨幣總市值',
      value: fmtBigUSD(state.global.total_market_cap.usd),
      deltaPct: state.global.market_cap_change_percentage_24h_usd,
      deltaPeriod: '24 小時前',
      note: '升 = 熱錢流入加密市場',
    }));
    tiles.push(makeTile({
      label: 'BTC 市佔率(Dominance)',
      value: `${fmtNum(state.global.market_cap_percentage.btc, 1, 1)}%`,
      note: '升 = 加密圈內資金往 BTC 集中(圈內避險)',
    }));
  }

  if (state.gold) {
    const sparkVals = state.gold.sparkline_in_7d?.price || [];
    const sparkDates = sparkVals.map((_, i) => {
      const t = new Date(Date.now() - (sparkVals.length - 1 - i) * 3600e3);
      return t.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: 'numeric', hour12: false });
    });
    tiles.push(makeTile({
      label: '黃金(PAXG 代理)',
      value: `$${fmtPrice(state.gold.current_price)}`,
      deltaPct: state.gold.price_change_percentage_24h_in_currency,
      deltaPeriod: '24 小時前',
      spark: sparkVals.length ? sparkline(sparkVals, sparkDates, v => `$${fmtPrice(v)}`) : null,
      note: '升且股市跌 = 避險買盤進場',
    }));
  }

  if (tiles.length) grid.replaceChildren(...tiles);
}

// ===== 資金流向判讀 =====

function computeSignals() {
  const signals = [];

  if (state.fxRates) {
    const dxy = dxySeries();
    const dxyChg = pctChange(dxy[0], dxy[dxy.length - 1]);
    signals.push({
      name: '美元指數(30日)',
      read: `${fmtPct(dxyChg)},${dxyChg > 0.3 ? '資金回流美元(避險)' : dxyChg < -0.3 ? '資金流出美元、尋找風險資產' : '美元持平'}`,
      dir: -grade(dxyChg, 1.5),   // 美元走強 = 避險
      weight: 2,
    });

    const jpy = fxSeries('JPY');
    const jpyChg = pctChange(jpy[0], jpy[jpy.length - 1]);
    signals.push({
      name: 'USD/JPY(30日)',
      read: `${fmtPct(jpyChg)},${jpyChg > 0.5 ? '日圓套利活絡(風險偏好)' : jpyChg < -0.5 ? '套利平倉、資金回流日圓(避險)' : '持平'}`,
      dir: grade(jpyChg, 2),
      weight: 1.5,
    });

    const em = emIndexSeries();
    const emChg = em[em.length - 1] - 100;
    signals.push({
      name: '新興市場貨幣(30日)',
      read: `${fmtPct(emChg)},${emChg > 0.3 ? '熱錢流入新興市場' : emChg < -0.3 ? '熱錢撤出新興市場' : '持平'}`,
      dir: grade(emChg, 1),
      weight: 2,
    });
  }

  if (state.btc) {
    const btc7 = state.btc.price_change_percentage_7d_in_currency ?? 0;
    signals.push({
      name: 'BTC(7日)',
      read: `${fmtPct(btc7)},${btc7 > 2 ? '投機資金進場' : btc7 < -2 ? '投機資金退潮' : '觀望'}`,
      dir: grade(btc7, 6),
      weight: 1.5,
    });
  }

  if (state.global) {
    const mcap24 = state.global.market_cap_change_percentage_24h_usd ?? 0;
    signals.push({
      name: '加密總市值(24時)',
      read: `${fmtPct(mcap24)},${mcap24 > 1 ? '短線熱錢流入' : mcap24 < -1 ? '短線熱錢流出' : '持平'}`,
      dir: grade(mcap24, 2.5),
      weight: 1,
    });
  }

  if (state.btc && state.gold) {
    const btc7 = state.btc.price_change_percentage_7d_in_currency ?? 0;
    const gold7 = state.gold.price_change_percentage_7d_in_currency ?? 0;
    const diff = btc7 - gold7;
    signals.push({
      name: 'BTC vs 黃金(7日)',
      read: `${fmtPct(diff)},${diff > 1 ? '風險資產跑贏避險資產' : diff < -1 ? '避險資產跑贏風險資產' : '相當'}`,
      dir: grade(diff, 5),
      weight: 1,
    });
  }

  return signals;
}

function renderVerdict() {
  const signals = computeSignals();
  if (!signals.length) return;

  const totalW = signals.reduce((s, x) => s + x.weight, 0);
  const score = Math.round(signals.reduce((s, x) => s + x.dir * x.weight, 0) / totalW * 100);

  let verdict, tone;
  if (score >= 25)       { verdict = 'RISK-ON 風險偏好'; tone = '資金正流向風險資產'; }
  else if (score >= 8)   { verdict = '中性偏風險'; tone = '資金溫和流向風險資產'; }
  else if (score > -8)   { verdict = '中性觀望'; tone = '資金沒有明顯的單一方向'; }
  else if (score > -25)  { verdict = '中性偏避險'; tone = '資金溫和轉向避險資產'; }
  else                   { verdict = 'RISK-OFF 避險'; tone = '資金正撤向美元、日圓等避險資產'; }

  const hero = $('#verdict-text');
  hero.replaceChildren(
    document.createTextNode(verdict + ' '),
    el('span', 'score', `${score > 0 ? '+' : ''}${score}`)
  );

  // 分數計:-100(左)~ +100(右)
  $('#meter-marker').style.left = `${50 + score / 2}%`;

  // 摘要句:從區域變化挑出流入/流出最明顯的區域
  let summary = tone + '。';
  if (state.fxRates) {
    const regions = regionChanges();
    const inflow = regions.filter(r => r.chg > 0.3).slice(0, 3).map(r => r.name);
    const outflow = regions.filter(r => r.chg < -0.3).slice(-3).map(r => r.name);
    if (inflow.length) summary += `近 30 日資金傾向流入:${inflow.join('、')}。`;
    if (outflow.length) summary += `傾向流出:${outflow.join('、')}。`;
  }
  $('#verdict-summary').textContent = summary;

  // 訊號清單
  const list = $('#signal-list');
  list.replaceChildren(...signals.map(sig => {
    const li = el('li');
    li.appendChild(el('span', 'signal-name', sig.name));
    li.appendChild(el('span', 'signal-read', sig.read));
    const chipCls = sig.dir > 0.15 ? 'pos' : sig.dir < -0.15 ? 'neg' : '';
    const chipTxt = sig.dir > 0.15 ? '↑ 推升風險偏好' : sig.dir < -0.15 ? '↓ 偏向避險' : '— 中性';
    li.appendChild(el('span', `signal-chip ${chipCls}`, chipTxt));
    return li;
  }));
}

// ===== 區域資金流向圖 =====

function renderRegions() {
  if (!state.fxRates) return;
  const regions = regionChanges();
  const maxAbs = Math.max(0.5, ...regions.map(r => Math.abs(r.chg)));

  // --- 圖表 ---
  const chart = $('#region-chart');
  const rows = regions.map(r => {
    const row = el('div', 'flow-row');
    row.appendChild(el('div', 'flow-name', r.name));

    const track = el('div', 'flow-track');
    track.appendChild(el('div', 'flow-center'));

    const widthPct = Math.abs(r.chg) / maxAbs * 42;  // 每側最多佔 42%,留空間給數值標籤
    const pos = r.chg >= 0;
    const bar = el('div', `flow-bar ${pos ? 'pos' : 'neg'}`);
    bar.style.left = pos ? '50%' : `${50 - widthPct}%`;
    bar.style.width = `${widthPct}%`;
    bar.tabIndex = 0;
    bar.appendChild(el('div', 'fill'));

    const meaning = pos ? '貨幣升值 → 資金流入傾向' : '貨幣貶值 → 資金流出傾向';
    const ttLines = [
      { value: `${fmtPct(r.chg)}(近 30 日)` },
      { label: `${r.name} · ${r.pair}` },
      { label: meaning },
    ];
    bar.addEventListener('pointermove', (ev) => showTooltip(ttLines, ev.clientX, ev.clientY));
    bar.addEventListener('pointerleave', hideTooltip);
    bar.addEventListener('focus', () => {
      const rect = bar.getBoundingClientRect();
      showTooltip(ttLines, rect.right, rect.top);
    });
    bar.addEventListener('blur', hideTooltip);
    track.appendChild(bar);

    // 數值標籤放在條的資料端外側
    const val = el('span', 'flow-value', fmtPct(r.chg, 1));
    if (pos) val.style.left = `calc(${50 + widthPct}% + 6px)`;
    else val.style.right = `calc(${50 + widthPct}% + 6px)`;
    track.appendChild(val);

    row.appendChild(track);
    return row;
  });

  // 底部刻度
  const axis = el('div', 'flow-axis');
  axis.appendChild(el('div'));
  const ticks = el('div', 'ticks');
  ticks.appendChild(el('span', null, `-${maxAbs.toFixed(1)}%`));
  ticks.appendChild(el('span', null, '0'));
  ticks.appendChild(el('span', null, `+${maxAbs.toFixed(1)}%`));
  axis.appendChild(ticks);

  chart.replaceChildren(...rows, axis);

  // --- 表格檢視(等價版本) ---
  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['區域', '貨幣對', '近 30 日變化', '判讀']) hr.appendChild(el('th', null, h));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const r of regions) {
    const tr = el('tr');
    tr.appendChild(el('td', null, r.name));
    tr.appendChild(el('td', null, r.pair));
    const td = el('td', 'num', fmtPct(r.chg));
    tr.appendChild(td);
    tr.appendChild(el('td', null, r.chg >= 0.3 ? '資金流入傾向' : r.chg <= -0.3 ? '資金流出傾向' : '中性'));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  $('#region-table').replaceChildren(table);
}

// 圖表 / 表格切換
function initViewToggle() {
  const btnChart = $('#btn-chart-view');
  const btnTable = $('#btn-table-view');
  const setView = (showTable) => {
    $('#region-chart').hidden = showTable;
    $('#region-table').hidden = !showTable;
    btnChart.classList.toggle('active', !showTable);
    btnTable.classList.toggle('active', showTable);
    btnChart.setAttribute('aria-pressed', String(!showTable));
    btnTable.setAttribute('aria-pressed', String(showTable));
  };
  btnChart.addEventListener('click', () => setView(false));
  btnTable.addEventListener('click', () => setView(true));
}

// ===== TradingView widget(即時行情)=====

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
          { s: 'TVC:USOIL', d: 'WTI 原油' },
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
    ],
  });
  wrap.appendChild(script);
  container.appendChild(wrap);
}

// ===== 更新流程 =====

function renderAll() {
  renderTiles();
  renderVerdict();
  renderRegions();
}

async function refreshFX() {
  const card = $('#region-card');
  card.classList.add('refreshing');
  try {
    await fetchFX();
    setStatus('#dot-fx', '#ts-fx', true);
  } catch (err) {
    console.error('匯率資料抓取失敗:', err);
    setStatus('#dot-fx', '#ts-fx', false);
  } finally {
    card.classList.remove('refreshing');
    renderAll();
  }
}

let cryptoRetryTimer = null;

async function refreshCrypto() {
  try {
    await fetchCrypto();
    setStatus('#dot-crypto', '#ts-crypto', true);
  } catch (err) {
    console.error('加密貨幣資料抓取失敗:', err);
    setStatus('#dot-crypto', '#ts-crypto', false);
    // 常見是 429(rate limit):30 秒後重試一次,不疊加多個計時器
    if (!cryptoRetryTimer) {
      cryptoRetryTimer = setTimeout(() => {
        cryptoRetryTimer = null;
        refreshCrypto();
      }, 30 * 1000);
    }
  } finally {
    renderAll();
  }
}

async function refreshAll() {
  const btn = $('#refresh-btn');
  btn.disabled = true;
  await Promise.allSettled([refreshFX(), refreshCrypto()]);
  btn.disabled = false;
}

// ===== 啟動 =====

function main() {
  initViewToggle();
  $('#refresh-btn').addEventListener('click', refreshAll);

  refreshAll();
  setInterval(refreshCrypto, CRYPTO_POLL_MS);
  setInterval(refreshFX, FX_POLL_MS);

  mountTradingView();
  // 深淺色主題切換時重掛 TradingView(widget 的主題在載入時就固定了)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', mountTradingView);
}

main();
