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

  /** Better-sqlite3-style transaction helper: BEGIN / COMMIT / ROLLBACK. */
  transaction(fn) {
    const self = this;
    return function tx(...args) {
      self.db.exec('BEGIN');
      try {
        const r = fn(...args);
        self.db.exec('COMMIT');
        return r;
      } catch (e) {
        try { self.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = { Database };
