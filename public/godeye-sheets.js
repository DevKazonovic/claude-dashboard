import { icon, link, urlFor, navigate, setTitle } from './ui.js'

const SIZE = {
  feature: [280, 100],
  person: [196, 60],
  app: [214, 74],
  service: [214, 74],
  part: [204, 68],
  store: [176, 84],
  outside: [200, 68],
  step: [210, 72],
  start: [186, 52],
  end: [196, 54],
  stop: [204, 56],
  decision: [224, 112],
  question: [220, 78],
  slice: [212, 84],
  port: [206, 50],
}
const SIDE_NORMAL = { r: [1, 0], l: [-1, 0], t: [0, -1], b: [0, 1] }
const PORT_ANCHOR = { top: ['b', 't'], bottom: ['t', 'b'], left: ['r', 'l'], right: ['l', 'r'] }
const PORT_GAP = 84
const POLL_MS = 2500
const STATUS = { built: 'Built', building: 'Building', next: 'Next' }
const ICON_PERSON = '<svg class="gs-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.2-4 4.3-6 8-6s6.8 2 8 6"/></svg>'
const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7"/></svg>'
const SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'
const FIT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>'

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

function bezierAt(p, t) {
  const u = 1 - t
  return {
    x: u * u * u * p[0].x + 3 * u * u * t * p[1].x + 3 * u * t * t * p[2].x + t * t * t * p[3].x,
    y: u * u * u * p[0].y + 3 * u * u * t * p[1].y + 3 * u * t * t * p[2].y + t * t * t * p[3].y,
  }
}

function polyLength(pts) {
  let total = 0
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return total
}

function polyAt(pts, t) {
  const total = polyLength(pts)
  let want = total * t
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (want <= len || i === pts.length - 1) {
      const k = len ? Math.min(1, want / len) : 0
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, dx: b.x - a.x, dy: b.y - a.y }
    }
    want -= len
  }
  return { x: pts[0].x, y: pts[0].y, dx: 1, dy: 0 }
}

function overlap(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

function inside(pt, r) {
  return pt.x > r.x && pt.x < r.x + r.w && pt.y > r.y && pt.y < r.y + r.h
}

function sheetSort(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? -1
    const y = pb[i] ?? -1
    if (x !== y) return x - y
  }
  return 0
}

export function drawSheets(container, initial, sheetParam) {
  let data = initial
  let sheets = new Map()
  let order = []
  let index = []
  let cur = null
  let model = null
  let selected = null
  let view = { x: 0, y: 0, k: 1 }
  let busy = false
  let userMoved = false
  let gone = false
  let polling = null
  let reduce = window.matchMedia('(prefers-reduced-motion: reduce)')
  const project = initial.project
  const mapId = initial.id

  container.replaceChildren()
  const root = document.createElement('div')
  root.className = 'gs'
  root.innerHTML = `
    <header class="gs-top">
      <span class="gs-back-slot"></span>
      <div class="gs-feat"><h1 class="gs-feat-name"></h1><p class="gs-feat-note"></p></div>
      <div class="gs-grow"></div>
      <button class="gs-sheets-btn" type="button" aria-expanded="false">Sheets</button>
      <div class="gs-search">${SEARCH}<input type="search" class="gs-q" placeholder="Find a box" autocomplete="off" aria-label="Find a box on any sheet"><kbd aria-hidden="true">/</kbd><div class="gs-results" hidden></div></div>
    </header>
    <div class="gs-main">
      <nav class="gs-tree" aria-label="Sheets"></nav>
      <div class="gs-scrim"></div>
      <section class="gs-stage" aria-label="Sheet">
        <div class="gs-head"><nav class="gs-crumbs" aria-label="Where you are"></nav><ol class="gs-steps" aria-label="Levels"></ol></div>
        <div class="gs-canvas">
          <div class="gs-world"></div>
          <div class="gs-empty" hidden>This sheet has no boxes yet.</div>
          <div class="gs-controls">
            <div class="gs-zoom"><button type="button" data-z="out" aria-label="Zoom out">&minus;</button><button type="button" data-z="fit" aria-label="Fit the sheet">${FIT}</button><button type="button" data-z="in" aria-label="Zoom in">+</button></div>
            <div class="gs-hint">Click a box for details · <b>+</b> opens it · <kbd>Esc</kbd> goes back · scroll to zoom, drag to move</div>
          </div>
          <div class="gs-tblock"></div>
        </div>
        <aside class="gs-panel" aria-hidden="true" aria-label="Details">
          <div class="gs-p-head"><span class="gs-p-kind"></span><button class="gs-p-x" type="button" aria-label="Close details">&times;</button></div>
          <div class="gs-p-body"></div>
        </aside>
      </section>
    </div>`
  container.append(root)
  const q = (sel) => root.querySelector(sel)
  q('.gs-back-slot').replaceWith(link(urlFor({ view: 'godeye', project }), { class: 'gs-back', 'aria-label': `Back to ${project}`, title: `Back to ${project}` }, icon('back')))
  const canvas = q('.gs-canvas')
  const world = q('.gs-world')
  const panel = q('.gs-panel')
  const pBody = q('.gs-p-body')
  const tree = q('.gs-tree')
  const scrim = q('.gs-scrim')
  const sheetsBtn = q('.gs-sheets-btn')
  const input = q('.gs-q')
  const results = q('.gs-results')

  function levelName(level) {
    return (data.schema.levels[level] && data.schema.levels[level].name) || level
  }

  function kindName(kind) {
    if (kind === 'port') return 'Connection'
    return (data.schema.kinds[kind] && data.schema.kinds[kind].name) || kind
  }

  function load(next) {
    data = next
    sheets = new Map(next.design.sheets.map((s) => [s.id, s]))
    order = [...sheets.keys()].sort(sheetSort)
    index = []
    for (const id of order) {
      for (const b of sheets.get(id).boxes) index.push({ sid: id, bid: b.id, name: b.name, hay: `${b.name} ${b.note || ''} ${b.does || ''}`.toLowerCase() })
    }
    const d = next.design
    q('.gs-feat-name').textContent = d.feature
    q('.gs-feat-note').textContent = [d.product, d.summary].filter(Boolean).join(' · ')
    setTitle(d.feature)
  }

  function chain(id) {
    const out = []
    let s = sheets.get(id)
    while (s) {
      out.unshift(s)
      s = s.parent ? sheets.get(s.parent) : null
    }
    return out
  }

  function questionsOf(s) {
    return s.boxes.reduce((n, b) => n + (b.questions ? b.questions.length : 0), 0)
  }

  function portsFor(s) {
    if (s.level !== 'parts' || !s.parent || !s.from) return []
    const parent = sheets.get(s.parent)
    if (!parent) return []
    const boxes = new Map(parent.boxes.map((b) => [b.id, b]))
    const owner = boxes.get(s.from)
    const found = new Map()
    for (const line of s.lines) {
      for (const [end, dir] of [
        [line.from, 'in'],
        [line.to, 'out'],
      ]) {
        if (typeof end !== 'string' || !end.startsWith('^')) continue
        const ref = end.slice(1)
        const key = `${ref}|${dir}`
        const other = boxes.get(ref)
        if (found.has(key) || !other || !owner) continue
        const labels = parent.lines
          .filter((pl) => {
            const into = pl.from === ref && pl.to === s.from
            const outof = pl.from === s.from && pl.to === ref
            return dir === 'in' ? into || (pl.both && outof) : outof || (pl.both && into)
          })
          .map((pl) => pl.label)
          .filter(Boolean)
        const dc = other.at[0] - owner.at[0]
        const dr = other.at[1] - owner.at[1]
        const side = Math.abs(dr) > Math.abs(dc) ? (dr > 0 ? 'bottom' : 'top') : dc > 0 ? 'right' : 'left'
        found.set(key, { id: `^${ref}>${dir}`, kind: 'port', name: other.name, note: labels.join(', '), dir, side, ref, refSheet: parent.id })
      }
    }
    return [...found.values()]
  }

  function endId(end, role) {
    return typeof end === 'string' && end.startsWith('^') ? `${end}>${role === 'from' ? 'in' : 'out'}` : end
  }

  function anchor(n, side, off = 0) {
    const hw = n.w / 2
    const hh = n.h / 2
    if (side === 'r') return { x: n.x + hw, y: n.y + off }
    if (side === 'l') return { x: n.x - hw, y: n.y + off }
    if (side === 't') return { x: n.x + off, y: n.y - hh }
    return { x: n.x + off, y: n.y + hh }
  }

  function bezierFor(a, b, fs, ts, fo = 0, to = 0) {
    const p = anchor(a, fs, fo)
    const r = anchor(b, ts, to)
    const dist = Math.hypot(r.x - p.x, r.y - p.y)
    const len = Math.max(26, Math.min(150, dist * 0.42))
    const [nx, ny] = SIDE_NORMAL[fs]
    const [mx, my] = SIDE_NORMAL[ts]
    return [p, { x: p.x + nx * len, y: p.y + ny * len }, { x: r.x + mx * len, y: r.y + my * len }, r]
  }

  function polyFor(a, b, route, fo = 0, to = 0) {
    const p = anchor(a, route.fs, fo)
    const r = anchor(b, route.ts, to)
    if (route.shape === 'hvh') return [p, { x: route.gx, y: p.y }, { x: route.gx, y: r.y }, r]
    if (route.shape === 'vhv') return [p, { x: p.x, y: route.gy }, { x: r.x, y: route.gy }, r]
    return [p, { x: route.gx, y: p.y }, { x: route.gx, y: route.gy }, { x: r.x, y: route.gy }, r]
  }

  function samples(route, pts) {
    const out = []
    if (route.shape === 'bez') {
      for (let i = 1; i < 30; i++) out.push(bezierAt(pts, i / 30))
      return out
    }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]
      const b = pts[i]
      const n = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 12))
      for (let j = 0; j < n; j++) out.push({ x: a.x + ((b.x - a.x) * j) / n, y: a.y + ((b.y - a.y) * j) / n })
    }
    return out.slice(1)
  }

  function score(route, pts, a, b, rects) {
    let hits = 0
    for (const pt of samples(route, pts)) {
      for (const [id, r] of rects) if (id !== a.id && id !== b.id && inside(pt, r)) hits += 1
    }
    const p = pts[0]
    const r = pts[pts.length - 1]
    const [nx, ny] = SIDE_NORMAL[route.fs]
    const [mx, my] = SIDE_NORMAL[route.ts]
    let penalty = 0
    if ((r.x - p.x) * nx + (r.y - p.y) * ny < -4) penalty += 700
    if ((p.x - r.x) * mx + (p.y - r.y) * my < -4) penalty += 700
    const length = route.shape === 'bez' ? Math.hypot(r.x - p.x, r.y - p.y) * 1.15 : polyLength(pts) + (route.shape === 'hvhv' ? 140 : 70)
    return hits * 6000 + penalty + length
  }

  function layout(s) {
    const ports = portsFor(s)
    const nodes = [...s.boxes.map((b) => ({ ...b, box: b })), ...ports]
    const byId = new Map(nodes.map((n) => [n.id, n]))
    let num = 0
    for (const n of nodes) {
      const size = SIZE[n.kind] || SIZE.part
      n.w = size[0]
      n.h = size[1]
      if (s.level === 'flow' && n.kind === 'step') n.num = ++num
    }
    const edges = []
    for (const line of s.lines) {
      const a = byId.get(endId(line.from, 'from'))
      const b = byId.get(endId(line.to, 'to'))
      if (a && b && a !== b) edges.push({ line, a, b })
    }
    return { s, nodes, byId, edges, ports }
  }

  function measure(m) {
    for (const n of m.nodes) {
      const txt = n.el.querySelector('.gs-txt')
      if (n.kind === 'decision') n.h = Math.max(n.h, Math.ceil(txt.offsetHeight * 2 + 18))
      else if (n.kind === 'store') n.h = Math.max(n.h, Math.ceil(txt.offsetHeight + 36))
      else n.h = Math.max(n.h, n.el.offsetHeight)
      n.el.style.height = `${n.h}px`
    }
    for (const e of m.edges) {
      e.lw = e.lb ? e.lb.offsetWidth : 0
      e.lh = e.lb ? e.lb.offsetHeight : 0
    }
  }

  function place(m) {
    const boxes = m.nodes.filter((n) => n.kind !== 'port')
    const cols = Math.max(0, ...boxes.map((b) => b.at[0])) + 1
    const rows = Math.max(0, ...boxes.map((b) => b.at[1])) + 1
    const colW = Array(cols).fill(0)
    const rowH = Array(rows).fill(0)
    for (const b of boxes) {
      colW[b.at[0]] = Math.max(colW[b.at[0]], b.w)
      rowH[b.at[1]] = Math.max(rowH[b.at[1]], b.h)
    }
    for (let c = 0; c < cols; c++) if (!colW[c]) colW[c] = 90
    for (let r = 0; r < rows; r++) if (!rowH[r]) rowH[r] = 50
    const gapX = Array(Math.max(0, cols - 1)).fill(84)
    const gapY = Array(Math.max(0, rows - 1)).fill(72)
    for (const e of m.edges) {
      if (e.a.kind === 'port' || e.b.kind === 'port' || !e.lw) continue
      const dc = Math.abs(e.a.at[0] - e.b.at[0])
      const dr = Math.abs(e.a.at[1] - e.b.at[1])
      if (dc && dc >= dr) {
        const c0 = Math.min(e.a.at[0], e.b.at[0])
        const need = (e.lw + 44) / dc
        for (let i = c0; i < c0 + dc; i++) gapX[i] = Math.max(gapX[i], need)
      } else if (dr) {
        const r0 = Math.min(e.a.at[1], e.b.at[1])
        const need = (e.lh + 40) / dr
        for (let i = r0; i < r0 + dr; i++) gapY[i] = Math.max(gapY[i], need)
      }
    }
    const colX = []
    let x = 0
    for (let c = 0; c < cols; c++) {
      colX[c] = x + colW[c] / 2
      x += colW[c] + (gapX[c] || 0)
    }
    const rowY = []
    let y = 0
    for (let r = 0; r < rows; r++) {
      rowY[r] = y + rowH[r] / 2
      y += rowH[r] + (gapY[r] || 0)
    }
    const width = x
    const height = y
    for (const b of boxes) {
      b.x = colX[b.at[0]]
      b.y = rowY[b.at[1]]
    }
    m.gxs = [-PORT_GAP / 2]
    for (let c = 0; c < cols - 1; c++) m.gxs.push(colX[c] + colW[c] / 2 + gapX[c] / 2)
    m.gxs.push(width + PORT_GAP / 2)
    m.gys = [-PORT_GAP / 2]
    for (let r = 0; r < rows - 1; r++) m.gys.push(rowY[r] + rowH[r] / 2 + gapY[r] / 2)
    m.gys.push(height + PORT_GAP / 2)

    const sides = { top: [], bottom: [], left: [], right: [] }
    for (const p of m.ports) {
      const inner = m.edges.filter((e) => e.a === p || e.b === p).map((e) => (e.a === p ? e.b : e.a))
      const along = p.side === 'top' || p.side === 'bottom' ? 'x' : 'y'
      p.want = inner.length ? inner.reduce((sum, n) => sum + n[along], 0) / inner.length : along === 'x' ? width / 2 : height / 2
      sides[p.side].push(p)
    }
    for (const [side, list] of Object.entries(sides)) {
      const along = side === 'top' || side === 'bottom' ? 'x' : 'y'
      list.sort((a, b) => a.want - b.want || (a.dir === 'in' ? -1 : 1))
      const gap = along === 'x' ? 24 : 18
      let last = -Infinity
      for (const p of list) {
        const size = along === 'x' ? p.w : p.h
        let pos = p.want
        if (pos - size / 2 < last + gap) pos = last + gap + size / 2
        p[along] = pos
        last = pos + size / 2
      }
      for (const p of list) {
        if (side === 'top') p.y = -PORT_GAP - p.h / 2
        if (side === 'bottom') p.y = height - (gapY.length ? 0 : 0) + PORT_GAP + p.h / 2 - (rows ? 0 : 0)
        if (side === 'left') p.x = -PORT_GAP - p.w / 2
        if (side === 'right') p.x = width - (gapX.length ? 0 : 0) + PORT_GAP + p.w / 2
      }
    }
    for (const p of sides.bottom) p.y = rowY[rows - 1] + rowH[rows - 1] / 2 + PORT_GAP + p.h / 2
    for (const p of sides.right) p.x = colX[cols - 1] + colW[cols - 1] / 2 + PORT_GAP + p.w / 2
  }

  function route(m) {
    const rects = m.nodes.map((n) => [n.id, { x: n.x - n.w / 2 - 6, y: n.y - n.h / 2 - 6, w: n.w + 12, h: n.h + 12 }])
    for (const e of m.edges) {
      const { a, b } = e
      let best = null
      const consider = (r) => {
        const pts = r.shape === 'bez' ? bezierFor(a, b, r.fs, r.ts) : polyFor(a, b, r)
        const value = score(r, pts, a, b, rects)
        if (!best || value < best.value) best = { ...r, value }
      }
      if (a.kind === 'port' || b.kind === 'port') {
        const port = a.kind === 'port' ? a : b
        const [ps, bs] = PORT_ANCHOR[port.side]
        consider(a === port ? { shape: 'bez', fs: ps, ts: bs } : { shape: 'bez', fs: bs, ts: ps })
      } else {
        const dc = b.at[0] - a.at[0]
        const dr = b.at[1] - a.at[1]
        const horizontal = dc !== 0 && Math.abs(dc) >= Math.abs(dr)
        const base = horizontal ? (dc > 0 ? ['r', 'l'] : ['l', 'r']) : dr > 0 ? ['b', 't'] : ['t', 'b']
        consider({ shape: 'bez', fs: base[0], ts: base[1] })
        if (best.value >= 6000) {
          for (const fs of ['r', 'l', 't', 'b']) for (const ts of ['r', 'l', 't', 'b']) consider({ shape: 'bez', fs, ts })
        }
        if (best.value >= 6000) {
          for (const gx of m.gxs) consider({ shape: 'hvh', gx, fs: gx > a.x ? 'r' : 'l', ts: gx > b.x ? 'r' : 'l' })
          for (const gy of m.gys) consider({ shape: 'vhv', gy, fs: gy > a.y ? 'b' : 't', ts: gy > b.y ? 'b' : 't' })
          for (const gx of m.gxs) for (const gy of m.gys) consider({ shape: 'hvhv', gx, gy, fs: gx > a.x ? 'r' : 'l', ts: gy > b.y ? 'b' : 't' })
        }
      }
      e.route = best
    }

    const groups = new Map()
    const add = (node, side, e, end) => {
      const key = `${node.id}|${side}`
      if (!groups.has(key)) groups.set(key, { node, side, items: [] })
      groups.get(key).items.push({ e, end })
    }
    for (const e of m.edges) {
      add(e.a, e.route.fs, e, 'from')
      add(e.b, e.route.ts, e, 'to')
    }
    for (const { node, side, items } of groups.values()) {
      const axis = side === 'l' || side === 'r' ? 'y' : 'x'
      items.sort((p, r) => {
        const po = p.end === 'from' ? p.e.b : p.e.a
        const ro = r.end === 'from' ? r.e.b : r.e.a
        return po[axis] - ro[axis] || m.edges.indexOf(p.e) - m.edges.indexOf(r.e)
      })
      const length = axis === 'y' ? node.h : node.w
      const spread = node.kind === 'decision' ? 0 : Math.min(length * 0.6, (items.length - 1) * 24)
      items.forEach((item, i) => {
        const off = items.length > 1 ? -spread / 2 + (spread * i) / (items.length - 1) : 0
        if (item.end === 'from') item.e.fo = off
        else item.e.to = off
      })
    }
    for (const e of m.edges) {
      e.pts = e.route.shape === 'bez' ? bezierFor(e.a, e.b, e.route.fs, e.route.ts, e.fo || 0, e.to || 0) : polyFor(e.a, e.b, e.route, e.fo || 0, e.to || 0)
    }
  }

  function pointOn(e, t) {
    if (e.route.shape === 'bez') {
      const pt = bezierAt(e.pts, t)
      const n = bezierAt(e.pts, Math.min(1, t + 0.02))
      return { x: pt.x, y: pt.y, dx: n.x - pt.x, dy: n.y - pt.y }
    }
    return polyAt(e.pts, t)
  }

  function labelRect(pt, anchorName, w, h) {
    if (anchorName === 'above') return { x: pt.x - w / 2, y: pt.y - h - 6, w, h }
    if (anchorName === 'below') return { x: pt.x - w / 2, y: pt.y + 6, w, h }
    if (anchorName === 'left') return { x: pt.x - w - 8, y: pt.y - h / 2, w, h }
    if (anchorName === 'right') return { x: pt.x + 8, y: pt.y - h / 2, w, h }
    return { x: pt.x - w / 2, y: pt.y - h / 2, w, h }
  }

  function placeLabels(m) {
    const boxes = m.nodes.map((n) => ({ x: n.x - n.w / 2 - 3, y: n.y - n.h / 2 - 3, w: n.w + 6, h: n.h + 6 }))
    const placed = []
    for (const e of m.edges) {
      if (!e.lb) continue
      const yesNo = e.line.kind === 'yes' || e.line.kind === 'no'
      const ts = yesNo ? [0.32, 0.45, 0.22, 0.6] : [0.5, 0.4, 0.6, 0.3, 0.7, 0.22, 0.78]
      const off = e.fo || 0
      let best = null
      for (const t of ts) {
        const pt = pointOn(e, t)
        const orient = Math.abs(pt.dx) >= Math.abs(pt.dy) * 1.6 ? 'h' : Math.abs(pt.dy) >= Math.abs(pt.dx) * 1.6 ? 'v' : 'x'
        const anchors = yesNo || orient === 'x' ? ['center', 'above', 'right'] : orient === 'h' ? (off > 0 ? ['below', 'above'] : ['above', 'below']) : off < 0 ? ['left', 'right'] : ['right', 'left']
        anchors.forEach((name, i) => {
          const rect = labelRect(pt, name, e.lw, e.lh)
          let cost = 0
          for (const r of boxes) cost += overlap(rect, r) * 10
          for (const r of placed) cost += overlap(rect, r) * 10
          cost += Math.abs(t - ts[0]) * 40 + i * 6
          if (!best || cost < best.cost) best = { cost, rect, name, pt }
        })
        if (best && best.cost < 8) break
      }
      placed.push(best.rect)
      e.lb.className = `gs-elabel k-${e.line.kind} a-${best.name}`
      e.lb.style.left = `${best.pt.x}px`
      e.lb.style.top = `${best.pt.y}px`
      e.lrect = best.rect
    }
  }

  function pathOf(e) {
    const p = e.pts
    if (e.route.shape === 'bez') return `M${p[0].x},${p[0].y} C${p[1].x},${p[1].y} ${p[2].x},${p[2].y} ${p[3].x},${p[3].y}`
    let d = `M${p[0].x},${p[0].y}`
    for (let i = 1; i < p.length - 1; i++) {
      const prev = p[i - 1]
      const pt = p[i]
      const next = p[i + 1]
      const l1 = Math.hypot(pt.x - prev.x, pt.y - prev.y)
      const l2 = Math.hypot(next.x - pt.x, next.y - pt.y)
      const r = Math.min(14, l1 / 2, l2 / 2)
      if (!l1 || !l2) continue
      const a1 = { x: pt.x + ((prev.x - pt.x) / l1) * r, y: pt.y + ((prev.y - pt.y) / l1) * r }
      const a2 = { x: pt.x + ((next.x - pt.x) / l2) * r, y: pt.y + ((next.y - pt.y) / l2) * r }
      d += ` L${a1.x},${a1.y} Q${pt.x},${pt.y} ${a2.x},${a2.y}`
    }
    const last = p[p.length - 1]
    return `${d} L${last.x},${last.y}`
  }

  function nodeHtml(n, s) {
    let html = ''
    if (n.kind === 'decision') html += '<svg class="gs-shape" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon points="50,1 99,50 50,99 1,50"/></svg>'
    if (n.kind === 'store') html += '<svg class="gs-shape" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M1,14 C1,-3 99,-3 99,14 L99,86 C99,103 1,103 1,86 Z"/><path class="gs-lid" d="M1,14 C1,31 99,31 99,14 C99,-3 1,-3 1,14 Z"/></svg>'
    if (n.kind === 'person') html += ICON_PERSON
    if (n.num) html += `<span class="gs-num" aria-hidden="true">${n.num}</span>`
    const title = n.kind === 'port' ? `<span class="gs-dir">${n.dir === 'in' ? '← from' : 'to →'}</span>${esc(n.name)}` : esc(n.name)
    html += `<div class="gs-txt"><div class="gs-t">${title}</div>${n.note ? `<div class="gs-s">${esc(n.note)}</div>` : ''}</div>`
    if (n.opens && sheets.has(n.opens)) html += `<button class="gs-plus" type="button" data-open="${esc(n.opens)}" aria-label="Open the diagram inside ${esc(n.name)}" title="Open inside">+</button>`
    const qn = n.questions ? n.questions.length : 0
    if (qn) html += `<span class="gs-qd" title="${qn} open question${qn > 1 ? 's' : ''}">?${qn > 1 ? qn : ''}</span>`
    if (n.kind === 'slice' && n.status) html += `<span class="gs-st st-${esc(n.status)}">${esc(STATUS[n.status] || n.status)}</span>`
    return html
  }

  function render(id) {
    const s = sheets.get(id)
    cur = id
    selected = null
    world.replaceChildren()
    const m = layout(s)
    model = m
    const svgNS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(svgNS, 'svg')
    svg.setAttribute('class', 'gs-edges')
    svg.setAttribute('width', '10')
    svg.setAttribute('height', '10')
    svg.innerHTML = `<defs>${['plain', 'accent', 'muted', 'hot']
      .map((k) => `<marker id="gs-a-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path class="gs-m-${k}" d="M0,0.8 L10,5 L0,9.2 Z"/></marker>`)
      .join('')}</defs>`
    world.append(svg)
    for (const n of m.nodes) {
      const el = document.createElement('div')
      el.className = `gs-node k-${n.kind}${n.kind === 'port' ? ` dir-${n.dir}` : ''}`
      el.dataset.id = n.id
      el.tabIndex = 0
      el.setAttribute('role', 'button')
      el.setAttribute('aria-label', n.kind === 'port' ? `${n.dir === 'in' ? 'Comes from' : 'Goes to'} ${n.name}${n.note ? `: ${n.note}` : ''}. Press Enter to go there.` : `${n.name}. ${kindName(n.kind)}. Press Enter for details.`)
      el.innerHTML = nodeHtml(n, s)
      el.style.width = `${n.w}px`
      el.style.minHeight = `${n.h}px`
      world.append(el)
      n.el = el
    }
    for (const e of m.edges) {
      const line = e.line
      if (line.label || line.order) {
        const lb = document.createElement('div')
        lb.className = `gs-elabel k-${line.kind}`
        lb.innerHTML = (line.order ? `<span class="gs-en">${line.order}</span>` : '') + esc(line.label || '')
        world.append(lb)
        e.lb = lb
      } else e.lb = null
    }
    measure(m)
    if (m.nodes.length) {
      place(m)
      route(m)
      placeLabels(m)
    }
    for (const n of m.nodes) {
      n.el.style.left = `${n.x - n.w / 2}px`
      n.el.style.top = `${n.y - n.h / 2}px`
    }
    for (const e of m.edges) {
      const kind = e.line.kind
      const marker = kind === 'main' || kind === 'loop' ? 'accent' : kind === 'copies' || kind === 'blocked' || kind === 'no' ? 'muted' : 'plain'
      const path = document.createElementNS(svgNS, 'path')
      path.setAttribute('class', `gs-e k-${kind}`)
      path.setAttribute('d', pathOf(e))
      path.setAttribute('marker-end', `url(#gs-a-${marker})`)
      if (e.line.both) path.setAttribute('marker-start', `url(#gs-a-${marker})`)
      path.dataset.m = marker
      svg.append(path)
      e.path = path
    }
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    const grow = (x, y) => {
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
    for (const n of m.nodes) {
      grow(n.x - n.w / 2, n.y - n.h / 2)
      grow(n.x + n.w / 2, n.y + n.h / 2)
    }
    for (const e of m.edges) {
      for (const p of e.pts) grow(p.x, p.y)
      if (e.lrect) {
        grow(e.lrect.x, e.lrect.y)
        grow(e.lrect.x + e.lrect.w, e.lrect.y + e.lrect.h)
      }
    }
    m.bbox = Number.isFinite(x0) ? { x0: x0 - 16, y0: y0 - 18, x1: x1 + 16, y1: y1 + 24 } : { x0: 0, y0: 0, x1: 400, y1: 300 }
    q('.gs-empty').hidden = m.nodes.length > 0
    chrome()
  }

  function chrome() {
    const s = sheets.get(cur)
    const crumbs = chain(cur)
    q('.gs-crumbs').innerHTML = crumbs
      .map((c, i) => {
        const inner = `<span class="gs-n">${esc(c.id)}</span>${esc(c.title)}`
        const piece = i === crumbs.length - 1 ? `<span class="gs-cur" aria-current="page">${inner}</span>` : `<button type="button" data-go="${esc(c.id)}">${inner}</button>`
        return piece + (i < crumbs.length - 1 ? '<span class="gs-sep" aria-hidden="true">›</span>' : '')
      })
      .join('')
    q('.gs-steps').innerHTML = data.schema.order
      .map((level, i) => {
        const ids = order.filter((id) => sheets.get(id).level === level)
        const draft = ids.some((id) => sheets.get(id).status === 'draft')
        const here = s.level === level
        const arrow = i ? '<li class="gs-arrow" aria-hidden="true">→</li>' : ''
        if (!ids.length) return `${arrow}<li><button type="button" disabled title="No ${esc(levelName(level))} sheet yet"><span class="gs-dot is-none"></span>${esc(levelName(level))}</button></li>`
        return `${arrow}<li class="${here ? 'is-cur' : ''}"><button type="button" data-go="${esc(ids[0])}"${here ? ' aria-current="step"' : ''}><span class="gs-dot${draft ? ' is-draft' : ''}"></span>${esc(levelName(level))}</button></li>`
      })
      .join('')
    const parentOf = (id) => (id.includes('.') ? id.slice(0, id.lastIndexOf('.')) : null)
    const row = (id) => {
      const t = sheets.get(id)
      const qn = questionsOf(t)
      const kids = order.filter((k) => parentOf(k) === id)
      const here = id === cur
      const mark = qn ? `<span class="gs-qn" aria-hidden="true">?${qn}</span><span class="visually-hidden">, ${qn} open question${qn > 1 ? 's' : ''}</span>` : ''
      return `<li><a class="gs-ti${here ? ' is-cur' : ''}" href="${esc(sheetUrl(id))}" data-go="${esc(id)}" title="Sheet ${esc(id)}"${here ? ' aria-current="page"' : ''}><span class="gs-ti-t">${esc(t.title)}</span>${mark}</a>${kids.length ? `<ul class="gs-tl gs-sub">${kids.map(row).join('')}</ul>` : ''}</li>`
    }
    const focused = tree.contains(document.activeElement) ? document.activeElement.dataset.go : null
    tree.innerHTML = order
      .filter((id) => !sheets.has(parentOf(id)))
      .map((id) => `<div class="gs-tg"><h2 class="gs-tg-h">${esc(levelName(sheets.get(id).level))}</h2><ul class="gs-tl">${row(id)}</ul></div>`)
      .join('')
    if (focused) tree.querySelector(`[data-go="${CSS.escape(focused)}"]`)?.focus()
    const qn = questionsOf(s)
    const count = s.boxes.length
    const meta = `${count} ${count === 1 ? 'box' : 'boxes'}${qn ? ` · ${qn} open question${qn > 1 ? 's' : ''}` : ''}`
    q('.gs-tblock').innerHTML =
      `<div class="gs-tb-grid"><div class="gs-tb-cell"><span class="gs-tb-k">Sheet</span><span class="gs-tb-v">${esc(s.id)}</span></div><div class="gs-tb-cell"><span class="gs-tb-k">Level</span><span class="gs-tb-v">${esc(levelName(s.level))}</span></div></div><div class="gs-tb-title">${esc(s.title)}</div><div class="gs-tb-meta">${esc(s.note ? `${s.note} · ${meta}` : meta)}</div>` +
      (s.status === 'draft' ? '<div class="gs-tb-stamp is-draft">Draft · waiting for your OK<small>Tell Claude ok, or what to change.</small></div>' : `<div class="gs-tb-stamp">${CHECK}Approved</div>`)
  }

  function stageSize() {
    return { w: canvas.clientWidth, h: canvas.clientHeight }
  }

  function fitView(scale = 1) {
    const { w, h } = stageSize()
    const narrow = w < 640
    const pad = 24
    const padB = narrow ? 128 : 150
    const b = model.bbox
    const bw = b.x1 - b.x0
    const bh = b.y1 - b.y0
    let k = Math.min((w - pad * 2) / bw, (h - pad - padB) / bh)
    k = Math.max(0.05, Math.min(k, 1.15)) * scale
    return { x: pad + (w - pad * 2 - bw * k) / 2 - b.x0 * k, y: pad + (h - pad - padB - bh * k) / 2 - b.y0 * k, k }
  }

  function boxView(n) {
    const { w, h } = stageSize()
    const k = Math.min(3.2, Math.min(w / (n.w * 1.4), h / (n.h * 1.6)))
    return { x: w / 2 - n.x * k, y: h / 2 - n.y * k, k }
  }

  function apply() {
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`
    const g = 24 * view.k
    canvas.style.backgroundSize = `${g}px ${g}px`
    canvas.style.backgroundPosition = `${view.x}px ${view.y}px`
  }

  function animate(to, ms, o0 = 1, o1 = 1) {
    return new Promise((resolve) => {
      if (reduce.matches || ms <= 0) {
        view = { ...to }
        apply()
        world.style.opacity = String(o1)
        resolve()
        return
      }
      const from = { ...view }
      const t0 = performance.now()
      const step = (now) => {
        if (gone) return resolve()
        const t = Math.min(1, (now - t0) / ms)
        const k = ease(t)
        view = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, k: from.k + (to.k - from.k) * k }
        apply()
        world.style.opacity = String(o0 + (o1 - o0) * k)
        if (t < 1) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })
  }

  function isAncestor(a, b) {
    let s = sheets.get(b)
    while (s && s.parent) {
      if (s.parent === a) return true
      s = sheets.get(s.parent)
    }
    return false
  }

  function sheetUrl(id) {
    return urlFor({ view: 'godeye', project, map: mapId, sheet: id === '1' ? null : id })
  }

  function syncUrl() {
    const href = sheetUrl(cur)
    if (`${window.location.pathname}${window.location.search}` !== href) navigate(href)
  }

  async function go(id, opts = {}) {
    if (!sheets.has(id) || busy || gone) return
    closePanel()
    closeTree()
    if (id === cur) {
      if (opts.select) select(opts.select, true)
      return
    }
    busy = true
    const prev = cur
    const goingIn = prev && sheets.get(id).parent === prev && sheets.get(id).from
    const goingOut = prev && isAncestor(id, prev)
    if (goingIn) {
      const n = model.byId.get(sheets.get(id).from)
      await animate(n ? boxView(n) : view, 420, 1, 0.05)
      render(id)
      view = fitView(0.78)
      apply()
      world.style.opacity = '0'
      await animate(fitView(), 420, 0, 1)
    } else if (goingOut) {
      const c = stageSize()
      await animate({ x: c.w / 2 - (c.w / 2 - view.x) * 0.6, y: c.h / 2 - (c.h / 2 - view.y) * 0.6, k: view.k * 0.6 }, 320, 1, 0)
      let child = sheets.get(prev)
      while (child && child.parent !== id) child = sheets.get(child.parent)
      render(id)
      const n = child && child.from ? model.byId.get(child.from) : null
      view = n ? boxView(n) : fitView(1.2)
      apply()
      world.style.opacity = '0.05'
      await animate(fitView(), 460, 0.05, 1)
    } else {
      await animate(view, 150, 1, 0)
      render(id)
      view = fitView(0.96)
      apply()
      world.style.opacity = '0'
      await animate(fitView(), 260, 0, 1)
    }
    userMoved = false
    busy = false
    if (!opts.fromUrl) syncUrl()
    if (opts.select) select(opts.select, true)
  }

  function select(id, pulse = false) {
    const n = model.byId.get(id)
    if (!n) return
    if (n.kind === 'port') {
      go(n.refSheet, { select: n.ref })
      return
    }
    selected = id
    const near = new Set([id])
    for (const e of model.edges) {
      if (e.a.id === id) near.add(e.b.id)
      if (e.b.id === id) near.add(e.a.id)
    }
    for (const x of model.nodes) {
      x.el.classList.toggle('is-sel', x.id === id)
      x.el.classList.toggle('is-dim', !near.has(x.id))
    }
    for (const e of model.edges) {
      const hot = e.a.id === id || e.b.id === id
      e.path.classList.toggle('is-hot', hot)
      e.path.classList.toggle('is-dim', !hot)
      const marker = hot && e.path.dataset.m !== 'accent' ? 'hot' : e.path.dataset.m
      e.path.setAttribute('marker-end', `url(#gs-a-${marker})`)
      if (e.line.both) e.path.setAttribute('marker-start', `url(#gs-a-${marker})`)
      if (e.lb) e.lb.classList.toggle('is-dim', !hot)
    }
    if (pulse) {
      n.el.classList.remove('is-pulse')
      void n.el.offsetWidth
      n.el.classList.add('is-pulse')
    }
    openPanel(n)
  }

  function clearSelection() {
    if (!model) return
    selected = null
    for (const x of model.nodes) x.el.classList.remove('is-sel', 'is-dim')
    for (const e of model.edges) {
      e.path.classList.remove('is-hot', 'is-dim')
      e.path.setAttribute('marker-end', `url(#gs-a-${e.path.dataset.m})`)
      if (e.line.both) e.path.setAttribute('marker-start', `url(#gs-a-${e.path.dataset.m})`)
      if (e.lb) e.lb.classList.remove('is-dim')
    }
  }

  function chip([sid, bid]) {
    const t = sheets.get(sid)
    const b = t && t.boxes.find((x) => x.id === bid)
    if (!b) return ''
    const name = b.kind === 'start' ? t.title : b.name
    return `<button type="button" class="gs-chip" data-go="${esc(sid)}" data-sel="${esc(bid)}"><span class="gs-n">${esc(sid)}</span>${esc(name)}</button>`
  }

  const list = (items) => `<ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`

  function openPanel(n) {
    const s = sheets.get(cur)
    q('.gs-p-kind').textContent = `${kindName(n.kind)} · Sheet ${s.id}`
    let html = `<div><h2 class="gs-p-title">${esc(n.name)}</h2>${n.note ? `<p class="gs-p-sub">${esc(n.note)}</p>` : ''}</div>`
    if (n.does) html += `<section class="gs-p-sec"><h3>What it does</h3><p>${esc(n.does)}</p></section>`
    if (n.gets || n.gives) {
      html += '<div class="gs-p-io">'
      html += `<section class="gs-p-sec"><h3>Gets</h3>${n.gets ? list(n.gets) : '<p class="gs-p-sub">Nothing from outside</p>'}</section>`
      html += `<section class="gs-p-sec"><h3>Gives</h3>${n.gives ? list(n.gives) : '<p class="gs-p-sub">Nothing to others</p>'}</section>`
      html += '</div>'
    }
    if (n.rules) html += `<section class="gs-p-sec"><h3>Rules</h3>${list(n.rules)}</section>`
    if (n.done) html += `<section class="gs-p-sec gs-p-done"><h3>Done when</h3><p>${esc(n.done)}</p></section>`
    if (n.out) html += `<section class="gs-p-sec"><h3>Not in this feature</h3>${list(n.out)}</section>`
    if (n.questions) html += `<section class="gs-p-sec gs-p-q"><h3>Open questions</h3>${list(n.questions)}</section>`
    if (n.from && Array.isArray(n.from)) html += `<section class="gs-p-sec"><h3>Built from</h3><div class="gs-chips">${n.from.map(chip).join('')}</div></section>`
    if (n.check) html += `<section class="gs-p-sec"><h3>Check against the sheets</h3><p>${esc(n.check)}</p></section>`
    if (n.see) html += `<section class="gs-p-sec"><h3>${s.level === 'flow' ? 'Done by' : 'See also'}</h3><div class="gs-chips">${n.see.map(chip).join('')}</div></section>`
    const acts = []
    if (n.opens && sheets.has(n.opens)) acts.push(`<button type="button" class="gs-btn is-primary" data-go="${esc(n.opens)}">Open inside <span aria-hidden="true">+</span></button>`)
    if (n.kind === 'feature') {
      if (sheets.has('3')) acts.push('<button type="button" class="gs-btn" data-go="3">Open the system</button>')
      if (sheets.has('4')) acts.push('<button type="button" class="gs-btn" data-go="4">Open the build</button>')
    }
    if (acts.length) html += `<div class="gs-p-actions">${acts.join('')}</div>`
    pBody.innerHTML = html
    pBody.scrollTop = 0
    panel.classList.add('is-open')
    panel.setAttribute('aria-hidden', 'false')
  }

  function closePanel() {
    if (!panel.classList.contains('is-open')) return false
    panel.classList.remove('is-open')
    panel.setAttribute('aria-hidden', 'true')
    clearSelection()
    return true
  }

  function zoomAt(f, px, py) {
    const fit = fitView()
    const k = Math.max(fit.k * 0.5, Math.min(Math.max(fit.k * 4, 2.2), view.k * f))
    const r = k / view.k
    view = { x: px - (px - view.x) * r, y: py - (py - view.y) * r, k }
    apply()
    userMoved = true
  }

  function closeTree() {
    if (!tree.classList.contains('is-open')) return
    const inside = tree.contains(document.activeElement)
    tree.classList.remove('is-open')
    scrim.classList.remove('is-open')
    sheetsBtn.setAttribute('aria-expanded', 'false')
    if (inside) sheetsBtn.focus()
  }

  const onWheel = (event) => {
    event.preventDefault()
    if (busy) return
    const rect = canvas.getBoundingClientRect()
    const dy = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
    zoomAt(Math.exp(-dy * (event.ctrlKey ? 0.01 : 0.0016)), event.clientX - rect.left, event.clientY - rect.top)
  }
  canvas.addEventListener('wheel', onWheel, { passive: false })

  const pointers = new Map()
  let drag = null
  let pinch = null
  canvas.addEventListener('pointerdown', (event) => {
    if (busy || event.button !== 0) return
    if (event.target.closest('.gs-node, .gs-controls, .gs-tblock')) return
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    canvas.setPointerCapture(event.pointerId)
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.k }
      drag = null
    } else drag = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false }
  })
  canvas.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      const rect = canvas.getBoundingClientRect()
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      zoomAt((pinch.k * d) / pinch.d / view.k, (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top)
      return
    }
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (!drag.moved && Math.hypot(dx, dy) > 4) {
      drag.moved = true
      canvas.classList.add('is-grabbing')
    }
    if (drag.moved) {
      view.x = drag.vx + dx
      view.y = drag.vy + dy
      apply()
      userMoved = true
    }
  })
  const endPointer = (event) => {
    if (!pointers.has(event.pointerId)) return
    pointers.delete(event.pointerId)
    if (pointers.size < 2) pinch = null
    if (drag && pointers.size === 0) {
      if (!drag.moved) closePanel()
      drag = null
      canvas.classList.remove('is-grabbing')
    }
  }
  canvas.addEventListener('pointerup', endPointer)
  canvas.addEventListener('pointercancel', endPointer)
  canvas.addEventListener('dblclick', (event) => {
    if (event.target.closest('.gs-node, .gs-controls, .gs-tblock') || !model) return
    animate(fitView(), 380)
    userMoved = false
  })

  world.addEventListener('click', (event) => {
    if (busy) return
    const plus = event.target.closest('.gs-plus')
    if (plus) {
      event.stopPropagation()
      go(plus.dataset.open)
      return
    }
    const node = event.target.closest('.gs-node')
    if (node) select(node.dataset.id)
  })
  world.addEventListener('keydown', (event) => {
    const node = event.target.closest('.gs-node')
    if (!node || event.target.classList.contains('gs-plus')) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      select(node.dataset.id)
    }
  })

  root.addEventListener('click', (event) => {
    const target = event.target.closest('[data-go]')
    if (target && !target.closest('.gs-world')) {
      if (target.href && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return
      event.preventDefault()
      hideResults()
      go(target.dataset.go, { select: target.dataset.sel })
      return
    }
    const zoom = event.target.closest('[data-z]')
    if (zoom && model) {
      const c = stageSize()
      if (zoom.dataset.z === 'in') zoomAt(1.3, c.w / 2, c.h / 2)
      else if (zoom.dataset.z === 'out') zoomAt(1 / 1.3, c.w / 2, c.h / 2)
      else {
        animate(fitView(), 360)
        userMoved = false
      }
    }
  })
  q('.gs-p-x').addEventListener('click', () => closePanel())
  sheetsBtn.addEventListener('click', () => {
    tree.classList.add('is-open')
    scrim.classList.add('is-open')
    sheetsBtn.setAttribute('aria-expanded', 'true')
    tree.querySelector('.gs-ti.is-cur')?.focus()
  })
  scrim.addEventListener('click', closeTree)

  let hot = -1
  let found = []
  function hideResults() {
    results.hidden = true
    hot = -1
  }
  function showResults() {
    const value = input.value.trim().toLowerCase()
    if (!value) return hideResults()
    const words = value.split(/\s+/)
    found = index.filter((it) => words.every((w) => it.hay.includes(w)))
    hot = found.length ? 0 : -1
    results.innerHTML = found.length
      ? found
          .map((it, i) => {
            const t = sheets.get(it.sid)
            return `<button type="button" class="${i === hot ? 'is-hot' : ''}" data-go="${esc(it.sid)}" data-sel="${esc(it.bid)}"><span class="gs-r-n">${esc(it.sid)}</span><span class="gs-r-t">${esc(it.name)}</span><span class="gs-r-s">${esc(levelName(t.level))} · ${esc(t.title)}</span></button>`
          })
          .join('')
      : '<div class="gs-r-none">No box matches. Try a shorter word.</div>'
    results.hidden = false
  }
  input.addEventListener('input', showResults)
  input.addEventListener('focus', showResults)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!found.length) return
      event.preventDefault()
      hot = (hot + (event.key === 'ArrowDown' ? 1 : -1) + found.length) % found.length
      ;[...results.querySelectorAll('button')].forEach((b, i) => b.classList.toggle('is-hot', i === hot))
    } else if (event.key === 'Enter' && hot >= 0) {
      event.preventDefault()
      const it = found[hot]
      hideResults()
      input.blur()
      go(it.sid, { select: it.bid })
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      hideResults()
      input.blur()
    }
  })
  const onDocPointer = (event) => {
    if (!event.target.closest('.gs-search')) hideResults()
  }
  document.addEventListener('pointerdown', onDocPointer)

  const onKey = (event) => {
    if (event.defaultPrevented || event.target === input || event.target.closest('input, textarea, [contenteditable="true"]')) return
    if (event.key === '/') {
      event.preventDefault()
      input.focus()
      return
    }
    if (event.key !== 'Escape') return
    if (tree.classList.contains('is-open')) {
      event.preventDefault()
      closeTree()
      return
    }
    if (closePanel()) {
      event.preventDefault()
      return
    }
    const s = sheets.get(cur)
    if (s && s.parent) {
      event.preventDefault()
      go(s.parent)
    }
  }
  document.addEventListener('keydown', onKey)

  const resize = new ResizeObserver(() => {
    if (!busy && model && !userMoved) {
      view = fitView()
      apply()
    }
  })
  resize.observe(canvas)

  async function poll() {
    if (gone || document.hidden || busy) return
    try {
      const response = await fetch(`/api/godeye/map?${new URLSearchParams({ project, id: mapId })}`, { headers: { accept: 'application/json' } })
      if (!response.ok || gone) return
      const next = await response.json()
      if (gone || next.version !== 4 || next.updatedMs === data.updatedMs) return
      const keep = selected
      const was = { ...view }
      load(next)
      const target = sheets.has(cur) ? cur : '1'
      render(target)
      view = userMoved ? was : fitView()
      apply()
      world.style.opacity = '1'
      if (keep && model.byId.has(keep)) select(keep)
      q('.gs-tblock').classList.remove('is-fresh')
      void q('.gs-tblock').offsetWidth
      q('.gs-tblock').classList.add('is-fresh')
      if (target !== cur) syncUrl()
    } catch {}
  }

  load(initial)
  const start = sheetParam && sheets.has(sheetParam) ? sheetParam : '1'
  render(start)
  view = fitView()
  apply()
  world.style.opacity = '1'
  polling = window.setInterval(poll, POLL_MS)
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      if (gone || busy || !model) return
      const keep = selected
      render(cur)
      if (!userMoved) view = fitView()
      apply()
      if (keep) select(keep)
    })
  }

  return {
    setSheet(id) {
      const want = id && sheets.has(id) ? id : '1'
      if (want !== cur) go(want, { fromUrl: true })
    },
    destroy() {
      gone = true
      window.clearInterval(polling)
      resize.disconnect()
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDocPointer)
      canvas.removeEventListener('wheel', onWheel)
      reduce = { matches: true }
    },
  }
}
