import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DurableSqlDatabase, type DurableStorageLike } from '../src/core/durable-sqlite.js';
import { Store } from '../src/core/store.js';

/** Mimics ctx.storage: sql.exec(query, ...bindings) returning a cursor, and transactionSync. */
function fakeStorage(): DurableStorageLike {
  const db = new DatabaseSync(':memory:');
  return {
    sql: {
      exec(query: string, ...bindings: (string | number | null)[]) {
        if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|PRAGMA)/i.test(query))
          throw new Error('not allowed in Durable Object SQL: ' + query);
        if (!bindings.length && query.includes(';')) {
          db.exec(query);
          return { toArray: () => [] };
        }
        const rows = db.prepare(query).all(...bindings) as Record<string, unknown>[];
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(fn: () => T): T {
      db.exec('BEGIN');
      try {
        const v = fn();
        db.exec('COMMIT');
        return v;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

test('claim is idempotent and rejects a reused key with another fingerprint', () => {
  const store = new Store(new DurableSqlDatabase(fakeStorage()));
  assert.equal(store.claim('a', 'k1', 'f1').fresh, true);
  assert.equal(store.claim('a', 'k1', 'f1').fresh, false);
  assert.throws(() => store.claim('a', 'k1', 'f2'), /operation key/i);
});

test('reserve enforces the per-minute limit and cooldown', () => {
  const store = new Store(new DurableSqlDatabase(fakeStorage()));
  const now = 1_000_000;
  assert.equal(store.reserve('a', 2, now), 0);
  assert.equal(store.reserve('a', 2, now), 0);
  assert.ok(store.reserve('a', 2, now) > 0);
  store.cooldown('b', 5000);
  assert.ok(store.reserve('b', 2) > 0);
});

test('a throwing transaction rolls back', () => {
  const store = new Store(new DurableSqlDatabase(fakeStorage()));
  assert.throws(() =>
    store.transaction(() => {
      store.db.prepare("INSERT INTO operations VALUES ('a','k','f','pending',NULL)").run();
      throw new Error('boom');
    })
  );
  assert.equal(store.db.prepare("SELECT key FROM operations WHERE key='k'").get(), undefined);
});

test('finish records the result for replay', () => {
  const store = new Store(new DurableSqlDatabase(fakeStorage()));
  store.claim('a', 'k2', 'f');
  store.finish('a', 'k2', { id: 't1' });
  const again = store.claim('a', 'k2', 'f');
  assert.equal(again.op.state, 'done');
  assert.deepEqual(JSON.parse(again.op.result!), { id: 't1' });
});
