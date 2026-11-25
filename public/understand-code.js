import { el, icon, keepFocus, reducedMotion } from './ui.js'
import { renderMarkdown } from './markdown.js'

const MAX_SECTIONS = 10
const WIDE = '(min-width: 1280px)'
const BY_EXT = { bash: 'bash', sh: 'bash', zsh: 'bash', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', cs: 'csharp', css: 'css', dart: 'dart', go: 'go', graphql: 'graphql', gql: 'graphql', htm: 'markup', html: 'markup', svg: 'markup', xml: 'markup', vue: 'markup', java: 'java', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', json: 'json', kt: 'kotlin', kts: 'kotlin', md: 'markdown', php: 'php', py: 'python', rb: 'ruby', rs: 'rust', scala: 'scala', sql: 'sql', swift: 'swift', toml: 'toml', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx', yaml: 'yaml', yml: 'yaml' }
const memo = new WeakMap()
let prism = null

const isRange = (value) => Array.isArray(value) && value.length === 2 && Number.isInteger(value[0]) && Number.isInteger(value[1]) && value[0] >= 1 && value[0] <= value[1]

function lessonSection(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.title !== 'string' || !raw.title.trim() || typeof raw.explanation !== 'string' || !isRange(raw.lineRange)) return null
  if (raw.tourOrder !== undefined && !Number.isInteger(raw.tourOrder)) return null
  return { title: raw.title, lineRange: [raw.lineRange[0], raw.lineRange[1]], explanation: raw.explanation, ...(raw.tourOrder !== undefined ? { tourOrder: raw.tourOrder } : {}) }
}

export function normalizeLessons(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  if (memo.has(data)) return memo.get(data)
  const files = data.files
  if (!files || typeof files !== 'object' || Array.isArray(files)) return null
  const out = Object.create(null)
  for (const [path, entry] of Object.entries(files)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.overview !== 'string') continue
    const sections = []
    for (const raw of Array.isArray(entry.sections) ? entry.sections : []) {
      if (sections.length >= MAX_SECTIONS) break
      const section = lessonSection(raw)
      if (section) sections.push(section)
    }
    out[path] = { overview: entry.overview, sections }
  }
  const lessons = { version: typeof data.version === 'number' ? data.version : 1, generatedAt: typeof data.generatedAt === 'string' ? data.generatedAt : '', files: out }
  memo.set(data, lessons)
  return lessons
}

function guessLanguage(filePath) {
  const name = String(filePath || '').split('/').pop().toLowerCase()
  if (name === 'dockerfile' || name.endsWith('.dockerfile')) return 'docker'
  const dot = name.lastIndexOf('.')
  return (dot > 0 && BY_EXT[name.slice(dot + 1)]) || 'text'
}

function bytes(size) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function loadPrism() {
  prism =
    prism ||
    new Promise((resolve, reject) => {
      if (window.Prism && window.Prism.tokenize) return resolve(window.Prism)
      document.head.append(el('script', { src: '/vendor/prism.js', onload: () => resolve(window.Prism), onerror: reject }))
    }).catch(() => (prism = null))
  return prism
}

export function tokenLines(Prism, code, language) {
  const grammar = Prism && Prism.languages[language]
  let tokens = [code]
  if (grammar) {
    const env = { code, grammar, language, tokens: [] }
    Prism.hooks.run('before-tokenize', env)
    env.tokens = Prism.tokenize(env.code, env.grammar)
    Prism.hooks.run('after-tokenize', env)
    tokens = env.tokens
  }
  const lines = [[]]
  const push = (text, types) =>
    text.split(/\r\n|\r|\n/).forEach((part, i) => {
      if (i) lines.push([])
      if (part) lines.at(-1).push([part, types])
    })
  const walk = (list, types) => {
    for (const token of list) {
      if (typeof token === 'string') push(token, types)
      else walk([].concat(token.content), [...types, token.type, ...[].concat(token.alias || [])])
    }
  }
  walk(tokens, [])
  return lines
}

export function register(api) {
  const { actions } = api
  const host = el('div', { class: 'ua-c-host' })
  const empty = el('p', { class: 'ua-c-empty' }, 'No file selected')
  const head = el('div', { class: 'ua-c-head' })
  const scroller = el('div', { class: 'ua-c-scroll' })
  const lessonBox = el('aside', { class: 'ua-c-lesson', 'aria-label': 'Lesson' })
  const main = el('div', { class: 'ua-c-main' }, scroller, lessonBox)
  const viewer = el('div', { class: 'ua-c-viewer' }, empty, head, main)
  const sheet = el('div', { class: 'ua-c-sheet' })
  const box = el('div', { class: 'ua-c-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Code viewer', onmousedown: (event) => event.stopPropagation() })
  const modal = el('div', { class: 'ua-c-modal', onmousedown: () => actions.collapseCode() }, box)
  const fresh = () => ({ id: null, path: undefined, status: 'idle', source: null, error: null, Prism: null, md: 'rendered', pick: null, open: window.matchMedia(WIDE).matches, rows: null, pre: null, lit: [], litKey: null, bodyKey: null })
  let v = fresh()
  let placed = null
  let ticket = 0
  let gone = false
  api.root.append(host)

  const nodeOf = (s) => (s.code.node ? api.data.node(s.code.node) || api.data.mainNode(s.code.node) : null)
  const lessonOf = (node) => {
    const all = normalizeLessons(api.data.file('code-lessons.json'))
    return all && node && node.filePath ? all.files[node.filePath] || null : null
  }
  const languageOf = (node) => (v.source && v.source.language && v.source.language !== 'text' ? v.source.language : guessLanguage(node && node.filePath))
  const rangeOf = (node) => v.pick || (node && isRange(node.lineRange) ? { start: node.lineRange[0], end: node.lineRange[1] } : null)
  const repaint = () => paint(nodeOf(api.store.get()), placed)

  function place(mode) {
    if (mode === placed) return false
    placed = mode
    if (mode === 'sheet') sheet.replaceChildren(viewer)
    if (mode === 'modal') box.replaceChildren(viewer)
    api.slots.bottom.replaceChildren(...(mode === 'sheet' ? [sheet] : []))
    host.replaceChildren(...(mode === 'modal' ? [modal] : []))
    return true
  }

  function scrollTo(line, smooth) {
    const row = v.rows && v.rows[line - 1]
    if (!row || !row.isConnected) return
    scroller.scrollTo({ top: row.offsetTop - (scroller.clientHeight - row.offsetHeight) / 2, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' })
  }

  function rowsFor(language) {
    if (!v.pre) {
      v.rows = tokenLines(v.Prism, v.source.content, language).map((parts, i) =>
        el('div', { class: 'ua-c-line', 'data-line': i + 1 }, el('span', { class: 'ua-c-ln' }, i + 1), el('span', { class: 'ua-c-src' }, parts.map(([text, types]) => (types.length ? el('span', { class: `token ${types.join(' ')}` }, text) : text)))),
      )
      v.pre = el('pre', { class: 'ua-c-code', 'data-lang': language }, v.rows)
      v.lit = []
      v.litKey = null
    }
    return v.pre
  }

  function setMd(mode) {
    v.md = mode
    repaint()
    if (mode === 'source' && v.pick) scrollTo(v.pick.start, true)
  }

  function toggleSection(section) {
    const [start, end] = section.lineRange
    const same = v.pick && v.pick.start === start && v.pick.end === end
    v.pick = same ? null : { start, end }
    if (!same && languageOf(nodeOf(api.store.get())) === 'markdown') v.md = 'source'
    repaint()
    if (!same) scrollTo(start, true)
  }

  function paintHead(node, lesson, mode, language) {
    const range = rangeOf(node)
    const close = mode === 'modal' ? 'Close expanded code viewer' : 'Close code viewer'
    keepFocus(head, () =>
      head.replaceChildren(
        el(
          'div',
          { class: 'ua-c-title' },
          el('div', { class: 'ua-c-meta' }, el('span', { class: 'ua-c-lang' }, language), el('span', { class: 'ua-c-range' }, range ? `Lines ${range.start}-${range.end}` : 'Full file')),
          el('div', { class: 'ua-c-name' }, node.name),
          node.filePath ? el('div', { class: 'ua-c-path' }, node.filePath) : null,
        ),
        el(
          'div',
          { class: 'ua-c-actions' },
          lesson
            ? el(
                'button',
                {
                  class: 'ua-c-lesson-toggle',
                  type: 'button',
                  'aria-expanded': String(v.open),
                  'data-focus': 'lesson-toggle',
                  onclick: () => {
                    v.open = !v.open
                    repaint()
                  },
                },
                v.open ? 'Hide lesson' : 'Show lesson',
              )
            : null,
          mode === 'sheet' ? el('button', { class: 'icon-button', type: 'button', title: 'Open larger code viewer', 'aria-label': 'Open larger code viewer', 'data-focus': 'code-expand', onclick: actions.expandCode }, icon('fit')) : null,
          el('button', { class: 'icon-button', type: 'button', title: close, 'aria-label': close, 'data-focus': 'code-close', onclick: mode === 'modal' ? actions.collapseCode : actions.closeCode }, icon('close')),
        ),
      ),
    )
  }

  function toolbar(markdown) {
    const source = v.source
    return el(
      'div',
      { class: 'ua-c-bar' },
      el('span', null, `${source.lineCount} lines`),
      el(
        'div',
        { class: 'ua-c-tools' },
        markdown ? el('div', { class: 'ua-c-toggle', role: 'group', 'aria-label': 'Markdown view' }, ['rendered', 'source'].map((mode) => el('button', { type: 'button', 'aria-pressed': String(v.md === mode), 'data-focus': `md-${mode}`, onclick: () => setMd(mode) }, mode === 'rendered' ? 'Rendered' : 'Source'))) : null,
        el('span', null, bytes(source.sizeBytes)),
      ),
    )
  }

  function paintBody(language) {
    const markdown = language === 'markdown'
    const key = `${v.status}|${v.path}|${markdown && v.md}`
    if (key === v.bodyKey) return
    v.bodyKey = key
    let content = []
    if (v.status === 'loading') content = [el('p', { class: 'ua-c-note' }, 'Loading source...')]
    if (v.status === 'error') content = [el('div', { class: 'ua-c-error' }, el('p', { class: 'ua-c-error-title' }, 'Source unavailable'), el('p', null, v.error || 'Source unavailable'))]
    if (v.status === 'loaded') content = [toolbar(markdown), markdown && v.md === 'rendered' ? el('div', { class: 'md ua-c-md' }, renderMarkdown(v.source.content)) : rowsFor(language)]
    keepFocus(scroller, () => scroller.replaceChildren(...content))
  }

  function lessonCard(section, i) {
    const [start, end] = section.lineRange
    const active = Boolean(v.pick && v.pick.start === start && v.pick.end === end)
    return el(
      'div',
      { class: active ? 'ua-c-sec is-active' : 'ua-c-sec' },
      el(
        'button',
        { class: 'ua-c-sec-btn', type: 'button', 'aria-pressed': String(active), 'data-focus': `sec-${i}`, onclick: () => toggleSection(section) },
        el('span', { class: 'ua-c-sec-top' }, el('span', { class: 'ua-c-sec-title' }, section.title), section.tourOrder !== undefined ? el('span', { class: 'ua-c-tour' }, `Tour ${section.tourOrder}`) : null),
        el('span', { class: 'ua-c-sec-lines' }, `Lines ${start}–${end}`),
      ),
      active ? el('div', { class: 'md small-md ua-c-sec-text' }, renderMarkdown(section.explanation)) : null,
    )
  }

  function paintLesson(lesson) {
    main.classList.toggle('has-lesson', Boolean(lesson))
    lessonBox.classList.toggle('is-open', v.open)
    if (!lesson) return lessonBox.replaceChildren()
    const top = lessonBox.scrollTop
    keepFocus(lessonBox, () =>
      lessonBox.replaceChildren(
        el('div', { class: 'ua-c-lesson-head' }, el('h3', null, 'Lesson')),
        el(
          'div',
          { class: 'ua-c-lesson-body' },
          el('div', { class: 'md small-md' }, renderMarkdown(lesson.overview)),
          lesson.sections.length ? el('div', { class: 'ua-c-secs' }, lesson.sections.map(lessonCard)) : el('p', { class: 'ua-c-only' }, 'Overview only, no section breakdown for this file.'),
        ),
      ),
    )
    lessonBox.scrollTop = top
  }

  function paintRange(node) {
    const range = rangeOf(node)
    const key = range && v.rows ? `${range.start}-${range.end}` : ''
    if (key === v.litKey) return
    v.litKey = key
    for (const row of v.lit) row.classList.remove('is-lit')
    v.lit = range && v.rows ? v.rows.slice(range.start - 1, range.end) : []
    for (const row of v.lit) row.classList.add('is-lit')
  }

  function paint(node, mode) {
    empty.hidden = Boolean(node)
    head.hidden = !node
    main.hidden = !node
    if (!node || !mode) return
    const language = languageOf(node)
    const lesson = lessonOf(node)
    paintHead(node, lesson, mode, language)
    paintBody(language)
    paintLesson(lesson)
    paintRange(node)
  }

  async function load(path) {
    const mine = ++ticket
    Object.assign(v, { path, status: path ? 'loading' : 'error', source: null, error: path ? null : 'This node does not have a file path.', rows: null, pre: null, lit: [], litKey: null })
    if (!path) return
    const [source, Prism] = await Promise.all([api.data.source(path).catch((error) => ({ failed: (error && error.message) || 'Source unavailable' })), loadPrism()])
    if (gone || mine !== ticket) return
    if (source.failed !== undefined) Object.assign(v, { status: 'error', error: source.failed })
    else Object.assign(v, { status: 'loaded', source, Prism })
    const node = nodeOf(api.store.get())
    paint(node, placed)
    const range = rangeOf(node)
    if (range) scrollTo(range.start, Boolean(v.pick))
  }

  function sync(s) {
    const mode = s.code.open ? (s.code.expanded ? 'modal' : 'sheet') : null
    if (!mode) {
      if (placed) {
        ticket++
        v = fresh()
      }
      return place(null)
    }
    const node = nodeOf(s)
    const switched = s.code.node !== v.id
    if (switched) {
      v.id = s.code.node
      v.pick = null
    }
    const path = node && node.filePath ? node.filePath : null
    const reload = path !== v.path
    if (reload) load(path)
    const moved = place(mode)
    paint(node, mode)
    if (moved) (head.querySelector(`[data-focus="${mode === 'modal' ? 'code-close' : 'code-expand'}"]`) || viewer).focus({ preventScroll: true })
    const range = switched && !reload ? rangeOf(node) : null
    if (range) scrollTo(range.start, false)
  }

  const off = api.store.subscribe((s, p) => {
    if (s.code !== p.code || s.files !== p.files || s.graph !== p.graph || s.viewMode !== p.viewMode) sync(s)
  })
  sync(api.store.get())
  return () => {
    gone = true
    off()
    host.remove()
  }
}
