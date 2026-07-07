# Mapa de Migração — Cloudflare Worker `kommo-cnn` → Supabase (Edge Functions + Postgres + Cron)

> **Data:** 2026-07-06
> **Fonte da verdade:** o Worker **deployado** — version `dd7d1ac0` (deploy 2026-07-06 05:10 UTC), confirmado ao vivo (cron `* * * * *`, `CNN_WRITE_TARGET=production`, `WH1/WH2_ENABLED=1`). Código: `src/index.ts` (**5.756 linhas**, arquivo único).
> **Objetivo deste documento:** MAPEAR (não executar) todas as funções, schemas e itens do Worker e seu de-para para a arquitetura-alvo. É o insumo do plano de implementação.
> **Vercel:** reservada para uma eventual UI/dashboard futura — **fora do caminho crítico**. Todo o backend vai para o Supabase.
>
> **⚠️ REVISADO (06/07, tarde) — a stack final é `github/vercel/supabase`:** a **lógica passou a rodar em Vercel Functions (Node)**, NÃO em Supabase Edge Functions. Este mapa de FUNÇÕES / SCHEMAS / ITENS segue 100% válido (o de-para de função não muda) — só o **host** da lógica mudou (Vercel Node em vez de Deno Edge) e o cron pg_cron passa a chamar a Vercel. **Plano definitivo:** `docs/superpowers/plans/2026-07-06-plano-github-vercel-supabase.md`.

---

## 1. Contexto e decisões (do brainstorming 2026-07-06)

**Por que migrar:** o teto do Cloudflare Free de **50 sub-requests (`fetch`) por invocação** tornou o projeto inviável de operar bem — toda a arquitetura de fila + micro-ticks existe para contornar esse teto, e ainda assim aperta (backlog de ORC, migração martelando endpoints, etc.).

**Por que Supabase (e não Vercel para a lógica):**
- Vercel Hobby **não faz cron sub-diário** (só 1×/dia; `* * * * *` falha no deploy) e **proíbe uso comercial**. Uma clínica real é uso comercial.
- Supabase resolve os três: **sem teto de sub-requests**, **cron de 1 min via pg_cron+pg_net**, **uso comercial permitido no free**. A pausa por inatividade (7 dias) não afeta, porque o tick escreve no banco a cada minuto.
- Edge Functions são **Deno** → mesmas Web APIs do Cloudflare Worker (`fetch`, `Response`, `crypto`, `btoa`, `URL`, `setTimeout`) → **o código porta quase 1:1**.

**Decisões fixadas:**
1. Lógica → **Supabase Edge Functions** (Deno).
2. Banco → **Supabase Postgres** (substitui o D1).
3. Cron → **Supabase Cron** (`pg_cron` + `pg_net`) chamando a Edge Function a cada minuto.
4. Estratégia → **portar 1:1 primeiro** (risco baixo, valida a plataforma); **simplificar depois** (o fim do teto de 50 permite lotes maiores e menos peças).
5. Vercel → só se/quando houver UI.

---

## 2. Arquitetura-alvo

```
                    ┌───────────────────────── SUPABASE ─────────────────────────┐
  Kommo ──webhook──►│  Edge Function "api" (Deno)                                 │
   (form-urlencoded)│    • roteia ~50 paths (webhooks + debug + mig)              │
                    │    • webhooks/confirmacao, /pos-venda-agendar, /lead-agendado│
                    │                        │                                    │
  CNN  ◄──lê/escreve┤  Edge Function "tick" (Deno)  ◄── pg_net HTTP (a cada 1 min)│
   (allowlist §7.8) │    • = o antigo scheduled(): produtores + consumirFila      │
                    │                        │                    ▲               │
                    │                        ▼                    │               │
                    │              Postgres (estado + fila)   pg_cron '* * * * *'  │
                    │   14 tabelas · pg_cron · pg_net · Supavisor (pooler)         │
                    └──────────────────────────────────────────────────────────────┘
  Vercel: (futuro) UI/dashboard lendo o mesmo Postgres — fora de escopo agora
```

**Componentes:**
- **Edge Function `api`** — replica o roteador `fetch` atual (webhooks de produção + endpoints de debug/migração). Auth idêntica (`?secret=` e header `Authorization` == `WEBHOOK_SECRET`).
- **Edge Function `tick`** — replica o `scheduled()`: no minuto certo roda os produtores (véspera/sync/orçamento) e sempre dreno da fila. Disparada pelo pg_cron via pg_net (não pelo cron da Vercel).
- **Postgres** — as 14 tabelas + as extensões `pg_cron` e `pg_net`.
- **pg_cron job** `* * * * *` → `pg_net` `POST` para a URL da Edge `tick` (com header de auth).

---

## 3. Padrões transversais a converter (o "como" do porte)

Estas são as mudanças que se repetem por todo o código. A maioria das ~150 funções cai em uma destas categorias.

| Padrão no CF Worker | Alvo Supabase/Deno | Esforço | Observação |
|---|---|---|---|
| `export default { fetch, scheduled }` | 2 Edge Functions: `api` (`Deno.serve` roteando) e `tick` | 🟡 | mesma lógica de roteamento; `scheduled` vira função HTTP chamada pelo cron |
| cron `* * * * *` (wrangler.toml) | `pg_cron` job + `pg_net` POST → Edge `tick` | 🔴 | gatilho sai do runtime e vai pro banco |
| `env.DB.prepare(sql).bind(a,b).run/first/all()` | client Postgres (`postgres.js` via Supavisor) | 🟡 | **mecânico, mas em toda query**: `?` → `$1,$2…`; `.first()`→`rows[0]`; `.all()`→`{results:rows}` (ou adaptar chamadas) |
| `env.DB.batch([stmt,…])` | transação PG (`BEGIN…COMMIT`) ou `sql.begin()` | 🟡 | agrupa como transação |
| `INSERT OR IGNORE` | `INSERT … ON CONFLICT DO NOTHING` | 🟡 | |
| `INSERT … ON CONFLICT(x) DO UPDATE SET c=excluded.c` | **idêntico** no PG (`EXCLUDED`) | 🟢 | upserts portam direto |
| `INSERT OR REPLACE` (tabelas `mig_*`) | `ON CONFLICT(pk) DO UPDATE SET …` (listar colunas) | 🟡 | PG não tem OR REPLACE |
| claim `UPDATE … WHERE id IN (SELECT … LIMIT n) RETURNING *` (`filaClaimLote`) | `… IN (SELECT id … FOR UPDATE SKIP LOCKED LIMIT n) RETURNING *` | 🔴→🟢 | **melhora**: concorrência real do PG (o D1 dependia de single-writer) |
| lease via `cursores` (`INSERT…ON CONFLICT…WHERE atualizado_em<=? RETURNING`) | manter, **ou** `pg_try_advisory_lock()` nativo | 🟡 | advisory lock é mais limpo p/ serializar o tick |
| `PRAGMA table_info(t)` (`migrarMapeamento`) | `information_schema.columns` | 🔴 | idiom SQLite |
| `sqlite_master` (`tabelaExiste`) | `information_schema.tables` / `pg_tables` | 🔴 | idiom SQLite |
| `ALTER TABLE ADD COLUMN` em try/catch | `ADD COLUMN IF NOT EXISTS` | 🟢 | PG suporta nativo |
| `CREATE TABLE/INDEX IF NOT EXISTS` | idêntico | 🟢 | vira migration SQL, não roda em runtime |
| teto 50 subreq: `subreqUsados`/`bumpSubreq`/`orcamentoOk(max)` | **remover** (não existe limite) | 🟢 | budget passa a ser por-tempo; ver §8 (risco de wall-clock da Edge) |
| `kommoThrottle` (7 req/s, `kommoNextSlot` global) | **manter** | 🟢 | vira o limitante real; isolate por-invocação igual ao Worker |
| `ctx.waitUntil(async…)` (no `scheduled`) | `EdgeRuntime.waitUntil()` ou awaitar direto | 🟡 | o tick pode simplesmente aguardar o trabalho |
| `resolveFields`/`resolveTiposConsulta` cache global + TTL | idem (best-effort no isolate Deno) | 🟢 | mesmo comportamento de cache-por-isolate |
| secrets `env.X` | `Deno.env.get("X")` | 🟢 | de-para direto |
| `crypto.randomUUID`, `btoa`, `Response.json`, `URLSearchParams`, `fetch`, `setTimeout` | idênticos no Deno | 🟢 | zero mudança |
| timestamps `Math.floor(Date.now()/1000)` (JS) | idêntico | 🟢 | o código gera epoch em JS, não via SQL `strftime` |
| `0/1` como boolean (SQLite) | manter `int`/`smallint` 0-1 (ou `boolean`) | 🟢 | manter 0/1 minimiza mudança |

**Cliente Postgres recomendado:** `postgres` (postgres.js) conectando pelo **Supavisor** (pooler do Supabase, porta 6543 transaction mode) — ideal para Edge Functions (conexões curtas). Encapsular num helper `db()` que replica a API mínima usada (`prepare().bind().run/first/all` + `batch`) para reduzir a mudança nas ~40 funções que tocam o banco a **um único ponto**.

---

## 4. Inventário de funções (por bloco) e esforço de porte

> Legenda: 🟢 porta 1:1 (lógica pura ou só `fetch`) · 🟡 troca só a camada de dados (mecânico) · 🔴 exige atenção (idiom SQLite / cron / concorrência).
> **Mensagem-chave:** a lógica de negócio (a parte testada e difícil) é quase toda 🟢/🟡. Os 🔴 são poucos e concentrados no schema/fila/cron.

### 4.1 Config e roteamento por tipo — 🟢
`CNN_BASE`, IDs CNN (`CNN_CONVENIO_PARTICULAR`, `CNN_TIPO_CONSULTA`, `CNN_LOCAL_AGENDA`, `CNN_TIPO_PROCEDIMENTO`), stages dos 3 funis, `PIPELINE_*`, `ORC_ENABLED`, `ETAPAS_ORC_PODE_AGIR`, `MAPA_STATUS`, `VESPERA_DESTINO`, `ETAPA_BASE`, `ETAPA_CONFIRMACAO`, `normNome`, `GRUPO_A_TIPOS`/`GRUPO_B_TIPOS`, `destinoStatus`, `pipelineDoGrupo`, `grupoDaAgenda`. → **constantes/funções puras, portam sem tocar.**

### 4.2 Cache de campos/tipos — 🟢
`fieldsCache`/`resolveFields`, `tiposCache`/`resolveTiposConsulta`. Cache global de módulo + TTL 1h. Comportamento equivalente no isolate Deno.

### 4.3 Retry/backoff (A4) — 🟢
`MARCA_TRANSITORIO`, `STATUS_TRANSITORIOS`, `RetryOpts`, `parseRetryAfterMs`, `ehTransitorio`, `fetchComRetry`, `retryPadrao`, `retryPost`, `retrySweep`. Puro + `fetch`. **`podeRetentar: orcamentoOk()` deixa de fazer sentido** (sem teto de subreq) → simplificar para `() => true` ou guarda de tempo.

### 4.4 Wrappers CNN + guardrail §7.8 — 🟢
`cnnCreds`, `cnnHeaders`, `CNN_STATUS_ALTERACAO_PERMITIDOS`, `cnnProducaoPermitido` (puro, tem selftest), `assertCnnWritable`, `cnnGet`/`cnnPost`/`cnnPut`, `cnnOrcamentosDoPaciente`. `fetch` padrão; remover `bumpSubreq`. **Guardrail de escrita CNN preservado integralmente.**

### 4.5 Wrappers Kommo — 🟢
`kommoBase`, `kommoNextSlot`/`kommoThrottle` (**manter** — é o rate-limit real agora), `kommoGet` (trata 204/vazio), `kommoPatch`/`kommoPost`/`kommoDelete`.

### 4.6 Utilitários puros — 🟢
`isTestePhone`/`ALLOWLIST_TESTE`, `getFieldValue`, `addMinutes`, `unixToDateBRT`, `brtToUnix`, `dayRangeBRT`, `tomorrowBRT`, `todayBRT`, `nextMondayBRT`, `normalizePhone`, `phoneKey` (§7.1), `isTarefaInterna`. Datas em BRT (UTC−3).

### 4.7 Escrita em lead / vínculo — 🟢
`setLeadFields`, `moveLeadToStage` (guarda anti-Primeiro-Contato), `setAgendamento`, `escreverVinculoCnn`, `alinharCardA`, `cnnPacienteNome`. Só `fetch` Kommo/CNN.

### 4.8 Schema D1 — 🔴 (vira migrations SQL)
`ensureSchema` (7 tabelas core + `ALTER ADD locked_at`/`origin`). → converter para **migrations Postgres** versionadas (não roda em runtime). Ver §5.

### 4.9 Lease do tick (B2) — 🟡/🔴
`TICK_LEASE_TTL_SEG`, `adquirirLease`, `liberarLease`, `novoOwnerLease`. SQL `ON CONFLICT … WHERE atualizado_em<=? RETURNING`. Portar, **ou** trocar por `pg_advisory_lock` (recomendado).

### 4.10 Fila de trabalho — 🔴 (o coração do porte de dados)
`FILA_MAX_TENTATIVAS`, `filaEnfileirarLote` (INSERT OR IGNORE em batch), `FILA_ORDER_BY`, `FILA_LOCK_TTL_SEG`, `filaRank`, `filaPuxarPendentes` (peek), **`filaClaimLote`** (claim atômico → `FOR UPDATE SKIP LOCKED`), `filaMarcarFeito`, `filaMarcarErro`, `filaAdiar`, `filaStats`. Concorrência **melhora** no Postgres.

### 4.11 Observabilidade — 🟡
`TICK_LOG_RETENCAO_DIAS`/`registrarTick` (tick_log), F1-alerta (`criarTarefaAlertaKommo`, `verificarAlertaGrave`, consts), `audit`, `leadJaLembradoNaData`, `registrarLembrete`. D1 + `fetch`.

### 4.12 Cursores + mapeamento + agenda_sync — 🟡 (🔴 na migração de chave)
`getCursor`/`setCursor`; `mapeamentoKey`, `upsertMapeamento`, `getMapeamento`, `getMapeamentoIdSet`, `getMapeamentoLeadMap`, `getAgendaSyncMap`; `upsertAgendaSync`, `getAgendaSync`. → 🟡 troca data-layer.
`tabelaExiste` (sqlite_master), `migrarMapeamento` (PRAGMA + swap de tabelas) → 🔴 **e provavelmente descartáveis**: a migração de chave composta `(paciente,grupo)` já foi executada; o schema-alvo Postgres já nasce com a PK composta.

### 4.13 Webhooks Kommo→CNN — 🟢 (puros) / 🟡 (I/O)
`TIPO_PROCEDIMENTO_CNN`, `tipoProcedimentoParaId`, `resolveTipoConsultaId`, `cnnWriteTarget`, **`decidirSupressao`** (puro, anti-loop, tem selftest 🟢), `leadEhFamilia`, `criarTarefaLead`, `purgarGemeoFeito`, `acharAgendaCnnPorHorario`, `consumirItemCnnConfirmar`, `consumirItemCnnAgendar`, `handleConfirmacao` (W2), `handlePosVendaAgendar`, `handleWhCriarCampo`, `setSyncedTs`.

### 4.14 Reflexo de orçamento (ORC) — 🟢 (puros) / 🟡 (I/O)
`temAgendaFutura`, **`decidirEtapaOrcamento`** (puro, selftest 🟢), `ORC_APROVACAO_MAX_DIAS`, `orcamentosRecentes` (puro 🟢), `getOrcamentoSync`/`upsertOrcamentoSync`, `getOrCreateConvenioParticular`, `leadAlvoOrcamento`, `dadosPacienteDoOrcamento` (puro 🟢), `consumirItemOrcamento`, `produtorOrcamento` (consts `CURSOR_ORCAMENTO`, `ORC_CRIACAO_STEP_DIAS`, `ORC_CRIACAO_LOOKBACK_DIAS`, `ORC_ENQUEUE_CAP`, `addDiasISO`).

### 4.15 Fluxos CNN↔Kommo (produtores/consumidores + legado) — 🟡
`handleLeadAgendado` (W1), `selectLeadsLembreteD1`, `syncKommoParaCnn` (A2), `syncCnnParaKommo` (A3 legado), `backfillCadastros`/`ANO_PISO` (A4 legado), `produtorBackfill`, `produtorSync`, `produtorVespera`, `consumirItemA4`, `consumirItemA3`, `consumirItemF2`, **`consumirFila`** (remover o `orcamentoOk` budget), `cronVespera`/`STATUS_TERMINAL`. Helpers de lead: `acharLeadPorTelefone`, `marcarFamiliaSeColisao`, `escolherCardAdotado` (puro 🟢), `acharLeadPorPacienteCnn`, `criarCardLead`.

### 4.16 Endpoints de diagnóstico/manutenção — 🟡
`handleTestWorkflow` (+ `STAGE_NOME`), `handleDebugC1`, `handleDebugScale`, `handleDebugCnnShape`, `handleDebugOrcamento`, `handleDebugOrcamentoImpacto`, `handleTickLog`, `handleFilaErros`, `handleFilaRequeue`, `handleDebugCount`, `handleDebugCriarAgenda`, `handleDebugBackfillPreview`, `handleDebugRaw`, `handleDebugAgendas`, `verificarDados`, `auditarSync`, `splitColisaoTelefone`, `consolidarColisao`, `mapaCampos`, `corrigirCards`. `/debug-d1cost` → **descartável** (media o teto de subreq do CF, sem sentido no Supabase).

### 4.17 Selftests — 🟢 (portam 1:1 — usar para validar o port!)
`selftestAssert`, `runSelftestLogic` (52 asserções), `runSelftestFuzz`, `runSelftestStress` (+ `gerarPacientesSim`, `simConsumirOrc`, `bucketPrioridadeSim`, tipos Sim*), `mockDoFetch`/`corrRetry`/`runRetrySelftest`, `handleDebugSelftest`. **Puros e em memória** → rodam iguais no Deno e provam que a lógica não regrediu.

### 4.18 Migração Sync Única (one-time, já executada) — 🟢/🟡/🔴
Puros 🟢: `classificarMigracao`, `derivarSinaisMig`, `faixaInativo`, `ordemEtapa`, `MIG_*` consts, `SinaisMig`. I/O 🟡: `handleMigProbe`, `handleMigSweep`, `migAgendas/OrcamentosPaciente`, `migAgendas/OrcamentosSweep`, `migCamposCustom`, `migContatoCF`, `migCriarLead`, `migMoveForwardOnly`, `migEnriquecer`, `migValidarLeadExistente`, `migSyncItem`, `migCriarCampoSelect`, `migCriarCampos`. 🔴: `ensureMigSchema` (DDL→migration), `migImportarPagina`/`migReimportarErros` (INSERT OR REPLACE), `migClaimLote` (claim), `MIG_ORDEM`. → **Como a migração já rodou, este bloco é candidato a NÃO portar** (ou portar só o que for reutilizável). Decidir na §10.

### 4.19 Auth + export — 🟢/🟡
`webhookAuthOk`, `discoverAuthOk` (🟢); `fetch` (roteador → `Deno.serve` na Edge `api`, 🟡); `scheduled` (→ Edge `tick`, 🔴 pelo acoplamento com cron/lease). `interface Env` → variáveis lidas via `Deno.env.get`.

---

## 5. Schemas: 14 tabelas D1 → Postgres

Todas nascem via **migrations SQL** no Supabase (não em runtime). As 3 tabelas transitórias da migração de chave (`mapeamento_bak`/`_new`/`_old`) **não** são portadas.

| # | Tabela | PK / UNIQUE | Papel | Nota de conversão |
|---|---|---|---|---|
| 1 | `agendamento_sync` | `lead_id` | legado (W1/C1/C2): ts de sync | trivial |
| 2 | `cursores` | `nome` | watermarks (a3/a4 offset, kommo_updated_at, orçamento, lease, alerta) | trivial; se lease virar advisory lock, alguns some |
| 3 | `mapeamento` | **`(paciente_id_cnn, grupo)`** | identidade paciente↔lead (1/grupo) + `duplicata` | **nasce com PK composta** (a migração de chave já é passado) |
| 4 | `agenda_sync` | `agenda_id_cnn` | baseline anti-eco + `origin` (anti-loop webhooks) | `origin` já como coluna |
| 5 | `lembrete_d1` | `chave` | idempotência véspera (lead+data) | trivial |
| 6 | `auditoria` | `id` autoinc | ledger de ações | `AUTOINCREMENT`→`GENERATED AS IDENTITY` |
| 7 | `fila_trabalho` | `id` autoinc / `chave` UNIQUE | fila de trabalho + `locked_at` | claim → `FOR UPDATE SKIP LOCKED`; `IDENTITY` |
| 8 | `orcamento_sync` | `paciente_id_cnn` | idempotência do reflexo de orçamento | trivial |
| 9 | `tick_log` | `id` autoinc | log durável por tick (F1) | `IDENTITY`; poda por `ts` |
| 10 | `backfill_hist` | `paciente_id_cnn` | staging do backfill histórico + `processado` | `INSERT…ON CONFLICT DO UPDATE` já usa `MAX/COALESCE` (porta) |
| 11 | `mig_pacientes` | `paciente_id_cnn` | staging da migração (classificação/sync) | INSERT OR REPLACE→upsert; volumoso |
| 12 | `mig_agendas` | `id_agenda` | staging agendas | INSERT OR REPLACE→upsert |
| 13 | `mig_orcamentos` | `id_orcamento` | staging orçamentos | INSERT OR REPLACE→upsert |
| 14 | `mig_sync_log` | `id` autoinc | log da migração | `IDENTITY` |

**Regras gerais SQLite→Postgres:**
- `INTEGER PRIMARY KEY AUTOINCREMENT` → `bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`.
- Timestamps epoch (segundos) → `bigint` (o app já gera com `Date.now()/1000`).
- Flags 0/1 → manter `smallint`/`int` (ou `boolean`; manter 0/1 minimiza diffs).
- Texto → `text`.
- `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`; `INSERT OR REPLACE` → `ON CONFLICT(pk) DO UPDATE SET …`.
- `ON CONFLICT(x) DO UPDATE SET c=excluded.c` → **igual** (Postgres usa `EXCLUDED`).
- Índices: recriar os mesmos (`idx_map_tel`, `idx_map_lead`, `idx_map_pac`, `idx_ag_lead`, `idx_ag_pac`, `idx_fila_status`, `idx_tick_ts`, `idx_mig_*`).

---

## 6. Itens de configuração

### 6.1 Secrets (9) → Supabase Edge secrets (`Deno.env.get`)
`CNN_CID`, `CNN_BASIC_USER`, `CNN_BASIC_PASS`, `CNN_CID_PRODUCTION`, `CNN_BASIC_USER_PRODUCTION`, `CNN_BASIC_PASS_PRODUCTION`, `KOMMO_ACCESS_TOKEN`, `KOMMO_CLIENT_SECRET` (existe no ar mas **o código não usa** — refresh OAuth nunca implementado; decidir se leva), `WEBHOOK_SECRET`. + novo: `SUPABASE_DB_URL`/pooler para o client PG.

### 6.2 Vars (4) → Edge secrets/env
`CNN_WRITE_TARGET=production`, `WH1_ENABLED=1`, `WH2_ENABLED=1`, `KOMMO_SUBDOMAIN=atendimentoclinicabergmanncombr`.

### 6.3 Cron (1)
`* * * * *` → **pg_cron** job disparando **pg_net** `POST {edge}/tick` com header de auth. (Opcional: um 2º job de heartbeat, desnecessário porque o tick já escreve no banco.)

### 6.4 Rotas HTTP (~50) → todas na Edge `api`
- **Produção (webhooks Kommo):** `/webhook/lead-agendado` (W1), `/webhook/confirmacao` (W2), `/webhook/pos-venda-agendar`. → **re-apontar no Kommo** para a nova URL.
- **Operacional/observabilidade:** `/health`, `/debug-audit`, `/debug-tick-log`, `/debug-tick`, `/debug-fila-erros`, `/debug-fila-requeue`, `/debug-count`, `/discover`.
- **Diagnóstico CNN/Kommo:** `/debug-agendas`, `/debug-raw`, `/debug-raw-agendas`, `/debug-cnn-shape`, `/debug-nomes`, `/debug-orcamento`, `/debug-orcamento-impacto`, `/debug-lookup-paciente`, `/debug-backfill-preview`, `/debug-scale`, `/debug-c1`, `/debug-a2`, `/debug-a3`, `/debug-a4`, `/debug-f2`, `/debug-criar-agenda`, `/debug-move`, `/debug-corrigir`, `/debug-verificar`, `/debug-auditoria`, `/debug-mapa-campos`, `/debug-split-colisao`, `/debug-consolidar-colisao`, `/debug-aniversario`, `/debug-backfill-hist`.
- **Selftest:** `/debug-selftest`, `/debug-retry-selftest`.
- **Migração:** `/debug-migra-probe`, `/debug-migra-sweep`, `/mig-import`, `/mig-reimport`, `/mig-sync`, `/mig-criar-campos`, `/mig-campos-info`, `/mig-verify-lead`, `/debug-migrar-mapeamento`.
- **Descartáveis:** `/debug-d1cost` (mede teto de subreq do CF).

### 6.5 APIs externas (inalteradas — só `fetch`)
- **CNN** (`https://api.clinicanasnuvens.com.br`, Basic + header `clinicaNasNuvens-cid`): `/info`, `/agenda/lista`, `/agenda/{id}`, `POST /agenda/novo`, `POST /agenda/{id}/remarcar`, `PUT /agenda/alteracao-status`, `/paciente/lista`, `/paciente/{id}`, `POST /paciente/novo`, `POST /convenio-paciente/associar`, `/convenio-paciente/lista`, `/tipo-consulta/lista`, `/tipo-procedimento/lista`, `/orcamento/lista`, `/orcamento/{id}`.
- **Kommo** (`https://{subdomain}.kommo.com/api/v4`, Bearer): `/leads/pipelines`, `/leads` (filtros por etapa/updated_at/id/query), `/leads/{id}`, `PATCH /leads/{id}`, `POST /leads/complex`, `POST /leads/custom_fields`, `/contacts`, `/contacts/{id}`, `POST /tasks`, `/leads|contacts/custom_fields`.

### 6.6 Constantes de negócio (inalteradas)
Pipelines: Captação `13847079`, Pós-Venda `13950431`, Pós-Consulta `13947295`. Stages e IDs CNN de produção conforme §8 do `CLAUDE.md`. Grupos A/B por nome de tipo.

---

## 7. Migração de dados (D1 → Postgres)

O estado vivo precisa ser transportado (a fila pode ser recomeçada, mas `mapeamento`/`agenda_sync`/`orcamento_sync`/`lembrete_d1` são a memória de idempotência — **sem eles, o cutover re-processa tudo**).

**Volumes atuais (medidos ao vivo 2026-07-06):** `mapeamento` ≈ 1.556; `fila_trabalho` ≈ 9.823 (9.822 feito + 1 erro — a parte `feito` pode ser descartada); `mig_pacientes` ≈ milhares; `auditoria`/`tick_log` = histórico (opcional levar).

**Método:** `wrangler d1 export kommo-cnn-db --remote --output dump.sql` (⚠️ o token CF oscila por IP — usar quando liberado) → transformar SQLite-SQL → Postgres (ajustar tipos/`AUTOINCREMENT`/aspas) → `psql` no Supabase. Alternativa: exportar por tabela em JSON via endpoints `/debug-*` e carregar via script.

**Prioridade de carga:** `mapeamento`, `agenda_sync`, `orcamento_sync`, `lembrete_d1`, `cursores` (idempotência) → `mig_*` (se ainda útil) → `auditoria`/`tick_log` (histórico, opcional). `fila_trabalho` **feito** não precisa ir; o **1 dead-letter** decidir junto (ver §10).

---

## 8. Riscos e fricções

1. **🔴 Reescrita da camada de dados** — dezenas de `env.DB…`. Mitigação: um helper `db()` que replica a API mínima (`prepare/bind/run/first/all/batch`) → muda **1 arquivo**, não 40 funções.
2. **🟡 Limites de execução da Edge Function (free)** — validar CPU-time/wall-clock. O tick é I/O-bound (~3–18s wall, pouco CPU), mas Edge Functions medem CPU separadamente. Se apertar: manter lotes menores (como hoje) ou dividir o tick. **Ironia a confirmar:** trocamos o teto de subreq por um possível teto de CPU/tempo — precisa medir cedo.
3. **🟡 `pg_net` é fire-and-forget** — o cron dispara o POST e não espera resposta. Se a Edge falhar, o pg_cron não sabe. Mitigação: idempotência (já existe) + `tick_log` + o alerta F1. Considerar `net.http_collect_response` para monitorar.
4. **🟡 Re-apontar webhooks do Kommo** para a nova URL da Edge `api` (`/webhook/*`) — passo manual de cutover.
5. **🟡 Cache global entre invocações** (`resolveFields`/`kommoNextSlot`) — best-effort no Deno, igual ao Worker; sem regressão esperada.
6. **🟡 Deploy do dump depende do token CF (IP-restrito)** — coordenar liberação de IP para o `wrangler d1 export`.
7. **🟢 `KOMMO_CLIENT_SECRET` / refresh OAuth** — segue não implementado; a migração não muda isso (registrar como dívida à parte).

---

## 9. Fases da migração (roadmap — implementação vem depois, via writing-plans)

1. **Provisionar Supabase** — projeto, Postgres, habilitar `pg_cron` + `pg_net`, configurar Supavisor.
2. **Schema** — migrations das 14 tabelas + índices (PK composta em `mapeamento`, `IDENTITY`, etc.).
3. **Camada de dados** — helper `db()` (postgres.js/Supavisor) replicando a API D1 usada.
4. **Portar a lógica** — Edge `api` (roteador + webhooks + debug) e Edge `tick` (produtores + `consumirFila`); remover `subreqUsados`/budget; claim → `SKIP LOCKED`; lease → advisory lock.
5. **Validar sem tocar produção** — rodar `/debug-selftest` (logic/fuzz/stress) + `/debug-retry-selftest` na Edge (devem dar os mesmos 52/… verdes); dry-runs.
6. **Cron** — pg_cron `* * * * *` → pg_net → Edge `tick` (começar em dry/observação).
7. **Migrar dados** — exportar D1 → carregar Postgres (§7), na ordem de prioridade.
8. **Cutover** — re-apontar webhooks do Kommo; ligar o cron; **desligar o cron do CF Worker** (rollback = religar o CF, que fica intacto como fallback).
9. **Observar** — `/debug-tick-log` equivalente, `/debug-audit`, dead-letters, por alguns dias.

---

## 10. Decisões em aberto (para o plano de implementação)

- **`subreqUsados`/budget:** remover de vez (recomendado) ou manter como guarda de tempo? → recomendo remover e reavaliar lotes.
- **Lease:** portar a linha `cursores.tick_lease` ou trocar por `pg_advisory_lock`? → recomendo advisory lock.
- **Bloco de migração (`mig_*`, §4.18):** portar, portar parcial ou **deixar para trás** (já executou)? → recomendo não portar agora; reavaliar se precisar de novo passe.
- **Endpoints de debug:** portar todos ou só o núcleo operacional (`/health`, `/debug-audit`, `/debug-tick-log`, `/debug-tick`, `/debug-fila-*`, `/debug-selftest`, `/discover`)? → recomendo núcleo primeiro.
- **1 dead-letter atual:** investigar/resolver **antes** do cutover (não migrar lixo).
- **1 Edge Function vs várias:** começar com `api` + `tick` (2 funções); dividir só se limites exigirem.
- **Simplificação pós-porte:** com o fim do teto de 50, avaliar lotes maiores/menos micro-ticks (fase 2, fora deste mapa).

---

*Fim do mapa. Próximo passo: plano de implementação (skill writing-plans) a partir das fases da §9 — somente após revisão deste documento.*
