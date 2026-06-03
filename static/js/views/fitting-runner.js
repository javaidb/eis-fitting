import { getState, setState } from '../state.js';
import { streamFitting } from '../api.js';

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
  });
}

function batteryIdFromPath(path) {
  const parts = (path || '').replace(/\\/g, '/').split('/');
  const parent = parts.length >= 2 ? parts[parts.length - 2] : '';
  const m = parent.match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

function groupFiles(files) {
  const groups = new Map();
  for (const f of files) {
    const bid = batteryIdFromPath(f.path);
    const parts = (f.path || '').replace(/\\/g, '/').split('/');
    const parent = parts.length >= 2 ? parts[parts.length - 2] : 'Files';
    const key = bid != null ? `battery_${bid}` : parent;
    const label = bid != null ? `Battery ${bid}` : parent;
    if (!groups.has(key)) groups.set(key, { label, files: [] });
    groups.get(key).files.push(f);
  }
  return groups;
}

// Stable, unique DOM id derived from a file's path (unique across batteries even
// when filenames repeat, e.g. battery_01/EIS.csv and battery_02/EIS.csv).
function pathToSafeId(path) {
  return (path || '').replace(/[^a-zA-Z0-9]/g, '_');
}

export function FittingRunnerView(container, { navigate, showToast }) {
  // Keyed by file path (unique), not filename (which can repeat across batteries).
  const resultMap = new Map();

  function render() {
    const state = getState();
    const ready = state.files?.length && state.columnMap && state.circuitConfig;
    const cached = ready && state.fitResults?.length && state.fitCacheKey === configKey(state);

    // Correlate saved results to files by position — results are stored in the same
    // order as state.files, so fitResults[i] belongs to files[i].
    resultMap.clear();
    const files = state.files || [];
    (state.fitResults || []).forEach((r, i) => {
      if (files[i]) resultMap.set(files[i].path, r);
    });

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
        <button class="btn btn-danger" id="stop-btn" style="display:none;">■ Stop</button>
        <button class="btn btn-primary" id="run-btn" ${!ready ? 'disabled' : ''}>${cached ? '↺ Re-run Fitting' : '▶ Run Fitting'}</button>
        <button class="btn btn-secondary" id="next-btn" ${!state.fitResults?.length ? 'disabled' : ''}>View Trends →</button>
      </div>

      <div class="fit-tile-root" id="fit-tile-root">
        ${buildTileGrid(files, resultMap)}
      </div>

      <div class="fit-modal-overlay" id="fit-modal" style="display:none;" role="dialog" aria-modal="true">
        <div class="fit-modal-box">
          <div class="fit-modal-header">
            <span class="fit-modal-title" id="fit-modal-title"></span>
            <span class="residual-badge" id="fit-modal-badge"></span>
            <button class="fit-modal-close" id="fit-modal-close" aria-label="Close">✕</button>
          </div>
          <div class="fit-modal-meta" id="fit-modal-meta"></div>
          <div class="fit-modal-tabs" id="fit-modal-tabs">
            <button class="tab-btn active" data-tab="nyquist">Nyquist</button>
            <button class="tab-btn" data-tab="bode">Bode</button>
            <button class="tab-btn" data-tab="residuals">Residuals</button>
          </div>
          <div class="fit-modal-plot" id="fit-modal-plot"></div>
          <div class="params-summary fit-modal-params" id="fit-modal-params"></div>
        </div>
      </div>
    `;

    container.querySelector('#back-btn').addEventListener('click', () => navigate(5));
    container.querySelector('#next-btn').addEventListener('click', () => navigate(7));
    container.querySelector('#run-btn').addEventListener('click', runFitting);
    container.querySelector('#stop-btn').addEventListener('click', stopFitting);
    container.querySelector('#clear-cache-link')?.addEventListener('click', e => { e.preventDefault(); runFitting(); });
    container.querySelector('#fit-modal-close').addEventListener('click', closeModal);
    container.querySelector('#fit-modal').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeModal();
    });

    wireTileClicks();
  }

  function buildTileGrid(files, rMap) {
    if (!files.length) return '';
    const groups = groupFiles(files);
    return [...groups.entries()].map(([, { label, files: gFiles }]) => `
      <div class="fit-group">
        <div class="fit-group-header">${label}</div>
        <div class="fit-tile-row">
          ${gFiles.map(f => buildTile(f.filename, f.path, rMap.get(f.path))).join('')}
        </div>
      </div>
    `).join('');
  }

  // path is used as the unique tile key (filename repeats across batteries, path never does).
  function buildTile(filename, path, result) {
    const safeId = pathToSafeId(path);
    if (!result) {
      return `<div class="fit-tile pending" data-path="${path}" id="tile-${safeId}">
        <div class="fit-tile-name">${filename}</div>
        <div class="fit-tile-pct">—</div>
      </div>`;
    }
    const good = result.success && result.residual != null && result.residual < GOOD_THRESHOLD;
    const cls = result.success ? (good ? 'good' : 'poor') : 'failed';
    const pct = result.residual != null ? `${(result.residual * 100).toFixed(1)}%` : '—';
    return `<div class="fit-tile ${cls}" data-path="${path}" id="tile-${safeId}">
      <div class="fit-tile-name">${filename}</div>
      <div class="fit-tile-pct">${result.success ? pct : 'FAILED'}</div>
    </div>`;
  }

  function wireTileClicks() {
    container.querySelectorAll('.fit-tile:not(.pending)').forEach(el => {
      el.addEventListener('click', () => {
        const result = resultMap.get(el.dataset.path);
        if (result) openModal(result);
      });
    });
  }

  function updateTile(result, path) {
    const el = container.querySelector(`#tile-${pathToSafeId(path)}`);
    if (!el) return;

    const good = result.success && result.residual != null && result.residual < GOOD_THRESHOLD;
    const cls = result.success ? (good ? 'good' : 'poor') : 'failed';
    const pct = result.residual != null ? `${(result.residual * 100).toFixed(1)}%` : '—';

    el.className = `fit-tile ${cls}`;
    el.querySelector('.fit-tile-pct').textContent = result.success ? pct : 'FAILED';
    // Clone to drop accumulated listeners from any previous run before adding the new one.
    const fresh = el.cloneNode(true);
    fresh.addEventListener('click', () => openModal(result));
    el.replaceWith(fresh);
  }

  function openModal(result) {
    const modal    = container.querySelector('#fit-modal');
    const titleEl  = container.querySelector('#fit-modal-title');
    const badgeEl  = container.querySelector('#fit-modal-badge');
    const metaEl   = container.querySelector('#fit-modal-meta');
    const plotEl   = container.querySelector('#fit-modal-plot');
    const paramsEl = container.querySelector('#fit-modal-params');

    titleEl.textContent = result.filename;

    const good = result.success && result.residual != null && result.residual < GOOD_THRESHOLD;
    const qualClass = result.success ? (good ? 'good' : 'poor') : 'failed';
    const residualPct = result.residual != null ? (result.residual * 100).toFixed(2) : '—';
    badgeEl.className = `residual-badge ${qualClass}`;
    badgeEl.textContent = result.success ? `${residualPct}%` : 'FAILED';

    const charStr = Object.entries(result.characterization || {})
      .map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toPrecision(4) : v}`)
      .join(' · ');
    const circuitStr = result.circuit_used ? `Circuit: ${result.circuit_used}` : '';
    metaEl.textContent = [charStr, circuitStr].filter(s => s).join(' · ');
    if (result.error) metaEl.textContent += (metaEl.textContent ? ' · ' : '') + result.error;

    paramsEl.innerHTML = Object.entries(result.parameters || {})
      .map(([k, v]) => {
        const { scale, unit } = paramUnitInfo(k);
        const disp = typeof v === 'number' ? (v * scale).toExponential(3) : v;
        const warn = typeof v === 'number' ? checkPhysical(k, v) : null;
        const warnHtml = warn ? ` <span class="param-warn" title="${warn}">⚠</span>` : '';
        return `<span>${k}${warnHtml}</span>${disp}${unit ? ' ' + unit : ''}`;
      })
      .join(' &nbsp; ');

    // Reset tabs to Nyquist and wire switching. Clone to clear previous result's listeners.
    const tabsEl = container.querySelector('#fit-modal-tabs');
    const freshTabs = tabsEl.cloneNode(true);
    tabsEl.replaceWith(freshTabs);

    // Add or remove the Variants tab depending on whether there are variants to show.
    freshTabs.querySelector('[data-tab="variants"]')?.remove();
    if (result.variants_tried?.length > 1) {
      const vBtn = document.createElement('button');
      vBtn.className = 'tab-btn';
      vBtn.dataset.tab = 'variants';
      vBtn.textContent = `Variants (${result.variants_tried.length})`;
      freshTabs.appendChild(vBtn);
    }

    freshTabs.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === 'nyquist');
      btn.addEventListener('click', () => {
        freshTabs.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        plotEl.innerHTML = '';
        requestAnimationFrame(() => {
          if (btn.dataset.tab === 'nyquist')        plotNyquist(result, plotEl);
          else if (btn.dataset.tab === 'bode')      plotBode(result, plotEl);
          else if (btn.dataset.tab === 'variants')  plotVariants(result, plotEl);
          else                                      plotResiduals(result, plotEl);
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

  let _abortCtrl = null;

  function stopFitting() {
    _abortCtrl?.abort();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') closeModal();
  }

  async function runFitting() {
    const state = getState();
    if (!state.files?.length || !state.columnMap || !state.circuitConfig) return;

    const runBtn        = container.querySelector('#run-btn');
    const stopBtn       = container.querySelector('#stop-btn');
    const nextBtn       = container.querySelector('#next-btn');
    const fitStatus     = container.querySelector('#fit-status');
    const progressBar   = container.querySelector('#progress-bar');
    const progressLabel = container.querySelector('#progress-label');
    const tileRoot      = container.querySelector('#fit-tile-root');

    // Ordered list of file paths matching the order the server will return results.
    const filePaths = state.files.map(f => f.path);

    _abortCtrl = new AbortController();
    runBtn.disabled = true;
    stopBtn.style.display = '';
    fitStatus.style.display = '';

    resultMap.clear();
    setState({ fitCacheKey: null, fitResults: [] });
    tileRoot.innerHTML = buildTileGrid(state.files, resultMap);

    const results = [];
    let stopped = false;
    let gotDone = false;

    const timeout  = parseFloat(container.querySelector('#fit-timeout').value) || 60;
    const freqMinVal = container.querySelector('#freq-min').value.trim();
    const freqMaxVal = container.querySelector('#freq-max').value.trim();
    const freqMin  = freqMinVal !== '' ? parseFloat(freqMinVal) : null;
    const freqMax  = freqMaxVal !== '' ? parseFloat(freqMaxVal) : null;
    const runCacheKey = configKey({ ...state, fitTimeout: timeout, fitFreqMin: freqMin, fitFreqMax: freqMax });

    try {
      setState({ fitTimeout: timeout, fitFreqMin: freqMin, fitFreqMax: freqMax });

      const request = {
        files:           state.files,
        column_map:      { ...state.columnMap, decimal_places: state.charDecimalPlaces ?? {} },
        circuit_config:  state.circuitConfig,
        fit_timeout:     timeout,
        optimize_config: state.optimizeConfig ?? { enabled: false },
        freq_min:        freqMin,
        freq_max:        freqMax,
      };

      for await (const event of streamFitting(request, _abortCtrl.signal)) {
        if (event.event === 'progress') {
          const pct = Math.round((event.index / event.total) * 100);
          progressBar.style.width = `${pct}%`;
          progressLabel.textContent = `Fitting ${event.file} (${event.index + 1} / ${event.total})`;
        } else if (event.event === 'result') {
          const result = event.data;
          // results arrive in the same order as filePaths, so index = current length before push
          const path = filePaths[results.length];
          results.push(result);
          resultMap.set(path, result);
          updateTile(result, path);
          // Yield a paint frame so each tile visually updates before the next result
          // is processed — without this, a burst of SSE events in one TCP chunk would
          // be handled entirely in microtasks with no repaint opportunity between them.
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
      const completed = !stopped && gotDone;
      setState({
        fitResults:  results,
        fitCacheKey: completed ? runCacheKey : null,
        maxStep:     Math.max(state.maxStep, 7),
      });

      // Refresh banners/buttons to reflect the latest cache state.
      render();
    }
  }

  function plotBode(result, el) {
    if (!el || typeof Plotly === 'undefined') return;
    const freqs = result.frequencies;
    if (!freqs?.length) { el.textContent = 'No frequency data'; return; }

    const dataMag   = result.z_real_data.map((r, i) => Math.sqrt(r ** 2 + result.z_imag_data[i] ** 2));
    const dataPhase = result.z_real_data.map((r, i) => Math.atan2(result.z_imag_data[i], r) * 180 / Math.PI);

    const traces = [
      { x: freqs, y: dataMag,   mode: 'markers', name: '|Z| data',   marker: { color: '#8892b0', size: 5 }, xaxis: 'x',  yaxis: 'y'  },
      { x: freqs, y: dataPhase, mode: 'markers', name: 'Phase data', marker: { color: '#8892b0', size: 5 }, xaxis: 'x2', yaxis: 'y2' },
    ];

    if (result.success && result.z_real_fit?.length) {
      const fitMag   = result.z_real_fit.map((r, i) => Math.sqrt(r ** 2 + result.z_imag_fit[i] ** 2));
      const fitPhase = result.z_real_fit.map((r, i) => Math.atan2(result.z_imag_fit[i], r) * 180 / Math.PI);
      traces.push({ x: freqs, y: fitMag,   mode: 'lines', name: '|Z| fit',   line: { color: 'var(--accent)', width: 2 },              xaxis: 'x',  yaxis: 'y'  });
      traces.push({ x: freqs, y: fitPhase, mode: 'lines', name: 'Phase fit', line: { color: 'var(--accent)', width: 2, dash: 'dash' }, xaxis: 'x2', yaxis: 'y2' });
    }

    const axisStyle = { type: 'log', color: '#8892b0', gridcolor: '#2d3147', zeroline: false };
    Plotly.newPlot(el, traces, {
      grid: { rows: 2, columns: 1, pattern: 'independent' },
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      margin: { t: 8, r: 16, b: 48, l: 64 },
      font:   { color: '#8892b0', size: 11 },
      xaxis:  { ...axisStyle, title: 'Frequency (Hz)' },
      yaxis:  { ...axisStyle, title: '|Z| (Ω)' },
      xaxis2: { ...axisStyle, title: 'Frequency (Hz)' },
      yaxis2: { type: 'linear', color: '#8892b0', gridcolor: '#2d3147', title: 'Phase (°)' },
      showlegend: false,
    }, { displayModeBar: false, responsive: true });
  }

  function plotResiduals(result, el) {
    if (!el || typeof Plotly === 'undefined') return;
    const freqs = result.frequencies;
    if (!freqs?.length || !result.success || !result.z_real_fit?.length) {
      el.textContent = 'No residuals available';
      return;
    }

    const realRes = result.z_real_data.map((r, i) =>
      (r - result.z_real_fit[i]) / (Math.abs(r) + 1e-12) * 100);
    const imagRes = result.z_imag_data.map((v, i) =>
      (v - result.z_imag_fit[i]) / (Math.abs(v) + 1e-12) * 100);

    Plotly.newPlot(el, [
      { x: freqs, y: realRes, mode: 'markers+lines', name: "Z' residual",  marker: { color: '#e05c5c', size: 4 }, line: { color: '#e05c5c', width: 1 } },
      { x: freqs, y: imagRes, mode: 'markers+lines', name: "Z'' residual", marker: { color: '#4a9ade', size: 4 }, line: { color: '#4a9ade', width: 1 } },
    ], {
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      margin: { t: 8, r: 16, b: 48, l: 64 },
      font:   { color: '#8892b0', size: 11 },
      xaxis:  { title: 'Frequency (Hz)', type: 'log', color: '#8892b0', gridcolor: '#2d3147', zeroline: false },
      yaxis:  { title: 'Residual (%)', color: '#8892b0', gridcolor: '#2d3147', zeroline: true, zerolinecolor: '#4a5080' },
      legend: { x: 0.6, y: 0.95, font: { size: 10 } },
      showlegend: true,
    }, { displayModeBar: false, responsive: true });
  }

  function plotVariants(result, el) {
    const variants = result.variants_tried || [];
    if (!variants.length) {
      el.innerHTML = '<p style="color:var(--text-muted);padding:16px 0;">No variant data available.</p>';
      return;
    }

    const oc = getState().optimizeConfig ?? {};
    const criterion = (oc.criterion ?? 'AIC').toLowerCase();

    const successVariants = variants.filter(v => v.success && v[criterion] != null);
    const bestScore = successVariants.length ? Math.min(...successVariants.map(v => v[criterion])) : null;

    const infoId = 'variants-info-popup';
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;position:relative;">
        <span style="font-size:12px;color:var(--text-muted);">Winner = 0. All others show how much worse (ΔAIC / ΔBIC). ★ marks the selected circuit.</span>
        <button id="variants-info-btn" style="background:none;border:1px solid var(--border);border-radius:50%;width:18px;height:18px;font-size:11px;color:var(--text-muted);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;line-height:1;">ⓘ</button>
        <div id="${infoId}" style="display:none;position:absolute;left:0;top:24px;z-index:10;width:340px;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:12px;line-height:1.6;color:var(--text);box-shadow:0 4px 16px rgba(0,0,0,.3);">
          <div style="font-weight:600;margin-bottom:6px;">How to read ΔAIC / ΔBIC</div>
          <p style="margin:0 0 6px;">The winning circuit is always <strong>0</strong>. Every other circuit shows how much worse it is relative to the winner — so +4 means "4 points worse than the best."</p>
          <p style="margin:0 0 6px;"><strong>AIC</strong> (Akaike) and <strong>BIC</strong> (Bayesian) both reward a better fit but penalise circuits with more free parameters, so a 3-RC circuit doesn't automatically win just because it fits slightly better.</p>
          <p style="margin:0;"><strong>BIC</strong> penalises extra parameters more heavily, so it tends to select simpler circuits. A common rule of thumb: ΔAIC &lt; 2 means the two circuits are essentially equivalent; ΔAIC &gt; 10 means the winner is strongly preferred.</p>
        </div>
      </div>
      <div style="overflow-x:auto;overflow-y:auto;max-height:260px;">
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
            ${(() => {
              const bestAic = Math.min(...variants.filter(v => v.success && v.aic != null).map(v => v.aic));
              const bestBic = Math.min(...variants.filter(v => v.success && v.bic != null).map(v => v.bic));
              return variants.map(v => {
                const isWinner = v.success && bestScore != null && v[criterion] === bestScore;
                const bg      = isWinner ? 'background:rgba(100,220,150,0.07);' : '';
                const opacity = v.success ? '' : 'opacity:0.45;';
                const resText = v.residual != null ? `${(v.residual * 100).toFixed(2)}%` : (v.error ?? '—');
                const dAic = v.aic != null && isFinite(bestAic) ? `+${(v.aic - bestAic).toFixed(1)}` : '—';
                const dBic = v.bic != null && isFinite(bestBic) ? `+${(v.bic - bestBic).toFixed(1)}` : '—';
                return `<tr style="${bg}${opacity}">
                  <td style="padding:4px 10px;font-family:monospace;font-size:11px;color:var(--accent);">${v.circuit_string}</td>
                  <td style="text-align:right;padding:4px 8px;">${v.n_params}</td>
                  <td style="text-align:right;padding:4px 8px;">${resText}</td>
                  <td style="text-align:right;padding:4px 8px;">${isWinner ? '0' : dAic}</td>
                  <td style="text-align:right;padding:4px 8px;">${isWinner ? '0' : dBic}</td>
                  <td style="text-align:center;padding:4px 8px;color:#64dc96;font-size:14px;">${isWinner ? '★' : ''}</td>
                </tr>`;
              }).join('');
            })()}
          </tbody>
        </table>
      </div>`;

    // Info button toggle
    const infoBtn = el.querySelector('#variants-info-btn');
    const infoPopup = el.querySelector(`#${infoId}`);
    infoBtn.addEventListener('click', e => {
      e.stopPropagation();
      infoPopup.style.display = infoPopup.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', function closeInfo() {
      infoPopup.style.display = 'none';
      document.removeEventListener('click', closeInfo);
    }, { once: true });
  }

  function plotNyquist(result, el) {
    if (!el || typeof Plotly === 'undefined') return;

    const traces = [];
    if (result.z_real_data?.length) {
      traces.push({
        x: result.z_real_data,
        y: result.z_imag_data.map(v => -v),
        mode: 'markers', type: 'scatter', name: 'Data',
        marker: { color: '#8892b0', size: 5 },
      });
    }
    if (result.success && result.z_real_fit?.length) {
      traces.push({
        x: result.z_real_fit,
        y: result.z_imag_fit.map(v => -v),
        mode: 'lines', type: 'scatter', name: 'Fit',
        line: { color: 'var(--accent)', width: 2 },
      });
    }

    Plotly.newPlot(el, traces, {
      paper_bgcolor: 'transparent',
      plot_bgcolor:  'transparent',
      margin: { t: 8, r: 16, b: 48, l: 64 },
      font:   { color: '#8892b0', size: 11 },
      xaxis:  { title: "Z' (Ω)", color: '#8892b0', gridcolor: '#2d3147', zeroline: false },
      yaxis:  { title: "-Z'' (Ω)", color: '#8892b0', gridcolor: '#2d3147', zeroline: false, scaleanchor: 'x', scaleratio: 1 },
      legend: { x: 0.7, y: 0.95, font: { size: 10 } },
      showlegend: true,
    }, { displayModeBar: false, responsive: true });
  }

  return {
    async onEnter() {
      render();
      document.addEventListener('keydown', onKeyDown);

      // Auto-populate freq range inputs from the first file when no range is saved in state.
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
    },
    onLeave() {
      document.removeEventListener('keydown', onKeyDown);
    },
  };
}
