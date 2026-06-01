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
