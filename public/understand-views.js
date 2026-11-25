import { el, icon, readStore, writeStore, reducedMotion, keepFocus } from './ui.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const KMIN = 0.05
const KMAX = 2
const GAP_X = 56
const GAP_Y = 44
const KNOWLEDGE = new Set(['article', 'entity', 'topic', 'claim', 'source'])
const EDGE_STYLES = new Set(['related', 'cites', 'contradicts', 'builds_on', 'exemplifies', 'categorized_under', 'authored_by', 'implements', 'depends_on'])
const QUIET = new Set(['related', 'categorized_under'])
const RISK = { fresh: 0, unknown: 1, dirty: 2, stale: 3 }
const UNKNOWN = {
  'missing-graph-commit': 'does not include a Git commit hash to compare with HEAD',
  'git-head-unavailable': 'could not be compared because the dashboard could not read Git HEAD',
  'graph-commit-unavailable': 'references a commit that is not available in this checkout',
  'git-command-timeout': 'could not be checked because Git freshness commands timed out',
  'freshness-request-failed': 'could not be refreshed because the freshness request failed',
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const fix = (n) => Math.round(n * 10) / 10
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item) : [])
const noDiff = () => ({ on: false, changed: new Set(), affected: new Set() })
const short = (hash) => String(hash).slice(0, 7)
const orderOf = (edge) => (Number.isFinite(edge.order) ? edge.order : Math.round((Number(edge.weight) || 0) * 10))
const countOf = (result) => (Number.isInteger(result.changedFileCount) ? result.changedFileCount : strings(result.changedFiles).length)

function section(title, ...content) {
  return el('section', { class: 'ua-p-section' }, el('h3', { class: 'ua-p-label' }, title), ...content)
}

function stepsOf(edges, flowId, find) {
  return edges
    .filter((e) => e.type === 'flow_step' && e.source === flowId)
    .sort((a, b) => orderOf(a) - orderOf(b))
    .map((e) => find(e.target))
    .filter(Boolean)
}

function curve(pts, cut) {
  const n = pts.length
  const end = pts[n - 1]
  const prev = n > 2 ? mid(pts[n - 2], end) : pts[0]
  const a = Math.atan2(end.y - prev.y, end.x - prev.x)
  let d = `M${fix(pts[0].x)},${fix(pts[0].y)}`
  for (let i = 1; i < n - 1; i++) {
    const m = mid(pts[i], pts[i + 1])
    d += ` Q${fix(pts[i].x)},${fix(pts[i].y)} ${fix(m.x)},${fix(m.y)}`
  }
  return { d: `${d} L${fix(end.x - cut * Math.cos(a))},${fix(end.y - cut * Math.sin(a))}`, end, a }
}

function arrow(pts, cls) {
  const { d, end, a } = curve(pts, 8)
  const bx = end.x - 8 * Math.cos(a)
  const by = end.y - 8 * Math.sin(a)
  const px = -Math.sin(a) * 4.5
  const py = Math.cos(a) * 4.5
  return `<g class="${cls}"><path class="ua-v-line" d="${d}"/><polygon class="ua-v-head" points="${fix(end.x)},${fix(end.y)} ${fix(bx + px)},${fix(by + py)} ${fix(bx - px)},${fix(by - py)}"/></g>`
}

function dagre(holder, nodes, edges, mode) {
  return new Promise((resolve, reject) => {
    if (holder.worker) holder.worker.terminate()
    const worker = (holder.worker = new Worker('/understand-layout.js'))
    const done = (settle, value) => {
      worker.terminate()
      if (holder.worker === worker) holder.worker = null
      settle(value)
    }
    worker.onmessage = (event) => (event.data.error ? done(reject, new Error(event.data.error)) : done(resolve, event.data.result.root))
    worker.onerror = () => done(reject, new Error('The layout worker stopped.'))
    worker.postMessage({ id: 1, job: { mode, root: { nodes, edges }, inner: {} } })
  })
}

function grid(nodes) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)))
  const cw = Math.max(0, ...nodes.map((n) => n.w)) + 40
  const ch = Math.max(0, ...nodes.map((n) => n.h)) + 40
  const pos = {}
  nodes.forEach((n, i) => (pos[n.id] = { x: (i % cols) * cw, y: Math.floor(i / cols) * ch, w: n.w, h: n.h }))
  return { pos, edges: {}, w: cols * cw, h: Math.ceil(nodes.length / cols) * ch }
}

function createCanvas(host, on) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'ua-edges')
  svg.setAttribute('aria-hidden', 'true')
  const labels = el('div', { class: 'ua-v-labels' })
  const world = el('div', { class: 'ua-world' }, svg, labels, el('div', { class: 'ua-cards' }))
  const crumb = el('nav', { class: 'ua-crumb ua-ui', 'aria-label': 'Where you are', hidden: true })
  const warn = el('p', { class: 'ua-v-warn ua-ui', role: 'status', hidden: true })
  const readout = el('span', { class: 'ua-zoom-pct' }, '100%')
  const zoomButton = (label, key, name, run) => el('button', { class: 'ua-zoom-btn', type: 'button', 'aria-label': label, title: `${label} (${key})`, onclick: run }, icon(name))
  const busy = el('div', { class: 'ua-busy', role: 'status', hidden: true })
  const empty = el('p', { class: 'ua-empty', hidden: true })
  const canvas = el(
    'div',
    { class: 'ua-canvas' },
    world,
    crumb,
    warn,
    el('div', { class: 'ua-zoom ua-ui', role: 'group', 'aria-label': 'Zoom' }, zoomButton('Zoom out', '-', 'minus', () => zoomBy(0.8)), readout, zoomButton('Zoom in', '+', 'plus', () => zoomBy(1.25)), zoomButton('Fit to screen', '0', 'fit', () => fit(240))),
    busy,
    empty,
  )
  host.replaceChildren(canvas)
  let view = { x: 0, y: 0, k: 1 }
  let size = { w: 0, h: 0 }
  let rects = new Map()
  let anim = 0
  let fitted = true
  let drag = null
  let swallow = false

  function apply() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`
    let cell = 20 * view.k
    while (cell < 10) cell *= 2
    canvas.style.backgroundSize = `${cell}px ${cell}px`
    canvas.style.backgroundPosition = `${view.x}px ${view.y}px`
    readout.textContent = `${Math.round(view.k * 100)}%`
  }

  function go(to, ms) {
    const id = ++anim
    if (ms <= 0 || reducedMotion()) {
      view = to
      return apply()
    }
    const from = view
    const start = performance.now()
    const step = (now) => {
      if (id !== anim) return
      const t = Math.min(1, (now - start) / ms)
      const e = 1 - (1 - t) ** 3
      view = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, k: from.k + (to.k - from.k) * e }
      apply()
      if (t < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  function viewFor(b, pad, maxK) {
    const cw = canvas.clientWidth
    const ch = canvas.clientHeight
    const k = clamp(Math.min(cw / (Math.max(b.w, 1) * (1 + pad)), ch / (Math.max(b.h, 1) * (1 + pad))), KMIN, maxK)
    return { k, x: cw / 2 - (b.x + b.w / 2) * k, y: ch / 2 - (b.y + b.h / 2) * k }
  }

  function fit(ms = 400) {
    fitted = true
    if (size.w && canvas.clientWidth) go(viewFor({ x: 0, y: 0, ...size }, 0.15, 1), ms)
  }

  function frame(ids) {
    const list = [...ids].map((id) => rects.get(id)).filter(Boolean)
    if (!list.length || !canvas.clientWidth) return
    const x = Math.min(...list.map((r) => r.x))
    const y = Math.min(...list.map((r) => r.y))
    fitted = false
    go(viewFor({ x, y, w: Math.max(...list.map((r) => r.x + r.w)) - x, h: Math.max(...list.map((r) => r.y + r.h)) - y }, 0.3, 1.2), 500)
  }

  function reveal(id) {
    const r = rects.get(id)
    if (!r || !canvas.clientWidth) return
    const x0 = r.x * view.k + view.x
    const y0 = r.y * view.k + view.y
    if (x0 >= 0 && y0 >= 0 && x0 + r.w * view.k <= canvas.clientWidth && y0 + r.h * view.k <= canvas.clientHeight) return
    fitted = false
    go({ k: view.k, x: canvas.clientWidth / 2 - (r.x + r.w / 2) * view.k, y: canvas.clientHeight / 2 - (r.y + r.h / 2) * view.k }, 400)
  }

  function moveTo(next) {
    anim++
    fitted = false
    view = next
    apply()
  }

  function zoomAt(k, px, py) {
    const next = clamp(k, KMIN, KMAX)
    const r = next / view.k
    moveTo({ k: next, x: px - (px - view.x) * r, y: py - (py - view.y) * r })
  }

  function zoomBy(f) {
    zoomAt(view.k * f, canvas.clientWidth / 2, canvas.clientHeight / 2)
  }

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      const r = canvas.getBoundingClientRect()
      if (event.ctrlKey || event.metaKey) return zoomAt(view.k * 2 ** clamp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.01), -0.5, 0.5), event.clientX - r.left, event.clientY - r.top)
      const m = event.deltaMode === 1 ? 16 : 1
      moveTo({ ...view, x: view.x - event.deltaX * m, y: view.y - event.deltaY * m })
    },
    { passive: false },
  )
  canvas.addEventListener('pointerdown', (event) => {
    swallow = false
    if (event.button === 0 && !event.target.closest('.ua-ui')) drag = { id: event.pointerId, x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false }
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
    if (drag.moved) moveTo({ ...view, x: drag.vx + dx, y: drag.vy + dy })
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
    if (swallow) return (swallow = false)
    if (event.target.closest('.ua-ui')) return
    const card = event.target.closest('[data-id]')
    if (card) on.pick(card.dataset.id, card)
    else on.blank()
  })
  canvas.addEventListener('dblclick', (event) => {
    const card = event.target.closest('[data-id]')
    if (card && on.open) on.open(card.dataset.id, card)
  })
  world.addEventListener('keydown', (event) => {
    const card = event.target.closest('[data-id]')
    if (!card || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    ;(on.key || on.pick)(card.dataset.id, card)
  })
  const resize = new ResizeObserver(() => fitted && fit(0))
  resize.observe(canvas)
  apply()

  return {
    world,
    labels,
    crumb,
    warn,
    busy,
    empty,
    show(layer, nextRects, nextSize, markup) {
      layer.classList.remove('is-pending')
      world.replaceChildren(svg, labels, layer)
      svg.setAttribute('width', String(Math.ceil(nextSize.w)))
      svg.setAttribute('height', String(Math.ceil(nextSize.h)))
      svg.innerHTML = markup
      rects = nextRects
      size = nextSize
      fit(0)
      return [...svg.children]
    },
    fit,
    frame,
    reveal,
    zoomBy,
    destroy() {
      anim++
      resize.disconnect()
    },
  }
}

function domainView(api, ctx) {
  function card(node, kind, ...content) {
    return el('div', { class: `ua-card ua-v-card ua-v-${kind}`, tabindex: '0', role: 'button', 'data-id': node.id, 'data-kind': kind, 'aria-label': `${node.name}, ${kind}`, style: { '--ua-c': api.util.typeColor(node.type) } }, ...content)
  }

  function domainCard(node, flows) {
    const entities = strings(node.domainMeta && node.domainMeta.entities)
    return card(
      node,
      'domain',
      el('div', { class: 'ua-v-name' }, node.name),
      node.summary ? el('p', { class: 'ua-v-summary' }, node.summary) : null,
      entities.length
        ? el('div', { class: 'ua-v-entities' }, el('span', { class: 'ua-p-label' }, 'Entities'), el('div', { class: 'chips' }, entities.slice(0, 5).map((name) => el('span', { class: 'chip' }, name)), entities.length > 5 ? el('span', { class: 'ua-v-more' }, `+${entities.length - 5} more`) : null))
        : null,
      el('div', { class: 'ua-card-foot' }, el('span', null, plural(flows, 'flow')), el('span', { class: 'ua-explore' }, 'Double-click to open →')),
    )
  }

  function flowCard(node, steps) {
    const entry = node.domainMeta && node.domainMeta.entryPoint
    return card(node, 'flow', entry ? el('span', { class: 'ua-v-entry' }, entry) : null, el('div', { class: 'ua-v-name' }, node.name), node.summary ? el('p', { class: 'ua-v-summary' }, node.summary) : null, el('div', { class: 'ua-card-foot' }, el('span', null, plural(steps, 'step'))))
  }

  function stepCard(node, n) {
    return card(node, 'step', el('div', { class: 'ua-v-step-top' }, el('span', { class: 'ua-v-order' }, String(n)), el('span', { class: 'ua-v-name' }, node.name)), node.summary ? el('p', { class: 'ua-v-summary' }, node.summary) : null, node.filePath ? el('p', { class: 'ua-v-file' }, node.filePath) : null)
  }

  return {
    id: 'domain',
    mount(host) {
      const holder = { worker: null }
      let graph = null
      let domainId = null
      let token = 0
      let gone = false
      let lastSel = null
      let layer = null
      const c = createCanvas(host, {
        pick: (id) => api.actions.selectNode(id),
        open: (id, node) => node.dataset.kind === 'domain' && api.actions.navigateToDomain(id),
        key: (id, node) => (node.dataset.kind === 'domain' && api.store.get().selected === id ? api.actions.navigateToDomain(id) : api.actions.selectNode(id)),
        blank: () => api.actions.selectNode(null),
      })
      ctx.canvas = c

      function detail(dg, byId, active, next, rects) {
        const node = byId.get(active)
        c.crumb.replaceChildren(
          el('button', { class: 'ua-crumb-link', type: 'button', onclick: () => api.actions.clearActiveDomain() }, 'Domains'),
          el('span', { class: 'ua-crumb-sep', 'aria-hidden': 'true' }, '›'),
          el('span', { class: 'ua-crumb-here' }, node ? node.name : active),
          el('span', { class: 'ua-crumb-hint' }, '(Esc to go back)'),
        )
        const flows = dg.edges.filter((e) => e.type === 'contains_flow' && e.source === active).map((e) => byId.get(e.target)).filter(Boolean)
        const rows = flows.map((flow) => {
          const steps = stepsOf(dg.edges, flow.id, (id) => byId.get(id))
          return [flowCard(flow, steps.length), ...steps.map((step, i) => stepCard(step, i + 1))]
        })
        for (const row of rows) next.append(...row)
        let markup = ''
        let size = { w: 0, h: 0 }
        let y = 0
        for (const row of rows) {
          const h = Math.max(...row.map((item) => item.offsetHeight))
          let x = 0
          for (const item of row) {
            const r = { x, y: y + (h - item.offsetHeight) / 2, w: item.offsetWidth, h: item.offsetHeight }
            item.style.left = `${r.x}px`
            item.style.top = `${r.y}px`
            if (!rects.has(item.dataset.id)) rects.set(item.dataset.id, r)
            if (x) markup += arrow([{ x: x - GAP_X, y: y + h / 2 }, { x, y: y + h / 2 }], 'ua-v-seq')
            x += r.w + GAP_X
          }
          size = { w: Math.max(size.w, x - GAP_X), h: y + h }
          y += h + GAP_Y
        }
        c.empty.textContent = 'This domain has no flows yet.'
        c.empty.hidden = rows.length > 0
        return { markup, size }
      }

      async function overview(dg, next, rects, mine) {
        c.crumb.replaceChildren(el('span', { class: 'ua-crumb-here is-caps' }, 'Domains'))
        const domains = dg.nodes.filter((n) => n.type === 'domain')
        const ids = new Set(domains.map((n) => n.id))
        const made = new Map(domains.map((n) => [n.id, domainCard(n, dg.edges.filter((e) => e.type === 'contains_flow' && e.source === n.id).length)]))
        const cross = dg.edges.filter((e) => e.type === 'cross_domain' && e.source !== e.target && ids.has(e.source) && ids.has(e.target))
        const tags = cross.map((e) => (e.description ? el('div', { class: 'ua-v-elabel' }, e.description) : null))
        next.append(...made.values(), ...tags.filter(Boolean))
        const nodes = domains.map((n) => ({ id: n.id, w: made.get(n.id).offsetWidth, h: made.get(n.id).offsetHeight }))
        const edges = cross.map((e, i) => ({ id: `x${i}`, from: e.source, to: e.target, label: tags[i] ? { w: tags[i].offsetWidth, h: tags[i].offsetHeight } : null }))
        let r
        try {
          r = await dagre(holder, nodes, edges, 'horizontal')
        } catch {
          r = grid(nodes)
        }
        if (mine !== token || gone) return null
        for (const n of nodes) {
          const p = r.pos[n.id]
          made.get(n.id).style.left = `${p.x}px`
          made.get(n.id).style.top = `${p.y}px`
          rects.set(n.id, p)
        }
        let markup = ''
        edges.forEach((e, i) => {
          const routed = r.edges[e.id]
          const pts = routed ? routed.pts : [center(rects.get(e.from)), center(rects.get(e.to))]
          markup += arrow(pts, 'ua-v-cross')
          if (!tags[i]) return
          const lp = (routed && routed.lp) || mid(pts[0], pts[pts.length - 1])
          tags[i].style.left = `${lp.x - e.label.w / 2}px`
          tags[i].style.top = `${lp.y - e.label.h / 2}px`
        })
        c.empty.textContent = 'This domain graph has no domains.'
        c.empty.hidden = domains.length > 0
        return { markup, size: { w: r.w, h: r.h } }
      }

      async function rebuild(dg, active) {
        const mine = ++token
        const byId = new Map(dg.nodes.map((n) => [n.id, n]))
        const next = el('div', { class: 'ua-cards is-pending' })
        c.world.append(next)
        const rects = new Map()
        const out = active ? detail(dg, byId, active, next, rects) : await overview(dg, next, rects, mine)
        if (!out || mine !== token || gone) return next.remove()
        c.show(next, rects, out.size, out.markup)
        layer = next
        lastSel = null
        paint(api.store.get())
      }

      function paint(state) {
        if (!layer) return
        for (const item of layer.querySelectorAll('[data-id]')) item.classList.toggle('is-selected', item.dataset.id === state.selected)
        if (state.selected && state.selected !== lastSel) c.reveal(state.selected)
        lastSel = state.selected
      }

      return {
        update(state) {
          const dg = api.data.domain()
          if (!dg) {
            graph = null
            c.crumb.hidden = true
            c.empty.textContent = 'No domain graph available. Run /understand-domain to generate one.'
            c.empty.hidden = false
            return
          }
          if (state.domainId && !dg.nodes.some((n) => n.id === state.domainId && n.type === 'domain')) return api.actions.clearActiveDomain()
          c.crumb.hidden = false
          if (dg !== graph || state.domainId !== domainId) {
            graph = dg
            domainId = state.domainId
            rebuild(dg, domainId)
          }
          paint(state)
        },
        destroy() {
          gone = true
          token++
          if (holder.worker) holder.worker.terminate()
          c.destroy()
          if (ctx.canvas === c) ctx.canvas = null
        },
      }
    },
  }
}

function knowledgeView(api, ctx) {
  function nodeCard(node, scale) {
    return el(
      'div',
      { class: 'ua-card ua-node ua-v-knode', tabindex: '0', role: 'button', 'data-id': node.id, 'aria-label': `${node.name}, ${node.type}`, style: { '--ua-c': api.util.typeColor(node.type), '--ua-v-s': scale.toFixed(2) } },
      el('div', { class: 'ua-card-top' }, el('span', { class: 'ua-kicker' }, node.type), node.complexity ? el('span', { class: `ua-cx ua-cx-${node.complexity}` }, node.complexity) : null),
      el('div', { class: 'ua-node-name' }, node.name),
    )
  }

  return {
    id: 'knowledge',
    mount(host) {
      const holder = { worker: null }
      let last = null
      let token = 0
      let gone = false
      let cards = new Map()
      let edges = []
      let lastSel = null
      let lastTour = ''
      let labelled = { active: undefined, edges: null }
      const c = createCanvas(host, {
        pick: (id) => api.actions.selectNode(id),
        blank: () => api.actions.selectNode(null),
      })
      ctx.canvas = c

      async function rebuild(state) {
        const mine = ++token
        const nodes = state.graph.nodes.filter((n) => api.util.nodePasses(n, state))
        const ids = new Set(nodes.map((n) => n.id))
        const list = state.graph.edges.filter((e) => e.source !== e.target && ids.has(e.source) && ids.has(e.target) && api.util.edgePasses(e, state))
        const degree = new Map()
        for (const e of list) for (const id of [e.source, e.target]) degree.set(id, (degree.get(id) || 0) + 1)
        const made = new Map(nodes.map((n) => [n.id, nodeCard(n, clamp(0.85 + (degree.get(n.id) || 0) * 0.03, 0.85, 1.5))]))
        const next = el('div', { class: 'ua-cards is-pending' }, [...made.values()])
        c.world.append(next)
        const sized = nodes.map((n) => ({ id: n.id, w: made.get(n.id).offsetWidth, h: made.get(n.id).offsetHeight }))
        c.busy.textContent = 'Computing graph layout'
        c.busy.hidden = false
        let r
        let fallback = false
        try {
          r = await dagre(
            holder,
            sized,
            list.map((e, i) => ({ id: `k${i}`, from: e.source, to: e.target, label: null })),
            'vertical',
          )
        } catch {
          r = grid(sized)
          fallback = true
        }
        if (mine !== token || gone) return next.remove()
        c.busy.hidden = true
        c.warn.textContent = 'Layout unavailable; showing a fallback grid.'
        c.warn.hidden = !fallback
        const rects = new Map()
        for (const n of sized) {
          const p = r.pos[n.id]
          made.get(n.id).style.left = `${p.x}px`
          made.get(n.id).style.top = `${p.y}px`
          rects.set(n.id, p)
        }
        const drawn = list.map((e, i) => ({ source: e.source, target: e.target, type: e.type, pts: r.edges[`k${i}`] ? r.edges[`k${i}`].pts : [center(rects.get(e.source)), center(rects.get(e.target))] }))
        const markup = drawn.map((e) => `<path class="ua-v-e ua-v-e-${EDGE_STYLES.has(e.type) ? e.type : 'related'}" d="${curve(e.pts, 0).d}"/>`).join('')
        const els = c.show(next, rects, { w: r.w, h: r.h }, markup)
        edges = drawn.map((e, i) => ({ ...e, el: els[i] }))
        cards = made
        lastSel = null
        lastTour = ''
        c.empty.textContent = state.graph.nodes.length ? 'No nodes match the current filters.' : 'No knowledge graph available. Run /understand-knowledge to generate one.'
        c.empty.hidden = nodes.length > 0
        paint(api.store.get())
      }

      function paint(state) {
        const active = state.focus || state.selected
        const near = new Set(active ? [active] : [])
        for (const e of edges) {
          if (e.source === active) near.add(e.target)
          if (e.target === active) near.add(e.source)
        }
        const tour = new Set(state.tour.active ? api.util.tourIds(state) : [])
        const path = new Set(state.path || [])
        const hits = new Map(String(state.query).trim() ? state.results.map((hit) => [hit.nodeId, hit.score]) : [])
        for (const [id, node] of cards) {
          node.classList.toggle('is-selected', id === state.selected)
          node.classList.toggle('is-near', Boolean(active) && id !== active && near.has(id))
          node.classList.toggle('is-faded', Boolean(active) && !near.has(id))
          node.classList.toggle('is-mark-tour', tour.has(id))
          node.classList.toggle('is-mark-path', path.has(id))
          node.classList.toggle('is-mark-focus', id === state.focus)
          const score = hits.get(id)
          if (typeof score === 'number') node.dataset.hit = score <= 0.1 ? 'strong' : score <= 0.3 ? 'mid' : 'weak'
          else delete node.dataset.hit
        }
        for (const e of edges) {
          const hot = Boolean(active) && (e.source === active || e.target === active)
          e.el.classList.toggle('is-hot', hot)
          e.el.classList.toggle('is-dim', Boolean(active) && !hot)
        }
        if (labelled.active !== active || labelled.edges !== edges) {
          labelled = { active, edges }
          c.labels.replaceChildren(
            ...edges
              .filter((e) => active && (e.source === active || e.target === active) && !QUIET.has(e.type))
              .map((e) => {
                const p = e.pts.length > 2 ? e.pts[Math.floor(e.pts.length / 2)] : mid(e.pts[0], e.pts[e.pts.length - 1])
                return el('span', { class: 'ua-v-klabel', style: { left: `${p.x}px`, top: `${p.y}px` } }, String(e.type).replace(/_/g, ' '))
              }),
          )
        }
        if (state.selected && state.selected !== lastSel) c.reveal(state.selected)
        lastSel = state.selected
        const tourKey = state.tour.active ? `${state.tour.step}|${state.version}` : ''
        if (tourKey && tourKey !== lastTour) c.frame(tour)
        lastTour = tourKey
      }

      return {
        update(state) {
          if (!state.graph) return
          if (!last || state.version !== last.version || state.persona !== last.persona || state.categories !== last.categories || state.filters !== last.filters) {
            last = state
            rebuild(state)
          }
          paint(state)
        },
        destroy() {
          gone = true
          token++
          if (holder.worker) holder.worker.terminate()
          c.destroy()
          if (ctx.canvas === c) ctx.canvas = null
        },
      }
    },
  }
}

function bannerOf(report, kind) {
  if (!report || !report.graphs) return null
  const entries = [
    { name: 'knowledge', result: report.graphs.knowledge },
    { name: 'domain', result: report.graphs.domain },
  ].filter((entry) => entry.result && Object.hasOwn(RISK, entry.result.status))
  const top = Math.max(0, ...entries.map((entry) => RISK[entry.result.status]))
  if (!top) return null
  const hit = entries.filter((entry) => RISK[entry.result.status] === top)
  const subject = hit.length === 2 ? 'Knowledge and domain graphs' : hit[0].name === 'knowledge' ? 'Knowledge graph' : 'Domain graph'
  const has = (name) => hit.some((entry) => entry.name === name)
  const main = kind === 'knowledge' ? '/understand-knowledge' : '/understand'
  const commands = has('knowledge') && has('domain') ? `${main} and /understand-domain` : has('domain') ? '/understand-domain' : main
  const action = `Run ${commands} to refresh ${hit.length === 1 ? 'it' : 'them'} before relying on impact or onboarding answers.`
  const files = [...new Set(hit.flatMap((entry) => strings(entry.result.changedFiles)))].sort()
  const since = (n) => `${plural(n, 'file')} ${n === 1 ? 'has' : 'have'} changed since analysis.`
  if (top === RISK.stale) {
    const line = ({ name, result: r }) =>
      r.relation === 'behind'
        ? `The ${name} graph is ${plural(r.commitsBehind, 'project commit')} behind HEAD; ${since(countOf(r))}`
        : r.relation === 'ahead'
          ? `The ${name} graph comes from a newer project history than HEAD; ${since(countOf(r))}`
          : `The ${name} graph and HEAD come from different project histories; ${since(countOf(r))}`
    return { title: `${subject} may be stale`, summary: hit.map(line).join(' '), action, files }
  }
  if (top === RISK.dirty) {
    const line = ({ name, result: r }) => {
      const n = countOf(r)
      return `${plural(n, 'working-tree file')} ${n === 1 ? 'has' : 'have'} changed and ${n === 1 ? 'is' : 'are'} not represented by the ${name} graph's commit metadata.`
    }
    return { title: `${subject} ${hit.length === 1 ? 'has' : 'have'} working-tree changes`, summary: hit.map(line).join(' '), action, files }
  }
  const failed = hit.some((entry) => entry.result.reason === 'freshness-request-failed')
  const line = ({ name, result: r }) => (r.reason === 'freshness-request-failed' ? 'The dashboard could not refresh graph freshness data.' : `The ${name} graph ${UNKNOWN[r.reason] || 'could not be checked'}.`)
  return { title: `${subject} freshness could not be verified`, summary: [...new Set(hit.map(line))].join(' '), action: failed ? 'Refocus the window to retry the freshness check.' : action, files: [] }
}

function headerStatus(api) {
  const clearedKey = `claude-dashboard-understand-diff-cleared:${api.key}`
  const modes = [
    ['domain', 'Domain'],
    ['structural', 'Structural'],
  ].map(([mode, label]) => el('button', { class: 'flow-switch-option', type: 'button', 'data-mode': mode, onclick: () => api.store.get().viewMode !== mode && api.actions.setViewMode(mode) }, label))
  const toggle = el('div', { class: 'flow-switch ua-v-toggle', role: 'group', 'aria-label': 'View' }, modes)
  let filesOpen = false
  let shownBanner = null

  function syncToggle(s) {
    const show = Boolean(s.graph) && s.kind !== 'knowledge' && Boolean(api.data.domain())
    if (!show && s.viewMode === 'domain') return api.actions.setViewMode('structural')
    if (!show) return api.slots.viewToggle.replaceChildren()
    const current = s.viewMode === 'domain' ? 'domain' : 'structural'
    for (const button of modes) button.setAttribute('aria-pressed', String(button.dataset.mode === current))
    if (!toggle.isConnected) api.slots.viewToggle.replaceChildren(toggle)
  }

  function syncDiff(s) {
    const body = s.files['diff-overlay.json']
    const o = body && body.data
    const usable = Boolean(o) && Array.isArray(o.changedNodeIds) && Array.isArray(o.affectedNodeIds) && o.changedNodeIds.length > 0
    const stamp = usable ? String(o.generatedAt || body.updatedMs) : ''
    const head = s.freshness && s.freshness.headCommit
    const why =
      s.kind !== 'code' || !usable
        ? 'No diff data loaded'
        : readStore(clearedKey) === stamp
          ? 'Diff cleared. A new /understand-diff run brings it back.'
          : o.headCommit && !s.freshness
            ? 'Checking the diff against HEAD'
            : o.headCommit && head && o.headCommit !== head
              ? `This diff was made at commit ${short(o.headCommit)}, but HEAD is now ${short(head)}. Run /understand-diff again.`
              : null
    if (why && s.diff.changed.size) return api.store.set({ diff: noDiff() })
    if (!why && !s.diff.changed.size) return api.actions.setDiff(o.changedNodeIds, o.affectedNodeIds)
    const on = s.diff.on && !why
    api.root.classList.toggle('ua-v-diff-on', on)
    if (s.kind !== 'code') return api.slots.diff.replaceChildren()
    keepFocus(api.slots.diff, () =>
      api.slots.diff.replaceChildren(
        ...[
          el('button', { class: on ? 'button small ua-v-diff is-on' : 'button small ua-v-diff', type: 'button', 'data-focus': 'diff', 'aria-pressed': String(on), disabled: Boolean(why), title: why || (on ? 'Hide diff overlay (D)' : 'Show diff overlay (D)'), onclick: api.actions.toggleDiff }, on ? 'Diff ON' : 'Diff OFF'),
          on ? el('span', { class: 'ua-v-legend' }, `Changed (${s.diff.changed.size})`) : null,
          on ? el('span', { class: 'ua-v-legend is-affected' }, `Affected (${s.diff.affected.size})`) : null,
          why
            ? null
            : el(
              'button',
              {
                class: 'icon-button ua-v-diff-clear',
                type: 'button',
                'aria-label': 'Clear diff',
                title: 'Clear this diff',
                onclick: () => {
                  writeStore(clearedKey, stamp)
                  api.store.set({ diff: noDiff() })
                },
              },
              icon('close'),
            ),
        ].filter(Boolean),
      ),
    )
  }

  function syncBanner(s, force) {
    const b = s.kind === 'design' ? null : bannerOf(s.freshness, s.kind)
    const sig = b ? JSON.stringify([b, filesOpen]) : ''
    if (!force && sig === shownBanner) return
    shownBanner = sig
    if (!b) return api.slots.banners.replaceChildren()
    const toggleFiles = () => {
      filesOpen = !filesOpen
      syncBanner(api.store.get(), true)
    }
    keepFocus(api.slots.banners, () =>
      api.slots.banners.replaceChildren(
        el(
          'div',
          { class: 'ua-v-stale', role: 'status' },
          el(
            'div',
            { class: 'ua-v-stale-row' },
            el('span', { class: 'ua-v-stale-icon', 'aria-hidden': 'true' }, '⚠'),
            el('div', { class: 'ua-v-stale-text' }, el('p', { class: 'ua-v-stale-title' }, b.title), el('p', null, b.summary), el('p', { class: 'ua-v-stale-action' }, b.action)),
            b.files.length ? el('button', { class: 'text-button ua-v-stale-toggle', type: 'button', 'data-focus': 'stale-files', 'aria-expanded': String(filesOpen), onclick: toggleFiles }, filesOpen ? 'Hide files' : `Show files (${b.files.length})`) : null,
          ),
          filesOpen && b.files.length ? el('div', { class: 'ua-v-stale-files scroll-area' }, b.files.map((file) => el('code', null, file))) : null,
        ),
      ),
    )
  }

  return function sync(s, p) {
    if (!p || s.files !== p.files || s.freshness !== p.freshness || s.diff !== p.diff || s.kind !== p.kind) syncDiff(s)
    if (!p || s.graph !== p.graph || s.kind !== p.kind || s.viewMode !== p.viewMode || s.files !== p.files) syncToggle(s)
    if (!p || s.freshness !== p.freshness || s.kind !== p.kind) syncBanner(s)
  }
}

function nodePanels(api) {
  const broken = new Set()
  const nameOf = (id) => (api.data.node(id) || { name: id }).name
  const jump = (id, run = () => api.actions.navigateToNode(id), prefix = '→') =>
    el('button', { class: 'ua-p-link', type: 'button', onclick: run }, el('span', { class: 'ua-p-arrow', 'aria-hidden': 'true' }, prefix), el('span', null, nameOf(id)))

  api.panels.node({
    id: 'figma-thumbnail',
    order: 40,
    when: (node) => Boolean(node.figmaMeta && node.figmaMeta.thumbnailUrl) && !broken.has(node.id),
    render(node) {
      const size = node.figmaMeta.dimensions || {}
      const img = el('img', { class: 'ua-v-thumb', src: api.data.thumbUrl(node.id), alt: `${node.name} thumbnail`, loading: 'lazy', decoding: 'async', width: Number.isFinite(size.width) ? Math.round(size.width) : null, height: Number.isFinite(size.height) ? Math.round(size.height) : null })
      img.addEventListener('error', () => {
        broken.add(node.id)
        img.remove()
      })
      return img
    },
  })

  api.panels.node({
    id: 'knowledge-links',
    order: 90,
    when: (node) => KNOWLEDGE.has(node.type),
    render(node) {
      const edges = api.data.edgesOf(node.id)
      const meta = node.knowledgeMeta || {}
      const category = edges.find((e) => e.type === 'categorized_under' && e.source === node.id)
      const links = edges.filter((e) => e.type === 'related' && e.source === node.id).map((e) => e.target)
      const backlinks = edges.filter((e) => e.type === 'related' && e.target === node.id).map((e) => e.source)
      return [
        category ? section('Category', jump(category.target)) : null,
        strings(meta.wikilinks).length ? section(`Wikilinks (${links.length})`, links.map((id) => jump(id))) : null,
        backlinks.length ? section(`Backlinks (${backlinks.length})`, backlinks.map((id) => jump(id, undefined, '←'))) : null,
        typeof meta.content === 'string' && meta.content.trim() ? section('Preview', el('div', { class: 'ua-v-preview scroll-area' }, meta.content)) : null,
      ]
    },
  })

  api.panels.node({
    id: 'domain-details',
    order: 100,
    when: (node) => node.type === 'domain' || node.type === 'flow' || node.type === 'step',
    render(node) {
      const meta = node.domainMeta || {}
      const edges = api.data.edgesOf(node.id)
      const bullets = (items) => el('ul', { class: 'ua-v-rules' }, items.map((item) => el('li', null, item)))
      if (node.type === 'domain') {
        const entities = strings(meta.entities)
        const rules = strings(meta.businessRules)
        const cross = strings(meta.crossDomainInteractions)
        const flows = edges.filter((e) => e.type === 'contains_flow' && e.source === node.id).map((e) => e.target)
        const open = (flow) => () => {
          api.actions.navigateToDomain(node.id)
          api.actions.selectNode(flow)
        }
        return [
          entities.length ? section('Entities', el('div', { class: 'chips' }, entities.map((name) => el('span', { class: 'chip' }, name)))) : null,
          rules.length ? section('Business Rules', bullets(rules)) : null,
          cross.length ? section('Cross-Domain', bullets(cross)) : null,
          flows.length ? section(`Flows (${flows.length})`, flows.map((flow) => jump(flow, open(flow)))) : null,
        ]
      }
      if (node.type === 'flow') {
        const steps = stepsOf(edges, node.id, (id) => api.data.node(id))
        return [
          meta.entryPoint ? section('Entry Point', el('p', { class: 'ua-p-path' }, meta.entryPoint, meta.entryType ? el('span', { class: 'ua-p-lines' }, ` (${meta.entryType})`) : null)) : null,
          steps.length ? section(`Steps (${steps.length})`, steps.map((step, i) => jump(step.id, () => api.actions.selectNode(step.id), `${i + 1}.`))) : null,
        ]
      }
      const range = Array.isArray(node.lineRange) && node.lineRange.length === 2 ? `:${node.lineRange[0]}-${node.lineRange[1]}` : ''
      return node.filePath ? section('Implementation', el('p', { class: 'ua-p-path' }, `${node.filePath}${range}`)) : null
    },
  })
}

export function register(api) {
  const ctx = { canvas: null }
  const offs = []
  api.views.register(domainView(api, ctx))
  api.views.register(knowledgeView(api, ctx))
  nodePanels(api)
  const zoom = (run) => () => (ctx.canvas ? run(ctx.canvas) : false)
  offs.push(
    api.keys.register({ key: '+', shift: 'any', hidden: true, description: 'Zoom in', group: 'View', handler: zoom((c) => c.zoomBy(1.25)) }),
    api.keys.register({ key: '=', hidden: true, description: 'Zoom in', group: 'View', handler: zoom((c) => c.zoomBy(1.25)) }),
    api.keys.register({ key: '-', hidden: true, description: 'Zoom out', group: 'View', handler: zoom((c) => c.zoomBy(0.8)) }),
    api.keys.register({ key: '0', hidden: true, description: 'Fit to screen', group: 'View', handler: zoom((c) => c.fit(240)) }),
    api.keys.escape(65, (s) => (s.viewMode === 'domain' && s.domainId ? (api.actions.clearActiveDomain(), true) : false)),
  )
  const sync = headerStatus(api)
  offs.push(api.store.subscribe(sync))
  sync(api.store.get(), null)
  return () => {
    for (const off of offs) off()
    api.root.classList.remove('ua-v-diff-on')
  }
}
