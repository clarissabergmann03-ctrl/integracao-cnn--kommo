# Migração kommo-cnn → Supabase — Fase 1: Fundação (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **⚠️ CONSOLIDADO em (06/07, tarde) `docs/superpowers/plans/2026-07-06-plano-github-vercel-supabase.md`** — a stack final é `github/vercel/supabase` com a **lógica na Vercel** (Node), não em Supabase Edge (Deno). As tarefas de Fundação abaixo (git, projeto Supabase, extensões, schema, camada `DB`) seguem válidas; a única diferença é que a camada `DB` roda em **Node na Vercel** (testes com vitest) e não em Deno. Use o plano consolidado como fonte.

**Goal:** Versionar o projeto no GitHub e levantar a fundação no Supabase — projeto, extensões, schema Postgres (9 tabelas operacionais) e uma camada de dados (`DB` shim sobre postgres.js) testada — sem ainda portar a lógica de negócio.

**Architecture:** Backend 100% Supabase (Edge Functions Deno + Postgres + pg_cron/pg_net); Vercel reservada para UI futura. Esta fase entrega infra + banco + camada de acesso a dados testável isoladamente. O de-para completo está no spec `docs/superpowers/specs/2026-07-06-migracao-cf-worker-para-supabase-edge-design.md`.

**Tech Stack:** Deno, Supabase (CLI, Postgres, pg_cron, pg_net, Supavisor pooler), `postgres.js` (`npm:postgres`), GitHub (`gh` CLI).

## Global Constraints

- **Custo zero:** Supabase Free (uso comercial permitido no free). Não introduzir recurso pago.
- **SQL raw obrigatório:** o código usa `UPDATE…RETURNING`, `ON CONFLICT`, DDL → driver `postgres.js`, **não** `supabase-js`/PostgREST.
- **Pooler transaction mode:** conectar via `SUPABASE_DB_URL` (Supavisor, porta **6543**) com `postgres(url, { prepare: false })` — transaction mode não suporta prepared statements nomeados.
- **Placeholders `?` → `$n`:** o shim converte automaticamente; as queries do código são mantidas com `?`.
- **Segredos:** `.env` está no `.gitignore` — nunca commitar. Tokens já presentes: `SUPABASE_ACCESS_TOKEN`, `GITHUB_TOKEN`, `CLOUDFLARE_API_TOKEN`.
- **Escopo do schema:** portar só as **9 tabelas operacionais**. As `mig_pacientes/mig_agendas/mig_orcamentos/mig_sync_log` e `backfill_hist` são staging de processos one-time já concluídos → **NÃO recriar** (decisão §10 do spec).
- **Região Supabase:** `sa-east-1` (São Paulo) — latência com CNN/Kommo no Brasil.

---

## Decomposição (3 planos sequenciais)

Cada plano entrega software testável por si só; o próximo só começa após o anterior validado.

| Plano | Entrega | Testável por |
|---|---|---|
| **1 — Fundação (ESTE)** | git/GitHub + projeto Supabase + extensões + 9 tabelas + camada `DB` | `deno test` da camada de dados contra o Postgres novo |
| **2 — Porte da lógica** | Edge Functions `api` (roteador+webhooks) e `tick` (produtores+consumirFila); `subreqUsados` removido; claim → `SKIP LOCKED`; lease → advisory lock | `/debug-selftest` (52/52), `/debug-retry-selftest`, dry-runs |
| **3 — Ativação** | pg_cron→pg_net (tick 1min), migração dos dados D1→PG, re-apontar webhooks Kommo, desligar cron do CF | `/debug-tick-log` e `/debug-audit` no ar; CF como rollback |

Este documento detalha o **Plano 1**. Os Planos 2 e 3 têm roadmap no fim (a serem detalhados quando o anterior for concluído — o detalhe deles depende do resultado real da fundação).

---

## File Structure (Plano 1)

- Create: `kommo-cnn/supabase/config.toml` — gerado por `supabase init`.
- Create: `kommo-cnn/supabase/migrations/0001_extensions.sql` — pg_cron + pg_net.
- Create: `kommo-cnn/supabase/migrations/0002_schema_operacional.sql` — as 9 tabelas + índices.
- Create: `kommo-cnn/supabase/functions/_shared/db.ts` — o shim `DB` sobre postgres.js (única peça que substitui o `env.DB` do Worker).
- Create: `kommo-cnn/supabase/functions/_shared/db_test.ts` — testes Deno da camada de dados.
- Modify: `kommo-cnn/.env` — preencher `SUPABASE_URL`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`, `SUPABASE_DB_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` após criar o projeto.

---

## Task 1: Versionar o projeto no GitHub

**Files:**
- Create: `kommo-cnn/.git/` (via `git init`)
- Usa: `kommo-cnn/.gitignore` (já existe), `kommo-cnn/.env` (já existe, deve ser ignorado)

**Interfaces:**
- Produces: repositório Git local + remoto `kommo-cnn` no GitHub com o código atual; base para os commits das próximas tarefas.

- [ ] **Step 1: Inicializar o git na pasta do projeto**

Run:
```bash
cd /d/clarissa-bergmann/kommo-cnn && git init && git add -A
```

- [ ] **Step 2: Verificar que segredos NÃO entraram no staging**

Run:
```bash
git status --porcelain | grep -E '\.env$|\.dev\.vars|setup-secrets' || echo "OK: nenhum segredo no staging"
```
Expected: `OK: nenhum segredo no staging` (o `.gitignore` cobre `.env`). Se aparecer `.env`, PARE e corrija o `.gitignore` antes de continuar.

- [ ] **Step 3: Commit inicial**

Run:
```bash
git commit -m "chore: versiona projeto kommo-cnn (baseline pré-migração Supabase)"
```
Expected: commit criado com os arquivos do projeto (sem `.env`).

- [ ] **Step 4: Criar o repositório remoto e dar push (via gh + GITHUB_TOKEN)**

Run:
```bash
export GH_TOKEN="$(grep -E '^GITHUB_TOKEN=' .env | cut -d= -f2)"
gh repo create kommo-cnn --private --source=. --remote=origin --push
```
Expected: repo `kommo-cnn` criado como **private** e push concluído.

- [ ] **Step 5: Confirmar que o `.env` não está no remoto**

Run:
```bash
gh api repos/{owner}/kommo-cnn/contents/.env 2>&1 | grep -q "Not Found" && echo "OK: .env fora do repo"
```
Expected: `OK: .env fora do repo`.

---

## Task 2: Inicializar a estrutura Supabase local

**Files:**
- Create: `kommo-cnn/supabase/config.toml`, `kommo-cnn/supabase/functions/`, `kommo-cnn/supabase/migrations/`

**Interfaces:**
- Produces: estrutura local do Supabase onde vivem migrations e Edge Functions.

- [ ] **Step 1: Instalar o Supabase CLI (se necessário) e inicializar**

Run:
```bash
cd /d/clarissa-bergmann/kommo-cnn && npx supabase@latest init
```
Expected: cria `supabase/config.toml`. Responda "N" se perguntar sobre VS Code settings.

- [ ] **Step 2: Commit da estrutura**

Run:
```bash
git add supabase && git commit -m "chore: supabase init (estrutura local)"
```

---

## Task 3: Provisionar/linkar o projeto Supabase

**Files:**
- Modify: `kommo-cnn/.env` (preencher os valores do Supabase)

**Interfaces:**
- Consumes: `SUPABASE_ACCESS_TOKEN` (do `.env`).
- Produces: projeto Supabase criado (região sa-east-1) e linkado localmente; `.env` com `SUPABASE_URL`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD`, `SUPABASE_DB_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

> ⚠️ **Requer confirmação do dono na execução:** cria um recurso na conta dele. Confirmar a **organização** (`supabase orgs list`) e uma **senha forte** de banco antes de rodar o create.

- [ ] **Step 1: Autenticar o CLI via token e listar orgs**

Run:
```bash
export SUPABASE_ACCESS_TOKEN="$(grep -E '^SUPABASE_ACCESS_TOKEN=' .env | cut -d= -f2)"
npx supabase orgs list
```
Expected: lista as organizações; anote o `ID` da org-alvo.

- [ ] **Step 2: Criar o projeto (região São Paulo)**

Run (substitua `<ORG_ID>` e `<DB_PASSWORD>`):
```bash
npx supabase projects create kommo-cnn --org-id <ORG_ID> --region sa-east-1 --db-password '<DB_PASSWORD>'
```
Expected: retorna o `project-ref`. Guarde-o.

- [ ] **Step 3: Preencher os valores no `.env`**

Preencher (do painel → Settings → API e Database, ou do output acima):
```
SUPABASE_PROJECT_REF=<project-ref>
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_DB_PASSWORD=<DB_PASSWORD>
SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
SUPABASE_DB_URL=postgres://postgres.<project-ref>:<DB_PASSWORD>@aws-0-sa-east-1.pooler.supabase.com:6543/postgres
```

- [ ] **Step 4: Linkar o diretório local ao projeto**

Run:
```bash
npx supabase link --project-ref <project-ref>
```
Expected: `Finished supabase link`.

- [ ] **Step 5: Verificar conectividade**

Run:
```bash
npx supabase projects list
```
Expected: o projeto `kommo-cnn` aparece com um `●` (linkado).

---

## Task 4: Habilitar extensões pg_cron + pg_net

**Files:**
- Create: `kommo-cnn/supabase/migrations/0001_extensions.sql`

**Interfaces:**
- Produces: extensões `pg_cron` e `pg_net` habilitadas (pré-requisito do cron da Fase 3).

- [ ] **Step 1: Escrever a migration**

Create `supabase/migrations/0001_extensions.sql`:
```sql
-- Cron dentro do Postgres + HTTP de dentro do banco (gatilho do tick na Fase 3).
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
```

- [ ] **Step 2: Aplicar no banco remoto**

Run:
```bash
npx supabase db push
```
Expected: aplica `0001_extensions.sql` sem erro.

- [ ] **Step 3: Verificar extensões habilitadas**

Run:
```bash
npx supabase db execute --linked "select extname from pg_extension where extname in ('pg_cron','pg_net') order by extname;"
```
Expected: retorna `pg_cron` e `pg_net`.

- [ ] **Step 4: Commit**

Run:
```bash
git add supabase/migrations/0001_extensions.sql && git commit -m "feat(db): habilita pg_cron + pg_net"
```

---

## Task 5: Criar o schema operacional (9 tabelas)

**Files:**
- Create: `kommo-cnn/supabase/migrations/0002_schema_operacional.sql`

**Interfaces:**
- Produces: as 9 tabelas operacionais + índices, prontas para a camada de dados e o porte.

- [ ] **Step 1: Escrever a migration com o schema convertido (SQLite→Postgres)**

Create `supabase/migrations/0002_schema_operacional.sql`:
```sql
-- Legado (W1): ts de sync por lead
CREATE TABLE IF NOT EXISTS agendamento_sync (
  lead_id text PRIMARY KEY, synced_ts bigint NOT NULL, updated_at bigint NOT NULL);

-- Watermarks / cursores / lease
CREATE TABLE IF NOT EXISTS cursores (
  nome text PRIMARY KEY, valor text, atualizado_em bigint NOT NULL);

-- Identidade paciente↔lead (PK COMPOSTA — a migração de chave já é passado)
CREATE TABLE IF NOT EXISTS mapeamento (
  paciente_id_cnn text NOT NULL, grupo text NOT NULL, lead_id_kommo text, telefone_norm text,
  duplicata smallint DEFAULT 0, criado_em bigint NOT NULL, atualizado_em bigint NOT NULL,
  PRIMARY KEY (paciente_id_cnn, grupo));
CREATE INDEX IF NOT EXISTS idx_map_tel ON mapeamento(telefone_norm);
CREATE INDEX IF NOT EXISTS idx_map_lead ON mapeamento(lead_id_kommo);
CREATE INDEX IF NOT EXISTS idx_map_pac ON mapeamento(paciente_id_cnn);

-- Baseline anti-eco por agenda (+origin p/ anti-loop dos webhooks)
CREATE TABLE IF NOT EXISTS agenda_sync (
  agenda_id_cnn text PRIMARY KEY, lead_id_kommo text, paciente_id_cnn text,
  last_agendamento_ts bigint, last_cnn_status text, atualizado_em bigint NOT NULL, origin text);
CREATE INDEX IF NOT EXISTS idx_ag_lead ON agenda_sync(lead_id_kommo);
CREATE INDEX IF NOT EXISTS idx_ag_pac ON agenda_sync(paciente_id_cnn);

-- Idempotência da véspera (1 lembrete/lead/dia)
CREATE TABLE IF NOT EXISTS lembrete_d1 (
  chave text PRIMARY KEY, lead_id_kommo text, agenda_id_cnn text, data_agendamento text,
  grupo text, pipeline_destino bigint, etapa_destino bigint, enviado_em bigint NOT NULL);

-- Ledger de auditoria (AUTOINCREMENT → IDENTITY)
CREATE TABLE IF NOT EXISTS auditoria (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, ts bigint NOT NULL, funcao text, ambiente text,
  entidade_id text, acao text, de text, para text, detalhe text);

-- Fila de trabalho (+locked_at); claim usará FOR UPDATE SKIP LOCKED (Fase 2)
CREATE TABLE IF NOT EXISTS fila_trabalho (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chave text UNIQUE, tipo text, agenda_id_cnn text, paciente_id_cnn text, grupo text, payload text,
  status text DEFAULT 'pendente', tentativas int DEFAULT 0, ultimo_erro text, locked_at bigint,
  criado_em bigint NOT NULL, atualizado_em bigint NOT NULL);
CREATE INDEX IF NOT EXISTS idx_fila_status ON fila_trabalho(status, id);

-- Idempotência do reflexo de orçamento
CREATE TABLE IF NOT EXISTS orcamento_sync (
  paciente_id_cnn text PRIMARY KEY, lead_id_kommo text, ultimo_status text, ultima_etapa bigint, updated_at bigint);

-- Log durável por tick (F1)
CREATE TABLE IF NOT EXISTS tick_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, ts bigint NOT NULL, ok smallint NOT NULL,
  ms bigint, subreq int, gatilhos text,
  processados int, movidos int, criados_b int, adiados int, erros int, transitorios int,
  fila_pendente int, fila_erro int, erro text, resumo text);
CREATE INDEX IF NOT EXISTS idx_tick_ts ON tick_log(ts);
```

- [ ] **Step 2: Aplicar no banco remoto**

Run:
```bash
npx supabase db push
```
Expected: aplica `0002_schema_operacional.sql` sem erro.

- [ ] **Step 3: Verificar que as 9 tabelas existem**

Run:
```bash
npx supabase db execute --linked "select count(*) as n from information_schema.tables where table_schema='public' and table_name in ('agendamento_sync','cursores','mapeamento','agenda_sync','lembrete_d1','auditoria','fila_trabalho','orcamento_sync','tick_log');"
```
Expected: `n = 9`.

- [ ] **Step 4: Verificar a PK composta do mapeamento**

Run:
```bash
npx supabase db execute --linked "select string_agg(a.attname, ',' order by array_position(i.indkey, a.attnum)) as pk from pg_index i join pg_attribute a on a.attrelid=i.indrelid and a.attnum=any(i.indkey) where i.indrelid='mapeamento'::regclass and i.indisprimary;"
```
Expected: `paciente_id_cnn,grupo`.

- [ ] **Step 5: Commit**

Run:
```bash
git add supabase/migrations/0002_schema_operacional.sql && git commit -m "feat(db): schema operacional (9 tabelas) em Postgres"
```

---

## Task 6: Camada de dados — shim `DB` sobre postgres.js

**Files:**
- Create: `kommo-cnn/supabase/functions/_shared/db.ts`
- Test: `kommo-cnn/supabase/functions/_shared/db_test.ts`

**Interfaces:**
- Consumes: `SUPABASE_DB_URL` (env).
- Produces: `DB` com a mesma API mínima do `env.DB` do Worker:
  - `DB.prepare(query: string).bind(...args).run(): Promise<{success:true}>`
  - `DB.prepare(query).bind(...args).first<T>(): Promise<T|null>`
  - `DB.prepare(query).bind(...args).all<T>(): Promise<{results:T[]}>`
  - `DB.batch(stmts: Stmt[]): Promise<unknown>`
  Placeholders `?` são convertidos para `$n` internamente. Isto é o que o Plano 2 importa no lugar de `env.DB`.

- [ ] **Step 1: Escrever o teste que falha (conexão + CRUD + claim SKIP LOCKED)**

Create `supabase/functions/_shared/db_test.ts`:
```ts
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { DB } from './db.ts'

Deno.test('insert + first + all + placeholders', async () => {
  const now = Math.floor(Date.now() / 1000)
  await DB.prepare('INSERT INTO cursores (nome, valor, atualizado_em) VALUES (?, ?, ?) ON CONFLICT(nome) DO UPDATE SET valor=excluded.valor')
    .bind('t_db_test', 'v1', now).run()
  const row = await DB.prepare('SELECT valor FROM cursores WHERE nome = ?').bind('t_db_test').first<{ valor: string }>()
  assertEquals(row?.valor, 'v1')
  const many = await DB.prepare('SELECT nome FROM cursores WHERE nome = ?').bind('t_db_test').all<{ nome: string }>()
  assertEquals(many.results.length, 1)
})

Deno.test('batch em transação', async () => {
  const now = Math.floor(Date.now() / 1000)
  await DB.batch([
    DB.prepare('INSERT INTO cursores (nome,valor,atualizado_em) VALUES (?,?,?) ON CONFLICT(nome) DO UPDATE SET valor=excluded.valor').bind('t_b1','x',now),
    DB.prepare('INSERT INTO cursores (nome,valor,atualizado_em) VALUES (?,?,?) ON CONFLICT(nome) DO UPDATE SET valor=excluded.valor').bind('t_b2','y',now),
  ])
  const r = await DB.prepare("SELECT count(*)::int n FROM cursores WHERE nome IN ('t_b1','t_b2')").first<{ n: number }>()
  assertEquals(r?.n, 2)
})

Deno.test('claim atômico FOR UPDATE SKIP LOCKED devolve RETURNING', async () => {
  const now = Math.floor(Date.now() / 1000)
  await DB.prepare("INSERT INTO fila_trabalho (chave,tipo,status,criado_em,atualizado_em) VALUES (?, 'A3','pendente',?,?) ON CONFLICT(chave) DO NOTHING").bind('t_claim', now, now).run()
  const claimed = await DB.prepare(
    `UPDATE fila_trabalho SET status='processing', locked_at=?, tentativas=tentativas+1, atualizado_em=?
       WHERE id IN (SELECT id FROM fila_trabalho WHERE chave='t_claim' AND status='pendente' FOR UPDATE SKIP LOCKED LIMIT 1)
     RETURNING id, tentativas`
  ).bind(now, now).all<{ id: number; tentativas: number }>()
  assertEquals(claimed.results.length, 1)
  assertEquals(claimed.results[0].tentativas, 1)
  // limpeza
  await DB.prepare("DELETE FROM fila_trabalho WHERE chave='t_claim'").run()
  await DB.prepare("DELETE FROM cursores WHERE nome IN ('t_db_test','t_b1','t_b2')").run()
})
```

- [ ] **Step 2: Rodar o teste para confirmar que falha**

Run:
```bash
export SUPABASE_DB_URL="$(grep -E '^SUPABASE_DB_URL=' ../../.env | cut -d= -f2)"
deno test --allow-net --allow-env supabase/functions/_shared/db_test.ts
```
Expected: FALHA com "Module not found ./db.ts" (o shim ainda não existe).

- [ ] **Step 3: Implementar o shim `DB`**

Create `supabase/functions/_shared/db.ts`:
```ts
import postgres from 'npm:postgres@3'

// Supavisor transaction mode (6543) → prepare:false (não suporta prepared statements nomeados).
const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false })

// Converte placeholders estilo D1/SQLite (?) para os do Postgres ($1,$2,...).
const toPg = (q: string) => { let i = 0; return q.replace(/\?/g, () => `$${++i}`) }

class Stmt {
  constructor(private q: string, private params: unknown[] = []) {}
  bind(...args: unknown[]) { return new Stmt(this.q, args) }
  async run() { await sql.unsafe(toPg(this.q), this.params as any[]); return { success: true as const } }
  async first<T = any>() { const r = await sql.unsafe(toPg(this.q), this.params as any[]); return ((r[0] as T) ?? null) }
  async all<T = any>() { const r = await sql.unsafe(toPg(this.q), this.params as any[]); return { results: r as unknown as T[] } }
  _tx(tx: any) { return tx.unsafe(toPg(this.q), this.params as any[]) }
}

export const DB = {
  prepare: (q: string) => new Stmt(q),
  batch: (stmts: Stmt[]) => sql.begin((tx: any) => Promise.all(stmts.map((s) => s._tx(tx)))),
}
export type { Stmt }
```

- [ ] **Step 4: Rodar o teste para confirmar que passa**

Run:
```bash
deno test --allow-net --allow-env supabase/functions/_shared/db_test.ts
```
Expected: PASS nos 3 testes (`insert + first + all`, `batch`, `claim`).

- [ ] **Step 5: Commit**

Run:
```bash
git add supabase/functions/_shared/db.ts supabase/functions/_shared/db_test.ts && git commit -m "feat(db): shim DB sobre postgres.js (API igual ao env.DB do Worker) + testes"
```

---

## Roadmap — Plano 2: Porte da lógica (a detalhar após a Fundação)

Cada tarefa termina rodando os selftests portados (que existem no código e são puros → devem dar os **mesmos 52/52** verdes).

1. **Estrutura das Edge Functions** — `supabase/functions/api/index.ts` (`Deno.serve` + roteador dos ~50 paths) e `supabase/functions/tick/index.ts` (o antigo `scheduled`). `supabase/functions/_shared/logic.ts` recebe as ~150 funções portadas.
2. **Porte mecânico** — `env.DB` → `import { DB }`; remover `subreqUsados`/`bumpSubreq`/`orcamentoOk` (e o `podeRetentar` do retry); trocar `ctx.waitUntil` por await direto no `tick`. `fetch`/`crypto`/`btoa`/`Response` ficam iguais.
3. **Ajustes 🔴 pontuais** — `filaClaimLote` → `FOR UPDATE SKIP LOCKED`; lease → `pg_try_advisory_lock`; `INSERT OR IGNORE`→`ON CONFLICT DO NOTHING`; `tabelaExiste`/`PRAGMA` (só se portar algo que use — o bloco `mig_*` não vai).
4. **Selftests como gate** — portar `/debug-selftest` (logic/fuzz/stress) e `/debug-retry-selftest`; rodar e exigir 52/52 + retry verde antes de seguir.
5. **Deploy + dry-run** — `supabase functions deploy`; `supabase secrets set --env-file .env`; validar webhooks e `/debug-tick?dry=1` contra dados reais (read-only).

## Roadmap — Plano 3: Ativação (a detalhar após o Porte)

1. **Cron** — migration com `cron.schedule('kommo-cnn-tick','* * * * *', $$ select net.http_post(url:='https://<ref>.supabase.co/functions/v1/tick', headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='tick_token')), body:=jsonb_build_object('t', now())) $$)`. Token do tick no **Vault** (não hardcode).
2. **Migração de dados** — `wrangler d1 export kommo-cnn-db --remote --output dump.sql` (⚠️ token CF IP-restrito) → transformar → carregar. Ordem: `mapeamento`, `agenda_sync`, `orcamento_sync`, `lembrete_d1`, `cursores` (idempotência) → `auditoria`/`tick_log` (opcional). `fila_trabalho` 'feito' não migra; investigar o 1 dead-letter antes.
3. **Cutover** — re-apontar os 3 webhooks do Kommo para `…/functions/v1/api/webhook/*`; ligar o cron; **desligar o cron do CF Worker** (rollback = religar o CF, que fica intacto).
4. **Observação** — `/debug-tick-log` e `/debug-audit` na Edge por alguns dias; comparar com o baseline do CF.

---

## Self-Review (Plano 1)

- **Cobertura do spec (Fase 1):** git/GitHub (Task 1) ✓; provisionar Supabase + extensões (Tasks 2-4) ✓; schema PG das 9 tabelas operacionais (Task 5) ✓; camada de dados (Task 6) ✓. As `mig_*`/`backfill_hist` ficam de fora **por decisão explícita** (§10) — registrado nas Global Constraints.
- **Placeholders:** os `<ORG_ID>`, `<DB_PASSWORD>`, `<project-ref>` nos comandos são valores que **só existem em runtime** (criados na execução) — não são placeholders de código; cada um tem o comando exato que o produz no passo anterior.
- **Consistência de tipos:** a API do shim `DB` (`prepare/bind/run/first/all/batch`) usada no teste (Task 6 Step 1) casa 1:1 com a implementação (Step 3) e com o que o Plano 2 vai consumir.
- **Escopo:** foco em fundação testável; nenhuma lógica de negócio portada aqui (isso é o Plano 2).
