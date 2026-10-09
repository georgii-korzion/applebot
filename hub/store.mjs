// runtime/: state.json (последние STATUS профилей), records.json (записи заказов), log.ndjson (все LOG).
// Запись не чаще раза в 2 с (debounce) — FLEET-SPEC §9.6.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEBOUNCE_MS = 2000;

export class Store {
  constructor(dir, { log = () => {} } = {}) {
    this.dir = dir;
    this.log = log;
    this.pending = new Map(); // name → () => string
    this.timer = null;
    this.logBuf = [];
    this.logTimer = null;
    try { mkdirSync(dir, { recursive: true }); } catch (e) { this.log(`runtime/ не создан: ${e.message}`, 'warn'); }
  }

  readJson(name, fallback) {
    const f = join(this.dir, name);
    if (!existsSync(f)) return fallback;
    try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { this.log(`${name} не прочитан: ${e.message}`, 'warn'); return fallback; }
  }

  /** Отложенная запись JSON (последнее значение за 2 с). */
  saveJson(name, getValue) {
    this.pending.set(name, getValue);
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, DEBOUNCE_MS);
  }

  flush() {
    for (const [name, getValue] of this.pending) {
      const f = join(this.dir, name);
      try {
        writeFileSync(`${f}.tmp`, JSON.stringify(getValue(), null, 2));
        renameSync(`${f}.tmp`, f);
      } catch (e) { this.log(`${name} не записан: ${e.message}`, 'warn'); }
    }
    this.pending.clear();
    this.flushLog();
  }

  appendLog(entry) {
    this.logBuf.push(JSON.stringify(entry));
    if (this.logTimer) return;
    this.logTimer = setTimeout(() => { this.logTimer = null; this.flushLog(); }, DEBOUNCE_MS);
  }

  flushLog() {
    if (!this.logBuf.length) return;
    const lines = this.logBuf.splice(0);
    try { appendFileSync(join(this.dir, 'log.ndjson'), `${lines.join('\n')}\n`); } catch (e) { this.log(`log.ndjson не записан: ${e.message}`, 'warn'); }
  }

  close() {
    clearTimeout(this.timer); this.timer = null;
    clearTimeout(this.logTimer); this.logTimer = null;
    this.flush();
  }
}
