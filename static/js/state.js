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
  fitResults: [],
  fitCacheKey: null,
  charUnits: {},
  fitting: false,
};

let _state = { ..._defaults };
const _listeners = new Set();

function _load() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      _state = { ..._defaults, ...parsed, fitting: false };
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
