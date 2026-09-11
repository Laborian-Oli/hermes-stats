/**
 * hermes-stats — 预览图生成（README 用）
 *
 * 用【合成数据】渲染统计页效果图（绝不使用真实 usage 数据，防隐私泄漏）：
 * 真实组件（来自 plugin/desktop/plugin.js）+ 无头 Chrome 截图 → assets/preview.png
 *
 * 用法：node dev/preview/render-preview.mjs
 * 依赖：google-chrome-stable 可用；HERMES_HOME/HERMES_SRC 定位 react（默认 ~/.hermes）
 */
const HERMES_HOME = process.env.HERMES_HOME ?? `${process.env.HOME}/.hermes`
const SRC = process.env.HERMES_SRC ?? `${HERMES_HOME}/hermes-agent`

// 生成可导入副本（同 smoke.mjs 的转换逻辑）
const { readFile, writeFile, mkdir } = await import('node:fs/promises')
const root = new URL('../../', import.meta.url)
let testSrc = await readFile(new URL('plugin/desktop/plugin.js', root), 'utf8')
testSrc = testSrc
  .replace("from 'react/jsx-runtime'", `from '${SRC}/node_modules/react/jsx-runtime.js'`)
  .replace("from 'react'", `from '${SRC}/node_modules/react/index.js'`)
  .replace("from '@hermes/plugin-sdk'", "from './stub-sdk.mjs'")
if (!/^export \{/m.test(testSrc)) {
  testSrc += "\nexport { TokensChart, OutputChart, CacheChart, SessionsChart, CostChart, Donut, HBars, Card, TwoCol, HeadRow, StatCard, StatPage, TodayChip, ContextChip }\n"
}
await writeFile(new URL('dev/hs-render-test/plugin-test.mjs', root), testSrc)

globalThis.document = { documentElement: {} }
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })

const { renderToStaticMarkup } = await import(`${SRC}/node_modules/react-dom/server.js`)
const { createElement: h } = await import(`${SRC}/node_modules/react/index.js`)
const P = await import('../hs-render-test/plugin-test.mjs')
const { jsx } = await import(`${SRC}/node_modules/react/jsx-runtime.js`)

/* ---------- 合成数据（与真实用量无关的示意值） ---------- */
const rnd = (min, max) => Math.round(min + Math.random() * (max - min))
const N = 30
const daily = Array.from({ length: N }, (_, i) => {
  const day = `2026-03-${String(i + 1).padStart(2, '0')}`
  const input = i % 13 === 0 ? 0 : Math.round(180000 + 420000 * Math.abs(Math.sin(i * 0.9)) + (i % 9 === 0 ? rnd(1200000, 1900000) : 0))
  const output = i % 13 === 0 ? 0 : Math.round(input * (0.05 + 0.04 * Math.abs(Math.sin(i * 1.7))))
  const cache = i % 13 === 0 ? 0 : Math.round(input * (4 + 3 * Math.abs(Math.sin(i * 0.4))))
  return {
    day, input_tokens: input, output_tokens: output,
    cache_read_tokens: cache, cache_write_tokens: Math.round(cache * 0.05),
    sessions: i % 13 === 0 ? 0 : rnd(1, 8),
    estimated_cost: 0,
  }
})
const sum = k => daily.reduce((s, d) => s + (d[k] || 0), 0)
const stats = {
  overview: {
    total_sessions: sum('sessions'), total_messages: sum('sessions') * 9,
    total_input_tokens: sum('input_tokens'), total_output_tokens: sum('output_tokens'),
    total_cache_read_tokens: sum('cache_read_tokens'), estimated_cost: 0,
    total_tool_calls: sum('sessions') * 11, total_hours: sum('sessions') * 0.4,
    avg_messages_per_session: 9, unknown_cost_sessions: sum('sessions'),
  },
  totals: { total_input: sum('input_tokens'), total_output: sum('output_tokens'), estimated_cost: 0 },
  daily,
  platforms: [
    { platform: 'desktop', input_tokens: sum('input_tokens') * 0.82, output_tokens: sum('output_tokens') * 0.85 },
    { platform: 'cron', input_tokens: sum('input_tokens') * 0.14, output_tokens: sum('output_tokens') * 0.11 },
    { platform: 'cli', input_tokens: sum('input_tokens') * 0.04, output_tokens: sum('output_tokens') * 0.04 },
  ],
  // 占位模型名：预览图不暴露任何真实模型/用量
  by_model: [
    { model: 'alpha-model', input_tokens: sum('input_tokens') * 0.65, output_tokens: sum('output_tokens') * 0.7, estimated_cost: 0, sessions: rnd(20, 40) },
    { model: 'beta-model', input_tokens: sum('input_tokens') * 0.35, output_tokens: sum('output_tokens') * 0.3, estimated_cost: 0, sessions: rnd(8, 16) },
  ],
  tools: (['web_search', 'read_file', 'terminal', 'write_file', 'patch', 'browser_navigate']).map((t, i) => ({ tool: t, count: rnd(40, 160) - i * 12, percentage: 18 - i * 2 })),
  skills: { summary: { distinct_skills_used: 7 }, top_skills: [] },
  activity: {
    by_hour: Array.from({ length: 24 }, (_, i) => ({ hour: i, count: (i >= 9 && i <= 23) ? rnd(0, 5) : 0 })),
    by_day: ['一', '二', '三', '四', '五', '六', '日'].map((d, i) => ({ day: '周' + d, count: rnd(8, 22) })),
    busiest_hour: { hour: 20 }, active_days: 26, max_streak: 9,
  },
  top_sessions: [], generated_at: Date.now() / 1000,
}

/* ---------- 预览页（复刻统计页上半部分，造型一致） ---------- */
const css = `
:root{--ui-accent:#FFBF00;--ui-text-secondary:#d8cfae;--ui-text-quaternary:#8f8570;--ui-stroke-secondary:#6d644f;--ui-destructive:#e55}
*{box-sizing:border-box}
body{background:#1a1a2e;color:#FFF8DC;font-family:'Noto Sans CJK SC','Noto Sans',system-ui,sans-serif;margin:16px}
.hs-root{max-width:920px;font-size:13px;line-height:1.5}
.hs-head{display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap}
.hs-title{font-size:17px;font-weight:650}
.hs-radio{display:inline-flex;border:1px solid var(--ui-stroke-secondary);border-radius:8px;overflow:hidden}
.hs-radio button{background:transparent;border:0;color:var(--ui-text-secondary);padding:4px 12px;font-size:12px}
.hs-radio button.active{background:rgba(255,191,0,.18);color:var(--ui-accent);font-weight:600}
.hs-tag{font-size:10px;padding:1px 7px;border-radius:99px;border:1px solid var(--ui-stroke-secondary);color:var(--ui-text-secondary)}
.hs-sec{margin-top:20px}
.hs-sec-title{display:flex;align-items:center;gap:7px;font-size:14px;font-weight:600;margin-bottom:9px}
.hs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:9px}
.hs-card{border:1px solid var(--ui-stroke-secondary);border-radius:9px;padding:10px 13px;background:rgba(255,191,0,.03)}
.hs-stat-label{font-size:11px;color:var(--ui-text-quaternary)}
.hs-stat-value{font-size:17px;font-weight:650;margin-top:2px}
.hs-stat-sub{font-size:11px;color:var(--ui-text-quaternary);margin-top:2px}
.hs-chart-card{border:1px solid var(--ui-stroke-secondary);border-radius:9px;padding:12px 14px;margin-top:10px}
.hs-chart-title{font-size:12px;color:var(--ui-text-secondary);margin-bottom:6px}
.hs-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--ui-text-secondary)}
.hs-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px}
.hs-donuts{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}
.hs-table{width:100%;border-collapse:collapse;font-size:12px}
.hs-table th{text-align:left;color:var(--ui-text-quaternary);font-weight:500;padding:5px 8px;border-bottom:1px solid var(--ui-stroke-secondary)}
.hs-table td{padding:5px 8px;border-bottom:1px solid rgba(109,100,79,.45)}
.hs-note{margin-top:22px;font-size:11px;color:var(--ui-text-quaternary)}
`

const o = stats.overview
const fmtTokens = n => (n = n || 0) >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n)
const fmtCost = n => (n = n || 0) >= 1 ? '$' + n.toFixed(2) : n > 0 ? '$' + n.toPrecision(2) : '$0'

const cards = [
  jsx(P.StatCard, { key: 'a', label: '会话', value: String(o.total_sessions), sub: `用户消息 ${o.total_messages}` }),
  jsx(P.StatCard, { key: 'b', label: '消息', value: String(o.total_messages) }),
  jsx(P.StatCard, { key: 'c', label: '总 Tokens', value: fmtTokens(o.total_input_tokens + o.total_output_tokens), sub: `缓存读 ${fmtTokens(o.total_cache_read_tokens)}` }),
  jsx(P.StatCard, { key: 'd', label: '成本', value: fmtCost(o.estimated_cost), sub: `${o.unknown_cost_sessions} 会话无定价` }),
  jsx(P.StatCard, { key: 'e', label: '工具调用', value: String(o.total_tool_calls) }),
  jsx(P.StatCard, { key: 'f', label: '活跃时长', value: o.total_hours.toFixed(1) + 'h' }),
]
const sections = [
  jsx('div', { key: 's1', className: 'hs-sec', children: jsx('div', { className: 'hs-grid', children: cards }) }),
  jsx('div', { key: 's2', className: 'hs-sec', children: [
    jsx('div', { key: 't', className: 'hs-sec-title', children: 'Token 趋势' }),
    jsx(P.Card, { key: 'a', title: '输入（对数刻度）', children: jsx(P.TokensChart, { daily }) }),
    jsx(P.TwoCol, { key: 'g', a: jsx(P.Card, { title: '输出', children: jsx(P.OutputChart, { daily }) }), b: jsx(P.Card, { title: '缓存读（对数刻度）', children: jsx(P.CacheChart, { daily }) }) }),
  ]}),
  jsx('div', { key: 's3', className: 'hs-sec', children: [
    jsx('div', { key: 't', className: 'hs-sec-title', children: '会话与成本' }),
    jsx(P.TwoCol, { key: 'g', a: jsx(P.Card, { title: '每天会话数', children: jsx(P.SessionsChart, { daily }) }), b: jsx(P.Card, { title: '每天估算成本', children: jsx(P.CostChart, { daily }) }) }),
  ]}),
  jsx('div', { key: 's4', className: 'hs-sec', children: [
    jsx('div', { key: 't', className: 'hs-sec-title', children: '分布' }),
    jsx('div', { key: 'd', className: 'hs-donuts', children: [
      jsx(P.Card, { key: 'p', title: '平台 (Tokens)', children: jsx(P.Donut, { data: stats.platforms.map(p => ({ label: p.platform, value: p.input_tokens + p.output_tokens })), label: fmtTokens(o.total_input_tokens + o.total_output_tokens) }) }),
      jsx(P.Card, { key: 'm', title: '模型 (Tokens)', children: jsx(P.Donut, { data: stats.by_model.map(m => ({ label: m.model, value: m.input_tokens + m.output_tokens })), label: fmtTokens(o.total_input_tokens + o.total_output_tokens) }) }),
    ]}),
  ]}),
]
const head = jsx('div', { key: 'h', className: 'hs-head', children: [
  jsx('div', { key: 't', className: 'hs-title', children: '统计中心' }),
  jsx('div', { key: 'r', className: 'hs-radio', children: ['7', '30', '90'].map(d => jsx('button', { key: d, className: d === '30' ? 'active' : '', children: d + ' 天' })) }),
  jsx('span', { key: 'b', className: 'hs-tag', children: '生成于 10:30' }),
]})
const page = jsx('div', { className: 'hs-root', children: [jsx('style', { key: 's', children: css }), head, ...sections] })

const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div style="margin:16px">${renderToStaticMarkup(page)}</div></body></html>`
await mkdir(new URL('assets/', root), { recursive: true })
await writeFile(new URL('/tmp/hs-preview.html', import.meta.url), html)
console.log('HTML 就绪')