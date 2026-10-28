import { el, icon, readStore, writeStore } from './ui.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const LEAF = 8
const HUB = 14
const CORE = 22
const SPACING = 15
const GAP = 28
const LINE_CHARS = 22
const LINE_HEIGHT = 13
const GOLDEN = Math.PI * (3 - Math.sqrt(5))
const MIN_ZOOM = 0.1
const MAX_ZOOM = 4
const FINISHED = new Set(['done', 'ended', 'stopped'])
const LEGEND = [
  ['working', 'Working'],
  ['waiting', 'Needs input'],
  ['done', 'Done'],
  ['failed', 'Failed'],
  ['idle', 'Idle or stopped'],
]

function svg(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs || {})) if (value !== null && value !== undefined) node.setAttribute(key, value)
  return node
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function tone(status) {
  if (status === 'working' || status === 'busy') return 'working'
  if (status === 'waiting' || status === 'blocked') return 'waiting'
  if (status === 'done' || status === 'failed') return status
  return 'idle'
}

function hubTone(leaves) {
  const tones = leaves.map((leaf) => tone(leaf.status))
  if (tones.includes('working')) return 'working'
  if (tones.includes('failed')) return 'failed'
  return tones.length && tones.every((value) => value === 'done') ? 'done' : 'idle'
}

function wrap(text) {
  const lines = []
  let line = ''
  for (const word of String(text || '').split(/\s+/).filter(Boolean)) {
    if (line && line.length + word.length + 1 > LINE_CHARS) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines
}

function disc(count) {
  const inner = HUB / 2 + 12
  const points = Array.from({ length: count }, (_, index) => {
    const radius = inner + SPACING * Math.sqrt(index + 0.5)
    const angle = index * GOLDEN
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
  })
  return { points, radius: count ? inner + SPACING * Math.sqrt(count - 0.5) + LEAF : HUB / 2 }
}

function layoutCluster(cluster) {
  const coreLines = wrap(cluster.title)
  const coreBelow = CORE / 2 + 8 + coreLines.length * LINE_HEIGHT
  const hubs = cluster.hubs.map((hub) => {
    const shape = disc(hub.leaves.length)
    const lines = wrap(hub.title)
    return { ...hub, ...shape, lines, size: shape.radius + 10 + lines.length * LINE_HEIGHT }
  })
  const total = hubs.reduce((sum, hub) => sum + 2 * hub.size + GAP, 0)
  const ring = hubs.length ? Math.max(coreBelow + GAP + Math.max(...hubs.map((hub) => hub.size)), total / (2 * Math.PI)) : 0
  let angle = -Math.PI / 2
  for (const hub of hubs) {
    const share = ((2 * hub.size + GAP) / total) * Math.PI * 2
    hub.x = Math.cos(angle + share / 2) * ring
    hub.y = Math.sin(angle + share / 2) * ring
    angle += share
  }
  const radius = hubs.length ? ring + Math.max(...hubs.map((hub) => hub.size)) : coreBelow
  return { ...cluster, coreLines, hubs, radius }
}

function arrange(clusters) {
  const laid = clusters.map(layoutCluster)
  if (laid.length === 1) {
    Object.assign(laid[0], { x: 0, y: 0 })
    return laid
  }
  const area = laid.reduce((sum, cluster) => sum + (2 * cluster.radius + GAP) ** 2, 0)
  const limit = Math.max(...laid.map((cluster) => 2 * cluster.radius), Math.sqrt(area) * 1.5)
  let x = 0
  let y = 0
  let row = 0
  for (const cluster of laid) {
    const size = 2 * cluster.radius
    if (x > 0 && x + size > limit) {
      x = 0
      y += row + GAP * 2
      row = 0
    }
    Object.assign(cluster, { x: x + cluster.radius, y: y + cluster.radius })
    x += size + GAP * 2
    row = Math.max(row, size)
  }
  return laid
}

export function createAgentGraph(container, { onOpen, storeKey, showFinished }) {
  const view = { x: 0, y: 0, k: 1 }
  let clusters = []
  let shapes = new Map()
  let finished = readStore(storeKey) === null ? showFinished : readStore(storeKey) === 'on'
  let query = ''
  let touched = false
  let drag = null
  let signature = ''
  let bounds = null

  const svgRoot = svg('svg', { class: 'graph-svg', role: 'img', 'aria-label': 'Graph of the agents' })
  const viewport = svg('g', { class: 'graph-viewport' })
  const linkLayer = svg('g')
  const nodeLayer = svg('g')
  const labelLayer = svg('g')
  viewport.append(linkLayer, nodeLayer, labelLayer)
  svgRoot.append(viewport)
  const tip = el('div', { class: 'graph-tip', hidden: true })
  const search = el('input', { class: 'input search', type: 'search', placeholder: 'Search agents', 'aria-label': 'Search agents', autocomplete: 'off', spellcheck: 'false' })
  const toggle = el('input', { type: 'checkbox', checked: finished })
  const summary = el('span', { class: 'graph-summary' })
  const bar = el('div', { class: 'graph-bar' }, search, el('label', { class: 'graph-toggle' }, toggle, el('span', null, 'Show finished agents')), summary)
  const legend = el('div', { class: 'graph-legend', 'aria-hidden': 'true' }, LEGEND.map(([key, label]) => el('span', { class: 'graph-legend-item' }, el('span', { class: `graph-swatch is-${key}` }), label)))
  const fitButton = el('button', { class: 'icon-button graph-fit', type: 'button', 'aria-label': 'Fit to screen', title: 'Fit to screen', onclick: () => fit(true) }, icon('fit'))
  const root = el('div', { class: 'graph' }, svgRoot, bar, legend, fitButton, tip)
  container.replaceChildren(root)

  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase()
    markSearch()
  })
  toggle.addEventListener('change', () => {
    finished = toggle.checked
    writeStore(storeKey, finished ? 'on' : 'off')
    signature = ''
    draw()
    fit(false)
  })

  function apply(animate) {
    viewport.classList.toggle('is-moving', Boolean(animate))
    viewport.style.setProperty('transform', `translate(${view.x}px, ${view.y}px) scale(${view.k})`)
  }

  function frame(box, animate) {
    const w = svgRoot.clientWidth
    const h = svgRoot.clientHeight
    if (!box || !w || !h) return
    const k = clamp(Math.min((w - 80) / Math.max(1, box.w), (h - 140) / Math.max(1, box.h)), MIN_ZOOM, 1.6)
    Object.assign(view, { k, x: w / 2 - (box.x + box.w / 2) * k, y: (h + 40) / 2 - (box.y + box.h / 2) * k })
    apply(animate)
  }

  function fit(animate) {
    if (animate) touched = false
    frame(bounds, animate)
  }

  function visibleCluster(cluster) {
    const hubs = cluster.hubs
      .map((hub) => ({ ...hub, leaves: finished ? hub.leaves : hub.leaves.filter((leaf) => !FINISHED.has(leaf.status)) }))
      .filter((hub) => finished || hub.leaves.length)
    return { ...cluster, hubs }
  }

  function label(x, y, lines, className, key) {
    const text = svg('text', { x, y, class: className, 'text-anchor': 'middle', 'data-key': key })
    lines.forEach((line, index) => {
      const span = svg('tspan', { x, dy: index ? LINE_HEIGHT : 0 })
      span.textContent = line
      text.append(span)
    })
    return text
  }

  function node(shape, size) {
    return svg('rect', { x: shape.x - size / 2, y: shape.y - size / 2, width: size, height: size, rx: size > LEAF ? 4 : 2, class: `graph-node is-${shape.kind} is-${shape.tone}`, 'data-key': shape.key })
  }

  function link(from, to, key) {
    return svg('line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, class: `graph-link is-${to.kind}`, 'data-from': from.key, 'data-to': to.key, 'data-key': key })
  }

  function draw() {
    const laid = arrange(clusters.map(visibleCluster))
    const nextSignature = JSON.stringify(laid.map((cluster) => [cluster.key, cluster.title, cluster.status, cluster.hubs.map((hub) => [hub.key, hub.title, hub.leaves.map((leaf) => [leaf.key, leaf.status, leaf.label])])]))
    let total = 0
    let shown = 0
    for (const cluster of clusters) for (const hub of cluster.hubs) total += hub.leaves.length
    for (const cluster of laid) for (const hub of cluster.hubs) shown += hub.leaves.length
    summary.textContent = total ? `${shown} of ${total} agents shown` : 'No agents yet'
    if (nextSignature === signature) return
    signature = nextSignature
    shapes = new Map()
    const links = []
    const nodes = []
    const labels = []
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const cluster of laid) {
      const core = { key: cluster.key, kind: 'core', tone: tone(cluster.status), x: cluster.x, y: cluster.y, title: cluster.title, detail: cluster.subtitle, payload: cluster.payload, related: new Set([cluster.key]) }
      shapes.set(core.key, core)
      x0 = Math.min(x0, cluster.x - cluster.radius)
      y0 = Math.min(y0, cluster.y - cluster.radius)
      x1 = Math.max(x1, cluster.x + cluster.radius)
      y1 = Math.max(y1, cluster.y + cluster.radius)
      for (const hub of cluster.hubs) {
        const hubKey = `${cluster.key}/${hub.key}`
        const hubShape = { key: hubKey, kind: 'hub', tone: hubTone(hub.leaves), x: cluster.x + hub.x, y: cluster.y + hub.y, title: hub.title, detail: hub.subtitle, radius: hub.radius, related: new Set([hubKey, core.key]) }
        shapes.set(hubKey, hubShape)
        core.related.add(hubKey)
        links.push(link(core, hubShape, `${core.key}>${hubKey}`))
        hub.leaves.forEach((leaf, index) => {
          const point = hub.points[index]
          const leafKey = `${hubKey}/${leaf.key}`
          const leafShape = { key: leafKey, kind: 'leaf', tone: tone(leaf.status), x: hubShape.x + point.x, y: hubShape.y + point.y, title: leaf.label, detail: leaf.detail, payload: leaf.payload, search: `${leaf.label} ${leaf.detail}`.toLowerCase(), related: new Set([leafKey, hubKey, core.key]) }
          shapes.set(leafKey, leafShape)
          hubShape.related.add(leafKey)
          links.push(link(hubShape, leafShape, `${hubKey}>${leafKey}`))
          nodes.push(node(leafShape, LEAF))
        })
        nodes.push(node(hubShape, HUB))
        labels.push(label(hubShape.x, hubShape.y + hub.radius + 14, hub.lines, 'graph-label is-hub', hubKey))
      }
      nodes.push(node(core, CORE))
      labels.push(label(cluster.x, cluster.y + CORE / 2 + 16, cluster.coreLines, 'graph-label is-core', core.key))
    }
    bounds = Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
    linkLayer.replaceChildren(...links)
    nodeLayer.replaceChildren(...nodes)
    labelLayer.replaceChildren(...labels)
    markSearch()
    if (!touched) fit(false)
  }

  function markSearch() {
    svgRoot.classList.toggle('is-search', Boolean(query))
    for (const element of nodeLayer.children) {
      const shape = shapes.get(element.dataset.key)
      element.classList.toggle('is-match', Boolean(query && shape && shape.search && shape.search.includes(query)))
    }
  }

  function focus(shape) {
    svgRoot.classList.toggle('is-focus', Boolean(shape))
    for (const layer of [nodeLayer, labelLayer]) {
      for (const element of layer.children) element.classList.toggle('is-lit', Boolean(shape && shape.related.has(element.dataset.key)))
    }
    for (const element of linkLayer.children) element.classList.toggle('is-lit', Boolean(shape && shape.related.has(element.dataset.from) && shape.related.has(element.dataset.to)))
  }

  function showTip(shape, event) {
    tip.hidden = !shape
    if (!shape) return
    tip.replaceChildren(el('strong', null, shape.title), shape.detail ? el('span', null, shape.detail) : null, shape.kind === 'leaf' && shape.payload ? el('span', { class: 'graph-tip-hint' }, 'Click to open its run') : shape.kind === 'hub' ? el('span', { class: 'graph-tip-hint' }, 'Click to zoom in') : null)
    const box = root.getBoundingClientRect()
    tip.style.setProperty('left', `${Math.min(event.clientX - box.left + 14, box.width - 300)}px`)
    tip.style.setProperty('top', `${event.clientY - box.top + 16}px`)
  }

  function shapeOf(target) {
    const key = target && target.closest && target.closest('[data-key]') ? target.closest('[data-key]').dataset.key : null
    return key ? shapes.get(key) || null : null
  }

  svgRoot.addEventListener('pointerover', (event) => {
    if (drag && drag.moved) return
    const shape = event.target.classList && event.target.classList.contains('graph-node') ? shapeOf(event.target) : null
    focus(shape)
    showTip(shape, event)
  })
  svgRoot.addEventListener('pointermove', (event) => {
    if (drag) {
      const dx = event.clientX - drag.x
      const dy = event.clientY - drag.y
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
      drag.moved = true
      touched = true
      Object.assign(view, { x: drag.vx + dx, y: drag.vy + dy })
      apply(false)
      return
    }
    if (!tip.hidden) showTip(shapes.get(tip.dataset.key) || shapeOf(event.target), event)
  })
  svgRoot.addEventListener('pointerleave', () => {
    focus(null)
    showTip(null)
  })
  svgRoot.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    svgRoot.setPointerCapture(event.pointerId)
    drag = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false, shape: event.target.classList.contains('graph-node') ? shapeOf(event.target) : null }
  })
  svgRoot.addEventListener('pointerup', () => {
    const shape = drag && !drag.moved ? drag.shape : null
    drag = null
    if (!shape) return
    if (shape.kind === 'hub') {
      touched = true
      const r = shape.radius + 30
      frame({ x: shape.x - r, y: shape.y - r, w: r * 2, h: r * 2 + 40 }, true)
    } else if (shape.payload) onOpen(shape.payload)
  })
  svgRoot.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      const box = svgRoot.getBoundingClientRect()
      const px = event.clientX - box.left
      const py = event.clientY - box.top
      const k = clamp(view.k * Math.exp(-event.deltaY * (event.deltaMode === 1 ? 16 : 1) * (event.ctrlKey ? 0.01 : 0.0015)), MIN_ZOOM, MAX_ZOOM)
      Object.assign(view, { x: px - ((px - view.x) * k) / view.k, y: py - ((py - view.y) * k) / view.k, k })
      touched = true
      apply(false)
    },
    { passive: false },
  )
  const resize = new ResizeObserver(() => {
    if (!touched) fit(false)
  })
  resize.observe(svgRoot)

  return {
    update(next) {
      clusters = next
      draw()
    },
    destroy() {
      resize.disconnect()
      container.replaceChildren()
    },
  }
}
