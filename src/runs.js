const fs = require('fs')
const { spawn } = require('child_process')

const OUTPUT_LIMIT = 1024 * 1024
const ERROR_LIMIT = 4000
const STOP_GRACE_MS = 5000

function append(text, chunk, limit) {
  const next = text + chunk
  return next.length > limit ? next.slice(-limit) : next
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function lastLines(text, count) {
  return text.trim().split('\n').filter(Boolean).slice(-count).join(' ')
}

function createRuns() {
  const runs = new Map()

  function view(run) {
    return { status: run.status, startedAt: run.startedAt, endedAt: run.endedAt, error: run.error }
  }

  function finish(run, status, error) {
    if (run.status !== 'running') return
    run.status = status
    run.error = error || null
    run.endedAt = Date.now()
    run.child = null
  }

  return {
    get(id) {
      const run = runs.get(id)
      return run ? view(run) : null
    },
    active(id) {
      const run = runs.get(id)
      return Boolean(run && run.status === 'running')
    },
    start(id, cwd, message) {
      const run = { status: 'running', startedAt: Date.now(), endedAt: null, error: null, out: '', err: '', stopped: false, child: null }
      runs.set(id, run)
      if (!fs.existsSync(cwd)) {
        finish(run, 'failed', `The folder ${cwd} no longer exists, so this conversation cannot be resumed.`)
        return view(run)
      }
      let child
      try {
        child = spawn('claude', ['--resume', id, '--print', '--output-format', 'json', '--', message], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        finish(run, 'failed', `Could not start Claude Code: ${error.message}`)
        return view(run)
      }
      run.child = child
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        run.out = append(run.out, chunk, OUTPUT_LIMIT)
      })
      child.stderr.on('data', (chunk) => {
        run.err = append(run.err, chunk, ERROR_LIMIT)
      })
      child.on('error', (error) => {
        finish(run, 'failed', error.code === 'ENOENT' ? `Could not start Claude Code: the claude command was not found on this computer.${process.platform === 'win32' ? ' On Windows, replying from the page needs Claude Code from its native installer, not from npm.' : ''}` : `Could not start Claude Code: ${error.message}`)
      })
      child.on('close', (code) => {
        if (run.stopped) return finish(run, 'stopped', null)
        const result = parseJson(run.out.trim())
        if (code === 0 && !(result && result.is_error)) return finish(run, 'done', null)
        const reason = (result && typeof result.result === 'string' && result.result.trim()) || lastLines(run.err, 3) || `Claude Code stopped with exit code ${code}.`
        finish(run, 'failed', reason.slice(0, ERROR_LIMIT))
      })
      return view(run)
    },
    stop(id) {
      const run = runs.get(id)
      if (!run || run.status !== 'running' || !run.child) return false
      run.stopped = true
      const child = run.child
      child.kill('SIGINT')
      setTimeout(() => {
        if (run.status === 'running') child.kill('SIGKILL')
      }, STOP_GRACE_MS).unref()
      return true
    },
  }
}

module.exports = { createRuns }
