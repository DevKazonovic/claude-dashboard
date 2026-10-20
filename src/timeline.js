const path = require('path')
const { readLines, statSafe, parseJson, own } = require('./collector')
const { costParts, cacheWriteSplit, normalizeModel } = require('./pricing')
const { homePath } = require('./format')

const MAX_CACHED = 8
const TEXT_LIMIT = 20000
const PROMPT_LIMIT = 12000
const DETAIL_LIMIT = 2000
const RESULT_LIMIT = 2000
const NOTE_LIMIT = 600
const TARGET_LIMIT = 200
const EDIT_LINES = 60
const META_RECORD = '{"type":"'
const ATTACHMENT = '"type":"attachment"'
const QUEUED = '"queued_command"'
const CONTEXT_BLOCK = /^\s*<(system-reminder|ide_opened_file|ide_selection|ide_diagnostics)>/
const NOTIFICATION_SUMMARY = /<summary>([\s\S]*?)<\/summary>/
const NOTIFICATION_STATUS = /<status>([a-z_]+)<\/status>/
const NOTIFICATION_TOOL = /<tool-use-id>([^<]+)<\/tool-use-id>/
const NOTIFICATION_RESULT = /<result>([\s\S]*?)(?:<\/result>|$)/
const COMMAND_NAME = /<command-name>([^<]*)<\/command-name>/
const COMMAND_ARGS = /<command-args>([^<]*)<\/command-args>/
const COMMAND_OUTPUT = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/
const WORKFLOW_NAME = /\bname:\s*(['"`])([^'"`\n]+)\1/
const WORKFLOW_DESCRIPTION = /\bdescription:\s*(['"`])([^'"`\n]+)\1/
const INTERRUPTED = '[Request interrupted by user'
const HARNESS_REQUEST = /^\[Workflow harness [^\]]*user request\][^\n]*?:\n([\s\S]*)$/
const HARNESS_TASK = /^\[Workflow harness [^\]]*computed task\][\s\S]*?follows:\n([\s\S]*)$/

function clip(value, limit) {
  if (typeof value !== 'string') return ''
  return value.length > limit ? own(value.slice(0, limit)) : value
}

function keep(value, limit) {
  if (typeof value !== 'string' || !value) return ''
  return own(value.length > limit ? value.slice(0, limit) : value)
}

function str(value) {
  return typeof value === 'string' ? value : ''
}

function firstLine(value) {
  return str(value).trimStart().split('\n')[0].trim()
}

function time(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? ms : null
}

function blocksOf(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content.filter((block) => block && typeof block === 'object') : []
}

function promptParts(content) {
  const texts = []
  let images = 0
  let documents = 0
  for (const block of blocksOf(content)) {
    if (block.type === 'text' && typeof block.text === 'string') {
      if (!CONTEXT_BLOCK.test(block.text)) texts.push(block.text)
    } else if (block.type === 'image') images += 1
    else if (block.type === 'document') documents += 1
  }
  return { text: texts.join('\n\n').trim(), images, documents }
}

function resultText(content) {
  if (typeof content === 'string') return content
  const parts = []
  for (const block of blocksOf(content)) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[Image]')
  }
  return parts.join('\n')
}

function shortPath(value, cwd) {
  if (typeof value !== 'string' || !value) return ''
  if (cwd && value.startsWith(cwd + path.sep)) return keep(value.slice(cwd.length + 1), TARGET_LIMIT)
  return keep(homePath(value), TARGET_LIMIT)
}

function firstString(input) {
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim()) return keep(firstLine(value), TARGET_LIMIT)
  }
  return ''
}

function jsonDetail(input) {
  if (!Object.keys(input).length) return ''
  let text
  try {
    text = JSON.stringify(input, null, 2)
  } catch {
    return ''
  }
  return keep(text, DETAIL_LIMIT)
}

function prefixed(text, mark) {
  if (!text) return []
  return text.split('\n').slice(0, EDIT_LINES).map((line) => `${mark}${line}`)
}

function editDetail(edits) {
  const lines = []
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object') continue
    if (lines.length) lines.push('')
    lines.push(...prefixed(str(edit.old_string), '- '), ...prefixed(str(edit.new_string), '+ '))
  }
  return keep(lines.join('\n'), DETAIL_LIMIT)
}

function serverLabel(server) {
  return server.replace(/^claude_ai_/, '').replace(/_/g, ' ')
}

function describeTool(block, cwd) {
  const name = typeof block.name === 'string' && block.name ? block.name : 'Tool'
  const input = block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input : {}
  const tool = { id: block.id, name, label: name, target: '', detail: '', kind: 'tool', subagentType: null, background: false }
  switch (name) {
    case 'Bash':
      tool.target = keep(str(input.description) || firstLine(input.command), TARGET_LIMIT)
      tool.detail = keep(str(input.command), DETAIL_LIMIT)
      tool.background = input.run_in_background === true
      break
    case 'Read':
      tool.target = shortPath(input.file_path, cwd)
      if (input.offset || input.limit) tool.detail = `Lines ${input.offset || 1} to ${(input.offset || 1) + (input.limit || 0)}`
      break
    case 'Write':
      tool.target = shortPath(input.file_path, cwd)
      tool.detail = keep(str(input.content), DETAIL_LIMIT)
      break
    case 'Edit':
      tool.target = shortPath(input.file_path, cwd)
      tool.detail = editDetail([input])
      break
    case 'MultiEdit':
      tool.target = shortPath(input.file_path, cwd)
      tool.detail = editDetail(Array.isArray(input.edits) ? input.edits : [])
      break
    case 'NotebookEdit':
      tool.target = shortPath(input.notebook_path, cwd)
      tool.detail = keep(str(input.new_source), DETAIL_LIMIT)
      break
    case 'Grep':
    case 'Glob':
      tool.target = keep(str(input.pattern), TARGET_LIMIT)
      tool.detail = [input.path ? `In ${shortPath(input.path, cwd)}` : '', input.glob ? `Files ${keep(str(input.glob), TARGET_LIMIT)}` : ''].filter(Boolean).join('\n')
      break
    case 'WebFetch':
      tool.target = keep(str(input.url), TARGET_LIMIT)
      tool.detail = keep(str(input.prompt), DETAIL_LIMIT)
      break
    case 'WebSearch':
    case 'web_search':
      tool.label = 'WebSearch'
      tool.target = keep(str(input.query), TARGET_LIMIT)
      break
    case 'Agent':
    case 'Task':
      tool.kind = 'agent'
      tool.label = 'Agent'
      tool.target = keep(str(input.description) || firstLine(input.prompt), TARGET_LIMIT)
      tool.subagentType = keep(str(input.subagent_type), 80) || null
      tool.background = input.run_in_background !== false
      tool.detail = keep(str(input.prompt), DETAIL_LIMIT)
      break
    case 'Workflow': {
      const script = str(input.script)
      const named = WORKFLOW_NAME.exec(script)
      const described = WORKFLOW_DESCRIPTION.exec(script)
      tool.kind = 'workflow'
      tool.target = named ? keep(named[2], TARGET_LIMIT) : keep(str(input.name) || path.basename(str(input.scriptPath)), TARGET_LIMIT)
      tool.detail = described ? keep(described[2], DETAIL_LIMIT) : ''
      break
    }
    case 'Skill':
      tool.target = keep(str(input.skill) || str(input.command), TARGET_LIMIT)
      break
    case 'TodoWrite':
      tool.target = Array.isArray(input.todos) ? `${input.todos.length} to-do items` : ''
      break
    case 'SendMessage':
      tool.target = keep(str(input.summary) || str(input.to), TARGET_LIMIT)
      tool.detail = keep(str(input.message), DETAIL_LIMIT)
      break
    case 'SubagentHandback':
      tool.target = 'Final report'
      tool.detail = keep(str(input.message), DETAIL_LIMIT)
      break
    case 'ExitPlanMode':
      tool.target = 'Plan'
      tool.detail = keep(str(input.plan), DETAIL_LIMIT)
      break
    case 'AskUserQuestion': {
      const question = Array.isArray(input.questions) && input.questions[0] && typeof input.questions[0] === 'object' ? input.questions[0].question : ''
      tool.target = keep(str(question), TARGET_LIMIT)
      break
    }
    default:
      if (name.startsWith('mcp__')) {
        const [, server = '', ...rest] = name.split('__')
        tool.label = serverLabel(server) || 'MCP'
        tool.target = keep(rest.join('__'), TARGET_LIMIT)
      }
  }
  if (!tool.target) tool.target = firstString(input)
  if (!tool.detail && tool.kind === 'tool' && !['Read', 'TodoWrite'].includes(name)) tool.detail = jsonDetail(input)
  return tool
}

function usageOf(usage) {
  const { write5m, write1h } = cacheWriteSplit(usage)
  return {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheWrite: usage.cache_creation_input_tokens || 0,
    write5m,
    write1h,
    thinking: (usage.output_tokens_details && usage.output_tokens_details.thinking_tokens) || 0,
    searches: (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0,
    fast: usage.speed === 'fast',
  }
}

function freshTimeline(file, kind) {
  return {
    file,
    kind,
    size: -1,
    mtimeMs: 0,
    offset: 0,
    pending: null,
    missing: false,
    error: null,
    cwd: null,
    rev: 0,
    turns: [],
    steps: [],
    stepKeys: new Map(),
    tools: new Map(),
    current: null,
    lastAt: null,
  }
}

function touch(timeline, turn, at) {
  timeline.rev += 1
  turn.rev += 1
  if (at) turn.endAt = Math.max(turn.endAt || 0, at)
}

function startTurn(timeline, fields, at) {
  const turn = { index: timeline.turns.length, kind: 'prompt', text: '', length: 0, images: 0, documents: 0, at, endAt: at, items: [], rev: 0, ...fields }
  timeline.turns.push(turn)
  timeline.current = turn
  touch(timeline, turn, at)
  return turn
}

function currentTurn(timeline, at) {
  return timeline.current || startTurn(timeline, { kind: timeline.kind === 'agent' ? 'task' : 'start' }, at)
}

function addMarker(timeline, marker, at) {
  const turn = currentTurn(timeline, at)
  const last = turn.items[turn.items.length - 1]
  if (marker.kind === 'error' && last && last.type === 'marker' && last.kind === 'error' && last.text === marker.text) last.count += 1
  else turn.items.push({ type: 'marker', count: 1, at, ...marker })
  touch(timeline, turn, at)
}

function notificationParts(text) {
  const summary = NOTIFICATION_SUMMARY.exec(text)
  const status = NOTIFICATION_STATUS.exec(text)
  const tool = NOTIFICATION_TOOL.exec(text)
  const result = NOTIFICATION_RESULT.exec(text)
  const body = result ? result[1].trim() : ''
  return {
    text: summary ? keep(summary[1].trim(), NOTE_LIMIT) : '',
    status: status ? keep(status[1], 40) : null,
    toolUseId: tool ? keep(tool[1], 120) : null,
    result: keep(body, RESULT_LIMIT),
    resultLength: body.length,
  }
}

function dedent(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/^ {2}/, ''))
    .join('\n')
    .trim()
}

function addAgentMessage(timeline, text, images, documents, at) {
  const request = HARNESS_REQUEST.exec(text)
  const task = request ? null : HARNESS_TASK.exec(text)
  const body = request ? '' : task ? dedent(task[1]) : text
  let turn = timeline.current
  if (!turn || turn.items.length) turn = startTurn(timeline, { kind: timeline.turns.length ? 'message' : 'task' }, at)
  if (request) turn.request = keep(dedent(request[1]), NOTE_LIMIT)
  if (body) {
    turn.text = keep(turn.text ? `${turn.text}\n\n${body}` : body, PROMPT_LIMIT)
    turn.length = (turn.length ? turn.length + 2 : 0) + body.length
  }
  turn.images += images
  turn.documents += documents
  touch(timeline, turn, at)
}

function peerBody(origin, text) {
  if (typeof origin.handbackReportText === 'string') return origin.handbackReportText
  if (typeof origin.body === 'string') return origin.body
  return text
}

function handleAssistant(timeline, record) {
  const message = record.message
  if (!message || typeof message !== 'object') return
  const at = time(record.timestamp)
  if (message.model === '<synthetic>') {
    const { text } = promptParts(message.content)
    if (text) addMarker(timeline, { kind: 'notice', text: clip(text, NOTE_LIMIT) }, at)
    return
  }
  const key = message.id || record.requestId || record.uuid || null
  let step = key ? timeline.stepKeys.get(key) : null
  if (!step) {
    const turn = currentTurn(timeline, at)
    step = {
      index: timeline.steps.length,
      turn: turn.index,
      model: normalizeModel(message.model) || 'unknown',
      startAt: timeline.lastAt || at,
      at,
      endAt: at,
      blocks: [],
      seen: new Set(),
      usage: null,
      parts: null,
      stopReason: null,
    }
    timeline.steps.push(step)
    if (key) timeline.stepKeys.set(key, step)
    turn.items.push({ type: 'step', step: step.index })
  }
  const usage = message.usage
  if (usage && typeof usage === 'object' && (!step.usage || (usage.output_tokens || 0) >= step.usage.output)) {
    step.usage = usageOf(usage)
    step.parts = costParts(step.model, usage)
  }
  if (typeof message.stop_reason === 'string') step.stopReason = message.stop_reason
  const content = Array.isArray(message.content) ? message.content : []
  content.forEach((block, position) => {
    const signature = record.apiBlockIndex != null && content.length === 1 ? record.apiBlockIndex : position
    addBlock(timeline, step, block, signature, at, record.cwd || timeline.cwd)
  })
  if (at) {
    step.endAt = at
    timeline.lastAt = at
  }
  touch(timeline, timeline.turns[step.turn], at)
}

function addBlock(timeline, step, block, signature, at, cwd) {
  if (!block || typeof block !== 'object') return
  if (block.type === 'tool_use' || block.type === 'server_tool_use') {
    if (!block.id || timeline.tools.has(block.id)) return
    const tool = describeTool(block, cwd)
    Object.assign(tool, { at, step: step.index, turn: step.turn, result: null, resultAt: null, agentId: null, runId: null, workflowName: null, summary: null })
    timeline.tools.set(block.id, tool)
    step.blocks.push({ type: 'tool', id: block.id })
    return
  }
  if (block.type === 'web_search_tool_result' || block.type === 'web_fetch_tool_result') {
    const tool = timeline.tools.get(block.tool_use_id)
    if (!tool) return
    const found = Array.isArray(block.content) ? block.content.filter((item) => item && item.url).map((item) => `${item.title || item.url}\n${item.url}`) : []
    tool.result = { text: keep(found.join('\n\n'), RESULT_LIMIT), length: 0, isError: !Array.isArray(block.content) }
    tool.resultAt = at
    return
  }
  const seenKey = `${signature}:${block.type}`
  if (step.seen.has(seenKey)) return
  step.seen.add(seenKey)
  if (block.type === 'text') {
    const text = str(block.text)
    if (text.trim()) step.blocks.push({ type: 'text', text: clip(text, TEXT_LIMIT), length: text.length })
  } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
    const text = str(block.thinking)
    step.blocks.push({ type: 'thinking', text: clip(text, TEXT_LIMIT), length: text.length })
  }
}

function attachResult(timeline, block, extra, at) {
  const tool = timeline.tools.get(block.tool_use_id)
  if (!tool) return
  const text = resultText(block.content)
  tool.result = { text: clip(text, RESULT_LIMIT), length: text.length, isError: block.is_error === true }
  tool.resultAt = at
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    if (typeof extra.agentId === 'string') tool.agentId = keep(extra.agentId, 120)
    if (typeof extra.runId === 'string') tool.runId = keep(extra.runId, 120)
    if (typeof extra.workflowName === 'string') tool.workflowName = keep(extra.workflowName, TARGET_LIMIT)
    if (typeof extra.summary === 'string' && tool.kind === 'workflow') tool.summary = keep(extra.summary, NOTE_LIMIT)
  }
  const turn = timeline.turns[tool.turn]
  if (turn) touch(timeline, turn, at)
}

function handleUser(timeline, record) {
  const message = record.message
  if (!message || typeof message !== 'object') return
  const at = time(record.timestamp)
  const results = blocksOf(message.content).filter((block) => block.type === 'tool_result')
  if (results.length) {
    for (const block of results) attachResult(timeline, block, record.toolUseResult, at)
    if (at) timeline.lastAt = at
    return
  }
  const origin = record.origin && typeof record.origin === 'object' ? record.origin : {}
  const { text, images, documents } = promptParts(message.content)
  if (record.isCompactSummary) {
    const turn = currentTurn(timeline, at)
    const compact = [...turn.items].reverse().find((item) => item.type === 'marker' && item.kind === 'compact')
    if (compact && !compact.detail) {
      compact.detail = clip(text, PROMPT_LIMIT)
      touch(timeline, turn, at)
    } else addMarker(timeline, { kind: 'compact', detail: clip(text, PROMPT_LIMIT) }, at)
  } else if (origin.kind === 'task-notification' || text.startsWith('<task-notification>')) {
    startTurn(timeline, { kind: 'notification', ...notificationParts(text) }, at)
  } else if (origin.kind === 'peer') {
    const body = peerBody(origin, text)
    startTurn(timeline, { kind: 'peer', name: keep(str(origin.name), 120) || null, text: clip(body, PROMPT_LIMIT), length: body.length }, at)
  } else if (record.isMeta) {
    const skill = COMMAND_NAME.exec(text)
    if (text.startsWith('<command-message>') && skill) addMarker(timeline, { kind: 'skill', text: keep(skill[1], TARGET_LIMIT) }, at)
  } else if (text.startsWith('<command-name>') || text.startsWith('<command-message>')) {
    const command = COMMAND_NAME.exec(text)
    const args = COMMAND_ARGS.exec(text)
    const name = command ? command[1].trim() : ''
    const value = [name && !name.startsWith('/') ? `/${name}` : name, args ? args[1].trim() : ''].filter(Boolean).join(' ')
    if (value) startTurn(timeline, { kind: 'command', text: keep(value, PROMPT_LIMIT), length: value.length }, at)
  } else if (text.startsWith('<local-command-stdout>')) {
    const output = COMMAND_OUTPUT.exec(text)
    if (output && output[1].trim()) addMarker(timeline, { kind: 'command-output', text: keep(output[1].trim(), NOTE_LIMIT) }, at)
  } else if (text.startsWith(INTERRUPTED)) {
    addMarker(timeline, { kind: 'interrupted', text: text.includes('for tool use') ? 'tool' : 'reply' }, at)
  } else if (!text.startsWith('<local-command-caveat>') && !text.startsWith('<system-reminder>') && (text || images || documents)) {
    if (timeline.kind === 'agent') addAgentMessage(timeline, text, images, documents, at)
    else startTurn(timeline, { kind: record.turnOrigin === 'scheduled' ? 'scheduled' : 'prompt', text: clip(text, PROMPT_LIMIT), length: text.length, images, documents }, at)
  }
  if (at) timeline.lastAt = at
}

function handleSystem(timeline, record) {
  const at = time(record.timestamp)
  if (record.subtype === 'compact_boundary') {
    const meta = record.compactMetadata && typeof record.compactMetadata === 'object' ? record.compactMetadata : {}
    addMarker(timeline, { kind: 'compact', trigger: keep(str(meta.trigger), 20) || null, preTokens: meta.preTokens || 0, postTokens: meta.postTokens || 0, detail: '' }, at)
  } else if (record.subtype === 'api_error') {
    const error = record.error && typeof record.error === 'object' ? record.error : {}
    addMarker(timeline, { kind: 'error', text: keep(str(error.formatted) || str(error.message) || 'The request to the API failed.', NOTE_LIMIT) }, at)
  } else if (record.subtype === 'local_command' && typeof record.content === 'string') {
    const output = COMMAND_OUTPUT.exec(record.content)
    const command = COMMAND_NAME.exec(record.content)
    if (output) {
      if (output[1].trim()) addMarker(timeline, { kind: 'command-output', text: keep(output[1].trim(), NOTE_LIMIT) }, at)
    } else addMarker(timeline, { kind: 'command', text: keep(command ? command[1] : record.content.trim(), TARGET_LIMIT) }, at)
  } else if (record.subtype === 'stop_hook_summary' && (record.preventedContinuation || (Array.isArray(record.hookErrors) && record.hookErrors.length))) {
    const reason = str(record.stopReason) || (Array.isArray(record.hookErrors) ? str(record.hookErrors[0]) : '')
    addMarker(timeline, { kind: 'hook', text: keep(reason, NOTE_LIMIT) }, at)
  }
}

function handleQueued(timeline, attachment, at) {
  const origin = attachment.origin && typeof attachment.origin === 'object' ? attachment.origin : {}
  const { text, images } = promptParts(attachment.prompt)
  if (origin.kind === 'task-notification' || text.startsWith('<task-notification>')) {
    const parts = notificationParts(text)
    addMarker(timeline, { kind: 'notification', text: parts.text, status: parts.status }, at)
  } else if (origin.kind === 'peer') {
    const body = peerBody(origin, text)
    addMarker(timeline, { kind: 'peer', name: keep(str(origin.name), 120) || null, text: clip(body, PROMPT_LIMIT), length: body.length }, at)
  } else if (text || images) {
    addMarker(timeline, { kind: 'queued', text: clip(text, PROMPT_LIMIT), length: text.length, images }, at)
  }
}

function handleLine(timeline, line) {
  if (line.length < 2 || line.startsWith(META_RECORD)) return
  if (line.includes(ATTACHMENT) && !line.includes(QUEUED)) return
  const record = parseJson(line)
  if (!record || typeof record !== 'object') return
  if (timeline.kind === 'main' && record.isSidechain === true) return
  if (!timeline.cwd && typeof record.cwd === 'string') timeline.cwd = record.cwd
  if (record.type === 'assistant') handleAssistant(timeline, record)
  else if (record.type === 'user') handleUser(timeline, record)
  else if (record.type === 'system') handleSystem(timeline, record)
  else if (record.type === 'attachment' && record.attachment && record.attachment.type === 'queued_command') handleQueued(timeline, record.attachment, time(record.timestamp))
}

function reset(timeline) {
  const pending = timeline.pending
  Object.assign(timeline, freshTimeline(timeline.file, timeline.kind), { pending })
}

async function readTimeline(timeline, stat) {
  if (stat.size < timeline.offset) reset(timeline)
  await readLines(timeline.file, timeline.offset, stat.size, {
    onLine: (line) => handleLine(timeline, line),
    onOffset: (offset) => {
      timeline.offset = offset
    },
  })
  timeline.size = stat.size
  timeline.mtimeMs = stat.mtimeMs
  timeline.missing = false
  timeline.error = null
}

async function updateTimeline(timeline) {
  for (;;) {
    if (timeline.pending) {
      await timeline.pending
      continue
    }
    const stat = await statSafe(timeline.file)
    if (timeline.pending) continue
    if (!stat) {
      timeline.missing = true
      return timeline
    }
    if (stat.size === timeline.size && stat.mtimeMs === timeline.mtimeMs) return timeline
    timeline.pending = readTimeline(timeline, stat)
      .catch((error) => {
        timeline.error = error.message
      })
      .finally(() => {
        timeline.pending = null
      })
    await timeline.pending
    return timeline
  }
}

function createTimelines() {
  const cache = new Map()
  return {
    async get(file, kind) {
      let timeline = cache.get(file)
      if (timeline) cache.delete(file)
      else timeline = freshTimeline(file, kind)
      cache.set(file, timeline)
      for (const [key, entry] of cache) {
        if (cache.size <= MAX_CACHED) break
        if (key !== file && !entry.pending) cache.delete(key)
      }
      return updateTimeline(timeline)
    },
  }
}

module.exports = { createTimelines, describeTool }
