/**
 * @file context.js — Build shared context object and absence handling
 * @description Preprocessing: creates the context used by all solver phases.
 */

'use strict';

/* global getMonthlyContractHours, countWeekdaysInMonth */

// ---------------------------------------------------------------------------
// Preprocessing — build a shared context object used by all phases
// ---------------------------------------------------------------------------

function buildContext(config) {
  const { year, month, nurses, rules, hourDeltas, previousMonthTail } = config;

  // Apply fascia oraria before any hour-dependent computation. 'auto' follows
  // the diurni usage: schedules WITH diurni (maxCoverageD > 0) use the standard
  // hours (M/P 6.2, N 12.2, assenze 6.12), schedules WITHOUT diurni use the
  // extended ones (M/P 7.2, N 10.2, assenze 7.12).
  const requestedFascia = rules.fasciaOraria || 'auto';
  const resolvedFascia =
    requestedFascia === 'auto' ? ((rules.maxCoverageD ?? 4) > 0 ? 'standard' : '7-10') : requestedFascia;
  applyFasciaOraria(resolvedFascia);

  const numDays = daysInMonth(year, month);
  const numNurses = nurses.length;
  const monthlyTargetHours = getMonthlyContractHours(year, month);

  // Forbidden-transition table (may be relaxed by rule flags)
  const forbidden = {
    P: [...BASE_FORBIDDEN_NEXT.P],
    D: [...BASE_FORBIDDEN_NEXT.D],
    N: [...BASE_FORBIDDEN_NEXT.N],
    S: [...BASE_FORBIDDEN_NEXT.S],
  };
  if (rules.consentePomeriggioDiurno) forbidden.P = forbidden.P.filter(s => s !== 'D');
  if (rules.consente2DiurniConsecutivi) forbidden.D = forbidden.D.filter(s => s !== 'D');

  // Per-nurse properties
  const nurseProps = nurses.map(n => ({
    soloMattine: n.tags.includes('solo_mattine'),
    quattroMattineVenerdiNotte: n.tags.includes('quattro_mattine_venerdi_notte'),
    soloDiurni: n.tags.includes('solo_diurni'),
    soloNotti: n.tags.includes('solo_notti'),
    diurniENotturni: n.tags.includes('diurni_e_notturni'),
    noNotti: n.tags.includes('no_notti'),
    diurniNoNotti: n.tags.includes('diurni_no_notti'),
    noDiurni: n.tags.includes('no_diurni') || n.tags.includes('quattro_mattine_venerdi_notte'),
    mattineEPomeriggi: n.tags.includes('mattine_e_pomeriggi'),
  }));

  // Day-of-week cache & week index helpers
  const dows = [];
  for (let d = 0; d < numDays; d++) dows.push(dayOfWeek(year, month, d + 1));
  const firstDow = dayOfWeek(year, month, 1);
  const adjustedFirstDow = firstDow === 0 ? 6 : firstDow - 1;
  const weekOf = d => Math.floor((d + adjustedFirstDow) / 7);
  const numWeeks = weekOf(numDays - 1) + 1;

  // Coverage targets
  const minCovM = rules.minCoverageM ?? 6,
    maxCovM = rules.maxCoverageM ?? 7;
  const minCovP = rules.minCoverageP ?? 6,
    maxCovP = rules.maxCoverageP ?? 7;
  const minCovD = rules.minCoverageD ?? 0,
    maxCovD = rules.maxCoverageD ?? 4;
  const minCovN = rules.minCoverageN ?? 6,
    maxCovN = rules.maxCoverageN ?? 6;

  const targetNights = rules.targetNights ?? 4;
  // maxNights is the soft monthly night cap; hardMaxNights ("Notti massime assolute")
  // is the absolute per-nurse limit. The soft cap can never exceed the hard cap.
  const hardMaxNights = rules.hardMaxNights ?? rules.maxNights ?? 7;
  const maxNights = Math.min(rules.maxNights ?? 7, hardMaxNights);
  const minRPerWeek = rules.minRPerWeek ?? 2;

  // Hour limits: the UI sliders express WEEKLY hours (min/max per settimana).
  // Convert them to monthly thresholds using the number of weekdays in the month
  // (5 weekdays = one contract week). Values above 60 cannot come from the weekly
  // sliders and are treated as already-monthly for backward compatibility.
  const weeksEquivalent = countWeekdaysInMonth(year, month) / 5;
  const minHoursRule = rules.minHours || 0;
  const minMonthlyHours = minHoursRule > 60 ? minHoursRule : Math.round(minHoursRule * weeksEquivalent * 10) / 10;
  const maxHoursRule = rules.maxHours || 0;
  const maxMonthlyHours =
    maxHoursRule > 0
      ? maxHoursRule > 60
        ? maxHoursRule
        : Math.round(maxHoursRule * weeksEquivalent * 10) / 10
      : Infinity;
  const preferDiurni = rules.preferDiurni ?? false;
  const coppiaTurni = rules.coppiaTurni ?? null;
  const consente2D = rules.consente2DiurniConsecutivi ?? false;
  // Night on-call: each day with nights tomorrow needs a nurse on M/D today
  // whose next-day shift is N. Off unless explicitly enabled by the rules.
  const reperibileNotturno = rules.reperibileNotturno ?? false;

  // Pre-compute pinned cells (absences + solo_mattine)
  // pinned[n][d] = shift code or null
  const pinned = Array.from({ length: numNurses }, () => new Array(numDays).fill(null));
  for (let n = 0; n < numNurses; n++) {
    const nurse = nurses[n];
    for (let d = 0; d < numDays; d++) {
      const abs = getAbsenceShift(nurse, d + 1, year, month);
      if (abs) {
        pinned[n][d] = abs;
        continue;
      }
      if (nurseProps[n].quattroMattineVenerdiNotte) {
        if (dows[d] >= 1 && dows[d] <= 4) pinned[n][d] = 'M';
        else if (dows[d] === 5) pinned[n][d] = 'N';
        else if (dows[d] === 6) pinned[n][d] = 'S';
        else pinned[n][d] = 'R';
      } else if (nurseProps[n].soloMattine) {
        pinned[n][d] = dows[d] === 0 || dows[d] === 6 ? 'R' : 'M';
      }
    }
  }

  // Previous month tail: pin mandatory continuation days at month start
  // Handles N→S→R→R continuation and D-D→R continuation (when consente2D)
  const prevTail = previousMonthTail || null;
  if (prevTail) {
    for (let n = 0; n < numNurses; n++) {
      const tail = prevTail[n];
      if (!tail || tail.length === 0) continue;
      const last = tail[tail.length - 1];
      const secondLast = tail.length >= 2 ? tail[tail.length - 2] : null;

      if (last === 'N') {
        // N on last day → need S, R at start (the second R is always optional)
        if (!pinned[n][0]) pinned[n][0] = 'S';
        if (numDays > 1 && !pinned[n][1]) pinned[n][1] = 'R';
      } else if (last === 'S' && secondLast === 'N') {
        // N-S on last two days → need R at start
        if (!pinned[n][0]) pinned[n][0] = 'R';
      }

      // D-D continuation: when consente2D is enabled and prev month ends with D-D,
      // day 0 must be R (D-D must always be followed by R)
      if (consente2D && last === 'D' && secondLast === 'D') {
        if (!pinned[n][0]) pinned[n][0] = 'R';
      }
    }
  }

  // Precompute week day-lists
  const weekDaysList = Array.from({ length: numWeeks }, () => []);
  for (let d = 0; d < numDays; d++) weekDaysList[weekOf(d)].push(d);

  return {
    year,
    month,
    nurses,
    rules,
    numDays,
    numNurses,
    forbidden,
    nurseProps,
    dows,
    weekOf,
    numWeeks,
    pinned,
    weekDaysList,
    minCovM,
    maxCovM,
    minCovP,
    maxCovP,
    minCovD,
    maxCovD,
    minCovN,
    maxCovN,
    targetNights,
    maxNights,
    hardMaxNights,
    minMonthlyHours,
    maxMonthlyHours,
    minRPerWeek,
    preferDiurni,
    coppiaTurni,
    consente2D,
    reperibileNotturno,
    monthlyTargetHours,
    hourDeltas: hourDeltas || null,
    prevTail,
  };
}

function getAbsenceShift(nurse, day1Based, year, month) {
  if (!nurse.absencePeriods) return null;
  for (const [tagKey, shiftCode] of Object.entries(ABSENCE_TAG_TO_SHIFT)) {
    if (!nurse.tags.includes(tagKey)) continue;
    const period = nurse.absencePeriods[tagKey];
    if (period && period.start && period.end) {
      const ds = `${year}-${String(month + 1).padStart(2, '0')}-${String(day1Based).padStart(2, '0')}`;
      if (ds >= period.start && ds <= period.end) {
        // Ferie consume 5 working days per week: Saturdays and Sundays inside a
        // vacation period count as plain rest days, not as vacation.
        if (tagKey === 'ferie' && isWeekend(year, month, day1Based)) return 'R';
        return shiftCode;
      }
    } else {
      return shiftCode;
    }
  }
  return null;
}
