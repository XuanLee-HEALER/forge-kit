import { expect } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

function sqlIdentifier(name: string) { return '"' + name.replaceAll('"', '""') + '"'; }
type Table = { name: string; columns: string[] };
export function snapshot(work: string, tables?: Table[]) {
  const db = new Database(join(work, ".workbench/ledger/ledger.sqlite"), { readonly: true });
  try {
    const names = db.query("SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name: string}[];
    const schema = tables ?? names.map(({name}) => ({
      name, columns: (db.query("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(name) as {name: string}[]).map(c => c.name),
    }));
    const rows = schema.map(({name, columns}) => {
      const fields = columns.map(sqlIdentifier).join(", ");
      return db.query(`SELECT ${fields} FROM ${sqlIdentifier(name)} ORDER BY ${fields}`).values();
    });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    return { schema, rows };
  } finally { db.close(); }
}
