import { getState, setState } from '../state.js';
import { characterizeFiles, streamFitting, streamKK } from '../api.js';

const GOOD_THRESHOLD = 0.05;

// Format a display-unit value without unnecessary scientific notation.
// Plain decimal for |v| in [1e-3, 1e4); scientific outside that range.
function fmtNum(v) {
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (abs === 0) return '0';
  if (abs >= 1e-3 && abs < 1e4) {
    const dp = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 10 ? 2 : abs >= 1 ? 3 : abs >= 0.1 ? 4 : 5;
    const s = v.toFixed(dp);
    return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
  }
  return v.toExponential(3);
}

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
    weight:          state.fitWeighting ?? 'none',
    solver:          state.fitSolver ?? 'lm',
    omitInductive:   state.omitInductive ?? false,
    kkData:          state.kkData ?? {},  // per-file ranges change the fit — invalidate cache when KK reruns
  });
}

function parentFolder(path) {
  const parts = (path || '').replace(/\\/g, '/').split('/');
  return parts.length >= 2 ? parts[parts.length - 2] : 'Files';
}

function groupFiles(files) {
  const groups = new Map();
  for (const f of files) {
    const folder = parentFolder(f.path);
    if (!groups.has(folder)) groups.set(folder, { label: folder, files: [] });
    groups.get(folder).files.push(f);
  }
  return groups;
}

function pathToSafeId(path) {
  return (path || '').replace(/[^a-zA-Z0-9]/g, '_');
}

// ── KK tile state helpers ──────────────────────────────────────────────────

function kkTileState(kk) {
  if (!kk.success)                        return { cls: 'kk-fail', label: 'KK ✗' };
  if (kk.flagged_indices?.length > 0)     return { cls: 'kk-warn', label: `KK ⚠ ${kk.flagged_indices.length} pts` };
  return                                           { cls: 'kk-ok',   label: 'KK ✓' };
}

export function FittingRunnerView(container, { navigate, showToast }) {
  const resultMap = new Map();   // path → FitResult
  const charMap   = new Map();   // path → characterization
  const kkMap     = new Map();   // path → KKResult

  // 'kk' when KK was the last operation run; 'fit' when fitting was last.
  // Controls which state buildTile renders when both maps have data.
  let _activeView = 'fit';

  let binByField = '';
  let sortByBest = false;

  function getCharFields() {
    const fields = new Set();
    for (const r of resultMap.values())
      for (const k of Object.keys(r.characterization || {})) fields.add(k);
    for (const c of charMap.values())
      for (const k of Object.keys(c)) fields.add(k);
    if (!fields.size)
      for (const k of Object.keys(getState().charUnits || {})) fields.add(k);
    return [...fields].sort();
  }

  function rebuildGrid() {
    const tileRoot = container.querySelector('#fit-tile-root');
    if (!tileRoot) return;
    tileRoot.innerHTML = buildTileGrid(getState().files || []);
    wireTileClicks();
  }

  function render() {
    const state = getState();
    const ready = state.files?.length && state.columnMap && state.circuitConfig;
    const charFields = getCharFields();
    const cached = ready && state.fitResults?.length && state.fitCacheKey === configKey(state);

    resultMap.clear();
    const files = state.files || [];
    (state.fitResults || []).forEach((r, i) => {
      if (files[i]) resultMap.set(files[i].path, r);
    });

    const weighting      = state.fitWeighting ?? 'none';
    const solver         = state.fitSolver ?? 'lm';
    const omitInductive  = state.omitInductive ?? false;

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

      <!-- Flow panel + standalone Trends button -->
      <div class="fit-panel-row">

        <!-- Three-step flow panel: KK → Configure → Fit -->
        <div class="fit-flow-panel">

          <!-- Back nav -->
          <div class="flow-back-col">
            <button class="btn btn-secondary" id="back-btn" title="Back to bounds editor">←</button>
          </div>

          <!-- Step 1: KK Check -->
          <div class="flow-section">
            <div class="flow-section-label">1 · KK Check</div>
            <div class="flow-section-body">
              <button class="btn btn-secondary" id="kk-run-btn" ${!ready ? 'disabled' : ''} style="width:100%;">
                KK Check
              </button>
              <div class="flow-hint">Validate linearity, flag bad points, estimate Rs</div>
            </div>
          </div>

          <div class="flow-arrow-col">›</div>

          <!-- Step 2: Configure -->
          <div class="flow-section flow-section-config">
            <div class="flow-section-label">2 · Configure</div>
            <div class="flow-section-body">
              <div class="flow-config-row">
                <label class="flow-config-item">
                  <span class="flow-config-label">Timeout</span>
                  <input id="fit-timeout" type="number" min="5" max="600" step="5"
                         value="${state.fitTimeout ?? 60}" class="flow-input flow-input-sm">
                  <span class="flow-unit">s</span>
                </label>

                <label class="flow-config-item">
                  <span class="flow-config-label">Freq</span>
                  <input id="freq-min" type="number" min="0" step="any"
                         value="${state.fitFreqMin ?? ''}" placeholder="min" class="flow-input flow-input-md">
                  <span class="flow-unit">–</span>
                  <input id="freq-max" type="number" min="0" step="any"
                         value="${state.fitFreqMax ?? ''}" placeholder="max" class="flow-input flow-input-md">
                  <span class="flow-unit">Hz</span>
                </label>

                <label class="flow-config-item">
                  <span class="flow-config-label">Weight</span>
                  <select id="weighting-select" class="flow-select">
                    <option value="none"         ${weighting === 'none'         ? 'selected' : ''}>None</option>
                    <option value="modulus"       ${weighting === 'modulus'       ? 'selected' : ''}>Modulus (1/|Z|²)</option>
                    <option value="proportional"  ${weighting === 'proportional'  ? 'selected' : ''}>Proportional (1/Z'², 1/Z''²)</option>
                  </select>
                </label>

                <label class="flow-config-item">
                  <span class="flow-config-label">Solver</span>
                  <select id="solver-select" class="flow-select">
                    <option value="lm"          ${solver === 'lm'          ? 'selected' : ''}>LM</option>
                    <option value="diff_ev"     ${solver === 'diff_ev'     ? 'selected' : ''}>Diff. Evo.</option>
                    <option value="basin_hop"   ${solver === 'basin_hop'   ? 'selected' : ''}>Basin Hopping</option>
                    <option value="nelder_mead" ${solver === 'nelder_mead' ? 'selected' : ''}>Nelder-Mead</option>
                  </select>
                </label>

                <label class="flow-config-item" style="flex-direction:row;align-items:center;gap:6px;cursor:pointer;"
                       title="Remove high-frequency inductive points (Z'' > 0) before fitting">
                  <input type="checkbox" id="omit-inductive-cb" ${omitInductive ? 'checked' : ''}
                         style="accent-color:var(--accent);width:14px;height:14px;flex-shrink:0;">
                  <span class="flow-config-label" style="white-space:nowrap;">Omit inductive</span>
                </label>
              </div>
            </div>
          </div>

          <div class="flow-arrow-col">›</div>

          <!-- Step 3: Run Fit -->
          <div class="flow-section flow-section-run">
            <div class="flow-section-label">3 · Fit</div>
            <div class="flow-section-body">
              <button class="btn btn-primary" id="run-btn" ${!ready ? 'disabled' : ''} style="width:100%;">
                ${cached ? '↺ Re-run' : '▶ Run Fitting'}
              </button>
              <button class="btn btn-danger" id="stop-btn" style="display:none;width:100%;">■ Stop</button>
            </div>
          </div>

        </div><!-- /fit-flow-panel -->

        <!-- Standalone Trends navigation, far right -->
        <button class="btn btn-secondary" id="next-btn"
                ${!state.fitResults?.length ? 'disabled' : ''}
                style="align-self:stretch;white-space:nowrap;">
          View Trends →
        </button>

      </div><!-- /fit-panel-row -->

      <!-- Progress bar (below the flow panel, full width) -->
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

      <div class="fit-sort-bar">
        <span style="font-size:12px;color:var(--text-muted);">Bin by</span>
        <select id="bin-by-select" style="padding:3px 6px;background:var(--surface);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:12px;">
          <option value="">— none —</option>
          ${charFields.map(f => `<option value="${f}" ${f === binByField ? 'selected' : ''}>${f}</option>`).join('')}
        </select>
        <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text-muted);cursor:pointer;">
          <input type="checkbox" id="sort-best-cb" ${sortByBest ? 'checked' : ''}> Group by best circuit
        </label>
      </div>

      <div class="fit-tile-root" id="fit-tile-root">
        ${buildTileGrid(files)}
      </div>

      <!-- Shared modal for both KK and fit results -->
      <div class="fit-modal-overlay" id="fit-modal" style="display:none;" role="dialog" aria-modal="true">
        <div class="fit-modal-box">
          <div class="fit-modal-header">
            <span class="fit-modal-title" id="fit-modal-title"></span>
            <span class="residual-badge" id="fit-modal-badge"></span>
            <button class="fit-modal-close" id="fit-modal-close" aria-label="Close">✕</button>
          </div>
          <div class="fit-modal-meta" id="fit-modal-meta"></div>
          <div class="fit-modal-tabs" id="fit-modal-tabs"></div>
          <div class="fit-modal-plot" id="fit-modal-plot"></div>
          <div class="params-summary fit-modal-params" id="fit-modal-params"></div>
        </div>
      </div>
    `;

    container.querySelector('#back-btn').addEventListener('click', () => navigate(5));
    container.querySelector('#next-btn').addEventListener('click', () => navigate(7));
    container.querySelector('#run-btn').addEventListener('click', runFitting);
    container.querySelector('#stop-btn').addEventListener('click', stopFitting);
    container.querySelector('#kk-run-btn').addEventListener('click', runKK);
    container.querySelector('#clear-cache-link')?.addEventListener('click', e => { e.preventDefault(); runFitting(); });
    container.querySelector('#fit-modal-close').addEventListener('click', closeModal);
    container.querySelector('#fit-modal').addEventListener('click', e => {
      if (e.target === e.currentTarget) closeModal();
    });
    container.querySelector('#weighting-select').addEventListener('change', e => {
      setState({ fitWeighting: e.target.value });
    });
    container.querySelector('#solver-select').addEventListener('change', e => {
      setState({ fitSolver: e.target.value });
    });
    container.querySelector('#omit-inductive-cb').addEventListener('change', e => {
      setState({ omitInductive: e.target.checked });
    });
    container.querySelector('#bin-by-select')?.addEventListener('change', e => {
      binByField = e.target.value;
      rebuildGrid();
    });
    container.querySelector('#sort-best-cb')?.addEventListener('change', e => {
      sortByBest = e.target.checked;
      rebuildGrid();
    });

    wireTileClicks();
  }

  // ── Tile building ──────────────────────────────────────────────────────────

  function buildTileGrid(files) {
    if (!files.length) return '';
    const groups = groupFiles(files);
    return [...groups.entries()].map(([, { label, files: gFiles }]) => {
      let displayFiles = [...gFiles];
      if (sortByBest) {
        displayFiles.sort((a, b) => {
          const ca = resultMap.get(a.path)?.circuit_used ?? '￿';
          const cb = resultMap.get(b.path)?.circuit_used ?? '￿';
          return ca.localeCompare(cb);
        });
      }
      if (binByField) {
        const bins = new Map();
        for (const f of displayFiles) {
          const char = resultMap.get(f.path)?.characterization ?? charMap.get(f.path) ?? {};
          const val = String(char[binByField] ?? 'N/A');
          if (!bins.has(val)) bins.set(val, []);
          bins.get(val).push(f);
        }
        const sortedBins = [...bins.entries()].sort(([a], [b]) => {
          const na = parseFloat(a), nb = parseFloat(b);
          return !isNaN(na) && !isNaN(nb) ? na - nb : a.localeCompare(b);
        });
        return `
          <div class="fit-group">
            <div class="fit-group-header">${label}</div>
            <div class="fit-subgroup-row">
              ${sortedBins.map(([val, binFiles]) => `
                <div class="fit-subgroup">
                  <div class="fit-subgroup-header">${binByField}: ${val}</div>
                  <div class="fit-tile-row">
                    ${binFiles.map(f => buildTile(f.filename, f.path)).join('')}
                  </div>
                </div>
              `).join('')}
            </div>
          </div>`;
      }
      return `
        <div class="fit-group">
          <div class="fit-group-header">${label}</div>
          <div class="fit-tile-row">
            ${displayFiles.map(f => buildTile(f.filename, f.path)).join('')}
          </div>
        </div>`;
    }).join('');
  }

  function buildTile(filename, path) {
    const safeId    = pathToSafeId(path);
    const fitResult = resultMap.get(path);
    const kkResult  = kkMap.get(path);

    // KK view takes priority when KK was the most recently run operation
    if (_activeView === 'kk' && kkResult) {
      return _kkTileHTML(filename, path, safeId, kkResult);
    }
    if (fitResult) {
      return _fitTileHTML(filename, path, safeId, fitResult);
    }
    // KK as fallback when no fit result yet
    if (kkResult) {
      return _kkTileHTML(filename, path, safeId, kkResult);
    }
    return `<div class="fit-tile pending" data-path="${path}" id="tile-${safeId}">
      <div class="fit-tile-name">${filename}</div>
      <div class="fit-tile-pct">—</div>
    </div>`;
  }

  function _fitTileHTML(filename, path, safeId, result) {
    const good = result.success && result.residual != null && result.residual < GOOD_THRESHOLD;
    const cls  = result.success ? (good ? 'good' : 'poor') : 'failed';
    const pct  = result.residual != null ? `${(result.residual * 100).toFixed(1)}%` : '—';
    return `<div class="fit-tile ${cls}" data-path="${path}" id="tile-${safeId}">
      <div class="fit-tile-name">${filename}</div>
      <div class="fit-tile-pct">${result.success ? pct : 'FAILED'}</div>
    </div>`;
  }

  function _kkTileHTML(filename, path, safeId, kk) {
    const { cls, label } = kkTileState(kk);
    const rs  = kk.rs_estimate;
    const lf  = kk.lf_intercept;
    const r1  = rs != null && lf != null ? (lf - rs) * 1000 : null;
    const rsSub = rs != null
      ? `<div class="fit-tile-sub">Rs≈${(rs * 1000).toFixed(1)} mΩ${r1 != null ? ` · R₁≈${r1.toFixed(1)} mΩ` : ''}</div>`
      : '';
    return `<div class="fit-tile ${cls}" data-path="${path}" id="tile-${safeId}">
      <div class="fit-tile-name">${filename}</div>
      <div class="fit-tile-pct">${label}</div>
      ${rsSub}
    </div>`;
  }

  function wireTileClicks() {
    container.querySelectorAll('.fit-tile:not(.pending)').forEach(el => {
      el.addEventListener('click', () => {
        const path = el.dataset.path;
        // Route based on what the tile is visually showing, not just map presence
        const isKKTile = el.classList.contains('kk-ok') ||
                         el.classList.contains('kk-warn') ||
                         el.classList.contains('kk-fail');
        if (isKKTile) {
          const kkResult = kkMap.get(path);
          if (kkResult) openKKModal(kkResult);
        } else {
          const fitResult = resultMap.get(path);
          if (fitResult) openFitModal(fitResult);
        }
      });
    });
  }

  // Live update helpers called during streaming

  function updateFitTile(fitResult, path) {
    const safeId = pathToSafeId(path);
    const el = container.querySelector(`#tile-${safeId}`);
    if (!el) return;
    // Replace entire inner HTML so any KK sub-line is also removed
    el.outerHTML = _fitTileHTML(
      el.querySelector('.fit-tile-name')?.textContent ?? '',
      path, safeId, fitResult,
    );
    // Re-query since outerHTML replaced the element
    const fresh = container.querySelector(`#tile-${safeId}`);
    if (fresh) fresh.addEventListener('click', () => openFitModal(fitResult));
  }

  function updateKKTile(kkResult, path) {
    // KK always overrides — this is the point: re-running KK after fitting shows KK state
    const safeId = pathToSafeId(path);
    const el = container.querySelector(`#tile-${safeId}`);
    if (!el) return;
    el.outerHTML = _kkTileHTML(
      el.querySelector('.fit-tile-name')?.textContent ?? '',
      path, safeId, kkResult,
    );
    const fresh = container.querySelector(`#tile-${safeId}`);
    if (fresh) fresh.addEventListener('click', () => openKKModal(kkResult));
  }

  // ── KK modal ───────────────────────────────────────────────────────────────

  function openKKModal(kk) {
    const modal    = container.querySelector('#fit-modal');
    const titleEl  = container.querySelector('#fit-modal-title');
    const badgeEl  = container.querySelector('#fit-modal-badge');
    const metaEl   = container.querySelector('#fit-modal-meta');
    const plotEl   = container.querySelector('#fit-modal-plot');
    const paramsEl = container.querySelector('#fit-modal-params');
    const tabsEl   = container.querySelector('#fit-modal-tabs');

    titleEl.textContent = kk.filename;

    // Badge
    const { cls: kkCls, label: kkLabel } = kkTileState(kk);
    const badgeClass = kkCls === 'kk-ok' ? 'good' : kkCls === 'kk-warn' ? 'poor' : 'failed';
    badgeEl.className = `residual-badge ${badgeClass}`;
    badgeEl.textContent = kk.success ? kkLabel : 'KK ✗';

    // Meta line
    const metaParts = [];
    if (kk.M  != null) metaParts.push(`M = ${kk.M} RC elements`);
    if (kk.mu != null) metaParts.push(`μ = ${kk.mu.toFixed(3)}`);
    if (kk.rs_estimate != null) metaParts.push(`Rs ≈ ${(kk.rs_estimate * 1000).toFixed(2)} mΩ`);
    if (kk.lf_intercept != null && kk.rs_estimate != null)
      metaParts.push(`R₁ ≈ ${((kk.lf_intercept - kk.rs_estimate) * 1000).toFixed(2)} mΩ`);
    if (kk.error)      metaParts.push(kk.error);
    metaEl.textContent = metaParts.join(' · ');

    // Tabs: Nyquist (KK) + Residuals
    tabsEl.innerHTML = '';
    [
      { id: 'kk-nyquist',   label: 'Nyquist (KK)' },
      { id: 'kk-residuals', label: 'KK Residuals' },
    ].forEach(({ id, label }, idx) => {
      const btn = document.createElement('button');
      btn.className = `tab-btn${idx === 0 ? ' active' : ''}`;
      btn.dataset.tab = id;
      btn.textContent = label;
      tabsEl.appendChild(btn);
    });

    tabsEl.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        plotEl.innerHTML = '';
        requestAnimationFrame(() => {
          if (btn.dataset.tab === 'kk-nyquist') plotKKNyquist(kk, plotEl);
          else                                   plotKKResiduals(kk, plotEl);
        });
      });
    });

    // Bottom action: apply suggested range
    paramsEl.innerHTML = '';
    const hints = [];
    if (kk.freq_min_suggest != null)
      hints.push(`Freq: ${kk.freq_min_suggest.toPrecision(3)} – ${kk.freq_max_suggest.toPrecision(3)} Hz`);
    if (kk.rs_estimate != null)
      hints.push(`Rs ≈ ${(kk.rs_estimate * 1000).toFixed(2)} mΩ seeds R0`);
    if (kk.lf_intercept != null && kk.rs_estimate != null)
      hints.push(`R₁ ≈ ${((kk.lf_intercept - kk.rs_estimate) * 1000).toFixed(2)} mΩ seeds R1`);

    if (hints.length) {
      paramsEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
          <span style="font-size:12px;color:var(--text-muted);">${hints.join(' · ')}</span>
          ${kk.freq_min_suggest != null ? `<button class="btn btn-secondary" id="modal-kk-apply" style="font-size:12px;padding:4px 12px;">Apply freq range globally</button>` : ''}
        </div>`;
      container.querySelector('#modal-kk-apply')?.addEventListener('click', () => {
        const minEl = container.querySelector('#freq-min');
        const maxEl = container.querySelector('#freq-max');
        if (minEl) minEl.value = kk.freq_min_suggest;
        if (maxEl) maxEl.value = kk.freq_max_suggest;
        closeModal();
        showToast('Global freq range updated — per-file ranges from KK are still used automatically.', 'success');
      });
    }

    plotEl.innerHTML = '';
    modal.style.display = 'flex';
    requestAnimationFrame(() => plotKKNyquist(kk, plotEl));
  }

  function plotKKNyquist(kk, el) {
    if (!el || typeof Plotly === 'undefined') return;
    if (!kk.z_real?.length) {
      el.innerHTML = '<p style="color:var(--text-muted);padding:24px;">No impedance data available.</p>';
      return;
    }

    const flagged = new Set(kk.flagged_indices || []);
    const goodIdx = kk.z_real.map((_, i) => i).filter(i => !flagged.has(i));
    const badIdx  = [...flagged];

    const traces = [{
      x: goodIdx.map(i => kk.z_real[i]),
      y: goodIdx.map(i => -kk.z_imag[i]),
      mode: 'markers', name: 'Compliant',
      marker: { color: '#4caf7d', size: 7 },
      text: goodIdx.map(i => `${kk.frequencies[i] != null ? kk.frequencies[i].toPrecision(4) : ''} Hz`),
      hovertemplate: "%{text}<br>Z'=%{x:.4g} Ω<br>-Z''=%{y:.4g} Ω<extra></extra>",
    }];

    if (badIdx.length) {
      traces.push({
        x: badIdx.map(i => kk.z_real[i]),
        y: badIdx.map(i => -kk.z_imag[i]),
        mode: 'markers', name: 'Flagged (|KK res| > 1%)',
        marker: { color: '#e05c5c', size: 10, symbol: 'x', line: { color: '#e05c5c', width: 2 } },
        text: badIdx.map(i => `${kk.frequencies[i] != null ? kk.frequencies[i].toPrecision(4) : ''} Hz (flagged)`),
        hovertemplate: "%{text}<br>Z'=%{x:.4g} Ω<br>-Z''=%{y:.4g} Ω<extra></extra>",
      });
    }

    // ── HF / LF real-axis intercept annotations ──────────────────────────────
    // Sort indices by frequency so we can find the actual HF/LF endpoints.
    const n = kk.frequencies.length;
    const sortedByFreq = [...Array(n).keys()].sort((a, b) => kk.frequencies[b] - kk.frequencies[a]);
    const hfIdx = sortedByFreq[0];          // highest frequency data point
    const lfIdx = sortedByFreq[n - 1];      // lowest  frequency data point

    const hfX = kk.rs_estimate;             // interpolated HF intercept on real axis
    const lfX = kk.lf_intercept;            // interpolated LF intercept on real axis

    const hfDataY = -kk.z_imag[hfIdx];     // −Z'' of the HF data endpoint
    const lfDataY = -kk.z_imag[lfIdx];     // −Z'' of the LF data endpoint

    if (hfX != null) {
      const hfMΩ = (hfX * 1000).toFixed(2);
      // Drop-line: from HF data endpoint to the real axis at the HF intercept
      traces.push({
        x: [kk.z_real[hfIdx], hfX],
        y: [hfDataY, 0],
        mode: 'lines', name: 'HF drop',
        line: { color: '#4a9ade', width: 1.5, dash: 'dot' },
        showlegend: false, hoverinfo: 'skip',
      });
      // Intercept marker + label on the real axis
      traces.push({
        x: [hfX], y: [0],
        mode: 'markers+text',
        marker: { color: '#4a9ade', size: 9, symbol: 'diamond',
                  line: { color: 'rgba(255,255,255,0.6)', width: 1 } },
        text: [`Rs≈${hfMΩ} mΩ`],
        textposition: 'top right',
        textfont: { color: '#4a9ade', size: 10 },
        name: `Rs ≈ ${hfMΩ} mΩ`,
        hovertemplate: `HF intercept<br>Rs ≈ ${hfMΩ} mΩ<extra></extra>`,
        showlegend: true,
      });
    }

    if (lfX != null) {
      const lfMΩ  = (lfX * 1000).toFixed(2);
      const r1Est = hfX != null ? ((lfX - hfX) * 1000).toFixed(2) : null;
      const r1Label = r1Est != null ? ` (R₁≈${r1Est} mΩ)` : '';
      // Drop-line: from LF data endpoint to the real axis at the LF intercept
      traces.push({
        x: [kk.z_real[lfIdx], lfX],
        y: [lfDataY, 0],
        mode: 'lines', name: 'LF drop',
        line: { color: '#4a9ade', width: 1.5, dash: 'dot' },
        showlegend: false, hoverinfo: 'skip',
      });
      // Intercept marker + label on the real axis
      traces.push({
        x: [lfX], y: [0],
        mode: 'markers+text',
        marker: { color: '#4a9ade', size: 9, symbol: 'diamond',
                  line: { color: 'rgba(255,255,255,0.6)', width: 1 } },
        text: [`Rs+R₁≈${lfMΩ} mΩ`],
        textposition: 'top left',
        textfont: { color: '#4a9ade', size: 10 },
        name: `Rs+R₁ ≈ ${lfMΩ} mΩ${r1Label}`,
        hovertemplate: `LF intercept<br>Rs+R₁ ≈ ${lfMΩ} mΩ${r1Label.replace('≈', '≈')}<extra></extra>`,
        showlegend: true,
      });
    }

    Plotly.newPlot(el, traces, {
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      margin: { t: 8, r: 16, b: 48, l: 64 },
      font:   { color: '#8892b0', size: 11 },
      xaxis:  { title: "Z' (Ω)", color: '#8892b0', gridcolor: '#2d3147', zeroline: true, zerolinecolor: '#4a5080' },
      yaxis:  { title: "-Z'' (Ω)", color: '#8892b0', gridcolor: '#2d3147', zeroline: true, zerolinecolor: '#4a5080', scaleanchor: 'x', scaleratio: 1 },
      legend: { x: 0.5, y: 0.95, font: { size: 10 } },
      showlegend: true,
    }, { displayModeBar: false, responsive: true });
  }

  function plotKKResiduals(kk, el) {
    if (!el || typeof Plotly === 'undefined' || !kk.frequencies?.length) {
      el.innerHTML = '<p style="color:var(--text-muted);padding:24px;">No KK residual data.</p>';
      return;
    }

    const flagged = new Set(kk.flagged_indices || []);
    const pointColors = kk.frequencies.map((_, i) =>
      flagged.has(i) ? '#e05c5c' : '#4ecdc4'
    );

    const freqArr = kk.frequencies;
    const f0 = freqArr[0], f1 = freqArr[freqArr.length - 1];

    Plotly.newPlot(el, [
      {
        x: freqArr, y: kk.res_real.map(v => Math.abs(v) * 100),
        mode: 'markers+lines', name: "|ΔZ'| / |Z|",
        marker: { color: pointColors, size: 6 },
        line: { color: '#e05c5c', width: 1 },
        hovertemplate: "%{x:.4g} Hz<br>|ΔZ'|/|Z| = %{y:.3f}%<extra></extra>",
      },
      {
        x: freqArr, y: kk.res_imag.map(v => Math.abs(v) * 100),
        mode: 'markers+lines', name: "|ΔZ''| / |Z|",
        marker: { color: pointColors, size: 6, symbol: 'diamond' },
        line: { color: '#4a9ade', width: 1 },
        hovertemplate: "%{x:.4g} Hz<br>|ΔZ''|/|Z| = %{y:.3f}%<extra></extra>",
      },
      {
        x: [f0, f1], y: [1, 1],
        mode: 'lines', name: '1 % threshold',
        line: { color: '#aaa', dash: 'dot', width: 1.5 },
      },
    ], {
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      margin: { t: 8, r: 16, b: 48, l: 64 },
      font:   { color: '#8892b0', size: 11 },
      xaxis:  { title: 'Frequency (Hz)', type: 'log', color: '#8892b0', gridcolor: '#2d3147', zeroline: false },
      yaxis:  { title: 'KK residual (%)', color: '#8892b0', gridcolor: '#2d3147', zeroline: true, zerolinecolor: '#4a5080' },
      legend: { x: 0.5, y: 0.95, font: { size: 10 } },
      showlegend: true,
    }, { displayModeBar: false, responsive: true });
  }

  // ── Fit modal ──────────────────────────────────────────────────────────────

  function openFitModal(result) {
    const modal    = container.querySelector('#fit-modal');
    const titleEl  = container.querySelector('#fit-modal-title');
    const badgeEl  = container.querySelector('#fit-modal-badge');
    const metaEl   = container.querySelector('#fit-modal-meta');
    const plotEl   = container.querySelector('#fit-modal-plot');
    const paramsEl = container.querySelector('#fit-modal-params');
    const tabsEl   = container.querySelector('#fit-modal-tabs');

    titleEl.textContent = result.filename;

    const good = result.success && result.residual != null && result.residual < GOOD_THRESHOLD;
    badgeEl.className = `residual-badge ${result.success ? (good ? 'good' : 'poor') : 'failed'}`;
    badgeEl.textContent = result.success
      ? `${(result.residual * 100).toFixed(2)}%`
      : 'FAILED';

    const charStr   = Object.entries(result.characterization || {})
      .map(([k, v]) => `${k}: ${typeof v === 'number' ? v.toPrecision(4) : v}`).join(' · ');
    const circuitStr = result.circuit_used ? `Circuit: ${result.circuit_used}` : '';
    metaEl.textContent = [charStr, circuitStr].filter(Boolean).join(' · ');
    if (result.error) metaEl.textContent += (metaEl.textContent ? ' · ' : '') + result.error;

    paramsEl.innerHTML = Object.entries(result.parameters || {})
      .map(([k, v]) => {
        const { scale, unit } = paramUnitInfo(k);
        const disp = typeof v === 'number' ? fmtNum(v * scale) : v;
        const warn = typeof v === 'number' ? checkPhysical(k, v) : null;
        const warnHtml = warn ? ` <span class="param-warn" title="${warn}">⚠</span>` : '';
        return `<span>${k}${warnHtml}</span>${disp}${unit ? ' ' + unit : ''}`;
      }).join(' &nbsp; ');

    // Build tabs
    tabsEl.innerHTML = '';
    const tabDefs = [
      { id: 'nyquist',     label: 'Nyquist' },
      { id: 'bode',        label: 'Bode' },
      { id: 'residuals',   label: 'Residuals' },
      { id: 'parameters',  label: 'Parameters' },
    ];
    if (result.variants_tried?.length > 1)
      tabDefs.push({ id: 'variants', label: `Variants (${result.variants_tried.length})` });
    tabDefs.push({ id: 'diagnostics', label: 'Diagnostics' });

    tabDefs.forEach(({ id, label }, idx) => {
      const btn = document.createElement('button');
      btn.className = `tab-btn${idx === 0 ? ' active' : ''}`;
      btn.dataset.tab = id;
      btn.textContent = label;
      tabsEl.appendChild(btn);
    });

    tabsEl.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        tabsEl.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        plotEl.innerHTML = '';
        requestAnimationFrame(() => {
          const t = btn.dataset.tab;
          if      (t === 'nyquist')     plotNyquist(result, plotEl);
          else if (t === 'bode')        plotBode(result, plotEl);
          else if (t === 'parameters')  plotParameters(result, plotEl);
          else if (t === 'variants')    plotVariants(result, plotEl);
          else if (t === 'diagnostics') plotDiagnostics(result, plotEl);
          else                          plotResiduals(result, plotEl);
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

  // ── KK run ─────────────────────────────────────────────────────────────────

  async function runKK() {
    const state = getState();
    if (!state.files?.length || !state.columnMap) return;

    const kkBtn = container.querySelector('#kk-run-btn');
    kkBtn.disabled = true;
    kkBtn.textContent = 'KK…';

    _activeView = 'kk';
    kkMap.clear();
    rebuildGrid();   // tiles go to pending (or fit state if _activeView were 'fit')
    wireTileClicks();

    const freqMinVal = container.querySelector('#freq-min').value.trim();
    const freqMaxVal = container.querySelector('#freq-max').value.trim();
    const filePaths  = state.files.map(f => f.path);
    const kkResults  = [];

    const request = {
      files:       state.files,
      column_map:  { ...state.columnMap, decimal_places: state.charDecimalPlaces ?? {} },
      freq_min:    freqMinVal !== '' ? parseFloat(freqMinVal) : null,
      freq_max:    freqMaxVal !== '' ? parseFloat(freqMaxVal) : null,
    };

    try {
      for await (const event of streamKK(request)) {
        if (event.event === 'result') {
          const r = event.data;
          const path = filePaths[kkResults.length];
          kkResults.push(r);
          kkMap.set(path, r);
          updateKKTile(r, path);
          await new Promise(resolve => requestAnimationFrame(resolve));
        } else if (event.event === 'done') {
          const nFlagged = kkResults.filter(r => r.success && r.flagged_indices?.length > 0).length;
          const nFail    = kkResults.filter(r => !r.success).length;
          const nOk      = kkResults.length - nFlagged - nFail;
          showToast(
            `KK: ${nOk} compliant · ${nFlagged} flagged · ${nFail} failed`,
            nFail > 0 ? 'error' : nFlagged > 0 ? 'info' : 'success',
          );
        }
      }
    } catch (err) {
      showToast(`KK error: ${err.message}`, 'error');
    }

    // Persist per-file KK data so fitting can use it even after a page re-render
    const kkData = {};
    for (const r of kkResults) {
      if (r.path) {
        kkData[r.path] = {
          freqMin:  r.freq_min_suggest ?? null,
          freqMax:  r.freq_max_suggest ?? null,
          rsEst:    r.rs_estimate      ?? null,
          M:        r.M                ?? null,
          mu:       r.mu               ?? null,
        };
      }
    }
    setState({ kkData });

    kkBtn.disabled = false;
    kkBtn.textContent = 'KK Check';
  }

  // ── Fitting run ────────────────────────────────────────────────────────────

  let _abortCtrl = null;
  let _viewGen   = 0;   // incremented on every onEnter/onLeave; async callbacks capture
                        // their value and bail if it has changed (navigated away + back)

  function stopFitting() { _abortCtrl?.abort(); }
  function onKeyDown(e) { if (e.key === 'Escape') closeModal(); }

  async function runFitting() {
    const state  = getState();
    if (!state.files?.length || !state.columnMap || !state.circuitConfig) return;
    const myGen  = _viewGen;   // snapshot — if user leaves and re-enters, _viewGen changes

    const runBtn        = container.querySelector('#run-btn');
    const stopBtn       = container.querySelector('#stop-btn');
    const nextBtn       = container.querySelector('#next-btn');
    const fitStatus     = container.querySelector('#fit-status');
    const progressBar   = container.querySelector('#progress-bar');
    const progressLabel = container.querySelector('#progress-label');

    const filePaths = state.files.map(f => f.path);
    _abortCtrl = new AbortController();
    runBtn.disabled  = true;
    stopBtn.style.display = '';
    fitStatus.style.display = '';

    resultMap.clear();
    setState({ fitCacheKey: null, fitResults: [] });
    // Rebuild so KK tiles (if any) are still visible while fit is running
    rebuildGrid();

    // Pre-sized array keeps results aligned with filePaths order (important for state reload).
    // Results arrive out of order with parallel fitting, so we index by path lookup.
    const resultsByPath = {};
    const results = new Array(filePaths.length).fill(null);
    let completedCount = 0;
    let stopped = false, gotDone = false;

    const timeout         = parseFloat(container.querySelector('#fit-timeout').value) || 60;
    const freqMinVal      = container.querySelector('#freq-min').value.trim();
    const freqMaxVal      = container.querySelector('#freq-max').value.trim();
    const freqMin         = freqMinVal !== '' ? parseFloat(freqMinVal) : null;
    const freqMax         = freqMaxVal !== '' ? parseFloat(freqMaxVal) : null;
    const weighting      = container.querySelector('#weighting-select').value;
    const solver         = container.querySelector('#solver-select').value;
    const omitInductive  = container.querySelector('#omit-inductive-cb').checked;
    const runCacheKey = configKey({ ...state, fitTimeout: timeout, fitFreqMin: freqMin,
                                   fitFreqMax: freqMax, fitWeighting: weighting, fitSolver: solver,
                                   omitInductive });

    try {
      setState({ fitTimeout: timeout, fitFreqMin: freqMin, fitFreqMax: freqMax,
                 fitWeighting: weighting, fitSolver: solver, omitInductive });

      // Attach per-file KK-derived freq range and Rs estimate to each FileInfo.
      // Per-file values take priority in the backend; global inputs are the fallback.
      const kkData = getState().kkData ?? {};
      const filesWithKK = state.files.map(f => {
        const kk = kkData[f.path];
        return {
          ...f,
          freq_min:    kk?.freqMin  ?? freqMin,
          freq_max:    kk?.freqMax  ?? freqMax,
          rs_estimate: kk?.rsEst    ?? null,
        };
      });

      const request = {
        files:             filesWithKK,
        column_map:        { ...state.columnMap, decimal_places: state.charDecimalPlaces ?? {} },
        circuit_config:    state.circuitConfig,
        fit_timeout:       timeout,
        optimize_config:   state.optimizeConfig ?? { enabled: false },
        freq_min:          freqMin,   // global fallback (backend only uses if per-file is null)
        freq_max:          freqMax,
        weighting:         weighting,
        solver:            solver,
        omit_inductive:    omitInductive,
      };

      for await (const event of streamFitting(request, _abortCtrl.signal)) {
        if (event.event === 'progress') {
          const pct = Math.round((event.index / event.total) * 100);
          progressBar.style.width = `${pct}%`;
          progressLabel.textContent = `Fitting ${event.file} (${event.index + 1} / ${event.total})`;
        } else if (event.event === 'result') {
          const result = event.data;
          const path = result.path;
          const fileIdx = filePaths.indexOf(path);
          if (fileIdx >= 0) results[fileIdx] = result;
          resultsByPath[path] = result;
          completedCount++;
          resultMap.set(path, result);
          updateFitTile(result, path);
          await new Promise(r => requestAnimationFrame(r));
        } else if (event.event === 'done') {
          gotDone = true;
          progressBar.style.width = '100%';
          const ok = results.filter(r => r?.success).length;
          progressLabel.textContent = `Done — ${ok}/${completedCount} successful`;
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        stopped = true;
        const ok = results.filter(r => r?.success).length;
        progressLabel.textContent = `Stopped — ${ok}/${completedCount} completed`;
      } else {
        showToast(`Fitting error: ${err.message}`, 'error');
      }
    } finally {
      _activeView = 'fit';
      const orderedResults = results.filter(r => r !== null);
      // Always persist results — even if the user navigated away, the data is valuable.
      setState({
        fitResults:  orderedResults,
        fitCacheKey: (!stopped && gotDone) ? runCacheKey : null,
        maxStep:     Math.max(state.maxStep, 7),
      });
      // Only touch the DOM if we are still in the same view session.
      // If the user left and came back, onEnter already rendered a fresh view;
      // calling render() here would wipe it. If they're still here, render() will
      // re-enable the run button and update the tile grid from the saved results.
      if (_viewGen === myGen) render();
    }
  }

  // ── Fit plot functions ─────────────────────────────────────────────────────

  function plotNyquist(result, el) {
    if (!el || typeof Plotly === 'undefined') return;

    // Use flex column so the toggle row sits below the plot without shrinking it.
    el.style.display = 'flex';
    el.style.flexDirection = 'column';

    const plotDiv = document.createElement('div');
    plotDiv.style.flex = '1';
    plotDiv.style.minHeight = '0';
    el.appendChild(plotDiv);

    const baseTraces = [];
    if (result.z_real_data?.length) {
      baseTraces.push({ x: result.z_real_data, y: result.z_imag_data.map(v => -v),
        mode: 'markers', type: 'scatter', name: 'Data',
        marker: { color: '#8892b0', size: 5 } });
    }
    if (result.success && result.z_real_fit?.length) {
      baseTraces.push({ x: result.z_real_fit, y: result.z_imag_fit.map(v => -v),
        mode: 'lines', type: 'scatter', name: 'Fit',
        line: { color: 'var(--accent)', width: 2 } });
    }

    const layout = {
      paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
      margin: { t: 8, r: 16, b: 48, l: 64 },
      font:   { color: '#8892b0', size: 11 },
      xaxis:  { title: "Z' (Ω)",  color: '#8892b0', gridcolor: '#2d3147', zeroline: false },
      yaxis:  { title: "-Z'' (Ω)", color: '#8892b0', gridcolor: '#2d3147', zeroline: false, scaleanchor: 'x', scaleratio: 1 },
      legend: { x: 0.7, y: 0.95, font: { size: 10 } },
      showlegend: true,
    };

    Plotly.newPlot(plotDiv, baseTraces, layout, { displayModeBar: false, responsive: true });

    // Envelope toggle — only shown when confidence data exists.
    const hasConf = result.success && result.circuit_used &&
                    result.frequencies?.length &&
                    result.confidence && Object.keys(result.confidence).length > 0;
    if (!hasConf) return;

    const toggleRow = document.createElement('div');
    toggleRow.style.cssText = 'padding:4px 8px;display:flex;align-items:center;gap:8px;flex-shrink:0;';
    toggleRow.innerHTML = `
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted);cursor:pointer;">
        <input type="checkbox" id="nq-env-toggle" style="accent-color:var(--accent);">
        ±1σ envelope
      </label>
      <span id="nq-env-status" style="font-size:11px;color:var(--text-muted);"></span>
    `;
    el.appendChild(toggleRow);

    toggleRow.querySelector('#nq-env-toggle').addEventListener('change', async function () {
      const statusEl = toggleRow.querySelector('#nq-env-status');
      if (!this.checked) {
        Plotly.react(plotDiv, baseTraces, layout);
        return;
      }
      statusEl.textContent = 'Computing…';
      try {
        const resp = await fetch('/api/fit-envelope', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            circuit_string: result.circuit_used,
            parameters:     result.parameters,
            confidence:     result.confidence,
            frequencies:    result.frequencies,
            n_samples:      200,
          }),
        });
        if (!resp.ok) throw new Error('Envelope computation failed');
        const env = await resp.json();
        const envTraces = [
          // Upper bound (invisible line — acts as the "from" for fill='tonexty')
          { x: env.z_real_upper, y: env.z_imag_upper.map(v => -v),
            mode: 'lines', line: { width: 0 }, name: '+1σ', showlegend: false,
            hoverinfo: 'skip' },
          // Lower bound filled back to upper
          { x: env.z_real_lower, y: env.z_imag_lower.map(v => -v),
            mode: 'lines', fill: 'tonexty', fillcolor: 'rgba(78,205,196,0.15)',
            line: { width: 0 }, name: '±1σ', showlegend: true,
            hoverinfo: 'skip' },
        ];
        Plotly.react(plotDiv, [...baseTraces, ...envTraces], layout);
        statusEl.textContent = '';
      } catch (_) {
        statusEl.textContent = 'Failed';
        this.checked = false;
      }
    });
  }

  function plotBode(result, el) {
    if (!el || typeof Plotly === 'undefined') return;
    const freqs = result.frequencies;
    if (!freqs?.length) { el.textContent = 'No frequency data'; return; }
    const dataMag   = result.z_real_data.map((r, i) => Math.sqrt(r**2 + result.z_imag_data[i]**2));
    const dataPhase = result.z_real_data.map((r, i) => Math.atan2(result.z_imag_data[i], r) * 180 / Math.PI);
    const traces = [
      { x: freqs, y: dataMag,   mode: 'markers', name: '|Z| data',   marker: { color: '#8892b0', size: 5 }, xaxis:'x',  yaxis:'y'  },
      { x: freqs, y: dataPhase, mode: 'markers', name: 'Phase data', marker: { color: '#8892b0', size: 5 }, xaxis:'x2', yaxis:'y2' },
    ];
    if (result.success && result.z_real_fit?.length) {
      const fitMag   = result.z_real_fit.map((r, i) => Math.sqrt(r**2 + result.z_imag_fit[i]**2));
      const fitPhase = result.z_real_fit.map((r, i) => Math.atan2(result.z_imag_fit[i], r) * 180 / Math.PI);
      traces.push({ x: freqs, y: fitMag,   mode: 'lines', name: '|Z| fit',   line: { color:'var(--accent)', width:2 },             xaxis:'x',  yaxis:'y'  });
      traces.push({ x: freqs, y: fitPhase, mode: 'lines', name: 'Phase fit', line: { color:'var(--accent)', width:2, dash:'dash' }, xaxis:'x2', yaxis:'y2' });
    }
    const ax = { type:'log', color:'#8892b0', gridcolor:'#2d3147', zeroline:false };
    Plotly.newPlot(el, traces, {
      grid: { rows:2, columns:1, pattern:'independent' },
      paper_bgcolor:'transparent', plot_bgcolor:'transparent',
      margin:{t:8,r:16,b:48,l:64}, font:{color:'#8892b0',size:11},
      xaxis:{...ax, title:'Frequency (Hz)'}, yaxis:{...ax, title:'|Z| (Ω)'},
      xaxis2:{...ax, title:'Frequency (Hz)'}, yaxis2:{type:'linear',color:'#8892b0',gridcolor:'#2d3147',title:'Phase (°)'},
      showlegend: false,
    }, { displayModeBar:false, responsive:true });
  }

  function plotResiduals(result, el) {
    if (!el || typeof Plotly === 'undefined') return;
    if (!result.frequencies?.length || !result.success || !result.z_real_fit?.length) {
      el.textContent = 'No residuals available'; return;
    }
    const realRes = result.z_real_data.map((r, i) => (r - result.z_real_fit[i]) / (Math.abs(r) + 1e-12) * 100);
    const imagRes = result.z_imag_data.map((v, i) => (v - result.z_imag_fit[i]) / (Math.abs(v) + 1e-12) * 100);
    Plotly.newPlot(el, [
      { x: result.frequencies, y: realRes, mode:'markers+lines', name:"Z' residual",  marker:{color:'#e05c5c',size:4}, line:{color:'#e05c5c',width:1} },
      { x: result.frequencies, y: imagRes, mode:'markers+lines', name:"Z'' residual", marker:{color:'#4a9ade',size:4}, line:{color:'#4a9ade',width:1} },
    ], {
      paper_bgcolor:'transparent', plot_bgcolor:'transparent',
      margin:{t:8,r:16,b:48,l:64}, font:{color:'#8892b0',size:11},
      xaxis:{title:'Frequency (Hz)',type:'log',color:'#8892b0',gridcolor:'#2d3147',zeroline:false},
      yaxis:{title:'Residual (%)',color:'#8892b0',gridcolor:'#2d3147',zeroline:true,zerolinecolor:'#4a5080'},
      legend:{x:0.6,y:0.95,font:{size:10}}, showlegend:true,
    }, { displayModeBar:false, responsive:true });
  }

  function plotParameters(result, el) {
    if (!result.success) {
      el.innerHTML = '<p style="color:var(--text-muted);padding:16px 0;">No parameters — fit failed.</p>';
      return;
    }

    const names  = result.param_names?.length ? result.param_names : Object.keys(result.parameters || {});
    const fitted  = result.parameters    || {};
    const initial = result.initial_guess || {};
    const conf    = result.confidence    || {};

    const rows = names.map(name => {
      const { scale, unit } = paramUnitInfo(name);

      const fittedVal  = fitted[name];
      const initVal    = initial[name];
      const confVal    = conf[name];

      const fmt = v => v != null ? fmtNum(v * scale) : '—';

      // Relative change from initial to fitted
      let changePct = null;
      if (fittedVal != null && initVal != null && Math.abs(initVal) > 1e-30) {
        changePct = ((fittedVal - initVal) / Math.abs(initVal)) * 100;
      }
      const changeStr   = changePct != null ? `${changePct >= 0 ? '+' : ''}${changePct.toFixed(1)}%` : '—';
      const changeColor = changePct == null           ? 'color:var(--text-muted)'
                        : Math.abs(changePct) < 20    ? 'color:var(--text-muted)'
                        : Math.abs(changePct) < 200   ? 'color:var(--warning)'
                        :                               'color:var(--accent)';

      const warn     = fittedVal != null ? checkPhysical(name, fittedVal) : null;
      const warnHtml = warn ? ` <span class="param-warn" title="${warn}">⚠</span>` : '';

      // Bar showing relative magnitude of fitted vs initial
      const barPct = (fittedVal != null && initVal != null && initVal > 0)
        ? Math.min(200, Math.max(0, (fittedVal / initVal) * 100))
        : null;
      const barHtml = barPct != null
        ? `<div style="position:relative;height:4px;background:var(--surface2);border-radius:2px;width:80px;margin-top:3px;">
             <div style="position:absolute;left:0;top:0;height:4px;border-radius:2px;
                         width:${Math.min(barPct, 100)}%;background:var(--accent);opacity:0.7;"></div>
             ${barPct > 100 ? `<div style="position:absolute;left:50%;top:0;height:4px;width:2px;background:var(--text-muted);"></div>` : ''}
           </div>`
        : '';

      return `<tr style="border-bottom:1px solid var(--border);">
        <td style="padding:7px 10px;font-family:monospace;font-size:12px;color:var(--accent);white-space:nowrap;">${name}${warnHtml}</td>
        <td style="padding:7px 8px;font-size:11px;color:var(--text-muted);text-align:right;white-space:nowrap;">${unit || '—'}</td>
        <td style="padding:7px 8px;font-size:12px;color:var(--text-muted);text-align:right;font-family:monospace;">${fmt(initVal)}</td>
        <td style="padding:7px 8px;font-size:12px;color:var(--text);text-align:right;font-family:monospace;font-weight:600;">${fmt(fittedVal)}</td>
        <td style="padding:7px 8px;font-size:12px;${changeColor};text-align:right;white-space:nowrap;">${changeStr}</td>
        <td style="padding:7px 8px;font-size:11px;color:var(--text-muted);text-align:right;font-family:monospace;">${confVal != null ? `±${fmtNum(confVal * scale)}` : '—'}</td>
        <td style="padding:7px 10px;">${barHtml}</td>
      </tr>`;
    }).join('');

    el.innerHTML = `
      <div style="overflow-x:auto;overflow-y:auto;max-height:320px;">
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <thead>
            <tr style="position:sticky;top:0;background:var(--surface);z-index:1;">
              <th style="padding:5px 10px;text-align:left;border-bottom:1px solid var(--border);color:var(--text-muted);font-weight:600;">Param</th>
              <th style="padding:5px 8px;text-align:right;border-bottom:1px solid var(--border);color:var(--text-muted);font-weight:600;">Unit</th>
              <th style="padding:5px 8px;text-align:right;border-bottom:1px solid var(--border);color:var(--text-muted);font-weight:600;">Initial</th>
              <th style="padding:5px 8px;text-align:right;border-bottom:1px solid var(--border);color:var(--text-muted);font-weight:600;">Fitted</th>
              <th style="padding:5px 8px;text-align:right;border-bottom:1px solid var(--border);color:var(--text-muted);font-weight:600;">Δ from init</th>
              <th style="padding:5px 8px;text-align:right;border-bottom:1px solid var(--border);color:var(--text-muted);font-weight:600;">±1σ</th>
              <th style="padding:5px 10px;border-bottom:1px solid var(--border);"></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function plotDiagnostics(result, el) {
    if (!result.success) {
      el.innerHTML = '<p style="color:var(--text-muted);padding:16px 0;">No diagnostics — fit failed.</p>';
      return;
    }

    const names = result.param_names || Object.keys(result.parameters || {});
    const conf  = result.confidence  || {};
    const corr  = result.correlation;
    const k     = names.length;
    const N     = result.frequencies?.length ?? 0;
    const dof   = 2 * N - k;   // 2N because real + imag are separate observations

    // ── Fit quality ───────────────────────────────────────────────────────────
    const pct = result.residual != null ? result.residual * 100 : null;
    let qualColor, qualLabel, qualTip;
    if      (pct == null) { qualColor = 'var(--text-muted)'; qualLabel = '—';          qualTip = ''; }
    else if (pct < 1)     { qualColor = 'var(--success)';    qualLabel = 'Excellent';  qualTip = 'Circuit matches data very well.'; }
    else if (pct < 5)     { qualColor = 'var(--success)';    qualLabel = 'Good';       qualTip = 'Fit is within typical EIS noise levels.'; }
    else if (pct < 10)    { qualColor = 'var(--warning)';    qualLabel = 'Acceptable'; qualTip = 'Some systematic deviation — check Residuals tab.'; }
    else                  { qualColor = 'var(--danger)';     qualLabel = 'Poor';       qualTip = 'Large deviation — consider a different circuit topology.'; }

    // ── Parameter constraints ─────────────────────────────────────────────────
    // Full confidence table is in the Parameters tab; here we only flag problems.
    const hasConf = names.some(n => conf[n] != null);
    let constraintHTML = '';
    if (hasConf) {
      const loose = names.filter(n => {
        const v = result.parameters[n], s = conf[n];
        return v != null && s != null && Math.abs(v) > 1e-30 && (s / Math.abs(v)) > 0.5;
      });
      if (loose.length) {
        constraintHTML = `
          <div class="diag-block">
            <div class="diag-block-title" style="color:var(--warning);">⚠ Loosely constrained parameters</div>
            <div class="diag-block-body">
              ${loose.map(n => `<code style="color:var(--accent)">${n}</code>`).join(', ')}
              have relative uncertainty &gt;50 %.
              Consider tightening bounds, removing redundant elements, or running with more restarts.
              (Full ±1σ values are in the <strong>Parameters</strong> tab.)
            </div>
          </div>`;
      } else {
        constraintHTML = `
          <div class="diag-block">
            <div class="diag-block-title" style="color:var(--success);">✓ All parameters well-constrained</div>
            <div class="diag-block-body">Every parameter has relative uncertainty &lt;50 %. See the <strong>Parameters</strong> tab for exact ±1σ values.</div>
          </div>`;
      }
    } else {
      constraintHTML = `
        <div class="diag-block">
          <div class="diag-block-title" style="color:var(--text-muted);">Parameter uncertainty unavailable</div>
          <div class="diag-block-body">The Jacobian was singular or the solver doesn't produce a covariance estimate (Diff. Evo., Basin Hopping). Re-run with LM for uncertainty data.</div>
        </div>`;
    }

    // ── Correlation alerts ────────────────────────────────────────────────────
    let corrHTML = '';
    if (corr && names.length >= 2) {
      const pairs = [];
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const r = corr[i][j];
          if (Math.abs(r) >= 0.7) pairs.push({ a: names[i], b: names[j], r });
        }
      }
      pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));

      if (pairs.length) {
        const rows = pairs.map(({ a, b, r }) => {
          const abs  = Math.abs(r);
          const col  = abs >= 0.9 ? 'var(--danger)' : 'var(--warning)';
          const note = abs >= 0.9
            ? 'very high — optimizer trades one against the other; consider removing one'
            : 'notable — monitor across spectra';
          return `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px;flex-wrap:wrap;">
            <code style="color:var(--accent);white-space:nowrap;">${a} ↔ ${b}</code>
            <span style="font-weight:700;color:${col};">${r >= 0 ? '+' : ''}${r.toFixed(2)}</span>
            <span style="color:var(--text-muted);font-size:11px;">${note}</span>
          </div>`;
        }).join('');

        corrHTML = `
          <div class="diag-block">
            <div class="diag-block-title" style="color:${pairs.some(p => Math.abs(p.r) >= 0.9) ? 'var(--danger)' : 'var(--warning)'};">
              ${pairs.length === 1 ? '1 correlated parameter pair' : `${pairs.length} correlated parameter pairs`}
            </div>
            <div class="diag-block-body" style="margin-bottom:8px;">
              High correlation (|r| ≥ 0.9) means the circuit has more parameters than the data can independently resolve.
              Try simplifying the model or running Auto-Optimize.
            </div>
            ${rows}
          </div>`;
      } else {
        corrHTML = `
          <div class="diag-block">
            <div class="diag-block-title" style="color:var(--success);">✓ Parameters independently identifiable</div>
            <div class="diag-block-body">No strongly correlated pairs (all |r| &lt; 0.7). Each parameter describes a distinct feature of the spectrum.</div>
          </div>`;
      }
    }

    el.innerHTML = `
      <div style="padding:8px 0;display:flex;flex-direction:column;gap:14px;">

        <!-- Fit quality headline -->
        <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;">
          <div style="font-size:32px;font-weight:700;color:${qualColor};line-height:1;">${pct != null ? pct.toFixed(2) + '%' : '—'}</div>
          <div>
            <div style="font-size:14px;font-weight:600;color:${qualColor};">${qualLabel}</div>
            <div style="font-size:11px;color:var(--text-muted);">mean relative residual${qualTip ? ' — ' + qualTip : ''}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:1px;">${k} param${k !== 1 ? 's' : ''} · ${N} freq. points · ${dof} degrees of freedom</div>
          </div>
        </div>

        ${constraintHTML}
        ${corrHTML}

      </div>

      <style>
        .diag-block { padding:10px 12px;border-radius:6px;background:var(--surface); }
        .diag-block-title { font-size:12px;font-weight:600;margin-bottom:4px; }
        .diag-block-body  { font-size:12px;color:var(--text-muted);line-height:1.5; }
      </style>`;
  }

  function plotVariants(result, el) {
    const variants = result.variants_tried || [];
    if (!variants.length) {
      el.innerHTML = '<p style="color:var(--text-muted);padding:16px 0;">No variant data available.</p>';
      return;
    }
    const criterion = ((getState().optimizeConfig?.criterion) ?? 'AIC').toLowerCase();
    const succV     = variants.filter(v => v.success && v[criterion] != null);
    const bestScore = succV.length ? Math.min(...succV.map(v => v[criterion])) : null;
    const bestAic   = Math.min(...variants.filter(v => v.success && v.aic != null).map(v => v.aic));
    const bestBic   = Math.min(...variants.filter(v => v.success && v.bic != null).map(v => v.bic));

    el.innerHTML = `
      <div style="overflow-x:auto;overflow-y:auto;max-height:280px;">
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
            ${variants.map(v => {
              const isWinner = v.success && bestScore != null && v[criterion] === bestScore;
              const bg       = isWinner ? 'background:rgba(100,220,150,0.07);' : '';
              const opacity  = v.success ? '' : 'opacity:0.45;';
              const resText  = v.residual != null ? `${(v.residual * 100).toFixed(2)}%` : (v.error ?? '—');
              const dAic     = v.aic != null && isFinite(bestAic) ? `+${(v.aic - bestAic).toFixed(1)}` : '—';
              const dBic     = v.bic != null && isFinite(bestBic) ? `+${(v.bic - bestBic).toFixed(1)}` : '—';
              return `<tr style="${bg}${opacity}">
                <td style="padding:4px 10px;font-family:monospace;font-size:11px;color:var(--accent);">${v.circuit_string}</td>
                <td style="text-align:right;padding:4px 8px;">${v.n_params}</td>
                <td style="text-align:right;padding:4px 8px;">${resText}</td>
                <td style="text-align:right;padding:4px 8px;">${isWinner ? '0' : dAic}</td>
                <td style="text-align:right;padding:4px 8px;">${isWinner ? '0' : dBic}</td>
                <td style="text-align:center;padding:4px 8px;color:#64dc96;font-size:14px;">${isWinner ? '★' : ''}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  return {
    async onEnter() {
      const myGen = ++_viewGen;   // new session — invalidates any stale callbacks

      // Idempotent: remove first so repeated onEnter calls never stack listeners.
      document.removeEventListener('keydown', onKeyDown);
      document.addEventListener('keydown', onKeyDown);

      render();

      const s = getState();

      if (s.fitFreqMin === null && s.fitFreqMax === null && s.files?.length && s.columnMap?.frequency) {
        try {
          const res = await fetch('/api/freq-range', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: s.files[0].path, frequency_column: s.columnMap.frequency }),
          });
          if (res.ok && _viewGen === myGen) {
            const { freq_min, freq_max } = await res.json();
            const minEl = container.querySelector('#freq-min');
            const maxEl = container.querySelector('#freq-max');
            if (minEl) minEl.value = freq_min;
            if (maxEl) maxEl.value = freq_max;
          }
        } catch (_) {}
      }

      if (s.files?.length && s.columnMap) {
        try {
          const data = await characterizeFiles({
            files: s.files,
            column_map: { ...s.columnMap, decimal_places: s.charDecimalPlaces ?? {} },
          });
          if (_viewGen !== myGen) return;   // navigated away during the fetch — drop it
          charMap.clear();
          for (const { path, characterization } of data) charMap.set(path, characterization);
          if (!binByField) {
            const fields = getCharFields();
            if (fields.length) binByField = fields[0];
          }
          render();
        } catch (_) {}
      }
    },
    onLeave() {
      ++_viewGen;              // invalidate all pending async callbacks from this session
      _abortCtrl?.abort();     // stop any in-progress fit
      document.removeEventListener('keydown', onKeyDown);
    },
  };
}
