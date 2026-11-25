import { el, icon, link, urlFor, navigate, setTitle, live, spinner, badge, joinMeta, stateBlock, errorBlock, keepFocus, reducedMotion, readStore, writeStore, createMenu, button } from './ui.js'
import { openChat, openProject, openRun } from './panels.js'
import { createUsage } from './usage.js'

const NODE_W = 248
const NODE_H = 64
const SIDE = { level: 96, sibling: 16, group: 36 }
const DOWN = { level: 56, sibling: 20, stack: 12, indent: 40, block: 56 }
const ARROW_GAP = 3
const CORNER = 10
const PAD = 56
const HEAD_GAP = 18
const MIN_ZOOM = 0.1
const MAX_ZOOM = 1.4
const GRID = 20
const MINI_W = 200
const MINI_H = 140
const LAYOUT_KEY = 'claude-dashboard-flow-layout'
const USAGE_KEY = 'claude-dashboard-flow-usage'
const PROJECT_KEY = 'claude-dashboard-flow-project'
const LAYOUTS = [
  { key: 'graph', label: 'Graph' },
  { key: 'side', label: 'Sideways' },
  { key: 'down', label: 'Waterfall' },
]
const GRAPH = {
  dot: { project: 22, session: 16, workflow: 12, agent: 10 },
  width: { project: 184, session: 172, workflow: 156, agent: 140 },
  gap: 16,
  directions: 72,
  cluster: 96,
  line: 16,
  char: 6.6,
  label: 6,
  aspect: 1.6,
}
const SVG_NS = 'http://www.w3.org/2000/svg'
const KIND_ICONS = { project: 'folder', session: 'chat', agent: 'bot', workflow: 'flow' }

function svg(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value)
  return node
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function treeOf(groups) {
  const branch = (session) => (node) => ({ key: `n:${session.id}:${node.key}`, kind: node.kind, item: node, session, children: node.children.map(branch(session)) })
  return groups.map((group) => ({
    key: `p:${group.project}`,
    kind: 'project',
    item: group,
    children: group.sessions.map((session) => ({
      key: `s:${session.id}`,
      kind: 'session',
      item: session,
      session,
      children: session.agentNodes.map(branch(session)),
    })),
  }))
}

function topOf(groups) {
  return [...groups]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((group) => ({
      key: `p:${group.project}`,
      kind: 'project',
      item: group,
      children: [...group.sessions]
        .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0) || a.id.localeCompare(b.id))
        .map((session) => ({ key: `s:${session.id}`, kind: 'session', item: session, session, children: [] })),
    }))
}

function levelOf(session, path) {
  const target = path[path.length - 1]
  const leaf = (item) => ({ key: `n:${session.id}:${item.key}`, kind: item.kind, item, session, children: [] })
  const center = target ? { ...leaf(target), center: true } : { key: `s:${session.id}`, kind: 'session', item: session, session, center: true }
  center.children = (target ? target.children : session.agentNodes).map(leaf)
  return [center]
}

function pathTo(items, key) {
  for (const item of items) {
    if (item.key === key) return [item]
    const below = pathTo(item.children, key)
    if (below) return [item, ...below]
  }
  return null
}

function canOpen(node) {
  if (node.center) return false
  if (node.kind === 'session') return node.item.agentCount > 0
  return (node.kind === 'workflow' || node.kind === 'agent') && node.item.children.length > 0
}

function graphSub(node, tone) {
  const item = node.item
  if (node.kind === 'session') return item.agentCount ? item.agentsLabel : null
  if (node.kind === 'workflow') return item.statusLabel
  if (node.kind !== 'agent') return null
  if (tone === 'working' && item.activity) return activityLabel(item.activity)
  if (!item.children.length) return null
  const working = item.children.filter((child) => child.status === 'working').length
  return [`${item.children.length} ${item.children.length === 1 ? 'agent' : 'agents'}`, working ? `${working} working` : null].filter(Boolean).join(', ')
}

function cardBoxes(layout) {
  for (const node of layout.nodes) node.box = [0, 0, NODE_W, NODE_H]
  return layout
}

function sideLayout(roots) {
  const nodes = []
  const edges = []
  let cursor = 0
  let depth = 0
  function place(node, level) {
    nodes.push(node)
    node.x = level * (NODE_W + SIDE.level)
    depth = Math.max(depth, level)
    if (node.children.length) {
      for (const child of node.children) {
        place(child, level + 1)
        edges.push({ key: `${node.key}>${child.key}`, from: node, to: child, shape: 'side' })
      }
      node.y = (node.children[0].y + node.children[node.children.length - 1].y) / 2
    } else {
      node.y = cursor
      cursor += NODE_H + SIDE.sibling
    }
  }
  roots.forEach((root, index) => {
    if (index) cursor += SIDE.group
    place(root, 0)
  })
  return { nodes, edges, width: (depth + 1) * NODE_W + depth * SIDE.level, height: Math.max(NODE_H, cursor - SIDE.sibling) }
}

function waterfallLayout(roots) {
  const top = NODE_H + DOWN.level
  const blocks = roots.map((project) => {
    const nodes = [project]
    const edges = []
    let x = 0
    let height = NODE_H
    for (const session of project.children) {
      nodes.push(session)
      Object.assign(session, { x, y: top })
      edges.push({ key: `${project.key}>${session.key}`, from: project, to: session, shape: 'down' })
      let row = 0
      let deepest = 0
      const stack = (parent, depth) => {
        for (const child of parent.children) {
          row += 1
          deepest = Math.max(deepest, depth)
          nodes.push(child)
          Object.assign(child, { x: x + DOWN.indent * depth, y: top + row * (NODE_H + DOWN.stack) })
          edges.push({ key: `${parent.key}>${child.key}`, from: parent, to: child, shape: 'stack' })
          stack(child, depth + 1)
        }
      }
      stack(session, 1)
      height = Math.max(height, top + row * (NODE_H + DOWN.stack) + NODE_H)
      x += NODE_W + DOWN.indent * deepest + DOWN.sibling
    }
    const sessions = project.children
    Object.assign(project, { x: sessions.length ? (sessions[0].x + sessions[sessions.length - 1].x) / 2 : 0, y: 0 })
    return { nodes, edges, width: Math.max(NODE_W, x - DOWN.sibling), height }
  })
  const nodes = []
  const edges = []
  let x = 0
  for (const block of blocks) {
    for (const node of block.nodes) {
      node.x += x
      nodes.push(node)
    }
    edges.push(...block.edges)
    x += block.width + DOWN.block
  }
  return { nodes, edges, width: Math.max(NODE_W, x - DOWN.block), height: Math.max(NODE_H, ...blocks.map((block) => block.height)) }
}

function graphLayout(roots) {
  const nodes = []
  const edges = []
  const turns = [0]
  for (let step = 1; turns.length < GRAPH.directions; step++) turns.push((step * 2 * Math.PI) / GRAPH.directions, (-step * 2 * Math.PI) / GRAPH.directions)
  function nearest(self, r, placed, forward, inbound) {
    let best = null
    for (const turn of turns) {
      const ux = Math.cos(forward + turn)
      const uy = Math.sin(forward + turn)
      const blocked = [[0, self + GRAPH.gap + r]]
      if (inbound && ux < 0) blocked.push([0, Math.abs(uy) < 1e-6 ? Infinity : (r + GRAPH.gap) / Math.abs(uy)])
      for (const spot of placed) {
        const along = ux * spot.x + uy * spot.y
        const clear = r + spot.r + GRAPH.gap
        const disc = along * along - spot.x * spot.x - spot.y * spot.y + clear * clear
        if (disc > 0) blocked.push([along - Math.sqrt(disc), along + Math.sqrt(disc)])
      }
      blocked.sort((a, b) => a[0] - b[0])
      let d = 0
      for (const [from, to] of blocked) {
        if (from > d) break
        d = Math.max(d, to)
      }
      if (!best || d < best.d - 0.5) best = { d, x: d * ux, y: d * uy }
    }
    return best
  }
  function measure(node, inbound) {
    const size = node.center ? GRAPH.dot.project : GRAPH.dot[node.kind]
    const width = node.center ? GRAPH.width.project : GRAPH.width[node.kind]
    const lines = Math.ceil((textOf(node).title.length * GRAPH.char) / width) + (node.kind === 'agent' || node.kind === 'workflow' || (node.kind === 'session' && node.item.agentCount) ? 1 : 0)
    const height = size + GRAPH.label + Math.max(1, lines) * GRAPH.line
    const self = Math.hypot(width / 2, height - size / 2)
    Object.assign(node, { size, box: [-width / 2, -size / 2, width, height], spots: [] })
    for (const child of node.children) measure(child, true)
    const parents = node.children.filter((child) => child.children.length).sort((a, b) => b.reach - a.reach)
    for (const child of [...parents, ...node.children.filter((child) => !child.children.length)]) {
      node.spots.push({ ...nearest(self, child.reach, node.spots, 0, inbound), r: child.reach, child })
    }
    const parts = [{ x: 0, y: 0, r: self }, ...node.spots]
    const span = (center) => Math.max(...parts.map((part) => Math.hypot(part.x - center, part.y) + part.r))
    let lo = Math.min(...parts.map((part) => part.x))
    let hi = Math.max(...parts.map((part) => part.x))
    for (let step = 0; step < 40; step++) {
      const a = lo + (hi - lo) / 3
      const b = hi - (hi - lo) / 3
      if (span(a) < span(b)) hi = b
      else lo = a
    }
    node.shift = (lo + hi) / 2
    node.reach = span(node.shift)
  }
  function place(node, x, y, turn) {
    Object.assign(node, { x, y })
    nodes.push(node)
    const cos = Math.cos(turn)
    const sin = Math.sin(turn)
    for (const spot of node.spots) {
      const sx = spot.x * cos - spot.y * sin
      const sy = spot.x * sin + spot.y * cos
      const angle = Math.atan2(sy, sx)
      const away = Math.hypot(sx, sy) - spot.child.shift
      edges.push({ key: `${node.key}>${spot.child.key}`, from: node, to: spot.child, shape: 'line' })
      place(spot.child, x + away * Math.cos(angle), y + away * Math.sin(angle), angle)
    }
  }
  for (const root of roots) measure(root, false)
  const rowsOf = (columns) => Array.from({ length: Math.ceil(roots.length / columns) }, (_, index) => roots.slice(index * columns, (index + 1) * columns))
  const spanOf = (row) => row.reduce((sum, root) => sum + 2 * root.reach + GRAPH.cluster, -GRAPH.cluster)
  let best = null
  for (let columns = 1; columns <= roots.length; columns++) {
    const rows = rowsOf(columns)
    const width = Math.max(...rows.map(spanOf))
    const height = rows.reduce((sum, row) => sum + 2 * Math.max(...row.map((root) => root.reach)) + GRAPH.cluster, -GRAPH.cluster)
    const score = Math.min(GRAPH.aspect / width, 1 / height)
    if (!best || score > best.score) best = { rows, score }
  }
  let top = 0
  for (const row of best ? best.rows : []) {
    const tall = Math.max(...row.map((root) => root.reach))
    let left = 0
    for (const root of row) {
      place(root, left + root.reach, top + tall + root.shift, -Math.PI / 2)
      left += 2 * root.reach + GRAPH.cluster
    }
    top += 2 * tall + GRAPH.cluster
  }
  if (!nodes.length) return { nodes, edges, width: NODE_W, height: NODE_H }
  const minX = Math.min(...nodes.map((node) => node.x + node.box[0]))
  const minY = Math.min(...nodes.map((node) => node.y + node.box[1]))
  for (const node of nodes) Object.assign(node, { x: node.x - minX, y: node.y - minY })
  return {
    nodes,
    edges,
    width: Math.max(...nodes.map((node) => node.x + node.box[0] + node.box[2])),
    height: Math.max(...nodes.map((node) => node.y + node.box[1] + node.box[3])),
  }
}

function edgePath(edge) {
  const { from, to } = edge
  if (edge.shape === 'line') return `M ${from.x} ${from.y} L ${to.x} ${to.y}`
  if (edge.shape === 'stack') {
    const x1 = from.x + DOWN.indent / 2
    const y1 = from.y + NODE_H
    const x2 = to.x - ARROW_GAP
    const y2 = to.y + NODE_H / 2
    const r = Math.min(CORNER, x2 - x1)
    return `M ${x1} ${y1} V ${y2 - r} Q ${x1} ${y2} ${x1 + r} ${y2} H ${x2}`
  }
  if (edge.shape === 'down') {
    const x1 = from.x + NODE_W / 2
    const y1 = from.y + NODE_H
    const x2 = to.x + NODE_W / 2
    const y2 = to.y - ARROW_GAP
    const mid = y1 + DOWN.level / 2
    if (Math.abs(x2 - x1) < 1) return `M ${x1} ${y1} V ${y2}`
    const r = Math.min(CORNER, Math.abs(x2 - x1) / 2)
    const sx = Math.sign(x2 - x1)
    return `M ${x1} ${y1} V ${mid - r} Q ${x1} ${mid} ${x1 + sx * r} ${mid} H ${x2 - sx * r} Q ${x2} ${mid} ${x2} ${mid + r} V ${y2}`
  }
  const x1 = from.x + NODE_W
  const y1 = from.y + NODE_H / 2
  const x2 = to.x - ARROW_GAP
  const y2 = to.y + NODE_H / 2
  const mid = x1 + SIDE.level / 2
  if (Math.abs(y2 - y1) < 1) return `M ${x1} ${y1} H ${x2}`
  const r = Math.min(CORNER, Math.abs(y2 - y1) / 2)
  const sy = Math.sign(y2 - y1)
  return `M ${x1} ${y1} H ${mid - r} Q ${mid} ${y1} ${mid} ${y1 + sy * r} V ${y2 - sy * r} Q ${mid} ${y2} ${mid + r} ${y2} H ${x2}`
}

function activityLabel(activity) {
  return [activity.label, activity.target].filter(Boolean).join(' ')
}

function toneOf(node) {
  const item = node.item
  if (node.kind === 'project') return item.busy ? 'working' : 'idle'
  if (node.kind === 'session') return item.status === 'busy' ? 'working' : item.status === 'waiting' || item.status === 'blocked' ? 'waiting' : 'idle'
  return item.status === 'working' ? 'working' : item.status === 'failed' ? 'failed' : 'faded'
}

function textOf(node) {
  const item = node.item
  if (node.kind === 'project') return { title: item.name, sub: item.summaryLabel, badge: item.busy ? ['busy', `${item.busy} working`] : null }
  if (node.kind === 'session') return { title: item.title, sub: joinMeta([item.whereLabel, item.tokensLabel]), badge: [item.status, item.statusLabel] }
  if (node.kind === 'workflow') return { title: item.name, sub: item.statusLabel, badge: [item.status, item.stateLabel], progress: item.progress }
  return { title: item.description, sub: item.activity ? activityLabel(item.activity) : joinMeta([item.typeLabel, item.tokensLabel]), badge: [item.status, item.statusLabel] }
}

export function overviewPage(container, params) {
  setTitle('Overview')
  const view = { x: 0, y: 0, k: 1 }
  const pointers = new Map()
  let graph = null
  let byKey = new Map()
  let touched = false
  let drag = null
  let pinch = null
  let moveTimer = null
  let lastState = null
  let miniScale = 1
  let direction = LAYOUTS.some((entry) => entry.key === readStore(LAYOUT_KEY)) ? readStore(LAYOUT_KEY) : 'graph'
  let headSpace = 0
  if (params.get('project')) writeStore(PROJECT_KEY, params.get('project'))
  let project = params.get('project') || readStore(PROJECT_KEY) || null
  let conversation = params.get('conversation') || null
  let inside = params.get('node') || null
  let level = null
  let crumbSig = ''
  let flying = false
  let arrival = null
  let depth = 0
  let lastLevel = null
  const edgeEls = new Map()

  const defs = svg('defs')
  const arrow = (id, className) => {
    const marker = svg('marker', { id, viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '10', markerHeight: '10', markerUnits: 'userSpaceOnUse', orient: 'auto' })
    marker.append(svg('path', { d: 'M2 1.5 L9 5 L2 8.5', class: className }))
    return marker
  }
  defs.append(arrow('flow-arrow', 'flow-arrow'), arrow('flow-arrow-live', 'flow-arrow-live'))
  const edgeLayer = svg('svg', { class: 'flow-edges', 'aria-hidden': 'true' })
  const idleEdges = svg('g')
  const liveEdges = svg('g')
  edgeLayer.append(defs, idleEdges, liveEdges)
  const nodeLayer = el('div', { class: 'flow-nodes' })
  const world = el('div', { class: 'flow-world' }, edgeLayer, nodeLayer)

  const mini = svg('svg', { class: 'flow-minimap', 'aria-hidden': 'true' })
  const miniNodes = svg('g')
  const miniMask = svg('path', { class: 'flow-mask', 'fill-rule': 'evenodd' })
  mini.append(miniNodes, miniMask)

  const summary = el('p', { class: 'flow-summary' })
  const crumb = el('nav', { class: 'flow-crumb', 'aria-label': 'Where you are', title: 'Esc to go back', hidden: true })
  const warp = el('div', { class: 'flow-warp', 'aria-hidden': 'true' })
  const rings = [0, 1].map(() => el('div', { class: 'flow-ring', 'aria-hidden': 'true' }))
  const usageHolder = el('div', { class: 'flow-usage' })
  const head = el('div', { class: 'flow-head' }, el('h1', { class: 'flow-heading' }, 'Overview'), summary, usageHolder)
  const usage = createUsage(usageHolder, { collapseKey: USAGE_KEY })
  const pill = el('p', { class: 'flow-pill', role: 'status', hidden: true })
  const empty = el('div', { class: 'flow-empty', hidden: true })
  const controls = el(
    'div',
    { class: 'flow-controls' },
    el('button', { class: 'flow-control', type: 'button', 'aria-label': 'Zoom in', title: 'Zoom in', onclick: () => zoomBy(1.25) }, icon('plus')),
    el('button', { class: 'flow-control', type: 'button', 'aria-label': 'Zoom out', title: 'Zoom out', onclick: () => zoomBy(0.8) }, icon('minus')),
    el('button', { class: 'flow-control', type: 'button', 'aria-label': 'Fit to screen', title: 'Fit to screen', onclick: () => fit(true) }, icon('fit')),
  )
  const switcher = el('div', { class: 'flow-switch', role: 'group', 'aria-label': 'Layout' })
  const projectHolder = el('div', { class: 'menu' })
  const pickProject = (key) => {
    writeStore(PROJECT_KEY, key)
    navigate(urlFor({ view: 'overview', project: key }))
  }
  const projectMenu = createMenu(projectHolder, { label: 'Project', align: 'end', onSelect: (key) => pickProject(key === 'all' ? null : key) })
  const tools = el('div', { class: 'flow-tools' }, projectHolder, switcher)
  const canvas = el('section', { class: 'flow', 'aria-label': 'Map of the running conversations and their agents' }, world, warp, ...rings, head, crumb, pill, empty, tools, controls, mini)

  container.replaceChildren(canvas)

  function apply() {
    world.style.setProperty('transform', `translate(${view.x}px, ${view.y}px) scale(${view.k})`)
    world.style.setProperty('--zoom', String(view.k))
    let grid = GRID * view.k
    while (grid < 10) grid *= 2
    canvas.style.setProperty('background-size', `${grid}px ${grid}px`)
    canvas.style.setProperty('background-position', `${view.x}px ${view.y}px`)
    if (!graph) return
    const vx = -view.x / view.k
    const vy = -view.y / view.k
    const vw = canvas.clientWidth / view.k
    const vh = canvas.clientHeight / view.k
    const left = Math.min(0, vx)
    const top = Math.min(0, vy)
    const width = Math.max(graph.width, vx + vw) - left
    const height = Math.max(graph.height, vy + vh) - top
    const scale = Math.max(width / MINI_W, height / MINI_H)
    const offset = 5 * scale
    const w = scale * MINI_W + offset * 2
    const h = scale * MINI_H + offset * 2
    const x = left - (scale * MINI_W - width) / 2 - offset
    const y = top - (scale * MINI_H - height) / 2 - offset
    miniScale = w / MINI_W
    mini.setAttribute('viewBox', `${x} ${y} ${w} ${h}`)
    miniMask.setAttribute('d', `M${x - offset} ${y - offset}h${w + offset * 2}v${h + offset * 2}h${-(w + offset * 2)}z M${vx} ${vy}h${vw}v${vh}h${-vw}z`)
  }

  function move(next, animate) {
    Object.assign(view, next)
    if (animate && !reducedMotion()) {
      canvas.classList.add('is-moving')
      window.clearTimeout(moveTimer)
      moveTimer = window.setTimeout(() => canvas.classList.remove('is-moving'), 320)
    }
    apply()
  }

  function headBottom() {
    if (!usage.expanded()) headSpace = head.offsetTop + head.offsetHeight + HEAD_GAP
    const base = headSpace || head.offsetTop + usageHolder.offsetTop + HEAD_GAP
    return Math.min(crumb.hidden ? base : base + 8 + crumb.offsetHeight, canvas.clientHeight - PAD - NODE_H)
  }

  function fit(animate) {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (!graph || !w || !h) return
    if (animate) touched = false
    const top = headBottom()
    const k = clamp(Math.min((w - PAD * 2) / graph.width, (h - top - PAD) / graph.height), MIN_ZOOM, 1)
    move({ k, x: (w - graph.width * k) / 2, y: top + (h - top - PAD - graph.height * k) / 2 }, animate)
  }

  function zoomAt(px, py, next) {
    const k = clamp(next, MIN_ZOOM, MAX_ZOOM)
    touched = true
    move({ k, x: px - ((px - view.x) * k) / view.k, y: py - ((py - view.y) * k) / view.k })
  }

  function zoomBy(factor) {
    zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, view.k * factor)
  }

  function reveal(node) {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    const [bx, by, bw, bh] = node.box
    const left = (node.x + bx) * view.k + view.x
    const top = (node.y + by) * view.k + view.y
    if (left >= 8 && top >= 8 && left + bw * view.k <= w - 8 && top + bh * view.k <= h - 8) return
    touched = true
    move({ x: w / 2 - (node.x + bx + bw / 2) * view.k, y: h / 2 - (node.y + by + bh / 2) * view.k }, true)
  }

  function openNode(node) {
    if (node.kind === 'agent') openRun(node.session.id, node.item.id)
    else if (node.kind !== 'project') openChat(node.session.id)
    else if (node.item.project) openProject(node.item.project)
  }

  function go(id, key) {
    navigate(urlFor({ view: 'overview', project, conversation: id, node: key }))
  }

  function screenOf(node) {
    return { x: node.x * view.k + view.x, y: node.y * view.k + view.y }
  }

  function viewTransform(point = null, factor = 1) {
    if (!point) return `translate(${view.x}px, ${view.y}px) scale(${view.k})`
    return `translate(${point.x - (point.x - view.x) * factor}px, ${point.y - (point.y - view.y) * factor}px) scale(${view.k * factor})`
  }

  function streaks(point, inward) {
    warp.style.setProperty('--wx', `${point.x}px`)
    warp.style.setProperty('--wy', `${point.y}px`)
    const [from, to] = inward ? ['scale(1.9) rotate(-8deg)', 'scale(0.6)'] : ['scale(0.6)', 'scale(1.9) rotate(8deg)']
    warp.animate([{ opacity: 0, transform: from }, { opacity: 0.85, offset: 0.35 }, { opacity: 0, transform: to }], { duration: 820, easing: 'cubic-bezier(.3,0,.2,1)' })
  }

  function shock(point) {
    rings.forEach((ring, index) => {
      ring.style.setProperty('left', `${point.x}px`)
      ring.style.setProperty('top', `${point.y}px`)
      ring.animate([{ opacity: 0.9, transform: 'scale(0.2)' }, { opacity: 0, transform: 'scale(7)' }], { duration: 800, delay: index * 160, easing: 'cubic-bezier(.1,.7,.3,1)', fill: 'backwards' })
    })
  }

  function settle() {
    const scripted = (animation) => !(animation instanceof CSSAnimation) && !(animation instanceof CSSTransition)
    for (const animation of [...world.getAnimations(), ...edgeLayer.getAnimations(), ...nodeLayer.getAnimations({ subtree: true })]) if (scripted(animation)) animation.cancel()
  }

  function travel(id, key, inward, from) {
    if (flying) return
    if (reducedMotion() || direction !== 'graph' || !graph) return go(id, key)
    flying = true
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    const center = graph.nodes.find((node) => node.center)
    const point = from ? screenOf(from) : center ? screenOf(center) : { x: w / 2, y: h / 2 }
    streaks(point, !inward)
    let leave
    if (inward) {
      const k = view.k * 2.6
      const x = w / 2 - from.x * k
      const y = (headBottom() + h) / 2 - from.y * k
      leave = world.animate([{ transform: viewTransform(), opacity: 1, filter: 'blur(0px)' }, { transform: `translate(${x}px, ${y}px) scale(${k})`, opacity: 0, filter: 'blur(3px)' }], { duration: 380, easing: 'cubic-bezier(.55,0,.85,.35)', fill: 'forwards' })
    } else {
      const elements = new Map([...nodeLayer.children].map((child) => [child.dataset.key, child]))
      for (const node of center ? graph.nodes : []) {
        const element = elements.get(node.key)
        if (element && node !== center) element.animate([{ transform: 'none', opacity: 1 }, { transform: `translate(${center.x - node.x}px, ${center.y - node.y}px) scale(.15)`, opacity: 0 }], { duration: 300, easing: 'cubic-bezier(.5,0,.9,.4)', fill: 'forwards' })
      }
      edgeLayer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: 'forwards' })
      leave = world.animate([{ transform: viewTransform(), opacity: 1 }, { transform: viewTransform(point, 0.55), opacity: 0 }], { duration: 380, easing: 'cubic-bezier(.55,0,.85,.35)', fill: 'forwards' })
    }
    leave.finished.then(() => {
      arrival = inward ? 'in' : 'out'
      go(id, key)
      if (arrival) {
        arrival = null
        settle()
      }
      flying = false
    })
  }

  function landingKey(previous) {
    if (!previous) return null
    if (!level) return `s:${previous.session.id}`
    const step = previous.path[level.path.length]
    return step ? `n:${previous.session.id}:${step.key}` : null
  }

  function arrive(kind, previous) {
    settle()
    const elements = new Map([...nodeLayer.children].map((child) => [child.dataset.key, child]))
    if (kind === 'out') {
      const landing = byKey.get(landingKey(previous))
      const point = landing ? screenOf(landing) : { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }
      if (!warp.getAnimations().length) streaks(point, true)
      world.animate([{ transform: viewTransform(point, 2.4), opacity: 0 }, { transform: viewTransform(), opacity: 1 }], { duration: 560, easing: 'cubic-bezier(.2,.8,.2,1)' })
      if (landing) shock(point)
      return
    }
    const center = graph.nodes.find((node) => node.center)
    if (!center) return
    const point = screenOf(center)
    if (!warp.getAnimations().length) streaks(point, false)
    shock(point)
    const order = new Map(graph.nodes.map((node, index) => [node, index]))
    const delay = (node) => 120 + Math.min(order.get(node) * 12, 360)
    for (const node of graph.nodes) {
      const element = elements.get(node.key)
      if (!element) continue
      if (node === center) element.animate([{ transform: 'scale(2.6)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 460, easing: 'cubic-bezier(.2,.9,.25,1)' })
      else element.animate([{ transform: `translate(${center.x - node.x}px, ${center.y - node.y}px) scale(.15)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 640, delay: delay(node), easing: 'cubic-bezier(.16,1.25,.3,1)', fill: 'backwards' })
    }
    for (const edge of graph.edges) {
      const path = edgeEls.get(edge.key)
      const length = Math.hypot(edge.to.x - edge.from.x, edge.to.y - edge.from.y)
      if (path) path.animate([{ strokeDasharray: `${length}px ${length}px`, strokeDashoffset: `${length}px` }, { strokeDasharray: `${length}px ${length}px`, strokeDashoffset: '0px' }], { duration: 560, delay: delay(edge.to), easing: 'cubic-bezier(.3,.7,.2,1)', fill: 'backwards' })
    }
  }

  function details() {
    const target = level && level.path[level.path.length - 1]
    if (target && target.kind === 'agent') openRun(level.session.id, target.id)
    else if (level) openChat(level.session.id)
  }

  function up() {
    if (!level) return
    const parent = level.path[level.path.length - 2]
    if (inside) travel(conversation, parent ? parent.key : null, false)
    else travel(null, null, false)
  }

  function onKey(event) {
    if (event.key !== 'Escape' || event.defaultPrevented || direction !== 'graph' || !conversation) return
    if (event.target.closest && event.target.closest('input, textarea, select, [contenteditable]')) return
    event.preventDefault()
    up()
  }

  function renderCrumb() {
    const steps = level
      ? [
          { tag: 'Project', label: level.projectName, to: [null, null] },
          { tag: 'Conversation', label: level.session.title, to: [level.session.id, null] },
          ...level.path.map((item) => ({ tag: item.kind === 'workflow' ? 'Workflow' : 'Agent', label: item.kind === 'workflow' ? item.name : item.description, to: [level.session.id, item.key] })),
        ]
      : []
    const sig = steps.map((step) => `${step.tag}:${step.label}`).join('\n')
    if (sig !== crumbSig) {
      crumbSig = sig
      crumb.hidden = !steps.length
      const parts = steps.flatMap((step, index) => [
        el('span', { class: 'agent-tag' }, step.tag),
        index === steps.length - 1 ? el('span', { class: 'flow-crumb-here' }, step.label) : el('button', { class: 'flow-crumb-link', type: 'button', 'data-focus': `crumb-${index}`, onclick: () => travel(...step.to, false) }, step.label),
      ])
      if (steps.length) parts.push(el('button', { class: 'flow-crumb-details', type: 'button', 'aria-haspopup': 'dialog', 'data-focus': 'crumb-details', onclick: details }, 'Details'))
      keepFocus(crumb, () => crumb.replaceChildren(...parts))
    }
    placeCrumb()
  }

  function placeCrumb() {
    crumb.style.setProperty('top', `${head.offsetTop + head.offsetHeight + 8}px`)
    crumb.style.setProperty('width', `${head.offsetWidth}px`)
  }

  function openGraphNode(node) {
    if (!canOpen(node)) return openNode(node)
    if (node.kind === 'session') travel(node.session.id, null, true, node)
    else travel(node.session.id, node.item.key, true, node)
  }

  function dotEl(node, text, tone) {
    const [left, top, width] = node.box
    const sub = graphSub(node, tone)
    const opens = canOpen(node)
    return el(
      'button',
      {
        class: `graph-node is-${node.kind} flow-${tone}${opens ? ' can-open' : ''}${node.center ? ' is-center' : ''}${node.item.status === 'done' ? ' is-done' : ''}`,
        type: 'button',
        'data-key': node.key,
        'data-focus': `flow-${node.key}`,
        'aria-haspopup': opens ? null : 'dialog',
        title: [text.title, text.sub, text.badge ? text.badge[1] : null].filter(Boolean).join('\n'),
        style: { left: `${node.x + left}px`, top: `${node.y + top}px`, width: `${width}px`, 'transform-origin': `50% ${node.size / 2}px` },
        onclick: () => openGraphNode(node),
      },
      el('span', { class: 'graph-dot', style: { width: `${node.size}px`, height: `${node.size}px` } }),
      el('span', { class: 'graph-label' }, text.title),
      sub ? el('span', { class: 'graph-sub' }, sub) : null,
    )
  }

  function nodeEl(node, text, tone) {
    return el(
      'button',
      {
        class: `flow-node is-${node.kind} flow-${tone}`,
        type: 'button',
        'data-key': node.key,
        'data-focus': `flow-${node.key}`,
        'aria-haspopup': 'dialog',
        title: text.title,
        style: { left: `${node.x}px`, top: `${node.y}px` },
        onclick: () => openNode(node),
      },
      el('span', { class: 'flow-icon' }, tone === 'working' ? spinner() : icon(KIND_ICONS[node.kind])),
      el('span', { class: 'flow-text' }, el('span', { class: 'flow-title' }, text.title), el('span', { class: 'flow-sub' }, text.sub)),
      text.badge ? el('span', { class: 'flow-badge' }, badge(...text.badge)) : null,
      text.progress === undefined ? null : el('span', { class: 'flow-progress', 'aria-hidden': 'true' }, el('span', { style: { width: `${Math.round(text.progress * 100)}%` } })),
    )
  }

  function syncNodes() {
    const old = new Map([...nodeLayer.children].map((child) => [child.dataset.key, child]))
    const next = graph.nodes.map((node) => {
      const text = textOf(node)
      const tone = toneOf(node)
      const sig = [direction, node.kind, node.center, tone, text.title, text.sub, text.badge ? text.badge.join(':') : '', text.progress, direction === 'graph' ? graphSub(node, tone) : '', node.x, node.y].join('|')
      const current = old.get(node.key)
      if (current && current.dataset.sig === sig) return current
      const fresh = direction === 'graph' ? dotEl(node, text, tone) : nodeEl(node, text, tone)
      fresh.dataset.sig = sig
      return fresh
    })
    const keep = new Set(next)
    keepFocus(nodeLayer, () => {
      for (const child of [...nodeLayer.children]) if (!keep.has(child)) child.remove()
      let cursor = nodeLayer.firstElementChild
      for (const element of next) {
        if (element === cursor) cursor = cursor.nextElementSibling
        else nodeLayer.insertBefore(element, cursor)
      }
    })
  }

  function syncEdges() {
    const seen = new Set()
    for (const edge of graph.edges) {
      seen.add(edge.key)
      const d = edgePath(edge)
      const liveEdge = toneOf(edge.to) === 'working'
      const group = liveEdge ? liveEdges : idleEdges
      let path = edgeEls.get(edge.key)
      if (!path) {
        path = svg('path')
        edgeEls.set(edge.key, path)
      }
      if (path.parentNode !== group) group.append(path)
      if (path.getAttribute('d') !== d) path.setAttribute('d', d)
      const className = liveEdge ? 'flow-edge is-live' : 'flow-edge'
      if (path.getAttribute('class') !== className) path.setAttribute('class', className)
      const marker = edge.shape === 'line' ? null : liveEdge ? 'url(#flow-arrow-live)' : 'url(#flow-arrow)'
      if (!marker) path.removeAttribute('marker-end')
      else if (path.getAttribute('marker-end') !== marker) path.setAttribute('marker-end', marker)
    }
    for (const [key, path] of edgeEls) {
      if (seen.has(key)) continue
      path.remove()
      edgeEls.delete(key)
    }
    edgeLayer.setAttribute('width', String(graph.width))
    edgeLayer.setAttribute('height', String(graph.height))
  }

  function syncMinimap() {
    miniNodes.replaceChildren(...graph.nodes.map((node) => svg('rect', { x: node.x + node.box[0], y: node.y + node.box[1], width: node.box[2], height: node.box[3], rx: 12, class: toneOf(node) === 'working' ? 'flow-mini-node is-live' : 'flow-mini-node' })))
  }

  function render(state) {
    const data = state.data
    pill.hidden = state.status !== 'stale'
    pill.textContent = state.status === 'stale' ? 'Reconnecting' : ''
    if (!data) {
      summary.textContent = ''
      empty.hidden = false
      empty.replaceChildren(state.status === 'loading' ? el('p', { class: 'meta' }, 'Loading') : errorBlock('Could not load the running conversations', state.error, () => live.refresh && live.refresh()))
      return
    }
    lastState = state
    level = null
    if (direction === 'graph' && conversation) {
      const session = data.sessions.find((item) => item.id === conversation)
      const path = session && inside ? pathTo(session.agentNodes, inside) : []
      if (!session || !path) {
        navigate(urlFor({ view: 'overview', project, conversation: session ? conversation : null }), { replace: true })
        return
      }
      const group = data.groups.find((item) => item.project === session.project)
      level = { session, path, projectName: group ? group.name : session.projectName }
    }
    const groups = project ? data.groups.filter((group) => group.project === project) : data.groups
    const choices = data.groups.filter((group) => group.project).map((group) => ({ key: group.project, label: group.name }))
    const chosen = project ? choices.find((choice) => choice.key === project) : null
    projectMenu.render(chosen ? chosen.label : project ? project.split('/').pop() : 'All projects', [{ key: 'all', label: 'All projects' }, ...choices], project || 'all')
    summary.textContent = project ? (groups[0] ? groups[0].summaryLabel : 'Nothing running in this project') : data.totals.summaryLabel
    const bare = !groups.length && !level
    empty.hidden = !bare
    controls.hidden = bare
    mini.toggleAttribute('hidden', bare)
    tools.hidden = !data.groups.length
    if (bare && project) {
      empty.replaceChildren(stateBlock({ title: `Nothing is running in ${project.split('/').pop()}`, text: 'Its conversations show up here again as soon as one is open in Claude Code.', actions: [button('Show all projects', () => pickProject(null))] }))
    } else if (bare) {
      empty.replaceChildren(stateBlock({ title: 'Nothing is running', text: 'Start Claude Code in a terminal, VS Code or the desktop app. It shows up here within a few seconds.', actions: [link(urlFor({ view: 'conversations' }), { class: 'button' }, 'See past conversations')] }))
    }
    renderCrumb()
    const first = !graph
    if (direction === 'graph') graph = graphLayout(level ? levelOf(level.session, level.path) : topOf(groups))
    else graph = cardBoxes(direction === 'down' ? waterfallLayout(treeOf(groups)) : sideLayout(treeOf(groups)))
    byKey = new Map(graph.nodes.map((node) => [node.key, node]))
    syncNodes()
    syncEdges()
    syncMinimap()
    if (first || !touched) fit(false)
    else apply()
    const nextDepth = level ? 1 + level.path.length : 0
    const kind = arrival || (!first && direction === 'graph' && nextDepth !== depth ? (nextDepth > depth ? 'in' : 'out') : null)
    const previous = lastLevel
    depth = nextDepth
    lastLevel = level
    arrival = null
    if (kind && !reducedMotion()) arrive(kind, previous)
  }

  function onPointerDown(event) {
    if (event.target.closest('.flow-node, .graph-node, .flow-controls, .flow-tools, .flow-empty, .flow-usage')) return
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    canvas.setPointerCapture(event.pointerId)
    if (event.target.closest('.flow-minimap')) {
      drag = { mini: true, x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, scale: miniScale, moved: false }
      return
    }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), k: view.k }
      drag = null
      return
    }
    drag = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false }
  }

  function onPointerMove(event) {
    if (!pointers.has(event.pointerId)) return
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      const box = canvas.getBoundingClientRect()
      zoomAt((a.x + b.x) / 2 - box.left, (a.y + b.y) / 2 - box.top, (pinch.k * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.distance)
      return
    }
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    drag.moved = true
    touched = true
    canvas.classList.add('is-panning')
    if (drag.mini) move({ x: drag.vx - dx * drag.scale * view.k, y: drag.vy - dy * drag.scale * view.k })
    else move({ x: drag.vx + dx, y: drag.vy + dy })
  }

  function onPointerUp(event) {
    if (!pointers.has(event.pointerId)) return
    pointers.delete(event.pointerId)
    if (pointers.size < 2) pinch = null
    if (drag && drag.mini && !drag.moved && event.type === 'pointerup') centerFromMini(event)
    if (!pointers.size) drag = null
    canvas.classList.remove('is-panning')
  }

  function centerFromMini(event) {
    const matrix = mini.getScreenCTM()
    if (!matrix) return
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
    touched = true
    move({ x: canvas.clientWidth / 2 - point.x * view.k, y: canvas.clientHeight / 2 - point.y * view.k })
  }

  function onWheel(event) {
    if (event.target.closest('.flow-empty, .flow-tools')) return
    event.preventDefault()
    const box = canvas.getBoundingClientRect()
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1)
    const factor = Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0015))
    if (event.target.closest('.flow-minimap')) zoomBy(factor)
    else zoomAt(event.clientX - box.left, event.clientY - box.top, view.k * factor)
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  nodeLayer.addEventListener('focusin', (event) => {
    const node = byKey.get(event.target.dataset.key)
    if (node && event.target.matches(':focus-visible')) reveal(node)
  })
  const resize = new ResizeObserver(() => {
    placeCrumb()
    if (!graph) return
    if (touched) apply()
    else fit(false)
  })
  resize.observe(canvas)
  resize.observe(head)
  resize.observe(crumb)
  function renderSwitch() {
    keepFocus(switcher, () =>
      switcher.replaceChildren(
        ...LAYOUTS.map((entry) => el('button', { class: 'flow-switch-option', type: 'button', 'aria-pressed': String(entry.key === direction), 'data-focus': `layout-${entry.key}`, onclick: () => setLayout(entry.key) }, entry.label)),
      ),
    )
  }

  function setLayout(key) {
    if (key === direction) return
    direction = key
    writeStore(LAYOUT_KEY, key === 'graph' ? null : key)
    renderSwitch()
    touched = false
    if (conversation) navigate(urlFor({ view: 'overview', project }), { replace: true })
    else if (lastState) render(lastState)
  }

  renderSwitch()
  usage.start()
  window.addEventListener('keydown', onKey)
  const unsubscribe = live.subscribe(render)

  return {
    update(next) {
      if (next.get('project')) writeStore(PROJECT_KEY, next.get('project'))
      const value = next.get('project') || readStore(PROJECT_KEY) || null
      const id = next.get('conversation') || null
      const key = next.get('node') || null
      if (value === project && id === conversation && key === inside) return
      touched = false
      project = value
      conversation = id
      inside = key
      if (lastState) render(lastState)
    },
    destroy() {
      projectMenu.close()
      usage.stop()
      unsubscribe()
      resize.disconnect()
      window.clearTimeout(moveTimer)
      window.removeEventListener('keydown', onKey)
    },
  }
}
