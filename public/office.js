import { el, readStore, writeStore } from './ui.js'

const SKIN = ['#f1c7a3', '#e3ac82', '#c68642', '#8d5524', '#f6d7b0']
const HAIR = ['#2b2118', '#5a3825', '#a0522d', '#e2b65b', '#d9d6cf', '#8e3b46', '#2f4b7c']
const SHIRT = ['#c6613f', '#3f7cc6', '#4fa36b', '#8a5cc6', '#d1a33c', '#3fa6a6', '#c64f7a', '#6b7280']
const MOODS = { working: 'working', busy: 'working', done: 'done', failed: 'failed', waiting: 'waiting', blocked: 'waiting' }
const BUBBLES = { done: '✓', failed: '!', waiting: '?', idle: 'zz' }
const FINISHED = new Set(['done', 'ended', 'stopped'])
const WIDE_ROOM = 8

function hash(text) {
  let value = 7
  for (const char of String(text)) value = (value * 31 + char.charCodeAt(0)) >>> 0
  return value
}

function moodOf(status) {
  return MOODS[status] || 'idle'
}

function px(x, y, w, h, fill, className) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"${className ? ` class="${className}"` : ''}/>`
}

function sprite(seed, mood) {
  const value = hash(seed)
  const skin = SKIN[value % SKIN.length]
  const hair = HAIR[(value >>> 3) % HAIR.length]
  const shirt = SHIRT[(value >>> 6) % SHIRT.length]
  const style = (value >>> 9) % 3
  const nap = mood === 'idle'
  const top = nap ? 8 : 4
  const parts = [px(7, 7, 10, 8, '#3b3a37'), px(8, 6, 8, 1, '#4a4945')]
  const laptop = px(9, 11, 6, 3, '#c9c7c0') + px(11, 12, 2, 1, mood === 'working' ? '#ffb86b' : '#9a9891', mood === 'working' ? 'office-logo' : null)
  parts.push(px(9, nap ? 10 : 9, 6, nap ? 4 : 5, shirt))
  if (nap) parts.push(laptop)
  parts.push(px(10, top, 4, 4, skin), px(10, top - 1, 4, 2, hair))
  if (style === 1) parts.push(px(9, top, 1, 2, hair))
  if (style === 2) parts.push(px(9, top, 1, 4, hair), px(14, top, 1, 4, hair))
  if (nap) parts.push(px(11, top + 2, 1, 1, '#1f1e1d'), px(13, top + 2, 1, 1, '#1f1e1d'), px(8, 13, 8, 1, skin))
  else {
    parts.push(px(11, 6, 1, 1, '#1f1e1d'), px(13, 6, 1, 1, '#1f1e1d'))
    parts.push(laptop)
    if (mood === 'working') parts.push(px(8, 12, 2, 1, skin, 'office-hand'), px(14, 12, 2, 1, skin, 'office-hand is-late'))
    if (mood === 'done') parts.push(px(8, 3, 2, 3, skin), px(14, 3, 2, 3, skin), px(11, 7, 2, 1, '#7a3b2b'))
    if (mood === 'failed') parts.push(px(9, 5, 1, 2, skin), px(14, 5, 1, 2, skin), px(11, 7, 2, 1, '#1f1e1d'))
    if (mood === 'waiting') parts.push(px(15, 1, 2, 2, skin), px(15, 3, 1, 3, shirt), px(8, 12, 2, 1, skin))
  }
  parts.push(px(2, 14, 20, 2, '#8b5a3c'), px(3, 16, 18, 3, '#6e452e'), px(4, 19, 2, 1, '#4b2f20'), px(18, 19, 2, 1, '#4b2f20'))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 20" shape-rendering="crispEdges">${parts.join('')}</svg>`
}

const PLANT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 12" shape-rendering="crispEdges">${px(4, 0, 2, 2, '#4fa36b')}${px(2, 2, 3, 2, '#3f8a59')}${px(5, 1, 3, 3, '#4fa36b')}${px(3, 4, 4, 3, '#3f8a59')}${px(2, 7, 6, 1, '#a0522d')}${px(3, 8, 4, 4, '#8b4a2b')}</svg>`

function syncChildren(parent, items, build) {
  const old = new Map([...parent.children].map((child) => [child.dataset.key, child]))
  const next = items.map((item) => {
    const current = old.get(item.key)
    if (current && current.dataset.sig === item.sig) return current
    const fresh = build(item)
    fresh.dataset.key = item.key
    fresh.dataset.sig = item.sig
    return fresh
  })
  const keep = new Set(next)
  for (const child of [...parent.children]) if (!keep.has(child)) child.remove()
  let cursor = parent.firstElementChild
  for (const element of next) {
    if (element === cursor) cursor = cursor.nextElementSibling
    else parent.insertBefore(element, cursor)
  }
}

export function createAgentOffice(container, { onOpen, storeKey, showFinished }) {
  const parts = new WeakMap()
  let rooms = []
  let query = ''
  let finished = readStore(storeKey) === null ? showFinished : readStore(storeKey) === 'on'

  const search = el('input', { class: 'input search', type: 'search', placeholder: 'Search agents', 'aria-label': 'Search agents', autocomplete: 'off', spellcheck: 'false' })
  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase()
    render()
  })
  const toggle = el('input', { type: 'checkbox', checked: finished })
  toggle.addEventListener('change', () => {
    finished = toggle.checked
    writeStore(storeKey, finished ? 'on' : 'off')
    render()
  })
  const summary = el('p', { class: 'office-summary' })
  const floor = el('div', { class: 'office-rooms' })
  container.replaceChildren(el('div', { class: 'office' }, el('div', { class: 'office-bar' }, search, el('label', { class: 'office-toggle' }, toggle, el('span', null, 'Show finished agents')), summary), floor))

  function bubble(desk, mood) {
    if (mood === 'working') return desk.tool || 'Working'
    return BUBBLES[mood]
  }

  function deskEl(desk) {
    const mood = moodOf(desk.status)
    const art = el('span', { class: 'office-art', 'aria-hidden': 'true' })
    art.innerHTML = sprite(desk.key, mood)
    const text = [desk.label, desk.detail].filter(Boolean).join('\n')
    return el(
      'button',
      { class: `office-desk is-${mood}${desk.boss ? ' is-boss' : ''}`, type: 'button', title: text, 'aria-label': text.replace('\n', ', '), 'data-focus': `desk-${desk.key}`, onclick: () => onOpen(desk) },
      el('span', { class: `office-bubble is-${mood}` }, bubble(desk, mood)),
      art,
      el('span', { class: 'office-name' }, desk.label),
    )
  }

  function roomEl() {
    const title = el('h3', { class: 'office-room-title' })
    const meta = el('span', { class: 'office-room-meta' })
    const plant = el('span', { class: 'office-plant', 'aria-hidden': 'true' })
    plant.innerHTML = PLANT
    const boss = el('div', { class: 'office-boss' })
    const desks = el('div', { class: 'office-desks' })
    const empty = el('p', { class: 'office-empty' }, 'Nobody at a desk right now.')
    const room = el('section', { class: 'office-room' }, el('header', { class: 'office-room-head' }, el('span', { class: 'office-room-heading' }, title, meta), plant), boss, desks, empty)
    parts.set(room, { title, meta, boss, desks, empty })
    return room
  }

  function sig(desk) {
    return [desk.status, desk.tool, desk.label, desk.detail].join('|')
  }

  function keep(desk) {
    if (!finished && FINISHED.has(desk.status)) return false
    return !query || [desk.label, desk.detail].some((value) => String(value || '').toLowerCase().includes(query))
  }

  function render() {
    let shown = 0
    let total = 0
    const items = rooms.map((room) => ({ ...room, sig: 'room' }))
    syncChildren(floor, items, roomEl)
    for (const room of rooms) {
      const node = floor.querySelector(`[data-key="${CSS.escape(room.key)}"]`)
      const refs = parts.get(node)
      const desks = room.desks.filter(keep)
      total += room.desks.length
      shown += desks.length
      refs.title.textContent = room.title
      refs.meta.textContent = room.subtitle || ''
      node.classList.toggle('is-wide', desks.length > WIDE_ROOM)
      syncChildren(refs.boss, room.boss ? [{ ...room.boss, boss: true, sig: sig(room.boss) }] : [], deskEl)
      syncChildren(
        refs.desks,
        desks.map((desk) => ({ ...desk, sig: sig(desk) })),
        deskEl,
      )
      refs.empty.hidden = Boolean(desks.length || room.boss)
      refs.desks.hidden = !desks.length
    }
    summary.textContent = total ? `${shown} of ${total} agents shown` : 'No agents yet'
  }

  return {
    update(next) {
      rooms = next
      render()
    },
    destroy() {
      container.replaceChildren()
    },
  }
}
