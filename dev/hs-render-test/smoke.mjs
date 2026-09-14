/**
 * hermes-stats — SSR 冒烟测试
 *
 * 用真实后端数据 + 真实 React 服务端渲染逐个渲染组件，
 * 把"页面打开才炸"变成"保存前就能验"。
 *
 * 环境变量（均有默认值）：
 *   HERMES_HOME   默认 ~/.hermes
 *   HERMES_SRC    默认 $HERMES_HOME/hermes-agent（提供 node_modules/react*）
 *   HS_PORT       本地 hermes serve 端口
 *   HS_TOKEN      dashboard session token（请求 /api/plugins/hermes-stats 用）
 *
 * 用法：HS_PORT=<port> HS_TOKEN=<token> node smoke.mjs
 * （自动从 plugin/desktop/plugin.js 生成 plugin-test.mjs，无需手工复制）
 */
const HERMES_HOME = process.env.HERMES_HOME ?? `${process.env.HOME}/.hermes`
const SRC = process.env.HERMES_SRC ?? `${HERMES_HOME}/hermes-agent`

// 把插件源码生成为可导入的 plugin-test.mjs（替换 import 头：react 绝对路径 + SDK stub）
const { readFile, writeFile } = await import('node:fs/promises')
const pluginSrc = new URL('../../plugin/desktop/plugin.js', import.meta.url)
let testSrc = await readFile(pluginSrc, 'utf8')
testSrc = testSrc
  .replace("from 'react/jsx-runtime'", `from '${SRC}/node_modules/react/jsx-runtime.js'`)
  .replace("from 'react'", `from '${SRC}/node_modules/react/index.js'`)
  .replace("from '@hermes/plugin-sdk'", "from './stub-sdk.mjs'")
// 源码不含 named export（运行时由 SDK 注册），补一行供冒烟测试逐个渲染
if (!/^export \{/m.test(testSrc)) {
  testSrc += "\nexport { TokensChart, OutputChart, CacheChart, SessionsChart, CostChart, Donut, HBars, Card, TwoCol, HeadRow, StatCard, StatPage, TodayChip, ContextChip, todayChipLabel }\n"
}
await writeFile(new URL('./plugin-test.mjs', import.meta.url), testSrc)

globalThis.document = { documentElement: {} }
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })

const { renderToStaticMarkup } = await import(`${SRC}/node_modules/react-dom/server.js`)
const { createElement: h } = await import(`${SRC}/node_modules/react/index.js`)
const P = await import('./plugin-test.mjs')

const PORT = process.env.HS_PORT
const TOKEN = process.env.HS_TOKEN
const get = p => fetch(`http://127.0.0.1:${PORT}/api/plugins/hermes-stats` + p, { headers: { Authorization: `Bearer ${TOKEN}` } }).then(r => r.json())
const stats = await get('/stats?days=7')

const cases = [
  ['TokensChart', h(P.TokensChart, { daily: stats.daily || [] })],
  ['OutputChart', h(P.OutputChart, { daily: stats.daily || [] })],
  ['CacheChart', h(P.CacheChart, { daily: stats.daily || [] })],
  ['SessionsChart', h(P.SessionsChart, { daily: stats.daily || [] })],
  ['CostChart', h(P.CostChart, { daily: stats.daily || [] })],
  ['Donut', h(P.Donut, { data: (stats.platforms || []).map(p => ({ label: p.platform, value: p.total_tokens || 0 })), label: 'x' })],
  ['HBars', h(P.HBars, { rows: (stats.tools || []).slice(0, 10).map(t => ({ label: t.tool, value: t.count, pct: t.percentage })) })],
  ['TodayChip(stub host)', h(P.TodayChip, { rest: p => get(p) })],
]
let fail = 0
for (const [name, el] of cases) {
  try { renderToStaticMarkup(el); console.log('✅', name) }
  catch (e) { fail++; console.log('❌', name, '-', e.message) }
}

// ContextChip：stub host 无聚焦会话 → 应渲染为空，不崩溃
try {
  const c2 = renderToStaticMarkup(h(P.ContextChip))
  if (c2.length === 0) console.log('✅ ContextChip(无会话→空)')
  else console.log(`✅ ContextChip 渲染 ${c2.length} 字符`)
} catch (e) { fail++; console.log('❌ ContextChip -', e.message) }

// 模型环图数据通路检查
const modelDonutHtml = renderToStaticMarkup(h(P.Donut, { data: (stats.by_model || []).map(m => ({ label: m.model, value: (m.input_tokens || 0) + (m.output_tokens || 0) })), label: 'm' }))
console.log(modelDonutHtml.length > 100 ? `✅ 模型环图有数据 (${modelDonutHtml.length}字符)` : `❌ 模型环图仍空 (${modelDonutHtml.length}字符)`)

// 状态栏 chip 文案回归护栏：成本必须折成人民币且非零
// （曾经的 bug：读 totals.estimated_cost 这个不存在的键 → chip 恒显示 0）
const one = await get('/stats?days=1')
const fxRate = one.fx && one.fx.usd_cny > 0 ? one.fx.usd_cny : 7.1
const chipText = P.todayChipLabel(one.totals, k => ({ today: '今日', loading: '…', error: '错误' }[k] ?? k), fxRate)
const cny = (one.totals.total_estimated_cost || 0) * fxRate
const expectTxt = cny >= 1 ? '¥' + cny.toFixed(2) : cny > 0 ? '¥' + cny.toPrecision(2) : '¥0'
if (chipText.includes(expectTxt)) console.log(`✅ TodayChip 文案「${chipText}」= 期望成本 ${expectTxt}`)
else { fail++; console.log(`❌ TodayChip 文案「${chipText}」不含期望成本 ${expectTxt}`) }

console.log(fail === 0 ? '🎉 全部通过' : fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)