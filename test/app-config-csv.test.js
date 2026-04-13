'use strict';

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadApp() {
  const context = {
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
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Blob: function Blob() {},
    URL: {
      createObjectURL: () => 'blob:test',
      revokeObjectURL: () => {},
    },
    Worker: function Worker() {},
    FileReader: function FileReader() {},
    alert: () => {},
    crypto: {
      randomUUID: () => 'test-uuid',
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    document: {
      addEventListener: () => {},
      getElementById: () => null,
      querySelectorAll: () => [],
      createElement: () => ({
        click() {},
        appendChild() {},
        remove() {},
        addEventListener() {},
        setAttribute() {},
        classList: { add() {}, remove() {}, toggle() {} },
        style: {},
        dataset: {},
      }),
      documentElement: { classList: { toggle() {} } },
      body: { appendChild() {} },
    },
    window: {
      print() {},
      innerWidth: 1280,
      scrollX: 0,
      scrollY: 0,
    },
  };

  vm.createContext(context);
  const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'app.js' });
  vm.runInContext(
    `function _getAppConst(name) {
       const lookup = {
         DEFAULT_RULES: DEFAULT_RULES,
         CONFIG_CSV_ABSENCE_FIELDS: CONFIG_CSV_ABSENCE_FIELDS
       };
       return lookup[name];
     }
     function _getAppState() { return state; }
     function _setAppState(value) { state = value; }`,
    context
  );
  return context;
}

function toPlain(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultRulesForApply(appContext) {
  return toPlain(appContext._getAppConst('DEFAULT_RULES'));
}

let ctx;

before(() => {
  ctx = loadApp();
});

describe('config CSV helpers', () => {
  it('should migrate legacy default nurse names from saved state', () => {
    const currentState = toPlain(ctx._getAppState());
    const legacyNames = [
      'Rossi Marco',
      'Bianchi Laura',
      'Ferrari Giovanni',
      'Esposito Sofia',
      'Conti Luca',
      'Ricci Anna',
      'Colombo Pietro',
      'Russo Elena',
      'Marinelli Sara',
      'Greco Alberto',
      'Bruno Claudia',
      'Romano Fabio',
      'Costa Valentina',
      'Fontana Roberto',
      'Ferrara Giulia',
      'Galli Stefano',
      'Coppola Marta',
      'Rizzo Davide',
      'Lombardi Chiara',
      'Barbieri Simone',
      'Moretti Paola',
      'Caruso Marco',
      'De Luca Francesca',
      'Fiore Alessandro',
      'Pellegrini Ilaria',
      'Monti Nicola',
      'Poli Carmen',
      'Testa Giorgio',
      'Riva Serena',
      'Sala Massimo',
      'Villa Roberta',
      'Sergi Luigi',
      'Palumbo Elisa',
      'Messina Diego',
      'Cattaneo Nadia',
      'Rinaldi Lorenzo',
      'Fabbri Agnese',
    ];
    const savedState = {
      ...currentState,
      totalNurses: legacyNames.length,
      nurses: legacyNames.map((name, index) => ({ id: `n${index + 1}`, name, tags: [], absencePeriods: {} })),
    };
    ctx.localStorage.getItem = key => (key === 'turni_state' ? JSON.stringify(savedState) : null);

    ctx._setAppState({ ...currentState, nurses: [] });
    ctx.loadState();

    const nextState = toPlain(ctx._getAppState());
    assert.equal(nextState.nurses[0].name, 'Giorgi Bruna');
    assert.equal(nextState.nurses[27].name, 'PES CLAUDIA');
    assert.equal(nextState.nurses[35].name, 'Infermiere 36');
    assert.equal(nextState.nurses[36].name, 'Infermiere 37');
  });

  it('should keep custom nurse names from saved state unchanged', () => {
    const currentState = toPlain(ctx._getAppState());
    const savedState = {
      ...currentState,
      totalNurses: 2,
      nurses: [
        { id: 'n1', name: 'Infermiere Personalizzato 1', tags: [], absencePeriods: {} },
        { id: 'n2', name: 'Infermiere Personalizzato 2', tags: [], absencePeriods: {} },
      ],
    };
    ctx.localStorage.getItem = key => (key === 'turni_state' ? JSON.stringify(savedState) : null);

    ctx._setAppState({ ...currentState, nurses: [] });
    ctx.loadState();

    const nextState = toPlain(ctx._getAppState());
    assert.equal(nextState.nurses[0].name, 'Infermiere Personalizzato 1');
    assert.equal(nextState.nurses[1].name, 'Infermiere Personalizzato 2');
  });

  it('should migrate partial legacy default rosters from saved state', () => {
    const currentState = toPlain(ctx._getAppState());
    const savedState = {
      ...currentState,
      totalNurses: 2,
      nurses: [
        { id: 'n1', name: 'Rossi Marco', tags: [], absencePeriods: {} },
        { id: 'n2', name: 'Bianchi Laura', tags: [], absencePeriods: {} },
      ],
    };
    ctx.localStorage.getItem = key => (key === 'turni_state' ? JSON.stringify(savedState) : null);

    ctx._setAppState({ ...currentState, nurses: [] });
    ctx.loadState();

    const nextState = toPlain(ctx._getAppState());
    assert.equal(nextState.nurses[0].name, 'Giorgi Bruna');
    assert.equal(nextState.nurses[1].name, 'Aresu FRANCESCA');
  });

  it('should roundtrip nurses and rules through CSV', () => {
    const defaultRules = toPlain(ctx._getAppConst('DEFAULT_RULES'));
    const cfg = {
      month: 4,
      year: 2027,
      totalNurses: 3,
      absentNurses: 1,
      nurses: [
        {
          id: 'n1',
          name: 'Rossi, Maria',
          tags: ['solo_mattine', 'ferie'],
          absencePeriods: {
            ferie: { start: '2027-05-01', end: '2027-05-03' },
          },
          previousMonthTail: ['M', 'N', 'S'],
        },
        {
          id: 'n2',
          name: 'Bianchi Laura',
          tags: ['no_notti'],
          absencePeriods: {},
          previousMonthTail: ['', 'R', 'M'],
        },
        {
          id: 'n3',
          name: 'Verdi Luca',
          tags: [],
          absencePeriods: {},
        },
      ],
      rules: {
        ...defaultRules,
        minCoverageM: 5,
        consente2DiurniConsecutivi: true,
        coppiaTurni: [0, 1],
        fasciaOraria: '7-10',
      },
    };

    const csv = ctx.formatCsv(ctx.buildConfigCsvRows(cfg));
    const result = ctx.parseConfigCSV(csv);

    assert.equal(result.error, undefined);
    assert.equal(result.config.month, 4);
    assert.equal(result.config.year, 2027);
    assert.equal(result.config.totalNurses, 3);
    assert.equal(result.config.absentNurses, 1);
    assert.equal(result.config.rules.minCoverageM, 5);
    assert.equal(result.config.rules.consente2DiurniConsecutivi, true);
    assert.deepEqual(toPlain(result.config.rules.coppiaTurni), [0, 1]);
    assert.equal(result.config.rules.fasciaOraria, '7-10');
    assert.equal(result.config.nurses[0].name, 'Rossi, Maria');
    assert.deepEqual(toPlain(result.config.nurses[0].tags), ['solo_mattine', 'ferie']);
    assert.deepEqual(toPlain(result.config.nurses[0].absencePeriods.ferie), {
      start: '2027-05-01',
      end: '2027-05-03',
    });
    assert.deepEqual(toPlain(result.config.nurses[0].previousMonthTail), ['M', 'N', 'S']);
    assert.deepEqual(toPlain(result.config.nurses[1].previousMonthTail), [null, 'R', 'M']);
  });

  it('should activate absence tags when CSV dates are present', () => {
    const csv = [
      '"Sezione";"Chiave";"Valore";"Ordine";"Nome";"Tag";"Ferie dal";"Ferie al"',
      '"infermiere";"";"";"1";"Rossi Marco";"";"2027-05-10";"2027-05-12"',
    ].join('\r\n');

    const result = ctx.parseConfigCSV(csv);

    assert.equal(result.error, undefined);
    assert.deepEqual(toPlain(result.config.nurses[0].tags), ['ferie']);
    assert.deepEqual(toPlain(result.config.nurses[0].absencePeriods.ferie), {
      start: '2027-05-10',
      end: '2027-05-12',
    });
  });

  it('should convert invalid previous-month tail shift codes to null', () => {
    const csv = [
      '"Sezione";"Chiave";"Valore";"Ordine";"Nome";"Tag";"Mese prec. -3";"Mese prec. -2";"Mese prec. -1"',
      '"infermiere";"";"";"1";"Rossi Marco";"";"XYZ";"M";"BAD"',
    ].join('\r\n');

    const result = ctx.parseConfigCSV(csv);

    assert.equal(result.error, undefined);
    assert.deepEqual(toPlain(result.config.nurses[0].previousMonthTail), [null, 'M', null]);
  });

  it('should clear generated results when applying an imported config', () => {
    const currentState = toPlain(ctx._getAppState());
    ctx.renderAll = () => {};
    ctx.saveState = () => {};
    ctx._setAppState({
      ...currentState,
      totalNurses: 2,
      absentNurses: 0,
      nurses: [
        { id: 'n1', name: 'A', tags: [], absencePeriods: {} },
        { id: 'n2', name: 'B', tags: [], absencePeriods: {} },
      ],
      schedule: [['M'], ['P']],
      violations: [{ msg: 'old' }],
      stats: [{ totalHours: 6.2 }],
      solutions: [{ schedule: [['M'], ['P']] }],
      selectedSolution: 1,
      solverMethod: 'fallback',
      solverDiagnostics: ['old'],
      solverProgress: { percent: 100, message: 'done' },
    });

    ctx.applyConfigPayload({
      totalNurses: 1,
      absentNurses: 0,
      nurses: [{ name: 'Nuova', tags: ['no_notti'], absencePeriods: {} }],
      rules: { ...defaultRulesForApply(ctx), fasciaOraria: 'standard' },
    });

    const nextState = toPlain(ctx._getAppState());
    assert.equal(nextState.totalNurses, 1);
    assert.equal(nextState.nurses[0].name, 'Nuova');
    assert.equal(nextState.schedule, null);
    assert.deepEqual(nextState.violations, []);
    assert.deepEqual(nextState.stats, []);
    assert.deepEqual(nextState.solutions, []);
    assert.equal(nextState.selectedSolution, 0);
    assert.equal(nextState.solverMethod, null);
  });

  it('should prefer manual previous-month tail values over imported CSV tail values', () => {
    const currentState = toPlain(ctx._getAppState());
    ctx._setAppState({
      ...currentState,
      totalNurses: 1,
      absentNurses: 0,
      nurses: [{ id: 'n1', name: 'A', tags: [], absencePeriods: {}, previousMonthTail: ['P', 'N', 'S'] }],
      previousMonthSchedule: [['M', 'P', 'R', 'M', 'R']],
      previousMonthHours: [31],
    });

    assert.deepEqual(toPlain(ctx.buildPrevMonthTail()), [['M', 'P', 'P', 'N', 'S']]);
  });

  it('should respect totalNurses from imported config and ignore extra nurse rows', () => {
    const currentState = toPlain(ctx._getAppState());
    ctx.renderAll = () => {};
    ctx.saveState = () => {};
    ctx._setAppState({
      ...currentState,
      totalNurses: 2,
      absentNurses: 0,
      nurses: [
        { id: 'n1', name: 'A', tags: [], absencePeriods: {} },
        { id: 'n2', name: 'B', tags: [], absencePeriods: {} },
      ],
    });

    ctx.applyConfigPayload({
      totalNurses: 3,
      absentNurses: 0,
      nurses: [
        { name: 'Uno', tags: [], absencePeriods: {} },
        { name: 'Due', tags: [], absencePeriods: {} },
        { name: 'Tre', tags: [], absencePeriods: {} },
        { name: 'Quattro', tags: [], absencePeriods: {} },
        { name: 'Cinque', tags: [], absencePeriods: {} },
      ],
      rules: { ...defaultRulesForApply(ctx), fasciaOraria: 'standard' },
    });

    const nextState = toPlain(ctx._getAppState());
    assert.equal(nextState.totalNurses, 3);
    assert.equal(nextState.nurses.length, 3);
    assert.deepEqual(
      nextState.nurses.map(nurse => nurse.name),
      ['Uno', 'Due', 'Tre']
    );
  });
});

describe('manual fixed-pattern protections', () => {
  it('should keep the fixed 4 mattine + notte ven. pattern during manual edits', () => {
    const currentState = toPlain(ctx._getAppState());
    ctx._setAppState({
      ...currentState,
      year: 2025,
      month: 0,
      totalNurses: 1,
      absentNurses: 0,
      nurses: [
        {
          id: 'n1',
          name: 'Infermiere 1',
          tags: ['quattro_mattine_venerdi_notte'],
          absencePeriods: {},
        },
      ],
      schedule: [new Array(31).fill('R')],
      stats: [{ totalHours: 0, nights: 0, diurni: 0, weekends: 0 }],
      violations: [],
    });

    ctx.applyManualShift(0, 0, 'P');
    ctx.applyManualShift(0, 2, 'M');

    const nextState = toPlain(ctx._getAppState());
    assert.equal(nextState.schedule[0][0], 'M');
    assert.equal(nextState.schedule[0][2], 'N');
  });
});

describe('previous month hour compensation', () => {
  it('should compute previous-month deltas relative to the imported roster average', () => {
    const currentState = toPlain(ctx._getAppState());
    ctx._setAppState({
      ...currentState,
      totalNurses: 4,
      absentNurses: 0,
      nurses: [
        { id: 'n1', name: 'A', tags: [], absencePeriods: {} },
        { id: 'n2', name: 'B', tags: [], absencePeriods: {} },
        { id: 'n3', name: 'C', tags: [], absencePeriods: {} },
        { id: 'n4', name: 'D', tags: [], absencePeriods: {} },
      ],
      previousMonthSchedule: [
        ['M', 'M'],
        ['M', 'M'],
        ['M', 'M'],
        [null, null],
      ],
      previousMonthHours: [124.0, 130.2, 136.4, null],
    });

    const deltas = toPlain(ctx.computePrevMonthDeltas());

    assert.deepEqual(deltas, {
      A: -6.2,
      B: 0,
      C: 6.2,
    });
    const deltaSum = Object.values(deltas).reduce((sum, value) => sum + value, 0);
    assert.equal(deltaSum, 0);
  });

  it('should build zero-sum hourDeltas for the solver', () => {
    const currentState = toPlain(ctx._getAppState());
    ctx._setAppState({
      ...currentState,
      totalNurses: 4,
      absentNurses: 0,
      nurses: [
        { id: 'n1', name: 'A', tags: [], absencePeriods: {} },
        { id: 'n2', name: 'B', tags: [], absencePeriods: {} },
        { id: 'n3', name: 'C', tags: [], absencePeriods: {} },
        { id: 'n4', name: 'D', tags: [], absencePeriods: {} },
      ],
      previousMonthSchedule: [
        ['M', 'M'],
        ['M', 'M'],
        ['M', 'M'],
        [null, null],
      ],
      previousMonthHours: [124.0, 130.2, 136.4, null],
    });

    const hourDeltas = toPlain(ctx.buildHourDeltas());

    assert.deepEqual(hourDeltas, [6.2, 0, -6.2, 0]);
    const deltaSum = hourDeltas.reduce((sum, value) => sum + value, 0);
    assert.equal(deltaSum, 0);
  });
});

describe('monthly contract hours helpers', () => {
  it('should compute April 2026 month-hours from weekdays × 7.12', () => {
    assert.equal(ctx.countWeekdaysInMonth(2026, 3), 22);
    assert.equal(ctx.getMonthlyContractHours(2026, 3), 156.64);
  });
});
