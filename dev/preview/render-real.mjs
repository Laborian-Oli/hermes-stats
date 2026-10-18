/**
 * 用【真实后端数据】渲染统计页 —— 只给本机自看，不提交（防真实用量外泄）。
 * 与 render-preview.mjs 的区别：那份用合成数据给 README，这份用真数据验证改动。
 *
 * 用法：node dev/preview/render-real.mjs
 */
const HERMES_HOME = process.env.HERMES_HOME ?? `${process.env.HOME}/.hermes`
const SRC = process.env.HERMES_SRC ?? `${HERMES_HOME}/hermes-agent`

const { readFile, writeFile, mkdir } = await import('node:fs/promises')
const root = new URL('../../', import.meta.url)
let testSrc = await readFile(new URL('plugin/desktop/plugin.js', root), 'utf8')
testSrc = testSrc
  .replace("from 'react/jsx-runtime'", `from '${SRC}/node_modules/react/jsx-runtime.js'`)
  .replace("from 'react'", `from '${SRC}/node_modules/react/index.js'`)
  .replace("from '@hermes/plugin-sdk'", "from './stub-sdk.mjs'")
if (!/^export \{/m.test(testSrc)) {
  testSrc += "\nexport { STYLE, fmtInt, fmtTokens, fmtCost, todayChipLabel, applyFx, HeadRow, Card, TwoCol, StatCard, TokensChart, OutputChart, CacheChart, SessionsChart, CostChart, Donut, HBars, StatPage }\n"
}
await writeFile(new URL('dev/hs-render-test/plugin-real.mjs', root), testSrc)

globalThis.document = { documentElement: {} }
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })

const { renderToStaticMarkup } = await import(`${SRC}/node_modules/react-dom/server.js`)
const { createElement: h } = await import(`${SRC}/node_modules/react/index.js`)

// 真实数据：从后端 payload 直接读，不重新查库（保证与页面实际显示一致）
const payload = JSON.parse(await readFile('/tmp/hs-real.json', 'utf8'))

const P = await import(new URL('dev/hs-render-test/plugin-real.mjs', root).href)
const jsx = P.jsx || h
const stats = payload
const o = stats.overview, a = stats.activity, m = stats.by_model

const head = jsx('div', { key: 'h', className: 'hs-head', children: [
  jsx('div', { key: 't', className: 'hs-title', children: '统计中心（真实数据）' }),
  jsx('div', { key: 'r', className: 'hs-radio', children: ['7', '30', '90'].map(d => jsx('button', { key: d, className: d === '30' ? 'active' : '', children: d + ' 天' })) }),
  jsx('span', { key: 'b', className: 'hs-tag', children: `生成于 ${new Date((stats.generated_at || Date.now()/1000)*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}` }),
]})

const cards = [
  jsx(P.StatCard, { key:'a', label:'会话', value: P.fmtInt(o.total_sessions), sub: o.user_messages?`用户消息 ${P.fmtInt(o.user_messages)}`:null }),
  jsx(P.StatCard, { key:'b', label:'消息', value: P.fmtInt(o.total_messages), sub:`平均 ${(o.avg_messages_per_session||0).toFixed(1)}/会话` }),
  jsx(P.StatCard, { key:'c', label:'总 Tokens', value: P.fmtTokens((o.total_input_tokens||0)+(o.total_output_tokens||0)), sub:`缓存读 ${P.fmtTokens(o.total_cache_read_tokens||0)}` }),
  jsx(P.StatCard, { key:'d', label:'成本（¥）', value: P.fmtCost(stats.pricing.cost_usd), sub: `${stats.pricing.unpriced.length} 个模型未定价（已计 ¥${P.fmtCost(stats.pricing.cost_usd).replace('¥','')}）` }),
  jsx(P.StatCard, { key:'e', label:'工具调用', value: P.fmtInt(o.total_tool_calls), sub: stats.totals&&stats.totals.total_api_calls!=null?`API 调用 ${P.fmtInt(stats.totals.total_api_calls)}`:null }),
  jsx(P.StatCard, { key:'f', label:'活跃时长', value:(o.total_hours||0).toFixed(1)+'h', sub:a?`活跃 ${a.active_days} 天 · 最长连续 ${a.max_streak} 天`:null }),
]

const page = jsx('div', { className: 'hs-root', children: [
  jsx('style', { key: 's', children: P.STYLE || '' }),
  head,
  jsx('div', { key:'o', className:'hs-grid', children: cards }),
  jsx('div', { key:'s1', className:'hs-sec', children:[
    jsx('div',{key:'t',className:'hs-sec-title',children:'会话与成本'}),
    jsx(P.TwoCol,{key:'g',a:jsx(P.Card,{title:'每天会话数',children:jsx(P.SessionsChart,{daily:stats.daily})}),b:jsx(P.Card,{title:'每天估算成本（¥）',children:jsx(P.CostChart,{daily:stats.daily})})}),
  ]}),
  jsx('div',{key:'s3',className:'hs-sec',children:[
    jsx('div',{key:'t',className:'hs-sec-title',children:'模型成本'}),
    jsx(P.Card,{key:'c',children:jsx('table',{className:'hs-table',children:[
      jsx('thead',{key:'h',children:jsx('tr',{children:[P.HeadRow(['模型','Tokens','成本（¥）','会话'])]})}),
      jsx('tbody',{key:'b',children:(stats.pricing.by_model||[]).map((mm,i)=>jsx('tr',{key:i,children:[
        jsx('td',{key:'n',children:mm.model+(mm.status==='estimate'?' 估算':mm.status==='free'?' 本地免费':'')}),
        jsx('td',{key:'t',children:P.fmtTokens(mm.tokens)}),
        jsx('td',{key:'c',children:P.fmtCost(mm.cost_usd)}),
        jsx('td',{key:'s',children:P.fmtInt((stats.by_model.find(x=>x.model===mm.model)||{}).sessions||0)}),
      ]}))}),
    ]})}),
  ]}),
]})

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{background:#14161c;margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
</style></head><body><div style="max-width:920px;margin:0 auto">${renderToStaticMarkup(page)}</div></body></html>`
await writeFile('/tmp/hs-real.html', html)
console.log('HTML 就绪: /tmp/hs-real.html')
console.log(`成本 ${stats.pricing.cost_usd} USD, 覆盖 ${(stats.pricing.coverage*100).toFixed(1)}%`)