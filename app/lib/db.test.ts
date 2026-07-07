import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { DB, sql } from './db.js'

test('insert + first + all + placeholders ?→$n', async () => {
  const now = Math.floor(Date.now() / 1000)
  await DB.prepare('INSERT INTO cursores (nome,valor,atualizado_em) VALUES (?,?,?) ON CONFLICT(nome) DO UPDATE SET valor=excluded.valor')
    .bind('t_dbtest', 'v1', now).run()
  const row = await DB.prepare('SELECT valor FROM cursores WHERE nome = ?').bind('t_dbtest').first<{ valor: string }>()
  assert.equal(row?.valor, 'v1')
  const many = await DB.prepare('SELECT nome FROM cursores WHERE nome = ?').bind('t_dbtest').all<{ nome: string }>()
  assert.equal(many.results.length, 1)
})

test('batch em transacao (ON CONFLICT DO UPDATE)', async () => {
  const now = Math.floor(Date.now() / 1000)
  await DB.batch([
    DB.prepare('INSERT INTO cursores (nome,valor,atualizado_em) VALUES (?,?,?) ON CONFLICT(nome) DO UPDATE SET valor=excluded.valor').bind('t_b1', 'x', now),
    DB.prepare('INSERT INTO cursores (nome,valor,atualizado_em) VALUES (?,?,?) ON CONFLICT(nome) DO UPDATE SET valor=excluded.valor').bind('t_b2', 'y', now),
  ])
  const r = await DB.prepare("SELECT count(*)::int n FROM cursores WHERE nome IN ('t_b1','t_b2')").first<{ n: number }>()
  assert.equal(r?.n, 2)
})

test('claim atomico FOR UPDATE SKIP LOCKED + RETURNING', async () => {
  const now = Math.floor(Date.now() / 1000)
  await DB.prepare("INSERT INTO fila_trabalho (chave,tipo,status,criado_em,atualizado_em) VALUES (?, 'A3','pendente',?,?) ON CONFLICT(chave) DO NOTHING").bind('t_claim', now, now).run()
  const claimed = await DB.prepare(
    `UPDATE fila_trabalho SET status='processing', locked_at=?, tentativas=tentativas+1, atualizado_em=?
       WHERE id IN (SELECT id FROM fila_trabalho WHERE chave='t_claim' AND status='pendente' FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id, tentativas`
  ).bind(now, now).all<{ id: number; tentativas: number }>()
  assert.equal(claimed.results.length, 1)
  assert.equal(claimed.results[0].tentativas, 1)
})

after(async () => {
  await DB.prepare("DELETE FROM fila_trabalho WHERE chave='t_claim'").run()
  await DB.prepare("DELETE FROM cursores WHERE nome IN ('t_dbtest','t_b1','t_b2')").run()
  await sql.end()
})
