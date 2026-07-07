# Item 2 — Kommo→CNN (W1 criação + reconciliação) — Implementation Plan

> **For agentic workers:** SUB-SKILL: superpowers:subagent-driven-development. Cada tarefa: o subagente lê o spec + a função-alvo atual em `src/index.ts`, edita e valida (`tsc` + dry-run sandbox). Steps com checkbox.

**Goal:** Adicionar a direção **Kommo→CNN** — W1 cria paciente+agenda no CNN (lendo custom fields do card), W2 confirma, e uma reconciliação por polling empurra status (CONFIRMADO/FINALIZADO) pro CNN. Tudo validado no **sandbox**; liberar produção é gate à parte (§7.8).

**Architecture:** Escreve no CNN via `cnnPost/cnnPut` (hoje travados em produção por `assertCnnWritable`). Constrói/valida tudo no sandbox; a liberação de produção vira um interruptor granular + OK do dono. Reconciliação é duplicata-aware (cada card → a agenda do seu grupo).

**Tech Stack:** TypeScript, Cloudflare Worker, D1, wrangler, API Kommo v4, API CNN. Validação: `tsc` + `/debug-*` sandbox + `/test-workflow`.

**Spec:** `docs/superpowers/specs/2026-06-29-kommo-cnn-item2-kommo-para-cnn-design.md`.

**Pré-requisito:** a **fase da duplicata** (modelo `(paciente,grupo)`) deve estar implementada antes — a reconciliação depende do mapeamento por grupo.

## Global Constraints
- §7.8: escrita CNN só liberada em produção via gate explícito; até lá, sandbox. `assertCnnWritable` permanece como base.
- Status: "Consulta Confirmada"→`CONFIRMADO_PACIENTE`; "Avaliação Realizada"→`FINALIZADO`. Só escreve se diverge (idempotente).
- W1: só cria se o lead tiver os custom fields preenchidos; não inventa (escopo "não chuta IDs").
- Anti-eco: toda escrita Kommo→CNN atualiza `agenda_sync` na hora.
- Sem git → checkpoint = `tsc` ok; rollback = Version ID anterior.

---

### Task 1 — Setup: custom fields no Kommo + resolver de profissional
**Files:** `src/index.ts` (+ chamada de setup via API Kommo).
- Criar (via `POST /leads/custom_fields`, idempotente) os campos **"Tipo Consulta CNN"** e **"Profissional CNN"** (select). Popular as opções a partir de `GET /tipo-consulta/lista` e `GET /executor-agenda/lista` do CNN.
- Novo resolver `resolveExecutores(env,target)` (cache 1h, análogo a `resolveTiposConsulta`): nome normalizado → idExecutor.
- [ ] Implementar o setup dos campos (endpoint `/debug-setup-campos-w1`) + `resolveExecutores`. `tsc`. Rodar o setup no Kommo; conferir os 2 campos criados via `/discover`.

### Task 2 — W1 (criação) lendo os custom fields — sandbox
**Files:** `src/index.ts` — `handleLeadAgendado`.
- Ler `AGENDAMENTO` + "Tipo Consulta CNN" + "Profissional CNN" do lead; resolver tipo (resolveTiposConsulta) e executor (resolveExecutores) → IDs CNN; convênio Particular; local default; horaFim=+30min.
- Se faltar tipo/profissional → não cria; retorna pendência (log). Grava `ID Agenda CNN`/`ID Paciente CNN` + atualiza `agenda_sync` (anti-eco). `target="sandbox"`.
- [ ] Implementar + `tsc` + validar no sandbox (allowlist): card com campos preenchidos → cria agenda no CNN sandbox; sem campos → não cria. Limpar depois.

### Task 3 — Reconciliação por polling (duplicata-aware) — sandbox
**Files:** `src/index.ts` — nova função `reconciliarStatusKommoCnn(env,target,dryRun)` + ligação no tick (`consumirFila`/scheduled, sandbox).
- Varre leads em "Consulta Confirmada" e "Avaliação Realizada"; pra cada card, acha a agenda do **seu grupo** (`ID Agenda CNN`/mapeamento (paciente,grupo)); lê status no CNN; se diverge → `PUT /agenda/alteracao-status` (CONFIRMADO_PACIENTE / FINALIZADO); atualiza `agenda_sync`.
- [ ] Implementar + `tsc` + validar no sandbox: lead em Consulta Confirmada → agenda vira CONFIRMADO_PACIENTE; em Avaliação Realizada → FINALIZADO; rodar 2× → 2ª vez não reescreve (idempotente). Limpar depois.

### Task 4 — W2 (confirmação) revalidado no modelo de duplicata — sandbox
**Files:** `src/index.ts` — `handleConfirmacao`.
- Garantir que confirma a agenda do card certo (grupo) e atualiza baseline. `target="sandbox"`.
- [ ] Ajustar (se preciso) + `tsc` + validar no sandbox.

### Task 5 — Interruptor §7.8 + trava de prontuário
**Files:** `src/index.ts` — `assertCnnWritable`.
- Trava de prontuário: denylist `prontu|evolu|anamnese|prescri|receit|laudo|anexo` → bloqueia em QUALQUER ambiente.
- Liberação granular: var `CNN_WRITE_ENABLED` + allowlist de caminhos permitidos em produção (`/agenda/novo`, `/agenda/alteracao-status`, `/paciente/novo`, `/convenio-paciente/associar`). Sem a flag/allowlist → bloqueado como hoje.
- [ ] Implementar + `tsc` + testar que: prontuário sempre bloqueado; produção bloqueada sem a flag; com flag+allowlist, caminho liberado passa.

### Task 6 — Rollout (GATE: OK do dono)
- [ ] Bateria E2E no sandbox (W1, W2, reconciliação) cobrindo duplicata; **limpar tudo**.
- [ ] Configurar webhooks no Kommo (`lead-agendado` já; confirmar `confirmacao`/Salesbot).
- [ ] **GATE — OK do dono** pra liberar escrita CNN em produção (ligar `CNN_WRITE_ENABLED` + allowlist, um caminho por vez).
- [ ] Deploy + monitorar `/debug-audit` + conferir no CNN as primeiras escritas reais.

## Riscos
- **Escreve no CNN de produção real** — sandbox-first + gate + granular. Maior risco.
- Depende da **fase da duplicata** estar feita (reconciliação por (paciente,grupo)).
- Webhooks + custom fields são **setup no Kommo** (fora do código) — sem eles, W1 não cria.
- Resolver de profissional depende dos nomes baterem (como o roteamento de tipos).
