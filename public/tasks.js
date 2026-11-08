import { el, link, urlFor, navigate, setTitle, createResource, createMenu, every, keepFocus, stateBlock, errorBlock, banner, button, icon, getJson, postJson, statusDot, activityText, linesSkeleton } from './ui.js'
import { chatLink } from './panels.js'
import { pageShell, paramsOf, apiQuery, searchInput } from './pages.js'

const REFRESH_MS = 4000
const FILTERS = ['status', 'category', 'who', 'type', 'q']
const NEW_TASK = 'new'

function fieldBlock(label, control, help) {
  const error = el('p', { class: 'form-error', role: 'alert', hidden: true })
  return {
    error,
    node: el(
      'div',
      { class: 'field task-field' },
      el('span', { class: 'task-label' }, label, help ? el('span', { class: 'task-help', role: 'img', tabindex: '0', 'aria-label': help, title: help }, icon('info')) : null),
      control,
      error,
    ),
  }
}

function createChoice(label, onChange) {
  const holder = el('div', { class: 'menu' })
  let items = []
  let selected = ''
  const menu = createMenu(holder, {
    label,
    onSelect: (key) => {
      selected = key
      render()
      if (onChange) onChange(key)
    },
  })
  function render() {
    const entry = items.find((item) => item.key === selected)
    menu.render(entry ? entry.label : '', items, selected)
  }
  return {
    node: holder,
    get value() {
      return selected
    },
    set(nextItems, value) {
      items = nextItems
      selected = value
      render()
    },
    close: () => menu.close(),
  }
}

function createTaskPanel({ onSaved, onClose }) {
  let openId = null
  let detail = null
  let options = null
  let request = 0
  let saving = false
  let returnFocus = null

  const meta = el('p', { class: 'meta' })
  const title = el('h2', { class: 'slideover-title', id: 'task-panel-title' })
  const closeButton = el('button', { class: 'icon-button', type: 'button', 'aria-label': 'Close the task', onclick: () => onClose() }, icon('close'))
  const body = el('div', { class: 'slideover-body scroll-area' })
  const foot = el('div', { class: 'skill-foot task-foot' })
  const form = el(
    'form',
    {
      class: 'task-form',
      novalidate: true,
      onsubmit: (event) => {
        event.preventDefault()
        submit()
      },
    },
    body,
    foot,
  )
  const backdrop = el('div', { class: 'slideover-backdrop', hidden: true, onclick: () => onClose() })
  const panel = el('aside', { class: 'slideover task-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'task-panel-title', hidden: true }, el('div', { class: 'slideover-head' }, el('div', { class: 'slideover-heading' }, meta, title), closeButton), form)
  document.body.append(backdrop, panel)

  const categoryList = el('datalist', { id: 'task-category-options' })
  const groupList = el('datalist', { id: 'task-group-options' })
  const inputs = {
    title: el('input', { class: 'input task-input', type: 'text', maxlength: '300', dir: 'auto', autocomplete: 'off', 'aria-label': 'Title' }),
    category: el('input', { class: 'input task-input', type: 'text', maxlength: '60', dir: 'auto', autocomplete: 'off', list: 'task-category-options', 'aria-label': 'Category', placeholder: 'Inbox' }),
    group: el('input', { class: 'input task-input', type: 'text', maxlength: '120', dir: 'auto', autocomplete: 'off', list: 'task-group-options', 'aria-label': 'Group' }),
    note: el('textarea', { class: 'input task-note', rows: '6', dir: 'auto', 'aria-label': 'Note' }),
  }
  const owner = createChoice('Who this is on')
  const status = createChoice('Status')
  const conversation = createChoice('Conversation')
  const fields = {
    title: fieldBlock('Title', inputs.title),
    category: fieldBlock('Category', [inputs.category, categoryList], 'The project or area this belongs to. Each category gets its own list, and typing a new name creates it.'),
    group: fieldBlock('Group', [inputs.group, groupList], 'An optional heading inside the category, such as one phase of a plan. Tasks with the same group show together.'),
    owner: fieldBlock('Who', owner.node, 'Who has to act next. On you and On both of us show up when you filter for what is on you.'),
    status: fieldBlock('Status', status.node, 'Now is what we are working on at the moment. Next is what comes after it, and Later is everything else.'),
    conversationId: fieldBlock('Conversation', conversation.node, 'Links an open Claude Code conversation, so you can jump to the place where this work is happening.'),
    note: fieldBlock('Note', inputs.note),
  }
  const generalError = el('p', { class: 'form-error task-general-error', role: 'alert', hidden: true })
  const saveButton = el('button', { class: 'button primary', type: 'submit' }, 'Save')
  const cancelButton = button('Cancel', () => onClose())
  const archiveButton = button('Archive', () => archive(), 'ghost task-foot-end')

  inputs.category.addEventListener('input', fillGroups)

  function fillGroups() {
    const groups = (options && options.groups[inputs.category.value.trim()]) || []
    groupList.replaceChildren(...groups.map((name) => el('option', { value: name })))
  }

  function clearErrors() {
    for (const field of Object.values(fields)) field.error.hidden = true
    generalError.hidden = true
  }

  function showError(reason) {
    const field = reason.field && fields[reason.field]
    const target = field ? field.error : generalError
    target.textContent = reason.message
    target.hidden = false
  }

  function fill(values, nextOptions) {
    options = nextOptions
    inputs.title.value = values.title
    inputs.category.value = values.category
    inputs.group.value = values.group
    inputs.note.value = values.note
    categoryList.replaceChildren(...options.categories.map((name) => el('option', { value: name })))
    fillGroups()
    owner.set(options.owners, values.owner)
    status.set(options.statuses, values.status)
    conversation.set([{ key: '', label: 'None' }, ...options.conversations.map((row) => ({ key: row.id, label: row.title }))], values.conversationId || '')
    clearErrors()
    body.replaceChildren(...Object.values(fields).map((field) => field.node))
    archiveButton.textContent = values.archived ? 'Restore' : 'Archive'
    foot.replaceChildren(...[saveButton, cancelButton, values.id ? archiveButton : null, generalError].filter(Boolean))
    setBusy(false)
  }

  function setBusy(value) {
    saving = value
    saveButton.disabled = value
    archiveButton.disabled = value
  }

  function values() {
    return {
      title: inputs.title.value,
      note: inputs.note.value,
      category: inputs.category.value,
      group: inputs.group.value,
      owner: owner.value,
      status: status.value,
      conversationId: conversation.value || null,
    }
  }

  function changedValues() {
    const next = values()
    const changed = {}
    for (const [key, value] of Object.entries(next)) if (value !== (detail[key] ?? (key === 'conversationId' ? null : ''))) changed[key] = value
    return changed
  }

  async function submit() {
    if (saving || !openId) return
    clearErrors()
    setBusy(true)
    try {
      if (detail) {
        const changed = changedValues()
        if (Object.keys(changed).length) await postJson('/api/tasks/update', { id: detail.id, ...changed })
      } else await postJson('/api/tasks/add', values())
      onSaved()
      onClose()
    } catch (reason) {
      showError(reason)
      setBusy(false)
    }
  }

  async function archive() {
    if (saving || !detail) return
    clearErrors()
    setBusy(true)
    try {
      await postJson('/api/tasks/update', { id: detail.id, archived: !detail.archived })
      onSaved()
      onClose()
    } catch (reason) {
      showError(reason)
      setBusy(false)
    }
  }

  async function load(id) {
    const mine = ++request
    body.replaceChildren(linesSkeleton(6))
    foot.replaceChildren()
    try {
      const task = await getJson(`/api/task?${new URLSearchParams({ id })}`)
      if (mine !== request || openId !== id) return
      detail = task
      title.textContent = task.title
      meta.textContent = task.metaLabel
      fill({ ...task }, task.options)
      inputs.title.focus({ preventScroll: true })
    } catch (reason) {
      if (mine !== request || openId !== id) return
      body.replaceChildren(errorBlock('Could not load this task', reason.message, () => load(id)))
    }
  }

  function show() {
    if (panel.hidden) returnFocus = document.activeElement
    backdrop.hidden = false
    panel.hidden = false
  }

  function hide() {
    if (panel.hidden) return
    request++
    openId = null
    detail = null
    owner.close()
    status.close()
    conversation.close()
    panel.hidden = true
    backdrop.hidden = true
    body.replaceChildren()
    foot.replaceChildren()
    if (returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true })
    returnFocus = null
  }

  const onKey = (event) => {
    if (event.key !== 'Escape' || event.defaultPrevented || panel.hidden) return
    event.preventDefault()
    onClose()
  }
  window.addEventListener('keydown', onKey)

  return {
    sync(id, defaults, currentOptions) {
      if (!id) return hide()
      if (id === openId) return
      show()
      openId = id
      detail = null
      if (id === NEW_TASK) {
        title.textContent = 'New task'
        meta.textContent = 'Tasks'
        fill({ title: '', note: '', category: defaults.category, group: '', owner: 'you', status: defaults.status, conversationId: null, archived: false, id: null }, currentOptions || { categories: [], groups: {}, conversations: [], owners: defaults.owners, statuses: defaults.statuses })
        inputs.title.focus({ preventScroll: true })
      } else {
        title.textContent = 'Task'
        meta.textContent = 'Tasks'
        load(id)
      }
    },
    destroy() {
      request++
      window.removeEventListener('keydown', onKey)
      backdrop.remove()
      panel.remove()
    },
  }
}

function sectionHead(title, count, href) {
  return el('div', { class: 'task-section-head' }, el('h2', { class: 'task-section-title', dir: 'auto' }, href ? link(href, { class: 'task-section-link' }, title) : title), count ? el('span', { class: 'task-section-count' }, count) : null)
}

function taskRow(row, actions) {
  const conversation = row.conversation
  return el(
    'li',
    { class: row.done ? 'task-row is-done' : 'task-row' },
    el('input', {
      class: 'task-check',
      type: 'checkbox',
      checked: row.done,
      disabled: row.archived,
      'aria-label': row.done ? `Mark as not done: ${row.title}` : `Mark as done: ${row.title}`,
      'data-focus': `check-${row.id}`,
      onchange: (event) => actions.setDone(row, event.target.checked),
    }),
    el('button', { class: 'task-main', type: 'button', 'aria-haspopup': 'dialog', 'data-focus': `task-${row.id}`, onclick: () => actions.open(row.id) }, el('span', { class: 'task-title', dir: 'auto' }, row.title), el('span', { class: 'task-meta' }, row.metaLabel)),
    conversation ? chatLink(conversation.id, null, { class: 'task-conversation', title: conversation.title, 'data-focus': `chat-${row.id}` }, conversation.live ? statusDot(conversation) : null, el('span', null, conversation.label)) : null,
    row.canStart ? el('button', { class: 'button small', type: 'button', 'data-focus': `start-${row.id}`, onclick: () => actions.start(row) }, 'Start') : null,
  )
}

function sectionNode(section, actions) {
  return el(
    'section',
    { class: 'task-section', 'aria-label': section.title },
    sectionHead(section.title, section.countLabel, section.category ? urlFor({ view: 'tasks', category: section.category }) : null),
    section.groups.map((group) => [group.title ? el('h3', { class: 'task-group-title', dir: 'auto' }, group.title) : null, el('ul', { class: 'task-rows' }, group.rows.map((row) => taskRow(row, actions)))]),
  )
}

function conversationRow(row) {
  return el(
    'li',
    { class: 'task-row' },
    el('span', { class: 'task-status' }, statusDot(row)),
    chatLink(row.id, null, { class: 'task-main', 'data-focus': `conversation-${row.id}` }, el('span', { class: 'task-title', dir: 'auto' }, row.title), el('span', { class: 'task-meta' }, row.activity ? activityText(row.activity, [row.metaLabel]) : row.metaLabel)),
  )
}

function conversationsNode(rows) {
  return el('section', { class: 'task-section', 'aria-label': 'Conversations' }, sectionHead('Conversations', `${rows.length} open`), el('ul', { class: 'task-rows' }, rows.map(conversationRow)))
}

function categoriesNode(cards) {
  return el(
    'section',
    { class: 'task-section', 'aria-label': 'Categories' },
    sectionHead('Categories'),
    el(
      'div',
      { class: 'plugin-grid' },
      cards.map((card) => link(urlFor({ view: 'tasks', category: card.name }), { class: 'plugin-card task-category', 'data-focus': `category-${card.name}` }, el('span', { class: 'plugin-name', dir: 'auto' }, card.name), el('span', { class: 'meta' }, card.label))),
    ),
  )
}

export function tasksPage(container, params) {
  let query = params
  let latest = null
  let tasksSeen = null
  let conversationsSeen = null
  let controlsSeen = null
  setTitle('Tasks')
  const shell = pageShell(container, { title: 'Tasks' })
  shell.actions.append(button('New task', () => openTask(NEW_TASK), 'primary'))

  const holders = { status: el('div', { class: 'menu' }), category: el('div', { class: 'menu' }), who: el('div', { class: 'menu' }), type: el('div', { class: 'menu' }) }
  const search = searchInput('Search tasks and conversations', query.get('q') || '', (value) => go({ q: value || null }, true))
  const summary = el('p', { class: 'page-meta' })
  const notice = el('div', { class: 'task-notice' })
  const tasksArea = el('div', { class: 'task-sections' })
  const conversationsArea = el('div', { class: 'task-sections' })
  const categoriesArea = el('div', { class: 'task-sections' })
  shell.body.append(el('div', { class: 'toolbar' }, holders.status, holders.category, holders.who, holders.type, search.node), summary, notice, el('div', { class: 'task-layout' }, tasksArea, conversationsArea, categoriesArea))

  const menus = {
    status: createMenu(holders.status, { label: 'Status', onSelect: (key) => go({ status: latest && key === latest.filters.statusDefault ? null : key }) }),
    category: createMenu(holders.category, { label: 'Category', onSelect: (key) => go({ category: key || null, status: null }) }),
    who: createMenu(holders.who, { label: 'Who', onSelect: (key) => go({ who: key || null }) }),
    type: createMenu(holders.type, { label: 'Type', onSelect: (key) => go({ type: key || null }) }),
  }

  function current() {
    return paramsOf(query, FILTERS)
  }

  function go(changes, replace) {
    navigate(urlFor({ view: 'tasks', ...current(), ...changes }), { replace })
  }

  function openTask(id) {
    navigate(urlFor({ view: 'tasks', ...current(), task: id }))
  }

  function closeTask() {
    if (query.get('task')) navigate(urlFor({ view: 'tasks', ...current() }))
  }

  const panel = createTaskPanel({ onSaved: () => resource.load({ silent: true }), onClose: closeTask })

  async function change(payload) {
    notice.replaceChildren()
    try {
      await postJson('/api/tasks/update', payload)
    } catch (reason) {
      notice.replaceChildren(banner(`That change was not saved. ${reason.message}`))
      tasksSeen = null
    }
    resource.load({ silent: true })
  }

  const actions = {
    open: openTask,
    start: (row) => change({ id: row.id, status: 'now' }),
    setDone: (row, done) => change({ id: row.id, status: done ? 'done' : 'next' }),
  }

  function renderControls(data) {
    const signature = JSON.stringify([data.filters, data.menus])
    if (signature === controlsSeen) return
    controlsSeen = signature
    for (const key of ['status', 'category', 'who', 'type']) {
      const selected = data.filters[key]
      const entry = data.menus[key].find((item) => item.key === selected) || data.menus[key][0]
      menus[key].render(entry.label, data.menus[key], entry.key)
    }
  }

  function emptyState(data) {
    if (data.filters.type === 'conversations') return null
    if (!data.filtered && !data.totalTasks) {
      return stateBlock({
        title: 'Nothing to track yet',
        text: 'Add what you and Claude are working on. Open Claude Code conversations show up here by themselves.',
        actions: [button('New task', () => openTask(NEW_TASK), 'primary')],
      })
    }
    if (data.filtered) return stateBlock({ title: 'Nothing matches these filters', actions: [button('Clear filters', () => navigate(urlFor({ view: 'tasks' })))] })
    return stateBlock({
      title: 'Nothing in Now',
      text: 'Move a task here when you start on it.',
      actions: [button('See Next', () => go({ status: 'next' })), button('New task', () => openTask(NEW_TASK))],
    })
  }

  function renderTasks(data) {
    const signature = JSON.stringify([data.sections, data.categories, data.filtered, data.totalTasks])
    if (signature === tasksSeen) return
    tasksSeen = signature
    keepFocus(tasksArea, () => {
      const empty = data.sections.length ? null : emptyState(data)
      tasksArea.replaceChildren(...(empty ? [empty] : data.sections.map((section) => sectionNode(section, actions))))
    })
    keepFocus(categoriesArea, () => categoriesArea.replaceChildren(...(data.categories.length ? [categoriesNode(data.categories)] : [])))
  }

  function renderConversations(data) {
    const signature = JSON.stringify(data.conversations)
    if (signature === conversationsSeen) return
    conversationsSeen = signature
    keepFocus(conversationsArea, () => conversationsArea.replaceChildren(...(data.conversations.length ? [conversationsNode(data.conversations)] : [])))
  }

  function render(state) {
    if (state.status === 'loading' || (state.status === 'refreshing' && !state.data)) {
      tasksSeen = null
      return tasksArea.replaceChildren(linesSkeleton(6))
    }
    if (state.status === 'error') {
      tasksSeen = null
      conversationsSeen = null
      summary.textContent = ''
      conversationsArea.replaceChildren()
      categoriesArea.replaceChildren()
      return tasksArea.replaceChildren(errorBlock('Could not load your tasks', state.error, () => resource.load()))
    }
    latest = state.data
    renderControls(latest)
    summary.textContent = latest.summaryLabel
    if (state.refreshError) notice.replaceChildren(banner(`${state.refreshError} Showing the last list.`))
    renderTasks(latest)
    renderConversations(latest)
    syncPanel()
  }

  function syncPanel() {
    const status = query.get('status')
    panel.sync(query.get('task'), { category: query.get('category') || '', status: status === 'next' || status === 'later' ? status : latest && latest.filters.status === 'now' ? 'now' : 'next', owners: latest ? latest.options.owners : [], statuses: latest ? latest.options.statuses : [] }, latest ? latest.options : null)
  }

  const resource = createResource(() => {
    const text = apiQuery(current())
    return text ? `/api/tasks?${text}` : '/api/tasks'
  }, render)
  resource.load()
  const stop = every(REFRESH_MS, () => {
    if (resource.state.status === 'ready') resource.load({ silent: true })
  })

  return {
    update(next) {
      const before = apiQuery(current())
      query = next
      search.sync(query.get('q') || '')
      if (apiQuery(current()) !== before) {
        notice.replaceChildren()
        resource.load()
      }
      if (latest) syncPanel()
    },
    destroy() {
      stop()
      search.stop()
      resource.cancel()
      panel.destroy()
      for (const menu of Object.values(menus)) menu.close()
    },
  }
}
