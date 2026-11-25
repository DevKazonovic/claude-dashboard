if (typeof window === 'undefined') importScripts('/vendor/dagre.min.js')

function uaClip(box, q) {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const dx = q.x - cx
  const dy = q.y - cy
  let w = box.w / 2
  let h = box.h / 2
  if (!dx && !dy) return { x: cx, y: cy }
  if (Math.abs(dy) * w > Math.abs(dx) * h) {
    if (dy < 0) h = -h
    return { x: cx + (h * dx) / dy, y: cy + h }
  }
  if (dx < 0) w = -w
  return { x: cx + w, y: cy + (w * dy) / dx }
}

function uaRun(spec, mode) {
  const out = { pos: {}, edges: {}, w: 0, h: 0 }
  if (!spec.nodes.length) return out
  const g = new self.dagre.graphlib.Graph({ multigraph: true })
  g.setGraph({ rankdir: mode === 'horizontal' ? 'LR' : 'TB', nodesep: 44, ranksep: 64, edgesep: 24 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of spec.nodes) g.setNode(n.id, { width: n.w, height: n.h })
  for (const e of spec.edges) g.setEdge(e.from, e.to, e.label ? { width: e.label.w, height: e.label.h, labelpos: 'c' } : {}, e.id)
  self.dagre.layout(g)
  const k = mode === 'waterfall' ? 0.8 : 0
  let top = Infinity
  for (const n of spec.nodes) top = Math.min(top, g.node(n.id).y)
  const shear = (p) => ({ x: p.x + k * (p.y - top), y: p.y })
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
  for (const n of spec.nodes) {
    const c = shear(g.node(n.id))
    const p = { x: c.x - n.w / 2, y: c.y - n.h / 2, w: n.w, h: n.h }
    out.pos[n.id] = p
    grow(p.x, p.y)
    grow(p.x + p.w, p.y + p.h)
  }
  for (const e of spec.edges) {
    const d = g.edge({ v: e.from, w: e.to, name: e.id })
    const pts = d.points.map(shear)
    if (k && e.from !== e.to) {
      pts[0] = uaClip(out.pos[e.from], pts[1])
      pts[pts.length - 1] = uaClip(out.pos[e.to], pts[pts.length - 2])
    }
    const lp = e.label ? shear(d) : null
    out.edges[e.id] = { pts, lp }
    for (const p of pts) grow(p.x, p.y)
    if (lp) {
      grow(lp.x - e.label.w / 2, lp.y - e.label.h / 2)
      grow(lp.x + e.label.w / 2, lp.y + e.label.h / 2)
    }
  }
  for (const p of Object.values(out.pos)) {
    p.x -= x0
    p.y -= y0
  }
  for (const e of Object.values(out.edges)) {
    for (const p of e.lp ? [...e.pts, e.lp] : e.pts) {
      p.x -= x0
      p.y -= y0
    }
  }
  out.w = x1 - x0
  out.h = y1 - y0
  return out
}

function uaLayout(job) {
  const inner = {}
  const sizes = {}
  for (const [id, spec] of Object.entries(job.inner)) {
    inner[id] = uaRun(spec, job.mode)
    sizes[id] = { w: Math.max(spec.minW, inner[id].w + spec.pad * 2), h: spec.head + inner[id].h + spec.pad }
  }
  for (const n of job.root.nodes) if (sizes[n.id]) Object.assign(n, sizes[n.id])
  return { root: uaRun(job.root, job.mode), inner, sizes }
}

self.uaLayout = uaLayout

if (typeof window === 'undefined') {
  self.onmessage = (event) => {
    const { id, job } = event.data
    try {
      self.postMessage({ id, result: uaLayout(job) })
    } catch (error) {
      self.postMessage({ id, error: String((error && error.message) || error) })
    }
  }
}
