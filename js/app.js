/**
 * app.js — Turni Infermieri PS
 * Main application logic: state management, UI rendering, wizard flow.
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHIFT_COLORS = { M: 'shift-M', P: 'shift-P', D: 'shift-D', N: 'shift-N', S: 'shift-S', R: 'shift-R' };
const SHIFT_LABELS = { M: 'Mattina', P: 'Pomeriggio', D: 'Diurno', N: 'Notte', S: 'Smonto', R: 'Riposo' };
const SHIFT_HOURS  = { M: 6.2, P: 6.2, D: 12.2, N: 12.2, S: 0, R: 0 };
const DOW_LABELS   = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
const MONTHS_IT    = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno',
                      'Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];

const DEFAULT_NURSE_NAMES = [
  'Rossi Marco','Bianchi Laura','Ferrari Giovanni','Esposito Sofia',
  'Conti Luca','Ricci Anna','Colombo Pietro','Russo Elena',
  'Marinelli Sara','Greco Alberto','Bruno Claudia','Romano Fabio',
  'Costa Valentina','Fontana Roberto','Ferrara Giulia','Galli Stefano',
  'Coppola Marta','Rizzo Davide','Lombardi Chiara','Barbieri Simone',
  'Moretti Paola','Caruso Marco','De Luca Francesca','Fiore Alessandro',
  'Pellegrini Ilaria','Monti Nicola','Poli Carmen','Testa Giorgio',
  'Riva Serena','Sala Massimo','Villa Roberta','Sergi Luigi',
  'Palumbo Elisa','Messina Diego','Cattaneo Nadia','Rinaldi Lorenzo',
  'Fabbri Agnese',
];

const DEFAULT_RULES = {
  minCoverageM: 6,
  maxCoverageM: 7,
  minCoverageP: 6,
  maxCoverageP: 7,
  minCoverageD: 0,
  maxCoverageD: 4,
  minCoverageN: 2,
  maxCoverageN: 4,
  targetHours: 36,
  minHours: 28,
  maxHours: 42,
  targetNights: 4,
  maxNights: 6,
  hardMaxNights: 7,
  noConsecD: true,
  mandatoryS: true,
  minGap11h: true,
  forwardOnly: true,
  minRPerWeek: 2,
  preferDiurni: false,
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function genId(i) {
  return crypto.randomUUID ? crypto.randomUUID() : `n${i}`;
}

function nextMonthDefault() {
  const now = new Date();
  const m = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return { month: m.getMonth(), year: m.getFullYear() };
}

function buildDefaultNurses(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: genId(i),
    name: DEFAULT_NURSE_NAMES[i] || `Infermiere ${i + 1}`,
    tags: [],
  }));
}

const { month: defMonth, year: defYear } = nextMonthDefault();

let state = {
  step: 1,
  month: defMonth,
  year: defYear,
  totalNurses: 37,
  absentNurses: 2,
  nurses: buildDefaultNurses(37),
  rules: { ...DEFAULT_RULES },
  schedule: null,
  violations: [],
  stats: [],
  worker: null,
  darkMode: false,
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function saveState() {
  try {
    const s = { ...state, worker: null, schedule: state.schedule };
    localStorage.setItem('turni_state', JSON.stringify(s));
  } catch (_) {}
}

function loadState() {
  try {
    const raw = localStorage.getItem('turni_state');
    if (!raw) return;
    const saved = JSON.parse(raw);
    // Merge carefully
    state = { ...state, ...saved, worker: null };
    // Ensure rules have all keys
    state.rules = { ...DEFAULT_RULES, ...saved.rules };
    // Re-hydrate nurses (ensure tags array)
    state.nurses = (saved.nurses || []).map(n => ({ ...n, tags: n.tags || [] }));
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Dark mode
// ---------------------------------------------------------------------------

function applyDarkMode(dark) {
  document.documentElement.classList.toggle('dark', dark);
  const btn = document.getElementById('btn-dark');
  if (btn) btn.textContent = dark ? '☀️' : '🌙';
}

// ---------------------------------------------------------------------------
// Utility: days in month
// ---------------------------------------------------------------------------

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function dayOfWeek(year, month, day) {
  return new Date(year, month, day).getDay();
}

function isWeekend(year, month, day) {
  const d = dayOfWeek(year, month, day);
  return d === 0 || d === 6;
}

// ---------------------------------------------------------------------------
// Step navigation
// ---------------------------------------------------------------------------

function goToStep(step) {
  state.step = step;
  saveState();
  renderAll();
}

// ---------------------------------------------------------------------------
// Master render
// ---------------------------------------------------------------------------

function renderAll() {
  renderStepNav();
  renderStep1();
  renderStep2();
  renderStep3();
  renderStep4();
  applyDarkMode(state.darkMode);
}

function showOnlyStep(step) {
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById(`step-${i}`);
    if (el) el.classList.toggle('hidden', i !== step);
  }
}

// ---------------------------------------------------------------------------
// Step Nav
// ---------------------------------------------------------------------------

function renderStepNav() {
  showOnlyStep(state.step);
  const steps = [1, 2, 3, 4];
  steps.forEach(i => {
    const ind = document.getElementById(`btn-nav-${i}`);
    if (!ind) return;
    ind.className = 'step-indicator ' + (
      i < state.step ? 'done' : i === state.step ? 'active' : 'pending'
    );
    if (i < state.step) ind.innerHTML = '✓';
    else ind.textContent = i;

    const conn = document.getElementById(`step-conn-${i}`);
    if (conn) conn.className = 'step-connector ' + (i < state.step ? 'done' : '');
  });

  // Nav buttons
  ['btn-nav-1','btn-nav-2','btn-nav-3','btn-nav-4'].forEach((id, idx) => {
    const btn = document.getElementById(id);
    if (btn) {
      btn.classList.toggle('font-bold', idx + 1 === state.step);
      btn.classList.toggle('text-blue-500', idx + 1 === state.step);
    }
  });
}

// ---------------------------------------------------------------------------
// Step 1 — Organico
// ---------------------------------------------------------------------------

function renderStep1() {
  // Month/year selectors
  const selMonth = document.getElementById('sel-month');
  const selYear = document.getElementById('sel-year');
  if (selMonth) selMonth.value = state.month;
  if (selYear) selYear.value = state.year;

  // Nurse counts
  const inpTotal = document.getElementById('inp-total');
  const inpAbsent = document.getElementById('inp-absent');
  if (inpTotal) inpTotal.value = state.totalNurses;
  if (inpAbsent) inpAbsent.value = state.absentNurses;

  renderNurseList();
}

function renderNurseList() {
  const container = document.getElementById('nurse-list');
  if (!container) return;
  container.innerHTML = '';

  const activeNurses = state.nurses.slice(0, state.totalNurses - state.absentNurses);

  activeNurses.forEach((nurse, idx) => {
    const item = document.createElement('div');
    item.className = 'nurse-item';
    item.dataset.idx = idx;
    item.draggable = true;

    const tagDefs = [
      { key: 'solo_mattine', label: 'Solo mattine feriali', cls: 'tag-solo_mattine' },
      { key: 'no_notti',     label: 'No notti',            cls: 'tag-no_notti' },
      { key: 'no_diurni',   label: 'No diurni 12h',       cls: 'tag-no_diurni' },
      { key: 'ferie',       label: 'Ferie',               cls: 'tag-ferie' },
      { key: 'malattia',    label: 'Malattia',            cls: 'tag-malattia' },
      { key: '104',         label: '104',                 cls: 'tag-104' },
      { key: 'permesso_retribuito', label: 'Permesso retribuito', cls: 'tag-permesso_retribuito' },
      { key: 'maternita',   label: 'Maternità',           cls: 'tag-maternita' },
    ];

    const tagsHTML = tagDefs.map(t => {
      const active = nurse.tags.includes(t.key);
      return `<button class="tag ${t.cls} ${active ? 'active' : 'inactive'}"
                data-nurse="${idx}" data-tag="${t.key}"
                title="${t.label}">${t.label}</button>`;
    }).join('');

    item.innerHTML = `
      <span class="drag-handle" title="Trascina per riordinare">⠿</span>
      <span class="flex-1 text-sm font-medium nurse-name"
            contenteditable="true"
            data-nurse="${idx}"
            spellcheck="false">${escHtml(nurse.name)}</span>
      <div class="flex flex-wrap gap-1">${tagsHTML}</div>
    `;

    container.appendChild(item);

    // Contenteditable name editing
    const nameEl = item.querySelector('.nurse-name');
    nameEl.addEventListener('blur', () => {
      state.nurses[idx].name = nameEl.textContent.trim() || `Infermiere ${idx + 1}`;
      saveState();
    });
    nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } });

    // Tag toggle
    item.querySelectorAll('.tag').forEach(tagBtn => {
      tagBtn.addEventListener('click', () => {
        const nIdx = parseInt(tagBtn.dataset.nurse);
        const tKey = tagBtn.dataset.tag;
        const tags = state.nurses[nIdx].tags;
        const pos = tags.indexOf(tKey);
        if (pos >= 0) tags.splice(pos, 1); else tags.push(tKey);
        saveState();
        renderNurseList();
      });
    });

    // Drag and drop
    item.addEventListener('dragstart', e => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', idx);
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
    item.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', e => {
      e.preventDefault();
      item.classList.remove('drag-over');
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
      const toIdx = idx;
      if (fromIdx === toIdx) return;
      const moved = state.nurses.splice(fromIdx, 1)[0];
      state.nurses.splice(toIdx, 0, moved);
      saveState();
      renderNurseList();
    });
  });
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ---------------------------------------------------------------------------
// Step 2 — Regole
// ---------------------------------------------------------------------------

function renderStep2() {
  const r = state.rules;

  // Coverage sliders - Mattina
  bindRange('sl-min-cov-m', 'val-min-cov-m', r.minCoverageM, v => { state.rules.minCoverageM = v; saveState(); });
  bindRange('sl-max-cov-m', 'val-max-cov-m', r.maxCoverageM, v => { state.rules.maxCoverageM = v; saveState(); });

  // Coverage sliders - Pomeriggio
  bindRange('sl-min-cov-p', 'val-min-cov-p', r.minCoverageP, v => { state.rules.minCoverageP = v; saveState(); });
  bindRange('sl-max-cov-p', 'val-max-cov-p', r.maxCoverageP, v => { state.rules.maxCoverageP = v; saveState(); });

  // Coverage sliders - Diurno
  bindRange('sl-min-cov-d', 'val-min-cov-d', r.minCoverageD, v => { state.rules.minCoverageD = v; saveState(); });
  bindRange('sl-max-cov-d', 'val-max-cov-d', r.maxCoverageD, v => { state.rules.maxCoverageD = v; saveState(); });

  // Coverage sliders - Notte
  bindRange('sl-min-cov-n', 'val-min-cov-n', r.minCoverageN, v => { state.rules.minCoverageN = v; saveState(); });
  bindRange('sl-max-cov-n', 'val-max-cov-n', r.maxCoverageN, v => { state.rules.maxCoverageN = v; saveState(); });

  // Hours
  bindRange('sl-target-hours', 'val-target-hours', r.targetHours, v => { state.rules.targetHours = v; saveState(); });
  bindRange('sl-min-hours',    'val-min-hours',    r.minHours,    v => { state.rules.minHours = v; saveState(); });
  bindRange('sl-max-hours',    'val-max-hours',    r.maxHours,    v => { state.rules.maxHours = v; saveState(); });

  // Nights
  bindRange('sl-target-nights', 'val-target-nights', r.targetNights,   v => { state.rules.targetNights = v; saveState(); });
  bindRange('sl-max-nights',    'val-max-nights',    r.maxNights,      v => { state.rules.maxNights = v; saveState(); });
  bindRange('sl-hard-nights',   'val-hard-nights',   r.hardMaxNights,  v => { state.rules.hardMaxNights = v; saveState(); });

  // Toggles
  bindToggle('tog-no-consec-d',   r.noConsecD,    v => { state.rules.noConsecD = v; saveState(); });
  bindToggle('tog-mandatory-s',   r.mandatoryS,   v => { state.rules.mandatoryS = v; saveState(); });
  bindToggle('tog-min-gap',       r.minGap11h,    v => { state.rules.minGap11h = v; saveState(); });
  bindToggle('tog-forward-only',  r.forwardOnly,  v => { state.rules.forwardOnly = v; saveState(); });
  bindToggle('tog-min-r-week',    r.minRPerWeek > 0, v => { state.rules.minRPerWeek = v ? 2 : 0; saveState(); });
}

function bindRange(inputId, labelId, value, onChange) {
  const inp = document.getElementById(inputId);
  const lbl = document.getElementById(labelId);
  if (!inp) return;
  inp.value = value;
  if (lbl) lbl.textContent = value;
  inp.oninput = () => {
    const v = parseFloat(inp.value);
    if (lbl) lbl.textContent = v;
    onChange(v);
  };
}

function bindToggle(inputId, value, onChange) {
  const inp = document.getElementById(inputId);
  if (!inp) return;
  inp.checked = value;
  inp.onchange = () => onChange(inp.checked);
}

// ---------------------------------------------------------------------------
// Step 3 — Genera
// ---------------------------------------------------------------------------

function renderStep3() {
  const bar = document.getElementById('progress-bar');
  const msg = document.getElementById('progress-msg');
  if (bar) bar.style.width = '0%';
  if (msg) msg.textContent = '';

  const activeCount = state.totalNurses - state.absentNurses;
  const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setEl('summary-period',  `${MONTHS_IT[state.month]} ${state.year}`);
  setEl('summary-nurses',  `${activeCount} / ${state.totalNurses}`);
  setEl('summary-cov',     `M:${state.rules.minCoverageM}–${state.rules.maxCoverageM} | P:${state.rules.minCoverageP}–${state.rules.maxCoverageP} | D:${state.rules.minCoverageD}–${state.rules.maxCoverageD} | N:${state.rules.minCoverageN}–${state.rules.maxCoverageN}`);
  setEl('summary-nights',  `${state.rules.targetNights} (max ${state.rules.hardMaxNights})`);
}

function startSolver() {
  // Terminate existing worker
  if (state.worker) { state.worker.terminate(); state.worker = null; }

  const btn = document.getElementById('btn-generate');
  if (btn) { btn.disabled = true; btn.textContent = 'Elaborazione...'; }

  const activeNurses = state.nurses.slice(0, state.totalNurses - state.absentNurses);

  const config = {
    year: state.year,
    month: state.month,
    nurses: activeNurses,
    rules: state.rules,
  };

  const worker = new Worker('js/solver.js');
  state.worker = worker;

  worker.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'progress') {
      const bar = document.getElementById('progress-bar');
      const msg = document.getElementById('progress-msg');
      if (bar) bar.style.width = data.percent + '%';
      if (msg) msg.textContent = data.message;
    } else if (data.type === 'result') {
      state.schedule = data.schedule;
      state.violations = data.violations || [];
      state.stats = data.stats || [];
      state.worker = null;
      worker.terminate();
      saveState();
      const btnG = document.getElementById('btn-generate');
      if (btnG) { btnG.disabled = false; btnG.textContent = 'GENERA TURNI'; }
      goToStep(4);
    } else if (data.type === 'error') {
      alert('Errore nel solver: ' + data.message);
      const btnG = document.getElementById('btn-generate');
      if (btnG) { btnG.disabled = false; btnG.textContent = 'GENERA TURNI'; }
      state.worker = null;
      worker.terminate();
    }
  };

  worker.onerror = (err) => {
    alert('Errore Worker: ' + err.message);
    const btnG = document.getElementById('btn-generate');
    if (btnG) { btnG.disabled = false; btnG.textContent = 'GENERA TURNI'; }
    state.worker = null;
  };

  worker.postMessage({ type: 'solve', config });
}

function regenerateTurni() {
  // Set preferDiurni to true for regeneration
  state.rules.preferDiurni = true;
  saveState();
  
  // Terminate existing worker
  if (state.worker) { state.worker.terminate(); state.worker = null; }

  const btn = document.getElementById('btn-regenerate');
  if (btn) { btn.disabled = true; btn.textContent = 'Rigenerando...'; }

  const activeNurses = state.nurses.slice(0, state.totalNurses - state.absentNurses);

  const config = {
    year: state.year,
    month: state.month,
    nurses: activeNurses,
    rules: state.rules,
  };

  const worker = new Worker('js/solver.js');
  state.worker = worker;

  worker.onmessage = (e) => {
    const data = e.data;
    if (data.type === 'progress') {
      // Progress can be shown if needed
    } else if (data.type === 'result') {
      state.schedule = data.schedule;
      state.violations = data.violations || [];
      state.stats = data.stats || [];
      state.worker = null;
      worker.terminate();
      saveState();
      const btnR = document.getElementById('btn-regenerate');
      if (btnR) { btnR.disabled = false; btnR.textContent = '🔄 Rigenera turni'; }
      renderStep4();
    } else if (data.type === 'error') {
      alert('Errore nel solver: ' + data.message);
      const btnR = document.getElementById('btn-regenerate');
      if (btnR) { btnR.disabled = false; btnR.textContent = '🔄 Rigenera turni'; }
      state.worker = null;
      worker.terminate();
    }
  };

  worker.onerror = (err) => {
    alert('Errore Worker: ' + err.message);
    const btnR = document.getElementById('btn-regenerate');
    if (btnR) { btnR.disabled = false; btnR.textContent = '🔄 Rigenera turni'; }
    state.worker = null;
  };

  worker.postMessage({ type: 'solve', config });
}

// ---------------------------------------------------------------------------
// Step 4 — Risultati
// ---------------------------------------------------------------------------

let openDropdown = null;

function renderStep4() {
  const container = document.getElementById('schedule-container');
  if (!container) return;
  if (!state.schedule) {
    container.innerHTML = '<p class="text-gray-500 italic text-center py-12">Nessun turno generato. Torna al passo 3.</p>';
    return;
  }

  const numDays = daysInMonth(state.year, state.month);
  const activeNurses = state.nurses.slice(0, state.schedule.length);
  const numNurses = activeNurses.length;

  // Build violation map for quick lookup: "n,d" → true
  const vioMap = new Set();
  (state.violations || []).forEach(v => {
    if (v.nurse !== undefined && v.day !== undefined) {
      vioMap.add(`${v.nurse},${v.day}`);
    }
  });

  // Build coverage per day
  function dayStats(d) {
    let M = 0, P = 0, N = 0;
    for (let n = 0; n < numNurses; n++) {
      const s = state.schedule[n][d];
      if (s === 'M' || s === 'D') M++;
      if (s === 'P' || s === 'D') P++;
      if (s === 'N') N++;
    }
    return { M, P, N };
  }

  // Header row
  let headerHTML = '<tr>';
  headerHTML += `<th class="sticky top-0 left-0 z-30 bg-white dark:bg-slate-800">
                   <span class="text-xs font-semibold">Infermiere</span>
                 </th>`;
  for (let d = 0; d < numDays; d++) {
    const dow = dayOfWeek(state.year, state.month, d + 1);
    const wk = isWeekend(state.year, state.month, d + 1);
    headerHTML += `<th class="${wk ? 'col-weekend' : ''}" title="${DOW_LABELS[dow]} ${d + 1} ${MONTHS_IT[state.month]}">
                     <div class="text-xs leading-none">${DOW_LABELS[dow].charAt(0)}</div>
                     <div class="font-bold">${d + 1}</div>
                   </th>`;
  }
  headerHTML += `<th class="stats-col">Ore | N | WE</th></tr>`;

  // Nurse rows
  let bodyHTML = '';
  for (let n = 0; n < numNurses; n++) {
    const st = state.stats[n] || { totalHours: 0, nights: 0, weekends: 0 };
    bodyHTML += `<tr>`;
    bodyHTML += `<td class="text-xs font-medium truncate" title="${escHtml(activeNurses[n].name)}">${escHtml(activeNurses[n].name)}</td>`;

    for (let d = 0; d < numDays; d++) {
      const shift = state.schedule[n][d] || 'R';
      const wk = isWeekend(state.year, state.month, d + 1);
      const vio = vioMap.has(`${n},${d}`);
      bodyHTML += `<td class="${wk ? 'col-weekend' : ''} ${vio ? 'violation-cell' : ''}" data-n="${n}" data-d="${d}">
                     <span class="shift-cell ${SHIFT_COLORS[shift] || 'shift-empty'}"
                           data-n="${n}" data-d="${d}">${shift}</span>
                   </td>`;
    }

    bodyHTML += `<td class="stats-col text-xs">${st.totalHours}h | ${st.nights}N | ${st.weekends}WE</td>`;
    bodyHTML += `</tr>`;
  }

  // Coverage row
  bodyHTML += `<tr class="coverage-row">`;
  bodyHTML += `<td class="text-xs font-semibold">COPERTURA</td>`;
  for (let d = 0; d < numDays; d++) {
    const cov = dayStats(d);
    const min = state.rules.minCoverage;
    const warnM = cov.M < min, warnP = cov.P < min;
    const wk = isWeekend(state.year, state.month, d + 1);
    bodyHTML += `<td class="${wk ? 'col-weekend' : ''}" title="M:${cov.M} P:${cov.P} N:${cov.N}">
      <div class="text-center leading-none">
        <div class="${warnM ? 'cov-warn' : 'cov-ok'}" style="font-size:9px">${warnM ? '⚠' : ''}M${cov.M}</div>
        <div class="${warnP ? 'cov-warn' : 'cov-ok'}" style="font-size:9px">${warnP ? '⚠' : ''}P${cov.P}</div>
        <div style="font-size:9px;color:#1E3A5F">N${cov.N}</div>
      </div>
    </td>`;
  }
  bodyHTML += `<td class="stats-col"></td></tr>`;

  // Build violations summary
  const vioSummaryHTML = state.violations.length > 0
    ? `<div class="mt-3 p-3 bg-red-50 dark:bg-red-950 border border-red-300 dark:border-red-700 rounded-lg max-h-32 overflow-y-auto">
         <p class="font-semibold text-red-700 dark:text-red-400 text-sm mb-1">⚠️ Violazioni rilevate (${state.violations.length})</p>
         ${state.violations.slice(0, 20).map(v => `<p class="text-xs text-red-600 dark:text-red-400">${escHtml(v.msg)}</p>`).join('')}
         ${state.violations.length > 20 ? `<p class="text-xs text-red-500">...e altre ${state.violations.length - 20}</p>` : ''}
       </div>`
    : `<div class="mt-3 p-3 bg-green-50 dark:bg-green-950 border border-green-300 dark:border-green-700 rounded-lg">
         <p class="font-semibold text-green-700 dark:text-green-400 text-sm">✅ Nessuna violazione rilevata</p>
       </div>`;

  container.innerHTML = `
    <div class="schedule-wrapper">
      <table class="schedule-table">
        <thead>${headerHTML}</thead>
        <tbody>${bodyHTML}</tbody>
      </table>
    </div>
    ${vioSummaryHTML}
    <div class="mt-4 text-xs text-gray-500 flex flex-wrap gap-4 no-print">
      ${Object.entries(SHIFT_LABELS).map(([k, v]) =>
        `<span class="inline-flex items-center gap-1">
           <span class="shift-cell ${SHIFT_COLORS[k]}" style="width:20px;height:18px;font-size:10px">${k}</span>
           <span>${v}</span>
         </span>`).join('')}
    </div>
  `;

  // Attach click listeners for inline shift editing
  container.querySelectorAll('.shift-cell').forEach(cell => {
    cell.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = parseInt(cell.dataset.n);
      const d = parseInt(cell.dataset.d);
      openShiftDropdown(cell, n, d);
    });
  });
}

function openShiftDropdown(anchorEl, n, d) {
  closeDropdown();

  const dropdown = document.createElement('div');
  dropdown.className = 'shift-dropdown';
  dropdown.id = 'active-dropdown';

  ['M', 'P', 'D', 'N', 'S', 'R'].forEach(shift => {
    const btn = document.createElement('button');
    btn.className = `shift-cell ${SHIFT_COLORS[shift]}`;
    btn.style.width = '36px';
    btn.style.height = '36px';
    btn.title = SHIFT_LABELS[shift];
    btn.textContent = shift;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      applyManualShift(n, d, shift);
      closeDropdown();
    });
    dropdown.appendChild(btn);
  });

  document.body.appendChild(dropdown);
  openDropdown = dropdown;

  // Position near anchor
  const rect = anchorEl.getBoundingClientRect();
  const left = Math.min(rect.left + window.scrollX, window.innerWidth - 230);
  const top = rect.bottom + window.scrollY + 4;
  dropdown.style.position = 'absolute';
  dropdown.style.left = left + 'px';
  dropdown.style.top = top + 'px';
}

function closeDropdown() {
  if (openDropdown) {
    openDropdown.remove();
    openDropdown = null;
  }
}

function applyManualShift(n, d, newShift) {
  if (!state.schedule) return;
  const old = state.schedule[n][d];
  state.schedule[n][d] = newShift;

  // Enforce N→S→R block
  if (newShift === 'N') {
    const numDays = daysInMonth(state.year, state.month);
    if (d + 1 < numDays) state.schedule[n][d + 1] = 'S';
    if (d + 2 < numDays) state.schedule[n][d + 2] = 'R';
  }
  // If we're removing N and old was N, clear the S
  if (old === 'N' && newShift !== 'N') {
    const numDays = daysInMonth(state.year, state.month);
    if (d + 1 < numDays && state.schedule[n][d + 1] === 'S') state.schedule[n][d + 1] = 'R';
    if (d + 2 < numDays && state.schedule[n][d + 2] === 'R') {/* keep R */}
  }

  // Recalculate stats for affected nurse
  recalcNurseStats(n);

  // Re-validate
  revalidate();

  saveState();
  renderStep4();
}

function recalcNurseStats(n) {
  const numDays = daysInMonth(state.year, state.month);
  let totalHours = 0, nights = 0, weekends = 0;
  for (let d = 0; d < numDays; d++) {
    const s = state.schedule[n][d];
    totalHours += SHIFT_HOURS[s] || 0;
    if (s === 'N') nights++;
    if (isWeekend(state.year, state.month, d + 1) && s && s !== 'R') weekends++;
  }
  state.stats[n] = { totalHours: Math.round(totalHours * 10) / 10, nights, weekends };
}

function revalidate() {
  if (!state.schedule) return;
  const numNurses = state.schedule.length;
  const numDays = daysInMonth(state.year, state.month);
  const violations = [];

  const FORBIDDEN_NEXT = {
    P: ['M', 'D'],
    D: ['M', 'P', 'D'],
    N: ['M', 'P', 'D', 'R', 'N'],
    S: ['M', 'P', 'D', 'N'],
  };

  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays - 1; d++) {
      const cur = state.schedule[n][d];
      const nxt = state.schedule[n][d + 1];
      const forbidden = FORBIDDEN_NEXT[cur] || [];
      if (forbidden.includes(nxt)) {
        violations.push({ nurse: n, day: d, type: 'transition', msg: `Inf. ${n + 1}, gg ${d + 1}-${d + 2}: ${cur}→${nxt} vietato` });
      }
    }
  }

  for (let d = 0; d < numDays; d++) {
    let M = 0, P = 0, D = 0, N = 0;
    for (let n = 0; n < numNurses; n++) {
      const s = state.schedule[n][d];
      if (s === 'M') M++;
      if (s === 'P') P++;
      if (s === 'D') { D++; M++; P++; }
      if (s === 'N') N++;
    }
    if (M < state.rules.minCoverageM) violations.push({ day: d, type: 'coverage_M', msg: `Giorno ${d + 1}: M insufficiente (${M}/${state.rules.minCoverageM})` });
    if (P < state.rules.minCoverageP) violations.push({ day: d, type: 'coverage_P', msg: `Giorno ${d + 1}: P insufficiente (${P}/${state.rules.minCoverageP})` });
    if (N < state.rules.minCoverageN) violations.push({ day: d, type: 'coverage_N', msg: `Giorno ${d + 1}: N insufficiente (${N}/${state.rules.minCoverageN})` });
  }

  state.violations = violations;
}

// ---------------------------------------------------------------------------
// Export: CSV
// ---------------------------------------------------------------------------

function exportCSV() {
  if (!state.schedule) return;
  const numDays = daysInMonth(state.year, state.month);
  const activeNurses = state.nurses.slice(0, state.schedule.length);

  // Header row
  const headers = ['Infermiere', ...Array.from({ length: numDays }, (_, i) => {
    const dow = DOW_LABELS[dayOfWeek(state.year, state.month, i + 1)];
    return `${i + 1} ${dow}`;
  }), 'Ore', 'Notti', 'Weekend'];

  const rows = [headers];
  activeNurses.forEach((nurse, n) => {
    const st = state.stats[n] || { totalHours: 0, nights: 0, weekends: 0 };
    const row = [nurse.name,
      ...Array.from({ length: numDays }, (_, d) => state.schedule[n][d] || 'R'),
      st.totalHours, st.nights, st.weekends
    ];
    rows.push(row);
  });

  const csv = '\uFEFF' + rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(';')).join('\r\n');
  downloadFile(csv, `turni_${MONTHS_IT[state.month]}_${state.year}.csv`, 'text/csv;charset=utf-8;');
}

// ---------------------------------------------------------------------------
// Export: Save/Load config JSON
// ---------------------------------------------------------------------------

function saveConfig() {
  const cfg = {
    month: state.month,
    year: state.year,
    totalNurses: state.totalNurses,
    absentNurses: state.absentNurses,
    nurses: state.nurses,
    rules: state.rules,
  };
  downloadFile(JSON.stringify(cfg, null, 2), `config_turni_${state.year}_${state.month + 1}.json`, 'application/json');
}

function loadConfig(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const cfg = JSON.parse(e.target.result);
      state.month       = cfg.month       ?? state.month;
      state.year        = cfg.year        ?? state.year;
      state.totalNurses = cfg.totalNurses ?? state.totalNurses;
      state.absentNurses = cfg.absentNurses ?? state.absentNurses;
      state.nurses      = (cfg.nurses || []).map(n => ({ ...n, tags: n.tags || [] }));
      state.rules       = { ...DEFAULT_RULES, ...cfg.rules };
      saveState();
      renderAll();
      alert('Configurazione caricata con successo.');
    } catch (_) {
      alert('Errore nel caricamento del file JSON.');
    }
  };
  reader.readAsText(file);
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Nurse count sync
// ---------------------------------------------------------------------------

function syncNurseList() {
  const active = state.totalNurses - state.absentNurses;
  // Extend list if needed
  while (state.nurses.length < state.totalNurses) {
    const i = state.nurses.length;
    state.nurses.push({
      id: genId(i),
      name: DEFAULT_NURSE_NAMES[i] || `Infermiere ${i + 1}`,
      tags: [],
    });
  }
  saveState();
  renderNurseList();
}

// ---------------------------------------------------------------------------
// Init: wire up all event listeners
// ---------------------------------------------------------------------------

function init() {
  loadState();
  applyDarkMode(state.darkMode);

  // Dark mode toggle
  document.getElementById('btn-dark')?.addEventListener('click', () => {
    state.darkMode = !state.darkMode;
    applyDarkMode(state.darkMode);
    saveState();
  });

  // Close dropdown on outside click
  document.addEventListener('click', closeDropdown);

  // ---- Step nav buttons ----
  ['btn-nav-1','btn-nav-2','btn-nav-3','btn-nav-4'].forEach((id, idx) => {
    document.getElementById(id)?.addEventListener('click', () => goToStep(idx + 1));
  });

  // ---- Step 1 ----
  const selMonth = document.getElementById('sel-month');
  if (selMonth) {
    selMonth.addEventListener('change', () => {
      state.month = parseInt(selMonth.value);
      saveState();
    });
  }
  const selYear = document.getElementById('sel-year');
  if (selYear) {
    selYear.addEventListener('change', () => {
      state.year = parseInt(selYear.value);
      saveState();
    });
  }
  const inpTotal = document.getElementById('inp-total');
  if (inpTotal) {
    inpTotal.addEventListener('change', () => {
      state.totalNurses = Math.max(1, parseInt(inpTotal.value) || 1);
      syncNurseList();
    });
  }
  const inpAbsent = document.getElementById('inp-absent');
  if (inpAbsent) {
    inpAbsent.addEventListener('change', () => {
      state.absentNurses = Math.max(0, parseInt(inpAbsent.value) || 0);
      saveState();
      renderNurseList();
    });
  }
  document.getElementById('btn-step1-next')?.addEventListener('click', () => goToStep(2));

  // ---- Step 2 ----
  document.getElementById('btn-step2-back')?.addEventListener('click', () => goToStep(1));
  document.getElementById('btn-step2-next')?.addEventListener('click', () => goToStep(3));

  // ---- Step 3 ----
  document.getElementById('btn-step3-back')?.addEventListener('click', () => goToStep(2));
  document.getElementById('btn-generate')?.addEventListener('click', startSolver);

  // ---- Step 4 ----
  document.getElementById('btn-step4-back')?.addEventListener('click', () => goToStep(3));
  document.getElementById('btn-regenerate')?.addEventListener('click', regenerateTurni);
  document.getElementById('btn-export-csv')?.addEventListener('click', exportCSV);
  document.getElementById('btn-save-config')?.addEventListener('click', saveConfig);
  document.getElementById('btn-print')?.addEventListener('click', () => window.print());
  document.getElementById('btn-load-config')?.addEventListener('click', () => {
    document.getElementById('inp-load-file')?.click();
  });
  document.getElementById('inp-load-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) loadConfig(file);
    e.target.value = '';
  });

  renderAll();
}

document.addEventListener('DOMContentLoaded', init);
