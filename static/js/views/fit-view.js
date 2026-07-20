// Fit step — composite view with three sub-tabs:
//   Batch Fitting: the classic Circuit → Bounds → Run pipeline (feeds Trends)
//   EIS Lab:       per-file playground — pick a predefined circuit, see the fit
//   DRT:           distribution of relaxation times (unchanged, just relocated)
import { getState, setState } from '../state.js';
import { CircuitBuilderView } from './circuit-builder.js';
import { BoundsEditorView }   from './bounds-editor.js';
import { FittingRunnerView }  from './fitting-runner.js';
import { EisLabView }         from './eis-lab.js';
import { DRTView }            from './drt-viewer.js';

const SECTIONS = ['circuit', 'bounds', 'run'];
const SECTION_LABELS = { circuit: 'Circuit', bounds: 'Bounds', run: 'Run' };

export function FitView(container, { navigate, showToast }) {

  container.innerHTML = `
    <div class="fit-subtab-bar">
      <button class="fit-subtab" data-tab="batch">Batch Fitting</button>
      <button class="fit-subtab" data-tab="lab">EIS Lab</button>
      <button class="fit-subtab" data-tab="drt">DRT</button>
      <div class="batch-stepper" id="batch-stepper">
        ${SECTIONS.map((s, i) => `
          <button class="batch-step" data-section="${s}">
            <span class="batch-step-num">${i + 1}</span>${SECTION_LABELS[s]}
          </button>`).join('')}
      </div>
    </div>
    <div class="fit-subview" id="fit-sub-circuit"></div>
    <div class="fit-subview" id="fit-sub-bounds"></div>
    <div class="fit-subview" id="fit-sub-run"></div>
    <div class="fit-subview" id="fit-sub-lab"></div>
    <div class="fit-subview" id="fit-sub-drt"></div>
  `;

  // Child navigate shim: 'circuit'/'bounds'/'run' move within Batch Fitting,
  // 'drt'/'lab' switch sub-tabs, numbers are real app steps and pass through.
  function subNavigate(target) {
    if (typeof target === 'string') {
      if (target === 'drt' || target === 'lab') { switchChild(target); return; }
      setSection(target, true);
      return;
    }
    navigate(target);
  }

  const els = {
    circuit: container.querySelector('#fit-sub-circuit'),
    bounds:  container.querySelector('#fit-sub-bounds'),
    run:     container.querySelector('#fit-sub-run'),
    lab:     container.querySelector('#fit-sub-lab'),
    drt:     container.querySelector('#fit-sub-drt'),
  };
  const children = {
    circuit: CircuitBuilderView(els.circuit, { navigate: subNavigate, showToast }),
    bounds:  BoundsEditorView(els.bounds,   { navigate: subNavigate, showToast }),
    run:     FittingRunnerView(els.run,     { navigate: subNavigate, showToast }),
    lab:     EisLabView(els.lab,            { navigate: subNavigate, showToast }),
    drt:     DRTView(els.drt,               { navigate: subNavigate, showToast }),
  };

  let _entered = false;   // only drive child onEnter/onLeave while this step is active

  // A section is reachable once the data it needs exists.
  function sectionEnabled(section) {
    const s = getState();
    if (section === 'circuit') return true;
    if (section === 'bounds')  return !!s.circuitString || !!s.optimizeConfig?.enabled;
    if (section === 'run')     return !!s.circuitConfig;
    return false;
  }

  // Which child (batch section, lab, or drt) is currently live, by state.
  function activeChildKey() {
    const s = getState();
    if (s.fitSubTab === 'lab') return 'lab';
    if (s.fitSubTab === 'drt') return 'drt';
    return SECTIONS.includes(s.batchSection) ? s.batchSection : 'circuit';
  }

  function syncUI() {
    const s = getState();
    const tab = s.fitSubTab === 'lab' ? 'lab' : s.fitSubTab === 'drt' ? 'drt' : 'batch';
    const active = activeChildKey();

    container.querySelectorAll('.fit-subtab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    container.querySelector('#batch-stepper').style.display = tab === 'batch' ? '' : 'none';
    container.querySelectorAll('.batch-step').forEach(btn => {
      const sec = btn.dataset.section;
      btn.classList.toggle('active', tab === 'batch' && sec === active);
      btn.classList.toggle('done', tab === 'batch' && SECTIONS.indexOf(sec) < SECTIONS.indexOf(s.batchSection) && sectionEnabled(sec));
      btn.disabled = !sectionEnabled(sec);
    });
    Object.entries(els).forEach(([key, el]) => el.classList.toggle('active', key === active));
  }

  function switchChild(nextKey) {
    const prevKey = activeChildKey();
    if (prevKey === nextKey) { syncUI(); children[nextKey]?.onEnter?.(); return; }
    if (_entered) children[prevKey]?.onLeave?.();
    if (nextKey === 'lab' || nextKey === 'drt') setState({ fitSubTab: nextKey });
    else setState({ fitSubTab: 'batch', batchSection: nextKey });
    syncUI();
    if (_entered) children[nextKey]?.onEnter?.();
  }

  function setSection(section, force = false) {
    if (!SECTIONS.includes(section)) return;
    if (!force && !sectionEnabled(section)) return;
    switchChild(section);
  }

  container.querySelectorAll('.fit-subtab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab === 'lab' || tab === 'drt') { switchChild(tab); return; }
      switchChild(SECTIONS.includes(getState().batchSection) ? getState().batchSection : 'circuit');
    });
  });
  container.querySelectorAll('.batch-step').forEach(btn => {
    btn.addEventListener('click', () => setSection(btn.dataset.section));
  });

  return {
    onEnter() {
      _entered = true;
      syncUI();
      children[activeChildKey()]?.onEnter?.();
    },
    onLeave() {
      children[activeChildKey()]?.onLeave?.();
      _entered = false;
    },
    // For the global header Next button: the active section's own Next, or null
    // in the Lab (where "next" just means the Trends step, if unlocked).
    getNextBtn() {
      const key = activeChildKey();
      if (key === 'lab') return null;
      return els[key].querySelector('#next-btn');
    },
  };
}
