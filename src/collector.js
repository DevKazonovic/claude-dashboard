const fs = require('fs')
const os = require('os')
const path = require('path')
const { costParts, normalizeModel } = require('./pricing')

const CHUNK_SIZE = 8 * 1024 * 1024
const INDEX_TTL_MS = 2000
const SMALL_LINE = 20000
const NEWLINE = 10
const AGENT_FILE = /^agent-(.+)\.jsonl$/
const WORKFLOW_SCRIPT = /^(.+)-(wf_[A-Za-z0-9-]+)\.js$/
const SESSION_FILE = /^\d+\.json$/
const META_LINE = /"type":"(ai-title|custom-title|last-prompt)"/
const CWD_VALUE = /"cwd":"((?:[^"\\]|\\.)*)"/
const OWNER_ACCOUNT = /"ownerAccountUuid":"([0-9a-fA-F-]{8,64})"/
const SETTINGS_ROOT = /"rule_roots":\{"userSettings":"((?:[^"\\]|\\.)*)"/
const TIMESTAMP_VALUE = /"timestamp":"(\d{4}-\d{2}-\d{2}T[^"]+)"/
const TOOL_RESULT_ID = /"tool_use_id":"([^"]+)"/g
const USER_LINE = '"type":"user"'
const META_FLAG = '"isMeta":true'
const SIDECHAIN_FLAG = '"isSidechain":true'
const TURN_ENDS = new Set(['end_turn', 'stop_sequence'])
const PROMPT_CLIP = 2000
const PROMPT_TEXT_LIMIT = 60000
const PROMPT_LINE_LIMIT = 200000
const FINAL_TOOL = 'StructuredOutput'
const ERROR_FLAG = '"is_error":true'
const INTERRUPTED_TEXT = '[Request interrupted by user'
const NOTIFICATION_OPEN = '<task-notification>'
const NOTIFICATION_HEADER = 1500
const NOTIFICATION_TASK = /<task-id>([^<]+)<\/task-id>/
const NOTIFICATION_TOOL = /<tool-use-id>([^<]+)<\/tool-use-id>/
const NOTIFICATION_STATUS = /<status>([a-z_]+)<\/status>/
const WORKFLOW_RUN = /Task ID: ([A-Za-z0-9]+)(?:\\n|\n)(?:[^"\\]|\\.)*?Run ID: (wf_[A-Za-z0-9-]+)/g
const TASK_STOPPED_TEXT = 'Successfully stopped task: '
const TASK_STOPPED = /Successfully stopped task: ([A-Za-z0-9]+)/g
const TOTAL_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'webSearches', 'cost', 'messages', 'unpriced', 'inputCost', 'outputCost', 'cacheReadCost', 'cacheWriteCost', 'searchCost']
const AGENT_TOOLS = new Set(['Agent', 'Task'])
const SKILL_TOOL = 'Skill'
const COMMAND_TAG = '<command-name>'
const COMMAND_NAME = /<command-name>\/?([^<\s]+)<\/command-name>/

function own(text) {
  return Buffer.from(text, 'utf8').toString('utf8')
}

async function readdirSafe(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function statSafe(file) {
  try {
    return await fs.promises.stat(file)
  } catch {
    return null
  }
}

async function realpathSafe(file) {
  try {
    return await fs.promises.realpath(file)
  } catch {
    return null
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function dayKey(timestamp) {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return null
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function emptyTotals() {
  return Object.fromEntries(TOTAL_KEYS.map((key) => [key, 0]))
}

function addUsage(map, model, usage, parts) {
  if (!map.has(model)) map.set(model, emptyTotals())
  const totals = map.get(model)
  totals.input += usage.input_tokens || 0
  totals.output += usage.output_tokens || 0
  totals.cacheRead += usage.cache_read_input_tokens || 0
  totals.cacheWrite += usage.cache_creation_input_tokens || 0
  totals.webSearches += (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0
  totals.messages += 1
  if (!parts) {
    totals.unpriced += 1
    return
  }
  totals.cost += parts.total
  totals.inputCost += parts.input
  totals.outputCost += parts.output
  totals.cacheReadCost += parts.cacheRead
  totals.cacheWriteCost += parts.cacheWrite
  totals.searchCost += parts.search
}

function cloneModels(models) {
  const copy = new Map()
  for (const [model, totals] of models) copy.set(model, { ...totals })
  return copy
}

function freshData() {
  return {
    seen: new Map(),
    models: new Map(),
    days: new Map(),
    firstTs: null,
    lastAssistantTs: null,
    costState: null,
    cwd: null,
    customTitle: null,
    aiTitle: null,
    lastPrompt: null,
    ownerAccount: null,
    settingsRoot: null,
    agentCalls: new Map(),
    toolResults: new Set(),
    openTools: new Map(),
    turnEnded: false,
    turnEndedAt: null,
    interrupted: false,
    promptText: '',
    taskStatus: new Map(),
    taskStatusById: new Map(),
    workflowTasks: new Map(),
    skillUses: new Map(),
  }
}

function readNotifications(data, line) {
  let start = line.indexOf(NOTIFICATION_OPEN)
  while (start !== -1) {
    const header = line.slice(start, start + NOTIFICATION_HEADER)
    const task = NOTIFICATION_TASK.exec(header)
    const tool = NOTIFICATION_TOOL.exec(header)
    const status = NOTIFICATION_STATUS.exec(header)
    if (status) {
      if (tool) data.taskStatus.set(own(tool[1]), own(status[1]))
      if (task) data.taskStatusById.set(own(task[1]), own(status[1]))
    }
    start = line.indexOf(NOTIFICATION_OPEN, start + NOTIFICATION_OPEN.length)
  }
}

function newTranscript(file, kind) {
  return { file, kind, size: -1, mtimeMs: 0, offset: 0, pending: null, missing: false, error: null, data: freshData() }
}

function handleAssistant(data, line, kind) {
  const record = parseJson(line)
  if (!record || record.type !== 'assistant') return
  const message = record.message
  if (!message) return
  let delivered = false
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!block || block.type !== 'tool_use' || !block.id) continue
      if (AGENT_TOOLS.has(block.name)) data.agentCalls.set(block.id, block.id)
      if (block.name === FINAL_TOOL) delivered = true
      if (block.name === SKILL_TOOL && block.input && typeof block.input.skill === 'string') data.skillUses.set(block.id, { name: block.input.skill, at: record.timestamp ? Date.parse(record.timestamp) : NaN })
      data.openTools.set(block.id, { block, cwd: typeof record.cwd === 'string' ? record.cwd : null, at: record.timestamp ? Date.parse(record.timestamp) : NaN })
    }
  }
  if (kind !== 'main' || record.isSidechain !== true) {
    data.turnEnded = delivered || TURN_ENDS.has(message.stop_reason)
    data.interrupted = false
    if (data.turnEnded && record.timestamp) data.turnEndedAt = Date.parse(record.timestamp)
  }
  const usage = message.usage
  if (!usage || message.model === '<synthetic>') return
  if (record.timestamp) data.lastAssistantTs = record.timestamp
  if (!data.firstTs && record.timestamp) data.firstTs = record.timestamp
  const key = message.id || record.requestId || record.uuid
  const known = key ? data.seen.get(key) : null
  const model = known ? known.model : normalizeModel(message.model) || 'unknown'
  const parts = costParts(model, usage)
  const cost = parts ? parts.total : null
  if (known) {
    const output = usage.output_tokens || 0
    if (output <= known.output) return
    const extraOutput = output - known.output
    const extraCost = cost !== null && known.cost !== null ? cost - known.cost : 0
    for (const totals of [data.models.get(model), known.day ? data.days.get(known.day).get(model) : null]) {
      if (!totals) continue
      totals.output += extraOutput
      totals.cost += extraCost
      totals.outputCost += extraCost
    }
    known.output = output
    known.cost = cost
    return
  }
  const day = record.timestamp ? dayKey(record.timestamp) : null
  addUsage(data.models, model, usage, parts)
  if (day) {
    if (!data.days.has(day)) data.days.set(day, new Map())
    addUsage(data.days.get(day), model, usage, parts)
  }
  if (!key) return
  data.seen.set(key, {
    model,
    day,
    t: record.timestamp ? Date.parse(record.timestamp) : NaN,
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheWrite: usage.cache_creation_input_tokens || 0,
    webSearches: (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0,
    cost,
  })
}

function handleCostState(data, line) {
  const record = parseJson(line)
  if (!record || record.type !== 'cost-state' || !record.modelUsage || typeof record.modelUsage !== 'object') return
  const models = new Map()
  for (const [name, usage] of Object.entries(record.modelUsage)) {
    if (!usage || typeof usage !== 'object') continue
    const model = normalizeModel(name)
    if (!models.has(model)) models.set(model, emptyTotals())
    const totals = models.get(model)
    totals.input += usage.inputTokens || 0
    totals.output += usage.outputTokens || 0
    totals.cacheRead += usage.cacheReadInputTokens || 0
    totals.cacheWrite += usage.cacheCreationInputTokens || 0
    totals.webSearches += usage.webSearchRequests || 0
    totals.cost += usage.costUSD || 0
  }
  const written = Number.isFinite(record.startTime) && Number.isFinite(record.totalDuration) ? record.startTime + record.totalDuration : NaN
  const at = Number.isFinite(written) ? written : data.lastAssistantTs ? Date.parse(data.lastAssistantTs) : NaN
  data.costState = {
    at: Number.isFinite(at) ? at : null,
    day: Number.isFinite(at) ? dayKey(at) : null,
    models,
    mainBefore: cloneModels(data.models),
  }
}

function readPrompt(data, line) {
  const record = parseJson(line)
  if (!record || record.type !== 'user' || !record.message) return
  const content = record.message.content
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((block) => block && block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n') : ''
  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith('<')) return
  data.promptText = own(`${data.promptText}\n${trimmed.slice(0, PROMPT_CLIP).toLowerCase()}`.slice(0, PROMPT_TEXT_LIMIT))
}

function readCommand(data, line) {
  const record = parseJson(line)
  if (!record || record.type !== 'user' || !record.uuid || !record.message || typeof record.message.content !== 'string') return
  if (!record.message.content.trimStart().startsWith('<command-')) return
  const match = COMMAND_NAME.exec(record.message.content)
  if (match) data.skillUses.set(record.uuid, { name: own(match[1]), at: record.timestamp ? Date.parse(record.timestamp) : NaN })
}

function handleMeta(data, line) {
  const record = parseJson(line)
  if (!record) return
  if (record.type === 'custom-title' && record.customTitle) data.customTitle = record.customTitle
  else if (record.type === 'ai-title' && record.aiTitle) data.aiTitle = record.aiTitle
  else if (record.type === 'last-prompt' && record.lastPrompt) data.lastPrompt = record.lastPrompt
}

function handleLine(transcript, line) {
  if (line.length < 2) return
  const data = transcript.data
  if (line.includes('"type":"assistant"') && line.includes('"usage"')) handleAssistant(data, line, transcript.kind)
  else if (line.length < SMALL_LINE && META_LINE.test(line)) handleMeta(data, line)
  else if (transcript.kind === 'main' && line.length < SMALL_LINE && line.includes('"type":"cost-state"')) handleCostState(data, line)
  const agentResults = transcript.kind === 'main' && data.agentCalls.size > 0
  if (agentResults || data.openTools.size || data.turnEnded) {
    if (line.includes('"tool_use_id":"')) {
      for (const match of line.matchAll(TOOL_RESULT_ID)) {
        const open = data.openTools.get(match[1])
        if (open && open.block.name === FINAL_TOOL && line.includes(ERROR_FLAG)) data.turnEnded = false
        data.openTools.delete(match[1])
        const id = agentResults ? data.agentCalls.get(match[1]) : null
        if (id) data.toolResults.add(id)
      }
    } else if ((data.openTools.size || data.turnEnded) && line.includes(USER_LINE) && !(transcript.kind === 'main' && line.includes(SIDECHAIN_FLAG))) {
      data.turnEnded = false
      if (!line.includes(META_FLAG)) data.openTools.clear()
    }
  }
  if (line.length < SMALL_LINE && line.includes(INTERRUPTED_TEXT)) data.interrupted = true
  if (transcript.kind === 'main') {
    if (data.promptText.length < PROMPT_TEXT_LIMIT && line.length < PROMPT_LINE_LIMIT && line.includes(USER_LINE) && !line.includes('"tool_use_id":"') && !line.includes(META_FLAG) && !line.includes(SIDECHAIN_FLAG)) readPrompt(data, line)
    if (line.includes(NOTIFICATION_OPEN)) readNotifications(data, line)
    if (line.length < SMALL_LINE && line.includes(COMMAND_TAG) && line.includes(USER_LINE)) readCommand(data, line)
    if (line.includes('Run ID: wf_')) {
      for (const match of line.matchAll(WORKFLOW_RUN)) data.workflowTasks.set(own(match[2]), own(match[1]))
    }
    if (line.includes(TASK_STOPPED_TEXT)) {
      for (const match of line.matchAll(TASK_STOPPED)) data.taskStatusById.set(own(match[1]), 'stopped')
    }
    if (line.startsWith('{"type":"bridge-session"')) {
      const match = OWNER_ACCOUNT.exec(line)
      if (match) data.ownerAccount = own(match[1])
    } else if (line.startsWith('{"type":"api-request"')) {
      const match = SETTINGS_ROOT.exec(line)
      if (match) data.settingsRoot = parseJson(`"${match[1]}"`)
    }
  }
  if (!data.cwd && line.includes('"cwd":"')) {
    const match = CWD_VALUE.exec(line)
    if (match) data.cwd = parseJson(`"${match[1]}"`)
  }
  if (!data.firstTs && line.includes('"timestamp":"')) {
    const match = TIMESTAMP_VALUE.exec(line)
    if (match) data.firstTs = own(match[1])
  }
}

async function readLines(file, start, size, { onLine, onOffset, onBytes }) {
  const handle = await fs.promises.open(file, 'r')
  try {
    let position = start
    let carry = null
    while (position < size) {
      const length = Math.min(CHUNK_SIZE, size - position)
      const chunk = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(chunk, 0, length, position)
      if (bytesRead === 0) break
      position += bytesRead
      if (onBytes) onBytes(bytesRead)
      const bytes = carry ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
      const end = bytes.lastIndexOf(NEWLINE)
      if (end === -1) {
        carry = bytes
        continue
      }
      for (const line of bytes.toString('utf8', 0, end).split('\n')) onLine(line)
      carry = end + 1 < bytes.length ? bytes.subarray(end + 1) : null
      onOffset(position - (carry ? carry.length : 0))
    }
  } finally {
    await handle.close()
  }
}

async function readNew(transcript, stat, onBytes) {
  if (stat.size < transcript.offset) {
    transcript.offset = 0
    transcript.data = freshData()
  }
  await readLines(transcript.file, transcript.offset, stat.size, {
    onLine: (line) => handleLine(transcript, line),
    onOffset: (offset) => {
      transcript.offset = offset
    },
    onBytes,
  })
  transcript.size = stat.size
  transcript.mtimeMs = stat.mtimeMs
  transcript.missing = false
  transcript.error = null
}

async function updateTranscript(transcript, onBytes) {
  for (;;) {
    if (transcript.pending) {
      await transcript.pending
      continue
    }
    const stat = await statSafe(transcript.file)
    if (transcript.pending) continue
    if (!stat) {
      transcript.missing = true
      return transcript
    }
    if (stat.size === transcript.size && stat.mtimeMs === transcript.mtimeMs) return transcript
    transcript.pending = readNew(transcript, stat, onBytes)
      .catch((error) => {
        transcript.error = error.message
      })
      .finally(() => {
        transcript.pending = null
      })
    await transcript.pending
    return transcript
  }
}

function createJsonCache() {
  const cache = new Map()
  return async function readJson(file) {
    const stat = await statSafe(file)
    if (!stat) {
      cache.delete(file)
      return null
    }
    const cached = cache.get(file)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value
    let text
    try {
      text = await fs.promises.readFile(file, 'utf8')
    } catch {
      return cached ? cached.value : null
    }
    const value = parseJson(text)
    if (value === null) return cached ? cached.value : null
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value })
    return value
  }
}

function createJournalCache() {
  const cache = new Map()
  return async function readJournal(file) {
    const stat = await statSafe(file)
    if (!stat) return new Set()
    const cached = cache.get(file)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.done
    let text
    try {
      text = await fs.promises.readFile(file, 'utf8')
    } catch {
      return cached ? cached.done : new Set()
    }
    const done = new Set()
    for (const line of text.split('\n')) {
      if (!line.includes('"type":"result"')) continue
      const record = parseJson(line)
      if (record && record.type === 'result' && record.agentId) done.add(record.agentId)
    }
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, done })
    return done
  }
}

async function discoverConfigDirs(extraDirs) {
  const home = os.homedir()
  const candidates = []
  for (const entry of await readdirSafe(home)) {
    if (entry.name === '.claude' || entry.name.startsWith('.claude-')) candidates.push(path.join(home, entry.name))
  }
  for (const dir of extraDirs) candidates.push(path.resolve(dir.replace(/^~(?=$|[\\/])/, home)))
  const found = []
  const seen = new Set()
  for (const dir of candidates) {
    const real = await realpathSafe(dir)
    if (!real || seen.has(real)) continue
    const stat = await statSafe(real)
    if (!stat || !stat.isDirectory()) continue
    if (!(await statSafe(path.join(real, 'projects'))) && !(await statSafe(path.join(real, 'sessions')))) continue
    seen.add(real)
    found.push(dir)
  }
  return found
}

async function projectRoots(configDirs) {
  const roots = []
  const seen = new Set()
  for (const dir of configDirs) {
    const real = await realpathSafe(path.join(dir, 'projects'))
    if (!real || seen.has(real)) continue
    seen.add(real)
    roots.push(real)
  }
  return roots
}

function emptyEntry(id) {
  return { id, main: null, agents: [], workflowNames: new Map() }
}

function agentRef(dir, name, id, workflowId) {
  return {
    id,
    workflowId,
    file: path.join(dir, name),
    metaFile: path.join(dir, name.replace(/\.jsonl$/, '.meta.json')),
    journalFile: workflowId ? path.join(dir, 'journal.jsonl') : null,
  }
}

async function indexSessionDir(session, sessionDir) {
  const subagentsDir = path.join(sessionDir, 'subagents')
  for (const child of await readdirSafe(subagentsDir)) {
    const match = child.isFile() && AGENT_FILE.exec(child.name)
    if (match) {
      session.agents.push(agentRef(subagentsDir, child.name, match[1], null))
      continue
    }
    if (!child.isDirectory() || child.name !== 'workflows') continue
    const workflowsDir = path.join(subagentsDir, 'workflows')
    for (const workflow of await readdirSafe(workflowsDir)) {
      if (!workflow.isDirectory()) continue
      const workflowDir = path.join(workflowsDir, workflow.name)
      for (const file of await readdirSafe(workflowDir)) {
        const fileMatch = file.isFile() && AGENT_FILE.exec(file.name)
        if (fileMatch) session.agents.push(agentRef(workflowDir, file.name, fileMatch[1], workflow.name))
      }
    }
    for (const script of await readdirSafe(path.join(sessionDir, 'workflows', 'scripts'))) {
      const scriptMatch = script.isFile() && WORKFLOW_SCRIPT.exec(script.name)
      if (scriptMatch) session.workflowNames.set(scriptMatch[2], scriptMatch[1])
    }
  }
}

async function buildIndex(roots) {
  const sessions = new Map()
  const entryFor = (id) => {
    if (!sessions.has(id)) sessions.set(id, emptyEntry(id))
    return sessions.get(id)
  }
  for (const root of roots) {
    for (const project of await readdirSafe(root)) {
      if (!project.isDirectory()) continue
      const projectDir = path.join(root, project.name)
      for (const entry of await readdirSafe(projectDir)) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          entryFor(entry.name.slice(0, -'.jsonl'.length)).main = path.join(projectDir, entry.name)
        } else if (entry.isDirectory() && (await statSafe(path.join(projectDir, entry.name, 'subagents')))) {
          await indexSessionDir(entryFor(entry.name), path.join(projectDir, entry.name))
        }
      }
    }
  }
  return sessions
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

async function readLive(configDirs, readJson) {
  const sessions = new Map()
  for (const dir of configDirs) {
    const sessionsDir = path.join(dir, 'sessions')
    for (const entry of await readdirSafe(sessionsDir)) {
      if (!entry.isFile() || !SESSION_FILE.test(entry.name)) continue
      const record = await readJson(path.join(sessionsDir, entry.name))
      if (!record || typeof record.sessionId !== 'string' || !isAlive(record.pid)) continue
      const current = sessions.get(record.sessionId)
      if (!current || (record.updatedAt || 0) > (current.updatedAt || 0)) sessions.set(record.sessionId, { ...record, configDir: dir })
    }
  }
  return [...sessions.values()]
}

function createCollector(options = {}) {
  const transcripts = new Map()
  const readJson = createJsonCache()
  const readJournal = createJournalCache()
  const scan = { status: 'idle', totalBytes: 0, doneBytes: 0, error: null }
  let configDirs = []
  let roots = []
  let index = new Map()
  let indexAt = 0
  let indexPending = null
  let ready = null

  function init() {
    if (!ready) {
      ready = (async () => {
        configDirs = await discoverConfigDirs(options.extraConfigDirs || [])
        roots = await projectRoots(configDirs)
      })()
    }
    return ready
  }

  function prune(next) {
    const files = new Set()
    for (const entry of next.values()) {
      if (entry.main) files.add(entry.main)
      for (const ref of entry.agents) files.add(ref.file)
    }
    for (const [file, transcript] of transcripts) {
      if (!files.has(file) && !transcript.pending) transcripts.delete(file)
    }
  }

  async function getIndex() {
    await init()
    if (indexAt && Date.now() - indexAt < INDEX_TTL_MS) return index
    if (!indexPending) {
      indexPending = buildIndex(roots)
        .then((next) => {
          index = next
          indexAt = Date.now()
          prune(next)
          return next
        })
        .finally(() => {
          indexPending = null
        })
    }
    return indexPending
  }

  function transcriptFor(file, kind) {
    let transcript = transcripts.get(file)
    if (!transcript) {
      transcript = newTranscript(file, kind)
      transcripts.set(file, transcript)
    }
    return transcript
  }

  async function load(entry, onBytes) {
    const main = entry.main ? await updateTranscript(transcriptFor(entry.main, 'main'), onBytes) : null
    const agents = []
    for (const ref of entry.agents) {
      const state = await updateTranscript(transcriptFor(ref.file, 'agent'), onBytes)
      const meta = (await readJson(ref.metaFile)) || {}
      const finished = ref.journalFile ? (await readJournal(ref.journalFile)).has(ref.id) : false
      const workflowName = ref.workflowId ? entry.workflowNames.get(ref.workflowId) || null : null
      agents.push({ ref, state, meta, finished, workflowName })
    }
    return { id: entry.id, main, agents }
  }

  async function startFullScan() {
    if (scan.status === 'running' || scan.status === 'done') return
    scan.status = 'running'
    scan.error = null
    scan.doneBytes = 0
    try {
      const liveIds = new Set((await liveRecords()).map((record) => record.sessionId))
      const entries = [...(await getIndex()).values()].sort((a, b) => liveIds.has(b.id) - liveIds.has(a.id))
      let total = 0
      for (const entry of entries) {
        const files = [[entry.main, 'main'], ...entry.agents.map((ref) => [ref.file, 'agent'])]
        for (const [file, kind] of files) {
          if (!file) continue
          const stat = await statSafe(file)
          if (stat) total += Math.max(stat.size - transcriptFor(file, kind).offset, 0)
        }
      }
      scan.totalBytes = total
      for (const entry of entries) {
        await load(entry, (bytes) => {
          scan.doneBytes += bytes
        })
      }
      scan.status = 'done'
    } catch (error) {
      scan.status = 'failed'
      scan.error = error.message
    }
  }

  async function liveRecords() {
    await init()
    return readLive(configDirs, readJson)
  }

  return {
    init,
    startFullScan,
    configDirs: () => configDirs.slice(),
    scanStatus: () => ({ ...scan }),
    async counts() {
      let conversations = 0
      let agents = 0
      for (const entry of (await getIndex()).values()) {
        if (entry.main) conversations += 1
        agents += entry.agents.length
      }
      return { conversations, agents }
    },
    async live() {
      const records = await liveRecords()
      const sessions = await getIndex()
      const items = []
      for (const record of records) {
        items.push({ record, loaded: await load(sessions.get(record.sessionId) || emptyEntry(record.sessionId)) })
      }
      return items
    },
    async all() {
      const records = await liveRecords()
      const sessions = await getIndex()
      const live = new Map(records.map((record) => [record.sessionId, record]))
      const items = []
      for (const entry of sessions.values()) items.push({ record: live.get(entry.id) || null, loaded: await load(entry) })
      for (const record of records) {
        if (!sessions.has(record.sessionId)) items.push({ record, loaded: await load(emptyEntry(record.sessionId)) })
      }
      return items
    },
    async one(id) {
      const records = await liveRecords()
      const sessions = await getIndex()
      const record = records.find((item) => item.sessionId === id) || null
      const entry = sessions.get(id)
      if (!entry && !record) return null
      return { record, loaded: await load(entry || emptyEntry(id)) }
    },
  }
}

module.exports = { createCollector, createJsonCache, readLines, readdirSafe, statSafe, realpathSafe, parseJson, own, emptyTotals, TOTAL_KEYS }
