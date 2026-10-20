const PER_MILLION = 1e6
const CACHE_WRITE_5M = 1.25
const CACHE_WRITE_1H = 2
const WEB_SEARCH_USD = 0.01

const MODELS = [
  { id: 'claude-fable-5-1', input: 10, output: 50, cacheRead: 0.25 },
  { id: 'claude-mythos-5-1', input: 10, output: 50, cacheRead: 0.25 },
  { id: 'claude-fable-5', input: 10, output: 50, cacheRead: 1 },
  { id: 'claude-mythos-5', input: 10, output: 50, cacheRead: 1 },
  { id: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.2, fast: 2 },
  { id: 'claude-opus-5', input: 5, output: 25, cacheRead: 0.5, fast: 2 },
  { id: 'claude-opus-4-8', input: 5, output: 25, cacheRead: 0.5 },
  { id: 'claude-opus-4-7', input: 5, output: 25, cacheRead: 0.5 },
  { id: 'claude-opus-4-6', input: 5, output: 25, cacheRead: 0.5 },
  { id: 'claude-opus-4-5', input: 5, output: 25, cacheRead: 0.5 },
  { id: 'claude-opus-4-1', input: 15, output: 75, cacheRead: 1.5 },
  { id: 'claude-opus-4', input: 15, output: 75, cacheRead: 1.5 },
  { id: 'claude-sonnet-5-5', input: 2, output: 10, cacheRead: 0.2 },
  { id: 'claude-sonnet-5', input: 2, output: 10, cacheRead: 0.2 },
  { id: 'claude-sonnet-4-6', input: 3, output: 15, cacheRead: 0.3 },
  { id: 'claude-sonnet-4-5', input: 3, output: 15, cacheRead: 0.3, long: { above: 200000, input: 6, output: 22.5, cacheRead: 0.6 } },
  { id: 'claude-sonnet-4', input: 3, output: 15, cacheRead: 0.3, long: { above: 200000, input: 6, output: 22.5, cacheRead: 0.6 } },
  { id: 'claude-3-7-sonnet', input: 3, output: 15, cacheRead: 0.3 },
  { id: 'claude-3-5-sonnet', input: 3, output: 15, cacheRead: 0.3 },
  { id: 'claude-haiku-5-5', input: 0.1, output: 0.5, cacheRead: 0.01, long: { above: 100000, input: 0.5, output: 2.5, cacheRead: 0.05 } },
  { id: 'claude-haiku-4-5', input: 1, output: 5, cacheRead: 0.1 },
  { id: 'claude-3-5-haiku', input: 0.8, output: 4, cacheRead: 0.08 },
  { id: 'claude-3-opus', input: 15, output: 75, cacheRead: 1.5 },
  { id: 'claude-3-haiku', input: 0.25, output: 1.25, cacheRead: 0.03 },
].sort((a, b) => b.id.length - a.id.length)

function normalizeModel(model) {
  return String(model || '').toLowerCase().replace(/\[.*\]$/, '').trim()
}

function findPrice(model) {
  const id = normalizeModel(model)
  return MODELS.find((entry) => id === entry.id || id.startsWith(`${entry.id}-`)) || null
}

function cacheWriteSplit(usage) {
  const cacheWrite = usage.cache_creation_input_tokens || 0
  const split = usage.cache_creation || {}
  const write1h = split.ephemeral_1h_input_tokens || 0
  const write5m = split.ephemeral_5m_input_tokens != null ? split.ephemeral_5m_input_tokens : Math.max(cacheWrite - write1h, 0)
  return { write5m, write1h }
}

function costParts(model, usage) {
  const price = findPrice(model)
  if (!price) return null
  const input = usage.input_tokens || 0
  const output = usage.output_tokens || 0
  const cacheRead = usage.cache_read_input_tokens || 0
  const cacheWrite = usage.cache_creation_input_tokens || 0
  const { write5m, write1h } = cacheWriteSplit(usage)
  const tier = price.long && input + cacheRead + cacheWrite > price.long.above ? price.long : price
  const rate = (usage.speed === 'fast' && price.fast ? price.fast : 1) / PER_MILLION
  const searches = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0
  const parts = {
    input: input * tier.input * rate,
    output: output * tier.output * rate,
    cacheRead: cacheRead * tier.cacheRead * rate,
    cacheWrite: (write5m * tier.input * CACHE_WRITE_5M + write1h * tier.input * CACHE_WRITE_1H) * rate,
    search: searches * WEB_SEARCH_USD,
  }
  parts.total = parts.input + parts.output + parts.cacheRead + parts.cacheWrite + parts.search
  return parts
}

function messageCost(model, usage) {
  const parts = costParts(model, usage)
  return parts ? parts.total : null
}

module.exports = { messageCost, costParts, cacheWriteSplit, findPrice, normalizeModel }
