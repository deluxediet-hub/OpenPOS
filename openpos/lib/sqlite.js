'use strict';
// ---------------------------------------------------------------------------
// sqlite.js — thin shim exposing the small better-sqlite3-style API this
// project uses, on top of Node's built-in `node:sqlite` (Node ≥ 22.13).
// Zero native dependencies → installs anywhere with no build toolchain.
// ---------------------------------------------------------------------------
const { DatabaseSync } = require('node:sqlite');

class Database {
  constructor(file, opts = {}) {
    this.db = new DatabaseSync(file, opts);
    // Transaction depth — nested transactions become SAVEPOINTs so a helper
    // called inside an open transaction (e.g. module activation during setup)
    // cannot abort the caller's work by starting its own BEGIN.
    this._txDepth = 0;
  }

  get inTransaction() {
    return this._txDepth > 0;
  }

  pragma(sql) {
    try {
      this.db.exec(`PRAGMA ${sql}`);
    } catch (e) {
      // some pragmas report via return rows; only surface real errors
      if (/no such|syntax/i.test(e.message)) throw e;
    }
  }

  exec(sql) {
    return this.db.exec(sql);
  }

  prepare(sql) {
    const stmt = this.db.prepare(sql);
    return {
      run: (...params) => stmt.run(...params),
      get: (...params) => stmt.get(...params),
      all: (...params) => stmt.all(...params)
    };
  }

  /**
   * Better-sqlite3-style transaction helper: BEGIN / COMMIT / ROLLBACK.
   * Nested calls use SAVEPOINT, so a helper may open its own transaction even
   * when the caller already has one open — the outer unit of work stays atomic.
   */
  transaction(fn) {
    const self = this;
    return function tx(...args) {
      const nested = self._txDepth > 0;
      const name = `sp${self._txDepth + 1}`;
      self._txDepth++;
      self.db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN');
      try {
        const r = fn(...args);
        self.db.exec(nested ? `RELEASE ${name}` : 'COMMIT');
        self._txDepth--;
        return r;
      } catch (e) {
        self._txDepth--;
        try {
          self.db.exec(nested ? `ROLLBACK TO ${name}` : 'ROLLBACK');
          if (nested) self.db.exec(`RELEASE ${name}`);
        } catch { /* already rolled back */ }
        throw e;
      }
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = { Database };
