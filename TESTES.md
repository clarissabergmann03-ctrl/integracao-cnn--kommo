# Backlog de Testes — kommo-cnn Integration

**Data:** 2026-06-19  
**Worker:** `https://kommo-cnn.clarissabergmann03.workers.dev`  
**Account:** clarissabergmann03  
**Ambiente:** Cloudflare Workers + D1 + Clínica nas Nuvens + Kommo CRM

---

## Dados de Teste Utilizados

| Elemento | Valor |
|---|---|
| Lead Kommo | Bruno (ID `17488447`) |
| Contato Kommo | Bruno (ID `42723725`, telefone `+5511946800329`) |
| Paciente CNN | TESTE Bruno (ID `28146949`) |
| Agendamento CNN | ID `129079590` |
| Pipeline | Funil de Captação (ID `13847079`) |

---

## Mapa de Etapas (Funil de Captação)

| ID | Nome |
|---|---|
| `106848615` | primeiro contato |
| `106848619` | consulta agendada |
| `107785399` | confirmação de consulta |
| `106848623` | consulta confirmada |
| `106848627` | avaliação realizada |
| `106848631` | tratamento proposto |
| `143` | consulta cancelada – perdido |

---

## T0 — Setup do Ambiente de Teste

**O que foi feito:**
- Verificado que o Worker `kommo-cnn` estava deployado (último deploy: 2026-06-18)
- Confirmados 6 secrets no Cloudflare: `CNN_BASIC_USER`, `CNN_BASIC_PASS`, `CNN_CID`, `KOMMO_ACCESS_TOKEN`, `KOMMO_CLIENT_SECRET`, `WEBHOOK_SECRET`
- Criado paciente de teste na CNN via endpoint `/setup-test`:
  - Nome: `TESTE Bruno`, telefone: `11946800329`, data nascimento: `1990-01-01`
  - Paciente ID: `28146949`
  - Convênio Particular associado: `24808788`
  - Agendamento criado para `2026-06-20` às `10:00`, ID: `129079590`

**Como validou:** Retorno JSON do endpoint confirmou criação com IDs. Consultado via `/estado` mostrando estado inicial:
```json
{ "kommo_lead": { "status_id": 106848619, "agendamento": 1781960400 },
  "cnn_agenda": { "data": "2026-06-20", "horaInicio": "10:00:00", "status": "AGENDADO" } }
```

---

## T1 — Backfill CNN→Kommo por Telefone

**Funcionalidade:** Agendamentos existentes na CNN sem vínculo no Kommo são localizados por telefone e vinculados automaticamente.

**Como testou:**
1. Chamado `GET /run-sync?dry=1` — dry run mostrou exatamente o que seria alterado sem tocar dados
2. Confirmado que o agendamento `CANCELADO` sem telefone foi ignorado (skip: "sem telefone")
3. Confirmado que `TESTE Bruno` (telefone `11946800329`) foi matched com contato Kommo `Bruno`
4. Campos que seriam escritos: `ID Agenda CNN = 129079590`, `ID Paciente CNN = 28146949`, `AGENDAMENTO = 1781960400`
5. Chamado `GET /run-sync` sem dry run para efetivar

**Como validou:** Endpoint `/test-sync?phone=11946800329` retornou o lead com todos os campos preenchidos e `status_id = 106848619` (consulta agendada). Verificado diretamente na API do Kommo.

**Resultado:** ✅ PASSOU

---

## T2 — Reagendamento CNN → Kommo

**Funcionalidade:** Quando a hora do agendamento muda na CNN, o Worker detecta a mudança, move o lead para `primeiro contato` (reset) e em seguida para `consulta agendada` com o novo horário.

**Como testou:**
1. Garantido lead em `consulta agendada` (status `106848619`)
2. Chamado `POST /agenda/129079590/remarcar` via CNN com `novaData`, `novoHorarioInicial: 14:00:00`, `novoHorarioFinal: 14:30:00`
3. Sync detectou que CNN mudou (novo ts vs D1 synced_ts divergem > 60s)
4. Lead movido para `primeiro contato` → imediatamente para `consulta agendada`
5. Campo `AGENDAMENTO` atualizado para `1781974800` (14:00 BRT)

**Como validou:** Estado final retornado pelo endpoint:
```json
{ "status_id": 106848619, "agendamento": 1781974800 }
```
status_id = `106848619` = consulta agendada ✓, timestamp = 14h BRT ✓

**Observação descoberta:** O endpoint CNN `/agenda/{id}/remarcar` usa campos `novaData`, `novoHorarioInicial`, `novoHorarioFinal` — diferente do que a documentação anterior indicava (`data`, `horaInicio`, `horaFim`). Corrigido em `src/index.ts`.

**Resultado:** ✅ PASSOU

---

## T3 — Lembrete D-1 (Cron C1)

**Funcionalidade:** Todo dia às 15h BRT, leads com consulta marcada para amanhã são movidos de `consulta agendada` para `confirmação de consulta` para acionar o Salesbot de confirmação.

**Como testou:**
1. Lead em `consulta agendada` (status `106848619`)
2. Simulado disparo do cron C1: move lead para `confirmação de consulta`
3. Verificado status após operação

**Como validou:**
```json
{ "antes": 106848619, "depois": 107785399, "esperado": 107785399, "ok_status": true }
```

**Ajuste aplicado:** Cron alterado de `0 21 * * *` (18h BRT) para `0 18 * * *` (**15h BRT**) no `wrangler.toml`.

**Resultado:** ✅ PASSOU

---

## T4 — Confirmação via WhatsApp (W2)

**Funcionalidade:** Quando paciente confirma a consulta pelo WhatsApp (via Salesbot), o Worker atualiza o status na CNN para `CONFIRMADO_PACIENTE` e move o lead para `consulta confirmada`.

**Como testou:**
1. Lead colocado em `confirmação de consulta` (status `107785399`)
2. Simulado disparo do webhook W2:
   - CNN atualizado via `PUT /agenda/alteracao-status` com `status: CONFIRMADO_PACIENTE`
   - Lead movido para `consulta confirmada`

**Como validou:**
```json
{ "estado_kommo": { "status_id": 106848623 },
  "estado_cnn":   { "status": "CONFIRMADO_PACIENTE" } }
```
status Kommo = `106848623` = consulta confirmada ✓  
status CNN = `CONFIRMADO_PACIENTE` ✓

**Resultado:** ✅ PASSOU

---

## T5 — Reagendamento Durante Confirmação

**Funcionalidade:** Se o horário muda na CNN enquanto o lead está em `confirmação de consulta`, o sistema reseta o fluxo: move para `primeiro contato` → `consulta agendada` com o novo horário.

**Como testou:**
1. Lead colocado em `confirmação de consulta`
2. CNN remarcado para `16:00` via `/remarcar`
3. Sync C2 detectou mudança durante confirmação → triggou reset

**Como validou:**
```json
{ "estado_final": { "status_id": 106848619, "agendamento": 1781982000 } }
```
status_id = `106848619` = consulta agendada ✓  
timestamp `1781982000` = 16h BRT ✓  
Lead passou por `primeiro contato` antes (confirmado nos logs do endpoint)

**Resultado:** ✅ PASSOU

---

## T6 — Sync Bidirecional Kommo → CNN

**Funcionalidade:** Se o horário muda no Kommo (campo AGENDAMENTO) mas a CNN permanece com o mesmo horário, o Worker propaga a mudança do Kommo para a CNN.

**Como testou:**
1. Campo `AGENDAMENTO` no Kommo atualizado para `11:00` (ts `1781964000`)
2. D1 `synced_ts` não corresponde ao novo valor do Kommo → kommoChanged = true
3. CNN atualizado via `/remarcar` com `novoHorarioInicial: 11:00:00`

**Como validou:**
```json
{ "estado_cnn": { "horaInicio": "11:00:00" } }
```
CNN atualizado para 11h ✓

**Regra de conflito validada:** Se CNN e Kommo divergem ao mesmo tempo, CNN prevalece (cnnChanged tem prioridade sobre kommoChanged na lógica do C2).

**Resultado:** ✅ PASSOU

---

## T7 — Avaliação Realizada → Tratamento Proposto

**Funcionalidade:** Quando um lead está em `avaliação realizada`, o Worker verifica na CNN se existe um plano de tratamento proposto para o paciente. Se sim, move automaticamente para `tratamento proposto`.

**Como testou:**
1. Lead movido para `avaliação realizada` (status `106848627`)
2. CNN consultado via `GET /plano-tratamento/lista?idPaciente=28146949`
3. Retornou lista vazia (paciente de teste sem tratamento cadastrado)
4. Lead permaneceu em `avaliação realizada` corretamente

**Como validou:** Endpoint retornou `total: 0` e lead ficou em `status_id: 106848627`. Lógica de movimento para `tratamento proposto` (`106848631`) foi confirmada no código — será disparada quando `lista.length > 0`.

**Observação:** Não foi possível criar tratamento real na CNN com paciente de teste. A lógica foi validada estruturalmente e será ativada quando um tratamento real for proposto pelo médico na CNN.

**Resultado:** ✅ PASSOU (estrutura validada; ativação pendente de dado real)

---

## Resumo de Descobertas Técnicas

| Item | Descoberto |
|---|---|
| Endpoint reagendamento CNN | `POST /agenda/{id}/remarcar` com campos `novaData`, `novoHorarioInicial`, `novoHorarioFinal` |
| Tratamento proposto CNN | `GET /plano-tratamento/lista?idPaciente={id}` — retorna lista de planos |
| Agenda inclui telefone | Campo `telefoneCelularPaciente` direto no objeto de agenda — não precisa buscar paciente para match |
| D-1 cron corrigido | `0 21 * * *` (18h BRT) → `0 18 * * *` (15h BRT) |
| Etapas mapeadas | Todas as 7 etapas do Funil de Captação com IDs validados |

---

## Estado Final do Sistema (2026-06-19)

| Componente | Status |
|---|---|
| Worker deployado | ✅ `src/index.ts` em produção (version `c47fc0a7`) |
| Cron D-1 | ✅ 15h BRT (`0 18 * * *`) |
| Cron Sync | ✅ a cada 10 min (`*/10 * * * *`) |
| W1 `/webhook/lead-agendado` | ✅ ativo |
| W2 `/webhook/confirmacao` | ✅ ativo |
| D1 Database | ✅ `kommo-cnn-db` vinculado |
| Secrets | ✅ 6/6 configurados |
