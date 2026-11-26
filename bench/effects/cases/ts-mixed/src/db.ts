import Database from 'better-sqlite3';

export const db = new Database('notes.db');

export function bump(id: string) {
  return db.prepare('UPDATE counters SET hits = hits + 1 WHERE id = ?').run(id);
}

export function top(limit: number) {
  return db.prepare('SELECT id, hits FROM counters ORDER BY hits DESC LIMIT ?').all(limit);
}
