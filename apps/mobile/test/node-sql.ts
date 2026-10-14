/// <reference types="node" />
import { DatabaseSync } from 'node:sqlite';

import type { Sql, SqlParam } from '../src/core/sql';

/** Implementação de Sql sobre o node:sqlite, para testes. */
export function nodeSql(path = ':memory:'): Sql {
  const db = new DatabaseSync(path);
  return {
    async exec(sql) {
      db.exec(sql);
    },
    async run(sql, ...params: SqlParam[]) {
      db.prepare(sql).run(...params);
    },
    async all<T>(sql: string, ...params: SqlParam[]) {
      return db.prepare(sql).all(...params) as T[];
    },
    async first<T>(sql: string, ...params: SqlParam[]) {
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
  };
}
