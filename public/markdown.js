import { el } from './ui.js'

const FENCE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const QUOTE = /^\s{0,3}>\s?/
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const INLINE = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])|(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"*_])/g

function external(href, text) {
  return el('a', { href, target: '_blank', rel: 'noreferrer noopener' }, text)
}

function inline(text) {
  const nodes = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) nodes.push(text.slice(last, match.index))
    if (match[1]) nodes.push(el('code', null, match[2]))
    else if (match[3] || match[4]) nodes.push(el('strong', null, inline(match[3] || match[4])))
    else if (match[5]) nodes.push(external(match[6], match[5]))
    else if (match[7] || match[8]) nodes.push(el('em', null, inline(match[7] || match[8])))
    else if (match[9]) nodes.push(external(match[9], match[9]))
    last = match.index + match[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function isTable(lines, index) {
  return lines[index].includes('|') && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1])
}

function cells(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function startsBlock(lines, index) {
  const line = lines[index]
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST.test(line) || isTable(lines, index)
}

function parseTable(lines, index) {
  const head = cells(lines[index])
  const rows = []
  let next = index + 2
  while (next < lines.length && lines[next].includes('|') && lines[next].trim()) rows.push(cells(lines[next++]))
  const table = el(
    'table',
    null,
    el('thead', null, el('tr', null, head.map((cell) => el('th', { scope: 'col' }, inline(cell))))),
    el('tbody', null, rows.map((row) => el('tr', null, head.map((_, column) => el('td', null, inline(row[column] || '')))))),
  )
  return { node: el('div', { class: 'md-table' }, table), next }
}

function parseList(lines, index) {
  const first = LIST.exec(lines[index])
  const ordered = /\d/.test(first[2])
  const base = first[1].length
  const list = el(ordered ? 'ol' : 'ul')
  if (ordered && parseInt(first[2], 10) !== 1) list.setAttribute('start', String(parseInt(first[2], 10)))
  let item = null
  let next = index
  while (next < lines.length) {
    const line = lines[next]
    if (!line.trim()) {
      const following = lines[next + 1]
      if (following !== undefined && (LIST.test(following) || /^\s{2,}\S/.test(following))) {
        next++
        continue
      }
      break
    }
    const match = LIST.exec(line)
    if (match) {
      const indent = match[1].length
      if (indent < base) break
      if (indent <= base + 1) {
        if (/\d/.test(match[2]) !== ordered) break
        item = el('li', null, inline(match[3]))
        list.append(item)
        next++
        continue
      }
      if (!item) break
      const nested = parseList(lines, next)
      item.append(nested.node)
      next = nested.next
      continue
    }
    if (item && /^\s+\S/.test(line)) {
      item.append(' ', ...inline(line.trim()))
      next++
      continue
    }
    break
  }
  return { node: list, next }
}

export function renderMarkdown(text) {
  const root = document.createDocumentFragment()
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      const code = []
      index++
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) code.push(lines[index++])
      index++
      root.append(el('pre', { class: 'md-pre' }, el('code', null, code.join('\n'))))
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      root.append(el(`h${Math.min(6, heading[1].length + 2)}`, null, inline(heading[2])))
      index++
      continue
    }
    if (RULE.test(line)) {
      root.append(el('hr'))
      index++
      continue
    }
    if (QUOTE.test(line)) {
      const quoted = []
      while (index < lines.length && QUOTE.test(lines[index])) quoted.push(lines[index++].replace(QUOTE, ''))
      root.append(el('blockquote', null, renderMarkdown(quoted.join('\n'))))
      continue
    }
    if (isTable(lines, index)) {
      const table = parseTable(lines, index)
      root.append(table.node)
      index = table.next
      continue
    }
    if (LIST.test(line)) {
      const list = parseList(lines, index)
      root.append(list.node)
      index = list.next
      continue
    }
    const paragraph = [line.trim()]
    index++
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) paragraph.push(lines[index++].trim())
    root.append(el('p', null, inline(paragraph.join('\n'))))
  }
  return root
}
