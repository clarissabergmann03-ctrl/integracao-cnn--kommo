I have everything I need. Both real drains (cron `scheduled()` @4494-4519 and `/debug-tick` @4207-4224) acquire the B2 lease before calling `consumirFila`, and `FILA_LOCK_TTL_SEG` has a single use (line 633, in `filaClaimLote`). Here is the spec.

---

# SPEC — C1-TTL: mitigar hard-crash do C1 (item preso 300s + tentativa queimada)

## 1. Diagnóstico (onde a regressão nasce)

O claim atômico incrementa a tentativa **sempre**, em `filaClaimLote` (linha 636):

```
SET status='processing', locked_at=?, tentativas=tentativas+1, atualizado_em=?
```

e só considera "repescável" um `processing` cujo `locked_at < now - FILA_LOCK_TTL_SEG`, com `FILA_LOCK_TTL_SEG = 300` (linha 615, único uso em 633).

Se um dreno morre entre `filaClaimLote` e `filaMarcarFeito/Erro/Adiar`, o item fica `status='processing'` com `tentativas` já +1. Consequências:

- **Preso ~300s** até virar stale e ser repescado.
- **Tentativa queimada**: ao repescar, o claim faz `+1` de novo. 4 crashes → dead-letter de um item saudável (mesmo que a API nunca tenha sido chamada de fato).

Dois sub-cenários de crash (importam para avaliar o TTL):

- **Cenário 2 — lease liberado, item órfão** (ex.: exceção em `filaMarcarFeito`/D1 propaga para fora de `consumirFila`; o `finally` do `scheduled` @4518 solta o lease). Próximo tick (60s) roda normal, mas o item só é repescado ao vencer o **TTL do item**. **Aqui baixar o TTL ajuda diretamente.**
- **Cenário 1 — worker morto de verdade** (isolate killed; `finally` não roda). O lease fica preso até `TICK_LEASE_TTL_SEG=300`, então nenhum tick roda antes disso. Recuperação **gated pelo lease (300s)**, não pelo TTL do item; baixar o TTL só ajuda na margem.

Ponto de segurança confirmado: **não existem drenos concorrentes** hoje — cron e `/debug-tick` passam ambos por `adquirirLease` (linhas 4495 e 4208). `filaClaimLote` é chamado **uma vez** por `consumirFila`; o loop nunca re-reivindica. Logo, baixar o TTL do item **não** cria risco de double-processing sob o regime atual.

---

## 2. Opção A — baixar `FILA_LOCK_TTL_SEG` 300 → 90

**Diff (1 linha), linha 615:**

```ts
// antes
const FILA_LOCK_TTL_SEG = 300;
// depois
const FILA_LOCK_TTL_SEG = 90;   // C1-TTL: repesca 'processing' órfão mais cedo (era 300)
```

**Efeito:** reduz a janela de item-preso de 300s→90s no cenário 2 (integralmente) e na margem do cenário 1. **Não** corrige a tentativa queimada.

**Segurança:** total. Sem mudança de lógica, sem schema, preserva o dead-letter crash-safe (reclaim ainda conta → pílula-venenosa ainda morre). Único risco teórico — um dreno **vivo** segurar um item >90s enquanto outro dreno concorrente o repesca — é impedido pelo lease (B2, TTL 300): não há 2 drenos simultâneos. Para dois drenos coexistirem seria preciso um tick vivo rodando >300s (lease expirado) com `cap=10/budget=40` — irrealista.

**Não baixar demais:** 90s mantém margem sobre a duração real de um tick (segundos a poucas dezenas). Não descer perto da cadência do cron (60s) nem perto do pior caso de backoff.

**Limite:** para acelerar TAMBÉM o cenário 1 (worker morto), seria preciso baixar `TICK_LEASE_TTL_SEG` (300) — **fora de escopo**; não mexer aqui (o lease tem outra função).

---

## 3. Opção B — não queimar tentativa em reclaim-por-crash (incremento condicional)

**Diff (SET do `filaClaimLote`), linha 636:**

```ts
// antes
        SET status='processing', locked_at=?, tentativas=tentativas+1, atualizado_em=?
// depois
        SET status='processing', locked_at=?,
            tentativas = tentativas + (CASE WHEN status='pendente' THEN 1 ELSE 0 END),
            atualizado_em=?
```

**Semântica (SQLite/D1):** o RHS de um `UPDATE` é avaliado com os **valores antigos** da linha, antes de qualquer atribuição. Então o `CASE` enxerga o `status` **anterior**: claim fresco (`pendente`) conta +1; reclaim de `processing` stale conta +0. Esse comportamento é validado por teste (§5).

**Efeito:** claim fresco queima tentativa (como hoje); reclaim-por-crash **não**. Importante — as tentativas de **erro genuíno continuam contando**: `filaMarcarErro`/`filaAdiar` devolvem o item a `pendente`, e o próximo claim (agora `pendente`) incrementa. Ou seja, os 4 strikes de dead-letter passam a contar **só** attempts reais, ignorando crashes. É exatamente o desejado.

**Trade-off / [DECISAO]:** remove a única propriedade que hoje garante dead-letter **à prova de crash**: um item que faça **hard-crash do worker ANTES de qualquer update de status** (bypassa o `try/catch` por-item) nunca passa por `pendente`, então nunca incrementa → loop infinito de reclaim, re-derrubando o worker a cada ciclo do TTL, envenenando a fila.
- Probabilidade **neste** código: quase nula. Payloads são JSON minúsculos; todo o trabalho por-item está dentro do `try/catch` (2129-2166). Hard-crashes aqui são de infra/budget/timing (não determinísticos por item) — logo hoje uma tentativa queimada nesses casos é **falso-positivo**, não sinal de veneno.
- **[DECISAO] do dono:** aceitar essa troca (recomendado, dado o perfil de risco) OU blindar com guarda limitada (ver §6, diff maior — não recomendado como mínimo).

**B sozinho é pior que A+B:** corrige a tentativa mas deixa o item preso até o TTL. Se adotar B, adote A junto.

---

## 4. Recomendação (menor diff seguro)

- **Menor diff, zero-risco, para a metade "preso 300s": Opção A (1 linha, 300→90).** É a mudança incondicionalmente segura e endereça o sintoma de maior severidade (latência de recuperação).
- **Para fechar TAMBÉM a "tentativa queimada" com diff mínimo: A + B juntas.** B é ~1 expressão, correta para todos os caminhos de erro genuíno; a única contrapartida (pílula-que-hard-crasha) é praticamente inexistente neste código — por isso marcada **[DECISAO]**, não bloqueante.
- **Recomendação final:** aplicar **A** já (seguro e suficiente para o item-preso); aplicar **B** no mesmo lote se o dono aceitar abrir mão do dead-letter crash-safe (recomendo aceitar). Não adotar a guarda de coluna extra agora — é o maior diff, para um risco de probabilidade ~nula.

Severidade residual sem B: baixa — exige **4** crashes no mesmo item para dead-letter, e o A5 (`/debug-fila-requeue`) já reprocessa dead-letters.

---

## 5. Plano de teste local (D1 direto, sem editar código)

O harness de selftest (~3160) opera sobre itens mock em memória, **não** sobre o SQL real de `filaClaimLote`. Para validar a semântica do claim, rodar o SQL exato de produção contra linhas semeadas num D1 local:

```bash
npx wrangler d1 execute kommo-cnn-db --local --command "
DELETE FROM fila_trabalho;
INSERT INTO fila_trabalho (id,chave,tipo,status,tentativas,locked_at,criado_em,atualizado_em) VALUES
 (1,'k-pend','A3','pendente',0,NULL,strftime('%s','now'),strftime('%s','now')),
 (2,'k-stale','A3','processing',1,strftime('%s','now')-100,strftime('%s','now'),strftime('%s','now')),
 (3,'k-fresh','A3','processing',1,strftime('%s','now')-30,strftime('%s','now'),strftime('%s','now')),
 (4,'k-dead','A3','pendente',4,NULL,strftime('%s','now'),strftime('%s','now'));"
```

Rodar o claim com **TTL=90** e o **CASE** da Opção B (staleAntes = now-90, MAX=4):

```bash
npx wrangler d1 execute kommo-cnn-db --local --command "
UPDATE fila_trabalho
   SET status='processing', locked_at=strftime('%s','now'),
       tentativas = tentativas + (CASE WHEN status='pendente' THEN 1 ELSE 0 END),
       atualizado_em=strftime('%s','now')
 WHERE id IN (
   SELECT id FROM fila_trabalho
    WHERE tentativas < 4
      AND (status='pendente' OR (status='processing' AND locked_at < strftime('%s','now')-90))
    ORDER BY (CASE WHEN grupo='B' THEN 0 WHEN tipo='ORC' THEN 2 ELSE 1 END), id
    LIMIT 10)
 RETURNING id,status,tentativas;"
```

**Resultado esperado (RETURNING):**
- `id=1` → `tentativas=1` (era `pendente` → +1). **Se voltar 0, o SQLite avaliou o CASE contra o `status` já atribuído (`processing`); nesse caso NÃO usar a Opção B — cair só na Opção A** (este é o teste adversarial da semântica de valor-antigo).
- `id=2` → `tentativas=1` (reclaim stale de 100s > 90 → **+0**, tentativa NÃO queimada — valida Opção B). Com TTL=300 ele **não** apareceria (valida Opção A).
- `id=3` → **ausente** do RETURNING (locked_at=now-30, não < now-90 → item ainda "vivo/possuído", não é roubado — valida segurança do TTL).
- `id=4` → **ausente** (tentativas=4, não `<4` → respeita o teto, sem over-claim).

**Teste de não-regressão do dead-letter genuíno** (garante que erro real ainda morre em 4): rodar o ciclo pendente→claim(+1)→`filaMarcarErro`(volta a pendente) 4x via `/debug-tick?dry=0` (ambiente sandbox) forçando erro, e conferir `status='erro'` em `/debug-fila-erros`. Alternativa determinística: repetir o bloco de claim acima 4x sobre `id=1` intercalando `UPDATE ... SET status='pendente', locked_at=NULL WHERE id=1;` e verificar que na 4ª o `tentativas` chega a 4.

**Sanidade em prod (read-only):** `/debug-tick?dry=1` (não reivindica) para confirmar que o bundle carregou; `/debug-count` e `/debug-fila-erros` antes/depois de um tick real para ver a fila drenar sem novos dead-letters.

---

## 6. Riscos & mitigações

- **A — double-processing:** impedido pelo lease B2 (300s) que serializa cron + `/debug-tick`; nenhum caller de `consumirFila` sem lease hoje. Residual desprezível.
- **A — cenário worker-morto:** recuperação ainda gated pelo lease (300s); baixar o TTL do item ajuda só na margem. Aceitar, ou tratar `TICK_LEASE_TTL_SEG` em item separado (fora de escopo).
- **B — perda do dead-letter crash-safe:** pílula que hard-crasha antes de qualquer update entra em loop de reclaim. Probabilidade ~nula aqui. **Guarda opcional (diff maior, NÃO recomendado agora):** adicionar coluna `reclaims` (migração idempotente igual `locked_at`), `CASE ELSE reclaims+1`, e excluir do SELECT itens com `reclaims >= RECLAIM_MAX` (ex.: 10) — eles ficam presos em `processing` (dead-letter de fato, visível), sem re-derrubar o worker. Só adotar se o dono não aceitar o trade-off de B.
- **B — dependência de semântica SQLite:** RHS usa valores antigos; coberto pelo teste do `id=1==1` em §5.

---

## 7. Rollback & housekeeping

- **Rollback:** A é reverter o literal (90→300); B é reverter a expressão do SET. Ambos triviais, sem migração/estado.
- **Doc:** ao aplicar, atualizar as refs em `CLAUDE.md` ("`FILA_LOCK_TTL_SEG`=300 ~530" e a gotcha do claim atômico C1) para 90 e, se B entrar, registrar "reclaim-por-crash não queima tentativa (incremento condicional; dead-letter crash-safe removido — [DECISAO] dono)". Sem alteração de código exigida por isto.
- Arquivo-alvo único: `D:/clarissa-bergmann/kommo-cnn/src/index.ts` (linha 615 e linha 636).