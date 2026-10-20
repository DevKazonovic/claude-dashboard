#!/usr/bin/env node
const { start } = require('../src/server')

const HELP = `Usage: claude-dashboard [options]

Opens a local web page with every Claude Code session on this computer,
the agents inside each one, and their token usage.

Options:
  -p, --port <number>    Port to listen on (default 3737)
  --config-dir <path>    Also read this Claude config folder. Repeat it for
                         several folders. ~/.claude and ~/.claude-* are
                         found automatically.
  --no-open              Do not open the browser
  -h, --help             Show this help`

function parseArgs(argv) {
  const options = { port: 3737, open: true, configDirs: [], help: false, error: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') options.help = true
    else if (arg === '--no-open') options.open = false
    else if (arg === '-p' || arg === '--port') options.port = Number(argv[++i])
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length))
    else if (arg === '--config-dir') {
      const value = argv[++i]
      if (!value || value.startsWith('-')) options.error = 'The --config-dir option needs a folder path.'
      else options.configDirs.push(value)
    }
    else if (arg.startsWith('--config-dir=')) options.configDirs.push(arg.slice('--config-dir='.length))
    else options.error = `Unknown option: ${arg}`
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

if (options.error) {
  console.error(`${options.error}\n\n${HELP}`)
  process.exit(1)
}

start(options).catch((error) => {
  console.error(error.message)
  process.exit(1)
})
