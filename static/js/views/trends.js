import { getState } from '../state.js';

export function TrendsView(container, { navigate, showToast }) {

  function render() {
    const state = getState();
    const results = (state.fitResults || []).filter(r => r.success);

    if (!results.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📈</div>
          <div>Run fitting first to see parameter trends.</div>
          <button class="btn btn-secondary" style="margin-top:12px;" id="back-btn">← Back to Fitting</button>
        </div>`;
      container.querySelector('#back-btn')?.addEventListener('click', () => navigate(5));
      return;
    }

    // Collect all parameter names and characterization labels
    const paramNames = Object.keys(results[0].parameters);
    const charLabels = Object.keys(results[0].characterization || {});

    const xOptions = charLabels.length
      ? charLabels
      : ['File index'];

    const state2 = getState();
    const savedX = state2._trendsX || xOptions[0];
    const savedY = state2._trendsY || paramNames.slice(0, Math.min(paramNames.length, 4));
    const savedGroup = state2._trendsGroup || '';

    container.innerHTML = `
      <div class="section-header">Trends</div>
      <div class="section-sub">Parameter values extracted from ${results.length} successful fit(s) across characterization variables.</div>

      <div class="trends-controls">
        <div class="col" style="flex:0 0 180px;">
          <label>X axis (characterization)</label>
          <select id="x-axis">
            ${xOptions.map(o => `<option value="${o}" ${o === savedX ? 'selected' : ''}>${o}</option>`).join('')}
          </select>
        </div>
        <div class="col" style="flex:0 0 180px;">
          <label>Group by (color)</label>
          <select id="group-by">
            <option value="">— none —</option>
            ${charLabels.filter(l => l !== savedX).map(o => `<option value="${o}" ${o === savedGroup ? 'selected' : ''}>${o}</option>`).join('')}
          </select>
        </div>
        <div class="col">
          <label>Parameters to plot (hold Ctrl to multi-select)</label>
          <select id="y-params" multiple size="${Math.min(paramNames.length, 5)}" style="min-width:200px;">
            ${paramNames.map(p => `<option value="${p}" ${savedY.includes(p) ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </div>
        <button class="btn btn-primary" id="update-btn" style="align-self:flex-end;">Update Plots</button>
      </div>

      <div class="export-btn-row">
        <button class="btn btn-secondary btn-sm" id="export-btn">⬇ Export CSV</button>
      </div>

      <div class="trend-plots-grid" id="trend-plots-grid"></div>

      <div class="step-actions" style="margin-top:20px;">
        <button class="btn btn-secondary" id="back-btn">← Back to Fitting</button>
      </div>
    `;

    const updateBtn  = container.querySelector('#update-btn');
    const exportBtn  = container.querySelector('#export-btn');
    const backBtn    = container.querySelector('#back-btn');

    updateBtn.addEventListener('click', updatePlots);
    exportBtn.addEventListener('click', exportCSV);
    backBtn.addEventListener('click', () => navigate(5));

    updatePlots();

    function getSelections() {
      const xAxis  = container.querySelector('#x-axis').value;
      const groupBy = container.querySelector('#group-by').value;
      const yParams = [...container.querySelector('#y-params').selectedOptions].map(o => o.value);
      return { xAxis, groupBy, yParams };
    }

    function updatePlots() {
      const { xAxis, groupBy, yParams } = getSelections();
      if (!yParams.length) { showToast('Select at least one parameter.', 'error'); return; }

      const grid = container.querySelector('#trend-plots-grid');
      grid.innerHTML = '';

      for (const param of yParams) {
        grid.insertAdjacentHTML('beforeend', `
          <div class="trend-plot-card">
            <div class="trend-plot-title">${param}</div>
            <div class="trend-plot" id="trend-${param.replace(/[^a-zA-Z0-9]/g, '_')}"></div>
          </div>
        `);
      }

      // Slight delay to let DOM settle before Plotly
      setTimeout(() => {
        for (const param of yParams) {
          plotTrend(param, xAxis, groupBy);
        }
      }, 50);
    }

    function plotTrend(param, xAxis, groupBy) {
      const safeId = param.replace(/[^a-zA-Z0-9]/g, '_');
      const el = container.querySelector(`#trend-${safeId}`);
      if (!el || typeof Plotly === 'undefined') return;

      // Group results by groupBy value
      const groups = {};
      for (const r of results) {
        const xVal = xAxis === 'File index'
          ? results.indexOf(r)
          : r.characterization?.[xAxis];
        const yVal = r.parameters?.[param];
        const yErr = r.confidence?.[param];
        if (xVal == null || yVal == null) continue;

        const groupKey = groupBy && r.characterization?.[groupBy] != null
          ? `${groupBy}=${r.characterization[groupBy].toPrecision(4)}`
          : 'all';

        if (!groups[groupKey]) groups[groupKey] = { x: [], y: [], e: [], label: groupKey };
        groups[groupKey].x.push(xVal);
        groups[groupKey].y.push(yVal);
        groups[groupKey].e.push(yErr ?? 0);
      }

      const PALETTE = ['#4ecdc4', '#e05c5c', '#4a9ade', '#e67e22', '#9b59b6', '#27ae60', '#f0a500'];
      const traces = Object.values(groups).map((g, i) => ({
        x: g.x,
        y: g.y,
        error_y: g.e.some(v => v > 0) ? { type: 'data', array: g.e, visible: true, color: PALETTE[i % PALETTE.length], thickness: 1.5, width: 4 } : undefined,
        mode: 'markers+lines',
        type: 'scatter',
        name: g.label === 'all' ? param : g.label,
        marker: { color: PALETTE[i % PALETTE.length], size: 7 },
        line:   { color: PALETTE[i % PALETTE.length], width: 1.5, dash: 'dot' },
      }));

      if (!traces.length) { el.innerHTML = '<div style="padding:20px;color:var(--text-dim);text-align:center;">No data</div>'; return; }

      const layout = {
        paper_bgcolor: 'transparent',
        plot_bgcolor:  'transparent',
        margin: { t: 4, r: 10, b: 40, l: 56 },
        font:   { color: '#8892b0', size: 10 },
        xaxis:  { title: xAxis, color: '#8892b0', gridcolor: '#2d3147', zeroline: false },
        yaxis:  { title: param, color: '#8892b0', gridcolor: '#2d3147', zeroline: false },
        legend: { x: 0.02, y: 0.98, font: { size: 9 } },
        showlegend: Object.keys(groups).length > 1,
      };

      Plotly.newPlot(el, traces, layout, { displayModeBar: false, responsive: true });
    }

    function exportCSV() {
      const allParams = paramNames;
      const allChar   = charLabels;
      const header = ['filename', ...allChar, ...allParams].join(',');
      const rows = results.map(r => {
        const charVals  = allChar.map(l  => r.characterization?.[l] ?? '');
        const paramVals = allParams.map(p => r.parameters?.[p] ?? '');
        return [r.filename, ...charVals, ...paramVals].join(',');
      });
      const csv  = [header, ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = 'eis_results.csv';
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  return { onEnter: render };
}
