import { $, getJson, live, routeFor, navigate, urlFor } from './ui.js'
import { createSidebar } from './sidebar.js'
import { analyticsPage, conversationsPage, projectsPage, skillsPage, pluginsPage, settingsPage, notFoundPage } from './pages.js'
import { overviewPage } from './flow.js'
import { createPanels, CHAT_KEYS } from './panels.js'

const LIVE_MS = 3000
const VIEWS = { overview: overviewPage, conversations: conversationsPage, projects: projectsPage, skills: skillsPage, plugins: pluginsPage, analytics: analyticsPage, settings: settingsPage, notfound: notFoundPage }

function pageParams(params) {
  const copy = new URLSearchParams(params)
  for (const key of CHAT_KEYS) copy.delete(key)
  return copy
}

const sidebar = createSidebar()
const panels = createPanels()
let active = null

function render() {
  const route = routeFor(window.location)
  if (route.session) {
    navigate(urlFor({ view: 'overview', chat: route.session, agent: route.agent, detail: route.params.get('detail') }), { replace: true })
    return
  }
  const params = pageParams(route.params)
  const signature = params.toString()
  sidebar.update({ ...route, session: route.params.get('chat') })
  panels.sync(route.params)
  if (active && active.key === route.view) {
    if (active.signature !== signature) {
      active.signature = signature
      active.controller.update(params)
    }
    return
  }
  if (active) active.controller.destroy()
  const content = $('content')
  content.replaceChildren()
  $('main').classList.toggle('is-canvas', route.view === 'overview')
  $('scroller').scrollTop = 0
  active = { key: route.view, signature, controller: VIEWS[route.view](content, params) }
  if (!route.params.get('chat')) content.focus({ preventScroll: true })
}

let liveTimer = null

async function pollLive() {
  window.clearTimeout(liveTimer)
  try {
    const data = await getJson('/api/live')
    live.set({ status: 'ready', data, error: null })
  } catch (error) {
    live.set({ status: live.data ? 'stale' : 'error', error: error.message })
  }
  liveTimer = window.setTimeout(function next() {
    if (document.hidden) liveTimer = window.setTimeout(next, LIVE_MS)
    else pollLive()
  }, LIVE_MS)
}

live.refresh = pollLive
window.addEventListener('popstate', render)
window.addEventListener('routechange', render)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pollLive()
})
render()
pollLive()
