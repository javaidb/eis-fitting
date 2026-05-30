import { getState, setState } from '../state.js';

export function ColumnMapperView(container, { navigate, showToast }) {

  function defaultUnit(label) {
    const l = (label || '').toLowerCase();
    if (/temp/.test(l))                       return '°C';
    if (/\bsoc\b|state.of.charge/.test(l))    return '%';
    if (/volt|^v$|_v$/.test(l))               return 'V';
    return '';
  }

  function render() {
    const { files, detectedRoles, columnMap, charUnits } = getState();
    if (!files?.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📂</div><div>Load files first.</div></div>';
      return;
    }

    // Collect all unique columns across files
    const allCols = [...new Set(files.flatMap(f => f.columns))];

    // Check for header mismatches
    const allSame = files.every(f =>
      f.columns.length === files[0].columns.length &&
      f.columns.every((c, i) => c === files[0].columns[i])
    );

    const roles  = detectedRoles || {};
    const cm     = columnMap || {};
    const savedUnits = charUnits || {};
    const charParams = cm.characterization
      ? Object.entries(cm.characterization).map(([label, col]) => ({
          label, col, unit: savedUnits[label] ?? defaultUnit(label),
        }))
      : [];

    // Pre-fill auto-detected + add temperature/voltage/soc as defaults if present
    const freq   = cm.frequency   || roles.frequency   || '';
    const realZ  = cm.real_z      || roles.real_z      || '';
    const imagZ  = cm.imag_z      || roles.imag_z      || '';
    const negate = cm.negate_imag ?? false;

    const defaultCharEntries = [];
    if (charParams.length === 0) {
      if (roles.temperature) defaultCharEntries.push({ label: 'Temperature', col: roles.temperature, unit: '°C' });
      if (roles.voltage)     defaultCharEntries.push({ label: 'Voltage',     col: roles.voltage,     unit: 'V'  });
      if (roles.soc)         defaultCharEntries.push({ label: 'SOC',         col: roles.soc,         unit: '%'  });
    }
    const charEntries = charParams.length ? charParams : defaultCharEntries;

    function colOption(col, selected) {
      return `<option value="${col}" ${col === selected ? 'selected' : ''}>${col}</option>`;
    }
    function colSelect(id, selected) {
      return `
        <select id="${id}">
          <option value="">— select —</option>
          ${allCols.map(c => colOption(c, selected)).join('')}
        </select>`;
    }

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
            ${colSelect('col-frequency', freq)}
          </div>
          <div class="mapping-field">
            <label>Real Impedance Z′</label>
            ${colSelect('col-real-z', realZ)}
          </div>
          <div class="mapping-field">
            <label>Imaginary Impedance Z″</label>
            ${colSelect('col-imag-z', imagZ)}
          </div>
        </div>
        <div class="toggle-row" style="margin-top:12px;">
          <input type="checkbox" id="negate-imag" ${negate ? 'checked' : ''}>
          <label class="toggle-label" for="negate-imag">Negate imaginary values (if stored as positive Z″)</label>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Characterization Parameters (for trend analysis)</div>
        <div class="section-sub" style="margin-bottom:12px; font-size:12px;">
          These are the variables that vary between files (e.g. temperature, voltage, SOC). Each row is one variable.
        </div>
        <div class="char-params-list" id="char-params-list">
          ${charEntries.map((e, i) => charParamRow(i, e.label, e.col, allCols, e.unit ?? '')).join('')}
        </div>
        <button class="btn btn-secondary btn-sm" id="add-char-btn" style="margin-top:10px;">+ Add Parameter</button>
      </div>

      <div class="step-actions">
        <button class="btn btn-secondary" id="back-btn">← Back</button>
        <div class="spacer"></div>
        <button class="btn btn-primary" id="next-btn">Next: Build Circuit →</button>
      </div>
    `;

    let charCount = charEntries.length;

    container.querySelector('#add-char-btn').addEventListener('click', () => {
      const list = container.querySelector('#char-params-list');
      const row = document.createElement('div');
      row.innerHTML = charParamRow(charCount++, '', '', allCols);
      row.className = '';
      list.insertAdjacentHTML('beforeend', charParamRow(charCount - 1, '', '', allCols, ''));
      attachRemoveListeners();
    });

    attachRemoveListeners();

    container.querySelector('#back-btn').addEventListener('click', () => navigate(1));

    container.querySelector('#next-btn').addEventListener('click', () => {
      const frequency = container.querySelector('#col-frequency').value;
      const real_z    = container.querySelector('#col-real-z').value;
      const imag_z    = container.querySelector('#col-imag-z').value;
      const negate_imag = container.querySelector('#negate-imag').checked;

      if (!frequency || !real_z || !imag_z) {
        showToast('Please select frequency, real Z, and imaginary Z columns.', 'error');
        return;
      }

      const charRows = container.querySelectorAll('.char-param-row');
      const characterization = {};
      const newCharUnits = {};
      charRows.forEach(row => {
        const labelEl = row.querySelector('.char-label');
        const colEl   = row.querySelector('.char-col');
        const unitEl  = row.querySelector('.char-unit');
        if (labelEl && colEl && labelEl.value.trim() && colEl.value) {
          const lbl = labelEl.value.trim();
          characterization[lbl] = colEl.value;
          if (unitEl?.value.trim()) newCharUnits[lbl] = unitEl.value.trim();
        }
      });

      setState({
        columnMap: { frequency, real_z, imag_z, negate_imag, characterization },
        charUnits: newCharUnits,
        maxStep: Math.max(getState().maxStep, 4),
      });
      navigate(3);
    });

    function attachRemoveListeners() {
      container.querySelectorAll('.char-remove-btn').forEach(btn => {
        btn.onclick = () => btn.closest('.char-param-row').remove();
      });
    }
  }

  function charParamRow(i, label, col, allCols, unit = '') {
    const autoUnit = unit || defaultUnit(label);
    return `
      <div class="char-param-row">
        <input type="text" class="char-label" placeholder="Label (e.g. Temperature)" value="${label}">
        <select class="char-col">
          <option value="">— column —</option>
          ${allCols.map(c => `<option value="${c}" ${c === col ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
        <input type="text" class="char-unit" placeholder="unit" value="${autoUnit}"
               style="width:56px;padding:4px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px;text-align:center;">
        <button class="btn btn-icon btn-ghost char-remove-btn" title="Remove">✕</button>
      </div>`;
  }

  return { onEnter: render };
}
