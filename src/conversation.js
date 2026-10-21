const crypto = require('crypto')
const fs = require('fs')
const format = require('./format')
const { describeSession, agentGroups, modelRows, modelsOf, sumModels, tokenRows, resumeCommand, liveActivity } = require('./views')
const { openTerminal, openVscode } = require('./launch')

const SESSION_ID = /^[A-Za-z0-9_-]{6,100}$/
const AGENT_ID = /^[A-Za-z0-9_-]{1,100}$/
const LIVE_BUCKET_MS = 30000
const PREVIEW_LIMIT = 280
const CHAT_PAGE = 20
const CHAT_MAX = 50
const SUMMARY_TARGET = 40
const ACTIVITY_NAMES = 4
const MESSAGE_LIMIT = 50000
const LONG_TEXT = 1400
const LONG_LINES = 16
const NOTIFICATION_STATUS = { completed: 'Done', failed: 'Failed', killed: 'Stopped', stopped: 'Stopped' }
const KIND_LABELS = {
  prompt: 'You',
  command: 'You ran a command',
  scheduled: 'Scheduled prompt',
  notification: 'Background task',
  peer: 'Agent report',
  task: 'Task',
  message: 'Message to the agent',
  start: 'Continued work',
}
const STOP_LABELS = { max_tokens: 'Stopped at the output limit', refusal: 'Claude declined', pause_turn: 'Paused' }

function hash(value) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 16)
}

function revisionOf(item, extra) {
  const { record, loaded } = item
  const parts = [record ? `${record.status}:${record.updatedAt}` : 'ended']
  if (loaded.main) parts.push(`${loaded.main.size}:${loaded.main.mtimeMs}`)
  for (const agent of loaded.agents) parts.push(`${agent.ref.id}:${agent.state.size}:${agent.state.mtimeMs}:${agent.finished}`)
  if (record) parts.push(String(Math.floor(Date.now() / LIVE_BUCKET_MS)))
  if (extra) parts.push(extra)
  return hash(parts.join('|'))
}

function agentLinks(session, loaded) {
  const byId = new Map(session.agents.map((agent) => [agent.id, agent]))
  const byToolUse = new Map()
  const byRun = new Map()
  for (const agent of loaded.agents) {
    const dto = byId.get(agent.ref.id)
    if (!dto) continue
    if (agent.meta.toolUseId) byToolUse.set(agent.meta.toolUseId, dto)
    if (agent.ref.workflowId) {
      if (!byRun.has(agent.ref.workflowId)) byRun.set(agent.ref.workflowId, [])
      byRun.get(agent.ref.workflowId).push(dto)
    }
  }
  const taskStatus = loaded.main ? loaded.main.data.taskStatus : new Map()
  return { byId, byToolUse, byRun, taskStatus, live: Boolean(session.record) }
}

function linkedAgent(tool, links) {
  return links.byToolUse.get(tool.id) || (tool.agentId ? links.byId.get(tool.agentId) : null) || null
}

function linkedRun(tool, links) {
  return tool.runId ? links.byRun.get(tool.runId) || [] : []
}

function preview(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > PREVIEW_LIMIT ? `${flat.slice(0, PREVIEW_LIMIT).trimEnd()}…` : flat
}

function isLong(text) {
  if (!text) return false
  if (text.length > LONG_TEXT) return true
  let lines = 1
  for (let i = 0; i < text.length && lines <= LONG_LINES; i++) if (text.charCodeAt(i) === 10) lines++
  return lines > LONG_LINES
}

function truncatedNote(shown, length) {
  return length > shown ? `Showing the first ${format.count(shown)} of ${format.count(length)} characters.` : null
}

function attachmentsLabel(source) {
  return [source.images ? format.plural(source.images, 'image', 'images') : null, source.documents ? format.plural(source.documents, 'document', 'documents') : null].filter(Boolean).join(', ') || null
}

function kindLabel(turn) {
  if (turn.kind === 'peer' && turn.name) return `Report from ${turn.name}`
  return KIND_LABELS[turn.kind] || 'Message'
}

function turnTitle(turn) {
  if (turn.kind === 'start') return 'Claude kept working without a new message.'
  if (turn.kind === 'notification') return turn.text || 'A background task finished.'
  if (turn.text) return preview(turn.text)
  return attachmentsLabel(turn) || 'Empty message'
}

function referencedAgents(timeline, turn, links) {
  const agents = new Map()
  for (const item of turn.items) {
    if (item.type !== 'step') continue
    for (const block of timeline.steps[item.step].blocks) {
      if (block.type !== 'tool') continue
      const tool = timeline.tools.get(block.id)
      if (tool.kind === 'agent') {
        const dto = linkedAgent(tool, links)
        if (dto) agents.set(dto.id, dto)
      } else if (tool.kind === 'workflow') {
        for (const dto of linkedRun(tool, links)) agents.set(dto.id, dto)
      }
    }
  }
  return [...agents.values()]
}

function turnRev(turn, agents) {
  return hash(`${turn.rev}|${agents.map((agent) => `${agent.id}:${agent.messages}:${agent.status}:${agent.totalTokens}`).join(',')}`)
}

function stepTokens(step) {
  return step.usage ? step.usage.input + step.usage.output + step.usage.cacheRead + step.usage.cacheWrite : 0
}

function turnTotals(timeline, turn, agents, claimed) {
  const totals = { tokens: 0, calls: 0, tools: 0, errors: 0, agentTokens: 0, agentCount: agents.length }
  for (const item of turn.items) {
    if (item.type !== 'step') continue
    const step = timeline.steps[item.step]
    totals.calls += 1
    totals.tokens += stepTokens(step)
    for (const block of step.blocks) {
      if (block.type !== 'tool') continue
      totals.tools += 1
      const tool = timeline.tools.get(block.id)
      if (tool.result && tool.result.isError) totals.errors += 1
    }
  }
  for (const agent of agents) {
    if (claimed.has(agent.id)) continue
    claimed.add(agent.id)
    totals.agentTokens += agent.totalTokens
  }
  totals.tokens += totals.agentTokens
  return totals
}

function turnSummary(turn, totals, rev, now) {
  const duration = turn.at && turn.endAt > turn.at ? format.duration(turn.endAt - turn.at) : ''
  const facts = [
    totals.calls ? format.plural(totals.calls, 'model call', 'model calls') : 'No model calls',
    totals.tools ? format.plural(totals.tools, 'tool call', 'tool calls') : null,
    totals.agentCount ? format.plural(totals.agentCount, 'agent', 'agents') : null,
    totals.errors ? format.plural(totals.errors, 'error', 'errors') : null,
    duration,
  ]
  return {
    index: turn.index,
    number: turn.index + 1,
    kind: turn.kind,
    kindLabel: kindLabel(turn),
    title: turnTitle(turn),
    status: turn.status || null,
    statusLabel: turn.status ? NOTIFICATION_STATUS[turn.status] || format.capitalize(turn.status) : null,
    atLabel: turn.at ? format.timeLabel(turn.at, now) : '',
    factsLabel: facts.filter(Boolean).join(' · '),
    footLabel: totals.calls || totals.agentCount ? [`${format.tokens(totals.tokens)} tokens`, ...facts].filter(Boolean).join(' · ') : null,
    tokens: totals.tokens,
    tokensLabel: `${format.tokens(totals.tokens)} tokens`,
    agentTokensLabel: totals.agentTokens ? `${format.tokens(totals.agentTokens)} tokens in agents` : null,
    share: 0,
    rev,
  }
}

function summarize(timeline, links, now) {
  const claimed = new Set()
  const summaries = timeline.turns.map((turn) => {
    const agents = referencedAgents(timeline, turn, links)
    return turnSummary(turn, turnTotals(timeline, turn, agents, claimed), turnRev(turn, agents), now)
  })
  const max = Math.max(0, ...summaries.map((summary) => summary.tokens))
  for (const summary of summaries) summary.share = max ? summary.tokens / max : 0
  return summaries
}

function timelineView(timeline, links, now) {
  const summaries = summarize(timeline, links, now)
  return {
    turns: summaries,
    countLabel: format.plural(summaries.length, 'message', 'messages'),
    error: timeline.error || null,
  }
}

function usageRows(usage) {
  const total = usage.input + usage.cacheWrite + usage.cacheRead + usage.output
  const share = (value) => format.percent(total ? value / total : 0)
  const writeLabel = usage.write1h && usage.write5m ? 'Cache write' : usage.write1h ? 'Cache write, kept 1 hour' : 'Cache write, kept 5 minutes'
  const rows = [
    { label: 'Input', value: format.count(usage.input), share: share(usage.input) },
    { label: writeLabel, value: format.count(usage.cacheWrite), share: share(usage.cacheWrite) },
    { label: 'Cache read', value: format.count(usage.cacheRead), share: share(usage.cacheRead) },
    { label: 'Output', value: format.count(usage.output), note: usage.thinking ? `${format.count(usage.thinking)} of it thinking` : null, share: share(usage.output) },
  ]
  if (usage.searches) rows.push({ label: 'Web searches', value: format.count(usage.searches), share: '' })
  return rows
}

function toolStatus(tool, live) {
  if (!tool.result) return { status: 'pending', statusLabel: live ? 'Waiting for the result' : 'No result' }
  if (tool.result.isError) return { status: 'error', statusLabel: 'Error' }
  const duration = tool.at && tool.resultAt && tool.resultAt >= tool.at ? format.duration(tool.resultAt - tool.at) : ''
  return { status: 'done', statusLabel: duration }
}

function agentCard(dto) {
  if (!dto) return null
  return {
    id: dto.id,
    typeLabel: dto.typeLabel,
    description: dto.description,
    phase: dto.phase,
    status: dto.status,
    statusLabel: dto.statusLabel,
    tokensLabel: dto.tokensLabel,
    modelsLabel: dto.modelsLabel,
    callsLabel: format.plural(dto.messages, 'model call', 'model calls'),
    lastActiveAt: dto.lastActiveAt,
  }
}

function workflowStatus(tool, agents, links) {
  const task = links.taskStatus.get(tool.id)
  if (task === 'completed') return { status: 'done', statusLabel: 'Done' }
  if (task === 'failed') return { status: 'failed', statusLabel: 'Failed' }
  if (task === 'killed' || task === 'stopped') return { status: 'stopped', statusLabel: 'Stopped' }
  if (agents.some((agent) => agent.status === 'working')) return { status: 'working', statusLabel: 'Working' }
  return links.live ? { status: 'inactive', statusLabel: 'Running' } : { status: 'ended', statusLabel: 'Ended' }
}

function phasesOf(agents) {
  const phases = new Map()
  for (const agent of [...agents].sort((a, b) => (a.lastActiveAt || 0) - (b.lastActiveAt || 0))) {
    const key = agent.phase || 'Agents'
    if (!phases.has(key)) phases.set(key, [])
    phases.get(key).push(agentCard(agent))
  }
  return [...phases.entries()].map(([title, list]) => ({ title, agents: list }))
}

function toolDto(tool, links) {
  const dto = {
    type: 'tool',
    key: tool.id,
    kind: tool.kind,
    name: tool.name,
    label: tool.label,
    target: tool.target,
    detail: tool.detail,
    result: tool.result
      ? { text: tool.result.text, isError: tool.result.isError, empty: !tool.result.text.trim(), truncatedNote: truncatedNote(tool.result.text.length, tool.result.length) }
      : null,
    ...toolStatus(tool, links.live),
  }
  if (tool.kind === 'agent') {
    dto.agent = agentCard(linkedAgent(tool, links))
    dto.subagentLabel = tool.subagentType ? format.agentTypeLabel(tool.subagentType) : 'Agent'
    dto.backgroundLabel = tool.background ? 'Ran in the background' : 'Claude waited for it'
  } else if (tool.kind === 'workflow') {
    const agents = linkedRun(tool, links)
    const tokens = agents.reduce((total, agent) => total + agent.totalTokens, 0)
    dto.workflow = {
      name: tool.workflowName || tool.target || 'Workflow',
      summary: tool.summary || tool.detail || '',
      tokensLabel: `${format.tokens(tokens)} tokens`,
      agentsLabel: format.plural(agents.length, 'agent', 'agents'),
      phases: phasesOf(agents),
      ...workflowStatus(tool, agents, links),
    }
  }
  return dto
}

function shortTarget(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > SUMMARY_TARGET ? `${flat.slice(0, SUMMARY_TARGET).trimEnd()}…` : flat
}

function callSummary(blocks) {
  const tools = blocks.filter((block) => block.type === 'tool')
  const parts = []
  if (blocks.some((block) => block.type === 'thinking')) parts.push('Thinking')
  for (const tool of tools.slice(0, 2)) parts.push([tool.label, shortTarget(tool.target)].filter(Boolean).join(' '))
  if (tools.length > 2) parts.push(format.plural(tools.length - 2, 'more tool call', 'more tool calls'))
  if (blocks.some((block) => block.type === 'text')) parts.push('Reply')
  return parts.join(', ') || 'No content'
}

function stepDto(timeline, step, number, maxTokens, links, now) {
  const usage = step.usage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, write5m: 0, write1h: 0, thinking: 0, searches: 0, fast: false }
  const context = usage.input + usage.cacheRead + usage.cacheWrite
  let thinking = null
  const blocks = []
  for (const block of step.blocks) {
    if (block.type === 'tool') blocks.push(toolDto(timeline.tools.get(block.id), links))
    else if (block.type === 'thinking') {
      if (thinking) {
        if (block.text) thinking.text = thinking.text ? `${thinking.text}\n\n${block.text}` : block.text
        continue
      }
      thinking = {
        type: 'thinking',
        text: block.text,
        tokens: usage.thinking,
        tokensLabel: usage.thinking ? `${format.tokens(usage.thinking)} tokens` : null,
        emptyLabel: usage.thinking ? `Claude Code did not save the text of this thinking. It used ${format.tokens(usage.thinking)} tokens.` : 'Claude Code did not save the text of this thinking.',
      }
      blocks.push(thinking)
    } else blocks.push({ type: 'text', text: block.text, long: isLong(block.text), truncatedNote: truncatedNote(block.text.length, block.length) })
  }
  return {
    type: 'step',
    key: `s${step.index}`,
    number,
    modelLabel: format.modelLabel(step.model),
    tokensLabel: `${format.tokens(context + usage.output)} tokens`,
    share: maxTokens ? (context + usage.output) / maxTokens : 0,
    atLabel: step.at ? format.timeLabel(step.at, now) : '',
    durationLabel: step.startAt && step.endAt && step.endAt >= step.startAt ? format.duration(step.endAt - step.startAt) : '',
    contextLabel: `${format.tokens(context)} tokens`,
    speedLabel: usage.fast ? 'Fast mode' : null,
    stopLabel: STOP_LABELS[step.stopReason] || null,
    summaryLabel: callSummary(blocks),
    usage: usageRows(usage),
    blocks,
  }
}

function markerDto(marker, now) {
  const base = { type: 'marker', kind: marker.kind, atLabel: marker.at ? format.timeLabel(marker.at, now) : '', text: '', detail: '' }
  switch (marker.kind) {
    case 'compact':
      return {
        ...base,
        label: marker.trigger === 'manual' ? 'You compacted the conversation' : 'Claude Code compacted the conversation to free up context',
        text: marker.preTokens ? `The context went from ${format.tokens(marker.preTokens)} tokens to ${format.tokens(marker.postTokens)}.` : '',
        detail: marker.detail || '',
        detailLabel: 'Summary Claude kept',
      }
    case 'error':
      return { ...base, label: 'A request to the API failed', text: marker.count > 1 ? `${marker.text} This happened ${marker.count} times in a row.` : marker.text }
    case 'interrupted':
      return { ...base, label: marker.text === 'tool' ? 'You stopped a tool call' : 'You stopped Claude' }
    case 'skill':
      return { ...base, label: `Loaded the ${marker.text} skill` }
    case 'command':
      return { ...base, label: `Ran ${marker.text}` }
    case 'command-output':
      return { ...base, label: 'Command output', text: marker.text }
    case 'notice':
      return { ...base, label: 'Notice from Claude Code', text: marker.text }
    case 'hook':
      return { ...base, label: 'A hook stopped Claude', text: marker.text }
    case 'queued':
      return { ...base, label: 'You sent this while Claude was working', text: marker.text, attachmentsLabel: attachmentsLabel(marker), long: isLong(marker.text) }
    case 'notification':
      return { ...base, label: 'A background task finished', text: marker.text, statusLabel: marker.status ? NOTIFICATION_STATUS[marker.status] || format.capitalize(marker.status) : null }
    case 'peer':
      return { ...base, label: marker.name ? `Report from ${marker.name}` : 'Message from another session', text: marker.text, long: isLong(marker.text), truncatedNote: truncatedNote(marker.text.length, marker.length || 0) }
    default:
      return { ...base, label: format.capitalize(marker.kind) }
  }
}

function promptDto(turn) {
  return {
    text: turn.text,
    long: isLong(turn.text),
    truncatedNote: truncatedNote(turn.text.length, turn.length || 0),
    attachmentsLabel: attachmentsLabel(turn),
    requestLabel: turn.request ? `Started by your message: ${turn.request}` : null,
    statusLabel: turn.status ? NOTIFICATION_STATUS[turn.status] || format.capitalize(turn.status) : null,
    result: turn.result || '',
    resultNote: turn.result ? truncatedNote(turn.result.length, turn.resultLength || 0) : null,
  }
}

function activityOf(entries, live) {
  const tools = entries.filter((entry) => entry.type === 'tool')
  const thinking = entries.filter((entry) => entry.type === 'thinking')
  const thinkingTokens = thinking.reduce((sum, entry) => sum + (entry.tokens || 0), 0)
  if (!tools.length) {
    return { label: 'Thinking', detail: thinkingTokens ? `${format.tokens(thinkingTokens)} tokens` : null, note: null, status: 'thinking', title: 'Thinking', clickable: thinking.some((entry) => entry.text) }
  }
  const errors = tools.filter((tool) => tool.status === 'error').length
  const pending = tools.filter((tool) => tool.status === 'pending').length
  const status = errors ? 'error' : pending ? 'pending' : 'done'
  if (tools.length === 1) {
    const tool = tools[0]
    return { label: tool.label, detail: tool.target, note: tool.statusLabel || null, status, title: [tool.label, tool.target].filter(Boolean).join(' '), clickable: true }
  }
  const counts = new Map()
  for (const tool of tools) counts.set(tool.label, (counts.get(tool.label) || 0) + 1)
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const names = ranked.slice(0, ACTIVITY_NAMES).map(([name, count]) => (count > 1 ? `${name} (${count})` : name))
  if (ranked.length > ACTIVITY_NAMES) names.push(format.plural(ranked.length - ACTIVITY_NAMES, 'other tool', 'other tools'))
  const label = `${thinking.length ? 'Thought, then used' : 'Used'} ${format.plural(tools.length, 'tool', 'tools')}`
  return {
    label,
    detail: names.join(', '),
    note: [errors ? format.plural(errors, 'error', 'errors') : null, pending ? `${pending} ${live ? 'running' : 'without a result'}` : null].filter(Boolean).join(', ') || null,
    status,
    title: label,
    clickable: true,
  }
}

function segmentsOf(items, live) {
  const segments = []
  let group = null
  const flush = () => {
    if (!group) return
    segments.push({ type: 'activity', key: group.key, steps: [...new Set(group.entries.map((entry) => entry.step))], entries: group.entries, ...activityOf(group.entries, live) })
    group = null
  }
  for (const item of items) {
    if (item.type === 'marker') {
      flush()
      segments.push({ ...item, steps: [] })
      continue
    }
    item.blocks.forEach((block, position) => {
      const entry = { ...block, step: item.key, key: block.type === 'tool' ? block.key : `${item.key}-${position}` }
      if (block.type === 'text' || (block.type === 'tool' && block.kind !== 'tool')) {
        flush()
        segments.push({ ...entry, steps: [item.key] })
        return
      }
      if (!group) group = { key: `group-${entry.key}`, entries: [] }
      group.entries.push(entry)
    })
  }
  flush()
  return segments
}

function chatTurn(timeline, turn, summary, links, now) {
  let maxTokens = 0
  for (const item of turn.items) {
    if (item.type === 'step') maxTokens = Math.max(maxTokens, stepTokens(timeline.steps[item.step]))
  }
  let number = 0
  const calls = []
  const items = turn.items.map((item) => {
    if (item.type === 'marker') return markerDto(item, now)
    const step = stepDto(timeline, timeline.steps[item.step], ++number, maxTokens, links, now)
    const { blocks, ...call } = step
    calls.push(call)
    return step
  })
  return {
    ...summary,
    prompt: promptDto(turn),
    segments: segmentsOf(items, links.live),
    calls,
    agents: referencedAgents(timeline, turn, links).map(agentCard),
    emptyLabel: items.length ? null : turn.kind === 'command' ? 'This command ran inside Claude Code without a model call.' : links.live ? 'Claude has not answered this message yet.' : 'Claude did not answer this message.',
  }
}

function spanLabel(from, to) {
  return from && to && to > from ? format.duration(to - from) : null
}

async function loadSession(collector, id) {
  if (!id || !SESSION_ID.test(id)) return null
  await collector.init()
  return collector.one(id)
}

class RequestError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function isFolder(folder) {
  try {
    return (await fs.promises.stat(folder)).isDirectory()
  } catch {
    return false
  }
}

function composerOf(session, item, run) {
  const folder = session.cwd ? format.homePath(session.cwd) : null
  const base = {
    placeholder: 'Reply to Claude',
    note: folder ? `Sends your message with claude --resume in ${folder}, using your Claude Code settings and permissions.` : null,
    error: run && run.status === 'failed' ? `Your last message failed: ${run.error}` : null,
    stoppedLabel: run && run.status === 'stopped' ? 'You stopped Claude before it finished.' : null,
  }
  if (run && run.status === 'running') return { ...base, state: 'running', text: 'Claude is answering your message.' }
  if (item.record) return { ...base, state: 'live', text: 'This conversation is open in Claude Code. Send your message there.' }
  if (!session.cwd || !item.loaded.main) return { ...base, state: 'unavailable', text: 'This conversation has no folder on record, so it cannot be resumed from here.' }
  return { ...base, state: 'ready', text: null }
}

function requestId(body) {
  const id = body && typeof body.id === 'string' ? body.id : ''
  if (!SESSION_ID.test(id)) throw new RequestError(400, 'This conversation ID is not valid.')
  return id
}

async function sendMessage(collector, runs, body) {
  const id = requestId(body)
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) throw new RequestError(400, 'Write a message first.')
  if (message.length > MESSAGE_LIMIT) throw new RequestError(400, `The message is too long. Keep it under ${format.count(MESSAGE_LIMIT)} characters.`)
  const item = await loadSession(collector, id)
  if (!item) throw new RequestError(404, 'This conversation was not found on this computer.')
  if (runs.active(id)) throw new RequestError(409, 'Claude is still answering your last message.')
  if (item.record) throw new RequestError(409, 'This conversation is open in Claude Code. Send your message there.')
  const session = describeSession(item, { range: null, now: Date.now() })
  if (!session.cwd || !item.loaded.main) throw new RequestError(409, 'This conversation has no folder on record, so it cannot be resumed from here.')
  if (!(await isFolder(session.cwd))) throw new RequestError(409, `The folder ${format.homePath(session.cwd)} no longer exists, so this conversation cannot be resumed.`)
  return { run: runs.start(id, session.cwd, message) }
}

function openerOf(session, item, run) {
  if (item.record) return { available: false, note: 'This conversation is already open in Claude Code.' }
  if (run && run.status === 'running') return { available: false, note: 'Claude is answering your message from the dashboard.' }
  if (!session.cwd || !item.loaded.main) return { available: false, note: 'This conversation has no folder on record, so it cannot be resumed.' }
  return { available: true, note: null }
}

async function openConversation(collector, runs, body) {
  const id = requestId(body)
  const target = body.target
  if (target !== 'terminal' && target !== 'vscode') throw new RequestError(400, 'Choose where to open the conversation: terminal or vscode.')
  const item = await loadSession(collector, id)
  if (!item) throw new RequestError(404, 'This conversation was not found on this computer.')
  const session = describeSession(item, { range: null, now: Date.now() })
  const opener = openerOf(session, item, runs.get(id))
  if (!opener.available) throw new RequestError(409, opener.note)
  if (!(await isFolder(session.cwd))) throw new RequestError(409, `The folder ${format.homePath(session.cwd)} no longer exists, so this conversation cannot be resumed.`)
  try {
    if (target === 'vscode') {
      await openVscode(session.cwd, id)
      return { message: 'Opened the conversation in VS Code.' }
    }
    const app = await openTerminal(resumeCommand(session.cwd, id))
    return { message: `Opened the conversation in ${app}.` }
  } catch (error) {
    if (target === 'vscode' && error.code === 'ENOENT') throw new RequestError(500, 'Could not find VS Code. Install it, or open the conversation in a terminal.')
    throw new RequestError(500, `Could not open the conversation: ${error.message}`)
  }
}

function stopMessage(runs, body) {
  const id = requestId(body)
  if (!runs.stop(id)) throw new RequestError(409, 'Claude is not answering a message from the dashboard right now.')
  return { stopped: true }
}

async function buildConversation(collector, timelines, runs, accounts, params) {
  const item = await loadSession(collector, params.get('id'))
  if (!item) return null
  const run = runs.get(item.loaded.id)
  const revision = revisionOf(item, run ? `run:${run.status}:${run.endedAt || ''}` : null)
  if (params.get('revision') === revision) return { unchanged: true, revision }
  const now = Date.now()
  const session = describeSession(item, { range: null, now })
  const { loaded, record } = item
  const timeline = loaded.main ? await timelines.get(loaded.main.file, 'main') : null
  const links = agentLinks(session, loaded)
  const extra = session.extra ? sumModels(session.extra.models) : null
  const extraTokens = extra ? extra.input + extra.output + extra.cacheRead + extra.cacheWrite : 0
  const working = (record && record.status === 'busy') || (run && run.status === 'running')
  return {
    ...session.dto,
    revision,
    activity: working && loaded.main ? liveActivity(loaded.main, now, session.working.length) : null,
    configDir: record ? format.homePath(record.configDir) : null,
    claudeCodeVersion: record ? record.version || null : null,
    resumeCommand: resumeCommand(session.cwd, session.dto.id),
    durationLabel: spanLabel(session.dto.startedAt, session.dto.lastActiveAt),
    tokens: tokenRows(sumModels(session.models), extra),
    models: modelRows(session.models),
    agentGroups: agentGroups(session.agents),
    agentsNote: extraTokens
      ? `Claude Code's own total for this conversation includes ${format.tokens(extraTokens)} tokens that its transcripts do not record, mostly output from agents. The agent totals only count what the transcripts record.`
      : null,
    timeline: timeline ? timelineView(timeline, links, now) : null,
    timelineMissing: timeline ? null : 'This conversation has no main transcript on this computer, only agent transcripts.',
    composer: composerOf(session, item, run),
    opener: openerOf(session, item, run),
    account: await accounts.forSession(item),
  }
}

async function buildAgent(collector, timelines, accounts, params) {
  const agentId = params.get('agent')
  if (!agentId || !AGENT_ID.test(agentId)) return null
  const item = await loadSession(collector, params.get('id'))
  if (!item) return null
  const agent = item.loaded.agents.find((entry) => entry.ref.id === agentId)
  if (!agent) return null
  const revision = revisionOf(item, agentId)
  if (params.get('revision') === revision) return { unchanged: true, revision }
  const now = Date.now()
  const session = describeSession(item, { range: null, now })
  const dto = session.agents.find((entry) => entry.id === agentId)
  const timeline = await timelines.get(agent.ref.file, 'agent')
  const models = modelsOf(agent.state, null)
  const firstAt = timeline.turns.length ? timeline.turns[0].at : null
  return {
    ...dto,
    revision,
    title: dto.description || dto.typeLabel,
    callsLabel: format.plural(dto.messages, 'model call', 'model calls'),
    session: { id: session.dto.id, title: session.dto.title, projectLabel: session.dto.projectLabel, live: session.dto.live },
    workflowLabel: agent.ref.workflowId ? `Workflow ${agent.workflowName || agent.ref.workflowId}` : null,
    durationLabel: spanLabel(firstAt, dto.lastActiveAt),
    tokens: tokenRows(sumModels(models), null),
    models: modelRows(models),
    timeline: timelineView(timeline, agentLinks(session, item.loaded), now),
    account: await accounts.forSession(item),
  }
}

async function loadChat(collector, timelines, params) {
  const agentId = params.get('agent') || ''
  if (agentId && !AGENT_ID.test(agentId)) return null
  const item = await loadSession(collector, params.get('id'))
  if (!item) return null
  const agent = agentId ? item.loaded.agents.find((entry) => entry.ref.id === agentId) : null
  const file = agentId ? agent && agent.ref.file : item.loaded.main && item.loaded.main.file
  if (!file) return null
  const now = Date.now()
  const session = describeSession(item, { range: null, now })
  const timeline = await timelines.get(file, agentId ? 'agent' : 'main')
  const links = agentLinks(session, item.loaded)
  return { timeline, links, now, summaries: summarize(timeline, links, now) }
}

function whole(value, fallback) {
  const number = Number(value)
  return value !== null && value !== '' && Number.isInteger(number) && number >= 0 ? number : fallback
}

async function buildChat(collector, timelines, params) {
  const chat = await loadChat(collector, timelines, params)
  if (!chat) return null
  const total = chat.timeline.turns.length
  const end = Math.min(whole(params.get('end'), total), total)
  const start = Math.max(Math.min(whole(params.get('start'), end - CHAT_PAGE), end), end - CHAT_MAX, 0)
  const turns = []
  for (let index = start; index < end; index++) turns.push(chatTurn(chat.timeline, chat.timeline.turns[index], chat.summaries[index], chat.links, chat.now))
  return { total, start, end, turns }
}

async function buildTurn(collector, timelines, params) {
  const index = whole(params.get('turn'), -1)
  if (index < 0) return null
  const chat = await loadChat(collector, timelines, params)
  if (!chat || !chat.timeline.turns[index]) return null
  return chatTurn(chat.timeline, chat.timeline.turns[index], chat.summaries[index], chat.links, chat.now)
}

module.exports = { buildConversation, buildAgent, buildChat, buildTurn, sendMessage, stopMessage, openConversation, RequestError }
