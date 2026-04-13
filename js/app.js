/**
 * @file app.js — Turni Infermieri PS
 * @description Main application logic: state management, UI rendering, wizard flow.
 * @version 1.0.0
 *
 * This is the main thread script for the nurse shift scheduling application.
 * It manages a 4-step wizard UI (Organico → Regole → Genera → Risultati),
 * communicates with the solver Web Worker, and persists state to localStorage.
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHIFT_COLORS = {
  M: 'shift-M',
  P: 'shift-P',
  D: 'shift-D',
  N: 'shift-N',
  S: 'shift-S',
  R: 'shift-R',
  F: 'shift-F',
  MA: 'shift-MA',
  L104: 'shift-L104',
  PR: 'shift-PR',
  MT: 'shift-MT',
};
const SHIFT_LABELS = {
  M: 'Mattina',
  P: 'Pomeriggio',
  D: 'Diurno',
  N: 'Notte',
  S: 'Smonto',
  R: 'Riposo',
  F: 'Ferie',
  MA: 'Malattia',
  L104: '104',
  PR: 'Perm.Retr.',
  MT: 'Maternità',
};
// Active shift hours (mutable — updated by applyFasciaOraria)
const SHIFT_HOURS = { M: 6.2, P: 6.2, D: 12.2, N: 12.2, S: 0, R: 0, F: 6.12, MA: 6.12, L104: 6.12, PR: 6.12, MT: 6.12 };
const FASCIA_PRESETS = {
  standard: { M: 6.2, P: 6.2, D: 12.2, N: 12.2, S: 0, R: 0, F: 6.12, MA: 6.12, L104: 6.12, PR: 6.12, MT: 6.12 },
  '7-10': { M: 7.2, P: 7.2, D: 12.2, N: 10.2, S: 0, R: 0, F: 7.12, MA: 7.12, L104: 7.12, PR: 7.12, MT: 7.12 },
};
const MONTHLY_HOURS_PER_WEEKDAY = 7.12;
function applyFasciaOraria(fascia) {
  const key = FASCIA_PRESETS[fascia] ? fascia : 'standard';
  Object.assign(SHIFT_HOURS, FASCIA_PRESETS[key]);
}
const DOW_LABELS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
const MONTHS_IT = [
  'Gennaio',
  'Febbraio',
  'Marzo',
  'Aprile',
  'Maggio',
  'Giugno',
  'Luglio',
  'Agosto',
  'Settembre',
  'Ottobre',
  'Novembre',
  'Dicembre',
];
const CONFIG_CSV_ABSENCE_FIELDS = [
  { key: 'ferie', startHeader: 'Ferie dal', endHeader: 'Ferie al' },
  { key: 'malattia', startHeader: 'Malattia dal', endHeader: 'Malattia al' },
  { key: '104', startHeader: '104 dal', endHeader: '104 al' },
  { key: 'permesso_retribuito', startHeader: 'Permesso retr. dal', endHeader: 'Permesso retr. al' },
  { key: 'maternita', startHeader: 'Maternità dal', endHeader: 'Maternità al' },
];
const CONFIG_CSV_PREVIOUS_TAIL_FIELDS = [
  { key: 'dayMinus3', header: 'Mese prec. -3' },
  { key: 'dayMinus2', header: 'Mese prec. -2' },
  { key: 'dayMinus1', header: 'Mese prec. -1' },
];
const ALL_SHIFT_CODES = ['M', 'P', 'D', 'N', 'S', 'R', 'F', 'MA', 'L104', 'PR', 'MT'];
const VALID_SHIFTS = new Set(ALL_SHIFT_CODES);

const DEBUG = typeof localStorage !== 'undefined' && localStorage.getItem('debug') === 'true';

const DEFAULT_NURSE_NAMES = [
  'Giorgi Bruna',
  'Aresu FRANCESCA',
  'ATZENI ELISA',
  'CABONI ILARIA',
  'CALLEDDA CARLA',
  'CAMBA LORENZA',
  'CAMBONI CINZIA',
  'CARDIA SILVIA',
  'CASU VALENTINA',
  'CARTA LUISIANA',
  'COGONI MARIA',
  'CORONGIU GIUSEPPE',
  'DEIAS DANIELA',
  'DEMARA MATTEO',
  'DETTORINO MICHELA',
  'DIANA CHIARA',
  'FENZA MARIA GRAZIA',
  'FRAU FEDERICA',
  'LOVICU MARCO',
  'MAMELI ESTER',
  'MATTANA DENISE',
  'MELIS CRISTINA',
  'MELIS FRANCESCA',
  'MILIA NICOLA',
  'PAITA DARIO',
  'PANENA NOEMI',
  'PERRA MARCO',
  'PES CIUDIA',
  'PUTZOLU MARIA ANTONIA',
  'SERRA ALESSANDRO',
  'SERRA ELISA',
  'SPANU SERGIO',
  'TUVERI FILIPPO',
  'ZANDA SILVIA',
  'MANCA ANDREA',
];

const DEFAULT_RULES = {
  minCoverageM: 6,
  maxCoverageM: 7,
  minCoverageP: 6,
  maxCoverageP: 7,
  minCoverageD: 0,
  maxCoverageD: 4,
  minCoverageN: 6,
  maxCoverageN: 6,
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
  // New flags
  coppiaTurni: null, // Array of 2 nurse indices [n1, n2] to have same shifts, or null
  consentePomeriggioDiurno: false, // Allow P→D transition
  consente2DiurniConsecutivi: false, // Allow D-D but require R after
  fasciaOraria: 'standard', // 'standard' (6+12) or '7-10' (7+10)
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

function countWeekdaysInMonth(year, month) {
  const totalDays = new Date(year, month + 1, 0).getDate();
  let weekdays = 0;
  for (let day = 1; day <= totalDays; day++) {
    const dow = new Date(year, month, day).getDay();
    if (dow >= 1 && dow <= 5) weekdays++;
  }
  return weekdays;
}

function getMonthlyContractHours(year, month) {
  return Math.round(countWeekdaysInMonth(year, month) * MONTHLY_HOURS_PER_WEEKDAY * 100) / 100;
}

function createEmptyAbsencePeriods() {
  return {
    ferie: { start: null, end: null },
    malattia: { start: null, end: null },
    104: { start: null, end: null },
    permesso_retribuito: { start: null, end: null },
    maternita: { start: null, end: null },
  };
}

function createEmptyPreviousMonthTail() {
  return [null, null, null];
}

function normalizeNullableDate(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
}

function normalizeShiftCode(value) {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return VALID_SHIFTS.has(normalized) ? normalized : null;
}

function normalizeNurse(nurse, index) {
  const absencePeriods = createEmptyAbsencePeriods();
  const sourcePeriods = nurse && nurse.absencePeriods ? nurse.absencePeriods : {};
  CONFIG_CSV_ABSENCE_FIELDS.forEach(({ key }) => {
    const period = sourcePeriods[key] || {};
    absencePeriods[key] = {
      start: normalizeNullableDate(period.start),
      end: normalizeNullableDate(period.end),
    };
  });

  const previousMonthTail = createEmptyPreviousMonthTail();
  const sourceTail = Array.isArray(nurse?.previousMonthTail) ? nurse.previousMonthTail.slice(-3) : [];
  sourceTail.forEach((shift, tailIndex) => {
    previousMonthTail[previousMonthTail.length - sourceTail.length + tailIndex] = normalizeShiftCode(shift);
  });

  return {
    ...nurse,
    id: nurse?.id || genId(index),
    name: nurse?.name?.trim() || DEFAULT_NURSE_NAMES[index] || `Infermiere ${index + 1}`,
    tags: Array.isArray(nurse?.tags) ? nurse.tags.filter(Boolean) : [],
    absencePeriods,
    previousMonthTail,
  };
}

function buildDefaultNurses(count) {
  return Array.from({ length: count }, (_, i) => normalizeNurse({}, i));
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
  solutions: [],
  selectedSolution: 0,
  solverMethod: null,
  solverDiagnostics: [],
  solverProgress: { percent: 0, message: '' },
  numSolutions: 3,
  timeBudget: 0, // 0 = auto (inferred from constraints); >0 = user-chosen seconds; -1 = until zero violations
  solverChoice: 'auto', // 'auto'|'milp'|'glpk'|'fallback'
  worker: null,
  darkMode: false,
  previousMonthSchedule: null, // 2D array [nurse][day] of shift codes from prev month
  previousMonthHours: null, // array of total hours per nurse from prev month
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function saveState() {
  try {
    const s = { ...state, worker: null, schedule: state.schedule, solutions: [] };
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
    // Re-hydrate nurses (ensure tags array and absencePeriods)
    state.nurses = (saved.nurses || []).map((n, index) => normalizeNurse(n, index));
    // Apply fascia oraria to update SHIFT_HOURS in main thread
    applyFasciaOraria(state.rules.fasciaOraria);
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
  renderGenerateStep();
  renderStep4();
  applyDarkMode(state.darkMode);
}

function showOnlyStep(step) {
  for (let i = 1; i <= 5; i++) {
    const el = document.getElementById(`step-${i}`);
    if (el) el.classList.toggle('hidden', i !== step);
  }
}

// ---------------------------------------------------------------------------
// Step Nav
// ---------------------------------------------------------------------------

function renderStepNav() {
  showOnlyStep(state.step);
  const steps = [1, 2, 3, 4, 5];
  steps.forEach(i => {
    const ind = document.getElementById(`btn-nav-${i}`);
    if (!ind) return;
    ind.className = 'step-indicator ' + (i < state.step ? 'done' : i === state.step ? 'active' : 'pending');
    if (i < state.step) ind.innerHTML = '✓';
    else ind.textContent = i;

    const conn = document.getElementById(`step-conn-${i}`);
    if (conn) conn.className = 'step-connector ' + (i < state.step ? 'done' : '');
  });

  // Nav buttons
  ['btn-nav-1', 'btn-nav-2', 'btn-nav-3', 'btn-nav-4', 'btn-nav-5'].forEach((id, idx) => {
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

  // Absence types that need period selection
  const absenceTypes = [
    { key: 'ferie', label: 'Ferie', shiftCode: 'F' },
    { key: 'malattia', label: 'Malattia', shiftCode: 'MA' },
    { key: '104', label: '104', shiftCode: 'L104' },
    { key: 'permesso_retribuito', label: 'Permesso retribuito', shiftCode: 'PR' },
    { key: 'maternita', label: 'Maternità', shiftCode: 'MT' },
  ];

  activeNurses.forEach((nurse, idx) => {
    // Ensure nurse has absencePeriods initialized
    if (!nurse.absencePeriods) {
      nurse.absencePeriods = createEmptyAbsencePeriods();
    }

    const item = document.createElement('div');
    item.className = 'nurse-item';
    item.dataset.idx = idx;
    item.draggable = true;

    const tagDefs = [
      { key: 'solo_mattine', label: 'Solo mattine feriali', cls: 'tag-solo_mattine', isAbsence: false },
      {
        key: 'quattro_mattine_venerdi_notte',
        label: '4 mattine + notte ven.',
        cls: 'tag-quattro_mattine_venerdi_notte',
        isAbsence: false,
      },
      { key: 'mattine_e_pomeriggi', label: 'Mattine e Pomeriggi', cls: 'tag-mattine_e_pomeriggi', isAbsence: false },
      { key: 'solo_diurni', label: 'Solo diurni 12h', cls: 'tag-solo_diurni', isAbsence: false },
      { key: 'solo_notti', label: 'Solo notti', cls: 'tag-solo_notti', isAbsence: false },
      { key: 'diurni_e_notturni', label: 'Diurni e Notturni', cls: 'tag-diurni_e_notturni', isAbsence: false },
      { key: 'no_notti', label: 'No notti', cls: 'tag-no_notti', isAbsence: false },
      { key: 'diurni_no_notti', label: 'Sì diurni, no notti', cls: 'tag-diurni_no_notti', isAbsence: false },
      { key: 'no_diurni', label: 'No diurni 12h', cls: 'tag-no_diurni', isAbsence: false },
      { key: 'ferie', label: 'Ferie', cls: 'tag-ferie', isAbsence: true },
      { key: 'malattia', label: 'Malattia', cls: 'tag-malattia', isAbsence: true },
      { key: '104', label: '104', cls: 'tag-104', isAbsence: true },
      { key: 'permesso_retribuito', label: 'Permesso retribuito', cls: 'tag-permesso_retribuito', isAbsence: true },
      { key: 'maternita', label: 'Maternità', cls: 'tag-maternita', isAbsence: true },
    ];

    const tagsHTML = tagDefs
      .map(t => {
        const active = nurse.tags.includes(t.key);
        return `<button class="tag ${t.cls} ${active ? 'active' : 'inactive'}"
                data-nurse="${idx}" data-tag="${t.key}"
                title="${t.label}">${t.label}</button>`;
      })
      .join('');

    // Build absence period inputs for active absence tags
    let absencePeriodsHTML = '';
    tagDefs
      .filter(t => t.isAbsence && nurse.tags.includes(t.key))
      .forEach(t => {
        const period = nurse.absencePeriods[t.key] || { start: null, end: null };
        absencePeriodsHTML += `
        <div class="absence-period mt-2 p-2 bg-gray-50 dark:bg-slate-800 rounded-lg text-xs" data-nurse="${idx}" data-type="${t.key}">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-semibold ${t.cls.replace('tag-', 'text-')}">${t.label}:</span>
            <label class="flex items-center gap-1">
              Dal: <input type="date" class="absence-start border rounded px-1 py-0.5 text-xs bg-white dark:bg-slate-700 dark:border-slate-600" 
                     data-nurse="${idx}" data-type="${t.key}" value="${period.start || ''}" />
            </label>
            <label class="flex items-center gap-1">
              Al: <input type="date" class="absence-end border rounded px-1 py-0.5 text-xs bg-white dark:bg-slate-700 dark:border-slate-600"
                   data-nurse="${idx}" data-type="${t.key}" value="${period.end || ''}" />
            </label>
            <span class="text-gray-500">(6.12 ore/giorno)</span>
          </div>
        </div>
      `;
      });

    item.innerHTML = `
      <div class="flex items-center gap-2 w-full">
        <span class="drag-handle" title="Trascina per riordinare">⠿</span>
        <span class="flex-1 text-sm font-medium nurse-name"
              contenteditable="true"
              data-nurse="${idx}"
              spellcheck="false">${escHtml(nurse.name)}</span>
        <div class="flex flex-wrap gap-1">${tagsHTML}</div>
      </div>
      ${absencePeriodsHTML}
    `;

    container.appendChild(item);

    // Contenteditable name editing
    const nameEl = item.querySelector('.nurse-name');
    nameEl.addEventListener('blur', () => {
      state.nurses[idx].name = nameEl.textContent.trim() || `Infermiere ${idx + 1}`;
      saveState();
    });
    nameEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        nameEl.blur();
      }
    });

    // Tag toggle
    item.querySelectorAll('.tag').forEach(tagBtn => {
      tagBtn.addEventListener('click', () => {
        const nIdx = parseInt(tagBtn.dataset.nurse);
        const tKey = tagBtn.dataset.tag;
        const tags = state.nurses[nIdx].tags;
        const pos = tags.indexOf(tKey);
        if (pos >= 0) tags.splice(pos, 1);
        else tags.push(tKey);
        saveState();
        renderNurseList();
      });
    });

    // Absence period date inputs
    item.querySelectorAll('.absence-start').forEach(inp => {
      inp.addEventListener('change', () => {
        const nIdx = parseInt(inp.dataset.nurse);
        const type = inp.dataset.type;
        if (!state.nurses[nIdx].absencePeriods) {
          state.nurses[nIdx].absencePeriods = {};
        }
        if (!state.nurses[nIdx].absencePeriods[type]) {
          state.nurses[nIdx].absencePeriods[type] = { start: null, end: null };
        }
        state.nurses[nIdx].absencePeriods[type].start = inp.value || null;
        saveState();
      });
    });

    item.querySelectorAll('.absence-end').forEach(inp => {
      inp.addEventListener('change', () => {
        const nIdx = parseInt(inp.dataset.nurse);
        const type = inp.dataset.type;
        if (!state.nurses[nIdx].absencePeriods) {
          state.nurses[nIdx].absencePeriods = {};
        }
        if (!state.nurses[nIdx].absencePeriods[type]) {
          state.nurses[nIdx].absencePeriods[type] = { start: null, end: null };
        }
        state.nurses[nIdx].absencePeriods[type].end = inp.value || null;
        saveState();
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
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Normalize diagnostics received from the worker so the UI can render them
 * consistently. Duplicate entries are removed using a composite key built from
 * source, phase, code, userMessage, and detail.
 * @param {object[]} diagnostics
 * @returns {object[]}
 */
function normalizeDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics)) return [];
  const seen = new Set();
  return diagnostics
    .filter(diag => diag && diag.userMessage)
    .map(diag => ({
      source: diag.source || 'solver',
      phase: diag.phase || 'solve',
      code: diag.code || 'unknown',
      severity: diag.severity || 'warning',
      userMessage: diag.userMessage,
      detail: diag.detail || '',
      status: diag.status || '',
    }))
    .filter(diag => {
      const key = [diag.source, diag.phase, diag.code, diag.userMessage, diag.detail].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function sourceLabel(source) {
  if (source === 'highs') return 'HiGHS';
  if (source === 'glpk') return 'GLPK';
  if (source === 'worker') return 'Worker';
  return 'Solver';
}

function worstDiagnosticSeverity(diagnostics) {
  if ((diagnostics || []).some(diag => diag.severity === 'error')) return 'error';
  if ((diagnostics || []).some(diag => diag.severity === 'warning')) return 'warning';
  return 'info';
}

function renderDiagnosticsPanel(elementId, diagnostics) {
  const panel = document.getElementById(elementId);
  if (!panel) return;
  const normalized = normalizeDiagnostics(diagnostics).filter(diag => diag.severity !== 'info');
  if (normalized.length === 0) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }

  const severity = worstDiagnosticSeverity(normalized);
  const theme =
    severity === 'error'
      ? {
          box: 'bg-red-50 dark:bg-red-950 border-red-300 dark:border-red-700',
          title: 'text-red-700 dark:text-red-400',
          text: 'text-red-600 dark:text-red-300',
          icon: '❌',
          heading: 'Diagnostica solver',
        }
      : {
          box: 'bg-amber-50 dark:bg-amber-950 border-amber-300 dark:border-amber-700',
          title: 'text-amber-700 dark:text-amber-400',
          text: 'text-amber-700 dark:text-amber-300',
          icon: '⚠️',
          heading: 'Avvisi solver',
        };

  panel.classList.remove('hidden');
  panel.innerHTML = `<div class="p-3 border rounded-lg ${theme.box}">
      <p class="font-semibold text-sm ${theme.title}">${theme.icon} ${theme.heading}</p>
      <div class="mt-2 space-y-2">
        ${normalized
          .map(
            diag => `<div>
              <p class="text-sm ${theme.text}"><strong>${sourceLabel(diag.source)}:</strong> ${escHtml(diag.userMessage)}</p>
              ${
                diag.detail
                  ? `<p class="text-xs text-gray-600 dark:text-slate-400 mt-0.5">${escHtml(diag.detail)}</p>`
                  : ''
              }
            </div>`
          )
          .join('')}
      </div>
    </div>`;
}

function updateSolverProgress(percent, message) {
  // Progress state is the source of truth so the same message can be re-rendered
  // after step changes or late worker updates, even if the DOM is not visible yet.
  state.solverProgress = { percent: percent || 0, message: message || '' };
  const bar = document.getElementById('progress-bar');
  const msg = document.getElementById('progress-msg');
  if (bar) bar.style.width = `${state.solverProgress.percent}%`;
  if (msg) msg.textContent = state.solverProgress.message;
}

function setSolverDiagnostics(diagnostics) {
  state.solverDiagnostics = normalizeDiagnostics(diagnostics);
  renderDiagnosticsPanel('solver-run-feedback', state.solverDiagnostics);
  renderDiagnosticsPanel('solver-diagnostics-banner', state.solverDiagnostics);
}

function resetSolverFeedback() {
  updateSolverProgress(0, '');
  setSolverDiagnostics([]);
}

function applySolveResult(data) {
  console.log(
    `[App] Applicazione risultato solver: ${data.solutions?.length || 0} soluzioni, metodo="${data.solverMethod}"`
  );
  state.solutions = data.solutions || [];
  state.selectedSolution = 0;
  state.solverMethod = data.solverMethod || null;
  setSolverDiagnostics(data.diagnostics || []);
  if (state.solutions.length > 0) {
    const best = state.solutions[0];
    state.schedule = best.schedule;
    state.violations = best.violations || [];
    state.stats = best.stats || [];
  } else {
    state.schedule = data.schedule;
    state.violations = data.violations || [];
    state.stats = data.stats || [];
  }
}

/**
 * Build a structured diagnostic array for a Worker runtime error in the main
 * thread UI. `actionLabel` should be a user-facing phrase such as
 * "la generazione" or "la rigenerazione".
 * @param {ErrorEvent} err
 * @param {string} actionLabel
 * @returns {object[]}
 */
function buildWorkerRuntimeDiagnostic(err, actionLabel) {
  return [
    {
      source: 'worker',
      phase: 'runtime',
      code: 'worker_error',
      severity: 'error',
      userMessage: `Worker error durante ${actionLabel}`,
      detail: err?.message || 'Errore sconosciuto nel worker',
    },
  ];
}

// ---------------------------------------------------------------------------
// Step 2 — Regole
// ---------------------------------------------------------------------------

function renderStep2() {
  const r = state.rules;

  // Coverage sliders - Mattina
  bindRange('sl-min-cov-m', 'val-min-cov-m', r.minCoverageM, v => {
    state.rules.minCoverageM = v;
    saveState();
  });
  bindRange('sl-max-cov-m', 'val-max-cov-m', r.maxCoverageM, v => {
    state.rules.maxCoverageM = v;
    saveState();
  });

  // Coverage sliders - Pomeriggio
  bindRange('sl-min-cov-p', 'val-min-cov-p', r.minCoverageP, v => {
    state.rules.minCoverageP = v;
    saveState();
  });
  bindRange('sl-max-cov-p', 'val-max-cov-p', r.maxCoverageP, v => {
    state.rules.maxCoverageP = v;
    saveState();
  });

  // Coverage sliders - Diurno
  bindRange('sl-min-cov-d', 'val-min-cov-d', r.minCoverageD, v => {
    state.rules.minCoverageD = v;
    saveState();
  });
  bindRange('sl-max-cov-d', 'val-max-cov-d', r.maxCoverageD, v => {
    state.rules.maxCoverageD = v;
    saveState();
  });

  // Coverage sliders - Notte
  bindRange('sl-min-cov-n', 'val-min-cov-n', r.minCoverageN, v => {
    state.rules.minCoverageN = v;
    saveState();
  });
  bindRange('sl-max-cov-n', 'val-max-cov-n', r.maxCoverageN, v => {
    state.rules.maxCoverageN = v;
    saveState();
  });

  // Hours
  bindRange('sl-target-hours', 'val-target-hours', r.targetHours, v => {
    state.rules.targetHours = v;
    saveState();
  });
  bindRange('sl-min-hours', 'val-min-hours', r.minHours, v => {
    state.rules.minHours = v;
    saveState();
  });
  bindRange('sl-max-hours', 'val-max-hours', r.maxHours, v => {
    state.rules.maxHours = v;
    saveState();
  });

  // Nights
  bindRange('sl-target-nights', 'val-target-nights', r.targetNights, v => {
    state.rules.targetNights = v;
    saveState();
  });
  bindRange('sl-max-nights', 'val-max-nights', r.maxNights, v => {
    state.rules.maxNights = v;
    saveState();
  });
  bindRange('sl-hard-nights', 'val-hard-nights', r.hardMaxNights, v => {
    state.rules.hardMaxNights = v;
    saveState();
  });

  // Toggles
  bindToggle('tog-no-consec-d', r.noConsecD, v => {
    state.rules.noConsecD = v;
    saveState();
  });
  bindToggle('tog-mandatory-s', r.mandatoryS, v => {
    state.rules.mandatoryS = v;
    saveState();
  });
  bindToggle('tog-min-gap', r.minGap11h, v => {
    state.rules.minGap11h = v;
    saveState();
  });
  bindToggle('tog-forward-only', r.forwardOnly, v => {
    state.rules.forwardOnly = v;
    saveState();
  });
  bindToggle('tog-min-r-week', r.minRPerWeek > 0, v => {
    state.rules.minRPerWeek = v ? 2 : 0;
    saveState();
  });

  // New toggles for additional rules
  bindToggle('tog-consente-pom-diurno', r.consentePomeriggioDiurno, v => {
    state.rules.consentePomeriggioDiurno = v;
    saveState();
  });
  bindToggle('tog-consente-2d', r.consente2DiurniConsecutivi, v => {
    state.rules.consente2DiurniConsecutivi = v;
    saveState();
  });

  // Fascia oraria radio buttons
  const radios = document.querySelectorAll('input[name="fascia-oraria"]');
  radios.forEach(radio => {
    radio.checked = radio.value === (r.fasciaOraria || 'standard');
    radio.onchange = () => {
      state.rules.fasciaOraria = radio.value;
      applyFasciaOraria(radio.value);
      saveState();
    };
  });

  // Nurse pairing dropdown
  renderNursePairingDropdown();

  // Previous month status
  renderPrevMonthStatus();
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

// Helper function to render nurse pairing dropdowns
function renderNursePairingDropdown() {
  const sel1 = document.getElementById('sel-coppia-1');
  const sel2 = document.getElementById('sel-coppia-2');
  if (!sel1 || !sel2) return;

  const activeNurses = state.nurses.slice(0, state.totalNurses - state.absentNurses);

  // Build options
  let optionsHtml = '<option value="">-- Nessuno --</option>';
  activeNurses.forEach((nurse, idx) => {
    optionsHtml += `<option value="${idx}">${escHtml(nurse.name)}</option>`;
  });

  sel1.innerHTML = optionsHtml;
  sel2.innerHTML = optionsHtml;

  // Set current values
  if (state.rules.coppiaTurni && Array.isArray(state.rules.coppiaTurni) && state.rules.coppiaTurni.length === 2) {
    sel1.value = state.rules.coppiaTurni[0];
    sel2.value = state.rules.coppiaTurni[1];
  }

  // Event handlers
  sel1.onchange = sel2.onchange = () => {
    const v1 = sel1.value;
    const v2 = sel2.value;
    const n1 = parseInt(v1, 10);
    const n2 = parseInt(v2, 10);
    if (v1 !== '' && v2 !== '' && !isNaN(n1) && !isNaN(n2) && n1 !== n2) {
      state.rules.coppiaTurni = [n1, n2];
    } else {
      state.rules.coppiaTurni = null;
    }
    saveState();
  };
}

// ---------------------------------------------------------------------------
// Previous month schedule import
// ---------------------------------------------------------------------------

/**
 * Render the status of previous month import in Step 2.
 */
function renderPrevMonthStatus() {
  const statusEl = document.getElementById('prev-month-status');
  const deltasEl = document.getElementById('prev-month-deltas');
  if (!statusEl || !deltasEl) return;

  if (!state.previousMonthSchedule || !state.previousMonthHours) {
    statusEl.innerHTML =
      '<span class="text-gray-400 dark:text-slate-500">Nessun dato del mese precedente importato.</span>';
    deltasEl.classList.add('hidden');
    return;
  }

  const numNurses = state.previousMonthSchedule.length;
  const numDays = state.previousMonthSchedule[0]?.length || 0;
  statusEl.innerHTML = `<span class="text-green-600 dark:text-green-400 font-semibold">✅ Importati turni di ${numNurses} infermieri × ${numDays} giorni</span>`;

  const deltas = computePrevMonthDeltas();
  if (!deltas || Object.keys(deltas).length === 0) {
    deltasEl.classList.add('hidden');
    return;
  }

  deltasEl.classList.remove('hidden');
  const activeNurses = state.nurses.slice(0, state.totalNurses - state.absentNurses);
  let html =
    '<div class="mt-2 p-3 bg-indigo-50 dark:bg-indigo-950 border border-indigo-200 dark:border-indigo-800 rounded-lg max-h-48 overflow-y-auto">';
  html +=
    '<p class="text-xs font-semibold text-indigo-700 dark:text-indigo-300 mb-2">📊 Scostamento ore rispetto alla media del mese precedente:</p>';
  html += '<div class="grid grid-cols-2 sm:grid-cols-3 gap-1">';
  for (let n = 0; n < activeNurses.length; n++) {
    const name = activeNurses[n].name;
    const d = deltas[name];
    if (d === undefined) continue;
    const color =
      d > 0
        ? 'text-red-600 dark:text-red-400'
        : d < 0
          ? 'text-blue-600 dark:text-blue-400'
          : 'text-gray-500 dark:text-slate-400';
    const sign = d > 0 ? '+' : '';
    const label = d > 0 ? '(meno ore prossimo mese)' : d < 0 ? '(più ore prossimo mese)' : '';
    html += `<div class="text-xs"><span class="font-medium">${escHtml(name)}:</span> <span class="${color}">${sign}${d}h</span> <span class="text-gray-400 text-[10px]">${label}</span></div>`;
  }
  html += '</div></div>';
  deltasEl.innerHTML = html;
}

function getImportedPrevMonthTailForNurse(nurseIdx, tailDays = 5) {
  const row = state.previousMonthSchedule?.[nurseIdx];
  if (!Array.isArray(row) || row.length === 0) return null;
  const tail = row.slice(-tailDays).map(shift => normalizeShiftCode(shift));
  return tail.some(Boolean) ? tail : null;
}

function getManualPreviousMonthTailForNurse(nurse) {
  const tail = createEmptyPreviousMonthTail();
  const sourceTail = Array.isArray(nurse?.previousMonthTail) ? nurse.previousMonthTail.slice(-3) : [];
  sourceTail.forEach((shift, tailIndex) => {
    tail[tail.length - sourceTail.length + tailIndex] = normalizeShiftCode(shift);
  });
  return tail;
}

function getContinuitySummary() {
  const activeNurses = state.nurses.slice(0, state.totalNurses - state.absentNurses);
  const manualCount = activeNurses.filter(nurse => getManualPreviousMonthTailForNurse(nurse).some(Boolean)).length;
  const importedCount = activeNurses.filter((_, nurseIdx) => getImportedPrevMonthTailForNurse(nurseIdx)).length;
  return {
    manualCount,
    importedCount,
    hasAny: manualCount > 0 || importedCount > 0,
  };
}

function continuitySummaryLabel() {
  const summary = getContinuitySummary();
  if (!summary.hasAny) return '— Non configurata';
  const parts = [];
  if (summary.manualCount > 0) parts.push(`${summary.manualCount} manuali`);
  if (summary.importedCount > 0) parts.push(`${summary.importedCount} da CSV mese prec.`);
  return `✅ ${parts.join(' · ')}`;
}

/**
 * Parse pasted CSV text into previous month schedule data.
 * Expected format: each row is "Name;shift1;shift2;...;shiftN[;ore;D;N;WE]"
 * Supports both semicolon and comma separators. Header row is auto-detected and skipped.
 */
function parsePrevMonthCSV(text) {
  const { rows } = parseCsvText(text);
  if (rows.length === 0) return { error: 'Nessun dato trovato.' };

  // Skip header row if first cell looks like a header
  let startIdx = 0;
  const firstCells = rows[0].map(c => c.trim());
  if (
    firstCells[0].toLowerCase().includes('infermiere') ||
    firstCells[0].toLowerCase().includes('nome') ||
    firstCells[0].toLowerCase() === 'name'
  ) {
    startIdx = 1;
  }

  const activeNurses = state.nurses.slice(0, state.totalNurses - state.absentNurses);
  const scheduleData = [];
  const hoursData = [];
  const matched = [];

  for (let i = startIdx; i < rows.length; i++) {
    const cells = rows[i].map(c => c.trim());
    if (cells.length < 2) continue;

    const name = cells[0];
    // Extract shift cells — stop when we hit a non-shift value (stats columns)
    const shifts = [];
    for (let j = 1; j < cells.length; j++) {
      const val = cells[j].toUpperCase().trim();
      if (VALID_SHIFTS.has(val)) {
        shifts.push(val);
      } else if (shifts.length > 0) {
        break; // Hit stats columns
      }
    }

    if (shifts.length === 0) continue;

    // Match to active nurse by name
    const nurseIdx = activeNurses.findIndex(n => n.name.toLowerCase().trim() === name.toLowerCase().trim());

    scheduleData.push({ name, shifts, nurseIdx });
    // Compute hours from shifts
    let h = 0;
    for (const s of shifts) h += SHIFT_HOURS[s] || 0;
    hoursData.push(Math.round(h * 10) / 10);
    matched.push(nurseIdx >= 0);
  }

  if (scheduleData.length === 0) return { error: 'Nessun turno valido trovato nel CSV.' };

  // Check that all rows have the same number of days
  const numDays = scheduleData[0].shifts.length;
  const inconsistent = scheduleData.some(r => r.shifts.length !== numDays);
  if (inconsistent) return { error: 'Le righe hanno un numero diverso di giorni. Verifica il formato.' };

  const matchedCount = matched.filter(Boolean).length;

  return { scheduleData, hoursData, numDays, matchedCount, total: scheduleData.length };
}

function getConfigPayload() {
  return {
    month: state.month,
    year: state.year,
    totalNurses: state.totalNurses,
    absentNurses: state.absentNurses,
    nurses: state.nurses.map((nurse, index) => normalizeNurse(nurse, index)),
    rules: { ...DEFAULT_RULES, ...state.rules },
  };
}

function resetGeneratedResults() {
  state.schedule = null;
  state.violations = [];
  state.stats = [];
  state.solutions = [];
  state.selectedSolution = 0;
  state.solverMethod = null;
  state.solverDiagnostics = [];
  state.solverProgress = { percent: 0, message: '' };
}

function applyConfigPayload(cfg) {
  if (cfg.month !== undefined) state.month = Math.max(0, Math.min(11, parseInt(cfg.month) || 0));
  if (cfg.year !== undefined) state.year = Math.max(2020, parseInt(cfg.year) || state.year);

  const explicitTotalNurses = cfg.totalNurses !== undefined ? Math.max(1, parseInt(cfg.totalNurses, 10) || 1) : null;

  const importedNurses =
    Array.isArray(cfg.nurses) && cfg.nurses.length > 0
      ? cfg.nurses.map((nurse, index) => normalizeNurse(nurse, index))
      : null;
  const cappedImportedNurses =
    importedNurses && explicitTotalNurses !== null ? importedNurses.slice(0, explicitTotalNurses) : importedNurses;
  if (importedNurses) {
    state.nurses = cappedImportedNurses;
  }

  if (explicitTotalNurses !== null) {
    state.totalNurses = explicitTotalNurses;
  } else if (importedNurses) {
    state.totalNurses = importedNurses.length;
  }

  while (state.nurses.length < state.totalNurses) {
    state.nurses.push(normalizeNurse({}, state.nurses.length));
  }
  if (state.nurses.length > state.totalNurses) {
    state.nurses = state.nurses.slice(0, state.totalNurses);
  }

  if (cfg.absentNurses !== undefined) {
    state.absentNurses = Math.max(0, parseInt(cfg.absentNurses) || 0);
  }
  state.absentNurses = Math.min(state.absentNurses, state.totalNurses);

  state.rules = { ...DEFAULT_RULES, ...(cfg.rules || state.rules) };
  const activeCount = Math.max(0, state.totalNurses - state.absentNurses);
  if (
    !Array.isArray(state.rules.coppiaTurni) ||
    state.rules.coppiaTurni.length !== 2 ||
    state.rules.coppiaTurni.some(idx => !Number.isInteger(idx) || idx < 0 || idx >= activeCount)
  ) {
    state.rules.coppiaTurni = null;
  }

  applyFasciaOraria(state.rules.fasciaOraria);
  resetGeneratedResults();
  saveState();
  renderAll();
}

function serializeConfigRuleValue(key, value) {
  if (key === 'coppiaTurni') return Array.isArray(value) ? value.join(',') : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value ?? '';
}

function parseConfigRuleValue(key, rawValue) {
  const value = String(rawValue ?? '').trim();
  const defaultValue = DEFAULT_RULES[key];
  if (key === 'coppiaTurni') {
    if (!value) return null;
    const pair = value
      .split(/[|,]/)
      .map(part => parseInt(part.trim(), 10))
      .filter(Number.isInteger);
    return pair.length === 2 ? pair : null;
  }
  if (typeof defaultValue === 'boolean') {
    return ['true', '1', 'si', 'sì'].includes(value.toLowerCase());
  }
  if (typeof defaultValue === 'number') {
    const num = Number(value);
    return Number.isFinite(num) ? num : defaultValue;
  }
  if (typeof defaultValue === 'string') {
    return value || defaultValue;
  }
  return value;
}

function normalizeCsvHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function buildConfigCsvRows(cfg) {
  const rows = [
    [
      'Sezione',
      'Chiave',
      'Valore',
      'Ordine',
      'Nome',
      'Tag',
      ...CONFIG_CSV_ABSENCE_FIELDS.flatMap(field => [field.startHeader, field.endHeader]),
      ...CONFIG_CSV_PREVIOUS_TAIL_FIELDS.map(field => field.header),
    ],
  ];
  const emptyNurseCells = new Array(CONFIG_CSV_ABSENCE_FIELDS.length * 2 + CONFIG_CSV_PREVIOUS_TAIL_FIELDS.length).fill(
    ''
  );

  [
    ['month', cfg.month],
    ['year', cfg.year],
    ['totalNurses', cfg.totalNurses],
    ['absentNurses', cfg.absentNurses],
  ].forEach(([key, value]) => {
    rows.push(['meta', key, value, '', '', '', ...emptyNurseCells]);
  });

  Object.keys(DEFAULT_RULES).forEach(key => {
    rows.push(['vincolo', key, serializeConfigRuleValue(key, cfg.rules[key]), '', '', '', ...emptyNurseCells]);
  });

  cfg.nurses.forEach((nurse, index) => {
    const normalizedNurse = normalizeNurse(nurse, index);
    rows.push([
      'infermiere',
      '',
      '',
      index + 1,
      normalizedNurse.name,
      normalizedNurse.tags.join(','),
      ...CONFIG_CSV_ABSENCE_FIELDS.flatMap(field => [
        normalizedNurse.absencePeriods[field.key]?.start || '',
        normalizedNurse.absencePeriods[field.key]?.end || '',
      ]),
      ...normalizedNurse.previousMonthTail.map(shift => shift || ''),
    ]);
  });

  return rows;
}

function exportConfigCSV() {
  const csv = formatCsv(buildConfigCsvRows(getConfigPayload()));
  downloadFile(csv, `config_turni_${state.year}_${state.month + 1}.csv`, 'text/csv;charset=utf-8;');
}

function parseConfigCSV(text) {
  const { rows } = parseCsvText(text);
  if (rows.length === 0) return { error: 'Nessun dato trovato nel CSV.' };

  const headerMap = new Map(rows[0].map((header, index) => [normalizeCsvHeader(header), index]));
  const sectionIdx = headerMap.get('sezione') ?? headerMap.get('section');
  if (sectionIdx === undefined) {
    return { error: 'Formato CSV non riconosciuto. Usa il file esportato dall’app.' };
  }

  const keyIdx = headerMap.get('chiave') ?? headerMap.get('key');
  const valueIdx = headerMap.get('valore') ?? headerMap.get('value');
  const orderIdx = headerMap.get('ordine') ?? headerMap.get('order');
  const nameIdx = headerMap.get('nome') ?? headerMap.get('name');
  const tagIdx = headerMap.get('tag') ?? headerMap.get('tags');
  const nurseRows = [];
  const cfg = { nurses: [] };
  let hasData = false;
  let hasRules = false;

  const getCell = (row, idx) => (idx === undefined ? '' : String(row[idx] ?? '').trim());

  rows.slice(1).forEach((row, fallbackIndex) => {
    const section = getCell(row, sectionIdx).toLowerCase();
    if (!section) return;

    if (section === 'meta') {
      const key = getCell(row, keyIdx);
      const value = getCell(row, valueIdx);
      if (['month', 'year', 'totalNurses', 'absentNurses'].includes(key)) {
        cfg[key] = parseInt(value, 10);
        hasData = true;
      }
      return;
    }

    if (section === 'vincolo' || section === 'rule' || section === 'regola') {
      const key = getCell(row, keyIdx);
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_RULES, key)) return;
      if (!cfg.rules) cfg.rules = {};
      cfg.rules[key] = parseConfigRuleValue(key, getCell(row, valueIdx));
      hasData = true;
      hasRules = true;
      return;
    }

    if (section === 'infermiere' || section === 'nurse') {
      const name = getCell(row, nameIdx);
      if (!name) return;
      const tags = getCell(row, tagIdx)
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean);
      const absencePeriods = createEmptyAbsencePeriods();
      const previousMonthTail = createEmptyPreviousMonthTail();
      CONFIG_CSV_ABSENCE_FIELDS.forEach(field => {
        const startIdx = headerMap.get(normalizeCsvHeader(field.startHeader));
        const endIdx = headerMap.get(normalizeCsvHeader(field.endHeader));
        absencePeriods[field.key] = {
          start: normalizeNullableDate(getCell(row, startIdx)),
          end: normalizeNullableDate(getCell(row, endIdx)),
        };
        if ((absencePeriods[field.key].start || absencePeriods[field.key].end) && !tags.includes(field.key)) {
          tags.push(field.key);
        }
      });
      CONFIG_CSV_PREVIOUS_TAIL_FIELDS.forEach((field, tailIdx) => {
        const cellIdx = headerMap.get(normalizeCsvHeader(field.header));
        previousMonthTail[tailIdx] = normalizeShiftCode(getCell(row, cellIdx));
      });
      const rawOrder = parseInt(getCell(row, orderIdx), 10);
      nurseRows.push({
        order: Number.isInteger(rawOrder) ? rawOrder : fallbackIndex + 1,
        nurse: normalizeNurse({ name, tags, absencePeriods, previousMonthTail }, fallbackIndex),
      });
      hasData = true;
    }
  });

  if (!hasData) return { error: 'Nessuna configurazione valida trovata nel CSV.' };

  if (nurseRows.length > 0) {
    cfg.nurses = nurseRows.sort((a, b) => a.order - b.order).map(entry => entry.nurse);
    if (cfg.totalNurses === undefined || Number.isNaN(cfg.totalNurses)) {
      cfg.totalNurses = cfg.nurses.length;
    }
  } else {
    delete cfg.nurses;
  }
  if (!hasRules) delete cfg.rules;

  Object.keys(cfg).forEach(key => {
    if (Number.isNaN(cfg[key])) delete cfg[key];
  });

  return { config: cfg };
}

/**
 * Import parsed CSV data into state, mapping nurses by name order.
 */
function importPrevMonthData(scheduleData) {
  const activeNurses = state.nurses.slice(0, state.totalNurses - state.absentNurses);
  const numDays = scheduleData[0].shifts.length;

  // Build schedule and hours arrays aligned to active nurses order
  const schedule = [];
  const hours = [];

  for (let n = 0; n < activeNurses.length; n++) {
    const entry = scheduleData.find(r => r.name.toLowerCase().trim() === activeNurses[n].name.toLowerCase().trim());
    if (entry) {
      schedule.push([...entry.shifts]);
      let h = 0;
      for (const s of entry.shifts) h += SHIFT_HOURS[s] || 0;
      hours.push(Math.round(h * 10) / 10);
    } else {
      // No match — fill with nulls (will be ignored in delta computation)
      schedule.push(new Array(numDays).fill(null));
      hours.push(null);
    }
  }

  state.previousMonthSchedule = schedule;
  state.previousMonthHours = hours;
  saveState();
}

function clearPrevMonth() {
  state.previousMonthSchedule = null;
  state.previousMonthHours = null;
  saveState();
  renderPrevMonthStatus();
}

function parseCsvLine(line, separator) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === separator && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  cells.push(current);
  return cells;
}

function parseCsvText(text) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(line => line.trim().length > 0);
  if (lines.length === 0) return { separator: ';', rows: [] };
  const separator = lines[0].includes(';') ? ';' : ',';
  return { separator, rows: lines.map(line => parseCsvLine(line, separator)) };
}

function formatCsvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function formatCsv(rows) {
  return '\uFEFF' + rows.map(row => row.map(formatCsvCell).join(';')).join('\r\n');
}

// ---------------------------------------------------------------------------
// Previous month hour deltas
// ---------------------------------------------------------------------------

/**
 * Compute per-nurse hour deltas from the previous month schedule.
 * Returns an object mapping nurse name → delta (actual - imported-month average).
 * Positive delta means nurse worked MORE than the roster average
 * (should work less next month). Negative delta means nurse worked LESS
 * than average (should work more next month).
 *
 * Using deviations from the imported month average keeps the compensation
 * zero-sum, so the next month rebalances only relative inequities instead of
 * shifting the whole roster above/below the new month's achievable total hours.
 */
function computePrevMonthDeltas() {
  if (!state.previousMonthSchedule || !state.previousMonthHours) return null;
  const activeNurses = state.nurses.slice(0, state.totalNurses - state.absentNurses);
  const knownHours = state.previousMonthHours.filter(h => h !== undefined && h !== null);
  if (knownHours.length === 0) return null;
  const avgHours = knownHours.reduce((sum, h) => sum + h, 0) / knownHours.length;
  const deltas = {};
  for (let n = 0; n < activeNurses.length; n++) {
    const name = activeNurses[n].name;
    const h = state.previousMonthHours[n];
    if (h !== undefined && h !== null) {
      deltas[name] = Math.round((h - avgHours) * 10) / 10;
    }
  }
  return deltas;
}

/**
 * Build hourDeltas array for active nurses to pass to solver.
 * Each entry is the hour adjustment: negative means nurse should work more this month.
 */
function buildHourDeltas() {
  const deltas = computePrevMonthDeltas();
  if (!deltas) return null;
  const activeNurses = state.nurses.slice(0, state.totalNurses - state.absentNurses);
  // Negate: if nurse worked +5h MORE than the imported-month average
  // (positive delta from computePrevMonthDeltas), they should work LESS this
  // month → solver needs a negative adjustment (hourDeltas = -5).
  // The solver interprets positive hourDeltas as "nurse should work more hours".
  const hourDeltas = activeNurses.map(n => -(deltas[n.name] || 0));
  // Only return if at least one delta is nonzero
  if (hourDeltas.every(d => d === 0)) return null;
  return hourDeltas;
}

/**
 * Build previousMonthTail array mixing manual continuity input (-3/-2/-1)
 * with any imported previous-month roster.
 */
function buildPrevMonthTail() {
  const activeNurses = state.nurses.slice(0, state.totalNurses - state.absentNurses);
  const tail = activeNurses.map((nurse, nurseIdx) => {
    const importedTail = getImportedPrevMonthTailForNurse(nurseIdx)?.slice() || [];
    const manualTail = getManualPreviousMonthTailForNurse(nurse);
    const hasManual = manualTail.some(Boolean);
    if (!importedTail.length && !hasManual) return null;
    if (!importedTail.length) return manualTail;

    const mergedTail = importedTail.slice();
    if (!hasManual) return mergedTail;

    const manualStartIdx = Math.max(0, mergedTail.length - manualTail.length);
    manualTail.forEach((shift, tailIdx) => {
      if (shift) mergedTail[manualStartIdx + tailIdx] = shift;
    });
    return mergedTail;
  });
  return tail.some(entry => entry && entry.some(Boolean)) ? tail : null;
}

function renderContinuityList() {
  const container = document.getElementById('continuity-list');
  if (!container) return;

  const activeNurses = state.nurses.slice(0, state.totalNurses - state.absentNurses);
  const shiftOptions = [''].concat(ALL_SHIFT_CODES);
  container.innerHTML = activeNurses
    .map((nurse, nurseIdx) => {
      const manualTail = getManualPreviousMonthTailForNurse(nurse);
      const importedTail = getImportedPrevMonthTailForNurse(nurseIdx);
      const importedLabel = importedTail ? importedTail.map(shift => shift || '—').join(' · ') : '—';
      return `<div class="rule-card">
        <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p class="font-semibold text-sm">${escHtml(nurse.name)}</p>
            <p class="text-xs text-gray-500 dark:text-slate-400">Ultimi 5 turni importati: ${escHtml(importedLabel)}</p>
          </div>
          <div class="grid grid-cols-3 gap-2 w-full lg:w-auto">
            ${CONFIG_CSV_PREVIOUS_TAIL_FIELDS.map(
              (field, tailIdx) => `<label class="text-xs text-gray-600 dark:text-slate-300">
                <span class="block mb-1 font-medium">${escHtml(field.header)}</span>
                <select
                  class="continuity-tail-select btn w-full border border-gray-300 dark:border-slate-600 rounded-lg px-2 py-2 bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100"
                  data-nurse="${nurseIdx}"
                  data-tail-index="${tailIdx}"
                >
                  ${shiftOptions
                    .map(
                      value =>
                        `<option value="${value}" ${manualTail[tailIdx] === value ? 'selected' : ''}>${
                          value || '—'
                        }</option>`
                    )
                    .join('')}
                </select>
              </label>`
            ).join('')}
          </div>
        </div>
      </div>`;
    })
    .join('');

  container.querySelectorAll('.continuity-tail-select').forEach(select => {
    select.addEventListener('change', () => {
      const nurseIdx = parseInt(select.dataset.nurse, 10);
      const tailIdx = parseInt(select.dataset.tailIndex, 10);
      state.nurses[nurseIdx].previousMonthTail[tailIdx] = normalizeShiftCode(select.value);
      saveState();
      renderStep3();
    });
  });
}

function renderStep3() {
  const summary = getContinuitySummary();
  const statusEl = document.getElementById('continuity-status');
  const hintEl = document.getElementById('continuity-hint');
  if (statusEl) statusEl.textContent = continuitySummaryLabel();
  if (hintEl) {
    hintEl.textContent =
      summary.importedCount > 0
        ? 'I valori manuali sovrascrivono gli ultimi 3 giorni del CSV importato.'
        : 'Lascia vuoto un giorno se non vuoi forzare la continuità per quel turno.';
  }
  renderContinuityList();
}

// ---------------------------------------------------------------------------
// Step 4 — Genera
// ---------------------------------------------------------------------------

/**
 * Estimate expected solving time (seconds) from the current constraints.
 * Heuristic: base cost ~ numNurses × numDays × avgCoverage, scaled empirically.
 */
function estimateTimeBudget() {
  const activeCount = state.totalNurses - state.absentNurses;
  const daysInMonth = new Date(state.year, state.month + 1, 0).getDate();
  const avgCoverage =
    (state.rules.minCoverageM + state.rules.maxCoverageM) / 2 +
    (state.rules.minCoverageP + state.rules.maxCoverageP) / 2 +
    (state.rules.minCoverageD + state.rules.maxCoverageD) / 2 +
    (state.rules.minCoverageN + state.rules.maxCoverageN) / 2;
  // Complexity proxy: nurses × days × coverage density
  const complexity = activeCount * daysInMonth * avgCoverage;
  // Empirical mapping: ~5000 complexity ≈ 30s, scale linearly
  // Floor 15s (small rosters solve fast), cap 120s (diminishing returns beyond)
  const estimated = Math.round(Math.max(15, Math.min(120, complexity / 170)));
  return estimated;
}

/** Label for the time-budget select dropdown */
function timeBudgetLabel(value) {
  if (value === -1) return 'Fino a 0 violazioni';
  if (value === 0) return 'Auto';
  if (value < 60) return `${value} secondi`;
  return `${value / 60} ${value / 60 === 1 ? 'minuto' : 'minuti'}`;
}

function renderGenerateStep() {
  updateSolverProgress(state.solverProgress?.percent || 0, state.solverProgress?.message || '');
  renderDiagnosticsPanel('solver-run-feedback', state.solverDiagnostics);

  const activeCount = state.totalNurses - state.absentNurses;
  const setEl = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  setEl('summary-period', `${MONTHS_IT[state.month]} ${state.year}`);
  setEl('summary-nurses', `${activeCount} / ${state.totalNurses}`);
  setEl(
    'summary-cov',
    `M:${state.rules.minCoverageM}–${state.rules.maxCoverageM} | P:${state.rules.minCoverageP}–${state.rules.maxCoverageP} | D:${state.rules.minCoverageD}–${state.rules.maxCoverageD} | N:${state.rules.minCoverageN}–${state.rules.maxCoverageN}`
  );
  setEl('summary-month-hours', `${getMonthlyContractHours(state.year, state.month).toFixed(2)} ore`);
  setEl('summary-nights', `${state.rules.targetNights} (max ${state.rules.hardMaxNights})`);
  setEl('summary-prev-month', continuitySummaryLabel());

  // Bind num solutions slider
  bindRange('inp-num-solutions', 'val-num-solutions', state.numSolutions, v => {
    state.numSolutions = v;
    saveState();
  });

  // Bind time budget selector
  const selTime = document.getElementById('sel-time-budget');
  const lblEstimate = document.getElementById('lbl-time-estimate');
  if (selTime) {
    selTime.value = String(state.timeBudget);
    selTime.onchange = () => {
      state.timeBudget = parseInt(selTime.value, 10);
      saveState();
      if (lblEstimate) {
        lblEstimate.textContent = state.timeBudget === 0 ? `Tempo stimato: ~${estimateTimeBudget()} secondi` : '';
      }
    };
  }
  if (lblEstimate) {
    lblEstimate.textContent = state.timeBudget === 0 ? `Tempo stimato: ~${estimateTimeBudget()} secondi` : '';
  }

  // Bind solver choice selector
  const selSolver = document.getElementById('sel-solver-method');
  if (selSolver) {
    selSolver.value = state.solverChoice || 'auto';
    selSolver.onchange = () => {
      state.solverChoice = selSolver.value;
      saveState();
    };
  }
}

function startSolver() {
  // Terminate existing worker
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }

  resetSolverFeedback();
  state.schedule = null;
  state.violations = [];
  state.stats = [];
  state.solutions = [];
  state.selectedSolution = 0;
  state.solverMethod = null;

  const btn = document.getElementById('btn-generate');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Elaborazione...';
  }

  const activeNurses = state.nurses.slice(0, state.totalNurses - state.absentNurses);

  const config = {
    year: state.year,
    month: state.month,
    nurses: activeNurses,
    rules: state.rules,
    hourDeltas: buildHourDeltas(),
    previousMonthTail: buildPrevMonthTail(),
  };

  const worker = new Worker('js/solver.js');
  state.worker = worker;

  worker.onmessage = e => {
    const data = e.data;
    if (data.type === 'progress') {
      updateSolverProgress(data.percent, data.message);
    } else if (data.type === 'result') {
      if (data.solutions) {
        data.solutions.forEach((sol, i) => {
          console.log(
            `[App]   Solution #${i + 1}: method=${sol.solverMethod}, score=${sol.score}, violations=${sol.violations?.length}`
          );
        });
      }
      applySolveResult(data);
      state.worker = null;
      worker.terminate();
      saveState();
      const btnG = document.getElementById('btn-generate');
      if (btnG) {
        btnG.disabled = false;
        btnG.textContent = 'GENERA TURNI';
      }
      goToStep(5);
    } else if (data.type === 'error') {
      console.error('[App] Solver error:', data.message, data.error);
      updateSolverProgress(state.solverProgress?.percent || 0, data.message || 'Errore nel solver');
      setSolverDiagnostics(data.diagnostics || []);
      const btnG = document.getElementById('btn-generate');
      if (btnG) {
        btnG.disabled = false;
        btnG.textContent = 'GENERA TURNI';
      }
      state.worker = null;
      worker.terminate();
    }
  };

  worker.onerror = err => {
    console.error('[App] Worker error:', err.message, err);
    updateSolverProgress(state.solverProgress?.percent || 0, 'Worker error durante la generazione');
    setSolverDiagnostics(buildWorkerRuntimeDiagnostic(err, 'la generazione'));
    const btnG = document.getElementById('btn-generate');
    if (btnG) {
      btnG.disabled = false;
      btnG.textContent = 'GENERA TURNI';
    }
    state.worker = null;
    worker.terminate();
  };

  const effectiveTimeBudget = state.timeBudget === 0 ? estimateTimeBudget() : state.timeBudget;
  worker.postMessage({
    type: 'solve',
    config,
    numSolutions: state.numSolutions,
    timeBudget: effectiveTimeBudget,
    untilZeroViolations: state.timeBudget === -1,
    solverChoice: state.solverChoice || 'auto',
  });
}

function regenerateTurni() {
  // Terminate existing worker
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }

  resetSolverFeedback();

  const btn = document.getElementById('btn-regenerate');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Rigenerando...';
  }

  const activeNurses = state.nurses.slice(0, state.totalNurses - state.absentNurses);

  // Create a copy of rules with preferDiurni enabled for this regeneration only
  const regenerationRules = { ...state.rules, preferDiurni: true };

  const config = {
    year: state.year,
    month: state.month,
    nurses: activeNurses,
    rules: regenerationRules,
    hourDeltas: buildHourDeltas(),
  };

  const worker = new Worker('js/solver.js');
  state.worker = worker;

  worker.onmessage = e => {
    const data = e.data;
    if (data.type === 'progress') {
      updateSolverProgress(data.percent, data.message);
    } else if (data.type === 'result') {
      if (data.solutions) {
        data.solutions.forEach((sol, i) => {
          console.log(
            `[App Regen]   Solution #${i + 1}: method=${sol.solverMethod}, score=${sol.score}, violations=${sol.violations?.length}`
          );
        });
      }
      applySolveResult(data);
      state.worker = null;
      worker.terminate();
      saveState();
      const btnR = document.getElementById('btn-regenerate');
      if (btnR) {
        btnR.disabled = false;
        btnR.textContent = '🔄 Rigenera turni';
      }
      renderStep4();
    } else if (data.type === 'error') {
      console.error('[App Regen] Solver error:', data.message, data.error);
      updateSolverProgress(state.solverProgress?.percent || 0, data.message || 'Errore nel solver');
      setSolverDiagnostics(data.diagnostics || []);
      const btnR = document.getElementById('btn-regenerate');
      if (btnR) {
        btnR.disabled = false;
        btnR.textContent = '🔄 Rigenera turni';
      }
      state.worker = null;
      worker.terminate();
      renderStep4();
    }
  };

  worker.onerror = err => {
    console.error('[App Regen] Worker error:', err.message, err);
    updateSolverProgress(state.solverProgress?.percent || 0, 'Worker error durante la rigenerazione');
    setSolverDiagnostics(buildWorkerRuntimeDiagnostic(err, 'la rigenerazione'));
    const btnR = document.getElementById('btn-regenerate');
    if (btnR) {
      btnR.disabled = false;
      btnR.textContent = '🔄 Rigenera turni';
    }
    state.worker = null;
    worker.terminate();
    renderStep4();
  };

  const effectiveTimeBudget = state.timeBudget === 0 ? estimateTimeBudget() : state.timeBudget;
  worker.postMessage({
    type: 'solve',
    config,
    numSolutions: state.numSolutions,
    timeBudget: effectiveTimeBudget,
    untilZeroViolations: state.timeBudget === -1,
    solverChoice: state.solverChoice || 'auto',
  });
}

// ---------------------------------------------------------------------------
// Rebalance — optimise the existing schedule via local search
// ---------------------------------------------------------------------------

function rebalanceTurni() {
  if (!state.schedule) {
    alert('Nessun turno da riassegnare. Genera prima i turni.');
    return;
  }

  // Terminate existing worker
  if (state.worker) {
    state.worker.terminate();
    state.worker = null;
  }

  resetSolverFeedback();

  const btn = document.getElementById('btn-rebalance');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Riassegnando...';
  }

  const activeNurses = state.nurses.slice(0, state.totalNurses - state.absentNurses);

  const config = {
    year: state.year,
    month: state.month,
    nurses: activeNurses,
    rules: state.rules,
    hourDeltas: buildHourDeltas(),
    previousMonthTail: buildPrevMonthTail(),
  };

  const worker = new Worker('js/solver.js');
  state.worker = worker;

  worker.onmessage = e => {
    const data = e.data;
    if (data.type === 'progress') {
      updateSolverProgress(data.percent, data.message);
    } else if (data.type === 'result') {
      console.log('[App Rebalance] Result received');
      state.solutions = data.solutions || [];
      state.selectedSolution = 0;
      state.solverMethod = data.solverMethod || null;
      setSolverDiagnostics(data.diagnostics || []);
      if (state.solutions.length > 0) {
        const best = state.solutions[0];
        state.schedule = best.schedule;
        state.violations = best.violations || [];
        state.stats = best.stats || [];
      } else {
        state.schedule = data.schedule;
        state.violations = data.violations || [];
        state.stats = data.stats || [];
      }
      state.worker = null;
      worker.terminate();
      saveState();
      const btnR = document.getElementById('btn-rebalance');
      if (btnR) {
        btnR.disabled = false;
        btnR.textContent = '⚖️ Riassegna turni';
      }
      renderStep4();
    } else if (data.type === 'error') {
      console.error('[App Rebalance] Solver error:', data.message, data.error);
      updateSolverProgress(state.solverProgress?.percent || 0, data.message || 'Errore nella riassegnazione');
      setSolverDiagnostics(data.diagnostics || []);
      const btnR = document.getElementById('btn-rebalance');
      if (btnR) {
        btnR.disabled = false;
        btnR.textContent = '⚖️ Riassegna turni';
      }
      state.worker = null;
      worker.terminate();
      renderStep4();
    }
  };

  worker.onerror = err => {
    console.error('[App Rebalance] Worker error:', err.message, err);
    updateSolverProgress(state.solverProgress?.percent || 0, 'Worker error durante la riassegnazione');
    setSolverDiagnostics(buildWorkerRuntimeDiagnostic(err, 'la riassegnazione'));
    const btnR = document.getElementById('btn-rebalance');
    if (btnR) {
      btnR.disabled = false;
      btnR.textContent = '⚖️ Riassegna turni';
    }
    state.worker = null;
    worker.terminate();
    renderStep4();
  };

  worker.postMessage({
    type: 'rebalance',
    config,
    schedule: state.schedule,
    timeBudget: 15,
  });
}

// ---------------------------------------------------------------------------
// Step 4 — Risultati
// ---------------------------------------------------------------------------

let openDropdown = null;

function renderSolutionPicker() {
  const picker = document.getElementById('solution-picker');
  const btnContainer = document.getElementById('solution-buttons');
  const countEl = document.getElementById('solution-count');
  if (!picker || !btnContainer) return;

  if (!state.solutions || state.solutions.length <= 1) {
    picker.classList.add('hidden');
    return;
  }

  picker.classList.remove('hidden');
  if (countEl) countEl.textContent = `${state.solutions.length} soluzioni ordinate per qualità`;
  btnContainer.innerHTML = '';

  state.solutions.forEach((sol, idx) => {
    const vioCount = (sol.violations || []).length;
    const isSelected = idx === state.selectedSolution;
    const btn = document.createElement('button');
    btn.className = `px-3 py-2 text-sm font-semibold rounded-lg shadow transition-colors ${
      isSelected
        ? 'bg-blue-600 text-white ring-2 ring-blue-400'
        : 'bg-white dark:bg-slate-700 text-gray-700 dark:text-slate-300 border border-gray-300 dark:border-slate-600 hover:bg-gray-100 dark:hover:bg-slate-600'
    }`;
    const label = idx === 0 ? '⭐ Migliore' : `#${idx + 1}`;
    btn.innerHTML = `${label}<br><span class="text-xs font-normal">${vioCount === 0 ? '✅ 0 viol.' : `⚠️ ${vioCount} viol.`}</span>`;
    btn.title = `Soluzione ${idx + 1} — ${vioCount} violazioni, punteggio: ${sol.score}`;
    btn.setAttribute('aria-label', `Soluzione ${idx + 1}${idx === 0 ? ' (migliore)' : ''}, ${vioCount} violazioni`);
    btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    btn.addEventListener('click', () => selectSolution(idx));
    btnContainer.appendChild(btn);
  });
}

function selectSolution(idx) {
  if (!state.solutions || idx < 0 || idx >= state.solutions.length) return;
  state.selectedSolution = idx;
  const sol = state.solutions[idx];
  state.schedule = sol.schedule;
  state.violations = sol.violations || [];
  state.stats = sol.stats || [];
  saveState();
  renderStep4();
}

function renderSolverMethodBanner() {
  const banner = document.getElementById('solver-method-banner');
  if (!banner) return;

  // Determine solver method from selected solution or global state
  let method = state.solverMethod;
  if (state.solutions && state.solutions.length > 0 && state.selectedSolution >= 0) {
    const sol = state.solutions[state.selectedSolution];
    if (sol && sol.solverMethod) method = sol.solverMethod;
  }

  if (!method || !state.schedule) {
    banner.classList.add('hidden');
    return;
  }

  banner.classList.remove('hidden');
  if (method === 'milp') {
    banner.innerHTML = `<div class="p-3 bg-green-50 dark:bg-green-950 border border-green-300 dark:border-green-700 rounded-lg">
      <p class="font-semibold text-green-700 dark:text-green-400 text-sm">✅ Algoritmo utilizzato: <strong>HiGHS MILP</strong> (ottimizzazione matematica)</p>
    </div>`;
  } else if (method === 'glpk') {
    banner.innerHTML = `<div class="p-3 bg-blue-50 dark:bg-blue-950 border border-blue-300 dark:border-blue-700 rounded-lg">
      <p class="font-semibold text-blue-700 dark:text-blue-400 text-sm">✅ Algoritmo utilizzato: <strong>GLPK.js</strong> (ottimizzazione matematica)</p>
    </div>`;
  } else {
    banner.innerHTML = `<div class="p-3 bg-amber-50 dark:bg-amber-950 border border-amber-300 dark:border-amber-700 rounded-lg">
      <p class="font-semibold text-amber-700 dark:text-amber-400 text-sm">⚠️ Algoritmo utilizzato: <strong>Euristica</strong> (greedy + simulated annealing) — i solver matematici non erano disponibili oppure non hanno trovato una soluzione utilizzabile.</p>
    </div>`;
  }
}

function renderStep4() {
  const container = document.getElementById('schedule-container');
  if (!container) return;

  // Render solution picker and solver method banner
  renderSolutionPicker();
  renderSolverMethodBanner();
  renderDiagnosticsPanel('solver-diagnostics-banner', state.solverDiagnostics);

  if (!state.schedule) {
    container.innerHTML =
      '<p class="text-gray-500 italic text-center py-12">Nessun turno generato. Torna al passo 3.</p>';
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
    let M = 0,
      P = 0,
      N = 0;
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
  headerHTML += `<th class="stats-col">Ore | D | N | WE</th></tr>`;

  // Nurse rows
  let bodyHTML = '';
  for (let n = 0; n < numNurses; n++) {
    const st = state.stats[n] || { totalHours: 0, nights: 0, diurni: 0, weekends: 0 };
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

    bodyHTML += `<td class="stats-col text-xs">${st.totalHours}h | ${st.diurni || 0}D | ${st.nights}N | ${st.weekends}WE</td>`;
    bodyHTML += `</tr>`;
  }

  // Coverage row
  bodyHTML += `<tr class="coverage-row">`;
  bodyHTML += `<td class="text-xs font-semibold">COPERTURA</td>`;
  for (let d = 0; d < numDays; d++) {
    const cov = dayStats(d);
    const min = state.rules.minCoverage;
    const warnM = cov.M < min,
      warnP = cov.P < min;
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
  const vioSummaryHTML =
    state.violations.length > 0
      ? `<div class="mt-3 p-3 bg-red-50 dark:bg-red-950 border border-red-300 dark:border-red-700 rounded-lg max-h-32 overflow-y-auto">
         <p class="font-semibold text-red-700 dark:text-red-400 text-sm mb-1">⚠️ Violazioni rilevate (${state.violations.length})</p>
         ${state.violations
           .slice(0, 20)
           .map(v => `<p class="text-xs text-red-600 dark:text-red-400">${escHtml(v.msg)}</p>`)
           .join('')}
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
      ${Object.entries(SHIFT_LABELS)
        .map(
          ([k, v]) =>
            `<span class="inline-flex items-center gap-1">
           <span class="shift-cell ${SHIFT_COLORS[k]}" style="width:20px;height:18px;font-size:10px">${k}</span>
           <span>${v}</span>
         </span>`
        )
        .join('')}
    </div>
  `;

  // Attach click listeners for inline shift editing
  container.querySelectorAll('.shift-cell').forEach(cell => {
    cell.addEventListener('click', e => {
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

  // Include all shift types including absence shifts
  ['M', 'P', 'D', 'N', 'S', 'R', 'F', 'MA', 'L104', 'PR', 'MT'].forEach(shift => {
    const btn = document.createElement('button');
    btn.className = `shift-cell ${SHIFT_COLORS[shift]}`;
    btn.style.width = '36px';
    btn.style.height = '36px';
    btn.title = SHIFT_LABELS[shift];
    btn.textContent = shift;
    btn.addEventListener('click', e => {
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
  const left = Math.min(rect.left + window.scrollX, window.innerWidth - 280);
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
    if (d + 2 < numDays && state.schedule[n][d + 2] === 'R') {
      /* keep R */
    }
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
  let totalHours = 0,
    nights = 0,
    diurni = 0,
    weekends = 0;
  for (let d = 0; d < numDays; d++) {
    const s = state.schedule[n][d];
    totalHours += SHIFT_HOURS[s] || 0;
    if (s === 'N') nights++;
    if (s === 'D') diurni++;
    if (isWeekend(state.year, state.month, d + 1) && s && s !== 'R') weekends++;
  }
  state.stats[n] = { totalHours: Math.round(totalHours * 10) / 10, nights, diurni, weekends };
}

function revalidate() {
  if (!state.schedule) return;
  const numNurses = state.schedule.length;
  const numDays = daysInMonth(state.year, state.month);
  const violations = [];

  const FORBIDDEN_NEXT = {
    P: state.rules.consentePomeriggioDiurno ? ['M'] : ['M', 'D'],
    D: state.rules.consente2DiurniConsecutivi ? ['M', 'P'] : ['M', 'P', 'D'],
    N: ['M', 'P', 'D', 'R', 'N'],
    S: ['M', 'P', 'D', 'N', 'S'],
  };

  for (let n = 0; n < numNurses; n++) {
    for (let d = 0; d < numDays - 1; d++) {
      const cur = state.schedule[n][d];
      const nxt = state.schedule[n][d + 1];
      const forbidden = FORBIDDEN_NEXT[cur] || [];
      if (forbidden.includes(nxt)) {
        violations.push({
          nurse: n,
          day: d,
          type: 'transition',
          msg: `Inf. ${n + 1}, gg ${d + 1}-${d + 2}: ${cur}→${nxt} vietato`,
        });
      }
    }
    // D-D specific checks when consecutive D shifts are allowed
    if (state.rules.consente2DiurniConsecutivi) {
      for (let d = 1; d < numDays - 1; d++) {
        if (state.schedule[n][d - 1] === 'D' && state.schedule[n][d] === 'D' && state.schedule[n][d + 1] !== 'R')
          violations.push({
            nurse: n,
            day: d + 1,
            type: 'DD_no_R',
            msg: `Inf. ${n + 1}, gg ${d + 2}: dopo D-D serve R`,
          });
      }
      for (let d = 2; d < numDays; d++) {
        if (state.schedule[n][d - 2] === 'D' && state.schedule[n][d - 1] === 'D' && state.schedule[n][d] === 'D')
          violations.push({
            nurse: n,
            day: d,
            type: 'DDD',
            msg: `Inf. ${n + 1}, gg ${d + 1}: 3 diurni consecutivi non consentiti`,
          });
      }
    }
  }

  for (let d = 0; d < numDays; d++) {
    let M = 0,
      P = 0,
      D = 0,
      N = 0;
    for (let n = 0; n < numNurses; n++) {
      const s = state.schedule[n][d];
      if (s === 'M') M++;
      if (s === 'P') P++;
      if (s === 'D') {
        D++;
        M++;
        P++;
      }
      if (s === 'N') N++;
    }
    if (M < state.rules.minCoverageM)
      violations.push({
        day: d,
        type: 'coverage_M',
        msg: `Giorno ${d + 1}: M insufficiente (${M}/${state.rules.minCoverageM})`,
      });
    if (M > state.rules.maxCoverageM)
      violations.push({
        day: d,
        type: 'coverage_M_max',
        msg: `Giorno ${d + 1}: M eccessiva (${M}/${state.rules.maxCoverageM})`,
      });
    if (P < state.rules.minCoverageP)
      violations.push({
        day: d,
        type: 'coverage_P',
        msg: `Giorno ${d + 1}: P insufficiente (${P}/${state.rules.minCoverageP})`,
      });
    if (P > state.rules.maxCoverageP)
      violations.push({
        day: d,
        type: 'coverage_P_max',
        msg: `Giorno ${d + 1}: P eccessiva (${P}/${state.rules.maxCoverageP})`,
      });
    if (N < state.rules.minCoverageN)
      violations.push({
        day: d,
        type: 'coverage_N',
        msg: `Giorno ${d + 1}: N insufficiente (${N}/${state.rules.minCoverageN})`,
      });
    if (N > state.rules.maxCoverageN)
      violations.push({
        day: d,
        type: 'coverage_N_max',
        msg: `Giorno ${d + 1}: N eccessiva (${N}/${state.rules.maxCoverageN})`,
      });
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
  const headers = [
    'Infermiere',
    ...Array.from({ length: numDays }, (_, i) => {
      const dow = DOW_LABELS[dayOfWeek(state.year, state.month, i + 1)];
      return `${i + 1} ${dow}`;
    }),
    'Ore',
    'Diurni',
    'Notti',
    'Weekend',
  ];

  const rows = [headers];
  activeNurses.forEach((nurse, n) => {
    const st = state.stats[n] || { totalHours: 0, nights: 0, diurni: 0, weekends: 0 };
    const row = [
      nurse.name,
      ...Array.from({ length: numDays }, (_, d) => state.schedule[n][d] || 'R'),
      st.totalHours,
      st.diurni || 0,
      st.nights,
      st.weekends,
    ];
    rows.push(row);
  });

  const csv = formatCsv(rows);
  downloadFile(csv, `turni_${MONTHS_IT[state.month]}_${state.year}.csv`, 'text/csv;charset=utf-8;');
}

// ---------------------------------------------------------------------------
// Export: Save/Load config JSON
// ---------------------------------------------------------------------------

function saveConfig() {
  const cfg = getConfigPayload();
  downloadFile(JSON.stringify(cfg, null, 2), `config_turni_${state.year}_${state.month + 1}.json`, 'application/json');
}

function loadConfig(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const cfg = JSON.parse(e.target.result);
      applyConfigPayload(cfg);
      alert('Configurazione caricata con successo.');
    } catch (_) {
      alert('Errore nel caricamento del file JSON.');
    }
  };
  reader.readAsText(file);
}

function loadConfigCSV(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const result = parseConfigCSV(e.target.result);
    if (result.error) {
      alert(result.error);
      return;
    }
    applyConfigPayload(result.config);
    alert('Configurazione CSV caricata con successo.');
  };
  reader.onerror = () => {
    alert('Errore durante la lettura del file CSV.');
  };
  reader.readAsText(file, 'UTF-8');
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
  // Extend list if needed
  while (state.nurses.length < state.totalNurses) {
    state.nurses.push(normalizeNurse({}, state.nurses.length));
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
  ['btn-nav-1', 'btn-nav-2', 'btn-nav-3', 'btn-nav-4', 'btn-nav-5'].forEach((id, idx) => {
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
  document.getElementById('btn-export-config-csv')?.addEventListener('click', exportConfigCSV);
  document.getElementById('btn-load-config-csv')?.addEventListener('click', () => {
    document.getElementById('inp-load-config-csv-file')?.click();
  });
  document.getElementById('inp-load-config-csv-file')?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (file) loadConfigCSV(file);
    e.target.value = '';
  });
  document.getElementById('btn-step1-next')?.addEventListener('click', () => goToStep(2));

  // ---- Step 2 ----
  document.getElementById('btn-step2-back')?.addEventListener('click', () => goToStep(1));
  document.getElementById('btn-step2-next')?.addEventListener('click', () => goToStep(3));

  // Previous month CSV import — file upload
  document.getElementById('btn-upload-prev-csv')?.addEventListener('click', () => {
    document.getElementById('inp-prev-csv-file')?.click();
  });
  document.getElementById('inp-prev-csv-file')?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      e.target.value = '';
      const text = reader.result;
      const result = parsePrevMonthCSV(text);
      if (result.error) {
        alert(result.error);
        return;
      }
      importPrevMonthData(result.scheduleData);
      renderPrevMonthStatus();
      alert(
        `Importati ${result.total} infermieri × ${result.numDays} giorni. ` +
          `${result.matchedCount}/${result.total} corrispondenti ai nomi attuali.`
      );
    };
    reader.onerror = () => {
      e.target.value = '';
      alert('Errore durante la lettura del file. Riprova.');
    };
    reader.readAsText(file, 'UTF-8');
  });
  // Previous month CSV import — paste text
  document.getElementById('btn-import-prev-csv')?.addEventListener('click', () => {
    const modal = document.getElementById('csv-paste-modal');
    if (modal) modal.classList.remove('hidden');
  });
  document.getElementById('btn-csv-cancel')?.addEventListener('click', () => {
    const modal = document.getElementById('csv-paste-modal');
    if (modal) modal.classList.add('hidden');
  });
  document.getElementById('btn-csv-confirm')?.addEventListener('click', () => {
    const area = document.getElementById('csv-paste-area');
    const modal = document.getElementById('csv-paste-modal');
    if (!area) return;
    const text = area.value;
    const result = parsePrevMonthCSV(text);
    if (result.error) {
      alert(result.error);
      return;
    }
    importPrevMonthData(result.scheduleData);
    if (modal) modal.classList.add('hidden');
    area.value = '';
    renderPrevMonthStatus();
    alert(
      `Importati ${result.total} infermieri × ${result.numDays} giorni. ` +
        `${result.matchedCount}/${result.total} corrispondenti ai nomi attuali.`
    );
  });
  document.getElementById('btn-clear-prev')?.addEventListener('click', () => {
    clearPrevMonth();
  });

  // ---- Step 3 ----
  document.getElementById('btn-step3-back')?.addEventListener('click', () => goToStep(2));
  document.getElementById('btn-step3-next')?.addEventListener('click', () => goToStep(4));

  // ---- Step 4 ----
  document.getElementById('btn-step4-back')?.addEventListener('click', () => goToStep(3));
  document.getElementById('btn-generate')?.addEventListener('click', startSolver);

  // ---- Step 5 ----
  document.getElementById('btn-step5-back')?.addEventListener('click', () => goToStep(4));
  document.getElementById('btn-regenerate')?.addEventListener('click', regenerateTurni);
  document.getElementById('btn-rebalance')?.addEventListener('click', rebalanceTurni);
  document.getElementById('btn-export-csv')?.addEventListener('click', exportCSV);
  document.getElementById('btn-save-config')?.addEventListener('click', saveConfig);
  document.getElementById('btn-print')?.addEventListener('click', () => window.print());
  document.getElementById('btn-load-config')?.addEventListener('click', () => {
    document.getElementById('inp-load-file')?.click();
  });
  document.getElementById('inp-load-file')?.addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (file) loadConfig(file);
    e.target.value = '';
  });

  renderAll();
}

document.addEventListener('DOMContentLoaded', init);
