# 🏥 Turni Infermieri — Pronto Soccorso

Applicazione web per la **generazione automatica dei turni infermieristici** in Pronto Soccorso.
Nessun server, nessuna installazione: basta aprire `index.html` nel browser.

---

## ✨ Funzionalità

- **Wizard a 4 step** — Organico → Regole → Genera → Risultati
- **Motore di scheduling ibrido** — MILP (HiGHS via WASM) come solver primario, con fallback a euristica greedy + simulated annealing
- **Modifica interattiva** — click su una cella per cambiare turno manualmente
- **Soluzioni multiple** — genera e confronta diverse proposte, ordinate per qualità
- **Export** — CSV, JSON configurazione, stampa ottimizzata per A4 landscape
- **Dark mode** — tema chiaro/scuro con toggle
- **Persistenza locale** — tutto il lavoro è salvato in `localStorage`
- **100% offline** — funziona anche senza connessione (Tailwind CSS e HiGHS hanno fallback)

## 🚀 Come usare

1. **Apri `index.html`** in un browser moderno (Chrome, Firefox, Edge, Safari)
2. **Step 1 — Organico**: configura mese/anno, lista infermieri, tag (solo mattine, no notti, assenze…)
3. **Step 2 — Regole**: imposta coperture min/max per turno, ore target, limiti notti, vincoli aggiuntivi
4. **Step 3 — Genera**: scegli numero soluzioni e tempo di elaborazione, poi premi "Genera Turni"
5. **Step 4 — Risultati**: visualizza griglia turni, violazioni, statistiche; modifica manualmente se necessario

## 📁 Struttura del progetto

```
index.html        — Pagina unica: UI wizard a 4 step
js/app.js         — Logica applicativa: stato, rendering, eventi
js/solver.js      — Web Worker: motore di scheduling (MILP + euristica)
css/custom.css    — Stili CSS con variabili per temi chiaro/scuro
```

Nessun framework, nessun bundler, nessun `npm install`.

## 🔧 Codici turno

| Codice | Nome                   | Ore   |
|--------|------------------------|-------|
| M      | Mattina                | 6.2   |
| P      | Pomeriggio             | 6.2   |
| D      | Diurno (giornata)      | 12.2  |
| N      | Notte                  | 12.2  |
| S      | Smonto (post-notte)    | 0     |
| R      | Riposo                 | 0     |
| F      | Ferie                  | 6.12  |
| MA     | Malattia               | 6.12  |
| L104   | Legge 104              | 6.12  |
| PR     | Permesso Retribuito    | 6.12  |
| MT     | Maternità              | 6.12  |

## ⚙️ Motore di scheduling

Il solver gira in un **Web Worker** e usa una strategia a doppio livello:

1. **HiGHS MILP** (primario) — Costruisce una formulazione LP in formato CPLEX con variabili binarie di decisione, vincoli hard (copertura, transizioni, blocchi notte) e obiettivo di equità. Usa più seed con perturbazione dell'obiettivo per soluzioni diverse.

2. **Greedy + Simulated Annealing** (fallback) — Costruzione euristica multi-restart seguita da ricerca locale (swap, cambio turno, equità, riposo settimanale) con accettazione simulated annealing.

### Vincoli hard

- Copertura minima/massima giornaliera per tipo di turno
- Transizioni vietate (es. P→M, N deve essere seguito da S→R→R)
- Gap minimo 11 ore tra turni
- Riposo settimanale minimo
- Limite massimo notti per infermiere

### Obiettivi soft

- Equità ore lavorate tra infermieri
- Equità turni notturni
- Equità weekend lavorati

## 🖨️ Stampa ed export

- **Stampa**: la griglia è ottimizzata per stampa A4 landscape
- **CSV**: esporta la tabella turni in formato CSV
- **JSON**: salva/carica la configurazione completa (organico + regole)

## 💻 Requisiti tecnici

- Qualsiasi browser moderno con supporto Web Worker e ES6+
- Nessun server necessario — apri direttamente il file HTML
- Connessione internet opzionale (per Tailwind CSS CDN e HiGHS WASM CDN; in assenza vengono usati i fallback locali)

## 📄 Licenza

Questo progetto è distribuito come software libero.