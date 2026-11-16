/* ═══════════════════════════════════════════════════════════
   app.js — Arranque, navegación y cableado de vistas
   ═══════════════════════════════════════════════════════════ */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const state = {
  lines: [], stops: [], quiz: null,
  mapView: null, drive: null, trace: null,
  currentLine: null, currentVariant: 0,
  quizQs: [], quizIdx: 0, quizRight: 0,
};

/* ── toast ── */
let toastT;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ── arranque ── */
async function boot() {
  try {
    const v = new MapView($('#mapCanvas'));
    v.focus = true;   // plano limpio: solo la línea elegida y lo esencial
    state.mapView = v;
    const info = await v.load('');
    state.lines = info.lines ? v.lines : [];
    state.stops = v.stops;
    v.onStopClick = showStopCard;

    state.drive = new DriveSim($('#driveCanvas'));
    await state.drive.load('');
    wireDrive();

    state.trace = new MapView($('#traceCanvas'));
    state.trace.focus = true;
    await state.trace.load('');

    // versión de los datos (la escribe scripts/actualizar_datos.py)
    fetch('data/meta.json').then(r => r.ok ? r.json() : null).then(m => {
      if (!m) return;
      const f = d => d && d.length === 8 ? `${d.slice(6)}-${d.slice(4, 6)}-${d.slice(0, 4)}` : d;
      $('#dataInfo').textContent = `Datos: GTFS oficial de EMT · versión ${m.feed_version} · vigente del ${f(m.start)} al ${f(m.end)}. El plano base es de 2023 (solo orientativo).`;
    }).catch(() => {});

    state.quiz = new Quiz(state.lines);
    buildLineList();
    buildDriveSelects();
    buildTraceSelects();
    wireTrace();
    wireUI();
    toast(`Datos cargados · ${v.lines.length} líneas · ${v.stops.length} paradas`);
  } catch (e) {
    console.error(e);
    toast('Error cargando los datos: ' + e.message, 6000);
  }
}

/* ════════ VISTA MAPA ════════ */
function buildLineList(filter = '') {
  const box = $('#lineList');
  const f = filter.trim().toLowerCase();
  const rows = state.lines.filter(l =>
    !f || l.n.toLowerCase().includes(f) || (l.name || '').toLowerCase().includes(f));

  box.innerHTML = rows.map(l => `
    <div class="line-row" data-id="${l.id}">
      <span class="badge" style="background:${l.color}">${l.n}</span>
      <span class="meta">
        <span class="nm">${esc(l.name || '')}</span>
        <span class="sub">${l.variants.length} sentido${l.variants.length > 1 ? 's' : ''} · ${l.variants[0].stops.length} paradas</span>
      </span>
    </div>`).join('') || `<p class="hintbar">Sin resultados para «${esc(filter)}».</p>`;

  box.querySelectorAll('.line-row').forEach(r => {
    r.addEventListener('click', () => selectLine(r.dataset.id, r));
  });
}

// Líneas que EMT rediseña en noviembre de 2026 (anuncio del Ayuntamiento, 28-09-2026): el GTFS vigente aún trae las antiguas
const REDESIGN = { '8': '58', '10': '50', '11': '51' };

function selectLine(id, row) {
  const l = state.lines.find(x => String(x.id) === String(id));
  if (!l) return;
  state.currentLine = l;
  state.currentVariant = 0;

  $$('.line-row').forEach(r => r.classList.toggle('sel', r === row));
  showLineDetail(l);

  applyOverlay(l, 0);
  fitToPoints(l.variants[0].pts);
  $('#stopCard').classList.add('hidden');
}

function applyOverlay(l, vi) {
  const v = l.variants[vi] || l.variants[0];
  state.mapView.overlay = { pts: v.pts, color: l.color, width: 7 };
  state.mapView.overlayStops = v.stops.map((s, i) => ({ ...s, order: i, served: false }));
  state.mapView.nextStopOrder = -1;
  state.mapView.dirty = true;
}

function fitToPoints(pts) {
  if (!pts || !pts.length) return;
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const v = state.mapView;
  // La parte de la ruta que cae fuera de la página impresa (El Saler,
  // El Palmar, Vinalesa…) no tiene calles detrás: se recorta el encuadre
  // al plano ampliado para que el mapa no se encoja hasta desaparecer.
  const pad = Math.max(v.mapW, v.mapH) * 0.15;
  // con mapa base fuera del plano se encuadra la ruta completa
  if (!MapView.OUTSIDE_TILES || navigator.onLine === false) {
    x0 = Math.max(x0, -pad); y0 = Math.max(y0, -pad);
    x1 = Math.min(x1, v.mapW + pad); y1 = Math.min(y1, v.mapH + pad);
  }
  if (x1 - x0 < 40 || y1 - y0 < 40) { v.fit(); return; }
  v.fitBox(x0, y0, x1, y1, 0.93);
}

function showLineDetail(l) {
  $('#lineList').classList.add('hidden');
  const d = $('#lineDetail');
  d.classList.remove('hidden');

  const variants = l.variants.map((v, i) => `
    <button class="vtab ${i === 0 ? 'active' : ''}" data-v="${i}">
      Sentido ${i + 1} · ${v.stops.length} paradas
    </button>`).join('');

  $('#detailBody').innerHTML = `
    <div class="detail-title">
      <span class="badge" style="background:${l.color}">${l.n}</span>
      <h3>${esc(l.name || '')}</h3>
    </div>
    ${REDESIGN[l.n] ? `<div class="hintbar warn-note">⚠ EMT rediseña esta línea en noviembre de 2026 y pasará a ser la <b>${REDESIGN[l.n]}</b>. Aquí se muestra el recorrido del feed vigente (hasta el 09-12-2026); confírmalo con el material oficial.</div>` : ''}
    <div class="variant-tabs">${variants}</div>
    <ul class="stops" id="stopList"></ul>
    <div class="hintbar">Toca una parada del mapa para ver qué otras líneas la sirven.
      En <b>Conducción</b> puedes recorrer esta línea al volante.</div>`;

  renderStops(l, 0);

  d.querySelectorAll('.vtab').forEach(b => b.addEventListener('click', () => {
    d.querySelectorAll('.vtab').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    const vi = +b.dataset.v;
    state.currentVariant = vi;
    applyOverlay(l, vi);
    fitToPoints(l.variants[vi].pts);
    renderStops(l, vi);
  }));
}

function renderStops(l, vi) {
  const v = l.variants[vi] || l.variants[0];
  $('#stopList').innerHTML = v.stops.map((s, i) => `
    <li data-x="${s.x}" data-y="${s.y}">
      <span class="idx">${i + 1}</span>
      <span class="dot"></span>
      <span>${esc(s.name)}</span>
    </li>`).join('');

  $('#stopList').querySelectorAll('li').forEach(li => {
    li.addEventListener('click', () => {
      state.mapView.centerOn(+li.dataset.x, +li.dataset.y, Math.max(state.mapView.scale, 2.2));
      li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  });
}

function showStopCard(stop) {
  const lines = state.lines.filter(l =>
    l.variants.some(v => v.stops.some(s => s.id === stop.id)));
  const card = $('#stopCard');
  card.innerHTML = `
    <button class="close" aria-label="Cerrar">✕</button>
    <h4>${esc(stop.name)}</h4>
    <div class="mini" style="font-size:12px;color:var(--muted)">
      ${lines.length} línea${lines.length !== 1 ? 's' : ''} con parada aquí
    </div>
    <div class="chips">
      ${lines.map(l => `<span class="chip" data-id="${l.id}" style="background:${l.color}">${l.n}</span>`).join('')}
    </div>`;
  card.classList.remove('hidden');
  card.querySelector('.close').onclick = () => card.classList.add('hidden');
  card.querySelectorAll('.chip').forEach(c =>
    c.addEventListener('click', () => {
      const row = $(`.line-row[data-id="${c.dataset.id}"]`);
      if (row) { row.click(); row.scrollIntoView({ block: 'center' }); }
      else {
        $('#lineSearch').value = '';
        buildLineList('');
        const r2 = $(`.line-row[data-id="${c.dataset.id}"]`);
        if (r2) { r2.click(); r2.scrollIntoView({ block: 'center' }); }
      }
    }));
}

/* ════════ VISTA TRAZAR ════════ */
const TRACE_TOL = 30;   // tolerancia (unidades del plano, ~150 m) para dar por buena una zona del trazado

function buildTraceSelects() {
  const sel = $('#traceLine');
  sel.innerHTML = state.lines.map(l => `<option value="${l.id}">${l.n} — ${esc(l.name || '')}</option>`).join('');
  const fill = () => {
    const l = state.lines.find(x => String(x.id) === sel.value) || state.lines[0];
    $('#traceVariant').innerHTML = l.variants.map((v, i) => {
      const a = v.stops[0]?.name || '?', b = v.stops[v.stops.length - 1]?.name || '?';
      return `<option value="${i}">${esc(a)} → ${esc(b)} (${v.stops.length})</option>`;
    }).join('');
  };
  sel.addEventListener('change', fill);
  fill();
}

/** reparte una polilínea en puntos separados ~step unidades */
function densify(pts, step = 8) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let k = 0; k < n; k++) out.push([x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n]);
  }
  if (pts.length) out.push(pts[pts.length - 1]);
  return out;
}

function minDist(p, grid, cell) {
  const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell);
  let best = Infinity;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const a = grid.get((cx + i) + ',' + (cy + j)); if (!a) continue;
    for (const q of a) { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d < best) best = d; }
  }
  return best;
}

function buildGrid(pts, cell) {
  const g = new Map();
  for (const p of pts) {
    const k = Math.floor(p[0] / cell) + ',' + Math.floor(p[1] / cell);
    let a = g.get(k); if (!a) g.set(k, a = []); a.push(p);
  }
  return g;
}

/** trozos consecutivos con el mismo estado ok */
function runs(pts, oks) {
  const out = []; let cur = null;
  for (let i = 0; i < pts.length; i++) {
    if (!cur || cur.ok !== oks[i]) { cur = { ok: oks[i], pts: cur ? [cur.pts[cur.pts.length - 1]] : [] }; out.push(cur); }
    cur.pts.push(pts[i]);
  }
  return out;
}

/** compara el recorrido real con los trazos del usuario (lista de {pts}) */
function evaluateTrace(real, strokes, stops) {
  const CELL = TRACE_TOL * 2;
  const rd = densify(real);
  const uds = strokes.map(st => densify(st.pts));
  const ud = uds.flat();
  const gu = buildGrid(ud, CELL), gr = buildGrid(rd, CELL);
  const rok = rd.map(p => minDist(p, gu, CELL) <= TRACE_TOL);
  const userRuns = [];
  let good = 0;
  for (const pts of uds) {
    const oks = pts.map(p => minDist(p, gr, CELL) <= TRACE_TOL);
    good += oks.filter(Boolean).length;
    userRuns.push(...runs(pts, oks));
  }
  const cover = rok.filter(Boolean).length / rd.length;
  const precision = good / Math.max(1, ud.length);
  const missed = stops.filter(s => minDist([s.x, s.y], gu, CELL) > TRACE_TOL);
  return { cover, precision, missed, real: runs(rd, rok), user: userRuns, realPts: real };
}

function wireTrace() {
  const t = state.trace;
  const st = { line: null, variant: null };
  t.hideOtherStops = true;
  t.tool = 'move';

  const nPts = () => (t.trace || []).reduce((a, s) => a + s.pts.length, 0);
  const refresh = () => { $('#trPts').textContent = nPts(); };
  const clearResult = () => {
    t.traceResult = null; t.traceView = 'both';
    $('#traceResult').classList.add('hidden'); $('#traceViewBtns').classList.add('hidden');
    $$('.tv').forEach(b => b.classList.toggle('active', b.dataset.tv === 'both'));
  };
  const setTool = k => {
    t.tool = k;
    $$('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === k));
    t.canvas.style.cursor = k === 'move' ? 'grab' : 'crosshair';
  };
  const idleCursor = () => { t.canvas.style.cursor = (t.tool === 'move' && !t._drawKey) ? 'grab' : 'crosshair'; };
  $$('.tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $$('.tv').forEach(b => b.addEventListener('click', () => {
    t.traceView = b.dataset.tv;
    $$('.tv').forEach(x => x.classList.toggle('active', x === b));
    t.dirty = true;
  }));

  // a mano alzada
  t.onStroke = (ph, x, y) => {
    if (!st.line) return;
    const last = () => t.trace[t.trace.length - 1];
    if (ph === 'start') { if (t.traceResult) clearResult(); t.trace.push({ kind: 'free', pts: [[x, y]] }); }
    else if (ph === 'move') {
      const s = last(); if (!s) return;
      const l = s.pts[s.pts.length - 1];
      if (Math.hypot(x - l[0], y - l[1]) >= Math.max(4, 3 / t.scale)) s.pts.push([x, y]);
    } else if (ph === 'end') { const s = last(); if (s && s.pts.length < 2) t.trace.pop(); }
    else if (ph === 'cancel') t.trace.pop();
    t.dirty = true; refresh();
  };

  // por puntos (clic)
  t.onMapClick = (x, y) => {
    if (!st.line || t.tool !== 'poly') return;
    if (t.traceResult) clearResult();
    const l = t.trace[t.trace.length - 1];
    if (l && l.kind === 'poly') l.pts.push([x, y]); else t.trace.push({ kind: 'poly', pts: [[x, y]] });
    t.dirty = true; refresh();
  };

  $('#traceStart').addEventListener('click', () => {
    const l = state.lines.find(x => String(x.id) === $('#traceLine').value);
    if (!l) return;
    const v = l.variants[+($('#traceVariant').value || 0)] || l.variants[0];
    st.line = l; st.variant = v;
    const stops = v.stops;
    t.overlay = null; t.corridor = null;
    t.overlayStops = $('#traceHelp').value === 'ends'
      ? [stops[0], stops[stops.length - 1]].map((s, i) => ({ ...s, order: i, served: false }))
      : stops.map((s, i) => ({ ...s, order: i, served: false }));
    t.nextStopOrder = 0;   // la primera parada, resaltada en amarillo
    t.trace = []; clearResult(); setTool('move');
    $('#traceSetup').classList.add('hidden'); $('#traceHud').classList.remove('hidden');
    $('#view-trazar').classList.add('focus-ui');
    $('#trLine').textContent = `${l.n} · ${l.name || ''}`;
    $('#trFrom').textContent = stops[0].name; $('#trTo').textContent = stops[stops.length - 1].name;
    refresh();
    // encuadre: zona de la ruta (sin entregar el trazado exacto)
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [x, y] of v.pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    t.fitBox(x0, y0, x1, y1, 0.9);
    t.dirty = true;
  });

  /** deshace el último tramo: recorta el último trazo hasta la última parada por la que pasó; si no hay, lo quita entero */
  const undo = () => {
    const l = t.trace && t.trace[t.trace.length - 1];
    if (!l) return;
    if (t.traceResult) clearResult();
    if (l.kind === 'poly' && l.pts.length > 1) { l.pts.pop(); t.dirty = true; refresh(); return; }
    const stops = st.variant ? st.variant.stops : [];
    const pts = l.pts, end = pts[pts.length - 1];
    let cut = -1, run = 0;
    for (let j = pts.length - 2; j >= 1; j--) {
      run += Math.hypot(pts[j][0] - pts[j + 1][0], pts[j][1] - pts[j + 1][1]);
      if (run < 40) continue;                      // ignora la parada en la que ya terminaba el trazo
      if (stops.some(s => Math.hypot(s.x - pts[j][0], s.y - pts[j][1]) <= TRACE_TOL)) { cut = j; break; }
    }
    if (cut > 0 && l.kind === 'free') l.pts = pts.slice(0, cut + 1); else t.trace.pop();
    t.dirty = true; refresh();
  };
  $('#traceUndo').addEventListener('click', undo);

  const check = () => {
    if (!st.line) return;
    const box = $('#traceResult');
    if (nPts() < 2) { box.className = 'trace-result warn'; box.textContent = 'Dibuja primero el recorrido sobre el mapa.'; return; }
    const r = evaluateTrace(st.variant.pts, t.trace, st.variant.stops);
    r.color = st.line.color;
    t.traceResult = r; t.traceView = 'both'; t.dirty = true;
    $$('.tv').forEach(b => b.classList.toggle('active', b.dataset.tv === 'both'));
    $('#traceViewBtns').classList.remove('hidden');
    const pc = Math.round(r.cover * 100), pp = Math.round(r.precision * 100);
    const verdict = pc >= 90 && pp >= 85 ? '¡Ruta correcta!' : pc >= 70 ? 'Casi: te falta algún tramo' : 'Todavía no: repasa el recorrido';
    const missed = r.missed.length
      ? `<div class="miss">No pasaste cerca de: ${r.missed.slice(0, 8).map(s => esc(s.name)).join(', ')}${r.missed.length > 8 ? ` y ${r.missed.length - 8} más` : ''}</div>` : '';
    box.className = 'trace-result ' + (pc >= 90 && pp >= 85 ? 'ok' : pc >= 70 ? 'mid' : 'bad');
    box.innerHTML = `<b>${verdict}</b>
      <div>Recorrido real cubierto: <b>${pc} %</b></div>
      <div>Tu trazado que va por la ruta: <b>${pp} %</b></div>
      <div class="legend"><span class="lg g"></span> acertaste <span class="lg r"></span> te faltó <span class="lg b"></span> tu trazado <span class="lg o"></span> te saliste</div>
      ${missed}`;
    toast(`${verdict} · cubres el ${pc} %`, 3500);
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  $('#traceCheck').addEventListener('click', check);

  const end = () => {
    st.line = null; t.trace = null; clearResult(); t.overlayStops = [];
    $('#traceHud').classList.add('hidden'); $('#traceSetup').classList.remove('hidden');
    $('#view-trazar').classList.remove('focus-ui');
    t.tool = null; t.dirty = true; t.fit();
  };
  $('#traceEnd').addEventListener('click', end);

  $('#trZoomIn').onclick = () => t.zoomAt(1.35, t.canvas.width / 2, t.canvas.height / 2);
  $('#trZoomOut').onclick = () => t.zoomAt(1 / 1.35, t.canvas.width / 2, t.canvas.height / 2);
  $('#trFit').onclick = () => {
    if (!st.variant) return t.fit();
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [x, y] of st.variant.pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    t.fitBox(x0, y0, x1, y1, 0.9);
  };

  const active = () => $('#view-trazar').classList.contains('active') && st.line;
  const clearAll = () => { t.trace = []; clearResult(); t.dirty = true; refresh(); };
  $('#traceClear').onclick = clearAll;
  window.addEventListener('keydown', e => {
    if (!active()) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey || e.altKey) { if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); undo(); } return; }
    if (k === '1') { e.preventDefault(); if (!t._drawKey) { t._drawKey = true; t.canvas.style.cursor = 'crosshair'; } }
    else if (k === '2') { e.preventDefault(); if (!e.repeat) undo(); }
    else if (k === '3') { e.preventDefault(); if (!e.repeat) clearAll(); }
    else if (k === ' ') { e.preventDefault(); t._space = true; t.canvas.style.cursor = 'grab'; }
    else if (e.key === 'Enter') { e.preventDefault(); check(); }
    else if (e.key === 'Escape') end();
  });
  window.addEventListener('keyup', e => {
    if (e.key === '1') { t._drawKey = false; idleCursor(); }
    if (e.key === ' ') { t._space = false; idleCursor(); }
  });
  window.addEventListener('blur', () => { t._drawKey = false; t._space = false; });
}

/* ════════ VISTA CONDUCCIÓN ════════ */
function buildDriveSelects() {
  const sel = $('#driveLine');
  sel.innerHTML = state.lines.map(l =>
    `<option value="${l.id}">${l.n} — ${esc(l.name || '')}</option>`).join('');
  fillVariants();
  sel.addEventListener('change', fillVariants);
}

function fillVariants() {
  const l = state.lines.find(x => String(x.id) === $('#driveLine').value) || state.lines[0];
  if (!l) return;
  $('#driveVariant').innerHTML = l.variants.map((v, i) => {
    const a = v.stops[0]?.name || '?', b = v.stops[v.stops.length - 1]?.name || '?';
    return `<option value="${i}">${esc(a)} → ${esc(b)} (${v.stops.length})</option>`;
  }).join('');
}

function wireDrive() {
  const d = state.drive;

  d.onHud = h => {
    $('#hudLine').textContent = h.line;
    $('#hudNext').textContent = h.next;
    $('#hudStops').textContent = h.stops;
    $('#hudDev').textContent = h.deviations;
    $('#hudSpeed').textContent = h.speed + ' km/h';
    $('#hudBar').style.width = h.pct + '%';
    $('#hudDev').style.color = h.deviations > 0 ? 'var(--warn)' : 'var(--txt)';
    if (h.auto) {
      $('#autoPause').textContent = h.paused ? '▶ Seguir' : '⏸ Pausa';
      $$('.auto-sp').forEach(b => b.classList.toggle('active', +b.dataset.sp === h.autoSpeed));
    }
    const msg = $('#driveMsg');
    if (h.offRoute) { msg.className = 'drive-msg err'; msg.textContent = '⚠ Fuera del recorrido — vuelve al trazado azul'; }
    else if (!msg.classList.contains('warn')) { msg.className = 'drive-msg'; }
  };

  d.onMessage = (kind, text) => {
    const msg = $('#driveMsg');
    msg.className = 'drive-msg ' + (kind === 'err' ? 'err' : kind === 'warn' ? 'warn' : 'good');
    msg.textContent = text;
    clearTimeout(d._msgT);
    d._msgT = setTimeout(() => { msg.className = 'drive-msg'; msg.textContent = ''; }, 4200);
  };

  d.onFinish = (ok, res) => {
    const b = $('#driveBanner');
    b.className = 'banner ' + (ok ? 'ok' : 'bad');
    b.innerHTML = ok
      ? `✅ ¡Ruta correcta! Has completado las ${res.stops} paradas<br>
         <span style="font-size:13px;font-weight:500">${res.deviations} desvío${res.deviations === 1 ? '' : 's'} · ${fmtTime(res.time)}</span>`
      : `❌ Recorrido terminado con ${res.deviations} desvío${res.deviations === 1 ? '' : 's'}`;
    b.classList.remove('hidden');
    setTimeout(() => b.classList.add('hidden'), 5200);
  };

  const begin = auto => {
    const l = state.lines.find(x => String(x.id) === $('#driveLine').value);
    if (!l) return;
    const vi = +($('#driveVariant').value || 0);
    $('#driveSetup').classList.add('hidden');
    $('#driveHud').classList.remove('hidden');
    $('#view-conduccion').classList.add('focus-ui');
    $('#driveBanner').classList.add('hidden');
    $('#autoCtl').classList.toggle('hidden', !auto);
    if (d.start(l, vi, { auto })) toast((auto ? 'Recorrido automático · línea ' : 'Conduciendo línea ') + l.n);
  };
  $('#driveStart').addEventListener('click', () => begin(false));
  $('#driveAuto').addEventListener('click', () => begin(true));
  $('#autoPause').addEventListener('click', () => d.setPaused(!d.paused));
  $$('.auto-sp').forEach(b => b.addEventListener('click', () => d.setAutoSpeed(+b.dataset.sp)));

  $('#driveStop').addEventListener('click', endDrive);
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('#view-conduccion').classList.contains('active')) endDrive();
  });
}

function endDrive() {
  state.drive.stop();
  $('#driveSetup').classList.remove('hidden');
  $('#driveHud').classList.add('hidden');
  $('#driveBanner').classList.add('hidden');
  $('#driveMsg').textContent = '';
  $('#view-conduccion').classList.remove('focus-ui');
}

/* ════════ VISTA TEST ════════ */
function startQuiz() {
  const kind = $('#quizKind').value;
  const n = +$('#quizLen').value;
  state.quizQs = state.quiz.build(kind, n);
  state.quizIdx = 0; state.quizRight = 0;
  if (!state.quizQs.length) { toast('No hay suficientes datos para ese tipo de pregunta.'); return; }
  $('#quizScore').classList.remove('hidden');
  renderQuestion();
}

function renderQuestion() {
  const q = state.quizQs[state.quizIdx];
  const box = $('#quizBox');
  box.innerHTML = `
    <div class="q-progress"><span>Pregunta ${state.quizIdx + 1} / ${state.quizQs.length}</span>
      <span>✔ ${state.quizRight}</span></div>
    <div class="q-text">${q.text}</div>
    <div class="q-opts">
      ${q.options.map((o, i) => `<button class="q-opt" data-i="${i}">${esc(o)}</button>`).join('')}
    </div>
    <div class="q-exp hidden" id="qExp"></div>
    <div class="q-actions hidden" id="qAct">
      <button class="go" id="qNext">${state.quizIdx + 1 >= state.quizQs.length ? 'Ver resultado' : 'Siguiente →'}</button>
    </div>`;

  box.querySelectorAll('.q-opt').forEach(b =>
    b.addEventListener('click', () => answer(+b.dataset.i)));
}

function answer(i) {
  const q = state.quizQs[state.quizIdx];
  const box = $('#quizBox');
  const btns = box.querySelectorAll('.q-opt');
  btns.forEach((b, j) => {
    b.disabled = true;
    if (j === q.correct) b.classList.add('right');
    else if (j === i) b.classList.add('wrong');
  });
  if (i === q.correct) state.quizRight++;

  const exp = $('#qExp');
  exp.classList.remove('hidden');
  exp.innerHTML = (i === q.correct ? '✅ <b>Correcto.</b> ' : '❌ <b>Incorrecto.</b> ') + q.explain;
  $('#qAct').classList.remove('hidden');
  $('#qNext').onclick = () => {
    state.quizIdx++;
    if (state.quizIdx >= state.quizQs.length) endQuiz();
    else renderQuestion();
  };
}

function endQuiz() {
  const total = state.quizQs.length, ok = state.quizRight;
  const pct = Math.round((ok / total) * 100);
  const stars = pct >= 90 ? '⭐⭐⭐' : pct >= 70 ? '⭐⭐' : pct >= 50 ? '⭐' : '💪';
  $('#quizBox').innerHTML = `
    <div style="text-align:center;padding:14px 0">
      <div class="stars">${stars}</div>
      <div style="font-size:44px;font-weight:800;margin:10px 0;color:var(--accent)">${ok}<span style="font-size:22px;color:var(--muted)">/${total}</span></div>
      <div style="color:var(--muted);font-size:14px">${pct}% de aciertos</div>
      <div class="q-actions" style="margin-top:24px">
        <button class="go" id="qAgain">🔁 Otro test</button>
      </div>
    </div>`;
  $('#qAgain').onclick = startQuiz;
  $('#quizScore').innerHTML = `Último resultado<br><b>${ok}/${total}</b> · ${pct}%`;
}

/* ════════ UI genérica ════════ */
function wireUI() {
  // pestañas
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    $$('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    const v = t.dataset.view;
    $$('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
    if (v !== 'conduccion' && state.drive.running) endDrive();
    setTimeout(() => {
      if (v === 'mapa') { state.mapView._resize(); state.mapView.dirty = true; }
      if (v === 'conduccion') { state.drive.view._resize(); if (!state.drive.running) state.drive.view.fit(); state.drive.view.dirty = true; }
      if (v === 'trazar') { state.trace._resize(); if (!$('#view-trazar').classList.contains('focus-ui')) state.trace.fit(); state.trace.dirty = true; }
    }, 40);
  }));

  $('#lineSearch').addEventListener('input', e => buildLineList(e.target.value));
  $('#backToList').addEventListener('click', () => {
    $('#lineDetail').classList.add('hidden');
    $('#lineList').classList.remove('hidden');
    $$('.line-row').forEach(r => r.classList.remove('sel'));
    state.mapView.overlay = null;
    state.mapView.overlayStops = [];
    state.mapView.dirty = true;
  });

  $('#zoomIn').onclick = () => state.mapView.zoomAt(1.35, state.mapView.canvas.width / 2, state.mapView.canvas.height / 2);
  $('#zoomOut').onclick = () => state.mapView.zoomAt(1 / 1.35, state.mapView.canvas.width / 2, state.mapView.canvas.height / 2);
  $('#zoomFit').onclick = () => state.mapView.fit();

  // atajos de teclado para portátil (solo en la vista Mapa y sin escribir en el buscador)
  window.addEventListener('keydown', e => {
    if (!$('#view-mapa').classList.contains('active')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const v = state.mapView, typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName);
    const cx = v.canvas.width / 2, cy = v.canvas.height / 2, step = 90 * v._dpr();
    if (e.key === '/' && !typing) { e.preventDefault(); $('#lineSearch').focus(); return; }
    if (e.key === 'Escape') {
      if (typing) { document.activeElement.blur(); return; }
      if (!$('#lineDetail').classList.contains('hidden')) $('#backToList').click();
      $('#stopCard').classList.add('hidden');
      return;
    }
    if (typing) return;
    const k = e.key;
    if (k === '+' || k === '=') v.zoomAt(1.3, cx, cy);
    else if (k === '-' || k === '_') v.zoomAt(1 / 1.3, cx, cy);
    else if (k === '0' || k.toLowerCase() === 'f') { if (state.currentLine && !$('#lineDetail').classList.contains('hidden')) fitToPoints(state.currentLine.variants[state.currentVariant].pts); else v.fit(); }
    else if (k === 'ArrowLeft') v.tx += step;
    else if (k === 'ArrowRight') v.tx -= step;
    else if (k === 'ArrowUp') v.ty += step;
    else if (k === 'ArrowDown') v.ty -= step;
    else if (k === 'Tab' || k === 'Enter') return;
    else return;
    e.preventDefault();
    v.dirty = true;
  });

  $('#quizStart').addEventListener('click', startQuiz);

  // service worker + instalación
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  let deferred;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault(); deferred = e;
    $('#installBtn').classList.remove('hidden');
  });
  $('#installBtn').addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    $('#installBtn').classList.add('hidden');
  });
}

/* ── util ── */
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fmtTime(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

boot();
