# Turni Infermieri — Pronto Soccorso

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
[![Deploy](../../actions/workflows/deploy.yml/badge.svg)](../../actions/workflows/deploy.yml)

Applicazione web per la **generazione automatica dei turni infermieristici** in Pronto Soccorso.
Nessun server, nessuna installazione: basta aprire `index.html` nel browser.

---

## Funzionalita

- **Wizard a 4 step** — Organico → Regole → Genera → Risultati
- **Motore di scheduling ibrido** — MILP (HiGHS via WASM) come solver primario, euristica greedy + simulated annealing, e nuovo Pattern Beam a cicli profilo
- **Modifica interattiva** — click su una cella per cambiare turno manualmente
- **Soluzioni multiple** — genera e confronta diverse proposte, ordinate per qualita
- **Export** — CSV, JSON configurazione, stampa ottimizzata per A4 landscape
- **Dark mode** — tema chiaro/scuro con toggle
- **Persistenza locale** — tutto il lavoro e salvato in `localStorage`
- **100% offline** — funziona anche senza connessione (Tailwind CSS e HiGHS hanno fallback)

## Quick Start

```bash
# Just open in browser — no install needed
open index.html

# Or serve locally
npx http-server -p 8080 -c-1
# or
python3 -m http.server 8080
```

## Development Setup

```bash
# Install dev dependencies (linting, formatting, testing)
npm install

# Run all checks
npm run validate

# Individual commands
npm test              # Run solver unit tests
npm run lint          # ESLint check
npm run lint:fix      # ESLint auto-fix
npm run format        # Prettier format
npm run format:check  # Prettier check
npm run benchmark:accuracy # Compare heuristic vs Pattern Beam accuracy
npm run serve         # Local dev server on port 8080
```

## Project Structure

```
index.html                  Single-page UI: 4-step wizard
js/
  app.js                    Main application logic: state, rendering, events
  solver.js                 Web Worker entry point (loads modules via importScripts)
  solver/
    constants.js            Shift data, weights, utility functions
    context.js              Preprocessing: buildContext, getAbsenceShift
    scoring.js              Constraints, scoring, violations, stats
    construct.js            Greedy construction heuristic (8 phases)
    local-search.js         Simulated annealing + move functions
    pattern-planner.js       Pattern Beam cyclic profile planner
    lp-model.js             MILP LP formulation, solution parsers
    solvers.js              HiGHS/GLPK loaders, solve orchestration
css/
  custom.css                Styles with CSS variables for light/dark themes
test/
  solver.test.js            Unit tests for solver pure functions
.github/
  workflows/
    ci.yml                  CI pipeline: lint + format + test
    deploy.yml              GitHub Pages deployment
  copilot-instructions.md   AI assistant guidelines
CLAUDE.md                   Agent development guide
```

No framework, no bundler, no build step. Runtime dependencies load from CDN with offline fallbacks.
The solver modules share scope via `importScripts()` — no module system needed.

## Shift Codes

| Code | Name                   | Hours |
|------|------------------------|-------|
| M    | Mattina (Morning)      | 6.2   |
| P    | Pomeriggio (Afternoon) | 6.2   |
| D    | Diurno (Day-long)      | 12.2  |
| N    | Notte (Night)          | 12.2  |
| S    | Smonto (Post-night)    | 0     |
| R    | Riposo (Rest)          | 0     |
| F    | Ferie (Holiday)        | 6.12  |
| MA   | Malattia (Sick)        | 6.12  |
| L104 | Legge 104              | 6.12  |
| PR   | Permesso Retribuito    | 6.12  |
| MT   | Maternita              | 6.12  |

## Scheduling Engine

The solver runs in a **Web Worker** and uses a triple-strategy approach:

1. **HiGHS MILP** (primary) — Mathematical optimization via WASM. Binary decision variables, hard constraints, fairness objective with multiple seeds.

2. **GLPK.js** (secondary) — Alternative MILP solver. Same LP formulation, JavaScript implementation.

3. **Pattern Beam** (optional) — Profile-aware cyclic planner that selects whole-month nurse rows with beam search and shared repair passes.

4. **Greedy + Simulated Annealing** (fallback) — Multi-restart construction heuristic with local search. Always available, works offline.

### Hard Constraints
- Daily coverage min/max per shift type (M, P, D, N)
- Forbidden transitions (P->M, N must be followed by S->R->R)
- 11-hour minimum gap between consecutive shifts
- Weekly rest minimums (2+ real rest days per week)
- Night shift caps per nurse (soft + hard limits)

### Soft Objectives
- Hour equity across nurses (minimax fairness)
- Night shift distribution fairness
- D-shift (12h) equity among eligible nurses
- M/P balance for restricted nurses

## Tech Requirements

- Any modern browser with ES6+, Web Workers, and localStorage
- No server needed — open the HTML file directly
- Internet optional (CDN resources have local fallbacks)
- WebAssembly support recommended (for MILP solvers; heuristic fallback always works)

## CI/CD

- **Pull requests**: Automated linting, format checking, and unit tests via GitHub Actions
- **Main branch pushes**: Automatic deployment to GitHub Pages (only when runtime files change)

## License

This project is distributed as free software.
