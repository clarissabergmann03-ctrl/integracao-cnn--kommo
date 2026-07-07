# Design — CNN→Kommo: duplicata de card + anti-spam de confirmação + sync pelo mais próximo

**Data:** 2026-06-29
**Status:** Design aprovado em brainstorming — aguardando review do spec antes do plano.
**Projeto:** `kommo-cnn`. Fonte da verdade do código: `src/index.ts`.
**Escopo:** direção **CNN→Kommo** (enriquece a Fase 1 já deployada + revisa o backfill da Fase 2). O **item 2 (Kommo→CNN)** é a fase seguinte ("ambos, em ordem"), fora deste spec.

---

## 1. Contexto e o que muda

A Fase 1 (no ar desde 29/06) usa **"B-vence"**: paciente com agenda A e B no mesmo dia vira **um card só**, roteado pra B. Este design **substitui o B-vence** por **duplicação de card** (2 cards por paciente quando há A+B) com **ciclo de vida por grupo**, **anti-spam de confirmação** e **sync pelo mais próximo**. Afeta: confirmação (véspera), sync de status, backfill (Fase 2) e o modelo de dados (`mapeamento`).

## 2. Princípios mantidos

- §7.8 (CNN prod = só leitura): este escopo é CNN→Kommo (lê CNN, escreve Kommo). Nenhum `cnnPost/cnnPut`.
- Cancelamento: A → "Cancelada–Perdido"; B → permanece "Cliente Ativo".
- Idempotência e anti-ressurreição (agora por `(paciente, grupo)`).
- Roteamento por NOME do tipo de consulta (Grupo A = {atendimento social, consulta/avaliação}; Grupo B = demais).

## 3. Modelo de dados

`mapeamento` passa a ter **chave composta `(paciente_id_cnn, grupo)`** (hoje é só `paciente_id_cnn`):
- `(pac, "A")` → lead de **Captação**.
- `(pac, "B")` → lead de **Pós-Venda**.

Um paciente pode ter 0, 1 ou 2 entradas. **Migração:** alterar a PK; cada entrada existente herda o `grupo` pelo **pipeline atual do lead** (Captação→A; Pós-Venda→B). Anti-ressurreição passa a ser por `(paciente, grupo)`.

## 4. Ciclo de vida dos cards (o sync ajusta cada card pelo seu grupo, independentemente, a cada ciclo)

**Card de Pós-Venda (grupo B):**
- Paciente com agenda **B ativa** → garante card no Pós-Venda em **"Cliente Ativo"** (cria se não existe).
- **Pegajoso:** uma vez "Cliente Ativo", permanece — cancelar/concluir uma agenda B **não** o tira de Cliente Ativo.

**Card de Captação (grupo A):**
- Paciente com agenda **A ativa** → garante card no Captação na **etapa do status** da agenda (AGENDADO→Consulta Agendada; CONFIRMADO_PACIENTE→Consulta Confirmada; FINALIZADO→Avaliação Realizada; etc. — `MAPA_STATUS` grupo A).
- **Sem agenda A vigente para o card** (a A foi cancelada, ou o paciente virou só-B e o card de Captação ficou órfão) → o card vai pra **"Cancelada–Perdido"** (não polui a Captação). *(Agenda A FINALIZADA segue o `MAPA_STATUS` → "Avaliação Realizada", etapa normal pós-consulta — não é Perdido.)*
- Se o paciente **também tem card de Pós-Venda** (é cliente) → o card de Captação é a **duplicata**: nome recebe sufixo **" (duplicata)"**.

## 5. Quando a duplicata nasce

Invariante: **paciente com agenda A ativa E agenda B ativa → tem 2 cards** (Pós-Venda "Cliente Ativo" + Captação para o A, marcado "(duplicata)").

Fluxo normal (sem A+B simultâneo) = **1 card só**, que progride Captação → Pós-Venda conforme o paciente avança (consulta → vira cliente). O sync **só cria o 2º card (a duplicata no Captação)** quando detecta o A+B simultâneo: o card-cliente fica/vai pro Pós-Venda e a duplicata é criada no Captação para a agenda A ainda ativa. O sync garante o invariante (cria o card que faltar, no funil certo).

## 6. Confirmação (véspera) + anti-spam

Mesma grade da Fase 1 (Seg–Sex 18h UTC→D+1; Sáb 14h UTC→segunda). Por paciente com agenda no dia-alvo:
- **A+B no MESMO dia** (paciente tem os 2 cards, ambas agendas no dia-alvo) → move **só o card de Captação** para **"Confirmação de Consulta"**; o card de Pós-Venda **fica em "Cliente Ativo"** (não vai pra Confirmação de Agendamento); **1 confirmação** (1 WhatsApp).
- **A+B em DIAS diferentes** → cada card confirma na véspera do **seu** agendamento (Captação→Confirmação de Consulta na véspera do A; Pós-Venda→Confirmação de Agendamento na véspera do B).
- **Card único** → confirma normal no seu funil (A→Confirmação de Consulta; B→Confirmação de Agendamento).

Idempotência da confirmação: por `(lead, data)` (`lembrete_d1`), como hoje.

## 7. Sync pelo mais próximo

Quando um card tem **mais de uma agenda elegível do seu grupo**, o sync usa a **mais próxima** (data/hora mais iminente) para dirigir status, hora (`AGENDAMENTO`), o vínculo `ID Agenda CNN` e a confirmação.

## 8. Migração do estado atual (Fase 1 está no ar com B-vence)

- `produtorVespera`/`cronVespera` (confirmação): trocar o dedup "B-first → 1 move" pela lógica duplicata-aware (anti-spam §6).
- `produtorSync`/`consumirItemA3` (sync): gerenciar 2 cards por paciente + ciclo de vida §4 (inclui A→Perdido sem agenda A ativa) + mais-próximo §7.
- `produtorBackfill`/`backfillCadastros` (Fase 2): para paciente **A+B futuro**, criar a duplicata (Captação) além do card de Pós-Venda; manter "só-B → Cliente Ativo" e "só-A → não sincroniza".
- `mapeamento`: migração pra chave composta `(paciente, grupo)`.
- Reconciliação: o sync/backfill revisados criam as duplicatas faltantes para pacientes A+B-futuro existentes; cards únicos atuais herdam o grupo pelo pipeline.

## 9. Fora de escopo

- **Item 2 (Kommo→CNN, semi-bilateral)** — próxima fase.
- **Função 3** (mover por orçamento aprovado / "compra") — não construída; o move "vira cliente" hoje é dirigido por ganhar agenda B (sync) ou manual.
- Liberação de escrita CNN em produção (§7.8 segue).

## 10. Riscos / observações

- **Sistema vivo:** a Fase 1 (B-vence) está em produção. Esta mudança altera confirmação + sync + modelo de dados → exige **validação no sandbox antes do deploy** e migração cuidadosa do `mapeamento` no D1.
- **2 leads por contato no Kommo** (mesmo telefone): o lookup por telefone precisa escolher o lead certo **por grupo/pipeline** (não pegar `leads[0]` cego).
- **Anti-spam depende de checar as datas no CNN** (fonte) na hora da confirmação — não confiar só na cópia local.
- Risco de mover um card-cliente (Pós-Venda) indevidamente pra confirmação: a regra "B é pegajoso / mesmo-dia confirma só Captação" precisa de guarda explícita.
