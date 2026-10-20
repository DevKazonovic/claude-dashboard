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
  live,
  spinner,
  activityText,
  liveLine,
  THEMES,
  currentTheme,
  setTheme,
} from './ui.js'
import { createUsage } from './usage.js'

const REFRESH_MS = 30000
const SEARCH_MS = 300
const CONVERSATION_SORTS = [
  { key: 'lastActive:desc', label: 'Last active' },
  { key: 'tokens:desc', label: 'Most tokens' },
  { key: 'tokens:asc', label: 'Fewest tokens' },
  { key: 'started:desc', label: 'Newest' },
  { key: 'started:asc', label: 'Oldest' },
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

function conversationHref(id) {
  return urlFor({ session: id })
}

function tableSkeleton(columns = 5) {
  return el(
    'div',
    { class: 'table-wrap' },
    el('table', { class: 'table' }, el('tbody', null, [0, 1, 2, 3, 4, 5].map(() => el('tr', null, Array.from({ length: columns }, (_, column) => el('td', null, skeleton(`line ${column ? 'w-60' : 'w-80'}`))))))),
  )
}

function rowLink(href, focusKey, cells) {
  return el(
    'tr',
    {
      class: 'row-link',
      tabindex: '0',
      'data-focus': focusKey,
      onclick: (event) => {
        if (event.target.closest('a')) return
        navigate(href)
      },
      onkeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          navigate(href)
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
            link(
              conversationHref(row.id),
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
            link(
              urlFor({ view: 'conversations', project: row.project, ...rangeParamsFromData(data) }),
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

export function overviewPage(container, params) {
  let query = params
  setTitle('Overview')
  const shell = pageShell(container, { title: 'Overview', intro: 'How many tokens your Claude Code conversations used.' })
  const rangeHolder = el('div', { class: 'menu' })
  shell.actions.append(rangeHolder)
  const range = rangeMenu(rangeHolder, { onChange: (next) => navigate(urlFor({ view: 'overview', ...next })) })
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
      return body.replaceChildren(stateBlock({ title: 'No activity in this date range', text: `Nothing ran in ${data.range.description}.`, actions: [button('Show all time', () => navigate(urlFor({ view: 'overview' })))] }))
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

function liveCard(session) {
  return el(
    'article',
    { class: 'live-card' },
    el(
      'div',
      { class: 'live-row' },
      el(
        'div',
        { class: 'live-main' },
        link(conversationHref(session.id), { class: 'live-title', 'data-focus': `live-${session.id}` }, session.title),
        el('p', { class: session.accountKnown ? 'live-account' : 'live-account is-unknown' }, session.accountLabel),
        el('p', { class: 'meta' }, joinMeta([session.whereLabel, session.startedLabel])),
      ),
      el('div', { class: 'live-side' }, badge(session.status, session.statusLabel), el('span', { class: 'amount' }, session.tokensLabel)),
    ),
    session.activity ? liveLine(session.activity) : null,
    el('p', { class: 'meta' }, joinMeta([session.agentsLabel, session.modelsLabel])),
    session.workingAgentList.length ? el('ul', { class: 'working-list' }, session.workingAgentList.map((agent) => workingAgent(session, agent))) : null,
  )
}

function workingAgent(session, agent) {
  return el(
    'li',
    null,
    link(
      urlFor({ session: session.id, agent: agent.id }),
      { class: 'working-agent', 'data-focus': `working-${session.id}-${agent.id}` },
      spinner(),
      el('span', { class: 'working-main' }, el('span', { class: 'working-head' }, el('span', { class: 'working-type' }, agent.typeLabel), el('span', { class: 'working-desc' }, agent.description)), agent.activity ? activityText(agent.activity) : null),
      el('span', { class: 'amount small' }, agent.tokensLabel),
    ),
  )
}

function liveGroup(group) {
  return el(
    'section',
    { class: 'live-group' },
    el('div', { class: 'live-group-head' }, el('h2', { class: 'live-group-title' }, group.name), el('p', { class: 'live-group-meta' }, joinMeta([group.label, group.summaryLabel]))),
    el('div', { class: 'cards' }, group.sessions.map(liveCard)),
  )
}

export function livePage(container) {
  setTitle('Running now')
  const shell = pageShell(container, { title: 'Running now', intro: 'Conversations open on this computer right now, and the agents working inside them. This page updates every 3 seconds.' })
  const summary = el('p', { class: 'page-meta', 'aria-live': 'polite' })
  shell.actions.append(summary)
  const unsubscribe = live.subscribe((state) => {
    const body = shell.body
    if (state.status === 'loading') {
      body.replaceChildren(el('div', { class: 'cards' }, [0, 1].map(() => el('div', { class: 'live-card' }, linesSkeleton(3)))))
      return
    }
    if (!state.data) {
      summary.textContent = ''
      body.replaceChildren(errorBlock('Could not load the running conversations', state.error, () => live.refresh && live.refresh()))
      return
    }
    summary.textContent = state.status === 'stale' ? 'Reconnecting' : state.data.totals.summaryLabel
    const parts = []
    if (state.status === 'stale') parts.push(banner(`${state.error} Showing the last data and retrying.`))
    if (state.data.groups.length) parts.push(el('div', { class: 'live-groups' }, state.data.groups.map(liveGroup)))
    else {
      parts.push(
        stateBlock({
          title: 'Nothing is running',
          text: 'Start Claude Code in a terminal, VS Code or the desktop app. It shows up here within a few seconds.',
          actions: [link(urlFor({ view: 'conversations' }), { class: 'button', 'data-focus': 'live-empty-action' }, 'See past conversations')],
        }),
      )
    }
    keepFocus(body, () => body.replaceChildren(...parts))
  })
  return { update() {}, destroy: unsubscribe }
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
          rowLink(conversationHref(row.id), `row-${row.id}`, [
            el('td', null, el('div', { class: 'cell-title' }, link(conversationHref(row.id), { class: 'cell-link', tabindex: '-1' }, row.title), row.live ? badge(row.status, row.statusLabel) : null), el('div', { class: 'meta' }, row.projectLabel)),
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
    searchLabel: 'Search by title, folder or ID',
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
          rowLink(urlFor({ view: 'conversations', project: row.project }), `project-${row.project}`, [
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
