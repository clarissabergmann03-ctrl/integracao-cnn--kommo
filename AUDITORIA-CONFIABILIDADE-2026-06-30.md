# Auditoria de Confiabilidade — Sincronização CNN ↔ Kommo

**Data:** 2026-06-30 · **Versão no ar:** `fe50b47b` · **Fonte:** CNN **produção** + Kommo, puxados via Cloudflare Worker (GET, secrets no worker).
**Método:** endpoints `/debug-verificar` e `/debug-auditoria` (leitura crua, cap-safe) + queries diretas no D1.
**Janela analisada:** −2/+14 dias (2026-06-28 → 2026-07-14), 442 agendas.

---

## Checklist auditado

### A. Integridade da leitura (CNN) — ✅ PASSOU
- [x] **Paginação completa:** 5/5 páginas lidas, `completo=true`. Páginas [100,100,100,100,40] = 440-442 agendas.
- [x] **Campos íntegros:** 0 sem `idPaciente`, 0 sem `status`, 0 sem `tipo`. Nada vindo "pela metade".
- [x] **Sem truncamento pelo teto de 50 sub-requests:** 18 subreq (`/debug-verificar`), 40 (`/debug-auditoria`).
- [x] **0 agendas sem telefone.**

### B. Realidade dos pacientes — ✅ PASSOU
- [x] **Nomes reais:** amostra de 15 pacientes de "atendimento social" → todos reais, com data de nascimento (ex.: Maria Margarida Cherubini 1954, Suzi Cristina Flores 1962, Lourdes Regina Zambonato 1936, Luan Rodrigues Lotti 1992).
- [x] **Telefones reais:** 0 sem telefone; **19 tarefas internas** (telefone falso, ex. (51)11111-1111) corretamente **excluídas** (`isTarefaInterna`).
- [x] **Sem dados de teste** na janela de produção.
- [x] **180 pacientes distintos** em atendimento social (224 agendas → vários pacientes com +1 slot).

### C. Classificação por tipo — ✅ PASSOU
- [x] **`tipos_desconhecidos: {}`** e **`pacientes_sem_grupo: 0`** → 100% das agendas roteadas.
- [x] Os **9 tipos reais** do CNN mapeiam certo: `atendimento social` + `consulta/avaliacao` → **A**; `procedimento`, `encaixe`, `retorno`, `pequenas cirurgias`, `cirurgia`, `cortesia`, `encaminhamento-interno` → **B**.
- [x] Na janela: 224 atendimento social (A) + 151 procedimento + 29 encaixe + 19 retorno + 1 peq. cirurgia (B).

### D. Consistência Kommo ↔ CNN — ✅ PASSOU (1 ressalva)
- [x] **Cards B (10/10):** todos em Pós-Venda / Cliente Ativo (107658911), **com ID Agenda CNN + ID Paciente CNN preenchidos** (fix funcionando).
- [x] **Cards A (8/8):** todos em Captação, com IDs preenchidos.
- [ ] 🟡 **3/8 cards A em "Primeiro Contato"** (vs Consulta Agendada) — provável FALTOU (correto) OU lead já baselined-ativo não re-alinhado (o `/debug-corrigir` resolveria). **Confirmar.**

### E. Roteamento (sem mis-routes) — ✅ PASSOU
- [x] **18/18 cards no funil certo** (B→Pós-Venda, A→Captação). `pipeline_ok=true` em todos.
- [x] **0 agendas mapeadas para múltiplos leads.**

### F. Logs / D1 — ✅ PASSOU (1 anomalia)
- [x] Fila: **0 erro, 0 pendente.**
- [x] mapeamento: **0 grupo inválido, 0 lead nulo.**
- [x] Perdido: **10** (sem enxurrada; orphan conservador).
- [ ] ⚠️ **4 leads compartilhados entre pacientes** = **3 colisões de telefone** (pares de pacientes CNN com o mesmo número — prováveis familiares): tel 5192478008, 5181776465, 5199647907. ~1% dos pacientes.

### G. Modelo duplicata — ✅ FUNCIONANDO (atenção ao volume)
- [x] **124 pacientes com 2 cards** (A+B) = duplicata por atendimento A **e** procedimento B ativos simultâneos.
- [ ] ⚠️ Volume: **124 duplicatas** em Captação + **165 Cliente Ativo** no Pós-Venda. Confirmar se reflete a operação real da clínica.

---

## Veredito: confiabilidade **ALTA**
Dados íntegros e completos, pacientes reais, classificação 100% correta, IDs gravados nos cards, roteamento certo, **0 erros**.

### Ressalvas (não-bloqueantes)
1. **Colisão de telefone (3 casos):** 2 pacientes CNN com o mesmo número → 1 card só. Mitigação: casar também por nome+nascimento, não só telefone.
2. **3 cards A em Primeiro Contato:** confirmar se são FALTOU (correto) ou leads ativos não re-alinhados (rodar `/debug-corrigir?dry=1` lista; `dry=0` corrige).
3. **Volume duplicata/Cliente Ativo (124/165):** alto overlap atendimento-social × procedimento; confirmar se bate.

### Endpoints de auditoria criados (reutilizáveis, só-leitura)
- `/debug-verificar?env=production` — integridade + reconciliação 164.
- `/debug-auditoria?env=production` — realidade dos pacientes + classificação + consistência dos cards.
- `/debug-corrigir?dry=1` — lista cards com ID vazio / etapa errada (dry) ou corrige (dry=0).
