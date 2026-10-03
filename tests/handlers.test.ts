import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { handleFlag, handleMcp } from '../lib/handlers.js'

const demo = readFileSync('public/demo-data.csv', 'utf8')

const rpc = (body: unknown) =>
  handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))

describe('JSON API', () => {
  it('flags a posted CSV body', async () => {
    const res = await handleFlag(new Request('http://x/api/flag?drop_threshold=30', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: demo }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.drop_threshold).toBe(0.3)
    expect([...body.flagged].sort()).toEqual(['DEMO-02', 'DEMO-08', 'DEMO-10'])
  })

  it('returns 400 with a readable message for bad input', async () => {
    const res = await handleFlag(new Request('http://x/api/flag?drop_threshold=500', { method: 'POST', body: demo }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/drop_threshold/)
  })

  it('shows usage on a bare GET', async () => {
    const res = await handleFlag(new Request('http://x/api/flag'))
    expect((await res.json()).usage).toBeTruthy()
  })
})

describe('MCP endpoint', () => {
  it('initializes and lists the tool', async () => {
    const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json()
    expect(init.result.protocolVersion).toBe('2025-06-18')
    expect(init.result.capabilities.tools).toBeDefined()

    const list = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()
    expect(list.result.tools[0].name).toBe('flag_fatigued_creatives')
  })

  it('accepts the initialized notification with 202', async () => {
    const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(res.status).toBe(202)
  })

  it('reports tool errors in-band', async () => {
    const res = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'flag_fatigued_creatives', arguments: { csv_url: 'not a url' } } })).json()
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toMatch(/valid URL/)
  })

  it('rejects unknown methods', async () => {
    const res = await (await rpc({ jsonrpc: '2.0', id: 4, method: 'nope' })).json()
    expect(res.error.code).toBe(-32601)
  })
})
