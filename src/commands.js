const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { createCollector } = require('./collector')
const { createTerminal } = require('./terminal')
const { health, openBrowser, scanSummary, HOST } = require('./server')
const { homePath } = require('./format')
const { version: VERSION } = require('../package.json')

const SOURCE = 'github:DevKazonovic/claude-dashboard'
const NPM_PERMISSIONS = 'https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally'
const BIN = path.join(__dirname, '..', 'bin', 'claude-dashboard.js')
const STATE_DIR = path.join(os.tmpdir(), `claude-dashboard-${typeof process.getuid === 'function' ? process.getuid() : os.userInfo().username}`)
const STATE_FILE = path.join(STATE_DIR, 'state.json')
const LOG_FILE = path.join(STATE_DIR, 'dashboard.log')
const START_TIMEOUT_MS = 20000
const STOP_TIMEOUT_MS = 5000
const POLL_MS = 250

function readState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    return state && Number.isInteger(state.pid) && Number.isInteger(state.port) ? state : null
  } catch {
    return null
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function installKind() {
  if (__dirname.includes(`${path.sep}_npx${path.sep}`)) return 'npx'
  if (__dirname.includes(`${path.sep}node_modules${path.sep}`)) return 'global'
  return 'clone'
}

function commandName() {
  const kind = installKind()
  if (kind === 'npx') return `npx -y ${SOURCE}`
  if (kind === 'global') return 'claude-dashboard'
  return `node ${path.relative(process.cwd(), BIN) || BIN}`
}

function npm(args) {
  return new Promise((resolve) => {
    const child = spawn('npm', args, { shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    child.on('error', (error) => resolve({ ok: false, output: error.message }))
    child.on('close', (code) => resolve({ ok: code === 0, output }))
  })
}

function installedVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version
  } catch {
    return null
  }
}

async function findRunning(port) {
  const state = readState()
  for (const candidate of new Set([state && state.port, port].filter(Boolean))) {
    const info = await health(candidate)
    if (info) return { pid: info.pid, port: candidate, url: `http://${HOST}:${candidate}/`, background: Boolean(state && state.port === candidate && state.pid === info.pid), info }
  }
  if (state) fs.rmSync(STATE_FILE, { force: true })
  return null
}

function lastLog(lines) {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

async function waitForState(child) {
  let exited = false
  child.once('exit', () => {
    exited = true
  })
  const startedAt = Date.now()
  while (Date.now() - startedAt < START_TIMEOUT_MS) {
    const state = readState()
    if (state && state.pid === child.pid) return state
    if (exited) return null
    await sleep(100)
  }
  return null
}

async function start(options) {
  const ui = createTerminal({ version: VERSION })
  const running = await findRunning(options.port)
  if (running) {
    ui.already(running.url)
    if (options.open) openBrowser(running.url, ui)
    return
  }
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.rmSync(STATE_FILE, { force: true })
  const log = fs.openSync(LOG_FILE, 'w')
  const args = [BIN, '--no-open', '--state-file', STATE_FILE, '--port', String(options.port), ...options.configDirs.flatMap((dir) => ['--config-dir', path.resolve(dir)])]
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', log, log], windowsHide: true })
  fs.closeSync(log)
  child.unref()
  const state = await waitForState(child)
  if (!state) {
    ui.log('The dashboard did not start in the background.', 'error')
    const tail = lastLog(8)
    if (tail) ui.note(tail)
    ui.note(`Full log: ${LOG_FILE}`)
    process.exitCode = 1
    return
  }
  const collector = createCollector({ extraConfigDirs: options.configDirs })
  await collector.init()
  ui.header({ url: state.url, folders: collector.configDirs().map(homePath), stopHint: `Runs in the background. Stop it with ${commandName()} stop` })
  if (state.port !== options.port) ui.log(`Port ${options.port} is in use, so the dashboard runs on port ${state.port}`, 'warning')
  if (options.open) openBrowser(state.url, ui)
  let latest = { status: 'running', doneBytes: 0, totalBytes: 0 }
  let counts = null
  const poll = setInterval(async () => {
    const info = await health(state.port)
    if (!info) return
    latest = info.scan
    counts = info.counts
  }, POLL_MS)
  process.once('SIGINT', () => {
    ui.clear()
    ui.note('The dashboard keeps running in the background.')
    process.exit(0)
  })
  ui.watchScan(
    () => latest,
    async (scan, elapsed) => {
      clearInterval(poll)
      if (scan.status === 'failed') ui.log(`Reading the transcripts failed: ${scan.error}`, 'error')
      else {
        const info = counts ? null : await health(state.port)
        ui.done(scanSummary(scan, counts || (info && info.counts) || { conversations: 0, agents: 0 }, elapsed))
      }
      ui.note('You can close this terminal. The dashboard keeps running in the background.')
    },
  )
}

async function stop(options) {
  const ui = createTerminal({ version: VERSION })
  const running = await findRunning(options.port)
  if (!running) return ui.note('The dashboard is not running.')
  try {
    process.kill(running.pid, 'SIGTERM')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  const startedAt = Date.now()
  while (alive(running.pid) && Date.now() - startedAt < STOP_TIMEOUT_MS) await sleep(100)
  if (alive(running.pid)) process.kill(running.pid, 'SIGKILL')
  fs.rmSync(STATE_FILE, { force: true })
  ui.done(`Stopped the dashboard at ${running.url.replace(/\/$/, '')}`)
}

async function status(options) {
  const ui = createTerminal({ version: VERSION })
  const running = await findRunning(options.port)
  if (!running) return ui.note(`The dashboard is not running. Start it in the background with ${commandName()} start`)
  const scan = running.info.scan
  ui.done(`Running at ${running.url.replace(/\/$/, '')}${running.background ? ' in the background' : ''}`)
  ui.note(scan.status === 'done' ? 'All transcripts read' : scan.status === 'failed' ? scan.label : `Reading transcripts, ${scan.percent}% done`)
  if (running.background) ui.note(`Log: ${LOG_FILE}`)
}

async function update(options) {
  const ui = createTerminal({ version: VERSION })
  const kind = installKind()
  if (kind === 'npx') return ui.note('npx already runs the newest version each time, so there is nothing to update.')
  if (kind === 'clone') return ui.note('This copy runs from a cloned folder. Update it with git pull in that folder.')
  ui.spin('Installing the newest version from GitHub')
  const result = await npm(['install', '-g', SOURCE])
  ui.clear()
  if (!result.ok) {
    ui.log('The update failed.', 'error')
    const tail = result.output.trim().split('\n').slice(-6).join('\n')
    if (tail) ui.note(tail)
    if (result.output.includes('EACCES')) ui.note(`npm cannot write to its global folder. Do not use sudo; follow ${NPM_PERMISSIONS}`)
    process.exitCode = 1
    return
  }
  ui.done(`Installed the newest version from GitHub (claude-dashboard ${installedVersion() || VERSION})`)
  const running = await findRunning(options.port)
  if (running && running.background) ui.note('The dashboard in the background still runs the old version. Restart it with claude-dashboard stop, then claude-dashboard start.')
}

module.exports = { start, stop, status, update }
