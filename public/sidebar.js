import { $, el, icon, link, urlFor, navigate, createResource, every, readStore, writeStore, skeleton, live, button, spinner } from './ui.js'

const RECENTS_MS = 10000
const SEARCH_MS = 250
const OPEN_KEY = 'claude-dashboard-open-projects'
const NAV = [
  { view: 'overview', label: 'Overview' },
  { view: 'live', label: 'Running now' },
  { view: 'conversations', label: 'Conversations' },
  { view: 'projects', label: 'Projects' },
]
const MOBILE = window.matchMedia('(max-width: 900px)')

function statusDot(session) {
  if (!session) return null
  if (session.status === 'busy') return spinner(session.statusLabel)
  const tone = session.status === 'waiting' || session.status === 'blocked' ? 'waiting' : 'idle'
  return el('span', { class: `dot dot-${tone}`, role: 'img', 'aria-label': session.statusLabel, title: session.statusLabel })
}

function liveSignature(data) {
  return data ? data.sessions.map((session) => `${session.id}:${session.status}`).sort().join(',') : ''
}

function readOpenProjects() {
  try {
    const value = JSON.parse(readStore(OPEN_KEY) || 'null')
    return Array.isArray(value) ? new Set(value.filter((entry) => typeof entry === 'string')) : null
  } catch {
    return null
  }
}

export function createSidebar() {
  const nav = $('nav')
  const search = $('recents-search')
  const body = $('recents-body')
  const scanLine = $('scan-line')
  let route = { view: 'overview', session: null }
  let query = ''
  let searchTimer = null
  let openProjects = readOpenProjects()
  let liveSeen = ''

  function liveSessionOf(item) {
    if (live.data) return live.data.sessions.find((session) => session.id === item.id) || null
    return item.live ? item : null
  }

  function liveMark(group) {
    if (!live.data) return group.live ? el('span', { class: 'dot dot-working', role: 'img', 'aria-label': group.liveLabel, title: group.liveLabel }) : null
    const running = live.data.groups.find((entry) => entry.project === group.project)
    if (!running) return null
    if (running.busy) return spinner(running.summaryLabel)
    return el('span', { class: 'dot', role: 'img', 'aria-label': running.summaryLabel, title: running.summaryLabel })
  }

  const navLinks = NAV.map((entry) => {
    const count = entry.view === 'live' ? el('span', { class: 'nav-count', hidden: true }) : null
    const node = link(urlFor({ view: entry.view === 'overview' ? null : entry.view }), { class: 'nav-item', 'data-view': entry.view, onnavigate: closeDrawer }, el('span', null, entry.label), count)
    return { entry, node, count }
  })
  nav.replaceChildren(...navLinks.map((item) => item.node))

  const recents = createResource(() => {
    const params = new URLSearchParams()
    if (query) params.set('q', query)
    if (route.session) params.set('session', route.session)
    const text = params.toString()
    return `/api/recents${text ? `?${text}` : ''}`
  }, renderRecents)

  function defaultOpen(groups) {
    const open = new Set(groups.length ? [groups[0].project] : [])
    const current = route.session ? groups.find((group) => group.items.some((item) => item.id === route.session)) : null
    if (current) open.add(current.project)
    return open
  }

  function openSet(groups) {
    return openProjects || defaultOpen(groups)
  }

  function toggleProject(project) {
    const groups = recents.state.data ? recents.state.data.groups : []
    openProjects = new Set(openSet(groups))
    if (openProjects.has(project)) openProjects.delete(project)
    else openProjects.add(project)
    writeStore(OPEN_KEY, JSON.stringify([...openProjects]))
    renderRecents(recents.state)
  }

  function revealCurrent() {
    const data = recents.state.data
    if (!data || !route.session) return
    const current = data.groups.find((group) => group.items.some((item) => item.id === route.session))
    if (!current) {
      if (recents.state.status === 'ready') recents.load({ silent: true })
      return
    }
    if (openProjects && !openProjects.has(current.project)) {
      openProjects.add(current.project)
      writeStore(OPEN_KEY, JSON.stringify([...openProjects]))
    }
  }

  function recentItem(item) {
    const current = route.session === item.id
    return el(
      'li',
      null,
      link(
        urlFor({ session: item.id }),
        { class: 'recent', 'aria-current': current ? 'page' : null, title: item.title, 'data-focus': `recent-${item.id}`, onnavigate: closeDrawer },
        statusDot(liveSessionOf(item)),
        el('span', { class: 'recent-title' }, item.title),
        el('span', { class: 'recent-tokens', title: item.tokensTitle }, item.tokensLabel),
      ),
    )
  }

  function projectGroup(group, index, open) {
    const listId = `project-list-${index}`
    const head = el(
      'button',
      { class: 'project-head', type: 'button', 'aria-expanded': String(open), 'aria-controls': listId, 'data-focus': `project-${group.project}`, title: group.label, onclick: () => toggleProject(group.project) },
      icon('chevron', 'project-chevron'),
      el('span', { class: 'project-name' }, group.name),
      liveMark(group),
      el('span', { class: 'project-count' }, group.countLabel),
    )
    return el(
      'div',
      { class: `project-group${open ? ' is-open' : ''}` },
      head,
      el('ul', { class: 'recent-list', id: listId, hidden: !open }, group.items.map(recentItem)),
      open && group.moreLabel ? link(urlFor({ view: 'conversations', project: group.project || null, q: query || null }), { class: 'project-more', onnavigate: closeDrawer }, group.moreLabel) : null,
    )
  }

  function renderRecents(state) {
    if (state.status === 'loading') {
      body.replaceChildren(el('div', { class: 'recents-skeleton' }, [0, 1, 2, 3, 4, 5].map(() => skeleton('line w-80'))))
      return
    }
    if (state.status === 'scanning') {
      body.replaceChildren(el('p', { class: 'sidebar-note' }, `Reading your transcripts, ${state.scan ? state.scan.percent : 0}% done.`))
      return
    }
    if (state.status === 'error') {
      body.replaceChildren(el('div', { class: 'sidebar-note sidebar-error', role: 'alert' }, el('p', null, 'Could not load your conversations.'), el('p', null, state.error), button('Try again', () => recents.load(), 'small')))
      return
    }
    const data = state.data
    if (!data.sessionsOnMachine) {
      body.replaceChildren(el('div', { class: 'sidebar-note' }, el('p', { class: 'sidebar-note-title' }, 'No conversations yet'), el('p', null, 'Every Claude Code conversation on this computer shows up here, grouped by project, with the tokens it used.')))
      return
    }
    if (!data.groups.length) {
      body.replaceChildren(
        el(
          'div',
          { class: 'sidebar-note' },
          el('p', { class: 'sidebar-note-title' }, 'No conversation matches'),
          el('p', null, `No title, folder or message of yours has “${query}”.`),
          button(
            'Clear search',
            () => {
              search.value = ''
              setQuery('')
            },
            'small',
          ),
        ),
      )
      return
    }
    const open = openSet(data.groups)
    const content = [
      ...data.groups.map((group, index) => projectGroup(group, index, Boolean(query) || open.has(group.project))),
      state.refreshError ? el('p', { class: 'sidebar-note sidebar-error', role: 'status' }, 'Could not refresh. Showing the last list.') : null,
    ]
    const active = document.activeElement
    const key = active && body.contains(active) ? active.getAttribute('data-focus') : null
    const scroll = body.scrollTop
    body.replaceChildren(...content.filter(Boolean))
    body.scrollTop = scroll
    if (key) {
      const next = body.querySelector(`[data-focus="${CSS.escape(key)}"]`)
      if (next) next.focus({ preventScroll: true })
    }
  }

  function setQuery(value) {
    window.clearTimeout(searchTimer)
    if (value === query) return
    query = value
    recents.load()
  }

  search.addEventListener('input', (event) => {
    window.clearTimeout(searchTimer)
    const value = event.target.value.trim()
    searchTimer = window.setTimeout(() => setQuery(value), SEARCH_MS)
  })

  live.subscribe((state) => {
    const count = navLinks.find((item) => item.entry.view === 'live').count
    const running = state.data ? state.data.totals.count : 0
    count.hidden = !running
    count.textContent = running ? String(running) : ''
    scanLine.hidden = !state.data || state.data.scan.status === 'done'
    if (state.data && state.data.scan.status !== 'done') scanLine.textContent = state.data.scan.status === 'failed' ? state.data.scan.label : `Reading transcripts, ${state.data.scan.percent}% done`
    const signature = liveSignature(state.data)
    if (signature === liveSeen) return
    liveSeen = signature
    if (recents.state.data) renderRecents(recents.state)
  })

  const settingsLink = link(urlFor({ view: 'settings' }), { class: 'nav-item', 'data-view': 'settings', onnavigate: closeDrawer }, el('span', null, 'Settings'))
  $('foot-nav').replaceChildren(settingsLink)

  function openDrawer() {
    document.body.classList.add('drawer-open')
    $('backdrop').hidden = false
    const target = document.querySelector('#sidebar .nav-item[aria-current="page"]') || document.querySelector('#sidebar .nav-item')
    if (target) target.focus({ preventScroll: true })
  }
  function closeDrawer() {
    if (!document.body.classList.contains('drawer-open')) return
    document.body.classList.remove('drawer-open')
    $('backdrop').hidden = true
  }
  function setHidden(hidden) {
    if (hidden) document.documentElement.dataset.sidebar = 'hidden'
    else delete document.documentElement.dataset.sidebar
    writeStore('claude-dashboard-sidebar', hidden ? 'hidden' : null)
  }
  $('sidebar-open').addEventListener('click', () => {
    if (MOBILE.matches) openDrawer()
    else {
      setHidden(false)
      $('sidebar-close').focus({ preventScroll: true })
    }
  })
  $('sidebar-close').addEventListener('click', () => {
    if (MOBILE.matches) closeDrawer()
    else {
      setHidden(true)
      $('sidebar-open').focus({ preventScroll: true })
    }
  })
  $('backdrop').addEventListener('click', closeDrawer)
  document.querySelector('.brand').addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    closeDrawer()
    navigate(urlFor({ view: 'overview' }))
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && document.body.classList.contains('drawer-open')) closeDrawer()
  })
  MOBILE.addEventListener('change', closeDrawer)

  recents.load()
  every(RECENTS_MS, () => {
    if (recents.state.status === 'ready') recents.load({ silent: true })
  })

  return {
    update(next) {
      const changed = next.session !== route.session
      route = next
      for (const item of navLinks) {
        if (item.entry.view === route.view && !route.session) item.node.setAttribute('aria-current', 'page')
        else item.node.removeAttribute('aria-current')
      }
      if (route.view === 'settings') settingsLink.setAttribute('aria-current', 'page')
      else settingsLink.removeAttribute('aria-current')
      if (changed && recents.state.status === 'ready') {
        revealCurrent()
        renderRecents(recents.state)
      }
      closeDrawer()
    },
    refresh: () => recents.load({ silent: true }),
  }
}
