import { el, icon, readStore, writeStore, reducedMotion } from './ui.js'
import { NODE_CATEGORY, EDGE_CATEGORY } from './understand.js'

const LAYOUT_KEY = 'claude-dashboard-understand-layout'
const LAYOUTS = [
  { key: 'horizontal', label: 'Horizontal' },
  { key: 'vertical', label: 'Vertical' },
  { key: 'waterfall', label: 'Waterfall' },
]
const KMIN = 0.01
const KMAX = 2
const WORKER_BOXES = 300
const TYPE_COLOR = { file: 'file', function: 'function', class: 'class', module: 'module', concept: 'concept', config: 'config', document: 'document', service: 'service', table: 'table', endpoint: 'endpoint', pipeline: 'pipeline', schema: 'schema', resource: 'resource', domain: 'concept', flow: 'pipeline', step: 'function', article: 'article', entity: 'entity', topic: 'topic', claim: 'claim', source: 'source', page: 'concept', screen: 'service', component: 'class', componentSet: 'module', instance: 'function', token: 'config' }
export const STRUCTURAL_TYPES = new Set(['file', 'function', 'class', 'module', 'concept', 'config', 'document', 'service', 'table', 'endpoint', 'pipeline', 'schema', 'resource', 'domain', 'flow', 'step', 'page', 'screen', 'component', 'componentSet', 'instance', 'token'])
const SUB_FILE = new Set(['function', 'class'])

export function typeColor(type) {
  return `var(--ua-t-${Object.hasOwn(TYPE_COLOR, type) ? TYPE_COLOR[type] : 'file'})`
}

export function layerColor(index) {
  return `var(--ua-l${index % 7})`
}

export function nodePasses(node, state) {
  if (state.persona === 'non-technical' && SUB_FILE.has(node.type)) return false
  if (state.categories[Object.hasOwn(NODE_CATEGORY, node.type) ? NODE_CATEGORY[node.type] : 'code'] === false) return false
  return state.filters.nodeTypes.has(node.type) && state.filters.complexities.has(node.complexity)
}

export function edgePasses(edge, state) {
  return !Object.hasOwn(EDGE_CATEGORY, edge.type) || state.filters.edgeCategories.has(EDGE_CATEGORY[edge.type])
}

const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const fix = (n) => Math.round(n * 10) / 10
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const weight = (count) => Math.min(1 + Math.log2(count + 1), 5)
const plural = (n, word) => `${n} ${word}${n !== 1 ? 's' : ''}`
const measure = document.createElement('canvas').getContext('2d')
let font = null

function labelSize(text) {
  font = font || getComputedStyle(document.body).fontFamily
  measure.font = `600 11px ${font}`
  return { w: Math.ceil(measure.measureText(text).width) + 14, h: 18 }
}

let ready = null

function script(src) {
  return new Promise((resolve, reject) => {
    const node = document.createElement('script')
    node.src = src
    node.onload = resolve
    node.onerror = () => reject(new Error('Could not load the graph layout.'))
    document.head.append(node)
  })
}

function layoutReady() {
  if (!ready) {
    ready = script('/vendor/dagre.min.js')
      .then(() => script('/understand-layout.js'))
      .catch((error) => {
        ready = null
        throw error
      })
  }
  return ready
}

const memo = new WeakMap()

function indexOf(graph) {
  if (memo.has(graph)) return memo.get(graph)
  const lastLayer = new Map()
  const firstLayer = new Map()
  for (const layer of graph.layers) {
    for (const id of layer.nodeIds) {
      lastLayer.set(id, layer.id)
      if (!firstLayer.has(id)) firstLayer.set(id, layer.id)
    }
  }
  const pairs = new Map()
  for (const e of graph.edges) {
    const a = lastLayer.get(e.source)
    const b = lastLayer.get(e.target)
    if (!a || !b || a === b) continue
    const [from, to] = a < b ? [a, b] : [b, a]
    const key = `${from}|${to}`
    if (!pairs.has(key)) pairs.set(key, { from, to, count: 0 })
    pairs.get(key).count++
  }
  const index = { layerEdges: [...pairs.values()], firstLayer, byId: new Map(graph.nodes.map((n) => [n.id, n])), layerIndex: new Map(graph.layers.map((l, i) => [l.id, i])) }
  memo.set(graph, index)
  return index
}

function overviewModel(state, index) {
  const picked = state.filters.layerIds
  const shown = state.graph.layers.map((layer, i) => ({ id: layer.id, kind: 'layer', layer, index: i })).filter((item) => !picked.size || picked.has(item.id))
  const ids = new Set(shown.map((item) => item.id))
  return {
    kind: 'overview',
    top: shown,
    rootEdges: index.layerEdges.filter((p) => ids.has(p.from) && ids.has(p.to)).map((p, i) => ({ id: `le-${i}`, from: p.from, to: p.to, kind: 'agg', label: String(p.count), width: weight(p.count) })),
    inner: [],
    drawn: [],
    atomOf: new Map(),
    members: new Map(),
    edges: [],
  }
}

function project(derived, files, nodes) {
  const home = new Map()
  const meta = new Map()
  for (const c of derived.containers) {
    meta.set(c.id, c)
    for (const id of c.nodeIds) home.set(id, c.id)
  }
  const fileAt = new Map(files.filter((f) => f.filePath).map((f) => [f.filePath, f]))
  const parentOf = (n) => (SUB_FILE.has(n.type) && !home.has(n.id) ? fileAt.get(n.filePath) : null)
  for (const n of nodes) {
    const file = parentOf(n)
    if (!file || home.has(file.id)) continue
    const id = `container:file:${file.id}`
    home.set(file.id, id)
    meta.set(id, { id, name: file.name, strategy: 'file' })
  }
  const groups = new Map()
  const ungrouped = []
  for (const n of nodes) {
    const file = parentOf(n)
    const cid = home.get(n.id) || (file && home.get(file.id))
    if (!cid) {
      ungrouped.push(n.id)
      continue
    }
    if (!groups.has(cid)) groups.set(cid, [])
    groups.get(cid).push(n.id)
  }
  const containers = []
  for (const c of meta.values()) {
    const ids = groups.get(c.id)
    if (!ids) continue
    if (ids.length === 1 && nodes.length >= 3) ungrouped.push(ids[0])
    else containers.push({ ...c, nodeIds: ids })
  }
  return { containers, ungrouped }
}

function layerModel(state, index) {
  const { graph } = state
  const layer = graph.layers.find((l) => l.id === state.layerId)
  if (!layer) return null
  const inLayer = new Set(layer.nodeIds)
  const wanted = new Set(inLayer)
  if (state.detailLevel === 'class') {
    for (const e of graph.edges) {
      if (e.type !== 'contains' || !inLayer.has(e.source)) continue
      const child = index.byId.get(e.target)
      if (child && (child.type === 'class' || (child.type === 'function' && state.showFunctions))) wanted.add(child.id)
    }
  }
  let nodes = graph.nodes.filter((n) => wanted.has(n.id) && STRUCTURAL_TYPES.has(n.type) && nodePasses(n, state))
  let ids = new Set(nodes.map((n) => n.id))
  let edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target) && edgePasses(e, state))
  if (state.focus && ids.has(state.focus)) {
    const keep = new Set([state.focus])
    for (const e of edges) {
      if (e.source === state.focus) keep.add(e.target)
      if (e.target === state.focus) keep.add(e.source)
    }
    nodes = nodes.filter((n) => keep.has(n.id))
    ids = keep
    edges = edges.filter((e) => keep.has(e.source) && keep.has(e.target))
  }
  const files = graph.nodes.filter((n) => inLayer.has(n.id) && n.type === 'file')
  const derived = project(state.containers[layer.id] || { containers: [], ungrouped: [] }, files, nodes)
  const atomOf = new Map()
  const members = new Map()
  for (const c of derived.containers) {
    members.set(c.id, c.nodeIds)
    for (const id of c.nodeIds) atomOf.set(id, c.id)
  }
  for (const id of derived.ungrouped) atomOf.set(id, id)
  const inter = new Map()
  const intra = []
  for (const e of edges) {
    const a = atomOf.get(e.source)
    const b = atomOf.get(e.target)
    if (a === b) {
      intra.push(e)
      continue
    }
    const key = `${a.length}:${a} ${b}`
    if (!inter.has(key)) inter.set(key, { from: a, to: b, edges: [] })
    inter.get(key).edges.push(e)
  }
  const loose = new Set(derived.ungrouped)
  const top = [...derived.containers.map((container, i) => ({ id: container.id, kind: 'box', container, index: i })), ...nodes.filter((n) => loose.has(n.id)).map((node) => ({ id: node.id, kind: 'node', node }))]
  const rootEdges = [...inter.values()].map((entry, i) => ({ id: `agg-${i}`, from: entry.from, to: entry.to, kind: 'agg', label: String(entry.edges.length), width: weight(entry.edges.length), entry }))
  const counts = new Map()
  for (const p of index.layerEdges) {
    if (p.from === layer.id) counts.set(p.to, (counts.get(p.to) || 0) + p.count)
    else if (p.to === layer.id) counts.set(p.from, (counts.get(p.from) || 0) + p.count)
  }
  const picked = state.filters.layerIds
  for (const [lid, count] of counts) {
    if (picked.size && !picked.has(lid)) continue
    const target = graph.layers.find((l) => l.id === lid)
    top.push({ id: `portal:${lid}`, kind: 'portal', layerId: lid, name: target ? target.name : lid, count, index: index.layerIndex.get(lid) || 0 })
    const targetIds = new Set(target ? target.nodeIds : [])
    const cross = new Set()
    for (const e of graph.edges) {
      if (inLayer.has(e.source) && targetIds.has(e.target)) cross.add(e.source)
      if (inLayer.has(e.target) && targetIds.has(e.source)) cross.add(e.target)
    }
    const seen = new Set()
    for (const id of cross) {
      const atom = atomOf.get(id)
      if (!atom || seen.has(atom)) continue
      seen.add(atom)
      rootEdges.push({ id: `pe-${rootEdges.length}`, from: atom, to: `portal:${lid}`, kind: 'portal' })
    }
  }
  const inner = []
  for (const c of derived.containers) {
    if (!state.expanded.has(c.id)) continue
    const seen = new Set()
    const innerEdges = []
    for (const e of intra) {
      const key = `${e.source}|${e.target}|${e.type}`
      if (atomOf.get(e.source) !== c.id || seen.has(key)) continue
      seen.add(key)
      innerEdges.push({ id: `in-${innerEdges.length}`, from: e.source, to: e.target, kind: 'intra', label: e.type })
    }
    inner.push({ id: c.id, members: c.nodeIds.map((id) => index.byId.get(id)).filter(Boolean), edges: innerEdges })
  }
  const drawn = []
  const seen = new Set()
  for (const edge of rootEdges) {
    if (edge.kind !== 'agg') continue
    const a = state.expanded.has(edge.from)
    const b = state.expanded.has(edge.to)
    if (!a && !b) continue
    edge.hidden = true
    for (const m of edge.entry.edges) {
      const from = a ? m.source : edge.from
      const to = b ? m.target : edge.to
      const key = `${from}|${to}|${m.type}`
      if (seen.has(key)) continue
      seen.add(key)
      drawn.push({ from, to, kind: 'inflated', label: m.type })
    }
  }
  return { kind: 'layer', layer, top, rootEdges, inner, drawn, atomOf, members, edges }
}

function visKey(state) {
  const f = state.filters
  const off = Object.keys(state.categories).filter((k) => state.categories[k] === false)
  return [state.detailLevel, state.showFunctions, state.persona, off, [...f.nodeTypes], [...f.complexities], [...f.layerIds], [...f.edgeCategories], state.level === 'layer' ? state.focus || '' : ''].join('|')
}

function complexityOf(layer, byId) {
  const counts = { simple: 0, moderate: 0, complex: 0 }
  let resolved = 0
  for (const id of layer.nodeIds) {
    const node = byId.get(id)
    if (!node) continue
    resolved++
    counts[node.complexity] = (counts[node.complexity] || 0) + 1
  }
  return counts.complex > resolved * 0.3 ? 'complex' : counts.moderate > resolved * 0.3 ? 'moderate' : 'simple'
}

function button(attrs, ...children) {
  return el('div', { tabindex: '0', role: 'button', ...attrs }, ...children)
}

function layerCard(item, byId) {
  const { layer } = item
  const count = layer.nodeIds.length
  const files = plural(count, 'file')
  const level = complexityOf(layer, byId)
  return button(
    { class: 'ua-card ua-layer', 'data-id': layer.id, 'data-kind': 'layer', 'aria-label': `${layer.name} layer, ${files}`, style: { '--ua-c': layerColor(item.index) } },
    el('div', { class: 'ua-card-top' }, el('span', { class: 'ua-kicker' }, 'Layer'), el('span', { class: 'ua-card-meta' }, el('span', { class: 'ua-matches', hidden: true }), el('span', { class: `ua-cx ua-cx-${level}` }, level))),
    el('div', { class: 'ua-layer-name' }, layer.name),
    layer.description ? el('p', { class: 'ua-layer-desc' }, layer.description) : null,
    el('div', { class: 'ua-card-foot' }, el('span', null, files), el('span', { class: 'ua-explore' }, 'Click to explore →')),
  )
}

function nodeCard(node) {
  const tested = Array.isArray(node.tags) && node.tags.includes('tested')
  return button(
    { class: 'ua-card ua-node', 'data-id': node.id, 'data-kind': 'node', 'aria-label': `${node.name}, ${node.type}`, style: { '--ua-c': typeColor(node.type) } },
    el(
      'div',
      { class: 'ua-card-top' },
      el('span', { class: 'ua-kicker' }, node.type),
      el('span', { class: 'ua-card-meta' }, tested ? el('span', { class: 'ua-tested', role: 'img', title: 'Tested', 'aria-label': 'Tested' }) : null, el('span', { class: `ua-cx ua-cx-${node.complexity}` }, node.complexity)),
    ),
    el('div', { class: 'ua-node-name' }, node.name),
  )
}

function portalCard(item) {
  return button(
    { class: 'ua-card ua-portal', 'data-id': item.id, 'data-kind': 'portal', 'data-layer': item.layerId, 'aria-label': `Go to ${item.name}`, style: { '--ua-c': layerColor(item.index) } },
    el('div', { class: 'ua-portal-name' }, el('span', { class: 'ua-dot' }), el('span', null, item.name), el('span', { class: 'ua-arrow' }, '→')),
    el('div', { class: 'ua-portal-count' }, plural(item.count, 'connection')),
  )
}

function boxName(container) {
  return container.name === '~' ? '(root)' : container.name
}

function boxCard(item, open) {
  const { container } = item
  const name = boxName(container)
  const n = container.nodeIds.length
  return button(
    { class: open ? 'ua-box is-open' : 'ua-box', 'data-id': container.id, 'data-kind': 'box', 'aria-expanded': String(open), 'aria-label': `${name} container, ${plural(n, 'item')}, ${open ? 'expanded' : 'collapsed'}`, style: { '--ua-c': layerColor(item.index % 12) } },
    el('div', { class: 'ua-box-head' }, el('span', { class: container.name === '~' ? 'ua-box-name is-root' : 'ua-box-name' }, open ? el('span', { class: 'ua-caret' }, '▾') : null, name), el('span', { class: 'ua-box-hits', hidden: true }), el('span', { class: 'ua-box-count' }, String(n))),
  )
}

function head(p, a) {
  const bx = p.x - 7 * Math.cos(a)
  const by = p.y - 7 * Math.sin(a)
  const px = -Math.sin(a) * 4
  const py = Math.cos(a) * 4
  return `<polygon class="ua-ahead" points="${fix(p.x)},${fix(p.y)} ${fix(bx + px)},${fix(by + py)} ${fix(bx - px)},${fix(by - py)}"/>`
}

function pill(p, text) {
  const { w, h } = labelSize(text)
  return `<g class="ua-elabel"><rect x="${fix(p.x - w / 2)}" y="${fix(p.y - h / 2)}" width="${w}" height="${h}" rx="9"/><text x="${fix(p.x)}" y="${fix(p.y + 3.8)}" text-anchor="middle">${esc(text)}</text></g>`
}

function edgeMarkup(e, d, tip, angle, lp) {
  const width = e.width ? ` stroke-width="${fix(e.width)}"` : ''
  return `<g class="ua-edge ua-e-${e.kind}"><path class="ua-eline" d="${d}"${width}/>${head(tip, angle)}${e.label && lp ? pill(lp, e.label) : ''}</g>`
}

function polyline(e, pts, lp) {
  const n = pts.length
  const last = pts[n - 1]
  const prev = n > 2 ? mid(pts[n - 2], last) : pts[0]
  const a = Math.atan2(last.y - prev.y, last.x - prev.x)
  let d = `M${fix(pts[0].x)},${fix(pts[0].y)}`
  for (let i = 1; i < n - 1; i++) {
    const m = mid(pts[i], pts[i + 1])
    d += ` Q${fix(pts[i].x)},${fix(pts[i].y)} ${fix(m.x)},${fix(m.y)}`
  }
  d += ` L${fix(last.x - 7 * Math.cos(a))},${fix(last.y - 7 * Math.sin(a))}`
  return edgeMarkup(e, d, last, a, lp)
}

function curve(e, a, b, horizontal) {
  const s = horizontal ? { x: a.x + a.w, y: a.y + a.h / 2 } : { x: a.x + a.w / 2, y: a.y + a.h }
  const t = horizontal ? { x: b.x, y: b.y + b.h / 2 } : { x: b.x + b.w / 2, y: b.y }
  const bend = Math.max(30, horizontal ? Math.abs(t.x - s.x) / 2 : Math.abs(t.y - s.y) / 2)
  const c1 = horizontal ? { x: s.x + bend, y: s.y } : { x: s.x, y: s.y + bend }
  const c2 = horizontal ? { x: t.x - bend, y: t.y } : { x: t.x, y: t.y - bend }
  const angle = Math.atan2(t.y - c2.y, t.x - c2.x)
  const end = { x: t.x - 7 * Math.cos(angle), y: t.y - 7 * Math.sin(angle) }
  const lp = { x: (s.x + 3 * c1.x + 3 * c2.x + t.x) / 8, y: (s.y + 3 * c1.y + 3 * c2.y + t.y) / 8 }
  return edgeMarkup(e, `M${fix(s.x)},${fix(s.y)} C${fix(c1.x)},${fix(c1.y)} ${fix(c2.x)},${fix(c2.y)} ${fix(end.x)},${fix(end.y)}`, t, angle, lp)
}

export function createGraph(host, handlers) {
  const stored = readStore(LAYOUT_KEY)
  let mode = LAYOUTS.some((entry) => entry.key === stored) ? stored : 'vertical'
  let view = { x: 0, y: 0, k: 1 }
  let size = { w: 0, h: 0 }
  let model = null
  let latest = null
  let lastKey = null
  let lastLevel = null
  let lastSelected = null
  let building = Promise.resolve(false)
  let token = 0
  let anim = 0
  let fitted = true
  let fitPad = 0.2
  let gone = false
  let worker = null
  let jobs = 0
  let zoomTimer = null
  let followTimer = null
  let lastUserZoom = null
  let swallow = false
  let drag = null
  let gestureK = 1
  let cards = new Map()
  let boxes = new Map()
  let rects = new Map()
  let info = new Map()
  let edgeEls = []
  let painted = new Set()
  let paintQueued = false
  const marks = new Map()

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', 'ua-edges')
  svg.setAttribute('aria-hidden', 'true')
  const world = el('div', { class: 'ua-world' }, el('div', { class: 'ua-boxes' }), svg, el('div', { class: 'ua-cards' }))
  const crumb = el('nav', { class: 'ua-crumb ua-ui', 'aria-label': 'Where you are' })
  const focusPill = el('button', { class: 'ua-focus-pill ua-ui', type: 'button', hidden: true, title: 'Show the whole layer', onclick: () => handlers.unfocus() }, el('span', null, 'Showing neighborhood'), icon('close'))
  const options = LAYOUTS.map((entry) => el('button', { class: 'flow-switch-option', type: 'button', 'aria-pressed': String(entry.key === mode), onclick: () => setMode(entry.key) }, entry.label))
  const readout = el('span', { class: 'ua-zoom-pct' }, '100%')
  const zoomOut = el('button', { class: 'ua-zoom-btn', type: 'button', 'aria-label': 'Zoom out', title: 'Zoom out (-)', onclick: () => zoomBy(0.8) }, icon('minus'))
  const zoomIn = el('button', { class: 'ua-zoom-btn', type: 'button', 'aria-label': 'Zoom in', title: 'Zoom in (+)', onclick: () => zoomBy(1.25) }, icon('plus'))
  const fitButton = el('button', { class: 'ua-zoom-btn', type: 'button', 'aria-label': 'Fit to screen', title: 'Fit to screen (0)', onclick: () => fitAll(240) }, icon('fit'))
  const busy = el('div', { class: 'ua-busy', role: 'status', hidden: true }, 'Computing layout…')
  const empty = el('p', { class: 'ua-empty', hidden: true })
  const canvas = el(
    'div',
    { class: 'ua-canvas' },
    world,
    crumb,
    focusPill,
    el('div', { class: 'flow-switch ua-switch ua-ui', role: 'group', 'aria-label': 'Layout' }, options),
    el('div', { class: 'ua-zoom ua-ui', role: 'group', 'aria-label': 'Zoom' }, zoomOut, readout, zoomIn, fitButton),
    busy,
    empty,
  )
  host.replaceChildren(canvas)

  function apply() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`
    let grid = 20 * view.k
    while (grid < 10) grid *= 2
    canvas.style.backgroundSize = `${grid}px ${grid}px`
    canvas.style.backgroundPosition = `${view.x}px ${view.y}px`
    readout.textContent = `${Math.round(view.k * 100)}%`
    zoomOut.disabled = view.k <= KMIN + 1e-6
    zoomIn.disabled = view.k >= KMAX - 1e-6
  }

  function animate(to, ms) {
    const id = ++anim
    if (ms <= 0 || reducedMotion()) {
      view = to
      apply()
      return
    }
    const from = { ...view }
    const start = performance.now()
    const step = (now) => {
      if (id !== anim || gone) return
      const t = Math.min(1, (now - start) / ms)
      const e = 1 - Math.pow(1 - t, 3)
      view = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, k: from.k + (to.k - from.k) * e }
      apply()
      if (t < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  function viewFor(b, padding, maxZoom, minZoom = KMIN) {
    const cw = canvas.clientWidth
    const ch = canvas.clientHeight
    const k = clamp(Math.min(cw / (Math.max(b.w, 1) * (1 + padding)), ch / (Math.max(b.h, 1) * (1 + padding))), minZoom, maxZoom)
    return { k, x: cw / 2 - (b.x + b.w / 2) * k, y: ch / 2 - (b.y + b.h / 2) * k }
  }

  function fitAll(ms = 400, padding = fitPad) {
    fitted = true
    fitPad = padding
    if (!size.w || !canvas.clientWidth) return
    animate(viewFor({ x: 0, y: 0, w: size.w, h: size.h }, padding, KMAX), ms)
  }

  function frame(ids, opts = {}) {
    const wanted = [...ids]
    const list = wanted.map((id) => rects.get(id)).filter(Boolean)
    if (!list.length || !canvas.clientWidth) return false
    const x0 = Math.min(...list.map((r) => r.x))
    const y0 = Math.min(...list.map((r) => r.y))
    const x1 = Math.max(...list.map((r) => r.x + r.w))
    const y1 = Math.max(...list.map((r) => r.y + r.h))
    fitted = false
    animate(viewFor({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, opts.padding ?? 0.3, opts.maxZoom ?? 1.2, opts.minZoom ?? KMIN), opts.ms ?? 500)
    return list.length === wanted.length
  }

  function centerOn(id) {
    const b = rects.get(id)
    if (!b) return
    fitted = false
    animate({ k: view.k, x: canvas.clientWidth / 2 - (b.x + b.w / 2) * view.k, y: canvas.clientHeight / 2 - (b.y + b.h / 2) * view.k }, 0)
  }

  function containerIds() {
    return model && model.kind === 'layer' ? [...model.members.keys()] : []
  }

  function moved() {
    fitted = false
    anim++
    window.clearTimeout(zoomTimer)
    zoomTimer = window.setTimeout(() => {
      const prev = lastUserZoom
      lastUserZoom = view.k
      if (view.k > 1 && (prev === null || view.k > prev)) handlers.zoomedIn(containerIds())
    }, 200)
  }

  function zoomAt(k, px, py) {
    k = clamp(k, KMIN, KMAX)
    const r = k / view.k
    view = { k, x: px - (px - view.x) * r, y: py - (py - view.y) * r }
    apply()
    moved()
  }

  function zoomBy(f) {
    zoomAt(view.k * f, canvas.clientWidth / 2, canvas.clientHeight / 2)
  }

  function setMode(next) {
    if (next === mode) return
    mode = next
    writeStore(LAYOUT_KEY, next)
    options.forEach((option, i) => option.setAttribute('aria-pressed', String(LAYOUTS[i].key === mode)))
    if (latest) update(latest, { refit: true })
  }

  function renderCrumb() {
    if (!model || model.kind !== 'layer') {
      crumb.replaceChildren(el('span', { class: 'ua-crumb-here is-caps' }, 'Project overview'))
      return
    }
    crumb.replaceChildren(
      el('button', { class: 'ua-crumb-link', type: 'button', onclick: () => handlers.overview() }, 'Project'),
      el('span', { class: 'ua-crumb-sep', 'aria-hidden': 'true' }, '›'),
      el('span', { class: 'ua-crumb-here' }, model.layer.name),
      el('span', { class: 'ua-crumb-hint' }, '(Esc to go back)'),
    )
  }

  function viaWorker(job) {
    if (!worker) worker = new Worker('/understand-layout.js')
    const id = ++jobs
    return new Promise((resolve, reject) => {
      const done = () => {
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onError)
      }
      const onMessage = (event) => {
        if (event.data.id !== id) return
        done()
        if (event.data.error) reject(new Error(event.data.error))
        else resolve(event.data.result)
      }
      const onError = () => {
        done()
        reject(new Error('The layout worker stopped.'))
      }
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onError)
      worker.postMessage({ id, job })
    })
  }

  async function onMain(job) {
    await layoutReady()
    return window.uaLayout(job)
  }

  async function rebuild(state) {
    const mine = ++token
    const index = indexOf(state.graph)
    const next = (state.level === 'layer' && layerModel(state, index)) || overviewModel(state, index)
    const boxLayer = el('div', { class: 'ua-boxes is-pending' })
    const cardLayer = el('div', { class: 'ua-cards is-pending' })
    world.append(boxLayer, cardLayer)
    const made = new Map()
    const madeBoxes = new Map()
    const children = new Map()
    const nextInfo = new Map()
    for (const item of next.top) {
      if (item.kind === 'box') {
        const n = item.container.nodeIds.length
        item.size = state.sizes.get(item.id) || { w: clamp(Math.sqrt(n) * 280 * 1.2, 280, 800), h: clamp(Math.sqrt(n) * 120 * 1.2, 120, 600) }
        const node = boxCard(item, state.expanded.has(item.id))
        node.style.width = `${item.size.w}px`
        node.style.height = `${item.size.h}px`
        boxLayer.append(node)
        madeBoxes.set(item.id, node)
        nextInfo.set(item.id, { kind: 'box', label: boxName(item.container) })
        continue
      }
      const node = item.kind === 'layer' ? layerCard(item, index.byId) : item.kind === 'portal' ? portalCard(item) : nodeCard(item.node)
      cardLayer.append(node)
      made.set(item.id, node)
      nextInfo.set(item.id, { kind: item.kind, label: item.kind === 'layer' ? item.layer.name : item.kind === 'portal' ? item.name : item.node.name })
    }
    for (const box of next.inner) {
      for (const member of box.members) {
        const node = nodeCard(member)
        cardLayer.append(node)
        children.set(member.id, node)
        nextInfo.set(member.id, { kind: 'node', label: member.name })
      }
    }
    const dims = new Map()
    for (const [id, node] of [...made, ...children]) dims.set(id, { w: node.offsetWidth, h: node.offsetHeight })
    const job = {
      mode,
      root: {
        nodes: next.top.map((item) => ({ id: item.id, ...(item.kind === 'box' ? item.size : dims.get(item.id)) })),
        edges: next.rootEdges.map((e) => ({ id: e.id, from: e.from, to: e.to, label: e.label ? labelSize(e.label) : null })),
      },
      inner: Object.fromEntries(
        next.inner.map((box) => [
          box.id,
          { nodes: box.members.map((m) => ({ id: m.id, ...dims.get(m.id) })), edges: box.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, label: labelSize(e.label) })), pad: 20, head: madeBoxes.get(box.id).firstChild.offsetHeight + 8, minW: 280 },
        ]),
      ),
    }
    const count = job.root.nodes.length + children.size
    let result
    try {
      if (count > WORKER_BOXES) {
        busy.hidden = false
        result = await viaWorker(job).catch(() => onMain(job))
      } else result = await onMain(job)
    } catch (error) {
      boxLayer.remove()
      cardLayer.remove()
      if (mine === token) {
        busy.hidden = true
        empty.textContent = error.message
        empty.hidden = false
      }
      return false
    }
    if (mine !== token || gone) {
      boxLayer.remove()
      cardLayer.remove()
      return false
    }
    busy.hidden = true
    const nextRects = new Map()
    for (const item of next.top) {
      const p = result.root.pos[item.id]
      const node = made.get(item.id) || madeBoxes.get(item.id)
      node.style.left = `${p.x}px`
      node.style.top = `${p.y}px`
      if (item.kind === 'box') {
        node.style.width = `${p.w}px`
        node.style.height = `${p.h}px`
      }
      nextRects.set(item.id, p)
    }
    for (const [id, s] of Object.entries(result.sizes)) state.sizes.set(id, s)
    const offsets = new Map()
    for (const box of next.inner) {
      const outer = nextRects.get(box.id)
      const r = result.inner[box.id]
      const o = { x: outer.x + (outer.w - r.w) / 2, y: outer.y + job.inner[box.id].head }
      offsets.set(box.id, o)
      for (const m of box.members) {
        const p = r.pos[m.id]
        const rect = { x: o.x + p.x, y: o.y + p.y, w: p.w, h: p.h }
        const node = children.get(m.id)
        node.style.left = `${rect.x}px`
        node.style.top = `${rect.y}px`
        nextRects.set(m.id, rect)
      }
    }
    let markup = ''
    const list = []
    for (const e of next.rootEdges) {
      if (e.hidden) continue
      const r = result.root.edges[e.id]
      markup += polyline(e, r.pts, r.lp)
      list.push(e)
    }
    for (const box of next.inner) {
      const o = offsets.get(box.id)
      const shift = (p) => ({ x: p.x + o.x, y: p.y + o.y })
      for (const e of box.edges) {
        const r = result.inner[box.id].edges[e.id]
        markup += polyline(e, r.pts.map(shift), r.lp && shift(r.lp))
        list.push(e)
      }
    }
    for (const e of next.drawn) {
      const a = nextRects.get(e.from)
      const b = nextRects.get(e.to)
      if (!a || !b) continue
      markup += curve(e, a, b, mode === 'horizontal')
      list.push(e)
    }
    svg.setAttribute('width', String(Math.ceil(result.root.w)))
    svg.setAttribute('height', String(Math.ceil(result.root.h)))
    svg.innerHTML = markup
    edgeEls = list.map((e, i) => ({ g: svg.children[i], from: e.from, to: e.to, kind: e.kind }))
    boxLayer.classList.remove('is-pending')
    cardLayer.classList.remove('is-pending')
    world.replaceChildren(boxLayer, svg, cardLayer)
    cards = new Map([...made, ...children])
    boxes = madeBoxes
    rects = nextRects
    info = nextInfo
    painted = new Set()
    model = next
    size = { w: result.root.w, h: result.root.h }
    empty.hidden = next.top.length > 0
    empty.textContent = next.kind === 'layer' ? 'This layer has no nodes to show.' : 'This graph has no layers.'
    renderCrumb()
    return true
  }

  function paint() {
    paintQueued = false
    if (!model || !latest) return
    const state = latest
    const sel = state.selected
    const near = new Set()
    const lit = new Set()
    if (model.kind === 'layer') {
      for (const anchor of [sel, state.focus]) {
        if (!anchor) continue
        const around = new Set([anchor])
        for (const e of model.edges) {
          if (e.source === anchor) around.add(e.target)
          if (e.target === anchor) around.add(e.source)
        }
        for (const id of around) {
          const atom = model.atomOf.get(id)
          if (atom && atom !== id) lit.add(atom)
          if (anchor === sel) near.add(id)
        }
      }
    }
    const names = new Set([...painted, ...marks.keys()])
    const has = (name, id) => Boolean(marks.has(name) && marks.get(name).ids.has(id))
    const dimmers = [...marks.values()].filter((m) => m.dim).map((m) => m.ids)
    const search = marks.get('search')
    for (const [id, node] of cards) {
      if (node.dataset.kind === 'layer') {
        let hits = 0
        if (search) for (const hit of search.ids.keys()) if (state.graph && indexOf(state.graph).firstLayer.get(hit) === id) hits++
        const badge = node.querySelector('.ua-matches')
        badge.hidden = !hits
        badge.textContent = hits ? `${hits} ${hits === 1 ? 'match' : 'matches'}` : ''
        continue
      }
      if (node.dataset.kind !== 'node') continue
      node.classList.toggle('is-selected', id === sel)
      node.classList.toggle('is-near', Boolean(sel) && id !== sel && near.has(id))
      node.classList.toggle('is-faded', Boolean(sel) && !near.has(id))
      for (const name of names) node.classList.toggle(`is-mark-${name}`, has(name, id))
      const score = search && search.ids.get(id)
      if (typeof score === 'number') node.dataset.hit = score <= 0.1 ? 'strong' : score <= 0.3 ? 'mid' : 'weak'
      else delete node.dataset.hit
      node.classList.toggle('is-dimmed', dimmers.length > 0 && !dimmers.some((ids) => ids.has(id)))
    }
    for (const [id, box] of boxes) {
      box.classList.toggle('is-lit', lit.has(id))
      const members = model.members.get(id) || []
      for (const name of names) box.classList.toggle(`has-mark-${name}`, members.some((m) => has(name, m)))
      const hits = search ? members.filter((m) => search.ids.has(m)).length : 0
      const badge = box.querySelector('.ua-box-hits')
      badge.hidden = !hits
      badge.textContent = hits ? plural(hits, 'hit') : ''
    }
    for (const edge of edgeEls) {
      if (edge.kind === 'portal') continue
      const hot = Boolean(sel) && (edge.from === sel || edge.to === sel)
      edge.g.classList.toggle('is-hot', hot)
      edge.g.classList.toggle('is-dim', Boolean(sel) && !hot)
    }
    canvas.classList.toggle('is-dimming', dimmers.length > 0)
    focusPill.hidden = !(model.kind === 'layer' && state.focus)
    painted = new Set(marks.keys())
  }

  function schedulePaint() {
    if (paintQueued) return
    paintQueued = true
    queueMicrotask(paint)
  }

  function highlight(name, ids, opts = {}) {
    const list = ids instanceof Map ? ids : new Map([...(ids || [])].map((id) => [id, true]))
    if (!list.size) marks.delete(name)
    else marks.set(name, { ids: list, dim: Boolean(opts.dim) })
    schedulePaint()
  }

  async function update(state, opts = {}) {
    latest = state
    const key = [state.version, state.level, state.layerId, [...state.expanded].sort().join('\n'), mode, visKey(state)].join('\u0000')
    if (key !== lastKey) {
      lastKey = key
      building = rebuild(state)
    }
    if (!(await building) || gone || latest !== state) return false
    paint()
    const levelKey = `${state.level}|${state.layerId}`
    const first = lastLevel === null
    const levelChanged = levelKey !== lastLevel
    const selected = state.selected
    const selChanged = selected !== lastSelected
    const toggled = state.toggled
    lastLevel = levelKey
    lastSelected = selected
    state.toggled = null
    if (opts.reload && !first) return true
    if (levelChanged || opts.refit) fitAll(first ? 0 : 400, first ? 0.1 : 0.2)
    if (selected && selChanged && rects.has(selected)) {
      window.clearTimeout(followTimer)
      followTimer = window.setTimeout(() => frame([selected]), 100)
    } else if (toggled && state.expanded.has(toggled)) centerOn(toggled)
    return true
  }

  function snapshot() {
    if (!model) return null
    const list = []
    for (const [id, r] of rects) list.push({ id, kind: info.get(id).kind, label: info.get(id).label, x: r.x, y: r.y, w: r.w, h: r.h })
    return { svg, world, bounds: { x: 0, y: 0, w: size.w, h: size.h }, level: model.kind, boxes: list, edges: edgeEls.map(({ from, to, kind }) => ({ from, to, kind })) }
  }

  function activate(target) {
    const { id, kind } = target.dataset
    if (kind === 'layer') handlers.drill(id)
    else if (kind === 'portal') handlers.drill(target.dataset.layer)
    else if (kind === 'box') handlers.toggle(id)
    else handlers.select(id)
  }

  const onWheel = (event) => {
    event.preventDefault()
    const r = canvas.getBoundingClientRect()
    if (event.ctrlKey || event.metaKey) {
      const s = event.deltaMode === 1 ? 0.05 : event.ctrlKey ? 0.01 : 0.004
      zoomAt(view.k * 2 ** clamp(-event.deltaY * s, -0.5, 0.5), event.clientX - r.left, event.clientY - r.top)
      return
    }
    const m = event.deltaMode === 1 ? 16 : 1
    view = { ...view, x: view.x - event.deltaX * m, y: view.y - event.deltaY * m }
    apply()
    moved()
  }
  canvas.addEventListener('wheel', onWheel, { passive: false })
  canvas.addEventListener('gesturestart', (event) => {
    event.preventDefault()
    gestureK = view.k
  })
  canvas.addEventListener('gesturechange', (event) => {
    event.preventDefault()
    const r = canvas.getBoundingClientRect()
    zoomAt(gestureK * event.scale, event.clientX - r.left, event.clientY - r.top)
  })
  canvas.addEventListener('pointerdown', (event) => {
    swallow = false
    if (event.button !== 0 || event.target.closest('.ua-ui')) return
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false }
  })
  canvas.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) > 4) {
      drag.moved = true
      canvas.setPointerCapture(event.pointerId)
      canvas.classList.add('is-grabbing')
    }
    if (!drag.moved) return
    view = { ...view, x: drag.vx + dx, y: drag.vy + dy }
    apply()
    moved()
  })
  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.id) return
    swallow = drag.moved && event.type === 'pointerup'
    drag = null
    canvas.classList.remove('is-grabbing')
  }
  canvas.addEventListener('pointerup', endDrag)
  canvas.addEventListener('pointercancel', endDrag)
  canvas.addEventListener('click', (event) => {
    if (swallow) {
      swallow = false
      return
    }
    if (event.target.closest('.ua-ui')) return
    const target = event.target.closest('[data-kind]')
    if (target) activate(target)
    else handlers.select(null)
  })
  world.addEventListener('keydown', (event) => {
    const target = event.target.closest('[data-kind]')
    if (!target || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    activate(target)
  })
  const resize = new ResizeObserver(() => {
    if (fitted && model) fitAll(0)
  })
  resize.observe(canvas)
  apply()

  return {
    update,
    highlight,
    fit: fitAll,
    frame,
    focusNode: (id) => frame([id]),
    centerOn,
    zoomBy,
    snapshot,
    containerIds,
    containerOf(id) {
      const atom = model && model.atomOf.get(id)
      return atom && atom !== id ? atom : null
    },
    destroy() {
      gone = true
      token++
      anim++
      window.clearTimeout(zoomTimer)
      window.clearTimeout(followTimer)
      resize.disconnect()
      if (worker) worker.terminate()
    },
  }
}
