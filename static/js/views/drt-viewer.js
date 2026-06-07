import { getState, setState } from '../state.js';
import { computeDRTAuto, computeDRTSingle, computeLCurve } from '../api.js';

const PEAK_COLORS = [
  '#e05c5c', '#4a9ade', '#e67e22', '#27ae60',
  '#9b59b6', '#1abc9c', '#f1c40f', '#e91e63',
];

const MECHANISMS = [
  { key: 'fast', label: 'R₀',              tauMax: 5e-3,     color: '#e05c5c' },
  { key: 'sei',  label: 'SEI',             tauMax: 0.1,      color: '#e67e22' },
  { key: 'mid',  label: 'Charge Transfer', tauMax: 1.0,      color: '#4a9ade' },
  { key: 'slow', label: 'Diffusion',       tauMax: Infinity, color: '#27ae60' },
];

function categorizePeak(peak) {
  return MECHANISMS.find(m => peak.tau_center < m.tauMax) ?? MECHANISMS[MECHANISMS.length - 1];
}

function fmtTau(tau) {
  if (tau == null) return '—';
  if (tau < 1e-6)  return `${(tau * 1e9).toFixed(1)} ns`;
  if (tau < 1e-3)  return `${(tau * 1e6).toFixed(1)} µs`;
  if (tau < 1)     return `${(tau * 1e3).toFixed(1)} ms`;
  return `${tau.toFixed(3)} s`;
}

function fmtLambda(lambda) {
  if (lambda == null) return '—';
  if (lambda >= 0.1)  return lambda.toFixed(3);
  if (lambda >= 0.01) return lambda.toFixed(4);
  if (lambda >= 1e-4) return lambda.toExponential(1);
  return lambda.toExponential(2);
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function batteryIdFromPath(file) {
  const parts = (file.path || file.filename).replace(/\\/g, '/').split('/');
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

function nearestLambdaIdx(pts, lambda) {
  let best = 0, bestDist = Infinity;
  pts.forEach((p, i) => {
    const d = Math.abs(Math.log10(p.lambda_val) - Math.log10(lambda));
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

// ════════════════════════════════════════════════════════════════
export function DRTView(container, { navigate, showToast }) {
  const _cache       = new Map();  // path → DRT result
  const _lcurveCache = new Map();  // path → L-curve data
  const _lambdaCache = new Map();  // path → lambda used for cached result
  let _charKeys      = [];         // updated on render, used by DOM updaters
  let _statsIdent    = null;       // selected identifier for stats section
  let _computeSeq    = 0;
  let _debounceTimer = null;
  let _autoRunGen    = 0;          // incremented on each onEnter to cancel stale runs

  // ── Initial render ────────────────────────────────────────────
  function render() {
    const state    = getState();
    const ready    = !!(state.files?.length && state.columnMap);
    const files    = state.files || [];
    const selected = state.drtSelectedFile;
    _charKeys = state.columnMap ? Object.keys(state.columnMap.characterization || {}) : [];

    // Seed cache from persisted results (first load only)
    if (state.drtResults?.length && _cache.size === 0) {
      state.drtResults.forEach(r => {
        const key = r.path || r.filename;
        _cache.set(key, r);
        if (r.lambda_used != null) _lambdaCache.set(key, r.lambda_used);
      });
    }

    const lambda         = fileEffectiveLambda(selected?.path);
    const sliderVal      = Math.log10(lambda).toFixed(3);
    const cachedSelected = selected ? _cache.get(selected.path) : null;
    const charHeaders    = _charKeys.map(k => `<th class="drt-fcell">${escHtml(k)}</th>`).join('');
    if (!_statsIdent && _charKeys.length) _statsIdent = _charKeys[0];
    const statsIdent     = _statsIdent;

    const tableRows = files.map(f => buildTableRow(f, selected)).join('');

    container.innerHTML = `
      <div class="section-header">DRT Tuning Lab</div>
      <div class="section-sub">
        Distribution of Relaxation Times &nbsp;·&nbsp; model-free process identification
        &nbsp;·&nbsp; ${files.length} file(s) — L-curve λ auto-selected per file
      </div>

      <div class="step-actions" style="margin-bottom:16px;">
        <button class="btn btn-secondary" id="back-btn">← Back</button>
        <div class="spacer"></div>
        <button class="btn btn-secondary" id="next-btn">Build Circuit →</button>
      </div>

      ${!ready ? `
        <div style="padding:60px;text-align:center;color:var(--text-muted);font-size:13px;">
          No files loaded — go back to configure column mapping first.
        </div>
      ` : `
      <div class="drt-lab">
        <div class="drt-lab-left">
          <div class="drt-panel-title" style="display:flex;align-items:center;gap:6px;">
            <span>Files &middot; ${files.length}</span>
            <div style="flex:1;"></div>
            <button id="drt-refresh-btn" class="drt-icon-btn"
                    title="Re-run L-curve λ optimisation for all files" style="font-size:14px;">↺</button>
          </div>
          <div class="drt-file-scroll">
            <table class="drt-file-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th class="drt-fcell">Battery</th>
                  ${charHeaders}
                  <th class="drt-fcell" style="text-align:right;">λ</th>
                  <th style="text-align:right;">Peaks</th>
                </tr>
              </thead>
              <tbody>${tableRows}</tbody>
            </table>
          </div>

          <div class="drt-stats-panel">
            <div class="drt-stats-header">
              <span class="drt-stats-title">Peak distribution by</span>
              <select id="drt-stats-ident" class="drt-stats-select">
                ${statsIdentOpts(statsIdent)}
              </select>
            </div>
            <div class="drt-stats-body" id="drt-stats-body">
              ${buildStatsHtml(statsIdent)}
            </div>
          </div>
        </div>

        <div class="drt-lab-right" id="drt-lab-right">
          ${buildRightPanel(selected, cachedSelected, lambda, sliderVal)}
        </div>
      </div>
      `}
    `;

    container.querySelector('#back-btn').addEventListener('click', () => navigate(2));
    container.querySelector('#next-btn').addEventListener('click', () => navigate(4));
    container.querySelector('#drt-refresh-btn')?.addEventListener('click', refreshAll);
    container.querySelector('#drt-stats-ident')?.addEventListener('change', e => {
      _statsIdent = e.target.value;
      updateStatsBody();
    });

    container.querySelectorAll('.drt-file-row').forEach(row => {
      row.addEventListener('click', () => {
        const fpath = row.dataset.path;
        const file  = (getState().files || []).find(f => f.path === fpath);
        if (file) handleFileSelect(file);
      });
    });

    wireControls();

    if (cachedSelected?.success) {
      requestAnimationFrame(() => plotDRT(cachedSelected));
    } else if (selected && !cachedSelected) {
      requestAnimationFrame(() => computeAndShow(selected));
    }
  }

  // ── Build a single table row ──────────────────────────────────
  function buildTableRow(file, selected) {
    const r          = _cache.get(file.path);
    const isSelected = selected?.path === file.path;
    const statusText  = r ? (r.success ? `${r.peaks.length} pk` : '✗') : '';
    const statusColor = r && !r.success ? 'color:var(--danger)' : '';
    const lambdaText  = r?.lambda_used != null ? fmtLambda(r.lambda_used)
                      : _lambdaCache.has(file.path) ? fmtLambda(_lambdaCache.get(file.path))
                      : '';
    const batteryId   = escHtml(String(
      r?.characterization?.battery_id ?? batteryIdFromPath(file) ?? '—'
    ));
    const charCells = _charKeys.map(k => {
      const v = r?.characterization?.[k];
      const d = v != null ? (typeof v === 'number' ? v.toPrecision(4) : v) : '—';
      return `<td class="drt-fcell drt-charval">${escHtml(String(d))}</td>`;
    }).join('');

    return `
      <tr class="drt-file-row${isSelected ? ' selected' : ''}" data-path="${escHtml(file.path)}">
        <td class="drt-fname" title="${escHtml(file.filename)}">${escHtml(file.filename)}</td>
        <td class="drt-fcell drt-fbattery">${batteryId}</td>
        ${charCells}
        <td class="drt-flambda" style="text-align:right;">${escHtml(lambdaText)}</td>
        <td class="drt-fstatus" style="${statusColor};text-align:right;">${statusText}</td>
      </tr>`;
  }

  // ── Right panel HTML ──────────────────────────────────────────
  function buildRightPanel(selected, result, lambda, sliderVal) {
    if (!selected) {
      return `<div class="drt-empty-hint">Select a file from the list to explore its DRT spectrum</div>`;
    }
    const hasResult = result?.success;
    return `
      <div class="drt-selected-file-name" title="${escHtml(selected.filename)}">${escHtml(selected.filename)}</div>

      <div class="drt-lambda-row">
        <span class="drt-lambda-label">Regularisation λ</span>
        <input type="range" id="drt-lambda-slider" min="-6" max="0" step="0.05" value="${sliderVal}">
        <span id="drt-lambda-val" class="drt-lambda-val">${fmtLambda(lambda)}</span>
        <button id="drt-auto-lambda" class="drt-auto-btn" title="Suggest optimal λ via L-curve analysis">⚡ Auto</button>
      </div>

      <div id="drt-quality-hint-wrap">${hasResult ? buildQualityHint(result) : ''}</div>

      <div id="drt-lcurve-section" class="drt-lcurve-section" style="display:none;">
        <div class="drt-lcurve-header">
          <span class="drt-lcurve-title">L-Curve</span>
          <span id="drt-lcurve-info" class="drt-lcurve-info"></span>
          <button id="drt-lcurve-dismiss" class="drt-icon-btn" title="Close">✕</button>
        </div>
        <div id="drt-lcurve-plot" class="drt-lcurve-plot"></div>
      </div>

      <div id="drt-loading" class="drt-spinner-row" style="display:none;">
        <div class="drt-spinner"></div>Computing DRT…
      </div>

      <div id="drt-spectrum-plot" class="drt-spectrum-plot" style="${hasResult ? '' : 'display:none;'}"></div>
      <div id="drt-plot-placeholder" class="drt-plot-placeholder" style="${hasResult ? 'display:none;' : ''}">
        ${result && !result.success
          ? `<span style="color:var(--danger)">${escHtml(result.error || 'Computation failed')}</span>`
          : 'Computing…'}
      </div>

      <div id="drt-peaks-summary">${hasResult ? buildPeaksHtml(result) : ''}</div>
    `;
  }

  // ── Per-file effective lambda ─────────────────────────────────
  function fileEffectiveLambda(filePath) {
    if (filePath && _lambdaCache.has(filePath)) return _lambdaCache.get(filePath);
    return getState().drtLambda ?? 1e-3;
  }

  // ── File selection ────────────────────────────────────────────
  function handleFileSelect(file) {
    if (getState().drtSelectedFile?.path === file.path) return;
    setState({ drtSelectedFile: file });

    container.querySelectorAll('.drt-file-row').forEach(row => {
      row.classList.toggle('selected', row.dataset.path === file.path);
    });

    const rightEl = container.querySelector('#drt-lab-right');
    if (!rightEl) return;

    const lambda    = fileEffectiveLambda(file.path);
    const sliderVal = Math.log10(lambda).toFixed(3);
    const cached    = _cache.get(file.path);

    rightEl.innerHTML = buildRightPanel(file, cached, lambda, sliderVal);
    wireControls();

    if (cached?.success) {
      requestAnimationFrame(() => plotDRT(cached));
    } else {
      // Result is computing via auto-run; show spinner; don't re-trigger
      const alreadyInFlight = !cached;
      if (alreadyInFlight) {
        // Check if it has an error (not just pending)
        if (cached?.success === false) {
          computeAndShow(file);
        }
        // else: auto-run will update when done via refreshSelectedIfMatch
      }
    }
  }

  // ── Control wiring ────────────────────────────────────────────
  function wireControls() {
    const slider = container.querySelector('#drt-lambda-slider');
    if (slider) {
      slider.addEventListener('input', () => {
        const lambda  = 10 ** parseFloat(slider.value);
        setState({ drtLambda: lambda });
        const selected = getState().drtSelectedFile;
        if (selected) _lambdaCache.set(selected.path, lambda);
        const display = container.querySelector('#drt-lambda-val');
        if (display) display.textContent = fmtLambda(lambda);
        updateLCurveCurrentMarker();
        scheduleRecompute();
      });
    }

    const autoBtn = container.querySelector('#drt-auto-lambda');
    if (autoBtn) autoBtn.addEventListener('click', computeAutoLambda);

    const dismissBtn = container.querySelector('#drt-lcurve-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        const sec = container.querySelector('#drt-lcurve-section');
        if (sec) sec.style.display = 'none';
        const plotEl = container.querySelector('#drt-spectrum-plot');
        if (plotEl?.data) requestAnimationFrame(() => Plotly.Plots.resize(plotEl));
      });
    }
  }

  function scheduleRecompute() {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => {
      const file = getState().drtSelectedFile;
      if (file) computeAndShow(file);
    }, 350);
  }

  // ── Refresh: clear caches and re-run all ─────────────────────
  function refreshAll() {
    _cache.clear();
    _lcurveCache.clear();
    _lambdaCache.clear();
    setState({ drtResults: [] });

    // Reset every row to blank state
    container.querySelectorAll('.drt-file-row').forEach(row => {
      const lambdaCell = row.querySelector('.drt-flambda');
      const statusCell = row.querySelector('.drt-fstatus');
      if (lambdaCell) lambdaCell.textContent = '';
      if (statusCell) { statusCell.textContent = ''; statusCell.style.color = ''; }
      row.querySelectorAll('.drt-charval').forEach(c => { c.textContent = '—'; });
    });

    runAutoAll();
  }

  // ── Auto-run on enter: all files ─────────────────────────────
  async function runAutoAll() {
    const state = getState();
    if (!state.files?.length || !state.columnMap) return;

    const gen   = ++_autoRunGen;
    const files = state.files;
    const CONCURRENCY = 3;

    // Only files without a cached result
    const toCompute = files.filter(f => !_cache.has(f.path));
    if (!toCompute.length) return;

    for (let i = 0; i < toCompute.length; i += CONCURRENCY) {
      if (_autoRunGen !== gen) return;
      await Promise.all(
        toCompute.slice(i, i + CONCURRENCY).map(f => autoComputeFile(f, gen))
      );
    }
  }

  async function autoComputeFile(file, gen) {
    if (_autoRunGen !== gen) return;
    setRowStatus(file.path, '⋯', false);

    try {
      const result = await computeDRTAuto({ file, column_map: getState().columnMap });
      if (_autoRunGen !== gen) return;

      _cache.set(file.path, result);
      if (result.lambda_used != null) _lambdaCache.set(file.path, result.lambda_used);
      persistResult(result);
      updateRowFromResult(file.path, result);

      // If this file is currently selected, populate the right panel
      const selected = getState().drtSelectedFile;
      if (selected?.path === file.path) refreshSelectedIfMatch(file, result);
    } catch (err) {
      if (_autoRunGen === gen) setRowStatus(file.path, '✗', true);
    }
  }

  // ── Per-file DOM update (without rebuilding the table) ────────
  function updateRowFromResult(filePath, result) {
    container.querySelectorAll('.drt-file-row').forEach(row => {
      if (row.dataset.path !== filePath) return;

      const charCells = row.querySelectorAll('.drt-charval');
      _charKeys.forEach((k, i) => {
        if (charCells[i]) {
          const v = result.characterization?.[k];
          charCells[i].textContent = v != null
            ? (typeof v === 'number' ? v.toPrecision(4) : v)
            : '—';
        }
      });

      const lambdaCell = row.querySelector('.drt-flambda');
      if (lambdaCell) {
        lambdaCell.textContent = result.lambda_used != null ? fmtLambda(result.lambda_used) : '—';
      }

      const statusCell = row.querySelector('.drt-fstatus');
      if (statusCell) {
        statusCell.textContent = result.success ? `${result.peaks.length} pk` : '✗';
        statusCell.style.color = result.success ? '' : 'var(--danger)';
      }
    });

    updateStatsBody();
  }

  // Called when autoComputeFile finishes for the currently-selected file
  function refreshSelectedIfMatch(file, result) {
    const rightEl = container.querySelector('#drt-lab-right');
    if (!rightEl) return;

    // Update the slider to show the auto-selected λ
    const lambda    = result.lambda_used ?? fileEffectiveLambda(file.filename);
    const sliderVal = Math.log10(lambda).toFixed(3);
    const sliderEl  = container.querySelector('#drt-lambda-slider');
    const displayEl = container.querySelector('#drt-lambda-val');
    if (sliderEl)  sliderEl.value = sliderVal;
    if (displayEl) displayEl.textContent = fmtLambda(lambda);

    // Update quality hint
    const hintWrap = container.querySelector('#drt-quality-hint-wrap');
    if (hintWrap) hintWrap.innerHTML = buildQualityHint(result);

    // Show or update the DRT plot
    const phEl    = container.querySelector('#drt-plot-placeholder');
    const plotEl  = container.querySelector('#drt-spectrum-plot');
    const peaksEl = container.querySelector('#drt-peaks-summary');

    if (result.success) {
      if (phEl)  phEl.style.display = 'none';
      if (plotEl) { plotEl.style.display = ''; plotEl.style.opacity = '1'; }
      plotDRT(result);
      if (peaksEl) peaksEl.innerHTML = buildPeaksHtml(result);
    } else {
      if (plotEl) plotEl.style.display = 'none';
      if (phEl) {
        phEl.style.display = 'flex';
        phEl.innerHTML = `<span style="color:var(--danger)">${escHtml(result.error || 'Computation failed')}</span>`;
      }
      if (peaksEl) peaksEl.innerHTML = '';
    }

    // Hide loading spinner if showing
    const loadingEl = container.querySelector('#drt-loading');
    if (loadingEl) loadingEl.style.display = 'none';
  }

  // ── Persist result to state.drtResults ────────────────────────
  function persistResult(result) {
    const prev = getState().drtResults || [];
    const key  = result.path || result.filename;
    const idx  = prev.findIndex(r => (r.path || r.filename) === key);
    setState({
      drtResults: idx >= 0
        ? [...prev.slice(0, idx), result, ...prev.slice(idx + 1)]
        : [...prev, result],
    });
  }

  // ── L-curve auto-λ ────────────────────────────────────────────
  async function computeAutoLambda() {
    const state = getState();
    const file  = state.drtSelectedFile;
    if (!file || !state.columnMap) return;

    const autoBtn = container.querySelector('#drt-auto-lambda');
    if (autoBtn) { autoBtn.disabled = true; autoBtn.textContent = '…'; }

    try {
      const data = await computeLCurve({ file, column_map: state.columnMap });

      if (!data.success) {
        console.error('L-curve traceback:\n', data.traceback || data.error);
        showToast(`L-curve failed: ${data.error}`, 'error');
        return;
      }

      _lcurveCache.set(file.path, data);
      showLCurveSection(data);

      const optLambda = data.optimal_lambda;
      setState({ drtLambda: optLambda });
      _lambdaCache.set(file.path, optLambda);
      const slider  = container.querySelector('#drt-lambda-slider');
      const display = container.querySelector('#drt-lambda-val');
      if (slider)  slider.value = Math.log10(optLambda).toFixed(3);
      if (display) display.textContent = fmtLambda(optLambda);

      computeAndShow(file);
    } catch (err) {
      showToast(`L-curve error: ${err.message}`, 'error');
    } finally {
      if (autoBtn) { autoBtn.disabled = false; autoBtn.textContent = '⚡ Auto'; }
    }
  }

  function showLCurveSection(data) {
    const sec = container.querySelector('#drt-lcurve-section');
    if (!sec) return;
    sec.style.display = '';

    const infoEl = container.querySelector('#drt-lcurve-info');
    if (infoEl) {
      infoEl.innerHTML =
        `Optimal λ&nbsp;<span class="drt-lcurve-lambda">${fmtLambda(data.optimal_lambda)}</span>` +
        `<span class="drt-lcurve-badge">applied</span>`;
    }

    const dismissBtn = container.querySelector('#drt-lcurve-dismiss');
    if (dismissBtn) dismissBtn.onclick = () => {
      sec.style.display = 'none';
      const plotEl = container.querySelector('#drt-spectrum-plot');
      if (plotEl?.data) requestAnimationFrame(() => Plotly.Plots.resize(plotEl));
    };

    requestAnimationFrame(() => {
      plotLCurve(data);
      const plotEl = container.querySelector('#drt-spectrum-plot');
      if (plotEl?.data) Plotly.Plots.resize(plotEl);
    });
  }

  function plotLCurve(data) {
    const el = container.querySelector('#drt-lcurve-plot');
    if (!el || typeof Plotly === 'undefined') return;

    const pts           = data.points;
    const n             = pts.length;
    const currentLambda = fileEffectiveLambda(getState().drtSelectedFile?.path);
    const currentIdx    = nearestLambdaIdx(pts, currentLambda);

    const rn = pts.map(p => p.residual_norm);
    const sn = pts.map(p => p.solution_norm);

    const colors = pts.map((_, i) => {
      const t = i / Math.max(n - 1, 1);
      return `rgb(${Math.round(78 + t * 146)},${Math.round(150 - t * 116)},${Math.round(196 - t * 140)})`;
    });

    const axStyle = {
      color: '#8892b0', gridcolor: '#2d3147', zeroline: false,
      tickfont: { size: 8 }, type: 'log',
    };

    Plotly.newPlot(el, [
      {
        x: rn, y: sn,
        mode: 'markers+lines', type: 'scatter',
        marker: { color: colors, size: 5 },
        line:   { color: '#3a3f5c', width: 1 },
        text: pts.map(p => `λ = ${fmtLambda(p.lambda_val)}`),
        hovertemplate: '%{text}<extra></extra>',
        showlegend: false,
      },
      {
        x: [rn[data.optimal_index]], y: [sn[data.optimal_index]],
        mode: 'markers', type: 'scatter',
        marker: { color: 'var(--accent)', size: 11, symbol: 'star',
                  line: { color: '#fff', width: 1.5 } },
        hovertemplate: `Optimal λ = ${fmtLambda(data.optimal_lambda)}<extra></extra>`,
        showlegend: false,
      },
      {
        x: [rn[currentIdx]], y: [sn[currentIdx]],
        mode: 'markers', type: 'scatter',
        marker: { color: '#f1c40f', size: 9, symbol: 'diamond',
                  line: { color: '#fff', width: 1 } },
        hovertemplate: `Current λ = ${fmtLambda(pts[currentIdx].lambda_val)}<extra></extra>`,
        showlegend: false,
      },
    ], {
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      height: 140,
      margin: { t: 4, r: 8, b: 40, l: 52 },
      font:   { color: '#8892b0', size: 9 },
      xaxis:  { ...axStyle, title: { text: 'Residual norm', font: { size: 9 } } },
      yaxis:  { ...axStyle, title: { text: 'Solution norm', font: { size: 9 } } },
    }, { displayModeBar: false, responsive: true });
  }

  function updateLCurveCurrentMarker() {
    const sec = container.querySelector('#drt-lcurve-section');
    if (!sec || sec.style.display === 'none') return;
    const file = getState().drtSelectedFile;
    const data = file ? _lcurveCache.get(file.path) : null;
    if (!data) return;
    const el = container.querySelector('#drt-lcurve-plot');
    if (!el?.data) return;
    const lambda = fileEffectiveLambda(file?.filename);
    const idx = nearestLambdaIdx(data.points, lambda);
    Plotly.restyle(el, {
      x: [[data.points.map(p => p.residual_norm)[idx]]],
      y: [[data.points.map(p => p.solution_norm)[idx]]],
    }, [2]);
  }

  // ── Per-file DRT computation (manual slider) ──────────────────
  async function computeAndShow(file) {
    const state = getState();
    if (!state.columnMap) return;

    const seq    = ++_computeSeq;
    const lambda = fileEffectiveLambda(file.path);

    const loadingEl = container.querySelector('#drt-loading');
    const plotEl    = container.querySelector('#drt-spectrum-plot');
    if (loadingEl) loadingEl.style.display = 'flex';
    if (plotEl)    plotEl.style.opacity = '0.35';

    setRowStatus(file.filename, '⋯', false);

    try {
      const result = await computeDRTSingle({ file, column_map: state.columnMap, lambda_reg: lambda });
      if (_computeSeq !== seq) return;

      result.lambda_used = lambda;
      result.path = file.path;
      _cache.set(file.path, result);
      _lambdaCache.set(file.path, lambda);
      persistResult(result);

      setRowStatus(file.path, result.success ? `${result.peaks.length} pk` : '✗', !result.success);
      updateRowLambda(file.path, lambda);

      const hintWrap = container.querySelector('#drt-quality-hint-wrap');
      if (hintWrap) hintWrap.innerHTML = buildQualityHint(result);

      const phEl    = container.querySelector('#drt-plot-placeholder');
      const peaksEl = container.querySelector('#drt-peaks-summary');

      if (result.success) {
        if (phEl)  phEl.style.display = 'none';
        if (plotEl) { plotEl.style.display = ''; plotEl.style.opacity = '1'; }
        plotDRT(result);
        if (peaksEl) peaksEl.innerHTML = buildPeaksHtml(result);
      } else {
        if (plotEl) plotEl.style.display = 'none';
        if (phEl)  { phEl.style.display = 'flex'; phEl.innerHTML = `<span style="color:var(--danger)">${escHtml(result.error || 'Failed')}</span>`; }
        if (peaksEl) peaksEl.innerHTML = '';
      }
      updateStatsBody();
    } catch (err) {
      if (_computeSeq !== seq) return;
      setRowStatus(file.path, '✗', true);
      showToast(`DRT error: ${err.message}`, 'error');
    } finally {
      if (_computeSeq === seq) {
        if (loadingEl) loadingEl.style.display = 'none';
        if (plotEl)    plotEl.style.opacity = '1';
      }
    }
  }

  // ── Targeted DOM helpers ──────────────────────────────────────
  function setRowStatus(filePath, text, isError) {
    container.querySelectorAll('.drt-file-row').forEach(row => {
      if (row.dataset.path !== filePath) return;
      const cell = row.querySelector('.drt-fstatus');
      if (cell) { cell.textContent = text; cell.style.color = isError ? 'var(--danger)' : ''; }
    });
  }

  function updateRowLambda(filePath, lambda) {
    container.querySelectorAll('.drt-file-row').forEach(row => {
      if (row.dataset.path !== filePath) return;
      const cell = row.querySelector('.drt-flambda');
      if (cell) cell.textContent = fmtLambda(lambda);
    });
  }

  // ── DRT spectrum plot ─────────────────────────────────────────
  function plotDRT(result) {
    const el = container.querySelector('#drt-spectrum-plot');
    if (!el || typeof Plotly === 'undefined') return;

    const traces = [{
      x: result.log_tau, y: result.gamma,
      mode: 'lines', type: 'scatter', name: 'γ(τ)',
      line: { color: 'var(--accent)', width: 2 },
    }];

    (result.peaks || []).forEach((p, i) => {
      const color  = PEAK_COLORS[i % PEAK_COLORS.length];
      const gaussY = result.log_tau.map(x =>
        p.amplitude * Math.exp(-0.5 * ((x - p.log_tau_center) / (p.sigma || 0.3)) ** 2)
      );
      traces.push({
        x: result.log_tau, y: gaussY,
        mode: 'lines', type: 'scatter', name: `Peak ${i + 1}`,
        line: { color, width: 1.5, dash: 'dot' },
      });
    });

    Plotly.newPlot(el, traces, {
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      margin: { t: 8, r: 12, b: 40, l: 52 },
      font:   { color: '#8892b0', size: 10 },
      xaxis: { title: 'log₁₀(τ / s)', color: '#8892b0', gridcolor: '#2d3147', zeroline: false },
      yaxis: { title: 'γ(τ)',          color: '#8892b0', gridcolor: '#2d3147', zeroline: false },
      legend: { x: 0.68, y: 0.95, font: { size: 10 }, bgcolor: 'transparent' },
      showlegend: traces.length > 1,
      shapes: (result.peaks || []).map((p, i) => ({
        type: 'line',
        x0: p.log_tau_center, x1: p.log_tau_center, y0: 0, y1: 1,
        xref: 'x', yref: 'paper',
        line: { color: PEAK_COLORS[i % PEAK_COLORS.length], width: 1, dash: 'dot' },
      })),
    }, { displayModeBar: false, responsive: true });
  }

  // ── Quality hint ──────────────────────────────────────────────
  function buildQualityHint(result) {
    if (!result?.success) return '';
    const n = result.peaks?.length ?? 0;
    if (n === 0) {
      return `<div class="drt-quality-hint drt-hint-warn">No peaks detected — λ may be too high (over-regularised)</div>`;
    }
    const avgR2 = result.peaks.reduce((s, p) => s + p.r2, 0) / n;
    if (n > 5 && avgR2 < 0.7) {
      return `<div class="drt-quality-hint drt-hint-warn">${n} low-quality peaks (avg R²&nbsp;${(avgR2 * 100).toFixed(0)}%) — λ may be too low</div>`;
    }
    return '';
  }

  // ── Peaks summary ─────────────────────────────────────────────
  function buildPeaksHtml(result) {
    if (!result.peaks?.length) {
      return `<div style="font-size:12px;color:var(--text-muted);padding:8px 0;">No peaks detected.</div>`;
    }
    const rows = result.peaks.map((p, i) => {
      const color   = PEAK_COLORS[i % PEAK_COLORS.length];
      const mech    = categorizePeak(p);
      const r2color = p.r2 >= 0.9 ? 'var(--success)' : p.r2 >= 0.7 ? 'var(--warning)' : 'var(--danger)';
      return `
        <tr>
          <td style="color:${color};font-weight:600;">${i + 1}</td>
          <td style="font-family:monospace;">${fmtTau(p.tau_center)}</td>
          <td style="color:var(--text-muted);">${mech.label}</td>
          <td style="color:${r2color};">${(p.r2 * 100).toFixed(0)}%</td>
          <td style="color:var(--text-muted);">σ = ${p.sigma.toFixed(2)}</td>
        </tr>`;
    }).join('');

    return `
      <div class="drt-peaks-label">Detected Peaks</div>
      <table class="drt-peaks-table">
        <thead><tr><th>#</th><th>τ</th><th>Process</th><th>R²</th><th>Width</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  // ── Peak-distribution stats ───────────────────────────────────
  function statsIdentOpts(current) {
    // Collect all identifier keys from charKeys + keys seen in cached results
    const keySet = new Set(_charKeys);
    for (const r of _cache.values()) {
      if (r.success && r.characterization) {
        Object.keys(r.characterization).forEach(k => keySet.add(k));
      }
    }
    const keys = [...keySet];
    if (!keys.length) return `<option value="">— no identifiers —</option>`;
    return keys.map(k =>
      `<option value="${escHtml(k)}" ${k === current ? 'selected' : ''}>${escHtml(k)}</option>`
    ).join('');
  }

  function buildStatsHtml(identKey) {
    if (!identKey) return `<div class="drt-stats-empty">No identifiers mapped</div>`;

    const successResults = [..._cache.values()].filter(r => r.success);
    if (!successResults.length) {
      return `<div class="drt-stats-empty">Computing…</div>`;
    }

    // Group by identifier value
    const groups = new Map();
    successResults.forEach(r => {
      const val = r.characterization?.[identKey];
      if (val == null) return;
      const key = String(val);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r.peaks.length);
    });

    if (!groups.size) {
      return `<div class="drt-stats-empty">No data for "${escHtml(identKey)}"</div>`;
    }

    // Peak-count columns: 1, 2, 3, 4+
    const CAP = 4;
    const colLabels = ['1', '2', '3', '4+'];

    const sortedKeys = [...groups.keys()].sort((a, b) => {
      const na = parseFloat(a), nb = parseFloat(b);
      return isNaN(na) || isNaN(nb) ? a.localeCompare(b) : na - nb;
    });

    const headerCols = colLabels.map(l => `<th class="drt-stats-pkcol">${l}</th>`).join('');

    const rows = sortedKeys.map(key => {
      const counts = groups.get(key);
      const n = counts.length;
      const cells = [1, 2, 3].map(i => {
        const c = counts.filter(p => p === i).length;
        const pct = Math.round(c / n * 100);
        return `<td class="drt-stats-cell">${pctHtml(pct)}</td>`;
      }).join('') + (() => {
        const c = counts.filter(p => p >= CAP).length;
        const pct = Math.round(c / n * 100);
        return `<td class="drt-stats-cell">${pctHtml(pct)}</td>`;
      })();

      return `<tr>
        <td class="drt-stats-key">${escHtml(key)}</td>
        <td class="drt-stats-n">${n}</td>
        ${cells}
      </tr>`;
    }).join('');

    return `
      <table class="drt-stats-table">
        <thead>
          <tr>
            <th>${escHtml(identKey)}</th>
            <th title="Computed files">n</th>
            ${headerCols}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function pctHtml(pct) {
    if (!pct) return `<span style="color:var(--text-dim)">—</span>`;
    const t   = pct / 100;
    // Background fills quadratically — barely visible at low %, solid teal at high %
    const bg  = (t * t * 0.65).toFixed(2);
    // Text: dim teal when unfilled, light when background is solid enough
    const fg  = t > 0.52 ? '#cffaf8'
              : `rgba(78,205,196,${(0.30 + 0.55 * t).toFixed(2)})`;
    const w   = pct >= 50 ? '700' : pct >= 20 ? '500' : '400';
    return `<span style="background:rgba(78,205,196,${bg});color:${fg};font-weight:${w};padding:1px 5px;border-radius:3px;white-space:nowrap;">${pct}%</span>`;
  }

  function updateStatsBody() {
    const el = container.querySelector('#drt-stats-body');
    if (!el) return;
    const sel = container.querySelector('#drt-stats-ident');
    const ident = sel?.value || _statsIdent;
    el.innerHTML = buildStatsHtml(ident);

    // Refresh the identifier <select> options (new keys may have appeared)
    if (sel) {
      const prev = sel.value;
      sel.innerHTML = statsIdentOpts(prev);
    }
  }

  return {
    onEnter() {
      ++_autoRunGen; // cancel any previous batch
      render();
      const state = getState();
      if (state.files?.length && state.columnMap) {
        requestAnimationFrame(() => runAutoAll());
      }
    },
  };
}
