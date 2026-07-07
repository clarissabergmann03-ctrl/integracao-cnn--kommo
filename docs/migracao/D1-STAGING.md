# Migração via D1 STAGING — CNN → D1 → Kommo

> Arquitetura: **importa** a base do CNN para o D1 (uma vez, leitura resiliente), **limpa/valida** no D1, e um **Worker dreno** sincroniza aos poucos para o Kommo respeitando o rate limit, com idempotência (`sync_status` + `kommo_lead_id`). Desacopla a leitura frágil do CNN da escrita no Kommo; durável (resume após queda).

## Fluxo
```
CNN  ──import (resiliente, 2 passes)──►  D1 (mig_pacientes)  ──valida──►  Worker dreno (cron/endpoint)  ──batches ≤50 subreq, ≤7 req/s──►  Kommo
                                          sync_status=pendente                                            sync_status=enviado + kommo_lead_id
```

## 1) Schema D1

```sql
CREATE TABLE IF NOT EXISTS mig_pacientes (
  paciente_id_cnn  TEXT PRIMARY KEY,           -- identidade forte (ID Paciente CNN no Kommo)
  nome             TEXT,
  telefone         TEXT,                        -- 11 dígitos c/ DDD (pode ser vazio)
  data_nascimento  TEXT,                        -- ISO 'YYYY-MM-DD' ou NULL

  -- sinais derivados (do import/classificação) — para auditoria e re-classificação sem re-ler
  n_agendas        INTEGER DEFAULT 0,
  n_orcamentos     INTEGER DEFAULT 0,
  cobertura_pct    INTEGER,                      -- 0..100 (% do último orçamento aprovado executado)
  dias_silencio    INTEGER,
  ultimo_aprovado  TEXT,                         -- ISO ou NULL
  cancelou_apos    INTEGER DEFAULT 0,            -- 0/1 (último aprovado foi cancelado/perdido)
  fez_todos        INTEGER DEFAULT 0,            -- 0/1 (cobertura >= 85%)
  tem_futura       INTEGER DEFAULT 0,            -- 0/1 (agenda >= 2026-07-01)
  grupo_futuro     TEXT,                         -- 'A' | 'B' | NULL
  teve_grupo_b     INTEGER DEFAULT 0,            -- 0/1

  -- destino (classificação)
  regra            TEXT,                         -- ex '5.1c_abandono_silencio>90d'
  pipeline_id      INTEGER,                      -- funil-alvo
  stage_id         INTEGER,                      -- etapa-alvo
  inativo_faixa    TEXT,                         -- '90D'|'180D'|'360D'|'540D'|'720D'|'' (<90D)

  -- enriquecimento
  valor_venda      REAL,                         -- orcamento.valorLiquido → lead.price
  faciais          TEXT,                         -- csv de procedimentos faciais (enum a resolver)
  corporais        TEXT,                         -- csv de procedimentos corporais
  fonte            TEXT,                         -- origem CNN (mapear p/ enum 'Fonte' se casar)
  flags            TEXT,                         -- json array de flags de validação

  -- controle de VALIDAÇÃO (checklist)
  validacao        TEXT NOT NULL DEFAULT 'pendente',  -- pendente|ok|revisar|erro_classificacao|erro_leitura

  -- controle de SYNC (idempotência)
  sync_status      TEXT NOT NULL DEFAULT 'pendente',  -- pendente|processing|enviado|erro|skip
  kommo_lead_id    TEXT,                         -- preenchido após criar/adotar no Kommo (idempotência)
  tentativas       INTEGER NOT NULL DEFAULT 0,
  ultimo_erro      TEXT,

  -- timestamps (epoch s)
  importado_em     INTEGER,
  sincronizado_em  INTEGER,
  atualizado_em    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mig_sync ON mig_pacientes(sync_status, validacao);
CREATE INDEX IF NOT EXISTS idx_mig_val  ON mig_pacientes(validacao);

-- Trilha de auditoria opcional (o que foi escrito no Kommo, quando)
CREATE TABLE IF NOT EXISTS mig_sync_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  paciente_id_cnn  TEXT, kommo_lead_id TEXT, acao TEXT, detalhe TEXT, ts INTEGER
);
```

> **Idempotência:** PK = `paciente_id_cnn`. Rodar o dreno 2× dá o mesmo resultado: itens já `enviado` não são re-selecionados; e mesmo se forem, o writer procura o lead por *ID Paciente CNN* antes de criar (nunca duplica) e o move é *forward-only* (nunca rebaixa).

## 2) Worker dreno (sincronização em batches, respeitando o rate limit)

```typescript
// ── Migração D1→Kommo: schema, claim atômico, dreno idempotente ──────────────
async function ensureMigSchema(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS mig_pacientes ( /* ...schema acima... */ )`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_mig_sync ON mig_pacientes(sync_status, validacao)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS mig_sync_log ( /* ...acima... */ )`),
  ]);
}

// Ordem das etapas por funil (para o guard forward-only: nunca rebaixar)
const MIG_ORDEM: Record<number, number[]> = {
  [PIPELINE_CAPTACAO]:    [106848271,106848615,106848619,107785399,106848623,106848627,106848631,107789355,142,143],
  [PIPELINE_POS_VENDA]:   [107658903,107658907,107658911,107974651,107658915,107860123,107774015,107774019,107774023,142,143],
  [PIPELINE_POS_CONSULTA]:[107633735,107633739,107633747,107773799,142,143],
};
function ordemEtapa(pipe: number, stage: number): number {
  const i = (MIG_ORDEM[pipe] ?? []).indexOf(stage);
  return i < 0 ? 999 : i;  // desconhecida → tratada como "à frente" (não rebaixa por engano)
}

// Claim atômico de um lote pendente+validado (D1 single-writer → seguro sob concorrência)
async function migClaimLote(env: Env, limite: number): Promise<any[]> {
  const now = Math.floor(Date.now() / 1000);
  const r = await env.DB.prepare(
    `UPDATE mig_pacientes SET sync_status='processing', tentativas=tentativas+1, atualizado_em=?1
       WHERE paciente_id_cnn IN (
         SELECT paciente_id_cnn FROM mig_pacientes
          WHERE sync_status='pendente' AND validacao IN ('ok','revisar') AND tentativas < 4
          ORDER BY paciente_id_cnn LIMIT ?2)
     RETURNING *`
  ).bind(now, limite).all();
  return r.results ?? [];
}

// Monta os custom fields do Kommo a partir da linha do D1
function migCamposCustom(row: any, fields: Record<string, number>): any[] {
  const cf: any[] = [];
  if (fields["ID Paciente CNN"]) cf.push({ field_id: fields["ID Paciente CNN"], values: [{ value: String(row.paciente_id_cnn) }] });
  if (row.data_nascimento && fields["Aniversário"]) {
    const ts = Math.floor(Date.parse(row.data_nascimento) / 1000);
    if (Number.isFinite(ts)) cf.push({ field_id: fields["Aniversário"], values: [{ value: ts }] });
  }
  if (row.inativo_faixa && fields["Inativo"]) {
    const en = fields[`Inativo::${row.inativo_faixa}`];   // enum resolvido por resolveFields
    if (en) cf.push({ field_id: fields["Inativo"], values: [{ enum_id: en }] });
  }
  // Faciais/Corporais/Fonte: enums — resolver row.faciais/corporais/fonte → enum_id (mapa a completar, §gaps)
  return cf;
}

// Cria o card no funil/etapa-alvo (idempotência A7: adota card existente por ID Paciente CNN antes)
async function migCriarLead(row: any, grupo: "A" | "B", fields: Record<string, number>, env: Env): Promise<string | undefined> {
  const criado: any = await kommoPost("/leads/complex", [{
    name: row.nome || `Paciente ${row.paciente_id_cnn}`,
    pipeline_id: Number(row.pipeline_id), status_id: Number(row.stage_id),
    ...(row.valor_venda ? { price: Math.round(Number(row.valor_venda)) } : {}),
    custom_fields_values: migCamposCustom(row, fields),
    _embedded: { contacts: [{ name: row.nome || "",
      custom_fields_values: row.telefone ? [{ field_code: "PHONE", values: [{ value: row.telefone, enum_code: "WORK" }] }] : [] }] },
  }], env);
  return criado?.[0]?.id ? String(criado[0].id) : undefined;
}

// Move forward-only + garante etapa/pipeline (nunca rebaixa)
async function migMoveForwardOnly(leadId: string, stageId: number, pipelineId: number, env: Env): Promise<void> {
  const lead: any = await kommoGet(`/leads/${leadId}`, env);
  const mesmoFunil = Number(lead.pipeline_id) === pipelineId;
  if (mesmoFunil && ordemEtapa(pipelineId, Number(lead.status_id)) >= ordemEtapa(pipelineId, stageId)) return; // já igual/à frente
  await kommoPatch(`/leads/${leadId}`, { status_id: stageId, pipeline_id: pipelineId }, env);
}

// Enriquece campos (idempotente) num lead existente
async function migEnriquecer(leadId: string, row: any, fields: Record<string, number>, env: Env): Promise<void> {
  const body: any = { custom_fields_values: migCamposCustom(row, fields) };
  if (row.valor_venda) body.price = Math.round(Number(row.valor_venda));
  await kommoPatch(`/leads/${leadId}`, body, env);
}

// Processa 1 linha: idempotente (acha por ID Paciente CNN → adota/move; senão cria) + enriquece
async function migSyncItem(row: any, env: Env, fields: Record<string, number>, dryRun: boolean): Promise<any> {
  const grupo: "A" | "B" = Number(row.pipeline_id) === PIPELINE_POS_VENDA ? "B" : "A";
  let leadId: string | undefined = row.kommo_lead_id || await acharLeadPorPacienteCnn(String(row.paciente_id_cnn), grupo, fields, env);
  if (dryRun) return { acao: leadId ? "mover+enriquecer" : "criar", leadId: leadId ?? null };
  let acao: string;
  if (!leadId) { leadId = await migCriarLead(row, grupo, fields, env); acao = "criado"; }
  else { await migMoveForwardOnly(leadId, Number(row.stage_id), Number(row.pipeline_id), env); acao = "movido"; }
  if (leadId) await migEnriquecer(leadId, row, fields, env);
  return { acao, leadId: leadId ?? null };
}

// Dreno de um batch — respeita o teto de 50 subreq/tick e o throttle Kommo (kommoThrottle nos wrappers)
async function migSyncBatch(env: Env, limite = 12, dryRun = true): Promise<any> {
  await ensureMigSchema(env);
  const fields = await resolveFields(env);
  const lote = dryRun
    ? (await env.DB.prepare(`SELECT * FROM mig_pacientes WHERE sync_status='pendente' AND validacao IN ('ok','revisar') AND tentativas<4 ORDER BY paciente_id_cnn LIMIT ?`).bind(limite).all()).results ?? []
    : await migClaimLote(env, limite);
  const out: any = { total: lote.length, dry: dryRun, criados: 0, movidos: 0, erros: 0, itens: [] as any[] };
  const now = Math.floor(Date.now() / 1000);
  for (const row of lote) {
    if (!orcamentoOk(46)) { out.parou_budget = true; break; }   // devolve o resto ao próximo tick
    try {
      const r = await migSyncItem(row, env, fields, dryRun);
      out.itens.push({ pid: row.paciente_id_cnn, ...r });
      if (!dryRun) {
        await env.DB.prepare(`UPDATE mig_pacientes SET sync_status='enviado', kommo_lead_id=?1, sincronizado_em=?2, ultimo_erro=NULL, atualizado_em=?2 WHERE paciente_id_cnn=?3`)
          .bind(r.leadId, now, row.paciente_id_cnn).run();
        await env.DB.prepare(`INSERT INTO mig_sync_log (paciente_id_cnn,kommo_lead_id,acao,detalhe,ts) VALUES (?,?,?,?,?)`)
          .bind(row.paciente_id_cnn, r.leadId, r.acao, row.regra, now).run();
        if (r.acao === "criado") out.criados++; else out.movidos++;
      }
    } catch (e) {
      out.erros++;
      if (!dryRun) {
        const status = Number(row.tentativas) >= 4 ? "erro" : "pendente";   // devolve p/ retry até 4x
        await env.DB.prepare(`UPDATE mig_pacientes SET sync_status=?1, ultimo_erro=?2, atualizado_em=?3 WHERE paciente_id_cnn=?4`)
          .bind(status, String(e).slice(0, 300), now, row.paciente_id_cnn).run();
      }
    }
  }
  return out;
}

// Endpoint: /mig-sync?limite=12&dry=1  (dry=0 escreve no Kommo). Auth = discoverAuthOk.
// Cron: em scheduled(), chamar `if (env.MIG_SYNC_ENABLED === "true") await migSyncBatch(env, 12, false);`
//       → ~12 leads/tick a 1 tick/min ≈ ~17k/dia (folga p/ os ~8,26k). Ou drenar rápido via wrangler dev --remote em loop.
```

## 3) Import (CNN → D1) — como o D1 é populado
Reusa o classificador já validado (`derivarSinaisMig` + `classificarMigracao` + `faixaInativo`) + o leitor resiliente (`retrySweep`), gravando cada paciente no `mig_pacientes` (em vez de JSONL). Como o D1 é durável, o import é retomável e os `erro_leitura` ficam marcados para o 2º passe — sem perder progresso quando o wrangler cai.

## Gaps a confirmar (só o que não cobrimos)
1. **CREATE vs só-mover:** pacientes sem lead no Kommo → **criar card** no funil/etapa (assumido), ou só posicionar quem já existe?
2. **Enum de Faciais/Corporais/Fonte:** o mapa procedimento-CNN→enum-Kommo não foi fechado. v1 enriquece só ID Paciente CNN + Aniversário + price + Inativo; Faciais/Corporais/Fonte ficam para uma 2ª passada quando definirmos o mapa. OK?
3. **Escopo do sync:** só `validacao='ok'`, ou `ok`+`revisar` (revisar = casos-limite que você liberou)?
