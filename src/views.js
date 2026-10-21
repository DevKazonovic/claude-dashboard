const path = require('path')
const format = require('./format')
const { resolveRange, dayKey, parseDay, shift } = require('./ranges')
const { emptyTotals, TOTAL_KEYS } = require('./collector')
const { describeTool } = require('./timeline')

const WORKING_MS = 120000
const IN_FLIGHT_MS = 900000
const DAY_MS = 86400000
const PAGE_SIZES = [10, 25, 50, 100]
const SORTS = new Set(['lastActive', 'tokens', 'started'])
const PROJECT_SORTS = new Set(['tokens', 'lastActive', 'conversations', 'name'])
const PROJECT_ITEMS = 10
const TOP_LIMIT = 6
const AGENT_STATUS = { done: 'Done', failed: 'Failed', stopped: 'Stopped', working: 'Working', inactive: 'Inactive', ended: 'Ended' }
const TOKEN_ROWS = [
  ['cacheRead', 'Cache read'],
  ['cacheWrite', 'Cache write'],
  ['output', 'Output'],
  ['input', 'Input'],
]

function addModel(target, model, totals) {
  if (!target.has(model)) target.set(model, emptyTotals())
  const entry = target.get(model)
  for (const key of TOTAL_KEYS) entry[key] += totals[key] || 0
}

function modelsOf(transcript, range) {
  const models = new Map()
  if (!transcript) return models
  if (!range || !range.from) {
    for (const [model, totals] of transcript.data.models) addModel(models, model, totals)
    return models
  }
  for (const [day, dayModels] of transcript.data.days) {
    if (day < range.from || day > range.to) continue
    for (const [model, totals] of dayModels) addModel(models, model, totals)
  }
  return models
}

function mergeModels(target, source) {
  for (const [model, totals] of source) addModel(target, model, totals)
  return target
}

function sumModels(models) {
  const total = emptyTotals()
  for (const totals of models.values()) for (const key of TOTAL_KEYS) total[key] += totals[key]
  return total
}

function tokenFields(totals) {
  const all = totals.input + totals.output + totals.cacheRead + totals.cacheWrite
  return {
    inputTokens: totals.input,
    outputTokens: totals.output,
    cacheReadTokens: totals.cacheRead,
    cacheWriteTokens: totals.cacheWrite,
    totalTokens: all,
    inputLabel: format.tokens(totals.input),
    outputLabel: format.tokens(totals.output),
    cacheReadLabel: format.tokens(totals.cacheRead),
    cacheWriteLabel: format.tokens(totals.cacheWrite),
    totalTokensLabel: format.tokens(all),
    tokensLabel: `${format.tokens(all)} tokens`,
  }
}

function modelRows(models) {
  return [...models.entries()].map(([model, totals]) => ({ model, label: format.modelLabel(model), calls: totals.messages, callsLabel: format.plural(totals.messages, 'model call', 'model calls'), ...tokenFields(totals) })).sort((a, b) => b.totalTokens - a.totalTokens)
}

function tokenRows(totals, extra) {
  const rows = TOKEN_ROWS.map(([key, label]) => ({ key, label, tokens: Math.max(0, totals[key] - (extra ? extra[key] : 0)) }))
  const extraTokens = extra ? extra.input + extra.output + extra.cacheRead + extra.cacheWrite : 0
  if (extraTokens > 0) rows.push({ key: 'extra', label: 'Not in the transcripts', tokens: extraTokens })
  const total = rows.reduce((sum, row) => sum + row.tokens, 0)
  const result = rows.map((row) => ({
    key: row.key,
    label: row.label,
    valueLabel: `${format.tokens(row.tokens)} tokens`,
    detailLabel: format.percent(total ? row.tokens / total : 0),
    share: total ? row.tokens / total : 0,
  }))
  if (totals.webSearches) result.push({ key: 'search', label: 'Web searches', valueLabel: format.plural(totals.webSearches, 'search', 'searches'), detailLabel: null, share: null })
  return result
}

function correctionFor(loaded) {
  const snapshot = loaded.main && loaded.main.data.costState
  if (!snapshot) return null
  const counted = mergeModels(new Map(), snapshot.mainBefore)
  if (snapshot.at !== null) {
    for (const agent of loaded.agents) {
      for (const entry of agent.state.data.seen.values()) {
        if (entry.t <= snapshot.at) addModel(counted, entry.model, { ...entry, cost: entry.cost || 0, messages: 0, unpriced: 0 })
      }
    }
  }
  const models = new Map()
  for (const [model, recorded] of snapshot.models) {
    const seen = counted.get(model) || emptyTotals()
    const extra = emptyTotals()
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'webSearches', 'cost']) extra[key] = Math.max(0, recorded[key] - seen[key])
    if (extra.cost > 0 || extra.output > 0) models.set(model, extra)
  }
  return models.size ? { day: snapshot.day, models, cost: sumModels(models).cost } : null
}

function firstLine(text) {
  return text ? String(text).split('\n')[0].trim() : ''
}

function agentStatus(agent, main, record, now) {
  const live = Boolean(record)
  if (agent.finished) return 'done'
  const toolUseId = agent.meta.toolUseId
  const task = main ? (toolUseId && main.data.taskStatus.get(toolUseId)) || main.data.taskStatusById.get(agent.ref.id) || null : null
  if (task === 'completed') return 'done'
  if (task === 'failed') return 'failed'
  if (task === 'killed' || task === 'stopped') return 'stopped'
  if (agent.ref.workflowId && main) {
    const taskId = main.data.workflowTasks.get(agent.ref.workflowId)
    const workflow = taskId ? main.data.taskStatusById.get(taskId) : null
    if (workflow === 'failed') return 'failed'
    if (workflow === 'killed' || workflow === 'stopped') return 'stopped'
    if (workflow === 'completed') return live ? 'inactive' : 'ended'
  }
  const foreground = agent.meta.requestShape !== 'background' && !agent.ref.workflowId
  if (foreground && toolUseId && main && main.data.toolResults.has(toolUseId)) return 'done'
  if (!live) return 'ended'
  const quiet = now - agent.state.mtimeMs
  if (quiet < WORKING_MS) return 'working'
  const data = agent.state.data
  const inFlight = (data.openTools.size > 0 || !data.turnEnded) && !data.interrupted
  const thisRun = !record.startedAt || agent.state.mtimeMs >= record.startedAt
  return inFlight && thisRun && quiet < IN_FLIGHT_MS ? 'working' : 'inactive'
}

function liveActivity(transcript, now, agentsWorking) {
  const data = transcript.data
  const open = [...data.openTools.values()]
  const activity = (label, target, moreLabel, since) => ({ label, target, moreLabel, sinceLabel: Number.isFinite(since) && since > 0 ? format.duration(Math.max(0, now - since)) : null })
  if (open.length) {
    const latest = open[open.length - 1]
    const tool = describeTool(latest.block, latest.cwd)
    return activity(tool.label, tool.target, open.length > 1 ? `and ${format.plural(open.length - 1, 'more tool', 'more tools')}` : null, latest.at)
  }
  if (!data.turnEnded) return activity('Thinking', '', null, transcript.mtimeMs)
  if (agentsWorking === undefined) return activity('Finishing', '', null, data.turnEndedAt)
  return activity(agentsWorking ? `Waiting for ${format.plural(agentsWorking, 'agent', 'agents')}` : 'Waiting for background tasks', '', null, data.turnEndedAt)
}

function agentDto(agent, main, record, now) {
  const models = modelsOf(agent.state, null)
  const totals = sumModels(models)
  const status = agentStatus(agent, main, record, now)
  const lastActiveAt = agent.state.mtimeMs || null
  return {
    id: agent.ref.id,
    workflowId: agent.ref.workflowId,
    workflowName: agent.workflowName,
    typeLabel: format.agentTypeLabel(agent.meta.agentType),
    description: agent.meta.description || '',
    phase: agent.meta.workflowPhase || null,
    status,
    statusLabel: AGENT_STATUS[status],
    lastActiveAt,
    lastActiveLabel: lastActiveAt ? format.capitalize(format.ago(lastActiveAt, now)) : 'Unknown',
    modelsLabel: modelRows(models).map((row) => row.label).join(', ') || 'No model calls yet',
    messages: totals.messages,
    activity: status === 'working' ? liveActivity(agent.state, now) : null,
    ...tokenFields(totals),
  }
}

function describeSession({ record, loaded }, { range, now }) {
  const main = loaded.main
  const data = main ? main.data : null
  const live = Boolean(record)
  const models = modelsOf(main, range)
  for (const agent of loaded.agents) mergeModels(models, modelsOf(agent.state, range))
  const correction = correctionFor(loaded)
  const correctionInRange = correction && (!range || !range.from || (correction.day && correction.day >= range.from && correction.day <= range.to))
  if (correctionInRange) mergeModels(models, correction.models)
  const totals = sumModels(models)
  const agents = loaded.agents.map((agent) => agentDto(agent, main, record, now)).sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
  const working = agents.filter((agent) => agent.status === 'working')
  const everUsed = (data ? data.seen.size : 0) + loaded.agents.reduce((total, agent) => total + agent.state.data.seen.size, 0) > 0
  const cwd = (record && record.cwd) || (data && data.cwd) || ''
  const mtimes = [main ? main.mtimeMs : 0, ...loaded.agents.map((agent) => agent.state.mtimeMs || 0)]
  const lastActiveAt = Math.max(record && record.updatedAt ? record.updatedAt : 0, ...mtimes) || null
  const firstTs = data && data.firstTs ? Date.parse(data.firstTs) : NaN
  const startedAt = (record && record.startedAt) || (Number.isFinite(firstTs) ? firstTs : null)
  const rows = modelRows(models)
  const dto = {
    id: loaded.id,
    title: (data && (data.customTitle || data.aiTitle || firstLine(data.lastPrompt))) || (record && record.name) || 'Untitled conversation',
    name: record ? record.name || null : null,
    live,
    status: live ? record.status || 'unknown' : 'ended',
    statusLabel: live ? format.sessionStatusLabel(record.status) : 'Ended',
    project: cwd,
    projectLabel: cwd ? format.homePath(cwd) : 'Unknown folder',
    projectName: cwd ? path.basename(cwd) : 'Unknown folder',
    whereLabel: live ? format.whereLabel(record.kind, record.entrypoint) : null,
    startedAt,
    startedLabel: startedAt ? `Started ${format.ago(startedAt, now)}` : 'Start time unknown',
    startedDateLabel: startedAt ? format.dateTimeLabel(startedAt) : 'Unknown',
    lastActiveAt,
    lastActiveLabel: lastActiveAt ? format.capitalize(format.ago(lastActiveAt, now)) : 'Unknown',
    lastActiveDateLabel: lastActiveAt ? format.dateTimeLabel(lastActiveAt) : 'Unknown',
    agentCount: agents.length,
    workingAgents: working.length,
    agentsLabel: agents.length ? `${format.plural(agents.length, 'agent', 'agents')}${working.length ? `, ${working.length} working` : ''}` : 'No agents',
    modelsLabel: rows.map((row) => row.label).join(', ') || 'No model calls',
    messages: totals.messages,
    messagesLabel: format.count(totals.messages),
    ...tokenFields(totals),
  }
  return { dto, models, agents, working, record, cwd, everUsed, correction, extra: correctionInRange ? correction : null, loaded }
}

function shellQuote(value) {
  return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

function resumeCommand(cwd, id) {
  const resume = `claude --resume ${id}`
  if (!cwd) return resume
  if (process.platform === 'win32') return `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'; ${resume}`
  return `cd ${shellQuote(cwd)} && ${resume}`
}

function agentGroups(agents) {
  const groups = new Map()
  for (const agent of agents) {
    const key = agent.workflowId || 'subagents'
    if (!groups.has(key)) groups.set(key, { key, workflowName: agent.workflowName, agents: [] })
    groups.get(key).agents.push(agent)
  }
  return [...groups.values()]
    .map((group) => {
      const tokens = group.agents.reduce((total, agent) => total + agent.totalTokens, 0)
      const working = group.agents.filter((agent) => agent.status === 'working').length
      return {
        key: group.key,
        title: group.key === 'subagents' ? 'Subagents' : `Workflow ${group.workflowName || group.key}`,
        subtitle: [format.plural(group.agents.length, 'agent', 'agents'), working ? `${working} working` : null, `${format.tokens(tokens)} tokens`].filter(Boolean).join(', '),
        tokens,
        tokensLabel: `${format.tokens(tokens)} tokens`,
        lastActiveAt: Math.max(0, ...group.agents.map((agent) => agent.lastActiveAt || 0)),
        agents: group.agents,
      }
    })
    .sort((a, b) => {
      if ((a.key === 'subagents') !== (b.key === 'subagents')) return a.key === 'subagents' ? -1 : 1
      return b.lastActiveAt - a.lastActiveAt
    })
}

function scanDto(scan) {
  const percent = scan.status === 'done' ? 100 : scan.totalBytes ? Math.min(99, Math.floor((scan.doneBytes / scan.totalBytes) * 100)) : 0
  const label =
    scan.status === 'done'
      ? 'All transcripts read'
      : scan.status === 'failed'
        ? `Reading the transcripts failed: ${scan.error}`
        : `Reading your Claude Code transcripts, ${percent}% done. This happens once each time the dashboard starts.`
  return { status: scan.status, percent, label, error: scan.error, doneBytes: scan.doneBytes, totalBytes: scan.totalBytes }
}

async function scanState(collector) {
  await collector.init()
  if (collector.scanStatus().status === 'idle') collector.startFullScan()
  const scan = collector.scanStatus()
  if (scan.status === 'failed') throw new Error(`Reading the transcripts failed: ${scan.error}`)
  if (scan.status !== 'done') return { status: 'scanning', scan: scanDto(scan) }
  return null
}

function firstRunMessage(collector) {
  const looked = collector.configDirs().map(format.homePath).join(', ') || 'your home folder'
  return `Looked in ${looked}. Run Claude Code once, or start the dashboard with --config-dir <path> if your Claude folder is somewhere else.`
}

async function describeAll(collector, range, now) {
  return (await collector.all()).map((item) => describeSession(item, { range, now }))
}

function inRangeOf(described, range) {
  return described.filter((session) => (range && range.from ? session.dto.messages > 0 : session.everUsed || session.dto.live))
}

function pageOf(params, total) {
  const pageSize = PAGE_SIZES.includes(Number(params.get('pageSize'))) ? Number(params.get('pageSize')) : 25
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const page = Math.min(Math.max(1, parseInt(params.get('page'), 10) || 1), pages)
  return { page, pages, pageSize, start: (page - 1) * pageSize, end: page * pageSize }
}

function rangeDto(range) {
  return { key: range.key, label: range.label, description: range.description, from: range.from, to: range.to }
}

async function buildLive(collector, accounts) {
  await collector.init()
  const now = Date.now()
  const sessions = []
  for (const item of await collector.live()) {
    const session = describeSession(item, { range: null, now })
    const account = accounts ? await accounts.forSession(item) : null
    sessions.push({
      ...session.dto,
      accountLabel: account ? account.label : null,
      accountKnown: Boolean(account && account.known),
      activity: session.dto.status === 'busy' && item.loaded.main ? liveActivity(item.loaded.main, now, session.working.length) : null,
      workingAgentList: session.working.map((agent) => ({
        id: agent.id,
        typeLabel: agent.typeLabel,
        description: agent.description || agent.phase || agent.typeLabel,
        tokensLabel: agent.tokensLabel,
        activity: agent.activity,
      })),
    })
  }
  sessions.sort((a, b) => {
    if ((a.status === 'busy') !== (b.status === 'busy')) return a.status === 'busy' ? -1 : 1
    if (a.status === 'busy') return (a.startedAt || 0) - (b.startedAt || 0) || a.id.localeCompare(b.id)
    return (b.lastActiveAt || 0) - (a.lastActiveAt || 0)
  })
  const names = uniqueNames(sessions.map((dto) => ({ dto })))
  const byProject = new Map()
  for (const dto of sessions) {
    if (!byProject.has(dto.project)) byProject.set(dto.project, { project: dto.project, name: names.get(dto.project) || dto.projectName, label: dto.projectLabel, sessions: [] })
    byProject.get(dto.project).sessions.push(dto)
  }
  const groups = [...byProject.values()].map((group) => {
    const tokens = group.sessions.reduce((total, dto) => total + dto.totalTokens, 0)
    const busy = group.sessions.filter((dto) => dto.status === 'busy').length
    return {
      ...group,
      busy,
      summaryLabel: [format.plural(group.sessions.length, 'conversation', 'conversations'), busy ? `${busy} working` : null, `${format.tokens(tokens)} tokens`].filter(Boolean).join(', '),
    }
  })
  const tokens = sessions.reduce((total, dto) => total + dto.totalTokens, 0)
  const working = sessions.reduce((total, dto) => total + dto.workingAgentList.length, 0)
  const summaryLabel = sessions.length
    ? [
        format.plural(sessions.length, 'conversation running', 'conversations running'),
        working ? format.plural(working, 'agent working', 'agents working') : null,
        `${format.tokens(tokens)} tokens so far`,
      ]
        .filter(Boolean)
        .join(', ')
    : 'Nothing running'
  return {
    generatedAt: now,
    sessions,
    groups,
    totals: { count: sessions.length, tokens, tokensLabel: format.tokens(tokens), workingAgents: working, summaryLabel },
    scan: scanDto(collector.scanStatus()),
  }
}

function matchesSearch(session, search) {
  const dto = session.dto
  if ([dto.title, dto.projectLabel, dto.project, dto.id, dto.name || ''].some((value) => value.toLowerCase().includes(search))) return true
  return Boolean(session.loaded.main && session.loaded.main.data.promptText.includes(search))
}

async function buildHistory(collector, params) {
  const waiting = await scanState(collector)
  if (waiting) return waiting
  const now = Date.now()
  const range = resolveRange(params, new Date(now))
  const search = (params.get('q') || '').trim().toLowerCase()
  const project = params.get('project') || ''
  const requested = params.get('sort') === 'cost' ? 'tokens' : params.get('sort')
  const sort = SORTS.has(requested) ? requested : 'lastActive'
  const dir = params.get('dir') === 'asc' ? 'asc' : 'desc'
  const described = await describeAll(collector, range, now)
  const inRange = inRangeOf(described, range)
  const scoped = project ? inRange.filter((session) => session.dto.project === project) : inRange
  const matches = search ? scoped.filter((session) => matchesSearch(session, search)) : scoped
  const value = (session) => (sort === 'tokens' ? session.dto.totalTokens : sort === 'started' ? session.dto.startedAt || 0 : session.dto.lastActiveAt || 0)
  matches.sort((a, b) => (dir === 'asc' ? value(a) - value(b) : value(b) - value(a)) || (b.dto.lastActiveAt || 0) - (a.dto.lastActiveAt || 0))
  const total = matches.length
  const paging = pageOf(params, total)
  const byModel = new Map()
  let agents = 0
  for (const session of matches) {
    mergeModels(byModel, session.models)
    agents += session.dto.agentCount
  }
  const totals = sumModels(byModel)
  return {
    status: 'ready',
    range: rangeDto(range),
    page: paging.page,
    pages: paging.pages,
    pageSize: paging.pageSize,
    total,
    pageLabel: total ? `Page ${paging.page} of ${paging.pages}, ${format.plural(total, 'conversation', 'conversations')}` : '',
    rows: matches.slice(paging.start, paging.end).map((session) => session.dto),
    project: project ? { value: project, label: format.homePath(project) } : null,
    summary: {
      ...tokenFields(totals),
      sessionsLabel: format.count(total),
      agentsLabel: format.count(agents),
      rangeLabel: range.description,
      line: total ? `${format.plural(total, 'conversation', 'conversations')}, ${format.plural(agents, 'agent', 'agents')}, ${format.tokens(tokenFields(totals).totalTokens)} tokens` : '',
    },
    filtered: Boolean(search) || Boolean(project) || range.key !== 'all',
    sessionsOnMachine: described.filter((session) => session.everUsed || session.dto.live).length,
    firstRunMessage: firstRunMessage(collector),
  }
}

function addDays(target, session, range) {
  const transcripts = [session.loaded.main, ...session.loaded.agents.map((agent) => agent.state)].filter(Boolean)
  for (const transcript of transcripts) {
    for (const [day, models] of transcript.data.days) {
      if (range.from && (day < range.from || day > range.to)) continue
      const totals = sumModels(models)
      target.set(day, (target.get(day) || 0) + totals.input + totals.output + totals.cacheRead + totals.cacheWrite)
    }
  }
  if (session.extra && session.extra.day) {
    const extra = sumModels(session.extra.models)
    target.set(session.extra.day, (target.get(session.extra.day) || 0) + extra.input + extra.output + extra.cacheRead + extra.cacheWrite)
  }
}

function mondayOf(date) {
  return shift(date, -((date.getDay() + 6) % 7))
}

function bucketLabels(unit, from, now) {
  const year = new Date(now).getFullYear()
  const short = { month: 'short', day: 'numeric' }
  const long = { month: 'short', day: 'numeric', year: 'numeric' }
  if (unit === 'day') return { label: from.toLocaleDateString('en-US', short), title: from.toLocaleDateString('en-US', long) }
  if (unit === 'week') return { label: from.toLocaleDateString('en-US', short), title: `Week of ${from.toLocaleDateString('en-US', long)}` }
  return {
    label: from.toLocaleDateString('en-US', from.getFullYear() === year ? { month: 'short' } : { month: 'short', year: 'numeric' }),
    title: from.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
  }
}

function chartData(days, range, now) {
  const active = [...days.entries()]
    .filter(([, tokens]) => tokens > 0)
    .map(([day]) => day)
    .sort()
  const start = parseDay(range.from || active[0] || '')
  const end = parseDay(range.to || dayKey(new Date(now)))
  if (!start || !end || start > end) return { unit: 'day', title: 'Tokens per day', bars: [] }
  const span = Math.round((end - start) / DAY_MS) + 1
  const unit = span <= 45 ? 'day' : span <= 182 ? 'week' : 'month'
  const buckets = []
  const index = new Map()
  let cursor = unit === 'week' ? mondayOf(start) : unit === 'month' ? new Date(start.getFullYear(), start.getMonth(), 1) : new Date(start)
  while (cursor <= end) {
    const next = unit === 'day' ? shift(cursor, 1) : unit === 'week' ? shift(cursor, 7) : new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    for (let day = new Date(cursor); day < next; day = shift(day, 1)) index.set(dayKey(day), buckets.length)
    buckets.push({ from: new Date(cursor), tokens: 0 })
    cursor = next
  }
  for (const [day, tokens] of days) {
    const position = index.get(day)
    if (position !== undefined) buckets[position].tokens += tokens
  }
  const max = Math.max(0, ...buckets.map((bucket) => bucket.tokens))
  const bars = buckets.map((bucket) => ({ key: dayKey(bucket.from), ...bucketLabels(unit, bucket.from, now), tokens: bucket.tokens, valueLabel: `${format.tokens(bucket.tokens)} tokens`, value: max ? bucket.tokens / max : 0 }))
  return {
    unit,
    title: unit === 'day' ? 'Tokens per day' : unit === 'week' ? 'Tokens per week' : 'Tokens per month',
    bars,
    maxLabel: `${format.tokens(max)} tokens`,
    firstLabel: bars.length ? bars[0].label : '',
    lastLabel: bars.length ? bars[bars.length - 1].label : '',
  }
}

function uniqueNames(sessions) {
  const folders = [...new Set(sessions.map((session) => session.dto.project).filter(Boolean))]
  const segments = new Map(folders.map((folder) => [folder, folder.split(path.sep).filter(Boolean)]))
  const tail = (folder, depth) => segments.get(folder).slice(-depth).join('/')
  const names = new Map()
  for (const folder of folders) {
    let depth = 1
    while (depth < segments.get(folder).length && folders.some((other) => other !== folder && tail(other, depth) === tail(folder, depth))) depth++
    names.set(folder, tail(folder, depth))
  }
  return names
}

function projectRows(sessions, now, names) {
  const projects = new Map()
  for (const session of sessions) {
    const key = session.dto.project
    if (!projects.has(key)) projects.set(key, { project: key, label: session.dto.projectLabel, name: names.get(key) || session.dto.projectName, conversations: 0, agents: 0, live: 0, lastActiveAt: 0, models: new Map() })
    const entry = projects.get(key)
    entry.conversations += 1
    entry.agents += session.dto.agentCount
    if (session.dto.live) entry.live += 1
    entry.lastActiveAt = Math.max(entry.lastActiveAt, session.dto.lastActiveAt || 0)
    mergeModels(entry.models, session.models)
  }
  return [...projects.values()].map((entry) => {
    const totals = sumModels(entry.models)
    return {
      project: entry.project,
      label: entry.label,
      name: entry.name,
      conversations: entry.conversations,
      conversationsLabel: format.plural(entry.conversations, 'conversation', 'conversations'),
      agents: entry.agents,
      agentsLabel: format.plural(entry.agents, 'agent', 'agents'),
      live: entry.live,
      lastActiveAt: entry.lastActiveAt || null,
      lastActiveLabel: entry.lastActiveAt ? format.capitalize(format.ago(entry.lastActiveAt, now)) : 'Unknown',
      ...tokenFields(totals),
    }
  })
}

function conversationRow(dto) {
  return {
    id: dto.id,
    title: dto.title,
    projectLabel: dto.projectLabel,
    live: dto.live,
    status: dto.status,
    statusLabel: dto.statusLabel,
    lastActiveLabel: dto.lastActiveLabel,
    modelsLabel: dto.modelsLabel,
    agentCount: dto.agentCount,
    totalTokens: dto.totalTokens,
    totalTokensLabel: dto.totalTokensLabel,
    tokensLabel: dto.tokensLabel,
  }
}

async function buildOverview(collector, params) {
  const waiting = await scanState(collector)
  if (waiting) return waiting
  const now = Date.now()
  const range = resolveRange(params, new Date(now))
  const described = await describeAll(collector, range, now)
  const sessions = inRangeOf(described, range)
  const byModel = new Map()
  const extras = new Map()
  const days = new Map()
  let agents = 0
  for (const session of sessions) {
    mergeModels(byModel, session.models)
    if (session.extra) mergeModels(extras, session.extra.models)
    addDays(days, session, range)
    agents += session.dto.agentCount
  }
  const totals = sumModels(byModel)
  const top = [...sessions].sort((a, b) => b.dto.totalTokens - a.dto.totalTokens).slice(0, TOP_LIMIT)
  const projects = projectRows(sessions, now, uniqueNames(described)).sort((a, b) => b.totalTokens - a.totalTokens)
  return {
    status: 'ready',
    range: rangeDto(range),
    stats: {
      ...tokenFields(totals),
      conversationsLabel: format.count(sessions.length),
      agentsLabel: format.count(agents),
      callsLabel: format.count(totals.messages),
      rangeLabel: range.description,
    },
    chart: chartData(days, range, now),
    tokens: tokenRows(totals, extras.size ? sumModels(extras) : null),
    models: modelRows(byModel),
    projects: projects.slice(0, TOP_LIMIT),
    projectCount: projects.length,
    topConversations: top.map((session) => conversationRow(session.dto)),
    conversationCount: sessions.length,
    filtered: range.key !== 'all',
    sessionsOnMachine: described.filter((session) => session.everUsed || session.dto.live).length,
    firstRunMessage: firstRunMessage(collector),
  }
}

async function buildProjects(collector, params) {
  const waiting = await scanState(collector)
  if (waiting) return waiting
  const now = Date.now()
  const range = resolveRange(params, new Date(now))
  const search = (params.get('q') || '').trim().toLowerCase()
  const requested = params.get('sort') === 'cost' ? 'tokens' : params.get('sort')
  const sort = PROJECT_SORTS.has(requested) ? requested : 'tokens'
  const dir = params.get('dir') === 'asc' ? 'asc' : 'desc'
  const described = await describeAll(collector, range, now)
  const all = projectRows(inRangeOf(described, range), now, uniqueNames(described))
  const matches = search ? all.filter((row) => [row.label, row.project].some((value) => value.toLowerCase().includes(search))) : all
  const value = (row) => (sort === 'lastActive' ? row.lastActiveAt || 0 : sort === 'conversations' ? row.conversations : row.totalTokens)
  matches.sort((a, b) => {
    const order = sort === 'name' ? a.name.localeCompare(b.name) : value(a) - value(b)
    return (dir === 'asc' ? order : -order) || b.totalTokens - a.totalTokens
  })
  const total = matches.length
  const paging = pageOf(params, total)
  return {
    status: 'ready',
    range: rangeDto(range),
    page: paging.page,
    pages: paging.pages,
    pageSize: paging.pageSize,
    total,
    pageLabel: total ? `Page ${paging.page} of ${paging.pages}, ${format.plural(total, 'project', 'projects')}` : '',
    rows: matches.slice(paging.start, paging.end),
    summary: {
      line: total
        ? `${format.plural(total, 'project', 'projects')}, ${format.plural(
            matches.reduce((sum, row) => sum + row.conversations, 0),
            'conversation',
            'conversations',
          )}, ${format.tokens(matches.reduce((sum, row) => sum + row.totalTokens, 0))} tokens`
        : '',
    },
    filtered: Boolean(search) || range.key !== 'all',
    sessionsOnMachine: described.filter((session) => session.everUsed || session.dto.live).length,
    firstRunMessage: firstRunMessage(collector),
  }
}

async function buildRecents(collector, params) {
  const waiting = await scanState(collector)
  if (waiting) return waiting
  const now = Date.now()
  const search = (params.get('q') || '').trim().toLowerCase()
  const open = params.get('session') || ''
  const usable = (await describeAll(collector, null, now)).filter((session) => session.everUsed || session.dto.live)
  const matches = search ? usable.filter((session) => matchesSearch(session, search)) : usable
  const names = uniqueNames(usable)
  const byProject = new Map()
  for (const session of matches) {
    const key = session.dto.project
    if (!byProject.has(key)) byProject.set(key, { project: key, label: session.dto.projectLabel, name: names.get(key) || session.dto.projectName, sessions: [] })
    byProject.get(key).sessions.push(session)
  }
  const item = (dto) => ({ id: dto.id, title: dto.title, live: dto.live, status: dto.status, statusLabel: dto.statusLabel, tokensLabel: format.tokens(dto.totalTokens), tokensTitle: `${format.tokens(dto.totalTokens)} tokens` })
  const groups = [...byProject.values()]
    .map((group) => {
      group.sessions.sort((a, b) => (b.dto.lastActiveAt || 0) - (a.dto.lastActiveAt || 0))
      const shown = group.sessions.slice(0, PROJECT_ITEMS)
      const current = open && !shown.some((session) => session.dto.id === open) ? group.sessions.find((session) => session.dto.id === open) : null
      if (current) shown.push(current)
      const live = group.sessions.filter((session) => session.dto.live).length
      return {
        project: group.project,
        label: group.label,
        name: group.name,
        lastActiveAt: group.sessions[0].dto.lastActiveAt || 0,
        count: group.sessions.length,
        countLabel: format.count(group.sessions.length),
        live,
        liveLabel: live ? `${format.count(live)} running` : null,
        items: shown.map((session) => item(session.dto)),
        moreLabel: group.sessions.length > shown.length ? `Show all ${format.count(group.sessions.length)}` : null,
      }
    })
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  return {
    status: 'ready',
    groups,
    total: matches.length,
    searched: Boolean(search),
    sessionsOnMachine: usable.length,
    firstRunMessage: firstRunMessage(collector),
  }
}

module.exports = {
  buildLive,
  buildHistory,
  buildOverview,
  buildProjects,
  buildRecents,
  describeSession,
  agentGroups,
  modelRows,
  modelsOf,
  sumModels,
  tokenRows,
  resumeCommand,
  liveActivity,
  scanDto,
}
