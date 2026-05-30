import { getState, setState } from '../state.js';

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

    // battery_id is always the color grouping — never an x-axis option
    const xOptions = charLabels.filter(l => l !== 'battery_id').length
      ? charLabels.filter(l => l !== 'battery_id')
      : ['File index'];

    const state2 = getState();
    const savedX       = state2._trendsX || xOptions[0];
    const savedY       = state2._trendsY || paramNames.slice(0, Math.min(paramNames.length, 4));
    const charUnits    = state2.charUnits || {};
    const savedBoxMode = state2._trendsBoxMode !== false; // default true

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
        <div class="col">
          <label>Parameters to plot (hold Ctrl to multi-select)</label>
          <select id="y-params" multiple size="${Math.min(paramNames.length, 5)}" style="min-width:200px;">
            ${paramNames.map(p => `<option value="${p}" ${savedY.includes(p) ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </div>
        <div class="col" style="flex:0 0 auto;align-self:flex-end;">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-muted);cursor:pointer;">
            <input type="checkbox" id="box-mode-toggle" ${savedBoxMode ? 'checked' : ''}
                   style="width:15px;height:15px;cursor:pointer;accent-color:var(--accent);">
            Box &amp; whisker
          </label>
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
      const xAxis   = container.querySelector('#x-axis').value;
      const groupBy = 'battery_id';
      const yParams = [...container.querySelector('#y-params').selectedOptions].map(o => o.value);
      const boxMode = container.querySelector('#box-mode-toggle').checked;
      return { xAxis, groupBy, yParams, boxMode };
    }

    function updatePlots() {
      const { xAxis, groupBy, yParams, boxMode } = getSelections();
      if (!yParams.length) { showToast('Select at least one parameter.', 'error'); return; }

      setState({ _trendsBoxMode: boxMode });

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

      setTimeout(() => {
        for (const param of yParams) {
          plotTrend(param, xAxis, groupBy, charUnits, boxMode);
        }
      }, 50);
    }

    function paramInfo(name) {
      if (/^R\d/.test(name))           return { scale: 1000, unit: 'mΩ' };
      if (/^C\d/.test(name))           return { scale: 1,    unit: 'F' };
      if (/^L\d/.test(name))           return { scale: 1,    unit: 'H' };
      if (/^CPE\d+_0/.test(name))      return { scale: 1,    unit: 'Ω⁻¹·sⁿ' };
      if (/^CPE\d+_1/.test(name))      return { scale: 1,    unit: '-' };
      if (/^W\d+(_0)?$/.test(name))    return { scale: 1,    unit: 'Ω·s½' };
      if (/^Wo\d+_0/.test(name))       return { scale: 1000, unit: 'mΩ' };
      if (/^Wo\d+_1/.test(name))       return { scale: 1,    unit: 's' };
      if (/^Wo\d+_2/.test(name))       return { scale: 1,    unit: '-' };
      if (/^Ws\d+_0/.test(name))       return { scale: 1000, unit: 'mΩ' };
      if (/^Ws\d+_1/.test(name))       return { scale: 1,    unit: 's' };
      if (/^Ws\d+_2/.test(name))       return { scale: 1,    unit: '-' };
      if (/^La\d+_0/.test(name))       return { scale: 1,    unit: 'H' };
      if (/^La\d+_1/.test(name))       return { scale: 1000, unit: 'mΩ' };
      return                                   { scale: 1,    unit: '' };
    }

    function defaultXUnit(label) {
      const l = (label || '').toLowerCase();
      if (/temp/.test(l))                     return '°C';
      if (/\bsoc\b|state.of.charge/.test(l))  return '%';
      if (/volt|_v$/.test(l))                 return 'V';
      return '';
    }

    function hexToRgba(hex, alpha) {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${alpha})`;
    }

    function plotTrend(param, xAxis, groupBy, charUnits = {}, boxMode = true) {
      const safeId = param.replace(/[^a-zA-Z0-9]/g, '_');
      const el = container.querySelector(`#trend-${safeId}`);
      if (!el || typeof Plotly === 'undefined') return;
      el.style.height = '350px';

      const { scale: yScale, unit: yUnit } = paramInfo(param);
      const yLabel = yUnit ? `${param} (${yUnit})` : param;

      // groups[groupKey][xNum] = [y1, y2, ...]
      const groups = {};
      for (const r of results) {
        const xRaw = xAxis === 'File index' ? results.indexOf(r) : r.characterization?.[xAxis];
        const yRaw = r.parameters?.[param];
        const yVal = yRaw != null ? yRaw * yScale : null;
        if (xRaw == null || yVal == null) continue;

        const groupKey = groupBy && r.characterization?.[groupBy] != null
          ? String(r.characterization[groupBy])
          : 'all';

        const xNum = Number(xRaw);
        if (!groups[groupKey]) groups[groupKey] = {};
        if (!groups[groupKey][xNum]) groups[groupKey][xNum] = [];
        groups[groupKey][xNum].push(yVal);
      }

      const groupKeys = Object.keys(groups).sort();
      if (!groupKeys.length) {
        el.innerHTML = '<div style="padding:20px;color:var(--text-dim);text-align:center;">No data</div>';
        return;
      }

      const PALETTE = ['#4ecdc4', '#e05c5c', '#4a9ade', '#e67e22', '#9b59b6', '#27ae60', '#f0a500'];

      // Use box traces only when toggled on AND data actually has spread
      const hasSpread = groupKeys.some(k => Object.values(groups[k]).some(ys => ys.length > 1));
      const useBox = boxMode && hasSpread;

      const traces = [];
      for (let i = 0; i < groupKeys.length; i++) {
        const key = groupKeys[i];
        const color = PALETTE[i % PALETTE.length];
        const xBins = groups[key];
        const sortedX = Object.keys(xBins).map(Number).sort((a, b) => a - b);
        const name = key === 'all' ? param : `cell ${key}`;

        if (useBox) {
          // Flatten to per-point arrays for Plotly box grouping
          const boxX = [], boxY = [];
          for (const x of sortedX) {
            for (const y of xBins[x]) { boxX.push(x); boxY.push(y); }
          }
          traces.push({
            x: boxX, y: boxY,
            type: 'box',
            name,
            marker:    { color, opacity: 0.8 },
            line:      { color },
            fillcolor: hexToRgba(color, 0.15),
            boxmean:   true,
            legendgroup: key,
            showlegend:  true,
          });
        } else {
          traces.push({
            x: sortedX,
            y: sortedX.map(x => { const ys = xBins[x]; return ys.reduce((s,v) => s+v, 0) / ys.length; }),
            type: 'scatter',
            mode: 'markers+lines',
            name,
            marker: { color, size: 7 },
            line:   { color, width: 1.5, dash: '4px,4px', shape: 'spline', smoothing: 0.6 },
            legendgroup: key,
            showlegend:  true,
          });
        }

        // Dashed mean trend line — only needed in box mode; scatter mode already draws it
        if (useBox) {
          const meanX = sortedX;
          const meanY = sortedX.map(x => {
            const ys = xBins[x];
            return ys.reduce((s, v) => s + v, 0) / ys.length;
          });
          traces.push({
            x: meanX, y: meanY,
            type: 'scatter',
            mode: 'lines',
            name: `${name} mean`,
            line: { color, width: 1.5, dash: '4px,4px', shape: 'spline', smoothing: 0.6 },
            legendgroup: key,
            showlegend:  false,
          });
        }
      }

      const layout = {
        paper_bgcolor: 'transparent',
        plot_bgcolor:  'transparent',
        height: 350,
        margin: { t: 4, r: 10, b: 90, l: 56 },
        font:   { color: '#8892b0', size: 10 },
        xaxis:  { title: (() => { const u = charUnits[xAxis] || defaultXUnit(xAxis); return u ? `${xAxis} (${u})` : xAxis; })(),
                   color: '#8892b0', gridcolor: '#2d3147', zeroline: false },
        yaxis:  { title: yLabel, color: '#8892b0', gridcolor: '#2d3147', zeroline: false },
        legend: { orientation: 'h', x: 0.5, xanchor: 'center', y: -0.38, yanchor: 'top', font: { size: 9 } },
        showlegend: groupKeys.length > 1 || groupKeys[0] !== 'all',
        boxmode: 'group',
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
