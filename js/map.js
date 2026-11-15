/* ═══════════════════════════════════════════════════════════
   map.js — Renderizado del plano vectorial de EMT + capas
   ═══════════════════════════════════════════════════════════ */

class MapView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.world = { w: 2069, h: 1417 };
    this.scale = 1; this.tx = 0; this.ty = 0;
    this.minScale = 0.15; this.maxScale = 8;
    this.map = null; this.lines = []; this.stops = [];
    this.overlay = null;          // {pts:[[x,y]…], color, width}
    this.overlayStops = [];       // [{x,y,name,served,order}]
    this.bus = null;              // {x,y,angle}
    this.corridor = null;         // [{x,y}] ruta resaltada (modo conducción)
    this.hoverStop = null;
    this.dirty = true;
    this._raf = null;
    this.onStopClick = null;
    this._bindEvents();
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  /* ── datos ── */
  async load(base = '') {
    const [map, lines, stops] = await Promise.all([
      fetch(base + 'data/map.json').then(r => r.json()),
      fetch(base + 'data/lines.json').then(r => r.json()),
      fetch(base + 'data/stops.json').then(r => r.json()),
    ]);
    this.map = map; this.lines = lines; this.stops = stops;
    this.mapW = map.w; this.mapH = map.h;
    this.world = { w: map.w, h: map.h };

    // el mundo se amplía para abarcar también la parte de red que queda
    // fuera de la página impresa (El Saler, El Palmar, Vinalesa…)
    let x0 = 0, y0 = 0, x1 = map.w, y1 = map.h;
    const acc = (x, y) => {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    };
    for (const l of lines) for (const v of l.variants)
      for (const p of v.pts) acc(p[0], p[1]);
    for (const s of stops) acc(s.x, s.y);
    const pad = 40;
    this.bounds = { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };

    this._buildOffscreen();
    this.fit();
    this.start();
    return { lines: lines.length, stops: stops.length, shapes: map.shapes.length };
  }

  _buildOffscreen() {
    // el plano base es idéntico en todas las vistas: se comparte
    if (MapView._cache && MapView._cacheKey === this.map.w + 'x' + this.map.h + ':' + this.map.shapes.length) {
      this.offscreen = MapView._cache;
      this.offScale = MapView._cacheDpr;
      return;
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const c = document.createElement('canvas');
    c.width = Math.round(this.world.w * dpr);
    c.height = Math.round(this.world.h * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, this.world.w, this.world.h);

    for (const s of this.map.shapes) {
      const hasFill = !!s.f, hasStroke = !!s.s;
      if (!hasFill && !hasStroke) continue;
      let p;
      try { p = new Path2D(s.d); } catch (e) { continue; }
      if (hasFill) { g.fillStyle = s.f; g.fill(p); }
      if (hasStroke) {
        g.strokeStyle = s.s;
        g.lineWidth = Math.max(s.w || 0.4, 0.25);
        g.stroke(p);
      }
    }
    MapView._cache = c;
    MapView._cacheDpr = dpr;
    MapView._cacheKey = this.map.w + 'x' + this.map.h + ':' + this.map.shapes.length;
    this.offscreen = c;
    this.offScale = dpr;
  }

  /* ── proyección ── */
  w2s(x, y) { return [x * this.scale + this.tx, y * this.scale + this.ty]; }
  s2w(sx, sy) { return [(sx - this.tx) / this.scale, (sy - this.ty) / this.scale]; }

  /** encaja un rectángulo (coords de mundo) en el visor */
  fitBox(x0, y0, x1, y1, pad = 0.97) {
    const { width: W, height: H } = this.canvas;
    const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
    const s = Math.min(W / w, H / h) * pad;
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, s));
    this.tx = (W - w * this.scale) / 2 - x0 * this.scale;
    this.ty = (H - h * this.scale) / 2 - y0 * this.scale;
    this.dirty = true;
  }

  /** encaja el plano impreso (por defecto) */
  fit() {
    this.fitBox(0, 0, this.mapW || this.world.w, this.mapH || this.world.h);
  }

  zoomAt(factor, sx, sy) {
    const ns = Math.max(this.minScale, Math.min(this.maxScale, this.scale * factor));
    const [wx, wy] = this.s2w(sx, sy);
    this.scale = ns;
    this.tx = sx - wx * ns;
    this.ty = sy - wy * ns;
    this.dirty = true;
  }

  centerOn(wx, wy, scale) {
    const { width: W, height: H } = this.canvas;
    if (scale) this.scale = scale;
    this.tx = W / 2 - wx * this.scale;
    this.ty = H / 2 - wy * this.scale;
    this.dirty = true;
  }

  /* ── eventos ── */
  /** coordenadas del puntero en píxeles device (las mismas que usa tx/ty) */
  _local(e) {
    const r = this.canvas.getBoundingClientRect();
    const d = this._dpr();
    return { x: (e.clientX - r.left) * d, y: (e.clientY - r.top) * d };
  }

  _bindEvents() {
    const c = this.canvas;
    let drag = null, pointers = new Map(), pinchDist = 0;

    c.addEventListener('pointerdown', e => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        drag = { x: e.clientX, y: e.clientY, moved: false, t: Date.now() };
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });

    c.addEventListener('pointermove', e => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0) {
          const r = c.getBoundingClientRect();
          const k = this._dpr();
          this.zoomAt(d / pinchDist,
            ((a.x + b.x) / 2 - r.left) * k,
            ((a.y + b.y) / 2 - r.top) * k);
        }
        pinchDist = d;
        return;
      }
      if (drag) {
        const k = this._dpr();
        const dx = (e.clientX - drag.x) * k, dy = (e.clientY - drag.y) * k;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        this.tx += dx; this.ty += dy;
        drag.x = e.clientX; drag.y = e.clientY;
        this.dirty = true;
      } else {
        this._mouse = this._local(e);
        this._updateHover();
      }
    });

    const end = e => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchDist = 0;
      if (drag && !drag.moved && Date.now() - drag.t < 600) {
        const p = this._local(e);
        this._click(p.x, p.y);
      }
      if (pointers.size === 0) drag = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { this._mouse = null; this.hoverStop = null; this.dirty = true; });

    c.addEventListener('wheel', e => {
      e.preventDefault();
      const p = this._local(e);
      this.zoomAt(e.deltaY < 0 ? 1.16 : 1 / 1.16, p.x, p.y);
    }, { passive: false });

    c.addEventListener('dblclick', e => {
      const p = this._local(e);
      const [wx, wy] = this.s2w(p.x, p.y);
      this.zoomAt(1.7, p.x, p.y);
      this.centerOn(wx, wy);
    });
  }

  _visibleStops() {
    const [x0, y0] = this.s2w(0, 0);
    const [x1, y1] = this.s2w(this.canvas.width, this.canvas.height);
    const pad = 30 / this.scale;
    return this.stops.filter(s => s.x > x0 - pad && s.x < x1 + pad && s.y > y0 - pad && s.y < y1 + pad);
  }

  _updateHover() {
    if (!this._mouse) return;
    const [wx, wy] = this.s2w(this._mouse.x, this._mouse.y);
    const rad = 14 / this.scale;
    let best = null, bd = rad;
    for (const s of this._visibleStops()) {
      const d = Math.hypot(s.x - wx, s.y - wy);
      if (d < bd) { bd = d; best = s; }
    }
    if (best !== this.hoverStop) { this.hoverStop = best; this.dirty = true; }
    this.canvas.style.cursor = best ? 'pointer' : 'grab';
  }

  _click(sx, sy) {
    const [wx, wy] = this.s2w(sx, sy);
    const rad = 16 / this.scale;
    let best = null, bd = rad;
    for (const s of this._visibleStops()) {
      const d = Math.hypot(s.x - wx, s.y - wy);
      if (d < bd) { bd = d; best = s; }
    }
    if (best && this.onStopClick) this.onStopClick(best);
  }

  /* ── bucle de render ── */
  start() {
    if (this._raf) return;
    const loop = () => {
      if (this.dirty) { this.draw(); this.dirty = false; }
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  draw() {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#071a31';
    ctx.fillRect(0, 0, W, H);
    if (!this.offscreen) return;

    // rejilla tenue en la zona fuera de la página impresa (la red GTFS
    // continúa hacia El Saler, El Palmar, Vinalesa… que el plano no cubre)
    const b = this.bounds;
    if (b) {
      ctx.save();
      ctx.translate(this.tx, this.ty);
      ctx.scale(this.scale, this.scale);
      ctx.strokeStyle = 'rgba(255,255,255,.05)';
      ctx.lineWidth = 1 / this.scale;
      ctx.beginPath();
      for (let x = Math.ceil(b.x0 / 100) * 100; x <= b.x1; x += 100) {
        ctx.moveTo(x, b.y0); ctx.lineTo(x, b.y1);
      }
      for (let y = Math.ceil(b.y0 / 100) * 100; y <= b.y1; y += 100) {
        ctx.moveTo(b.x0, y); ctx.lineTo(b.x1, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // plano base (tx/ty están en píxeles device, igual que el canvas)
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.offscreen,
      this.tx, this.ty,
      this.mapW * this.scale, this.mapH * this.scale);

    ctx.save();
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.scale, this.scale);

    // corredor de ruta (modo conducción)
    if (this.corridor && this.corridor.length > 1) {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,163,224,.20)';
      ctx.lineWidth = 34 / 1;
      this._path(this.corridor); ctx.stroke();
      ctx.strokeStyle = 'rgba(0,163,224,.55)';
      ctx.lineWidth = 14;
      this._path(this.corridor); ctx.stroke();
      ctx.setLineDash([16, 14]);
      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.lineWidth = 2.4;
      this._path(this.corridor); ctx.stroke();
      ctx.setLineDash([]);
    }

    // ruta superpuesta (vista mapa)
    if (this.overlay) {
      const o = this.overlay;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = (o.width || 7) + 4;
      this._path(o.pts); ctx.stroke();
      ctx.strokeStyle = o.color || '#e2001a';
      ctx.lineWidth = o.width || 7;
      this._path(o.pts); ctx.stroke();
    }

    // etiquetas (solo las visibles, dinámicas para que queden nítidas)
    this._drawLabels(ctx);

    // paradas
    this._drawStops(ctx);

    // autobús
    if (this.bus) this._drawBus(ctx);

    ctx.restore();
  }

  _dpr() { return this._dprVal || (this._dprVal = Math.min(window.devicePixelRatio || 1, 2)); }

  _path(pts) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  }

  _drawLabels(ctx) {
    const s = this.scale;
    // filtrar por escala: a poco zoom solo etiquetas grandes
    const minSize = s < 0.30 ? 11 : s < 0.45 ? 8.5 : s < 0.7 ? 6.5 : 4.5;
    const [x0, y0] = this.s2w(0, 0);
    const [x1, y1] = this.s2w(this.canvas.width, this.canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const l of this.map.labels) {
      if (l.s < minSize) continue;
      if (l.x < x0 - 60 || l.x > x1 + 60 || l.y < y0 - 30 || l.y > y1 + 30) continue;
      const fs = Math.max(l.s, 6.2 / s);
      ctx.font = `${l.s >= 9 ? '600' : '400'} ${fs}px 'Segoe UI',system-ui,sans-serif`;
      const col = l.c || '#1f1410';
      // halo blanco para legibilidad
      if (s > 0.35) {
        ctx.lineWidth = Math.max(1.8 / s, 0.75);
        ctx.strokeStyle = 'rgba(255,255,255,.92)';
        ctx.lineJoin = 'round';
        ctx.strokeText(l.t, l.x, l.y);
      }
      ctx.fillStyle = col;
      ctx.fillText(l.t, l.x, l.y);
    }
  }

  _drawStops(ctx) {
    const s = this.scale;
    const r = Math.max(3.4 / s, 2.2);
    const stops = this._visibleStops();

    for (const st of stops) {
      const ov = this.overlayStops.find(o => o.id === st.id);
      if (ov) continue; // ya dibujadas abajo con estado
      ctx.beginPath();
      ctx.arc(st.x, st.y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#ff8f00';
      ctx.fill();
      ctx.lineWidth = Math.max(1.2 / s, 0.7);
      ctx.strokeStyle = 'rgba(255,255,255,.95)';
      ctx.stroke();
    }

    // paradas de la ruta activa
    for (const o of this.overlayStops) {
      if (o.x < x0safe(this, 0) || o.x > x1safe(this) || o.y < y0safe(this) || o.y > y1safe(this)) continue;
      const done = o.served;
      const isNext = o.order === this.nextStopOrder;
      ctx.beginPath();
      ctx.arc(o.x, o.y, isNext ? r * 1.9 : r * 1.45, 0, Math.PI * 2);
      ctx.fillStyle = done ? '#12b76a' : isNext ? '#ffd600' : '#00a3e0';
      ctx.fill();
      ctx.lineWidth = Math.max(1.6 / s, 1);
      ctx.strokeStyle = done ? '#04231a' : '#ffffff';
      ctx.stroke();

      if (isNext || (s > 0.55 && o.name)) {
        const fs = Math.max(11 / s, 9);
        ctx.font = `700 ${fs}px 'Segoe UI',sans-serif`;
        const label = (isNext ? '▸ ' : '') + (o.name || '');
        ctx.textAlign = 'center';
        ctx.lineWidth = Math.max(3 / s, 2);
        ctx.strokeStyle = 'rgba(255,255,255,.95)';
        ctx.lineJoin = 'round';
        ctx.strokeText(label, o.x, o.y - r * 2.6);
        ctx.fillStyle = isNext ? '#8a5300' : '#0d2b4e';
        ctx.fillText(label, o.x, o.y - r * 2.6);
      }
    }
  }

  _drawBus(ctx) {
    const b = this.bus;
    const L = 26, W = 11;   // tamaño en unidades de mundo
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.angle);
    // sombra
    ctx.fillStyle = 'rgba(0,0,0,.28)';
    ctx.fillRect(-L / 2 + 1.4, -W / 2 + 1.8, L, W);
    // carrocería
    const grd = ctx.createLinearGradient(-L / 2, 0, L / 2, 0);
    grd.addColorStop(0, '#e2001a');
    grd.addColorStop(0.55, '#ff3b30');
    grd.addColorStop(1, '#b00014');
    ctx.fillStyle = grd;
    this._roundRect(ctx, -L / 2, -W / 2, L, W, 3);
    ctx.fill();
    ctx.lineWidth = 1.3; ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.stroke();
    // parabrisas
    ctx.fillStyle = '#bfe6ff';
    ctx.fillRect(L / 2 - 7.5, -W / 2 + 1.7, 4.4, W - 3.4);
    // franja blanca
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.fillRect(-L / 2 + 3, -1, L - 12, 2);
    // faros
    ctx.fillStyle = '#fff59d';
    ctx.fillRect(L / 2 - 1.6, -W / 2 + 1.2, 1.6, 2.4);
    ctx.fillRect(L / 2 - 1.6, W / 2 - 3.6, 1.6, 2.4);
    ctx.restore();

    // halo de dirección
    ctx.beginPath();
    ctx.arc(b.x, b.y, 20, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,163,224,.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this._dprVal = dpr;
    this.dirty = true;
  }
}

// helpers de límites visibles (usados en _drawStops)
function x0safe(m) { return m.s2w(0, 0)[0] - 40 / m.scale; }
function x1safe(m) { return m.s2w(m.canvas.width, 0)[0] + 40 / m.scale; }
function y0safe(m) { return m.s2w(0, 0)[1] - 40 / m.scale; }
function y1safe(m) { return m.s2w(0, m.canvas.height)[1] + 40 / m.scale; }

window.MapView = MapView;
