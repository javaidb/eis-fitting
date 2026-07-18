// EIS Lab — per-file circuit playground. Pick a file from the table, pick a
// circuit card, and the fit runs immediately with sensible default bounds.
// Cards are named and fully editable: the edit/add modal embeds the real
// drag-drop circuit builder, or accepts a plain circuit string.
// Keyboard: ↑/↓ walk the file rows, ←/→ cycle circuit cards.
import { getState, setState } from '../state.js';
import { parseCircuit, getSpectrum, streamFitting, characterizeFiles } from '../api.js';
import { guessDefault } from './bounds-editor.js';
import { mountCircuitEditor } from './circuit-builder.js';

const BATCH_CHIP = '__batch__';   // sentinel: use this file's saved batch config

function fmtNum(v) {
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (abs === 0) return '0';
  if (abs >= 1e-3 && abs < 1e4) {
    const dp = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 10 ? 2 : abs >= 1 ? 3 : abs >= 0.1 ? 4 : 5;
    const s = v.toFixed(dp);
    return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
  }
  return v.toExponential(3);
}

function paramUnitInfo(name) {
  if (/^R\d/.test(name))          return { scale: 1000, unit: 'mΩ' };
  if (/^C\d/.test(name))          return { scale: 1,    unit: 'F' };
  if (/^L\d/.test(name))          return { scale: 1,    unit: 'H' };
  if (/^CPE\d+_0/.test(name))     return { scale: 1,    unit: 'Ω⁻¹·sⁿ' };
  if (/^CPE\d+_1/.test(name))     return { scale: 1,    unit: '-' };
  if (/^W\d+(_0)?$/.test(name))   return { scale: 1,    unit: 'Ω·s½' };
  if (/^(Wo|Ws)\d+_0/.test(name)) return { scale: 1000, unit: 'mΩ' };
  if (/^(Wo|Ws)\d+_1/.test(name)) return { scale: 1,    unit: 's' };
  if (/^La\d+_0/.test(name))      return { scale: 1,    unit: 'H·sᵅ⁻¹' };
  if (/^La\d+_1/.test(name))      return { scale: 1,    unit: '-' };
  if (/^G\d+_0/.test(name))       return { scale: 1000, unit: 'mΩ' };
  if (/^G\d+_1/.test(name))       return { scale: 1,    unit: 's' };
  return                                  { scale: 1,    unit: '' };
}

function pathToSafeId(path) {
  return (path || '').replace(/[^a-zA-Z0-9]/g, '_');
}

export function EisLabView(container, { navigate, showToast }) {
  const fitCache      = new Map();  // cacheKey → FitResult
  const spectrumCache = new Map();  // path → { frequencies, z_real, z_imag }
  const parseCache    = new Map();  // circuit string → param_names
  const charMap       = new Map();  // path → characterization {label: value}

  let _abortCtrl = null;
  let _gen       = 0;      // bumped on every selection change / onLeave to drop stale async
  let _active    = false;  // view currently shown? (guards the characterization fetch)

  // Modal state
  let _modalEditor = null;   // handle from mountCircuitEditor
  let _modalCardId = null;   // card being edited, or null when adding
  let _modalTab    = 'builder';

  function files()       { return getState().files || []; }
  function selectedPath() {
    const s = getState();
    const fs = files();
    return fs.some(f => f.path === s.labSelectedPath) ? s.labSelectedPath : fs[0]?.path ?? null;
  }

  function cards() { return getState().labCircuits ?? []; }

  function charFields() {
    const fields = new Set();
    for (const c of charMap.values())
      for (const k of Object.keys(c || {})) fields.add(k);
    return [...fields].sort();
  }

  // Selectable chips for a file, in display order (batch chip only when a
  // saved per-file config exists).
  function chipList(path) {
    const chips = [];
    if (getState().fileConfigs?.[path]?.circuitConfig) chips.push(BATCH_CHIP);
    chips.push(...cards().map(c => c.id));
    return chips;
  }

  // Resolve a chip id to the circuit string it represents (null if unknown).
  function circuitStringFor(chip, path) {
    if (chip === BATCH_CHIP)
      return getState().fileConfigs?.[path]?.circuitConfig?.circuit_string ?? null;
    return cards().find(c => c.id === chip)?.circuit ?? null;
  }

  function settingsSig() {
    const s = getState();
    return JSON.stringify([s.fitFreqMin, s.fitFreqMax, s.fitWeighting ?? 'none',
                           s.fitSolver ?? 'lm', s.omitInductive ?? false, s.fitTimeout ?? 60]);
  }

  // Cache on circuit CONTENT, not card id — editing a card invalidates its fits.
  function cacheKey(path, chip) {
    const extra = chip === BATCH_CHIP
      ? JSON.stringify(getState().fileConfigs?.[path]?.circuitConfig ?? null)
      : circuitStringFor(chip, path);
    return `${path}::${chip}::${extra}::${settingsSig()}`;
  }

  async function circuitConfigFor(chip, path) {
    if (chip === BATCH_CHIP) {
      const saved = getState().fileConfigs?.[path];
      if (!saved?.circuitConfig) throw new Error('No saved batch config for this file');
      return saved.circuitConfig;
    }
    const circuit = circuitStringFor(chip, path);
    if (!circuit) throw new Error('Unknown circuit');
    let paramNames = parseCache.get(circuit);
    if (!paramNames) {
      const res = await parseCircuit(circuit);
      paramNames = res.param_names;
      parseCache.set(circuit, paramNames);
    }
    const defs = paramNames.map(guessDefault);
    return {
      circuit_string: circuit,
      param_names:    paramNames,
      initial_guess:  defs.map(d => d.initial),
      lower_bounds:   defs.map(d => d.lower),
      upper_bounds:   defs.map(d => d.upper),
    };
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  function render() {
    const state = getState();
    const fs = files();
    if (!fs.length || !state.columnMap) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🧪</div>
        <div>Load files and map columns first to use the EIS Lab.</div></div>`;
      return;
    }

    const path = selectedPath();
    const chip = state.labCircuit;
    const hasBatchCfg = !!state.fileConfigs?.[path]?.circuitConfig;
    const batchCircuit = state.fileConfigs?.[path]?.circuitConfig?.circuit_string;
    const fields = charFields();

    container.innerHTML = `
      <div class="section-header">EIS Lab</div>
      <div class="section-sub">Try circuits on one file at a time — the fit runs as soon as you pick one.
        <span class="lab-key-hint">⌨ ↑/↓ file &nbsp;·&nbsp; ←/→ circuit</span></div>

      <div class="lab-main">
        <div class="lab-sidebar">
          <div class="lab-sidebar-title">Circuits</div>
          ${hasBatchCfg ? `
            <button class="lab-chip lab-chip-batch ${chip === BATCH_CHIP ? 'active' : ''}" data-chip="${BATCH_CHIP}"
                    title="This file's config from the last batch run">
              ★ Batch config
              <span class="lab-chip-circuit">${batchCircuit}</span>
            </button>` : ''}
          ${cards().map(c => `
            <button class="lab-chip ${chip === c.id ? 'active' : ''}" data-chip="${c.id}">
              <span class="lab-chip-head">
                <span class="lab-chip-name">${c.name}</span>
                <span class="lab-chip-actions">
                  <span class="lab-chip-act" data-edit="${c.id}" title="Edit name / circuit">✎</span>
                  <span class="lab-chip-act lab-chip-act-del" data-delete="${c.id}" title="Delete circuit">✕</span>
                </span>
              </span>
              <span class="lab-chip-circuit">${c.circuit}</span>
            </button>`).join('')}
          <button class="btn btn-secondary btn-sm" id="lab-add-btn" style="margin-top:6px;">+ Add circuit</button>
        </div>

        <div class="lab-content">
          <div class="lab-result-header">
            <span id="lab-file-label" style="font-size:13px;font-weight:600;"></span>
            <span id="lab-circuit-label" style="font-family:monospace;font-size:13px;color:var(--accent);"></span>
            <span class="residual-badge" id="lab-badge" style="display:none;"></span>
            <span id="lab-status" style="font-size:12px;color:var(--text-muted);"></span>
          </div>
          <div class="lab-plot" id="lab-plot"></div>
          <div class="params-summary" id="lab-params"></div>
        </div>
      </div>

      <div class="lab-file-table-wrap" id="lab-file-table-wrap">
        <table class="data-table lab-file-table">
          <thead>
            <tr>
              <th style="width:32px;">#</th>
              <th>File</th>
              ${fields.map(f => `<th>${f}</th>`).join('')}
              <th>Batch circuit</th>
            </tr>
          </thead>
          <tbody>
            ${fs.map((f, i) => {
              const char = charMap.get(f.path) || {};
              const saved = state.fileConfigs?.[f.path]?.circuitConfig?.circuit_string;
              return `
              <tr class="lab-file-row ${f.path === path ? 'selected' : ''}" data-path="${f.path}" id="lab-row-${pathToSafeId(f.path)}">
                <td style="color:var(--text-muted);">${i + 1}</td>
                <td>${f.filename}</td>
                ${fields.map(k => {
                  const v = char[k];
                  return `<td>${v == null ? '—' : (typeof v === 'number' ? fmtNum(v) : v)}</td>`;
                }).join('')}
                <td style="font-family:monospace;font-size:11px;color:var(--text-muted);">${saved ?? '—'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>

      <div class="lab-modal-overlay" id="lab-modal" style="display:none;">
        <div class="lab-modal">
          <div class="lab-modal-header">
            <span id="lab-modal-title">Add circuit</span>
            <button class="fit-modal-close" id="lab-modal-close" title="Close (Esc)">✕</button>
          </div>
          <label class="lab-modal-field">
            <span>Name</span>
            <input type="text" id="lab-name-input" placeholder="e.g. My 2×RQ + Warburg">
          </label>
          <div class="lab-modal-tabs">
            <button class="tab-btn" data-mtab="builder">Circuit Builder</button>
            <button class="tab-btn" data-mtab="text">Text</button>
          </div>
          <div id="lab-editor-host" class="lab-editor-host"></div>
          <div id="lab-text-pane" class="lab-modal-field" style="display:none;">
            <span>Circuit string</span>
            <input type="text" id="lab-circuit-input" placeholder="e.g. R0-p(R1,CPE1)-W1" style="font-family:monospace;">
          </div>
          <div class="lab-modal-actions">
            <button class="btn btn-secondary" id="lab-modal-cancel">Cancel</button>
            <button class="btn btn-primary" id="lab-modal-save">Save</button>
          </div>
        </div>
      </div>
    `;

    container.querySelectorAll('.lab-chip').forEach(btn => {
      btn.addEventListener('click', e => {
        const edit = e.target.closest('[data-edit]');
        if (edit) { openModal(edit.dataset.edit); return; }
        const del = e.target.closest('[data-delete]');
        if (del) { deleteCard(del.dataset.delete); return; }
        selectChip(btn.dataset.chip);
      });
    });
    container.querySelector('#lab-add-btn').addEventListener('click', () => openModal(null));
    container.querySelectorAll('.lab-file-row').forEach(row => {
      row.addEventListener('click', () => selectFile(row.dataset.path));
    });

    // Modal wiring
    container.querySelector('#lab-modal-close').addEventListener('click', closeModal);
    container.querySelector('#lab-modal-cancel').addEventListener('click', closeModal);
    container.querySelector('#lab-modal-save').addEventListener('click', saveModal);
    container.querySelector('#lab-modal').addEventListener('mousedown', e => {
      if (e.target === e.currentTarget) closeModal();
    });
    container.querySelectorAll('[data-mtab]').forEach(btn => {
      btn.addEventListener('click', () => setModalTab(btn.dataset.mtab));
    });

    const row = container.querySelector('.lab-file-row.selected');
    row?.scrollIntoView({ block: 'nearest' });
  }

  // ── Card modal (add / edit) ────────────────────────────────────────────────

  function modalOpen() {
    return container.querySelector('#lab-modal')?.style.display !== 'none';
  }

  async function openModal(cardId) {
    const card = cardId ? cards().find(c => c.id === cardId) : null;
    _modalCardId = card?.id ?? null;
    _modalTab = 'builder';

    const modal = container.querySelector('#lab-modal');
    modal.style.display = '';
    container.querySelector('#lab-modal-title').textContent = card ? 'Edit circuit' : 'Add circuit';
    container.querySelector('#lab-name-input').value = card?.name ?? '';
    container.querySelector('#lab-circuit-input').value = card?.circuit ?? '';
    syncModalTabUI();

    // Embed the real circuit builder; keep the text input in sync as it changes
    _modalEditor?.destroy();
    _modalEditor = await mountCircuitEditor(container.querySelector('#lab-editor-host'), {
      initial: card?.circuit ?? '',
      showToast,
      onChange: str => { container.querySelector('#lab-circuit-input').value = str; },
    });

    container.querySelector('#lab-name-input').focus();
  }

  function closeModal() {
    _modalEditor?.destroy();
    _modalEditor = null;
    _modalCardId = null;
    const modal = container.querySelector('#lab-modal');
    if (modal) modal.style.display = 'none';
  }

  function setModalTab(tab) {
    // Moving text → builder: load the typed string into the canvas
    if (tab === 'builder' && _modalTab === 'text' && _modalEditor) {
      const str = container.querySelector('#lab-circuit-input').value.trim();
      try {
        _modalEditor.setCircuit(str);
      } catch (err) {
        showToast(`Invalid circuit string: ${err.message}`, 'error');
        return;   // stay on the text tab until it parses
      }
    }
    _modalTab = tab;
    syncModalTabUI();
  }

  function syncModalTabUI() {
    container.querySelectorAll('[data-mtab]').forEach(b =>
      b.classList.toggle('active', b.dataset.mtab === _modalTab));
    container.querySelector('#lab-editor-host').style.display = _modalTab === 'builder' ? '' : 'none';
    container.querySelector('#lab-text-pane').style.display   = _modalTab === 'text' ? '' : 'none';
  }

  async function saveModal() {
    const name = container.querySelector('#lab-name-input').value.trim();
    if (!name) { showToast('Give the circuit a name.', 'error'); return; }

    const circuit = _modalTab === 'builder'
      ? _modalEditor?.getCircuit() ?? ''
      : container.querySelector('#lab-circuit-input').value.trim();
    if (!circuit) { showToast('Build or type a circuit first.', 'error'); return; }

    // Validate against the backend parser before accepting it
    try {
      const res = await parseCircuit(circuit);
      parseCache.set(circuit, res.param_names);
    } catch (err) {
      showToast(`Invalid circuit: ${err.message}`, 'error');
      return;
    }

    const existing = cards();
    let id = _modalCardId;
    let next;
    if (id) {
      next = existing.map(c => c.id === id ? { ...c, name, circuit } : c);
    } else {
      id = `c${Date.now().toString(36)}`;
      next = [...existing, { id, name, circuit }];
    }
    setState({ labCircuits: next });
    closeModal();
    render();
    selectChip(id);
  }

  function deleteCard(cardId) {
    const s = getState();
    const patch = { labCircuits: cards().filter(c => c.id !== cardId) };
    if (s.labCircuit === cardId) patch.labCircuit = null;
    setState(patch);
    render();
    update();
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  function selectFile(path) {
    if (path === selectedPath()) return;
    setState({ labSelectedPath: path });
    render();   // batch chip + row highlight depend on the file
    update();
  }

  function selectChip(chip) {
    setState({ labCircuit: chip });
    container.querySelectorAll('.lab-chip').forEach(b =>
      b.classList.toggle('active', b.dataset.chip === chip));
    container.querySelector(`.lab-chip[data-chip="${CSS.escape(chip)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
    update();
  }

  function stepFile(dir) {
    const fs = files();
    const idx = fs.findIndex(f => f.path === selectedPath());
    const next = Math.min(fs.length - 1, Math.max(0, idx + dir));
    if (next !== idx) selectFile(fs[next].path);
  }

  function stepChip(dir) {
    const chips = chipList(selectedPath());
    if (!chips.length) return;
    const cur = getState().labCircuit;
    const idx = chips.indexOf(cur);
    // Nothing selected yet: start at the first / last chip
    const next = idx === -1
      ? (dir > 0 ? 0 : chips.length - 1)
      : (idx + dir + chips.length) % chips.length;
    selectChip(chips[next]);
  }

  function onKeyDown(e) {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target?.tagName)) return;
    if (modalOpen()) {
      if (e.key === 'Escape') closeModal();
      return;   // arrows must not switch file/circuit under the modal
    }
    if      (e.key === 'ArrowDown')  { e.preventDefault(); stepFile(1); }
    else if (e.key === 'ArrowUp')    { e.preventDefault(); stepFile(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); stepChip(1); }
    else if (e.key === 'ArrowLeft')  { e.preventDefault(); stepChip(-1); }
  }

  // ── Fitting ────────────────────────────────────────────────────────────────

  // Run (or restore) whatever the current selection implies.
  async function update() {
    const myGen = ++_gen;
    _abortCtrl?.abort();

    const state = getState();
    const path  = selectedPath();
    if (!path) return;
    let chip = state.labCircuit;
    // Sticky batch chip doesn't apply to files without a saved config;
    // a deleted card leaves a dangling id — treat both as "nothing selected".
    if (chip && !chipList(path).includes(chip)) chip = null;

    const fileLabel = container.querySelector('#lab-file-label');
    const labelEl   = container.querySelector('#lab-circuit-label');
    const statusEl  = container.querySelector('#lab-status');
    const badgeEl   = container.querySelector('#lab-badge');
    const paramsEl  = container.querySelector('#lab-params');
    if (!labelEl) return;

    fileLabel.textContent = files().find(f => f.path === path)?.filename ?? '';

    if (!chip) {
      labelEl.textContent = '';
      badgeEl.style.display = 'none';
      statusEl.textContent = 'Pick a circuit to fit this file.';
      paramsEl.innerHTML = '';
      await showSpectrumOnly(path, myGen);
      return;
    }

    const circuitStr = circuitStringFor(chip, path);
    labelEl.textContent = chip === BATCH_CHIP ? `★ ${circuitStr ?? ''}` : circuitStr ?? '';

    const key = cacheKey(path, chip);
    if (fitCache.has(key)) {
      renderResult(fitCache.get(key));
      return;
    }

    badgeEl.style.display = 'none';
    paramsEl.innerHTML = '';
    statusEl.textContent = 'Fitting…';
    await showSpectrumOnly(path, myGen);   // show the data while the fit runs
    if (_gen !== myGen) return;

    try {
      const circuitConfig = await circuitConfigFor(chip, path);
      if (_gen !== myGen) return;

      const file = files().find(f => f.path === path);
      const kk = state.kkData?.[path];
      const request = {
        files: [{
          ...file,
          rs_estimate:   kk?.rsEst ?? null,
          exclude_freqs: (state.excludeKKFlagged ?? true) && kk?.flaggedFreqs?.length ? kk.flaggedFreqs : null,
        }],
        column_map:      { ...state.columnMap, decimal_places: state.charDecimalPlaces ?? {} },
        circuit_config:  circuitConfig,
        fit_timeout:     state.fitTimeout ?? 60,
        optimize_config: { enabled: false },
        freq_min:        state.fitFreqMin ?? null,
        freq_max:        state.fitFreqMax ?? null,
        weighting:       state.fitWeighting ?? 'none',
        solver:          state.fitSolver ?? 'lm',
        omit_inductive:  state.omitInductive ?? false,
      };

      _abortCtrl = new AbortController();
      let result = null;
      for await (const event of streamFitting(request, _abortCtrl.signal)) {
        if (event.event === 'result') result = event.data;
      }
      if (_gen !== myGen) return;
      if (!result) throw new Error('No result returned');
      fitCache.set(key, result);
      renderResult(result);
    } catch (err) {
      if (err.name === 'AbortError' || _gen !== myGen) return;
      statusEl.textContent = '';
      badgeEl.style.display = '';
      badgeEl.className = 'residual-badge failed';
      badgeEl.textContent = 'ERROR';
      showToast(`Lab fit error: ${err.message}`, 'error');
    }
  }

  async function showSpectrumOnly(path, myGen) {
    let spec = spectrumCache.get(path);
    if (!spec) {
      try {
        spec = await getSpectrum({ path, column_map: getState().columnMap });
        spectrumCache.set(path, spec);
      } catch (_) { return; }
    }
    if (_gen !== myGen) return;
    plotNyquist({ frequencies: spec.frequencies, z_real_data: spec.z_real, z_imag_data: spec.z_imag });
  }

  function renderResult(result) {
    const statusEl = container.querySelector('#lab-status');
    const badgeEl  = container.querySelector('#lab-badge');
    const paramsEl = container.querySelector('#lab-params');
    if (!statusEl) return;

    statusEl.textContent = '';
    badgeEl.style.display = '';
    if (result.success) {
      const good = result.residual != null && result.residual < 0.05;
      badgeEl.className = `residual-badge ${good ? 'good' : 'poor'}`;
      badgeEl.textContent = result.residual != null ? `${(result.residual * 100).toFixed(2)}%` : '—';
    } else {
      badgeEl.className = 'residual-badge failed';
      badgeEl.textContent = 'FAILED';
      statusEl.textContent = result.error ?? '';
    }

    paramsEl.innerHTML = Object.entries(result.parameters || {})
      .map(([k, v]) => {
        const { scale, unit } = paramUnitInfo(k);
        const disp = typeof v === 'number' ? fmtNum(v * scale) : v;
        return `<span>${k}</span>${disp}${unit ? ' ' + unit : ''}`;
      }).join(' &nbsp; ');

    plotNyquist(result);
  }

  function plotNyquist(result) {
    const el = container.querySelector('#lab-plot');
    if (!el || typeof Plotly === 'undefined') return;

    const traces = [];
    if (result.z_real_data?.length) {
      traces.push({
        x: result.z_real_data, y: result.z_imag_data.map(v => -v),
        mode: 'markers', name: 'Data',
        marker: { color: '#4a9ade', size: 6 },
        text: (result.frequencies || []).map(f => f != null ? `${Number(f).toPrecision(4)} Hz` : ''),
        hovertemplate: "%{text}<br>Z'=%{x:.4g} Ω<br>-Z''=%{y:.4g} Ω<extra></extra>",
      });
    }
    if (result.z_real_fit?.length) {
      traces.push({
        x: result.z_real_fit, y: result.z_imag_fit.map(v => -v),
        mode: 'lines', name: 'Fit',
        line: { color: '#64dc96', width: 2 },
        hovertemplate: "Z'=%{x:.4g} Ω<br>-Z''=%{y:.4g} Ω<extra></extra>",
      });
    }
    Plotly.newPlot(el, traces, {
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      margin: { t: 8, r: 16, b: 48, l: 64 },
      font:   { color: '#8892b0', size: 11 },
      xaxis:  { title: "Z' (Ω)", color: '#8892b0', gridcolor: '#2d3147', zeroline: true, zerolinecolor: '#4a5080' },
      yaxis:  { title: "-Z'' (Ω)", color: '#8892b0', gridcolor: '#2d3147', zeroline: true, zerolinecolor: '#4a5080', scaleanchor: 'x', scaleratio: 1 },
      legend: { x: 0.5, y: 0.98, font: { size: 10 } },
      showlegend: true,
    }, { displayModeBar: false, responsive: true });
  }

  return {
    async onEnter() {
      // Idempotent: remove first so repeated onEnter calls never stack listeners.
      document.removeEventListener('keydown', onKeyDown);
      document.addEventListener('keydown', onKeyDown);

      _active = true;
      render();
      update();

      // Characterization identifiers for the file table (async, then re-render)
      const s = getState();
      if (s.files?.length && s.columnMap && !charMap.size) {
        try {
          const data = await characterizeFiles({
            files: s.files,
            column_map: { ...s.columnMap, decimal_places: s.charDecimalPlaces ?? {} },
          });
          if (!_active) return;
          for (const { path, characterization } of data) charMap.set(path, characterization);
          // Don't rebuild the DOM under an open editor modal — the identifiers
          // will appear on the next natural re-render.
          if (!modalOpen()) { render(); update(); }
        } catch (_) {}
      }
    },
    onLeave() {
      _active = false;
      ++_gen;
      _abortCtrl?.abort();
      closeModal();
      document.removeEventListener('keydown', onKeyDown);
    },
  };
}
