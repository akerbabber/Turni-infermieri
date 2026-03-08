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
const HOUR_EQUITY_MILP_WEIGHT = 0.3; // weight for minimax hour equity in MILP objective
const NIGHT_EQUITY_MILP_WEIGHT = 0.15; // weight for minimax night equity in MILP objective
const DIURNI_EQUITY_MILP_WEIGHT = 0.15; // weight for minimax D-shift equity in MILP objective
const MP_BALANCE_MILP_WEIGHT = 0.1; // weight for M/P balance penalty in MILP objective

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

const NUM_RESTARTS = 10;
const LOCAL_SEARCH_ITERS = 4000;

const MILP_MIN_TIME_PER_SOLUTION = 5;
const MILP_DEFAULT_TOTAL_TIME_BUDGET = 60;

// Safety cap to prevent indefinite runs in zero-violations mode (10 minutes)
const UNTIL_ZERO_MAX_TIME = 600;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
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

function gapHours(prev, next) {
  if (!SHIFT_END[prev] || !SHIFT_START[next]) return Infinity;
  if (prev === 'N') return SHIFT_START[next] - SHIFT_END[prev];
  return 24 - SHIFT_END[prev] + SHIFT_START[next];
}

function deepCopy(schedule) {
  return schedule.map(row => [...row]);
}
