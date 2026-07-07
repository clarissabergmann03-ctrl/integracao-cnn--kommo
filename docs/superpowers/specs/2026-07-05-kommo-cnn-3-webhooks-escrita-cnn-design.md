# Webhooks Kommo→CNN (escrita guardada) — Design

> **⚠️ ATUALIZAÇÃO 2026-07-06 — Webhook 3 (remarcar) REMOVIDO.** O dono observou que remarcação é uma **ação do CNN**, já refletida automaticamente pela **REGRA 1** (`consumirItemA3` ~L2309: quando a hora muda no CNN, atualiza o card + reposiciona). Um webhook Kommo→CNN de remarcar não tem gatilho real (ninguém remarca editando um campo do card). Ficaram só **2 webhooks** (Confirmar, Pós-Venda Agendar). O "falta 1 dia → tarefa" foi **dropado** junto. As seções abaixo sobre o Webhook 3 / `CNN_REMARCAR` / `faltaUmDia` são **histórico** — não valem mais.

> **Data:** 2026-07-05 · **Status:** aprovado (brainstorming, 4 seções); Webhook 3 removido em 06/07 · **Autor:** dono + agente
> **Escopo:** 3 novas funções que ESCREVEM no CNN a partir de eventos do Kommo, com anti-loop reusando `agenda_sync` e um allowlist de escrita que impede qualquer operação fora do objetivo.

## 1. Contexto e decisões do dono

Sistema existente = Cloudflare Worker (`src/index.ts`) que sincroniza CNN (clínica) ↔ Kommo (CRM). Hoje a direção **CNN→Kommo é polling** (`produtorSync`/`consumirItemA3`, a "REGRA 1") e a **escrita no CNN de produção é bloqueada** por `assertCnnWritable` (§7.8).

Decisões tomadas no brainstorming (2026-07-05):
- **D1 — Escrita no CNN de produção: LIBERADA, mas por allowlist estreito.** Nunca apagar paciente nem tocar em nada fora do objetivo. Trava por código, não promessa.
- **D2 — 3 webhooks Kommo→CNN**, disparados pelo Salesbot por etapa (mesmo padrão do "consulta agendada"/W1). O **polling CNN→Kommo continua intacto**. O Worker só escreve no CNN via evento do Kommo, nunca "à toa".
- **D3 — Anti-loop reusa `agenda_sync`** (não cria tabela nova). A chave de idempotência é `(last_agendamento_ts, last_cnn_status)` — que já é o "hash do payload".
- **D4 — Execução pela fila** (não síncrona): webhook valida + enfileira; o consumidor escreve no CNN reusando retry/backoff (A4) + claim atômico (C1) + dead-letter (A5).
- **D5 — Pós-venda cria agenda com TIPO escolhido pela secretária** via campo novo no card (mapeado ao vivo do CNN). Nunca cria paciente (exige paciente existente); só cria **agenda**, nada de orçamento/cadastro/financeiro.

## 2. Arquitetura

```
Kommo Salesbot ─POST /webhook/…?secret= ─► Handler (rápido, síncrono)
                                             1. valida secret + leadId
                                             2. lê o card (etapa, AGENDAMENTO, IDs, responsável, [Familia]?)
                                             3. shouldExecute(agenda_sync): já no alvo? → loga "suprimido" + 200
                                                                             novo? → enfileira job + 200
Fila (cron 1/min) ─► Consumidor ─► ESCREVE no CNN (allowlist, target = CNN_WRITE_TARGET)
                                     reusa fetchComRetry (A4) + claim (C1) + dead-letter (A5)
                                     sucesso → agenda_sync(novo ts/status, origin=system) + grava ID Agenda no card
Polling CNN→Kommo (REGRA 1, inalterado) ─► convergência de (last_agendamento_ts ±60s, last_cnn_status) → "sem mudança" → NÃO rebate
```
> **Nota (pós-certificação):** o guarda anti-loop é a **convergência de `(last_agendamento_ts, last_cnn_status)`**. A coluna `origin` é observabilidade/proveniência (e discriminador de idempotência no create), **não** um backstop lido pelo polling.

## 3. As 3 funções

Campo novo no card (`POST /leads/custom_fields`): select **"Tipo Procedimento CNN"** → `idTipoConsulta` (valores confirmados ao vivo em produção 2026-07-05):
`Procedimento→66670 · Cirurgia→93892 · Pequenas Cirurgias→66667 · Encaixe→66668 · Retorno→66672 · Cortesia→67118 · Encaminhamento-INTERNO→66669`.

### Webhook 1 — Consulta Confirmada (Grupo A) — estende `/webhook/confirmacao` (W2)
- **Dispara:** card → "Consulta Confirmada".
- **Handler:** lê `ID Agenda CNN`; recusa se `[Familia]`; `shouldExecute`: suprime se `agenda_sync.last_cnn_status == 'CONFIRMADO_PACIENTE'`.
- **Job `CNN_CONFIRMAR`:** `PUT /agenda/alteracao-status {idAgenda, status:'CONFIRMADO_PACIENTE'}` → `agenda_sync(status, origin=system)`.

### Webhook 2 — Consulta Agendada (Grupo B, pós-venda) — novo `/webhook/pos-venda-agendar`
- **Dispara:** card pós-venda → "Cliente Ativo" com **AGENDAMENTO** + **Tipo Procedimento CNN** preenchidos.
- **Handler:** exige `ID Paciente CNN` (paciente já existe — nunca cria paciente); recusa `[Familia]`; `shouldExecute CNN_AGENDAR`: suprime se o card já tem `ID Agenda CNN` **e** `ts` inalterado (retorno da confirmação = o loop).
- **Job `CNN_AGENDAR`:** `POST /agenda/novo {data,hora,idPaciente,idPacienteConvenio, idTipoConsulta:<campo>, status:'AGENDADO'}` → grava `ID Agenda CNN` no card + cria `agenda_sync(origin=system)`.

### Webhook 3 — Agendamento atualizado (A e B) — novo `/webhook/remarcar` — reusa `syncKommoParaCnn`
- **Dispara:** campo **AGENDAMENTO** alterado num card que já tem `ID Agenda CNN`.
- **Handler:** recusa `[Familia]`; `shouldExecute CNN_REMARCAR`: suprime se `|ts_novo − last_agendamento_ts| ≤ 60s`.
- **Job `CNN_REMARCAR` (2 passos):**
  1. **Sempre:** `POST /agenda/{id}/remarcar {novaData, novoHorarioInicial, novoHorarioFinal}` → `agenda_sync(ts, origin=system)`.
  2. **Roteia o card por grupo, com exceção "falta 1 dia"** (`ts − agora ≤ 24h`):
     - **> 1 dia:** move → A: Consulta Agendada (`ETAPA_BASE[A]`); B: Cliente Ativo (`ETAPA_BASE[B]`, ~no-op).
     - **≤ 1 dia:** **não move**; cria tarefa Kommo "Verificar agendamento" atribuída ao `responsible_user_id` do lead, anexada ao lead (`entity_id`/`entity_type`), `complete_till` = hora da consulta.

## 4. Anti-loop (`shouldExecute`)

Estado = `agenda_sync` (existente) + coluna aditiva `origin TEXT` (`cnn`|`kommo`|`system`).

| Job | Suprime quando | Executa quando |
|---|---|---|
| `CNN_CONFIRMAR` | `last_cnn_status == 'CONFIRMADO_PACIENTE'` | senão |
| `CNN_AGENDAR` | card já tem `ID Agenda CNN` **e** `ts` inalterado | sem agenda **ou** ts novo |
| `CNN_REMARCAR` | `\|ts_novo − last_agendamento_ts\| ≤ 60` | ts mudou |

Fecha o loop: o job grava `agenda_sync` (ts/status convergidos) ao escrever → o polling CNN→Kommo vê `ts` convergido → não rebate.

**Purga de reversão (achado da certificação):** as chaves de fila `CNN_*:${id}:${ts}` são permanentes (`INSERT OR IGNORE`). Sem tratamento, um re-disparo legítimo após reversão (confirma→desconfirma→reconfirma; remarca t0→t1→t0→t1) colidiria com o gêmeo `feito` e seria descartado em silêncio. Por isso, cada handler chama **`purgarGemeoFeito(chave)`** (espelha a mitigação A3-REVERSÃO) logo após `decidirSupressao` provar mudança real e antes de enfileirar.

**Double-check no consumidor:** só o `CNN_AGENDAR` relê o card (é o único cujo `shouldExecute` depende de um campo do card — `ID Agenda CNN`). `CONFIRMAR`/`REMARCAR` decidem sobre `agenda_sync` por desenho; a drenagem serializada (lease + ordem por id) garante o estado final correto.

## 5. Guardrail (allowlist de produção)

`assertCnnWritable(target, method, path)` em `production` permite **só**:
- `POST /agenda/novo`
- `PUT /agenda/alteracao-status` (status ∈ {`AGENDADO`,`CONFIRMADO_PACIENTE`})
- `POST /agenda/{id}/remarcar`
- `POST /convenio-paciente/associar` (pré-requisito do `/agenda/novo`, só se faltar)

Tudo o mais em produção **lança** (qualquer `DELETE`, `/paciente/*`, prontuário, orçamento, financeiro). `[Familia]`/colisão (≥2 pacientes no lead) → **recusa escrita** + tarefa de revisão. Allowlist é **fail-safe**: job com escrita proibida → dead-letter, CNN nunca tocado.

## 6. Erros e casos de borda

- CNN instável → `fetchComRetry`. `POST /agenda/novo` usa `retryPost()` (só 429). **Idempotência do create (achado da certificação):** como o retry da fila pode reexecutar após falha pós-create, `consumirItemCnnAgendar` grava `agenda_sync` (marcador durável) ANTES de tocar o card e, antes de criar, checa duas barreiras — (1) `agenda_sync` por `lead+ts+AGENDADO+origin=system`; (2) lookup no CNN (`acharAgendaCnnPorHorario`, GET permitido) — adotando a agenda existente em vez de criar outra.
- Falhas terminais dos jobs → `audit(acao:'dead-letter')` + `/debug-fila-erros` (não há `acao:'erro'`; transitórios não poluem o log, por design BX1).
- Dado faltando (sem `ID Paciente CNN`/AGENDAMENTO/Tipo) → 200 "skipped" (+ tarefa quando fizer sentido), sem loop de retry do Salesbot.
- Paciente com várias agendas B → webhook 3 opera na agenda do card (`ID Agenda CNN`); limitação documentada.

## 7. Alvo, flags e rollout

- `CNN_WRITE_TARGET` (env) = `sandbox` (default) | `production`. Allowlist só restringe `production`.
- Flags por webhook: `WH1_ENABLED`/`WH2_ENABLED`/`WH3_ENABLED` (default OFF).
- Rollout: lógica pura → E2E sandbox (TESTE Bruno pid 28146949) → dry-run prod → flip `production` + flags → observar `/debug-audit` + `/debug-fila-erros`. Limpar artefatos de teste.

## 8. Observabilidade (requisito 6)

Cada decisão → `auditoria` (`funcao` ∈ CNN_CONFIRMAR/AGENDAR/REMARCAR; `acao` ∈ executou / suprimido_ja_no_alvo / suprimido_loop / recusado_familia / erro). Visível no `/debug-audit`; dead-letters no `/debug-fila-erros`; selftest em `/debug-selftest`.

## 9. Checklist de implementação

1. Migração `agenda_sync ADD COLUMN origin TEXT` em `ensureSchema` (aditiva, idempotente).
2. `assertCnnWritable` → allowlist de produção + guarda `[Familia]`.
3. `CNN_WRITE_TARGET` + resolução do target nos wrappers `cnnPost/cnnPut` dos 3 jobs.
4. `shouldExecute(agendaId, alvo, env)` (puro sobre `agenda_sync`).
5. Fila: 3 tipos de job (`CNN_CONFIRMAR`/`CNN_AGENDAR`/`CNN_REMARCAR`) + consumidores; ligar no `consumirFila`/dispatcher.
6. Handlers `/webhook/pos-venda-agendar` e `/webhook/remarcar` + estender `/webhook/confirmacao`; rotas no dispatcher; `?dry=1`.
7. Criar campo Kommo "Tipo Procedimento CNN" (`/mig-criar-campos`-like, idempotente) + mapa opção→`idTipoConsulta`.
8. Tarefa "falta 1 dia" (reusa padrão `criarTarefaAlertaKommo`, com `responsible_user_id` do lead + entity attach).
9. Flags `WH1/2/3_ENABLED`.
10. Selftest: `shouldExecute`, fronteira "falta 1 dia", recusa `[Familia]`, allowlist.
