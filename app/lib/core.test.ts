// Gate de paridade: selftests in-code (puros) + 1 rota que toca o Postgres,
// tudo PELO roteador portado (handleFetch). Verdes = lógica + camada de dados portadas fiéis.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { handleFetch } from './core.ts'
import { makeEnv } from './env.ts'
import { sql } from './db.ts'

const env = makeEnv()
const SECRET = process.env.WEBHOOK_SECRET as string
const req = (path: string) => new Request('https://x' + path, { headers: { Authorization: SECRET } })

test('selftest logic → 52/52 (sem falhas)', async () => {
  const j: any = await (await handleFetch(req('/debug-selftest?mode=logic'), env)).json()
  console.log(`logic: ${j.passed}/${j.total} (failed ${j.failed})`)
  assert.equal(j.failed, 0); assert.equal(j.passed, j.total); assert.ok(j.total >= 52)
})

test('selftest fuzz → sem falhas', async () => {
  const j: any = await (await handleFetch(req('/debug-selftest?mode=fuzz'), env)).json()
  assert.equal(j.failed, 0)
})

test('selftest stress → sem falhas', async () => {
  const j: any = await (await handleFetch(req('/debug-selftest?mode=stress&n=200'), env)).json()
  assert.equal(j.failed, 0)
})

test('retry selftest → pass', async () => {
  const j: any = await (await handleFetch(req('/debug-retry-selftest'), env)).json()
  assert.equal(j.pass, true)
})

test('rota c/ DB: /debug-audit → 200 + estrutura (env.DB ↔ Postgres)', async () => {
  const r = await handleFetch(req('/debug-audit'), env)
  const j: any = await r.json()
  console.log(`audit: status=${r.status} mapeamento_total=${j.mapeamento_total} fila=${JSON.stringify(j.fila)}`)
  assert.equal(r.status, 200)
  assert.ok('mapeamento_total' in j && 'fila' in j && 'por_acao' in j)
})

after(async () => { await sql.end() })
