# Design — Comportamento operacional kommo-cnn (confirmação, sync semi-bilateral, backfill seletivo)

**Data:** 2026-06-28
**Status:** Aprovado pelo dono (28/06) — premissas resolvidas; seguindo para o plano de implementação (writing-plans).
**Projeto:** `kommo-cnn` (Cloudflare Worker + D1). Fonte da verdade do código: `src/index.ts`.

---

## 1. Contexto

Integração Kommo CRM ↔ Clínica nas Nuvens (CNN). Hoje o cron de produção roda só o **legado C1/C2** (Captação). A **camada nova** (fila-em-D1 + A2/A3/A4/F2 + Pós-Venda) já existe no código, validada em dry-run, mas está **inerte** (só roda via `/debug-*`).

Este design **liga a camada nova adaptada à spec abaixo** e **aposenta C1/C2**. Não reescreve o que já funciona.

## 2. Princípios mantidos (não-negociáveis)

- **§7.8 — CNN produção = só leitura.** Tudo que escreve no CNN (item 2) é desenvolvido e validado no **sandbox** primeiro; liberação de produção é passo separado, caso a caso. Trava por código (`assertCnnWritable`) permanece.
- **Cancelamento:** Grupo A (Captação) → "Cancelada–Perdido"; Grupo B (Pós-Venda) → permanece "Cliente Ativo".
- **Sem backfill amplo/cego.** Só o backfill **seletivo** do item 4. Agendamento que já passou não recebe contato.
- **Idempotência em tudo:** nada é movido/criado duas vezes (chaves em D1: `lembrete_d1`, `agenda_sync`, `mapeamento`, `fila_trabalho`).
- **Roteamento por NOME** do tipo de consulta em runtime (IDs diferem sandbox×prod). Grupo A = {atendimento social, consulta/avaliação}; Grupo B = {procedimento, retorno, encaixe, cirurgia, pequenas cirurgias, cortesia, encaminhamento-interno}.

## 3. Item 1 — Confirmação por horário (só escreve Kommo)

Move os leads cuja consulta cai no dia-alvo para a etapa de confirmação (dispara o WhatsApp Salesbot).

**Crons (UTC):**
- `0 18 * * 1-5` (Seg–Sex 15h BRT)
- `0 14 * * 6` (Sáb 11h BRT)
- Domingo: não roda.

**Dia-alvo (BRT):**
- Seg–Sex → agendas de **D+1** (amanhã).
- Sáb → agendas de **segunda** (D+2).

**Lógica por agenda do dia-alvo:**
1. Lista agendas do dia-alvo no CNN (fonte; §7.5 — não confia na cópia local).
2. Pula agenda em status terminal (`CANCELADO`/`CANCELADO_PACIENTE`/`FINALIZADO`/`FALTOU`).
3. Acha o lead no Kommo (por `ID Agenda CNN` / telefone via `phoneKey`).
4. Roteia por grupo: **Grupo A → "Confirmação de Consulta" (Captação)**; **Grupo B → "Confirmação de Agendamento" (Pós-Venda)**. *(premissa a confirmar — mantém o comportamento atual do código.)*
5. Idempotente: 1 confirmação por lead por data (`lembrete_d1`). Desempate B-vence quando o paciente tem A e B no mesmo dia.

**Base:** é o `cronVespera`/F2 existente, com (a) novo agendamento de cron e (b) função de dia-alvo ciente do dia-da-semana (hoje usa só `tomorrowBRT()`).

## 4. Item 2 — Sync semi-bilateral Kommo↔CNN (ESCREVE CNN → sandbox primeiro)

**Kommo → CNN — só via webhook (criação):**
- `POST /webhook/lead-agendado` (W1): lead movido para "Consulta Agendada" → cria paciente + agenda no CNN, grava `ID Agenda CNN`/`ID Paciente CNN` no lead. Escreve CNN.

**Kommo → CNN — reconciliação por polling (rede de segurança do webhook):**
- Varre leads do Kommo nas etapas **"Consulta Confirmada"** e **"Avaliação Realizada"**.
- Para cada lead com `ID Agenda CNN`, lê o status atual da agenda no CNN e, **se ainda não estiver no status esperado**, atualiza via `PUT /agenda/alteracao-status`:
  - "Consulta Confirmada" → `CONFIRMADO_PACIENTE`
  - "Avaliação Realizada" → `FINALIZADO`
- Idempotente (só escreve se o status divergir). Escreve CNN.

**CNN → Kommo:** via polling (item 3).

**Rollout:** todo o item 2 roda no **sandbox** até validação; liberação de produção é passo separado, caso a caso. Até lá, `assertCnnWritable` bloqueia produção.

**Premissa a confirmar (dono):** o webhook Kommo→CNN está configurado no painel do Kommo (não visível pelo código).

## 5. Item 3 — Sync de base CNN→Kommo (só escreve Kommo)

Mantém o Kommo em dia com o CNN para a **janela de agendas ativas**.

- **Janela:** **hoje−2 → hoje+14 dias** (BRT). O −2 só serve para capturar o **status final marcado com atraso** (finalizado/faltou/cancelado no dia seguinte ou depois); não é para contato. O status marcado no mesmo dia já é pego pela cobertura de "hoje".
- **Mecânica:** fila-em-D1 + cron `* * * * *`; cada execução faz ≤ ~50 chamadas externas (teto do plano free) → a janela inteira é coberta em poucos minutos, o dia todo (~72k chamadas/dia de teto; uso-alvo 60–70k).
- **Detecção:** baseline em `agenda_sync` na 1ª vez (registra estado, não move — evita eco); depois reflete mudança real de **status/hora** no Kommo.
- **Transições de status (CNN → etapa Kommo):**
  - `FINALIZADO` → "Avaliação Realizada".
  - `CANCELADO`/`CANCELADO_PACIENTE` → Grupo A: "Cancelada–Perdido"; Grupo B: permanece "Cliente Ativo".
  - mudança de hora → atualiza campo `AGENDAMENTO` no Kommo (CNN prevalece).
- **Lê CNN (produção permitida) + escreve Kommo.** Vai para produção.

## 6. Item 4 — Backfill seletivo (1×, só escreve Kommo)

Importa para o Pós-Venda os pacientes da base que **já têm relação ativa**, uma única vez.

- **Elegibilidade:** paciente com **agendamento FUTURO ativo** de **qualquer tipo do Grupo B** (procedimento, retorno, encaixe, cirurgia, pequenas cirurgias, cortesia, encaminhamento-interno) → garante card **"Cliente Ativo"** no Pós-Venda.
- **Exclusão:** paciente cujo(s) agendamento(s) futuro(s) são **só de Grupo A** (consulta/avaliação) → **não** sincroniza.
- **Janela de varredura:** agendas futuras ativas até **6 meses (hoje → +180 dias)**, alcançada por **rollout escalonado**: começa em **+3 dias**, depois **+7 → +14 → +28 → +56 → +90 → +180**, **verificando erros entre cada etapa** antes de expandir. Idempotente entre etapas (repetir uma janela maior não recria o que já foi feito).
- **Ação:** vincula se já existe lead por telefone (`phoneKey`); cria card se não existe (`POST /leads/complex`). Anti-duplicata (`phoneKey`) + anti-ressurreição (`mapeamento`). Idempotente.
- **Lê CNN + escreve Kommo.** Roda **1× em produção, com OK explícito do dono no momento.**
- Os 52 cards do backfill anterior (27/06) permanecem; a lógica seletiva não recria duplicados.

## 7. Sequência de entrega (rollout)

1. **Itens 3 + 1** → produção (só leem CNN + escrevem Kommo). Aposenta C1/C2; novos crons (`* * * * *`, `0 18 * * 1-5`, `0 14 * * 6`). Primeira hora = baseline (não move em massa).
2. **Item 4** → backfill seletivo em **escala crescente** (3 → 7 → 14 → 28 → 56 → 90 → 180 dias), verificando erros entre cada etapa antes de expandir, com OK no momento.
3. **Item 2** → desenvolve/valida no sandbox → libera produção por último, caso a caso.

**Dispatch do `scheduled()`:** roteia por `event.cron`. No mesmo minuto, `* * * * *` e um cron de confirmação podem disparar invocações separadas — o handler trata cada uma pelo seu `event.cron`.

## 8. Premissas — RESOLVIDAS (28/06)

- ✅ Webhook Kommo→CNN **está configurado** no painel do Kommo (confirmado pelo dono).
- ✅ Roteamento de confirmação por grupo (item 1) — **confirmado** (A → "Confirmação de Consulta"; B → "Confirmação de Agendamento").
- ✅ Janela do backfill (item 4) — **6 meses, via rollout escalonado** (3 → 7 → 14 → 28 → 56 → 90 → 180 dias, verificando erros entre etapas).

## 9. Fora de escopo (por ora)

- Liberar escrita CNN em produção (passo separado, pós-validação sandbox).
- Função 3 (orçamento), etapa "Importado CNN", Função 4 (reconciliação de campos), refresh OAuth do token Kommo, sufixo `(duplicata)`.
- Trava de prontuário (proposta separada/opcional).

## 10. Riscos / observações

- Primeira hora pós-flip do item 3 sobe muitos baselines (sem mover etapa) — esperado.
- Item 1 depende de o lead ter `ID Agenda CNN`/`AGENDAMENTO` corretos; o item 3 e o item 4 alimentam isso.
- Item 2 só tem valor real em produção; até a liberação, fica exercitado só no sandbox.
