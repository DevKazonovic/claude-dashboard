import { el, icon, link, urlFor, navigate, setTitle, live, spinner, badge, joinMeta, stateBlock, errorBlock, keepFocus, reducedMotion, readStore, writeStore, createMenu, button } from './ui.js'
import { openChat, openProject, openRun } from './panels.js'
import { createOps } from './ops.js'

const NODE_W = 248
const NODE_H = 64
const SIDE = { level: 96, sibling: 16, group: 36 }
const DOWN = { level: 56, sibling: 20, stack: 12, indent: 40, block: 56 }
const ARROW_GAP = 3
const CORNER = 10
const PAD = 56
const PAD_TOP = 104
const MIN_ZOOM = 0.2
const MAX_ZOOM = 1.4
const GRID = 20
const MINI_W = 200
const MINI_H = 140
const LAYOUT_KEY = 'claude-dashboard-flow-layout'
const LAYOUTS = [
  { key: 'side', label: 'Sideways' },
  { key: 'down', label: 'Waterfall' },
  { key: 'ops', label: 'Ops room' },
]
const SVG_NS = 'http://www.w3.org/2000/svg'
const KIND_ICONS = { project: 'folder', session: 'chat', agent: 'bot', workflow: 'flow', more: 'layers' }

function svg(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value)
  return node
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function treeOf(groups) {
  return groups.map((group) => ({
    key: `p:${group.project}`,
    kind: 'project',
    item: group,
    children: group.sessions.map((session) => ({
      key: `s:${session.id}`,
      kind: 'session',
      item: session,
      session,
      children: session.agentNodes.map((node) => ({ key: `n:${session.id}:${node.key}`, kind: node.kind, item: node, session, children: [] })),
    })),
  }))
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
      session.children.forEach((agent, index) => {
        nodes.push(agent)
        Object.assign(agent, { x: x + DOWN.indent, y: top + NODE_H + DOWN.stack + index * (NODE_H + DOWN.stack) })
        edges.push({ key: `${session.key}>${agent.key}`, from: session, to: agent, shape: 'stack' })
      })
      const last = session.children[session.children.length - 1]
      height = Math.max(height, (last ? last.y : top) + NODE_H)
      x += NODE_W + (last ? DOWN.indent : 0) + DOWN.sibling
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

function edgePath(edge) {
  const { from, to } = edge
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
  if (node.kind === 'more') return 'faded'
  return item.status === 'working' ? 'working' : item.status === 'failed' ? 'failed' : 'faded'
}

function textOf(node) {
  const item = node.item
  if (node.kind === 'project') return { title: item.name, sub: item.summaryLabel, badge: item.busy ? ['busy', `${item.busy} working`] : null }
  if (node.kind === 'session') return { title: item.title, sub: joinMeta([item.whereLabel, item.tokensLabel]), badge: [item.status, item.statusLabel] }
  if (node.kind === 'workflow') return { title: item.name, sub: item.statusLabel, badge: [item.status, item.stateLabel], progress: item.progress }
  if (node.kind === 'more') return { title: item.label, sub: item.statusLabel, badge: null }
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
  let direction = ['down', 'ops'].includes(readStore(LAYOUT_KEY)) ? readStore(LAYOUT_KEY) : 'side'
  let room = null
  let project = params.get('project') || null
  let inside = params.get('conversation') || null
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
  const head = el('div', { class: 'flow-head' }, el('h1', { class: 'flow-heading' }, 'Overview'), summary)
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
  const projectMenu = createMenu(projectHolder, { label: 'Project', align: 'end', onSelect: (key) => navigate(urlFor({ view: 'overview', project: key === 'all' ? null : key })) })
  const tools = el('div', { class: 'flow-tools' }, projectHolder, switcher)
  const roomHolder = el('div', { class: 'flow-ops', hidden: true })
  const canvas = el('section', { class: 'flow', 'aria-label': 'Map of the running conversations and their agents' }, world, roomHolder, head, pill, empty, tools, controls, mini)

  container.replaceChildren(canvas)

  function apply() {
    world.style.setProperty('transform', `translate(${view.x}px, ${view.y}px) scale(${view.k})`)
    canvas.style.setProperty('background-size', `${GRID * view.k}px ${GRID * view.k}px`)
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

  function fit(animate) {
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    if (!graph || !w || !h) return
    if (animate) touched = false
    const k = clamp(Math.min((w - PAD * 2) / graph.width, (h - PAD_TOP - PAD) / graph.height), MIN_ZOOM, 1)
    move({ k, x: (w - graph.width * k) / 2, y: PAD_TOP + (h - PAD_TOP - PAD - graph.height * k) / 2 }, animate)
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
    const left = node.x * view.k + view.x
    const top = node.y * view.k + view.y
    if (left >= 8 && top >= 8 && left + NODE_W * view.k <= w - 8 && top + NODE_H * view.k <= h - 8) return
    touched = true
    move({ x: w / 2 - (node.x + NODE_W / 2) * view.k, y: h / 2 - (node.y + NODE_H / 2) * view.k }, true)
  }

  function shown() {
    return inside ? 'ops' : direction
  }

  function onScreen(id, replace) {
    navigate(urlFor({ view: 'overview', project, conversation: id }), { replace })
  }

  function openNode(node) {
    if (node.kind === 'more') onScreen(node.session.id, false)
    else if (node.kind !== 'project') openChat(node.session.id, node.kind === 'agent' ? node.item.id : null)
    else if (node.item.project) openProject(node.item.project)
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
      const sig = [node.kind, tone, text.title, text.sub, text.badge ? text.badge.join(':') : '', text.progress, node.x, node.y].join('|')
      const current = old.get(node.key)
      if (current && current.dataset.sig === sig) return current
      const fresh = nodeEl(node, text, tone)
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
      if (path.getAttribute('class') !== className) {
        path.setAttribute('class', className)
        path.setAttribute('marker-end', liveEdge ? 'url(#flow-arrow-live)' : 'url(#flow-arrow)')
      }
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
    miniNodes.replaceChildren(...graph.nodes.map((node) => svg('rect', { x: node.x, y: node.y, width: NODE_W, height: NODE_H, rx: 12, class: toneOf(node) === 'working' ? 'flow-mini-node is-live' : 'flow-mini-node' })))
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
    const groups = project ? data.groups.filter((group) => group.project === project) : data.groups
    const choices = data.groups.filter((group) => group.project).map((group) => ({ key: group.project, label: group.name }))
    const chosen = project ? choices.find((choice) => choice.key === project) : null
    projectMenu.render(chosen ? chosen.label : project ? project.split('/').pop() : 'All projects', [{ key: 'all', label: 'All projects' }, ...choices], project || 'all')
    summary.textContent = project ? (groups[0] ? groups[0].summaryLabel : 'Nothing running in this project') : data.totals.summaryLabel
    const bare = !groups.length
    const opsRoom = shown() === 'ops'
    empty.hidden = !bare
    controls.hidden = bare || opsRoom
    mini.toggleAttribute('hidden', bare || opsRoom)
    world.hidden = opsRoom
    roomHolder.hidden = !opsRoom || bare
    canvas.classList.toggle('is-ops', opsRoom)
    tools.hidden = !data.groups.length
    if (bare && project) {
      empty.replaceChildren(stateBlock({ title: `Nothing is running in ${project.split('/').pop()}`, text: 'Its conversations show up here again as soon as one is open in Claude Code.', actions: [button('Show all projects', () => navigate(urlFor({ view: 'overview' })))] }))
    } else if (bare) {
      empty.replaceChildren(stateBlock({ title: 'Nothing is running', text: 'Start Claude Code in a terminal, VS Code or the desktop app. It shows up here within a few seconds.', actions: [link(urlFor({ view: 'conversations' }), { class: 'button' }, 'See past conversations')] }))
    }
    lastState = state
    if (opsRoom) {
      if (!room) room = createOps(roomHolder, { onAgent: openRun, onPick: (id) => onScreen(id, true) })
      room.update(groups, inside)
      return
    }
    if (room) room.destroy()
    room = null
    const first = !graph
    graph = direction === 'down' ? waterfallLayout(treeOf(groups)) : sideLayout(treeOf(groups))
    byKey = new Map(graph.nodes.map((node) => [node.key, node]))
    syncNodes()
    syncEdges()
    syncMinimap()
    if (first || !touched) fit(false)
    else apply()
  }

  function onPointerDown(event) {
    if (shown() === 'ops' || event.target.closest('.flow-node, .flow-controls, .flow-tools, .flow-empty')) return
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
    if (shown() === 'ops' || event.target.closest('.flow-empty, .flow-tools')) return
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
    if (!graph) return
    if (touched) apply()
    else fit(false)
  })
  resize.observe(canvas)
  function renderSwitch() {
    keepFocus(switcher, () =>
      switcher.replaceChildren(
        ...LAYOUTS.map((entry) => el('button', { class: 'flow-switch-option', type: 'button', 'aria-pressed': String(entry.key === shown()), 'data-focus': `layout-${entry.key}`, onclick: () => setLayout(entry.key) }, entry.label)),
      ),
    )
  }

  function setLayout(key) {
    if (key === shown()) return
    direction = key
    writeStore(LAYOUT_KEY, key === 'side' ? null : key)
    renderSwitch()
    touched = false
    if (inside) navigate(urlFor({ view: 'overview', project }), { replace: true })
    else if (lastState) render(lastState)
  }

  renderSwitch()
  const unsubscribe = live.subscribe(render)

  return {
    update(next) {
      const value = next.get('project') || null
      const conversation = next.get('conversation') || null
      if (value === project && conversation === inside) return
      if (value !== project) touched = false
      project = value
      inside = conversation
      renderSwitch()
      if (lastState) render(lastState)
    },
    destroy() {
      projectMenu.close()
      unsubscribe()
      resize.disconnect()
      window.clearTimeout(moveTimer)
      if (room) room.destroy()
    },
  }
}
