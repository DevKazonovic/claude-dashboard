const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const format = require('./format')
const { buildLive } = require('./views')

const STATUSES = ['now', 'next', 'later', 'done']
const STATUS_FILTERS = ['now', 'next', 'later', 'open', 'done', 'archived']
const STATUS_LABELS = { now: 'Now', next: 'Next', later: 'Later', done: 'Done', open: 'All open', archived: 'Archived' }
const OWNERS = ['you', 'claude', 'both']
const OWNER_LABELS = { you: 'On you', claude: 'On Claude', both: 'On both of us' }
const WHO_FILTERS = ['', ...OWNERS]
const TYPE_FILTERS = ['', 'tasks', 'conversations']
const TYPE_LABELS = { '': 'Tasks and conversations', tasks: 'Tasks', conversations: 'Conversations' }
const AUTHORS = { you: 'you', claude: 'Claude' }
const DEFAULT_CATEGORY = 'Inbox'
const CONVERSATION_ID = /^[A-Za-z0-9_-]{6,100}$/
const LIMITS = { title: 300, note: 20000, category: 60, group: 120 }
const FILE_VERSION = 1

class TaskError extends Error {
  constructor(status, message, field) {
    super(message)
    this.status = status
    this.field = field || null
  }
}

function defaultDataDir() {
  const home = os.homedir()
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'claude-dashboard')
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'claude-dashboard')
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'claude-dashboard')
}

function cleanText(body, key, label) {
  const value = body[key]
  if (typeof value !== 'string') throw new TaskError(400, `${label} must be text.`, key)
  const text = key === 'note' ? value.trim() : value.trim().replace(/\s+/g, ' ')
  if (text.length > LIMITS[key]) throw new TaskError(400, `Keep ${label.toLowerCase()} under ${format.count(LIMITS[key])} characters.`, key)
  return text
}

function cleanFields(body) {
  const fields = {}
  if (body.title !== undefined) {
    fields.title = cleanText(body, 'title', 'The title')
    if (!fields.title) throw new TaskError(400, 'Write a title for this task.', 'title')
  }
  if (body.note !== undefined) fields.note = cleanText(body, 'note', 'The note')
  if (body.category !== undefined) fields.category = cleanText(body, 'category', 'The category') || DEFAULT_CATEGORY
  if (body.group !== undefined) fields.group = cleanText(body, 'group', 'The group')
  if (body.owner !== undefined) {
    if (!OWNERS.includes(body.owner)) throw new TaskError(400, 'Choose who this is on: you, claude or both.', 'owner')
    fields.owner = body.owner
  }
  if (body.status !== undefined) {
    if (!STATUSES.includes(body.status)) throw new TaskError(400, 'Choose a status: now, next, later or done.', 'status')
    fields.status = body.status
  }
  if (body.conversationId !== undefined) {
    const id = body.conversationId
    if (id !== null && id !== '' && (typeof id !== 'string' || !CONVERSATION_ID.test(id))) throw new TaskError(400, 'This conversation ID is not valid.', 'conversationId')
    fields.conversationId = id || null
  }
  return fields
}

function authorOf(body) {
  return body.by === 'claude' ? 'claude' : 'you'
}

function newId(tasks) {
  const taken = new Set(tasks.map((task) => task.id))
  let id = crypto.randomBytes(4).toString('hex')
  while (taken.has(id)) id = crypto.randomBytes(4).toString('hex')
  return id
}

function createTasks(options = {}) {
  const dir = path.resolve(options.dir || defaultDataDir())
  const file = path.join(dir, 'tasks.json')
  let tasks = null
  let loadedMtime = null
  let queue = Promise.resolve()

  async function list() {
    let stat
    try {
      stat = await fs.promises.stat(file)
    } catch (error) {
      if (error.code !== 'ENOENT') throw new TaskError(500, `Could not read the tasks file: ${error.message}`)
      tasks = []
      loadedMtime = null
      return tasks
    }
    if (tasks && stat.mtimeMs === loadedMtime) return tasks
    let parsed
    try {
      parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'))
    } catch (error) {
      throw new TaskError(500, `The tasks file at ${format.homePath(file)} could not be read, and nothing was changed. ${error.message}`)
    }
    if (!parsed || !Array.isArray(parsed.tasks)) throw new TaskError(500, `The tasks file at ${format.homePath(file)} has no task list, and nothing was changed.`)
    tasks = parsed.tasks
    loadedMtime = stat.mtimeMs
    return tasks
  }

  async function save(next) {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    await fs.promises.writeFile(temp, `${JSON.stringify({ version: FILE_VERSION, tasks: next }, null, 2)}\n`, { mode: 0o600 })
    try {
      await fs.promises.copyFile(file, `${file}.bak`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await fs.promises.rename(temp, file)
    tasks = next
    loadedMtime = (await fs.promises.stat(file)).mtimeMs
  }

  function change(run) {
    const result = queue.then(async () => {
      const { next, value } = run(await list())
      await save(next)
      return value
    })
    queue = result.catch(() => null)
    return result
  }

  function add(body) {
    const fields = cleanFields(body)
    if (!fields.title) throw new TaskError(400, 'Write a title for this task.', 'title')
    const by = authorOf(body)
    return change((current) => {
      const now = Date.now()
      const status = fields.status || 'next'
      const task = {
        id: newId(current),
        title: fields.title,
        note: fields.note || '',
        category: fields.category || DEFAULT_CATEGORY,
        group: fields.group || '',
        owner: fields.owner || 'you',
        status,
        conversationId: fields.conversationId || null,
        order: current.reduce((highest, item) => Math.max(highest, item.order || 0), 0) + 1,
        createdAt: now,
        createdBy: by,
        updatedAt: now,
        updatedBy: by,
        doneAt: status === 'done' ? now : null,
        archivedAt: null,
      }
      return { next: [...current, task], value: task }
    })
  }

  function update(body) {
    if (typeof body.id !== 'string' || !body.id) throw new TaskError(400, 'Choose a task to change.')
    const fields = cleanFields(body)
    if (body.archived !== undefined && typeof body.archived !== 'boolean') throw new TaskError(400, 'Archived must be true or false.')
    const by = authorOf(body)
    return change((current) => {
      const existing = current.find((task) => task.id === body.id)
      if (!existing) throw new TaskError(404, 'This task was not found.')
      const now = Date.now()
      const task = { ...existing, ...fields, updatedAt: now, updatedBy: by }
      if (fields.status && fields.status !== existing.status) task.doneAt = fields.status === 'done' ? now : null
      if (body.archived !== undefined) task.archivedAt = body.archived ? existing.archivedAt || now : null
      return { next: current.map((item) => (item.id === task.id ? task : item)), value: task }
    })
  }

  return { file, list, add, update }
}

function joinMeta(parts) {
  return parts.filter(Boolean).join(' · ')
}

function byOrder(a, b) {
  return (a.order || 0) - (b.order || 0) || (a.createdAt || 0) - (b.createdAt || 0)
}

function statusMatches(task, status) {
  if (status === 'archived') return Boolean(task.archivedAt)
  if (task.archivedAt) return false
  if (status === 'open') return task.status !== 'done'
  return task.status === status
}

function whoMatches(owner, who) {
  if (!who) return true
  return owner === who || (who !== 'both' && owner === 'both')
}

function taskMatchesSearch(task, search) {
  return !search || [task.title, task.note, task.category, task.group].some((value) => value && value.toLowerCase().includes(search))
}

function readFilters(params) {
  const category = (params.get('category') || '').trim()
  const statusDefault = category ? 'open' : 'now'
  const status = params.get('status')
  const who = params.get('who') || ''
  const type = params.get('type') || ''
  return {
    category,
    statusDefault,
    status: STATUS_FILTERS.includes(status) ? status : statusDefault,
    who: WHO_FILTERS.includes(who) ? who : '',
    type: TYPE_FILTERS.includes(type) ? type : '',
    q: (params.get('q') || '').trim(),
  }
}

function categoryOfProject(project, names, fallback) {
  const segments = String(project || '').split(/[\\/]/).filter(Boolean)
  for (let index = segments.length - 1; index >= 0; index--) {
    const match = names.find((name) => name.toLowerCase() === segments[index].toLowerCase())
    if (match) return match
  }
  return fallback
}

function conversationRank(status) {
  if (status === 'waiting' || status === 'blocked') return 0
  return status === 'busy' ? 1 : 2
}

function conversationRows(sessions, names, linkedTasks) {
  return sessions
    .map((session) => {
      const category = categoryOfProject(session.project, names, session.projectName)
      const linked = linkedTasks.get(session.id)
      return {
        id: session.id,
        title: session.title,
        status: session.status,
        statusLabel: session.statusLabel,
        category,
        activity: session.activity,
        lastActiveAt: session.lastActiveAt,
        who: session.status === 'busy' ? 'claude' : 'you',
        metaLabel: joinMeta([category, session.status === 'busy' ? null : session.statusLabel, session.lastActiveLabel, linked ? `For: ${linked.title}` : null]),
      }
    })
    .sort((a, b) => conversationRank(a.status) - conversationRank(b.status) || (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
}

function conversationMatches(row, filters) {
  if (filters.category && row.category !== filters.category) return false
  if (filters.who === 'you' && row.who !== 'you') return false
  if (filters.who === 'claude' && row.who !== 'claude') return false
  if (filters.who === 'both') return false
  return !filters.q || [row.title, row.category].some((value) => value.toLowerCase().includes(filters.q.toLowerCase()))
}

function updatedLabel(task, now) {
  return `${format.capitalize(format.ago(task.updatedAt, now))} by ${AUTHORS[task.updatedBy] || 'you'}`
}

function conversationRef(task, sessionsById) {
  if (!task.conversationId) return null
  const session = sessionsById.get(task.conversationId)
  if (!session) return { id: task.conversationId, live: false, status: null, statusLabel: null, title: 'Conversation', label: 'Conversation' }
  return { id: session.id, live: true, status: session.status, statusLabel: session.statusLabel, title: session.title, label: session.statusLabel }
}

function taskRow(task, now, sessionsById, parts) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    owner: task.owner,
    category: task.category,
    done: task.status === 'done',
    archived: Boolean(task.archivedAt),
    canStart: !task.archivedAt && (task.status === 'next' || task.status === 'later'),
    metaLabel: joinMeta([...parts, updatedLabel(task, now)]),
    conversation: conversationRef(task, sessionsById),
  }
}

function groupRows(tasks, now, sessionsById, partsOf) {
  const groups = new Map()
  for (const task of tasks) {
    const key = task.group || ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(taskRow(task, now, sessionsById, partsOf(task)))
  }
  return [...groups.entries()].sort(([a], [b]) => Number(Boolean(a)) - Number(Boolean(b))).map(([title, rows]) => ({ title, rows }))
}

function sectionOf(key, title, tasks, groups, category) {
  return { key, title, category: category || null, countLabel: format.plural(tasks.length, 'task', 'tasks'), groups }
}

function buildSections(tasks, filters, now, sessionsById) {
  if (!tasks.length || filters.type === 'conversations') return []
  const open = filters.status === 'open'
  if (filters.category) {
    const statuses = open ? ['now', 'next', 'later'] : [filters.status]
    return statuses
      .map((status) => {
        const inStatus = status === 'archived' ? tasks : tasks.filter((task) => task.status === status)
        return inStatus.length ? sectionOf(status, STATUS_LABELS[status], inStatus, groupRows(inStatus, now, sessionsById, (task) => [OWNER_LABELS[task.owner]])) : null
      })
      .filter(Boolean)
  }
  if (filters.status === 'now') {
    return OWNERS.map((owner) => {
      const owned = tasks.filter((task) => task.owner === owner)
      return owned.length ? sectionOf(owner, OWNER_LABELS[owner], owned, [{ title: '', rows: owned.map((task) => taskRow(task, now, sessionsById, [task.category])) }]) : null
    }).filter(Boolean)
  }
  const names = [...new Set(tasks.map((task) => task.category))].sort((a, b) => a.localeCompare(b))
  return names.map((name) => {
    const inCategory = tasks.filter((task) => task.category === name)
    return sectionOf(name, name, inCategory, groupRows(inCategory, now, sessionsById, (task) => [open ? STATUS_LABELS[task.status] : null, OWNER_LABELS[task.owner]]), name)
  })
}

function categoryCards(names, visible, conversations) {
  return names
    .map((name) => {
      const tasks = visible.filter((task) => task.category === name && task.status !== 'done')
      const inNow = tasks.filter((task) => task.status === 'now').length
      const onYou = tasks.filter((task) => task.owner !== 'claude').length
      const running = conversations.filter((row) => row.category === name).length
      return {
        name,
        inNow,
        onYou,
        open: tasks.length,
        label: joinMeta([inNow ? `${format.count(inNow)} in Now` : null, tasks.length ? `${format.count(tasks.length)} open` : null, onYou ? `${format.count(onYou)} on you` : null, running ? format.plural(running, 'conversation', 'conversations') : null]) || 'Nothing open',
      }
    })
    .sort((a, b) => b.inNow - a.inNow || b.onYou - a.onYou || b.open - a.open || a.name.localeCompare(b.name))
}

function summaryOf(sections, conversations, filters) {
  const taskCount = sections.reduce((total, section) => total + section.groups.reduce((sum, group) => sum + group.rows.length, 0), 0)
  const working = conversations.filter((row) => row.status === 'busy').length
  const parts = [filters.type === 'conversations' ? null : format.plural(taskCount, 'task', 'tasks')]
  if (conversations.length) parts.push(`${format.plural(conversations.length, 'open conversation', 'open conversations')}${working ? `, ${format.count(working)} working` : ''}`)
  return joinMeta(parts)
}

function optionsOf(visible, names, rows) {
  const groups = {}
  for (const name of names) groups[name] = [...new Set(visible.filter((task) => task.category === name && task.group).map((task) => task.group))]
  return {
    categories: names,
    groups,
    conversations: rows.map((row) => ({ id: row.id, title: row.title })),
    owners: OWNERS.map((key) => ({ key, label: OWNER_LABELS[key] })),
    statuses: STATUSES.map((key) => ({ key, label: STATUS_LABELS[key] })),
  }
}

async function loadContext(store, collector, accounts) {
  const [all, live] = await Promise.all([store.list(), buildLive(collector, accounts)])
  const sorted = [...all].sort(byOrder)
  const visible = sorted.filter((task) => !task.archivedAt)
  const taskNames = [...new Set(visible.map((task) => task.category))]
  const linkedTasks = new Map(visible.filter((task) => task.conversationId).map((task) => [task.conversationId, task]))
  const conversations = conversationRows(live.sessions, taskNames, linkedTasks)
  const names = [...new Set([...taskNames, ...conversations.map((row) => row.category)])].sort((a, b) => a.localeCompare(b))
  return { sorted, visible, conversations, names, sessionsById: new Map(live.sessions.map((session) => [session.id, session])) }
}

async function buildTasksPage(store, collector, accounts, params) {
  const now = Date.now()
  const filters = readFilters(params)
  const { sorted, visible, conversations, names, sessionsById } = await loadContext(store, collector, accounts)
  if (filters.category && !names.includes(filters.category)) names.push(filters.category)
  const search = filters.q.toLowerCase()
  const inContext = sorted.filter((task) => (!filters.category || task.category === filters.category) && whoMatches(task.owner, filters.who) && taskMatchesSearch(task, search))
  const tasks = inContext.filter((task) => statusMatches(task, filters.status))
  const sections = buildSections(tasks, filters, now, sessionsById)
  const showsConversations = filters.type !== 'tasks' && (filters.status === 'now' || filters.status === 'open')
  const rows = showsConversations ? conversations.filter((row) => conversationMatches(row, filters)) : []
  const conversationCount = (name) => conversations.filter((row) => row.category === name).length
  const openCount = (name) => visible.filter((task) => task.category === name && task.status !== 'done').length
  const onDefaultView = !filters.category && filters.status === 'now' && !filters.who && !filters.type && !filters.q
  return {
    generatedAt: now,
    filters,
    filtered: Boolean(filters.category || filters.who || filters.type || filters.q || filters.status !== filters.statusDefault),
    totalTasks: visible.length,
    summaryLabel: summaryOf(sections, rows, filters),
    menus: {
      status: STATUS_FILTERS.map((key) => ({ key, label: `${STATUS_LABELS[key]} (${format.count(inContext.filter((task) => statusMatches(task, key)).length)})` })),
      category: [{ key: '', label: 'All categories' }, ...names.map((name) => ({ key: name, label: `${name} (${format.count(openCount(name) + conversationCount(name))})` }))],
      who: WHO_FILTERS.map((key) => ({ key, label: key ? OWNER_LABELS[key] : 'Everyone' })),
      type: TYPE_FILTERS.map((key) => ({ key, label: TYPE_LABELS[key] })),
    },
    sections,
    conversations: rows,
    categories: onDefaultView ? categoryCards(names, visible, conversations) : [],
    options: optionsOf(visible, names, conversations),
  }
}

async function buildTask(store, collector, accounts, params) {
  const id = params.get('id')
  const now = Date.now()
  const { sorted, visible, conversations, names } = await loadContext(store, collector, accounts)
  const task = sorted.find((item) => item.id === id)
  if (!task) return null
  const options = optionsOf(visible, names, conversations)
  if (task.conversationId && !options.conversations.some((row) => row.id === task.conversationId)) options.conversations.push({ id: task.conversationId, title: 'A conversation that is not open now' })
  if (!options.categories.includes(task.category)) options.categories.push(task.category)
  return {
    id: task.id,
    title: task.title,
    note: task.note,
    category: task.category,
    group: task.group,
    owner: task.owner,
    status: task.status,
    conversationId: task.conversationId,
    archived: Boolean(task.archivedAt),
    metaLabel: joinMeta([`Added ${format.ago(task.createdAt, now)} by ${AUTHORS[task.createdBy] || 'you'}`, `Updated ${format.ago(task.updatedAt, now)} by ${AUTHORS[task.updatedBy] || 'you'}`, `ID ${task.id}`]),
    options,
  }
}

module.exports = { createTasks, buildTasksPage, buildTask, defaultDataDir, TaskError }
