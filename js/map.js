/* ═══════════════════════════════════════════════════════════
   map.js — Renderizado del plano vectorial de EMT + capas
   ═══════════════════════════════════════════════════════════ */

const PAGE_W = 1811.5;

// Fuera de la página impresa (El Saler, Vinalesa, Alboraya…) el plano no tiene calles.
// Si hay conexión, ahí se dibuja de fondo un mapa base (OpenStreetMap) alineado
// con la misma transformación que usan las paradas. Poner a false para desactivarlo.
const OUTSIDE_TILES = true;
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
// transformación lon/lat -> coordenadas del plano. Es la que usan las paradas y los trazados guardados
// (ajuste por mínimos cuadrados sobre las 1153 paradas: residuo mediano 0,04 u; data/transform.json es el
// ajuste previo contra el PDF y queda ~40 u desplazado respecto a las paradas)
const TF = { a: 17324.839509939953, b: 79.08522013721928, c: 4184.4188125013425,
             d: 167.65328534851386, e: -21854.18438350673, f: 863405.1433757686 };
const ll2w = (lon, lat) => [TF.a * lon + TF.b * lat + TF.c, TF.d * lon + TF.e * lat + TF.f];
const w2ll = (x, y) => {
  const det = TF.a * TF.e - TF.b * TF.d, X = x - TF.c, Y = y - TF.f;
  return [(X * TF.e - TF.b * Y) / det, (TF.a * Y - TF.d * X) / det];
};
const tileLL = (z, x, y) => {
  const n = 2 ** z;
  return [x / n * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI];
};
const llTile = (z, lon, lat) => {
  const n = 2 ** z, r = lat * Math.PI / 180;
  return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)];
};

// recuadros de "ampliación" impresos encima del plano (x0,y0,x1,y1) y primer índice de su contenido
const INSETS = [[1275, 21, 1788, 374], [717, 620, 959, 795]];
const INSET_FROM = 14900;

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
    (MapView._views = MapView._views || []).push(this);
    this.focus = false;           // modo enfoque (conducción): solo ruta + calles colindantes
    this._corrSrc = null;
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

  /** rosa de los vientos y pictogramas junto al mar (borde derecho de la página) */
  _isCompass(s, i) {
    if (i < 7570 || i > 7810) return false;
    const m = /^M(-?[\d.]+),(-?[\d.]+)/.exec(s.d);
    return !!m && +m[1] > 1550 && +m[1] < PAGE_W + 5 && +m[2] > 850 && +m[2] < 1240;
  }

  /** contenido de los recuadros de ampliación (tapan el plano real) */
  _inInset(s, i) {
    if (i < INSET_FROM) return false;
    const n = s.d.match(/-?\d+\.?\d*/g);
    if (!n || n.length < 2) return false;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let k = 0; k + 1 < n.length; k += 2) {
      const x = +n[k], y = +n[k + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return INSETS.some(b => x0 >= b[0] - 2 && y0 >= b[1] - 2 && x1 <= b[2] + 2 && y1 <= b[3] + 2);
  }

  _labelInInset(l) {
    return l.x > PAGE_W || INSETS.some(b => l.x >= b[0] && l.x <= b[2] && l.y >= b[1] && l.y <= b[3]);
  }

  _isRed(c) {
    // rojo de las líneas de bus impresas en el plano (#e0040b, #dd161a, #da002f…)
    if (!c || c[0] !== '#' || c.length < 7) return false;
    const r = parseInt(c.substr(1, 2), 16), g = parseInt(c.substr(3, 2), 16), b = parseInt(c.substr(5, 2), 16);
    return r >= 0xc8 && g <= 0x40 && b <= 0x50;
  }

  _buildOffscreen() {
    // el plano base es idéntico en todas las vistas: se comparte
    // (en modo enfoque se dibuja una versión limpia, sin las líneas rojas)
    MapView._caches = MapView._caches || {};
    const key = this.map.w + 'x' + this.map.h + ':' + this.map.shapes.length + (this.focus ? ':clean' : '');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (MapView._caches[key]) {
      this.offscreen = MapView._caches[key];
      this.offScale = dpr;
      return;
    }
    const c = document.createElement('canvas');
    c.width = Math.round(this.world.w * dpr);
    c.height = Math.round(this.world.h * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, this.focus ? PAGE_W : this.world.w, this.world.h);
    if (this.focus) {
      // fuera la leyenda impresa a la derecha de la página (x > 1811)
      g.save();
      g.beginPath(); g.rect(0, 0, PAGE_W, this.world.h); g.clip();
    }

    for (let si = 0; si < this.map.shapes.length; si++) {
      const s = this.map.shapes[si];
      const hasFill = !!s.f, hasStroke = !!s.s;
      if (!hasFill && !hasStroke) continue;
      if (this.focus && (this._isRed(s.f) || this._isRed(s.s) || this._isCompass(s, si) || this._inInset(s, si))) continue;
      let p;
      try { p = new Path2D(s.d); } catch (e) { continue; }
      if (hasFill) { g.fillStyle = s.f; g.fill(p); }
      if (hasStroke) {
        g.strokeStyle = s.s;
        g.lineWidth = Math.max(s.w || 0.4, 0.25);
        g.stroke(p);
      }
    }
    if (this.focus) g.restore();
    MapView._caches[key] = c;
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
    this.fitBox(0, 0, this.focus ? PAGE_W : (this.mapW || this.world.w), this.mapH || this.world.h);
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
        if (drag.moved && this.onUserPan) this.onUserPan();
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

  /** en modo enfoque, las paradas que no son de la ruta solo se ven con mucho zoom (y sin ruta de conducción) */
  _showOtherStops() { return this.focus ? (!this.corridor && this.scale >= 1.8) : true; }

  _visibleStops() {
    const [x0, y0] = this.s2w(0, 0);
    const [x1, y1] = this.s2w(this.canvas.width, this.canvas.height);
    const pad = 30 / this.scale;
    if (!this._showOtherStops()) return [];
    return this.stops.filter(s => s.x > x0 - pad && s.x < x1 + pad && s.y > y0 - pad && s.y < y1 + pad);
  }

  /** paradas con las que se puede interactuar: las de la línea elegida + (con zoom) el resto */
  _hitStops() {
    const r = this._visibleStops();
    return this.overlayStops && this.overlayStops.length && !this.corridor ? r.concat(this.overlayStops) : r;
  }

  _updateHover() {
    if (!this._mouse) return;
    const [wx, wy] = this.s2w(this._mouse.x, this._mouse.y);
    const rad = 14 / this.scale;
    let best = null, bd = rad;
    for (const s of this._hitStops()) {
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
    for (const s of this._hitStops()) {
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
    const fp = this._focusPts();
    if (fp) {
      this._drawFocusBase(ctx);
    } else if (this.focus) {
      this._drawWorld(ctx);
    } else {
      ctx.drawImage(this.offscreen,
        this.tx, this.ty,
        this.mapW * this.scale, this.mapH * this.scale);
    }

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
      const lw = Math.max(o.width || 7, 5 / this.scale);
      ctx.strokeStyle = 'rgba(255,255,255,.95)';
      ctx.lineWidth = lw + Math.max(4, 3 / this.scale);
      this._path(o.pts); ctx.stroke();
      ctx.strokeStyle = o.color || '#e2001a';
      ctx.lineWidth = lw;
      this._path(o.pts); ctx.stroke();
      this._drawArrows(ctx, o.pts, lw);
    }

    // etiquetas (solo las visibles, dinámicas para que queden nítidas)
    this._drawLabels(ctx);

    // paradas
    this._drawStops(ctx);

    // autobús
    if (this.bus) this._drawBus(ctx);

    // atribución del mapa base (obligatoria)
    if (this.tilesShown) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const fs = 10 * this._dpr();
      ctx.font = `${fs}px 'Segoe UI',system-ui,sans-serif`;
      ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = 'rgba(255,255,255,.75)';
      ctx.fillText('© colaboradores de OpenStreetMap (fuera del plano impreso)', this.canvas.width - 8, this.canvas.height - 6);
      ctx.restore();
    }

    // nombre de la parada bajo el cursor
    if (this.hoverStop && this.hoverStop.name) {
      const h = this.hoverStop, fs = 13 / this.scale;
      ctx.font = `600 ${fs}px 'Segoe UI',system-ui,sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const w = ctx.measureText(h.name).width + 12 / this.scale, ph = 22 / this.scale;
      const by = h.y - 18 / this.scale;
      ctx.fillStyle = 'rgba(8,24,46,.94)';
      this._roundRect(ctx, h.x - w / 2, by - ph / 2, w, ph, 5 / this.scale);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(h.name, h.x, by);
    }

    ctx.restore();
  }

  _dpr() { return this._dprVal || (this._dprVal = Math.min(window.devicePixelRatio || 1, 2)); }

  _path(pts) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  }

  /** flechas de sentido a lo largo de la ruta (separadas ~110 px en pantalla) */
  _drawArrows(ctx, pts, lw) {
    const gap = 110 / this.scale, sz = Math.max(lw * 0.9, 5 / this.scale);
    const [x0, y0] = this.s2w(0, 0), [x1, y1] = this.s2w(this.canvas.width, this.canvas.height);
    let acc = gap / 2;
    ctx.fillStyle = '#fff';
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy);
      if (!d) continue;
      acc += d;
      if (acc < gap) continue;
      acc = 0;
      if (b[0] < x0 || b[0] > x1 || b[1] < y0 || b[1] > y1) continue;
      const ang = Math.atan2(dy, dx);
      ctx.save();
      ctx.translate(b[0], b[1]); ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(sz * 0.7, 0); ctx.lineTo(-sz * 0.5, -sz * 0.55); ctx.lineTo(-sz * 0.5, sz * 0.55);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  _drawLabels(ctx) {
    if (this.focus && this._focusPts()) return this._drawFocusLabels(ctx);
    const s = this.scale;
    // filtrar por escala: a poco zoom solo etiquetas grandes
    const minSize = s < 0.30 ? 11 : s < 0.45 ? 8.5 : s < 0.7 ? 6.5 : 4.5;
    const [x0, y0] = this.s2w(0, 0);
    const [x1, y1] = this.s2w(this.canvas.width, this.canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const l of this.map.labels) {
      if (l.s < minSize) continue;
      if (this.focus) {
        const lc = (l.c || '').toLowerCase();
        if (lc === '#ffffff' || this._isRed(lc) || l.x > PAGE_W || /^[\d\s\-\/,.]+$/.test(l.t) || l.t.length < 4) continue;
      }
      if (l.x < x0 - 60 || l.x > x1 + 60 || l.y < y0 - 30 || l.y > y1 + 30) continue;
      if (this.focus && this._labelInInset(l)) continue;
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

  /* ── modo enfoque (conducción) ── */
  /** mapa base (si hay) + plano impreso, en coordenadas de pantalla de g */
  _drawWorld(g) {
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    this.tilesShown = OUTSIDE_TILES && this._drawTiles(g);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(this.offscreen, this.tx, this.ty, this.mapW * this.scale, this.mapH * this.scale);
    g.restore();
  }

  /** teselas del mapa base, solo fuera de la página impresa. Devuelve true si dibujó alguna */
  _drawTiles(g) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
    const W = this.canvas.width, H = this.canvas.height;
    const [wx0, wy0] = this.s2w(0, 0), [wx1, wy1] = this.s2w(W, H);
    // ¿hay algo fuera de la página a la vista?
    if (wx0 >= 0 && wy0 >= 0 && wx1 <= PAGE_W && wy1 <= this.mapH) return false;
    let z = Math.round(Math.log2(24414 * this.scale));
    z = Math.max(9, Math.min(17, z));
    const corners = [[wx0, wy0], [wx1, wy0], [wx0, wy1], [wx1, wy1]].map(p => w2ll(p[0], p[1]));
    let t0, t1;
    for (;;) {
      const lons = corners.map(c => c[0]), lats = corners.map(c => c[1]);
      t0 = llTile(z, Math.min(...lons), Math.max(...lats));
      t1 = llTile(z, Math.max(...lons), Math.min(...lats));
      if ((t1[0] - t0[0] + 1) * (t1[1] - t0[1] + 1) <= 64 || z <= 9) break;
      z--;
    }
    if ((t1[0] - t0[0] + 1) * (t1[1] - t0[1] + 1) > 120) return false;
    MapView._tiles = MapView._tiles || new Map();
    g.save();
    g.translate(this.tx, this.ty); g.scale(this.scale, this.scale);
    g.beginPath();
    g.rect(wx0 - 1e4, wy0 - 1e4, (wx1 - wx0) + 2e4, (wy1 - wy0) + 2e4);
    g.rect(0, 0, PAGE_W, this.mapH);
    g.clip('evenodd');
    g.imageSmoothingEnabled = true;
    try { g.filter = 'grayscale(.75) brightness(1.06)'; } catch (e) {}
    let drawn = 0;
    for (let ty = t0[1]; ty <= t1[1]; ty++) for (let tx = t0[0]; tx <= t1[0]; tx++) {
      const key = z + '/' + tx + '/' + ty;
      let t = MapView._tiles.get(key);
      if (!t) {
        t = { img: new Image(), ok: false };
        t.img.onload = () => { t.ok = true; this.dirty = true; if (MapView._views) MapView._views.forEach(v => v.dirty = true); };
        t.img.onerror = () => { t.bad = true; };
        t.img.src = TILE_URL.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
        MapView._tiles.set(key, t);
        if (MapView._tiles.size > 600) MapView._tiles.delete(MapView._tiles.keys().next().value);
      }
      if (!t.ok) continue;
      const p00 = ll2w(...tileLL(z, tx, ty)), p10 = ll2w(...tileLL(z, tx + 1, ty)), p01 = ll2w(...tileLL(z, tx, ty + 1));
      g.save();
      g.transform((p10[0] - p00[0]) / 256, (p10[1] - p00[1]) / 256, (p01[0] - p00[0]) / 256, (p01[1] - p00[1]) / 256, p00[0], p00[1]);
      g.drawImage(t.img, 0, 0, 256.6, 256.6);
      g.restore();
      drawn++;
    }
    g.restore();
    return drawn > 0;
  }

  /** puntos de la ruta sobre la que se enfoca (conducción o línea elegida) */
  _focusPts() {
    if (!this.focus) return null;
    const p = (this.corridor && this.corridor.length > 1) ? this.corridor
      : (this.overlay && this.overlay.pts && this.overlay.pts.length > 1) ? this.overlay.pts : null;
    return p;
  }

  /** radio (unidades de mundo) alrededor de la ruta que se ve nítido */
  _focusR() { return Math.max(100, 190 / this.scale); }

  /** plano atenuado + franja nítida alrededor de la ruta */
  _drawFocusBase(ctx) {
    const W = this.canvas.width, H = this.canvas.height;
    ctx.save();
    ctx.globalAlpha = 0.22;
    this._drawWorld(ctx);
    ctx.restore();
    if (!this._mask || this._mask.width !== W || this._mask.height !== H) {
      this._mask = document.createElement('canvas');
      this._mask.width = W; this._mask.height = H;
    }
    const m = this._mask.getContext('2d');
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = 'source-over';
    m.clearRect(0, 0, W, H);
    m.setTransform(this.scale, 0, 0, this.scale, this.tx, this.ty);
    m.lineJoin = 'round'; m.lineCap = 'round';
    m.strokeStyle = '#fff';
    m.lineWidth = this._focusR() * 2;
    m.beginPath();
    const pts = this._focusPts();
    const [x0, y0] = this.s2w(0, 0), [x1, y1] = this.s2w(W, H);
    const pad = this._focusR() * 2;
    let pen = false;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const vis = p[0] > x0 - pad && p[0] < x1 + pad && p[1] > y0 - pad && p[1] < y1 + pad;
      if (vis) { if (!pen) { m.moveTo(p[0], p[1]); pen = true; } else m.lineTo(p[0], p[1]); }
      else pen = false;
    }
    m.stroke();
    // mundo completo (mapa base + plano) en un lienzo temporal y recortado con la franja
    if (!this._tmp || this._tmp.width !== W || this._tmp.height !== H) {
      this._tmp = document.createElement('canvas');
      this._tmp.width = W; this._tmp.height = H;
    }
    const tg = this._tmp.getContext('2d');
    tg.setTransform(1, 0, 0, 1, 0, 0);
    tg.globalCompositeOperation = 'source-over';
    tg.clearRect(0, 0, W, H);
    this._drawWorld(tg);
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = 'source-in';
    m.drawImage(this._tmp, 0, 0);
    ctx.drawImage(this._mask, 0, 0);
  }

  /** etiquetas candidatas: calles cerca de la ruta (se calcula una vez por ruta) */
  _buildFocusLabels() {
    const pts = this._focusPts(), CELL = 120, LIM = 120;
    const grid = new Map();
    for (const p of pts) {
      const k = Math.floor(p[0] / CELL) + ',' + Math.floor(p[1] / CELL);
      let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(p);
    }
    const out = [];
    for (const l of this.map.labels) {
      const c = (l.c || '').toLowerCase();
      // fuera números de línea (blancos / rojos / solo cifras) y textos diminutos
      if (c === '#ffffff' || this._isRed(c) || /^[\d\s\-\/,.]+$/.test(l.t) || l.t.length < 4) continue;
      const cx = Math.floor(l.x / CELL), cy = Math.floor(l.y / CELL);
      let bd = Infinity;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const a = grid.get((cx + i) + ',' + (cy + j)); if (!a) continue;
        for (const p of a) { const d = Math.hypot(p[0] - l.x, p[1] - l.y); if (d < bd) bd = d; }
      }
      if (bd <= LIM && !this._labelInInset(l)) out.push({ ...l, d: bd });
    }
    out.sort((a, b) => a.d - b.d);   // primero las de la propia ruta
    return out;
  }

  _drawFocusLabels(ctx) {
    const fp = this._focusPts();
    if (this._corrSrc !== fp) { this._focusLabels = this._buildFocusLabels(); this._corrSrc = fp; }
    const s = this.scale;
    const [x0, y0] = this.s2w(0, 0), [x1, y1] = this.s2w(this.canvas.width, this.canvas.height);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    const placed = [];
    for (const l of this._focusLabels) {
      if (l.x < x0 - 60 || l.x > x1 + 60 || l.y < y0 - 30 || l.y > y1 + 30) continue;
      const onRoute = l.d <= 38;
      const fs = Math.max(l.s * (onRoute ? 1.15 : 1), 11 / s);
      ctx.font = `${onRoute ? 700 : 500} ${fs}px 'Segoe UI',system-ui,sans-serif`;
      const w = ctx.measureText(l.t).width, h = fs;
      let hit = false;
      for (const b of placed) {
        if (Math.abs(b.x - l.x) < (b.w + w) / 2 + 1 && Math.abs(b.y - l.y) < (b.h + h) / 2) { hit = true; break; }
      }
      if (hit) continue;
      placed.push({ x: l.x, y: l.y, w, h });
      ctx.lineWidth = Math.max(3 / s, 1.4);
      ctx.strokeStyle = 'rgba(255,255,255,.96)';
      ctx.strokeText(l.t, l.x, l.y);
      ctx.fillStyle = onRoute ? '#0a1f3d' : '#4a5563';
      ctx.fillText(l.t, l.x, l.y);
    }
  }

  _drawStops(ctx) {
    const s = this.scale;
    const r = Math.max(3.4 / s, 2.2);
    const stops = this._visibleStops();

    for (const st of (this._showOtherStops() ? stops : [])) {
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

      const isEnd = o.order === 0 || o.order === this.overlayStops.length - 1;
      if (isNext || isEnd || (s > 1.3 && o.name)) {
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

MapView.OUTSIDE_TILES = OUTSIDE_TILES;
window.MapView = MapView;
