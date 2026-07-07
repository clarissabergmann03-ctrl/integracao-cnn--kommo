# Duplicata + anti-spam + sync-pelo-mais-próximo — Implementation Plan

> **For agentic workers:** SUB-SKILL: superpowers:subagent-driven-development. Cada tarefa: o subagente lê o spec + a função-alvo atual em `src/index.ts`, faz a edição e valida (`tsc` + dry-run sandbox). Steps com checkbox.

**Goal:** Substituir o "B-vence" por modelo de **2 cards por paciente** (Captação=A, Pós-Venda=B) com ciclo de vida por grupo, **anti-spam de confirmação** e **sync pelo mais próximo**, na direção CNN→Kommo.

**Architecture:** `mapeamento` vira chave `(paciente, grupo)`. O sync mantém cada card pelo seu grupo (B pegajoso em Cliente Ativo; A condicional, sem A vigente → Perdido; duplicata "(duplicata)" quando há A+B). Confirmação fica duplicata-aware. Tudo CNN→Kommo (não escreve CNN).

**Tech Stack:** TypeScript, Cloudflare Worker, D1, wrangler. Sem suíte de testes → validação por `tsc` + `/debug-*` em sandbox + `/debug-audit`.

**Spec:** `docs/superpowers/specs/2026-06-29-kommo-cnn-duplicata-antispam-sync-design.md` (ler antes de cada tarefa).

## Global Constraints
- §7.8: nenhum `cnnPost/cnnPut`. Lê CNN, escreve Kommo.
- Grupo A = {atendimento social, consulta/avaliação}; B = demais. Roteamento por NOME (`grupoDaAgenda`).
- Cancelamento: A→"Cancelada–Perdido"(143); B→permanece "Cliente Ativo"(107658911).
- Idempotência/anti-ressurreição por `(paciente, grupo)`.
- "Mais próximo": com várias agendas do mesmo grupo, usar a de data/hora mais iminente.
- **Sistema vivo:** validar TUDO no sandbox antes; **deploy = gate de OK do dono**; migração do `mapeamento` no D1 é destrutiva → backup antes.
- Plano free: `resetSubreq()` no início; `consumirFila`/migração respeitam teto ~50 subreq/invocação.
- Sem git → sem commits; checkpoint = `tsc` ok; rollback = Version ID anterior + tabela de backup do D1.

---

### Task 1 — Modelo de dados: `mapeamento` por (paciente, grupo) + migração

**Files:** `src/index.ts` — `ensureSchema`, `upsertMapeamento`, `getMapeamentoByPaciente`, `getMapeamentoIdSet`, `getMapeamentoLeadMap`; novo endpoint `/debug-migrar-mapeamento`.

**Comportamento:**
- Nova tabela `mapeamento` com `PRIMARY KEY (paciente_id_cnn, grupo)`, colunas: `paciente_id_cnn, grupo, lead_id_kommo, telefone_norm, duplicata, criado_em, atualizado_em`. Índices: `idx_map_tel`, `idx_map_lead`, novo `idx_map_pac` (paciente).
- Helpers viram cientes de grupo: `upsertMapeamento({paciente_id_cnn, grupo, lead_id_kommo, telefone_norm, duplicata})`; `getMapeamento(paciente, grupo)`; `getMapeamentoLeadMap()` retorna `Map<"pac|grupo", lead>`; `getMapeamentoIdSet()` retorna `Set<"pac|grupo">`.
- **Migração** (endpoint `/debug-migrar-mapeamento`, idempotente, em lote sob o teto de subreq): (1) cria `mapeamento_bak` (cópia de segurança) se não existir; (2) cria a tabela nova com PK composta; (3) copia as linhas inferindo `grupo` pelo **pipeline atual do lead** (lookup Kommo em lote: pipeline Captação→"A", Pós-Venda→"B"); processa em chunks com cursor, retomável; (4) ao terminar, troca os nomes (rename) numa chamada final `?commit=1`.

**Steps:**
- [ ] **1.** Ler o spec (§3, §8) e as funções atuais (`ensureSchema`, os 4 helpers de mapeamento).
- [ ] **2.** Reescrever o DDL de `mapeamento` em `ensureSchema` (PK composta + colunas + índices). Manter `CREATE TABLE IF NOT EXISTS` (não destrói; a troca real é via migração).
- [ ] **3.** Atualizar os helpers para a chave composta (assinaturas acima). Atualizar TODOS os call-sites para passar `grupo`.
- [ ] **4.** Implementar `/debug-migrar-mapeamento` (backup + recriação + cópia inferindo grupo + `?commit=1`).
- [ ] **5.** `npx tsc --noEmit` → sem erros novos.
- [ ] **6.** Validar no sandbox: chamar a migração em dry/lote, conferir contagem `mapeamento_bak` == origem e grupos inferidos coerentes (Captação→A, Pós-Venda→B) via `/debug-audit`/consulta.

---

### Task 2 — Sync: ciclo de vida dos 2 cards + mais-próximo

**Files:** `src/index.ts` — `produtorSync`, `consumirItemA3` (e helpers de apoio).

**Comportamento (por paciente, por grupo, independente):**
- Coletar agendas da janela; agrupar por paciente; para cada grupo (A/B) pegar a agenda **mais próxima** não-terminal (a "vigente").
- **B vigente** → garantir card Pós-Venda "Cliente Ativo" (criar se `(pac,B)` não existe; vincular por telefone+pipeline Pós-Venda se já há lead lá). **Pegajoso:** nunca tirar de Cliente Ativo por status terminal de B.
- **A vigente** → garantir card Captação na etapa do `MAPA_STATUS[A][status]`; se o paciente também tem `(pac,B)` → o card A leva sufixo " (duplicata)".
- **Sem A vigente** mas existe `(pac,A)` → mover esse card para "Cancelada–Perdido" (143).
- **Criação da duplicata:** quando há A vigente E B vigente e falta o card A → criar a duplicata no Captação (nome + " (duplicata)").
- Baseline (`agenda_sync`) por agenda como hoje (anti-eco), agora por (paciente,grupo) no enfileiramento. Lookup de lead por telefone deve filtrar **por pipeline do grupo** (não pegar `leads[0]` cego).

**Steps:**
- [ ] **1.** Ler spec (§4, §5, §7) + `produtorSync`/`consumirItemA3` atuais.
- [ ] **2.** `produtorSync`: enfileirar por (paciente,grupo) com a agenda mais próxima de cada grupo; payload inclui grupo + se o paciente tem o outro grupo (p/ decidir duplicata).
- [ ] **3.** `consumirItemA3`: implementar o ciclo de vida acima (B sticky / A condicional / Perdido / criação de duplicata / lookup por pipeline). Reusar `POST /leads/complex` (mesmo corpo do backfill) para criar card faltante.
- [ ] **4.** `npx tsc --noEmit`.
- [ ] **5.** Validar no sandbox (com a allowlist) cenários: só-B→Cliente Ativo; A+B→2 cards (duplicata tag); A cancelada→card A vai pra Perdido, B segue Cliente Ativo; múltiplas A→usa a mais próxima. Via `/debug-tick?env=sandbox&job=sync` (limpando a fila depois — ver regra de limpeza pós-teste).

---

### Task 3 — Confirmação anti-spam

**Files:** `src/index.ts` — `produtorVespera`, `consumirItemF2`, `cronVespera` (legado p/ `/debug-f2`).

**Comportamento (por paciente, no dia-alvo):**
- Tem `(pac,A)` e `(pac,B)` com agendas **no mesmo dia-alvo** → enfileirar/mover **só o card de Captação** para "Confirmação de Consulta"; **não** mover o Pós-Venda (fica Cliente Ativo); 1 lembrete.
- A+B em **dias diferentes** → cada card confirma na véspera do seu agendamento (A→Confirmação de Consulta; B→Confirmação de Agendamento).
- Card único → comportamento normal por grupo.
- Idempotência por `(lead, data)` (`lembrete_d1`) como hoje. Substituir o atual dedup "B-first → 1 lead" por essa lógica.

**Steps:**
- [ ] **1.** Ler spec (§6) + `produtorVespera`/`consumirItemF2`/`cronVespera` atuais.
- [ ] **2.** Implementar a detecção mesmo-dia-A+B (checar no CNN as datas das agendas A e B do paciente) e o roteamento anti-spam.
- [ ] **3.** `npx tsc --noEmit`.
- [ ] **4.** Validar no sandbox: A+B mesmo dia → 1 confirmação (só Captação), Pós-Venda fica Cliente Ativo; A+B dias diferentes → 2 confirmações nos dias certos; card único → normal. Via `/debug-f2?env=sandbox` (limpar depois).

---

### Task 4 — Backfill duplicata (revisa Fase 2)

**Files:** `src/index.ts` — `produtorBackfill`, `backfillCadastros` (+ handler `/debug-a4` já com `window`).

**Comportamento:** para a janela de agendas **futuras ativas**: paciente com **A+B futuro** → garante os 2 cards (Pós-Venda Cliente Ativo + duplicata no Captação); **só-B** → Cliente Ativo (card único); **só-A** → não sincroniza. Reusar a criação/lookup da Task 2. Idempotente por (paciente,grupo).

**Steps:**
- [ ] **1.** Ler spec (§8) + `produtorBackfill`/`backfillCadastros` atuais (e o plano `2026-06-29-fase2-backfill-seletivo.md`, que isto supersede no ponto da duplicata).
- [ ] **2.** Ajustar a elegibilidade/criação p/ o modelo de 2 cards.
- [ ] **3.** `npx tsc --noEmit`.
- [ ] **4.** Validar dry no sandbox: paciente A+B futuro → preview mostra 2 cards; só-B → 1; só-A → pulado.

---

### Task 5 — Migração + validação E2E + deploy (GATE)

**Steps:**
- [ ] **1.** `npx tsc --noEmit` geral (sem erros novos).
- [ ] **2.** Bateria E2E no **sandbox** com a allowlist cobrindo: ciclo de vida (Task 2), anti-spam (Task 3), backfill duplicata (Task 4). **Limpar tudo depois** (regra de limpeza pós-teste).
- [ ] **3.** **GATE — OK do dono.** Backup do D1 (`mapeamento_bak`) confirmado.
- [ ] **4.** Deploy: `npx wrangler deploy src/index.ts` (anotar Version ID). Rodar `/debug-migrar-mapeamento ... ?commit=1` em produção (lotes até concluir).
- [ ] **5.** Monitorar `/debug-audit` na 1ª hora (baseline; sem movimentação em massa indevida; sem erro). Rollback = Version ID anterior + restaurar `mapeamento_bak`.

---

## Riscos
- **Migração do `mapeamento` em D1 vivo** é o maior risco: backup obrigatório, idempotente, retomável, com `?commit=1` separado. Inferir grupo por pipeline custa lookups Kommo (lote sob o teto).
- **2 leads por contato:** todo lookup por telefone deve filtrar por pipeline do grupo.
- **Sistema no ar:** a troca B-vence→duplicata muda comportamento de confirmação/sync; validar exaustivo no sandbox antes do gate.
- Ordem das tarefas importa: Task 1 (dados) antes de 2/3/4.
