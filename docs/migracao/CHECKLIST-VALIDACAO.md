# CHECKLIST DE VALIDAÇÃO POR LEAD — Migração Sync Única

> Aplicado a CADA paciente classificado, pelos subagentes de auditoria (e revisável à mão). Objetivo: garantir que a etapa-destino é REAL, não fruto de erro de leitura nem de regra mal-disparada. Fonte de verdade = CNN produção (só-leitura). Campos do registro: `pid, nome, tel, regra, stage, na, no, cob(ertura%), sil(êncio d), aprov(último), cancApos, fezTodos, fut(ura), gFut(grupo futuro), flags`.

## 0. Integridade da leitura (porta de entrada — se falhar, PARA)
- [ ] **Não é `erro_leitura`.** Se for → re-sondar single-thread; NÃO classificar até ler completo.
- [ ] **`na`/`no` plausíveis.** Paciente antigo com `na=0 & no=0` é suspeito → re-sondar para descartar falha silenciosa.
- [ ] **Não `truncado_volumoso`.** Se truncou (paciente com muitas agendas) → re-ler sem cap antes de confiar em cobertura/silêncio.

## 1. Roteador — bloco certo
- [ ] Tem agenda em **[2026-07-01, 2028-01-01]**? → tem que estar no **Bloco Futuro** (cliente ativo / consulta agendada). Não tem → Bloco Passado.
- [ ] Bloco Futuro: grupo do agendamento futuro correto? **B vence A** (procedimento futuro → cliente ativo; só consulta futura → consulta agendada).

## 2. Consistência da regra (determinístico — deve bater 100%)
- [ ] **Concluído** ⟹ `cob ≥ 80%` **E** `cancApos = false`. Se `cob < 80%` e concluído → **ERRO**.
- [ ] **Abandono** ⟹ parcial (`cob < 80%`) **E** (`sil > 180` **ou** cauda de faltas) **E** sem agenda futura.
- [ ] **Cancelamento** ⟹ o orçamento com a **aprovação mais recente** está `CANCELADO/PERDIDO` (`cancApos = true`). Não pode ser um cancelamento antigo já superado por reaprovação.
- [ ] **Tratamento iniciado** ⟹ aprovado, parcial, `sil ≤ 180`, sem agenda futura.
- [ ] **Captura/perdido** ⟹ `no = 0` (zero orçamento) **E** nenhum grupo B no histórico. Se tem grupo B ou orçamento → **ERRO**.
- [ ] **Pós-Consulta/perdido** ⟹ teve orçamento gerado, **nunca aprovou**, sem grupo B.

## 3. Casos-limite (JULGAMENTO — foco dos subagentes; são os leads `flagados`)
- [ ] **`abandono_quase_concluido`** (`cob ≥ 70%`): fez quase tudo → conferir se não deveria ser **concluído** (o matching de procedimento pode subcontar por tipo/quantidade). Ex.: MARILEI 83%.
- [ ] **`abandono_recente_menos1ano`** (`sil` 180–365d): parou há menos de 1 ano → conferir a **última agenda real**; abandono ou ainda em tratamento?
- [ ] **`concluido_no_limite`** (`cob` 80–84%): passou raspando → a execução é real ou artefato de matching de `idTipoProcedimento`?
- [ ] **`captura_com_agendas`**: passou por consulta(s) mas **nunca gerou orçamento** → confirmar lead frio (consultou e não converteu), não erro de leitura de orçamento.
- [ ] **`cancelamento_multi_orcamento`** (`no ≥ 3`): confirmar que o **mais recente aprovado** é o cancelado (não um antigo).

## 4. Identidade / enriquecimento
- [ ] **Nome** presente e legível (não `sem_nome`).
- [ ] **Telefone** válido (11 dígitos com DDD).
- [ ] **Colisão de telefone**: 2 pacientes CNN DIFERENTES com o mesmo telefone → marcar **[Família]**, nunca colapsar num só lead.

## 5. Segurança / invariantes (nunca violar)
- [ ] **1 paciente → no máximo 1 etapa por funil** (0 duplicata dentro do mesmo funil).
- [ ] **Forward-only**: se o lead já existe no Kommo numa etapa MAIS avançada, não rebaixar.
- [ ] **CNN só-leitura**: a verificação jamais escreve no CNN.

## Veredito por lead (o que o subagente devolve)
Para cada lead: `OK` (passou tudo) · `REVISAR` (caso-limite, precisa olho humano) · `ERRO_CLASSIFICACAO` (regra violada, corrigir motor) · `ERRO_LEITURA` (re-sondar). Mais: `motivo` (1 linha) e, se re-sondou, os números conferidos.
