import type { SqlDatabase, SqlValue } from './sql.js';

/** The slice of DurableObjectState['storage'] this adapter uses. */
export interface DurableStorageLike {
  sql: { exec(query: string, ...bindings: SqlValue[]): { toArray(): Record<string, unknown>[] } };
  transactionSync<T>(fn: () => T): T;
}

/** Store adapter for SQLite-backed Durable Objects. Calls are synchronous, like node:sqlite;
 * transactions use transactionSync because BEGIN/COMMIT are not allowed in sql.exec. */
export class DurableSqlDatabase implements SqlDatabase {
  constructor(private readonly storage: DurableStorageLike) {}
  exec(sql: string) {
    this.storage.sql.exec(sql).toArray();
  }
  prepare(sql: string) {
    return {
      get: (...params: SqlValue[]) => this.storage.sql.exec(sql, ...params).toArray()[0],
      run: (...params: SqlValue[]) => {
        this.storage.sql.exec(sql, ...params).toArray();
      },
    };
  }
  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
  close() {}
}
