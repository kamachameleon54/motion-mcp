import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { SqlDatabase, SqlValue } from './sql.js';
import { Store } from './store.js';

export const defaultStatePath = () =>
  join(homedir(), '.local', 'state', 'motion-mcp', 'state.sqlite');

export class NodeSqlDatabase implements SqlDatabase {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  }
  exec(sql: string) {
    this.db.exec(sql);
  }
  prepare(sql: string) {
    const statement = this.db.prepare(sql);
    return {
      get: (...params: SqlValue[]) =>
        statement.get(...params) as Record<string, unknown> | undefined,
      run: (...params: SqlValue[]) => {
        statement.run(...params);
      },
    };
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}

export const openNodeStore = (path = defaultStatePath()) => new Store(new NodeSqlDatabase(path));
