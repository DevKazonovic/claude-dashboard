const fs = require('fs')
const path = require('path')
const format = require('./format')
const { createJsonCache, readdirSafe, statSafe } = require('./collector')
const { scanState } = require('./views')

const SYNCED_PREFIX = 'anthropic-skills'
const SYNCED_SOURCES = { anthropic: 'By Anthropic', 'anthropic-example': 'By Anthropic', custom: 'Uploaded to claude.ai', plugin: 'From a claude.ai plugin' }
const PARTS = [
  ['skills', 'skill', 'skills'],
  ['commands', 'command', 'commands'],
  ['agents', 'agent', 'agents'],
  ['hooks', 'hook', 'hooks'],
  ['servers', 'MCP server', 'MCP servers'],
]

function str(value) {
  return typeof value === 'string' ? value : ''
}

function list(value) {
  return typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

async function readText(file) {
  try {
    return await fs.promises.readFile(file, 'utf8')
  } catch {
    return ''
  }
}

function unquote(value) {
  if (/^".*"$/.test(value)) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  return /^'.*'$/.test(value) ? value.slice(1, -1).replace(/''/g, "'") : value
}

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const fields = {}
  if (!match) return fields
  const lines = match[1].split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[index])
    if (!pair) continue
    const more = []
    while (index + 1 < lines.length && /^\s+\S/.test(lines[index + 1])) more.push(lines[++index].trim())
    const value = pair[2].trim()
    fields[pair[1]] = /^[>|][+-]?$/.test(value) ? more.join(value.startsWith('|') ? '\n' : ' ') : unquote([value, ...more].join(' '))
  }
  return fields
}

async function skillsIn(dir) {
  const found = []
  for (const entry of await readdirSafe(dir)) {
    if (entry.name.startsWith('.') || entry.name === 'synced') continue
    const text = await readText(path.join(dir, entry.name, 'SKILL.md'))
    if (!text) continue
    const fields = frontmatter(text)
    found.push({ name: str(fields.name) || entry.name, description: str(fields.description) })
  }
  return found
}

async function skillsAt(dir) {
  const text = await readText(path.join(dir, 'SKILL.md'))
  if (!text) return skillsIn(dir)
  const fields = frontmatter(text)
  return [{ name: str(fields.name) || path.basename(dir), description: str(fields.description) }]
}

async function countMarkdown(target) {
  const stat = await statSafe(target)
  if (!stat) return 0
  if (!stat.isDirectory()) return target.endsWith('.md') ? 1 : 0
  let total = 0
  for (const entry of await readdirSafe(target)) {
    if (!entry.name.startsWith('.')) total += await countMarkdown(path.join(target, entry.name))
  }
  return total
}

function hookCount(config) {
  const events = config && config.hooks && typeof config.hooks === 'object' ? config.hooks : config
  let total = 0
  for (const groups of Object.values(events && typeof events === 'object' ? events : {})) {
    if (Array.isArray(groups)) for (const group of groups) total += group && Array.isArray(group.hooks) ? group.hooks.length : 0
  }
  return total
}

function serverCount(config) {
  const servers = config && config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : config
  return servers && typeof servers === 'object' && !Array.isArray(servers) ? Object.keys(servers).length : 0
}

async function configsOf(value, root, fallback, readJson) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return [value]
  const files = list(value)
  return Promise.all((files.length ? files.map((file) => path.resolve(root, file)) : [path.join(root, fallback)]).map((file) => readJson(file)))
}

async function partsOf(root, manifest, readJson) {
  const dirs = (field) => (list(manifest[field]).length ? [...new Set(list(manifest[field]).map((item) => path.resolve(root, item)))] : [path.join(root, field)])
  const skills = []
  for (const dir of dirs('skills')) skills.push(...(await skillsAt(dir)))
  let commands = 0
  for (const dir of dirs('commands')) commands += await countMarkdown(dir)
  let agents = 0
  for (const dir of dirs('agents')) agents += await countMarkdown(dir)
  const hooks = (await configsOf(manifest.hooks, root, path.join('hooks', 'hooks.json'), readJson)).reduce((total, config) => total + hookCount(config), 0)
  const servers = (await configsOf(manifest.mcpServers, root, '.mcp.json', readJson)).reduce((total, config) => total + serverCount(config), 0)
  return { skills, counts: { skills: skills.length, commands, agents, hooks, servers } }
}

function sourceLabel(name, market) {
  const source = market && market.source && typeof market.source === 'object' ? market.source : {}
  const where = str(source.repo) || str(source.url) || format.homePath(str(source.path)) || name
  return where ? `From ${where}` : 'Added by hand'
}

async function installedPlugins(configDir, readJson) {
  const registry = await readJson(path.join(configDir, 'plugins', 'installed_plugins.json'))
  const settings = (await readJson(path.join(configDir, 'settings.json'))) || {}
  const markets = (await readJson(path.join(configDir, 'plugins', 'known_marketplaces.json'))) || {}
  const enabled = settings.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : {}
  const plugins = []
  for (const [id, value] of Object.entries((registry && registry.plugins) || {})) {
    const installs = (Array.isArray(value) ? value : [value]).filter((item) => item && typeof item.installPath === 'string')
    const install = installs.find((item) => item.scope === 'user') || installs[0]
    if (!install) continue
    const at = id.lastIndexOf('@')
    const name = at > 0 ? id.slice(0, at) : id
    const marketName = at > 0 ? id.slice(at + 1) : ''
    const market = markets[marketName] && typeof markets[marketName] === 'object' ? markets[marketName] : null
    const listing = market && typeof market.installLocation === 'string' ? await readJson(path.join(market.installLocation, '.claude-plugin', 'marketplace.json')) : null
    const entry = listing && Array.isArray(listing.plugins) ? listing.plugins.find((item) => item && item.name === name) : null
    const manifest = { ...(entry || {}), ...((await readJson(path.join(install.installPath, '.claude-plugin', 'plugin.json'))) || {}) }
    const userScope = !install.scope || install.scope === 'user'
    plugins.push({
      id,
      name,
      description: str(manifest.description),
      on: userScope ? enabled[id] === true : null,
      sourceLabel: sourceLabel(marketName, market),
      version: str(manifest.version) || str(install.version),
      updatedAt: Date.parse(str(install.lastUpdated) || str(install.installedAt)),
      scopeLabel: userScope ? null : `For ${format.homePath(str(install.projectPath)) || 'one project'}`,
      parts: await partsOf(install.installPath, manifest, readJson),
    })
  }
  return plugins
}

async function syncedBuckets(configDir, kind, signed) {
  const root = path.join(configDir, kind, 'synced')
  const buckets = []
  for (const entry of await readdirSafe(root)) {
    if (!entry.isDirectory()) continue
    const [organization, key] = entry.name.split('_')
    const account = signed.find((item) => item.key === key && (!item.organization || item.organization === organization))
    if (account) buckets.push({ dir: path.join(root, entry.name), account })
  }
  return buckets
}

async function syncedPlugins(bucket, readJson) {
  const manifest = await readJson(path.join(bucket.dir, 'manifest.json'))
  const folders = (await readdirSafe(bucket.dir)).filter((entry) => entry.isDirectory())
  const plugins = []
  for (const plugin of manifest && Array.isArray(manifest.plugins) ? manifest.plugins : []) {
    const name = str(plugin && plugin.name)
    if (!name) continue
    const folder = folders.find((entry) => entry.name === `${name}~g${plugin.generation}`) || folders.find((entry) => entry.name === name || entry.name.startsWith(`${name}~`))
    const root = folder ? path.join(bucket.dir, folder.name) : null
    const pluginJson = (root && (await readJson(path.join(root, '.claude-plugin', 'plugin.json')))) || {}
    plugins.push({
      id: `${bucket.account.key}:${name}`,
      name,
      description: str(pluginJson.description) || str(plugin.description),
      on: null,
      sourceLabel: str(plugin.marketplaceName) ? `From ${plugin.marketplaceName}` : 'From claude.ai',
      version: str(pluginJson.version),
      updatedAt: Date.parse(str(plugin.updatedAt)),
      scopeLabel: null,
      parts: root ? await partsOf(root, pluginJson, readJson) : { skills: [], counts: {} },
      account: bucket.account,
    })
  }
  return plugins
}

function contextTokens(name, description) {
  return Math.ceil(`- ${name}: ${description}`.length / 4)
}

function versionLabel(version) {
  if (!version || version === 'unknown') return null
  if (/^\d+\.\d+/.test(version)) return `Version ${version}`
  return /^[0-9a-f]{7,40}$/i.test(version) ? `Commit ${version.slice(0, 7)}` : version
}

function partsLabel(counts) {
  return PARTS.filter(([key]) => counts[key]).map(([key, one, many]) => format.plural(counts[key], one, many)).join(' · ') || 'No skills, commands, agents, hooks or MCP servers'
}

function applyUses(skills, uses) {
  for (const skill of skills) Object.assign(skill, { uses: 0, lastUsedAt: 0 })
  for (const [name, use] of uses) {
    let targets = skills.filter((skill) => skill.key === name)
    if (!targets.length && !name.includes(':')) {
      const short = skills.filter((skill) => skill.name === name)
      if (new Set(short.map((skill) => skill.key)).size === 1) targets = short
    }
    for (const skill of targets) {
      skill.uses += use.count
      skill.lastUsedAt = Math.max(skill.lastUsedAt, use.lastAt)
    }
  }
}

function createExtensions(collector, accounts) {
  const readJson = createJsonCache()

  async function gather() {
    await collector.init()
    const signed = (await accounts.signedIn()).filter((account) => account.key)
    const dirs = collector.configDirs()
    const skills = []
    const plugins = []
    const seen = new Set()
    for (const dir of dirs) {
      const folder = dirs.length > 1 ? format.homePath(dir) : null
      for (const skill of await skillsIn(path.join(dir, 'skills'))) skills.push({ ...skill, key: skill.name, folder, sourceLabel: 'Your skill' })
      for (const plugin of await installedPlugins(dir, readJson)) {
        plugins.push({ ...plugin, folder })
        for (const skill of plugin.parts.skills) skills.push({ ...skill, key: `${plugin.name}:${skill.name}`, folder, off: plugin.on === false, sourceLabel: `Plugin ${plugin.name}` })
      }
      for (const bucket of await syncedBuckets(dir, 'skills', signed)) {
        const manifest = await readJson(path.join(bucket.dir, 'manifest.json'))
        for (const skill of manifest && Array.isArray(manifest.skills) ? manifest.skills : []) {
          const name = str(skill && skill.name)
          const key = `${SYNCED_PREFIX}:${name}`
          if (!name || seen.has(`${bucket.account.key}:${key}`)) continue
          seen.add(`${bucket.account.key}:${key}`)
          skills.push({ name, description: str(skill.description), key, account: bucket.account, sourceLabel: SYNCED_SOURCES[skill.source] || 'From claude.ai' })
        }
      }
      for (const bucket of await syncedBuckets(dir, 'plugins', signed)) {
        for (const plugin of await syncedPlugins(bucket, readJson)) {
          if (seen.has(plugin.id)) continue
          seen.add(plugin.id)
          plugins.push(plugin)
          for (const skill of plugin.parts.skills) skills.push({ ...skill, key: `${plugin.name}:${skill.name}`, account: bucket.account, sourceLabel: `Plugin ${plugin.name}` })
        }
      }
    }
    return { signed, skills, plugins }
  }

  async function uses() {
    const seen = new Map()
    for (const { loaded } of await collector.all()) {
      for (const transcript of [loaded.main, ...loaded.agents.map((agent) => agent.state)]) {
        if (!transcript) continue
        for (const [id, use] of transcript.data.skillUses) if (!seen.has(id)) seen.set(id, use)
      }
    }
    const byName = new Map()
    for (const use of seen.values()) {
      const entry = byName.get(use.name) || { count: 0, lastAt: 0 }
      entry.count += 1
      if (Number.isFinite(use.at) && use.at > entry.lastAt) entry.lastAt = use.at
      byName.set(use.name, entry)
    }
    return byName
  }

  function scope(data, params) {
    const wanted = params.get('account')
    const account = data.signed.some((item) => item.key === wanted) ? wanted : null
    return {
      account,
      accounts: data.signed.length > 1 ? data.signed.map((item) => ({ key: item.key, label: item.email })) : [],
      hasAccounts: data.signed.length > 0,
      several: data.signed.length > 1,
      keep: (item) => !account || item.account.key === account,
    }
  }

  return {
    async skills(params) {
      const waiting = await scanState(collector)
      if (waiting) return waiting
      const now = Date.now()
      const data = await gather()
      applyUses(data.skills, await uses())
      const view = scope(data, params)
      const row = (skill) => {
        const tokens = contextTokens(skill.name, skill.description)
        return {
          name: skill.name,
          description: skill.description,
          sourceLabel: [skill.sourceLabel, skill.folder, view.several && skill.account ? skill.account.email : null].filter(Boolean).join(' · '),
          off: Boolean(skill.off),
          usesLabel: format.count(skill.uses),
          lastUsedLabel: skill.lastUsedAt ? format.capitalize(format.ago(skill.lastUsedAt, now)) : 'Never',
          tokens,
          tokensLabel: `~${format.tokens(tokens)}`,
        }
      }
      const order = (a, b) => b.uses - a.uses || b.lastUsedAt - a.lastUsedAt || a.name.localeCompare(b.name)
      const local = data.skills.filter((skill) => !skill.account).sort(order).map(row)
      const synced = data.skills.filter((skill) => skill.account && view.keep(skill)).sort(order).map(row)
      const loaded = [...local, ...synced].filter((skill) => !skill.off)
      return {
        status: 'ready',
        account: view.account,
        accounts: view.accounts,
        hasAccounts: view.hasAccounts,
        local,
        synced,
        summaryLabel: loaded.length ? `${format.plural(loaded.length, 'skill is', 'skills are')} on. Their names and descriptions add up to about ${format.tokens(loaded.reduce((total, skill) => total + skill.tokens, 0))} tokens.` : '',
      }
    },
    async plugins(params) {
      const now = Date.now()
      const data = await gather()
      const view = scope(data, params)
      const row = (plugin) => ({
        name: plugin.name,
        description: plugin.description,
        on: plugin.on,
        statusLabel: plugin.on === true ? 'On' : plugin.on === false ? 'Off' : null,
        partsLabel: partsLabel(plugin.parts.counts),
        metaLabel: [
          plugin.sourceLabel,
          versionLabel(plugin.version),
          Number.isFinite(plugin.updatedAt) ? `Updated ${format.ago(plugin.updatedAt, now)}` : null,
          plugin.scopeLabel,
          plugin.folder,
          view.several && plugin.account ? plugin.account.email : null,
        ]
          .filter(Boolean)
          .join(' · '),
      })
      const byName = (a, b) => a.name.localeCompare(b.name)
      const local = data.plugins.filter((plugin) => !plugin.account).sort(byName).map(row)
      const synced = data.plugins.filter((plugin) => plugin.account && view.keep(plugin)).sort(byName).map(row)
      const on = local.filter((plugin) => plugin.on).length
      return {
        status: 'ready',
        account: view.account,
        accounts: view.accounts,
        hasAccounts: view.hasAccounts,
        local,
        synced,
        summaryLabel: [local.length ? `${format.plural(local.length, 'plugin', 'plugins')} installed, ${format.count(on)} on` : null, synced.length ? `${format.count(synced.length)} synced from claude.ai` : null].filter(Boolean).join(' · '),
      }
    },
  }
}

module.exports = { createExtensions }
