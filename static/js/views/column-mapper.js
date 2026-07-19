import { getState, setState } from '../state.js';
import { characterizeFiles, getSpectrum } from '../api.js';
import { computeFieldStyles, idCellHtml } from '../table-colors.js';

export function ColumnMapperView(container, { navigate, showToast }) {

  // Set during render; used by event handlers and charParamRow.
  let _allCols = [];
  let _previewPath = null;             // path of the file shown in the Nyquist preview
  const _spectrumCache = new Map();    // path|mapping-signature → spectrum
  let _charLabels = [];                // characterization labels shown as value columns
  let _charValues = new Map();         // path → { label: value }
  let _sortField = null;               // '__file' | <char label> | null = path order
  let _sortDir   = 1;                  // 1 asc, -1 desc
  let _batteryIds = [];        // sorted string array, e.g. ['1','2','3']
  let _colsByBattery = {};     // { bid_str: string[] }
  let _showPerBattery = false; // true when ≥2 distinct battery IDs detected

  function defaultUnit(label) {
    const l = (label || '').toLowerCase();
    if (/temp/.test(l))                    return '°C';
    if (/\bsoc\b|state.of.charge/.test(l)) return '%';
    if (/volt|^v$|_v$/.test(l))            return 'V';
    return '';
  }

  function bidFromFile(f) {
    const parts = (f.path || '').replace(/\\/g, '/').split('/');
    return parts.length >= 2 ? parts[parts.length - 2] : null;
  }

  function fileDisplayName(f) {
    const parent = bidFromFile(f);
    return parent ? `${parent}/${f.filename}` : f.filename;
  }

  // Build per-battery column sets from files.
  function buildBatteryInfo(files) {
    const map = {};
    for (const f of files) {
      const bid = bidFromFile(f);
      if (bid) {
        if (!map[bid]) map[bid] = new Set();
        f.columns.forEach(c => map[bid].add(c));
      }
    }
    const ids = Object.keys(map).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const cols = {};
    ids.forEach(bid => { cols[bid] = [...map[bid]].sort(); });
    return { ids, cols };
  }

  function colSelectHtml(cls, selected, cols, extraStyle = '') {
    return `<select class="${cls}" style="${extraStyle}">
      <option value="">— column —</option>
      ${cols.map(c => `<option value="${c}" ${c === selected ? 'selected' : ''}>${c}</option>`).join('')}
    </select>`;
  }

  function charParamRow(entry) {
    const {
      label = '', col = '', unit = '', decimals = '',
      mode = 'global', perBatteryCols = {},
    } = entry;
    const isPB   = mode === 'per-battery' && _showPerBattery;
    const autoUnit = unit || defaultUnit(label);

    const inputStyle = 'padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px;';

    const modeToggle = _showPerBattery ? `
      <div style="display:inline-flex;border:1px solid var(--border);border-radius:4px;overflow:hidden;flex-shrink:0;">
        <button type="button" class="mode-seg-btn" data-mode="global"
                style="${inputStyle}cursor:pointer;border:none;border-radius:0;${!isPB ? 'background:var(--accent);color:#fff;' : 'background:var(--surface);color:var(--text-muted);'}">
          Global
        </button>
        <button type="button" class="mode-seg-btn" data-mode="per-battery"
                style="${inputStyle}cursor:pointer;border:none;border-left:1px solid var(--border);border-radius:0;${isPB ? 'background:var(--accent);color:#fff;' : 'background:var(--surface);color:var(--text-muted);'}">
          Per battery
        </button>
      </div>` : '';

    const globalColSelect = isPB ? '' : colSelectHtml('char-col', col, _allCols);

    const perBatteryGrid = isPB ? `
      <div class="per-battery-cols" style="margin-top:6px;padding:8px 10px;background:rgba(0,0,0,.12);border-radius:5px;display:grid;grid-template-columns:auto 1fr;gap:5px 10px;align-items:center;">
        ${_batteryIds.map(bid => {
          const bidCols = _colsByBattery[bid] || _allCols;
          return `
            <span style="font-size:12px;color:var(--text-muted);white-space:nowrap;">${bid}</span>
            ${colSelectHtml('per-battery-col-select', perBatteryCols[bid] || '', bidCols,
              'font-size:12px;padding:3px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);',
            )} `
            .replace('class="per-battery-col-select"', `class="per-battery-col-select" data-battery="${bid}"`);
        }).join('')}
      </div>` : '';

    return `
      <div class="char-param-row">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <input type="text" class="char-label" placeholder="Label (e.g. Temperature)" value="${label}">
          ${globalColSelect}
          <input type="text" class="char-unit" placeholder="unit" value="${autoUnit}"
                 style="width:56px;${inputStyle}text-align:center;">
          <input type="number" class="char-decimals" placeholder="dp" min="0" max="8" value="${decimals}"
                 style="width:64px;${inputStyle}text-align:center;"
                 title="Decimal places to round to before averaging (numeric columns only)">
          ${modeToggle}
          <button class="btn btn-icon btn-ghost char-remove-btn" title="Remove">✕</button>
        </div>
        ${perBatteryGrid}
      </div>`;
  }

  // Read current state from a row element.
  function rowToEntry(row) {
    const label       = row.querySelector('.char-label')?.value || '';
    const col         = row.querySelector('.char-col')?.value || '';
    const unit        = row.querySelector('.char-unit')?.value || '';
    const decimals    = row.querySelector('.char-decimals')?.value || '';
    const activeModeBtn = row.querySelector('.mode-seg-btn[style*="var(--accent)"]');
    const mode        = activeModeBtn?.dataset.mode || 'global';
    const perBatteryCols = {};
    row.querySelectorAll('.per-battery-col-select').forEach(sel => {
      if (sel.value) perBatteryCols[sel.dataset.battery] = sel.value;
    });
    return { label, col, unit, decimals, mode, perBatteryCols };
  }

  function attachRemoveListeners() {
    container.querySelectorAll('.char-remove-btn').forEach(btn => {
      btn.onclick = () => btn.closest('.char-param-row').remove();
    });
  }

  function render() {
    const { files, discardedFiles, detectedRoles, columnMap, charUnits, charDecimalPlaces } = getState();
    if (!files?.length && !discardedFiles?.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📂</div><div>Load files first.</div></div>';
      return;
    }

    // Union of active + discarded so the mapping survives files being excluded.
    const allFiles = [...(files || []), ...(discardedFiles || [])];
    _allCols = [...new Set(allFiles.flatMap(f => f.columns))];

    const { ids, cols } = buildBatteryInfo(allFiles);
    _batteryIds     = ids;
    _colsByBattery  = cols;
    _showPerBattery = ids.length >= 2;

    const allSame = allFiles.every(f =>
      f.columns.length === allFiles[0].columns.length &&
      f.columns.every((c, i) => c === allFiles[0].columns[i])
    );

    const roles    = detectedRoles || {};
    const cm       = columnMap || {};
    const savedUnits    = charUnits || {};
    const savedDecimals = charDecimalPlaces || {};
    const pbChar   = cm.per_battery_characterization || {};

    // Restore existing char entries, including per-battery mode.
    let charEntries = [];
    if (cm.characterization && Object.keys(cm.characterization).length) {
      const allLabels = new Set([
        ...Object.keys(cm.characterization),
        ...Object.keys(pbChar),
      ]);
      for (const label of allLabels) {
        const globalCol = cm.characterization[label] || '';
        const isPB = !!(pbChar[label] && Object.keys(pbChar[label]).length > 0);
        charEntries.push({
          label,
          col:            globalCol,
          unit:           savedUnits[label] ?? defaultUnit(label),
          decimals:       savedDecimals[label] ?? '',
          mode:           isPB ? 'per-battery' : 'global',
          perBatteryCols: pbChar[label] || {},
        });
      }
    } else {
      // First visit — auto-fill from detected roles.
      if (roles.temperature) charEntries.push({ label: 'Temperature', col: roles.temperature, unit: '°C', decimals: '', mode: 'global', perBatteryCols: {} });
      if (roles.voltage)     charEntries.push({ label: 'Voltage',     col: roles.voltage,     unit: 'V',  decimals: '', mode: 'global', perBatteryCols: {} });
      if (roles.soc)         charEntries.push({ label: 'SOC',         col: roles.soc,         unit: '%',  decimals: '', mode: 'global', perBatteryCols: {} });
      if (roles.identifier)  charEntries.push({ label: 'identifier',  col: roles.identifier,  unit: '',   decimals: '', mode: 'global', perBatteryCols: {} });
    }

    const freq   = cm.frequency  || roles.frequency  || '';
    const realZ  = cm.real_z     || roles.real_z     || '';
    const imagZ  = cm.imag_z     || roles.imag_z     || '';
    const negate = cm.negate_imag ?? false;
    const skipFirstRow = cm.skip_first_data_row ?? false;

    container.innerHTML = `
      <div class="mapper-layout">
      <div class="mapper-main">

      <div class="section-header">Map Columns</div>
      <div class="section-sub">Assign which CSV columns correspond to which parameters.</div>

      ${!allSame ? `
        <div class="card" style="border-color:var(--warning);">
          <span style="color:var(--warning);">⚠ Column headers differ between files. Using union of all columns — verify assignments carefully.</span>
        </div>` : ''}

      <div class="card">
        <div class="card-title">EIS Data Columns (required for fitting)</div>
        <div class="mapping-grid">
          <div class="mapping-field">
            <label>Frequency</label>
            ${colSelectHtml('', freq, _allCols, '')}
          </div>
          <div class="mapping-field">
            <label>Real Impedance Z′</label>
            ${colSelectHtml('', realZ, _allCols, '')}
          </div>
          <div class="mapping-field">
            <label>Imaginary Impedance Z″</label>
            ${colSelectHtml('', imagZ, _allCols, '')}
          </div>
        </div>
        <div class="toggle-row" style="margin-top:12px;">
          <input type="checkbox" id="negate-imag" ${negate ? 'checked' : ''}>
          <label class="toggle-label" for="negate-imag">Negate imaginary values (if stored as positive Z″)</label>
        </div>
        <div class="toggle-row" style="margin-top:8px;">
          <input type="checkbox" id="skip-first-row" ${skipFirstRow ? 'checked' : ''}>
          <label class="toggle-label" for="skip-first-row">Skip first data row after header (e.g. a units row)</label>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Characterization Parameters (for trend analysis)</div>
        <div class="section-sub" style="margin-bottom:12px;font-size:12px;">
          These are the variables that vary between files (e.g. temperature, voltage, SOC).
          ${_showPerBattery ? 'Each parameter can use a <strong>global</strong> column name or a <strong>per-battery</strong> mapping when column names differ across batteries.' : ''}
        </div>
        <div class="char-params-list" id="char-params-list">
          ${charEntries.map(e => charParamRow(e)).join('')}
        </div>
        <button class="btn btn-secondary btn-sm" id="add-char-btn" style="margin-top:10px;">+ Add Parameter</button>
      </div>

      <div class="step-actions">
        <button class="btn btn-secondary" id="back-btn">← Back</button>
        <div class="spacer"></div>
        <button class="btn btn-primary" id="next-btn">Next: DRT →</button>
      </div>

      </div><!-- /mapper-main -->

      <aside class="mapper-preview">
        <div class="card">
          <div class="card-title" style="display:flex;align-items:center;gap:8px;">
            <span style="flex:1;">Nyquist Preview</span>
            <span class="chip" id="preview-active-count"></span>
            <button class="btn btn-secondary btn-sm" id="preview-refresh-btn"
                    title="Reload the plot using the currently selected columns">↻ Refresh</button>
          </div>
          <div class="section-sub" style="font-size:12px;margin-bottom:8px;">
            Click a file (or use ↑/↓ to cycle) to preview its raw spectrum with the current mapping.
            ⊘ excludes a file from analysis without hiding it here.
          </div>
          <div class="preview-list-header" id="preview-list-header" style="display:none;"></div>
          <div class="preview-file-list" id="preview-file-list" tabindex="0">
            ${previewItemsHtml()}
          </div>
          <div class="preview-plot" id="preview-plot">
            <div class="preview-plot-empty">Map Frequency, Z′ and Z″, then select a file.</div>
          </div>
        </div>
      </aside>

      </div><!-- /mapper-layout -->
    `;

    // Fix the EIS column selects (they don't have IDs yet — assign after render)
    const eiSelects = container.querySelectorAll('.mapping-field select');
    if (eiSelects[0]) eiSelects[0].id = 'col-frequency';
    if (eiSelects[1]) eiSelects[1].id = 'col-real-z';
    if (eiSelects[2]) eiSelects[2].id = 'col-imag-z';

    // Mode toggle: delegate clicks on .mode-seg-btn
    container.querySelector('#char-params-list').addEventListener('click', e => {
      const btn = e.target.closest('.mode-seg-btn');
      if (!btn) return;
      const row = btn.closest('.char-param-row');
      const entry = rowToEntry(row);
      entry.mode = btn.dataset.mode;
      const tmp = document.createElement('div');
      tmp.innerHTML = charParamRow(entry);
      row.replaceWith(tmp.firstElementChild);
      attachRemoveListeners();
    });

    // Add parameter row
    container.querySelector('#add-char-btn').addEventListener('click', () => {
      container.querySelector('#char-params-list')
        .insertAdjacentHTML('beforeend', charParamRow({ label: '', col: '', unit: '', decimals: '', mode: 'global', perBatteryCols: {} }));
      attachRemoveListeners();
    });

    attachRemoveListeners();

    container.querySelector('#back-btn').addEventListener('click', () => navigate(1));

    container.querySelector('#next-btn').addEventListener('click', () => {
      const frequency   = container.querySelector('#col-frequency').value;
      const real_z      = container.querySelector('#col-real-z').value;
      const imag_z      = container.querySelector('#col-imag-z').value;
      const negate_imag = container.querySelector('#negate-imag').checked;
      const skip_first_data_row = container.querySelector('#skip-first-row').checked;

      if (!frequency || !real_z || !imag_z) {
        showToast('Please select frequency, real Z, and imaginary Z columns.', 'error');
        return;
      }
      if (!(getState().files || []).length) {
        showToast('All files are excluded from analysis — re-include at least one (↺).', 'error');
        return;
      }

      const characterization = {};
      const per_battery_characterization = {};
      const newCharUnits = {};
      const newCharDecimalPlaces = {};

      container.querySelectorAll('.char-param-row').forEach(row => {
        const label = row.querySelector('.char-label')?.value.trim();
        if (!label) return;

        const unit    = row.querySelector('.char-unit')?.value.trim();
        const decVal  = row.querySelector('.char-decimals')?.value.trim();
        const modeBtn = row.querySelector('.mode-seg-btn[style*="var(--accent)"]');
        const mode    = modeBtn?.dataset.mode || 'global';

        if (unit) newCharUnits[label] = unit;
        if (decVal && !isNaN(decVal)) newCharDecimalPlaces[label] = parseInt(decVal, 10);

        if (mode === 'per-battery') {
          const pbCols = {};
          row.querySelectorAll('.per-battery-col-select').forEach(sel => {
            if (sel.value) pbCols[sel.dataset.battery] = sel.value;
          });
          if (Object.keys(pbCols).length) {
            per_battery_characterization[label] = pbCols;
            characterization[label] = ''; // placeholder so label is known globally
          }
        } else {
          const col = row.querySelector('.char-col')?.value;
          if (col) characterization[label] = col;
        }
      });

      setState({
        columnMap: { frequency, real_z, imag_z, negate_imag, skip_first_data_row, characterization, per_battery_characterization },
        charUnits: newCharUnits,
        charDecimalPlaces: newCharDecimalPlaces,
        maxStep: Math.max(getState().maxStep, 4),
      });
      navigate(3);
    });

    // ── Nyquist preview panel ─────────────────────────────────────────────
    function byPath(a, b) {
      return a.path.localeCompare(b.path, undefined, { numeric: true });
    }

    // Active + discarded files — path order by default, or the clicked
    // header's sort (numeric-aware, missing values last).
    function previewFiles() {
      const s = getState();
      const list = [...(s.files || []), ...(s.discardedFiles || [])].sort(byPath);
      if (!_sortField) return list;
      const val = f => _sortField === '__file'
        ? fileDisplayName(f)
        : (_charValues.get(f.path) || {})[_sortField] ?? null;
      list.sort((a, b) => {
        const va = val(a), vb = val(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        const na = Number(va), nb = Number(vb);
        const cmp = Number.isFinite(na) && Number.isFinite(nb)
          ? na - nb
          : String(va).localeCompare(String(vb), undefined, { numeric: true });
        return _sortDir * cmp;
      });
      return list;
    }

    function previewGridTpl() {
      return `18px minmax(0,1fr) ${'minmax(52px,80px) '.repeat(_charLabels.length)}20px`;
    }

    function fmtCharVal(v) {
      if (v === null || v === undefined || v === '') return '—';
      if (typeof v === 'number') {
        if (Number.isInteger(v)) return String(v);
        if (Math.abs(v) >= 10000 || (v !== 0 && Math.abs(v) < 0.01)) return v.toExponential(2);
        return String(+v.toFixed(3));
      }
      return String(v);
    }

    function previewItemsHtml() {
      const discardedPaths = new Set((getState().discardedFiles || []).map(f => f.path));
      const tpl = previewGridTpl();
      const list = previewFiles();
      const styles = computeFieldStyles(_charLabels, list, _charValues);
      return list.map(f => {
        const off  = discardedPaths.has(f.path);
        const vals = _charValues.get(f.path) || {};
        return `
          <div class="preview-file-item${f.path === _previewPath ? ' active' : ''}${off ? ' discarded' : ''}"
               data-path="${encodeURIComponent(f.path)}"
               style="display:grid;grid-template-columns:${tpl};"
               title="${fileDisplayName(f)}${off ? ' — excluded from analysis' : ''}">
            <span style="color:var(--accent);">📄</span><span>${fileDisplayName(f)}</span>
            ${_charLabels.map(l => `<span class="preview-val" title="${l}: ${fmtCharVal(vals[l])}">${idCellHtml(vals[l], styles[l])}</span>`).join('')}
            <button class="preview-discard-btn"
                    title="${off ? 'Re-include in analysis' : 'Exclude from analysis'}">${off ? '↺' : '⊘'}</button>
          </div>`;
      }).join('');
    }

    function renderPreviewHeader() {
      const el = container.querySelector('#preview-list-header');
      if (!el) return;
      if (!_charLabels.length) { el.style.display = 'none'; return; }
      el.style.display = 'grid';
      el.style.gridTemplateColumns = previewGridTpl();
      const th = (key, label) => {
        const active = _sortField === key;
        const arrow  = active ? (_sortDir === 1 ? '↑' : '↓') : '↕';
        return `<span class="preview-sort${active ? ' sorted' : ''}" data-sortkey="${key}"
                     title="Sort by ${label}">${label} <span class="sort-arrow">${arrow}</span></span>`;
      };
      el.innerHTML = `<span></span>${th('__file', 'File')}
        ${_charLabels.map(l => th(l, l)).join('')}<span></span>`;
    }

    // Read the characterization parameter rows as currently edited (unsaved).
    function readCharParams() {
      const characterization = {};
      const per_battery_characterization = {};
      const decimal_places = {};
      container.querySelectorAll('.char-param-row').forEach(row => {
        const label = row.querySelector('.char-label')?.value.trim();
        if (!label) return;
        const decVal  = row.querySelector('.char-decimals')?.value.trim();
        if (decVal && !isNaN(decVal)) decimal_places[label] = parseInt(decVal, 10);
        const modeBtn = row.querySelector('.mode-seg-btn[style*="var(--accent)"]');
        if ((modeBtn?.dataset.mode || 'global') === 'per-battery') {
          const pbCols = {};
          row.querySelectorAll('.per-battery-col-select').forEach(sel => {
            if (sel.value) pbCols[sel.dataset.battery] = sel.value;
          });
          if (Object.keys(pbCols).length) {
            per_battery_characterization[label] = pbCols;
            characterization[label] = '';
          }
        } else {
          const col = row.querySelector('.char-col')?.value;
          if (col) characterization[label] = col;
        }
      });
      return { characterization, per_battery_characterization, decimal_places };
    }

    async function loadCharValues() {
      const params = readCharParams();
      _charLabels = [...new Set([
        ...Object.keys(params.characterization),
        ...Object.keys(params.per_battery_characterization),
      ])];
      renderPreviewHeader();
      if (!_charLabels.length) { _charValues = new Map(); refreshPreviewList(); return; }
      try {
        const res = await characterizeFiles({
          files: previewFiles(),
          column_map: { ...currentEisMapping(), ...params },
        });
        _charValues = new Map(res.map(r => [r.path, r.characterization || {}]));
      } catch (_) {
        _charValues = new Map();
      }
      refreshPreviewList();
    }

    function updateActiveCount() {
      const el = container.querySelector('#preview-active-count');
      if (el) el.textContent = `${(getState().files || []).length} in analysis`;
    }

    function refreshPreviewList() {
      const listEl = container.querySelector('#preview-file-list');
      if (listEl) listEl.innerHTML = previewItemsHtml();
      updateActiveCount();
    }

    function toggleDiscard(path) {
      const s = getState();
      const active    = s.files || [];
      const discarded = s.discardedFiles || [];
      const f = active.find(x => x.path === path);
      if (f) {
        setState({ files: active.filter(x => x.path !== path), discardedFiles: [...discarded, f] });
        showToast(`${f.filename} excluded from analysis.`, 'success');
      } else {
        const d = discarded.find(x => x.path === path);
        if (!d) return;
        setState({
          files: [...active, d].sort(byPath),
          discardedFiles: discarded.filter(x => x.path !== path),
        });
        showToast(`${d.filename} re-included in analysis.`, 'success');
      }
      refreshPreviewList();
    }

    function currentEisMapping() {
      return {
        frequency:           container.querySelector('#col-frequency')?.value || '',
        real_z:              container.querySelector('#col-real-z')?.value || '',
        imag_z:              container.querySelector('#col-imag-z')?.value || '',
        negate_imag:         container.querySelector('#negate-imag')?.checked ?? false,
        skip_first_data_row: container.querySelector('#skip-first-row')?.checked ?? false,
        characterization: {},
        per_battery_characterization: {},
      };
    }

    function plotPreview(spec, el) {
      if (typeof Plotly === 'undefined') {
        el.innerHTML = '<div class="preview-plot-empty">Plotly not loaded.</div>';
        return;
      }
      el.innerHTML = '';
      // Same format as the Nyquist data trace in the Fit tab.
      const traces = [{
        x: spec.z_real, y: spec.z_imag.map(v => -v),
        mode: 'markers', type: 'scatter', name: 'Data',
        marker: { color: '#8892b0', size: 5 },
      }];
      const layout = {
        paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
        margin: { t: 8, r: 16, b: 48, l: 64 },
        font:   { color: '#8892b0', size: 11 },
        xaxis:  { title: "Z' (Ω)",  color: '#8892b0', gridcolor: '#2d3147', zeroline: false },
        yaxis:  { title: "-Z'' (Ω)", color: '#8892b0', gridcolor: '#2d3147', zeroline: false, scaleanchor: 'x', scaleratio: 1 },
        showlegend: false,
      };
      Plotly.newPlot(el, traces, layout, { displayModeBar: false, responsive: true });
    }

    async function showPreview(path, { force = false } = {}) {
      const plotEl = container.querySelector('#preview-plot');
      if (!plotEl) return;
      _previewPath = path;
      container.querySelectorAll('.preview-file-item').forEach(el =>
        el.classList.toggle('active', decodeURIComponent(el.dataset.path) === path));

      const cm = currentEisMapping();
      if (!cm.frequency || !cm.real_z || !cm.imag_z) {
        plotEl.innerHTML = '<div class="preview-plot-empty">Select Frequency, Z′ and Z″ columns first, then click a file (or ↻ Refresh).</div>';
        return;
      }

      const key = [path, cm.frequency, cm.real_z, cm.imag_z, cm.negate_imag, cm.skip_first_data_row].join('|');
      if (force) _spectrumCache.delete(key);
      let spec = _spectrumCache.get(key);
      if (!spec) {
        plotEl.innerHTML = '<div class="preview-plot-empty">Loading…</div>';
        try {
          spec = await getSpectrum({ path, column_map: cm });
          _spectrumCache.set(key, spec);
        } catch (err) {
          if (_previewPath === path) {
            plotEl.innerHTML = `<div class="preview-plot-empty" style="color:var(--danger);">⚠ ${err.message}</div>`;
          }
          return;
        }
        // A newer click may have superseded this fetch — don't clobber it.
        if (_previewPath !== path) return;
      }
      plotPreview(spec, plotEl);
    }

    const previewListEl = container.querySelector('#preview-file-list');

    previewListEl.addEventListener('click', e => {
      const item = e.target.closest('.preview-file-item');
      if (!item) return;
      const path = decodeURIComponent(item.dataset.path);
      if (e.target.closest('.preview-discard-btn')) {
        toggleDiscard(path);
        return;
      }
      previewListEl.focus({ preventScroll: true });   // arm ↑/↓ navigation
      showPreview(path);
    });

    // ↑/↓ cycle through files (wraps at both ends). The list is focusable
    // (tabindex=0), so clicking any file arms the keyboard navigation.
    previewListEl.addEventListener('keydown', e => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const list = previewFiles();
      if (!list.length) return;
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const idx = list.findIndex(f => f.path === _previewPath);
      const next = idx === -1
        ? (delta > 0 ? 0 : list.length - 1)
        : (idx + delta + list.length) % list.length;
      showPreview(list[next].path);
      container.querySelectorAll('.preview-file-item')[next]
        ?.scrollIntoView({ block: 'nearest' });
    });

    container.querySelector('#preview-refresh-btn').addEventListener('click', () => {
      loadCharValues();
      const path = _previewPath ?? previewFiles()[0]?.path;
      if (path) showPreview(path, { force: true });
    });

    // Header clicks: asc → desc → back to path order
    container.querySelector('#preview-list-header').addEventListener('click', e => {
      const s = e.target.closest('[data-sortkey]');
      if (!s) return;
      const key = s.dataset.sortkey;
      if (_sortField === key) {
        if (_sortDir === 1) _sortDir = -1;
        else { _sortField = null; _sortDir = 1; }
      } else {
        _sortField = key; _sortDir = 1;
      }
      renderPreviewHeader();
      refreshPreviewList();
    });

    updateActiveCount();
    loadCharValues();

    // Restore the previously previewed file after a re-render.
    if (_previewPath && previewFiles().some(f => f.path === _previewPath)) {
      showPreview(_previewPath);
    } else {
      _previewPath = null;
    }
  }

  return { onEnter: render };
}
