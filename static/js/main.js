import { getState, setState, subscribe } from './state.js';
import { FileLoaderView }    from './views/file-loader.js';
import { ColumnMapperView }  from './views/column-mapper.js';
import { DRTView }           from './views/drt-viewer.js';
import { CircuitBuilderView } from './views/circuit-builder.js';
import { BoundsEditorView }  from './views/bounds-editor.js';
import { FittingRunnerView } from './views/fitting-runner.js';
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
  { step: 4, el: document.getElementById('view-4'), factory: CircuitBuilderView },
  { step: 5, el: document.getElementById('view-5'), factory: BoundsEditorView },
  { step: 6, el: document.getElementById('view-6'), factory: FittingRunnerView },
  { step: 7, el: document.getElementById('view-7'), factory: TrendsView },
];

const instances = {};
VIEWS.forEach(({ step, el, factory }) => {
  instances[step] = factory(el, { navigate, showToast });
});

// ── Navigation ───────────────────────────────────────────────────
export function navigate(step) {
  const state = getState();
  if (step > state.maxStep) return;

  const prev = state.step;
  setState({ step });

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

// ── Project save / load ─────────────────────────────────────────
function saveProject() {
  const s = getState();
  const project = {
    version:       1,
    files:         s.files,
    columnMap:     s.columnMap,
    charUnits:     s.charUnits,
    circuitString: s.circuitString,
    circuitTree:   s.circuitTree,
    circuitConfig: s.circuitConfig,
    fitResults:    s.fitResults,
    fitCacheKey:   s.fitCacheKey,
    fitTimeout:    s.fitTimeout,
    drtLambda:     s.drtLambda,
    maxStep:       s.maxStep,
  };
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'eis-project.json';
  a.click();
  URL.revokeObjectURL(url);
}

function loadProject(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const proj = JSON.parse(e.target.result);
      if (!proj.version) throw new Error('Not a valid EIS project file');
      setState({
        files:         proj.files         ?? [],
        columnMap:     proj.columnMap     ?? null,
        charUnits:     proj.charUnits     ?? {},
        circuitString: proj.circuitString ?? '',
        circuitTree:   proj.circuitTree   ?? { nodes: [] },
        circuitConfig: proj.circuitConfig ?? null,
        fitResults:    proj.fitResults    ?? [],
        fitCacheKey:   proj.fitCacheKey   ?? null,
        fitTimeout:    proj.fitTimeout    ?? 60,
        drtLambda:     proj.drtLambda     ?? 1e-3,
        maxStep:       proj.maxStep       ?? 1,
        step:          1,
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
