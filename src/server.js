const fs = require('fs')
const http = require('http')
const path = require('path')
const { spawn } = require('child_process')
const { createCollector } = require('./collector')
const { createTimelines } = require('./timeline')
const { createRuns } = require('./runs')
const { createAccounts } = require('./accounts')
const { buildLive, buildHistory, buildOverview, buildProjects, buildRecents, scanDto } = require('./views')
const { buildConversation, buildAgent, buildChat, buildTurn, sendMessage, stopMessage, openConversation, RequestError } = require('./conversation')
const format = require('./format')
const { createTerminal } = require('./terminal')
const { version: VERSION } = require('../package.json')

const { homePath } = format
const APP_ID = 'claude-dashboard'
const HOST = '127.0.0.1'
const PORT_ATTEMPTS = 20
const PUBLIC_DIR = path.join(__dirname, '..', 'public')
const SCRIPT = 'text/javascript; charset=utf-8'
const PAGE = ['index.html', 'text/html; charset=utf-8']
const APP_PATHS = [
  /^\/overview\/?$/,
  /^\/running\/?$/,
  /^\/conversations\/?$/,
  /^\/projects\/?$/,
  /^\/settings\/?$/,
  /^\/chat\/[A-Za-z0-9_-]{6,100}\/?$/,
]
const AGENT_PATH = /^\/chat\/([A-Za-z0-9_-]{6,100})\/agents\/([A-Za-z0-9_-]{1,100})\/?$/
const LEGACY_VIEWS = { overview: '/overview', live: '/running', conversations: '/conversations', projects: '/projects' }
const LEGACY_LIST_PARAMS = ['range', 'from', 'to', 'q', 'sort', 'dir', 'page', 'project']
const LIST_PATHS = ['/conversations', '/projects']
const SESSION_ID = /^[A-Za-z0-9_-]{6,100}$/
const AGENT_ID = /^[A-Za-z0-9_-]{1,100}$/
const STATIC_FILES = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/theme.js': ['theme.js', SCRIPT],
  '/app.js': ['app.js', SCRIPT],
  '/ui.js': ['ui.js', SCRIPT],
  '/markdown.js': ['markdown.js', SCRIPT],
  '/sidebar.js': ['sidebar.js', SCRIPT],
  '/pages.js': ['pages.js', SCRIPT],
  '/conversation.js': ['conversation.js', SCRIPT],
  '/usage.js': ['usage.js', SCRIPT],
}
const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
}
const POST_ROUTES = new Set(['/api/send', '/api/stop', '/api/open'])
const BODY_LIMIT = 256 * 1024

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new RequestError(413, 'The message is too large to send.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseBody(text) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function withQuery(pathname, params) {
  const text = params.toString()
  return text ? `${pathname}?${text}` : pathname
}

function legacyTarget(params) {
  const session = params.get('session')
  const agent = params.get('agent')
  if (session && SESSION_ID.test(session)) {
    const detail = params.get('detail')
    const query = new URLSearchParams()
    if (agent && AGENT_ID.test(agent)) query.set('agent', agent)
    if (detail) query.set('detail', detail)
    return { status: 301, location: withQuery(`/chat/${session}`, query) }
  }
  const view = params.get('view')
  const rest = new URLSearchParams(params)
  for (const key of ['view', 'session', 'agent', 'detail']) rest.delete(key)
  if (rest.get('sort') === 'cost') rest.set('sort', 'tokens')
  if (LEGACY_VIEWS[view]) return { status: 301, location: withQuery(LEGACY_VIEWS[view], view === 'live' ? new URLSearchParams() : rest) }
  if (LEGACY_LIST_PARAMS.some((key) => params.has(key))) return { status: 301, location: withQuery('/conversations', rest) }
  return { status: 302, location: '/overview' }
}

function redirect(res, target) {
  res.writeHead(target.status, { ...HEADERS, Location: target.location })
  res.end()
}

function sameOrigin(req) {
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin') return false
  return req.headers.origin === `http://${req.headers.host}`
}

function send(res, status, body, type) {
  res.writeHead(status, { ...HEADERS, 'Content-Type': type })
  res.end(body)
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8')
}

function createHandler(collector, timelines, runs, accounts, port, report) {
  const allowedHosts = new Set([`${HOST}:${port}`, `localhost:${port}`, `[::1]:${port}`])
  return async (req, res) => {
    if (!allowedHosts.has(req.headers.host)) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8')
    const url = new URL(req.url, `http://${req.headers.host}`)
    const params = url.searchParams
    const posting = req.method === 'POST' && POST_ROUTES.has(url.pathname)
    if (req.method !== 'GET' && !posting) return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8')
    try {
      if (posting) {
        if (!sameOrigin(req)) return sendJson(res, 403, { error: 'This request did not come from the dashboard page.' })
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) return sendJson(res, 415, { error: 'Send the request as JSON.' })
        const body = parseBody(await readBody(req))
        if (!body) return sendJson(res, 400, { error: 'The request body is not valid JSON.' })
        if (url.pathname === '/api/send') return sendJson(res, 200, await sendMessage(collector, runs, body))
        if (url.pathname === '/api/open') return sendJson(res, 200, await openConversation(collector, runs, body))
        return sendJson(res, 200, stopMessage(runs, body))
      }
      if (url.pathname === '/api/health') {
        const scan = collector.scanStatus()
        return sendJson(res, 200, { app: APP_ID, pid: process.pid, scan: scanDto(scan), counts: scan.status === 'done' ? await collector.counts() : null })
      }
      if (url.pathname === '/api/live') return sendJson(res, 200, await buildLive(collector, accounts))
      if (url.pathname === '/api/sessions') return sendJson(res, 200, await buildHistory(collector, params))
      if (url.pathname === '/api/overview') return sendJson(res, 200, await buildOverview(collector, params))
      if (url.pathname === '/api/projects') return sendJson(res, 200, await buildProjects(collector, params))
      if (url.pathname === '/api/recents') return sendJson(res, 200, await buildRecents(collector, params))
      if (url.pathname === '/api/accounts') return sendJson(res, 200, await accounts.list())
      if (url.pathname === '/api/settings') return sendJson(res, 200, { folders: await accounts.folders(), scan: scanDto(collector.scanStatus()) })
      if (url.pathname === '/api/session') {
        const session = await buildConversation(collector, timelines, runs, accounts, params)
        if (!session) return sendJson(res, 404, { error: 'This conversation was not found on this computer.' })
        return sendJson(res, 200, session)
      }
      if (url.pathname === '/api/agent') {
        const agent = await buildAgent(collector, timelines, accounts, params)
        if (!agent) return sendJson(res, 404, { error: 'This agent was not found in this conversation.' })
        return sendJson(res, 200, agent)
      }
      if (url.pathname === '/api/chat') {
        const chat = await buildChat(collector, timelines, params)
        if (!chat) return sendJson(res, 404, { error: 'This conversation was not found on this computer.' })
        return sendJson(res, 200, chat)
      }
      if (url.pathname === '/api/turn') {
        const turn = await buildTurn(collector, timelines, params)
        if (!turn) return sendJson(res, 404, { error: 'This part of the conversation was not found.' })
        return sendJson(res, 200, turn)
      }
      if (url.pathname === '/') return redirect(res, legacyTarget(params))
      const agentPath = AGENT_PATH.exec(url.pathname)
      if (agentPath) {
        const query = new URLSearchParams([['agent', agentPath[2]], ...[...params].filter(([key]) => key !== 'agent')])
        return redirect(res, { status: 301, location: withQuery(`/chat/${agentPath[1]}`, query) })
      }
      if (LIST_PATHS.includes(url.pathname) && params.get('sort') === 'cost') {
        params.set('sort', 'tokens')
        return redirect(res, { status: 301, location: withQuery(url.pathname, params) })
      }
      const file = APP_PATHS.some((pattern) => pattern.test(url.pathname)) ? PAGE : STATIC_FILES[url.pathname]
      if (file) return send(res, 200, await fs.promises.readFile(path.join(PUBLIC_DIR, file[0])), file[1])
      return send(res, 404, 'Not found', 'text/plain; charset=utf-8')
    } catch (error) {
      if (error instanceof RequestError) return sendJson(res, error.status, { error: error.message })
      report(`${req.method} ${url.pathname} failed: ${error.message || error}`)
      return sendJson(res, 500, { error: error.message || 'Something went wrong on the dashboard server.' })
    }
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, HOST)
  })
}

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/api/health', headers: { host: `${HOST}:${port}` }, timeout: 1500 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => {
        try {
          const info = JSON.parse(body)
          resolve(info && info.app === APP_ID ? info : null)
        } catch {
          resolve(null)
        }
      })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.on('error', () => resolve(null))
  })
}

function scanSummary(scan, counts, elapsed) {
  return `Read ${format.plural(counts.conversations, 'conversation', 'conversations')} and ${format.plural(counts.agents, 'agent', 'agents')} (${format.bytes(scan.totalBytes)}) in ${format.duration(elapsed)}`
}

function saveState(file, port, url) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, port, url, startedAt: Date.now() }))
  process.on('exit', () => {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (saved.pid === process.pid) fs.rmSync(file, { force: true })
    } catch {}
  })
}

function openBrowser(url, ui) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('spawn', () => ui.log('Opened the dashboard in your browser'))
  child.on('error', () => ui.log(`Could not open a browser. Open ${url} yourself.`, 'warning'))
  child.unref()
}

async function start(options) {
  const ui = createTerminal({ version: VERSION })
  const collector = createCollector({ extraConfigDirs: options.configDirs })
  const timelines = createTimelines()
  const runs = createRuns((text, tone) => ui.log(text, tone))
  const accounts = createAccounts(collector)
  await collector.init()
  for (let port = options.port; port < options.port + PORT_ATTEMPTS; port++) {
    const url = `http://${HOST}:${port}/`
    if (await health(port)) {
      ui.already(url)
      if (options.open) openBrowser(url, ui)
      return
    }
    const server = http.createServer(createHandler(collector, timelines, runs, accounts, port, (text) => ui.log(text, 'error')))
    try {
      await listen(server, port)
    } catch (error) {
      if (error.code === 'EADDRINUSE') continue
      throw error
    }
    if (options.stateFile) saveState(options.stateFile, port, url)
    ui.header({ url, folders: collector.configDirs().map(homePath) })
    if (port !== options.port) ui.log(`Port ${options.port} is in use, so the dashboard runs on port ${port}`, 'warning')
    collector.startFullScan()
    ui.watchScan(
      () => collector.scanStatus(),
      async (scan, elapsed) => {
        if (scan.status === 'failed') return ui.log(`Reading the transcripts failed: ${scan.error}`, 'error')
        ui.done(scanSummary(scan, await collector.counts(), elapsed))
      },
    )
    if (options.open) openBrowser(url, ui)
    const quit = () => {
      ui.stop()
      process.exit(0)
    }
    ui.keys({ open: () => openBrowser(url, ui), quit })
    process.once('SIGINT', quit)
    process.once('SIGTERM', quit)
    return
  }
  throw new Error(`Ports ${options.port} to ${options.port + PORT_ATTEMPTS - 1} are all in use. Pick another one with --port.`)
}

module.exports = { start, health, openBrowser, scanSummary, HOST }
