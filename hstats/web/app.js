/* hstats 网页端。零依赖：图表全是手写 SVG，与桌面版同一思路——
   少一层依赖就少一处「环境变了图就画不出来」的风险。 */

const $ = (s, r = document) => r.querySelector(s);
/* el() 的关键约定：
   - text  → 走 textContent（元素内容）
   - html  → 走 innerHTML（要放标签时）
   - 其他  → setAttribute（class/id/style/data-* 等）
   踩过的坑：早先用 setAttribute('text', ...) 给所有节点塞文案，结果 text
   变成了一个无名的 HTML 属性，页面上一个数字都看不到。以后新增属性一律
   先确认它该走哪条路。 */
const el = (t, a = {}, kids = []) => {
  const n = document.createElement(t);
  for (const [k, v] of Object.entries(a)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v == null ? '' : String(v);
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) if (c != null) n.append(c);
  return n;
};
const SVGNS = 'http://www.w3.org/2000/svg';
const sv = (t, a = {}, kids = []) => {
  const n = document.createElementNS(SVGNS, t);
  for (const [k, v] of Object.entries(a)) if (v !== null && v !== undefined) n.setAttribute(k, v);
  for (const c of [].concat(kids)) if (c != null) n.append(c);
  return n;
};

/* ── 格式化：数字与单位混排处最容易出错，统一走这里 ────────── */
const fmtInt = n => Math.round(n || 0).toLocaleString('en-US');
function fmtTok(n) {
  n = n || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'K';
  return String(Math.round(n));
}
/* 汇率拿不到时退回 USD 并明示，而不是拿一个猜的常数折成 ¥——
   猜出来的「人民币金额」比诚实的美元数字更糟。 */
function fmtMoney(usd, rate) {
  if (usd == null || !Number.isFinite(usd)) return '—';
  if (rate == null || !Number.isFinite(rate)) return '$' + usd.toFixed(2);
  const v = usd * rate;
  // 小额也要两位：¥0.248 和 ¥170 混排会让表格宽度跳来跳去
  return '¥' + (v >= 1000 ? v.toFixed(0) : v.toFixed(2));
}
const fmtUsd = n => '$' + (n ?? 0).toFixed(4);
const pct = n => (n * 100).toFixed(1) + '%';

/* ── tooltip ─────────────────────────────────────────────── */
const tip = el('div', { class: 'tip' });
document.body.append(tip);
function showTip(e, html) {
  tip.innerHTML = html;
  tip.classList.add('on');
  const r = tip.getBoundingClientRect();
  let x = e.clientX + 14, y = e.clientY - r.height - 10;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
  if (y < 8) y = e.clientY + 16;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}
const hideTip = () => tip.classList.remove('on');

/* ── 图表：柱状 ──────────────────────────────────────────── */
function barChart(rows, { h = 200, color = 'var(--green)', fmt = fmtTok, label = '', zeroIsZero = false } = {}) {
  const W = 1000, PL = 56, PR = 8, PT = 12, PB = 22;
  const n = rows.length || 1;
  const max = Math.max(...rows.map(r => r.v), 1);
  // 4 条水平网格线足够定位，太多就成了噪音
  const ticks = [0, .25, .5, .75, 1].map(p => p * max);
  const iw = W - PL - PR, ih = h - PT - PB;
  const slot = iw / n, bw = Math.max(1, Math.min(slot - 2, slot * 0.62));

  const svg = sv('svg', { class: 'chart', viewBox: `0 0 ${W} ${h}`, style: `height:${h}px` });
  ticks.forEach(t => {
    const y = PT + ih - (t / max) * ih;
    svg.append(sv('line', { class: 'gl', x1: PL, x2: W - PR, y1: y, y2: y }));
    svg.append(sv('text', { x: PL - 8, y: y + 3, 'text-anchor': 'end' }, [document.createTextNode(fmt(t))]));
  });
  rows.forEach((r, i) => {
    // 值为 0 时不画「1px 假柱子」——那会被误读成每天都有小额消费
    if (!r.v && zeroIsZero) {
      const hit0 = sv('rect', { class: 'hit', x: PL + slot * i, y: PT, width: slot, height: ih });
      hit0.addEventListener('mousemove', e => showTip(e,
        `<div class="t-d">${r.k}</div><b>${fmt(0)}</b>`));
      hit0.addEventListener('mouseleave', hideTip);
      svg.append(hit0);
      return;
    }
    const bh = Math.max(1, (r.v / max) * ih);
    const x = PL + slot * i + (slot - bw) / 2;
    const y = PT + ih - bh;
    const g = sv('g');
    g.append(sv('rect', { class: 'bar-i' + (r.c2 ? ' alt' : ''), x, y, width: bw, height: bh, rx: 2 }));
    // 透明热区：柱子太窄时不好悬停
    const hit = sv('rect', { class: 'hit', x: PL + slot * i, y: PT, width: slot, height: ih });
    hit.addEventListener('mousemove', e => showTip(e,
      `<div class="t-d">${r.k}</div><b>${fmt(r.v)}</b>${r.sub ? `<div class="t-d">${r.sub}</div>` : ''}`));
    hit.addEventListener('mouseleave', hideTip);
    g.append(hit);
    svg.append(g);
  });
  // x 轴标签：最多 6 个，避免糊成一片
  const step = Math.max(1, Math.ceil(n / 6));
  rows.forEach((r, i) => {
    if (i % step) return;
    svg.append(sv('text', { x: PL + slot * i + slot / 2, y: h - 6, 'text-anchor': 'middle' },
      [document.createTextNode(r.k)]));
  });
  if (label) svg.append(sv('title', {}, [document.createTextNode(label)]));
  return svg;
}

/* ── 图表：折线+面积 ──────────────────────────────────────── */
function areaChart(rows, { h = 200, log = false, color = 'var(--green)', unit = '' } = {}) {
  const W = 1000, PL = 56, PR = 8, PT = 12, PB = 22;
  const n = rows.length || 1;
  const vals = rows.map(r => r.v);
  const max = Math.max(...vals, 1);

  /* 对数刻度：0 在对数轴上无意义，统一抬到 1。刻度**必须**在对数空间等距，
     否则会出现「标题写对数、刻度却是等差」的误导（踩过一次：
     刻度按 min+(max-min)*p 算，那是线性的）。 */
  const lo = log ? Math.max(Math.min(...vals.filter(v => v > 0), max), 1) : 0;
  const loT = log ? Math.log10(lo) : lo;
  const hiT = log ? Math.log10(Math.max(max, lo * 10)) : max;
  const tf = v => (log ? Math.log10(Math.max(v, 1)) : v);
  const norm = v => (tf(v) - loT) / Math.max(hiT - loT, 1e-9);

  const iw = W - PL - PR, ih = h - PT - PB;
  const x = i => PL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = v => PT + ih - norm(v) * ih;

  const svg = sv('svg', { class: 'chart', viewBox: `0 0 ${W} ${h}`, style: `height:${h}px` });
  // 刻度在对数空间等距：每档 ×10 的整数次幂
  const ticks = log
    ? Array.from({ length: 5 }, (_, i) => Math.pow(10, loT + ((hiT - loT) * i) / 4))
    : [0, .25, .5, .75, 1].map(p => p * max);
  ticks.forEach(t => {
    const yy = y(t);
    if (yy < PT - 1 || yy > PT + ih + 1) return;            // 越界的刻度不画
    svg.append(sv('line', { class: 'gl', x1: PL, x2: W - PR, y1: yy, y2: yy }));
    svg.append(sv('text', { x: PL - 8, y: yy + 3, 'text-anchor': 'end' },
      [document.createTextNode(unit + fmtTok(t))]));
  });

  const defs = sv('defs');
  const g1 = sv('linearGradient', { id: 'gA', x1: 0, y1: 0, x2: 0, y2: 1 });
  // 渐变用 currentColor 取不到 CSS 变量，直接给色值
  const rgb = color.includes('teal') ? '15,155,142' : '31,157,85';
  g1.append(sv('stop', { offset: '0%', 'stop-color': `rgb(${rgb})`, 'stop-opacity': .26 }));
  g1.append(sv('stop', { offset: '100%', 'stop-color': `rgb(${rgb})`, 'stop-opacity': .02 }));
  defs.append(g1); svg.append(defs);

  if (n > 1) {
    const d = rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r.v).toFixed(1)}`).join(' ');
    svg.append(sv('path', { class: 'area', d: `${d} L${x(n - 1)},${PT + ih} L${PL},${PT + ih} Z` }));
    svg.append(sv('path', { class: 'line', d, style: `stroke:${color}` }));
  }
  const iw2 = iw / n;
  rows.forEach((r, i) => {
    const hit = sv('rect', { class: 'hit', x: PL + iw2 * i, y: PT, width: iw2, height: ih });
    hit.addEventListener('mousemove', e => showTip(e,
      `<div class="t-d">${r.k}</div><b>${unit}${fmtTok(r.v)}</b>${r.sub ? `<div class="t-d">${r.sub}</div>` : ''}`));
    hit.addEventListener('mouseleave', hideTip);
    svg.append(hit);
  });
  const step = Math.max(1, Math.ceil(n / 6));
  rows.forEach((r, i) => {
    if (i % step) return;
    svg.append(sv('text', { x: x(i), y: h - 6, 'text-anchor': 'middle' },
      [document.createTextNode(r.k)]));
  });
  return svg;
}

/* ── 图表：堆叠横条（按来源/任务占比）───────────────────────── */
function hBars(rows, { fmt = fmtTok, full = false } = {}) {
  const max = Math.max(...rows.map(r => r.v), 1);
  const box = el('div', { style: 'display:flex;flex-direction:column;gap:10px' });
  rows.forEach((r, i) => box.append(el('div', {
    style: `display:grid;grid-template-columns:${full ? '210px' : '150px'} 1fr 96px;gap:12px;align-items:center`
  }, [
    el('span', { style: 'font-size:12px;color:var(--fg-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
                 text: r.k, title: r.k }),
    // 小到不足 2% 就不画条了：一排看不见的细线只会让人以为是空数据
    (r.v / max < 0.02)
      ? el('div', { class: 'dim', style: 'font-size:11px' }, [el('span', { text: '·' })])
      : el('div', { class: 'bar' + (r.c2 ? ' alt' : '') },
          [el('i', { style: `width:${(r.v / max * 100).toFixed(1)}%` })]),
    el('span', { class: 'mono', style: 'font-size:12px;text-align:right;color:var(--fg)',
                 text: fmt(r.v) + (r.pct != null ? ` · ${r.pct.toFixed(1)}%` : '') }),
  ])));
  return box;
}

/* ── 图表：饼图 ──────────────────────────────────────────
   用于「部分与整体」的占比：来源、任务、模型这三组天然是构成关系，
   饼图比一排横条更容易看出「谁是大头」。类别数超过 6 就改回横条——
   再多的扇区就没人能一眼分辨了。 */
function pieChart(rows, { size = 190 } = {}) {
  const PALETTE = ['var(--green)', 'var(--green-2)', 'var(--teal)',
                   'var(--lime)', '#6aa84f', '#8fbc8f', '#b7d7a8'];
  const total = rows.reduce((a, r) => a + r.v, 0);
  if (!total) return el('div', { class: 'fn', text: '无数据' });

  const S = 220, C = S / 2, R = C - 6, r0 = R * 0.55;
  const svg = sv('svg', { class: 'chart', viewBox: `0 0 ${S} ${S}`,
                          style: `width:${size}px;height:${size}px;flex:0 0 auto` });
  let a0 = -Math.PI / 2;
  rows.forEach((r, i) => {
    const frac = r.v / total;
    const a1 = a0 + frac * Math.PI * 2;
    const big = a1 - a0 > Math.PI ? 1 : 0;
    // 环形用两段弧拼：path 描述外弧→内弧，能画出真正的环
    const p = (rad, ang) => `${(C + rad * Math.cos(ang)).toFixed(2)} ${(C + rad * Math.sin(ang)).toFixed(2)}`;
    const d = `M ${p(R, a0)} A ${R} ${R} 0 ${big} 1 ${p(R, a1)} ` +
              `L ${p(r0, a1)} A ${r0} ${r0} 0 ${big} 0 ${p(r0, a0)} Z`;
    const seg = sv('path', { class: 'pie-seg', d, fill: PALETTE[i % PALETTE.length] });
    seg.addEventListener('mousemove', e => showTip(e,
      `<div class="t-d">${r.k}</div><b>${fmtTok(r.v)}</b>` +
      `<div class="t-d">${(frac * 100).toFixed(1)}%${r.sub ? ' · ' + r.sub : ''}</div>`));
    seg.addEventListener('mouseleave', hideTip);
    svg.append(seg);
    a0 = a1;
  });
  // 圆心写总量（上面那个 rowsTitle 是笔误，这里直接显示数字）
  svg.append(sv('text', { x: C, y: C + 5, 'text-anchor': 'middle',
                          style: 'font-size:17px;font-weight:700;fill:var(--fg)' },
    [document.createTextNode(fmtTok(total))]));
  svg.append(sv('text', { x: C, y: C + 21, 'text-anchor': 'middle',
                          style: 'font-size:10.5px;fill:var(--fg-3)' },
    [document.createTextNode('合计')]));

  const legend = el('div', { class: 'pie-legend' });
  rows.forEach((r, i) => legend.append(el('div', { class: 'li' }, [
    el('span', { class: 'sw', style: `background:${PALETTE[i % PALETTE.length]}` }),
    el('span', { class: 'nm', text: r.k, title: r.k }),
    el('span', { class: 'vl', text: fmtTok(r.v) + ` · ${((r.v / total) * 100).toFixed(0)}%` }),
  ])));
  return el('div', { class: 'pie-wrap' }, [svg, legend]);
}

/* ── 日历热力图 ────────────────────────────────────────────
   有自己的时间按钮：年历看「一整年的活跃节奏」，半年/季度看「近期在不在
   变密」。不跟顶部的 7/30/90 联动——那是给统计图用的，粒度完全不同，
   跟着它抖会让热力图失去意义。 */
const HEAT_RANGES = [[365, '一年'], [182, '半年'], [91, '季度']];
let HEAT_DAYS = 365;

function heatmap(byDay, days) {
  if (!byDay || !byDay.length) return el('div', { class: 'fn', text: '无活动数据' });
  const map = new Map(byDay.map(d => [d.day, d]));
  const end = new Date(); end.setHours(0, 0, 0, 0);
  const start = new Date(end); start.setDate(start.getDate() - (days - 1));
  const weeks = Math.ceil(days / 7);
  const max = Math.max(...byDay.map(d => d.total_tokens), 1);
  const lvl = v => !v ? 0 : v / max > .66 ? 4 : v / max > .33 ? 3 : v / max > .12 ? 2 : 1;

  const cells = el('div', { class: 'heat' });
  const cur = new Date(start);
  cur.setDate(cur.getDate() - cur.getDay());          // 对齐到周日
  const marks = [];
  let lastMonth = -1;
  while (cur <= end) {
    const k = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
    const dd = map.get(k);
    const c = el('i', { class: 'l' + lvl(dd ? dd.total_tokens : 0) });
    c.addEventListener('mousemove', e => showTip(e,
      `<div class="t-d">${k}</div><b>${fmtTok(dd ? dd.total_tokens : 0)}</b>` +
      (dd ? `<div class="t-d">${fmtInt(dd.sessions)} 会话 · ${fmtTok(dd.input_tokens)} 输入</div>` : '')));
    c.addEventListener('mouseleave', hideTip);
    cells.append(c);
    if (cur.getMonth() !== lastMonth) { marks.push({ label: `${cur.getMonth() + 1}月` }); lastMonth = cur.getMonth(); }
    cur.setDate(cur.getDate() + 1);
  }

  // 格子数量随区间变，月份标签密度也要跟着变，否则挤成一团
  const every = marks.length > 12 ? Math.ceil(marks.length / 6) : 1;
  const axis = el('div', { class: 'heat-axis' });
  marks.forEach((m, i) => { if (i % every === 0) axis.append(el('span', { text: m.label })); });

  const WD = ['一', '', '三', '', '五', '', '日'];
  const gutter = el('div', { class: 'heat-gutter' },
    WD.map(t => el('span', { text: t })));
  return el('div', {}, [
    el('div', { style: 'display:flex;align-items:flex-start' }, [
      gutter,
      el('div', { style: 'flex:1;min-width:0' }, [el('div', { class: 'heat-scroll' }, [cells]), axis]),
    ]),
  ]);
}

/* ── 渲染 ────────────────────────────────────────────────── */
let DAYS = 30, RATE = null, DATA = null;

/* 价格表用小写连字符的 key（minimax-m3.1-flash-preview）便于匹配；
   数据库里是厂商原名（MiniMax-M3.1-Flash-Preview）。两者混排会让
   同一个模型出现三种写法。这里统一成数据库里的原名，
   价格表那栏则明确标注「价格表 key」，承认它们本来就是两套命名。 */
function prettyModel(name) {
  if (!name) return '(未知)';
  const direct = (DATA?.cost?.by_model || []).find(m => m.model === name);
  if (direct) return name;
  const fromUsage = (DATA?.by_model || []).find(m => m.model === name);
  return fromUsage ? fromUsage.model : name;
}

function statusTag(m) {
  const cls = { official: 'ok', estimate: 'est', free: 'no', relay: 'no', unknown: 'bad' }[m.status] || 'no';
  return el('span', { class: 'tag ' + cls, text: m.status_label || m.status });
}

function render() {
  const root = $('#app');
  root.innerHTML = '';
  const d = DATA;
  const c = d.cost, s = d.summary;

  /* 头部 */
  const seg = el('div', { class: 'seg' });
  [7, 30, 90].forEach(n => seg.append(el('button', {
    class: n === DAYS ? 'on' : '', text: n + ' 天',
    onclick: () => { DAYS = n; load(); }
  })));
  root.append(el('div', { class: 'head' }, [
    el('div', {}, [
      el('h1', { text: 'Hermes 用量' }),
      el('div', { class: 'sub', html:
        `统计窗口 <b>近 ${DAYS} 天</b> · 数据源 <b>~/.hermes/state.db</b>（只读）· 生成于 <b>${new Date(d.generated_at * 1000).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</b>` +
        '· 数据延迟不超过 5 分钟 · ' +
        (RATE
          ? `汇率 <b>1 USD = ¥${RATE.toFixed(4)}</b>（${d.fx.source || '?'}${d.fx.stale ? ' · 缓存值' : ''}）`
          : '<b style="color:var(--amber)">汇率不可用 · 成本以 USD 显示</b>') }),
    ]),
    el('div', { class: 'ctrls' }, [
      seg,
      el('button', { class: 'btn', text: '刷新', onclick: load }),
      el('button', { class: 'btn primary', text: '导出 JSON', onclick: exportJson }),
    ]),
  ]));

  /* 健康提示：数据不可信时，先说这个 */
  const h = d.health;
  if (!h.ok) {
    root.append(el('div', { class: 'card', style: 'border-color:rgba(248,113,113,.4)' }, [
      el('h2', {}, [el('span', { class: 'tag bad', text: '数据不可信' }),
                    el('span', { class: 'hint', text: h.problems.join('；') })]),
    ]));
  }

  /* 四个主指标 */
  const unpricedHere = c.unpriced.filter(u => u.tokens);
  const missingTok = unpricedHere.reduce((a, u) => a + u.tokens, 0);
  // 覆盖率越低，越要说清「这个数字只代表多少」。切到 90 天会掉到 6 成，
  // 那时若只写一行小字，用户很容易把它当完整账单。
  const covNote = c.coverage < 0.999
    ? `已定价 token 占全部 token 的 ${pct(c.coverage)}；${unpricedHere.length} 个模型部分无价格（${fmtTok(missingTok)} 未计入）`
    : '按官方 API 单价估算';
  root.append(el('div', { class: 'grid g4' }, [
    el('div', { class: 'card kpi accent' + (c.coverage < 0.8 ? ' warn' : '') }, [
      el('div', { class: 'lbl', text: `等效成本（近 ${d.days} 天）` }),
      el('div', { class: 'val', text: fmtMoney(c.cost_usd, RATE), title: `${fmtUsd(c.cost_usd)} USD` }),
      el('div', { class: 'note' + (c.coverage < 0.999 ? ' warn' : ''), text: covNote }),
    ]),
    el('div', { class: 'card kpi' }, [
      el('div', { class: 'lbl', text: 'Tokens（输入+输出）' }),
      el('div', { class: 'val', text: fmtTok(s.total_tokens) }),
      el('div', { class: 'note', text: `缓存读另计 ${fmtTok(s.cache_read_tokens)} —— 是输入的 ${s.cache_share.toFixed(0)} 倍` }),
    ]),
    el('div', { class: 'card kpi' }, [
      el('div', { class: 'lbl', text: '会话' }),
      el('div', { class: 'val', text: fmtInt(s.sessions) }),
      el('div', { class: 'note', text: `${s.models} 个模型 · ${fmtInt(s.api_calls)} 次 API 调用` }),
    ]),
    el('div', { class: 'card kpi' }, [
      el('div', { class: 'lbl', text: 'Hermes 自记成本' }),
      el('div', { class: 'val', text: fmtMoney(d.hermes_cost_usd, RATE) }),
      el('div', { class: 'note', title: 'Hermes 对未登记价格的模型记 0，故此值系统性偏低，仅作下界参考',
                   text: 'Hermes 对未登记价格的模型记 0，仅作下界' }),
    ]),
  ]));

  /* 每日成本图。用量高度偏态（少数几天吃掉大半成本），
     线性轴会把其余日期全压在基线、浪费八成画布；这时自动切对数并在
     标题里说明——不能默默换刻度让人误读。 */
  // 统一用人民币：卡片金额是 ¥，若图轴仍标美元，同一张图两种货币必被误读
  const dayRows = c.daily.map(x => ({ k: x.day.slice(5), v: x.cost_usd * RATE }));
  const vals = dayRows.map(r => r.v).filter(v => v > 0).sort((a, b) => a - b);
  const med = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
  const skewed = med > 0 && Math.max(...vals) / med > 8;
  const card1 = el('div', { class: 'card' });
  card1.append(el('h2', {}, [el('span', { text: '每日成本（合计即上方卡片金额）' }),
    el('span', { class: 'v', text: fmtMoney(c.cost_usd, RATE) }),
    el('span', { class: 'hint', text: skewed
      ? '多数日期花得很少、少数几天吃掉大头，故用对数刻度；否则其余日期会全贴在基线上'
      : '金额为人民币，按参考汇率折算自美元' })]));
  card1.append(dayRows.length
    ? (skewed
        ? areaChart(dayRows, { h: 200, log: true, color: 'var(--green)', unit: '¥' })
        : barChart(dayRows, { h: 200, fmt: v => '¥' + v.toFixed(2), zeroIsZero: true }))
    : el('div', { class: 'fn', text: '该窗口内没有可定价的调用' }));
  root.append(card1);

  /* Token 趋势。缓存读只画一次——此前同时画了对数折线和柱状，
     两张图讲的是同一件事，且「对数刻度」的说明只对其中一张成立。 */
  const days = d.by_day;
  const card2 = el('div', { class: 'card' });
  card2.append(el('h2', {}, [el('span', { text: 'Token 趋势' }),
    el('span', { class: 'hint', text: '缓存读比输入高一两个数量级，混在同一坐标里会把其余曲线压平，故单独成图' })]));
  if (days.length) {
    card2.append(el('div', {}, [
      el('div', { class: 'sec-cap', text: '每日输入 + 输出（线性）' }),
      areaChart(days.map(x => ({ k: x.day.slice(5), v: x.total_tokens })), { h: 190 }),
    ]));
    card2.append(el('div', { class: 'sec' }, [
      el('div', { class: 'sec-cap',
        text: `每日缓存读 —— 是输入的 ${s.cache_share.toFixed(0)} 倍` }),
      barChart(days.map(x => ({ k: x.day.slice(5), v: x.cache_read_tokens })), { h: 170 }),
    ]));
  } else {
    card2.append(el('div', { class: 'fn', text: '无数据' }));
  }
  root.append(card2);

  /* 模型成本表 */
  const card3 = el('div', { class: 'card' });
  card3.append(el('h2', {}, [el('span', { text: '模型成本' }),
    el('span', { class: 'hint', text: '口径按官方 API 单价，非你的实际账单（你走 Token Plan / 套餐）' })]));
  const totalCost = c.cost_usd || 1;
  const tbody = el('tbody');
  c.by_model.forEach((m, i) => {
    const priced = m.status === 'official' || m.status === 'estimate' || m.status === 'free';
    const share = m.cost_usd / totalCost;      // 占总额，不是占最大的那个
    tbody.append(el('tr', {}, [
      el('td', {}, [el('div', { class: 'model' }, [
        el('span', { text: m.model }), statusTag(m),
        // 同一模型既有已定价又有未定价的端点（如 qwen 经 ollama 免费、
        // 另有一档查不到价）——不标出来会与「未定价」清单自相矛盾
        m.mixed ? el('span', { class: 'tag no', text: '混合口径' }) : null,
        m.unpriced_tokens ? el('span', {
          class: 'tag no',
          title: `其中 ${fmtTok(m.unpriced_tokens)} token 无价格，未计入成本`,
          text: `未计 ${fmtTok(m.unpriced_tokens)}`,
        }) : null,
      ])]),
      el('td', { class: 'num', title: '含缓存读', text: fmtTok(m.tokens) }),
      el('td', {}, [el('div', { style: 'display:flex;align-items:center;gap:8px' }, [
        el('div', { class: 'bar' + (i % 2 ? ' alt' : ''), style: 'flex:1;min-width:48px' },
          [el('i', { style: `width:${(share * 100).toFixed(1)}%` })]),
        el('span', { class: 'mono dim', style: 'font-size:11px;width:42px;text-align:right',
                     text: pct(share) }),
      ])]),
      el('td', { class: 'num', text: priced ? fmtMoney(m.cost_usd, RATE) : '—' }),
    ]));
  });
  card3.append(el('table', {}, [
    el('thead', {}, [el('tr', {}, [
      el('th', { text: '模型' }),
      el('th', { class: 'num', title: '含缓存读', text: 'Tokens（含缓存）' }),
      el('th', { text: '占成本' }),
      el('th', { class: 'num', text: '成本' }),
    ])]), tbody]));
  const unpriced = (c.unpriced || []).filter(u => u.tokens);
  if (unpriced.length) {
    card3.append(el('div', { class: 'fn sec',
      html: '此处 Tokens <b>含缓存读</b>，所以远大于上方卡片（那里只算输入+输出）——两个口径都对，只是量纲不同。<br>' +
            '未计入合计（无价格，不是 0）：' + unpriced.map(u => `${u.model} ${fmtTok(u.tokens)}`).join(' · ') }));
  }
  root.append(card3);

  /* 用量分布：来源 / 任务 / 模型 */
  const card4 = el('div', { class: 'card' });
  card4.append(el('h2', {}, [el('span', { text: '用量分布' }),
    el('span', { class: 'hint', text: '按输入+输出计，不含缓存读' })]));
  const mk = (title, rows, key, opts = {}) => {
    const val = r => r.input_tokens + r.output_tokens;      // 不含缓存读
    const tot = rows.reduce((a, r) => a + val(r), 0);
    const sorted = [...rows].sort((a, b) => val(b) - val(a));
    // 尾部的零碎项并成「其他 N 项」：饼图里 0.3% 的扇区根本看不见
    const big = sorted.filter(r => tot && val(r) / tot >= 0.01);
    const rest = sorted.filter(r => !big.includes(r));
    const data = big.map((r, i) => ({
      k: String(r[key] ?? r.model ?? r.source), v: val(r),
      c2: i % 2 === 1, pct: tot ? val(r) / tot * 100 : 0,
    }));
    if (rest.length) {
      const sum = rest.reduce((a, r) => a + val(r), 0);
      data.push({ k: `其他 ${rest.length} 项`, v: sum, c2: false,
                  pct: tot ? sum / tot * 100 : 0 });
    }
    // 扇区超过 6 个就没人能一眼分辨了，那类情况退回横条
    const body = data.length <= 6 ? pieChart(data) : hBars(data, { full: opts.full });
    return el('div', {}, [
      el('div', { class: 'sec-cap', style: 'margin-bottom:12px', text: title }),
      body,
    ]);
  };
  card4.append(mk('按来源', d.by_source, 'source'));
  card4.append(el('div', { class: 'sec' }, [mk('按任务（含辅助）', d.by_task, 'task')]));
  card4.append(el('div', { class: 'sec' }, [mk('按模型', d.by_model, 'model')]));
  root.append(card4);

  /* 活跃热力图 */
  const card5 = el('div', { class: 'card' });
  const heatSeg = el('div', { class: 'seg' });
  HEAT_RANGES.forEach(([d, label]) => heatSeg.append(el('button', {
    class: d === HEAT_DAYS ? 'on' : '', text: label,
    onclick: () => {
      HEAT_DAYS = d;
      [...heatSeg.children].forEach(b => b.classList.toggle('on', b.textContent === label));
      loadHeat(card5);
    },
  })));
  card5.append(el('h2', {}, [el('span', { text: '活跃热力图' }),
    el('span', { class: 'hint', text: '按天粒度；区间独立于上方统计窗口' }),
    el('span', { style: 'margin-left:auto' }, [heatSeg]),
  ]));
  loadHeat(card5);
  root.append(card5);

  /* 价格来源 */
  const pt = d.price_table;
  const card6 = el('div', { class: 'card' });
  card6.append(el('h2', {}, [el('span', { text: '价格来源' }),
    el('span', { class: 'hint', text: `price_table.yaml v${pt.version} · 核对于 ${pt.updated}` })]));
  const ptBody = el('tbody');
  (pt.entries || []).forEach(e => {
    const tier = e.time_tier === 'deepseek_peak_offpeak' && e.peak && e.off_peak;
    const cell = k => tier && e.peak[k] != null
      ? el('span', { title: `峰 $${e.peak[k]} / 谷 $${e.off_peak[k]}`,
                      text: `$${e.peak[k]}–${e.off_peak[k]}` })
      : el('span', { text: e[k] != null ? '$' + e[k] : '—' });
    ptBody.append(el('tr', {}, [
      el('td', {}, [el('div', { class: 'model' }, [el('span', { text: e.key }),
        tier ? el('span', { class: 'tag est', text: '峰谷价' }) : null])]),
      el('td', { class: 'num' }, [cell('input')]),
      el('td', { class: 'num' }, [cell('output')]),
      el('td', { class: 'num' }, [cell('cache_read')]),
      el('td', {}, [el('span', { class: 'tag ' + (e.confidence === 'official' ? 'ok' : 'est'),
                                 text: (pt.labels || {})[e.confidence] || e.confidence })]),
      el('td', { class: 'dim', text: e.checked || '—' }),
    ]));
  });
  card6.append(el('table', {}, [
    el('thead', {}, [el('tr', {}, ['价格表 key', '输入', '输出', '缓存读', '口径', '核对于']
      .map((t, i) => el('th', { class: i > 0 && i < 4 ? 'num' : '', text: t })))]),
    ptBody]));
  card6.append(el('div', { class: 'fn', style: 'margin-top:12px',
    html: '此处是<b>价格表 key</b>（小写连字符，为便于正则匹配），与上面表格里的厂商原名是同一批模型的两种写法。<br>' +
          '单价单位 <b>USD / 每百万 token</b>。峰谷价按每次调用的时刻判定：UTC 周一至周五 01–04、06–10 为峰（北京时间 09–12、14–18），周末与节假日全为谷。取官方划线原价而非促销价，折算的是「按量付费要花多少」。' }));

  const histKeys = Object.keys(pt.price_history || {}).filter(k => (pt.price_history[k] || []).length);
  if (histKeys.length) {
    const hb = el('tbody');
    histKeys.forEach(k => {
      hb.append(el('tr', {}, [
        el('td', { text: k }),
        el('td', { class: 'dim', text: pt.price_history[k].map(e => `${e.from} ~ ${e.until || '至今'}`).join('；') }),
        el('td', { colspan: 4, class: 'dim', text: pt.price_history[k][pt.price_history[k].length - 1].note || '' }),
      ]));
    });
    card6.append(el('div', { class: 'sec-cap', style: 'margin:28px 0 10px', text: '历史调价（按调用时间取当时那档价）' }));
    card6.append(el('table', {}, [el('thead', {}, [el('tr', {}, ['模型', '生效区间', '说明']
      .map(t => el('th', { text: t })))]), hb]));
  }
  root.append(card6);

  /* 页脚 */
  root.append(el('footer', {}, [
    el('span', { html: `口径：含辅助任务 · ${fmtInt(s.sessions)} 会话 · 数据仅供量级参考，与你的实际账单口径不同` }),
    el('span', { html: `数据健康：<b style="color:${h.ok ? 'var(--green)' : 'var(--red)'}">${h.ok ? '可信' : '有问题'}</b> · 最新用量 ${h.latest_usage_age_min} 分钟前` }),
  ]));
}

function loadHeat(card5) {
  /* 只认自己放进去的那个容器。之前这里先 card5.append(空节点) 再
     querySelector('.heat-host')，拿到的是刚建的空壳；随后往 card5 里
     再 append 一个真容器，render 时残留的「加载中…」就永远清不掉。
     正确做法：先按 class 找到已有容器，没有才建。 */
  let slot = card5.querySelector('.heat-host');
  if (!slot) {
    slot = el('div', { class: 'heat-host' });
    card5.append(slot);
  }
  slot.innerHTML = '';
  slot.append(el('div', { class: 'fn', text: '加载中…' }));
  fetch(`/api/activity?days=${HEAT_DAYS}`)
    .then(r => r.json())
    .then(a => {
      slot.innerHTML = '';
      slot.append(heatmap(a.by_day, HEAT_DAYS));
      slot.append(el('div', { class: 'heat-legend',
        style: 'justify-content:flex-end;margin-top:14px' },
        [el('span', { text: '少' })]
          .concat([0, 1, 2, 3, 4].map(l => el('i', { class: 'l' + l })))
          .concat([el('span', { text: '多' })])));
    })
    .catch(() => {
      slot.innerHTML = '';
      slot.append(el('div', { class: 'fn', text: '活动数据加载失败' }));
    });
}

function exportJson() {
  const blob = new Blob([JSON.stringify(DATA, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob),
    download: `hstats-${DAYS}d-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove();
}

async function load() {
  const app = $('#app');
  try {
    const r = await fetch(`/api/stats?days=${DAYS}&aux=1`);
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    DATA = d;
    RATE = d.fx && d.fx.usd_cny ? d.fx.usd_cny : null;   // 服务端下发，不猜
    render();
  } catch (e) {
    app.innerHTML = '';
    app.append(el('div', { class: 'card' }, [
      el('h2', {}, [el('span', { class: 'tag bad', text: '加载失败' })]),
      el('div', { class: 'err', text: String(e.message || e) }),
      el('div', { class: 'fn', html: '确认服务在跑：<b>cd ~/workspace/projects/hermes-stats && .venv/bin/python -m hstats.web</b>' }),
    ]));
  }
}

load();