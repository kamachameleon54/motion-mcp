import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { MotionError } from './errors.js';
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export interface Operation {
  fingerprint: string;
  state: string;
  result: string | null;
}
/** One durable store per Motion account. Multiple local processes use SQLite transactions.
 * Production runs one service/volume; remote Claude clients use the same service. */
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS operations (account TEXT, key TEXT, fingerprint TEXT, state TEXT, result TEXT, PRIMARY KEY(account,key));
      CREATE TABLE IF NOT EXISTS requests (account TEXT, at INTEGER);
      CREATE INDEX IF NOT EXISTS requests_account ON requests(account,at);
      CREATE TABLE IF NOT EXISTS cooldowns (account TEXT PRIMARY KEY, until_ms INTEGER);
      CREATE TABLE IF NOT EXISTS capture_intents (account TEXT, intent TEXT, operation TEXT, PRIMARY KEY(account,intent));
      CREATE TABLE IF NOT EXISTS revoked (jti TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS suggestions (key TEXT PRIMARY KEY, state TEXT, event TEXT);`);
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
  claim(account: string, key: string, fingerprint: string): { fresh: boolean; op: Operation } {
    return this.transaction(() => {
      const existing = this.db
        .prepare('SELECT fingerprint,state,result FROM operations WHERE account=? AND key=?')
        .get(account, key) as unknown as Operation | undefined;
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new MotionError(
            'operation_key_conflict',
            'This operation key belongs to a different request.'
          );
        return { fresh: false, op: existing };
      }
      this.db
        .prepare("INSERT INTO operations VALUES (?,?,?,'pending',NULL)")
        .run(account, key, fingerprint);
      return { fresh: true, op: { fingerprint, state: 'pending', result: null } };
    });
  }
  guardCapture(account: string, intent: string, operation: string, completedTaskIds: string[]) {
    this.transaction(() => {
      const prior = this.db
        .prepare('SELECT operation FROM capture_intents WHERE account=? AND intent=?')
        .get(account, intent) as { operation: string } | undefined;
      if (prior && prior.operation !== operation) {
        const op = this.db
          .prepare('SELECT state,result FROM operations WHERE account=? AND key=?')
          .get(account, prior.operation) as { state: string; result: string | null } | undefined;
        const taskId = op?.result ? JSON.parse(op.result).id : undefined;
        if (
          op?.state !== 'rejected' &&
          !(op?.state === 'done' && completedTaskIds.includes(taskId))
        )
          throw new MotionError(
            'duplicate_pending',
            'Another capture owns this next action. Reconcile the earlier operation before submitting again.',
            { operationKey: prior.operation }
          );
      }
      this.db
        .prepare(
          'INSERT INTO capture_intents VALUES (?,?,?) ON CONFLICT(account,intent) DO UPDATE SET operation=excluded.operation'
        )
        .run(account, intent, operation);
    });
  }
  finish(account: string, key: string, result: unknown, state = 'done') {
    this.db
      .prepare('UPDATE operations SET state=?,result=? WHERE account=? AND key=?')
      .run(state, JSON.stringify(result), account, key);
  }
  reserve(account: string, limit: number, now = Date.now(), windowMs = 60000): number {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM requests WHERE at<=?').run(now - windowMs);
      const cool = this.db
        .prepare('SELECT until_ms FROM cooldowns WHERE account=?')
        .get(account) as { until_ms: number } | undefined;
      if (cool && cool.until_ms > now) return cool.until_ms - now;
      const row = this.db
        .prepare('SELECT COUNT(*) AS count,MIN(at) AS oldest FROM requests WHERE account=?')
        .get(account) as { count: number; oldest: number };
      if (row.count >= limit) return Math.max(1, row.oldest + windowMs - now);
      this.db.prepare('INSERT INTO requests VALUES (?,?)').run(account, now);
      return 0;
    });
  }
  async acquire(account: string, limit: number, maxWaitMs: number) {
    const end = Date.now() + maxWaitMs;
    for (;;) {
      const wait = this.reserve(account, limit);
      if (!wait) return;
      if (Date.now() + wait > end)
        throw new MotionError(
          'rate_limit_wait',
          'Account quota is busy. Retry this same operation later.',
          { retryAfterMs: wait }
        );
      await delay(wait);
    }
  }
  cooldown(account: string, milliseconds: number) {
    this.db
      .prepare(
        'INSERT INTO cooldowns VALUES (?,?) ON CONFLICT(account) DO UPDATE SET until_ms=MAX(until_ms,excluded.until_ms)'
      )
      .run(account, Date.now() + milliseconds);
  }
  revoke(jti: string) {
    this.db.prepare('INSERT OR IGNORE INTO revoked VALUES (?)').run(jti);
  }
  isRevoked(jti: string) {
    return !!this.db.prepare('SELECT jti FROM revoked WHERE jti=?').get(jti);
  }
  close() {
    this.db.close();
  }
}
