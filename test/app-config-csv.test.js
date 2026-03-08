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
        },
        {
          id: 'n2',
          name: 'Bianchi Laura',
          tags: ['no_notti'],
          absencePeriods: {},
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
