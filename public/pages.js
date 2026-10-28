import {
  el,
  link,
  urlFor,
  navigate,
  setTitle,
  createResource,
  createMenu,
  rangeMenu,
  every,
  keepFocus,
  stateBlock,
  errorBlock,
  banner,
  badge,
  joinMeta,
  statTile,
  statsSkeleton,
  linesSkeleton,
  skeleton,
  th,
  shareRows,
  card,
  pager,
  scanBlock,
  button,
  icon,
  spinner,
  getJson,
  postJson,
  fact,
  THEMES,
  currentTheme,
  setTheme,
} from './ui.js'
import { createUsage } from './usage.js'
import { renderMarkdown } from './markdown.js'
import { chatLink, projectLink, openChat, openProject } from './panels.js'

const REFRESH_MS = 30000
const SEARCH_MS = 300
const CONVERSATION_SORTS = [
  { key: 'lastActive:desc', label: 'Last active' },
  { key: 'tokens:desc', label: 'Most tokens' },
  { key: 'tokens:asc', label: 'Fewest tokens' },
  { key: 'started:desc', label: 'Newest' },
  { key: 'started:asc', label: 'Oldest' },
]
const MARKET_SORTS = [
  { key: 'installs', label: 'Most installed' },
  { key: 'updated', label: 'Recently updated' },
  { key: 'name', label: 'Name' },
]
const PROJECT_SORTS = [
  { key: 'tokens:desc', label: 'Most tokens' },
  { key: 'lastActive:desc', label: 'Last active' },
  { key: 'conversations:desc', label: 'Most conversations' },
  { key: 'name:asc', label: 'Name' },
]

function pageShell(container, { title, intro }) {
  const actions = el('div', { class: 'page-actions' })
  const body = el('div', { class: 'page-body' })
  container.replaceChildren(el('div', { class: 'page' }, el('header', { class: 'page-head' }, el('div', { class: 'page-heading' }, el('h1', { class: 'page-title' }, title), intro ? el('p', { class: 'page-intro' }, intro) : null), actions), body))
  return { actions, body }
}

function paramsOf(query, keys) {
  const result = {}
  for (const key of keys) if (query.get(key)) result[key] = query.get(key)
  return result
}

function rangeParams(query) {
  const range = query.get('range')
  if (!range) return {}
  return range === 'custom' ? { range, from: query.get('from'), to: query.get('to') } : { range }
}

function apiQuery(params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value)
  return search.toString()
}

function tableSkeleton(columns = 5) {
  return el(
    'div',
    { class: 'table-wrap' },
    el('table', { class: 'table' }, el('tbody', null, [0, 1, 2, 3, 4, 5].map(() => el('tr', null, Array.from({ length: columns }, (_, column) => el('td', null, skeleton(`line ${column ? 'w-60' : 'w-80'}`))))))),
  )
}

function rowLink(open, focusKey, cells) {
  return el(
    'tr',
    {
      class: 'row-link',
      tabindex: '0',
      'data-focus': focusKey,
      onclick: (event) => {
        if (event.target.closest('a')) return
        open()
      },
      onkeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      },
    },
    cells,
  )
}

function modelsTable(models) {
  return el(
    'div',
    { class: 'table-wrap flat' },
    el(
      'table',
      { class: 'table' },
      el('thead', null, el('tr', null, th('Model'), th('Input', 'num'), th('Cache write', 'num'), th('Cache read', 'num'), th('Output', 'num'), th('Total', 'num'))),
      el(
        'tbody',
        null,
        models.map((model) =>
          el(
            'tr',
            null,
            el('td', null, el('div', { class: 'cell-title' }, model.label), el('div', { class: 'meta' }, model.callsLabel)),
            el('td', { class: 'num' }, model.inputLabel),
            el('td', { class: 'num' }, model.cacheWriteLabel),
            el('td', { class: 'num' }, model.cacheReadLabel),
            el('td', { class: 'num' }, model.outputLabel),
            el('td', { class: 'num strong' }, model.totalTokensLabel),
          ),
        ),
      ),
    ),
  )
}

export function barChart(chart, { label, onSelect }) {
  if (!chart.bars.length) return el('p', { class: 'meta' }, 'Nothing to chart yet.')
  const tooltip = el('div', { class: 'tooltip', role: 'status', hidden: true })
  const plot = el('div', { class: 'chart-plot', role: 'list', 'aria-label': label })
  const wrap = el('div', { class: 'chart' }, el('span', { class: 'chart-max' }, chart.maxLabel), plot, tooltip)
  const show = (bar, node) => {
    tooltip.replaceChildren(el('span', { class: 'tooltip-title' }, bar.title), el('span', { class: 'tooltip-value' }, bar.valueLabel))
    tooltip.hidden = false
    const box = wrap.getBoundingClientRect()
    const target = node.getBoundingClientRect()
    const center = target.left + target.width / 2 - box.left
    tooltip.style.setProperty('left', `${Math.min(Math.max(center, 90), Math.max(90, box.width - 90))}px`)
  }
  const hide = () => {
    tooltip.hidden = true
  }
  for (const bar of chart.bars) {
    const node = el(
      onSelect ? 'button' : 'div',
      {
        class: 'bar',
        type: onSelect ? 'button' : null,
        role: onSelect ? null : 'listitem',
        tabindex: onSelect ? null : '0',
        'aria-label': `${bar.title}: ${bar.valueLabel}`,
        onmouseenter: (event) => show(bar, event.currentTarget),
        onfocus: (event) => show(bar, event.currentTarget),
        onmouseleave: hide,
        onblur: hide,
        onclick: onSelect ? () => onSelect(bar) : null,
      },
      el('span', { class: bar.tokens > 0 ? 'bar-fill' : 'bar-fill is-zero', style: { height: `${bar.value * 100}%` } }),
    )
    plot.append(onSelect ? el('div', { role: 'listitem', class: 'bar-item' }, node) : node)
  }
  wrap.append(el('div', { class: 'chart-axis' }, el('span', null, chart.firstLabel), el('span', null, chart.lastLabel)))
  return wrap
}

function overviewContent(data) {
  const stats = data.stats
  const conversations = data.topConversations.length
    ? el(
        'ul',
        { class: 'rank-list' },
        data.topConversations.map((row) =>
          el(
            'li',
            null,
            chatLink(
              row.id,
              null,
              { class: 'rank-item', 'data-focus': `top-${row.id}` },
              el('span', { class: 'rank-main' }, el('span', { class: 'rank-title' }, row.title), el('span', { class: 'rank-meta' }, joinMeta([row.projectLabel, row.lastActiveLabel]))),
              el('span', { class: 'rank-value' }, row.tokensLabel),
            ),
          ),
        ),
      )
    : el('p', { class: 'meta' }, 'No conversation used tokens in this date range.')
  const projects = data.projects.length
    ? el(
        'ul',
        { class: 'rank-list' },
        data.projects.map((row) =>
          el(
            'li',
            null,
            projectLink(
              row.project,
              { class: 'rank-item', 'data-focus': `project-${row.project}` },
              el('span', { class: 'rank-main' }, el('span', { class: 'rank-title' }, row.name), el('span', { class: 'rank-meta' }, joinMeta([row.label, row.conversationsLabel]))),
              el('span', { class: 'rank-value' }, row.tokensLabel),
            ),
          ),
        ),
      )
    : el('p', { class: 'meta' }, 'No project has activity in this date range.')
  return [
    el('div', { class: 'stats' }, statTile('Tokens', stats.totalTokensLabel, stats.rangeLabel), statTile('Model calls', stats.callsLabel), statTile('Conversations', stats.conversationsLabel), statTile('Agents', stats.agentsLabel)),
    card(data.chart.title, barChart(data.chart, { label: data.chart.title })),
    el(
      'div',
      { class: 'grid-2' },
      card('Tokens by type', [shareRows(data.tokens), el('p', { class: 'note' }, 'Each model call re-reads the conversation from the cache, so cache reads are usually most of the tokens.')]),
      card('Models', data.models.length ? modelsTable(data.models) : el('p', { class: 'meta' }, 'No model calls in this date range.')),
    ),
    el(
      'div',
      { class: 'grid-2' },
      card('Conversations with the most tokens', conversations, data.conversationCount > conversations.childElementCount ? link(urlFor({ view: 'conversations', sort: 'tokens', dir: 'desc', ...rangeParamsFromData(data) }), { class: 'text-link' }, 'See all') : null),
      card('Projects with the most tokens', projects, data.projectCount > data.projects.length ? link(urlFor({ view: 'projects', ...rangeParamsFromData(data) }), { class: 'text-link' }, 'See all') : null),
    ),
  ]
}

function rangeParamsFromData(data) {
  if (!data.range || data.range.key === 'all') return {}
  return data.range.key === 'custom' ? { range: 'custom', from: data.range.from, to: data.range.to } : { range: data.range.key }
}

function overviewSkeleton() {
  return [statsSkeleton(), el('section', { class: 'card' }, skeleton('line w-30'), el('div', { class: 'chart-skeleton' }, skeleton('block'))), el('div', { class: 'grid-2' }, el('section', { class: 'card' }, linesSkeleton(4)), el('section', { class: 'card' }, linesSkeleton(4)))]
}

export function analyticsPage(container, params) {
  let query = params
  setTitle('Analytics')
  const shell = pageShell(container, { title: 'Analytics', intro: 'How many tokens your Claude Code conversations used.' })
  const rangeHolder = el('div', { class: 'menu' })
  shell.actions.append(rangeHolder)
  const range = rangeMenu(rangeHolder, { onChange: (next) => navigate(urlFor({ view: 'analytics', ...next })) })
  const resource = createResource(() => `/api/overview?${apiQuery(rangeParams(query))}`, render)
  function render(state) {
    const body = shell.body
    body.classList.toggle('is-refreshing', state.status === 'refreshing')
    if (state.status === 'loading' || (state.status === 'refreshing' && !state.data)) return body.replaceChildren(...overviewSkeleton())
    if (state.status === 'scanning') return body.replaceChildren(scanBlock(state.scan), ...overviewSkeleton())
    if (state.status === 'error') return body.replaceChildren(errorBlock('Could not load the overview', state.error, () => resource.load()))
    const data = state.data
    range.render(query, data.range)
    if (!data.sessionsOnMachine) return body.replaceChildren(stateBlock({ title: 'No Claude Code conversations found', text: data.firstRunMessage }))
    if (!data.conversationCount) {
      return body.replaceChildren(stateBlock({ title: 'No activity in this date range', text: `Nothing ran in ${data.range.description}.`, actions: [button('Show all time', () => navigate(urlFor({ view: 'analytics' })))] }))
    }
    keepFocus(body, () => body.replaceChildren(...[state.refreshError ? banner(`${state.refreshError} Showing the last data.`) : null, ...overviewContent(data)].filter(Boolean)))
  }
  range.render(query, null)
  resource.load()
  const stop = every(REFRESH_MS, () => {
    if (resource.state.status === 'ready') resource.load({ silent: true })
  })
  return {
    update(next) {
      query = next
      range.render(query, null)
      resource.load()
    },
    destroy() {
      stop()
      resource.cancel()
      range.close()
    },
  }
}

function searchInput(placeholder, value, onSearch) {
  let timer = null
  const input = el('input', { class: 'input search', type: 'search', placeholder, 'aria-label': placeholder, autocomplete: 'off', spellcheck: 'false', value })
  input.addEventListener('input', () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => onSearch(input.value.trim()), SEARCH_MS)
  })
  return {
    node: input,
    sync(next) {
      window.clearTimeout(timer)
      if (input.value.trim() !== next) input.value = next
    },
    stop: () => window.clearTimeout(timer),
  }
}

function listPage(container, params, config) {
  let query = params
  setTitle(config.title)
  const shell = pageShell(container, { title: config.title, intro: config.intro })
  const rangeHolder = el('div', { class: 'menu' })
  const sortHolder = el('div', { class: 'menu' })
  const search = searchInput(config.searchLabel, query.get('q') || '', (value) => go({ q: value || null, page: null }, true))
  const chips = el('div', { class: 'chips' })
  const summary = el('p', { class: 'page-meta' })
  const list = el('div')
  shell.body.append(el('div', { class: 'toolbar' }, rangeHolder, search.node, sortHolder), chips, summary, list)
  const range = rangeMenu(rangeHolder, { onChange: (next) => go({ ...next, page: null }) })
  const sort = createMenu(sortHolder, {
    label: config.sortLabel,
    align: 'end',
    onSelect: (key) => {
      const [field, dir] = key.split(':')
      go({ sort: field, dir, page: null })
    },
  })
  function current() {
    return { view: config.view, ...paramsOf(query, config.params) }
  }
  function go(changes, replace) {
    navigate(urlFor({ ...current(), ...changes }), { replace })
  }
  function renderControls(data) {
    range.render(query, data && data.range)
    const key = `${query.get('sort') || config.defaultSort.split(':')[0]}:${query.get('dir') || config.defaultSort.split(':')[1]}`
    const selected = config.sorts.find((entry) => entry.key === key) || config.sorts[0]
    sort.render(selected.label, config.sorts, selected.key)
    search.sync(query.get('q') || '')
  }
  const resource = createResource(() => `${config.api}?${apiQuery({ ...paramsOf(query, config.params), view: null })}`, render)
  function render(state) {
    list.classList.toggle('is-refreshing', state.status === 'refreshing')
    if (state.status === 'loading' || (state.status === 'refreshing' && !state.data)) {
      summary.textContent = ''
      return list.replaceChildren(tableSkeleton(config.columns))
    }
    if (state.status === 'scanning') return list.replaceChildren(scanBlock(state.scan), tableSkeleton(config.columns))
    if (state.status === 'error') return list.replaceChildren(errorBlock(`Could not load the ${config.noun}`, state.error, () => resource.load()))
    const data = state.data
    renderControls(data)
    chips.replaceChildren(...config.chips(data, go))
    summary.textContent = config.summary(data)
    if (!data.sessionsOnMachine && !data.filtered) return list.replaceChildren(stateBlock({ title: 'No Claude Code conversations found', text: data.firstRunMessage }))
    if (!data.rows.length) {
      return list.replaceChildren(
        stateBlock({
          title: `No ${config.noun} match`,
          text: query.get('q') ? `Nothing in this date range matches “${query.get('q')}”.` : `No ${config.noun} have activity in this date range.`,
          actions: [button('Clear filters', () => navigate(urlFor({ view: config.view })))],
        }),
      )
    }
    keepFocus(list, () =>
      list.replaceChildren(
        ...[
          state.refreshError ? banner(`${state.refreshError} Showing the last data.`) : null,
          config.table(data.rows),
          pager(data, (page) => {
            go({ page: page > 1 ? page : null })
            document.getElementById('scroller').scrollTop = 0
          }),
        ].filter(Boolean),
      ),
    )
  }
  renderControls(null)
  resource.load()
  const stop = every(REFRESH_MS, () => {
    if (resource.state.status === 'ready') resource.load({ silent: true })
  })
  return {
    update(next) {
      query = next
      renderControls(resource.state.data)
      resource.load()
    },
    destroy() {
      stop()
      search.stop()
      resource.cancel()
      range.close()
      sort.close()
    },
  }
}

function conversationsTable(rows) {
  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      { class: 'table' },
      el('thead', null, el('tr', null, th('Conversation'), th('Models'), th('Agents', 'num'), th('Last active'), th('Tokens', 'num'))),
      el(
        'tbody',
        null,
        rows.map((row) =>
          rowLink(() => openChat(row.id), `row-${row.id}`, [
            el('td', null, el('div', { class: 'cell-title' }, chatLink(row.id, null, { class: 'cell-link', tabindex: '-1' }, row.title), row.live ? badge(row.status, row.statusLabel) : null), el('div', { class: 'meta' }, row.projectLabel)),
            el('td', { class: 'meta' }, row.modelsLabel),
            el('td', { class: 'num' }, String(row.agentCount)),
            el('td', { class: 'nowrap' }, row.lastActiveLabel),
            el('td', { class: 'num strong' }, row.totalTokensLabel),
          ]),
        ),
      ),
    ),
  )
}

export function conversationsPage(container, params) {
  return listPage(container, params, {
    view: 'conversations',
    title: 'Conversations',
    intro: 'Every Claude Code conversation on this computer. Open one to see each step and its tokens.',
    noun: 'conversations',
    api: '/api/sessions',
    params: ['range', 'from', 'to', 'q', 'sort', 'dir', 'page', 'project'],
    searchLabel: 'Search titles, folders and your messages',
    sortLabel: 'Sort conversations',
    sorts: CONVERSATION_SORTS,
    defaultSort: 'lastActive:desc',
    columns: 5,
    summary: (data) => data.summary.line,
    chips: (data, go) => (data.project ? [el('span', { class: 'chip' }, el('span', null, `Project: ${data.project.label}`), el('button', { class: 'chip-clear', type: 'button', 'aria-label': 'Show all projects', onclick: () => go({ project: null, page: null }) }, 'Clear'))] : []),
    table: conversationsTable,
  })
}

function projectsTable(rows) {
  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      { class: 'table' },
      el('thead', null, el('tr', null, th('Project'), th('Conversations', 'num'), th('Agents', 'num'), th('Last active'), th('Tokens', 'num'))),
      el(
        'tbody',
        null,
        rows.map((row) =>
          rowLink(() => openProject(row.project), `project-${row.project}`, [
            el('td', null, el('div', { class: 'cell-title' }, row.name, row.live ? badge('busy', `${row.live} running`) : null), el('div', { class: 'meta' }, row.label)),
            el('td', { class: 'num' }, String(row.conversations)),
            el('td', { class: 'num' }, String(row.agents)),
            el('td', { class: 'nowrap' }, row.lastActiveLabel),
            el('td', { class: 'num strong' }, row.totalTokensLabel),
          ]),
        ),
      ),
    ),
  )
}

export function projectsPage(container, params) {
  return listPage(container, params, {
    view: 'projects',
    title: 'Projects',
    intro: 'Your conversations grouped by the folder they ran in. Open a project to see its conversations.',
    noun: 'projects',
    api: '/api/projects',
    params: ['range', 'from', 'to', 'q', 'sort', 'dir', 'page'],
    searchLabel: 'Search by folder',
    sortLabel: 'Sort projects',
    sorts: PROJECT_SORTS,
    defaultSort: 'tokens:desc',
    columns: 5,
    summary: (data) => data.summary.line,
    chips: () => [],
    table: projectsTable,
  })
}

function rememberFocus() {
  const active = document.activeElement
  const key = active && active.getAttribute ? active.getAttribute('data-focus') : null
  return () => {
    const target = active && document.contains(active) ? active : key ? document.querySelector(`[data-focus="${CSS.escape(key)}"]`) : null
    if (target) target.focus({ preventScroll: true })
  }
}

function skillCards(rows, open) {
  return el(
    'div',
    { class: 'plugin-grid' },
    rows.map((row) =>
      el(
        'button',
        { class: row.off ? 'plugin-card skill-card is-off' : 'plugin-card skill-card', type: 'button', 'aria-haspopup': 'dialog', 'data-focus': `skill-${row.id}`, onclick: () => open(row) },
        el('span', { class: 'plugin-head' }, el('span', { class: 'plugin-name' }, row.name), row.off ? badge('stopped', 'Plugin off') : null),
        row.description ? el('span', { class: 'plugin-desc' }, row.description) : null,
        el('span', { class: 'meta' }, row.sourceLabel),
        el('span', { class: 'plugin-parts' }, row.statsLabel),
      ),
    ),
  )
}

function createSkillPanel(onEdited) {
  let current = null
  let request = 0
  const meta = el('p', { class: 'meta' })
  const title = el('h2', { class: 'slideover-title', id: 'skill-panel-title' })
  const close = el('button', { class: 'icon-button', type: 'button', 'aria-label': 'Close the skill', onclick: () => hide() }, icon('close'))
  const body = el('div', { class: 'slideover-body scroll-area' })
  const foot = el('div', { class: 'skill-foot' })
  const backdrop = el('div', { class: 'slideover-backdrop', hidden: true, onclick: () => hide() })
  const panel = el('aside', { class: 'slideover skill-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'skill-panel-title', hidden: true }, el('div', { class: 'slideover-head' }, el('div', { class: 'slideover-heading' }, meta, title), close), body, foot)
  let restore = null
  document.body.append(backdrop, panel)

  const input = el('textarea', { class: 'composer-input', rows: '2', 'aria-label': 'What Claude should change in this skill', placeholder: 'Tell Claude what to change in this skill', spellcheck: 'true' })
  const send = el('button', { class: 'button primary small', type: 'submit' }, 'Send')
  const error = el('p', { class: 'composer-error', role: 'alert', hidden: true })
  const composer = el(
    'form',
    {
      class: 'composer',
      onsubmit: (event) => {
        event.preventDefault()
        submit()
      },
    },
    el('div', { class: 'composer-box' }, input, el('div', { class: 'composer-actions' }, send)),
    error,
  )
  input.addEventListener('input', () => {
    input.style.setProperty('height', 'auto')
    input.style.setProperty('height', `${Math.min(input.scrollHeight, 200)}px`)
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      submit()
    }
  })

  function thread() {
    if (!current.messages.length && !current.busy) return null
    return el(
      'section',
      { class: 'skill-thread', 'aria-label': 'Edits with Claude' },
      current.messages.map((message) =>
        el('div', { class: `skill-msg is-${message.role}` }, el('span', { class: 'skill-msg-who' }, message.role === 'you' ? 'You' : message.role === 'claude' ? 'Claude' : 'Error'), message.role === 'claude' ? el('div', { class: 'md' }, renderMarkdown(message.text)) : el('p', { class: 'skill-msg-text' }, message.text)),
      ),
      current.busy ? el('p', { class: 'live-line' }, spinner(), el('span', { class: 'live-text' }, el('span', { class: 'live-label' }, 'Claude is working on this skill'))) : null,
    )
  }

  function render() {
    const detail = current.detail
    if (!detail) {
      body.replaceChildren(linesSkeleton(6))
      foot.replaceChildren()
      return
    }
    body.replaceChildren(
      ...[
        detail.description ? el('p', { class: 'skill-summary' }, detail.description) : null,
        el('p', { class: 'meta skill-path' }, detail.folderLabel),
        detail.content ? el('div', { class: 'md skill-content' }, renderMarkdown(detail.content)) : el('p', { class: 'meta' }, 'SKILL.md has no instructions yet.'),
        detail.files.length ? el('section', { class: 'skill-files' }, el('h3', { class: 'skill-files-title' }, 'Other files'), el('ul', null, detail.files.map((file) => el('li', null, file)))) : null,
        thread(),
      ].filter(Boolean),
    )
    send.disabled = current.busy
    input.disabled = current.busy
    foot.replaceChildren(detail.editable ? composer : el('p', { class: 'note skill-locked' }, detail.lockedNote))
  }

  async function load(id) {
    const mine = ++request
    try {
      const detail = await getJson(`/api/skill?${new URLSearchParams({ id })}`)
      if (mine !== request || !current) return
      current.detail = detail
      if (detail.busy) current.busy = true
    } catch (reason) {
      if (mine !== request || !current) return
      body.replaceChildren(errorBlock('Could not load this skill', reason.message, () => load(id)))
      return
    }
    render()
  }

  async function submit() {
    const message = input.value.trim()
    if (!current || current.busy || !message) return
    const target = current
    target.messages.push({ role: 'you', text: message })
    target.busy = true
    input.value = ''
    input.style.removeProperty('height')
    error.hidden = true
    render()
    body.scrollTop = body.scrollHeight
    try {
      const result = await postJson('/api/skills/edit', { id: target.id, message, session: target.session })
      target.session = result.session || target.session
      target.messages.push({ role: 'claude', text: result.reply || 'Done.' })
      if (result.skill) target.detail = result.skill
      onEdited()
    } catch (reason) {
      target.messages.push({ role: 'error', text: reason.message })
    }
    target.busy = false
    if (current !== target) return
    render()
    body.scrollTop = body.scrollHeight
    input.focus({ preventScroll: true })
  }

  function hide() {
    if (panel.hidden) return
    request++
    current = null
    panel.hidden = true
    backdrop.hidden = true
    body.replaceChildren()
    if (restore) restore()
    restore = null
  }

  const onKey = (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || panel.hidden) return
    event.preventDefault()
    hide()
  }
  window.addEventListener('keydown', onKey)

  return {
    open(row) {
      if (panel.hidden) restore = rememberFocus()
      current = { id: row.id, detail: null, session: null, messages: [], busy: false }
      title.textContent = row.name
      meta.textContent = row.sourceLabel
      backdrop.hidden = false
      panel.hidden = false
      error.hidden = true
      render()
      load(row.id)
      close.focus({ preventScroll: true })
    },
    destroy() {
      request++
      window.removeEventListener('keydown', onKey)
      backdrop.remove()
      panel.remove()
    },
  }
}

function pluginGrid(rows) {
  return el(
    'div',
    { class: 'plugin-grid' },
    rows.map((row) =>
      el(
        'article',
        { class: row.on === false ? 'plugin-card is-off' : 'plugin-card' },
        el('div', { class: 'plugin-head' }, el('h3', { class: 'plugin-name' }, row.name), row.statusLabel ? badge(row.on ? 'working' : 'stopped', row.statusLabel) : null),
        row.description ? el('p', { class: 'plugin-desc', title: row.description }, row.description) : null,
        el('p', { class: 'plugin-parts' }, row.partsLabel),
        el('p', { class: 'meta' }, row.metaLabel),
      ),
    ),
  )
}

function extensionPage(container, params, config) {
  let query = params
  let menu = null
  setTitle(config.title)
  const shell = pageShell(container, { title: config.title, intro: config.intro })
  if (config.actions) shell.actions.append(...config.actions)
  const resource = createResource(() => `${config.api}?${apiQuery({ account: query.get('account') })}`, render)
  function section(title, note, extra, content) {
    return el('section', { class: 'ext-section' }, el('div', { class: 'ext-head' }, el('div', { class: 'ext-heading' }, el('h2', { class: 'ext-title' }, title), el('p', { class: 'meta' }, note)), extra), content)
  }
  function accountMenu(data) {
    if (menu) menu.close()
    menu = null
    if (!data.accounts.length) return null
    const holder = el('div', { class: 'menu' })
    const items = [{ key: 'all', label: 'All accounts' }, ...data.accounts]
    const selected = data.account || 'all'
    menu = createMenu(holder, { label: 'Account', align: 'end', onSelect: (key) => navigate(urlFor({ view: config.view, account: key === 'all' ? null : key })) })
    menu.render(items.find((item) => item.key === selected).label, items, selected)
    return holder
  }
  function render(state) {
    const body = shell.body
    body.classList.toggle('is-refreshing', state.status === 'refreshing')
    if (state.status === 'loading' || (state.status === 'refreshing' && !state.data)) return body.replaceChildren(linesSkeleton(4))
    if (state.status === 'scanning') return body.replaceChildren(scanBlock(state.scan), linesSkeleton(4))
    if (state.status === 'error') return body.replaceChildren(errorBlock(`Could not load the ${config.noun}`, state.error, () => resource.load()))
    const data = state.data
    keepFocus(body, () =>
      body.replaceChildren(
        ...[
          data.summaryLabel ? el('p', { class: 'page-meta' }, data.summaryLabel) : null,
          section('On this computer', config.localNote, null, data.local.length ? config.list(data.local) : el('p', { class: 'meta' }, config.localEmpty)),
          data.hasAccounts
            ? section('Synced from claude.ai', config.syncedNote, accountMenu(data), data.synced.length ? config.list(data.synced) : el('p', { class: 'meta' }, data.account ? 'Nothing is synced for this account.' : `No ${config.noun} synced from claude.ai yet.`))
            : null,
        ].filter(Boolean),
      ),
    )
  }
  resource.load()
  return {
    update(next) {
      query = next
      resource.load()
    },
    reload: () => resource.load({ silent: true }),
    destroy() {
      resource.cancel()
      if (menu) menu.close()
    },
  }
}

export function skillsPage(container, params) {
  const panel = createSkillPanel(() => page.reload())
  const page = extensionPage(container, params, {
    view: 'skills',
    title: 'Skills',
    intro: 'Every skill Claude Code can use, how often you used it, and how many tokens it takes. Claude Code adds the name and description of each skill to every conversation.',
    noun: 'skills',
    api: '/api/skills',
    localNote: 'Your own skills, and the skills that come with your plugins.',
    localEmpty: 'No skills in your Claude folders yet.',
    syncedNote: 'Skills from your claude.ai account. Claude Code keeps a copy on this computer.',
    list: (rows) => skillCards(rows, panel.open),
  })
  return {
    update: page.update,
    destroy() {
      page.destroy()
      panel.destroy()
    },
  }
}

function marketCards(rows, open) {
  return el(
    'div',
    { class: 'plugin-grid' },
    rows.map((row) =>
      el(
        'button',
        { class: 'plugin-card skill-card', type: 'button', 'data-focus': `market-${row.id}`, onclick: () => open(row.id) },
        el('span', { class: 'plugin-head' }, el('span', { class: 'plugin-name' }, row.title), row.stateLabel ? badge(row.on ? 'working' : 'stopped', row.stateLabel) : null),
        row.description ? el('span', { class: 'plugin-desc' }, row.description) : null,
        el('span', { class: 'meta' }, row.metaLabel),
        row.statsLabel ? el('span', { class: 'plugin-parts' }, row.statsLabel) : null,
      ),
    ),
  )
}

function createMarketPanel(onChanged) {
  const query = { q: '', category: '', sort: 'installs', page: 1 }
  let view = 'browse'
  let detail = null
  let detailRequest = 0
  let notice = null
  let busy = null
  const meta = el('p', { class: 'meta' })
  const title = el('h2', { class: 'slideover-title', id: 'market-title' }, 'Marketplace')
  const switchButton = el('button', { class: 'button small', type: 'button', 'data-focus': 'market-switch', onclick: () => show(view === 'sources' ? 'browse' : 'sources') }, 'Marketplaces')
  const close = el('button', { class: 'icon-button', type: 'button', 'aria-label': 'Close the marketplace', onclick: () => hide() }, icon('close'))
  const body = el('div', { class: 'slideover-body scroll-area' })
  const backdrop = el('div', { class: 'slideover-backdrop', hidden: true, onclick: () => hide() })
  let restore = null
  const panel = el('aside', { class: 'slideover market-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'market-title', hidden: true }, el('div', { class: 'slideover-head' }, el('div', { class: 'slideover-heading' }, meta, title), el('div', { class: 'market-head-actions' }, switchButton, close)), body)
  document.body.append(backdrop, panel)

  const reload = () => {
    query.page = 1
    list.load()
  }
  const search = searchInput('Search plugins', '', (value) => {
    query.q = value
    reload()
  })
  const categoryHolder = el('div', { class: 'menu' })
  const sortHolder = el('div', { class: 'menu' })
  const categoryMenu = createMenu(categoryHolder, {
    label: 'Category',
    onSelect: (key) => {
      query.category = key === 'all' ? '' : key
      reload()
    },
  })
  const sortMenu = createMenu(sortHolder, {
    label: 'Sort plugins',
    align: 'end',
    onSelect: (key) => {
      query.sort = key
      reload()
    },
  })
  const browseNotice = el('div')
  const results = el('div', { class: 'market-results' })
  const browseView = el('div', { class: 'market-view' }, el('div', { class: 'toolbar' }, search.node, categoryHolder, sortHolder), browseNotice, results)
  const sourceInput = el('input', { class: 'input', type: 'text', placeholder: 'owner/repo, a URL or a folder path', 'aria-label': 'Marketplace to add', autocomplete: 'off', spellcheck: 'false' })
  const addForm = el(
    'form',
    {
      class: 'market-add',
      onsubmit: (event) => {
        event.preventDefault()
        if (sourceInput.value.trim()) run({ action: 'marketplace-add', source: sourceInput.value.trim() })
      },
    },
    sourceInput,
    el('button', { class: 'button primary', type: 'submit' }, 'Add marketplace'),
  )
  const list = createResource(() => `/api/marketplace?${apiQuery({ q: query.q, category: query.category, sort: query.sort, page: query.page > 1 ? String(query.page) : null })}`, () => {
    if (!panel.hidden) render()
  })

  function noticeNode() {
    if (!notice) return null
    if (notice.tone === 'busy') return el('p', { class: 'live-line' }, spinner(), el('span', { class: 'live-text' }, el('span', { class: 'live-label' }, notice.text)))
    return el('p', { class: `market-notice is-${notice.tone}`, role: notice.tone === 'error' ? 'alert' : 'status' }, notice.text)
  }

  async function run(payload) {
    if (busy) return
    if ((payload.action === 'uninstall' || payload.action === 'marketplace-remove') && !window.confirm(payload.action === 'uninstall' ? 'Uninstall this plugin from Claude Code?' : `Remove the ${payload.name} marketplace from Claude Code?`)) return
    busy = payload.action
    notice = { tone: 'busy', text: 'Claude Code is working on it' }
    render()
    try {
      const result = await postJson('/api/marketplace/action', payload)
      notice = { tone: 'ok', text: result.message }
      if (payload.action === 'marketplace-add') sourceInput.value = ''
      onChanged()
    } catch (error) {
      notice = { tone: 'error', text: error.message }
    }
    busy = null
    if (view === 'detail' && detail && !detail.error) await loadDetail(detail.id, true)
    await list.load({ silent: true })
    render()
  }

  function actionButton(label, action, primary) {
    return el('button', { class: primary ? 'button primary' : 'button', type: 'button', disabled: Boolean(busy), 'data-focus': `act-${action}`, onclick: () => run({ action, id: detail.id }) }, label)
  }

  function renderBrowse() {
    if (body.firstChild !== browseView) body.replaceChildren(browseView)
    browseNotice.replaceChildren(...[noticeNode()].filter(Boolean))
    const state = list.state
    const data = state.data
    const categories = data ? data.categories : []
    const category = categories.find((entry) => entry.key === query.category)
    categoryMenu.render(category ? category.label : 'All categories', [{ key: 'all', label: 'All categories' }, ...categories], query.category || 'all')
    sortMenu.render(MARKET_SORTS.find((entry) => entry.key === query.sort).label, MARKET_SORTS, query.sort)
    results.classList.toggle('is-refreshing', state.status === 'refreshing')
    if (state.status === 'loading' || (state.status === 'refreshing' && !data)) return results.replaceChildren(linesSkeleton(6))
    if (state.status === 'error') return results.replaceChildren(errorBlock('Could not load the marketplace', state.error, () => list.load()))
    if (!data.rows.length) return results.replaceChildren(stateBlock({ title: 'No plugins match', text: query.q ? `Nothing matches “${query.q}”.` : 'No plugins in this category.' }))
    keepFocus(results, () =>
      results.replaceChildren(
        marketCards(data.rows, (id) => openDetail(id)),
        pager(data, (page) => {
          query.page = page
          list.load()
          body.scrollTop = 0
        }),
      ),
    )
  }

  function renderDetail() {
    const back = el('button', { class: 'button small market-back', type: 'button', 'data-focus': 'market-back', onclick: () => show('browse') }, icon('back'), 'All plugins')
    if (!detail) return body.replaceChildren(back, linesSkeleton(6))
    if (detail.error) return body.replaceChildren(back, errorBlock('Could not load this plugin', detail.error, () => loadDetail(detail.id)))
    const actions = detail.installed ? [detail.on ? actionButton('Turn off', 'disable') : actionButton('Turn on', 'enable', true), actionButton('Uninstall', 'uninstall')] : [actionButton('Install', 'install', true)]
    keepFocus(body, () =>
      body.replaceChildren(
        back,
        el(
          'div',
          { class: 'market-detail' },
          el('div', { class: 'market-title-row' }, el('h3', { class: 'market-name' }, detail.title), detail.stateLabel ? badge(detail.on ? 'working' : 'stopped', detail.stateLabel) : null),
          el('p', { class: 'meta' }, detail.metaLabel),
          detail.description ? el('p', { class: 'market-desc' }, detail.description) : null,
          el('div', { class: 'market-actions' }, ...actions, detail.homepage ? el('a', { class: 'text-link', href: detail.homepage, target: '_blank', rel: 'noopener noreferrer' }, 'Homepage') : null),
          noticeNode(),
          detail.facts.length ? el('dl', { class: 'facts' }, detail.facts.map(([label, value]) => fact(label, value))) : null,
          detail.groups.map(([label, names]) => el('section', { class: 'market-group' }, el('h4', { class: 'market-group-title' }, `${label} (${names.length})`), el('ul', { class: 'market-chips' }, names.map((name) => el('li', null, name))))),
        ),
      ),
    )
  }

  function renderSources() {
    const data = list.state.data
    keepFocus(body, () =>
      body.replaceChildren(
        ...[
          noticeNode(),
          data
            ? el(
                'ul',
                { class: 'folder-list' },
                data.markets.map((market) =>
                  el(
                    'li',
                    { class: 'folder-row market-source' },
                    el('span', { class: 'market-source-main' }, el('span', { class: 'market-source-name' }, market.name), el('span', { class: 'meta' }, joinMeta([market.sourceLabel, market.countLabel, market.updatedLabel]))),
                    el(
                      'span',
                      { class: 'market-actions' },
                      el('button', { class: 'button small', type: 'button', disabled: Boolean(busy), 'data-focus': `update-${market.name}`, onclick: () => run({ action: 'marketplace-update', name: market.name }) }, 'Update'),
                      el('button', { class: 'button small', type: 'button', disabled: Boolean(busy), 'data-focus': `remove-${market.name}`, onclick: () => run({ action: 'marketplace-remove', name: market.name }) }, 'Remove'),
                    ),
                  ),
                ),
              )
            : linesSkeleton(3),
          addForm,
        ].filter(Boolean),
      ),
    )
  }

  function render() {
    const data = list.state.data
    meta.textContent = data ? data.summaryLabel : 'Plugins from your marketplaces'
    switchButton.textContent = view === 'sources' ? 'Plugins' : 'Marketplaces'
    switchButton.hidden = view === 'detail'
    title.textContent = view === 'sources' ? 'Marketplaces' : 'Marketplace'
    if (view === 'detail') return renderDetail()
    if (view === 'sources') return renderSources()
    return renderBrowse()
  }

  async function loadDetail(id, silent) {
    const mine = ++detailRequest
    if (!silent) {
      detail = null
      render()
    }
    try {
      const data = await getJson(`/api/marketplace/plugin?${new URLSearchParams({ id })}`)
      if (mine === detailRequest) detail = data
    } catch (error) {
      if (mine === detailRequest) detail = { id, error: error.message }
    }
    if (mine === detailRequest && !silent) render()
  }

  function openDetail(id) {
    view = 'detail'
    notice = null
    body.scrollTop = 0
    loadDetail(id)
  }

  function show(next) {
    view = next
    notice = null
    detailRequest++
    render()
  }

  function hide() {
    if (panel.hidden) return
    panel.hidden = true
    backdrop.hidden = true
    categoryMenu.close()
    sortMenu.close()
    if (restore) restore()
    restore = null
  }

  const onKey = (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || panel.hidden) return
    event.preventDefault()
    if (view === 'detail') show('browse')
    else hide()
  }
  window.addEventListener('keydown', onKey)

  return {
    open() {
      if (panel.hidden) restore = rememberFocus()
      view = 'browse'
      notice = null
      backdrop.hidden = false
      panel.hidden = false
      render()
      list.load({ silent: Boolean(list.state.data) })
      if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) search.node.focus({ preventScroll: true })
      else close.focus({ preventScroll: true })
    },
    destroy() {
      list.cancel()
      search.stop()
      categoryMenu.close()
      sortMenu.close()
      window.removeEventListener('keydown', onKey)
      backdrop.remove()
      panel.remove()
    },
  }
}

export function pluginsPage(container, params) {
  const market = createMarketPanel(() => page.reload())
  const page = extensionPage(container, params, {
    view: 'plugins',
    title: 'Plugins',
    intro: 'Plugins added to Claude Code and what each one brings. Find more, and install them, in the Marketplace.',
    noun: 'plugins',
    api: '/api/plugins',
    localNote: 'Installed from a marketplace.',
    localEmpty: 'No plugins installed yet. Open the Marketplace to add one.',
    syncedNote: 'Plugins from your claude.ai account.',
    list: pluginGrid,
    actions: [button('Marketplace', () => market.open(), 'primary')],
  })
  return {
    update: page.update,
    destroy() {
      page.destroy()
      market.destroy()
    },
  }
}

function settingsSection(title, intro, content) {
  return el('section', { class: 'settings-section' }, el('div', { class: 'settings-heading' }, el('h2', { class: 'settings-title' }, title), el('p', { class: 'settings-intro' }, intro)), content)
}

function foldersView(state) {
  if (state.status === 'loading') return linesSkeleton(3)
  if (state.status === 'error') return errorBlock('Could not load the folders', state.error, () => state.retry())
  const data = state.data
  if (!data.folders.length) return stateBlock({ title: 'No Claude Code folder found', text: 'Run Claude Code once, or start the dashboard with --config-dir <path> if your Claude folder is somewhere else.' })
  return [
    el(
      'ul',
      { class: 'folder-list' },
      data.folders.map((folder) => el('li', { class: 'folder-row' }, el('span', { class: 'folder-path' }, folder.label), el('span', { class: 'meta' }, joinMeta([folder.accountLabel, folder.projectsLabel])))),
    ),
    el('p', { class: 'note' }, data.scan.label),
  ]
}

export function settingsPage(container) {
  setTitle('Settings')
  const shell = pageShell(container, { title: 'Settings', intro: 'How the dashboard looks, your Claude accounts with their usage limits, and the folders it reads.' })
  const themes = el('div', { class: 'theme-choices', role: 'group', 'aria-label': 'Theme' })
  const accounts = el('div', { class: 'settings-accounts' })
  const folders = el('div', { class: 'card settings-card' })
  shell.body.append(
    settingsSection('Appearance', 'The theme is saved in this browser.', themes),
    settingsSection('Accounts and usage', 'Every Claude account signed in to Claude Code on this computer, with the usage limits Claude Code saved the last time it checked.', accounts),
    settingsSection('Claude folders', 'The Claude Code folders this dashboard reads. It never changes them.', folders),
  )
  function renderThemes() {
    const selected = currentTheme()
    themes.replaceChildren(
      ...THEMES.map((theme) =>
        el(
          'button',
          {
            class: `theme-choice${theme.key === selected ? ' is-selected' : ''}`,
            type: 'button',
            'aria-pressed': String(theme.key === selected),
            'data-focus': `theme-${theme.key}`,
            onclick: () => {
              setTheme(theme.key)
              keepFocus(themes, renderThemes)
            },
          },
          el('span', { class: `theme-preview theme-preview-${theme.key}`, 'aria-hidden': 'true' }, el('span', { class: 'theme-preview-line' }), el('span', { class: 'theme-preview-line short' })),
          el('span', { class: 'theme-name' }, theme.label),
          el('span', { class: 'theme-note' }, theme.note),
        ),
      ),
    )
  }
  renderThemes()
  const usage = createUsage(accounts, { emptyText: 'No Claude account is signed in to Claude Code on this computer.' })
  usage.start()
  const resource = createResource(
    () => '/api/settings',
    (state) => folders.replaceChildren(...[].concat(foldersView({ ...state, retry: () => resource.load() }))),
  )
  resource.load()
  const stop = every(REFRESH_MS, () => {
    if (resource.state.status === 'ready') resource.load({ silent: true })
  })
  return {
    update() {},
    destroy() {
      stop()
      usage.stop()
      resource.cancel()
    },
  }
}

export function notFoundPage(container) {
  setTitle('Page not found')
  const shell = pageShell(container, { title: 'Page not found', intro: 'This address does not match any page of the dashboard.' })
  shell.body.append(stateBlock({ title: 'Nothing here', text: 'The link may be old or mistyped.', actions: [link(urlFor({ view: 'overview' }), { class: 'button' }, 'Go to the overview')] }))
  return { update() {}, destroy() {} }
}
