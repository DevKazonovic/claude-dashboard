#!/usr/bin/env node
const { start } = require('../src/server')
const background = require('../src/background')
const { version } = require('../package.json')

const COMMANDS = ['start', 'stop', 'status']

const HELP = `Usage: claude-dashboard [command] [options]

Opens a local web page with every Claude Code session on this computer,
the agents inside each one, and their token usage.

Commands:
  (none)                 Run in this terminal. Closing it stops the dashboard.
  start                  Run in the background, so you can close the terminal.
  stop                   Stop the dashboard.
  status                 Show whether the dashboard is running, and where.

Options:
  -p, --port <number>    Port to listen on (default 3737)
  --config-dir <path>    Also read this Claude config folder. Repeat it for
                         several folders. ~/.claude and ~/.claude-* are
                         found automatically.
  --no-open              Do not open the browser
  -v, --version          Show the version
  -h, --help             Show this help`

function parseArgs(argv) {
  const options = { command: null, port: 3737, open: true, configDirs: [], stateFile: null, help: false, version: false, error: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') options.help = true
    else if (arg === '-v' || arg === '--version') options.version = true
    else if (arg === '--no-open') options.open = false
    else if (arg === '-p' || arg === '--port') options.port = Number(argv[++i])
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length))
    else if (arg === '--config-dir') {
      const value = argv[++i]
      if (!value || value.startsWith('-')) options.error = 'The --config-dir option needs a folder path.'
      else options.configDirs.push(value)
    }
    else if (arg.startsWith('--config-dir=')) options.configDirs.push(arg.slice('--config-dir='.length))
    else if (arg === '--state-file' && argv[i + 1]) options.stateFile = argv[++i]
    else if (!arg.startsWith('-') && !options.command && COMMANDS.includes(arg)) options.command = arg
    else options.error = arg.startsWith('-') ? `Unknown option: ${arg}` : `Unknown command: ${arg}`
  }
  if (!options.error && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) {
    options.error = 'The port must be a whole number between 1 and 65535.'
  }
  return options
}

const options = parseArgs(process.argv.slice(2))

if (options.help) {
  console.log(HELP)
  process.exit(0)
}

if (options.version) {
  console.log(version)
  process.exit(0)
}

if (options.error) {
  console.error(`${options.error}\n\n${HELP}`)
  process.exit(1)
}

const run = options.command ? background[options.command] : start

run(options).catch((error) => {
  console.error(error.message)
  process.exit(1)
})
