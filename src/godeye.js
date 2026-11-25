const fs = require('fs')
const os = require('os')
const path = require('path')
const { createJsonCache, readdirSafe, statSafe } = require('./collector')
const { RequestError } = require('./conversation')
const format = require('./format')

const ROOT = path.join(os.homedir(), '.claude', 'godeye')
const MAP_ID = /^[a-z0-9][a-z0-9-]{0,99}$/
const PROJECT = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,59}$/u
const MAX_FILE_BYTES = 8 * 1024 * 1024
const SCHEMA_FILE = path.join(os.homedir(), '.claude', 'skills', 'godeye', 'assets', 'schema.json')
const OLD_FORMAT = 'Old format: run /godeye again'
const DASH = /[–—]/

function str(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function list(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && !Array.isArray(item)) : []
}

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function own(object, key) {
  return Boolean(object) && typeof key === 'string' && Object.hasOwn(object, key)
}

function validSchema(schema) {
  return Boolean(
    plain(schema) &&
      schema.godeye === 4 &&
      Array.isArray(schema.order) &&
      plain(schema.levels) &&
      plain(schema.kinds) &&
      plain(schema.lines) &&
      plain(schema.sheet) &&
      plain(schema.box) &&
      plain(schema.line) &&
      plain(schema.limits) &&
      schema.order.every((level) => plain(schema.levels[level]) && typeof schema.levels[level].sheet === 'string' && Array.isArray(schema.levels[level].kinds) && Array.isArray(schema.levels[level].lines)),
  )
}

function bySheet(a, b) {
  const x = a.id.split('.').map(Number)
  const y = b.id.split('.').map(Number)
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) if (x[i] !== y[i]) return x[i] - y[i]
  return x.length - y.length
}

function parentOf(id) {
  if (id === '1') return null
  return id.includes('.') ? id.slice(0, id.lastIndexOf('.')) : '1'
}

function normalizeDesign(raw, schema, problems = []) {
  const say = (text) => problems.push(text)
  const value = plain(raw)
  if (!value || value.godeye !== 4) {
    say('This file is not a GodEye design.')
    return null
  }
  const feature = str(value.feature)
  if (!feature) {
    say('The file has no feature name.')
    return null
  }
  const { levels, kinds, limits, box: boxRule, sheet: sheetRule } = schema
  const boxId = new RegExp(boxRule.id)
  const refPattern = new RegExp(boxRule.ref)
  const portPattern = new RegExp(schema.line.port)
  const patterns = Object.fromEntries(schema.order.map((level) => [level, new RegExp(levels[level].sheet)]))
  const levelName = (level) => levels[level].name.toLowerCase()
  for (const key of Object.keys(value)) if (!schema.file.fields.includes(key)) say(`Unknown field "${key}" at the top of the file.`)

  const given = []
  const seen = new Set()
  for (const item of list(value.sheets)) {
    const id = str(item.id)
    const level = typeof item.level === 'string' ? item.level : ''
    const where = id ? `Sheet ${id}` : 'A sheet'
    if (!own(patterns, level) || !patterns[level].test(id)) {
      say(`${where}: level "${level}" does not fit sheet number "${id}".`)
      continue
    }
    if (seen.has(id)) {
      say(`${where} appears twice.`)
      continue
    }
    const title = str(item.title)
    if (!title) {
      say(`${where} has no title.`)
      continue
    }
    if (!sheetRule.status.includes(item.status)) {
      say(`${where}: status must be ${sheetRule.status.join(' or ')}.`)
      continue
    }
    for (const key of Object.keys(item)) if (!sheetRule.fields.includes(key)) say(`${where}: unknown field "${key}".`)
    seen.add(id)
    given.push({ id, level, item, title })
  }
  given.sort(bySheet)
  if (given.length > limits.sheets) {
    say(`The file has more than ${limits.sheets} sheets.`)
    given.length = limits.sheets
  }

  const sheets = []
  const byId = new Map()
  const boxMaps = new Map()
  const built = []
  const opens = []
  const refs = []
  for (const { id, level, item, title } of given) {
    const parent = parentOf(id)
    if (parent && !byId.has(parent)) {
      say(`Sheet ${id} has no sheet ${parent} above it.`)
      continue
    }
    const sheet = { id, level, title, status: item.status, parent, from: null, boxes: [], lines: [] }
    const note = str(item.note)
    if (note) sheet.note = note
    const cells = new Set()
    const boxes = new Map()
    for (const rawBox of list(item.boxes)) {
      const bid = str(rawBox.id)
      const where = `Sheet ${id}, box "${bid || '?'}"`
      if (sheet.boxes.length >= limits.boxes) {
        say(`Sheet ${id} has more than ${limits.boxes} boxes.`)
        break
      }
      if (!boxId.test(bid)) {
        say(`${where}: the id must be lowercase words joined by dashes.`)
        continue
      }
      if (boxes.has(bid)) {
        say(`${where} appears twice.`)
        continue
      }
      if (!levels[level].kinds.includes(rawBox.kind)) {
        say(`${where}: kind "${rawBox.kind}" does not belong on a ${levelName(level)} sheet.`)
        continue
      }
      const name = str(rawBox.name)
      if (!name) {
        say(`${where} has no name.`)
        continue
      }
      const at = rawBox.at
      if (!Array.isArray(at) || at.length !== 2 || !at.every((n) => Number.isInteger(n) && n >= 0 && n < limits.grid)) {
        say(`${where}: at must be [column, row], whole numbers from 0 to ${limits.grid - 1}.`)
        continue
      }
      const cell = `${at[0]},${at[1]}`
      if (cells.has(cell)) {
        say(`${where}: cell [${cell}] is already taken.`)
        continue
      }
      cells.add(cell)
      const box = { id: bid, kind: rawBox.kind, name, at: [at[0], at[1]] }
      for (const key of Object.keys(rawBox)) {
        if (!boxRule.fields.includes(key)) {
          say(`${where}: unknown field "${key}".`)
          continue
        }
        if (['id', 'kind', 'name', 'at'].includes(key)) continue
        if (own(boxRule.only, key) && !boxRule.only[key].includes(rawBox.kind)) {
          say(`${where}: ${key} is only for ${boxRule.only[key].join(', ')} boxes.`)
          continue
        }
        if (key === 'opens') opens.push([sheet, box, str(rawBox.opens), where])
        else if (key === 'status') {
          if (boxRule.status.includes(rawBox.status)) box.status = rawBox.status
          else say(`${where}: status must be ${boxRule.status.join(', ')}.`)
        } else if (boxRule.text.includes(key)) {
          const text = str(rawBox[key])
          if (text) box[key] = text
        } else if (boxRule.lists.includes(key)) {
          const items = Array.isArray(rawBox[key]) ? rawBox[key].map(str).filter(Boolean) : []
          if (items.length) box[key] = items
        } else if (boxRule.refs.includes(key)) refs.push([box, key, rawBox[key], where])
      }
      boxes.set(bid, box)
      sheet.boxes.push(box)
    }
    const work = sheet.boxes.filter((box) => own(kinds, box.kind) && kinds[box.kind].work).length
    if (work > limits.work) say(`Sheet ${id} has ${work} work boxes. Keep it to ${limits.work}: group some into one box that opens its own sheet.`)
    sheets.push(sheet)
    byId.set(id, sheet)
    boxMaps.set(id, boxes)
    built.push([sheet, item])
  }

  const first = byId.get('1')
  const features = first ? first.boxes.filter((box) => box.kind === 'feature') : []
  if (!first || features.length !== 1) {
    say(first ? 'Sheet 1 must hold exactly one feature box.' : 'The file has no sheet 1, the idea.')
    return null
  }

  for (const [sheet, box, target, where] of opens) {
    const child = byId.get(target)
    const fits = child && child.parent === sheet.id && (sheet.id === '1' ? box.kind === 'feature' && target === '2' : own(kinds, box.kind) && kinds[box.kind].opens === child.level)
    if (!fits) {
      say(`${where}: opens "${target}", which is not a sheet this box can open.`)
      continue
    }
    if (child.from) {
      say(`${where}: sheet ${target} is already opened by box "${child.from}".`)
      continue
    }
    box.opens = target
    child.from = box.id
  }
  for (const sheet of sheets) if ((sheet.level === 'parts' || sheet.level === 'logic') && !sheet.from) say(`Sheet ${sheet.id} is not opened by any box on sheet ${sheet.parent}.`)

  const touches = (line, port) => line.from === port || line.to === port
  for (const [sheet, item] of built) {
    const boxes = boxMaps.get(sheet.id)
    const above = sheet.level === 'parts' && sheet.from ? byId.get(sheet.parent) : null
    const ports = new Set()
    if (above) {
      for (const line of above.lines) {
        if (line.from === sheet.from) ports.add(line.to)
        if (line.to === sheet.from) ports.add(line.from)
      }
    }
    const end = (ref) => (portPattern.test(ref) ? (ports.has(ref.slice(1)) ? 'port' : null) : boxes.has(ref) ? 'box' : null)
    for (const rawLine of list(item.lines)) {
      const from = str(rawLine.from)
      const to = str(rawLine.to)
      const where = `Sheet ${sheet.id}, line from "${from || '?'}" to "${to || '?'}"`
      if (sheet.lines.length >= limits.lines) {
        say(`Sheet ${sheet.id} has more than ${limits.lines} lines.`)
        break
      }
      const a = end(from)
      const b = end(to)
      if (!a || !b) {
        say(`${where}: "${a ? to : from}" is not a box on this sheet${sheet.level === 'parts' ? ', or a box linked to it on sheet 3' : ''}.`)
        continue
      }
      if (a === 'port' && b === 'port') {
        say(`${where}: a line must touch a box on this sheet.`)
        continue
      }
      if (from === to) {
        say(`${where}: a line cannot start and end on the same box.`)
        continue
      }
      const kind = rawLine.kind === undefined ? 'plain' : rawLine.kind
      if (!levels[sheet.level].lines.includes(kind)) {
        say(`${where}: kind "${kind}" does not belong on a ${levelName(sheet.level)} sheet.`)
        continue
      }
      for (const key of Object.keys(rawLine)) if (!schema.line.fields.includes(key)) say(`${where}: unknown field "${key}".`)
      const line = { from, to, kind }
      const label = str(rawLine.label)
      if (label) line.label = label
      if (own(schema.lines, kind) && schema.lines[kind].order) {
        if (Number.isInteger(rawLine.order) && rawLine.order >= 1) line.order = rawLine.order
        else say(`${where}: a main line needs order, a number from 1.`)
      } else if (own(rawLine, 'order')) say(`${where}: only main lines carry order.`)
      if (rawLine.both === true) line.both = true
      sheet.lines.push(line)
    }
    const orders = sheet.lines.filter((line) => line.order).map((line) => line.order).sort((x, y) => x - y)
    if (orders.some((order, i) => order !== i + 1)) say(`Sheet ${sheet.id}: number the main lines 1, 2, 3 and so on.`)
    if (above) {
      for (const line of above.lines) {
        if (line.from !== sheet.from && line.to !== sheet.from) continue
        const out = line.from === sheet.from
        const port = `^${out ? line.to : line.from}`
        const kept = sheet.lines.some((inner) => (line.both || inner.both ? touches(inner, port) : out ? inner.to === port : inner.from === port))
        if (!kept) say(`Sheet ${sheet.id} is missing a line ${out ? 'to' : 'from'} ${port}, which sheet ${above.id} shows for box "${sheet.from}".`)
      }
    }
  }

  for (const [box, key, given, where] of refs) {
    const pairs = []
    for (const ref of Array.isArray(given) ? given : []) {
      const text = str(ref)
      const slash = text.lastIndexOf('/')
      const target = boxMaps.get(text.slice(0, slash))
      if (!refPattern.test(text) || !target || !target.has(text.slice(slash + 1))) {
        say(`${where}: ${key} "${text}" does not point at a box.`)
        continue
      }
      pairs.push([text.slice(0, slash), text.slice(slash + 1)])
    }
    if (pairs.length) box[key] = pairs
  }

  const design = { feature }
  const product = str(value.product)
  const about = str(value.summary)
  if (product) design.product = product
  if (about) design.summary = about
  design.sheets = sheets

  const texts = [feature, product, about]
  for (const sheet of sheets) {
    texts.push(sheet.title, sheet.note || '')
    for (const box of sheet.boxes) for (const key of [...boxRule.text, ...boxRule.lists]) texts.push(...[box[key] || ''].flat())
    for (const line of sheet.lines) texts.push(line.label || '')
  }
  const dashed = texts.find((text) => DASH.test(text))
  if (dashed) say(`A long dash appears in "${dashed}". Use plain punctuation.`)
  return design
}

function version(raw) {
  return plain(raw) && [1, 2, 3, 4].includes(raw.godeye) ? raw.godeye : 0
}

function titleOf(design) {
  return design.product ? `${design.product} / ${design.feature}` : design.feature
}

function sheetsLabel(design) {
  const drafts = design.sheets.filter((sheet) => sheet.status === 'draft').length
  const questions = design.sheets.reduce((sum, sheet) => sum + sheet.boxes.reduce((count, box) => count + (box.questions ? box.questions.length : 0), 0), 0)
  return [format.plural(design.sheets.length, 'sheet', 'sheets'), drafts ? `${drafts} waiting for your OK` : 'all approved', questions ? format.plural(questions, 'open question', 'open questions') : ''].filter(Boolean).join(' · ')
}

function oldTitle(raw, v, id) {
  const name = str(raw.name) || id
  if (v === 3) {
    const product = plain(raw.facts) ? str(raw.facts.product) : ''
    return product ? `${product} / ${name}` : name
  }
  const topic = str(v === 2 ? raw.feature : raw.topic)
  return topic ? `${name} / ${topic}` : name
}

function viewSchema(schema) {
  const names = (group) => Object.fromEntries(Object.entries(group).map(([key, entry]) => [key, { name: (plain(entry) && str(entry.name)) || key }]))
  return { order: schema.order, levels: names(schema.levels), kinds: names(schema.kinds) }
}

function summary(id, raw, mtimeMs, schema) {
  const v = version(raw)
  const card = { id, updatedMs: mtimeMs, updatedLabel: `Updated ${format.ago(mtimeMs, Date.now())}`, partsLabel: '', error: null }
  if (!v) return { ...card, title: id, error: 'This file is not a GodEye design, or its JSON does not parse.' }
  if (v < 4) return { ...card, title: oldTitle(raw, v, id), partsLabel: 'Old format' }
  if (!schema) return { ...card, title: id, error: `The GodEye schema is missing or invalid: ${format.homePath(SCHEMA_FILE)}` }
  const problems = []
  const design = normalizeDesign(raw, schema, problems)
  if (!design) return { ...card, title: str(raw.feature) || id, error: `${problems[0]} Run /godeye again.` }
  return { ...card, title: titleOf(design), partsLabel: sheetsLabel(design), design }
}

function projectName(value) {
  const name = str(value).replace(/\s+/g, ' ')
  return PROJECT.test(name) ? name : null
}

function mapId(fileName) {
  const base = path.basename(str(fileName)).replace(/\.json$/i, '')
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 100)
      .replace(/^-+|-+$/g, '') || 'design'
  )
}

function createGodeye() {
  const readJson = createJsonCache()

  async function loadSchema() {
    const schema = await readJson(SCHEMA_FILE)
    return validSchema(schema) ? schema : null
  }

  async function projectDir(value) {
    const name = projectName(value)
    const dir = name ? path.join(ROOT, name) : null
    const stat = dir ? await statSafe(dir) : null
    return stat && stat.isDirectory() ? { name, dir } : null
  }

  async function maps(dir, schema) {
    const found = []
    for (const entry of await readdirSafe(dir)) {
      const id = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : ''
      if (!entry.isFile() || !MAP_ID.test(id)) continue
      const file = path.join(dir, entry.name)
      const [raw, stat] = await Promise.all([readJson(file), statSafe(file)])
      if (!stat) continue
      const { design, ...card } = summary(id, raw, stat.mtimeMs, schema)
      found.push(card)
    }
    return found.sort((a, b) => b.updatedMs - a.updatedMs)
  }

  return {
    async list() {
      const schema = await loadSchema()
      const projects = []
      for (const entry of await readdirSafe(ROOT)) {
        if (!entry.isDirectory() || !PROJECT.test(entry.name)) continue
        const dir = path.join(ROOT, entry.name)
        const [items, stat] = await Promise.all([maps(dir, schema), statSafe(dir)])
        const updatedMs = Math.max(stat ? stat.mtimeMs : 0, ...items.map((item) => item.updatedMs))
        projects.push({ name: entry.name, maps: items, countLabel: format.plural(items.length, 'design', 'designs'), updatedMs, updatedLabel: `Updated ${format.ago(updatedMs, Date.now())}` })
      }
      projects.sort((a, b) => b.updatedMs - a.updatedMs)
      return { projects, folderLabel: format.homePath(ROOT) }
    },

    async map(params) {
      const project = await projectDir(params.get('project'))
      const id = params.get('id') || ''
      if (!project || !MAP_ID.test(id)) return null
      const file = path.join(project.dir, `${id}.json`)
      const stat = await statSafe(file)
      if (!stat || !stat.isFile()) return null
      const raw = await readJson(file)
      const v = version(raw)
      const schema = v === 4 ? await loadSchema() : null
      if (v === 4 && !schema) throw new RequestError(500, `The GodEye schema is missing or invalid: ${format.homePath(SCHEMA_FILE)}`)
      const { design, ...info } = summary(id, raw, stat.mtimeMs, schema)
      if (info.error) throw new RequestError(422, info.error)
      if (v < 4) return { ...info, project: project.name, version: v, old: true }
      return { ...info, project: project.name, version: 4, design, schema: viewSchema(schema) }
    },

    async createProject(body) {
      const name = projectName(body.name)
      if (!name) throw new RequestError(400, 'Start the name with a letter or number, then use letters, numbers, spaces, dots, dashes or underscores, up to 60 characters.')
      await fs.promises.mkdir(ROOT, { recursive: true })
      try {
        await fs.promises.mkdir(path.join(ROOT, name))
      } catch (error) {
        if (error.code === 'EEXIST') throw new RequestError(409, `A project named ${name} already exists.`)
        throw error
      }
      return { name }
    },

    async addMap(body) {
      const project = await projectDir(body.project)
      if (!project) throw new RequestError(404, 'This project was not found. Open GodEye again.')
      if (typeof body.text !== 'string') throw new RequestError(400, 'Drop a .json design file.')
      if (Buffer.byteLength(body.text) > MAX_FILE_BYTES) throw new RequestError(413, 'This file is too large to be a design.')
      const fileName = str(body.file) || 'design.json'
      const text = body.text
      let raw = null
      try {
        raw = JSON.parse(text)
      } catch {}
      const v = version(raw)
      if (v && v < 4) throw new RequestError(400, OLD_FORMAT)
      if (v !== 4) throw new RequestError(422, `${fileName} is not a GodEye design. Run /godeye again.`)
      const schema = await loadSchema()
      if (!schema) throw new RequestError(500, `The GodEye schema is missing or invalid: ${format.homePath(SCHEMA_FILE)}`)
      const problems = []
      const design = normalizeDesign(raw, schema, problems)
      if (problems.length) throw new RequestError(422, `${fileName}: ${problems[0]}`)
      const id = mapId(fileName)
      const file = path.join(project.dir, `${id}.json`)
      const temp = `${file}.${process.pid}.tmp`
      await fs.promises.writeFile(temp, text)
      await fs.promises.rename(temp, file)
      return { project: project.name, id, title: titleOf(design) }
    },
  }
}

module.exports = { createGodeye, normalizeDesign, MAX_FILE_BYTES }
