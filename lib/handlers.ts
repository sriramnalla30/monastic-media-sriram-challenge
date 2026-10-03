// Web-standard (Request -> Response) handlers shared by the Vercel functions
// in /api and the tests. Keeping them here means the API and MCP tool run
// exactly the same code path as the web app.
import {
  DEFAULTS,
  FatigueInputError,
  flagFatiguedCreatives,
  flagFatiguedCreativesFromUrl,
  fetchCsvText,
  type FatigueReport,
  type Options,
} from './fatigue.js'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, mcp-session-id, mcp-protocol-version',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json', ...CORS } })

function errorResponse(err: unknown) {
  if (err instanceof FatigueInputError) return json({ error: err.message }, 400)
  console.error(err)
  return json({ error: 'Internal error' }, 500)
}

function optionsFrom(src: Record<string, unknown>): Options {
  const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v))
  return {
    dropThreshold: src.drop_threshold as number | string | undefined,
    minImpressions: num(src.min_impressions),
  }
}

/**
 * JSON API.
 *   GET  /api/flag?csv_url=...&drop_threshold=0.3
 *   POST /api/flag  {"csv_url": "...", "drop_threshold": 0.3}
 *   POST /api/flag?drop_threshold=0.3  with a text/csv body
 */
export async function handleFlag(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  try {
    const url = new URL(req.url)
    const query = Object.fromEntries(url.searchParams)

    if (req.method === 'GET') {
      if (!query.csv_url) {
        return json({
          usage: 'GET /api/flag?csv_url=<https url>&drop_threshold=0.3, or POST JSON {csv_url, drop_threshold}, or POST a text/csv body',
          defaults: DEFAULTS,
        })
      }
      return json(await flagFatiguedCreativesFromUrl(query.csv_url, optionsFrom(query)))
    }

    if (req.method === 'POST') {
      const type = req.headers.get('content-type') ?? ''
      if (type.includes('application/json')) {
        const body = (await req.json()) as Record<string, unknown>
        const opts = optionsFrom({ ...query, ...body })
        if (typeof body.csv === 'string') return json(flagFatiguedCreatives(body.csv, opts))
        if (typeof body.csv_url !== 'string') throw new FatigueInputError('Provide csv_url (or csv as a string)')
        return json(await flagFatiguedCreativesFromUrl(body.csv_url, opts))
      }
      return json(flagFatiguedCreatives(await req.text(), optionsFrom(query)))
    }

    return json({ error: 'Method not allowed' }, 405)
  } catch (err) {
    return errorResponse(err)
  }
}

/**
 * CSV proxy for the web app: GET /api/csv?url=...
 * Lets the browser load CSVs from hosts that don't send CORS headers.
 */
export async function handleCsvProxy(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  try {
    const target = new URL(req.url).searchParams.get('url') ?? ''
    const text = await fetchCsvText(target)
    return new Response(text, { headers: { 'content-type': 'text/csv; charset=utf-8', ...CORS } })
  } catch (err) {
    return errorResponse(err)
  }
}

// ---------------------------------------------------------------------------
// MCP server (Streamable HTTP transport, stateless, JSON responses only).
// Small enough to hand-roll, which keeps the function dependency-free.
// ---------------------------------------------------------------------------

const TOOL = {
  name: 'flag_fatigued_creatives',
  title: 'Flag fatigued Meta ad creatives',
  description:
    'Downloads a daily ad performance CSV (date, ad_id, creative_name, format, impressions, clicks, spend_inr) and flags creatives whose ' +
    'CTR over the last 7 days of the file has dropped by drop_threshold or more versus their baseline (first 7 days with impressions > 0). ' +
    'Creatives with fewer than 14 delivering days are "too new to judge"; under 5,000 impressions in the last 7 days is "not enough volume".',
  inputSchema: {
    type: 'object',
    properties: {
      csv_url: { type: 'string', description: 'Public http(s) URL of the CSV' },
      drop_threshold: { type: 'number', description: 'Fraction (0.3) or percent (30). Default 0.3', default: 0.3 },
      min_impressions: { type: 'number', description: 'Impressions floor for the last 7 days. Default 5000', default: 5000 },
      include_daily: { type: 'boolean', description: 'Include per-day series for each creative. Default false', default: false },
    },
    required: ['csv_url'],
  },
}

const SERVER_INFO = { name: 'creative-fatigue-flagger', version: '1.0.0' }
const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

interface RpcRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: Record<string, unknown>
}

const rpcResult = (id: RpcRequest['id'], result: unknown) => ({ jsonrpc: '2.0', id, result })
const rpcError = (id: RpcRequest['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

function compact(report: FatigueReport, includeDaily: boolean) {
  if (includeDaily) return report
  return { ...report, creatives: report.creatives.map(({ daily: _daily, ...rest }) => rest) }
}

async function dispatch(msg: RpcRequest): Promise<object | null> {
  const isNotification = msg.id === undefined
  switch (msg.method) {
    case 'initialize': {
      const requested = String(msg.params?.protocolVersion ?? '')
      return rpcResult(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'Call flag_fatigued_creatives with a csv_url to find Meta ad creatives whose CTR has fatigued.',
      })
    }
    case 'ping':
      return rpcResult(msg.id, {})
    case 'tools/list':
      return rpcResult(msg.id, { tools: [TOOL] })
    case 'tools/call': {
      const name = msg.params?.name
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      if (name !== TOOL.name) return rpcError(msg.id, -32602, `Unknown tool: ${String(name)}`)
      try {
        if (typeof args.csv_url !== 'string') throw new FatigueInputError('csv_url is required')
        const report = compact(await flagFatiguedCreativesFromUrl(args.csv_url, optionsFrom(args)), args.include_daily === true)
        return rpcResult(msg.id, {
          content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
          structuredContent: report,
        })
      } catch (err) {
        // Tool failures are reported in-band so the model can read and recover.
        const message = err instanceof Error ? err.message : String(err)
        return rpcResult(msg.id, { content: [{ type: 'text', text: `Error: ${message}` }], isError: true })
      }
    }
    default:
      if (isNotification) return null // e.g. notifications/initialized
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`)
  }
}

export async function handleMcp(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') {
    // Stateless server: no SSE stream to resume, so GET is not supported.
    return json({ error: 'This MCP endpoint accepts POST (Streamable HTTP, JSON responses).' }, 405)
  }
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json(rpcError(null, -32700, 'Parse error'), 400)
  }
  const messages = (Array.isArray(body) ? body : [body]) as RpcRequest[]
  const responses: object[] = []
  for (const m of messages) {
    if (!m || typeof m !== 'object' || typeof m.method !== 'string') {
      responses.push(rpcError(null, -32600, 'Invalid request'))
      continue
    }
    const r = await dispatch(m)
    if (r) responses.push(r)
  }
  if (responses.length === 0) return new Response(null, { status: 202, headers: CORS })
  return json(Array.isArray(body) ? responses : responses[0])
}
