import { $, getJson, live, routeFor } from './ui.js'
import { createSidebar } from './sidebar.js'
import { overviewPage, livePage, conversationsPage, projectsPage, settingsPage, notFoundPage } from './pages.js'
import { conversationPage } from './conversation.js'

const LIVE_MS = 3000
const VIEWS = { overview: overviewPage, live: livePage, conversations: conversationsPage, projects: projectsPage, settings: settingsPage, notfound: notFoundPage }

function routeOf(location) {
  const route = routeFor(location)
  if (route.session) return { ...route, key: `session:${route.session}`, page: conversationPage }
  return { ...route, key: route.view, page: VIEWS[route.view] }
}

const sidebar = createSidebar()
let active = null

function render() {
  const route = routeOf(window.location)
  sidebar.update(route)
  if (active && active.key === route.key) {
    active.controller.update(route.params)
    return
  }
  if (active) active.controller.destroy()
  const content = $('content')
  content.replaceChildren()
  $('main').classList.toggle('is-chat', Boolean(route.session))
  $('scroller').scrollTop = 0
  active = { key: route.key, controller: route.page(content, route.params) }
  content.focus({ preventScroll: true })
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
