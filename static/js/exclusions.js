// Manually excluded data points, keyed by file path and stored as frequency
// values (indices shift when a freq range is applied; frequencies don't).
// The backend matches them with np.isclose(rtol=1e-6) — mirror that here.
import { getState, setState } from './state.js';

const RTOL = 1e-6;

export function freqMatches(a, b) {
  return Math.abs(a - b) <= RTOL * Math.abs(b);
}

export function excludedFor(path) {
  return getState().excludedPoints?.[path] ?? [];
}

export function isExcluded(freq, list) {
  return list.some(f => freqMatches(freq, f));
}

export function toggleFreqs(path, freqs) {
  const cur = excludedFor(path);
  let next = [...cur];
  for (const f of freqs) {
    const i = next.findIndex(x => freqMatches(f, x));
    if (i === -1) next.push(f);
    else next.splice(i, 1);
  }
  setExcluded(path, next);
  return next;
}

export function addFreqs(path, freqs) {
  const cur = excludedFor(path);
  const next = [...cur];
  for (const f of freqs) {
    if (!next.some(x => freqMatches(f, x))) next.push(f);
  }
  setExcluded(path, next);
  return next;
}

export function clearExcluded(path) {
  setExcluded(path, []);
}

function setExcluded(path, list) {
  const all = { ...(getState().excludedPoints ?? {}) };
  if (list.length) all[path] = list;
  else delete all[path];
  setState({ excludedPoints: all });
}

// Frequencies to drop for a fit: manual exclusions plus KK-flagged points
// (the latter only when the "Exclude KK-flagged" option is on).
// Returns null when nothing should be dropped — the API field is optional.
export function excludeFreqsForFit(path, kkFlaggedFreqs) {
  const manual = excludedFor(path);
  const kk = kkFlaggedFreqs ?? [];
  const merged = [...manual];
  for (const f of kk) {
    if (!merged.some(x => freqMatches(f, x))) merged.push(f);
  }
  return merged.length ? merged : null;
}
