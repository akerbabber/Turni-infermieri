/**
 * @file guarantees.test.js — Tests for min/max guarantee enforcement
 *
 * Covers the mechanisms wired in the "pattern guarantees" pass:
 *   - weekly→monthly hour scaling (minHours/maxHours sliders)
 *   - hardMaxNights (absolute per-nurse night cap)
 *   - low_hours exemption only for genuinely absent nurses
 *   - D (diurno) coverage min/max enforcement
 *   - coppia sync never overwrites pinned cells
 */

'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadSolver() {
  const moduleFiles = [
    'solver/constants.js',
    'solver/context.js',
    'solver/scoring.js',
    'solver/construct.js',
    'solver/local-search.js',
    'solver/pattern-planner.js',
    'solver/solvers.js',
  ];
  const context = {
    self: {},
    console,
    Math,
    Date,
    Array,
    Object,
    Map,
    Set,
    String,
    Number,
    Boolean,
    RegExp,
    JSON,
    Error,
    TypeError,
    RangeError,
    Infinity,
    NaN,
    undefined,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    importScripts: () => {},
    postMessage: () => {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    URL: typeof URL !== 'undefined' ? URL : undefined,
  };
  vm.createContext(context);
  vm.runInContext('function progress() {}', context);
  const jsDir = path.join(__dirname, '..', 'js');
  for (const file of moduleFiles) {
    const code = fs.readFileSync(path.join(jsDir, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }
  return context;
}

let ctx;
before(() => {
  ctx = loadSolver();
});

function makeConfig(overrides = {}) {
  const numNurses = overrides.numNurses ?? 4;
  const nurses = [];
  for (let i = 0; i < numNurses; i++) {
    nurses.push({
      name: `Nurse ${i}`,
      tags: [],
      absencePeriods: {},
      ...((overrides.nurseOverrides && overrides.nurseOverrides[i]) || {}),
    });
  }
  return {
    year: overrides.year ?? 2026,
    month: overrides.month ?? 3, // April 2026 — 22 weekdays
    nurses,
    rules: {
      minCoverageM: 0,
      maxCoverageM: 10,
      minCoverageP: 0,
      maxCoverageP: 10,
      minCoverageD: 0,
      maxCoverageD: 10,
      minCoverageN: 0,
      maxCoverageN: 10,
      targetNights: 4,
      maxNights: 6,
      hardMaxNights: 7,
      minRPerWeek: 0,
      minGap11h: true,
      minHours: 0,
      ...(overrides.rules || {}),
    },
    hourDeltas: overrides.hourDeltas || null,
    previousMonthTail: overrides.previousMonthTail || null,
  };
}

function emptySchedule(bctx, fill = 'R') {
  return Array.from({ length: bctx.numNurses }, () => new Array(bctx.numDays).fill(fill));
}

describe('weekly→monthly hour scaling', () => {
  it('scales weekly slider values by weekdays/5', () => {
    // April 2026 has 22 weekdays → factor 4.4
    const bctx = ctx.buildContext(makeConfig({ rules: { minHours: 28, maxHours: 42 } }));
    assert.equal(bctx.minMonthlyHours, Math.round(28 * 4.4 * 10) / 10);
    assert.equal(bctx.maxMonthlyHours, Math.round(42 * 4.4 * 10) / 10);
  });

  it('treats values above 60 as already-monthly (legacy)', () => {
    const bctx = ctx.buildContext(makeConfig({ rules: { minHours: 130 } }));
    assert.equal(bctx.minMonthlyHours, 130);
  });

  it('maxMonthlyHours defaults to Infinity when maxHours is unset', () => {
    const bctx = ctx.buildContext(makeConfig({ rules: { minHours: 0 } }));
    assert.equal(bctx.maxMonthlyHours, Infinity);
  });
});

describe('hardMaxNights wiring', () => {
  it('exposes hardMaxNights and clamps the soft cap below it', () => {
    const a = ctx.buildContext(makeConfig({ rules: { maxNights: 6, hardMaxNights: 7 } }));
    assert.equal(a.maxNights, 6);
    assert.equal(a.hardMaxNights, 7);
    const b = ctx.buildContext(makeConfig({ rules: { maxNights: 8, hardMaxNights: 5 } }));
    assert.equal(b.maxNights, 5);
    assert.equal(b.hardMaxNights, 5);
  });

  it('reports troppe_notti when a nurse exceeds the absolute cap', () => {
    const bctx = ctx.buildContext(makeConfig({ rules: { maxNights: 1, hardMaxNights: 1, targetNights: 1 } }));
    const schedule = emptySchedule(bctx);
    // Two full night blocks for nurse 0 → 2 nights > hardMaxNights 1
    schedule[0][0] = 'N';
    schedule[0][1] = 'S';
    schedule[0][2] = 'R';
    schedule[0][3] = 'R';
    schedule[0][5] = 'N';
    schedule[0][6] = 'S';
    schedule[0][7] = 'R';
    schedule[0][8] = 'R';
    const violations = ctx.collectViolations(schedule, bctx);
    assert.ok(violations.some(v => v.type === 'troppe_notti' && v.nurse === 0));
    const score = ctx.computeScore(schedule, bctx);
    assert.ok(score.hard > 0);
  });
});

describe('monthly hour band enforcement', () => {
  it('flags an all-R nurse without absences as low_hours (not exempt)', () => {
    const bctx = ctx.buildContext(makeConfig({ rules: { minHours: 20 } }));
    const schedule = emptySchedule(bctx); // all R, no absence shifts
    const violations = ctx.collectViolations(schedule, bctx);
    const lows = violations.filter(v => v.type === 'low_hours');
    assert.equal(lows.length, bctx.numNurses);
  });

  it('exempts a fully absent nurse from low_hours', () => {
    const bctx = ctx.buildContext(makeConfig({ rules: { minHours: 60 } }));
    const schedule = emptySchedule(bctx);
    for (let d = 0; d < bctx.numDays; d++) schedule[0][d] = 'MT'; // maternity all month
    const violations = ctx.collectViolations(schedule, bctx);
    assert.ok(!violations.some(v => v.type === 'low_hours' && v.nurse === 0));
  });

  it('reports high_hours above the monthly maximum', () => {
    const bctx = ctx.buildContext(makeConfig({ rules: { minHours: 0, maxHours: 30 } }));
    const schedule = emptySchedule(bctx);
    // Fill nurse 0 with alternating M/P work far beyond 30h/week equivalent
    for (let d = 0; d < bctx.numDays; d++) schedule[0][d] = d % 2 === 0 ? 'M' : 'P';
    const violations = ctx.collectViolations(schedule, bctx);
    assert.ok(violations.some(v => v.type === 'high_hours' && v.nurse === 0));
  });
});

describe('D (diurno) coverage enforcement', () => {
  it('reports coverage_D when below the minimum', () => {
    const bctx = ctx.buildContext(makeConfig({ rules: { minCoverageD: 1, maxCoverageD: 3 } }));
    const schedule = emptySchedule(bctx); // no D anywhere
    const violations = ctx.collectViolations(schedule, bctx);
    const covD = violations.filter(v => v.type === 'coverage_D');
    assert.equal(covD.length, bctx.numDays);
    assert.ok(ctx.computeScore(schedule, bctx).hard > 0);
  });

  it('reports coverage_D_max when above the maximum', () => {
    const bctx = ctx.buildContext(makeConfig({ rules: { minCoverageD: 0, maxCoverageD: 0 } }));
    const schedule = emptySchedule(bctx);
    schedule[0][10] = 'D';
    const violations = ctx.collectViolations(schedule, bctx);
    assert.ok(violations.some(v => v.type === 'coverage_D_max' && v.day === 10));
  });
});

describe('nuove regole riposi e notti', () => {
  it('non segnala violazione quando N-S-R è seguito da lavoro (secondo R opzionale)', () => {
    const bctx = ctx.buildContext(makeConfig({}));
    const schedule = emptySchedule(bctx);
    schedule[0][0] = 'M';
    schedule[0][1] = 'P';
    schedule[0][2] = 'N';
    schedule[0][3] = 'S';
    schedule[0][4] = 'R';
    schedule[0][5] = 'M'; // lavoro subito dopo N-S-R: consentito
    const violations = ctx.collectViolations(schedule, bctx);
    assert.ok(!violations.some(v => v.type === 'need_2R_after_night'));
  });

  it('segnala isola_di_riposo con più di 2 R consecutivi (S escluso)', () => {
    const bctx = ctx.buildContext(makeConfig({}));
    const schedule = emptySchedule(bctx, 'M');
    schedule[0][10] = 'R';
    schedule[0][11] = 'R';
    schedule[0][12] = 'R'; // 3 R consecutivi → violazione
    schedule[1][10] = 'N';
    schedule[1][11] = 'S';
    schedule[1][12] = 'R';
    schedule[1][13] = 'R'; // S-R-R: solo 2 R → nessuna violazione
    const violations = ctx.collectViolations(schedule, bctx);
    assert.ok(violations.some(v => v.type === 'isola_di_riposo' && v.nurse === 0));
    assert.ok(!violations.some(v => v.type === 'isola_di_riposo' && v.nurse === 1));
  });
});

describe('ferie con weekend a riposo', () => {
  it('pinna F nei feriali e R nei weekend dentro il periodo ferie', () => {
    // Aprile 2026: 4-5 aprile = sabato e domenica
    const config = makeConfig({
      nurseOverrides: {
        0: {
          tags: ['ferie'],
          absencePeriods: { ferie: { start: '2026-04-01', end: '2026-04-07' } },
        },
      },
    });
    const bctx = ctx.buildContext(config);
    assert.equal(bctx.pinned[0][0], 'F'); // mer 1
    assert.equal(bctx.pinned[0][1], 'F'); // gio 2
    assert.equal(bctx.pinned[0][2], 'F'); // ven 3
    assert.equal(bctx.pinned[0][3], 'R'); // sab 4
    assert.equal(bctx.pinned[0][4], 'R'); // dom 5
    assert.equal(bctx.pinned[0][5], 'F'); // lun 6
    assert.equal(bctx.pinned[0][6], 'F'); // mar 7
  });
});

describe('fascia oraria automatica', () => {
  it('senza diurni (maxCoverageD=0): M/P valgono 7.2 e la notte 10.2', () => {
    const bctx = ctx.buildContext(makeConfig({ rules: { maxCoverageD: 0, fasciaOraria: 'auto' } }));
    const schedule = emptySchedule(bctx);
    schedule[0][0] = 'M';
    schedule[0][2] = 'N';
    assert.ok(Math.abs(ctx.nurseHours(schedule, 0, bctx.numDays) - (7.2 + 10.2)) < 1e-9);
  });

  it('con diurni (maxCoverageD>0): M/P valgono 6.2 e la notte 12.2', () => {
    const bctx = ctx.buildContext(makeConfig({ rules: { maxCoverageD: 4, fasciaOraria: 'auto' } }));
    const schedule = emptySchedule(bctx);
    schedule[0][0] = 'M';
    schedule[0][2] = 'N';
    assert.ok(Math.abs(ctx.nurseHours(schedule, 0, bctx.numDays) - (6.2 + 12.2)) < 1e-9);
  });

  it('la scelta manuale della fascia vince su auto', () => {
    const bctx = ctx.buildContext(makeConfig({ rules: { maxCoverageD: 0, fasciaOraria: 'standard' } }));
    const schedule = emptySchedule(bctx);
    schedule[0][0] = 'M';
    assert.ok(Math.abs(ctx.nurseHours(schedule, 0, bctx.numDays) - 6.2) < 1e-9);
  });
});

describe('reperibile notturno', () => {
  it('senza diurni: segnala reperibile_mancante quando nessuno ha M oggi e N domani', () => {
    const bctx = ctx.buildContext(makeConfig({ rules: { reperibileNotturno: true, maxCoverageD: 0 } }));
    const schedule = emptySchedule(bctx);
    schedule[0][5] = 'P'; // pomeriggio, non vale come mattina
    schedule[0][6] = 'N';
    schedule[0][7] = 'S';
    schedule[0][8] = 'R';
    const violations = ctx.collectViolations(schedule, bctx);
    assert.ok(violations.some(v => v.type === 'reperibile_mancante' && v.day === 5));
    assert.ok(ctx.computeScore(schedule, bctx).hard > 0);
  });

  it('senza diurni: soddisfatto da un infermiere con M oggi e N domani', () => {
    const bctx = ctx.buildContext(makeConfig({ rules: { reperibileNotturno: true, maxCoverageD: 0 } }));
    const schedule = emptySchedule(bctx);
    schedule[0][5] = 'M';
    schedule[0][6] = 'N';
    schedule[0][7] = 'S';
    schedule[0][8] = 'R';
    const violations = ctx.collectViolations(schedule, bctx);
    assert.ok(!violations.some(v => v.type === 'reperibile_mancante'));
  });

  it('con diurni: il reperibile è chi è in smonto oggi', () => {
    const bctx = ctx.buildContext(makeConfig({ rules: { reperibileNotturno: true, maxCoverageD: 4 } }));
    const schedule = emptySchedule(bctx);
    // Notte di n0 il giorno 5: smonto il 6. Notte di n1 il giorno 7 → il giorno 6
    // ha "notti domani" e n0 è in smonto → reperibile coperto.
    schedule[0][5] = 'N';
    schedule[0][6] = 'S';
    schedule[0][7] = 'R';
    schedule[1][6] = 'D';
    schedule[1][7] = 'N';
    schedule[1][8] = 'S';
    schedule[1][9] = 'R';
    const violations = ctx.collectViolations(schedule, bctx);
    assert.ok(!violations.some(v => v.type === 'reperibile_mancante' && v.day === 6));
    // Il giorno 4 ha "notte domani" (n0 il 5) ma nessuno in smonto → violazione.
    assert.ok(violations.some(v => v.type === 'reperibile_mancante' && v.day === 4));
  });

  it('non richiede nulla nei giorni senza notti il giorno dopo', () => {
    const bctx = ctx.buildContext(makeConfig({ rules: { reperibileNotturno: true } }));
    const schedule = emptySchedule(bctx); // nessuna notte in tutto il mese
    const violations = ctx.collectViolations(schedule, bctx);
    assert.ok(!violations.some(v => v.type === 'reperibile_mancante'));
  });
});

describe('limiti hard sui riposi', () => {
  it('3 R consecutivi sono una violazione hard', () => {
    const bctx = ctx.buildContext(makeConfig({ rules: { minRPerWeek: 0 } }));
    const schedule = emptySchedule(bctx, 'M');
    schedule[0][10] = 'R';
    schedule[0][11] = 'R';
    schedule[0][12] = 'R';
    assert.ok(ctx.computeScore(schedule, bctx).hard > 0);
  });

  it('4 o più riposi in una settimana sono una violazione hard (3 solo penalità)', () => {
    const bctx = ctx.buildContext(makeConfig({ rules: { minRPerWeek: 2 } }));
    const schedule = emptySchedule(bctx, 'M');
    // Aprile 2026: settimana piena 6-12 (lun-dom, indici 5-11)
    schedule[0][5] = 'R';
    schedule[0][7] = 'R';
    schedule[0][9] = 'R';
    schedule[0][11] = 'R'; // 4 R nella stessa settimana → hard
    const violations = ctx.collectViolations(schedule, bctx);
    assert.ok(violations.some(v => v.type === 'troppi_riposi_settimana' && v.nurse === 0));

    // Con 3 R (uno oltre il minimo) niente violazione hard, solo penalità soft.
    schedule[0][11] = 'M';
    const after = ctx.collectViolations(schedule, bctx);
    assert.ok(!after.some(v => v.type === 'troppi_riposi_settimana'));
  });

  it('canRepairShiftChange rifiuta un R che crea 3 riposi attaccati', () => {
    const bctx = ctx.buildContext(makeConfig({ rules: { minRPerWeek: 0 } }));
    const schedule = emptySchedule(bctx, 'M');
    schedule[0][10] = 'R';
    schedule[0][12] = 'R';
    assert.equal(ctx.canRepairShiftChange(schedule, bctx, 0, 11, 'R'), false);
  });
});

describe('coppia sync respects pinned cells', () => {
  it('does not overwrite the absence of the paired nurse', () => {
    const config = makeConfig({
      rules: { coppiaTurni: [0, 1], minHours: 0 },
      nurseOverrides: {
        1: {
          tags: ['ferie'],
          absencePeriods: { ferie: { start: '2026-04-01', end: '2026-04-30' } },
        },
      },
    });
    const bctx = ctx.buildContext(config);
    const schedule = emptySchedule(bctx);
    for (let d = 0; d < bctx.numDays; d++) {
      schedule[0][d] = d % 2 === 0 ? 'M' : 'R';
      schedule[1][d] = 'F';
    }
    // 0 iterations: only the final coppia sync + repair phase run
    const result = ctx.localSearch(schedule, bctx, 0);
    for (let d = 0; d < bctx.numDays; d++) {
      assert.equal(result[1][d], 'F', `pinned absence overwritten at day ${d + 1}`);
    }
  });
});
