const fs = require('fs')
const os = require('os')
const path = require('path')
const { promisify } = require('util')
const { execFile, spawn } = require('child_process')
const { createCollector } = require('./collector')
const { createTerminal } = require('./terminal')
const { health, openBrowser, scanSummary, HOST } = require('./server')
const { homePath } = require('./format')
const tasksCli = require('./tasks-cli')
const { version: VERSION } = require('../package.json')

const SOURCE = 'github:DevKazonovic/claude-dashboard'
const NPM_PERMISSIONS = 'https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally'
const BIN = path.join(__dirname, '..', 'bin', 'claude-dashboard.js')
const STATE_DIR = path.join(os.tmpdir(), `claude-dashboard-${typeof process.getuid === 'function' ? process.getuid() : os.userInfo().username}`)
const STATE_FILE = path.join(STATE_DIR, 'state.json')
const LOG_DIR = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Logs', 'claude-dashboard') : STATE_DIR
const LOG_FILE = path.join(LOG_DIR, 'dashboard.log')
const LABEL = 'io.github.devkazonovic.claude-dashboard'
const AGENT_FILE = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const DOMAIN = `gui/${process.getuid?.()}`
const SERVICE = `${DOMAIN}/${LABEL}`
const STABLE_NODES = ['/opt/homebrew/bin/node', '/usr/local/bin/node']
const VERSION_MANAGERS = ['/.nvm/', '/.fnm/', '/.volta/', '/.asdf/', '/.nodenv/', '/n/versions/', '/mise/']
const SYSTEM_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
const START_TIMEOUT_MS = 20000
const STOP_TIMEOUT_MS = 5000
const POLL_MS = 250
const execFileAsync = promisify(execFile)

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

async function waitForRunning(port) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < START_TIMEOUT_MS) {
    const running = await findRunning(port)
    if (running) return running
    await sleep(POLL_MS)
  }
  return null
}

function startupFailed(ui) {
  ui.log('The dashboard did not start in the background.', 'error')
  const tail = lastLog(8)
  if (tail) ui.note(tail)
  ui.note(`Full log: ${LOG_FILE}`)
  process.exitCode = 1
}

function serverArgs(options) {
  return [BIN, '--no-open', '--state-file', STATE_FILE, '--port', String(options.port), ...options.configDirs.flatMap((dir) => ['--config-dir', path.resolve(dir)]), ...(options.dataDir ? ['--data-dir', path.resolve(options.dataDir)] : [])]
}

async function stopProcess(running) {
  try {
    process.kill(running.pid, 'SIGTERM')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  const startedAt = Date.now()
  while (alive(running.pid) && Date.now() - startedAt < STOP_TIMEOUT_MS) await sleep(100)
  if (alive(running.pid)) process.kill(running.pid, 'SIGKILL')
  fs.rmSync(STATE_FILE, { force: true })
}

async function start(options) {
  const ui = createTerminal({ version: VERSION })
  const running = await findRunning(options.port)
  if (running) {
    ui.already(running.url)
    if (options.open) openBrowser(running.url, ui)
    return
  }
  fs.mkdirSync(LOG_DIR, { recursive: true })
  fs.rmSync(STATE_FILE, { force: true })
  const log = fs.openSync(LOG_FILE, 'w')
  const child = spawn(process.execPath, serverArgs(options), { detached: true, stdio: ['ignore', log, log], windowsHide: true })
  fs.closeSync(log)
  child.unref()
  const state = await waitForState(child)
  if (!state) return startupFailed(ui)
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
  await stopProcess(running)
  ui.done(`Stopped the dashboard at ${running.url.replace(/\/$/, '')}`)
  if (fs.existsSync(AGENT_FILE)) ui.note('It starts again the next time you log in.')
}

async function status(options) {
  const ui = createTerminal({ version: VERSION })
  const running = await findRunning(options.port)
  if (running) {
    const scan = running.info.scan
    ui.done(`Running at ${running.url.replace(/\/$/, '')}${running.background ? ' in the background' : ''}`)
    ui.note(scan.status === 'done' ? 'All transcripts read' : scan.status === 'failed' ? scan.label : `Reading transcripts, ${scan.percent}% done`)
    if (running.background) ui.note(`Log: ${LOG_FILE}`)
  } else ui.note(`The dashboard is not running. Start it in the background with ${commandName()} start`)
  if (process.platform === 'darwin') ui.note(fs.existsSync(AGENT_FILE) ? 'Starts by itself when you log in.' : `Does not start at login. Turn that on with ${commandName()} enable`)
}

function launchctl(args) {
  return execFileAsync('launchctl', args, { timeout: 10000 })
}

async function agentLoaded() {
  try {
    await launchctl(['print', SERVICE])
    return true
  } catch {
    return false
  }
}

async function nodeVersion(file) {
  try {
    const { stdout } = await execFileAsync(file, ['--version'], { timeout: 5000 })
    return Number((/^v(\d+)/.exec(stdout.trim()) || [])[1]) || 0
  } catch {
    return 0
  }
}

async function nodeForAgent() {
  const current = process.execPath
  if (!VERSION_MANAGERS.some((part) => current.includes(part))) return current
  for (const candidate of STABLE_NODES) {
    if (fs.existsSync(candidate) && (await nodeVersion(candidate)) >= 18) return candidate
  }
  return current
}

function xml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function agentPlist(node, options) {
  const args = [node, ...serverArgs(options)]
  const envPath = [...(process.env.PATH || '').split(path.delimiter), path.dirname(node), ...SYSTEM_PATH]
    .filter((dir, index, all) => dir && all.indexOf(dir) === index)
    .join(path.delimiter)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(envPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(LOG_FILE)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(LOG_FILE)}</string>
</dict>
</plist>
`
}

async function bootstrap() {
  let lastError = null
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await launchctl(['bootstrap', DOMAIN, AGENT_FILE])
      return
    } catch (error) {
      lastError = error
      await sleep(500)
    }
  }
  throw new Error(`macOS refused to load the login item: ${String(lastError.stderr || lastError.message).trim()}`)
}

function onMac(ui) {
  if (process.platform === 'darwin') return true
  ui.log('Starting at login works on macOS only.', 'error')
  process.exitCode = 1
  return false
}

async function enable(options) {
  const ui = createTerminal({ version: VERSION })
  if (!onMac(ui)) return
  if (installKind() === 'npx') {
    ui.log(`Starting at login needs an installed copy. Install it with npm install -g ${SOURCE}, then run claude-dashboard enable`, 'error')
    process.exitCode = 1
    return
  }
  if (await agentLoaded()) await launchctl(['bootout', SERVICE]).catch(() => null)
  const running = await findRunning(options.port)
  if (running) await stopProcess(running)
  const node = await nodeForAgent()
  for (const dir of [path.dirname(AGENT_FILE), LOG_DIR]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(AGENT_FILE, agentPlist(node, options))
  await bootstrap()
  const started = await waitForRunning(options.port)
  if (!started) return startupFailed(ui)
  ui.done(`Running at ${started.url.replace(/\/$/, '')}, and it starts by itself every time you log in`)
  ui.note(`It runs with the Node.js at ${node}. If you remove that Node.js, run ${commandName()} enable again.`)
  if (options.open) openBrowser(started.url, ui)
}

async function disable(options) {
  const ui = createTerminal({ version: VERSION })
  if (!onMac(ui)) return
  const loaded = await agentLoaded()
  if (loaded) await launchctl(['bootout', SERVICE]).catch(() => null)
  const existed = fs.existsSync(AGENT_FILE)
  fs.rmSync(AGENT_FILE, { force: true })
  if (!loaded && !existed) return ui.note('The dashboard was not set to start at login.')
  const running = await findRunning(options.port)
  if (running) await stopProcess(running)
  ui.done('The dashboard no longer starts at login, and it is stopped now')
  ui.note(`Run it any time with ${commandName()} start`)
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

function tasks(options) {
  return tasksCli.run(options.args || [], findRunning)
}

module.exports = { start, stop, status, enable, disable, update, tasks }
