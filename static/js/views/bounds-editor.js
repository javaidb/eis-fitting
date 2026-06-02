import { getState, setState } from '../state.js';
import { parseCircuit } from '../api.js';

const DEFAULTS = {
  R:     { initial: 0.01,   lower: 0,   upper: null },
  C:     { initial: 1e-6,   lower: 0,   upper: null },
  L:     { initial: 1e-7,   lower: 0,   upper: null },
  W:     { initial: 100,    lower: 0,   upper: null },
};
const DEFAULTS_CPE = [
  { initial: 1e-5, lower: 0,   upper: null  },  // Q
  { initial: 0.8,  lower: 0,   upper: 1.0   },  // α
];
const DEFAULTS_WO = [
  { initial: 100,  lower: 0,   upper: null  },  // R
  { initial: 1.0,  lower: 0,   upper: null  },  // τ
];

function checkPhysical(name, value) {
  if (/^R\d/.test(name)  && value < 0)          return 'negative resistance';
  if (/^C\d/.test(name)  && value <= 0)          return 'non-positive capacitance';
  if (/^C\d/.test(name)  && value > 1)           return 'C > 1 F (check units)';
  if (/^L\d/.test(name)  && value < 0)           return 'negative inductance';
  if (/^CPE\d+_1/.test(name) && (value < 0 || value > 1)) return 'α outside 0–1';
  if (/^(Wo|Ws|W)\d/.test(name) && value < 0)   return 'negative Warburg';
  return null;
}

function guessDefault(paramName) {
  // paramName examples: R0, C1, CPE0_0, CPE0_1, Wo1_0, Wo1_1, W2, L0
  if (/^CPE\d+_0/i.test(paramName)) return DEFAULTS_CPE[0];
  if (/^CPE\d+_1/i.test(paramName)) return DEFAULTS_CPE[1];
  if (/^Wo\d+_0|^Ws\d+_0/i.test(paramName)) return DEFAULTS_WO[0];
  if (/^Wo\d+_1|^Ws\d+_1/i.test(paramName)) return DEFAULTS_WO[1];
  const el = paramName.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
  return DEFAULTS[el] || { initial: 0.01, lower: 0, upper: null };
}

function fmtBound(v) {
  if (v === null || v === undefined) return '';
  return v;
}

export function BoundsEditorView(container, { navigate, showToast }) {

  let paramInfo = []; // [{name, unit}]

  async function render() {
    const state = getState();
    if (!state.circuitString) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚙</div><div>Build a circuit first.</div></div>';
      return;
    }

    // Fetch param names from backend
    try {
      const result = await parseCircuit(state.circuitString);
      paramInfo = result.param_names.map((name, i) => ({ name, unit: result.param_units[i] || '' }));
    } catch (err) {
      showToast(`Could not parse circuit: ${err.message}`, 'error');
      return;
    }

    // Load existing config or build defaults
    const cfg = state.circuitConfig;
    const rows = paramInfo.map((p, i) => {
      const def = guessDefault(p.name);
      return {
        name: p.name,
        unit: p.unit,
        initial: cfg?.initial_guess?.[i] ?? def.initial,
        lower:   cfg?.lower_bounds?.[i]  ?? def.lower,
        upper:   cfg?.upper_bounds?.[i]  ?? def.upper,
      };
    });

    container.innerHTML = `
      <div class="section-header">Set Bounds</div>
      <div class="section-sub">Configure initial guesses and search bounds for each parameter.
        Leave <em>Max</em> blank for no upper bound.</div>

      <div class="card">
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:14px;">
          <span class="card-title" style="margin:0; flex:1;">Parameters — ${state.circuitString}</span>
          <button class="btn btn-secondary btn-sm" id="suggest-btn">Suggest Defaults</button>
        </div>
        <table class="data-table">
          <thead>
            <tr>
              <th>Parameter</th>
              <th>Unit</th>
              <th>Initial Value</th>
              <th>Min</th>
              <th>Max</th>
            </tr>
          </thead>
          <tbody id="bounds-tbody">
            ${rows.map((r, i) => `
              <tr data-idx="${i}">
                <td><code style="color:var(--accent); font-size:13px;">${r.name}</code></td>
                <td style="color:var(--text-muted); font-size:12px;">${r.unit}</td>
                <td><input type="number" class="initial-val" data-i="${i}" value="${r.initial}" step="any"></td>
                <td><input type="number" class="lower-val"   data-i="${i}" value="${r.lower}"   step="any"></td>
                <td><input type="number" class="upper-val"   data-i="${i}" value="${fmtBound(r.upper)}" step="any" placeholder="∞"></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="step-actions">
        <button class="btn btn-secondary" id="back-btn">← Back</button>
        <div class="spacer"></div>
        <button class="btn btn-primary" id="next-btn">Next: Fit →</button>
      </div>
    `;

    container.querySelector('#suggest-btn').addEventListener('click', () => {
      paramInfo.forEach((p, i) => {
        const def = guessDefault(p.name);
        container.querySelector(`.initial-val[data-i="${i}"]`).value = def.initial;
        container.querySelector(`.lower-val[data-i="${i}"]`).value   = def.lower;
        container.querySelector(`.upper-val[data-i="${i}"]`).value   = def.upper ?? '';
      });
    });

    container.querySelector('#back-btn').addEventListener('click', () => navigate(4));
    container.querySelector('#next-btn').addEventListener('click', () => {
      const initial_guess = [], lower_bounds = [], upper_bounds = [];
      let valid = true;

      paramInfo.forEach((_, i) => {
        const iv = parseFloat(container.querySelector(`.initial-val[data-i="${i}"]`).value);
        const lo = parseFloat(container.querySelector(`.lower-val[data-i="${i}"]`).value);
        const upRaw = container.querySelector(`.upper-val[data-i="${i}"]`).value.trim();
        const up = upRaw === '' ? null : parseFloat(upRaw);

        if (isNaN(iv)) { valid = false; }
        initial_guess.push(iv);
        lower_bounds.push(isNaN(lo) ? 0 : lo);
        upper_bounds.push(up);
      });

      if (!valid) { showToast('Fill in all initial values.', 'error'); return; }

      const warnings = [];
      paramInfo.forEach((p, i) => {
        const w = checkPhysical(p.name, initial_guess[i]);
        if (w) warnings.push(`${p.name}: ${w}`);
      });
      if (warnings.length) showToast(`Unphysical values — ${warnings.join('; ')}`, 'warning');

      const circuitConfig = {
        circuit_string: state.circuitString,
        param_names:    paramInfo.map(p => p.name),
        initial_guess,
        lower_bounds,
        upper_bounds,
      };

      setState({ circuitConfig, maxStep: Math.max(getState().maxStep, 6) });
      navigate(6);
    });
  }

  return { onEnter: render };
}
