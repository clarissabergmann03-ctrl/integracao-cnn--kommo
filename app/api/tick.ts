// O tick do cron (= o scheduled() do Worker). Chamado pelo Supabase pg_cron → pg_net
// a cada minuto (Fase 3). handleScheduled usa ctx.waitUntil; aqui coletamos as promises
// e aguardamos antes de responder (a função serverless precisa terminar o trabalho).
import { handleScheduled } from '../lib/core.js'
import { makeEnv } from '../lib/env.js'

const env = makeEnv()

async function runTick(req: Request): Promise<Response> {
  // Auth: só o pg_cron (com o secret) dispara. Fase 3 troca por Bearer do Vault.
  const auth = req.headers.get('authorization')
  if (auth !== process.env.WEBHOOK_SECRET && auth !== `Bearer ${process.env.WEBHOOK_SECRET}`) {
    return new Response('Unauthorized', { status: 401 })
  }
  const promises: Promise<unknown>[] = []
  const ctx = { waitUntil: (p: Promise<unknown>) => { promises.push(p) } }
  const event = { scheduledTime: Date.now(), cron: '* * * * *' }
  await handleScheduled(event as any, env, ctx as any)
  await Promise.allSettled(promises)
  return Response.json({ ok: true, ranAt: Date.now() })
}

export function GET(req: Request) { return runTick(req) }
export function POST(req: Request) { return runTick(req) }
