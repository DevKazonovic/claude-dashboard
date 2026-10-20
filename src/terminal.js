const format = require('./format')

const ESC = '\x1b['
const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
const FRAME_MS = 120
const POLL_MS = 100
const BAR_CELLS = 24
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

function visible(text) {
  return text.replace(ANSI, '').length
}

function clock(date) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':')
}

function createTerminal({ stream = process.stdout, input = process.stdin, version } = {}) {
  const tty = Boolean(stream.isTTY)
  const paint = (code) => (text) => (tty ? `${ESC}${code}m${text}${ESC}0m` : String(text))
  const accent = paint('38;5;173')
  const dim = paint('2')
  const bold = paint('1')
  const green = paint('32')
  const red = paint('31')
  const yellow = paint('33')
  let live = null
  let timer = null
  let frame = 0
  let cursorHidden = false
  let keysOff = null

  const columns = () => stream.columns || 80

  function clearLive() {
    if (tty && live) stream.write(`\r${ESC}2K`)
  }

  function drawLive() {
    if (tty && live) stream.write(live(FRAMES[frame], columns()))
  }

  function print(text = '') {
    clearLive()
    stream.write(`${text}\n`)
    drawLive()
  }

  function showCursor() {
    if (!cursorHidden) return
    stream.write(`${ESC}?25h`)
    cursorHidden = false
  }

  function startLive(render) {
    live = render
    if (!tty) return
    stream.write(`${ESC}?25l`)
    cursorHidden = true
    drawLive()
    timer = setInterval(() => {
      frame = (frame + 1) % FRAMES.length
      clearLive()
      drawLive()
    }, FRAME_MS)
  }

  function stopLive() {
    clearInterval(timer)
    timer = null
    clearLive()
    live = null
    showCursor()
  }

  function box(rows) {
    const inner = Math.max(...rows.map(visible)) + 2
    if (inner + 2 > columns()) {
      for (const row of rows) if (row) print(row.trim())
      return
    }
    print(accent(`╭${'─'.repeat(inner)}╮`))
    for (const row of rows) print(`${accent('│')} ${row}${' '.repeat(inner - 1 - visible(row))}${accent('│')}`)
    print(accent(`╰${'─'.repeat(inner)}╯`))
  }

  process.on('exit', showCursor)

  return {
    header({ url, folders }) {
      const address = url.replace(/\/$/, '')
      const reading = folders.length ? `Reading ${folders.join(', ')}` : 'No Claude Code folder found yet. Start it with --config-dir <path> to add one.'
      if (!tty) {
        print(`claude-dashboard ${version}`)
        print(`Claude dashboard is running at ${url}`)
        print(reading)
        print('Press Ctrl+C to stop.')
        return
      }
      print()
      box([
        `${accent('✻')} ${bold('claude-dashboard')} ${dim(`v${version}`)}`,
        '',
        `  ${bold(address)}`,
        `  ${folders.length ? dim(reading) : yellow(reading)}`,
        '',
        `  ${dim('Press')} o ${dim('to open it in your browser,')} q ${dim('to quit')}`,
      ])
      print()
    },
    already(url) {
      if (!tty) return print(`Claude dashboard is already running at ${url}`)
      print(`${accent('✻')} The dashboard is already running at ${bold(url.replace(/\/$/, ''))}`)
    },
    watchScan(getScan, onDone) {
      const startedAt = Date.now()
      const render = (spin, width) => {
        const scan = getScan()
        const percent = scan.totalBytes ? Math.min(99, Math.floor((scan.doneBytes / scan.totalBytes) * 100)) : 0
        const filled = Math.round((percent / 100) * BAR_CELLS)
        const bar = accent('█'.repeat(filled)) + dim('░'.repeat(BAR_CELLS - filled))
        const facts = dim(`${format.bytes(scan.doneBytes)} of ${format.bytes(scan.totalBytes)} · ${format.duration(Date.now() - startedAt)}`)
        const full = `${accent(spin)} Reading transcripts ${bar} ${String(percent).padStart(2)}% ${facts}`
        return visible(full) < width ? full : `${accent(spin)} Reading transcripts ${percent}%`
      }
      if (tty) startLive(render)
      else print('Reading transcripts.')
      const poll = setInterval(() => {
        const scan = getScan()
        if (scan.status !== 'done' && scan.status !== 'failed') return
        clearInterval(poll)
        stopLive()
        onDone(scan, Date.now() - startedAt)
      }, POLL_MS)
    },
    done(text) {
      print(tty ? `${green('✓')} ${text}` : text)
    },
    log(text, tone) {
      const mark = tone === 'error' ? `${red('✗')} ` : tone === 'success' ? `${green('✓')} ` : tone === 'warning' ? `${yellow('!')} ` : ''
      print(`${dim(clock(new Date()))}  ${mark}${text}`)
    },
    keys({ open, quit }) {
      if (!tty || !input.isTTY) return
      input.setRawMode(true)
      input.setEncoding('utf8')
      input.resume()
      const onData = (key) => {
        if (key === 'o' || key === 'O') open()
        else if (key === 'q' || key === 'Q' || key === '\u0003' || key === '\u0004') quit()
      }
      input.on('data', onData)
      keysOff = () => {
        input.off('data', onData)
        input.setRawMode(false)
        input.pause()
      }
    },
    stop() {
      stopLive()
      if (keysOff) keysOff()
      print(tty ? dim('Stopped the dashboard.') : 'Stopped the dashboard.')
    },
  }
}

module.exports = { createTerminal }
