// Importa um dump SQLite (só INSERTs) no Postgres do Supabase (via DIRECT_URL :5432).
// Uso: node --env-file=.env scripts/import-dump.mjs <dump.sql>
import postgres from 'postgres'
import { readFileSync } from 'node:fs'

const sql = postgres(process.env.DIRECT_URL, { prepare: false })
const lines = readFileSync(process.argv[2], 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim().toUpperCase().startsWith('INSERT'))
console.log('INSERTs a aplicar:', lines.length)

try {
  await sql.unsafe(lines.join('\n')).simple() // simple protocol: vários statements num round-trip
  console.log('✔ import OK')
} catch (e) {
  console.log('✘ ERRO no import:', String(e?.message || e).slice(0, 300))
}

console.log('=== contagem no Postgres ===')
for (const t of ['mapeamento', 'agenda_sync', 'orcamento_sync', 'lembrete_d1', 'cursores', 'agendamento_sync']) {
  try { const r = await sql.unsafe(`select count(*)::int n from ${t}`); console.log(t.padEnd(18), r[0].n) }
  catch (e) { console.log(t.padEnd(18), 'ERR', String(e?.message || e).slice(0, 60)) }
}
await sql.end()
