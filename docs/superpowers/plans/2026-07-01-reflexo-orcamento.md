# Reflexo de Orçamento (CNN → Kommo) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans. Cada tarefa: o subagente lê o spec (`docs/superpowers/specs/2026-07-01-kommo-cnn-reflexo-orcamento-design.md`) + a função-alvo atual em `src/index.ts`, edita e valida (`tsc` + dry-run nos `/debug-*`). Steps com checkbox (`- [ ]`).

**Goal:** Refletir automaticamente o status do orçamento do CNN no funil Kommo, só para pacientes sem agenda futura, 1x por mudança de status, rodando a cada minuto (cursor budget-aware).

**Architecture:** Novo produtor `produtorOrcamento` + consumidor `consumirItemOrcamento` no padrão de fila já existente (enfileira em `fila_trabalho` com `tipo="ORC"`; drena no `consumirFila`). Lê CNN (`GET /orcamento/lista`, `GET /orcamento/{id}` — read-only), escreve Kommo via `moveLeadToStage` (pipeline+status num único PATCH). Estado/idempotência em nova tabela D1 `orcamento_sync`. Portão "tem agenda futura?" resolvido via `agenda_sync` (D1, sem custo de subrequest). **Não** altera o sync de agenda.

**Tech Stack:** TypeScript, Cloudflare Worker, D1, wrangler, API CNN (GET orçamento), API Kommo v4. Validação: `tsc` + `/debug-*` (dry-run produção read-only + sandbox) + `/debug-audit`. Fixtures: TESTE Bruno (Paciente CNN `28146949`, tel `11946800329`, telefones extra `92982717586`/`92994567328`).

## Global Constraints

- CNN produção = **só leitura** (`assertCnnWritable`). Esta função **só faz GET** no CNN; escreve só na Kommo. Não cria orçamento.
- Teto **50 subrequests/invocação** (`orcamentoOk`); ~100k req/dia (folgado). Roda **a cada 1 min**, cursor budget-aware.
- Sistema **vivo em produção** (cron `* * * * *`, versão atual `b0167bfa`). Construir **inerte/atrás de flag**, validar, e **ligar só com OK do dono** (deploy = gate).
- **Não** modificar `consumirItemA3` / `produtorSync` / `consumirItemF2` — precedência é pelo portão "tem agenda futura?".
- Auditar todo move via `audit(...)` com `funcao: "ORC"`.
- **Limpar** artefatos de teste depois (padrão do projeto).
- Deploy: token CF com IP liberado (oscila; `code 9109` quando muda).

## IDs confirmados (`/discover` 2026-07-01)

| Alvo | pipeline_id | status_id |
|---|---|---|
| Pós-Consulta / Em Análise | 13947295 | 107633739 |
| Pós-Consulta / Venda Perdida | 13947295 | 143 |
| Pós-Venda / Tratamento Iniciado | 13950431 | 107658907 |

CNN orçamento status: `ABERTO`, `APROVADO`, `PERDIDO`, `CANCELADO`. Endpoints: `GET /orcamento/lista` (`dataInicial`,`dataFinal`,`tipoData` obrigatório; `status`,`idPaciente`,`pagina`,`registrosPorPagina`), `GET /orcamento/{id}`.

---

### Task 1 — Constantes, schema D1 e helpers de leitura de orçamento

**Files:** Modify `src/index.ts` (bloco de constantes STAGE_*; `ensureSchema`; helpers CNN perto de `cnnGet`).

**Interfaces — Produces:**
- `PIPELINE_POS_CONSULTA=13947295`, `STAGE_POSCONS_EM_ANALISE=107633739`, `STAGE_POSCONS_VENDA_PERDIDA=143`, `STAGE_POS_TRATAMENTO_INICIADO=107658907`.
- `cnnOrcamentosDoPaciente(pid: string, env, target): Promise<any[]>` — todos os orçamentos do paciente (usa `idPaciente`, janela ampla, `tipoData=CRIACAO`).
- Tabela `orcamento_sync(paciente_id_cnn TEXT PRIMARY KEY, lead_id_kommo TEXT, ultimo_status TEXT, ultima_etapa INTEGER, updated_at INTEGER)`.

- [ ] **Step 1:** Adicionar as 4 constantes junto às demais `STAGE_*`/`PIPELINE_*` (topo do arquivo). Adicionar em `STAGE_NOME` os rótulos "Pós-Consulta: Em Análise", "Pós-Consulta: Venda Perdida", "Pós-Venda: Tratamento Iniciado".
- [ ] **Step 2:** Em `ensureSchema`, `CREATE TABLE IF NOT EXISTS orcamento_sync (...)` conforme acima.
- [ ] **Step 3:** Implementar `cnnOrcamentosDoPaciente(pid, env, target)`: pagina `GET /orcamento/lista?idPaciente=${pid}&dataInicial=${hoje-2anos}&dataFinal=${hoje+1ano}&tipoData=CRIACAO&registrosPorPagina=50&pagina=N` até acabar (respeitando `orcamentoOk`). Retorna a lista bruta.
- [ ] **Step 4:** `tsc` limpo.

Run: `npx tsc --noEmit` · Expected: sem erros novos (só os pré-existentes conhecidos).

---

### Task 2 — Endpoint `/debug-orcamento` (read-only) + medir volume

**Files:** Modify `src/index.ts` (novo `handleDebugOrcamento` + rota no fetch, auth `discoverAuthOk`, `resetSubreq`).

**Interfaces — Consumes:** `cnnGet`, `cnnOrcamentosDoPaciente` (Task 1). **Produces:** rota `GET /debug-orcamento`.

- [ ] **Step 1:** Implementar `handleDebugOrcamento(req, env)`: `?env=production|sandbox`; sem `id`/`paciente` → lista por `?status=` (default APROVADO) + janela `?di/?df` (default −90d→hoje) + `tipoData=APROVACAO`, paginando, retorna `{ total, por_status, amostra:[{id,status,contrato,dataAprovacao,paciente:{id,nome,tel},valorLiquido,procedimentos[],produtos[]}] }`. Com `?id=` → `GET /orcamento/{id}` cru. Com `?paciente=` → `cnnOrcamentosDoPaciente`.
- [ ] **Step 2:** Adicionar a rota (padrão das outras `/debug-*`).
- [ ] **Step 3:** `tsc` limpo. Deploy de validação (ver Task 7 para o comando; ou validar via `wrangler dev --remote` se preferir não deployar ainda).
- [ ] **Step 4 (medição real):** chamar em produção e **anotar o volume** por status na janela (dimensiona o pedaço por tick):

Run: `curl -s -H "Authorization: $WEBHOOK_SECRET" "https://kommo-cnn.clarissabergmann03.workers.dev/debug-orcamento?env=production&status=APROVADO&di=2026-01-01&df=2026-07-01"`
Expected: JSON com `total` > 0 e `amostra` com pacientes reais (id/nome/tel/procedimentos/valor). Repetir com `status=ABERTO` e `status=CANCELADO`.

---

### Task 3 — Decisor puro + portão de agenda futura

**Files:** Modify `src/index.ts` (`decidirEtapaOrcamento`, `temAgendaFutura`; expor no `/debug-orcamento?decidir=1`).

**Interfaces — Produces:**
- `temAgendaFutura(pid: string, env): Promise<boolean>` — via `agenda_sync` (D1): existe linha do paciente com `last_agendamento_ts >= agora` e `last_cnn_status` ∈ {AGENDADO, CONFIRMADO_PACIENTE}. (Fallback CNN opcional; começar só-D1.)
- `decidirEtapaOrcamento(orcamentos: any[], temFutura: boolean): { pipeline: number; status: number } | null` — regra da §4 do spec.

- [ ] **Step 1:** Implementar `temAgendaFutura(pid, env)` consultando `agenda_sync` (sem subrequest CNN).
- [ ] **Step 2:** Implementar `decidirEtapaOrcamento(orcamentos, temFutura)`:
  - `if (temFutura) return null;` (portão — agendamento/confirmação mandam).
  - `if (orcamentos.some(o => o.status === "APROVADO")) return { pipeline: PIPELINE_POS_VENDA, status: STAGE_POS_TRATAMENTO_INICIADO };`
  - senão pega o mais recente (maior `id`): `CANCELADO`/`PERDIDO` → `{ PIPELINE_POS_CONSULTA, STAGE_POSCONS_VENDA_PERDIDA }`; senão → `{ PIPELINE_POS_CONSULTA, STAGE_POSCONS_EM_ANALISE }`.
- [ ] **Step 3:** No `/debug-orcamento?decidir=1&paciente=PID&env=...`: retornar `{ pid, temAgendaFutura, orcamentos:[{id,status}], decisao }` — permite auditar a decisão por paciente real sem escrever.
- [ ] **Step 4:** `tsc` limpo. Validar decisão em pacientes reais (dry) e no TESTE Bruno (`paciente=28146949`).

Run: `curl -s -H "Authorization: $WEBHOOK_SECRET" ".../debug-orcamento?decidir=1&paciente=28146949&env=production"`
Expected: JSON coerente (portão respeitado se houver agenda futura; senão a etapa certa pelo status).

---

### Task 4 — Produtor + consumidor + dispatch na fila

**Files:** Modify `src/index.ts` (`produtorOrcamento`, `consumirItemOrcamento`, dispatch em `consumirFila`).

**Interfaces — Consumes:** Tasks 1-3 + `filaEnfileirarLote`, `moveLeadToStage`, `getMapeamentoLeadMap`/busca por telefone, `audit`, `getCursor`/`setCursor`, `orcamentoOk`. **Produces:**
- `produtorOrcamento(env, target, budget): Promise<any>` — enfileira itens `{tipo:"ORC", paciente_id_cnn, ...}`.
- `consumirItemOrcamento(item, env, target, dryRun): Promise<{r,leadId?,nome?}>`.

- [ ] **Step 1:** `produtorOrcamento`: cursor por `dataInicial` deslizante em `tipoData=APROVACAO` (pega aprovações recentes) **+** `tipoData=CRIACAO` para novos; para cada orçamento visto, se `status` difere de `orcamento_sync.ultimo_status` do paciente → enfileira o paciente (dedup por paciente no lote). Loop respeita `orcamentoOk(budget)` e grava o cursor (`getCursor`/`setCursor`, chave `cursor_orcamento`). Resumável.
- [ ] **Step 2:** `consumirItemOrcamento`: acha o lead (`ID Paciente CNN`/telefone/`mapeamento`); sem lead → `{r:"sem_lead"}` (registra, não quebra). Lê `cnnOrcamentosDoPaciente` + `temAgendaFutura` → `decidirEtapaOrcamento`. Se `null` → grava estado e `{r:"sem_mudanca"}`. Senão compara com `orcamento_sync.ultima_etapa`: se **igual** → `{r:"sem_mudanca"}` (1x, respeita move manual); se **baseline** (1ª vez) → grava sem mover, `{r:"baseline"}`; senão `moveLeadToStage(lead, status, env, pipeline)` + grava `orcamento_sync` + `{r:"movido", nome}`.
- [ ] **Step 3:** `consumirFila`: adicionar `else if (item.tipo === "ORC") res = await consumirItemOrcamento(item, env, target, dryRun);`. O bloco de auditoria já cobre `r==="movido"` com `funcao: item.tipo` → registra `funcao:"ORC"` automaticamente.
- [ ] **Step 4:** `tsc` limpo.
- [ ] **Step 5 (dry-run produção):** rodar produtor+consumidor em dry e conferir o que **moveria** (0 escrita):

Run: `curl -s -H "Authorization: $WEBHOOK_SECRET" ".../debug-tick?env=production&dry=1&prod=1&job=orcamento&cap=20"` *(adicionar `job=orcamento` no handler de `/debug-tick`, chamando `produtorOrcamento` + `consumirFila` dry)*
Expected: itens `ORC` com `r: "movido"/"baseline"/"sem_mudanca"`, destinos coerentes, **0 erros**, subreq < 50.
- [ ] **Step 6 (write-path controlado):** com TESTE Bruno, forçar o move real e **reverter** via `/debug-move`:

Run: mover TESTE Bruno para Tratamento Iniciado e conferir no `/debug-audit` (funcao ORC), depois `POST /debug-move` de volta.
Expected: 1 move auditado; revertido após o teste (padrão "limpar após teste").

---

### Task 5 — Ligar no cron (a cada 1 min, budget-aware) atrás de flag

**Files:** Modify `src/index.ts` (`scheduled()`).

- [ ] **Step 1:** Em `scheduled()`, **após** `produtorSync` e **antes** de `consumirFila`, adicionar `await produtorOrcamento(env, target, 45);` — todo minuto. Ordem: (véspera) → sync → **orçamento** → dreno. `orcamentoOk` garante que não estoura; o cursor cobre a base ao longo dos minutos (escalonamento).
- [ ] **Step 2 (flag/gate):** começar com o produtor **limitado** (cap pequeno, ex.: 10) para observar; expandir depois. (Sem env var nova: usar constante no topo `ORC_CAP` fácil de ajustar.)
- [ ] **Step 3:** `tsc` limpo.
- [ ] **Step 4 (pós-deploy, monitorar):** após deploy (Task 7), observar 15-30 min:

Run: `curl -s -H "Authorization: $WEBHOOK_SECRET" ".../debug-audit"`
Expected: entradas `funcao:"ORC"` com destinos certos; **0 conflito** com A3/F2 (nenhum lead pingue-pongando); subreq por invocação dentro do teto. Se algo estranho → reduzir `ORC_CAP` ou reverter (version anterior).

---

### Task 6 — Bateria de testes rigorosa + rollout escalonado

**Files:** nenhum (execução/validação). Usa `/debug-orcamento`, `/debug-tick?job=orcamento`, `/debug-audit`, `/debug-move`, `/test-workflow`.

- [ ] **Step 1 — casos (dry-run produção + TESTE Bruno):**
  1. `APROVADO` → Tratamento Iniciado (Pós-Venda).
  2. `ABERTO` (sem aprovado) → Em Análise (Pós-Consulta).
  3. `CANCELADO`/`PERDIDO` (sem aprovado) → Venda Perdida (Pós-Consulta).
  4. Paciente **com agenda futura** → **não move** (portão) — verificar num paciente real com agenda +N dias.
  5. Alvo inalterado / já na etapa → **não move** (rodar 2× → 2ª sem ação).
  6. Orçamento **sem lead** correspondente → `r:"sem_lead"`, não quebra.
  7. Erro CNN/Kommo simulado (id inválido) → item vira erro, lote **não** quebra.
- [ ] **Step 2 — rollout escalonado** (igual ao da confirmação): (a) dry medido → (b) ligar com `ORC_CAP` pequeno + observar `/debug-audit` → (c) expandir cap gradualmente conferindo 0 erro/0 conflito.
- [ ] **Step 3 — limpar:** reverter TESTE Bruno e qualquer lead de teste movido; conferir fila sem lixo (`filaStats`).
- [ ] **Step 4 — relatório curto:** anotar por caso (1-7) o resultado observado (o "relatório de validação" do entregável).

---

### Task 7 — Deploy (gate de OK) + memória

**Files:** deploy; Modify memória.

- [ ] **Step 1:** `npx tsc --noEmit` limpo (só erros pré-existentes).
- [ ] **Step 2 (GATE):** confirmar OK do dono antes do deploy.
- [ ] **Step 3:** deploy:

Run:
```powershell
$env:CLOUDFLARE_API_TOKEN="$CF_TOKEN"  # nunca commitar o valor real — ler de env local
Set-Location "D:\clarissa-bergmann\kommo-cnn"; npx wrangler deploy
```
Expected: deploy ok; anotar novo Version ID (ponto de rollback = `b0167bfa`).
- [ ] **Step 4:** atualizar a memória (estado atual: versão nova no ar, ORC ligado, resultados do rollout).

---

## Self-review (spec coverage)

- §4 regra central → Tasks 3-4 (decisor + consumidor). ✅
- §5 trigger 1min/cursor + `orcamento_sync` → Tasks 1,4,5. ✅
- §6 erros + auditoria `funcao:"ORC"` → Task 4 (Step 2/3) + Task 6 (caso 7). ✅
- §7 testes (dry prod + fixtures + limpar) → Tasks 2,4,6. ✅
- §8 endpoints/entregáveis → Tasks 2,4. ✅
- §9 decisões travadas (PERDIDO=Venda Perdida; APROVADO tem prioridade; não mexe no sync; 1min) → Tasks 3,5. ✅
- §10 riscos (cursor CRIACAO/APROVACAO; agenda futura via agenda_sync; baseline; medir volume) → Tasks 2,3,4. ✅
- **Sem placeholders**; tipos consistentes (`decidirEtapaOrcamento`, `temAgendaFutura`, `produtorOrcamento`, `consumirItemOrcamento`, `cnnOrcamentosDoPaciente` usados igual em todas as tasks). Conflitos A3/F2 cobertos pelo portão + ordem no `scheduled()` (Task 5) + monitoramento (Task 5 Step 4).
