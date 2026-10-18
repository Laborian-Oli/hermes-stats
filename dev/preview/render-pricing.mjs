/** 渲染「价格来源」区块，检查峰谷价与历史价显示。 */
const HERMES_HOME = process.env.HERMES_HOME ?? `${process.env.HOME}/.hermes`
const SRC = process.env.HERMES_SRC ?? `${HERMES_HOME}/hermes-agent`
const { readFile } = await import('node:fs/promises')

globalThis.document = { documentElement: {} }
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })

const { renderToStaticMarkup } = await import(`${SRC}/node_modules/react-dom/server.js`)
const { createElement: h } = await import(`${SRC}/node_modules/react/index.js`)
const P = await import(new URL('../hs-render-test/plugin-smoke.mjs', import.meta.url).href)
const jsx = P.jsx || h

const payload = JSON.parse(await readFile('/tmp/hs-real.json', 'utf8'))
const pr = payload.pricing, t = pr.table

const HeadRow = P.HeadRow
const tierLabel = e => e.time_tier === 'deepseek_peak_offpeak' ? '峰谷价' : null
const priceCell = (v, e) => {
  if (e && e.time_tier === 'deepseek_peak_offpeak' && e.peak && e.off_peak) {
    const pk = e.peak[v], off = e.off_peak[v]
    if (pk == null && off == null) return '—'
    return jsx('span', { title: `峰 $${pk} / 谷 $${off}`, children: pk === off ? '$' + pk : `$${pk}–${off}` })
  }
  return e[v] != null ? '$' + e[v] : '—'
}
const rows = t.entries.map((e, i) => jsx('tr', { key: i, children: [
  jsx('td', { key: 'k', children: [e.key, tierLabel(e) ? jsx('span', { key: 'tt', className: 'hs-tag', children: ' ' + tierLabel(e) }) : null] }),
  jsx('td', { key: 'i', children: priceCell('input', e) }),
  jsx('td', { key: 'o', children: priceCell('output', e) }),
  jsx('td', { key: 'r', children: priceCell('cache_read', e) }),
  jsx('td', { key: 'c', children: (t.labels && t.labels[e.confidence]) || e.confidence }),
  jsx('td', { key: 'd', children: e.checked || '—' }),
]}))
const histKeys = Object.keys(t.price_history || {}).filter(k => (t.price_history[k] || []).length)
const histRows = histKeys.map(k => jsx('tr', { key: k, children: [
  jsx('td', { key: 'k', children: k }),
  jsx('td', { key: 'd', children: t.price_history[k].map(e => `${e.from || '?'} ~ ${e.until || '至今'}`).join(' ; ') }),
  jsx('td', { key: 'n', colSpan: 4, children: t.price_history[k][t.price_history[k].length - 1].note || '—' }),
]}))

const page = jsx('div', { className: 'hs-root', children: [
  jsx('style', { key: 's', children: P.STYLE }),
  jsx('div', { key: 'h', className: 'hs-head', children: [
    jsx('div', { key: 't', className: 'hs-title', children: '价格来源（真实数据）' }),
    jsx('span', { key: 'v', className: 'hs-tag', children: `price_table.yaml v${t.version} · ${t.updated}` }),
  ]}),
  jsx('div', { key: 'sp', className: 'hs-sec', children: [
    jsx('div', { key: 'tt', className: 'hs-sec-title', children: `成本 ${(pr.cost_usd * payload.fx.usd_cny).toFixed(2)} 元 · 覆盖 ${(pr.coverage * 100).toFixed(1)}%` }),
    jsx(P.Card, { key: 'c', children: jsx('div', { className: 'hs-note', children: '单价单位 USD / 每百万 token。峰谷价按调用时刻判定：UTC 周一至周五 01-04 与 06-10 为峰（北京时间 09-12、14-18），周末与节假日全为谷。' }) }),
    jsx('table', { key: 'tb', className: 'hs-table', children: [
      jsx('thead', { key: 'hh', children: jsx('tr', { children: [HeadRow(['模型', '输入', '输出', '缓存读', '口径', '核对于'])] }) }),
      jsx('tbody', { key: 'b', children: rows }),
    ] }),
    jsx('div', { key: 'sh', className: 'hs-sec-title', style: { marginTop: 14 }, children: '历史调价（按调用时间取当时那档价）' }),
    jsx('table', { key: 'ht', className: 'hs-table', children: [
      jsx('thead', { key: 'h2', children: jsx('tr', { children: [HeadRow(['模型', '生效区间', '说明'])] }) }),
      jsx('tbody', { key: 'hb', children: histRows }),
    ] }),
  ]}),
]})

const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{background:#14161c;margin:0;padding:16px;font-family:-apple-system,"Segoe UI",sans-serif}</style></head><body><div style="max-width:920px;margin:0 auto">${renderToStaticMarkup(page)}</div></body></html>`
await (await import('node:fs/promises')).writeFile('/tmp/hs-pricing.html', html)
console.log('HTML 就绪 /tmp/hs-pricing.html')
console.log(`成本 $${pr.cost_usd} · 覆盖 ${(pr.coverage*100).toFixed(1)}% · 历史价 ${histKeys.length} 个模型`)