export type SqlValue = string | number | null;
export interface SqlStatement {
  get(...params: SqlValue[]): Record<string, unknown> | undefined;
  run(...params: SqlValue[]): void;
}
/** The subset of SQLite the store needs, so it runs on node:sqlite and Durable Object SQL. */
export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  transaction<T>(fn: () => T): T;
  close(): void;
}
