const { spawn } = require('child_process')

const LINUX_TERMINALS = [
  ['x-terminal-emulator', (command) => ['-e', 'bash', '-lc', command]],
  ['gnome-terminal', (command) => ['--', 'bash', '-lc', command]],
  ['konsole', (command) => ['-e', 'bash', '-lc', command]],
  ['xfce4-terminal', (command) => ['-x', 'bash', '-lc', command]],
  ['xterm', (command) => ['-e', 'bash', '-lc', command]],
]

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { stdio: 'ignore', windowsHide: !options.window, detached: Boolean(options.detached), shell: Boolean(options.shell) })
    } catch (error) {
      reject(error)
      return
    }
    child.once('error', reject)
    if (options.detached) {
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
      return
    }
    child.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} stopped with exit code ${code}.`))))
  })
}

function appleString(text) {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

async function openTerminal(command) {
  if (process.platform === 'darwin') {
    await run('osascript', ['-e', 'tell application "Terminal"', '-e', 'activate', '-e', `do script ${appleString(command)}`, '-e', 'end tell'])
    return 'Terminal'
  }
  if (process.platform === 'win32') {
    await run('powershell.exe', ['-NoExit', '-Command', command], { detached: true, window: true })
    return 'PowerShell'
  }
  for (const [name, argsFor] of LINUX_TERMINALS) {
    try {
      await run(name, argsFor(`${command}; exec bash`), { detached: true, window: true })
      return name
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  throw new Error('No terminal app was found. Copy the resume command from the Details panel instead.')
}

function openUrl(url) {
  if (process.platform === 'darwin') return run('open', [url])
  if (process.platform === 'win32') return run('cmd', ['/c', 'start', '', url])
  return run('xdg-open', [url], { detached: true })
}

async function openVscode(folder, sessionId) {
  try {
    await run('code', [process.platform === 'win32' ? `"${folder}"` : folder], { shell: process.platform === 'win32' })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await openUrl(`vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`)
}

module.exports = { openTerminal, openVscode }
