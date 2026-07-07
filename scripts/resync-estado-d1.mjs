// Re-sync do ESTADO vivo do D1 (Cloudflare) → Supabase, por UPSERT (ON CONFLICT DO UPDATE).
// Pré-requisito do cutover: garante que a Vercel herde o estado atual do CF e NÃO re-execute
// ações (re-enviar lembrete D-1, re-varrer cursor, re-refletir orçamento). Idempotente.
// Uso: node --env-file=.env scripts/resync-estado-d1.mjs
import postgres from 'postgres'

const ACCT = process.env.CLOUDFLARE_ACCOUNT_ID
const CFT  = process.env.CLOUDFLARE_API_TOKEN
const DBID = '158f672c-1589-439d-b550-8917f424c3ab' // kommo-cnn-db (wrangler.toml)
const sql = postgres(process.env.DIRECT_URL, { prepare: false })

// tabela → { pk: [...], cols: [...] }  (só as tabelas de ESTADO que afetam duplicação de ação)
const TABELAS = {
  cursores:         { pk: ['nome'],                     cols: ['nome','valor','atualizado_em'] },
  lembrete_d1:      { pk: ['chave'],                    cols: ['chave','lead_id_kommo','agenda_id_cnn','data_agendamento','grupo','pipeline_destino','etapa_destino','enviado_em'] },
  agenda_sync:      { pk: ['agenda_id_cnn'],            cols: ['agenda_id_cnn','lead_id_kommo','paciente_id_cnn','last_agendamento_ts','last_cnn_status','atualizado_em','origin'] },
  mapeamento:       { pk: ['paciente_id_cnn','grupo'],  cols: ['paciente_id_cnn','grupo','lead_id_kommo','telefone_norm','duplicata','criado_em','atualizado_em'] },
  orcamento_sync:   { pk: ['paciente_id_cnn'],          cols: ['paciente_id_cnn','lead_id_kommo','ultimo_status','ultima_etapa','updated_at'] },
  agendamento_sync: { pk: ['lead_id'],                  cols: ['lead_id','synced_ts','updated_at'] },
}

async function d1Query(sqlText) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCT}/d1/database/${DBID}/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CFT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql: sqlText }),
  })
  const j = await res.json()
  if (!j.success) throw new Error('D1: ' + JSON.stringify(j.errors))
  return j.result[0].results
}

function upsertSQL(table, cols, pk, rows) {
  const ph = [], params = []
  let n = 0
  for (const row of rows) {
    ph.push(`(${cols.map(() => `$${++n}`).join(',')})`)
    for (const c of cols) params.push(row[c] ?? null)
  }
  const setC = cols.filter((c) => !pk.includes(c)).map((c) => `${c}=excluded.${c}`).join(',')
  const q = `INSERT INTO ${table} (${cols.join(',')}) VALUES ${ph.join(',')} ON CONFLICT (${pk.join(',')}) DO UPDATE SET ${setC}`
  return { q, params }
}

for (const [table, { pk, cols }] of Object.entries(TABELAS)) {
  const order = pk.join(',')
  let offset = 0, total = 0
  while (true) {
    const rows = await d1Query(`SELECT ${cols.join(',')} FROM ${table} ORDER BY ${order} LIMIT 500 OFFSET ${offset}`)
    if (!rows.length) break
    // upsert em lotes de 200
    for (let i = 0; i < rows.length; i += 200) {
      const lote = rows.slice(i, i + 200)
      const { q, params } = upsertSQL(table, cols, pk, lote)
      await sql.unsafe(q, params)
    }
    total += rows.length
    offset += 500
    if (rows.length < 500) break
  }
  const [{ n }] = await sql.unsafe(`SELECT count(*)::int n FROM ${table}`)
  console.log(`${table.padEnd(18)} upserted=${String(total).padStart(5)}  total_supabase=${n}`)
}

await sql.end()
console.log('✔ re-sync de estado concluído')
