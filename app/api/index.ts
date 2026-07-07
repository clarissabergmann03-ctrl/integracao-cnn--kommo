// Roteador único (= o fetch() do Worker). vercel.json faz rewrite /(.*) → /api,
// então todos os ~50 paths caem aqui e handleFetch roteia (auth ?secret= / Authorization inclusas).
import { handleFetch } from '../lib/core.ts'
import { makeEnv } from '../lib/env.ts'

const env = makeEnv()
const route = (req: Request) => handleFetch(req, env)

export function GET(req: Request) { return route(req) }
export function POST(req: Request) { return route(req) }
export function PUT(req: Request) { return route(req) }
export function PATCH(req: Request) { return route(req) }
export function DELETE(req: Request) { return route(req) }
