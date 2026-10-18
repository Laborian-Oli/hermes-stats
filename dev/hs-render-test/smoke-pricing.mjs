/** 冒烟：用真实 payload 直接调 StatPage，确认改动没把页面打挂。 */
const HERMES_HOME = process.env.HERMES_HOME ?? `${process.env.HOME}/.hermes`
const SRC = process.env.HERMES_SRC ?? `${HERMES_HOME}/hermes-agent`

const { readFile, writeFile } = await import('node:fs/promises')
const root = new URL('../../', import.meta.url)
let src = await readFile(new URL('plugin/desktop/plugin.js', root), 'utf8')
src = src
  .replace("from 'react/jsx-runtime'", `from '${SRC}/node_modules/react/jsx-runtime.js'`)
  .replace("from 'react'", `from '${SRC}/node_modules/react/index.js'`)
  .replace("from '@hermes/plugin-sdk'", "from './stub-sdk.mjs'")
src += "\nexport { StatPage, todayChipLabel, fmtCost, fmtTokens, STYLE, applyFx }\n"
await writeFile(new URL('dev/hs-render-test/plugin-smoke.mjs', root), src)

globalThis.document = { documentElement: {} }
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })

const { renderToStaticMarkup } = await import(`${SRC}/node_modules/react-dom/server.js`)
const { createElement: h } = await import(`${SRC}/node_modules/react/index.js`)
const P = await import(new URL('dev/hs-render-test/plugin-smoke.mjs', root).href)

const payload = JSON.parse(await readFile('/tmp/hs-real.json', 'utf8'))
P.applyFx(payload)

// StatPage 需要 hook 宿主，这里直接测纯函数与 chip 文案，
// 页面主体已在 render-real.mjs 里用同样数据渲染过。
console.log('--- chip 文案（今日） ---')
const today = JSON.parse(await readFile('/tmp/hs-real.json', 'utf8')).totals
const inc = today.total_input_tokens_all + today.total_output_tokens_all
const main = today.total_input + today.total_output
console.log(`  主任务口径  ${main.toLocaleString()} tokens`)
console.log(`  含辅助口径  ${inc.toLocaleString()} tokens   (多 ${(((inc - main) / main) * 100).toFixed(1)}%)`)
console.log('  chip 实际显示:', P.todayChipLabel(today, k => k === 'today' ? '今日' : k, null, payload.pricing))
// 老 payload（无 _all 字段）应退回主任务口径而不是崩掉
const legacy = { total_input: today.total_input, total_output: today.total_output, total_estimated_cost: 0 }
console.log('  老 payload 兼容:', P.todayChipLabel(legacy, k => k === 'today' ? '今日' : k, null, payload.pricing))
console.log('  退化路径(无 pricing):', P.todayChipLabel(today, k => k === 'today' ? '今日' : k, 7.10, null))

console.log('\n--- fmtCost 边界 ---')
console.log('  0        ->', P.fmtCost(0, 7.1))
console.log('  0.00001  ->', P.fmtCost(0.00001, 7.1))
console.log('  1.5      ->', P.fmtCost(1.5, 7.1))
console.log('  null     ->', P.fmtCost(null, 7.1))
console.log('  null+flag->', P.fmtCost(null, 7.1, true))
console.log('  NaN      ->', P.fmtCost(NaN, 7.1))
console.log('  undefined->', P.fmtCost(undefined, 7.1))

console.log('\n--- 价格表自检 ---')
const t = payload.pricing.table
console.log('  版本', t.version, '条目', t.entries.length, '别名规则', t.alias_rules.length)
for (const e of t.entries) {
  console.log(`   ${e.key.padEnd(26)} in=$${e.input} out=$${e.output} cache=$${e.cache_read} [${t.labels[e.confidence]}] ${e.checked}`)
}
console.log('\nOK: 未抛异常')