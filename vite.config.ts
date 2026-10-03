import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// In `npm run dev`, serve /api/* with the same handlers Vercel runs in production,
// so the web app, JSON API and MCP endpoint can all be tried locally.
function localApi(): Plugin {
  return {
    name: 'local-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = req.url?.split('?')[0]
        const routes = ['/api/flag', '/api/mcp', '/api/csv']
        if (!path || !routes.includes(path)) return next()
        const { handleFlag, handleMcp, handleCsvProxy } = await server.ssrLoadModule('/lib/handlers.ts')
        const handler = { '/api/flag': handleFlag, '/api/mcp': handleMcp, '/api/csv': handleCsvProxy }[path]
        const chunks: Buffer[] = []
        for await (const c of req) chunks.push(c as Buffer)
        const request = new Request(`http://localhost${req.url}`, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
        })
        const response: Response = await handler(request)
        res.statusCode = response.status
        response.headers.forEach((v, k) => res.setHeader(k, v))
        res.end(Buffer.from(await response.arrayBuffer()))
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), localApi()],
})
