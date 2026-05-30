import { getState, setState } from '../state.js';
import { streamDRT } from '../api.js';

const PEAK_COLORS = [
  '#e05c5c', '#4a9ade', '#e67e22', '#27ae60',
  '#9b59b6', '#1abc9c', '#f1c40f', '#e91e63',
];

// ── Mechanism buckets ────────────────────────────────────────────
// Each peak is assigned to one of three τ-based categories.
const MECHANISMS = [
  { key: 'fast', label: 'R₀',             desc: 'τ < 5 ms',         tauMax: 5e-3,     color: '#e05c5c' },
  { key: 'sei',  label: 'SEI',            desc: '5 ms – 100 ms',    tauMax: 0.1,      color: '#e67e22' },
  { key: 'mid',  label: 'Charge Transfer',desc: '100 ms – 1 s',     tauMax: 1.0,      color: '#4a9ade' },
  { key: 'slow', label: 'Diffusion',      desc: 'τ > 1 s',          tauMax: Infinity, color: '#27ae60' },
];

// Y-axis category strings, ordered bottom→top for Plotly
const MECH_CATEGORIES = MECHANISMS.map(m => `${m.label}  ·  ${m.desc}`);

function categorizePeak(peak) {
  return MECHANISMS.find(m => peak.tau_center < m.tauMax) ?? MECHANISMS[MECHANISMS.length - 1];
}

// ── Peak clustering (used within buckets) ────────────────────────
function clusterPeaks(peaks) {
  if (!peaks.length) return [];
  const sorted = [...peaks].sort((a, b) => a.log_tau_center - b.log_tau_center);
  const clusters = [];
  let current = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].log_tau_center - current[current.length - 1].log_tau_center <= 1.0) {
      current.push(sorted[i]);
    } else { clusters.push(current); current = [sorted[i]]; }
  }
  clusters.push(current);
  return clusters;
}

// ── Circuit suggestion ───────────────────────────────────────────
function suggestCircuit(allPeaks) {
  if (!allPeaks.length) return null;

  const hasSEI  = allPeaks.some(p => categorizePeak(p).key === 'sei');
  const hasCT   = allPeaks.some(p => categorizePeak(p).key === 'mid');
  const hasDiff = allPeaks.some(p => categorizePeak(p).key === 'slow');

  let rIdx = 1, cpeIdx = 0, woIdx = 0;
  const parts = ['R0'];
  if (hasSEI)  parts.push(`p(R${rIdx++},CPE${cpeIdx++})`);
  if (hasCT)   parts.push(`p(R${rIdx++},CPE${cpeIdx++})`);
  if (hasDiff) parts.push(`Wo${woIdx++}`);

  return parts.join('-');
}

// ── Formatting ──────────────────────────────────────────────────
function fmtTau(tau) {
  if (tau == null) return '—';
  if (tau < 1e-6)  return `${(tau * 1e9).toFixed(1)} ns`;
  if (tau < 1e-3)  return `${(tau * 1e6).toFixed(1)} µs`;
  if (tau < 1)     return `${(tau * 1e3).toFixed(1)} ms`;
  return `${tau.toFixed(3)} s`;
}

// ════════════════════════════════════════════════════════════════
export function DRTView(container, { navigate, showToast }) {

  // ── Main render ───────────────────────────────────────────────
  function render() {
    const state  = getState();
    const ready  = !!(state.files?.length && state.columnMap);
    const results = state.drtResults || [];

    container.innerHTML = `
      <div class="section-header">DRT</div>
      <div class="section-sub">
        Distribution of Relaxation Times &nbsp;·&nbsp; model-free process identification
        &nbsp;·&nbsp; ${state.files?.length ?? 0} file(s)
      </div>

      <div class="fitting-status" id="drt-status" style="display:none;">
        <div class="progress-label" id="drt-progress-label">Starting…</div>
        <div class="progress-bar-wrap"><div class="progress-bar-fill" id="drt-progress-bar"></div></div>
      </div>

      <div class="step-actions" style="margin-bottom:20px;">
        <button class="btn btn-secondary" id="back-btn">← Back</button>
        <div class="spacer"></div>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted);">
          Regularisation λ
          <input id="drt-lambda" type="number" min="1e-7" max="10" step="any"
                 value="${state.drtLambda ?? 1e-3}"
                 style="width:88px;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:13px;text-align:right;">
        </label>
        <button class="btn btn-primary" id="run-drt-btn" ${!ready ? 'disabled' : ''}>▶ Run DRT</button>
        <button class="btn btn-secondary" id="next-btn">Build Circuit →</button>
      </div>

      <div id="drt-table-wrap" style="${results.length ? '' : 'display:none;'}">
        ${buildTable(results)}
      </div>

      <div id="drt-explorer-wrap" style="${results.length ? 'margin-top:32px;' : 'display:none;'}">
        ${buildExplorer(results)}
      </div>

      <div id="drt-grid-wrap" style="overflow-y:auto;max-height:60vh;padding-right:4px;margin-top:${results.length ? '32px' : '0'};">
        <div class="nyquist-grid" id="drt-grid">
          ${results.map(r => buildCard(r)).join('')}
        </div>
      </div>
    `;

    container.querySelector('#back-btn').addEventListener('click', () => navigate(2));
    container.querySelector('#next-btn').addEventListener('click', () => navigate(4));
    container.querySelector('#run-drt-btn').addEventListener('click', runDRT);
    wireExplorer(results);
  }

  // ── Peak Explorer section ─────────────────────────────────────
  function buildExplorer(results) {
    const successful = results.filter(r => r.success && r.peaks?.length);
    if (!successful.length) return '';

    const state = getState();
    const allChar = successful[0].characterization || {};
    const batteryIds = [...new Set(successful.map(r => r.characterization?.battery_id).filter(v => v != null))].sort();
    const identifiers = Object.keys(allChar).filter(k => k !== 'battery_id');

    if (!batteryIds.length || !identifiers.length) return '';

    const selBattery    = state.drtExpBattery    ?? batteryIds[0];
    const selIdentifier = state.drtExpIdentifier ?? identifiers[0];

    const batteryOpts = batteryIds.map(id =>
      `<option value="${id}" ${id == selBattery ? 'selected' : ''}>Battery ${id}</option>`
    ).join('');
    const identOpts = identifiers.map(id =>
      `<option value="${id}" ${id === selIdentifier ? 'selected' : ''}>${id}</option>`
    ).join('');

    return `
      <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px;">
        Peak Explorer
      </div>
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:14px;">
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted);">
          Battery
          <select id="exp-battery" style="padding:4px 8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:13px;">
            ${batteryOpts}
          </select>
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted);">
          X-axis
          <select id="exp-identifier" style="padding:4px 8px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:13px;">
            ${identOpts}
          </select>
        </label>
      </div>
      <div id="exp-chart" style="height:350px;"></div>
      <div id="exp-circuit" style="margin-top:12px;"></div>
    `;
  }

  function wireExplorer(results) {
    const batteryEl    = container.querySelector('#exp-battery');
    const identifierEl = container.querySelector('#exp-identifier');
    if (!batteryEl || !identifierEl) return;

    const state = getState();
    plotExplorer(results, state.drtExpBattery ?? batteryEl.value, state.drtExpIdentifier ?? identifierEl.value);

    batteryEl.addEventListener('change', () => {
      setState({ drtExpBattery: batteryEl.value });
      plotExplorer(results, batteryEl.value, identifierEl.value);
    });
    identifierEl.addEventListener('change', () => {
      setState({ drtExpIdentifier: identifierEl.value });
      plotExplorer(results, batteryEl.value, identifierEl.value);
    });
  }

  function plotExplorer(results, batteryId, identifier) {
    const el = container.querySelector('#exp-chart');
    const circuitEl = container.querySelector('#exp-circuit');
    if (!el || typeof Plotly === 'undefined') return;

    const filtered = results.filter(r =>
      r.success && r.peaks?.length &&
      String(r.characterization?.battery_id) === String(batteryId)
    );

    if (!filtered.length) {
      Plotly.purge(el);
      el.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:20px;">No peaks for this battery.</div>';
      if (circuitEl) circuitEl.innerHTML = '';
      return;
    }

    // Collect all peaks with their mechanism category and identifier value
    const allPeaks = [];
    filtered.forEach(r => {
      const xVal = r.characterization?.[identifier];
      if (xVal == null) return;
      (r.peaks || []).forEach(p => {
        const mech = categorizePeak(p);
        allPeaks.push({ ...p, xVal, filename: r.filename, mech });
      });
    });

    if (!allPeaks.length) {
      Plotly.purge(el);
      if (circuitEl) circuitEl.innerHTML = '';
      return;
    }

    // Normalise amplitude → marker size [12, 32]
    const maxAmp = Math.max(...allPeaks.map(p => p.amplitude));
    const bubbleSize = p => 12 + 20 * (p.amplitude / (maxAmp + 1e-30));

    // One trace per mechanism (controls legend colour + category label)
    const traces = MECHANISMS.map(mech => {
      const pts = allPeaks.filter(p => p.mech.key === mech.key);
      return {
        name: `${mech.label}  ·  ${mech.desc}`,
        type: 'scatter',
        mode: 'markers',
        x: pts.map(p => p.xVal),
        y: pts.map(() => `${mech.label}  ·  ${mech.desc}`),
        marker: {
          color: mech.color,
          size:  pts.map(p => bubbleSize(p)),
          opacity: pts.map(p => 0.3 + 0.7 * p.r2),
          line: { color: 'rgba(255,255,255,0.2)', width: 1 },
        },
        text: pts.map(p =>
          `${p.filename}<br>${identifier}: ${p.xVal}<br>` +
          `τ = ${fmtTau(p.tau_center)}<br>` +
          `R² = ${(p.r2 * 100).toFixed(0)}%  ·  σ = ${p.sigma.toFixed(2)}`
        ),
        hovertemplate: '%{text}<extra></extra>',
      };
    });

    const layout = {
      paper_bgcolor: 'transparent',
      plot_bgcolor:  'transparent',
      height: 280,
      margin: { t: 8, r: 12, b: 48, l: 170 },
      font:   { color: '#8892b0', size: 11 },
      xaxis: {
        title: identifier,
        color: '#8892b0', gridcolor: '#2d3147', zeroline: false,
      },
      yaxis: {
        type: 'category',
        categoryorder: 'array',
        categoryarray: MECH_CATEGORIES,   // bottom → top
        color: '#8892b0',
        gridcolor: '#2d3147',
        tickfont: { size: 12 },
      },
      legend: { bgcolor: 'transparent', font: { size: 11 }, orientation: 'h', y: -0.22 },
      showlegend: false,   // Y-axis labels already act as the legend
    };

    Plotly.newPlot(el, traces, layout, { displayModeBar: false, responsive: true });

    // Circuit suggestion
    if (circuitEl) {
      const suggestion = suggestCircuit(allPeaks);
      if (suggestion) {
        circuitEl.innerHTML = `
          <span style="font-size:12px;color:var(--text-muted);margin-right:8px;">Suggested circuit:</span>
          <code style="background:var(--surface2);padding:4px 10px;border-radius:4px;font-size:13px;
                       color:var(--accent);cursor:pointer;user-select:all;"
                title="Click to copy"
                id="exp-circuit-code">${suggestion}</code>`;
        circuitEl.querySelector('#exp-circuit-code').addEventListener('click', () => {
          navigator.clipboard?.writeText(suggestion).then(() => showToast('Circuit copied', 'info'));
        });
      } else {
        circuitEl.innerHTML = '';
      }
    }
  }

  // ── Streaming run ─────────────────────────────────────────────
  async function runDRT() {
    const state = getState();
    if (!state.files?.length || !state.columnMap) return;

    const lambda = parseFloat(container.querySelector('#drt-lambda').value);
    if (isNaN(lambda) || lambda <= 0) {
      showToast('λ must be a positive number.', 'error');
      return;
    }
    setState({ drtLambda: lambda });

    const runBtn        = container.querySelector('#run-drt-btn');
    const drtStatus     = container.querySelector('#drt-status');
    const progressBar   = container.querySelector('#drt-progress-bar');
    const progressLabel = container.querySelector('#drt-progress-label');
    const grid          = container.querySelector('#drt-grid');
    const tableWrap     = container.querySelector('#drt-table-wrap');
    const gridWrap      = container.querySelector('#drt-grid-wrap');
    const explorerWrap  = container.querySelector('#drt-explorer-wrap');

    runBtn.disabled = true;
    drtStatus.style.display = '';
    grid.innerHTML = '';
    tableWrap.style.display = 'none';
    tableWrap.innerHTML = '';
    if (explorerWrap) { explorerWrap.style.display = 'none'; explorerWrap.innerHTML = ''; }

    const results = [];
    setState({ drtResults: [] });

    try {
      const request = {
        files:      state.files,
        column_map: state.columnMap,
        lambda_reg: lambda,
      };

      for await (const event of streamDRT(request)) {
        if (event.event === 'progress') {
          const pct = Math.round((event.index / event.total) * 100);
          progressBar.style.width = `${pct}%`;
          progressLabel.textContent = `Computing DRT for ${event.file} (${event.index + 1} / ${event.total})`;
        } else if (event.event === 'result') {
          const result = event.data;
          results.push(result);

          const tableHtml = buildTable(results);
          if (tableHtml) {
            tableWrap.innerHTML = tableHtml;
            tableWrap.style.display = '';
            gridWrap.style.marginTop = '32px';
          }

          const explorerHtml = buildExplorer(results);
          if (explorerHtml && explorerWrap) {
            explorerWrap.innerHTML = explorerHtml;
            explorerWrap.style.display = 'block';
            explorerWrap.style.marginTop = '32px';
            wireExplorer(results);
          }

          grid.insertAdjacentHTML('beforeend', buildCard(result));
          plotDRT(result);
          setState({ drtResults: [...results] });
        } else if (event.event === 'done') {
          progressBar.style.width = '100%';
          progressLabel.textContent = `Done — ${results.filter(r => r.success).length}/${results.length} successful`;
        }
      }
    } catch (err) {
      showToast(`DRT error: ${err.message}`, 'error');
    } finally {
      runBtn.disabled = false;
      setState({ drtResults: results });
    }
  }

  // ── Table ─────────────────────────────────────────────────────
  function buildTable(results) {
    if (!results.length) return '';
    const maxPeaks = Math.max(...results.map(r => (r.peaks || []).length));
    if (maxPeaks === 0) return '';

    const charLabels = Object.keys(results[0].characterization || {});

    const peakHeaders = Array.from({ length: maxPeaks }, (_, i) =>
      `<th style="color:${PEAK_COLORS[i % PEAK_COLORS.length]}">τ${i + 1}</th>
       <th style="color:${PEAK_COLORS[i % PEAK_COLORS.length]};opacity:0.7;">R²</th>`
    ).join('');

    const rows = results.map(r => {
      const charCells = charLabels.map(l => {
        const v = r.characterization?.[l];
        return `<td>${typeof v === 'number' ? v.toPrecision(4) : (v ?? '—')}</td>`;
      }).join('');

      const peakCells = Array.from({ length: maxPeaks }, (_, i) => {
        const p = (r.peaks || [])[i];
        const color = PEAK_COLORS[i % PEAK_COLORS.length];
        if (!p) return `<td style="color:var(--text-muted)">—</td><td style="color:var(--text-muted)">—</td>`;
        const r2color = p.r2 >= 0.9 ? 'var(--success)' : p.r2 >= 0.7 ? 'var(--warning)' : 'var(--danger)';
        return `<td style="color:${color};font-weight:500;">${fmtTau(p.tau_center)}</td>
                <td style="color:${r2color};font-weight:500;">${(p.r2 * 100).toFixed(0)}%</td>`;
      }).join('');

      const statusCell = r.success ? '' :
        `<td colspan="${charLabels.length + maxPeaks * 2}" style="color:var(--danger);font-size:11px;">${r.error || 'FAILED'}</td>`;

      return `<tr>
        <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
            title="${r.filename}">${r.filename}</td>
        ${r.success ? charCells + peakCells : statusCell}
      </tr>`;
    }).join('');

    return `
      <div style="font-size:12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">
        Peak Summary
      </div>
      <div style="overflow-x:auto;overflow-y:auto;max-height:420px;">
        <table class="drt-table">
          <thead>
            <tr>
              <th>File</th>
              ${charLabels.map(l => `<th>${l}</th>`).join('')}
              ${peakHeaders}
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  // ── Individual DRT plot card ───────────────────────────────────
  function buildCard(result) {
    const safeId    = result.filename.replace(/[^a-zA-Z0-9]/g, '_');
    const qualClass = result.success ? 'good' : 'poor';

    const charStr = Object.entries(result.characterization || {})
      .map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toPrecision(4) : v}`)
      .join(' · ');

    const peakStr = (result.peaks || [])
      .map((p, i) => {
        const color  = PEAK_COLORS[i % PEAK_COLORS.length];
        const r2color = p.r2 >= 0.9 ? 'var(--success)' : p.r2 >= 0.7 ? 'var(--warning)' : 'var(--danger)';
        return `<span style="color:${color}">τ${i + 1}=${fmtTau(p.tau_center)}</span>`
             + `<span style="color:${r2color};font-size:10px;margin-left:2px;">${(p.r2 * 100).toFixed(0)}%</span>`;
      })
      .join(' &nbsp; ');

    return `
      <div class="nyquist-card ${qualClass}" data-filename="${result.filename}">
        <div class="nyquist-card-title">
          <span title="${result.filename}">${result.filename}</span>
          <span class="residual-badge ${qualClass}">${result.success ? `${(result.peaks || []).length} peak(s)` : 'FAILED'}</span>
        </div>
        ${charStr ? `<div style="padding:4px 12px;font-size:11px;color:var(--text-muted);">${charStr}</div>` : ''}
        ${result.error ? `<div style="padding:8px 12px;font-size:12px;color:var(--danger);">${result.error}</div>` : ''}
        <div class="nyquist-plot" id="drt-${safeId}"></div>
        ${peakStr ? `<div class="params-summary">${peakStr}</div>` : ''}
      </div>`;
  }

  function plotDRT(result) {
    if (!result.success) return;
    const safeId = result.filename.replace(/[^a-zA-Z0-9]/g, '_');
    const el = container.querySelector(`#drt-${safeId}`);
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
      margin: { t: 4, r: 8, b: 36, l: 48 },
      font:   { color: '#8892b0', size: 10 },
      xaxis:  { title: 'log₁₀(τ / s)', color: '#8892b0', gridcolor: '#2d3147', zeroline: false },
      yaxis:  { title: 'γ(τ)',          color: '#8892b0', gridcolor: '#2d3147', zeroline: false },
      legend: { x: 0.7, y: 0.95, font: { size: 10 } },
      showlegend: traces.length > 1,
      shapes: (result.peaks || []).map((p, i) => ({
        type: 'line', x0: p.log_tau_center, x1: p.log_tau_center, y0: 0, y1: 1,
        xref: 'x', yref: 'paper',
        line: { color: PEAK_COLORS[i % PEAK_COLORS.length], width: 1, dash: 'dot' },
      })),
    }, { displayModeBar: false, responsive: true });
  }

  function replotAll() {
    const state = getState();
    (state.drtResults || []).forEach(r => plotDRT(r));
    const results = state.drtResults || [];
    const batteryEl    = container.querySelector('#exp-battery');
    const identifierEl = container.querySelector('#exp-identifier');
    if (batteryEl && identifierEl) {
      plotExplorer(results, batteryEl.value, identifierEl.value);
    }
  }

  return {
    onEnter() {
      render();
      requestAnimationFrame(() => requestAnimationFrame(replotAll));
    },
  };
}
