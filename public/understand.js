import { el, icon, link, urlFor, navigate, setTitle, createResource, every, getJson, stateBlock, errorBlock, linesSkeleton, keepFocus } from './ui.js'
import { pageShell } from './pages.js'

const POLL_MS = 2500
const GRAPH = 'knowledge-graph.json'
const DATA_FILES = [GRAPH, 'domain-graph.json', 'diff-overlay.json', 'code-lessons.json', 'meta.json', 'config.json']
const HISTORY_MAX = 50
const CODE_CLOSED = { open: false, node: null, expanded: false }
const FRESHNESS_FAILED = { graphs: { knowledge: { status: 'unknown', reason: 'freshness-request-failed' } } }
const SIDE_IGNORES = new Set(['query', 'results', 'expanded', 'sizes', 'toggled'])
const EXCLUSIVE = { filter: 'export', export: 'filter' }
const MODS = [
  ['shift', 'shiftKey'],
  ['ctrl', 'ctrlKey'],
  ['alt', 'altKey'],
  ['meta', 'metaKey'],
]

export const ALL_NODE_TYPES = ['file', 'function', 'class', 'module', 'concept', 'config', 'document', 'service', 'table', 'endpoint', 'pipeline', 'schema', 'resource', 'domain', 'flow', 'step', 'article', 'entity', 'topic', 'claim', 'source', 'page', 'screen', 'component', 'componentSet', 'instance', 'token']
export const ALL_COMPLEXITIES = ['simple', 'moderate', 'complex']
export const EDGE_CATEGORY_MAP = {
  structural: ['imports', 'exports', 'contains', 'inherits', 'implements'],
  behavioral: ['calls', 'subscribes', 'publishes', 'middleware'],
  'data-flow': ['reads_from', 'writes_to', 'transforms', 'validates'],
  dependencies: ['depends_on', 'tested_by', 'configures'],
  semantic: ['related', 'similar_to'],
  infrastructure: ['deploys', 'serves', 'provisions', 'triggers', 'migrates', 'documents', 'routes', 'defines_schema'],
  domain: ['contains_flow', 'flow_step', 'cross_domain'],
  knowledge: ['cites', 'contradicts', 'builds_on', 'exemplifies', 'categorized_under', 'authored_by'],
  design: ['instance_of', 'variant_of', 'uses_token'],
}
export const ALL_EDGE_CATEGORIES = Object.keys(EDGE_CATEGORY_MAP)
export const EDGE_CATEGORY = Object.fromEntries(Object.entries(EDGE_CATEGORY_MAP).flatMap(([category, types]) => types.map((type) => [type, category])))
export const NODE_CATEGORY = { file: 'code', function: 'code', class: 'code', module: 'code', concept: 'code', config: 'config', document: 'docs', service: 'infra', resource: 'infra', pipeline: 'infra', table: 'data', endpoint: 'data', schema: 'data', domain: 'domain', flow: 'domain', step: 'domain', article: 'knowledge', entity: 'knowledge', topic: 'knowledge', claim: 'knowledge', source: 'knowledge', page: 'code', screen: 'code', component: 'code', componentSet: 'code', instance: 'code', token: 'code' }
export const CHIPS = [
  { key: 'code', label: 'Code', color: 'var(--ua-t-file)' },
  { key: 'config', label: 'Config', color: 'var(--ua-t-config)' },
  { key: 'docs', label: 'Docs', color: 'var(--ua-t-document)' },
  { key: 'infra', label: 'Infra', color: 'var(--ua-t-service)' },
  { key: 'data', label: 'Data', color: 'var(--ua-t-table)' },
  { key: 'domain', label: 'Domain', color: 'var(--ua-t-concept)' },
  { key: 'knowledge', label: 'Knowledge', color: 'var(--ua-t-article)' },
]
export const EDGE_LABELS = {
  imports: ['imports', 'imported by'],
  exports: ['exports to', 'exported by'],
  contains: ['contains', 'contained in'],
  inherits: ['inherits from', 'inherited by'],
  implements: ['implements', 'implemented by'],
  calls: ['calls', 'called by'],
  subscribes: ['subscribes to', 'subscribed by'],
  publishes: ['publishes to', 'consumed by'],
  middleware: ['middleware for', 'uses middleware'],
  reads_from: ['reads from', 'read by'],
  writes_to: ['writes to', 'written by'],
  transforms: ['transforms', 'transformed by'],
  validates: ['validates', 'validated by'],
  depends_on: ['depends on', 'depended on by'],
  tested_by: ['tested by', 'tests'],
  configures: ['configures', 'configured by'],
  related: ['related to', 'related to'],
  similar_to: ['similar to', 'similar to'],
  deploys: ['deploys', 'deployed by'],
  serves: ['serves', 'served by'],
  migrates: ['migrates', 'migrated by'],
  documents: ['documents', 'documented by'],
  provisions: ['provisions', 'provisioned by'],
  routes: ['routes to', 'routed from'],
  defines_schema: ['defines schema for', 'schema defined by'],
  triggers: ['triggers', 'triggered by'],
  contains_flow: ['contains flow', 'flow in'],
  flow_step: ['flow step', 'step of'],
  cross_domain: ['cross-domain to', 'cross-domain from'],
  cites: ['cites', 'cited by'],
  contradicts: ['contradicts', 'contradicted by'],
  builds_on: ['builds on', 'built upon by'],
  exemplifies: ['exemplifies', 'exemplified by'],
  categorized_under: ['categorized under', 'categorizes'],
  authored_by: ['authored by', 'authored'],
}
const ISSUE_ORDER = { fatal: 0, dropped: 1, 'auto-corrected': 2 }
const ISSUE_TAG = { fatal: 'Fatal', dropped: 'Dropped', 'auto-corrected': 'Auto-corrected' }

export function edgeLabel(type, outgoing) {
  if (Object.hasOwn(EDGE_LABELS, type)) return EDGE_LABELS[type][outgoing ? 0 : 1]
  const title = String(type).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  return outgoing ? title : `${title} (reverse)`
}

export function tourSteps(graph) {
  return graph && Array.isArray(graph.tour) ? [...graph.tour].sort((a, b) => a.order - b.order) : []
}

export function hasActiveFilters(state) {
  const f = state.filters
  return f.nodeTypes.size !== ALL_NODE_TYPES.length || f.complexities.size !== ALL_COMPLEXITIES.length || f.layerIds.size > 0 || f.edgeCategories.size !== ALL_EDGE_CATEGORIES.length
}

export function isLearnMode(state) {
  return state.tour.active || state.persona === 'junior'
}

function defaultFilters() {
  return { nodeTypes: new Set(ALL_NODE_TYPES), complexities: new Set(ALL_COMPLEXITIES), layerIds: new Set(), edgeCategories: new Set(ALL_EDGE_CATEGORIES) }
}

function initialState() {
  return {
    graph: null,
    kind: 'code',
    containers: {},
    version: 0,
    issues: [],
    loadError: null,
    files: {},
    freshness: null,
    level: 'overview',
    layerId: null,
    selected: null,
    history: [],
    focus: null,
    expanded: new Set(),
    sizes: new Map(),
    toggled: null,
    persona: 'junior',
    viewMode: 'structural',
    domainId: null,
    detailLevel: 'file',
    showFunctions: false,
    categories: Object.fromEntries(CHIPS.map((chip) => [chip.key, true])),
    filters: defaultFilters(),
    query: '',
    results: [],
    tour: { active: false, step: 0 },
    diff: { on: false, changed: new Set(), affected: new Set() },
    path: null,
    code: CODE_CLOSED,
    theme: null,
    open: {},
    tab: 'info',
  }
}

function createStore(initial) {
  let state = initial
  const subs = new Set()
  return {
    get: () => state,
    set(patch) {
      const prev = state
      const next = typeof patch === 'function' ? patch(prev) : patch
      if (!next) return
      state = { ...prev, ...next }
      for (const fn of [...subs]) {
        try {
          fn(state, prev)
        } catch (error) {
          console.error('Understand store subscriber failed', error)
        }
      }
    },
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
  }
}

function safe(run, fallback = null) {
  try {
    return run()
  } catch (error) {
    console.error('Understand module error', error)
    return fallback
  }
}

function edgeIndex(edges) {
  const map = new Map()
  for (const e of edges) {
    for (const id of e.source === e.target ? [e.source] : [e.source, e.target]) {
      if (!map.has(id)) map.set(id, [])
      map.get(id).push(e)
    }
  }
  return map
}

function diffFrom(data) {
  const ok = data && Array.isArray(data.changedNodeIds) && Array.isArray(data.affectedNodeIds) && data.changedNodeIds.length > 0
  return ok ? { on: true, changed: new Set(data.changedNodeIds), affected: new Set(data.affectedNodeIds) } : { on: false, changed: new Set(), affected: new Set() }
}

function plural(n, word) {
  return `${n} ${word}${n !== 1 ? 's' : ''}`
}

function copyText(issues, fatal) {
  const lead = fatal
    ? ['Some of these issues look like dashboard rendering bugs.', 'Please file an issue at github.com/Egonex-AI/Understand-Anything/issues with the text below.', '']
    : ['The following issues were found in your knowledge-graph.json.', 'These are LLM generation errors, not a system bug.', 'You can ask your agent to fix these specific issues in the knowledge-graph.json file:', '']
  const lines = [...issues].sort((a, b) => ISSUE_ORDER[a.level] - ISSUE_ORDER[b.level]).map((issue) => `[${ISSUE_TAG[issue.level]}] ${issue.message}`)
  return [...lead, ...lines].join('\n')
}

function section(title, ...content) {
  return el('section', { class: 'ua-p-section' }, el('h3', { class: 'ua-p-label' }, title), ...content)
}

function listView(container) {
  setTitle('Understand')
  const wrap = el('div', { class: 'ua-list scroll-area' })
  container.replaceChildren(wrap)
  const { body } = pageShell(wrap, { title: 'Understand', intro: 'Maps of your codebases, made by /understand.' })
  const resource = createResource(() => '/api/understand', render)
  let seen = null

  function card(project) {
    return link(
      urlFor({ view: 'understand', project: project.key }),
      { class: 'plugin-card ua-project', 'data-focus': `project-${project.key}` },
      el('span', { class: 'plugin-name' }, project.name),
      project.pathLabel ? el('span', { class: 'ua-project-path' }, project.pathLabel) : null,
      project.error ? el('span', { class: 'ua-project-error' }, project.error) : project.countsLabel ? el('span', { class: 'plugin-parts' }, project.countsLabel) : null,
      el('span', { class: 'meta' }, project.analyzedLabel),
    )
  }

  function render(state) {
    if (state.status === 'loading') return body.replaceChildren(linesSkeleton(4))
    if (state.status === 'error') return body.replaceChildren(errorBlock('Could not load your maps', state.error, () => resource.load()))
    const { projects, folderLabel } = state.data
    keepFocus(body, () =>
      body.replaceChildren(projects.length ? el('div', { class: 'plugin-grid' }, projects.map(card)) : stateBlock({ title: 'No projects yet', text: `Run /understand in a repo. Its map shows up here, saved in ${folderLabel}.` })),
    )
  }

  async function poll() {
    try {
      const { signature } = await getJson('/api/understand/version')
      if (seen !== null && signature !== seen) resource.load({ silent: true })
      seen = signature
    } catch {}
  }

  poll()
  resource.load()
  const stop = every(POLL_MS, poll)
  return {
    destroy() {
      stop()
      resource.cancel()
    },
  }
}

function projectView(container, key, initialNode) {
  setTitle(key)
  const store = createStore(initialState())
  const main = { byId: new Map(), layerOf: new Map(), edgesOf: new Map() }
  let domain = { graph: null, byId: new Map(), edgesOf: new Map() }
  let wanted = initialNode
  let gone = false
  let ready = false
  let graphMod = null
  let canvas = null
  let issuesOpen = false
  let shownNode = null
  let reloaded = false
  let queued = false
  let mounted = null
  let lastSide = null
  let lastBanners = null
  let lastTour = ''
  let freshCtl = null
  let filesPanel = null
  const borrowed = new Set()
  const seen = {}
  const reqs = {}
  const cleanups = []
  const views = new Map()
  const infoPanels = []
  const nodeSections = []
  const keys = []
  const escapes = []

  const title = el('h1', { class: 'ua-title' }, key)
  const fresh = el('span', { class: 'ua-fresh', role: 'status' })
  const slot = (name, className = 'ua-slot') => el('div', { class: className, 'data-slot': name })
  const slots = {
    persona: slot('persona'),
    viewToggle: slot('view-toggle'),
    diff: slot('diff'),
    detail: slot('detail'),
    chips: slot('chips'),
    legend: slot('legend'),
    filter: slot('filter'),
    export: slot('export'),
    path: slot('path'),
    theme: slot('theme'),
    help: slot('help'),
    search: slot('search', 'ua-searchrow'),
    banners: slot('banners', 'ua-slot-banners'),
    bottom: slot('bottom', 'ua-bottom'),
    overlay: slot('overlay', 'ua-overlay'),
  }
  const ownBanners = el('div', { class: 'ua-own-banners' })
  const structural = el('div', { class: 'ua-view-host' }, el('div', { class: 'ua-loading' }, linesSkeleton(3)))
  const viewHost = el('div', { class: 'ua-view-host', hidden: true })
  const stage = el('div', { class: 'ua-stage' }, structural, viewHost, el('div', { class: 'ua-watermark', 'aria-hidden': 'true' }, 'Press ? for keyboard shortcuts'))
  const tabButton = (tab, label) => el('button', { class: 'ua-tab', type: 'button', role: 'tab', onclick: () => actions.setTab(tab) }, label)
  const tabs = { info: tabButton('info', 'Info'), files: tabButton('files', 'Files') }
  const sideBody = el('div', { class: 'ua-side-body scroll-area', role: 'tabpanel' })
  const side = el('aside', { class: 'ua-side', 'aria-label': 'Details' }, el('div', { class: 'ua-tabs', role: 'tablist' }, tabs.info, tabs.files), sideBody)
  const root = el(
    'div',
    { class: 'ua' },
    el(
      'header',
      { class: 'ua-head' },
      el('div', { class: 'ua-head-left' }, link(urlFor({ view: 'understand' }), { class: 'icon-button', 'aria-label': 'All projects', title: 'All projects' }, icon('back')), title, fresh, slots.persona, slots.viewToggle),
      el('div', { class: 'ua-head-mid' }, slots.diff, slots.detail, slots.chips, slots.legend),
      el('div', { class: 'ua-head-right' }, slots.filter, slots.export, slots.path, slots.theme, slots.help),
    ),
    slots.search,
    el('div', { class: 'ua-banners' }, slots.banners, ownBanners),
    el('div', { class: 'ua-body' }, stage, side, slots.bottom),
    slots.overlay,
  )
  container.replaceChildren(root)

  const fresh0 = () => ({ expanded: new Set(), sizes: new Map(), toggled: null })
  const nameOf = (id) => (main.byId.get(id) || domain.byId.get(id) || { name: id }).name
  const activeIndex = (s = store.get()) => (s.viewMode === 'domain' && domain.graph ? domain : main)
  const pushed = (s, id) => (s.selected && id && id !== s.selected ? [...s.history, s.selected].slice(-HISTORY_MAX) : s.history)
  const tabFor = (s, id) => (id ? 'info' : s.tab)

  function layerNav(s, id) {
    const layerId = main.layerOf.get(id)
    if (!layerId) return {}
    return layerId === s.layerId ? { level: 'layer', layerId } : { level: 'layer', layerId, ...fresh0() }
  }

  function tourNav(s, step) {
    return step.nodeIds && step.nodeIds.length ? layerNav(s, step.nodeIds[0]) : {}
  }

  function tourIds(s) {
    const step = tourSteps(s.graph)[s.tour.step]
    return step && Array.isArray(step.nodeIds) ? step.nodeIds : []
  }

  const actions = {
    selectNode: (id) => store.set((s) => ({ selected: id || null, history: pushed(s, id), tab: tabFor(s, id) })),
    navigateToNode: (id) =>
      store.set((s) => {
        if (!s.graph || !id) return null
        const nav = layerNav(s, id)
        const base = { selected: id, history: pushed(s, id), tab: 'info' }
        return nav.level ? { ...base, ...nav, focus: null, code: CODE_CLOSED } : base
      }),
    goToHistory: (index) => store.set((s) => (index >= 0 && index < s.history.length ? { selected: s.history[index], history: s.history.slice(0, index), tab: 'info', ...layerNav(s, s.history[index]) } : null)),
    goBack: () => store.set((s) => (s.history.length ? { selected: s.history.at(-1), history: s.history.slice(0, -1), tab: 'info', ...layerNav(s, s.history.at(-1)) } : null)),
    drillIntoLayer: (layerId) => store.set({ level: 'layer', layerId, selected: null, focus: null, code: CODE_CLOSED, ...fresh0() }),
    overview: () => store.set({ level: 'overview', layerId: null, selected: null, focus: null, code: CODE_CLOSED, ...fresh0() }),
    setFocus: (id) => store.set((s) => ({ focus: id || null, selected: id || null, tab: tabFor(s, id), ...fresh0() })),
    setPersona: (persona) => store.set({ persona, ...fresh0() }),
    setViewMode: (viewMode) => store.set({ viewMode, selected: null, focus: null, code: CODE_CLOSED }),
    navigateToDomain: (domainId) => store.set((s) => ({ viewMode: 'domain', domainId, focus: null, history: s.selected ? [...s.history, s.selected].slice(-HISTORY_MAX) : s.history })),
    clearActiveDomain: () => store.set({ domainId: null, selected: null, focus: null }),
    setDetailLevel: (detailLevel) => store.set({ detailLevel, showFunctions: false, ...fresh0() }),
    toggleFunctions: () => store.set((s) => ({ showFunctions: !s.showFunctions, ...fresh0() })),
    toggleCategory: (category) => store.set((s) => ({ categories: { ...s.categories, [category]: s.categories[category] === false }, ...fresh0() })),
    setFilters: (partial) => store.set((s) => ({ filters: { ...s.filters, ...partial }, ...fresh0() })),
    resetFilters: () => store.set({ filters: defaultFilters(), ...fresh0() }),
    setSearch: (query, results) => store.set({ query, results: String(query).trim() ? results || [] : [] }),
    startTour: () =>
      store.set((s) => {
        const steps = tourSteps(s.graph)
        return steps.length ? { tour: { active: true, step: 0 }, selected: null, ...tourNav(s, steps[0]) } : null
      }),
    stopTour: () => store.set({ tour: { active: false, step: 0 } }),
    setTourStep: (step) =>
      store.set((s) => {
        const steps = tourSteps(s.graph)
        return step >= 0 && step < steps.length ? { tour: { active: s.tour.active, step }, ...tourNav(s, steps[step]) } : null
      }),
    nextTourStep: () => actions.setTourStep(store.get().tour.step + 1),
    prevTourStep: () => actions.setTourStep(store.get().tour.step - 1),
    setDiff: (changed, affected) => store.set({ diff: { on: true, changed: new Set(changed), affected: new Set(affected) } }),
    toggleDiff: () => store.set((s) => (s.diff.changed.size ? { diff: { ...s.diff, on: !s.diff.on } } : null)),
    openCode: (id) => store.set({ code: { open: true, node: id, expanded: false } }),
    closeCode: () => store.set({ code: CODE_CLOSED }),
    expandCode: () => store.set((s) => ({ code: { ...s.code, expanded: true } })),
    collapseCode: () => store.set((s) => ({ code: { ...s.code, expanded: false } })),
    setPath: (ids) => store.set({ path: ids && ids.length ? [...ids] : null }),
    setTheme: (theme) => store.set({ theme }),
    setOpen: (name, value) => store.set((s) => ({ open: { ...s.open, ...(value && EXCLUSIVE[name] ? { [EXCLUSIVE[name]]: false } : {}), [name]: Boolean(value) } })),
    toggleOpen: (name) => actions.setOpen(name, !store.get().open[name]),
    setTab: (tab) => store.set({ tab }),
    toggleContainer: (id) =>
      store.set((s) => {
        const expanded = new Set(s.expanded)
        const open = !expanded.has(id)
        if (open) expanded.add(id)
        else expanded.delete(id)
        return { expanded, toggled: open ? id : s.toggled }
      }),
    expandContainers: (ids) => store.set((s) => (ids.every((id) => s.expanded.has(id)) ? null : { expanded: new Set([...s.expanded, ...ids]) })),
    collapseContainers: (ids) => store.set((s) => ({ expanded: new Set([...s.expanded].filter((id) => !ids.includes(id))) })),
  }

  const handlers = {
    drill: (id) => actions.drillIntoLayer(id),
    overview: () => actions.overview(),
    select: (id) => actions.selectNode(id),
    toggle: (id) => actions.toggleContainer(id),
    zoomedIn: (ids) => {
      if (store.get().level === 'layer' && ids.length) actions.expandContainers(ids)
    },
    unfocus: () => actions.setFocus(null),
  }

  function indexMain(graph) {
    main.byId = new Map(graph.nodes.map((n) => [n.id, n]))
    main.layerOf = new Map()
    for (const layer of graph.layers) for (const id of layer.nodeIds) if (!main.layerOf.has(id)) main.layerOf.set(id, layer.id)
    main.edgesOf = edgeIndex(graph.edges)
  }

  function indexDomain(graph) {
    const ok = graph && Array.isArray(graph.nodes) && Array.isArray(graph.edges)
    domain = ok ? { graph, byId: new Map(graph.nodes.map((n) => [n.id, n])), edgesOf: edgeIndex(graph.edges) } : { graph: null, byId: new Map(), edgesOf: new Map() }
  }

  function trail(node, state) {
    if (!state.history.length) return el('span')
    const recent = state.history.slice(-3)
    const offset = state.history.length - recent.length
    return el(
      'nav',
      { class: 'ua-trail', 'aria-label': 'History' },
      el('button', { class: 'text-button', type: 'button', 'data-focus': 'back', onclick: actions.goBack }, '← Back'),
      el('span', { class: 'ua-trail-bar', 'aria-hidden': 'true' }, '│'),
      recent.map((id, i) => [i ? el('span', { class: 'ua-trail-sep', 'aria-hidden': 'true' }, '›') : null, el('button', { class: 'text-button', type: 'button', onclick: () => actions.goToHistory(offset + i) }, nameOf(id))]),
      el('span', { class: 'ua-trail-sep', 'aria-hidden': 'true' }, '›'),
      el('span', { class: 'ua-trail-here' }, node.name),
    )
  }

  function nodeInfo(state) {
    const index = activeIndex(state)
    const node = index.byId.get(state.selected)
    if (!node) return el('p', { class: 'ua-side-empty' }, 'Select a node to see details')
    const touching = index.edgesOf.get(node.id) || []
    const children = touching.filter((e) => e.type === 'contains' && e.source === node.id).map((e) => index.byId.get(e.target)).filter(Boolean)
    const others = touching.filter((e) => !(e.type === 'contains' && e.source === node.id))
    const groups = new Map()
    for (const e of others) {
      const outgoing = e.source === node.id
      const label = edgeLabel(e.type, outgoing)
      if (!groups.has(label)) groups.set(label, [])
      groups.get(label).push({ id: outgoing ? e.target : e.source, outgoing })
    }
    const tags = Array.isArray(node.tags) ? node.tags : []
    const focused = state.focus === node.id
    const parts = [
      { order: 10, render: () => el('div', { class: 'ua-p-top' }, trail(node, state), el('button', { class: 'icon-button', type: 'button', 'aria-label': 'Close details', 'data-focus': 'close', onclick: () => actions.selectNode(null) }, icon('close'))) },
      { order: 20, render: () => el('div', { class: 'ua-badges' }, el('span', { class: 'ua-badge', style: { '--ua-c': graphMod.typeColor(node.type) } }, node.type), node.complexity ? el('span', { class: `ua-badge ua-cx-${node.complexity}` }, node.complexity) : null) },
      {
        order: 30,
        render: () =>
          el('div', { class: 'ua-p-head' }, el('h2', { class: 'ua-p-name' }, node.name), el('button', { class: 'button small', type: 'button', 'aria-pressed': String(focused), 'data-focus': 'focus', title: focused ? 'Show the whole layer' : 'Show only this node and its neighbors', onclick: () => actions.setFocus(focused ? null : node.id) }, focused ? 'Unfocus' : 'Focus')),
      },
      { order: 50, render: () => (node.summary ? el('p', { class: 'ua-p-summary' }, node.summary) : null) },
      {
        order: 60,
        render: () =>
          node.filePath
            ? section('File', el('p', { class: 'ua-p-path' }, node.filePath, Array.isArray(node.lineRange) ? el('span', { class: 'ua-p-lines' }, ` L${node.lineRange[0]}-${node.lineRange[1]}`) : null), el('div', null, el('button', { class: 'button small', type: 'button', 'data-focus': 'open-code', onclick: () => actions.openCode(node.id) }, 'Open code')))
            : null,
      },
      { order: 70, render: () => (node.languageNotes ? el('details', { class: 'ua-p-notes', open: true }, el('summary', { class: 'ua-p-label' }, 'Language Concepts'), el('p', null, node.languageNotes)) : null) },
      { order: 80, render: () => (tags.length ? section('Tags', el('div', { class: 'chips' }, tags.map((tag) => el('span', { class: 'chip' }, tag)))) : null) },
      {
        order: 110,
        render: () =>
          children.length
            ? section(
                `Defined in this file (${children.length})`,
                el(
                  'div',
                  { class: 'ua-p-list' },
                  children.map((child) =>
                    el(
                      'button',
                      { class: 'ua-p-child', type: 'button', onclick: () => actions.navigateToNode(child.id) },
                      el('span', { class: 'ua-p-child-top' }, el('span', { class: 'ua-badge', style: { '--ua-c': graphMod.typeColor(child.type) } }, child.type), el('span', { class: 'ua-p-child-name' }, child.name), el('span', { class: `ua-cx ua-cx-${child.complexity}` }, child.complexity)),
                      child.summary ? el('span', { class: 'ua-p-child-summary' }, child.summary) : null,
                    ),
                  ),
                ),
              )
            : null,
      },
      {
        order: 120,
        render: () =>
          others.length
            ? section(
                `Connections (${others.length})`,
                [...groups].map(([label, items]) =>
                  el(
                    'div',
                    { class: 'ua-p-group' },
                    el('h4', { class: 'ua-p-group-title' }, `${label} (${items.length})`),
                    items.map((item) => el('button', { class: 'ua-p-link', type: 'button', onclick: () => actions.navigateToNode(item.id) }, el('span', { class: 'ua-p-arrow', 'aria-hidden': 'true' }, item.outgoing ? '→' : '←'), el('span', null, nameOf(item.id)))),
                  ),
                ),
              )
            : null,
      },
      ...nodeSections.filter((x) => !x.when || safe(() => x.when(node, state))).map((x) => ({ order: x.order ?? 100, render: () => safe(() => x.render(node, state, api)) })),
    ]
    return el('div', { class: 'ua-node-info' }, parts.sort((a, b) => a.order - b.order).map((part) => part.render()))
  }

  function warning(issues) {
    const fatal = issues.filter((issue) => issue.level === 'fatal')
    const fixed = issues.filter((issue) => issue.level === 'auto-corrected')
    const dropped = issues.filter((issue) => issue.level === 'dropped')
    const parts = [fatal.length ? plural(fatal.length, 'fatal error') : null, fixed.length ? plural(fixed.length, 'auto-correction') : null, dropped.length ? plural(dropped.length, 'dropped item') : null].filter(Boolean)
    const box = el(
      'div',
      { class: fatal.length ? 'ua-warn is-fatal' : 'ua-warn' },
      el(
        'button',
        {
          class: 'ua-warn-row',
          type: 'button',
          'aria-expanded': String(issuesOpen),
          'data-focus': 'issues',
          onclick: () => {
            issuesOpen = !issuesOpen
            renderBanners(store.get(), true)
          },
        },
        icon('chevron', 'ua-warn-chevron'),
        el('span', { class: 'ua-warn-icon', 'aria-hidden': 'true' }, '⚠'),
        el('span', { class: 'ua-warn-summary' }, fatal.length ? `Dashboard hit ${parts.join(', ')}` : `Knowledge graph loaded with ${parts.join(' and ')}`),
        el('span', { class: 'ua-warn-hint' }, issuesOpen ? 'click to collapse' : 'click to expand'),
      ),
    )
    if (!issuesOpen) return box
    const group = (name, list) => (list.length ? el('div', { class: 'ua-warn-group' }, el('p', { class: 'ua-warn-title' }, `${name} (${list.length})`), el('ul', null, list.map((issue) => el('li', null, issue.message)))) : null)
    const copy = el(
      'button',
      {
        class: 'button small',
        type: 'button',
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(copyText(issues, fatal.length > 0))
            copy.textContent = 'Copied!'
            window.setTimeout(() => (copy.textContent = 'Copy Issues'), 2000)
          } catch (error) {
            console.warn('Could not copy the issues', error)
          }
        },
      },
      'Copy Issues',
    )
    box.append(
      el('div', { class: 'ua-warn-body scroll-area' }, group('Fatal', fatal), group('Auto-corrected', fixed), group('Dropped', dropped)),
      el('div', { class: 'ua-warn-foot' }, el('span', null, fatal.length ? 'Copy these issues and file a bug report on GitHub' : 'Copy these issues and ask your agent to fix them in knowledge-graph.json'), copy),
    )
    return box
  }

  function renderBanners(state, force) {
    if (!force && lastBanners && lastBanners.issues === state.issues && lastBanners.loadError === state.loadError) return
    lastBanners = state
    keepFocus(ownBanners, () => ownBanners.replaceChildren(...(state.loadError ? [el('div', { class: 'ua-error', role: 'alert' }, state.loadError)] : state.issues.length ? [warning(state.issues)] : [])))
  }

  function renderSidebar(state) {
    if (lastSide && Object.keys(state).every((k) => state[k] === lastSide[k] || SIDE_IGNORES.has(k))) return
    lastSide = state
    for (const [tab, button] of Object.entries(tabs)) {
      button.setAttribute('aria-selected', String(state.tab === tab))
      button.classList.toggle('is-active', state.tab === tab)
    }
    side.classList.toggle('is-idle', !state.selected)
    const parts = []
    if (state.tab === 'files') parts.push(filesPanel && safe(() => filesPanel.render(state, api)))
    else for (const panel of infoPanels) if (!panel.when || safe(() => panel.when(state))) parts.push(safe(() => panel.render(state, api)))
    const out = parts.flat().filter(Boolean)
    if (!out.length) out.push(el('p', { class: 'ua-side-empty' }, state.tab === 'files' ? 'No files to show.' : 'Select a node to see details'))
    keepFocus(sideBody, () => sideBody.replaceChildren(...out))
    if (state.selected !== shownNode) sideBody.scrollTop = 0
    shownNode = state.selected
  }

  function renderView(state) {
    const view = state.viewMode !== 'structural' ? views.get(state.viewMode) : null
    if (mounted && (!view || mounted.id !== view.id)) {
      safe(() => mounted.instance.destroy && mounted.instance.destroy())
      mounted = null
      viewHost.replaceChildren()
    }
    structural.hidden = Boolean(view)
    viewHost.hidden = !view
    if (!view) return
    if (!mounted) mounted = { id: view.id, instance: safe(() => view.mount(viewHost, api)) || {} }
    safe(() => mounted.instance.update && mounted.instance.update(state))
  }

  function syncUrl(state) {
    const want = urlFor({ view: 'understand', project: key, node: state.selected })
    if (`${window.location.pathname}${window.location.search}` !== want) navigate(want, { replace: true })
  }

  function paintMarks(state) {
    canvas.highlight('search', String(state.query).trim() ? new Map(state.results.map((r) => [r.nodeId, r.score])) : null)
    canvas.highlight('tour', state.tour.active ? tourIds(state) : null)
    canvas.highlight('diff-changed', state.diff.on ? state.diff.changed : null, { dim: true })
    canvas.highlight('diff-affected', state.diff.on ? state.diff.affected : null, { dim: true })
    canvas.highlight('path', state.path)
    canvas.highlight('focus', state.focus ? [state.focus] : null)
  }

  function autoExpand(state) {
    const steps = state.tour.active ? tourIds(state) : []
    const need = new Set(state.level === 'layer' ? steps.map((id) => canvas.containerOf(id)).filter(Boolean) : [])
    const focusBox = state.level === 'layer' && state.focus ? canvas.containerOf(state.focus) : null
    const add = []
    for (const id of need) {
      if (state.expanded.has(id)) continue
      add.push(id)
      borrowed.add(id)
    }
    if (focusBox && !state.expanded.has(focusBox)) add.push(focusBox)
    const drop = []
    for (const id of [...borrowed]) {
      if (need.has(id)) continue
      borrowed.delete(id)
      if (state.expanded.has(id)) drop.push(id)
    }
    if (add.length || drop.length) {
      store.set({ expanded: new Set([...[...state.expanded].filter((id) => !drop.includes(id)), ...add]) })
      return
    }
    const tour = state.tour.active ? `${state.tour.step}|${state.version}|${state.layerId}` : ''
    if (tour && tour !== lastTour && !canvas.frame(steps, { minZoom: 0.4 })) canvas.fit(500, 0.3)
    lastTour = tour
  }

  async function drawCanvas(state) {
    if (!state.graph || structural.hidden) return
    const opts = { reload: reloaded }
    reloaded = false
    const ok = await canvas.update(state, opts)
    if (ok && !gone && store.get() === state) autoExpand(state)
  }

  function flush() {
    queued = false
    if (gone) return
    const state = store.get()
    renderBanners(state)
    if (!ready) return
    if (state.graph && !canvas) canvas = graphMod.createGraph(structural, handlers)
    renderSidebar(state)
    renderView(state)
    syncUrl(state)
    if (!canvas) return
    paintMarks(state)
    drawCanvas(state)
  }

  function schedule() {
    if (queued) return
    queued = true
    queueMicrotask(flush)
  }

  function refresh() {
    lastSide = null
    schedule()
  }

  store.subscribe(schedule)

  function flash() {
    fresh.textContent = 'Updated'
    fresh.classList.remove('is-on')
    void fresh.offsetWidth
    fresh.classList.add('is-on')
  }

  function applyGraph(body) {
    const s = store.get()
    const reload = Boolean(s.graph)
    const graph = body.data
    indexMain(graph)
    const patch = { graph, containers: body.containers || {}, version: s.version + 1, issues: body.issues || [], loadError: null, kind: body.kind || graph.kind || 'code', files: { ...s.files, [GRAPH]: body } }
    if (reload) {
      if (s.layerId && !graph.layers.some((layer) => layer.id === s.layerId)) Object.assign(patch, { level: 'overview', layerId: null }, fresh0())
      if (s.selected && s.viewMode !== 'domain' && !main.byId.has(s.selected)) patch.selected = null
      if (s.focus && !main.byId.has(s.focus)) patch.focus = null
      patch.history = s.history.filter((id) => main.byId.has(id) || domain.byId.has(id))
      reloaded = true
      flash()
      refreshFreshness()
    } else {
      if (patch.kind === 'knowledge') patch.viewMode = 'knowledge'
      if (wanted && main.byId.has(wanted)) Object.assign(patch, layerNav(s, wanted), { selected: wanted })
    }
    wanted = null
    title.textContent = graph.project.name || key
    setTitle(graph.project.name || key)
    store.set(patch)
  }

  function fail(message) {
    store.set({ loadError: message })
    if (!canvas) structural.replaceChildren(el('div', { class: 'ua-loading' }, stateBlock({ title: 'No map to show', text: 'Run /understand in this repo, or pick another project.', actions: [link(urlFor({ view: 'understand' }), { class: 'button' }, 'All projects')] })))
  }

  function setFile(name, body) {
    if (name === 'domain-graph.json') indexDomain(body && body.data)
    const patch = { files: { ...store.get().files, [name]: body } }
    if (name === 'diff-overlay.json') patch.diff = diffFrom(body && body.data)
    store.set(patch)
  }

  async function load(name) {
    const n = (reqs[name] = (reqs[name] || 0) + 1)
    let body = null
    let failure = null
    try {
      body = await getJson(`/api/understand/data?${new URLSearchParams({ project: key, file: name })}`)
    } catch (error) {
      failure = error
    }
    if (gone || n !== reqs[name]) return
    if (name !== GRAPH) return setFile(name, failure ? null : body)
    if (failure) fail(`Failed to load knowledge graph: ${failure.message}`)
    else if (body.error || !body.data) fail(body.error || 'Failed to load knowledge graph')
    else applyGraph(body)
  }

  async function poll() {
    let version
    try {
      version = await getJson(`/api/understand/version?${new URLSearchParams({ project: key })}`)
    } catch {
      return
    }
    if (gone) return
    const files = version.files || {}
    const changed = DATA_FILES.filter((name) => (files[name] || '') !== seen[name])
    for (const name of changed) seen[name] = files[name] || ''
    await Promise.all(changed.map((name) => (seen[name] ? load(name) : name === GRAPH ? null : setFile(name, null))))
  }

  async function refreshFreshness() {
    if (freshCtl) freshCtl.abort()
    const ctl = (freshCtl = new AbortController())
    let report = null
    try {
      const res = await fetch(`/api/understand/freshness?${new URLSearchParams({ project: key })}`, { cache: 'no-store', signal: ctl.signal })
      report = res.ok ? await res.json() : null
    } catch {
      if (ctl.signal.aborted) return
    }
    if (gone || ctl !== freshCtl) return
    const ok = report && report.graphs && report.graphs.knowledge && typeof report.graphs.knowledge.status === 'string'
    store.set({ freshness: ok ? report : FRESHNESS_FAILED })
  }

  function registerKey(spec) {
    keys.push(spec)
    return () => keys.includes(spec) && keys.splice(keys.indexOf(spec), 1)
  }

  function matches(spec, event) {
    return event.key.toLowerCase() === spec.key.toLowerCase() && MODS.every(([name, flag]) => spec[name] === 'any' || Boolean(spec[name]) === event[flag])
  }

  const step = (order, test, run) => ({
    order,
    run(s) {
      if (!test(s)) return false
      run()
      return true
    },
  })
  const builtinEscapes = [
    step(10, (s) => s.open.path, () => actions.setOpen('path', false)),
    step(20, (s) => s.open.filter, () => actions.setOpen('filter', false)),
    step(30, (s) => s.open.export, () => actions.setOpen('export', false)),
    step(40, (s) => s.code.open && s.code.expanded, actions.collapseCode),
    step(50, (s) => s.code.open, actions.closeCode),
    step(60, (s) => s.selected, () => actions.selectNode(null)),
    step(70, (s) => s.level === 'layer', actions.overview),
    step(80, (s) => s.tour.active, actions.stopTour),
    step(90, (s) => s.open.help, () => actions.setOpen('help', false)),
  ]

  function runEscape() {
    const s = store.get()
    for (const entry of [...escapes, ...builtinEscapes].sort((a, b) => a.order - b.order)) if (safe(() => entry.run(s), false)) return true
    return false
  }

  const canvasOn = (run) => (canvas && !structural.hidden ? run(canvas) : false)
  registerKey({ key: '?', shift: true, description: 'Show keyboard shortcuts', group: 'General', handler: () => actions.toggleOpen('help') })
  registerKey({ key: 'Escape', description: 'Close panels and modals / go back to overview', group: 'Navigation', handler: runEscape })
  registerKey({
    key: '/',
    description: 'Focus search bar',
    group: 'Navigation',
    handler: () => {
      const input = root.querySelector('[data-ua-search]')
      if (!input) return false
      input.focus()
    },
  })
  registerKey({ key: 'ArrowRight', description: 'Next tour step', group: 'Tour', handler: () => (store.get().tour.active ? actions.nextTourStep() : false) })
  registerKey({ key: 'ArrowLeft', description: 'Previous tour step', group: 'Tour', handler: () => (store.get().tour.active ? actions.prevTourStep() : false) })
  registerKey({ key: 'd', description: 'Toggle diff mode', group: 'View', handler: () => (store.get().diff.changed.size ? actions.toggleDiff() : false) })
  registerKey({ key: 'f', description: 'Toggle filter panel', group: 'View', handler: () => actions.toggleOpen('filter') })
  registerKey({ key: 'e', description: 'Toggle export menu', group: 'View', handler: () => actions.toggleOpen('export') })
  registerKey({ key: 'p', description: 'Open path finder', group: 'View', handler: () => actions.toggleOpen('path') })
  registerKey({ key: '+', shift: 'any', description: 'Zoom in', group: 'View', handler: () => canvasOn((c) => c.zoomBy(1.25)) })
  registerKey({ key: '=', hidden: true, description: 'Zoom in', group: 'View', handler: () => canvasOn((c) => c.zoomBy(1.25)) })
  registerKey({ key: '-', description: 'Zoom out', group: 'View', handler: () => canvasOn((c) => c.zoomBy(0.8)) })
  registerKey({ key: '0', description: 'Fit to screen', group: 'View', handler: () => canvasOn((c) => c.fit(240)) })

  const onKey = (event) => {
    if (gone || event.defaultPrevented || typeof event.key !== 'string') return
    const typing = event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
    if (typing && event.key !== 'Escape') return
    for (const spec of keys) {
      if (!matches(spec, event)) continue
      if (safe(() => spec.handler(event)) === false) continue
      event.preventDefault()
      return
    }
  }
  document.addEventListener('keydown', onKey)
  window.addEventListener('focus', refreshFreshness)

  const api = {
    key,
    root,
    store: { get: store.get, set: store.set, subscribe: store.subscribe },
    actions,
    slots,
    data: {
      file: (name) => (store.get().files[name] ? store.get().files[name].data : null),
      body: (name) => store.get().files[name] || null,
      graph: () => store.get().graph,
      domain: () => domain.graph,
      node: (id) => activeIndex().byId.get(id) || null,
      mainNode: (id) => main.byId.get(id) || null,
      edgesOf: (id) => activeIndex().edgesOf.get(id) || [],
      layerOf: (id) => main.layerOf.get(id) || null,
      source: (path) => getJson(`/api/understand/source?${new URLSearchParams({ project: key, path })}`),
      freshness: refreshFreshness,
      thumbUrl: (id) => `/api/understand/thumb?${new URLSearchParams({ project: key, id })}`,
    },
    canvas: {
      highlight: (name, ids, opts) => canvas && canvas.highlight(name, ids, opts),
      fit: (ms, padding) => canvas && canvas.fit(ms, padding),
      frame: (ids, opts) => Boolean(canvas) && canvas.frame(ids, opts),
      focusNode: (id) => Boolean(canvas) && canvas.focusNode(id),
      zoomBy: (factor) => canvas && canvas.zoomBy(factor),
      snapshot: () => (canvas ? canvas.snapshot() : null),
      containerOf: (id) => (canvas ? canvas.containerOf(id) : null),
    },
    views: {
      register(spec) {
        views.set(spec.id, spec)
        refresh()
      },
    },
    panels: {
      info(spec) {
        infoPanels.push(spec)
        infoPanels.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
        refresh()
      },
      node(spec) {
        nodeSections.push(spec)
        refresh()
      },
      files(spec) {
        filesPanel = spec
        refresh()
      },
    },
    keys: {
      register: registerKey,
      escape(order, run) {
        const entry = { order, run }
        escapes.push(entry)
        return () => escapes.includes(entry) && escapes.splice(escapes.indexOf(entry), 1)
      },
      list: () => keys.filter((spec) => !spec.hidden).map(({ key: k, shift, ctrl, alt, meta, description, group }) => ({ key: k, shift, ctrl, alt, meta, description, group })),
    },
    consts: { ALL_NODE_TYPES, ALL_COMPLEXITIES, EDGE_CATEGORY_MAP, ALL_EDGE_CATEGORIES, EDGE_CATEGORY, NODE_CATEGORY, CHIPS, EDGE_LABELS },
    util: {
      edgeLabel,
      tourSteps,
      tourIds,
      hasActiveFilters,
      isLearnMode,
      typeColor: (type) => graphMod.typeColor(type),
      layerColor: (index) => graphMod.layerColor(index),
      nodePasses: (node, state = store.get()) => graphMod.nodePasses(node, state),
      edgePasses: (edge, state = store.get()) => graphMod.edgePasses(edge, state),
    },
    refresh,
    onDestroy: (fn) => cleanups.push(fn),
  }

  infoPanels.push({ id: 'node', order: 10, when: (s) => Boolean(s.selected), render: nodeInfo })

  import('./understand-graph.js')
    .then(async (mod) => {
      graphMod = mod
      try {
        const modules = await import('./understand-modules.js')
        if (!gone) await modules.registerAll(api)
      } catch (error) {
        console.error('Understand modules failed to load', error)
      }
    })
    .catch((error) => fail(`Failed to load the map view: ${error.message}`))
    .finally(() => {
      ready = Boolean(graphMod)
      refresh()
    })

  poll().then(() => {
    if (!gone && !store.get().graph && !store.get().loadError) load(GRAPH)
  })
  refreshFreshness()
  const stop = every(POLL_MS, poll)

  return {
    setNode(next) {
      const id = next || null
      const s = store.get()
      if (!s.graph) {
        wanted = id
        return
      }
      if (id === s.selected) return
      if (id && main.byId.has(id)) actions.navigateToNode(id)
      else if (!id) actions.selectNode(null)
    },
    destroy() {
      gone = true
      stop()
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('focus', refreshFreshness)
      if (freshCtl) freshCtl.abort()
      if (mounted) safe(() => mounted.instance.destroy && mounted.instance.destroy())
      for (const fn of cleanups) safe(fn)
      if (canvas) canvas.destroy()
    },
  }
}

export function understandPage(container, params) {
  let key = null
  let view = null

  function mount(next) {
    const project = next.get('project') || ''
    if (view && project === key) {
      if (view.setNode) view.setNode(next.get('node'))
      return
    }
    if (view) view.destroy()
    key = project
    view = project ? projectView(container, project, next.get('node')) : listView(container)
  }

  mount(params)
  return {
    update: mount,
    destroy() {
      view.destroy()
    },
  }
}
