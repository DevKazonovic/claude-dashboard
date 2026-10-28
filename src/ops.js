const { readLines, statSafe, parseJson } = require('./collector')
const { describeTool } = require('./timeline')
const format = require('./format')

const TAIL_BYTES = 256 * 1024
const KEEP = 30
const ACTIVE_MS = 120000
const AGENT_LIMIT = 12
const RATE_AGENTS = 40
const RATE_MINUTES = 16
const TEXT_LIMIT = 240
const META_RECORD = '{"type":"'
const NOTIFICATION_SUMMARY = /<summary>([\s\S]*?)<\/summary>/
const NOTIFICATION_STATUS = /<status>([a-z_]+)<\/status>/

function clip(text) {
  const line = String(text || '').trim().split('\n')[0].trim()
  return line.length > TEXT_LIMIT ? `${line.slice(0, TEXT_LIMIT - 1)}…` : line
}

function textOf(content) {
  if (typeof content === 'string') return content
  return Array.isArray(content) ? content.filter((block) => block && block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n') : ''
}

function add(entry, event) {
  if (!event.id || entry.ids.has(event.id)) return
  entry.ids.add(event.id)
  entry.events.push(event)
}

function readAssistant(entry, record, at) {
  const message = record.message
  if (!message || message.model === '<synthetic>') return
  const usage = message.usage
  const key = message.id || record.uuid
  if (usage && key) entry.usage.set(key, { at, tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) })
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (!block) continue
    if ((block.type === 'tool_use' || block.type === 'server_tool_use') && block.id) {
      const tool = describeTool(block, record.cwd || entry.cwd)
      add(entry, { id: block.id, at, kind: tool.kind, label: tool.label, text: clip(tool.target) })
    } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) add(entry, { id: `${record.uuid}:text`, at, kind: 'say', label: 'Claude', text: clip(block.text) })
  }
}

function readUser(entry, record, at, main) {
  const content = record.message.content
  if (Array.isArray(content) && content.some((block) => block && block.type === 'tool_result')) {
    for (const block of content) {
      if (block && block.type === 'tool_result' && block.is_error === true) add(entry, { id: `${block.tool_use_id}:error`, at, kind: 'error', label: 'Error', text: clip(textOf(block.content)) })
    }
    return
  }
  const text = textOf(content).trim()
  if (text.startsWith('<task-notification>')) {
    const status = NOTIFICATION_STATUS.exec(text)
    const summary = NOTIFICATION_SUMMARY.exec(text)
    const failed = status && status[1] === 'failed'
    add(entry, { id: record.uuid, at, kind: failed ? 'error' : 'done', label: failed ? 'Failed' : 'Done', text: clip(summary ? summary[1] : status ? status[1] : 'Task finished') })
  } else if (text && !record.isMeta && !text.startsWith('<') && !text.startsWith('[Request interrupted')) add(entry, { id: record.uuid, at, kind: 'prompt', label: main ? 'You' : 'Task', text: clip(text) })
}

function readLine(entry, line, main) {
  if (line.length < 2 || line.startsWith(META_RECORD) || line.includes('"type":"attachment"')) return
  const record = parseJson(line)
  if (!record || (main && record.isSidechain === true)) return
  const at = Date.parse(record.timestamp)
  if (!Number.isFinite(at)) return
  if (!entry.since) entry.since = at
  if (!entry.cwd && typeof record.cwd === 'string') entry.cwd = record.cwd
  if (record.type === 'assistant') readAssistant(entry, record, at)
  else if (record.type === 'user' && record.message) readUser(entry, record, at, main)
  else if (record.type === 'system' && record.subtype === 'api_error') {
    const error = record.error && typeof record.error === 'object' ? record.error : {}
    add(entry, { id: record.uuid, at, kind: 'error', label: 'API', text: clip(error.formatted || error.message || 'The request to the API failed.') })
  }
}

function rateOf(entries, since, now) {
  const buckets = Array(RATE_MINUTES).fill(0)
  for (const entry of entries) {
    for (const { at, tokens } of entry.usage.values()) {
      const age = Math.floor((now - at) / 60000)
      if (age >= 0 && age < RATE_MINUTES) buckets[RATE_MINUTES - 1 - age] += tokens
    }
  }
  return buckets.map((value, index) => (since && now - (RATE_MINUTES - 1 - index) * 60000 <= since ? null : value))
}

function createOps() {
  const cache = new Map()

  async function follow(file, main) {
    const stat = await statSafe(file)
    if (!stat) return null
    let entry = cache.get(file)
    if (entry && entry.pending) await entry.pending
    if (entry && stat.size === entry.size && stat.mtimeMs === entry.mtimeMs) return entry
    if (!entry || stat.size < entry.offset) entry = { offset: Math.max(0, stat.size - TAIL_BYTES), size: -1, mtimeMs: 0, since: null, cwd: null, events: [], ids: new Set(), usage: new Map(), pending: null }
    cache.set(file, entry)
    const current = entry
    current.pending = readLines(file, current.offset, stat.size, {
      onLine: (line) => readLine(current, line, main),
      onOffset: (offset) => {
        current.offset = offset
      },
    })
      .then(() => {
        current.size = stat.size
        current.mtimeMs = stat.mtimeMs
        current.events = current.events.slice(-KEEP)
        current.ids = new Set(current.events.map((event) => event.id))
        const oldest = Date.now() - RATE_MINUTES * 60000
        for (const [key, usage] of current.usage) if (usage.at < oldest) current.usage.delete(key)
      })
      .catch(() => {})
      .finally(() => {
        current.pending = null
      })
    await current.pending
    return current
  }

  return {
    async build(collector) {
      const now = Date.now()
      const used = new Set()
      const sessions = {}
      for (const item of await collector.live()) {
        const { main, agents } = item.loaded
        const sources = main ? [{ file: main.file, main: true, loud: true, who: null, agentId: null }] : []
        const recent = agents.filter((agent) => agent.state && agent.state.mtimeMs > now - RATE_MINUTES * 60000).sort((a, b) => b.state.mtimeMs - a.state.mtimeMs)
        recent.slice(0, RATE_AGENTS).forEach((agent, index) => {
          sources.push({ file: agent.ref.file, main: false, loud: index < AGENT_LIMIT && agent.state.mtimeMs > now - ACTIVE_MS, who: agent.meta.description || format.agentTypeLabel(agent.meta.agentType), agentId: agent.ref.id })
        })
        const read = []
        for (const source of sources) {
          used.add(source.file)
          const entry = await follow(source.file, source.main)
          if (entry) read.push({ source, entry })
        }
        const head = read.find((part) => part.source.main)
        sessions[item.loaded.id] = {
          events: read
            .filter((part) => part.source.loud)
            .flatMap(({ source, entry }) => entry.events.map((event) => ({ ...event, who: source.who, agentId: source.agentId })))
            .sort((a, b) => a.at - b.at)
            .slice(-KEEP),
          rate: rateOf(
            read.map((part) => part.entry),
            head ? head.entry.since : null,
            now,
          ),
        }
      }
      for (const file of cache.keys()) if (!used.has(file)) cache.delete(file)
      return { generatedAt: now, sessions }
    },
  }
}

module.exports = { createOps }
