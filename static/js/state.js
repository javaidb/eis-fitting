// Global reactive state — pub/sub pattern, persisted to localStorage.

const STORAGE_KEY = 'eis-fitting-state';

const _defaults = {
  step: 1,
  maxStep: 1,       // highest step unlocked
  folderPath: '',
  files: [],
  detectedRoles: {},
  columnMap: null,
  circuitTree: { nodes: [] },
  circuitString: '',
  circuitConfig: null,
  optimizeConfig: { enabled: false, rc_min: 1, rc_max: 5, pair_types: ['CPE'], criterion: 'AIC', n_restarts: 1 },
  fitResults: [],
  fitCacheKey: null,
  drtResults: [],
  drtLambda: 1e-3,
  drtExpBattery: null,
  drtExpIdentifier: null,
  charUnits: {},
  charDecimalPlaces: {},
  fitFreqMin: null,
  fitFreqMax: null,
  fitWeightByModulus: true,
  fitSolver: 'lm',
  kkData: {},   // path → { freqMin, freqMax, rsEst, M, mu } from last KK run
  fitting: false,
  _sv: 2,           // schema version — bump when step numbering changes
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
      _state = { ..._defaults, ...parsed, fitting: false };

      // Defensive: ensure maxStep is never lower than what saved data implies.
      // Guards against half-migrated states or in-dev schema bumps.
      if (_state.fitResults?.length)  _state.maxStep = Math.max(_state.maxStep, 7);
      if (_state.circuitConfig)        _state.maxStep = Math.max(_state.maxStep, 6);
      if (_state.circuitString)        _state.maxStep = Math.max(_state.maxStep, 5);
      if (_state.columnMap)            _state.maxStep = Math.max(_state.maxStep, 3);
      if (_state.files?.length)        _state.maxStep = Math.max(_state.maxStep, 2);
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
