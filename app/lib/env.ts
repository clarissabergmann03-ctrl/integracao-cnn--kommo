// As funções do core recebem `env` e acessam env.CNN_CID (string, de process.env)
// e env.DB (o shim postgres.js). Reunimos os dois num objeto só — assim o código
// portado não muda as assinaturas (continua `env.DB.prepare(...)`, `env.CNN_CID`, ...).
import { DB } from './db.ts'

export function makeEnv(): any {
  return Object.assign({}, process.env, { DB })
}
