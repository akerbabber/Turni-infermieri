# Piano di Miglioramento Algoritmo Euristico
## Turni Infermieri — Pronto Soccorso

> **IMPORTANTE:** Modificare SOLO i file dell'euristica. NON toccare `lp-model.js`, `solvers.js` (parti MILP/HiGHS/GLPK).
> File target: `js/solver/construct.js`, `js/solver/local-search.js`, `js/solver/scoring.js`, `js/solver/constants.js`

---

## Contesto

**Organico tipico:** 35 infermieri, 30-31 giorni/mese
- 1 infermiere `no_diurni` (Rossi Marco) — solo M, P, N, S, R
- 1 infermiere `mattine_e_pomeriggi` (Sergi Luigi) — solo M, P, R
- 33 infermieri `diurni_e_notturni` — solo D, N, S, R
- `coppiaTurni = [4, 5]` (0-indexed: Conti Luca e Ricci Anna, o 5/6 per Ricci+Colombo)
- Coperture: M 6-8, P 6-8, D 4-8, N 6-7
- `targetNights = 6`, `maxNights = 6`, `minRPerWeek = 2`

**Pattern ottimale identificato per `diurni_e_notturni`:**
```
Ciclo base: [R, R, D, N, S] × 6 ripetizioni = 30 giorni = 146.4h esatte
```
Ogni infermiere dovrebbe seguire questo ciclo con un offset di 0-4 giorni per garantire la copertura.

**Problemi osservati nei dati reali (Aprile e Ottobre 2026):**
- Range ore: 122h–158.6h (deviazione std 9.7h vs ideale ~4h)
- 4 infermieri a 122h in Aprile (5D+5N invece di 6D+6N)
- `coppiaTurni` violato: Ricci/Colombo divergono di 24h in Ottobre
- Media notti: 5.56/mese vs target 6.0
- "Isole di riposo": fino a 7 R consecutivi per alcuni infermieri

---

## BUG #1 — `coppiaTurni` ignorato in `computeScore`

**File:** `js/solver/scoring.js`
**Riga:** ~316–333 (destructuring di `ctx` in `computeScore`)
**Sintomo:** La coppia Ricci/Colombo diverge di 24h tra mesi diversi.

**Problema:** `coppiaTurni` è estratto in `context.js` e salvato nel ctx, ma NON è nel destructuring di `computeScore()`, quindi nessuna penalità viene applicata quando le due schedule divergono.

**Fix — Step 1:** Nel destructuring di `computeScore`, aggiungere `coppiaTurni`:
```js
// PRIMA (circa riga 316):
const {
  numDays, numNurses, minCovM, minCovP, minCovN, maxCovM, maxCovP, maxCovN,
  targetNights, minRPerWeek, consente2D, forbidden, nurseProps, weekDaysList,
  hourDeltas, monthlyTargetHours,
} = ctx;

// DOPO:
const {
  numDays, numNurses, minCovM, minCovP, minCovN, maxCovM, maxCovP, maxCovN,
  targetNights, minRPerWeek, consente2D, forbidden, nurseProps, weekDaysList,
  hourDeltas, monthlyTargetHours, coppiaTurni,
} = ctx;
```

**Fix — Step 2:** Nel corpo di `computeScore`, PRIMA del `return`, aggiungere penalità soft per divergenza coppia:
```js
// Aggiungi dopo i calcoli di equity ore (circa riga 490, prima di "return { hard, soft, total }"):
if (coppiaTurni && Array.isArray(coppiaTurni) && coppiaTurni.length === 2) {
  const [n1, n2] = coppiaTurni;
  if (n1 >= 0 && n1 < numNurses && n2 >= 0 && n2 < numNurses) {
    for (let d = 0; d < numDays; d++) {
      if (schedule[n1][d] !== schedule[n2][d]) {
        hard += 1; // ogni giorno di divergenza è una violazione hard
      }
    }
  }
}
```

**Fix — Step 3:** In `collectViolations`, aggiungere il tipo di violazione `coppia_divergente`:
```js
// Aggiungere verso la fine di collectViolations(), prima del return:
if (ctx.coppiaTurni && Array.isArray(ctx.coppiaTurni) && ctx.coppiaTurni.length === 2) {
  const [n1, n2] = ctx.coppiaTurni;
  if (n1 >= 0 && n1 < ctx.numNurses && n2 >= 0 && n2 < ctx.numNurses) {
    for (let d = 0; d < ctx.numDays; d++) {
      if (schedule[n1][d] !== schedule[n2][d]) {
        violations.push({
          type: 'coppia_divergente',
          nurse: n2,
          day: d,
          msg: `Coppia: ${ctx.nurses[n1].name} e ${ctx.nurses[n2].name} hanno turni diversi il giorno ${d + 1}`,
        });
      }
    }
  }
}
```

---

## BUG #2 — Nessuna mossa `tryCoppiaTurniMove` nel Simulated Annealing

**File:** `js/solver/local-search.js`
**Righe:** 34–41 (moveStats), 68–98 (loop principale), ~872+ (dopo ultima funzione)
**Sintomo:** Il SA modifica n1 o n2 indipendentemente, rompendo la sincronizzazione post-costruzione.

**Fix — Step 1:** Estendere `moveStats` da 4 a 5 elementi (riga ~34):
```js
// PRIMA:
const moveStats = [
  { attempts: 0, accepts: 0, weight: 0.25 }, // 0: swap
  { attempts: 0, accepts: 0, weight: 0.2 },  // 1: change
  { attempts: 0, accepts: 0, weight: 0.3 },  // 2: equity
  { attempts: 0, accepts: 0, weight: 0.25 }, // 3: weekly rest
];

// DOPO:
const moveStats = [
  { attempts: 0, accepts: 0, weight: 0.15 }, // 0: swap
  { attempts: 0, accepts: 0, weight: 0.15 }, // 1: change
  { attempts: 0, accepts: 0, weight: 0.40 }, // 2: equity (aumentato)
  { attempts: 0, accepts: 0, weight: 0.20 }, // 3: weekly rest
  { attempts: 0, accepts: 0, weight: 0.10 }, // 4: coppia turni (NUOVO)
];
```

**Fix — Step 2:** Nel `switch(moveType)` (circa riga 85–98), aggiungere case 4:
```js
case 4:
  moved = tryCoppiaTurniMove(current, ctx, changes, cachedHours);
  break;
```

**Fix — Step 3:** Nel blocco di priorità per `hard > 0` (circa riga 68), aggiungere check coppia:
```js
if (currentScore.hard > 0 && Math.random() < 0.3) {
  // Se la coppia è desincronizzata, prioritizza quella mossa
  if (ctx.coppiaTurni && Array.isArray(ctx.coppiaTurni) && ctx.coppiaTurni.length === 2) {
    const [n1, n2] = ctx.coppiaTurni;
    if (n1 < ctx.numNurses && n2 < ctx.numNurses) {
      let hasDivergence = false;
      for (let d = 0; d < ctx.numDays; d++) {
        if (current[n1][d] !== current[n2][d]) { hasDivergence = true; break; }
      }
      if (hasDivergence) { moveType = 4; }
      else { moveType = 3; }
    } else {
      moveType = 3;
    }
  } else {
    moveType = 3;
  }
}
```

**Fix — Step 4:** Aggiungere la funzione `tryCoppiaTurniMove` alla fine del file (dopo l'ultima funzione esistente):
```js
function tryCoppiaTurniMove(schedule, ctx, changes, cachedHours) {
  const { numDays, numNurses, pinned, coppiaTurni, minCovM, minCovP } = ctx;
  if (!coppiaTurni || !Array.isArray(coppiaTurni) || coppiaTurni.length !== 2) return false;
  const [n1, n2] = coppiaTurni;
  if (n1 < 0 || n1 >= numNurses || n2 < 0 || n2 >= numNurses) return false;

  // Trova primo giorno di divergenza
  const days = shuffle(Array.from({ length: numDays }, (_, i) => i));
  for (const d of days) {
    if (schedule[n1][d] === schedule[n2][d]) continue;
    if (pinned[n1][d] || pinned[n2][d]) continue;

    const s1 = schedule[n1][d];
    const s2 = schedule[n2][d];

    // Prova a portare n2 in sync con n1 (n1 è il master)
    const prevN2 = d > 0 ? schedule[n2][d - 1] : null;
    const nextN2 = d < numDays - 1 ? schedule[n2][d + 1] : null;

    if (!transitionOk(prevN2, s1, ctx, schedule, n2, d)) continue;
    if (nextN2 !== null && !transitionOk(s1, nextN2, ctx, schedule, n2, d + 1)) continue;

    // Controlla che la copertura non crolli togliendo s2 da n2
    const cov = dayCoverage(schedule, d, numNurses);
    if (s2 === 'M' && cov.M <= minCovM) continue;
    if (s2 === 'P' && cov.P <= minCovP) continue;
    if (s2 === 'N' && cov.N <= ctx.minCovN) continue;

    // Applica la mossa: porta n2 in sync con n1
    changes.push({ n: n2, d, old: s2 });
    schedule[n2][d] = s1;
    if (cachedHours) {
      cachedHours[n2] += (SHIFT_HOURS[s1] || 0) - (SHIFT_HOURS[s2] || 0);
    }
    return true;
  }
  return false;
}
```

**Fix — Step 5:** Alla fine della funzione `localSearch`, PRIMA del `return best`, aggiungere sincronizzazione finale della coppia:
```js
// Sync finale coppia turni
if (ctx.coppiaTurni && Array.isArray(ctx.coppiaTurni) && ctx.coppiaTurni.length === 2) {
  const [n1, n2] = ctx.coppiaTurni;
  if (n1 >= 0 && n1 < numNurses && n2 >= 0 && n2 < numNurses) {
    for (let d = 0; d < numDays; d++) {
      best[n2][d] = best[n1][d];
    }
  }
}
return best;
```

---

## BUG #3 — Nessuna violazione hard per ore troppo basse

**File:** `js/solver/scoring.js`
**Funzione:** `collectViolations()` (circa riga 512–751) e `computeScore()` (circa riga 315–506)
**Sintomo:** 4 infermieri con 122h vengono accettati senza penalità hard.

**Fix — Step 1:** In `computeScore`, aggiungere penalità hard per ore sotto soglia:
```js
// Aggiungere nel corpo di computeScore, dopo il calcolo delle ore (circa riga 430):
const hardMinHours = ctx.rules.minHours || 0;
if (hardMinHours > 0) {
  for (let n = 0; n < numNurses; n++) {
    const h = nurseHours(schedule, n, numDays);
    const absShifts = ['F', 'MA', 'L104', 'PR', 'MT'];
    const isPurelyAbsent = schedule[n].every(s => absShifts.includes(s) || s === 'R');
    if (!isPurelyAbsent && h < hardMinHours) {
      hard += 1; // sotto la soglia minima assoluta
    }
  }
}
```

**Fix — Step 2:** In `collectViolations`, aggiungere il tipo di violazione `low_hours`:
```js
// Aggiungere verso la fine di collectViolations():
const hardMinHours = ctx.rules.minHours || 0;
if (hardMinHours > 0) {
  for (let n = 0; n < ctx.numNurses; n++) {
    const h = nurseHours(schedule, n, ctx.numDays);
    const absShifts = ['F', 'MA', 'L104', 'PR', 'MT'];
    const isPurelyAbsent = schedule[n].every(s => absShifts.includes(s) || s === 'R');
    if (!isPurelyAbsent && h < hardMinHours) {
      violations.push({
        type: 'low_hours',
        nurse: n,
        day: -1,
        msg: `${ctx.nurses[n].name}: ore totali ${h.toFixed(1)} < minimo ${hardMinHours}`,
      });
    }
  }
}
```

**Fix — Step 3:** Penalità asimmetrica per ore (punisce di più chi è SOTTO il target):
```js
// Sostituire la riga con Math.abs(hours[n] - target) * 3 (circa riga 435):
// PRIMA:
soft += Math.abs(hours[n] - target) * 3;

// DOPO:
const hourDiff = hours[n] - target;
soft += hourDiff < 0 ? Math.abs(hourDiff) * 5 : Math.abs(hourDiff) * 3;
// Punisce il sotto-utilizzo 67% di più rispetto al sovra-utilizzo
```

---

## BUG #4 — Temperatura SA sbagliata (lineare invece di esponenziale)

**File:** `js/solver/local-search.js`
**Riga:** ~62
**Sintomo:** Con `temp=2000` lineare, il SA accetta quasi qualsiasi mossa per le prime 1500 iterazioni su 4000.

**Fix:**
```js
// PRIMA (circa riga 62):
const temp = 2000 * (1 - fraction);

// DOPO:
// Cooling esponenziale calibrato per NSP 35×30:
// iter=0: temp≈120, iter=1000: temp≈60, iter=2000: temp≈30, iter=4000: temp≈0.1
const temp = useTimeLimit
  ? Math.max(0.1, 120 * Math.exp(-5 * fraction))
  : Math.max(0.1, 120 * Math.pow(0.9945, iter));
```

---

## BUG #5 — Fase 4.5 `construct.js` ignora turni D/N per weekly rest

**File:** `js/solver/construct.js`
**Righe:** ~681–707 (Phase 4.5 — Weekly rest enforcement)
**Sintomo:** Se una settimana ha solo N e D (nessun M/P convertibile), `minRPerWeek` non viene garantito.

**Fix:** Estendere il loop per tentare anche la conversione di D → R dopo M/P:
```js
// Nella fase 4.5, dopo il blocco che converte M/P, aggiungere un secondo tentativo con D:
// (inserire dopo il break alla riga ~703, dentro il while loop)
if (!converted && !nurseProps[n].noDiurni && !nurseProps[n].mattineEPomeriggi) {
  for (const d of wDays) {
    const s = schedule[n][d];
    if (s !== 'D') continue;
    const cov = dayCoverage(schedule, d, numNurses);
    // Converti D → R solo se la copertura M e P rimane sopra il minimo
    // (D conta per entrambi M e P, quindi rimuoverlo riduce entrambi)
    if (cov.M <= minCovM + 1 || cov.P <= minCovP + 1) continue;
    const prev = d > 0 ? schedule[n][d - 1] : null;
    const next = d < numDays - 1 ? schedule[n][d + 1] : null;
    if (transitionOk(prev, 'R', ctx, schedule, n, d) && transitionOk('R', next, ctx, schedule, n, d + 1)) {
      schedule[n][d] = 'R';
      rest++;
      converted = true;
      break;
    }
  }
}
```

---

## MIGLIORAMENTO #6 — Parametri SA: ADAPT_INTERVAL e iterazioni

**File:** `js/solver/constants.js` e `js/solver/local-search.js`
**Righe:** constants.js ~69–70, local-search.js ~41

**Fix in `constants.js`:**
```js
// PRIMA:
const NUM_RESTARTS = 10;
const LOCAL_SEARCH_ITERS = 4000;

// DOPO:
const NUM_RESTARTS = 8;           // meno restart, più iter per restart
const LOCAL_SEARCH_ITERS = 6000;  // +50% iterazioni per convergenza migliore
```

**Fix in `local-search.js`:**
```js
// PRIMA (circa riga 41):
const ADAPT_INTERVAL = 500;

// DOPO:
const ADAPT_INTERVAL = 1000; // adatta ogni 1000 iter (25% invece di 12.5%)
```

---

## MIGLIORAMENTO #7 — Pre-allocazione equità ore in Fase 3 (`construct.js`)

**File:** `js/solver/construct.js`
**Righe:** ~526–542 (funzione `avail()` e sorting nella Fase 3)
**Sintomo:** Il greedy sequenziale favorisce i primi infermieri della lista, causando squilibri di 36h.

**Fix:** Estendere il sorting in `avail()` con un deficit prospettico:

Aggiungere prima del loop `for (let d = 0; d < numDays; d++)` (circa riga 526):
```js
// Pre-calcola giorni rimanenti disponibili per ogni infermiere (approssimazione)
const daysAvailable = new Array(numNurses).fill(0);
for (let n = 0; n < numNurses; n++) {
  for (let dd = 0; dd < numDays; dd++) {
    if (schedule[n][dd] === null) daysAvailable[n]++;
  }
}
```

Modificare il sorting dentro `avail()` (circa riga 533–540):
```js
nurses.sort((a, b) => {
  const aOk = hasWeekBudget(a, d) ? 0 : 1;
  const bOk = hasWeekBudget(b, d) ? 0 : 1;
  if (aOk !== bOk) return aOk - bOk;

  const hd = ctx.hourDeltas;
  const aH = nurseHours(schedule, a, numDays) - (hd ? hd[a] || 0 : 0);
  const bH = nurseHours(schedule, b, numDays) - (hd ? hd[b] || 0 : 0);

  // Calcola deficit prospettico: quante ore mancano rispetto al target tenendo conto dei giorni rimasti
  const avgHoursPerDay = 12.2; // ore medie per turno D o N
  const aProspective = aH + daysAvailable[a] * avgHoursPerDay;
  const bProspective = bH + daysAvailable[b] * avgHoursPerDay;
  const aDeficit = ctx.monthlyTargetHours - aProspective;
  const bDeficit = ctx.monthlyTargetHours - bProspective;

  // Priorità a chi ha deficit prospettico più alto (rischio di restare sotto target)
  if (Math.abs(aDeficit - bDeficit) > 5) return bDeficit - aDeficit;
  return aH - bH;
});
```

---

## MIGLIORAMENTO #8 — Vincolo "isola di riposo" massima

**File:** `js/solver/scoring.js`
**Funzione:** `computeScore()` e `collectViolations()`
**Problema:** Fino a 7 R consecutivi osservati nei dati reali. Max ergonomicamente accettabile: 4.

**Fix in `computeScore`** (aggiungere dopo il loop delle violazioni settimanali, circa riga 480):
```js
// Penalità per isole di riposo eccessive (> 4 R consecutivi non obbligatori)
const MAX_REST_ISLAND = 4;
for (let n = 0; n < numNurses; n++) {
  let consRest = 0;
  for (let d = 0; d < numDays; d++) {
    if (schedule[n][d] === 'R' || schedule[n][d] === 'S') {
      consRest++;
    } else {
      if (consRest > MAX_REST_ISLAND) {
        soft += (consRest - MAX_REST_ISLAND) * 10;
      }
      consRest = 0;
    }
  }
  if (consRest > MAX_REST_ISLAND) {
    soft += (consRest - MAX_REST_ISLAND) * 10;
  }
}
```

**Fix in `collectViolations`** (aggiungere):
```js
// Violazione isola_di_riposo
const MAX_REST_ISLAND = 4;
for (let n = 0; n < ctx.numNurses; n++) {
  let consRest = 0;
  let islandStart = 0;
  for (let d = 0; d < ctx.numDays; d++) {
    if (schedule[n][d] === 'R' || schedule[n][d] === 'S') {
      if (consRest === 0) islandStart = d;
      consRest++;
    } else {
      if (consRest > MAX_REST_ISLAND) {
        violations.push({
          type: 'isola_di_riposo',
          nurse: n,
          day: islandStart,
          msg: `${ctx.nurses[n].name}: ${consRest} riposi consecutivi dal giorno ${islandStart + 1}`,
        });
      }
      consRest = 0;
    }
  }
}
```

---

## MIGLIORAMENTO #9 — Fix `construct.js` Fase 4.7: validazione coppia prima della copia

**File:** `js/solver/construct.js`
**Righe:** ~783–788 (Phase 4.7)
**Problema:** Copia cieca di n1→n2 senza verificare che n2 abbia gli stessi tag di n1. Se n1 è `no_diurni` e n2 è `diurni_e_notturni`, copia M/P a n2 viola i suoi vincoli.

**Fix:**
```js
// SOSTITUIRE le righe 783-788 con:
if (coppiaTurni && Array.isArray(coppiaTurni) && coppiaTurni.length === 2) {
  const [n1, n2] = coppiaTurni;
  if (n1 >= 0 && n1 < numNurses && n2 >= 0 && n2 < numNurses && n1 !== n2) {
    // Verifica compatibilità tag prima di copiare
    const p1 = nurseProps[n1];
    const p2 = nurseProps[n2];
    const sameType =
      p1.soloMattine === p2.soloMattine &&
      p1.soloDiurni === p2.soloDiurni &&
      p1.soloNotti === p2.soloNotti &&
      p1.diurniENotturni === p2.diurniENotturni &&
      p1.noDiurni === p2.noDiurni &&
      p1.mattineEPomeriggi === p2.mattineEPomeriggi;
    if (sameType) {
      for (let d = 0; d < numDays; d++) {
        if (!pinned[n2][d]) schedule[n2][d] = schedule[n1][d];
      }
    }
    // Se tag diversi, non copiare (la coppia con tag incompatibili non ha senso)
  }
}
```

---

## Ordine di Esecuzione Consigliato

Eseguire in questo ordine per massimizzare ROI e minimizzare rischi di regressione:

1. **BUG #4** — Fix temperatura SA (`local-search.js:62`) — modifica di 1 riga, zero rischio
2. **MIGLIORAMENTO #6** — Parametri SA (`constants.js`, `local-search.js:41`) — modifica di 3 righe
3. **BUG #1** — CoppiaTurni in `computeScore` (`scoring.js`) — aggiunge destructuring + penalità
4. **BUG #2** — `tryCoppiaTurniMove` (`local-search.js`) — nuova funzione + estensioni switch
5. **BUG #3** — Violazione hard ore basse (`scoring.js`) — nuova logica in collectViolations
6. **BUG #5** — Fase 4.5 D→R (`construct.js`) — estensione loop esistente
7. **MIGLIORAMENTO #7** — Pre-allocazione equità (`construct.js`) — modifica sorting avail()
8. **MIGLIORAMENTO #8** — Isola di riposo (`scoring.js`) — nuova penalità
9. **MIGLIORAMENTO #9** — Fix Fase 4.7 coppia (`construct.js`) — sostituzione blocco esistente

---

## Verifica Post-Implementazione

Dopo ogni modifica, eseguire:
```bash
cd C:\Users\arrep\Turni-infermieri
npm test
npm run lint
```

Per validare manualmente l'output, aprire `index.html` nel browser, caricare il file `config_turni_2026_5.csv` (Step 1 → importa config) e generare lo schedule con solver `fallback` (euristica pura, no MILP).

**Metriche di successo:**
- Range ore: da 122–158.6h → < 140–155h (σ < 5h)
- CoppiaTurni: schedule identici post-solve
- Media notti: da 5.56 → ≥ 5.8 per mese da 30 giorni
- Isole di riposo: nessun infermiere con > 4 R consecutivi non obbligatori
- Violazioni hard: 0 (stesso livello attuale)

---

## File da NON toccare

- `js/solver/lp-model.js` — formulazione MILP
- `js/solver/solvers.js` — orchestrazione HiGHS/GLPK
- `js/app.js` — UI e stato applicazione
- `index.html`, `css/custom.css`
- Qualsiasi file in `test/` (i test devono passare senza modifiche)
