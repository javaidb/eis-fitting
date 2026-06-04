import { getState, setState } from '../state.js';
import { characterizeFiles, streamFitting, streamKK } from '../api.js';

const GOOD_THRESHOLD = 0.05;

function checkPhysical(name, value) {
  if (/^R\d/.test(name)  && value < 0)          return 'negative resistance';
  if (/^C\d/.test(name)  && value <= 0)          return 'non-positive capacitance';
  if (/^C\d/.test(name)  && value > 1)           return 'C > 1 F (check units)';
  if (/^L\d/.test(name)  && value < 0)           return 'negative inductance';
  if (/^CPE\d+_1/.test(name) && (value < 0 || value > 1)) return 'α outside 0–1';
  if (/^(Wo|Ws|W)\d/.test(name) && value < 0)   return 'negative Warburg';
  return null;
}

function paramUnitInfo(name) {
  if (/^R\d/.test(name))          return { scale: 1000, unit: 'mΩ' };
  if (/^C\d/.test(name))          return { scale: 1,    unit: 'F' };
  if (/^L\d/.test(name))          return { scale: 1,    unit: 'H' };
  if (/^CPE\d+_0/.test(name))     return { scale: 1,    unit: 'Ω⁻¹·sⁿ' };
  if (/^CPE\d+_1/.test(name))     return { scale: 1,    unit: '-' };
  if (/^W\d+(_0)?$/.test(name))   return { scale: 1,    unit: 'Ω·s½' };
  if (/^Wo\d+_0/.test(name))      return { scale: 1000, unit: 'mΩ' };
  if (/^Wo\d+_1/.test(name))      return { scale: 1,    unit: 's' };
  if (/^Wo\d+_2/.test(name))      return { scale: 1,    unit: '-' };
  if (/^Ws\d+_0/.test(name))      return { scale: 1000, unit: 'mΩ' };
  if (/^Ws\d+_1/.test(name))      return { scale: 1,    unit: 's' };
  if (/^Ws\d+_2/.test(name))      return { scale: 1,    unit: '-' };
  if (/^La\d+_0/.test(name))      return { scale: 1,    unit: 'H' };
  if (/^La\d+_1/.test(name))      return { scale: 1000, unit: 'mΩ' };
  return                                  { scale: 1,    unit: '' };
}

function configKey(state) {
  return JSON.stringify({
    files:    (state.files || []).map(f => f.path),
    col:      state.columnMap,
    circuit:  state.circuitConfig,
    timeout:  state.fitTimeout ?? 60,
    optimize: state.optimizeConfig ?? { enabled: false },
    freqMin:  state.fitFreqMin ?? null,
    freqMax:  state.fitFreqMax ?? null,
    weight:   state.fitWeightByModulus ?? true,
    solver:   state.fitSolver ?? 'lm',
  });
}

function parentFolder(path) {
  const parts = (path || '').replace(/\\/g, '/').split('/');
  return parts.length >= 2 ? parts[parts.length - 2] : 'Files';
}

function groupFiles(files) {
  const groups = new Map();
  for (const f of files) {
    const folder = parentFolder(f.path);
    if (!groups.has(folder)) groups.set(folder, { label: folder, files: [] });
    groups.get(folder).files.push(f);
  }
  return groups;
}

function pathToSafeId(path) {
  return (path || '').replace(/[^a-zA-Z0-9]/g, '_');
}

// ── KK tile state helpers ──────────────────────────────────────────────────

function kkTileState(kk) {
  if (!kk.success)                        return { cls: 'kk-fail', label: 'KK ✗' };
  if (kk.flagged_indices?.length > 0)     return { cls: 'kk-warn', label: `KK ⚠ ${kk.flagged_indices.length} pts` };
  return                                           { cls: 'kk-ok',   label: 'KK ✓' };
}

export function FittingRunnerView(container, { navigate, showToast }) {
  const resultMap = new Map();   // path → FitResult
  const charMap   = new Map();   // path → characterization
  const kkMap     = new Map();   // path → KKResult

  let binByField = '';
  let sortByBest = false;

  function getCharFields() {
    const fields = new Set();
    for (const r of resultMap.values())
      for (const k of Object.keys(r.characterization || {})) fields.add(k);
    for (const c of charMap.values())
      for (const k of Object.keys(c)) fields.add(k);
    if (!fields.size)
      for (const k of Object.keys(getState().charUnits || {})) fields.add(k);
    return [...fields].sort();
  }

  function rebuildGrid() {
    const tileRoot = container.querySelector('#fit-tile-root');
    if (!tileRoot) return;
    tileRoot.innerHTML = buildTileGrid(getState().files || []);
    wireTileClicks();
  }

  function render() {
    const state = getState();
    const ready = state.files?.length && state.columnMap && state.circuitConfig;
    const charFields = getCharFields();
    const cached = ready && state.fitResults?.length && state.fitCacheKey === configKey(state);

    resultMap.clear();
    const files = state.files || [];
    (state.fitResults || []).forEach((r, i) => {
      if (files[i]) resultMap.set(files[i].path, r);
    });

    const weightChecked = state.fitWeightByModulus ?? true;
    const solver        = state.fitSolver ?? 'lm';

    container.innerHTML = `
      <div class="section-header">Fit</div>
      <div class="section-sub">
        ${(() => {
          const oc = state.optimizeConfig ?? {};
          if (oc.enabled) {
            const types = (oc.pair_types || ['CPE']).join('/');
            return `Optimize: searching ${oc.rc_min}–${oc.rc_max} RC pairs (${types}), ${oc.criterion ?? 'AIC'}`;
          }
          return `Circuit: <code style="color:var(--accent)">${state.circuitString || '—'}</code>`;
        })()}
        &nbsp;·&nbsp; ${files.length} file(s)
      </div>

      <div class="fitting-status" id="fit-status" style="display:none;">
        <div class="progress-label" id="progress-label">Starting…</div>
        <div class="progress-bar-wrap"><div class="progress-bar-fill" id="progress-bar"></div></div>
      </div>

      ${cached
        ? `<div class="cache-banner" id="cache-banner">✓ Cached results — config unchanged. <a href="#" id="clear-cache-link">Re-run anyway</a></div>`
        : (state.fitResults?.length && ready
            ? `<div class="cache-banner stale" id="cache-banner">⚠ Config changed — results below are from a previous run.</div>`
            : '')
      }

      <div class="step-actions" style="margin-bottom:20px;">
        <button class="btn btn-secondary" id="back-btn">← Back</button>
        <div class="spacer"></div>

        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted);">
          Timeout
          <input id="fit-timeout" type="number" min="5" max="600" step="5"
                 value="${state.fitTimeout ?? 60}"
                 style="width:64px;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:13px;text-align:right;">
          s / fit
        </label>

        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted);">
          Freq
          <input id="freq-min" type="number" min="0" step="any"
                 value="${state.fitFreqMin ?? ''}" placeholder="min"
                 style="width:72px;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:13px;text-align:right;">
          –
          <input id="freq-max" type="number" min="0" step="any"
                 value="${state.fitFreqMax ?? ''}" placeholder="max"
                 style="width:72px;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:13px;text-align:right;">
          Hz
        </label>

        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted);"
               title="Modulus weighting (1/|Z|²) — recommended for most EIS data">
          <input type="checkbox" id="weight-modulus-cb" ${weightChecked ? 'checked' : ''}>
          Modulus weight
        </label>

        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted);">
          Solver
          <select id="solver-select" style="padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:13px;">
            <option value="lm"      ${solver === 'lm'      ? 'selected' : ''}>LM (fast)</option>
            <option value="diff_ev" ${solver === 'diff_ev' ? 'selected' : ''}>Diff. Evo. (global)</option>
          </select>
        </label>

        <button class="btn btn-danger"    id="stop-btn"   style="display:none;">■ Stop</button>
        <button class="btn btn-secondary" id="kk-run-btn" ${!ready ? 'disabled' : ''}>KK Check</button>
        <button class="btn btn-primary"   id="run-btn"    ${!ready ? 'disabled' : ''}>${cached ? '↺ Re-run Fitting' : '▶ Run Fitting'}</button>
        <button class="btn btn-secondary" id="next-btn"   ${!state.fitResults?.length ? 'disabled' : ''}>View Trends →</button>
      </div>

      <div class="fit-sort-bar">
        <span style="font-size:12px;color:var(--text-muted);">Bin by</span>
        <select id="bin-by-select" style="padding:3px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px;">
          <option value="">— none —</option>
          ${charFields.map(f => `<option value="${f}" ${f === binByField ? 'selected' : ''}>${f}</option>`).join('')}
        </select>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text-muted);cursor:pointer;">
          <input type="checkbox" id="sort-best-cb" ${sortByBest ? 'checked' : ''}> Group by best circuit
        </label>
      </div>

      <div class="fit-tile-root" id="fit-tile-root">
        ${buildTileGrid(files)}
      </div>

      <!-- Shared modal for both KK and fit results -->
      <div class="fit-modal-overlay" id="fit-modal" style="display:none;" role="dialog" aria-modal="true">
        <div class="fit-modal-box">
          <div class="fit-modal-header">
            <span class="fit-modal-title" id="fit-modal-title"></span>
            <span class="residual-badge" id="fit-modal-badge"></span>
            <button class="fit-modal-close" id="fit-modal-close" aria-label="Close">✕</button>
          </div>
          <div class="fit-modal-meta" id="fit-modal-meta"></div>
          <div class="fit-modal-tabs" id="fit-modal-tabs"></div>
          <div class="fit-modal-plot" id="fit-modal-plot"></div>
          <div class="params-summary fit-modal-params" id="fit-modal-params"></div>
        </div>
      </div>
    `;

    container.querySelector('#back-btn').addEventListener('click', () => navigate(5));
    container.querySelector('#next-btn').addEventListener('click', () => navigate(7));
    container.querySelector('#run-btn').addEventListener('click', runFitting);
    container.querySelector('#stop-btn').addEventListener('click', stopFitting);
    container.querySelector('#kk-run-btn').addEventListener('click', runKK);
    container.querySelector('#clear-cache-link')?.addEventListener('click', e => { e.preventDefault(); runFitting(); });
    container.querySelector('#fit-modal-close').addEventListener('click', closeModal);
    container.querySelector('#fit-modal').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeModal();
    });
    container.querySelector('#weight-modulus-cb').addEventListener('change', e => {
      setState({ fitWeightByModulus: e.target.checked });
    });
    container.querySelector('#solver-select').addEventListener('change', e => {
      setState({ fitSolver: e.target.value });
    });
    container.querySelector('#bin-by-select')?.addEventListener('change', e => {
      binByField = e.target.value;
      rebuildGrid();
    });
    container.querySelector('#sort-best-cb')?.addEventListener('change', e => {
      sortByBest = e.target.checked;
      rebuildGrid();
    });

    wireTileClicks();
  }

  // ── Tile building ──────────────────────────────────────────────────────────

  function buildTileGrid(files) {
    if (!files.length) return '';
    const groups = groupFiles(files);
    return [...groups.entries()].map(([, { label, files: gFiles }]) => {
      let displayFiles = [...gFiles];
      if (sortByBest) {
        displayFiles.sort((a, b) => {
          const ca = resultMap.get(a.path)?.circuit_used ?? '￿';
          const cb = resultMap.get(b.path)?.circuit_used ?? '￿';
          return ca.localeCompare(cb);
        });
      }
      if (binByField) {
        const bins = new Map();
        for (const f of displayFiles) {
          const char = resultMap.get(f.path)?.characterization ?? charMap.get(f.path) ?? {};
          const val = String(char[binByField] ?? 'N/A');
          if (!bins.has(val)) bins.set(val, []);
          bins.get(val).push(f);
        }
        const sortedBins = [...bins.entries()].sort(([a], [b]) => {
          const na = parseFloat(a), nb = parseFloat(b);
          return !isNaN(na) && !isNaN(nb) ? na - nb : a.localeCompare(b);
        });
        return `
          <div class="fit-group">
            <div class="fit-group-header">${label}</div>
            <div class="fit-subgroup-row">
              ${sortedBins.map(([val, binFiles]) => `
                <div class="fit-subgroup">
                  <div class="fit-subgroup-header">${binByField}: ${val}</div>
                  <div class="fit-tile-row">
                    ${binFiles.map(f => buildTile(f.filename, f.path)).join('')}
                  </div>
                </div>
              `).join('')}
            </div>
          </div>`;
      }
      return `
        <div class="fit-group">
          <div class="fit-group-header">${label}</div>
          <div class="fit-tile-row">
            ${displayFiles.map(f => buildTile(f.filename, f.path)).join('')}
          </div>
        </div>`;
    }).join('');
  }

  function buildTile(filename, path) {
    const safeId  = pathToSafeId(path);
    const fitResult = resultMap.get(path);
    const kkResult  = kkMap.get(path);

    if (fitResult) {
      const good = fitResult.success && fitResult.residual != null && fitResult.residual < GOOD_THRESHOLD;
      const cls  = fitResult.success ? (good ? 'good' : 'poor') : 'failed';
      const pct  = fitResult.residual != null ? `${(fitResult.residual * 100).toFixed(1)}%` : '—';
      return `<div class="fit-tile ${cls}" data-path="${path}" id="tile-${safeId}">
        <div class="fit-tile-name">${filename}</div>
        <div class="fit-tile-pct">${fitResult.success ? pct : 'FAILED'}</div>
      </div>`;
    }

    if (kkResult) {
      const { cls, label } = kkTileState(kkResult);
      return `<div class="fit-tile ${cls}" data-path="${path}" id="tile-${safeId}">
        <div class="fit-tile-name">${filename}</div>
        <div class="fit-tile-pct">${label}</div>
      </div>`;
    }

    return `<div class="fit-tile pending" data-path="${path}" id="tile-${safeId}">
      <div class="fit-tile-name">${filename}</div>
      <div class="fit-tile-pct">—</div>
    </div>`;
  }

  function wireTileClicks() {
    container.querySelectorAll('.fit-tile:not(.pending)').forEach(el => {
      el.addEventListener('click', () => {
        const path      = el.dataset.path;
        const fitResult = resultMap.get(path);
        const kkResult  = kkMap.get(path);
        if      (fitResult) openFitModal(fitResult);
        else if (kkResult)  openKKModal(kkResult);
      });
    });
  }

  // Live update helpers called during streaming

  function updateFitTile(fitResult, path) {
    const el = container.querySelector(`#tile-${pathToSafeId(path)}`);
    if (!el) return;
    const good = fitResult.success && fitResult.residual != null && fitResult.residual < GOOD_THRESHOLD;
    const cls  = fitResult.success ? (good ? 'good' : 'poor') : 'failed';
    const pct  = fitResult.residual != null ? `${(fitResult.residual * 100).toFixed(1)}%` : '—';
    el.className = `fit-tile ${cls}`;
    el.querySelector('.fit-tile-pct').textContent = fitResult.success ? pct : 'FAILED';
    const fresh = el.cloneNode(true);
    fresh.addEventListener('click', () => openFitModal(fitResult));
    el.replaceWith(fresh);
  }

  function updateKKTile(kkResult, path) {
    // Don't overwrite a tile that already has a fit result
    if (resultMap.has(path)) return;
    const el = container.querySelector(`#tile-${pathToSafeId(path)}`);
    if (!el) return;
    const { cls, label } = kkTileState(kkResult);
    el.className = `fit-tile ${cls}`;
    el.querySelector('.fit-tile-pct').textContent = label;
    const fresh = el.cloneNode(true);
    fresh.addEventListener('click', () => openKKModal(kkResult));
    el.replaceWith(fresh);
  }

  // ── KK modal ───────────────────────────────────────────────────────────────

  function openKKModal(kk) {
    const modal    = container.querySelector('#fit-modal');
    const titleEl  = container.querySelector('#fit-modal-title');
    const badgeEl  = container.querySelector('#fit-modal-badge');
    const metaEl   = container.querySelector('#fit-modal-meta');
    const plotEl   = container.querySelector('#fit-modal-plot');
    const paramsEl = container.querySelector('#fit-modal-params');
    const tabsEl   = container.querySelector('#fit-modal-tabs');

    titleEl.textContent = kk.filename;

    // Badge
    const { cls: kkCls, label: kkLabel } = kkTileState(kk);
    const badgeClass = kkCls === 'kk-ok' ? 'good' : kkCls === 'kk-warn' ? 'poor' : 'failed';
    badgeEl.className = `residual-badge ${badgeClass}`;
    badgeEl.textContent = kk.success ? kkLabel : 'KK ✗';

    // Meta line
    const metaParts = [];
    if (kk.M  != null) metaParts.push(`M = ${kk.M} RC elements`);
    if (kk.mu != null) metaParts.push(`μ = ${kk.mu.toFixed(3)}`);
    if (kk.error)      metaParts.push(kk.error);
    metaEl.textContent = metaParts.join(' · ');

    // Tabs: Nyquist (KK) + Residuals
    tabsEl.innerHTML = '';
    [
      { id: 'kk-nyquist',   label: 'Nyquist (KK)' },
      { id: 'kk-residuals', label: 'KK Residuals' },
    ].forEach(({ id, label }, idx) => {
      const btn = document.createElement('button');
      btn.className = `tab-btn${idx === 0 ? ' active' : ''}`;
      btn.dataset.tab = id;
      btn.textContent = label;
      tabsEl.appendChild(btn);
    });

    tabsEl.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        plotEl.innerHTML = '';
        requestAnimationFrame(() => {
          if (btn.dataset.tab === 'kk-nyquist') plotKKNyquist(kk, plotEl);
          else                                   plotKKResiduals(kk, plotEl);
        });
      });
    });

    // Bottom action: apply suggested range
    paramsEl.innerHTML = '';
    if (kk.freq_min_suggest != null) {
      paramsEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
          <span style="font-size:12px;color:var(--text-muted);">
            Suggested compliant range:
            <strong style="color:var(--text);">
              ${kk.freq_min_suggest.toPrecision(3)} – ${kk.freq_max_suggest.toPrecision(3)} Hz
            </strong>
          </span>
          <button class="btn btn-secondary" id="modal-kk-apply" style="font-size:12px;padding:4px 12px;">
            Apply to freq filter
          </button>
        </div>`;
      container.querySelector('#modal-kk-apply').addEventListener('click', () => {
        const minEl = container.querySelector('#freq-min');
        const maxEl = container.querySelector('#freq-max');
        if (minEl) minEl.value = kk.freq_min_suggest;
        if (maxEl) maxEl.value = kk.freq_max_suggest;
        closeModal();
        showToast('Frequency range applied — re-run fitting to use it.', 'success');
      });
    }

    plotEl.innerHTML = '';
    modal.style.display = 'flex';
    requestAnimationFrame(() => plotKKNyquist(kk, plotEl));
  }

  function plotKKNyquist(kk, el) {
    if (!el || typeof Plotly === 'undefined') return;
    if (!kk.z_real?.length) {
      el.innerHTML = '<p style="color:var(--text-muted);padding:24px;">No impedance data available.</p>';
      return;
    }

    const flagged = new Set(kk.flagged_indices || []);
    const goodIdx = kk.z_real.map((_, i) => i).filter(i => !flagged.has(i));
    const badIdx  = [...flagged];

    const traces = [{
      x: goodIdx.map(i => kk.z_real[i]),
      y: goodIdx.map(i => -kk.z_imag[i]),
      mode: 'markers', name: 'Compliant',
      marker: { color: '#4caf7d', size: 7 },
      text: goodIdx.map(i => `${kk.frequencies[i] != null ? kk.frequencies[i].toPrecision(4) : ''} Hz`),
      hovertemplate: "%{text}<br>Z'=%{x:.4g} Ω<br>-Z''=%{y:.4g} Ω<extra></extra>",
    }];

    if (badIdx.length) {
      traces.push({
        x: badIdx.map(i => kk.z_real[i]),
        y: badIdx.map(i => -kk.z_imag[i]),
        mode: 'markers', name: 'Flagged (|KK res| > 1%)',
        marker: { color: '#e05c5c', size: 10, symbol: 'x', line: { color: '#e05c5c', width: 2 } },
        text: badIdx.map(i => `${kk.frequencies[i] != null ? kk.frequencies[i].toPrecision(4) : ''} Hz (flagged)`),
        hovertemplate: "%{text}<br>Z'=%{x:.4g} Ω<br>-Z''=%{y:.4g} Ω<extra></extra>",
      });
    }

    Plotly.newPlot(el, traces, {
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      margin: { t: 8, r: 16, b: 48, l: 64 },
      font:   { color: '#8892b0', size: 11 },
      xaxis:  { title: "Z' (Ω)", color: '#8892b0', gridcolor: '#2d3147', zeroline: false },
      yaxis:  { title: "-Z'' (Ω)", color: '#8892b0', gridcolor: '#2d3147', zeroline: false, scaleanchor: 'x', scaleratio: 1 },
      legend: { x: 0.5, y: 0.95, font: { size: 10 } },
      showlegend: true,
    }, { displayModeBar: false, responsive: true });
  }

  function plotKKResiduals(kk, el) {
    if (!el || typeof Plotly === 'undefined' || !kk.frequencies?.length) {
      el.innerHTML = '<p style="color:var(--text-muted);padding:24px;">No KK residual data.</p>';
      return;
    }

    const flagged = new Set(kk.flagged_indices || []);
    const pointColors = kk.frequencies.map((_, i) =>
      flagged.has(i) ? '#e05c5c' : '#4ecdc4'
    );

    const freqArr = kk.frequencies;
    const f0 = freqArr[0], f1 = freqArr[freqArr.length - 1];

    Plotly.newPlot(el, [
      {
        x: freqArr, y: kk.res_real.map(v => Math.abs(v) * 100),
        mode: 'markers+lines', name: "|ΔZ'| / |Z|",
        marker: { color: pointColors, size: 6 },
        line: { color: '#e05c5c', width: 1 },
        hovertemplate: "%{x:.4g} Hz<br>|ΔZ'|/|Z| = %{y:.3f}%<extra></extra>",
      },
      {
        x: freqArr, y: kk.res_imag.map(v => Math.abs(v) * 100),
        mode: 'markers+lines', name: "|ΔZ''| / |Z|",
        marker: { color: pointColors, size: 6, symbol: 'diamond' },
        line: { color: '#4a9ade', width: 1 },
        hovertemplate: "%{x:.4g} Hz<br>|ΔZ''|/|Z| = %{y:.3f}%<extra></extra>",
      },
      {
        x: [f0, f1], y: [1, 1],
        mode: 'lines', name: '1 % threshold',
        line: { color: '#aaa', dash: 'dot', width: 1.5 },
      },
    ], {
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      margin: { t: 8, r: 16, b: 48, l: 64 },
      font:   { color: '#8892b0', size: 11 },
      xaxis:  { title: 'Frequency (Hz)', type: 'log', color: '#8892b0', gridcolor: '#2d3147', zeroline: false },
      yaxis:  { title: 'KK residual (%)', color: '#8892b0', gridcolor: '#2d3147', zeroline: true, zerolinecolor: '#4a5080' },
      legend: { x: 0.5, y: 0.95, font: { size: 10 } },
      showlegend: true,
    }, { displayModeBar: false, responsive: true });
  }

  // ── Fit modal ──────────────────────────────────────────────────────────────

  function openFitModal(result) {
    const modal    = container.querySelector('#fit-modal');
    const titleEl  = container.querySelector('#fit-modal-title');
    const badgeEl  = container.querySelector('#fit-modal-badge');
    const metaEl   = container.querySelector('#fit-modal-meta');
    const plotEl   = container.querySelector('#fit-modal-plot');
    const paramsEl = container.querySelector('#fit-modal-params');
    const tabsEl   = container.querySelector('#fit-modal-tabs');

    titleEl.textContent = result.filename;

    const good = result.success && result.residual != null && result.residual < GOOD_THRESHOLD;
    badgeEl.className = `residual-badge ${result.success ? (good ? 'good' : 'poor') : 'failed'}`;
    badgeEl.textContent = result.success
      ? `${(result.residual * 100).toFixed(2)}%`
      : 'FAILED';

    const charStr   = Object.entries(result.characterization || {})
      .map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toPrecision(4) : v}`).join(' · ');
    const circuitStr = result.circuit_used ? `Circuit: ${result.circuit_used}` : '';
    metaEl.textContent = [charStr, circuitStr].filter(Boolean).join(' · ');
    if (result.error) metaEl.textContent += (metaEl.textContent ? ' · ' : '') + result.error;

    paramsEl.innerHTML = Object.entries(result.parameters || {})
      .map(([k, v]) => {
        const { scale, unit } = paramUnitInfo(k);
        const disp = typeof v === 'number' ? (v * scale).toExponential(3) : v;
        const warn = typeof v === 'number' ? checkPhysical(k, v) : null;
        const warnHtml = warn ? ` <span class="param-warn" title="${warn}">⚠</span>` : '';
        return `<span>${k}${warnHtml}</span>${disp}${unit ? ' ' + unit : ''}`;
      }).join(' &nbsp; ');

    // Build tabs
    tabsEl.innerHTML = '';
    const tabDefs = [
      { id: 'nyquist',     label: 'Nyquist' },
      { id: 'bode',        label: 'Bode' },
      { id: 'residuals',   label: 'Residuals' },
    ];
    if (result.variants_tried?.length > 1)
      tabDefs.push({ id: 'variants', label: `Variants (${result.variants_tried.length})` });
    tabDefs.push({ id: 'diagnostics', label: 'Diagnostics' });

    tabDefs.forEach(({ id, label }, idx) => {
      const btn = document.createElement('button');
      btn.className = `tab-btn${idx === 0 ? ' active' : ''}`;
      btn.dataset.tab = id;
      btn.textContent = label;
      tabsEl.appendChild(btn);
    });

    tabsEl.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        plotEl.innerHTML = '';
        requestAnimationFrame(() => {
          const t = btn.dataset.tab;
          if      (t === 'nyquist')     plotNyquist(result, plotEl);
          else if (t === 'bode')        plotBode(result, plotEl);
          else if (t === 'variants')    plotVariants(result, plotEl);
          else if (t === 'diagnostics') plotDiagnostics(result, plotEl);
          else                          plotResiduals(result, plotEl);
        });
      });
    });

    plotEl.innerHTML = '';
    modal.style.display = 'flex';
    requestAnimationFrame(() => plotNyquist(result, plotEl));
  }

  function closeModal() {
    container.querySelector('#fit-modal').style.display = 'none';
    container.querySelector('#fit-modal-plot').innerHTML = '';
  }

  // ── KK run ─────────────────────────────────────────────────────────────────

  async function runKK() {
    const state = getState();
    if (!state.files?.length || !state.columnMap) return;

    const kkBtn = container.querySelector('#kk-run-btn');
    kkBtn.disabled = true;
    kkBtn.textContent = 'KK…';

    kkMap.clear();
    // Reset all tiles without fit results back to pending so KK state starts fresh
    rebuildGrid();
    wireTileClicks();

    const freqMinVal = container.querySelector('#freq-min').value.trim();
    const freqMaxVal = container.querySelector('#freq-max').value.trim();
    const filePaths  = state.files.map(f => f.path);
    const kkResults  = [];

    const request = {
      files:       state.files,
      column_map:  { ...state.columnMap, decimal_places: state.charDecimalPlaces ?? {} },
      freq_min:    freqMinVal !== '' ? parseFloat(freqMinVal) : null,
      freq_max:    freqMaxVal !== '' ? parseFloat(freqMaxVal) : null,
    };

    try {
      for await (const event of streamKK(request)) {
        if (event.event === 'progress') {
          // Could update a status label here if needed
        } else if (event.event === 'result') {
          const r = event.data;
          const path = filePaths[kkResults.length];
          kkResults.push(r);
          kkMap.set(path, r);
          updateKKTile(r, path);
          await new Promise(resolve => requestAnimationFrame(resolve));
        } else if (event.event === 'done') {
          const nFlagged = kkResults.filter(r => r.success && r.flagged_indices?.length > 0).length;
          const nFail    = kkResults.filter(r => !r.success).length;
          const nOk      = kkResults.length - nFlagged - nFail;
          showToast(
            `KK: ${nOk} compliant · ${nFlagged} flagged · ${nFail} failed`,
            nFail > 0 ? 'error' : nFlagged > 0 ? 'info' : 'success',
          );
        }
      }
    } catch (err) {
      showToast(`KK error: ${err.message}`, 'error');
    }

    kkBtn.disabled = false;
    kkBtn.textContent = 'KK Check';
  }

  // ── Fitting run ────────────────────────────────────────────────────────────

  let _abortCtrl = null;
  function stopFitting() { _abortCtrl?.abort(); }
  function onKeyDown(e) { if (e.key === 'Escape') closeModal(); }

  async function runFitting() {
    const state = getState();
    if (!state.files?.length || !state.columnMap || !state.circuitConfig) return;

    const runBtn        = container.querySelector('#run-btn');
    const stopBtn       = container.querySelector('#stop-btn');
    const nextBtn       = container.querySelector('#next-btn');
    const fitStatus     = container.querySelector('#fit-status');
    const progressBar   = container.querySelector('#progress-bar');
    const progressLabel = container.querySelector('#progress-label');

    const filePaths = state.files.map(f => f.path);
    _abortCtrl = new AbortController();
    runBtn.disabled  = true;
    stopBtn.style.display = '';
    fitStatus.style.display = '';

    resultMap.clear();
    setState({ fitCacheKey: null, fitResults: [] });
    // Rebuild so KK tiles (if any) are still visible while fit is running
    rebuildGrid();

    const results = [];
    let stopped = false, gotDone = false;

    const timeout         = parseFloat(container.querySelector('#fit-timeout').value) || 60;
    const freqMinVal      = container.querySelector('#freq-min').value.trim();
    const freqMaxVal      = container.querySelector('#freq-max').value.trim();
    const freqMin         = freqMinVal !== '' ? parseFloat(freqMinVal) : null;
    const freqMax         = freqMaxVal !== '' ? parseFloat(freqMaxVal) : null;
    const weightByModulus = container.querySelector('#weight-modulus-cb').checked;
    const solver          = container.querySelector('#solver-select').value;
    const runCacheKey = configKey({ ...state, fitTimeout: timeout, fitFreqMin: freqMin,
                                   fitFreqMax: freqMax, fitWeightByModulus: weightByModulus, fitSolver: solver });

    try {
      setState({ fitTimeout: timeout, fitFreqMin: freqMin, fitFreqMax: freqMax,
                 fitWeightByModulus: weightByModulus, fitSolver: solver });

      const request = {
        files:             state.files,
        column_map:        { ...state.columnMap, decimal_places: state.charDecimalPlaces ?? {} },
        circuit_config:    state.circuitConfig,
        fit_timeout:       timeout,
        optimize_config:   state.optimizeConfig ?? { enabled: false },
        freq_min:          freqMin,
        freq_max:          freqMax,
        weight_by_modulus: weightByModulus,
        solver:            solver,
      };

      for await (const event of streamFitting(request, _abortCtrl.signal)) {
        if (event.event === 'progress') {
          const pct = Math.round((event.index / event.total) * 100);
          progressBar.style.width = `${pct}%`;
          progressLabel.textContent = `Fitting ${event.file} (${event.index + 1} / ${event.total})`;
        } else if (event.event === 'result') {
          const result = event.data;
          const path   = filePaths[results.length];
          results.push(result);
          resultMap.set(path, result);
          updateFitTile(result, path);
          await new Promise(r => requestAnimationFrame(r));
        } else if (event.event === 'done') {
          gotDone = true;
          progressBar.style.width = '100%';
          const ok = results.filter(r => r.success).length;
          progressLabel.textContent = `Done — ${ok}/${results.length} successful`;
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        stopped = true;
        const ok = results.filter(r => r.success).length;
        progressLabel.textContent = `Stopped — ${ok}/${results.length} completed`;
      } else {
        showToast(`Fitting error: ${err.message}`, 'error');
      }
    } finally {
      runBtn.disabled  = false;
      stopBtn.style.display = 'none';
      nextBtn.disabled = !results.length;
      setState({
        fitResults:  results,
        fitCacheKey: (!stopped && gotDone) ? runCacheKey : null,
        maxStep:     Math.max(state.maxStep, 7),
      });
      render();
    }
  }

  // ── Fit plot functions ─────────────────────────────────────────────────────

  function plotNyquist(result, el) {
    if (!el || typeof Plotly === 'undefined') return;
    const traces = [];
    if (result.z_real_data?.length) {
      traces.push({ x: result.z_real_data, y: result.z_imag_data.map(v => -v),
        mode: 'markers', type: 'scatter', name: 'Data',
        marker: { color: '#8892b0', size: 5 } });
    }
    if (result.success && result.z_real_fit?.length) {
      traces.push({ x: result.z_real_fit, y: result.z_imag_fit.map(v => -v),
        mode: 'lines', type: 'scatter', name: 'Fit',
        line: { color: 'var(--accent)', width: 2 } });
    }
    Plotly.newPlot(el, traces, {
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      margin: { t: 8, r: 16, b: 48, l: 64 },
      font:   { color: '#8892b0', size: 11 },
      xaxis:  { title: "Z' (Ω)",  color: '#8892b0', gridcolor: '#2d3147', zeroline: false },
      yaxis:  { title: "-Z'' (Ω)", color: '#8892b0', gridcolor: '#2d3147', zeroline: false, scaleanchor: 'x', scaleratio: 1 },
      legend: { x: 0.7, y: 0.95, font: { size: 10 } },
      showlegend: true,
    }, { displayModeBar: false, responsive: true });
  }

  function plotBode(result, el) {
    if (!el || typeof Plotly === 'undefined') return;
    const freqs = result.frequencies;
    if (!freqs?.length) { el.textContent = 'No frequency data'; return; }
    const dataMag   = result.z_real_data.map((r, i) => Math.sqrt(r**2 + result.z_imag_data[i]**2));
    const dataPhase = result.z_real_data.map((r, i) => Math.atan2(result.z_imag_data[i], r) * 180 / Math.PI);
    const traces = [
      { x: freqs, y: dataMag,   mode: 'markers', name: '|Z| data',   marker: { color: '#8892b0', size: 5 }, xaxis:'x',  yaxis:'y'  },
      { x: freqs, y: dataPhase, mode: 'markers', name: 'Phase data', marker: { color: '#8892b0', size: 5 }, xaxis:'x2', yaxis:'y2' },
    ];
    if (result.success && result.z_real_fit?.length) {
      const fitMag   = result.z_real_fit.map((r, i) => Math.sqrt(r**2 + result.z_imag_fit[i]**2));
      const fitPhase = result.z_real_fit.map((r, i) => Math.atan2(result.z_imag_fit[i], r) * 180 / Math.PI);
      traces.push({ x: freqs, y: fitMag,   mode: 'lines', name: '|Z| fit',   line: { color:'var(--accent)', width:2 },             xaxis:'x',  yaxis:'y'  });
      traces.push({ x: freqs, y: fitPhase, mode: 'lines', name: 'Phase fit', line: { color:'var(--accent)', width:2, dash:'dash' }, xaxis:'x2', yaxis:'y2' });
    }
    const ax = { type:'log', color:'#8892b0', gridcolor:'#2d3147', zeroline:false };
    Plotly.newPlot(el, traces, {
      grid: { rows:2, columns:1, pattern:'independent' },
      paper_bgcolor:'transparent', plot_bgcolor:'transparent',
      margin:{t:8,r:16,b:48,l:64}, font:{color:'#8892b0',size:11},
      xaxis:{...ax, title:'Frequency (Hz)'}, yaxis:{...ax, title:'|Z| (Ω)'},
      xaxis2:{...ax, title:'Frequency (Hz)'}, yaxis2:{type:'linear',color:'#8892b0',gridcolor:'#2d3147',title:'Phase (°)'},
      showlegend: false,
    }, { displayModeBar:false, responsive:true });
  }

  function plotResiduals(result, el) {
    if (!el || typeof Plotly === 'undefined') return;
    if (!result.frequencies?.length || !result.success || !result.z_real_fit?.length) {
      el.textContent = 'No residuals available'; return;
    }
    const realRes = result.z_real_data.map((r, i) => (r - result.z_real_fit[i]) / (Math.abs(r) + 1e-12) * 100);
    const imagRes = result.z_imag_data.map((v, i) => (v - result.z_imag_fit[i]) / (Math.abs(v) + 1e-12) * 100);
    Plotly.newPlot(el, [
      { x: result.frequencies, y: realRes, mode:'markers+lines', name:"Z' residual",  marker:{color:'#e05c5c',size:4}, line:{color:'#e05c5c',width:1} },
      { x: result.frequencies, y: imagRes, mode:'markers+lines', name:"Z'' residual", marker:{color:'#4a9ade',size:4}, line:{color:'#4a9ade',width:1} },
    ], {
      paper_bgcolor:'transparent', plot_bgcolor:'transparent',
      margin:{t:8,r:16,b:48,l:64}, font:{color:'#8892b0',size:11},
      xaxis:{title:'Frequency (Hz)',type:'log',color:'#8892b0',gridcolor:'#2d3147',zeroline:false},
      yaxis:{title:'Residual (%)',color:'#8892b0',gridcolor:'#2d3147',zeroline:true,zerolinecolor:'#4a5080'},
      legend:{x:0.6,y:0.95,font:{size:10}}, showlegend:true,
    }, { displayModeBar:false, responsive:true });
  }

  function plotDiagnostics(result, el) {
    if (!result.success) {
      el.innerHTML = '<p style="color:var(--text-muted);padding:16px 0;">No diagnostics — fit failed.</p>';
      return;
    }
    const chiNu = result.chi_sq_nu, rmse = result.rmse;
    const corr  = result.correlation;
    const names = result.param_names || Object.keys(result.parameters || {});

    let chiClass = '', chiNote = '';
    if (chiNu != null) {
      if      (chiNu < 0.5)  { chiClass = 'color:var(--accent)';  chiNote = 'possible overfitting'; }
      else if (chiNu < 2.0)  { chiClass = 'color:var(--success)'; chiNote = 'good fit'; }
      else if (chiNu < 10.0) { chiClass = 'color:var(--warning)'; chiNote = 'poor fit'; }
      else                   { chiClass = 'color:var(--danger)';   chiNote = 'very poor fit'; }
    }

    let corrHTML = '';
    if (corr && names.length) {
      const cell = (v, i, j) => {
        if (i === j) return 'background:rgba(78,205,196,0.15);color:var(--text);';
        const a = Math.abs(v);
        if (a > 0.9) return 'background:rgba(224,92,92,0.45);color:#fff;font-weight:600;';
        if (a > 0.7) return 'background:rgba(224,92,92,0.20);color:var(--text);';
        return 'color:var(--text-muted);';
      };
      corrHTML = `
        <div style="margin-top:16px;">
          <div style="font-size:12px;font-weight:600;margin-bottom:6px;">
            Parameter Correlation Matrix
            <span style="font-weight:400;color:var(--text-muted);"> — red = |r| &gt; 0.9 (degenerate pair)</span>
          </div>
          <div style="overflow-x:auto;">
            <table style="border-collapse:collapse;font-size:11px;">
              <thead><tr>
                <th style="padding:4px 8px;"></th>
                ${names.map(n => `<th style="padding:4px 8px;color:var(--text-muted);font-weight:600;white-space:nowrap;">${n}</th>`).join('')}
              </tr></thead>
              <tbody>
                ${corr.map((row, i) => `<tr>
                  <td style="padding:4px 8px;color:var(--text-muted);font-weight:600;white-space:nowrap;">${names[i]}</td>
                  ${row.map((v, j) => `<td style="padding:4px 8px;text-align:right;border-radius:3px;${cell(v,i,j)}">${v.toFixed(3)}</td>`).join('')}
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>`;
    } else {
      corrHTML = `<p style="font-size:12px;color:var(--text-muted);margin-top:12px;">Correlation matrix not available (singular Jacobian).</p>`;
    }

    el.innerHTML = `
      <div style="padding:8px 0;">
        <div style="display:flex;gap:32px;flex-wrap:wrap;">
          <div>
            <div style="font-size:12px;color:var(--text-muted);">Reduced χ²</div>
            <div style="font-size:22px;font-weight:600;${chiClass}">${chiNu != null ? chiNu.toFixed(3) : '—'}</div>
            ${chiNote ? `<div style="font-size:11px;color:var(--text-muted);">${chiNote}</div>` : ''}
          </div>
          <div>
            <div style="font-size:12px;color:var(--text-muted);">RMSE</div>
            <div style="font-size:22px;font-weight:600;color:var(--text);">${rmse != null ? rmse.toExponential(3) + ' Ω' : '—'}</div>
          </div>
          <div>
            <div style="font-size:12px;color:var(--text-muted);">AIC / BIC</div>
            <div style="font-size:16px;font-weight:600;color:var(--text);">${result.aic != null ? result.aic.toFixed(1) : '—'} / ${result.bic != null ? result.bic.toFixed(1) : '—'}</div>
          </div>
        </div>
        ${corrHTML}
      </div>`;
  }

  function plotVariants(result, el) {
    const variants = result.variants_tried || [];
    if (!variants.length) {
      el.innerHTML = '<p style="color:var(--text-muted);padding:16px 0;">No variant data available.</p>';
      return;
    }
    const criterion = ((getState().optimizeConfig?.criterion) ?? 'AIC').toLowerCase();
    const succV     = variants.filter(v => v.success && v[criterion] != null);
    const bestScore = succV.length ? Math.min(...succV.map(v => v[criterion])) : null;
    const bestAic   = Math.min(...variants.filter(v => v.success && v.aic != null).map(v => v.aic));
    const bestBic   = Math.min(...variants.filter(v => v.success && v.bic != null).map(v => v.bic));

    el.innerHTML = `
      <div style="overflow-x:auto;overflow-y:auto;max-height:280px;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="position:sticky;top:0;background:var(--surface);">
              <th style="text-align:left;padding:5px 10px;border-bottom:1px solid var(--border);color:var(--text-muted);font-weight:600;">Circuit</th>
              <th style="text-align:right;padding:5px 8px;border-bottom:1px solid var(--border);color:var(--text-muted);font-weight:600;">k</th>
              <th style="text-align:right;padding:5px 8px;border-bottom:1px solid var(--border);color:var(--text-muted);font-weight:600;">MAPE</th>
              <th style="text-align:right;padding:5px 8px;border-bottom:1px solid var(--border);color:var(--text-muted);font-weight:600;">ΔAIC</th>
              <th style="text-align:right;padding:5px 8px;border-bottom:1px solid var(--border);color:var(--text-muted);font-weight:600;">ΔBIC</th>
              <th style="padding:5px 8px;border-bottom:1px solid var(--border);"></th>
            </tr>
          </thead>
          <tbody>
            ${variants.map(v => {
              const isWinner = v.success && bestScore != null && v[criterion] === bestScore;
              const bg       = isWinner ? 'background:rgba(100,220,150,0.07);' : '';
              const opacity  = v.success ? '' : 'opacity:0.45;';
              const resText  = v.residual != null ? `${(v.residual * 100).toFixed(2)}%` : (v.error ?? '—');
              const dAic     = v.aic != null && isFinite(bestAic) ? `+${(v.aic - bestAic).toFixed(1)}` : '—';
              const dBic     = v.bic != null && isFinite(bestBic) ? `+${(v.bic - bestBic).toFixed(1)}` : '—';
              return `<tr style="${bg}${opacity}">
                <td style="padding:4px 10px;font-family:monospace;font-size:11px;color:var(--accent);">${v.circuit_string}</td>
                <td style="text-align:right;padding:4px 8px;">${v.n_params}</td>
                <td style="text-align:right;padding:4px 8px;">${resText}</td>
                <td style="text-align:right;padding:4px 8px;">${isWinner ? '0' : dAic}</td>
                <td style="text-align:right;padding:4px 8px;">${isWinner ? '0' : dBic}</td>
                <td style="text-align:center;padding:4px 8px;color:#64dc96;font-size:14px;">${isWinner ? '★' : ''}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  return {
    async onEnter() {
      render();
      document.addEventListener('keydown', onKeyDown);

      const s = getState();

      if (s.fitFreqMin === null && s.fitFreqMax === null && s.files?.length && s.columnMap?.frequency) {
        try {
          const res = await fetch('/api/freq-range', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: s.files[0].path, frequency_column: s.columnMap.frequency }),
          });
          if (res.ok) {
            const { freq_min, freq_max } = await res.json();
            const minEl = container.querySelector('#freq-min');
            const maxEl = container.querySelector('#freq-max');
            if (minEl) minEl.value = freq_min;
            if (maxEl) maxEl.value = freq_max;
          }
        } catch (_) {}
      }

      if (s.files?.length && s.columnMap) {
        try {
          const data = await characterizeFiles({
            files: s.files,
            column_map: { ...s.columnMap, decimal_places: s.charDecimalPlaces ?? {} },
          });
          charMap.clear();
          for (const { path, characterization } of data) charMap.set(path, characterization);
          if (!binByField) {
            const fields = getCharFields();
            if (fields.length) binByField = fields[0];
          }
          render();
        } catch (_) {}
      }
    },
    onLeave() {
      document.removeEventListener('keydown', onKeyDown);
    },
  };
}
