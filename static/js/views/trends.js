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
      container.querySelector('#back-btn')?.addEventListener('click', () => navigate(6));
      return;
    }

    // Collect all parameter names and characterization labels.
    // Build a union from both fit results and the saved column mapping so
    // sparse fields (e.g. identifier present in only some files) still appear.
    const paramNames = Object.keys(results[0].parameters);
    const charLabelSet = new Set();

    function parseIdentifierFromText(text) {
      if (!text) return null;
      const s = String(text);

      // Common patterns: [...], _123 suffix, id123 / identifier_123
      let m = s.match(/\[(\d+)\]/);
      if (m) return Number(m[1]);
      m = s.match(/(?:^|[_-])(\d+)(?:\.[^.]+)?$/);
      if (m) return Number(m[1]);
      m = s.match(/(?:identifier|sample[_\s-]?id|test[_\s-]?id|\bid\b)[_\s-]*([A-Za-z0-9]+)/i);
      if (m) {
        const n = Number(m[1]);
        return Number.isFinite(n) ? n : m[1];
      }
      return null;
    }

    function getIdentifierValue(r) {
      const ch = r.characterization || {};
      const direct = ch.identifier ?? ch.Identifier;
      if (direct != null && String(direct).trim() !== '') return direct;

      for (const [k, v] of Object.entries(ch)) {
        if (/identifier|sample[_\s-]?id|test[_\s-]?id|\bid\b/i.test(k) && v != null && String(v).trim() !== '') {
          return v;
        }
      }

      const pathVal = parseIdentifierFromText(r.path || '');
      if (pathVal != null) return pathVal;

      return parseIdentifierFromText(r.filename || '');
    }

    function getCharValue(r, label) {
      if (label === 'File index') return null;
      if (label === 'identifier') return getIdentifierValue(r);

      const ch = r.characterization || {};
      if (ch[label] != null) return ch[label];

      // Case-insensitive fallback for label mismatches (e.g., Identifier vs identifier)
      const target = String(label).toLowerCase();
      for (const [k, v] of Object.entries(ch)) {
        if (String(k).toLowerCase() === target) return v;
      }
      return null;
    }

    results.forEach(r => {
      Object.keys(r.characterization || {}).forEach(k => {
        // Only include if explicitly mapped in column mapper, or if it's identifier/battery_id
        const inMapping = Object.keys(state.columnMap?.characterization || {}).includes(k);
        if (inMapping || k === 'identifier' || k === 'battery_id') {
          charLabelSet.add(k);
        }
      });
    });
    Object.keys(state.columnMap?.characterization || {}).forEach(k => charLabelSet.add(k));

    // Ensure identifier is available when it can be derived from any result.
    if (results.some(r => getIdentifierValue(r) != null)) {
      charLabelSet.add('identifier');
    }

    const charLabels = [...charLabelSet];

    const xOptions = charLabels.length ? charLabels : ['File index'];

    const state2 = getState();
    const savedX        = (state2._trendsX && xOptions.includes(state2._trendsX)) ? state2._trendsX : xOptions[0];
    const savedY        = state2._trendsY || paramNames.slice(0, Math.min(paramNames.length, 4));
    const charUnits     = state2.charUnits || {};

    // Map battery_id value → raw subfolder name for legend labels
    const batteryLabels = {};
    (state2.fitResults || []).forEach((r, i) => {
      const bid = r.characterization?.battery_id;
      if (bid != null && (state2.files || [])[i]) {
        const parts = (state2.files[i].path || '').replace(/\\/g, '/').split('/');
        const sub = parts.length >= 2 ? parts[parts.length - 2] : '';
        if (sub) batteryLabels[String(bid)] = sub;
      }
    });
    const savedBoxMode  = state2._trendsBoxMode !== false; // default true
    const savedConf     = state2._trendsConf    === true;  // default false
    const savedGroupBy  = (state2._trendsGroupBy && charLabels.includes(state2._trendsGroupBy))
      ? state2._trendsGroupBy
      : (charLabels.includes('battery_id') ? 'battery_id' : charLabels[0]);
    const savedSection  = state2._trendsSection  ?? 'none';

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
        <div class="col" style="flex:0 0 160px;">
          <label>Group by (line color)</label>
          <select id="group-by">
            ${charLabels.map(o => `<option value="${o}" ${o === savedGroupBy ? 'selected' : ''}>${o}</option>`).join('')}
          </select>
        </div>
        <div class="col" style="flex:0 0 160px;">
          <label>Section by</label>
          <select id="section-by">
            <option value="none" ${savedSection === 'none' ? 'selected' : ''}>None</option>
            ${charLabels.map(o => `<option value="${o}" ${o === savedSection ? 'selected' : ''}>${o}</option>`).join('')}
          </select>
        </div>
        <div class="col">
          <label>Parameters to plot (hold Ctrl to multi-select)</label>
          <select id="y-params" multiple size="${Math.min(paramNames.length, 5)}" style="min-width:200px;">
            ${paramNames.map(p => `<option value="${p}" ${savedY.includes(p) ? 'selected' : ''}>${p}</option>`).join('')}
          </select>
        </div>
        <div class="col" style="flex:0 0 auto;align-self:flex-end;display:flex;flex-direction:column;gap:8px;">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-muted);cursor:pointer;">
            <input type="checkbox" id="box-mode-toggle" ${savedBoxMode ? 'checked' : ''}
                   style="width:15px;height:15px;cursor:pointer;accent-color:var(--accent);">
            Box &amp; whisker
          </label>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-muted);cursor:pointer;">
            <input type="checkbox" id="conf-toggle" ${savedConf ? 'checked' : ''}
                   style="width:15px;height:15px;cursor:pointer;accent-color:var(--accent);">
            ± confidence
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
    backBtn.addEventListener('click', () => navigate(6));

    updatePlots();

    function getSelections() {
      const xAxis     = container.querySelector('#x-axis').value;
      const groupBy   = container.querySelector('#group-by').value;
      const sectionBy = container.querySelector('#section-by').value;
      const yParams   = [...container.querySelector('#y-params').selectedOptions].map(o => o.value);
      const boxMode   = container.querySelector('#box-mode-toggle').checked;
      const showConf  = container.querySelector('#conf-toggle').checked;
      return { xAxis, groupBy, sectionBy, yParams, boxMode, showConf };
    }

    function updatePlots() {
      const { xAxis, groupBy, sectionBy, yParams, boxMode, showConf } = getSelections();
      if (!yParams.length) { showToast('Select at least one parameter.', 'error'); return; }
      if (xAxis === groupBy) { showToast('X axis and Group by must be different.', 'error'); return; }
      if (sectionBy !== 'none' && (sectionBy === xAxis || sectionBy === groupBy)) {
        showToast('Section by must differ from X axis and Group by.', 'error'); return;
      }

      setState({ _trendsBoxMode: boxMode, _trendsConf: showConf, _trendsGroupBy: groupBy, _trendsSection: sectionBy });

      if (showConf && !results.some(r => Object.keys(r.confidence || {}).length > 0)) {
        showToast('No confidence data — re-run fitting to generate uncertainty estimates.', 'warning');
      }

      const grid = container.querySelector('#trend-plots-grid');
      grid.innerHTML = '';

      // One synthetic null-section when no sectioner is set
      const sectionValues = sectionBy === 'none'
        ? [null]
        : [...new Set(results.map(r => getCharValue(r, sectionBy)).filter(v => v != null))].sort((a, b) => Number(a) - Number(b));

      const plotJobs = [];

      for (const secVal of sectionValues) {
        const sectionResults = secVal === null
          ? results
          : results.filter(r => String(getCharValue(r, sectionBy)) === String(secVal));

        let targetGrid;
        if (secVal !== null) {
          const secSafe = String(secVal).replace(/[^a-zA-Z0-9]/g, '_');
          grid.insertAdjacentHTML('beforeend', `
            <div class="trend-section">
              <div class="trend-section-header">${sectionBy} ${secVal}</div>
              <div class="trend-plots-grid" id="section-${secSafe}"></div>
            </div>
          `);
          targetGrid = container.querySelector(`#section-${secSafe}`);
        } else {
          targetGrid = grid;
        }

        for (const param of yParams) {
          const plotId = `trend-${param.replace(/[^a-zA-Z0-9]/g, '_')}-${secVal ?? 'all'}`;
          targetGrid.insertAdjacentHTML('beforeend', `
            <div class="trend-plot-card">
              <div class="trend-plot-title">${param}</div>
              <div class="trend-plot" id="${plotId}"></div>
            </div>
          `);
          plotJobs.push({ plotId, param, sectionResults });
        }
      }

      setTimeout(() => {
        for (const { plotId, param, sectionResults } of plotJobs) {
          const el = container.querySelector(`#${plotId}`);
          plotTrend(param, el, sectionResults, xAxis, groupBy, charUnits, boxMode, showConf);
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

    function plotTrend(param, el, activeResults, xAxis, groupBy, charUnits = {}, boxMode = true, showConf = false) {
      if (!el || typeof Plotly === 'undefined') return;
      el.style.height = '350px';

      const { scale: yScale, unit: yUnit } = paramInfo(param);
      const yLabel = yUnit ? `${param} (${yUnit})` : param;

      // groups[groupKey][xNum] = { ys: [y1, y2, ...], confs: [c1, c2, ...] }
      const groups = {};
      for (const r of activeResults) {
        const xRaw = xAxis === 'File index' ? activeResults.indexOf(r) : getCharValue(r, xAxis);
        const yRaw = r.parameters?.[param];
        const yVal = yRaw != null ? yRaw * yScale : null;
        if (xRaw == null || yVal == null) continue;

        const conf     = r.confidence?.[param];
        const groupVal = groupBy ? getCharValue(r, groupBy) : null;
        // If a grouping axis is selected, skip rows missing that grouping value.
        // This avoids creating a fallback "all" series that can be mislabeled as a parameter name.
        if (groupBy && (groupVal == null || String(groupVal).trim() === '')) continue;
        const groupKey = groupBy ? String(groupVal) : 'all';
        const xNum = Number(xRaw);

        if (!groups[groupKey]) groups[groupKey] = {};
        if (!groups[groupKey][xNum]) groups[groupKey][xNum] = { ys: [], confs: [] };
        groups[groupKey][xNum].ys.push(yVal);
        if (conf != null) groups[groupKey][xNum].confs.push(conf * yScale);
      }

      const groupKeys = Object.keys(groups).sort();
      if (!groupKeys.length) {
        el.innerHTML = '<div style="padding:20px;color:var(--text-dim);text-align:center;">No data</div>';
        return;
      }

      const PALETTE = ['#4ecdc4', '#e05c5c', '#4a9ade', '#e67e22', '#9b59b6', '#27ae60', '#f0a500'];

      // Use box traces only when toggled on AND data actually has spread
      const hasSpread = groupKeys.some(k => Object.values(groups[k]).some(bin => bin.ys.length > 1));
      const useBox = boxMode && hasSpread;

      const traces = [];
      for (let i = 0; i < groupKeys.length; i++) {
        const key = groupKeys[i];
        const color = PALETTE[i % PALETTE.length];
        const xBins = groups[key];
        const sortedX = Object.keys(xBins).map(Number).sort((a, b) => a - b);
        const name = key === 'all' ? param
          : groupBy === 'battery_id' ? (batteryLabels[key] ?? key)
          : String(key);

        if (useBox) {
          // Flatten to per-point arrays for Plotly box grouping
          const boxX = [], boxY = [];
          for (const x of sortedX) {
            for (const y of xBins[x].ys) { boxX.push(x); boxY.push(y); }
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
            y: sortedX.map(x => { const ys = xBins[x].ys; return ys.reduce((s,v) => s+v, 0) / ys.length; }),
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
            const ys = xBins[x].ys;
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

        // Confidence overlay: individual points ± 1σ, shown in both scatter and box modes
        if (showConf) {
          const ptX = [], ptY = [], ptErr = [];
          for (const x of sortedX) {
            xBins[x].ys.forEach((y, idx) => {
              ptX.push(x);
              ptY.push(y);
              ptErr.push(xBins[x].confs[idx] ?? null);
            });
          }
          if (ptErr.some(v => v !== null)) {
            traces.push({
              x: ptX, y: ptY,
              error_y: { type: 'data', array: ptErr, visible: true,
                         color: hexToRgba(color, 0.6), thickness: 1.5, width: 4 },
              type: 'scatter', mode: 'markers',
              name: `${name} ±1σ`,
              marker: { color, opacity: 0.75, size: 5 },
              legendgroup: key,
              showlegend: false,
            });
          }
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
        legend: { orientation: 'h', x: 0.5, xanchor: 'center', y: -0.38, yanchor: 'top', font: { size: 9 },
                  ...(groupBy !== 'battery_id' && groupKeys[0] !== 'all'
                    ? { title: { text: groupBy, font: { size: 10, color: '#8892b0' } } }
                    : {}) },
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
