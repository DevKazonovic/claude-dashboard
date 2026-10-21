import {
  el,
  icon,
  link,
  urlFor,
  navigate,
  setTitle,
  getJson,
  postJson,
  keepFocus,
  stateBlock,
  errorBlock,
  banner,
  badge,
  joinMeta,
  linesSkeleton,
  skeleton,
  fact,
  heat,
  shareRows,
  copyButton,
  button,
  reducedMotion,
  live,
  spinner,
  activityText,
} from './ui.js'
import { renderMarkdown } from './markdown.js'
import { createUsage } from './usage.js'

const LIVE_MS = 3000
const IDLE_MS = 15000
const PAGE = 20
const MAX_RANGE = 50
const FOLLOW_SLACK = 160
const INPUT_MAX_HEIGHT = 200
const OPEN_NOTE_MS = 5000
const OPEN_NOTE_LONG_MS = 30000

export function conversationPage(container, params) {
  return createConversation(container, { id: params.get('session'), agent: null }, params)
}

function toggleSet(set, key) {
  if (set.has(key)) set.delete(key)
  else set.add(key)
  return set.has(key)
}

function flash(node) {
  node.classList.remove('is-target')
  void node.offsetWidth
  node.classList.add('is-target')
}

function runs(indexes) {
  const result = []
  for (const index of indexes) {
    const last = result[result.length - 1]
    if (last && last[1] === index) last[1] = index + 1
    else result.push([index, index + 1])
  }
  return result
}

function disclosure({ label, open, onToggle, className, focusKey, content }) {
  const body = el('div', { class: 'disclosure-body', hidden: !open })
  let filled = false
  const fill = () => {
    if (filled) return
    filled = true
    body.append(...[].concat(content()))
  }
  if (open) fill()
  const trigger = el(
    'button',
    {
      class: `disclosure${className ? ` ${className}` : ''}`,
      type: 'button',
      'aria-expanded': String(open),
      'data-focus': focusKey,
      onclick: () => {
        const next = onToggle()
        if (next) fill()
        body.hidden = !next
        trigger.setAttribute('aria-expanded', String(next))
      },
    },
    icon('chevron', 'disclosure-chevron'),
    el('span', null, label),
  )
  return [trigger, body]
}

function clampable(content, { long, key, openSet, className }) {
  const isOpen = () => openSet.has(key)
  const box = el('div', { class: `${className}${long && !isOpen() ? ' is-clamped' : ''}` }, content)
  if (!long) return box
  const more = el(
    'button',
    {
      class: 'show-more',
      type: 'button',
      'aria-expanded': String(isOpen()),
      'data-focus': `more-${key}`,
      onclick: () => {
        toggleSet(openSet, key)
        const open = isOpen()
        box.classList.toggle('is-clamped', !open)
        more.setAttribute('aria-expanded', String(open))
        more.textContent = open ? 'Show less' : 'Show more'
      },
    },
    isOpen() ? 'Show less' : 'Show more',
  )
  return el('div', { class: `clamp-wrap ${className.split(' ')[0]}-wrap` }, box, more)
}

function ioRow(label, text, className) {
  return el('div', { class: 'io-row' }, el('span', { class: 'io-label' }, label), el('pre', { class: className ? `io-code ${className}` : 'io-code' }, text))
}

function toolDetails(tool) {
  const rows = []
  if (tool.detail) rows.push(ioRow('IN', tool.detail))
  if (!tool.result) rows.push(ioRow('OUT', tool.statusLabel, 'io-muted'))
  else if (tool.result.empty) rows.push(ioRow('OUT', 'No output', 'io-muted'))
  else rows.push(ioRow(tool.result.isError ? 'ERROR' : 'OUT', tool.result.text, tool.result.isError ? 'io-error' : null))
  return [el('div', { class: 'io' }, rows), tool.result && tool.result.truncatedNote ? el('p', { class: 'note' }, tool.result.truncatedNote) : null].filter(Boolean)
}

function createConversation(container, target, initialParams, options = {}) {
  const isAgent = Boolean(target.agent)
  const embedded = Boolean(options.onClose)
  const query = `id=${encodeURIComponent(target.id)}${isAgent ? `&agent=${encodeURIComponent(target.agent)}` : ''}`
  const base = isAgent ? `/api/agent?${query}` : `/api/session?${query}`
  const state = {
    status: 'loading',
    data: null,
    error: null,
    refreshError: null,
    turns: new Map(),
    start: 0,
    end: 0,
    chat: 'idle',
    chatError: null,
    older: 'idle',
    olderError: null,
    ready: false,
    selected: null,
    detail: embedded || !initialParams.get('agent') ? initialParams.get('detail') || null : null,
    detailOpenedHere: false,
    sending: false,
    sendError: null,
    followNext: false,
    ui: { text: new Set(), inputs: new Set(), agents: new Set(), markers: new Set(), calls: new Set(), panels: new Set(), replies: new Set() },
    repliesCollapsed: false,
    opening: null,
  }
  const nodes = new Map()
  let request = 0
  let timer = null
  let destroyed = false
  let detailReturnFocus = null
  let usageStarted = false
  let agentView = null
  let agentReturnFocus = null
  let agentOpenedHere = false
  let statusSeen = null
  let liveBusySeen = null

  const head = el('header', { class: 'chat-head' })
  const notice = el('div', { class: 'convo-notice' })
  const olderBar = el('div', { class: 'chat-older' })
  const list = el('div', { class: 'chat-list' })
  const working = el('p', { class: 'live-line chat-working', hidden: true })
  const statusNote = el('p', { class: 'visually-hidden', role: 'status' })
  const chatBody = el('div', { class: 'chat-body' }, olderBar, list, embedded ? null : [working, statusNote])
  const chatScroll = el('div', { class: 'chat-scroll scroll-area' }, el('div', { class: 'chat-col' }, chatBody))

  const slideTitleId = `slide-title-${isAgent ? target.agent : target.id}`
  const slideTitle = el('h2', { class: 'slideover-title', id: slideTitleId })
  const slideMeta = el('p', { class: 'meta' })
  const slideBack = embedded ? el('button', { class: 'icon-button', type: 'button', 'aria-label': 'Back to the agent', hidden: true, onclick: () => closeDetail() }, icon('back')) : null
  const slideClose = el('button', { class: 'icon-button', type: 'button', 'aria-label': 'Close', onclick: () => (embedded ? options.onClose() : closeDetail()) }, icon('close'))
  const slideBody = el('div', { class: 'slideover-body scroll-area', hidden: embedded })
  const agentPane = embedded ? el('div', { class: 'agent-pane' }, el('div', { class: 'agent-top' }, head, working, statusNote, notice), chatScroll) : null
  const slideover = el('aside', { class: embedded ? 'slideover agent-slideover' : 'slideover', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': slideTitleId, hidden: !embedded }, el('div', { class: 'slideover-head' }, slideBack, el('div', { class: 'slideover-heading' }, slideTitle, slideMeta), slideClose), agentPane, slideBody)
  const slideBackdrop = el('div', { class: 'slideover-backdrop', hidden: !embedded, onclick: () => (embedded ? options.onClose() : closeDetail()) })

  let crumbsHolder = null
  let detailsButton = null
  let foldButton = null
  let vscodeButton = null
  let terminalButton = null
  let openNote = null
  let openNoteTimer = null
  let composer = null
  let bottom = null
  let side = null
  let sideBody = null
  let sideClose = null
  let sideBackdrop = null
  let accountNote = null
  let usageHolder = null
  let usageCard = null
  let accountUsage = null
  let layout = null
  if (embedded) container.append(slideBackdrop, slideover)
  else {
    const bar = el('div', { class: 'chat-bar' })
    composer = buildComposer()
    bottom = el('div', { class: 'chat-bottom', hidden: true }, el('div', { class: 'chat-wrap' }, composer.form))
    const pane = el('div', { class: 'chat-pane' }, el('div', { class: 'chat-top' }, el('div', { class: 'chat-wrap' }, bar, head, notice)), chatScroll, bottom)
    sideBody = el('div', { class: 'side-body' })
    sideClose = el('button', { class: 'icon-button', type: 'button', 'aria-label': 'Close details', onclick: () => closeSide(true) }, icon('close'))
    side = el('aside', { class: 'side scroll-area', id: `side-${target.id}`, 'aria-label': 'Details' }, el('div', { class: 'side-head' }, el('h2', { class: 'side-title' }, 'Details'), sideClose), sideBody)
    sideBackdrop = el('div', { class: 'side-backdrop', hidden: true, onclick: () => closeSide(false) })
    crumbsHolder = el('div', { class: 'chat-crumbs' })
    detailsButton = el('button', { class: 'button small details-button', type: 'button', 'aria-controls': side.id, 'data-focus': 'details-button', hidden: true, onclick: () => openSide() })
    foldButton = el('button', { class: 'button small ghost', type: 'button', 'data-focus': 'fold-all', hidden: true, onclick: () => toggleFoldAll() })
    vscodeButton = el('button', { class: 'button small', type: 'button', 'data-focus': 'open-vscode', hidden: true, onclick: () => openIn('vscode') }, 'Open in VS Code')
    terminalButton = el('button', { class: 'button small', type: 'button', 'data-focus': 'open-terminal', hidden: true, onclick: () => openIn('terminal') }, 'Open in Terminal')
    openNote = el('p', { class: 'open-note', role: 'status', hidden: true })
    bar.append(crumbsHolder, el('div', { class: 'chat-bar-actions' }, foldButton, vscodeButton, terminalButton, detailsButton))
    notice.after(openNote)
    accountNote = el('p', { class: 'account-note', hidden: true })
    usageHolder = el('div', { class: 'chat-usage' })
    usageCard = el('section', { class: 'side-card usage-card', hidden: true }, el('h2', { class: 'side-card-title' }, 'Usage limits'), accountNote, usageHolder)
    accountUsage = createUsage(usageHolder, {
      only: () => (state.data && state.data.account ? state.data.account.key : null),
      emptyText: null,
    })
    layout = el('div', { class: 'chat-layout' }, pane, side, sideBackdrop, slideBackdrop, slideover)
    container.replaceChildren(layout)
  }

  function atBottom() {
    return chatScroll.scrollTop + chatScroll.clientHeight >= chatScroll.scrollHeight - FOLLOW_SLACK
  }

  function scrollToBottom() {
    chatScroll.scrollTop = chatScroll.scrollHeight
  }

  const observer = new IntersectionObserver(
    (entries) => {
      if (state.ready && state.start > 0 && state.older === 'idle' && entries.some((entry) => entry.isIntersecting)) loadOlder()
    },
    { root: chatScroll, rootMargin: '600px 0px 0px 0px' },
  )
  observer.observe(olderBar)

  const onKey = (event) => {
    if (event.key !== 'Escape') return
    if (agentView) agentView.escape()
    else if (!slideover.hidden) closeDetail()
    else if (layout.classList.contains('side-open')) closeSide(true)
  }
  if (!embedded) document.addEventListener('keydown', onKey)

  function summaries() {
    return state.data && state.data.timeline ? state.data.timeline.turns : []
  }

  function composerState() {
    return state.data && state.data.composer ? state.data.composer.state : null
  }

  function isLive() {
    if (!state.data) return false
    if (composerState() === 'running') return true
    return isAgent ? state.data.session.live : state.data.live
  }

  function isWorking() {
    if (!state.data) return false
    if (composerState() === 'running') return true
    if (!isLive()) return false
    return isAgent ? state.data.status === 'working' : state.data.status === 'busy'
  }

  function liveSession() {
    return live.data ? live.data.sessions.find((session) => session.id === target.id) || null : null
  }

  function liveAgent(id) {
    const session = liveSession()
    return session ? session.workingAgentList.find((agent) => agent.id === id) || null : null
  }

  function agentLive(id) {
    const node = el('p', { class: 'live-line agent-live', 'data-live-agent': id })
    fillAgentLive(node)
    return node
  }

  function fillAgentLive(node) {
    const agent = liveAgent(node.getAttribute('data-live-agent'))
    const activity = agent && agent.activity
    node.hidden = !activity
    node.replaceChildren(...(activity ? [spinner(), activityText(activity)] : []))
  }

  function renderLive() {
    if (state.status !== 'ready') return
    const following = atBottom()
    const anchor = visibleAnchor()
    renderWorking()
    for (const node of list.querySelectorAll('[data-live-agent]')) fillAgentLive(node)
    if (following) scrollToBottom()
    else if (anchor) chatScroll.scrollTop += anchor.node.getBoundingClientRect().top - anchor.top
    syncLiveState()
  }

  function visibleAnchor() {
    const top = chatScroll.getBoundingClientRect().top
    for (const node of list.children) {
      const box = node.getBoundingClientRect()
      if (box.bottom > top) return { node, top: box.top }
    }
    return null
  }

  function syncLiveState() {
    if (live.status !== 'ready' || !live.data) return
    const session = liveSession()
    const liveBusy = isAgent ? Boolean(liveAgent(target.agent)) : Boolean(session && session.status === 'busy')
    if (liveBusy === liveBusySeen) return
    liveBusySeen = liveBusy
    if (liveBusy !== isWorking()) load(true)
  }

  function renderStatusNote() {
    const label = state.data ? state.data.statusLabel : null
    if (label === statusSeen) return
    if (statusSeen !== null) statusNote.textContent = label
    statusSeen = label
  }

  function chatUrl(start, end) {
    return `/api/chat?${query}&start=${start}&end=${end}`
  }

  function pageUrl(detail) {
    return urlFor({ session: target.id, agent: target.agent, detail })
  }

  function agentHref(agentId) {
    return urlFor({ session: target.id, agent: agentId })
  }

  function agentLink(agentId, props, ...children) {
    return link(agentHref(agentId), { ...props, onnavigate: embedded ? null : () => (agentOpenedHere = true) }, ...children)
  }

  function openAgent(agentId, params) {
    if (agentView && agentView.agent === agentId) {
      agentView.update(params)
      return
    }
    if (agentView) agentView.destroy()
    else agentReturnFocus = document.activeElement
    agentView = { agent: agentId, ...createConversation(layout, { id: target.id, agent: agentId }, params, { onClose: closeAgent }) }
  }

  function closeAgent() {
    if (!agentView) return
    const depth = agentView.depth()
    if (agentOpenedHere) window.history.go(-(1 + depth))
    else navigate(pageUrl(null), { replace: true })
  }

  function dropAgent() {
    agentOpenedHere = false
    if (!agentView) return
    agentView.destroy()
    agentView = null
    if (agentReturnFocus && document.contains(agentReturnFocus)) agentReturnFocus.focus({ preventScroll: true })
    agentReturnFocus = null
  }

  function rerenderTurns(indexes) {
    for (const index of indexes) {
      const entry = nodes.get(index)
      if (entry) entry.turn = null
      renderTurn(index)
    }
  }

  function toggleFoldAll() {
    state.repliesCollapsed = !state.repliesCollapsed
    state.ui.replies.clear()
    rerenderTurns([...nodes.keys()])
    renderOpener()
  }

  function replyHidden(turn) {
    return state.repliesCollapsed && !state.ui.replies.has(turn.index)
  }

  function toggleReply(turn) {
    toggleSet(state.ui.replies, turn.index)
    rerenderTurns([turn.index])
    const next = list.querySelector(`[data-focus="${CSS.escape(`reply-${turn.index}`)}"]`)
    if (next) next.focus({ preventScroll: true })
  }

  function replyToggle(turn) {
    const hidden = replyHidden(turn)
    return el(
      'button',
      { class: 'disclosure small-toggle reply-toggle', type: 'button', 'aria-expanded': String(!hidden), 'data-focus': `reply-${turn.index}`, onclick: () => toggleReply(turn) },
      icon('chevron', 'disclosure-chevron'),
      el('span', null, hidden ? 'Show response' : 'Hide response'),
      hidden && turn.footLabel ? el('span', { class: 'reply-toggle-meta' }, `· ${turn.footLabel}`) : null,
    )
  }

  async function openIn(where) {
    state.opening = where
    renderOpener()
    try {
      const result = await postJson('/api/open', { id: target.id, target: where })
      showOpenNote(result.message, false, result.sticky)
    } catch (error) {
      showOpenNote(error.message, true)
    }
    state.opening = null
    renderOpener()
  }

  function showOpenNote(text, failed, sticky) {
    window.clearTimeout(openNoteTimer)
    openNote.textContent = text
    openNote.classList.toggle('is-error', failed)
    openNote.hidden = false
    if (!failed) openNoteTimer = window.setTimeout(() => (openNote.hidden = true), sticky ? OPEN_NOTE_LONG_MS : OPEN_NOTE_MS)
  }

  function renderOpener() {
    if (!foldButton) return
    const ready = state.status === 'ready'
    foldButton.hidden = !ready
    foldButton.textContent = state.repliesCollapsed ? 'Expand responses' : 'Collapse responses'
    foldButton.setAttribute('aria-pressed', String(state.repliesCollapsed))
    const opener = ready ? state.data.opener : null
    for (const [button, where, label] of [[vscodeButton, 'vscode', 'Open in VS Code'], [terminalButton, 'terminal', 'Open in Terminal']]) {
      button.hidden = !opener
      button.disabled = !opener || !opener.available || Boolean(state.opening)
      button.title = opener && opener.note ? opener.note : ''
      button.textContent = state.opening === where ? 'Opening' : label
    }
  }

  function drawerMode() {
    return Boolean(side) && window.getComputedStyle(side).position === 'fixed'
  }

  function openSide() {
    if (!layout) return
    layout.classList.add('side-open')
    sideBackdrop.hidden = false
    sideClose.focus({ preventScroll: true })
  }

  function closeSide(restoreFocus) {
    if (!layout || !layout.classList.contains('side-open')) return
    layout.classList.remove('side-open')
    sideBackdrop.hidden = true
    if (restoreFocus) {
      detailsButton.focus({ preventScroll: true })
    }
  }

  function buildComposer() {
    const textarea = el('textarea', { class: 'composer-input', rows: '1', 'aria-label': 'Message to Claude', spellcheck: 'true' })
    const sendButton = el('button', { class: 'button primary small composer-send', type: 'submit' }, 'Send')
    const stopButton = el('button', { class: 'button small composer-stop', type: 'button', hidden: true, onclick: () => stopRun() }, 'Stop')
    const error = el('p', { class: 'composer-error', role: 'alert', hidden: true })
    const status = el('p', { class: 'composer-status', role: 'status' })
    const note = el('p', { class: 'composer-note' })
    const form = el(
      'form',
      {
        class: 'composer',
        onsubmit: (event) => {
          event.preventDefault()
          submit()
        },
      },
      el('div', { class: 'composer-box' }, textarea, el('div', { class: 'composer-actions' }, stopButton, sendButton)),
      error,
      status,
      note,
    )
    const autosize = () => {
      textarea.style.setProperty('height', 'auto')
      textarea.style.setProperty('height', `${Math.min(textarea.scrollHeight, INPUT_MAX_HEIGHT)}px`)
    }
    textarea.addEventListener('input', () => {
      autosize()
      renderComposer()
    })
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        submit()
      }
    })
    return { form, textarea, sendButton, stopButton, error, status, note, autosize }
  }

  function renderComposer() {
    if (!bottom) return
    const data = state.data
    const box = data && data.composer
    bottom.hidden = !box
    if (!box) return
    const ready = box.state === 'ready'
    composer.textarea.placeholder = box.placeholder
    composer.textarea.disabled = !ready || state.sending
    composer.sendButton.hidden = box.state === 'running'
    composer.sendButton.disabled = !ready || state.sending || !composer.textarea.value.trim()
    composer.sendButton.textContent = state.sending ? 'Sending' : 'Send'
    composer.stopButton.hidden = box.state !== 'running'
    const errorText = state.sendError || box.error
    composer.error.hidden = !errorText
    composer.error.textContent = errorText || ''
    composer.status.textContent = box.text || box.stoppedLabel || ''
    composer.status.hidden = !composer.status.textContent
    composer.note.textContent = ready ? box.note || '' : ''
    composer.note.hidden = !composer.note.textContent
  }

  async function submit() {
    const message = composer.textarea.value.trim()
    if (!message || state.sending || composerState() !== 'ready') return
    state.sending = true
    state.sendError = null
    renderComposer()
    try {
      await postJson('/api/send', { id: target.id, message })
      composer.textarea.value = ''
      composer.autosize()
      state.followNext = true
      scrollToBottom()
    } catch (error) {
      state.sendError = error.message
    }
    state.sending = false
    renderComposer()
    if (!destroyed) load(true)
  }

  async function stopRun() {
    state.sendError = null
    try {
      await postJson('/api/stop', { id: target.id })
    } catch (error) {
      state.sendError = error.message
    }
    renderComposer()
    if (!destroyed) load(true)
  }

  async function fetchRange(start, end) {
    const page = await getJson(chatUrl(start, end))
    for (const turn of page.turns) state.turns.set(turn.index, turn)
    return page
  }

  async function loadInitial() {
    const total = summaries().length
    state.turns.clear()
    nodes.clear()
    list.replaceChildren()
    state.start = 0
    state.end = 0
    state.ready = false
    if (!total) {
      state.chat = 'idle'
      renderChatState()
      return
    }
    state.chat = 'loading'
    renderChatState()
    try {
      const page = await fetchRange(Math.max(0, total - PAGE), total)
      if (destroyed) return
      state.start = page.start
      state.end = page.end
      state.chat = 'idle'
      renderChatState()
      for (let index = state.start; index < state.end; index++) renderTurn(index)
      renderOlder()
      renderWorking()
      scrollToBottom()
      state.ready = true
      if (state.detail) showDetail(state.detail)
    } catch (error) {
      if (destroyed) return
      state.chat = 'error'
      state.chatError = error.message
      renderChatState()
    }
  }

  async function prepend(from) {
    const page = await fetchRange(from, state.start)
    if (destroyed) return
    const before = chatScroll.scrollHeight
    const top = chatScroll.scrollTop
    state.start = page.start
    for (let index = page.start; index < page.end; index++) renderTurn(index)
    chatScroll.scrollTop = top + chatScroll.scrollHeight - before
  }

  async function loadOlder() {
    if (state.older === 'loading' || state.start === 0) return
    state.older = 'loading'
    renderOlder()
    try {
      await prepend(Math.max(0, state.start - PAGE))
      state.older = 'idle'
    } catch (error) {
      state.older = 'error'
      state.olderError = error.message
    }
    if (destroyed) return
    renderOlder()
    if (state.older === 'idle' && state.start > 0 && olderBar.getBoundingClientRect().bottom > chatScroll.getBoundingClientRect().top - 600) loadOlder()
  }

  async function syncTurns() {
    const current = summaries()
    if (state.chat !== 'idle' || current.length < state.end || (!state.end && current.length)) return loadInitial()
    const following = atBottom() || state.followNext
    const changed = []
    for (let index = state.start; index < state.end; index++) {
      const loaded = state.turns.get(index)
      if (!loaded || loaded.rev !== current[index].rev) changed.push(index)
    }
    const ranges = runs(changed)
    if (current.length > state.end) {
      const last = ranges[ranges.length - 1]
      if (last && last[1] === state.end) last[1] = current.length
      else ranges.push([state.end, current.length])
    }
    for (const [start, end] of ranges) {
      for (let from = start; from < end; from += MAX_RANGE) {
        const page = await fetchRange(from, Math.min(end, from + MAX_RANGE))
        if (destroyed) return
        state.end = Math.max(state.end, page.end)
        for (let index = page.start; index < page.end; index++) renderTurn(index)
      }
    }
    renderWorking()
    if (state.selected !== null) renderSide()
    if (following && (ranges.length || isWorking())) {
      scrollToBottom()
      if (ranges.length) state.followNext = false
    }
  }

  async function load(silent) {
    const id = ++request
    window.clearTimeout(timer)
    try {
      const data = await getJson(silent && state.data ? `${base}&revision=${encodeURIComponent(state.data.revision)}` : base)
      if (destroyed || id !== request) return
      if (data.unchanged) {
        if (state.refreshError) {
          state.refreshError = null
          renderNotice()
        }
      } else {
        const first = !state.data
        Object.assign(state, { status: 'ready', data, error: null, refreshError: null })
        renderFrame()
        if (first) await loadInitial()
        else await syncTurns()
      }
    } catch (error) {
      if (destroyed || id !== request) return
      if (silent && state.data) {
        state.refreshError = error.message
        renderNotice()
      } else {
        Object.assign(state, { status: 'error', error: error.message })
        renderFrame()
      }
    }
    schedule()
  }

  function schedule() {
    window.clearTimeout(timer)
    if (destroyed || state.status === 'error') return
    timer = window.setTimeout(
      () => {
        if (document.hidden) schedule()
        else load(true)
      },
      isLive() ? LIVE_MS : IDLE_MS,
    )
  }

  function selectTurn(index) {
    state.selected = state.selected === index ? null : index
    for (const [other, entry] of nodes) {
      entry.node.classList.toggle('is-selected', other === state.selected)
      const foot = entry.node.querySelector('.msg-foot')
      if (foot) foot.setAttribute('aria-pressed', String(other === state.selected))
    }
    renderSide()
    if (state.selected === null) return
    if (drawerMode()) openSide()
    else side.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' })
  }

  async function ensureLoaded(index) {
    while (state.start > index) await prepend(Math.max(index, state.start - MAX_RANGE))
    renderOlder()
  }

  function revealStep(key) {
    const holder = list.querySelector(`[data-steps~="${CSS.escape(key)}"]`)
    if (!holder) return
    closeSide(false)
    holder.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' })
    flash(holder)
  }

  function openDetail(turnIndex, key) {
    detailReturnFocus = document.activeElement
    state.detailOpenedHere = true
    navigate(pageUrl(`${turnIndex}.${key}`))
  }

  function closeDetail() {
    if (state.detailOpenedHere) {
      state.detailOpenedHere = false
      window.history.back()
    } else navigate(pageUrl(null), { replace: true })
  }

  function parseDetail(value) {
    const dot = value.indexOf('.')
    const index = Number(value.slice(0, dot))
    if (dot < 1 || !Number.isInteger(index) || index < 0) return null
    return { index, key: value.slice(dot + 1) }
  }

  async function showDetail(value) {
    state.detail = value
    const parsed = parseDetail(value)
    if (!parsed) return
    if (!state.ready) return
    if (!state.turns.has(parsed.index) && parsed.index < state.start) {
      try {
        await ensureLoaded(parsed.index)
      } catch (error) {
        state.refreshError = error.message
        renderNotice()
        return
      }
    }
    if (state.detail !== value) return
    if (embedded) {
      const wasHidden = slideBody.hidden
      renderDetail()
      agentPane.hidden = true
      slideBody.hidden = false
      slideBack.hidden = false
      if (wasHidden) slideBack.focus({ preventScroll: true })
      return
    }
    const wasHidden = slideover.hidden
    renderDetail()
    slideover.hidden = false
    slideBackdrop.hidden = false
    if (wasHidden) slideClose.focus({ preventScroll: true })
  }

  function hideDetail() {
    state.detail = null
    state.detailOpenedHere = false
    if (embedded) {
      if (slideBody.hidden) return
      slideBody.hidden = true
      slideBody.replaceChildren()
      agentPane.hidden = false
      slideBack.hidden = true
      renderSlideHead()
    } else {
      if (slideover.hidden) return
      slideover.hidden = true
      slideBackdrop.hidden = true
      slideBody.replaceChildren()
    }
    if (detailReturnFocus && document.contains(detailReturnFocus)) detailReturnFocus.focus({ preventScroll: true })
    detailReturnFocus = null
  }

  function renderSlideHead() {
    if (!embedded || !slideBody.hidden) return
    const data = state.status === 'ready' ? state.data : null
    slideTitle.textContent = data ? data.title : 'Agent'
    slideMeta.textContent = data ? joinMeta([data.workflowLabel, data.modelsLabel, data.tokensLabel]) : ''
  }

  function agentSummary(data) {
    return [
      el('div', { class: 'convo-meta' }, el('span', { class: 'badges' }, badge(data.status, data.statusLabel), badge('neutral', data.typeLabel), data.phase ? badge('neutral', data.phase) : null), el('span', null, data.callsLabel)),
      el(
        'div',
        null,
        disclosure({
          label: 'Tokens and details',
          open: state.ui.panels.has('agent'),
          onToggle: () => toggleSet(state.ui.panels, 'agent'),
          focusKey: 'agent-details',
          className: 'small-toggle',
          content: () => [
            shareRows(data.tokens),
            el('dl', { class: 'facts' }, fact('Ran for', data.durationLabel || 'Unknown'), data.workflowLabel ? fact('Workflow', data.workflowLabel) : null, fact('Last active', data.lastActiveLabel), fact('Agent ID', data.id)),
          ],
        }),
      ),
    ]
  }

  function renderDetail() {
    const parsed = state.detail ? parseDetail(state.detail) : null
    const turn = parsed ? state.turns.get(parsed.index) : null
    const segment = turn ? turn.segments.find((entry) => entry.key === parsed.key) : null
    const scroll = slideBody.scrollTop
    if (!segment) {
      slideTitle.textContent = 'Not found'
      slideMeta.textContent = ''
      slideBody.replaceChildren(stateBlock({ title: 'This part of the conversation is not here anymore', text: 'The transcript changed since this link was made.', actions: [button('Close', () => closeDetail())] }))
      return
    }
    slideTitle.textContent = segment.title || segment.label
    slideMeta.textContent = joinMeta([`Message ${turn.number}`, turn.kindLabel, turn.atLabel])
    const entries = segment.entries || [segment]
    const sections = []
    for (const stepKey of segment.steps) {
      const call = turn.calls.find((entry) => entry.key === stepKey)
      const stepEntries = entries.filter((entry) => entry.step === stepKey)
      sections.push(
        el(
          'section',
          { class: 'detail-step' },
          call
            ? el(
                'div',
                { class: 'detail-step-head' },
                el('span', null, el('strong', null, `Model call ${call.number}`), ` · ${joinMeta([call.modelLabel, call.durationLabel ? `Took ${call.durationLabel}` : null])}`),
                el('span', { class: 'num' }, call.tokensLabel),
              )
            : null,
          stepEntries.map(detailEntry),
        ),
      )
    }
    slideBody.replaceChildren(...sections)
    slideBody.scrollTop = scroll
  }

  function detailEntry(entry) {
    if (entry.type === 'thinking') {
      return el(
        'div',
        { class: 'detail-entry' },
        el('p', { class: 'detail-entry-head' }, el('span', { class: 'detail-dot tone-thinking', 'aria-hidden': 'true' }), el('span', { class: 'detail-name' }, 'Thinking'), entry.tokensLabel ? el('span', { class: 'detail-status' }, entry.tokensLabel) : null),
        entry.text ? el('div', { class: 'detail-thinking' }, entry.text) : el('p', { class: 'note' }, entry.emptyLabel),
      )
    }
    const tone = entry.status === 'error' ? 'error' : entry.status === 'pending' ? 'pending' : 'done'
    return el(
      'div',
      { class: 'detail-entry' },
      el(
        'p',
        { class: 'detail-entry-head' },
        el('span', { class: `detail-dot tone-${tone}`, 'aria-hidden': 'true' }),
        el('span', { class: 'detail-name' }, entry.label),
        el('span', { class: 'detail-target' }, entry.target),
        entry.statusLabel ? el('span', { class: `detail-status${entry.status === 'error' ? ' is-error' : ''}` }, entry.statusLabel) : null,
      ),
      toolDetails(entry),
    )
  }

  function renderFrame() {
    if (state.status === 'loading') {
      if (!embedded) setTitle('Conversation')
      if (crumbsHolder) crumbsHolder.replaceChildren()
      renderAccount()
      renderSlideHead()
      head.replaceChildren(skeleton('title-line w-60'), skeleton('line w-40'))
      list.replaceChildren(...[0, 1, 2].map((index) => el('div', { class: `msg-skeleton ${index % 2 ? 'is-claude' : 'is-user'}` }, linesSkeleton(index % 2 ? 4 : 2))))
      if (sideBody) sideBody.replaceChildren(el('section', { class: 'side-card' }, linesSkeleton(4)), el('section', { class: 'side-card' }, linesSkeleton(5)))
      renderComposer()
      return
    }
    if (state.status === 'error') {
      if (!embedded) setTitle('Conversation')
      if (crumbsHolder) crumbsHolder.replaceChildren(crumbs(null))
      renderAccount()
      renderSlideHead()
      head.replaceChildren()
      chatBody.hidden = true
      if (sideBody) sideBody.replaceChildren()
      if (bottom) bottom.hidden = true
      renderOpener()
      notice.replaceChildren(
        errorBlock(isAgent ? 'Could not load this agent' : 'Could not load this conversation', state.error, () => {
          chatBody.hidden = false
          notice.replaceChildren()
          Object.assign(state, { status: 'loading', error: null })
          renderFrame()
          load(false)
        }),
      )
      return
    }
    chatBody.hidden = false
    if (!embedded) setTitle(state.data.title)
    if (crumbsHolder) keepFocus(crumbsHolder, () => crumbsHolder.replaceChildren(crumbs(state.data)))
    if (detailsButton) {
      detailsButton.hidden = false
      detailsButton.textContent = `Details · ${state.data.tokensLabel}`
    }
    renderAccount()
    renderSlideHead()
    keepFocus(head, () => head.replaceChildren(...(embedded ? agentSummary(state.data) : headContent(state.data))))
    renderNotice()
    renderSide()
    renderWorking()
    renderStatusNote()
    renderComposer()
    renderOpener()
  }

  function renderAccount() {
    if (!usageCard) return
    const account = state.data && state.data.account
    usageCard.hidden = !account
    accountNote.hidden = !account || account.known
    usageHolder.hidden = !account || !account.known
    if (!account) return
    if (account.known) {
      if (!usageStarted) {
        usageStarted = true
        accountUsage.start()
      } else accountUsage.render()
      return
    }
    accountNote.textContent = `${account.label}. ${account.note}`
  }

  function renderNotice() {
    notice.replaceChildren(...(state.refreshError ? [banner(`${state.refreshError} Showing the last data and retrying.`)] : []))
  }

  function renderSide() {
    if (!sideBody || !state.data) return
    keepFocus(sideBody, () => sideBody.replaceChildren(...sideContent(state.data)))
  }

  function renderWorking() {
    const busy = isWorking()
    working.hidden = !busy
    if (!busy) return working.replaceChildren()
    const now = isAgent ? liveAgent(target.agent) : liveSession()
    const activity = (now && now.activity) || state.data.activity || { label: state.data.statusLabel, target: '', moreLabel: null, sinceLabel: null }
    const turns = summaries()
    const last = turns.length ? turns[turns.length - 1] : null
    working.replaceChildren(spinner(), activityText(activity, embedded ? [] : [isAgent ? now && now.tokensLabel : last && last.tokensLabel]))
  }

  function renderChatState() {
    if (state.chat === 'loading') {
      list.replaceChildren(...[0, 1, 2].map((index) => el('div', { class: `msg-skeleton ${index % 2 ? 'is-claude' : 'is-user'}` }, linesSkeleton(index % 2 ? 4 : 2))))
      olderBar.replaceChildren()
      return
    }
    if (state.chat === 'error') {
      list.replaceChildren(errorBlock('Could not load the messages', state.chatError, () => loadInitial()))
      olderBar.replaceChildren()
      return
    }
    if (!state.data.timeline) {
      list.replaceChildren(stateBlock({ title: 'No main transcript', text: state.data.timelineMissing }))
      olderBar.replaceChildren()
      return
    }
    if (!summaries().length) {
      list.replaceChildren(stateBlock({ title: 'Nothing here yet', text: isAgent ? 'This agent has not started working yet.' : 'This conversation has no messages yet.' }))
      olderBar.replaceChildren()
      return
    }
    if (!nodes.size) list.replaceChildren()
  }

  function renderOlder() {
    if (!state.end) {
      olderBar.replaceChildren()
      return
    }
    if (state.start === 0) {
      olderBar.replaceChildren(el('p', { class: 'chat-start' }, isAgent ? 'Start of this agent' : state.data && state.data.startedDateLabel ? `Started ${state.data.startedDateLabel}` : 'Start of the conversation'))
      return
    }
    if (state.older === 'loading') {
      olderBar.replaceChildren(el('p', { class: 'chat-start', role: 'status' }, 'Loading earlier messages'))
      return
    }
    if (state.older === 'error') {
      olderBar.replaceChildren(
        el(
          'div',
          { class: 'chat-older-error', role: 'alert' },
          el('p', null, `Could not load earlier messages. ${state.olderError}`),
          button(
            'Try again',
            () => {
              state.older = 'idle'
              loadOlder()
            },
            'small',
          ),
        ),
      )
      return
    }
    olderBar.replaceChildren(button(`Load earlier messages (${state.start} more)`, loadOlder, 'small ghost'))
  }

  function renderTurn(index) {
    const turn = state.turns.get(index)
    if (!turn) return
    const existing = nodes.get(index)
    if (existing && existing.turn === turn) return
    const node = turnNode(turn)
    if (existing) {
      const active = document.activeElement
      const focusKey = active && existing.node.contains(active) ? active.getAttribute('data-focus') : null
      const above = existing.node.getBoundingClientRect().bottom <= chatScroll.getBoundingClientRect().top
      const height = existing.node.offsetHeight
      existing.node.replaceWith(node)
      if (above) chatScroll.scrollTop += node.offsetHeight - height
      if (focusKey) {
        const next = node.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`)
        if (next) next.focus({ preventScroll: true })
      }
    } else {
      let before = null
      for (const [other, entry] of nodes) if (other > index && (!before || other < before.index)) before = { index: other, node: entry.node }
      if (before) before.node.before(node)
      else list.append(node)
    }
    nodes.set(index, { node, turn })
    if (state.detail && !slideover.hidden) {
      const parsed = parseDetail(state.detail)
      if (parsed && parsed.index === index) renderDetail()
    }
  }

  function crumbs(data) {
    const parts = [link(urlFor({ view: 'conversations' }), { class: 'crumb' }, 'Conversations')]
    if (data && data.project) parts.push(el('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'), link(urlFor({ view: 'conversations', project: data.project }), { class: 'crumb', 'data-focus': 'crumb-project' }, data.projectName))
    return el('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, parts)
  }

  function headContent(data) {
    const badges = [badge(data.status, data.statusLabel), data.whereLabel ? badge('neutral', data.whereLabel) : null]
    return [el('h1', { class: 'chat-title' }, data.title), el('div', { class: 'convo-meta' }, el('span', { class: 'badges' }, badges), el('span', null, joinMeta([data.projectLabel, data.modelsLabel, data.tokensLabel])))]
  }

  function turnNode(turn) {
    const selected = state.selected === turn.index
    const group = el('article', { class: `msg-group msg-${turn.kind}${selected ? ' is-selected' : ''}`, id: `turn-${turn.index}`, 'aria-label': `Message ${turn.number}` })
    group.append(senderView(turn))
    const hasReply = turn.segments.length > 0 || Boolean(turn.emptyLabel) || Boolean(turn.footLabel)
    if (state.repliesCollapsed && hasReply) group.append(replyToggle(turn))
    if (replyHidden(turn) && hasReply) return group
    if (turn.segments.length) group.append(el('div', { class: 'msg-claude' }, turn.segments.map((segment) => segmentView(turn, segment))))
    else if (turn.emptyLabel && !(isWorking() && turn.index === summaries().length - 1)) group.append(el('p', { class: 'msg-empty' }, turn.emptyLabel))
    if (turn.footLabel && embedded) group.append(el('p', { class: 'msg-foot is-static' }, turn.footLabel))
    else if (turn.footLabel) {
      group.append(
        el(
          'button',
          { class: 'msg-foot', type: 'button', 'aria-pressed': String(selected), 'aria-controls': side.id, 'data-focus': `foot-${turn.index}`, title: 'Show the tokens of this message', onclick: () => selectTurn(turn.index) },
          turn.footLabel,
        ),
      )
    }
    return group
  }

  function senderView(turn) {
    const prompt = turn.prompt
    const key = `prompt-${turn.index}`
    if (turn.kind === 'start') return el('p', { class: 'msg-meta msg-continued' }, turn.title)
    if (turn.kind === 'notification') {
      return el(
        'div',
        { class: 'msg-event' },
        el('p', { class: 'msg-meta' }, joinMeta([turn.kindLabel, turn.atLabel])),
        el(
          'div',
          { class: 'event-box' },
          el('p', { class: 'event-title' }, turn.title, turn.statusLabel ? badge(turn.status === 'completed' ? 'done' : turn.status, turn.statusLabel) : null),
          prompt.result
            ? disclosure({
                label: 'Show the result Claude received',
                open: state.ui.markers.has(key),
                onToggle: () => toggleSet(state.ui.markers, key),
                focusKey: `result-${key}`,
                className: 'small-toggle',
                content: () => [el('pre', { class: 'code' }, prompt.result), prompt.resultNote ? el('p', { class: 'note' }, prompt.resultNote) : null],
              })
            : null,
        ),
      )
    }
    if (turn.kind === 'peer') {
      return el(
        'div',
        { class: 'msg-event' },
        el('p', { class: 'msg-meta' }, joinMeta([turn.kindLabel, turn.atLabel])),
        el('div', { class: 'event-box' }, clampable(renderMarkdown(prompt.text), { long: prompt.long, key, openSet: state.ui.text, className: 'md small-md' }), prompt.truncatedNote ? el('p', { class: 'note' }, prompt.truncatedNote) : null),
      )
    }
    return el(
      'div',
      { class: 'msg-user' },
      el('p', { class: 'msg-meta' }, joinMeta([turn.kind === 'prompt' ? null : turn.kindLabel, turn.atLabel])),
      prompt.text ? clampable(el('span', null, prompt.text), { long: prompt.long, key, openSet: state.ui.text, className: 'bubble' }) : null,
      prompt.attachmentsLabel ? el('p', { class: 'note' }, `Attached: ${prompt.attachmentsLabel}`) : null,
      prompt.requestLabel ? el('p', { class: 'note' }, prompt.requestLabel) : null,
      prompt.truncatedNote ? el('p', { class: 'note' }, prompt.truncatedNote) : null,
    )
  }

  function segmentView(turn, segment) {
    let tone = 'text'
    let content
    if (segment.type === 'marker') {
      tone = segment.kind === 'error' || segment.kind === 'hook' ? 'error' : segment.kind === 'interrupted' || segment.kind === 'notice' ? 'warning' : 'muted'
      content = markerView(segment)
    } else if (segment.type === 'text') {
      content = [clampable(renderMarkdown(segment.text), { long: segment.long, key: segment.key, openSet: state.ui.text, className: 'md' }), segment.truncatedNote ? el('p', { class: 'note' }, segment.truncatedNote) : null]
    } else if (segment.type === 'activity') {
      tone = segment.status
      content = activityView(turn, segment)
    } else if (segment.kind === 'agent') {
      tone = segment.agent && segment.agent.status === 'working' ? 'pending' : segment.status === 'error' ? 'error' : 'done'
      content = agentToolView(segment)
    } else {
      tone = segment.workflow.status === 'working' || segment.workflow.status === 'inactive' ? 'pending' : segment.workflow.status === 'failed' ? 'error' : 'done'
      content = workflowToolView(segment)
    }
    return el('div', { class: `seg seg-${segment.type} tone-${tone}`, 'data-steps': segment.steps.join(' '), 'data-step': segment.step || null }, content)
  }

  function activityView(turn, segment) {
    const parts = [el('span', { class: 'activity-label' }, segment.label), segment.detail ? el('span', { class: 'activity-detail' }, segment.detail) : null, segment.note ? el('span', { class: 'activity-note' }, segment.note) : null]
    if (!segment.clickable) return el('p', { class: 'activity-line is-static' }, parts)
    return el('button', { class: 'activity-line', type: 'button', 'aria-haspopup': 'dialog', 'data-focus': `activity-${segment.key}`, onclick: () => openDetail(turn.index, segment.key) }, parts)
  }

  function agentToolView(tool) {
    const agent = tool.agent
    return el(
      'div',
      { class: 'agent-card' },
      el('div', { class: 'agent-card-head' }, el('span', { class: 'agent-kind' }, tool.subagentLabel), agent ? badge(agent.status, agent.statusLabel) : null),
      el('p', { class: 'agent-title' }, tool.target || 'Agent'),
      el('p', { class: 'agent-meta' }, agent ? joinMeta([agent.tokensLabel, agent.callsLabel, tool.backgroundLabel]) : joinMeta([tool.statusLabel, tool.backgroundLabel])),
      agent && agent.status === 'working' ? agentLive(agent.id) : null,
      el(
        'div',
        { class: 'agent-actions' },
        agent ? agentLink(agent.id, { class: 'button small', 'data-focus': `agent-${tool.key}` }, 'Open agent') : el('span', { class: 'meta' }, 'This agent has no transcript on this computer.'),
        tool.detail ? disclosure({ label: 'Task it got', open: state.ui.inputs.has(tool.key), onToggle: () => toggleSet(state.ui.inputs, tool.key), focusKey: `input-${tool.key}`, className: 'small-toggle', content: () => el('pre', { class: 'code' }, tool.detail) }) : null,
      ),
    )
  }

  function workflowAgents(workflow) {
    if (!workflow.phases.length) return el('p', { class: 'meta' }, 'No agent of this workflow has a transcript yet.')
    return workflow.phases.map((phase) =>
      el(
        'div',
        { class: 'phase' },
        el('p', { class: 'phase-title' }, phase.title),
        el(
          'ul',
          { class: 'phase-list' },
          phase.agents.map((agent) =>
            el('li', null, agentLink(agent.id, { class: 'phase-agent', 'data-focus': `phase-${agent.id}` }, el('span', { class: 'phase-name' }, agent.description || agent.typeLabel), badge(agent.status, agent.statusLabel), el('span', { class: 'phase-tokens' }, agent.tokensLabel)), agent.status === 'working' ? agentLive(agent.id) : null),
          ),
        ),
      ),
    )
  }

  function workflowToolView(tool) {
    const workflow = tool.workflow
    return el(
      'div',
      { class: 'agent-card workflow-card' },
      el('div', { class: 'agent-card-head' }, el('span', { class: 'agent-kind' }, 'Workflow'), badge(workflow.status, workflow.statusLabel)),
      el('p', { class: 'agent-title' }, workflow.name),
      workflow.summary ? el('p', { class: 'agent-summary' }, workflow.summary) : null,
      el('p', { class: 'agent-meta' }, joinMeta([workflow.tokensLabel, workflow.agentsLabel])),
      el(
        'div',
        { class: 'agent-actions column' },
        disclosure({ label: `Show its ${workflow.agentsLabel}`, open: state.ui.agents.has(tool.key), onToggle: () => toggleSet(state.ui.agents, tool.key), focusKey: `agents-${tool.key}`, className: 'small-toggle', content: () => workflowAgents(workflow) }),
      ),
    )
  }

  function markerView(marker) {
    const key = `marker-${marker.kind}-${marker.atLabel}-${marker.label}`
    const node = el('div', { class: `chat-marker marker-${marker.kind}` }, el('p', { class: 'marker-line' }, el('span', { class: 'marker-label' }, marker.label), marker.statusLabel ? badge('neutral', marker.statusLabel) : null, el('span', { class: 'marker-when' }, marker.atLabel)))
    if (marker.text && marker.kind === 'queued') node.append(clampable(el('span', null, marker.text), { long: marker.long, key, openSet: state.ui.text, className: 'bubble' }))
    else if (marker.text && marker.kind === 'peer') node.append(clampable(renderMarkdown(marker.text), { long: marker.long, key, openSet: state.ui.text, className: 'md small-md' }))
    else if (marker.text) node.append(el('p', { class: 'marker-text' }, marker.text))
    if (marker.detail) node.append(el('div', { class: 'marker-detail' }, disclosure({ label: marker.detailLabel, open: state.ui.markers.has(key), onToggle: () => toggleSet(state.ui.markers, key), focusKey: `detail-${key}`, className: 'small-toggle', content: () => el('div', { class: 'md small-md' }, renderMarkdown(marker.detail)) })))
    return node
  }

  function sideCard(title, ...content) {
    return el('section', { class: 'side-card' }, title ? el('h2', { class: 'side-card-title' }, title) : null, ...content)
  }

  function miniStat(label, value) {
    return el('div', { class: 'mini-stat' }, el('span', { class: 'mini-label' }, label), el('span', { class: 'mini-value' }, value))
  }

  function callRow(call) {
    const open = state.ui.calls.has(call.key)
    const usageId = `usage-${call.key}`
    const usage = el(
      'div',
      { class: 'call-usage', id: usageId, hidden: !open },
      el('p', { class: 'usage-line' }, joinMeta([call.speedLabel, call.atLabel, call.durationLabel ? `Took ${call.durationLabel}` : null, call.stopLabel])),
      el('p', { class: 'usage-line' }, `Context sent: ${call.contextLabel}`),
      el(
        'div',
        { class: 'usage-grid', role: 'table', 'aria-label': `Tokens of model call ${call.number}` },
        call.usage.map((row) =>
          el('div', { class: 'usage-row', role: 'row' }, el('span', { class: 'usage-label', role: 'cell' }, row.label, row.note ? el('span', { class: 'usage-note' }, row.note) : null), el('span', { class: 'num', role: 'cell' }, row.value), el('span', { class: 'num', role: 'cell' }, row.share)),
        ),
      ),
      el('button', { class: 'text-button', type: 'button', onclick: () => revealStep(call.key) }, 'Show it in the chat'),
    )
    const row = el(
      'button',
      {
        class: 'call-row',
        type: 'button',
        'aria-expanded': String(open),
        'aria-controls': usageId,
        'data-focus': `call-${call.key}`,
        onclick: () => {
          const next = toggleSet(state.ui.calls, call.key)
          usage.hidden = !next
          row.setAttribute('aria-expanded', String(next))
          if (next && !drawerMode()) revealStep(call.key)
        },
      },
      el('span', { class: 'call-row-title' }, `Call ${call.number} · ${call.modelLabel}`),
      el('span', { class: 'call-row-tokens' }, call.tokensLabel),
      el('span', { class: 'call-row-text' }, call.summaryLabel),
      el('span', { class: 'call-row-meta' }, call.durationLabel),
      heat(call.share),
    )
    return el('li', { class: 'call-item' }, row, usage)
  }

  function selectedCard(turn) {
    const close = el('button', { class: 'button small ghost', type: 'button', 'data-focus': 'clear-selection', onclick: () => selectTurn(turn.index) }, 'Close')
    return el(
      'section',
      { class: 'side-card selected-card', 'aria-label': `Message ${turn.number}` },
      el('div', { class: 'side-card-row' }, el('h2', { class: 'side-card-title' }, `Message ${turn.number}`), close),
      el('p', { class: 'meta' }, joinMeta([turn.kindLabel, turn.atLabel])),
      el('p', { class: 'side-total' }, turn.tokensLabel),
      turn.factsLabel ? el('p', { class: 'meta' }, turn.factsLabel) : null,
      turn.agentTokensLabel ? el('p', { class: 'note' }, `This includes ${turn.agentTokensLabel}.`) : null,
      turn.calls.length ? el('h3', { class: 'side-subtitle' }, 'Model calls') : null,
      turn.calls.length ? el('ul', { class: 'call-list' }, turn.calls.map(callRow)) : el('p', { class: 'meta' }, 'This message has no model calls.'),
      turn.agents.length ? el('h3', { class: 'side-subtitle' }, 'Agents it started') : null,
      turn.agents.length
        ? el(
            'ul',
            { class: 'rail-list' },
            turn.agents.map((agent) =>
              el('li', null, agentLink(agent.id, { class: 'rail-link', 'data-focus': `selected-agent-${agent.id}` }, el('span', { class: 'rail-link-title' }, agent.status === 'working' ? spinner() : null, agent.description || agent.typeLabel), el('span', { class: 'rail-link-value' }, agent.tokensLabel), el('span', { class: 'rail-link-text' }, joinMeta([agent.statusLabel, agent.typeLabel])))),
            ),
          )
        : null,
    )
  }

  function sideContent(data) {
    const cards = []
    const selected = state.selected !== null ? state.turns.get(state.selected) : null
    cards.push(usageCard)
    if (selected) cards.push(selectedCard(selected))
    const view = data.timeline
    const stats = [miniStat('Model calls', data.messagesLabel), miniStat('Agents', data.agentsLabel), miniStat('Messages', view ? view.countLabel : 'None'), miniStat('Lasted', data.durationLabel || 'Unknown')]
    cards.push(
      sideCard(
        'This conversation',
        el('p', { class: 'side-total' }, data.tokensLabel),
        el('div', { class: 'mini-stats' }, stats),
        isLive() ? el('p', { class: 'note' }, 'Still running. The numbers update every 3 seconds.') : null,
      ),
    )
    cards.push(
      sideCard(
        'Tokens',
        shareRows(data.tokens),
        el('p', { class: 'note' }, 'Every model call sends the whole conversation again. Most of it comes from the cache, which is why cache reads are the biggest number.'),
        data.agentsNote ? el('p', { class: 'note' }, data.agentsNote) : null,
      ),
    )
    cards.push(sideCard('Agents', agentsSide(data)))
    if (data.models.length > 1) cards.push(sideCard('Models', el('div', { class: 'rail-rows' }, data.models.map((model) => el('div', { class: 'rail-row' }, el('span', null, model.label), el('span', { class: 'num' }, model.tokensLabel))))))
    cards.push(sideCard('Details', detailsSide(data)))
    return cards
  }

  function agentsSide(data) {
    if (!data.agentGroups.length) return el('p', { class: 'meta' }, 'This conversation did not start any subagents or workflows.')
    return data.agentGroups.map((group) =>
      el(
        'div',
        { class: 'rail-group' },
        el('p', { class: 'rail-group-title' }, el('span', null, group.title), el('span', { class: 'num' }, group.tokensLabel)),
        el(
          'ul',
          { class: 'rail-list' },
          group.agents.slice(0, 8).map((agent) =>
            el('li', null, agentLink(agent.id, { class: 'rail-link', 'data-focus': `side-agent-${agent.id}` }, el('span', { class: 'rail-link-title' }, agent.status === 'working' ? spinner() : null, agent.description || agent.typeLabel), el('span', { class: 'rail-link-value' }, agent.tokensLabel), el('span', { class: 'rail-link-text' }, joinMeta([agent.statusLabel, agent.typeLabel])))),
          ),
        ),
        group.agents.length > 8 ? el('p', { class: 'meta' }, `And ${group.agents.length - 8} more. Open them from the workflow card in the chat.`) : null,
      ),
    )
  }

  function detailsSide(data) {
    return [
      el(
        'dl',
        { class: 'facts' },
        fact('Folder', data.projectLabel),
        fact('Started', data.startedDateLabel),
        fact('Last active', data.lastActiveDateLabel),
        fact('ID', data.id),
        data.configDir ? fact('Config folder', data.configDir) : null,
        data.claudeCodeVersion ? fact('Claude Code', data.claudeCodeVersion) : null,
      ),
      el('div', { class: 'resume' }, el('p', { class: 'code-label' }, 'Resume in a terminal'), el('code', { class: 'resume-command' }, data.resumeCommand), el('div', { class: 'resume-actions' }, copyButton(data.resumeCommand))),
    ]
  }

  renderFrame()
  load(false)
  const stopLive = live.subscribe(renderLive)
  if (!embedded && initialParams.get('agent')) openAgent(initialParams.get('agent'), initialParams)

  return {
    update(params) {
      const agentId = embedded ? null : params.get('agent')
      if (agentId) {
        hideDetail()
        openAgent(agentId, params)
        return
      }
      if (!embedded) dropAgent()
      const detail = params.get('detail')
      if (detail) {
        if (detail !== state.detail || (embedded ? slideBody.hidden : slideover.hidden)) showDetail(detail)
      } else hideDetail()
    },
    escape() {
      if (embedded && !slideBody.hidden) closeDetail()
      else if (embedded) options.onClose()
    },
    depth() {
      return state.detailOpenedHere ? 1 : 0
    },
    destroy() {
      destroyed = true
      request++
      window.clearTimeout(timer)
      if (accountUsage) accountUsage.stop()
      stopLive()
      observer.disconnect()
      if (embedded) {
        slideover.remove()
        slideBackdrop.remove()
        return
      }
      if (agentView) agentView.destroy()
      agentView = null
      document.removeEventListener('keydown', onKey)
    },
  }
}
