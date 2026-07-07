const TOKEN = process.env.VERCEL_TOKEN
const PID = process.env.VERCEL_PROJECT_ID
const ORG = process.env.VERCEL_ORG_ID
const H = { Authorization: `Bearer ${TOKEN}` }
const out = {}

async function j(url, opts={}) {
  const r = await fetch(url, { headers: H, ...opts })
  const t = await r.text()
  try { return { status: r.status, body: JSON.parse(t) } } catch { return { status: r.status, body: t.slice(0,300) } }
}

// 1. Project: production alias/domains + latest deployment target
const proj = await j(`https://api.vercel.com/v9/projects/${PID}?teamId=${ORG}`)
out.project_name = proj.body?.name
out.production_alias = proj.body?.targets?.production?.alias || proj.body?.alias
out.prod_deploy = proj.body?.targets?.production ? {
  url: proj.body.targets.production.alias || proj.body.targets.production.url,
  readyState: proj.body.targets.production.readyState,
  createdAt: proj.body.targets.production.createdAt,
} : null

// 2. Deployments list (target + state)
const deps = await j(`https://api.vercel.com/v6/deployments?projectId=${PID}&teamId=${ORG}&limit=8`)
out.deployments = (deps.body?.deployments||[]).map(d => ({ url: d.url, target: d.target, state: d.readyState || d.state, created: new Date(d.created).toISOString() }))

// 3. Env var keys configured in Vercel (which targets) — no values
const env = await j(`https://api.vercel.com/v10/projects/${PID}/env?teamId=${ORG}`)
out.env_keys = (env.body?.envs||[]).map(e => ({ key: e.key, target: e.target, type: e.type, id: e.id }))

// 4. Try to decrypt KOMMO_ACCESS_TOKEN (to test webhook listing later)
const kommo = (env.body?.envs||[]).find(e => e.key === 'KOMMO_ACCESS_TOKEN')
if (kommo) {
  const dec = await j(`https://api.vercel.com/v9/projects/${PID}/env/${kommo.id}?teamId=${ORG}&decrypt=true`)
  out.kommo_token_present = !!(dec.body?.value)
  out.kommo_token_len = dec.body?.value ? String(dec.body.value).length : 0
  globalThis.__KOMMO = dec.body?.value || ''
} else {
  out.kommo_token_present = false
  out.kommo_token_note = 'KOMMO_ACCESS_TOKEN not configured as Vercel env var'
}

console.log(JSON.stringify(out, null, 2))
