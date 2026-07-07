// Camada de dados — shim `DB` com a MESMA API do `env.DB` do Cloudflare Worker,
// sobre postgres.js + Supavisor (transaction mode :6543, prepare:false).
// Converte placeholders estilo D1/SQLite (?) para os do Postgres ($1,$2,...),
// então as queries do código legado migram quase intactas.
import postgres from 'postgres'

// Tuning p/ serverless + Supavisor (transaction mode :6543). Sem estes timeouts, uma conexão
// que o pooler derrubou por ociosidade fica "morta" no pool do postgres.js e PENDURA a próxima
// query até o maxDuration (60s) da Vercel → 504 sob concorrência (medido: ~96% em burst de 40).
//  • idle_timeout: fecha conexão ociosa ANTES do Supavisor (evita reutilizar conexão morta)
//  • max_lifetime: recicla conexões periodicamente
//  • connect_timeout: falha rápido em vez de pendurar ao (re)conectar
//  • max: modesto — no Fluid Compute várias invocações dividem 1 pool; evita estourar o pooler
//  • statement_timeout: o servidor cancela query travada (libera a conexão em vez de segurar 60s)
export const sql = postgres(process.env.DATABASE_URL!, {
  prepare: false,
  idle_timeout: 20,
  max_lifetime: 60 * 30,
  connect_timeout: 15,
  max: 8,
  connection: { statement_timeout: 20000 },
})

const toPg = (q: string): string => { let i = 0; return q.replace(/\?/g, () => `$${++i}`) }

export class Stmt {
  q: string
  p: unknown[]
  constructor(q: string, p: unknown[] = []) { this.q = q; this.p = p }
  bind(...args: unknown[]): Stmt { return new Stmt(this.q, args) }
  async run(): Promise<{ success: true }> { await sql.unsafe(toPg(this.q), this.p as any[]); return { success: true } }
  async first<T = any>(): Promise<T | null> { const r = await sql.unsafe(toPg(this.q), this.p as any[]); return ((r[0] as T) ?? null) }
  async all<T = any>(): Promise<{ results: T[] }> { const r = await sql.unsafe(toPg(this.q), this.p as any[]); return { results: r as unknown as T[] } }
  _tx(tx: any) { return tx.unsafe(toPg(this.q), this.p as any[]) }
}

export const DB = {
  prepare: (q: string) => new Stmt(q),
  batch: (stmts: Stmt[]) => sql.begin((tx: any) => Promise.all(stmts.map((s) => s._tx(tx)))),
}
