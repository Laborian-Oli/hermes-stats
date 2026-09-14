/**
 * hermes-stats — Hermes Desktop 统计中心
 *
 * 侧栏"统计"页（/stats）：总览、每日 token/成本趋势、平台/模型分布、
 * 工具/技能排行、活跃模式、cron 执行、系统信息。
 * 状态栏：今日 token 与成本的常驻 chip（点击跳转统计页）。⌘K：统计中心。
 *
 * 数据来自 Python 后端 /api/plugins/hermes-stats/{stats,cron,system}
 * （复用官方 hermes insights / dashboard analytics 管线，全部只读）。
 *
 * 加载纪律（本次排障结论）：
 * 1) 导入面保持最小：jsx + react(useState) + 面积常量 + host + useQuery；
 *    SDK UI kit 组件导入曾引发 runtime load failed，全部弃用，纯原生 JSX + CSS。
 * 2) 禁止深嵌套 jsx(children:[ map(jsx(children:[...])) ])——每次排障都栽在
 *    括号配对上；所有 map 结果先存变量，jsx 调用最多一层 children。
 *
 * 安装位置：~/.hermes/plugins/hermes-stats/desktop/plugin.js
 */
import { jsx } from 'react/jsx-runtime'
import { useEffect, useState } from 'react'
import {
  ROUTES_AREA, SIDEBAR_NAV_AREA, STATUSBAR_AREAS, PALETTE_AREA,
  host, useValue, usePluginI18n
} from '@hermes/plugin-sdk'

/* 插件自带 i18n 词包：跟随应用当前语言（zh 由 zh-CN 归一化而来）。 */
const LOCALES = {
  en: {
    nav: 'Stats', palette: 'Open Stats Center', title: 'Stats Center',
    today: 'Today', loading: 'Stats…', error: 'Stats unavailable',
    note: 'Source: official hermes insights / dashboard analytics pipeline (read-only). Matches `hermes insights --days N`. Auto-refresh every 5 minutes.',
  },
  zh: {
    nav: '统计', palette: '统计中心 · 打开', title: '统计中心',
    today: '今日', loading: '统计…', error: '统计不可用',
    note: '数据源：官方 hermes insights / dashboard analytics 管线（只读）。数字与 `hermes insights --days N` 一致。每 5 分钟自动刷新。',
  },
  'zh-hant': {
    nav: '統計', palette: '開啟統計中心', title: '統計中心',
    today: '今日', loading: '統計…', error: '統計無法使用',
    note: '資料來源：官方 hermes insights / dashboard analytics 管線（唯讀）。數字與 `hermes insights --days N` 一致。每 5 分鐘自動重新整理。',
  },
  ja: {
    nav: '統計', palette: '統計センターを開く', title: '統計センター',
    today: '今日', loading: '統計…', error: '統計を取得できません',
    note: 'データソース: 公式 hermes insights / dashboard analytics パイプライン（読み取り専用）。`hermes insights --days N` と一致。5分ごとに自動更新。',
  },
}

const STYLE = `
.hs-root { padding: 18px 22px 48px; max-width: 920px; font-size: 13px; line-height: 1.5; }
.hs-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.hs-title { font-size: 17px; font-weight: 650; }
.hs-radio { display: inline-flex; border: 1px solid var(--ui-stroke-secondary); border-radius: 8px; overflow: hidden; }
.hs-radio button { background: transparent; border: 0; color: var(--ui-text-secondary); padding: 4px 12px; font-size: 12px; cursor: pointer; }
.hs-radio button.active { background: color-mix(in srgb, var(--ui-accent) 18%, transparent); color: var(--ui-accent); font-weight: 600; }
.hs-sec { margin-top: 20px; }
.hs-sec-title { display: flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 600; margin-bottom: 9px; }
.hs-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 9px; }
.hs-card { border: 1px solid var(--ui-stroke-secondary); border-radius: 9px; padding: 10px 13px; background: color-mix(in srgb, var(--ui-accent) 3%, transparent); }
.hs-stat-label { font-size: 11px; color: var(--ui-text-quaternary); }
.hs-stat-value { font-size: 17px; font-weight: 650; margin-top: 2px; }
.hs-stat-sub { font-size: 11px; color: var(--ui-text-quaternary); margin-top: 2px; }
.hs-chart-card { border: 1px solid var(--ui-stroke-secondary); border-radius: 9px; padding: 12px 14px; margin-top: 10px; }
.hs-chart-title { font-size: 12px; color: var(--ui-text-secondary); margin-bottom: 6px; }
.hs-legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 11px; color: var(--ui-text-secondary); }
.hs-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.hs-donuts { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
.hs-hbars { display: flex; flex-direction: column; gap: 6px; }
.hs-hbar { display: grid; grid-template-columns: 150px 1fr 74px; gap: 9px; align-items: center; }
.hs-hbar-label { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hs-hbar-track { height: 8px; border-radius: 4px; background: color-mix(in srgb, var(--ui-stroke-secondary) 40%, transparent); overflow: hidden; }
.hs-hbar-fill { height: 100%; border-radius: 4px; background: var(--ui-accent); }
.hs-hbar-val { font-size: 11px; color: var(--ui-text-secondary); text-align: right; font-variant-numeric: tabular-nums; }
.hs-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.hs-table th { text-align: left; color: var(--ui-text-quaternary); font-weight: 500; padding: 5px 8px; border-bottom: 1px solid var(--ui-stroke-secondary); }
.hs-table td { padding: 5px 8px; border-bottom: 1px solid color-mix(in srgb, var(--ui-stroke-secondary) 45%, transparent); }
.hs-tag { font-size: 10px; padding: 1px 7px; border-radius: 99px; border: 1px solid var(--ui-stroke-secondary); color: var(--ui-text-secondary); }
.hs-chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--ui-stroke-secondary); border-radius: 99px; padding: 2px 11px; font-size: 11px; color: var(--ui-text-secondary); background: transparent; cursor: pointer; }
.hs-chip:hover { border-color: var(--ui-accent); color: var(--ui-accent); }
.hs-chip + .hs-chip { margin-left: 6px; }
.hs-hourbars { display: flex; align-items: flex-end; gap: 3px; height: 66px; }
.hs-hourbars div { flex: 1; background: var(--ui-accent); opacity: .55; border-radius: 2px 2px 0 0; }
.hs-hourbars.fail div { background: var(--ui-destructive, #e55); }
.hs-note { margin-top: 22px; font-size: 11px; color: var(--ui-text-quaternary); }
.hs-box { border: 1px solid var(--ui-stroke-secondary); border-radius: 9px; padding: 14px 16px; color: var(--ui-text-secondary); }
`

function colors() {
  const cs = getComputedStyle(document.documentElement)
  return {
    accent: cs.getPropertyValue('--ui-accent').trim() || '#FFBF00',
    line: cs.getPropertyValue('--ui-text-secondary').trim() || '#99a',
    faint: cs.getPropertyValue('--ui-text-quaternary').trim() || '#667',
    stroke: cs.getPropertyValue('--ui-stroke-secondary').trim() || '#334',
  }
}

/* ---------------- 汇率（USD → CNY） ----------------
 * 模型单价与后端统计都是美元口径，展示统一折人民币。汇率随 /stats 的 fx 字段下发
 * （ECB 参考汇率 → exchangerate-api → 兜底常数，后端缓存 12h；stale 表示沿用旧值）。 */
const FX_FALLBACK = 7.10
let FX = { rate: FX_FALLBACK, source: 'fallback', date: null, stale: true }
function applyFx(payload) {
  const f = payload && payload.fx
  if (f && f.usd_cny > 0) {
    FX = { rate: f.usd_cny, source: f.source || '?', date: f.rate_date || null, stale: !!f.stale }
  }
  return FX
}
const Fx = { cn: '¥', fallback: '兜底', ecb: 'ECB', er: 'exchangerate-api' }
function fxNoteText() {
  const src = FX.source === 'ECB' ? Fx.ecb : FX.source === 'fallback' ? Fx.fallback : FX.source
  return `1 USD = ${Fx.cn}${FX.rate.toFixed(4)} · ${src}${FX.date ? ' ' + FX.date : ''}${FX.stale ? ' · 缓存值' : ''}`
}

/* ---------------- formatting ---------------- */
const fmtTokens = n => (n = n || 0) >= 1e9 ? (n / 1e9).toFixed(2) + 'B'
  : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
  : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n)
// 入参是美元估算值；rate 可显式传入（冒烟测试用），默认取当前汇率
const fmtCost = (n, rate) => {
  const v = (n || 0) * (rate != null ? rate : FX.rate)
  return v >= 1 ? Fx.cn + v.toFixed(2) : v > 0 ? Fx.cn + v.toPrecision(2) : Fx.cn + '0'
}
const fmtInt = n => (n || 0).toLocaleString()
const fmtDay = ts => ts ? new Date(ts * 1000).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '—'
const shortDay = d => typeof d === 'string' ? d.slice(5) : ''
const S = v => Number.isFinite(v) ? v : 0

/* ---------------- lightweight data hook ----------------
 * SDK 的 useQuery 在该运行时插件环境下崩（defaultQueryOptions is not a function），
 * 改用 react 原生 hooks 自轮询：{ data, isLoading, isError, error }。
 * deps 变化即重新拉取；intervalMs 为轮询间隔（毫秒）。
 */
function useData(fn, deps, intervalMs) {
  const [state, setState] = useState({ data: null, loading: true, error: null })
  useEffect(() => {
    let alive = true
    setState(prev => ({ ...prev, loading: true }))
    const load = () => {
      Promise.resolve().then(fn).then(data => {
        if (alive) setState({ data, loading: false, error: null })
      }).catch(err => {
        if (alive) setState({ data: null, loading: false, error: err })
      })
    }
    load()
    let timer = null
    if (intervalMs) timer = setInterval(load, intervalMs)
    return () => { alive = false; if (timer) clearInterval(timer) }
  }, deps)
  return { data: state.data, isLoading: state.loading, isError: !!state.error, error: state.error }
}

/* ---------------- tiny SVG charts ---------------- */

function TrendChart({ daily, metric, scale, color }) {
  const key = { in: 'input_tokens', out: 'output_tokens', cache: 'cache_read_tokens' }[metric]
  const vals = daily.map(d => d[key] || 0)
  const n = daily.length
  if (!n) return null
  const c = colors()
  const W = 640, H = 150, PL = 34, PR = 10, PT = 12, PB = 20
  const max = Math.max(1, ...vals)
  const lg = scale === 'log'
  const base = v => (lg ? (v > 0 ? Math.log10(v) / Math.log10(max) : 0) : v / max)
  const y = v => S(PT + (H - PT - PB) * (1 - base(S(v))))
  const x = i => S(PL + (W - PL - PR) * (n === 1 ? 0.5 : i / (n - 1)))
  const path = vals.map((v, i) => (i ? 'L' : 'M') + ' ' + x(i).toFixed(1) + ' ' + y(S(v)).toFixed(1)).join(' ')
  const area = path + ` L ${(W - PR).toFixed(1)} ${(H - PB).toFixed(1)} L ${PL} ${(H - PB).toFixed(1)} Z`
  const fill = color || (metric === 'in' ? c.accent : metric === 'out' ? c.line : c.faint)
  const fracs = lg ? [1, .25, .0625, .015625] : [1, .5, .25, 0]
  const grid = fracs.map((f, i) => {
    const ty = y(max * f)
    return jsx('g', { key: 'g' + i, children: [
      jsx('line', { key: 'l', x1: PL, x2: W - PR, y1: ty, y2: ty, stroke: c.stroke, strokeOpacity: .35, strokeWidth: 1 }),
      jsx('text', { key: 't', x: PL - 5, y: ty + 3, fontSize: 10, fill: c.faint, textAnchor: 'end', children: f === 0 ? '0' : fmtTokens(max * f) }),
    ]})
  })
  const xlabels = [0, Math.floor((n - 1) / 2), n - 1].map(i => jsx('text', { key: 'x' + i, x: x(i), y: H - 5, fontSize: 10, fill: c.faint, textAnchor: i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle', children: shortDay(daily[i].day) }))
  const shapes = metric === 'cache'
    ? [jsx('path', { key: 'a', d: area, fill: c.faint, opacity: .18 }), jsx('path', { key: 'l', d: path, fill: 'none', stroke: c.line, strokeWidth: 1.6 })]
    : [jsx('path', { key: 'a', d: area, fill, opacity: .85 })]
  return jsx('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', children: [...grid, ...shapes, ...xlabels] })
}

function TokensChart({ daily }) { return jsx(TrendChart, { daily, metric: 'in', scale: 'log' }) }
function OutputChart({ daily }) { return jsx(TrendChart, { daily, metric: 'out', scale: 'linear' }) }
function CacheChart({ daily }) { return jsx(TrendChart, { daily, metric: 'cache', scale: 'log' }) }

function SessionsChart({ daily }) {
  const n = daily.length
  if (!n) return null
  const c = colors()
  const W = 640, H = 110, PL = 28, PR = 10, PT = 8, PB = 18
  const max = Math.max(1, ...daily.map(d => d.sessions || 0))
  const bw = (W - PL - PR) / n
  const bars = daily.map((d, i) => {
    const h = (H - PT - PB) * (d.sessions / max)
    return jsx('rect', { key: 'b' + i, x: PL + i * bw + bw * .18, y: H - PB - h, width: bw * .64, height: Math.max(h, d.sessions ? 1 : 0), rx: 2, fill: c.accent, opacity: .75 })
  })
  const xlabels = [0, Math.floor((n - 1) / 2), n - 1].map(i => jsx('text', { key: 'x' + i, x: PL + i * bw + bw / 2, y: H - 4, fontSize: 9, fill: c.faint, textAnchor: 'middle', children: shortDay(daily[i].day) }))
  const axis = jsx('line', { key: 'axis', x1: PL, x2: W - PR, y1: H - PB, y2: H - PB, stroke: c.stroke, strokeOpacity: .4 })
  const maxT = jsx('text', { key: 'max', x: PL - 5, y: PT + 3, fontSize: 9, fill: c.faint, textAnchor: 'end', children: String(max) })
  return jsx('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', children: [axis, ...bars, ...xlabels, maxT] })
}

function CostChart({ daily }) {
  const n = daily.length
  if (!n) return null
  const c = colors()
  const W = 640, H = 110, PL = 34, PR = 10, PT = 8, PB = 18
  const vals = daily.map(d => d.estimated_cost || 0)
  const max = Math.max(0.0001, ...vals)
  const x = i => S(PL + (W - PL - PR) * (n === 1 ? 0.5 : i / (n - 1)))
  const y = v => S(PT + (H - PT - PB) * (1 - v / max))
  const path = vals.map((v, i) => (i ? 'L' : 'M') + ' ' + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ')
  const area = path + ` L ${(W - PR).toFixed(1)} ${(H - PB).toFixed(1)} L ${PL} ${(H - PB).toFixed(1)} Z`
  const xlabels = [0, Math.floor((n - 1) / 2), n - 1].map(i => jsx('text', { key: 'x' + i, x: x(i), y: H - 4, fontSize: 9, fill: c.faint, textAnchor: 'middle', children: shortDay(daily[i].day) }))
  const maxT = jsx('text', { key: 'max', x: PL - 5, y: PT + 3, fontSize: 9, fill: c.faint, textAnchor: 'end', children: fmtCost(max) })
  const areaP = jsx('path', { key: 'a', d: area, fill: c.accent, opacity: .15 })
  const lineP = jsx('path', { key: 'l', d: path, fill: 'none', stroke: c.accent, strokeWidth: 1.6 })
  return jsx('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', children: [areaP, lineP, ...xlabels, maxT] })
}

function Donut({ data, label }) {
  const c = colors()
  const total = data.reduce((s, d) => s + (d.value || 0), 0)
  if (!total) return jsx('div', { className: 'hs-chart-title', children: '暂无数据' })
  const size = 148, r = (size - 26) / 2, cx = size / 2, cy = size / 2
  const circ = 2 * Math.PI * r
  let acc = 0
  const segs = data.map(d => {
    const frac = (d.value || 0) / total
    const sg = { ...d, frac, dash: frac * circ, off: -acc * circ }
    acc += frac
    return sg
  })
  const OP = [1, .72, .5, .34, .24, .17]
  const circles = segs.map((s, i) => jsx('circle', { key: i, cx, cy, r, fill: 'none', stroke: c.accent, strokeOpacity: OP[i % 6], strokeWidth: 26, strokeDasharray: `${s.dash} ${circ - s.dash}`, strokeDashoffset: s.off, transform: `rotate(-90 ${cx} ${cy})` }))
  const centerT = jsx('text', { key: 'c', x: cx, y: cy - 2, textAnchor: 'middle', fontSize: 15, fontWeight: 650, fill: 'currentColor', children: label })
  const subT = jsx('text', { key: 's', x: cx, y: cy + 13, textAnchor: 'middle', fontSize: 9, fill: c.faint, children: '合计' })
  const legendItems = segs.map((s, i) => jsx('span', { key: i, children: [
    jsx('i', { key: 'i', style: { background: c.accent, opacity: OP[i % 6] } }),
    s.label,
    jsx('b', { key: 'v', style: { marginLeft: 6, color: 'currentColor' }, children: fmtTokens(s.value) }),
  ]}))
  const svg = jsx('svg', { key: 'svg', viewBox: `0 0 ${size} ${size}`, width: size, children: [...circles, centerT, subT] })
  const legend = jsx('div', { key: 'lg', className: 'hs-legend', style: { flexDirection: 'column', gap: 6 }, children: legendItems })
  return jsx('div', { style: { display: 'flex', alignItems: 'center', gap: 16 }, children: [svg, legend] })
}

function HBars({ rows }) {
  if (!rows || !rows.length) return jsx('div', { className: 'hs-chart-title', children: '暂无数据' })
  const items = rows.map((r, i) => jsx('div', { key: i, className: 'hs-hbar', children: [
    jsx('div', { key: 'l', className: 'hs-hbar-label', title: r.label, children: r.label }),
    jsx('div', { key: 't', className: 'hs-hbar-track', children: jsx('div', { className: 'hs-hbar-fill', style: { width: Math.max(1.5, r.pct || 0) + '%' } }) }),
    jsx('div', { key: 'v', className: 'hs-hbar-val', children: fmtInt(r.value) + (r.pct != null ? ` · ${r.pct.toFixed(0)}%` : '') }),
  ]}))
  return jsx('div', { className: 'hs-hbars', children: items })
}

/* ---------------- page helpers ---------------- */

function Card({ title, children }) {
  return jsx('div', { className: 'hs-chart-card', children: [
    title ? jsx('div', { key: 't', className: 'hs-chart-title', children: title }) : null,
    children,
  ]})
}

function TwoCol({ a, b }) {
  return jsx('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 10 }, children: [a, b] })
}

function HeadRow(cols) {
  const cells = cols.map(h => jsx('th', { key: h, children: h }))
  return jsx('thead', { children: jsx('tr', { children: cells }) })
}

function StatCard({ label, value, sub }) {
  return jsx('div', { className: 'hs-card hs-stat', children: [
    jsx('div', { key: 'l', className: 'hs-stat-label', children: label }),
    jsx('div', { key: 'v', className: 'hs-stat-value', children: value }),
    sub ? jsx('div', { key: 's', className: 'hs-stat-sub', children: sub }) : null,
  ]})
}

/* ---------------- page ---------------- */

function StatPage({ rest }) {
  const [days, setDays] = useState(30)
  const [tick, setTick] = useState(0)
  const t = usePluginI18n('hermes-stats')
  const s = useData(() => rest(`/stats?days=${days}`), [days, tick], 5 * 60 * 1000)
  const cron = useData(() => rest('/cron'), [tick], 5 * 60 * 1000)
  const sys = useData(() => rest('/system'), [tick], 10 * 60 * 1000)

  if (s.isLoading || cron.isLoading || sys.isLoading) {
    return jsx('div', { className: 'hs-root', children: jsx('div', { className: 'hs-box', children: '加载中…' }) })
  }
  if (s.isError || cron.isError || sys.isError) {
    return jsx('div', { className: 'hs-root', children: jsx('div', { className: 'hs-box', children: '统计中心加载失败：请确认 config.yaml → plugins.enabled 含 hermes-stats 且已重启 Desktop（gateway）。' }) })
  }
  const stats = s.data, c = sys.data
  applyFx(stats)
  const o = stats.overview || {}, a = stats.activity || {}
  if (!o.total_sessions) {
    return jsx('div', { className: 'hs-root', children: jsx('div', { className: 'hs-box', children: '当前时间窗口内暂无会话数据。' }) })
  }

  try {

  const totalTokens = stats.totals ? (stats.totals.total_input || 0) + (stats.totals.total_output || 0) : 0
  const hourMax = Math.max(1, ...a.by_hour.map(h => h.count))

  /* — 预构建数据（保持每个 jsx 调用只有一层 children） — */
  const overviewCards = [
    jsx(StatCard, { key: 'a', label: '会话', value: fmtInt(o.total_sessions), sub: o.user_messages ? `用户消息 ${fmtInt(o.user_messages)}` : null }),
    jsx(StatCard, { key: 'b', label: '消息', value: fmtInt(o.total_messages), sub: `平均 ${(o.avg_messages_per_session || 0).toFixed(1)}/会话` }),
    jsx(StatCard, { key: 'c', label: '总 Tokens', value: fmtTokens((o.total_input_tokens || 0) + (o.total_output_tokens || 0)), sub: `缓存读 ${fmtTokens(o.total_cache_read_tokens || 0)}` }),
    jsx(StatCard, { key: 'd', label: '成本（¥）', value: fmtCost(o.estimated_cost), sub: o.unknown_cost_sessions ? `${o.unknown_cost_sessions} 会话无定价` : null }),
    jsx(StatCard, { key: 'e', label: '工具调用', value: fmtInt(o.total_tool_calls), sub: stats.totals && stats.totals.total_api_calls != null ? `API 调用 ${fmtInt(stats.totals.total_api_calls)}` : null }),
    jsx(StatCard, { key: 'f', label: '活跃时长', value: (o.total_hours || 0).toFixed(1) + 'h', sub: a ? `活跃 ${a.active_days} 天 · 最长连续 ${a.max_streak} 天` : null }),
  ]
  const modelTokens = m => (m.input_tokens || 0) + (m.output_tokens || 0) + (m.cache_read_tokens || 0) + (m.cache_write_tokens || 0)
  const models = (stats.by_model || []).map(m => ({ label: m.model, value: modelTokens(m) }))
  const modelRows = (stats.by_model || []).map((m, i) => jsx('tr', { key: i, children: [
    jsx('td', { key: 'n', children: m.model }),
    jsx('td', { key: 't', children: fmtTokens(modelTokens(m)) }),
    jsx('td', { key: 'c', children: fmtCost(m.estimated_cost || 0) }),
    jsx('td', { key: 's', children: fmtInt(m.sessions || 0) }),
  ]}))
  const platforms = (stats.platforms || []).map(p => ({ label: p.platform, value: (p.input_tokens || 0) + (p.output_tokens || 0) }))
  const toolRows = (stats.tools || []).slice(0, 10).map(t => ({ label: t.tool, value: t.count, pct: t.percentage }))
  const skillRows = (stats.skills.top_skills || []).slice(0, 10).map((sk, i) => jsx('tr', { key: i, children: [
    jsx('td', { key: 'n', children: sk.skill }),
    jsx('td', { key: 'v', children: fmtInt(sk.view_count) }),
    jsx('td', { key: 'm', children: fmtInt(sk.manage_count) }),
    jsx('td', { key: 'd', children: fmtDay(sk.last_used_at) }),
  ]}))
  const hourBars = a.by_hour.map((h, i) => jsx('div', {
    key: i, style: { height: Math.max(3, 60 * h.count / hourMax) + '%', opacity: h.count ? .55 : .12 }, title: `${h.hour} 时 · ${h.count} 会话`,
  }))
  const dayMax = Math.max(1, ...a.by_day.map(x => x.count))
  const dayRows = a.by_day.map(d => ({ label: d.day, value: d.count, pct: d.count ? d.count / dayMax * 100 : 0 }))
  const sessionHighlights = (stats.top_sessions || []).map((t, i) => jsx('span', { key: i, children: `${t.label}: ${t.value} (${t.date})` }))
  const cronJobRows = (cron.data.jobs || []).map((j, i) => jsx('tr', { key: i, children: [
    jsx('td', { key: 'n', children: [j.name || j.id, ' ', j.enabled === false ? jsx('span', { className: 'hs-tag', children: '暂停' }) : null] }),
    jsx('td', { key: 'f', children: j.schedule ? String(j.schedule).slice(0, 18) : '—' }),
    jsx('td', { key: 'l', children: j.last_run_at ? String(j.last_run_at).slice(0, 16).replace('T', ' ') : '—' }),
  ]}))
  const cronDaily = (cron.data.by_day || []).slice(-14).map((d, i) => {
    const total = Math.max(1, d.completed + d.failed + d.other)
    return jsx('div', { key: i, style: { display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 1, height: '100%' }, title: `${d.day} · 成功 ${d.completed} / 失败 ${d.failed}`, children: [
      d.failed ? jsx('div', { key: 'f', style: { minHeight: 2, background: 'var(--ui-destructive, #e55)', opacity: .8 } }) : null,
      jsx('div', { key: 'ok', style: { minHeight: 2, background: 'var(--ui-accent)', opacity: .5, flex: d.completed / total } }),
      jsx('div', { key: 'o', style: { minHeight: 1, background: 'var(--ui-stroke-secondary)', opacity: .5, flex: d.other / total } }),
    ]})
  })
  const cronRecentRows = cron.data.recent.slice(0, 12).map((r, i) => jsx('tr', { key: i, children: [
    jsx('td', { key: 's', children: jsx('span', { className: 'hs-tag', children: r.status }) }),
    jsx('td', { key: 'j', children: String(r.job_id || '').slice(0, 12) }),
    jsx('td', { key: 't', children: (r.claimed_at || '').toString().slice(0, 16).replace('T', ' ') }),
    jsx('td', { key: 'e', children: r.error ? String(r.error).slice(0, 32) : '' }),
  ]}))
  const sysCards = [
    jsx(StatCard, { key: 'v', label: 'Hermes 版本', value: c.version || '—', sub: c.model ? `模型 ${c.model}` : null }),
    jsx(StatCard, { key: 'p', label: 'Profile', value: c.profile || 'default', sub: c.skin ? `皮肤 ${c.skin}` : null }),
    jsx(StatCard, { key: 'k', label: 'Skills', value: fmtInt(c.skills_count) }),
    jsx(StatCard, { key: 's', label: '历史会话', value: fmtInt(c.sessions_total) }),
    jsx(StatCard, { key: 'm', label: 'Memory', value: fmtTokens((c.memory_chars && c.memory_chars['MEMORY.md']) || 0) + ' 字符', sub: `USER.md ${fmtTokens((c.memory_chars && c.memory_chars['USER.md']) || 0)}` }),
  ]

  /* — 组装页面（每个 jsx 调用最多一层 children） — */
  const head = jsx('div', { key: 'h', className: 'hs-head', children: [
    jsx('div', { key: 't', className: 'hs-title', children: t('title') }),
    jsx('div', { key: 'r', className: 'hs-radio', children: [7, 30, 90].map(d => jsx('button', {
      key: d, className: d === days ? 'active' : '', onClick: () => setDays(d), children: d + ' 天',
    })) }),
    jsx('button', { key: 'f', className: 'hs-chip', onClick: () => setTick(t => t + 1), children: '刷新' }),
    jsx('span', { key: 'b', className: 'hs-tag', children: `生成于 ${new Date((stats.generated_at || Date.now() / 1000) * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` }),
  ]})
  const sec1 = jsx('div', { key: 's1', className: 'hs-sec', children: jsx('div', { className: 'hs-grid', children: overviewCards }) })
  const sec2 = jsx('div', { key: 's2', className: 'hs-sec', children: [
    jsx('div', { key: 't', className: 'hs-sec-title', children: 'Token 趋势' }),
    jsx(Card, { key: 'a', title: '输入（对数刻度）', children: jsx(TokensChart, { key: 'ch', daily: stats.daily || [] }) }),
    jsx(TwoCol, { key: 'g', a: jsx(Card, { title: '输出', children: jsx(OutputChart, { key: 'oc', daily: stats.daily || [] }) }), b: jsx(Card, { title: '缓存读（对数刻度）', children: jsx(CacheChart, { key: 'cc', daily: stats.daily || [] }) }) }),
  ]})
  const sec3 = jsx('div', { key: 's3', className: 'hs-sec', children: [
    jsx('div', { key: 't', className: 'hs-sec-title', children: ['会话与成本', jsx('span', { key: 'fx', className: 'hs-tag', children: `FX ${fxNoteText()}` })] }),
    jsx(TwoCol, { key: 'g', a: jsx(Card, { title: '每天会话数', children: jsx(SessionsChart, { daily: stats.daily || [] }) }), b: jsx(Card, { title: '每天估算成本（¥）', children: jsx(CostChart, { daily: stats.daily || [] }) }) }),
  ]})
  const sec4 = jsx('div', { key: 's4', className: 'hs-sec', children: [
    jsx('div', { key: 't', className: 'hs-sec-title', children: '分布' }),
    jsx('div', { key: 'd', className: 'hs-donuts', children: [
      jsx(Card, { key: 'p', title: '平台 (Tokens)', children: jsx(Donut, { data: platforms, label: fmtTokens(totalTokens) }) }),
      jsx(Card, { key: 'm', title: '模型 (Tokens)', children: jsx(Donut, { data: models, label: fmtTokens(totalTokens) }) }),
    ]}),
    jsx('div', { key: 'mc', style: { marginTop: 10 }, children: jsx(Card, { title: '模型成本（¥）', children: jsx('table', { className: 'hs-table', children: [
      HeadRow(['模型', 'Tokens', '成本（¥）', '会话']),
      jsx('tbody', { key: 'b', children: modelRows }),
    ]}) }) }),
  ]})
  const skillsTable = jsx('table', { key: 'tb', className: 'hs-table', children: [
    HeadRow(['技能', '加载', '编辑', '最近']),
    jsx('tbody', { key: 'b', children: skillRows }),
  ]})
  const sec5 = jsx('div', { key: 's5', className: 'hs-sec', children: [
    jsx('div', { key: 't', className: 'hs-sec-title', children: '工具 · 技能' }),
    jsx(TwoCol, { key: 'g', a: jsx(Card, { title: 'Top 工具', children: jsx(HBars, { rows: toolRows }) }), b: jsx(Card, { title: `Top 技能（${(stats.skills.summary.distinct_skills_used || 0)} 个用过）`, children: skillsTable }) }),
  ]})
  const hourCard = jsx(Card, { key: 'a', title: `24 小时分布 · 最忙 ${(a.busiest_hour || {}).hour} 时`, children: jsx('div', { className: 'hs-hourbars', children: hourBars }) })
  const weekCard = jsx(Card, { key: 'b', title: '星期分布', children: jsx(HBars, { rows: dayRows }) })
  const sec6 = jsx('div', { key: 's6', className: 'hs-sec', children: [
    jsx('div', { key: 't', className: 'hs-sec-title', children: '活跃模式' }),
    jsx(TwoCol, { key: 'g', a: hourCard, b: weekCard }),
    jsx(Card, { key: 'h', title: '显著会话', children: jsx('div', { className: 'hs-legend', children: sessionHighlights }) }),
  ]})
  const cronJobsCard = jsx(Card, { key: 'a', title: `全部任务 · 累计 ${fmtInt(cron.data.totals.runs)} 次 (失败 ${fmtInt(cron.data.totals.failed)})`, children: jsx('table', { className: 'hs-table', children: [
    HeadRow(['任务', '频率', '最近运行']),
    jsx('tbody', { key: 'b', children: cronJobRows }),
  ]}) })
  const cronDailyCard = jsx(Card, { key: 'b', title: '每日执行 (近 14 天)', children: jsx('div', { className: 'hs-hourbars', style: { height: 60 }, children: cronDaily }) })
  const cronRecentCard = cron.data.recent && cron.data.recent.length
    ? jsx(Card, { key: 'r', title: '最近执行', children: jsx('table', { className: 'hs-table', children: [
      HeadRow(['状态', '任务', '时间', '错误']),
      jsx('tbody', { key: 'b', children: cronRecentRows }),
    ]}) })
    : null
  const sec7 = jsx('div', { key: 's7', className: 'hs-sec', children: [
    jsx('div', { key: 't', className: 'hs-sec-title', children: 'Cron 执行' }),
    jsx(TwoCol, { key: 'g', a: cronJobsCard, b: cronDailyCard }),
    cronRecentCard,
  ]})
  const sec8 = jsx('div', { key: 's8', className: 'hs-sec', children: [
    jsx('div', { key: 't', className: 'hs-sec-title', children: '系统' }),
    jsx('div', { key: 'g', className: 'hs-grid', children: sysCards }),
  ]})
  const note = jsx('div', { key: 'n', className: 'hs-note', children: `${t('note')} 成本按人民币展示 · FX ${fxNoteText()}` })

  return jsx('div', { className: 'hs-root', children: [
    jsx('style', { key: 's', children: STYLE }),
    head, sec1, sec2, sec3, sec4, sec5, sec6, sec7, sec8, note,
  ]})
  } catch (e) {
    console.error('[hs-page] render error:', (e && e.message) || e, (e && e.stack) || '')
    return jsx('div', { className: 'hs-root', children: jsx('div', { className: 'hs-box', children: '渲染错误: ' + ((e && e.message) || String(e)) }) })
  }
}

/* ---------------- statusbar chip ---------------- */

/* chip 文案：纯函数，便于冒烟测试用真实后端数据断言。
   两个坑：① /stats 的 totals 键是 total_estimated_cost（estimated_cost 只出现在 overview/by_model/daily），
   取错键会让成本恒显示 0；② 展示货币是人民币，但 totals 里的钱是美元口径，换算汇率来自模块级 FX
   （由 applyFx 用 /stats 的 fx 字段刷新，测试时可显式传 rate）。 */
function todayChipLabel(totals, t, rate) {
  const o = totals || {}
  const tk = (o.total_input || 0) + (o.total_output || 0)
  const cost = o.total_estimated_cost != null ? o.total_estimated_cost : o.estimated_cost
  return `⚡ ${t('today')} ${fmtTokens(tk)} · ${fmtCost(cost, rate)}`
}

function TodayChip({ rest }) {
  const t = usePluginI18n('hermes-stats')
  const s = useData(() => rest('/stats?days=1'), [], 5 * 60 * 1000)
  let label = t('loading')
  if (s.isError) label = t('error')
  else if (s.data) { applyFx(s.data); label = todayChipLabel(s.data.totals, t) }
  return jsx('button', { className: 'hs-chip', onClick: () => host.navigate('/stats'), title: t('palette'), children: [label] })
}

function ContextChip() {
  const usage = useValue(host.state.focusedUsage)
  const sessId = useValue(host.state.focusedSessionId)
  const brk = useData(
    () => (sessId ? host.request('session.context_breakdown', { session_id: sessId }) : Promise.resolve(null)),
    [sessId], 10 * 1000)
  // 实时测量优先，估算兜底（对未发言的会话也有效，~ 前缀表示估算）
  const u = usage || brk.data
  let label = null
  if (u && u.context_used != null && u.context_max) {
    const pct = Math.max(0, Math.min(100, Math.round(u.context_percent ?? (u.context_used / u.context_max * 100))))
    label = `📏 ctx ${u.context_estimated ? '~' : ''}${pct}% ${fmtTokens(u.context_used)}/${fmtTokens(u.context_max)}`
  } else if (usage && usage.prompt != null) {
    label = `📏 ctx ${fmtTokens(usage.prompt)}`
  }
  if (!label) return null
  return jsx('button', { className: 'hs-chip', onClick: () => host.navigate('/stats'), title: '当前会话上下文用量', children: [label] })
}

/* ---------------- registration ---------------- */

export default {
  id: 'hermes-stats',
  name: 'Hermes Stats · 统计中心',
  register(ctx) {
    const rest = (path, opts) => ctx.rest(path, opts)
    ctx.i18n.register(LOCALES)

    ctx.registerMany([
      {
        id: 'hermes-stats-page',
        area: ROUTES_AREA,
        data: { path: '/stats' },
        render: () => jsx(StatPage, { rest }),
      },
      {
        id: 'hermes-stats-nav',
        area: SIDEBAR_NAV_AREA,
        data: { path: '/stats', label: ctx.i18n.t('nav'), codicon: 'graph-line' },
      },
      {
        id: 'hermes-stats-chip',
        area: STATUSBAR_AREAS.right,
        order: 120,
        render: () => jsx(TodayChip, { rest }),
      },
      {
        id: 'hermes-stats-ctxchip',
        area: STATUSBAR_AREAS.right,
        order: 121,
        render: () => jsx(ContextChip, {}),
      },
      {
        id: 'hermes-stats-open',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-stats.open',
          label: ctx.i18n.t('palette'),
          keywords: ['统计', 'stats', 'usage', '用量', '分析', 'analytics', 'tokens'],
          run: () => host.navigate('/stats'),
        },
      },
    ])

    ctx.register({
      id: 'hermes-stats-style',
      area: STATUSBAR_AREAS.right,
      order: 99,
      render: () => jsx('style', { children: STYLE }),
    })
  },
}