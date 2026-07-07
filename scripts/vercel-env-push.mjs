// Sobe as env vars de RUNTIME p/ a Vercel (via API, upsert). Uso: node --env-file=.env scripts/vercel-env-push.mjs
// Só sobe as que têm valor — as vazias (CNN_*/KOMMO_* ainda não preenchidas) são puladas; re-rode ao preencher.
const TOKEN = process.env.VERCEL_TOKEN
const PID = process.env.VERCEL_PROJECT_ID
const ORG = process.env.VERCEL_ORG_ID

// Vars que a LÓGICA (core.ts) usa em runtime. Tokens de plataforma (VERCEL/GITHUB/SUPABASE_ACCESS/CLOUDFLARE) NÃO entram.
const KEYS = [
  'DATABASE_URL', 'WEBHOOK_SECRET', 'CNN_WRITE_TARGET', 'WH1_ENABLED', 'WH2_ENABLED', 'KOMMO_SUBDOMAIN',
  'CNN_CID', 'CNN_BASIC_USER', 'CNN_BASIC_PASS', 'CNN_CID_PRODUCTION', 'CNN_BASIC_USER_PRODUCTION',
  'CNN_BASIC_PASS_PRODUCTION', 'KOMMO_ACCESS_TOKEN', 'KOMMO_CLIENT_SECRET',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
]
const body = KEYS.filter((k) => process.env[k]).map((k) => ({
  key: k, value: process.env[k], type: 'encrypted', target: ['production', 'preview', 'development'],
}))

const r = await fetch(`https://api.vercel.com/v10/projects/${PID}/env?teamId=${ORG}&upsert=true`, {
  method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})
const j = await r.json()
console.log('HTTP', r.status)
console.log('subidas:', body.map((b) => b.key).join(', '))
if (j.error) console.log('ERRO:', JSON.stringify(j.error))
else console.log('ok:', Array.isArray(j.created) ? j.created.length + ' criadas/atualizadas' : 'aplicado')
