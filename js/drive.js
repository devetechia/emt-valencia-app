/* ═══════════════════════════════════════════════════════════
   drive.js — Simulador de conducción con validación de ruta
   ═══════════════════════════════════════════════════════════ */

class DriveSim {
  constructor(canvas) {
    this.view = new MapView(canvas);
    this.view.focus = true;   // solo ruta + calles colindantes
    this.canvas = canvas;
    this.running = false;
    this.keys = {};
    this.mouse = { throttle: 0, brake: 0, steer: 0, active: false };
    this.onHud = null;
    this.onMessage = null;
    this.onFinish = null;
    this._last = 0;
    this._warned = 0;
    this.auto = false;       // recorrido automático (piloto automático)
    this.paused = false;
    this.autoSpeed = 1;
    this.freeLook = false;   // true = el usuario ha movido el mapa con el ratón
    this.view.onUserPan = () => { if (this.running) this.freeLook = true; };
    this._bind();
  }

  async load(base) {
    await this.view.load(base);
    this.view.start();
  }

  /* ── controles ── */
  _bind() {
    window.addEventListener('keydown', e => {
      if (!this.running) return;
      const k = e.key.toLowerCase();
      if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
      this.keys[k] = true;
      if (k === 'escape') this.stop();
      if (k === 'c') this.freeLook = false;
      if (this.auto) {
        if (k === 'p' || k === ' ') this.setPaused(!this.paused);
        if (k === '1') this.setAutoSpeed(1);
        if (k === '2') this.setAutoSpeed(2);
        if (k === '3') this.setAutoSpeed(4);
      }
    });
    window.addEventListener('keyup', e => { this.keys[e.key.toLowerCase()] = false; });
    window.addEventListener('blur', () => { this.keys = {}; this._resetMouse(); });

    const c = this.canvas;
    c.addEventListener('contextmenu', e => e.preventDefault());
    c.addEventListener('pointerdown', e => {
      if (!this.running) return;
      if (this.auto) return;
      if (e.pointerType === 'mouse') return;   // PC: el ratón solo sirve para mover el mapa
      c.setPointerCapture(e.pointerId);
      if (e.button === 0) this.mouse.throttle = 1;
      if (e.button === 2) this.mouse.brake = 1;
      this.mouse.active = true;
      this._mouseMove(e);
    });
    c.addEventListener('pointermove', e => { if (this.mouse.active && e.pointerType !== 'mouse') this._mouseMove(e); });
    const up = () => this._resetMouse();
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
  }

  _mouseMove(e) {
    const r = this.canvas.getBoundingClientRect();
    const cx = r.width / 2;
    const dx = (e.clientX - r.left - cx) / cx;
    this.mouse.steer = Math.max(-1, Math.min(1, dx * 1.7));
  }

  _resetMouse() { this.mouse = { throttle: 0, brake: 0, steer: 0, active: false }; }

  /* ── ciclo de vida ── */
  start(line, variantIdx, opts = {}) {
    this.auto = !!opts.auto;
    this.paused = false;
    this.autoSpeed = 1;
    this._dwell = 0;
    this._lastServed = 0;
    this.line = line;
    this.variant = line.variants[variantIdx] || line.variants[0];
    const pts = this.variant.pts;
    const stops = this.variant.stops;

    if (!pts || pts.length < 3) { this.onMessage?.('err', 'Esta línea no tiene trazado válido.'); return false; }

    // estado inicial: primer punto del trazado, orientado hacia el segundo
    this.route = pts;
    this.stops = stops.map((s, i) => ({ ...s, order: i, served: false, ri: 0 }));

    // precalcular, para cada parada, el índice del trazado más cercano
    for (const s of this.stops) {
      let bd = Infinity, bi = 0;
      for (let i = 0; i < pts.length; i++) {
        const dd = Math.hypot(pts[i][0] - s.x, pts[i][1] - s.y);
        if (dd < bd) { bd = dd; bi = i; }
      }
      s.ri = bi;
      s.rd = bd;
    }

    // longitud acumulada del trazado (para el piloto automático)
    this._cum = [0];
    for (let i = 1; i < pts.length; i++) this._cum.push(this._cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    this._s = 0; this._seg = 0;

    this.x = pts[0][0]; this.y = pts[0][1];
    this.angle = Math.atan2(pts[1][1] - this.y, pts[1][0] - this.x);
    this.speed = 0;
    this.progress = 0;
    this.nextStop = 0;
    this.deviation = 0;
    this._devWasOff = false;
    this._offTime = 0;
    this._devCounted = false;
    this._servedCount = 0;
    this._warned = 0;
    this._elapsed = 0;

    this.view.overlay = null;
    this.view.corridor = pts;
    this.view.overlayStops = this.stops;
    this.view.nextStopOrder = 0;
    this.view.bus = { x: this.x, y: this.y, angle: this.angle };
    this.freeLook = false;
    this.view.centerOn(this.x, this.y, 2.4);
    this.view.dirty = true;

    this.running = true;
    this._last = performance.now();
    this._loop();
    this.onMessage?.('good', this.auto
      ? 'Recorrido automático: el bus hace el trayecto solo. P pausa · 1/2/3 velocidad · arrastra para mirar el mapa.'
      : '¡Adelante! Sigue el trazado y para en cada parada.');
    this._hud();
    return true;
  }

  stop() {
    this.running = false;
    this.auto = false;
    cancelAnimationFrame(this._raf);
    this.view.bus = null;
    this.view.corridor = null;
    this.view.overlayStops = [];
    this.view.nextStopOrder = -1;
    this.view.dirty = true;
    this._resetMouse();
    this.keys = {};
  }

  _loop() {
    if (!this.running) return;
    const now = performance.now();
    const dt = Math.min((now - this._last) / 1000, 0.05);
    this._last = now;
    this._step(dt);
    this._render();
    this._raf = requestAnimationFrame(() => this._loop());
  }

  setPaused(p) { this.paused = !!p; this._hud(); }
  setAutoSpeed(m) { this.autoSpeed = m; this._hud(); }

  /** punto y rumbo sobre el trazado a una distancia s (unidades de mundo) desde el inicio */
  _pointAt(s) {
    const R = this.route, C = this._cum, n = R.length;
    s = Math.max(0, Math.min(C[n - 1], s));
    let i = this._seg || 0;
    if (C[i] > s) i = 0;
    while (i < n - 2 && C[i + 1] < s) i++;
    this._seg = i;
    const len = C[i + 1] - C[i] || 1, t = Math.max(0, Math.min(1, (s - C[i]) / len));
    const ax = R[i][0], ay = R[i][1], bx = R[i + 1][0], by = R[i + 1][1];
    return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, ang: Math.atan2(by - ay, bx - ax) };
  }

  /** piloto automático: el bus recorre el trazado "sobre raíles", frena en curvas y para en cada parada */
  _autoMove(dt) {
    const R = this.route, C = this._cum;
    let hold = false;
    if (this._dwell > 0) { this._dwell -= dt; hold = true; }
    else if (this._servedCount !== this._lastServed) {
      this._lastServed = this._servedCount;
      this._dwell = 1.6; hold = true;
    }
    const here = this._pointAt(this._s), ahead = this._pointAt(this._s + 35);
    let err = ahead.ang - here.ang;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    let target = 95 * (1 - 0.8 * Math.min(1, Math.abs(err) / 0.9));
    target = Math.max(target, 16);
    const st = this.stops[this.nextStop];
    if (st) {
      const d = C[st.ri] - this._s;
      if (d < 140 && d > -30) target = Math.min(target, 10 + Math.max(d, 0) * 0.5);
    }
    if (hold) this.speed = Math.max(0, this.speed - 120 * dt);
    else if (this.speed < target) this.speed = Math.min(target, this.speed + 68 * dt);
    else this.speed = Math.max(target, this.speed - 120 * dt);
    this._s = Math.min(C[R.length - 1], this._s + this.speed * dt);
    const p = this._pointAt(this._s);
    this.x = p.x; this.y = p.y;
    let da = p.ang - this.angle;
    while (da > Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    this.angle += da * Math.min(1, 7 * dt);
  }

  _step(dt) {
    if (!this.auto) return this._stepOnce(dt);
    if (this.paused) { this._hud(); return; }
    const total = dt * this.autoSpeed;
    const n = Math.max(1, Math.ceil(total / 0.03));
    for (let i = 0; i < n && this.running; i++) this._stepOnce(total / n);
  }

  _stepOnce(dt) {
    this._elapsed += dt;
    if (this.auto) { this._autoMove(dt); this._validate(dt); this._hud(); return; }
    const k = this.keys;
    const keyThrottle = (k['arrowup'] || k['w'] || k[' ']) ? 1 : 0;
    const keyBrake = (k['arrowdown'] || k['s']) ? 1 : 0;
    const keySteer = ((k['arrowright'] || k['d']) ? 1 : 0) - ((k['arrowleft'] || k['a']) ? 1 : 0);

    if (!this.auto && (keyThrottle || keyBrake || keySteer)) this.freeLook = false;
    let throttle = Math.max(keyThrottle, this.mouse.throttle);
    let brake = Math.max(keyBrake, this.mouse.brake);
    let steer = keySteer || this.mouse.steer;

    const MAX = 115, REV = -34, ACC = 68, BRK = 120, FRIC = 1.55;

    if (throttle && this.speed < MAX) this.speed += ACC * dt;
    if (brake) {
      if (this.speed > 0) this.speed -= BRK * dt;
      else if (this.speed > REV) this.speed -= ACC * 0.55 * dt;
    }
    if (!throttle && !brake) {
      const f = FRIC * dt;
      if (Math.abs(this.speed) <= f) this.speed = 0;
      else this.speed -= Math.sign(this.speed) * f;
    }
    this.speed = Math.max(REV, Math.min(MAX, this.speed));

    // giro proporcional a la velocidad
    const grip = Math.min(1, Math.abs(this.speed) / 42);
    this.angle += steer * 1.75 * grip * dt * Math.sign(this.speed || 1);

    this.x += Math.cos(this.angle) * this.speed * dt;
    this.y += Math.sin(this.angle) * this.speed * dt;

    // mantenerse dentro del mundo (plano + extensiones fuera de la página)
    const b = this.view.bounds || { x0: 6, y0: 6, x1: this.view.world.w - 6, y1: this.view.world.h - 6 };
    this.x = Math.max(b.x0, Math.min(b.x1, this.x));
    this.y = Math.max(b.y0, Math.min(b.y1, this.y));

    this._validate(dt);
    this._hud();
  }

  /* ── validación de ruta ── */
  _nearestOnRoute() {
    const R = this.route, n = R.length;
    const from = Math.max(0, this.progress - 45);
    const to = Math.min(n - 1, this.progress + 90);
    let bd = Infinity, bi = this.progress;
    for (let i = from; i <= to; i++) {
      const d = Math.hypot(R[i][0] - this.x, R[i][1] - this.y);
      if (d < bd) { bd = d; bi = i; }
    }
    // si nos hemos alejado mucho, ampliar búsqueda global
    if (bd > 120) {
      for (let i = 0; i < n; i += 2) {
        const d = Math.hypot(R[i][0] - this.x, R[i][1] - this.y);
        if (d < bd) { bd = d; bi = i; }
      }
    }
    return { dist: bd, idx: bi };
  }

  _validate(dt = 1 / 60) {
    const TOL = 46;          // tolerancia de desvío (unidades de mundo)
    const near = this._nearestOnRoute();
    this.progress = near.idx;
    this.lastDist = near.dist;

    // desvío: solo se contabiliza si se mantiene fuera del trazado un rato
    // en recorrido automático el bus va por el trazado: no hay desvíos (hay tramos del GTFS con puntos muy separados)
    const off = !this.auto && near.dist > TOL;
    this._offTime = off ? (this._offTime || 0) + dt : 0;
    if (!off && this._devWasOff) {
      this.onMessage?.('good', '✓ Ya estás de vuelta en el recorrido.');
    }
    if (this._offTime > 0.55 && !this._devCounted) {
      this.deviation++;
      this._devCounted = true;
      this.onMessage?.('err', `⚠ Desvío del recorrido (${Math.round(near.dist)} u). ¡Vuelve al trazado!`);
    }
    if (!off) this._devCounted = false;
    this._devWasOff = off;

    // paradas: se sirven cuando el autobús avanza por el trazado hasta su punto
    // (con respaldo por proximidad, para la última parada al final del trazado)
    if (!off) {
      while (this.nextStop < this.stops.length) {
        const s = this.stops[this.nextStop];
        const reached = this.progress >= s.ri ||
          Math.hypot(s.x - this.x, s.y - this.y) <= 60;
        if (!reached) break;
        s.served = true;
        this.nextStop++;
        this._servedCount++;
        this.view.nextStopOrder = this.nextStop;
        const left = this.stops.length - this.nextStop;
        if (left === 0) this._finish(true);
        else this.onMessage?.('good', `✓ ${s.name} — quedan ${left} parada${left > 1 ? 's' : ''}`);
      }
    }

    // aviso si se pasa una parada posterior sin haber hecho la que toca
    if (this.nextStop < this.stops.length && !off) {
      for (let i = this.nextStop + 1; i < Math.min(this.stops.length, this.nextStop + 5); i++) {
        const s = this.stops[i];
        if (this.progress >= s.ri) {
          if (this._warned !== i) {
            this._warned = i;
            this.onMessage?.('warn', `✕ Has pasado «${s.name}» sin parar en «${this.stops[this.nextStop].name}». Orden incorrecto.`);
          }
          break;
        }
      }
    } else {
      this._warned = 0;
    }

    // progreso
    this.view.bus = { x: this.x, y: this.y, angle: this.angle };
    this.view.dirty = true;
  }

  _finish(ok) {
    this.running = false;
    cancelAnimationFrame(this._raf);
    const dev = this.deviation;
    const mins = Math.floor(this._elapsed / 60), secs = Math.floor(this._elapsed % 60);
    const txt = ok
      ? `¡Recorrido completado! ${this.stops.length} paradas · ${dev} desvío${dev === 1 ? '' : 's'} · ${mins}:${String(secs).padStart(2, '0')}`
      : 'Recorrido terminado';
    this.onFinish?.(ok, { deviations: dev, time: this._elapsed, stops: this.stops.length });
    setTimeout(() => {
      this.stop();
      this.onMessage?.(ok ? 'good' : 'err', txt);
    }, 900);
  }

  _render() {
    // encuadre suave tras el autobús
    const v = this.view;
    if (this.freeLook) { v.dirty = true; return; }
    const { width: W, height: H } = this.canvas;
    const targetTx = W / 2 - this.x * v.scale;
    const targetTy = H / 2 - this.y * v.scale;
    v.tx += (targetTx - v.tx) * 0.10;
    v.ty += (targetTy - v.ty) * 0.10;
    v.dirty = true;
  }

  _hud() {
    const left = this.stops.length - this.nextStop;
    const next = this.stops[this.nextStop];
    const pct = this.stops.length ? (this._servedCount / this.stops.length) * 100 : 0;
    this.onHud?.({
      line: `${this.line.n} · ${this.line.name}`,
      next: next ? next.name : '— fin —',
      stops: `${this._servedCount} / ${this.stops.length}`,
      deviations: this.deviation,
      speed: Math.abs(Math.round(this.speed * 0.42)),   // aprox km/h
      pct,
      offRoute: this._devWasOff,
      auto: this.auto, paused: this.paused, autoSpeed: this.autoSpeed,
    });
  }
}

window.DriveSim = DriveSim;
