// Global reactive state — pub/sub pattern, persisted to localStorage.

const STORAGE_KEY = 'eis-fitting-state';

const _defaults = {
  step: 1,
  maxStep: 1,       // highest step unlocked
  folderPath: '',
  files: [],
  discardedFiles: [],  // excluded from analysis but still shown (greyed) in previews
  detectedRoles: {},
  columnMap: null,
  circuitTree: { nodes: [] },
  circuitString: '',
  circuitConfig: null,
  optimizeConfig: { enabled: false, rc_min: 1, rc_max: 2, pair_types: ['CPE'], criterion: 'AIC', n_restarts: 1 },
  fitResults: [],
  fitCacheKey: null,
  drtResults: [],
  drtLambda: 1e-3,
  drtMode: 'imag',   // 'imag' (Im-only kernel) or 'complex' (joint Re+Im)
  drtSelectedFile: null,
  drtExpBattery: null,
  drtExpIdentifier: null,
  charUnits: {},
  charDecimalPlaces: {},
  fitFreqMin: null,
  fitFreqMax: null,
  fitWeighting: 'none',
  fitSolver: 'lm',
  omitInductive: false,
  excludeKKFlagged: true,  // drop KK-flagged (red) points from the fit
  kkData: {},     // path → { freqMin, freqMax, rsEst, M, mu, flaggedFreqs } from last KK run
  kkResults: [],  // full KKResult list — survives navigation so tiles keep their KK badges
  fitting: false,
  fitSubTab: 'batch',      // active sub-tab inside the Fit step: 'batch' | 'lab' | 'drt'
  batchSection: 'circuit', // active section inside Batch Fitting: 'circuit' | 'bounds' | 'run'
  fileConfigs: {},         // path → per-file fit config snapshot from the last batch run that included it
  labCircuit: null,        // selected EIS Lab card id (or '__batch__'), sticky across files
  labSelectedPath: null,   // file currently open in the EIS Lab
  labFits: {},             // path → lab FitResult attached as the file's "circuit fit" (overrides batch)
  labCircuits: [           // editable named circuit cards shown in the EIS Lab
    { id: 'rc',        name: 'R + RC',          circuit: 'R0-p(R1,C1)' },
    { id: 'rq',        name: 'R + RQ',          circuit: 'R0-p(R1,CPE1)' },
    { id: 'rc2',       name: 'R + 2×RC',        circuit: 'R0-p(R1,C1)-p(R2,C2)' },
    { id: 'rq2',       name: 'R + 2×RQ',        circuit: 'R0-p(R1,CPE1)-p(R2,CPE2)' },
    { id: 'rq3',       name: 'R + 3×RQ',        circuit: 'R0-p(R1,CPE1)-p(R2,CPE2)-p(R3,CPE3)' },
    { id: 'randles-w', name: 'Randles (W)',     circuit: 'R0-p(R1-W1,C1)' },
    { id: 'randles-q', name: 'Randles (Wo+Q)',  circuit: 'R0-p(R1-Wo1,CPE1)' },
    { id: 'l-rq',      name: 'L + R + RQ',      circuit: 'L0-R0-p(R1,CPE1)' },
    { id: 'l-rq2',     name: 'L + R + 2×RQ',    circuit: 'L0-R0-p(R1,CPE1)-p(R2,CPE2)' },
    { id: 'rq2-ws',    name: '2×RQ + Ws',       circuit: 'R0-p(R1,CPE1)-p(R2,CPE2)-Ws1' },
  ],
  _sv: 4,           // schema version — bump when step numbering changes
};

let _state = { ..._defaults };
const _listeners = new Set();

function _load() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      // Migration to schema v2: DRT inserted as step 3, steps 3-6 shifted to 4-7.
      // Re-derive maxStep from what data exists — handles all pre-migration states.
      if ((parsed._sv ?? 1) < 2) {
        let ms = 1;
        if (parsed.files?.length)   ms = Math.max(ms, 2);
        if (parsed.columnMap)        ms = Math.max(ms, 4);  // circuit builder now step 4
        if (parsed.circuitString)    ms = Math.max(ms, 5);  // bounds now step 5
        if (parsed.circuitConfig)    ms = Math.max(ms, 6);  // fit now step 6
        if (parsed.fitResults?.length) ms = Math.max(ms, 7); // trends now step 7
        parsed.maxStep = ms;
        if (parsed.step >= 3) parsed.step = Math.min(parsed.step + 1, 7);
        parsed._sv = 2;
      }
      // Migration to schema v3: Build Circuit / Set Bounds / Fit (4/5/6) merged
      // into a single Fit step 4; Trends moved 7 → 5.
      if (parsed._sv < 3) {
        const mapStep = n => (n >= 7 ? 5 : n >= 4 ? 4 : n);
        // Land users who were mid-flow on the right Batch Fitting section.
        if (parsed.step === 5)      parsed.batchSection = 'bounds';
        else if (parsed.step >= 6)  parsed.batchSection = 'run';
        parsed.step    = mapStep(parsed.step ?? 1);
        parsed.maxStep = mapStep(parsed.maxStep ?? 1);
        parsed._sv = 3;
      }
      // Migration to schema v4: DRT moved from step 3 into a Fit sub-tab —
      // Fit is now step 3, Trends step 4.
      if (parsed._sv < 4) {
        if (parsed.step === 3) parsed.fitSubTab = 'drt';   // was on the DRT step
        const mapStep = n => (n >= 5 ? 4 : n >= 4 ? 3 : n);
        parsed.step    = mapStep(parsed.step ?? 1);
        parsed.maxStep = mapStep(parsed.maxStep ?? 1);
        parsed._sv = 4;
      }
      _state = { ..._defaults, ...parsed, fitting: false };

      // Defensive: ensure maxStep is never lower than what saved data implies.
      // Guards against half-migrated states or in-dev schema bumps.
      if (_state.fitResults?.length)  _state.maxStep = Math.max(_state.maxStep, 4);
      if (_state.circuitConfig)        _state.maxStep = Math.max(_state.maxStep, 3);
      if (_state.circuitString)        _state.maxStep = Math.max(_state.maxStep, 3);
      if (_state.columnMap)            _state.maxStep = Math.max(_state.maxStep, 3);
      if (_state.files?.length)        _state.maxStep = Math.max(_state.maxStep, 2);
      _state.maxStep = Math.min(_state.maxStep, 4);
      _state.step    = Math.min(_state.step, _state.maxStep);
    }
  } catch (_) { /* ignore */ }
}

function _persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_state));
  } catch (_) { /* ignore */ }
}

export function getState() {
  return _state;
}

export function setState(patch) {
  _state = { ..._state, ...patch };
  _persist();
  for (const fn of _listeners) fn(_state);
}

export function subscribe(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function resetState() {
  _state = { ..._defaults };
  _persist();
  for (const fn of _listeners) fn(_state);
}

_load();
