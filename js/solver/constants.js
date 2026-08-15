/**
 * @file constants.js — Shared constants and utility functions for the solver
 * @description Pure data and stateless helpers used across all solver modules.
 */

'use strict';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Active shift hours (mutable — updated by applyFasciaOraria)
const SHIFT_HOURS = { M: 6.2, P: 6.2, D: 12.2, N: 12.2, S: 0, R: 0, F: 6.12, MA: 6.12, L104: 6.12, PR: 6.12, MT: 6.12 };

// Fascia oraria presets
const FASCIA_PRESETS = {
  standard: { M: 6.2, P: 6.2, D: 12.2, N: 12.2, S: 0, R: 0, F: 6.12, MA: 6.12, L104: 6.12, PR: 6.12, MT: 6.12 },
  '7-10': { M: 7.2, P: 7.2, D: 12.2, N: 10.2, S: 0, R: 0, F: 7.12, MA: 7.12, L104: 7.12, PR: 7.12, MT: 7.12 },
};
const FASCIA_SHIFT_START = {
  standard: { M: 8, P: 14, D: 8, N: 20 },
  '7-10': { M: 7, P: 14, D: 8, N: 21 },
};
const FASCIA_SHIFT_END = {
  standard: { M: 14.2, P: 20.2, D: 20.2, N: 8.2 },
  '7-10': { M: 14.2, P: 21.2, D: 20.2, N: 7.2 },
};

const DEBUG = false; // Set to true for verbose solver logging

const EQUITY_THRESHOLD_HOURS = 2; // ±hours from average before equity move triggers
const MAX_CONSECUTIVE_REST = 2; // more than 2 consecutive R days must be avoided
const MONTHLY_HOURS_PER_WEEKDAY = 7.12;

// Weight applied to under-minimum coverage (below the required minimum staffing).
// Set much higher than every other hard weight so the solver treats the daily
// minimums as the top, non-negotiable priority: it never trades a coverage
// deficit for pattern/rest/hour violations, guarantees minimum staffing on every
// day first, and only then assigns extra staff toward the maximums.
const UNDER_COVERAGE_WEIGHT = 8;

const ABSENCE_TAG_TO_SHIFT = {
  ferie: 'F',
  malattia: 'MA',
  104: 'L104',
  permesso_retribuito: 'PR',
  maternita: 'MT',
};

// Active shift start/end times (mutable — updated by applyFasciaOraria)
const SHIFT_END = { M: 14.2, P: 20.2, D: 20.2, N: 8.2 };
const SHIFT_START = { M: 8, P: 14, D: 8, N: 20 };

/**
 * Apply a fascia oraria preset, updating SHIFT_HOURS, SHIFT_START, SHIFT_END.
 * Unknown fascia values default to 'standard'.
 * @param {string} fascia - 'standard' or '7-10'
 */
function applyFasciaOraria(fascia) {
  const key = FASCIA_PRESETS[fascia] ? fascia : 'standard';
  Object.assign(SHIFT_HOURS, FASCIA_PRESETS[key]);
  Object.assign(SHIFT_START, FASCIA_SHIFT_START[key]);
  Object.assign(SHIFT_END, FASCIA_SHIFT_END[key]);
}

const BASE_FORBIDDEN_NEXT = {
  P: ['M', 'D'],
  D: ['M', 'P', 'D'],
  N: ['M', 'P', 'D', 'R', 'N'],
  S: ['M', 'P', 'D', 'N', 'S'],
};

const NUM_RESTARTS = 10; // restart multipli con early-exit a 0 violazioni
const LOCAL_SEARCH_ITERS = 6000; // +50% iterazioni per convergenza migliore

// Default total solving time budget (seconds) when the user picks "auto".
const MILP_DEFAULT_TOTAL_TIME_BUDGET = 60;

// Safety cap to prevent indefinite runs in zero-violations mode (10 minutes)
const UNTIL_ZERO_MAX_TIME = 600;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

// Italian national holidays (month is 0-indexed like Date.getMonth()):
// 1/1 Capodanno, 6/1 Epifania, 25/4 Liberazione, 1/5 Lavoro, 2/6 Repubblica,
// 15/8 Ferragosto, 1/11 Ognissanti, 8/12 Immacolata, 25/12 Natale, 26/12 S. Stefano.
const ITALIAN_FIXED_HOLIDAYS = [
  [0, 1],
  [0, 6],
  [3, 25],
  [4, 1],
  [5, 2],
  [7, 15],
  [10, 1],
  [11, 8],
  [11, 25],
  [11, 26],
];

// Gregorian computus (Anonymous/Meeus algorithm): Easter Sunday for a year.
// Returns { month (0-indexed), day }.
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=March, 4=April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month: month - 1, day };
}

// Easter Monday (Pasquetta) for a year: { month (0-indexed), day }.
function easterMonday(year) {
  const easter = easterSunday(year);
  const date = new Date(year, easter.month, easter.day + 1);
  return { month: date.getMonth(), day: date.getDate() };
}

// True for Sundays and Italian national holidays (including Pasquetta).
function isFestivoItaliano(year, month, day1Based) {
  if (dayOfWeek(year, month, day1Based) === 0) return true;
  if (ITALIAN_FIXED_HOLIDAYS.some(([m, d]) => m === month && d === day1Based)) return true;
  const pasquetta = easterMonday(year);
  return pasquetta.month === month && pasquetta.day === day1Based;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Run `fn` with Math.random temporarily replaced by a seeded LCG (Numerical
 * Recipes constants), restoring the original RNG afterwards. Makes each
 * solution reproducible and genuinely different per seed.
 */
function withSeededRandom(seed, fn) {
  const original = Math.random;
  let s = seed >>> 0;
  Math.random = () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

function dayOfWeek(year, month, day) {
  return new Date(year, month, day).getDay();
}
function isWeekend(year, month, day) {
  const d = dayOfWeek(year, month, day);
  return d === 0 || d === 6;
}
function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

function countWeekdaysInMonth(year, month) {
  const totalDays = daysInMonth(year, month);
  let weekdays = 0;
  for (let day = 1; day <= totalDays; day++) {
    const dow = dayOfWeek(year, month, day);
    if (dow >= 1 && dow <= 5) weekdays++;
  }
  return weekdays;
}

function getMonthlyContractHours(year, month) {
  return Math.round(countWeekdaysInMonth(year, month) * MONTHLY_HOURS_PER_WEEKDAY * 100) / 100;
}

function gapHours(prev, next) {
  if (!SHIFT_END[prev] || !SHIFT_START[next]) return Infinity;
  if (prev === 'N') return SHIFT_START[next] - SHIFT_END[prev];
  return 24 - SHIFT_END[prev] + SHIFT_START[next];
}

function deepCopy(schedule) {
  return schedule.map(row => [...row]);
}
