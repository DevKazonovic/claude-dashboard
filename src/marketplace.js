const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const format = require('./format')
const { createJsonCache } = require('./collector')

const PAGE_SIZE = 48
const SORTS = new Set(['installs', 'updated', 'name'])
const PLUGIN_ACTIONS = new Set(['install', 'enable', 'disable', 'uninstall'])
const SOURCE_ACTIONS = { 'marketplace-update': 'update', 'marketplace-remove': 'remove' }
const COMMAND_TIMEOUT_MS = 3 * 60 * 1000
const DONE = { install: 'Installed', enable: 'Turned on', disable: 'Turned off', uninstall: 'Uninstalled', 'marketplace-add': 'Marketplace added', 'marketplace-update': 'Marketplace updated', 'marketplace-remove': 'Marketplace removed' }

function str(value) {
  return typeof value === 'string' ? value : ''
}

function fail(status, message) {
  return Object.assign(new Error(message), { status })
}

function sourceLabel(source) {
  if (typeof source === 'string') return source
  const value = source && typeof source === 'object' ? source : {}
  return str(value.repo) || str(value.url) || format.homePath(str(value.path)) || 'Unknown source'
}

function runClaude(args) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('claude', args, { cwd: os.tmpdir(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      reject(error)
      return
    }
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      output = `${output}${chunk}`.slice(-4000)
    })
    child.stderr.on('data', (chunk) => {
      output = `${output}${chunk}`.slice(-4000)
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), COMMAND_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const last = output.trim().split('\n').filter(Boolean).slice(-3).join(' ')
      if (code === 0) return resolve(last)
      reject(new Error(signal ? 'Claude Code took too long and was stopped.' : last || `Claude Code stopped with exit code ${code}.`))
    })
  })
}

function createMarketplace() {
  const readJson = createJsonCache()
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  let running = null

  async function load() {
    const plugins = path.join(configDir, 'plugins')
    const known = (await readJson(path.join(plugins, 'known_marketplaces.json'))) || {}
    const catalogFile = (await readJson(path.join(plugins, 'plugin-catalog-cache.json'))) || {}
    const catalog = catalogFile.catalog && typeof catalogFile.catalog === 'object' ? catalogFile.catalog : {}
    const stats = catalog.plugins && typeof catalog.plugins === 'object' ? catalog.plugins : {}
    const model = Array.isArray(catalog.models) ? str(catalog.models[0]) : ''
    const registry = (await readJson(path.join(plugins, 'installed_plugins.json'))) || {}
    const installed = new Set(Object.keys((registry && registry.plugins) || {}))
    const settings = (await readJson(path.join(configDir, 'settings.json'))) || {}
    const enabled = settings.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : {}
    const markets = []
    const entries = []
    for (const [name, market] of Object.entries(known)) {
      if (!market || typeof market !== 'object') continue
      const listing = typeof market.installLocation === 'string' ? await readJson(path.join(market.installLocation, '.claude-plugin', 'marketplace.json')) : null
      const list = listing && Array.isArray(listing.plugins) ? listing.plugins.filter((plugin) => plugin && str(plugin.name)) : []
      const updatedAt = Date.parse(str(market.lastUpdated))
      markets.push({ name, sourceLabel: sourceLabel(market.source), count: list.length, updatedAt })
      for (const plugin of list) {
        const id = `${plugin.name}@${name}`
        const stat = stats[id] && typeof stats[id] === 'object' ? stats[id] : {}
        const tokens = stat.tokens && model && stat.tokens[model] ? Number(stat.tokens[model].always_on) || 0 : 0
        entries.push({
          id,
          name: str(plugin.name),
          title: str(plugin.displayName) || str(plugin.name),
          description: str(plugin.description),
          author: plugin.author && typeof plugin.author === 'object' ? str(plugin.author.name) : str(plugin.author),
          category: str(plugin.category),
          keywords: Array.isArray(plugin.keywords) ? plugin.keywords.filter((word) => typeof word === 'string') : [],
          homepage: str(plugin.homepage) || (typeof plugin.repository === 'string' ? plugin.repository : ''),
          license: str(plugin.license),
          version: str(stat.version) || str(plugin.version),
          marketplace: name,
          installs: Number(stat.unique_installs) || 0,
          tokens,
          updatedAt: Date.parse(str(stat.last_updated)),
          components: stat.components && typeof stat.components === 'object' ? stat.components : {},
          installed: installed.has(id),
          on: installed.has(id) ? enabled[id] === true : null,
        })
      }
    }
    return { markets, entries }
  }

  function card(entry, now) {
    return {
      id: entry.id,
      title: entry.title,
      description: entry.description,
      metaLabel: [entry.author, entry.category ? format.capitalize(entry.category) : null, entry.marketplace].filter(Boolean).join(' · '),
      statsLabel: [entry.installs ? `${format.tokens(entry.installs)} installs` : null, entry.tokens ? `~${format.tokens(entry.tokens)} tokens` : null, Number.isFinite(entry.updatedAt) ? `Updated ${format.ago(entry.updatedAt, now)}` : null].filter(Boolean).join(' · '),
      installed: entry.installed,
      on: entry.on,
      stateLabel: entry.installed ? (entry.on ? 'On' : 'Off') : null,
    }
  }

  function names(list) {
    return Array.isArray(list) ? list.map((item) => (item && typeof item === 'object' ? str(item.name) : str(item))).filter(Boolean) : []
  }

  return {
    async list(params) {
      const now = Date.now()
      const { markets, entries } = await load()
      const search = (params.get('q') || '').trim().toLowerCase()
      const category = params.get('category') || ''
      const sort = SORTS.has(params.get('sort')) ? params.get('sort') : 'installs'
      const counts = new Map()
      for (const entry of entries) if (entry.category) counts.set(entry.category, (counts.get(entry.category) || 0) + 1)
      const matches = entries.filter((entry) => (!category || entry.category === category) && (!search || [entry.name, entry.title, entry.description, entry.author, ...entry.keywords].some((value) => value.toLowerCase().includes(search))))
      const order = { installs: (a, b) => b.installs - a.installs, updated: (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0), name: (a, b) => a.title.localeCompare(b.title) }[sort]
      matches.sort((a, b) => order(a, b) || a.title.localeCompare(b.title))
      const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE))
      const page = Math.min(Math.max(1, parseInt(params.get('page'), 10) || 1), pages)
      return {
        status: 'ready',
        rows: matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((entry) => card(entry, now)),
        total: matches.length,
        page,
        pages,
        pageLabel: matches.length ? `Page ${page} of ${pages}, ${format.plural(matches.length, 'plugin', 'plugins')}` : '',
        summaryLabel: `${format.plural(entries.length, 'plugin', 'plugins')} in ${format.plural(markets.length, 'marketplace', 'marketplaces')}, ${format.count(entries.filter((entry) => entry.installed).length)} installed`,
        categories: [...counts].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, label: `${format.capitalize(key)} (${format.count(count)})` })),
        markets: markets.map((market) => ({ name: market.name, sourceLabel: market.sourceLabel, countLabel: format.plural(market.count, 'plugin', 'plugins'), updatedLabel: Number.isFinite(market.updatedAt) ? `Updated ${format.ago(market.updatedAt, now)}` : null })),
        busy: Boolean(running),
      }
    },
    async plugin(params) {
      const now = Date.now()
      const entry = (await load()).entries.find((item) => item.id === params.get('id'))
      if (!entry) return null
      const parts = entry.components
      return {
        ...card(entry, now),
        name: entry.name,
        author: entry.author,
        homepage: /^https?:\/\//.test(entry.homepage) ? entry.homepage : null,
        facts: [
          ['Marketplace', entry.marketplace],
          ['Version', entry.version || null],
          ['Category', entry.category ? format.capitalize(entry.category) : null],
          ['Installs', entry.installs ? format.count(entry.installs) : null],
          ['Always in context', entry.tokens ? `About ${format.tokens(entry.tokens)} tokens in every conversation` : null],
          ['License', entry.license || null],
        ].filter(([, value]) => value),
        groups: [
          ['Skills', names(parts.skills)],
          ['Commands', names(parts.commands)],
          ['Agents', names(parts.agents)],
        ].filter(([, list]) => list.length),
        keywords: entry.keywords,
      }
    },
    async act(body) {
      const action = str(body.action)
      if (running) throw fail(409, 'Claude Code is still busy with the last change. Try again in a moment.')
      let args
      if (PLUGIN_ACTIONS.has(action)) {
        const entry = (await load()).entries.find((item) => item.id === body.id)
        if (!entry) throw fail(404, 'This plugin is not in your marketplaces.')
        if (action !== 'install' && !entry.installed) throw fail(400, 'This plugin is not installed.')
        args = ['plugin', action, entry.id]
      } else if (action === 'marketplace-add') {
        const source = str(body.source).trim()
        if (!source || source.length > 500 || /\s/.test(source) || source.startsWith('-')) throw fail(400, 'Enter a GitHub repo like owner/repo, a URL, or a folder path.')
        args = ['plugin', 'marketplace', 'add', source]
      } else if (SOURCE_ACTIONS[action]) {
        const market = (await load()).markets.find((item) => item.name === body.name)
        if (!market) throw fail(404, 'This marketplace is not added in Claude Code.')
        args = ['plugin', 'marketplace', SOURCE_ACTIONS[action], market.name]
      } else throw fail(400, 'This action is not supported.')
      running = runClaude(args)
      try {
        const output = await running
        return { ok: true, message: `${DONE[action]}. It applies to new Claude Code sessions.`, output }
      } catch (error) {
        if (error.code === 'ENOENT') throw fail(500, 'Could not find the claude command.')
        throw fail(502, error.message)
      } finally {
        running = null
      }
    },
  }
}

module.exports = { createMarketplace }
