import { getState, setState } from '../state.js';

export function ColumnMapperView(container, { navigate, showToast }) {

  // Set during render; used by event handlers and charParamRow.
  let _allCols = [];
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
    const { files, detectedRoles, columnMap, charUnits, charDecimalPlaces } = getState();
    if (!files?.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📂</div><div>Load files first.</div></div>';
      return;
    }

    _allCols = [...new Set(files.flatMap(f => f.columns))];

    const { ids, cols } = buildBatteryInfo(files);
    _batteryIds     = ids;
    _colsByBattery  = cols;
    _showPerBattery = ids.length >= 2;

    const allSame = files.every(f =>
      f.columns.length === files[0].columns.length &&
      f.columns.every((c, i) => c === files[0].columns[i])
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

    container.innerHTML = `
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
        <button class="btn btn-primary" id="next-btn">Next: Build Circuit →</button>
      </div>
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

      if (!frequency || !real_z || !imag_z) {
        showToast('Please select frequency, real Z, and imaginary Z columns.', 'error');
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
        columnMap: { frequency, real_z, imag_z, negate_imag, characterization, per_battery_characterization },
        charUnits: newCharUnits,
        charDecimalPlaces: newCharDecimalPlaces,
        maxStep: Math.max(getState().maxStep, 4),
      });
      navigate(3);
    });
  }

  return { onEnter: render };
}
