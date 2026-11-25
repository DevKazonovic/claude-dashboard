const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')
const { createJsonCache, readdirSafe, statSafe, realpathSafe } = require('./collector')
const { RequestError } = require('./conversation')
const format = require('./format')

const ROOT = path.join(os.homedir(), '.claude', 'understand')
const PROJECT = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u
const GRAPH = 'knowledge-graph.json'
const FILES = [GRAPH, 'meta.json', 'config.json', 'project.json', 'domain-graph.json', 'diff-overlay.json', 'code-lessons.json']
const LIST_FILES = [GRAPH, 'meta.json', 'project.json']
const MAX_DATA_BYTES = 64 * 1024 * 1024
const SCHEMA = pathToFileURL(path.join(__dirname, 'understand', 'core', 'schema.js')).href
const STALENESS = pathToFileURL(path.join(__dirname, 'understand', 'core', 'staleness.js')).href
const MAX_SOURCE_BYTES = 1024 * 1024
const KINDS = new Set(['knowledge', 'design'])
const LANGUAGES = { bash: 'bash', c: 'c', cc: 'cpp', cpp: 'cpp', cs: 'csharp', css: 'css', go: 'go', h: 'c', hpp: 'cpp', html: 'markup', java: 'java', js: 'javascript', jsx: 'jsx', json: 'json', md: 'markdown', mjs: 'javascript', py: 'python', rb: 'ruby', rs: 'rust', sh: 'bash', ts: 'typescript', tsx: 'tsx', txt: 'text', yaml: 'yaml', yml: 'yaml', php: 'php', vue: 'markup' }
const STRUCTURAL = new Set(['file', 'function', 'class', 'module', 'concept', 'config', 'document', 'service', 'table', 'endpoint', 'pipeline', 'schema', 'resource', 'domain', 'flow', 'step', 'page', 'screen', 'component', 'componentSet', 'instance', 'token'])

function commonPrefix(paths) {
  if (!paths.length) return ''
  const dirs = paths.map((p) => (p.lastIndexOf('/') >= 0 ? p.slice(0, p.lastIndexOf('/')) : ''))
  let prefix = dirs[0]
  for (const dir of dirs) {
    while (!dir.startsWith(prefix)) {
      prefix = prefix.slice(0, -1)
      if (!prefix) return ''
    }
  }
  return prefix.lastIndexOf('/') >= 0 ? prefix.slice(0, prefix.lastIndexOf('/') + 1) : ''
}

function groupByFolder(nodes) {
  const lcp = commonPrefix(nodes.filter((n) => n.filePath).map((n) => n.filePath))
  const groups = new Map()
  const rooted = []
  for (const n of nodes) {
    const rest = n.filePath ? n.filePath.slice(lcp.length) : ''
    if (!rest.includes('/')) {
      rooted.push(n.id)
      continue
    }
    const seg = rest.slice(0, rest.indexOf('/'))
    if (!groups.has(seg)) groups.set(seg, [])
    groups.get(seg).push(n.id)
  }
  return { groups, rooted }
}

function communities(ids, edges) {
  const Graph = require('graphology')
  const louvain = require('graphology-communities-louvain')
  const set = new Set(ids)
  const g = new Graph({ type: 'undirected', multi: false })
  for (const id of ids) g.mergeNode(id)
  for (const e of edges) {
    if (!set.has(e.source) || !set.has(e.target) || e.source === e.target || g.hasEdge(e.source, e.target)) continue
    g.addEdge(e.source, e.target)
  }
  const result = louvain(g, { randomWalk: false })
  const map = new Map(ids.map((id) => [id, result[id] ?? -1]))
  let next = 0
  for (const c of map.values()) if (c >= next) next = c + 1
  for (const [id, c] of map) if (c === -1) map.set(id, next++)
  return map
}

function applyLabels(containers, labels) {
  const pairs = []
  containers.forEach((c, ci) => {
    if (c.strategy !== 'community') return
    const members = new Set(c.nodeIds)
    labels.forEach((l, li) => {
      const ids = new Set(l.nodeIds)
      let shared = 0
      for (const id of ids) if (members.has(id)) shared++
      const union = members.size + ids.size - shared
      const score = union === 0 ? 0 : shared / union
      if (score >= 0.5) pairs.push({ ci, li, score })
    })
  })
  pairs.sort((a, b) => b.score - a.score)
  const names = new Map()
  const used = new Set()
  for (const { ci, li } of pairs) {
    if (names.has(ci) || used.has(li)) continue
    names.set(ci, labels[li].name)
    used.add(li)
  }
  return containers.map((c, ci) => (names.has(ci) ? { ...c, name: names.get(ci) } : c))
}

function buildContainers(nodes, edges, labels) {
  const { groups, rooted } = groupByFolder(nodes)
  const buckets = groups.size + (rooted.length ? 1 : 0)
  const crowded = [...groups.values(), rooted].some((ids) => ids.length / nodes.length > 0.7)
  if (buckets < 2 || crowded) {
    const byCommunity = new Map()
    for (const [id, cid] of communities(nodes.map((n) => n.id), edges)) {
      if (!byCommunity.has(cid)) byCommunity.set(cid, [])
      byCommunity.get(cid).push(id)
    }
    const containers = [...byCommunity.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([cid, ids], i) => ({ id: `container:cluster-${cid}`, name: i < 26 ? `Cluster ${String.fromCharCode(65 + i)}` : `Cluster ${i + 1}`, nodeIds: ids, strategy: 'community' }))
    return labels.length ? applyLabels(containers, labels) : containers
  }
  const containers = [...groups.entries()].map(([seg, ids]) => ({ id: `container:${seg}`, name: seg, nodeIds: ids, strategy: 'folder' }))
  if (rooted.length) containers.push({ id: 'container:~', name: '~', nodeIds: rooted, strategy: 'folder' })
  return containers
}

function dissolveSingles(nodes, containers, ungrouped) {
  if (nodes.length < 3) return containers
  return containers.filter((c) => {
    if (c.nodeIds.length !== 1) return true
    ungrouped.push(c.nodeIds[0])
    return false
  })
}

function deriveContainers(nodes, edges, labels, basis) {
  if (!nodes.length) return { containers: [], ungrouped: [] }
  if (!basis.nodes.length) {
    const ungrouped = []
    return { containers: dissolveSingles(nodes, buildContainers(nodes, edges, labels), ungrouped), ungrouped }
  }
  const basisContainers = buildContainers(basis.nodes, basis.edges, labels)
  const containerOf = new Map()
  for (const c of basisContainers) for (const id of c.nodeIds) containerOf.set(id, c)
  const fileByPath = new Map(basis.nodes.filter((n) => n.type === 'file' && n.filePath).map((n) => [n.filePath, n.id]))
  const projected = new Map()
  const ungrouped = []
  for (const node of nodes) {
    let container = containerOf.get(node.id)
    if (!container && (node.type === 'class' || node.type === 'function') && node.filePath && fileByPath.has(node.filePath)) container = containerOf.get(fileByPath.get(node.filePath))
    if (!container) {
      ungrouped.push(node.id)
      continue
    }
    if (!projected.has(container)) projected.set(container, [])
    projected.get(container).push(node.id)
  }
  const basisById = new Map(basis.nodes.map((n) => [n.id, n]))
  const containers = [...projected.entries()].map(([c, ids]) => {
    const single = c.strategy === 'community' && c.nodeIds.length === 1 && ids.length > 1 && c.name.startsWith('Cluster ') && basisById.get(c.nodeIds[0])
    return { ...c, name: single ? single.name : c.name, nodeIds: ids }
  })
  return { containers: dissolveSingles(nodes, containers, ungrouped), ungrouped }
}

function layerContainers(graph) {
  const out = Object.create(null)
  for (const layer of graph.layers) {
    const ids = new Set(layer.nodeIds)
    const nodes = graph.nodes.filter((n) => ids.has(n.id) && STRUCTURAL.has(n.type))
    const visible = new Set(nodes.map((n) => n.id))
    const basisNodes = graph.nodes.filter((n) => ids.has(n.id) && n.type === 'file')
    const basisIds = new Set(basisNodes.map((n) => n.id))
    out[layer.id] = deriveContainers(
      nodes,
      graph.edges.filter((e) => visible.has(e.source) && visible.has(e.target)),
      layer.containerLabels || [],
      { nodes: basisNodes, edges: graph.edges.filter((e) => basisIds.has(e.source) && basisIds.has(e.target)) },
    )
  }
  return out
}

function relativePaths(raw, root) {
  if (!raw || !Array.isArray(raw.nodes)) return
  for (const node of raw.nodes) {
    if (!node || typeof node.filePath !== 'string') continue
    if (root && node.filePath.startsWith(root)) node.filePath = node.filePath.slice(root.length).replace(/^[/\\]+/, '')
    else if (path.isAbsolute(node.filePath)) node.filePath = path.basename(node.filePath)
  }
}

function kindOf(...values) {
  return values.find((value) => KINDS.has(value)) || 'code'
}

function inside(root, target) {
  const rel = path.relative(root, target)
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

function graphPath(value) {
  const normalized = path.normalize(value)
  if (normalized === '.' || normalized === '..' || normalized.startsWith(`..${path.sep}`) || path.isAbsolute(normalized)) return null
  return normalized.split(path.sep).join('/')
}

async function readSource(root, requested, filePaths) {
  if (!requested) throw new RequestError(400, 'Missing path')
  if (requested.includes('\0')) throw new RequestError(400, 'Invalid path')
  if (path.isAbsolute(requested)) throw new RequestError(400, 'Absolute paths are not allowed')
  const rel = graphPath(requested)
  const abs = rel && path.resolve(root, rel)
  if (!rel || !inside(root, abs)) throw new RequestError(400, 'Path must stay inside the project')
  if (!filePaths.some((value) => typeof value === 'string' && graphPath(value) === rel)) throw new RequestError(404, 'File is not in the knowledge graph')
  const [realRoot, real] = await Promise.all([realpathSafe(root), realpathSafe(abs)])
  if (!real) throw new RequestError(404, 'File not found')
  if (!realRoot || !inside(realRoot, real)) throw new RequestError(400, 'Path must stay inside the project')
  const stat = await statSafe(real)
  if (!stat) throw new RequestError(404, 'File not found')
  if (!stat.isFile()) throw new RequestError(400, 'Path is not a file')
  if (stat.size > MAX_SOURCE_BYTES) throw new RequestError(413, 'File is too large to preview')
  const buffer = await fs.promises.readFile(real)
  if (buffer.includes(0)) throw new RequestError(415, 'Binary files cannot be previewed')
  const content = buffer.toString('utf8')
  return { path: rel, language: LANGUAGES[path.extname(rel).slice(1).toLowerCase()] || 'text', content, sizeBytes: buffer.byteLength, lineCount: content.length === 0 ? 0 : content.split(/\r\n|\n|\r/).length }
}

async function signatureOf(dir, files) {
  const stats = await Promise.all(files.map((file) => statSafe(path.join(dir, file))))
  const out = {}
  files.forEach((file, i) => {
    if (stats[i]) out[file] = `${stats[i].mtimeMs}:${stats[i].size}`
  })
  return out
}

function createUnderstand() {
  const readJson = createJsonCache()
  const graphs = new Map()

  async function projectDir(value) {
    const name = typeof value === 'string' ? value.trim() : ''
    if (!PROJECT.test(name)) return null
    const dir = path.join(ROOT, name)
    const stat = await statSafe(dir)
    return stat && stat.isDirectory() ? { name, dir } : null
  }

  async function projectDirs() {
    return (await readdirSafe(ROOT)).filter((entry) => entry.isDirectory() && PROJECT.test(entry.name)).map((entry) => ({ name: entry.name, dir: path.join(ROOT, entry.name) }))
  }

  async function graphOf(p) {
    const file = path.join(p.dir, GRAPH)
    const stat = await statSafe(file)
    if (!stat) {
      graphs.delete(p.name)
      return null
    }
    const sig = `${stat.mtimeMs}:${stat.size}`
    const cached = graphs.get(p.name)
    if (cached && cached.sig === sig) return cached.value
    if (stat.size > MAX_DATA_BYTES) throw new RequestError(413, 'This knowledge graph is too large to open.')
    let raw
    try {
      raw = JSON.parse(await fs.promises.readFile(file, 'utf8'))
    } catch {
      if (cached) return cached.value
      return { updatedMs: stat.mtimeMs, data: null, issues: [], containers: {}, error: 'Failed to load knowledge graph: Failed to read graph file' }
    }
    const info = await readJson(path.join(p.dir, 'project.json'))
    relativePaths(raw, info && typeof info.projectRoot === 'string' ? info.projectRoot : null)
    const kind = kindOf(raw && raw.kind)
    let value
    try {
      const result = (await import(SCHEMA)).validateGraph(raw)
      value = result.success
        ? { updatedMs: stat.mtimeMs, kind, data: { ...result.data, kind }, issues: result.issues || [], containers: layerContainers(result.data), error: null }
        : { updatedMs: stat.mtimeMs, kind, data: null, issues: result.issues || [], containers: {}, error: `Invalid knowledge graph: ${result.fatal || 'unknown validation error'}` }
    } catch (error) {
      return { updatedMs: stat.mtimeMs, data: null, issues: [], containers: {}, error: `Failed to load knowledge graph: ${error.message}` }
    }
    graphs.set(p.name, { sig, value })
    return value
  }

  return {
    async list() {
      const now = Date.now()
      const projects = []
      for (const p of await projectDirs()) {
        const [info, meta, graphStat] = await Promise.all([readJson(path.join(p.dir, 'project.json')), readJson(path.join(p.dir, 'meta.json')), statSafe(path.join(p.dir, GRAPH))])
        if (!info && !graphStat) continue
        let value = null
        let error = null
        try {
          value = await graphOf(p)
          error = value && value.error
        } catch (failure) {
          error = failure.message
        }
        const graph = value && value.data
        const analyzedMs = Date.parse((meta && meta.lastAnalyzedAt) || (graph && graph.project.analyzedAt) || '') || null
        projects.push({
          key: p.name,
          kind: kindOf(value && value.kind, info && info.kind),
          name: (graph && graph.project.name) || p.name,
          pathLabel: info && typeof info.projectRoot === 'string' ? format.homePath(info.projectRoot) : null,
          analyzedMs,
          analyzedLabel: analyzedMs ? `Analyzed ${format.ago(analyzedMs, now)}` : 'Not analyzed yet',
          countsLabel: graph ? [format.plural(graph.nodes.length, 'node', 'nodes'), format.plural(graph.edges.length, 'edge', 'edges'), format.plural(graph.layers.length, 'layer', 'layers')].join(' · ') : null,
          error,
        })
      }
      projects.sort((a, b) => (b.analyzedMs || 0) - (a.analyzedMs || 0) || a.key.localeCompare(b.key))
      return { folderLabel: format.homePath(ROOT), projects }
    },
    async version(params) {
      if (!params.has('project')) {
        const parts = await Promise.all((await projectDirs()).map(async (p) => `${p.name}=${Object.values(await signatureOf(p.dir, LIST_FILES)).join(',')}`))
        return { signature: parts.join('|') }
      }
      const p = await projectDir(params.get('project'))
      if (!p) return null
      const files = await signatureOf(p.dir, FILES)
      return { project: p.name, signature: Object.entries(files).map((entry) => entry.join('=')).join('|'), files }
    },
    async data(params) {
      const p = await projectDir(params.get('project'))
      const file = params.get('file')
      if (!p || !FILES.includes(file)) return null
      if (file === GRAPH) {
        const value = await graphOf(p)
        return value && { project: p.name, file, ...value }
      }
      const full = path.join(p.dir, file)
      const stat = await statSafe(full)
      if (!stat) return null
      if (stat.size > MAX_DATA_BYTES) throw new RequestError(413, 'This file is too large to open.')
      const data = await readJson(full)
      return data === null ? null : { project: p.name, file, updatedMs: stat.mtimeMs, data }
    },
    async source(params) {
      const p = await projectDir(params.get('project'))
      if (!p) return null
      const [info, graph] = await Promise.all([readJson(path.join(p.dir, 'project.json')), graphOf(p)])
      if (!graph) throw new RequestError(404, 'No knowledge graph found. Run /understand first.')
      if (!info || typeof info.projectRoot !== 'string') throw new RequestError(404, 'This project has no source folder to read from.')
      return readSource(info.projectRoot, params.get('path') || '', graph.data ? graph.data.nodes.map((n) => n.filePath) : [])
    },
    async freshness(params) {
      const p = await projectDir(params.get('project'))
      if (!p) return null
      const graph = await graphOf(p)
      if (!graph) throw new RequestError(404, 'No knowledge graph found. Run /understand first.')
      const domainFile = path.join(p.dir, 'domain-graph.json')
      const [info, domain, domainStat] = await Promise.all([readJson(path.join(p.dir, 'project.json')), readJson(domainFile), statSafe(domainFile)])
      if (!graph.data || (domainStat && !domain)) throw new RequestError(500, 'Failed to read graph file')
      const root = info && typeof info.projectRoot === 'string' ? info.projectRoot : null
      const input = (project) => ({
        graphCommitHash: root && project && typeof project.gitCommitHash === 'string' ? project.gitCommitHash : undefined,
        lastAnalyzedAt: project && typeof project.analyzedAt === 'string' ? project.analyzedAt : undefined,
      })
      const { getGraphFreshnessBatch } = await import(STALENESS)
      const graphs = await getGraphFreshnessBatch(root, { knowledge: input(graph.data.project), ...(domainStat ? { domain: input(domain.project) } : {}) })
      return { graphs, headCommit: Object.values(graphs).map((g) => g.headCommitHash).find(Boolean) }
    },
    async thumb(params) {
      const p = await projectDir(params.get('project'))
      const id = params.get('id')
      if (!p || !id) return null
      const file = path.join(p.dir, 'thumbnails', `${id.replace(/[^A-Za-z0-9._-]/g, '-')}.png`)
      const stat = await statSafe(file)
      return stat && stat.isFile() ? fs.promises.readFile(file) : null
    },
  }
}

module.exports = { createUnderstand, deriveContainers, readSource, ROOT }

if (require.main === module) {
  const assert = require('assert')
  const file = (id, filePath) => ({ id, type: 'file', name: id, filePath })
  const derive = (nodes, edges, labels) => deriveContainers(nodes, edges, labels, { nodes, edges })
  const folders = derive([file('a', 'src/auth/a.ts'), file('b', 'src/auth/b.ts'), file('c', 'src/db/c.ts'), file('d', 'src/db/d.ts')], [], [])
  assert.deepStrictEqual(folders.containers.map((c) => [c.id, c.nodeIds]), [['container:auth', ['a', 'b']], ['container:db', ['c', 'd']]])
  const flat = [file('a', 'lib/a.ts'), file('b', 'lib/b.ts'), file('c', 'lib/c.ts'), file('d', 'lib/d.ts')]
  const linked = [{ source: 'a', target: 'b' }, { source: 'c', target: 'd' }]
  const clusters = derive(flat, linked, [{ name: 'Auth', nodeIds: ['a', 'b'] }])
  assert.deepStrictEqual(clusters.containers.map((c) => [c.name, c.strategy, c.nodeIds.length]), [['Auth', 'community', 2], ['Cluster B', 'community', 2]])
  const singles = derive([file('a', 'src/x/a.ts'), file('b', 'src/y/b.ts'), file('c', 'src/y/c.ts')], [], [])
  assert.deepStrictEqual([singles.containers.map((c) => c.id), singles.ungrouped], [['container:y'], ['a']])
  const projected = deriveContainers([...flat, { id: 'fn', type: 'function', name: 'fn', filePath: 'lib/a.ts' }], linked, [], { nodes: flat, edges: linked })
  assert.ok(projected.containers.find((c) => c.nodeIds.includes('fn')).nodeIds.includes('a'))
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-source-'))
  const repo = path.join(tmp, 'repo')
  fs.mkdirSync(repo)
  fs.writeFileSync(path.join(repo, 'a.js'), 'one\ntwo')
  fs.writeFileSync(path.join(tmp, 'secret.js'), 'x')
  fs.symlinkSync(path.join(tmp, 'secret.js'), path.join(repo, 'leak.js'))
  Promise.all(['a.js', '', 'a\0', '/etc/hosts', '../secret.js', 'b.js', 'leak.js'].map((p) => readSource(repo, p, ['./a.js', 'leak.js', '../secret.js']).then((r) => r.lineCount, (e) => e.status)))
    .then((codes) => {
      assert.deepStrictEqual(codes, [2, 400, 400, 400, 400, 404, 400])
      console.log('understand self-check passed')
    })
    .finally(() => fs.rmSync(tmp, { recursive: true, force: true }))
}
