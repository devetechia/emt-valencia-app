/* ═══════════════════════════════════════════════════════════
   app.js — Arranque, navegación y cableado de vistas
   ═══════════════════════════════════════════════════════════ */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const state = {
  lines: [], stops: [], quiz: null,
  mapView: null, drive: null,
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
    state.mapView = v;
    const info = await v.load('');
    state.lines = info.lines ? v.lines : [];
    state.stops = v.stops;
    v.onStopClick = showStopCard;

    state.drive = new DriveSim($('#driveCanvas'));
    await state.drive.load('');
    wireDrive();

    state.quiz = new Quiz(state.lines);
    buildLineList();
    buildDriveSelects();
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
  x0 = Math.max(x0, -pad); y0 = Math.max(y0, -pad);
  x1 = Math.min(x1, v.mapW + pad); y1 = Math.min(y1, v.mapH + pad);
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

  $('#driveStart').addEventListener('click', () => {
    const l = state.lines.find(x => String(x.id) === $('#driveLine').value);
    if (!l) return;
    const vi = +($('#driveVariant').value || 0);
    $('#driveSetup').classList.add('hidden');
    $('#driveHud').classList.remove('hidden');
    $('#driveBanner').classList.add('hidden');
    if (d.start(l, vi)) toast('Conduciendo línea ' + l.n);
  });

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
      if (v === 'conduccion') { state.drive.view._resize(); state.drive.view.dirty = true; }
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
