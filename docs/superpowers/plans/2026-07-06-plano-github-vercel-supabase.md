# Plano de Implementação — kommo-cnn na stack GitHub + Vercel + Supabase

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development ou superpowers:executing-plans, task-a-task. Steps usam checkbox `- [ ]`.
> **Substitui** a orientação anterior de "lógica em Supabase Edge Functions" (spec `2026-07-06-migracao-cf-worker-para-supabase-edge-design.md` e plano `…-fase1-fundacao-supabase.md`). A **lógica agora roda na Vercel**; o Supabase é banco + cron.

**Goal:** Reimplementar as MESMAS funções do Worker `kommo-cnn` na stack GitHub + Vercel + Supabase, com paridade funcional e otimizações que a nova plataforma habilita (fim do teto de 50 subrequests, funções de ~60s, deploy contínuo).

**Architecture:** **Vercel Functions (Node)** hospedam toda a lógica (webhooks + endpoints + o "tick"); **Supabase Postgres** é o banco; **Supabase Cron (pg_cron+pg_net)** dispara `/api/tick` da Vercel a cada minuto (a Vercel Hobby não faz cron sub-diário); **GitHub** versiona e faz deploy contínuo na Vercel.

**Tech Stack:** TypeScript, Node 20, Vercel Functions (Fluid Compute), `postgres.js` (Supavisor pooler), Supabase (Postgres, pg_cron, pg_net, Vault), Supabase CLI (migrations), Vercel CLI, GitHub (`gh`).

## Global Constraints

- **Paridade primeiro, otimização depois:** portar as ~150 funções e ~50 rotas com comportamento idêntico; os selftests in-code (`/debug-selftest` = 52/52, `/debug-retry-selftest`) são o critério de aceite. Otimizações entram como passos explícitos e verificáveis, nunca "de brinde".
- **Runtime Node (NÃO Edge):** o código faz SQL raw via TCP (postgres.js) e muitas chamadas HTTP → Node runtime. Edge não tem TCP nativo.
- **Postgres via pooler:** `DATABASE_URL` = Supavisor transaction mode **:6543**, `postgres(url, { prepare: false })`; `DIRECT_URL` **:5432** só para migrations. Fluid Compute + `attachDatabasePool`/`waitUntil` p/ conexões serverless.
- **Cron:** `pg_cron` + `pg_net` no Supabase → `net.http_post` para `https://<app>.vercel.app/api/tick`; token do tick no **Supabase Vault** (não hardcode).
- **Uso comercial:** Vercel **Hobby proíbe uso comercial** → produção exige **Vercel Pro (~US$20/mês)**; Hobby só para POC/teste. Supabase free permite comercial. Registrar a escolha antes do go-live.
- **§7.8 preservado:** o guardrail de escrita CNN (`cnnProducaoPermitido`/`assertCnnWritable`) porta sem alteração.
- **Segredos:** `.env` gitignored; na Vercel via `vercel env` / dashboard; tokens já no `.env` — `VERCEL_TOKEN`, `GITHUB_TOKEN`, `SUPABASE_ACCESS_TOKEN`, `CLOUDFLARE_API_TOKEN`.
- **Schema:** só as **9 tabelas operacionais** (mig_*/backfill_hist ficam de fora — staging one-time concluído).
- **Região:** Supabase `sa-east-1` (SP).

---

## 1. Arquitetura e responsabilidades

```
  ┌── GitHub (repo kommo-cnn) ──┐   push
  │  código + migrations       │───────────► Vercel (deploy contínuo)
  └─────────────────────────────┘             │  api/index.ts  (roteador = o fetch() do Worker)
                                               │    /webhook/*  (Kommo → CNN)
  Kommo ──webhook POST──────────────────────► │    /api/tick   (o scheduled() do Worker)
  CNN   ◄── lê / escreve (allowlist §7.8) ─────┤    /debug-*    (observabilidade)
                                               │        │ postgres.js (Supavisor :6543, prepare:false)
                                               ▼        ▼
                              Supabase Postgres (9 tabelas)  +  pg_cron '* * * * *'
                                                        └── net.http_post → …/api/tick (Bearer via Vault)
```

| Plataforma | Responsabilidade |
|---|---|
| **GitHub** | Repositório + fonte da verdade do código; integração de deploy com a Vercel (push → build/deploy). Opcional: Actions para lint/test. |
| **Vercel** | Hospeda TODA a lógica (Vercel Functions Node). Recebe webhooks do Kommo e o tick do pg_cron. Fala com CNN/Kommo. Deploy contínuo. Env vars/secrets. |
| **Supabase** | Postgres (estado + fila). pg_cron/pg_net (gatilho de 1 min → Vercel). Vault (token do tick). Migrations via CLI. |

---

## 2. Decisões-chave

1. **Node runtime + função roteadora única.** `api/index.ts` replica o `switch` de rotas do `fetch()` do Worker; `vercel.json` faz rewrite de `/(.*)` → `/api`. Porte 1:1 do roteador, mínimo de reescrita. `env` interno = `process.env` (as funções continuam recebendo `env`).
2. **Camada de dados = shim `DB` (postgres.js).** Mesma API do `env.DB` (`prepare/bind/run/first/all/batch`), converte `?`→`$n`. Conexão via pooler `:6543` `prepare:false`. Uma peça isola toda a mudança de banco.
3. **Cron fora do runtime.** pg_cron no Postgres chama `/api/tick`. O tick não depende do cron da Vercel (que no Hobby é só diário).
4. **Deploy contínuo GitHub→Vercel** substitui o `wrangler deploy` (que sofria com o token IP-restrito). Migrations do banco via `supabase db push` (CI ou local).
5. **Comercial:** produção em **Vercel Pro**; POC pode ser Hobby. Decisão do dono antes do go-live.

---

## 3. Otimizações (o "otimizar o sistema")

Habilitadas por sair do teto de 50 subrequests e ganhar ~60s por invocação:

| Hoje (CF Free) | Depois (Vercel+Supabase) | Ganho |
|---|---|---|
| `subreqUsados`/`orcamentoOk` limitam a ~40 fetch/tick | **Removidos**; budget vira por-tempo (maxDuration) | menos código, menos "adiado por budget" |
| Lote de ~10 itens/tick; fila drena devagar | **Lote grande** (ex.: 100+) ou drenar a fila até esvaziar dentro de ~60s | backlog some rápido (fim do ORC "adiado" acumulando) |
| Micro-ticks a cada minuto p/ diluir carga | Tick "gordo": 1 minuto ainda, mas faz muito mais por passada | menos invocações desperdiçadas |
| Claim via `UPDATE…RETURNING` (dependia do single-writer do D1) | **`FOR UPDATE SKIP LOCKED`** | concorrência real; permite paralelizar drenos |
| Processamento estritamente sequencial | **Paralelismo controlado** sob o throttle Kommo (7 req/s) — `Promise.all` em janelas | menor wall-clock por tick |
| Conexões novas por request | **Supavisor pooler** + Fluid Compute `attachDatabasePool` | sem esgotar conexões |
| Deploy manual (`wrangler`, token IP-restrito) | **CI/CD GitHub→Vercel** | fim da dor operacional de deploy |
| Fila artesanal em D1 | (opcional, fase futura) **pgmq / Supabase Queues** | fila nativa durável — avaliar depois, não no porte 1:1 |

> Regra: cada otimização acima é um passo **separado e verificável** na Fase 2/3 — nunca misturada com o porte 1:1. Primeiro paridade (selftests verdes), depois otimizar com os selftests ainda verdes.

---

## 4. Paridade funcional — como as MESMAS funções migram

Detalhe completo por bloco no spec (`…-supabase-edge-design.md` §4) — **o de-para de função continua válido**; só muda o HOST (Vercel Node em vez de Deno Edge). Resumo do que muda no porte:

- **Lógica pura** (decisão de orçamento, roteamento por tipo, phoneKey, anti-loop, classificação, selftests): **zero mudança**.
- **Wrappers CNN/Kommo** (`fetch`): iguais; remove `bumpSubreq`. `btoa` → usar `Buffer.from(s).toString('base64')` (Node) num helper `b64()`.
- **Camada de dados** (tudo que usa `env.DB`): troca por `import { DB } from '../lib/db'` — API idêntica.
- **`export default { fetch, scheduled }`**: `fetch` → `api/index.ts` (roteador); `scheduled` → `api/tick.ts`; `ctx.waitUntil` → `waitUntil` do `@vercel/functions` (ou await direto).
- **Ajustes 🔴 pontuais:** `filaClaimLote`→`FOR UPDATE SKIP LOCKED`; lease→`pg_try_advisory_lock`; `INSERT OR IGNORE`→`ON CONFLICT DO NOTHING`; `INSERT OR REPLACE`→`ON CONFLICT DO UPDATE`. `PRAGMA`/`sqlite_master` só aparecem no bloco `mig_*` (não portado).
- **Rotas (~50):** todas atendidas pela função roteadora; auth (`?secret=` e header `Authorization`) idêntica.

---

## 5. Estrutura de arquivos (repo alvo)

```
kommo-cnn/
  api/
    index.ts              # roteador (= o fetch() do Worker); rewrite /(.*) → /api
    tick.ts               # = o scheduled(): produtores + consumirFila (chamado pelo pg_cron)
  lib/
    env.ts                # monta `env` a partir de process.env (assinaturas das funções não mudam)
    db.ts                 # shim DB (postgres.js, pooler, prepare:false)
    cnn.ts kommo.ts       # wrappers HTTP (§7.8 preservado)
    logic.ts              # produtores/consumidores/funções puras (o miolo portado)
    selftest.ts           # runSelftestLogic/Fuzz/Stress/retry (gate)
  supabase/
    migrations/
      0001_extensions.sql       # pg_cron + pg_net
      0002_schema_operacional.sql
      0003_cron.sql             # cron.schedule → /api/tick (Fase 3)
  vercel.json             # maxDuration + rewrites
  package.json tsconfig.json
  (raiz antiga src/index.ts fica como referência até o cutover)
```

`vercel.json`:
```json
{
  "functions": { "api/**/*.ts": { "maxDuration": 60 } },
  "rewrites": [{ "source": "/(.*)", "destination": "/api" }]
}
```

---

## 6. Fases de implementação

### FASE 1 — Fundação (detalhada)

#### Task 1: Versionar no GitHub
- [ ] **Step 1:** `cd /d/clarissa-bergmann/kommo-cnn && git init && git add -A`
- [ ] **Step 2:** verificar segredo fora do staging: `git status --porcelain | grep -E '\.env$' || echo OK`  → Expected: `OK`
- [ ] **Step 3:** `git commit -m "chore: baseline kommo-cnn (pré-migração)"`
- [ ] **Step 4:** `export GH_TOKEN="$(grep '^GITHUB_TOKEN=' .env | cut -d= -f2)" && gh repo create kommo-cnn --private --source=. --remote=origin --push`  → Expected: repo privado criado + push
- [ ] **Step 5:** `gh api repos/{owner}/kommo-cnn/contents/.env 2>&1 | grep -q "Not Found" && echo "OK: .env fora do repo"`

#### Task 2: Projeto Node + Vercel
- [ ] **Step 1:** criar `package.json` (`npm init -y`), instalar deps: `npm i postgres @vercel/functions && npm i -D typescript @types/node vitest tsx`
- [ ] **Step 2:** criar `tsconfig.json` (target ES2022, module NodeNext, strict) e `vercel.json` (bloco §5)
- [ ] **Step 3:** criar `api/index.ts` mínimo que responde `/health` (`export default (req: Request) => Response.json({ok:true,ts:Date.now()})`)
- [ ] **Step 4:** linkar à Vercel: `export VERCEL_TOKEN="$(grep '^VERCEL_TOKEN=' .env | cut -d= -f2)" && npx vercel link --yes --token $VERCEL_TOKEN` (anotar org/project id em `.vercel/project.json` → copiar p/ `VERCEL_ORG_ID`/`VERCEL_PROJECT_ID` no `.env`)
- [ ] **Step 5:** deploy de teste: `npx vercel deploy --token $VERCEL_TOKEN` → abrir `<url>/health` → Expected: `{ok:true,...}`
- [ ] **Step 6:** commit + push (dispara deploy contínuo)

#### Task 3: Provisionar Supabase (requer confirmação do dono: org + senha)
- [ ] **Step 1:** `export SUPABASE_ACCESS_TOKEN="$(grep '^SUPABASE_ACCESS_TOKEN=' .env | cut -d= -f2)" && npx supabase orgs list`
- [ ] **Step 2:** `npx supabase projects create kommo-cnn --org-id <ORG_ID> --region sa-east-1 --db-password '<SENHA>'`
- [ ] **Step 3:** preencher no `.env`: `SUPABASE_PROJECT_REF`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_PASSWORD`, `DATABASE_URL` (pooler :6543), `DIRECT_URL` (:5432)
- [ ] **Step 4:** `npx supabase init && npx supabase link --project-ref <ref>`

#### Task 4: Extensões + schema (migrations)
- [ ] **Step 1:** criar `supabase/migrations/0001_extensions.sql`:
```sql
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
```
- [ ] **Step 2:** criar `supabase/migrations/0002_schema_operacional.sql` com as 9 tabelas operacionais (DDL PG — igual ao Task 5 do plano-fase1: `agendamento_sync`, `cursores`, `mapeamento` [PK `(paciente_id_cnn,grupo)`], `agenda_sync` [+origin], `lembrete_d1`, `auditoria` [IDENTITY], `fila_trabalho` [+locked_at, IDENTITY], `orcamento_sync`, `tick_log` [IDENTITY] + índices)
- [ ] **Step 3:** `npx supabase db push` → Expected: aplica 0001 e 0002 sem erro
- [ ] **Step 4:** verificar 9 tabelas: `npx supabase db execute --linked "select count(*) n from information_schema.tables where table_schema='public' and table_name in ('agendamento_sync','cursores','mapeamento','agenda_sync','lembrete_d1','auditoria','fila_trabalho','orcamento_sync','tick_log');"` → Expected: `9`
- [ ] **Step 5:** commit + push

#### Task 5: Camada de dados `lib/db.ts` (TDD)
- [ ] **Step 1:** escrever teste `lib/db.test.ts` (vitest): insert+first+all com placeholders `?`; batch em transação; claim `FOR UPDATE SKIP LOCKED` com RETURNING (mesmos 3 casos do plano-fase1 Task 6)
- [ ] **Step 2:** `npx vitest run lib/db.test.ts` → Expected: FALHA (db.ts não existe)
- [ ] **Step 3:** implementar `lib/db.ts`:
```ts
import postgres from 'postgres'
const sql = postgres(process.env.DATABASE_URL!, { prepare: false })
const toPg = (q: string) => { let i = 0; return q.replace(/\?/g, () => `$${++i}`) }
class Stmt {
  constructor(private q: string, private p: unknown[] = []) {}
  bind(...a: unknown[]) { return new Stmt(this.q, a) }
  async run() { await sql.unsafe(toPg(this.q), this.p as any[]); return { success: true as const } }
  async first<T=any>() { const r = await sql.unsafe(toPg(this.q), this.p as any[]); return (r[0] as T) ?? null }
  async all<T=any>() { const r = await sql.unsafe(toPg(this.q), this.p as any[]); return { results: r as unknown as T[] } }
  _tx(tx: any) { return tx.unsafe(toPg(this.q), this.p as any[]) }
}
export const DB = { prepare: (q: string) => new Stmt(q), batch: (s: Stmt[]) => sql.begin((tx:any)=>Promise.all(s.map(x=>x._tx(tx)))) }
```
- [ ] **Step 4:** `export DATABASE_URL=... && npx vitest run lib/db.test.ts` → Expected: PASS (3 testes)
- [ ] **Step 5:** commit + push

### FASE 2 — Porte + otimizações (roadmap; detalhar após Fase 1)

1. **`lib/env.ts`** — `export const env = process.env as any` (as funções continuam recebendo `env`).
2. **Porte mecânico** de `src/index.ts` → `lib/*.ts`: `env.DB`→`DB`; `bumpSubreq/subreqUsados/orcamentoOk`→removidos; `btoa`→`b64()`; `ctx.waitUntil`→`waitUntil`. As funções puras/`fetch` copiam quase intactas.
3. **Roteador** `api/index.ts` = o `switch` do `fetch()`; `api/tick.ts` = o corpo do `scheduled()` (lease + produtores + `consumirFila`).
4. **Ajustes 🔴:** claim `FOR UPDATE SKIP LOCKED`; lease `pg_try_advisory_lock`; upserts `ON CONFLICT`.
5. **Gate de paridade:** portar `selftest.ts` + rotas `/debug-selftest` e `/debug-retry-selftest`; deploy; exigir **52/52 + retry verde** e dry-runs (`/debug-tick?dry=1`) contra dados reais (read-only) antes de otimizar.
6. **Otimizações** (cada uma um passo, selftests verdes entre elas): remover budget → lote grande em `consumirFila`; paralelismo sob throttle; `attachDatabasePool`.

### FASE 3 — Ativação (roadmap; detalhar após Fase 2)

1. **Vault + cron:** `select vault.create_secret('<token>', 'tick_token');` e `0003_cron.sql`:
```sql
select cron.schedule('kommo-cnn-tick','* * * * *', $$
  select net.http_post(
    url:='https://<app>.vercel.app/api/tick',
    headers:=jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='tick_token')),
    body:=jsonb_build_object('t', now())
  );
$$);
```
   `/api/tick` valida esse Bearer antes de rodar.
2. **Migração de dados** D1→PG: `wrangler d1 export kommo-cnn-db --remote --output dump.sql` (⚠️ token CF IP-restrito) → transformar → `psql "$DIRECT_URL"`. Ordem: `mapeamento`, `agenda_sync`, `orcamento_sync`, `lembrete_d1`, `cursores`. `fila_trabalho` 'feito' não migra; resolver o 1 dead-letter antes.
3. **Cutover:** re-apontar os 3 webhooks do Kommo para `https://<app>.vercel.app/webhook/*`; ligar o pg_cron; **desligar o cron do CF Worker**. Rollback = religar o CF (fica intacto).
4. **Observar:** `/debug-tick-log` e `/debug-audit` na Vercel por alguns dias; comparar com o baseline do CF; confirmar comercial (Pro) se produção.

---

## 7. Riscos e decisões em aberto

- 🔴 **Uso comercial na Vercel:** Hobby proíbe. Produção → **Pro (~$20/mês)**. Decidir antes do go-live (Supabase free já cobre comercial; o custo, se houver, é da Vercel).
- 🟡 **Conexões serverless↔Postgres:** mitigado por pooler :6543 + Fluid Compute; validar sob carga (preflight `SELECT 1` / reciclar client).
- 🟡 **`maxDuration` 60s (free):** o tick "gordo" precisa caber; se estourar, reduzir o lote ou dividir o tick. Medir cedo.
- 🟡 **`pg_net` fire-and-forget:** o cron não vê falha do tick → confiar na idempotência + `tick_log` + alerta F1.
- 🟡 **Deploy do dump depende do token CF (IP-restrito):** coordenar liberação.
- 🟢 **Vercel↔Supabase integração nativa** (marketplace) pode injetar env vars automaticamente — avaliar para simplificar o setup de secrets.

---

## Self-Review

- **Cobertura:** GitHub (Task 1), Vercel projeto+deploy (Task 2), Supabase projeto+schema (Tasks 3-4), camada de dados (Task 5); porte e ativação em roadmap (Fases 2-3). Paridade garantida pelos selftests (gate na Fase 2). Otimizações listadas e amarradas a passos verificáveis.
- **Placeholders:** `<ORG_ID>`, `<SENHA>`, `<ref>`, `<app>` são valores de runtime, cada um com o comando que o produz.
- **Consistência:** o shim `DB` (Task 5) tem a mesma API consumida no porte (Fase 2). `DATABASE_URL`/`DIRECT_URL` casam com o `.env`.
