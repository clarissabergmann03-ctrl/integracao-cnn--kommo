// Camada de dados — shim `DB` com a MESMA API do `env.DB` do Cloudflare Worker,
// sobre postgres.js + Supavisor (transaction mode :6543, prepare:false).
// Converte placeholders estilo D1/SQLite (?) para os do Postgres ($1,$2,...),
// então as queries do código legado migram quase intactas.
import postgres from 'postgres'

export const sql = postgres(process.env.DATABASE_URL!, { prepare: false })

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
