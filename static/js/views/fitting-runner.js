import { getState, setState } from '../state.js';
import { streamFitting } from '../api.js';

const GOOD_THRESHOLD = 0.05;  // residual < 5% → good fit badge

export function FittingRunnerView(container, { navigate, showToast }) {

  function render() {
    const state = getState();
    const ready = state.files?.length && state.columnMap && state.circuitConfig;

    container.innerHTML = `
      <div class="section-header">Fit</div>
      <div class="section-sub">
        Circuit: <code style="color:var(--accent)">${state.circuitString || '—'}</code>
        &nbsp;·&nbsp; ${state.files?.length ?? 0} file(s)
      </div>

      <div class="fitting-status" id="fit-status" style="display:none;">
        <div class="progress-label" id="progress-label">Starting…</div>
        <div class="progress-bar-wrap"><div class="progress-bar-fill" id="progress-bar"></div></div>
      </div>

      <div class="step-actions" style="margin-bottom:20px;">
        <button class="btn btn-secondary" id="back-btn">← Back</button>
        <div class="spacer"></div>
        <button class="btn btn-primary" id="run-btn" ${!ready ? 'disabled' : ''}>▶ Run Fitting</button>
        <button class="btn btn-secondary" id="next-btn" ${!state.fitResults?.length ? 'disabled' : ''}>View Trends →</button>
      </div>

      <div class="nyquist-grid" id="nyquist-grid">
        ${(state.fitResults || []).map(r => buildCard(r)).join('')}
      </div>
    `;

    container.querySelector('#back-btn').addEventListener('click', () => navigate(4));
    container.querySelector('#next-btn').addEventListener('click', () => navigate(6));
    container.querySelector('#run-btn').addEventListener('click', runFitting);
  }

  async function runFitting() {
    const state = getState();
    if (!state.files?.length || !state.columnMap || !state.circuitConfig) return;

    const runBtn  = container.querySelector('#run-btn');
    const nextBtn = container.querySelector('#next-btn');
    const fitStatus = container.querySelector('#fit-status');
    const progressBar = container.querySelector('#progress-bar');
    const progressLabel = container.querySelector('#progress-label');
    const grid = container.querySelector('#nyquist-grid');

    runBtn.disabled = true;
    fitStatus.style.display = '';
    grid.innerHTML = '';

    const results = [];

    try {
      const request = {
        files:          state.files,
        column_map:     state.columnMap,
        circuit_config: state.circuitConfig,
      };

      for await (const event of streamFitting(request)) {
        if (event.event === 'progress') {
          const pct = Math.round((event.index / event.total) * 100);
          progressBar.style.width = `${pct}%`;
          progressLabel.textContent = `Fitting ${event.file} (${event.index + 1} / ${event.total})`;
        } else if (event.event === 'result') {
          const result = event.data;
          results.push(result);
          grid.insertAdjacentHTML('beforeend', buildCard(result));
          plotNyquist(result);
        } else if (event.event === 'done') {
          progressBar.style.width = '100%';
          const ok = results.filter(r => r.success).length;
          progressLabel.textContent = `Done — ${ok}/${results.length} successful`;
        }
      }
    } catch (err) {
      showToast(`Fitting error: ${err.message}`, 'error');
    } finally {
      runBtn.disabled   = false;
      nextBtn.disabled  = !results.length;
      setState({ fitResults: results, maxStep: Math.max(state.maxStep, 6) });
    }
  }

  function buildCard(result) {
    const good = result.success && result.residual != null && result.residual < GOOD_THRESHOLD;
    const poor = !result.success || (result.residual != null && result.residual >= GOOD_THRESHOLD);
    const qualClass = result.success ? (good ? 'good' : 'poor') : 'poor';
    const residualPct = result.residual != null ? (result.residual * 100).toFixed(2) : '—';

    const charStr = Object.entries(result.characterization || {})
      .map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toPrecision(4) : v}`)
      .join(' · ');

    const paramStr = Object.entries(result.parameters || {})
      .map(([k, v]) => `<span>${k}</span>${typeof v === 'number' ? v.toExponential(3) : v}`)
      .join(' &nbsp; ');

    const safeId = result.filename.replace(/[^a-zA-Z0-9]/g, '_');

    return `
      <div class="nyquist-card ${qualClass}" data-filename="${result.filename}">
        <div class="nyquist-card-title">
          <span title="${result.filename}">${result.filename}</span>
          <span class="residual-badge ${qualClass}">${result.success ? `${residualPct}%` : 'FAILED'}</span>
        </div>
        ${charStr ? `<div style="padding:4px 12px; font-size:11px; color:var(--text-muted);">${charStr}</div>` : ''}
        ${result.error ? `<div style="padding:8px 12px; font-size:12px; color:var(--danger);">${result.error}</div>` : ''}
        <div class="nyquist-plot" id="nyq-${safeId}"></div>
        ${paramStr ? `<div class="params-summary">${paramStr}</div>` : ''}
      </div>
    `;
  }

  function plotNyquist(result) {
    const safeId = result.filename.replace(/[^a-zA-Z0-9]/g, '_');
    const el = container.querySelector(`#nyq-${safeId}`);
    if (!el || typeof Plotly === 'undefined') return;

    const traces = [];

    if (result.z_real_data?.length) {
      traces.push({
        x: result.z_real_data,
        y: result.z_imag_data.map(v => -v),
        mode: 'markers',
        type: 'scatter',
        name: 'Data',
        marker: { color: '#8892b0', size: 5 },
      });
    }

    if (result.success && result.z_real_fit?.length) {
      traces.push({
        x: result.z_real_fit,
        y: result.z_imag_fit.map(v => -v),
        mode: 'lines',
        type: 'scatter',
        name: 'Fit',
        line: { color: 'var(--accent)', width: 2 },
      });
    }

    const layout = {
      paper_bgcolor: 'transparent',
      plot_bgcolor:  'transparent',
      margin: { t: 4, r: 8, b: 36, l: 48 },
      font:   { color: '#8892b0', size: 10 },
      xaxis:  { title: "Z' (Ω)", color: '#8892b0', gridcolor: '#2d3147', zeroline: false },
      yaxis:  { title: "-Z'' (Ω)", color: '#8892b0', gridcolor: '#2d3147', zeroline: false, scaleanchor: 'x', scaleratio: 1 },
      legend: { x: 0.7, y: 0.95, font: { size: 10 } },
      showlegend: true,
    };

    Plotly.newPlot(el, traces, layout, { displayModeBar: false, responsive: true });
  }

  // Replot all existing results on enter (Plotly may not be ready on first load)
  function replotAll() {
    const state = getState();
    (state.fitResults || []).forEach(r => plotNyquist(r));
  }

  return {
    onEnter() {
      render();
      setTimeout(replotAll, 100); // slight delay until Plotly CDN is ready
    }
  };
}
