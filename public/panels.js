import { el, icon, navigate, urlFor, setTitle, createResource, badge, joinMeta, pager, errorBlock, scanBlock, linesSkeleton, keepFocus } from './ui.js'
import { conversationView, agentView } from './conversation.js'

export const CHAT_KEYS = ['chat', 'agent', 'detail', 'run']
let openedHere = false
let runOpenedHere = false
let projectOpener = null

function plainClick(event) {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

function pageHref(extra) {
  const params = new URLSearchParams(window.location.search)
  for (const key of CHAT_KEYS) params.delete(key)
  for (const [key, value] of Object.entries(extra || {})) if (value) params.set(key, value)
  const text = params.toString()
  return text ? `${window.location.pathname}?${text}` : window.location.pathname
}

export function openChat(id, agent, extra) {
  openedHere = true
  navigate(pageHref({ chat: id, agent, ...extra }))
}

export function openRun(id, agent) {
  runOpenedHere = true
  navigate(pageHref({ run: id, agent }))
}

export function openProject(project) {
  if (projectOpener) projectOpener(project)
}

export function chatLink(id, agent, props, ...children) {
  return el(
    'a',
    {
      ...props,
      href: urlFor({ view: 'overview', chat: id, agent }),
      onclick: (event) => {
        if (!plainClick(event)) return
        event.preventDefault()
        if (props && props.onnavigate) props.onnavigate()
        openChat(id, agent)
      },
      onnavigate: null,
    },
    ...children,
  )
}

export function projectLink(project, props, ...children) {
  return el(
    'a',
    {
      ...props,
      href: urlFor({ view: 'conversations', project }),
      onclick: (event) => {
        if (!plainClick(event)) return
        event.preventDefault()
        if (props && props.onnavigate) props.onnavigate()
        openProject(project)
      },
      onnavigate: null,
    },
    ...children,
  )
}

export function createPanels() {
  let chat = null
  let chatReturn = null
  let run = null
  let runReturn = null
  let savedTitle = null
  let project = null
  let page = 1
  let projectReturn = null

  const chatClose = el('button', { class: 'icon-button', type: 'button', 'aria-label': 'Close the conversation', onclick: () => closeChat() }, icon('close'))
  const chatBody = el('div', { class: 'chat-panel-body' })
  const chatPanel = el('aside', { class: 'chat-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Conversation', hidden: true }, el('div', { class: 'slideover-head chat-panel-head' }, el('p', { class: 'meta' }, 'Conversation'), chatClose), chatBody)
  const chatBackdrop = el('div', { class: 'slideover-backdrop', hidden: true, onclick: () => closeChat() })

  const projectMeta = el('p', { class: 'meta' })
  const projectTitle = el('h2', { class: 'slideover-title', id: 'project-panel-title' })
  const projectClose = el('button', { class: 'icon-button', type: 'button', 'aria-label': 'Close the project', onclick: () => closeProject() }, icon('close'))
  const projectBody = el('div', { class: 'slideover-body scroll-area' })
  const projectBackdrop = el('div', { class: 'slideover-backdrop', hidden: true, onclick: () => closeProject() })
  const projectPanel = el('aside', { class: 'slideover project-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'project-panel-title', hidden: true }, el('div', { class: 'slideover-head' }, el('div', { class: 'slideover-heading' }, projectMeta, projectTitle), projectClose), projectBody)
  document.body.append(projectBackdrop, projectPanel, chatBackdrop, chatPanel)

  const projectResource = createResource(() => `/api/sessions?${new URLSearchParams({ project, page: String(page) })}`, renderProject)

  function renderProject(state) {
    if (state.status === 'loading' || (state.status === 'refreshing' && !state.data)) return projectBody.replaceChildren(linesSkeleton(4))
    if (state.status === 'scanning') return projectBody.replaceChildren(scanBlock(state.scan))
    if (state.status === 'error') return projectBody.replaceChildren(errorBlock('Could not load this project', state.error, () => projectResource.load()))
    const data = state.data
    projectTitle.textContent = data.project ? data.project.label : project
    projectMeta.textContent = data.summary.line || 'Project'
    keepFocus(projectBody, () =>
      projectBody.replaceChildren(
        data.rows.length
          ? el(
              'ul',
              { class: 'flow-rows' },
              data.rows.map((row) =>
                el(
                  'li',
                  null,
                  chatLink(
                    row.id,
                    null,
                    { class: 'flow-row', 'data-focus': `project-row-${row.id}` },
                    el('span', { class: 'flow-row-main' }, el('span', { class: 'flow-row-title' }, row.title), el('span', { class: 'flow-row-meta' }, joinMeta([row.lastActiveLabel, row.modelsLabel, row.tokensLabel]))),
                    row.live ? badge(row.status, row.statusLabel) : null,
                  ),
                ),
              ),
            )
          : el('p', { class: 'meta' }, 'No conversation in this project used tokens yet.'),
        pager(data, (next) => {
          page = next
          projectResource.load()
          projectBody.scrollTop = 0
        }),
      ),
    )
  }

  projectOpener = (value) => {
    if (projectPanel.hidden) projectReturn = document.activeElement
    project = value
    page = 1
    projectTitle.textContent = value
    projectMeta.textContent = 'Project'
    projectBackdrop.hidden = false
    projectPanel.hidden = false
    projectResource.state.data = null
    projectResource.load()
    projectClose.focus({ preventScroll: true })
  }

  function closeProject() {
    if (projectPanel.hidden) return
    projectResource.cancel()
    projectBackdrop.hidden = true
    projectPanel.hidden = true
    projectBody.replaceChildren()
    if (projectReturn && document.contains(projectReturn)) projectReturn.focus({ preventScroll: true })
    projectReturn = null
  }

  function closeChat() {
    if (!chat) return
    if (openedHere) window.history.go(-(1 + chat.view.depth()))
    else navigate(pageHref(), { replace: true })
  }

  function hideChat() {
    openedHere = false
    if (!chat) return
    chat.view.destroy()
    chat = null
    chatPanel.hidden = true
    chatBackdrop.hidden = true
    chatBody.replaceChildren()
    if (savedTitle !== null) setTitle(savedTitle)
    savedTitle = null
    if (chatReturn && document.contains(chatReturn)) chatReturn.focus({ preventScroll: true })
    chatReturn = null
  }

  function closeRun() {
    if (!run) return
    if (runOpenedHere) window.history.go(-(1 + run.view.depth()))
    else navigate(pageHref(), { replace: true })
  }

  function hideRun() {
    runOpenedHere = false
    if (!run) return
    run.view.destroy()
    run = null
    const key = runReturn && runReturn.getAttribute('data-focus')
    const back = runReturn && !document.contains(runReturn) && key ? document.querySelector(`[data-focus="${CSS.escape(key)}"]`) : runReturn
    if (back && document.contains(back)) back.focus({ preventScroll: true })
    runReturn = null
  }

  function syncRun(params) {
    const id = params.get('run')
    const agent = params.get('agent')
    if (!id || !agent || params.get('chat')) return hideRun()
    if (run && run.id === id && run.agent === agent) return run.view.update(params)
    if (run) run.view.destroy()
    else runReturn = document.activeElement
    run = { id, agent, view: agentView(document.body, id, agent, params, { href: (extra) => pageHref({ run: id, ...extra }), onClose: closeRun, onOpenChat: () => openChat(id) }) }
    run.view.focus()
  }

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    if (chat) closeChat()
    else if (run) run.view.escape()
    else if (!projectPanel.hidden) closeProject()
    else return
    event.preventDefault()
  })

  return {
    sync(params) {
      syncRun(params)
      const id = params.get('chat')
      if (!id) return hideChat()
      if (chat && chat.id === id) return chat.view.update(params)
      if (chat) chat.view.destroy()
      else {
        chatReturn = document.activeElement
        savedTitle = document.getElementById('topbar-title').textContent
      }
      chatPanel.hidden = false
      chatBackdrop.hidden = false
      chat = { id, view: conversationView(chatBody, id, params, (extra) => pageHref({ chat: id, ...extra })) }
      chatClose.focus({ preventScroll: true })
    },
  }
}
