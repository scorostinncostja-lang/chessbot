// Обёртка над Stockfish (WASM в Web Worker, протокол UCI).
// Многопоточная сборка работает только при crossOriginIsolated (заголовки COOP/COEP ставит sw.js).

export function pickBuild() {
  const cores = navigator.hardwareConcurrency || 2;
  const multi = self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined' && cores > 1;
  const mem = navigator.deviceMemory || 4;
  return {
    url: multi ? 'engine/stockfish-18-lite.js' : 'engine/stockfish-18-lite-single.js',
    threads: multi ? Math.max(1, Math.min(cores - 1, 8)) : 1,
    hash: mem <= 2 ? 32 : mem <= 4 ? 64 : 256,
    multi,
  };
}

export class Engine {
  constructor(url) {
    this.worker = new Worker(url);
    this.listeners = new Set();
    this.worker.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : String(e.data);
      for (const fn of this.listeners) fn(line);
    };
    this.worker.onerror = (e) => { this.error = e; };
    this.busy = null;
    this.multipv = 0;
  }

  send(cmd) { this.worker.postMessage(cmd); }

  waitFor(prefix, timeoutMs = 30000) {
    return new Promise((res, rej) => {
      const t = timeoutMs ? setTimeout(() => { this.listeners.delete(fn); rej(new Error('engine timeout: ' + prefix)); }, timeoutMs) : 0;
      const fn = (line) => {
        if (line.startsWith(prefix)) { clearTimeout(t); this.listeners.delete(fn); res(line); }
      };
      this.listeners.add(fn);
    });
  }

  async init({ threads = 1, hash = 64 } = {}) {
    const ok = this.waitFor('uciok', 60000);
    this.send('uci');
    await ok;
    this.send(`setoption name Threads value ${threads}`);
    this.send(`setoption name Hash value ${hash}`);
    const ready = this.waitFor('readyok', 60000);
    this.send('isready');
    await ready;
  }

  newGame() { this.send('ucinewgame'); }

  async stop() {
    if (!this.busy) return;
    this.send('stop');
    try { await this.busy; } catch (_) { /* ignore */ }
  }

  /**
   * opts: { movetime (мс) | infinite: true, multipv }
   * onInfo(lines) — lines[i] = {depth, cp, mate, pv[], nps}; оценка с точки зрения стороны, которая ходит
   */
  async analyze(fen, opts, onInfo) {
    // запросы могут прилетать пачкой — выполняем только самый свежий
    const id = this.reqId = (this.reqId || 0) + 1;
    while (this.busy) await this.stop();
    if (id !== this.reqId) return { bestmove: null, lines: [], cancelled: true };
    const mpv = opts.multipv || 1;
    if (mpv !== this.multipv) { this.send(`setoption name MultiPV value ${mpv}`); this.multipv = mpv; }
    const lines = [];
    const fn = (line) => {
      if (!line.startsWith('info') || !line.includes(' pv ')) return;
      const k = +(line.match(/ multipv (\d+)/) || [0, 1])[1] - 1;
      const cp = line.match(/ score cp (-?\d+)/);
      const mate = line.match(/ score mate (-?\d+)/);
      if (line.includes(' lowerbound') || line.includes(' upperbound')) return;
      lines[k] = {
        depth: +(line.match(/ depth (\d+)/) || [])[1],
        cp: cp ? +cp[1] : null,
        mate: mate ? +mate[1] : null,
        nps: +(line.match(/ nps (\d+)/) || [0, 0])[1],
        pv: line.split(' pv ')[1].trim().split(/\s+/),
      };
      onInfo && onInfo(lines.filter(Boolean));
    };
    this.listeners.add(fn);
    const done = this.waitFor('bestmove', 0);
    this.send('position fen ' + fen);
    this.send(opts.infinite ? 'go infinite' : 'go movetime ' + opts.movetime);
    this.busy = done;
    try {
      const line = await done;
      return { bestmove: line.split(/\s+/)[1], lines: lines.filter(Boolean) };
    } finally {
      this.listeners.delete(fn);
      this.busy = null;
    }
  }
}
