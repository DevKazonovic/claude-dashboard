import { el, readStore, writeStore } from './ui.js'
import { renderMarkdown } from './markdown.js'

const DISMISSED = 'ua-onboarding-dismissed-v1'
const PERSONAS = [
  { id: 'non-technical', label: 'Overview', title: 'High-level architecture view' },
  { id: 'junior', label: 'Learn', title: 'Full dashboard with guided learning' },
  { id: 'experienced', label: 'Deep Dive', title: 'Code-focused view' },
]
const STEPS = [
  {
    title: 'Welcome to your project map',
    body: '/understand read this project and drew it as a map. Each card is something it found: a layer, a file, a class or a function, or an article or a screen in a wiki or Figma map. Lines show how they connect, like imports and calls. The map reloads by itself when /understand runs again.',
    hint: 'Five short steps cover the main moves',
  },
  {
    title: 'Layers first, then files',
    body: 'The map opens on the project layers. Click a layer to see what is inside it. Related files sit in boxes that open on click, and Files or +Classes at the top sets how much detail you see. Esc takes you back one level.',
    hint: 'Press 0 to fit the map to the screen, + and - to zoom',
  },
  {
    title: 'Three ways to read it',
    body: 'Overview hides classes and functions and shows project stats on the right. Learn, the default, keeps the guided tour on the right, under whatever you select. Deep Dive shows every node, with project stats instead of the tour.',
    hint: 'Switch any time with the three buttons at the top left',
  },
  {
    title: 'Search, click, read the code',
    body: 'Search finds a node by name, summary or tags and takes you to it. Click a node to see its summary and connections on the right. Open code shows the file, with a lesson beside it that walks through it section by section when one was written.',
    hint: 'Press / to jump to search',
  },
  {
    title: 'Take the tour, and more',
    body: 'Start Tour walks through the project step by step and moves the map to each step. The top bar also has Filter, Export, Path to find how two nodes connect, and Theme. Press Shift + ? to see every shortcut.',
    hint: 'Use the arrow keys to move through the tour',
  },
]
let shown = false

function learnPanel(api, s) {
  const { actions } = api
  const steps = api.util.tourSteps(s.graph)
  if (!steps.length) {
    return el('div', { class: 'ua-l-none' }, el('div', { class: 'ua-l-compass', 'aria-hidden': 'true' }, '🧭'), el('p', null, 'No tour available'), el('p', { class: 'ua-l-hint' }, 'Generate a tour from your knowledge graph to get a guided walkthrough'))
  }
  if (!s.tour.active) {
    return el(
      'section',
      { class: 'ua-l-panel', 'aria-label': 'Project Tour' },
      el('div', null, el('h2', { class: 'ua-l-title' }, 'Project Tour'), el('p', { class: 'ua-l-sub' }, `${steps.length} steps · Guided walkthrough of the codebase`)),
      el('button', { class: 'ua-l-start', type: 'button', 'data-focus': 'tour-start', onclick: actions.startTour }, 'Start Tour'),
      el('h3', { class: 'ua-l-label' }, 'Steps'),
      el(
        'ol',
        { class: 'ua-l-steps' },
        steps.map((step, i) => el('li', { class: 'ua-l-step' }, el('span', { class: 'ua-l-num' }, `${i + 1}.`), el('span', null, step.title))),
      ),
    )
  }
  const i = s.tour.step
  const step = steps[i]
  if (!step) return null
  const last = i === steps.length - 1
  const ids = Array.isArray(step.nodeIds) ? step.nodeIds : []
  return el(
    'section',
    { class: 'ua-l-panel ua-l-tour', 'aria-label': 'Tour' },
    el(
      'div',
      { class: 'ua-l-tour-head' },
      el('div', { class: 'ua-l-count' }, el('h3', { class: 'ua-l-label' }, 'Tour'), el('span', null, `${i + 1} / ${steps.length}`)),
      el('button', { class: 'ua-l-exit', type: 'button', 'data-focus': 'tour-exit', onclick: actions.stopTour }, 'Exit Tour'),
    ),
    el('div', { class: 'ua-l-progress', role: 'progressbar', 'aria-label': 'Tour progress', 'aria-valuemin': 1, 'aria-valuemax': steps.length, 'aria-valuenow': i + 1 }, el('div', { class: 'ua-l-progress-fill', style: { '--ua-l-pct': `${((i + 1) / steps.length) * 100}%` } })),
    el('h2', { class: 'ua-l-title' }, step.title),
    el('div', { class: 'md small-md ua-l-md' }, renderMarkdown(step.description)),
    step.languageLesson ? el('div', { class: 'ua-l-lang' }, el('h4', { class: 'ua-l-label' }, 'Language Lesson'), el('p', null, step.languageLesson)) : null,
    ids.length
      ? el(
          'div',
          { class: 'ua-l-refs' },
          el('h4', { class: 'ua-l-label' }, 'Referenced Components'),
          el(
            'div',
            { class: 'ua-l-pills' },
            ids.map((id) => el('button', { class: 'ua-l-pill', type: 'button', 'data-focus': `pill-${id}`, onclick: () => actions.selectNode(id) }, (api.data.mainNode(id) || {}).name || id)),
          ),
        )
      : null,
    el(
      'div',
      { class: 'ua-l-foot' },
      el(
        'div',
        { class: 'ua-l-dots' },
        steps.map((_, n) => el('button', { class: n === i ? 'ua-l-dot is-on' : 'ua-l-dot', type: 'button', 'aria-label': `Go to step ${n + 1}`, 'aria-current': n === i ? 'step' : null, 'data-focus': `dot-${n}`, onclick: () => actions.setTourStep(n) })),
      ),
      el(
        'div',
        { class: 'ua-l-nav' },
        el('button', { class: 'ua-l-prev', type: 'button', disabled: i === 0, 'data-focus': 'tour-prev', onclick: actions.prevTourStep }, 'Prev'),
        el('button', { class: 'ua-l-next', type: 'button', 'data-focus': 'tour-next', onclick: last ? actions.stopTour : actions.nextTourStep }, last ? 'Finish' : 'Next'),
      ),
    ),
  )
}

function onboarding(api) {
  const force = new URLSearchParams(window.location.search).get('onboard') === 'force'
  if (!force && (shown || readStore(DISMISSED) === '1')) return null
  shown = true
  let index = 0
  const tag = el('div', { class: 'ua-l-ob-tag' })
  const title = el('h2', { class: 'ua-l-ob-title', id: 'ua-l-ob-title' })
  const body = el('p', { class: 'ua-l-ob-body' })
  const hint = el('blockquote', { class: 'ua-l-ob-hint' })
  const bars = STEPS.map(() => el('span', { class: 'ua-l-ob-bar' }))
  const prev = el('button', { class: 'ua-l-ob-btn', type: 'button', onclick: () => go(index - 1) }, 'Previous')
  const next = el('button', { class: 'ua-l-ob-btn is-primary', type: 'button', onclick: () => (index === STEPS.length - 1 ? close(true) : go(index + 1)) })
  const card = el(
    'div',
    { class: 'ua-l-ob-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ua-l-ob-title' },
    tag,
    title,
    body,
    hint,
    el('div', { class: 'ua-l-ob-bars', 'aria-hidden': 'true' }, bars),
    el('div', { class: 'ua-l-ob-row' }, el('button', { class: 'ua-l-ob-btn', type: 'button', onclick: () => close(true) }, "Don't show again"), el('span', { class: 'ua-l-ob-gap' }), prev, next),
  )
  const overlay = el('div', { class: 'ua-l-ob', onclick: (event) => event.target === overlay && close(false) }, card)
  const host = el('div', { class: 'ua-l-host' }, overlay)
  const offEscape = api.keys.escape(5, () => host.isConnected && (close(false), true))

  function go(n) {
    index = n
    const step = STEPS[n]
    tag.replaceChildren(el('span', { class: 'ua-l-ob-num' }, `0${n + 1}`), el('span', null, `/ 0${STEPS.length}`), el('span', { class: 'ua-l-ob-dot' }), el('span', null, 'Understand · Get started'))
    title.textContent = step.title
    body.textContent = step.body
    hint.replaceChildren(el('span', { class: 'ua-l-ob-mark', 'aria-hidden': 'true' }, '·'), step.hint)
    bars.forEach((bar, i) => bar.classList.toggle('is-on', i === n))
    prev.hidden = n === 0
    next.textContent = n === STEPS.length - 1 ? 'Start exploring' : 'Next'
  }

  function close(remember) {
    if (remember) writeStore(DISMISSED, '1')
    host.remove()
    offEscape()
  }

  go(0)
  api.root.append(host)
  next.focus({ preventScroll: true })
  return () => close(false)
}

export function register(api) {
  const offs = []
  const buttons = PERSONAS.map((p) => el('button', { class: 'ua-l-seg-btn', type: 'button', title: p.title, onclick: () => api.actions.setPersona(p.id) }, p.label))
  const paintPersona = (s) =>
    PERSONAS.forEach((p, i) => {
      buttons[i].classList.toggle('is-on', s.persona === p.id)
      buttons[i].setAttribute('aria-pressed', String(s.persona === p.id))
    })
  api.slots.persona.replaceChildren(el('div', { class: 'ua-l-seg', role: 'group', 'aria-label': 'Persona' }, buttons))
  paintPersona(api.store.get())
  offs.push(api.store.subscribe((s, p) => s.persona !== p.persona && paintPersona(s)))
  api.panels.info({ id: 'learn', order: 20, when: api.util.isLearnMode, render: (s) => learnPanel(api, s) })
  const closeOnboarding = onboarding(api)
  if (closeOnboarding) offs.push(closeOnboarding)
  return () => offs.forEach((off) => off())
}
