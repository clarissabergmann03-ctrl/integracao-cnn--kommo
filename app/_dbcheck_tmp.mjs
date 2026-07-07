import postgres from 'postgres'

const url = process.env.DATABASE_URL
const sql = postgres(url, { prepare: false, connect_timeout: 15, max: 1 })

async function main() {
  const out = {}
  try {
    try { out.cron_jobs = await sql`select jobid, jobname, schedule, active, command from cron.job order by jobid` }
    catch (e) { out.cron_jobs_error = String(e.message || e) }

    try { out.cron_runs = await sql`select jobid, status, return_message, start_time from cron.job_run_details order by start_time desc limit 5` }
    catch (e) { out.cron_runs_error = String(e.message || e) }

    out.extensions = await sql`select extname from pg_extension where extname in ('pg_cron','pg_net') order by extname`

    out.rls = await sql`
      select c.relname, c.relrowsecurity as rls_enabled,
        (select count(*) from pg_policies p where p.schemaname='public' and p.tablename=c.relname) as policies
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' order by c.relname`

    for (const t of ['mapeamento','agenda_sync','orcamento_sync','lembrete_d1','cursores','fila_trabalho','tick_log','auditoria']) {
      try { const r = await sql.unsafe(`select count(*)::int n from ${t}`); out[`count_${t}`] = r[0].n }
      catch (e) { out[`count_${t}`] = 'ERR ' + (e.message||e) }
    }

    try { out.last_ticks = await sql`select id, ts, ok, ms, gatilhos, fila_pendente from tick_log order by id desc limit 3` }
    catch (e) { out.last_ticks_error = String(e.message||e) }

    try { out.vault = await sql`select name from vault.secrets order by name` }
    catch (e) { out.vault_error = String(e.message||e) }
  } finally {
    console.log(JSON.stringify(out, (k,v)=> typeof v==='bigint'? Number(v): v, 2))
    await sql.end({ timeout: 5 })
  }
}
main().catch(e=>{ console.error('FATAL', e.message||e); process.exit(1) })
