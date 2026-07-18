import { getState, setState, subscribe } from './state.js';
import { FileLoaderView }    from './views/file-loader.js';
import { ColumnMapperView }  from './views/column-mapper.js';
import { DRTView }           from './views/drt-viewer.js';
import { FitView }           from './views/fit-view.js';
import { TrendsView }        from './views/trends.js';

// ── Toast helper (exported so views can use it) ─────────────────
export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── View registry ────────────────────────────────────────────────
const VIEWS = [
  { step: 1, el: document.getElementById('view-1'), factory: FileLoaderView },
  { step: 2, el: document.getElementById('view-2'), factory: ColumnMapperView },
  { step: 3, el: document.getElementById('view-3'), factory: DRTView },
  { step: 4, el: document.getElementById('view-4'), factory: FitView },
  { step: 5, el: document.getElementById('view-5'), factory: TrendsView },
];

const instances = {};
VIEWS.forEach(({ step, el, factory }) => {
  instances[step] = factory(el, { navigate, showToast });
});

// ── Navigation ───────────────────────────────────────────────────
const STEP_LABELS = { 1: 'Load Files', 2: 'Map Columns', 3: 'DRT', 4: 'Fit', 5: 'Trends' };
const globalNextBtn = document.getElementById('global-next-btn');

function updateGlobalNext(step) {
  if (step >= 5) { globalNextBtn.style.display = 'none'; return; }
  globalNextBtn.style.display = '';
  // The Fit step advances through its own internal sections, so a fixed
  // "Next: <label>" would be misleading there.
  globalNextBtn.textContent = step === 4 ? 'Next →' : `Next: ${STEP_LABELS[step + 1]} →`;
}

// Proxy to the active view's own Next button so per-step validation and
// state commits (e.g. Map Columns building the columnMap) still run.
globalNextBtn.addEventListener('click', () => {
  const step = getState().step;
  if (step >= 5) return;
  const view = VIEWS.find(v => v.step === step);
  // Composite views (Fit) expose the Next button of their active section.
  const inst = instances[step];
  const viewNext = inst?.getNextBtn ? inst.getNextBtn() : view?.el.querySelector('#next-btn');
  if (viewNext) {
    if (viewNext.disabled) { showToast('Complete this step before continuing.', 'error'); return; }
    viewNext.click();
  } else if (step + 1 <= getState().maxStep) {
    navigate(step + 1);
  } else {
    showToast('Complete this step before continuing.', 'error');
  }
});

export function navigate(step) {
  const state = getState();
  if (step > state.maxStep) return;

  const prev = state.step;
  setState({ step });
  updateGlobalNext(step);

  VIEWS.forEach(({ step: s, el }) => {
    el.classList.toggle('active', s === step);
  });

  const nav = document.getElementById('step-nav');
  nav.querySelectorAll('.step-btn').forEach(btn => {
    const n = parseInt(btn.dataset.step, 10);
    btn.classList.toggle('active', n === step);
    btn.classList.toggle('done', n < step && n <= state.maxStep);
    btn.disabled = n > state.maxStep;
  });

  if (prev !== step) instances[prev]?.onLeave?.();
  instances[step]?.onEnter?.();
}

// ── Step-nav click handlers ──────────────────────────────────────
document.getElementById('step-nav').addEventListener('click', e => {
  const btn = e.target.closest('.step-btn');
  if (!btn || btn.disabled) return;
  navigate(parseInt(btn.dataset.step, 10));
});

// ── Filename helper ──────────────────────────────────────────────
export function buildFilename(folderPath, ext) {
  const folder = folderPath
    ? folderPath.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
    : '';
  const date = new Date().toISOString().slice(0, 10);
  const base = folder ? `${folder}_${date}` : `eis_${date}`;
  return `${base}.${ext}`;
}

// ── Project save / load ─────────────────────────────────────────
function saveProject() {
  const s = getState();
  const project = {
    version:            2,   // v2 = 5-step numbering (Fit merged), per-file configs
    files:              s.files,
    discardedFiles:     s.discardedFiles,
    columnMap:          s.columnMap,
    charUnits:          s.charUnits,
    charDecimalPlaces:  s.charDecimalPlaces,
    circuitString:      s.circuitString,
    circuitTree:        s.circuitTree,
    circuitConfig:      s.circuitConfig,
    fitResults:         s.fitResults,
    fileConfigs:        s.fileConfigs,
    labCircuit:         s.labCircuit,
    labCircuits:        s.labCircuits,
    fitCacheKey:        s.fitCacheKey,
    fitTimeout:         s.fitTimeout,
    fitWeighting:       s.fitWeighting ?? 'none',
    fitSolver:          s.fitSolver ?? 'lm',
    drtLambda:          s.drtLambda,
    maxStep:            s.maxStep,
  };
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = buildFilename(s.folderPath, 'json');
  a.click();
  URL.revokeObjectURL(url);
}

function loadProject(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const proj = JSON.parse(e.target.result);
      if (!proj.version) throw new Error('Not a valid EIS project file');
      // v1 projects used 7-step numbering (Circuit 4 / Bounds 5 / Fit 6 / Trends 7).
      let maxStep = proj.maxStep ?? 1;
      if (proj.version < 2) maxStep = maxStep >= 7 ? 5 : maxStep >= 4 ? 4 : maxStep;
      setState({
        files:              proj.files              ?? [],
        discardedFiles:     proj.discardedFiles     ?? [],
        columnMap:          proj.columnMap          ?? null,
        charUnits:          proj.charUnits          ?? {},
        charDecimalPlaces:  proj.charDecimalPlaces  ?? {},
        circuitString:      proj.circuitString      ?? '',
        circuitTree:        proj.circuitTree        ?? { nodes: [] },
        circuitConfig:      proj.circuitConfig      ?? null,
        fitResults:         proj.fitResults         ?? [],
        fileConfigs:        proj.fileConfigs        ?? {},
        labCircuit:         proj.labCircuit         ?? null,
        ...(proj.labCircuits?.length ? { labCircuits: proj.labCircuits } : {}),
        fitCacheKey:        proj.fitCacheKey        ?? null,
        fitTimeout:         proj.fitTimeout         ?? 60,
        fitWeighting:       proj.fitWeighting ?? 'none',
        fitSolver:          proj.fitSolver          ?? 'lm',
        drtLambda:          proj.drtLambda          ?? 1e-3,
        maxStep,
        step:               1,
      });
      navigate(1);
      showToast('Project loaded.', 'success');
    } catch (err) {
      showToast(`Failed to load project: ${err.message}`, 'error');
    }
  };
  reader.readAsText(file);
}

document.getElementById('save-project-btn').addEventListener('click', saveProject);
document.getElementById('load-project-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) { loadProject(file); e.target.value = ''; }
});

// ── Initial render ───────────────────────────────────────────────
const { step, maxStep } = getState();

// Sync disabled state for all buttons on load
document.getElementById('step-nav').querySelectorAll('.step-btn').forEach(btn => {
  const n = parseInt(btn.dataset.step, 10);
  btn.disabled = n > maxStep;
  btn.classList.toggle('done', n < step && n <= maxStep);
  btn.classList.toggle('active', n === step);
});

navigate(step);
