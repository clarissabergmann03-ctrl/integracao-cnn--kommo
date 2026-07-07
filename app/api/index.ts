// Roteador único da app (= o fetch() do Cloudflare Worker). vercel.json faz
// rewrite de /(.*) → /api, então todos os paths caem aqui. Web handlers nomeados
// por método (GET/POST/...) recebem uma Request web e retornam Response — o mesmo
// modelo do Worker, o que torna o porte da lógica (Fase 2) quase 1:1.
// Por ora só /health; os ~50 paths entram na Fase 2.

async function route(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url)
  if (pathname === '/health' || pathname === '/api' || pathname === '/api/health') {
    return Response.json({ ok: true, ts: Date.now(), stack: 'github+vercel+supabase' })
  }
  return new Response('Not found', { status: 404 })
}

export function GET(req: Request) { return route(req) }
export function POST(req: Request) { return route(req) }
export function PUT(req: Request) { return route(req) }
export function PATCH(req: Request) { return route(req) }
export function DELETE(req: Request) { return route(req) }
