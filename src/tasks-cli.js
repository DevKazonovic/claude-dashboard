const { HOST } = require('./server')

const DEFAULT_PORT = 3737
const VALUE_FLAGS = new Set(['title', 'note', 'category', 'group', 'who', 'status', 'conversation', 'type', 'q', 'port'])
const BOOLEAN_FLAGS = new Set(['json', 'help', 'archive', 'restore'])

const HELP = `Usage: claude-dashboard tasks [action] [options]

Reads and changes the Tasks page from the terminal. The dashboard has to be running.

Actions:
  (none) or list         Show what is in Now, with the open conversations.
  add "<title>"          Add a task.
  update <id>            Change a task.
  done <id>              Mark a task as done.

Options for list:
  --status <status>      now, next, later, open, done or archived
  --category <name>      Only this category
  --who <who>            you, claude or both
  --type <type>          tasks or conversations
  --q <text>             Search
  --json                 Print the full answer as JSON

Options for add and update:
  --title <text>         New title (update only)
  --note <text>          Note
  --category <name>      Category
  --group <name>         Group inside the category
  --who <who>            you, claude or both
  --status <status>      now, next, later or done
  --conversation <id>    Link a Claude Code conversation. Pass "" to remove it.
  --archive              Archive the task (update only)
  --restore              Bring back an archived task (update only)

  --port <number>        Port of the dashboard (default 3737)`

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '-h') {
      flags.help = true
      continue
    }
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals)
    if (BOOLEAN_FLAGS.has(name)) flags[name] = true
    else if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown option: --${name}\n\n${HELP}`)
    else if (equals !== -1) flags[name] = arg.slice(equals + 1)
    else if (index + 1 < argv.length) flags[name] = argv[++index]
    else throw new Error(`The --${name} option needs a value.`)
  }
  return { positional, flags }
}

function fieldsFrom(flags) {
  const fields = {}
  if (flags.title !== undefined) fields.title = flags.title
  if (flags.note !== undefined) fields.note = flags.note
  if (flags.category !== undefined) fields.category = flags.category
  if (flags.group !== undefined) fields.group = flags.group
  if (flags.who !== undefined) fields.owner = flags.who
  if (flags.status !== undefined) fields.status = flags.status
  if (flags.conversation !== undefined) fields.conversationId = flags.conversation
  return fields
}

async function call(origin, pathname, body) {
  const response = await fetch(`${origin}${pathname}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) } : undefined)
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error((data && data.error) || `The dashboard answered with status ${response.status}.`)
  return data
}

function printList(data) {
  const lines = []
  for (const section of data.sections) {
    lines.push(`${section.title} (${section.countLabel})`)
    for (const group of section.groups) {
      if (group.title) lines.push(`  ${group.title}`)
      for (const row of group.rows) lines.push(`  ${row.id}  ${row.title}  (${row.metaLabel})`)
    }
  }
  if (data.conversations.length) {
    lines.push(`Conversations (${data.conversations.length})`)
    for (const row of data.conversations) lines.push(`  ${row.id}  ${row.title}  (${row.statusLabel}, ${row.category})`)
  }
  console.log(lines.length ? lines.join('\n') : 'Nothing here.')
}

async function run(argv, findRunning) {
  const { positional, flags } = parseArgs(argv)
  if (flags.help) return console.log(HELP)
  const port = flags.port ? Number(flags.port) : DEFAULT_PORT
  const running = await findRunning(port)
  if (!running) throw new Error('The dashboard is not running. Start it with claude-dashboard start.')
  const origin = `http://${HOST}:${running.port}`
  const by = process.env.CLAUDECODE ? 'claude' : 'you'
  const action = positional[0] || 'list'
  if (action === 'list') {
    const params = new URLSearchParams()
    for (const key of ['status', 'category', 'who', 'type', 'q']) if (flags[key]) params.set(key, flags[key])
    const data = await call(origin, `/api/tasks?${params}`)
    return flags.json ? console.log(JSON.stringify(data)) : printList(data)
  }
  if (action === 'add') {
    const title = positional.slice(1).join(' ') || flags.title
    if (!title) throw new Error('Write a title: claude-dashboard tasks add "What needs doing"')
    const task = await call(origin, '/api/tasks/add', { ...fieldsFrom(flags), title, by })
    return console.log(`Added ${task.id}: ${task.title}`)
  }
  if (action === 'update' || action === 'done') {
    const id = positional[1]
    if (!id) throw new Error(`Name the task: claude-dashboard tasks ${action} <id>`)
    const body = { ...fieldsFrom(flags), id, by }
    if (action === 'done') body.status = 'done'
    if (flags.archive) body.archived = true
    if (flags.restore) body.archived = false
    const task = await call(origin, '/api/tasks/update', body)
    return console.log(`Updated ${task.id}: ${task.title} (${task.status})`)
  }
  throw new Error(`Unknown action: ${action}\n\n${HELP}`)
}

module.exports = { run }
