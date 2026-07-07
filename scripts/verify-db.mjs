// Verificação da fundação Postgres. Uso: node --env-file=.env scripts/verify-db.mjs
import postgres from 'postgres'

const TABELAS = ['agendamento_sync','cursores','mapeamento','agenda_sync','lembrete_d1','auditoria','fila_trabalho','orcamento_sync','tick_log']

async function tentar(nome, url) {
  const sql = postgres(url, { prepare: false, connect_timeout: 10, max: 1 })
  try {
    const t = await sql`select table_name from information_schema.tables where table_schema='public' and table_name = any(${TABELAS})`
    const e = await sql`select extname from pg_extension where extname in ('pg_cron','pg_net') order by extname`
    const pk = await sql`select string_agg(a.attname, ',' order by array_position(i.indkey, a.attnum)) pk from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey) where i.indrelid='mapeamento'::regclass and i.indisprimary`
    console.log(`[${nome}] OK — tabelas ${t.length}/9 | extensoes: ${e.map(x=>x.extname).join(',')||'nenhuma'} | mapeamento.pk: ${pk[0]?.pk}`)
    const faltando = TABELAS.filter(x => !t.find(r => r.table_name === x))
    if (faltando.length) console.log(`[${nome}] FALTANDO: ${faltando.join(', ')}`)
    return true
  } catch (err) {
    console.log(`[${nome}] FALHOU: ${err.message}`)
    return false
  } finally { await sql.end({ timeout: 5 }) }
}

const okPool = await tentar('pooler:6543', process.env.DATABASE_URL)
if (!okPool) {
  // tenta host alternativo do pooler (aws-1) e a conexão direta como diagnóstico
  const alt = process.env.DATABASE_URL.replace('aws-0-', 'aws-1-')
  await tentar('pooler-aws1', alt)
  await tentar('direct:5432', process.env.DIRECT_URL)
}
