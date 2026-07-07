# SPEC A3 — Reversão de status deduplicada pra sempre (chave A3:sync permanente)

Arquivo único: `D:/clarissa-bergmann/kommo-cnn/src/index.ts`. Nenhum arquivo editado por mim — só texto abaixo.

## 1. Diagnóstico (causa-raiz confirmada no código)

Geração da chave A3:sync em `produtorSync` (`src/index.ts:1676`):
```js
chave: `A3:sync:${pid}:${grupo}:${vig.id}:${vig.status}:${tsBucket}`
```
Enfileiramento em `filaEnfileirarLote` (`src/index.ts:604`) usa `INSERT OR IGNORE` contra `fila_trabalho.chave TEXT UNIQUE` (`:545`). A linha da chave **nunca é apagada** — `filaMarcarFeito` só faz `UPDATE ... status='feito'` (`:649-651`), permanecendo na tabela.

A chave **já inclui** `vig.status`, mas isso NÃO resolve reversão porque os **valores de status recorrem** (a agenda oscila entre poucos estados). Sequência real do bug:

1. Agenda X = `AGENDADO`. Chave `K_A = A3:sync:PID:A:X:AGENDADO:100`. Processada → linha `K_A` fica `feito`. `agenda_sync.last_cnn_status='AGENDADO'`.
2. Agenda X → `CONFIRMADO_PACIENTE`. Chave `K_C` (diferente) → enfileira, processa, move card p/ Consulta Confirmada. `agenda_sync='CONFIRMADO_PACIENTE'`.
3. **Reversão**: paciente desconfirma, X volta a `AGENDADO`. O gate `mudou` (`:1671`) é `true` (`est.status='CONFIRMADO_PACIENTE' ≠ 'AGENDADO'`), então o produtor **quer** enfileirar e monta a chave `K_A` de novo. Mas `K_A` **já existe** como `feito` (do passo 1) → `INSERT OR IGNORE` **descarta** → o item nunca entra na fila → o move-de-volta pra Consulta Agendada é **perdido pra sempre**.

Ou seja: a chave é "idempotente demais" porque colide com uma linha `feito` histórica de um valor de status que voltou a ocorrer. O `tsBucket` não salva (reversão pura não muda a hora → bucket constante).

## 2. Correção recomendada — purgar o gêmeo `feito` da MESMA chave, só p/ itens sync que passaram no gate `mudou`

Direção escolhida (das duas ofertadas no item): **purgar o feito quando o status muda**. Motivo de preferir purga a "enriquecer a chave":
- Enriquecer com a transição `from->to` (ex.: `CONFIRMADO->AGENDADO`) só conserta a **1ª** reversão; numa **re-oscilação** (`AGENDADO->CONFIRMADO` de novo) a chave de transição também recorre → bug volta.
- Uma chave verdadeiramente monotônica exigiria uma coluna `rev`/epoch em `agenda_sync` + mudança no consumidor (`upsertAgendaSync`, baseline) — muito mais superfície.
- A purga apoia-se no gate `mudou` (que já é a autoridade real de idempotência via `agenda_sync`) e trata a chave pelo que ela é: um **guard de dedup de trabalho EM VOO**, não um registro histórico eterno.

Escopo cirúrgico da purga (o que preserva a idempotência normal):
- Só chaves de **itens sync que passaram por `mudou=true`** (mudança real de estado da agenda).
- Só linhas `status='feito'` → **NÃO** toca `pendente`/`processing` (dedup de "mesma mudança = 1 item" intacto), **NÃO** toca `erro`/dead-letter (fica p/ `/debug-fila-requeue`).
- **NÃO** toca `A3:orphan` (que depende da permanência da chave p/ dedup entre ticks — ver §5).

### Diff 1 — acumulador (`src/index.ts`, logo após `:1663`)
```js
  const aEnfileirar: any[] = [];
  const comVigenteA = new Set<string>();
```
vira:
```js
  const aEnfileirar: any[] = [];
  const chavesSyncMudou: string[] = [];   // A3-REVERSÃO: chaves de sync que passaram no gate `mudou`
  const comVigenteA = new Set<string>();
```

### Diff 2 — `enfileirarSync` (`src/index.ts:1674-1679`)
De:
```js
    const tsBucket = Math.floor(vig.ts / 60);
    aEnfileirar.push({
      chave: `A3:sync:${pid}:${grupo}:${vig.id}:${vig.status}:${tsBucket}`, tipo: "A3",
      agenda_id_cnn: vig.id, paciente_id_cnn: pid, grupo,
      payload: { kind: "sync", leadId: leadId ?? null, status: vig.status, cnnTs: vig.ts, telefone: vig.tel, baseline: !est, temOutro },
    });
```
Para:
```js
    const tsBucket = Math.floor(vig.ts / 60);
    const chave = `A3:sync:${pid}:${grupo}:${vig.id}:${vig.status}:${tsBucket}`;
    chavesSyncMudou.push(chave);   // gate `mudou` já garantiu MUDANÇA REAL → habilita purga do gêmeo 'feito' (reversão)
    aEnfileirar.push({
      chave, tipo: "A3",
      agenda_id_cnn: vig.id, paciente_id_cnn: pid, grupo,
      payload: { kind: "sync", leadId: leadId ?? null, status: vig.status, cnnTs: vig.ts, telefone: vig.tel, baseline: !est, temOutro },
    });
```

### Diff 3 — purga antes do enqueue (`src/index.ts:1713`, imediatamente antes de `const antes = ...`)
```js
  // A3-REVERSÃO (fix): a chave A3:sync inclui o status, mas os VALORES de status recorrem
  // (a agenda oscila entre poucos estados: AGENDADO⇄CONFIRMADO_PACIENTE). Quando o status
  // volta a um valor JÁ SINCRONIZADO, a chave nova é idêntica à de uma linha 'feito' antiga
  // → INSERT OR IGNORE descarta o item → o move-de-volta é perdido pra sempre. Como esses
  // itens já passaram pelo gate `mudou` (agenda_sync ≠ estado atual = MUDANÇA REAL), purgamos
  // o gêmeo RESOLVIDO ('feito') da MESMA chave antes de reenfileirar. NÃO toca linhas em voo
  // (pendente/processing → preserva "mesma mudança = 1 item"), NÃO toca 'erro'/dead-letter
  // (fica p/ /debug-fila-requeue), NÃO toca órfãos (A3:orphan depende da chave p/ dedup entre
  // ticks). Sob o lease B2 o produtor não corre com o dreno (DELETE+INSERT não-atômico é seguro).
  if (chavesSyncMudou.length) {
    const CH = 50;
    for (let i = 0; i < chavesSyncMudou.length; i += CH) {
      const grp = chavesSyncMudou.slice(i, i + CH).map((ch) =>
        env.DB.prepare(`DELETE FROM fila_trabalho WHERE chave = ? AND status = 'feito'`).bind(ch));
      if (grp.length) await env.DB.batch(grp);
    }
  }

```
(As linhas seguintes `const antes = (await filaStats(env)).pendente ?? 0;` … `await filaEnfileirarLote(aEnfileirar, env);` ficam inalteradas.)

### Por que preserva a idempotência normal (mesmo status, mesma agenda, mesmo dia = 1 item)
- **Sem mudança**: gate `mudou=false` (`:1671-1672`) → item não é montado → chave não entra em `chavesSyncMudou` → nenhuma purga, nenhum insert. Zero churn tick-a-tick.
- **Duas rodadas do produtor com o MESMO status novo antes do dreno**: 1ª purga (nada casa) + insere `pendente K`. 2ª purga `WHERE chave=K AND status='feito'` → K está `pendente` → deleta 0; `INSERT OR IGNORE` deduplica contra o `pendente`. Continua 1 item.
- **Mudança de hora** (status igual, ts>60 dif.): `tsBucket` muda → chave nova, sem gêmeo → purga é no-op. Comportamento atual mantido.
- **Reversão** (status volta a valor já visto): purga a linha `feito` gêmea → `INSERT OR IGNORE` agora aterrissa → move-de-volta enfileirado. ✔

Efeito colateral positivo: `out.enfileirados`/`out.ja_na_fila` (`:1716-1717`) passam a contar a reversão como enfileirada (antes contava como `ja_na_fila`, silenciosamente perdida). Nenhuma mudança de contabilidade necessária — a purga não mexe no total de `pendente`.

## 3. Plano de teste local

Nenhum selftest existente assere o formato da chave A3 (grep confirma que `A3:sync`/`A3:orphan` só aparecem nas 2 linhas produtoras `:1676`/`:1707`) → nada quebra. A lógica nova é SQL/estado D1, então o selftest puro (`mode=logic`, sem D1, `:2905+`) não cobre; testar no D1 local.

**(A) Reprodução determinística no D1 local** (`kommo-cnn-db`, sem token CF):
```bash
npx wrangler d1 execute kommo-cnn-db --local --command "
DELETE FROM fila_trabalho WHERE chave LIKE 'A3:sync:__t:%';
-- passo 1: sync AGENDADO já processada (gêmeo 'feito')
INSERT INTO fila_trabalho (chave,tipo,status,tentativas,criado_em,atualizado_em)
  VALUES ('A3:sync:__t:A:9:AGENDADO:100','A3','feito',0,0,0);
-- BUG (só INSERT OR IGNORE, sem a purga): reversão CONFIRMADO->AGENDADO é descartada
INSERT OR IGNORE INTO fila_trabalho (chave,tipo,status,tentativas,criado_em,atualizado_em)
  VALUES ('A3:sync:__t:A:9:AGENDADO:100','A3','pendente',0,0,0);
SELECT 'BUG', status, COUNT(*) FROM fila_trabalho WHERE chave='A3:sync:__t:A:9:AGENDADO:100' GROUP BY status;
-- esperado BUG: 1x feito, 0x pendente (item perdido)

-- FIX: purga o gêmeo 'feito' e reinsere
DELETE FROM fila_trabalho WHERE chave='A3:sync:__t:A:9:AGENDADO:100' AND status='feito';
INSERT OR IGNORE INTO fila_trabalho (chave,tipo,status,tentativas,criado_em,atualizado_em)
  VALUES ('A3:sync:__t:A:9:AGENDADO:100','A3','pendente',0,0,0);
SELECT 'FIX', status, COUNT(*) FROM fila_trabalho WHERE chave='A3:sync:__t:A:9:AGENDADO:100' GROUP BY status;
-- esperado FIX: 1x pendente (reversão enfileirada)

-- IDEMPOTÊNCIA: rodar o fix de novo com o item AINDA pendente (em voo)
DELETE FROM fila_trabalho WHERE chave='A3:sync:__t:A:9:AGENDADO:100' AND status='feito';
INSERT OR IGNORE INTO fila_trabalho (chave,tipo,status,tentativas,criado_em,atualizado_em)
  VALUES ('A3:sync:__t:A:9:AGENDADO:100','A3','pendente',0,0,0);
SELECT 'IDEMP', status, COUNT(*) FROM fila_trabalho WHERE chave='A3:sync:__t:A:9:AGENDADO:100' GROUP BY status;
-- esperado IDEMP: AINDA 1x pendente (sem duplicar)

DELETE FROM fila_trabalho WHERE chave LIKE 'A3:sync:__t:%';
"
```
Critério de aprovação: `BUG` mostra `feito=1,pendente=0`; `FIX` mostra `pendente=1`; `IDEMP` mostra `pendente=1` (não 2).

**(B) Selftest embutido opcional (repetível, sem token)** — se o dono quiser cobertura de CI, adicionar endpoint `/debug-a3-reversao-selftest` no mesmo molde de `/debug-retry-selftest`, rodando os 3 asserts de (A) contra `env.DB` com prefixo `__selftest` e limpando ao fim. Retorna `{passed, failed, falhas}`. (Detalhar na implementação; não é bloqueante do fix.)

**(C) Smoke ao vivo (dry, read-only)**: `/debug-tick?job=sync&dry=1` após deploy-candidate em `wrangler dev --remote` — confirma que `produtorSync` roda sem erro com a purga. Obs.: `produtorSync` já escreve na fila independentemente de `dry` (o `dryRun` só governa o consumidor); a purga executa junto do enqueue, coerente com o comportamento atual.

## 4. Riscos

- **Não-atomicidade DELETE→INSERT**: são 2 batches D1 distintos. Mitigado pelo lease B2 (`adquirirLease`, `:574`) que serializa cron + `/debug-tick` → produtor não corre com dreno. Pior caso sem lease: reprocesso benigno (consumidor A3 é idempotente por `agenda_sync`/etapa-alvo).
- **`filaStats().feito` cai** ao purgar linhas `feito` — cosmético; não é usado em nenhuma decisão de correção. `/debug-fila-erros` (só `status='erro'`) intacto.
- **Custo**: +1 batch D1 por rodada do produtor, dimensionado ao nº de syncs com `mudou=true` (tipicamente pequeno; gate elimina o caso comum). Chamada de binding D1, não conta contra o teto de 50 fetch (`subreqUsados`).
- **Caminho `precisaCriar && !mudou`** (`:1672`): também entra em `chavesSyncMudou` e purga. Benigno/auto-cura: se o mapeamento sumiu mas `agenda_sync` existe, reabilita link/create. Baixo risco.

## 5. [DECISAO] do dono

1. **Escopo da purga: `feito` apenas (default) vs `feito`+`erro`.** Segui a letra do item ("purgar o feito"). Consequência: se um sync a um status oscilou p/ dead-letter (`erro`, 4 falhas), uma reversão futura a esse mesmo status fica bloqueada pela linha `erro` (resgate manual via `/debug-fila-requeue`). Para auto-retry nesse caso raro, trocar `status = 'feito'` por `status IN ('feito','erro')` no Diff 3.
2. **`A3:orphan` (`:1707`) tem a MESMA classe de bug** (destino ∈ conjunto finito → recorre; ex.: Perdido→reativado por ORC→Perdido de novo fica bloqueado pela linha `feito`). **Deixado FORA de escopo de propósito**: itens órfãos são montados incondicionalmente a cada tick e dependem da permanência da chave p/ dedup entre ticks; purgá-los sem um gate `mudou` re-enfileiraria+reprocessaria (1 `kommoGet /leads/{id}` cada) todo tick, inflando subrequests. Fica como follow-up separado se o dono quiser tratar reversão de órfão (exigiria um gate de mudança próprio, ex. comparar `destino` com a etapa atual antes de enfileirar).