// Liga o pg_cron do Supabase → chama /api/tick da Vercel a cada minuto (Vault + pg_net).
// Uso: node --env-file=.env scripts/setup-pgcron.mjs   |   rollback: select cron.unschedule('kommo-cnn-tick');
import postgres from 'postgres'
const sql = postgres(process.env.DIRECT_URL, { prepare: false })
const TICK_URL = 'https://kommo-cnn.vercel.app/api/tick'
const SECRET = process.env.WEBHOOK_SECRET

for (const [val, name] of [[SECRET, 'kommo_cnn_webhook_secret'], [TICK_URL, 'kommo_cnn_tick_url']]) {
  try { await sql`select vault.create_secret(${val}, ${name})`; console.log('vault secret criado:', name) }
  catch (e) { console.log('vault secret (ja existe/erro):', name, '-', String(e?.message || e).slice(0, 90)) }
}

await sql.unsafe(`select cron.schedule('kommo-cnn-tick', '* * * * *', $CRON$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'kommo_cnn_tick_url'),
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', (select decrypted_secret from vault.decrypted_secrets where name = 'kommo_cnn_webhook_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000);
$CRON$)`)

const jobs = await sql`select jobid, jobname, schedule, active from cron.job where jobname = 'kommo-cnn-tick'`
console.log('cron.job:', JSON.stringify(jobs))
await sql.end()
console.log('OK — pg_cron ligado (kommo-cnn-tick, cada minuto)')
