import { el, icon, getJson, spinner, every, keepFocus } from './ui.js'

const POLL_MS = 3000
const STEPS = 12
const CREW_STEPS = 4
const CREW = 6
const MAIN_AGENTS = 12
const FILE_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const TOOL_KINDS = new Set(['tool', 'agent', 'workflow'])
const VERBS = {
  Bash: ['Running', 'Ran'],
  Read: ['Reading', 'Read'],
  Edit: ['Editing', 'Edited'],
  MultiEdit: ['Editing', 'Edited'],
  NotebookEdit: ['Editing', 'Edited'],
  Write: ['Writing', 'Wrote'],
  Grep: ['Searching', 'Searched'],
  Glob: ['Searching', 'Searched'],
  WebFetch: ['Fetching', 'Fetched'],
  WebSearch: ['Searching the web', 'Searched the web'],
  Agent: ['Starting agent', 'Started agent'],
  Workflow: ['Running workflow', 'Started workflow'],
  Skill: ['Using skill', 'Used skill'],
  TodoWrite: ['Updating tasks', 'Updated tasks'],
  ToolSearch: ['Loading tools', 'Loaded tools'],
  AskUserQuestion: ['Asking you', 'Asked you'],
}
const EVENT_LABELS = { say: 'Claude', done: 'Finished' }
const ERROR_LABELS = { API: 'API error' }
const STATES = { running: 'Running', waiting: 'Needs you', failed: 'Error', done: 'Done', idle: 'Idle' }
const RANK = { running: 0, failed: 1, done: 2, idle: 3 }
const TALLY = ['running', 'waiting', 'failed', 'idle']
const NOT_TOOLS = /^(Thinking|Finishing|Waiting)\b/
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })

function started(item) {
  return item.startedAt || item.lastActiveAt || 0
}

function byStart(a, b) {
  return started(a) - started(b) || String(a.id).localeCompare(String(b.id))
}

function agentsOf(session) {
  const flatten = (nodes) => nodes.flatMap((node) => (node.kind === 'more' ? flatten(node.nodes) : node.kind === 'workflow' ? node.agents.map((agent) => ({ ...agent, workflow: node.name })) : [node]))
  return flatten(session.agentNodes).sort(byStart)
}

function sessionState(session, own) {
  if (session.status === 'busy') return 'running'
  if (session.status === 'waiting' || session.status === 'blocked') return 'waiting'
  const last = own[own.length - 1]
  return last && last.kind === 'error' ? 'failed' : 'idle'
}

function agentState(agent) {
  if (agent.status === 'working') return 'running'
  if (agent.status === 'failed') return 'failed'
  return agent.status === 'done' ? 'done' : 'idle'
}

function agentLabel(agent, state) {
  if (state === 'idle') return agent.statusLabel
  return state === 'failed' ? 'Failed' : STATES[state]
}

function verb(label, past) {
  if (VERBS[label]) return VERBS[label][past ? 1 : 0]
  if (NOT_TOOLS.test(label)) return label
  return `${past ? 'Used' : 'Using'} ${label.split('__').pop().replace(/_/g, ' ')}`
}

function subject(label, text) {
  if (!text) return null
  return FILE_TOOLS.has(label) ? el('code', null, text.split('/').pop()) : text
}

function dot() {
  return el('span', { class: 'ops-dot', 'aria-hidden': 'true' })
}

function doing(activity) {
  const target = subject(activity.label, activity.target)
  return [verb(activity.label, false), target ? (FILE_TOOLS.has(activity.label) ? ' ' : ': ') : null, target].filter(Boolean)
}

function nowOf(session, state, own) {
  if (state === 'running') {
    const activity = session.activity
    return [spinner(), ...(activity ? doing(activity) : ['Working']), activity && activity.sinceLabel ? el('span', { class: 'ops-since' }, ` · ${activity.sinceLabel}`) : null].filter(Boolean)
  }
  if (state === 'waiting') return ['Waiting for you']
  const kind = state === 'failed' ? 'error' : 'say'
  const last = own.findLast((event) => event.kind === kind)
  return [last ? last.text : 'No activity yet']
}

function stepLabel(event) {
  if (TOOL_KINDS.has(event.kind)) return verb(event.label, true)
  if (event.kind === 'error') return ERROR_LABELS[event.label] || event.label
  return EVENT_LABELS[event.kind] || event.label
}

function stepLine(event, count) {
  return el(
    'li',
    { class: `ops-line is-${event.kind}` },
    el('time', { class: 'ops-at', datetime: new Date(event.at).toISOString() }, timeFormat.format(event.at)),
    el('span', { class: 'ops-label' }, stepLabel(event)),
    el('span', { class: 'ops-text' }, event.who ? el('span', { class: 'ops-who' }, `${event.who} › `) : null, TOOL_KINDS.has(event.kind) ? subject(event.label, event.text) : event.text, count > 1 ? el('span', { class: 'ops-times' }, ` ×${count}`) : null),
  )
}

function stepsOf(events, limit) {
  const merged = []
  for (const event of events) {
    const last = merged[merged.length - 1]
    if (last && last.event.label === event.label && last.event.text === event.text && last.event.agentId === event.agentId) last.count += 1
    else merged.push({ event, count: 1 })
  }
  return merged.slice(-limit).map(({ event, count }) => stepLine(event, count))
}

function crewLabel(agents) {
  const count = (state) => agents.filter((agent) => agentState(agent) === state).length
  const [running, failed, done] = ['running', 'failed', 'done'].map(count)
  return [`${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}`, running ? `${running} running` : null, failed ? `${failed} failed` : null, done ? `${done} done` : null].filter(Boolean).join(' · ')
}

function crewOf(agents, limit) {
  const recent = (a, b) => (agentState(a) === 'running' ? started(a) - started(b) : (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
  return agents
    .slice()
    .sort((a, b) => RANK[agentState(a)] - RANK[agentState(b)] || recent(a, b))
    .slice(0, limit)
}

function metaOf(session, state, feed) {
  if (state !== 'running') return session.lastActiveAt ? session.lastActiveLabel : ''
  const perMinute = feed.rate.length > 1 ? feed.rate[feed.rate.length - 2] : null
  return perMinute ? `${compact.format(perMinute)} tokens/min` : `${compact.format(session.totalTokens || 0)} tokens`
}

function countLabel(state, count) {
  if (state === 'waiting') return `${count} ${count === 1 ? 'needs' : 'need'} you`
  if (state === 'failed') return `${count} ${count === 1 ? 'error' : 'errors'}`
  return `${count} ${state}`
}

function screenView(onOpen) {
  const view = { id: null }
  view.open = el('button', { class: 'ops-open', type: 'button', onclick: () => onOpen(view) })
  view.state = el('span', { class: 'ops-state' })
  view.meta = el('span', { class: 'ops-meta' })
  view.project = el('p', { class: 'ops-project' })
  view.title = el('h2', { class: 'ops-title' })
  view.now = el('p', { class: 'ops-now' })
  view.crew = el('p', { class: 'ops-crew', hidden: true })
  view.list = el('div', { class: 'ops-agents', hidden: true })
  view.log = el('ol', { class: 'ops-log' })
  view.node = el('article', { class: 'ops-screen', tabindex: '-1' }, view.open, el('header', { class: 'ops-strip' }, view.state, view.meta), el('div', { class: 'ops-body' }, view.project, view.title, view.now, view.crew, view.list, view.log))
  return view
}

function best(sessions) {
  const ranked = sessions.slice().sort((a, b) => (b.session.workingAgents || 0) - (a.session.workingAgents || 0) || (b.session.status === 'busy') - (a.session.status === 'busy') || (b.session.lastActiveAt || 0) - (a.session.lastActiveAt || 0))
  return ranked.length ? ranked[0].session.id : null
}

export function createOps(container, { onAgent, onPick }) {
  const feeds = new Map()
  const screens = new Map()
  const crews = new Map()
  const states = new Map()
  const keys = {}
  let groups = []
  let order = []
  let picked = null
  let auto = null
  let focus = null
  let shown = null
  let polling = false
  let offline = false
  let destroyed = false
  let scene = null
  let flat = false

  const crumbs = el('nav', { class: 'ops-crumbs', 'aria-label': 'Breadcrumb' })
  const counts = el('div', { class: 'ops-counts', 'aria-live': 'polite' })
  const clockText = el('span', { class: 'ops-clock' })
  const bar = el('header', { class: 'ops-bar' }, crumbs, counts, clockText)
  const hud = el('nav', { class: 'ops-hud', 'aria-label': 'Switch conversation', hidden: true })
  const main = screenView(() => {})
  const monitors = el('div', { class: 'ops-monitors', 'aria-label': 'Conversations' })
  const wall = el('div', { class: 'ops-wall' }, main.node, monitors)
  const space = el('div', { class: 'ops-space' })
  const root = el('div', { class: 'ops is-3d' }, bar, space, hud)
  container.replaceChildren(root)

  function feedOf(id) {
    if (!feeds.has(id)) feeds.set(id, { server: [], rate: [] })
    return feeds.get(id)
  }

  function agentRow(session, agent) {
    const state = agentState(agent)
    return el(
      'button',
      { class: `ops-agent is-${state}`, type: 'button', 'data-focus': `ops-agent-${agent.id}`, onclick: () => onAgent(session.id, agent.id) },
      dot(),
      el('span', { class: 'ops-agent-name' }, agent.description),
      el('span', { class: 'ops-agent-doing' }, state === 'running' && agent.activity ? doing(agent.activity) : agentLabel(agent, state)),
    )
  }

  function fillSession(view, entry, mode) {
    const { group, session } = entry
    const feed = feedOf(session.id)
    const own = feed.server.filter((event) => !event.agentId)
    const state = sessionState(session, own)
    const agents = agentsOf(session)
    view.id = session.id
    view.node.className = mode === 'main' ? `ops-screen is-main is-${state}` : `ops-screen is-${state}`
    view.open.hidden = mode !== 'wall'
    view.open.setAttribute('aria-label', `Open ${session.title}, ${STATES[state].toLowerCase()}`)
    view.state.replaceChildren(dot(), STATES[state])
    view.meta.textContent = metaOf(session, state, feed)
    view.project.textContent = group.name
    view.title.textContent = session.title
    view.now.replaceChildren(...nowOf(session, state, own))
    view.crew.hidden = !agents.length
    view.crew.textContent = crewLabel(agents)
    view.list.hidden = mode !== 'main' || !agents.length
    view.list.replaceChildren(...(view.list.hidden ? [] : crewOf(agents, MAIN_AGENTS).map((agent) => agentRow(session, agent))))
    view.log.replaceChildren(...stepsOf(own.length >= 3 ? own : feed.server, STEPS))
    return { state, agents }
  }

  function fillAgent(view, agent, events) {
    const state = agentState(agent)
    const now = state === 'running' && agent.activity ? [spinner(), ...doing(agent.activity)] : [[agent.tokensLabel, agent.modelsLabel].filter(Boolean).join(' · ')].filter(Boolean)
    view.node.className = `ops-screen is-agent is-${state}`
    view.open.setAttribute('aria-label', `Open agent ${agent.description}, ${agentLabel(agent, state).toLowerCase()}`)
    view.state.replaceChildren(dot(), agentLabel(agent, state))
    view.meta.textContent = (state === 'running' ? agent.tokensLabel : agent.lastActiveAt && agent.lastActiveLabel) || ''
    view.project.textContent = agent.workflow ? `${agent.workflow} · ${agent.typeLabel}` : agent.typeLabel
    view.title.textContent = agent.description
    view.now.hidden = !now.length
    view.now.replaceChildren(...now)
    view.log.replaceChildren(...stepsOf(events.filter((event) => event.agentId === agent.id), CREW_STEPS))
    return state
  }

  function crewItems(current) {
    const used = new Set()
    const items = current
      ? crewOf(agentsOf(current.session), CREW).map((agent) => {
          const key = `${current.session.id}:${agent.id}`
          if (!crews.has(key)) crews.set(key, screenView(() => onAgent(current.session.id, agent.id)))
          const view = crews.get(key)
          used.add(key)
          return { id: key, node: view.node, state: fillAgent(view, agent, feedOf(current.session.id).server) }
        })
      : []
    for (const key of crews.keys()) if (!used.has(key)) crews.delete(key)
    return items
  }

  function step(delta) {
    if (!order.length) return
    const index = order.findIndex(({ session }) => session.id === focus)
    const next = index < 0 ? (delta > 0 ? 0 : order.length - 1) : (index + delta + order.length) % order.length
    onPick(order[next].session.id)
  }

  function jump(state) {
    const list = order.filter(({ session }) => states.get(session.id) === state)
    if (!list.length) return
    const index = list.findIndex(({ session }) => session.id === focus)
    onPick(list[(index + 1) % list.length].session.id)
  }

  function renderBar(sessions, current) {
    const crumbKey = current ? `${current.group.name}\n${current.session.title}` : ''
    if (keys.crumbs !== crumbKey) {
      keys.crumbs = crumbKey
      const sep = () => el('span', { class: 'ops-sep', 'aria-hidden': 'true' }, '/')
      crumbs.replaceChildren(
        ...(current
          ? [el('button', { class: 'ops-crumb is-link', type: 'button', 'data-focus': 'ops-home', onclick: () => onPick(null) }, 'All conversations'), sep(), el('span', { class: 'ops-crumb' }, current.group.name), sep(), el('span', { class: 'ops-crumb is-here', 'aria-current': 'page' }, current.session.title)]
          : [el('span', { class: 'ops-crumb is-here' }, 'All conversations')]),
      )
    }
    const tally = TALLY.map((state) => [state, sessions.filter(({ session }) => states.get(session.id) === state).length]).filter(([, count]) => count)
    const countKey = tally.join('|')
    if (keys.counts === countKey) return
    keys.counts = countKey
    counts.replaceChildren(...tally.map(([state, count]) => el('button', { class: `ops-count is-${state}`, type: 'button', 'data-focus': `ops-count-${state}`, onclick: () => jump(state) }, dot(), countLabel(state, count))))
  }

  function renderHud(sessions, current) {
    const index = current ? sessions.indexOf(current) : -1
    const total = sessions.length
    const prev = index < 0 ? null : sessions[(index - 1 + total) % total].session
    const next = index < 0 ? null : sessions[(index + 1) % total].session
    const key = index < 0 ? '' : [index, total, prev.title, next.title].join('\n')
    if (keys.hud === key) return
    keys.hud = key
    hud.hidden = index < 0
    hud.replaceChildren(
      ...(index < 0
        ? []
        : [
            total > 1 ? el('button', { class: 'ops-step', type: 'button', 'data-focus': 'ops-prev', 'aria-label': `Previous conversation: ${prev.title}`, onclick: () => step(-1) }, icon('back'), el('span', { class: 'ops-step-name' }, prev.title)) : null,
            el('span', { class: 'ops-index' }, `${index + 1} of ${total}`),
            total > 1 ? el('button', { class: 'ops-step', type: 'button', 'data-focus': 'ops-next', 'aria-label': `Next conversation: ${next.title}`, onclick: () => step(1) }, el('span', { class: 'ops-step-name' }, next.title), icon('chevron')) : null,
            el('span', { class: 'ops-keys', 'aria-hidden': 'true' }, el('kbd', null, '←'), el('kbd', null, '→'), ' Switch', el('kbd', null, 'Esc'), ' Back'),
          ]),
    )
  }

  function moveFocus() {
    if (flat || !scene || focus === shown) return
    const before = shown
    shown = focus
    const active = document.activeElement
    if (active && active !== document.body && !active.closest('.ops-holo')) return
    const view = screens.get(focus || before)
    const node = view && (focus ? view.node : view.open)
    if (node && node.isConnected) node.focus({ preventScroll: true })
  }

  function render() {
    const sessions = groups.flatMap((group) => group.sessions.map((session) => ({ group, session }))).sort((a, b) => byStart(a.session, b.session))
    const ids = new Set(sessions.map(({ session }) => session.id))
    order = sessions
    if (!auto || !ids.has(auto)) auto = best(sessions)
    focus = picked && ids.has(picked) ? picked : flat ? auto : null
    const current = sessions.find(({ session }) => session.id === focus) || null
    keepFocus(root, () => {
      const items = sessions.map((entry) => {
        const { id } = entry.session
        if (!screens.has(id)) screens.set(id, screenView((view) => onPick(view.id)))
        const view = screens.get(id)
        const { state, agents } = fillSession(view, entry, !flat && id === focus ? 'focus' : 'wall')
        view.node.classList.toggle('is-on-main', flat && id === focus)
        states.set(id, state)
        return { id, node: view.node, state, agents: agents.length }
      })
      for (const [id, view] of screens) {
        if (ids.has(id)) continue
        view.node.remove()
        screens.delete(id)
        states.delete(id)
      }
      if (flat) {
        if (current) fillSession(main, current, 'main')
        let cursor = monitors.firstElementChild
        for (const { node } of items) {
          if (node === cursor) cursor = cursor.nextElementSibling
          else monitors.insertBefore(node, cursor)
        }
      } else if (scene) scene.place(items, focus, crewItems(current))
      renderBar(sessions, flat ? null : current)
      renderHud(sessions, flat ? null : current)
    })
    moveFocus()
  }

  function tickClock() {
    clockText.textContent = offline ? 'Reconnecting…' : clockFormat.format(Date.now())
  }

  async function poll() {
    if (polling || destroyed) return
    polling = true
    const data = await getJson('/api/ops').catch(() => null)
    polling = false
    if (destroyed) return
    offline = !data
    tickClock()
    if (!data) return
    for (const [id, entry] of Object.entries(data.sessions)) Object.assign(feedOf(id), { server: entry.events, rate: entry.rate })
    render()
  }

  function onKey(event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]')) return
    if (document.querySelector('[aria-modal="true"]:not([hidden])')) return
    if (event.key === 'Escape' && focus && !flat) onPick(null)
    else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') step(event.key === 'ArrowRight' ? 1 : -1)
    else return
    event.preventDefault()
  }

  window.addEventListener('keydown', onKey)
  const stopPoll = every(POLL_MS, poll)
  const stopClock = every(1000, tickClock)
  tickClock()
  poll()
  import('./ops3d.js')
    .then(({ createScene }) => {
      if (destroyed) return
      scene = createScene(space, { onPick, onBack: () => onPick(null) })
      render()
    })
    .catch(() => {
      if (destroyed) return
      flat = true
      root.classList.remove('is-3d')
      space.replaceWith(wall)
      render()
    })

  return {
    update(next, conversationId) {
      groups = next
      picked = conversationId
      render()
    },
    destroy() {
      destroyed = true
      window.removeEventListener('keydown', onKey)
      stopPoll()
      stopClock()
      if (scene) scene.destroy()
      container.replaceChildren()
    },
  }
}
