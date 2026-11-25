import { el, keepFocus, readStore, writeStore } from './ui.js'
import Fuse from './vendor/fuse.mjs'

const FUSE_OPTIONS = {
  keys: [
    { name: 'name', weight: 0.4 },
    { name: 'tags', weight: 0.3 },
    { name: 'summary', weight: 0.2 },
    { name: 'languageNotes', weight: 0.1 },
  ],
  threshold: 0.4,
  includeScore: true,
  ignoreLocation: true,
  useExtendedSearch: true,
}
const THEME_KEY = 'ua-theme'
const DEFAULT_THEME = { presetId: 'dashboard', accentId: 'dashboard' }
const SUB_FILE = new Set(['function', 'class'])
const NODE_KEYS = ['file', 'function', 'class', 'module', 'concept', 'config', 'document', 'service', 'table', 'endpoint', 'pipeline', 'schema', 'resource']
const DARK_NODES = ['#4a7c9b', '#5a9e6f', '#8b6fb0', '#c9a06c', '#b07a8a', '#5eead4', '#7dd3fc', '#a78bfa', '#6ee7b7', '#fdba74', '#fda4af', '#fcd34d', '#a5b4fc']
const LIGHT_NODES = ['#3a6a87', '#488a5b', '#755d99', '#a88a56', '#966674', '#14b8a6', '#38bdf8', '#8b5cf6', '#34d399', '#fb923c', '#fb7185', '#facc15', '#818cf8']
const swatches = (rows) => rows.map(([id, name, accent, dim, bright]) => ({ id, name, accent, dim, bright }))
const DARK_ACCENTS = swatches([
  ['gold', 'Gold', '#d4a574', '#c9a96e', '#e8c49a'],
  ['ocean', 'Ocean', '#5ba4cf', '#4e93ba', '#7abce0'],
  ['emerald', 'Emerald', '#5ea67a', '#4e9468', '#78c492'],
  ['rose', 'Rose', '#cf7a8a', '#b96e7e', '#e094a4'],
  ['purple', 'Purple', '#9b7abf', '#876bb0', '#b494d4'],
  ['amber', 'Amber', '#c9963a', '#b5862e', '#ddb05c'],
  ['teal', 'Teal', '#4aab9a', '#3d9686', '#68c4b4'],
  ['silver', 'Silver', '#a0a8b0', '#8e959c', '#b8bfc6'],
])
const LIGHT_ACCENTS = swatches([
  ['indigo', 'Indigo', '#4a6fa5', '#3d5f8f', '#6088bf'],
  ['ocean', 'Ocean', '#3a8ab5', '#2e7aa0', '#55a0cc'],
  ['emerald', 'Emerald', '#3a8a5c', '#2e7a4e', '#55a878'],
  ['rose', 'Rose', '#a5566a', '#8f4a5c', '#bf6e82'],
  ['purple', 'Purple', '#6b5a9e', '#5c4d8a', '#8474b5'],
  ['amber', 'Amber', '#9e7a30', '#8a6a28', '#b5923e'],
  ['teal', 'Teal', '#2e8a7a', '#267a6c', '#45a595'],
  ['slate', 'Slate', '#5a6570', '#4e5860', '#6e7a85'],
])
const preset = (id, name, dark, accent, [root, surface, elevated, panel, text, text2, text3]) => ({ id, name, dark, accent, accents: dark ? DARK_ACCENTS : LIGHT_ACCENTS, nodes: dark ? DARK_NODES : LIGHT_NODES, root, surface, elevated, panel, text, text2, text3 })
const PRESETS = [
  preset('dark-gold', 'Dark Gold', true, 'gold', ['#0a0a0a', '#111111', '#1a1a1a', '#141414', '#f5f0eb', '#a39787', '#6b5f53']),
  preset('dark-ocean', 'Dark Ocean', true, 'ocean', ['#0a0e14', '#111820', '#1a222c', '#141c24', '#e8edf2', '#87939f', '#536b7a']),
  preset('dark-forest', 'Dark Forest', true, 'emerald', ['#0a100a', '#111811', '#1a241a', '#141c14', '#ebf0eb', '#87a38f', '#536b5a']),
  preset('dark-rose', 'Dark Rose', true, 'rose', ['#100a0a', '#181111', '#221a1a', '#1c1414', '#f2e8ea', '#9f8790', '#6b535a']),
  preset('light-minimal', 'Light Minimal', false, 'indigo', ['#f5f3f0', '#eae7e3', '#ffffff', '#f0ede9', '#1a1a1a', '#6b6b6b', '#a0a0a0']),
]
const STATUS = {
  dark: { '--green': '#6fcf97', '--green-bg': 'rgb(111 207 151 / 0.14)', '--amber': '#e8b75a', '--amber-bg': 'rgb(232 183 90 / 0.14)', '--red': '#f28b82', '--red-bg': 'rgb(242 139 130 / 0.13)', '--overlay': 'rgb(0 0 0 / 0.55)', '--ua-glass': 'rgba(20, 20, 20, 0.8)', '--ua-glass-heavy': 'rgba(20, 20, 20, 0.95)' },
  light: { '--green': '#2c7a4b', '--green-bg': 'rgb(44 122 75 / 0.12)', '--amber': '#8f6200', '--amber-bg': 'rgb(176 122 0 / 0.14)', '--red': '#b3261e', '--red-bg': 'rgb(179 38 30 / 0.09)', '--overlay': 'rgb(20 20 19 / 0.38)', '--ua-glass': 'rgba(255, 255, 255, 0.8)', '--ua-glass-heavy': 'rgba(255, 255, 255, 0.95)' },
}
const FONTS = {
  serif: '"DM Serif Display", ui-serif, Georgia, Cambria, "Times New Roman", serif',
  sans: 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
}
const HEADING_FONTS = [
  ['serif', 'Serif'],
  ['sans', 'Sans'],
  ['mono', 'Mono'],
]
const GLYPHS = {
  search: '<path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>',
  funnel: '<path d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"/>',
  download: '<path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>',
  image: '<path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>',
  brush: '<path d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"/>',
  json: '<path d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/>',
  route: '<path d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"/>',
  palette: '<circle cx="12" cy="12" r="10"/><path d="M12 2a7 7 0 0 0 0 14 4 4 0 0 1 0 8 10 10 0 0 0 0-20z"/><circle cx="8" cy="10" r="1.5" fill="currentColor"/><circle cx="12" cy="7" r="1.5" fill="currentColor"/><circle cx="16" cy="10" r="1.5" fill="currentColor"/>',
  help: '<path d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>',
  close: '<path d="M6 18L18 6M6 6l12 12"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
  down: '<path d="M19 14l-7 7m0 0l-7-7m7 7V3"/>',
  alert: '<path d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>',
  ok: '<path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>',
  in: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8m-3-3l3 3 3-3"/>',
  out: '<circle cx="12" cy="12" r="9"/><path d="M12 16V8m-3 3l3-3 3 3"/>',
  bolt: '<path d="M13 10V3L4 14h7v7l9-11h-7z"/>',
}

const plural = (n, word) => `${n} ${word}${n !== 1 ? 's' : ''}`
const xml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const r1 = (n) => Math.round(n * 10) / 10
const presetOf = (id) => PRESETS.find((p) => p.id === id) || PRESETS[0]
const swatchOf = (p, id) => p.accents.find((a) => a.id === id) || p.accents.find((a) => a.id === p.accent) || p.accents[0]
const isMac = /mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '')

function glyph(name) {
  const span = el('span', { class: 'icon', 'aria-hidden': 'true' })
  span.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[name]}</svg>`
  return span
}

function rgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

function savedTheme() {
  try {
    const value = JSON.parse(readStore(THEME_KEY))
    return value && typeof value.presetId === 'string' && typeof value.accentId === 'string' ? value : null
  } catch {
    return null
  }
}

function keyLabel(k) {
  const punct = k.key.length === 1 && /[^a-zA-Z0-9]/.test(k.key)
  const parts = []
  if (k.ctrl || k.meta) parts.push(isMac ? '⌘' : 'Ctrl')
  if (k.shift === true && !punct) parts.push('⇧')
  if (k.alt) parts.push(isMac ? '⌥' : 'Alt')
  parts.push(punct ? k.key : k.key.toUpperCase())
  return parts.join(' + ')
}

function findPath(edges, from, to) {
  const adjacent = new Map()
  for (const e of edges) {
    if (!adjacent.has(e.source)) adjacent.set(e.source, [])
    if (!adjacent.has(e.target)) adjacent.set(e.target, [])
    adjacent.get(e.source).push(e.target)
    adjacent.get(e.target).push(e.source)
  }
  const parent = new Map([[from, null]])
  const queue = [from]
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    if (id === to) {
      const path = []
      for (let at = to; at !== null; at = parent.get(at)) path.unshift(at)
      return path
    }
    for (const next of adjacent.get(id) || []) {
      if (parent.has(next)) continue
      parent.set(next, id)
      queue.push(next)
    }
  }
  return []
}

function filterGraph(graph, filters, persona, edgeCategory) {
  const layersOf = new Map()
  for (const layer of graph.layers) {
    for (const id of layer.nodeIds) {
      if (!layersOf.has(id)) layersOf.set(id, [])
      layersOf.get(id).push(layer.id)
    }
  }
  const inLayers = (id) => !filters.layerIds.size || (layersOf.get(id) || []).some((layerId) => filters.layerIds.has(layerId))
  const nodes = graph.nodes.filter((n) => !(persona === 'non-technical' && SUB_FILE.has(n.type)) && filters.nodeTypes.has(n.type) && (!n.complexity || filters.complexities.has(n.complexity)) && inLayers(n.id))
  const ids = new Set(nodes.map((n) => n.id))
  const edges = graph.edges.filter((e) => ids.has(e.source) && ids.has(e.target) && (!Object.hasOwn(edgeCategory, e.type) || filters.edgeCategories.has(edgeCategory[e.type])))
  return { ...graph, nodes, edges }
}

function normalizePath(filePath) {
  const p = String(filePath).replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '')
  return !p || p === '.' || p.includes('\0') || p.split('/').includes('..') ? null : p
}

function fileTree(nodes) {
  const files = new Map()
  for (const node of nodes) {
    const path = node.filePath ? normalizePath(node.filePath) : null
    if (!path) continue
    const prev = files.get(path)
    if (!prev || (prev.type !== 'file' && node.type === 'file')) files.set(path, node)
  }
  const root = { children: [] }
  const folders = new Map([['', root]])
  for (const [path, node] of files) {
    const parts = path.split('/')
    let parent = root
    for (let i = 0; i < parts.length - 1; i++) {
      const at = parts.slice(0, i + 1).join('/')
      if (!folders.has(at)) {
        const folder = { type: 'folder', name: parts[i], path: at, children: [] }
        folders.set(at, folder)
        parent.children.push(folder)
      }
      parent = folders.get(at)
    }
    parent.children.push({ type: 'file', name: parts.at(-1), path, nodeId: node.id })
  }
  const sort = (list) => {
    list.sort((a, b) => (a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : a.name.localeCompare(b.name)))
    for (const entry of list) if (entry.children) sort(entry.children)
    return list
  }
  return { entries: sort(root.children), total: files.size }
}

function statsOf(graph) {
  const types = {}
  const complexity = { simple: 0, moderate: 0, complex: 0 }
  const degree = new Map()
  for (const n of graph.nodes) {
    types[n.type] = (types[n.type] || 0) + 1
    if (n.complexity) complexity[n.complexity] = (complexity[n.complexity] || 0) + 1
  }
  for (const e of graph.edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1)
    degree.set(e.target, (degree.get(e.target) || 0) + 1)
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const top = [...degree].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, count]) => ({ id, name: byId.has(id) ? byId.get(id).name : id, count }))
  const sum = (...keys) => keys.reduce((total, key) => total + (types[key] || 0), 0)
  const categories = [
    ['Code', 'file', sum('file', 'function', 'class', 'module', 'concept')],
    ['Config', 'config', sum('config')],
    ['Docs', 'document', sum('document')],
    ['Infra', 'service', sum('service', 'resource', 'pipeline')],
    ['Data', 'table', sum('table', 'endpoint', 'schema')],
    ['Domain', 'concept', sum('domain', 'flow', 'step')],
  ]
  return { types, complexity, top, categories }
}

function wrapLabel(text, max) {
  const lines = []
  let line = ''
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    for (let i = 0; i < word.length; i += max) {
      const part = word.slice(i, i + max)
      if (line && line.length + 1 + part.length > max) {
        lines.push(line)
        line = part
      } else line = line ? `${line} ${part}` : part
    }
  }
  if (line) lines.push(line)
  return lines.length ? lines : ['']
}

function buildSvg(snap, expanded) {
  const boxes = snap.boxes
  if (!boxes.length) return null
  const byId = new Map(boxes.map((b) => [b.id, b]))
  const minX = Math.min(...boxes.map((b) => b.x))
  const minY = Math.min(...boxes.map((b) => b.y))
  const maxX = Math.max(...boxes.map((b) => b.x + b.w))
  const maxY = Math.max(...boxes.map((b) => b.y + b.h))
  const pad = 40
  const width = Math.ceil(maxX - minX + pad * 2)
  const height = Math.ceil(maxY - minY + pad * 2)
  const ox = pad - minX
  const oy = pad - minY
  const card = (b, top) => {
    const x = r1(b.x + ox)
    const y = r1(b.y + oy)
    const cx = r1(x + b.w / 2)
    const lines = wrapLabel(b.label ?? b.id, Math.max(4, Math.floor((b.w - 16) / 7)))
    const y0 = top ? y + 22 : r1(y + b.h / 2 - ((lines.length - 1) * 15) / 2)
    const spans = lines.map((line, i) => `<tspan x="${cx}" dy="${i ? 15 : 0}">${xml(line)}</tspan>`).join('')
    return `<rect x="${x}" y="${y}" width="${r1(b.w)}" height="${r1(b.h)}" rx="8" fill="#1a1a1a" stroke="rgba(212,165,116,0.2)" stroke-width="1"/><text x="${cx}" y="${y0}" fill="#d4a574" text-anchor="middle" dominant-baseline="middle" font-size="12" font-family="ui-sans-serif, system-ui, sans-serif">${spans}</text>`
  }
  const center = (b) => [r1(b.x + ox + b.w / 2), r1(b.y + oy + b.h / 2)]
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#0a0a0a"/>`
  for (const b of boxes) if (b.kind === 'box') out += card(b, expanded.has(b.id))
  for (const e of snap.edges) {
    const a = byId.get(e.from)
    const b = byId.get(e.to)
    if (!a || !b) continue
    const [x1, y1] = center(a)
    const [x2, y2] = center(b)
    out += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(212,165,116,0.3)" stroke-width="1.5"/>`
  }
  for (const b of boxes) if (b.kind !== 'box') out += card(b, false)
  return { svg: `${out}</svg>`, width, height }
}

function download(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = el('a', { href: url, download: name, hidden: true })
  document.body.append(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function register(api) {
  const { store, actions, slots } = api
  const { ALL_NODE_TYPES, ALL_COMPLEXITIES, ALL_EDGE_CATEGORIES, EDGE_CATEGORY, CHIPS } = api.consts
  const renders = []
  const offs = []
  const openFolders = new Set()
  const trees = new WeakMap()
  const stats = new WeakMap()
  const path = { from: '', to: '', result: null }
  const shown = { path: false, help: false }
  let engine = null
  let engineGraph = null
  let dropOpen = false
  let tipId = null

  function bind(target, deps, render) {
    let last = null
    renders.push((s) => {
      const next = deps(s)
      if (last && next.every((v, i) => v === last[i])) return
      last = next
      const scrolls = [...target.querySelectorAll('[data-scroll]')].map((node) => [node.dataset.scroll, node.scrollTop])
      keepFocus(target, () => target.replaceChildren(...[render(s)].flat(Infinity).filter(Boolean)))
      for (const [key, top] of scrolls) {
        const node = target.querySelector(`[data-scroll="${key}"]`)
        if (node) node.scrollTop = top
      }
      const pop = target.querySelector('.ua-x-pop')
      const left = pop ? pop.getBoundingClientRect().left : 8
      if (left < 8) pop.style.setProperty('--ua-x-shift', `${Math.ceil(8 - left)}px`)
    })
  }

  const closeButton = (onclick, focus, autofocus) => el('button', { class: 'icon-button ua-x-close', type: 'button', 'aria-label': 'Close', title: 'Close', 'data-focus': focus, 'data-autofocus': autofocus || null, onclick }, glyph('close'))
  const anchor = (...children) => el('div', { class: 'ua-x-anchor' }, ...children)
  const tool = (attrs, ...children) => el('button', { type: 'button', ...attrs, class: `button small ua-x-tool${attrs.class ? ` ${attrs.class}` : ''}` }, ...children)

  bind(
    slots.detail,
    (s) => [s.graph, s.kind, s.viewMode, s.detailLevel, s.showFunctions],
    (s) => {
      if (!s.graph || s.kind === 'knowledge' || s.viewMode === 'domain') return null
      const option = (level, label, title) => el('button', { class: 'flow-switch-option', type: 'button', 'aria-pressed': String(s.detailLevel === level), title, 'data-focus': `x-level-${level}`, onclick: () => actions.setDetailLevel(level) }, label)
      return [
        el('span', { class: 'ua-x-divider', 'aria-hidden': 'true' }),
        el('div', { class: 'flow-switch ua-x-seg', role: 'group', 'aria-label': 'Detail level' }, option('file', 'Files', 'Files only: architecture-level dependencies (fast)'), option('class', '+Classes', 'Files + Classes: code structure with inheritance')),
        s.detailLevel === 'class' ? el('button', { class: 'ua-x-fn', type: 'button', 'aria-pressed': String(s.showFunctions), title: 'Toggle function nodes (may slow down rendering)', 'data-focus': 'x-fn', onclick: () => actions.toggleFunctions() }, 'fn') : null,
      ]
    },
  )

  bind(
    slots.chips,
    (s) => [s.graph, s.kind, s.categories],
    (s) => {
      if (!s.graph) return null
      const list = s.kind === 'knowledge' ? [{ key: 'knowledge', label: 'All', color: 'var(--ua-t-article)' }] : CHIPS
      return el(
        'div',
        { class: 'ua-x-chips', role: 'group', 'aria-label': 'Node categories' },
        list.map((chip) => {
          const on = s.categories[chip.key] !== false
          return el('button', { class: on ? 'ua-x-chip' : 'ua-x-chip is-off', type: 'button', 'aria-pressed': String(on), title: `${on ? 'Hide' : 'Show'} ${chip.label} nodes`, 'data-focus': `x-chip-${chip.key}`, style: { '--ua-c': chip.color }, onclick: () => actions.toggleCategory(chip.key) }, el('span', { class: 'ua-x-dot' }), chip.label)
        }),
      )
    },
  )

  bind(
    slots.legend,
    (s) => [s.graph, s.level, s.layerId],
    (s) => {
      const layers = s.graph ? s.graph.layers : []
      if (!layers.length) return null
      const detail = s.level === 'layer'
      const active = detail ? layers.find((layer) => layer.id === s.layerId) : null
      return el(
        'div',
        { class: 'ua-x-legend' },
        el('span', { class: 'ua-x-legend-label' }, detail ? (active ? active.name : 'Layer') : plural(layers.length, 'layer')),
        layers.map((layer, i) => {
          const state = !detail ? '' : layer.id === s.layerId ? ' is-active' : ' is-dim'
          return el('span', { class: `ua-x-leg${state}`, style: { '--ua-c': api.util.layerColor(i) } }, el('span', { class: 'ua-x-dot' }), el('span', { class: 'ua-x-leg-text' }, layer.name, el('span', { class: 'ua-x-leg-n' }, `(${layer.nodeIds.length})`)))
        }),
      )
    },
  )

  const input = el('input', { class: 'ua-x-input', type: 'text', placeholder: 'Search nodes by name, summary, or tags...', 'aria-label': 'Search nodes', autocomplete: 'off', spellcheck: 'false', 'data-ua-search': '' })
  const count = el('span', { class: 'ua-x-count', role: 'status' })
  const drop = el('div', { class: 'ua-x-drop', hidden: true })
  const searchBox = el('div', { class: 'ua-x-search' }, el('div', { class: 'ua-x-search-bar' }, glyph('search'), input, count), drop)
  slots.search.replaceChildren(searchBox)

  function runSearch(query) {
    const s = store.get()
    const q = String(query).trim()
    if (!s.graph || !q) return actions.setSearch(query, [])
    if (engineGraph !== s.graph) {
      engine = new Fuse(s.graph.nodes, FUSE_OPTIONS)
      engineGraph = s.graph
    }
    actions.setSearch(
      query,
      engine
        .search(q.split(/\s+/).join(' | '))
        .slice(0, 50)
        .map((hit) => ({ nodeId: hit.item.id, score: hit.score ?? 0 })),
    )
  }

  function paintSearch(s = store.get()) {
    if (document.activeElement !== input && input.value !== s.query) input.value = s.query
    const q = String(s.query).trim()
    count.textContent = q ? plural(s.results.length, 'result') : ''
    const hits = dropOpen && q ? s.results.slice(0, 5).map((r) => [r, api.data.mainNode(r.nodeId)]).filter(([, node]) => node) : []
    drop.hidden = !hits.length
    keepFocus(drop, () =>
      drop.replaceChildren(
        ...hits.map(([r, node]) => {
          const rel = Math.round((1 - r.score) * 100)
          return el(
            'button',
            {
              class: 'ua-x-hit',
              type: 'button',
              'data-focus': `x-hit-${node.id}`,
              onclick: () => {
                actions.navigateToNode(node.id)
                dropOpen = false
                paintSearch()
              },
            },
            el('span', { class: 'ua-badge ua-x-hit-type', style: { '--ua-c': api.util.typeColor(node.type) } }, node.type),
            el('span', { class: 'ua-x-hit-name' }, node.name),
            el('span', { class: 'ua-x-hit-rel' }, el('span', { class: 'ua-x-bar' }, el('span', { class: 'ua-x-bar-fill', style: { '--ua-x-pct': `${rel}%` } })), el('span', { class: 'ua-x-hit-pct' }, `${rel}%`)),
          )
        }),
      ),
    )
  }

  input.addEventListener('input', () => {
    dropOpen = true
    runSearch(input.value)
  })
  input.addEventListener('focus', () => {
    dropOpen = true
    paintSearch()
  })
  renders.push((s, p) => {
    if (!p || s.query !== p.query || s.results !== p.results || s.graph !== p.graph) paintSearch(s)
    if (p && s.graph !== p.graph && String(s.query).trim()) queueMicrotask(() => runSearch(store.get().query))
  })

  function filterPanel(s, active) {
    const f = s.filters
    const toggle = (key, value) => {
      const next = new Set(store.get().filters[key])
      if (next.has(value)) next.delete(value)
      else next.add(value)
      actions.setFilters({ [key]: next })
    }
    const group = (title, key, items) =>
      el(
        'div',
        { class: 'ua-x-group', role: 'group', 'aria-label': title },
        el('h3', { class: 'ua-x-group-title' }, title),
        items.map(({ value, label, color }) => el('label', { class: 'ua-x-check' }, el('input', { type: 'checkbox', checked: f[key].has(value), 'data-focus': `x-f-${key}-${value}`, onchange: () => toggle(key, value) }), color ? el('span', { class: 'ua-x-dot', style: { '--ua-c': color } }) : null, el('span', { class: color ? 'ua-x-check-text' : 'ua-x-check-text is-cap' }, label))),
      )
    const layers = s.graph ? s.graph.layers : []
    return el(
      'div',
      { class: 'ua-x-pop ua-x-filter', role: 'dialog', 'aria-label': 'Filter graph', 'data-scroll': 'filter' },
      group('Node Types', 'nodeTypes', ALL_NODE_TYPES.map((value) => ({ value, label: value }))),
      group('Complexity', 'complexities', ALL_COMPLEXITIES.map((value) => ({ value, label: value }))),
      layers.length ? group('Layers', 'layerIds', layers.map((layer, i) => ({ value: layer.id, label: layer.name, color: api.util.layerColor(i) }))) : null,
      group('Edge Categories', 'edgeCategories', ALL_EDGE_CATEGORIES.map((value) => ({ value, label: value.replace(/-/g, ' ') }))),
      active ? el('button', { class: 'button small ua-x-reset', type: 'button', 'data-focus': 'x-f-reset', onclick: () => actions.resetFilters() }, 'Reset All') : null,
    )
  }

  bind(
    slots.filter,
    (s) => [s.graph, s.filters, s.open.filter],
    (s) => {
      const active = api.util.hasActiveFilters(s)
      return anchor(tool({ class: active ? 'is-on' : '', title: 'Filter graph (F)', 'aria-expanded': String(Boolean(s.open.filter)), 'data-focus': 'x-filter', onclick: () => actions.toggleOpen('filter') }, glyph('funnel'), 'Filter'), s.open.filter ? filterPanel(s, active) : null)
    },
  )

  function structuralSnapshot() {
    const snap = api.canvas.snapshot()
    return snap && !snap.world.closest('[hidden]') ? snap : null
  }

  const fileBase = () => {
    const graph = store.get().graph
    return (graph && graph.project && graph.project.name) || 'knowledge-graph'
  }

  function exportImage(png) {
    const snap = structuralSnapshot()
    if (!snap) return window.alert('Graph not ready for export')
    const kind = png ? 'PNG' : 'SVG'
    try {
      const built = buildSvg(snap, store.get().expanded)
      if (!built) return window.alert('No nodes to export')
      const name = `${fileBase()}-export.${png ? 'png' : 'svg'}`
      if (!png) {
        download(new Blob([built.svg], { type: 'image/svg+xml;charset=utf-8' }), name)
        return actions.setOpen('export', false)
      }
      const img = new Image()
      img.onerror = () => window.alert('Failed to export PNG: could not render graph as image.')
      img.onload = () => {
        const canvas = el('canvas', { width: built.width * 2, height: built.height * 2 })
        const ctx = canvas.getContext('2d')
        if (!ctx) return window.alert('Failed to create canvas context')
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        canvas.toBlob((blob) => {
          if (!blob) return window.alert('Failed to export PNG: image encoding failed.')
          download(blob, name)
          actions.setOpen('export', false)
        }, 'image/png')
      }
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(built.svg)}`
    } catch (error) {
      window.alert(`Failed to export ${kind}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function exportJson() {
    const s = store.get()
    if (!s.graph) return window.alert('No graph loaded')
    try {
      const graph = filterGraph(s.graph, s.filters, s.persona, EDGE_CATEGORY)
      download(new Blob([JSON.stringify(graph, null, 2)], { type: 'application/json' }), `${fileBase()}-export.json`)
      actions.setOpen('export', false)
    } catch (error) {
      console.error('JSON export failed:', error)
      window.alert(`Failed to export JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  bind(
    slots.export,
    (s) => [s.graph, s.open.export, s.viewMode, s.version],
    (s) => {
      const ready = s.open.export && Boolean(structuralSnapshot())
      const item = (name, label, onclick, disabled) => el('button', { class: 'ua-x-item', type: 'button', disabled, 'data-focus': `x-export-${name}`, onclick }, glyph(name), el('span', null, label))
      return anchor(
        tool({ title: 'Export graph (E)', 'aria-expanded': String(Boolean(s.open.export)), 'data-focus': 'x-export', onclick: () => actions.toggleOpen('export') }, glyph('download'), 'Export'),
        s.open.export ? el('div', { class: 'ua-x-pop ua-x-export', role: 'group', 'aria-label': 'Export graph' }, item('image', 'Export as PNG', () => exportImage(true), !ready), item('brush', 'Export as SVG', () => exportImage(false), !ready), item('json', 'Export as JSON', exportJson, !s.graph)) : null,
      )
    },
  )

  bind(
    slots.path,
    () => [],
    () => tool({ title: 'Find path between nodes (P)', 'aria-haspopup': 'dialog', 'data-focus': 'x-path', onclick: () => actions.toggleOpen('path') }, glyph('route'), el('span', { class: 'ua-x-md' }, 'Path')),
  )

  function pickTheme(config) {
    writeStore(THEME_KEY, JSON.stringify(config))
    actions.setTheme(config)
  }

  function themePanel(config) {
    const dashboard = config.presetId === 'dashboard'
    const current = dashboard ? null : presetOf(config.presetId)
    const swatch = current && swatchOf(current, config.accentId)
    const font = Object.hasOwn(FONTS, config.headingFont) ? config.headingFont : 'serif'
    const title = (text) => el('h3', { class: 'ua-x-theme-title' }, text)
    return el(
      'div',
      { class: 'ua-x-pop ua-x-theme', role: 'dialog', 'aria-label': 'Theme' },
      el(
        'div',
        null,
        title('Theme'),
        el(
          'div',
          { class: 'ua-x-presets' },
          el(
            'button',
            { class: 'ua-x-preset', type: 'button', 'aria-pressed': String(dashboard), 'data-focus': 'x-preset-dashboard', onclick: () => pickTheme({ ...config, presetId: 'dashboard', accentId: 'dashboard' }) },
            el('span', { class: 'ua-x-dots', 'aria-hidden': 'true' }, ['var(--bg)', 'var(--raised)', 'var(--accent)'].map((color) => el('span', { style: { '--ua-c': color } }))),
            el('span', null, 'Dashboard'),
            dashboard ? glyph('check') : null,
          ),
          PRESETS.map((p) =>
            el(
              'button',
              { class: 'ua-x-preset', type: 'button', 'aria-pressed': String(p.id === current?.id), 'data-focus': `x-preset-${p.id}`, onclick: () => pickTheme({ ...config, presetId: p.id, accentId: p.accent }) },
              el(
                'span',
                { class: 'ua-x-dots', 'aria-hidden': 'true' },
                [p.root, p.surface, swatchOf(p, p.accent).accent].map((color) => el('span', { style: { '--ua-c': color } })),
              ),
              el('span', null, p.name),
              p.id === current?.id ? glyph('check') : null,
            ),
          ),
        ),
      ),
      current ? el('div', null, title('Accent Color'), el('div', { class: 'ua-x-swatches' }, current.accents.map((a) => el('button', { class: 'ua-x-swatch', type: 'button', title: a.name, 'aria-label': a.name, 'aria-pressed': String(a.id === swatch.id), 'data-focus': `x-accent-${a.id}`, style: { '--ua-c': a.accent }, onclick: () => pickTheme({ ...config, accentId: a.id }) })))) : null,
      el('div', null, title('Heading Font'), el('div', { class: 'ua-x-fonts' }, HEADING_FONTS.map(([id, label]) => el('button', { class: 'ua-x-font', type: 'button', 'aria-pressed': String(id === font), 'data-focus': `x-font-${id}`, style: { 'font-family': FONTS[id] }, onclick: () => pickTheme({ ...config, headingFont: id }) }, label)))),
    )
  }

  bind(
    slots.theme,
    (s) => [s.theme, s.open.theme],
    (s) => anchor(el('button', { class: 'button small ghost ua-x-tool', type: 'button', title: 'Change theme', 'aria-expanded': String(Boolean(s.open.theme)), 'data-focus': 'x-theme', onclick: () => actions.toggleOpen('theme') }, glyph('palette'), el('span', { class: 'ua-x-sm' }, 'Theme')), s.open.theme && s.theme ? themePanel(s.theme) : null),
  )

  let appliedVars = []
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)')
  const dashboardDark = () => {
    const forced = document.documentElement.dataset.theme
    return forced ? forced === 'dark' : systemDark.matches
  }
  const followDashboard = () => {
    if (currentTheme?.presetId === 'dashboard') api.root.dataset.uaTheme = dashboardDark() ? 'dark' : 'light'
  }
  let currentTheme = null
  const themeWatch = new MutationObserver(followDashboard)
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  systemDark.addEventListener('change', followDashboard)
  api.onDestroy(() => {
    themeWatch.disconnect()
    systemDark.removeEventListener('change', followDashboard)
  })

  function applyTheme(config) {
    if (!config) return
    currentTheme = config
    for (const name of appliedVars) api.root.style.removeProperty(name)
    appliedVars = []
    if (config.presetId === 'dashboard') {
      if (Object.hasOwn(FONTS, config.headingFont)) {
        api.root.style.setProperty('--serif', FONTS[config.headingFont])
        appliedVars = ['--serif']
      }
      followDashboard()
      return
    }
    const p = presetOf(config.presetId)
    const swatch = swatchOf(p, config.accentId)
    const a = (alpha) => rgba(swatch.accent, alpha)
    const vars = {
      '--bg': p.root,
      '--sidebar': p.surface,
      '--sunken': p.surface,
      '--inset': p.panel,
      '--code-bg': p.surface,
      '--raised': p.elevated,
      '--fg': p.text,
      '--fg-2': p.text2,
      '--muted': p.text2,
      '--faint': p.text3,
      '--hover': rgba(p.text, 0.06),
      '--active': rgba(p.text, 0.1),
      '--border': a(p.dark ? 0.12 : 0.1),
      '--border-strong': a(p.dark ? 0.25 : 0.18),
      '--accent': swatch.accent,
      '--ua-accent-dim': swatch.dim,
      '--ua-accent-bright': swatch.bright,
      '--scroll-thumb': a(0.2),
      '--ua-line': a(0.4),
      '--ua-grid': a(0.15),
      ...STATUS[p.dark ? 'dark' : 'light'],
      '--serif': FONTS[Object.hasOwn(FONTS, config.headingFont) ? config.headingFont : 'serif'],
    }
    NODE_KEYS.forEach((key, i) => (vars[`--ua-t-${key}`] = p.nodes[i]))
    for (const [name, value] of Object.entries(vars)) api.root.style.setProperty(name, value)
    appliedVars = Object.keys(vars)
    api.root.dataset.uaTheme = p.dark ? 'dark' : 'light'
  }

  function metaTheme() {
    const meta = api.data.file('meta.json')
    const theme = meta && meta.theme
    return theme && typeof theme.presetId === 'string' && typeof theme.accentId === 'string' ? theme : null
  }

  actions.setTheme(savedTheme() || metaTheme() || DEFAULT_THEME)
  renders.push((s, p) => {
    if (!p || s.theme !== p.theme) applyTheme(s.theme)
    if (!p || s.files === p.files || savedTheme()) return
    const meta = metaTheme()
    if (meta && JSON.stringify(meta) !== JSON.stringify(s.theme)) queueMicrotask(() => actions.setTheme(meta))
  })

  bind(
    slots.help,
    () => [],
    () => el('button', { class: 'icon-button ua-x-help', type: 'button', title: 'Show keyboard shortcuts', 'aria-label': 'Show keyboard shortcuts', 'aria-haspopup': 'dialog', 'data-focus': 'x-help', onclick: () => actions.setOpen('help', true) }, glyph('help')),
  )

  function pathResult() {
    if (path.result === null) return null
    if (!path.result.length) return el('div', { class: 'ua-x-none', role: 'status' }, glyph('alert'), el('p', null, 'No path found between these nodes.'))
    return el(
      'div',
      { class: 'ua-x-found', role: 'status' },
      el('h3', { class: 'ua-x-found-head' }, glyph('ok'), `Path Found (${path.result.length} nodes)`),
      el(
        'ol',
        { class: 'ua-x-steps' },
        path.result.map((id, i) => {
          const node = api.data.mainNode(id)
          if (!node) return null
          return el(
            'li',
            null,
            el(
              'button',
              {
                class: 'ua-x-step',
                type: 'button',
                'data-focus': `x-step-${i}`,
                onclick: () => {
                  actions.selectNode(id)
                  actions.setOpen('path', false)
                },
              },
              el('span', { class: 'ua-x-step-n' }, String(i + 1)),
              el('span', { class: 'ua-x-step-text' }, el('span', { class: 'ua-x-step-name' }, node.name), el('span', { class: 'ua-x-step-type' }, node.type)),
              glyph('chevron'),
            ),
            i < path.result.length - 1 ? el('span', { class: 'ua-x-down', 'aria-hidden': 'true' }, glyph('down')) : null,
          )
        }),
      ),
    )
  }

  function pathModal(s) {
    for (const key of ['from', 'to']) {
      if (!path[key] || api.data.mainNode(path[key])) continue
      path[key] = ''
      path.result = null
    }
    const close = () => actions.setOpen('path', false)
    const pick = (key) => (event) => {
      path[key] = event.target.value
      path.result = null
      actions.setPath(null)
      paintOverlay()
    }
    const select = (key, label) =>
      el(
        'label',
        { class: 'ua-x-field' },
        el('span', { class: 'ua-x-label' }, label),
        el('select', { class: 'input ua-x-select', 'data-focus': `x-path-${key}`, 'data-autofocus': key === 'from' ? 'path' : null, onchange: pick(key) }, el('option', { value: '' }, 'Select a node...'), s.graph.nodes.map((n) => el('option', { value: n.id, selected: n.id === path[key] }, `${n.name} (${n.type})`))),
      )
    const find = () => {
      path.result = findPath(store.get().graph.edges, path.from, path.to)
      actions.setPath(path.result.length ? path.result : null)
      paintOverlay()
    }
    return el(
      'div',
      { class: 'ua-x-backdrop', onmousedown: (event) => event.target === event.currentTarget && close() },
      el(
        'div',
        { class: 'ua-x-modal ua-x-pathbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Dependency Path Finder' },
        el('div', { class: 'ua-x-modal-head' }, el('div', { class: 'ua-x-modal-title' }, glyph('route'), el('h2', null, 'Dependency Path Finder')), closeButton(close, 'x-path-close')),
        el(
          'div',
          { class: 'ua-x-modal-body', 'data-scroll': 'path' },
          el('p', { class: 'ua-x-lead' }, 'Find the shortest path between two nodes in the dependency graph.'),
          select('from', 'From Node'),
          select('to', 'To Node'),
          el('button', { class: 'ua-x-cta', type: 'button', disabled: !path.from || !path.to || path.from === path.to, 'data-focus': 'x-path-find', onclick: find }, 'Find Path'),
          pathResult(),
        ),
        el('div', { class: 'ua-x-modal-foot' }, el('button', { class: 'button small ghost', type: 'button', 'data-focus': 'x-path-done', onclick: close }, 'Close')),
      ),
    )
  }

  function helpModal() {
    const groups = new Map()
    for (const k of api.keys.list()) {
      const group = k.group || 'General'
      if (!groups.has(group)) groups.set(group, [])
      groups.get(group).push(k)
    }
    const close = () => actions.setOpen('help', false)
    return el(
      'div',
      { class: 'ua-x-backdrop is-dim', onmousedown: (event) => event.target === event.currentTarget && close() },
      el(
        'div',
        { class: 'ua-x-modal ua-x-helpbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard Shortcuts' },
        el('div', { class: 'ua-x-modal-head' }, el('div', null, el('h2', null, 'Keyboard Shortcuts'), el('p', { class: 'ua-x-hint' }, 'Press ? anytime to toggle this help')), closeButton(close, 'x-help-close', 'help')),
        el(
          'div',
          { class: 'ua-x-keys', 'data-scroll': 'keys' },
          [...groups].map(([group, list]) => el('section', null, el('h3', { class: 'ua-x-keys-title' }, group), list.map((k) => el('div', { class: 'ua-x-key' }, el('span', null, k.description), el('kbd', { class: 'ua-x-kbd' }, keyLabel(k)))))),
        ),
        el('div', { class: 'ua-x-modal-foot is-center' }, el('p', { class: 'ua-x-hint' }, 'Press ESC to close')),
      ),
    )
  }

  const layer = el('div', { class: 'ua-x-layer' })

  function paintOverlay(s = store.get()) {
    const open = { path: Boolean(s.open.path && s.graph), help: Boolean(s.open.help) }
    const parts = [open.path ? pathModal(s) : null, open.help ? helpModal() : null].filter(Boolean)
    const scrolls = [...layer.querySelectorAll('[data-scroll]')].map((node) => [node.dataset.scroll, node.scrollTop])
    keepFocus(layer, () => layer.replaceChildren(...parts))
    for (const [key, top] of scrolls) {
      const node = layer.querySelector(`[data-scroll="${key}"]`)
      if (node) node.scrollTop = top
    }
    if (!parts.length) layer.remove()
    else if (!layer.isConnected) slots.overlay.append(layer)
    for (const name of ['path', 'help']) {
      if (open[name] && !shown[name]) {
        const target = layer.querySelector(`[data-autofocus="${name}"]`)
        if (target) target.focus()
      } else if (!open[name] && shown[name] && (!document.activeElement || document.activeElement === document.body)) {
        const trigger = slots[name].querySelector('button')
        if (trigger) trigger.focus()
      }
      shown[name] = open[name]
    }
  }

  renders.push((s, p) => {
    if (!p || s.open.path !== p.open.path || s.open.help !== p.open.help || s.graph !== p.graph) paintOverlay(s)
  })

  function explorer(s) {
    if (!s.graph) return el('p', { class: 'ua-side-empty' }, 'No graph loaded')
    if (!trees.has(s.graph)) trees.set(s.graph, fileTree(s.graph.nodes))
    const { entries, total } = trees.get(s.graph)
    const openFile = (id) => {
      actions.navigateToNode(id)
      actions.openCode(id)
    }
    const rows = []
    const walk = (list, depth) => {
      for (const entry of list) {
        const attrs = { class: `ua-x-row is-${entry.type}`, type: 'button', 'data-focus': `x-tree-${entry.path}`, style: { '--ua-x-depth': String(depth) } }
        if (entry.type === 'file') {
          rows.push(
            el(
              'button',
              {
                ...attrs,
                title: `${entry.path} - double-click to open`,
                ondblclick: () => openFile(entry.nodeId),
                onkeydown: (event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  openFile(entry.nodeId)
                },
              },
              el('span', { class: 'ua-x-row-mark', 'aria-hidden': 'true' }, '-'),
              el('span', { class: 'ua-x-row-name' }, entry.name),
            ),
          )
          continue
        }
        const open = openFolders.has(entry.path)
        rows.push(
          el(
            'button',
            {
              ...attrs,
              title: entry.path,
              'aria-expanded': String(open),
              onclick: () => {
                if (open) openFolders.delete(entry.path)
                else openFolders.add(entry.path)
                api.refresh()
              },
            },
            el('span', { class: 'ua-x-row-mark', 'aria-hidden': 'true' }, open ? 'v' : '>'),
            el('span', { class: 'ua-x-row-name' }, entry.name),
          ),
        )
        if (open) walk(entry.children, depth + 1)
      }
    }
    walk(entries, 0)
    return el(
      'div',
      { class: 'ua-x-files' },
      el('div', { class: 'ua-x-files-head' }, el('p', { class: 'ua-x-files-title' }, 'Analyzed Files'), el('p', { class: 'ua-x-files-count' }, `${total} files from the current knowledge graph`)),
      entries.length ? el('div', { class: 'ua-x-tree' }, rows) : el('p', { class: 'ua-side-empty' }, 'No file paths found.'),
    )
  }

  api.panels.files({ render: (s) => explorer(s) })

  function overview(s) {
    const graph = s.graph
    if (!graph) return el('p', { class: 'ua-side-empty' }, 'Loading project...')
    if (!stats.has(graph)) stats.set(graph, statsOf(graph))
    const { types, complexity, top, categories } = stats.get(graph)
    const { project, nodes, edges, layers } = graph
    const heading = (text) => el('h3', { class: 'ua-x-over-h' }, text)
    const stat = (value, label) => el('div', { class: 'ua-x-stat' }, el('div', { class: 'ua-x-stat-value' }, String(value)), el('div', { class: 'ua-x-stat-label' }, label))
    const pills = (title, list) => (Array.isArray(list) && list.length ? el('section', null, heading(title), el('div', { class: 'ua-x-pills' }, list.map((item) => el('span', { class: 'ua-x-pill' }, item)))) : null)
    const shownCats = categories.filter(([, , n]) => n > 0)
    const analyzed = new Date(project.analyzedAt)
    return el(
      'div',
      { class: 'ua-x-over' },
      el('div', null, el('h2', { class: 'ua-x-over-name' }, project.name), project.description ? el('p', { class: 'ua-x-over-desc' }, project.description) : null),
      el('div', { class: 'ua-x-stats' }, stat(nodes.length, 'Nodes'), stat(edges.length, 'Edges'), stat(layers.length, 'Layers'), stat(Object.keys(types).length, 'Types')),
      categories.some(([label, , n]) => label !== 'Code' && n > 0)
        ? el('section', null, heading('File Types'), el('div', { class: 'ua-x-cats' }, shownCats.map(([label, color, n]) => el('div', { class: 'ua-x-cat' }, el('span', { class: 'ua-x-dot', style: { '--ua-c': `var(--ua-t-${color})` } }), el('span', { class: 'ua-x-cat-label' }, label), el('span', { class: 'ua-x-num' }, String(n))))))
        : null,
      pills('Languages', project.languages),
      pills('Frameworks', project.frameworks),
      el(
        'section',
        null,
        heading('Node Type Distribution'),
        el(
          'div',
          { class: 'ua-x-dist' },
          Object.entries(types)
            .sort((a, b) => b[1] - a[1])
            .map(([type, n]) => {
              const pct = ((n / nodes.length) * 100).toFixed(0)
              return el('div', { class: 'ua-x-dist-row' }, el('div', { class: 'ua-x-dist-top' }, el('span', { class: 'ua-x-dist-type' }, type), el('span', { class: 'ua-x-num' }, `${n} (${pct}%)`)), el('div', { class: 'ua-x-meter' }, el('span', { style: { '--ua-x-pct': `${pct}%` } })))
            }),
        ),
      ),
      Object.values(complexity).some((n) => n > 0)
        ? el(
            'section',
            null,
            heading('Complexity Distribution'),
            el(
              'div',
              { class: 'ua-x-cx-grid' },
              ['simple', 'moderate', 'complex'].map((level) => el('div', { class: `ua-x-cx-tile is-${level}` }, el('b', null, String(complexity[level] || 0)), el('span', null, level))),
            ),
          )
        : null,
      top.length ? el('section', null, heading('Most Connected Nodes'), el('ol', { class: 'ua-x-top' }, top.map((node, i) => el('li', { class: 'ua-x-top-row' }, el('span', { class: 'ua-x-rank' }, String(i + 1)), el('span', { class: 'ua-x-top-name' }, node.name), el('span', { class: 'ua-x-num' }, String(node.count)))))) : null,
      el('div', { class: 'ua-x-avg' }, el('span', null, 'Avg Connections per Node'), el('b', null, nodes.length ? ((edges.length * 2) / nodes.length).toFixed(1) : '0')),
      Number.isNaN(analyzed.getTime()) ? null : el('p', { class: 'ua-x-analyzed' }, `Analyzed: ${analyzed.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`),
      api.util.tourSteps(graph).length ? el('button', { class: 'ua-x-cta', type: 'button', 'data-focus': 'x-start-tour', onclick: () => actions.startTour() }, 'Start Guided Tour') : null,
    )
  }

  api.panels.info({ id: 'overview', order: 30, when: (s) => !s.selected && !api.util.isLearnMode(s), render: (s) => overview(s) })

  const tip = el('div', { class: 'ua-x-tip', role: 'tooltip' })
  const stage = api.root.querySelector('.ua-stage')

  function hideTip() {
    tipId = null
    tip.remove()
  }

  function tipContent(id) {
    const node = api.data.node(id)
    if (!node) return null
    const edges = api.data.edgesOf(id)
    const incoming = edges.filter((e) => e.target === id).length
    const outgoing = edges.filter((e) => e.source === id).length
    const tags = Array.isArray(node.tags) ? node.tags : []
    return [
      el('div', { class: 'ua-x-tip-head' }, el('span', { class: 'ua-x-tip-type' }, node.type), node.complexity ? el('span', { class: 'ua-x-tip-cx' }, node.complexity) : null),
      el('h4', { class: 'ua-x-tip-name' }, node.name),
      el('div', { class: 'ua-x-tip-stats' }, el('span', { class: 'ua-x-tip-in' }, glyph('in'), `${incoming} in`), el('span', { class: 'ua-x-tip-out' }, glyph('out'), `${outgoing} out`), el('span', { class: 'ua-x-tip-total' }, glyph('bolt'), String(incoming + outgoing))),
      node.summary ? el('p', { class: 'ua-x-tip-summary' }, node.summary) : null,
      tags.length ? el('div', { class: 'ua-x-tip-tags' }, tags.slice(0, 3).map((tag) => el('span', { class: 'ua-x-tip-tag' }, tag)), tags.length > 3 ? el('span', { class: 'ua-x-tip-more' }, `+${tags.length - 3}`) : null) : null,
    ]
  }

  function moveTip(event) {
    const card = event.pointerType === 'mouse' && !event.buttons && event.target instanceof Element ? event.target.closest('.ua-node[data-id]') : null
    if (!card) return hideTip()
    if (card.dataset.id !== tipId) {
      const content = tipContent(card.dataset.id)
      if (!content) return hideTip()
      tip.replaceChildren(...content.filter(Boolean))
      tipId = card.dataset.id
    }
    if (!tip.isConnected) slots.overlay.append(tip)
    const x = Math.min(event.clientX + 16, window.innerWidth - tip.offsetWidth - 8)
    const y = event.clientY + 16 + tip.offsetHeight > window.innerHeight ? event.clientY - tip.offsetHeight - 12 : event.clientY + 16
    tip.style.left = `${Math.max(8, x)}px`
    tip.style.top = `${Math.max(8, y)}px`
  }

  if (stage) {
    stage.addEventListener('pointermove', moveTip)
    stage.addEventListener('pointerleave', hideTip)
    stage.addEventListener('pointerdown', hideTip)
    stage.addEventListener('wheel', hideTip, { passive: true })
  }

  const onDown = (event) => {
    const s = store.get()
    for (const name of ['filter', 'export', 'theme']) if (s.open[name] && !slots[name].contains(event.target)) actions.setOpen(name, false)
    if (dropOpen && !searchBox.contains(event.target)) {
      dropOpen = false
      paintSearch()
    }
  }
  document.addEventListener('mousedown', onDown)

  offs.push(
    api.keys.escape(1, () => {
      if (dropOpen || document.activeElement === input) {
        dropOpen = false
        input.blur()
        paintSearch()
      }
      return false
    }),
    api.keys.escape(9, (s) => Boolean(s.open.help) && (actions.setOpen('help', false), true)),
    api.keys.escape(35, (s) => Boolean(s.open.theme) && (actions.setOpen('theme', false), true)),
    store.subscribe((s, p) => {
      for (const run of renders) run(s, p)
    }),
  )
  for (const run of renders) run(store.get())

  return () => {
    for (const off of offs) off()
    document.removeEventListener('mousedown', onDown)
    if (stage) {
      stage.removeEventListener('pointermove', moveTip)
      stage.removeEventListener('pointerleave', hideTip)
      stage.removeEventListener('pointerdown', hideTip)
      stage.removeEventListener('wheel', hideTip)
    }
    hideTip()
    layer.remove()
  }
}
