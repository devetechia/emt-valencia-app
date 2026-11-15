/* ═══════════════════════════════════════════════════════════
   quiz.js — Generador de preguntas con datos reales de EMT
   ═══════════════════════════════════════════════════════════ */

class Quiz {
  constructor(lines) {
    this.lines = lines;

    // agrupar por número de línea (hay rutas duplicadas por sentidos)
    this.byNum = new Map();
    for (const l of lines) {
      if (!this.byNum.has(l.n)) this.byNum.set(l.n, []);
      this.byNum.get(l.n).push(l);
    }
    this.nums = [...this.byNum.keys()];

    // destinos (cabeceras) por línea
    this.endpoints = new Map();   // num -> [A, B]
    for (const [n, ls] of this.byNum) {
      const ep = this._endpoints(ls[0]);
      if (ep.length) this.endpoints.set(n, ep);
    }

    // paradas -> líneas
    this.stopLines = new Map();   // stopId -> {name, Set(nums)}
    for (const l of lines) {
      for (const v of l.variants) {
        for (const s of v.stops) {
          if (!this.stopLines.has(s.id)) this.stopLines.set(s.id, { name: s.name, nums: new Set() });
          this.stopLines.get(s.id).nums.add(l.n);
        }
      }
    }
    this.stopIds = [...this.stopLines.keys()];

    // destinos usados como opciones
    this.allDest = [...new Set([...this.endpoints.values()].flat())];
  }

  _endpoints(l) {
    const name = (l.name || '').replace(/^\s*[^-\s]+\s*-\s*/, '');   // quita "4 - "
    const parts = name.split(/\s+-\s+/).map(s => s.trim()).filter(Boolean);
    return [...new Set(parts)];
  }

  _other(pool, correct, n = 3) {
    const cands = pool.filter(x => x !== correct && !String(x).startsWith(String(correct)));
    const out = [];
    const used = new Set([correct]);
    let guard = 0;
    while (out.length < n && guard++ < 400) {
      const x = cands[Math.floor(Math.random() * cands.length)];
      if (x && !used.has(x)) { used.add(x); out.push(x); }
    }
    return out;
  }

  _shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* ── generación ── */
  build(kind, count) {
    const qs = [];
    let guard = 0;
    while (qs.length < count && guard++ < count * 60) {
      let q = null;
      const k = kind === 'mixed'
        ? ['stop', 'destino', 'cabecera'][Math.floor(Math.random() * 3)]
        : kind;
      if (k === 'stop') q = this._qStop();
      else if (k === 'destino') q = this._qDestino();
      else if (k === 'cabecera') q = this._qCabecera();
      if (q && !qs.some(x => x.text === q.text)) qs.push(q);
    }
    return this._shuffle(qs);
  }

  // ¿Qué línea pasa por la parada X?
  _qStop() {
    const cands = this.stopIds.filter(id => this.stopLines.get(id).nums.size === 1);
    if (cands.length < 4) return null;
    const id = cands[Math.floor(Math.random() * cands.length)];
    const info = this.stopLines.get(id);
    const correct = [...info.nums][0];
    const opts = this._other(this.nums, correct);
    if (opts.length < 3) return null;
    const shuffled = this._shuffle([correct, ...opts]);
    return {
      text: `¿Qué línea pasa por la parada <b>${info.name}</b>?`,
      options: shuffled,
      correct: shuffled.indexOf(correct),
      explain: `La parada «${info.name}» la sirve la línea <b>${correct}</b>${this._ep(correct)}.`,
    };
  }

  // ¿Qué línea lleva a DESTINO?
  _qDestino() {
    // destino servido exactamente por una línea
    const destCount = new Map();
    for (const [n, eps] of this.endpoints) {
      for (const d of eps) destCount.set(d, (destCount.get(d) || 0) + 1);
    }
    const uniques = [...destCount.entries()].filter(([, c]) => c === 1).map(([d]) => d);
    if (uniques.length < 4) return null;
    const dest = uniques[Math.floor(Math.random() * uniques.length)];
    const correct = [...this.endpoints.entries()].find(([, eps]) => eps.includes(dest))[0];
    const opts = this._other(this.nums, correct);
    if (opts.length < 3) return null;
    const shuffled = this._shuffle([correct, ...opts]);
    return {
      text: `¿Qué línea tiene como destino <b>${dest}</b>?`,
      options: shuffled,
      correct: shuffled.indexOf(correct),
      explain: `La línea <b>${correct}</b> conecta ${this._ep(correct)}.`,
    };
  }

  // Cabeceras de la línea X
  _qCabecera() {
    const withEp = [...this.endpoints.entries()].filter(([, eps]) => eps.length >= 2);
    if (withEp.length < 5) return null;
    const [num, eps] = withEp[Math.floor(Math.random() * withEp.length)];
    const correct = eps.join(' ↔ ');
    const pool = withEp.map(([, e]) => e.join(' ↔ ')).filter(x => x !== correct);
    const opts = this._other(pool, correct);
    if (opts.length < 3) return null;
    const shuffled = this._shuffle([correct, ...opts]);
    return {
      text: `¿Cuáles son las cabeceras de la línea <b>${num}</b>?`,
      options: shuffled,
      correct: shuffled.indexOf(correct),
      explain: `La línea <b>${num}</b> va de <b>${eps[0]}</b> a <b>${eps[1] || eps[0]}</b>.`,
    };
  }

  _ep(num) {
    const eps = this.endpoints.get(num);
    return eps && eps.length ? ` (${eps.join(' ↔ ')})` : '';
  }
}

window.Quiz = Quiz;
