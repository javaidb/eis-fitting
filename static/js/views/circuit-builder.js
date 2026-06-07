import { getState, setState } from '../state.js';

// ── Layout constants ─────────────────────────────────────────────
const COMP_W = 82;
const COMP_H = 34;
const H_GAP  = 28;
const V_GAP  = 14;
const BUS_W  = 18;   // horizontal stub on each side of parallel group
const PAD    = 24;
const WIRE_EXT = 26;

const COLORS = {
  R: '#e05c5c', C: '#4a9ade', L: '#9b59b6',
  CPE: '#e67e22', W: '#27ae60', Wo: '#1abc9c', Ws: '#16a085',
};

// Mirror of backend _strip_rc_pairs — used for the frame preview in optimize mode.
function stripRcPairsFn(s) {
  let r = s, prev;
  do {
    prev = r;
    r = r.replace(/-p\(R\d+,(?:CPE|C)\d+\)/g, '')
         .replace(/p\(R\d+,(?:CPE|C)\d+\)-/g, '')
         .replace(/^p\(R\d+,(?:CPE|C)\d+\)$/g, '');
  } while (r !== prev);
  return r.replace(/^-+|-+$/g, '') || '—';
}

// ── ID counter ───────────────────────────────────────────────────
let _idCounter = 0;
function newId() { return `n${++_idCounter}`; }

// ── Module state ─────────────────────────────────────────────────
let nodes       = [];
let history     = [];
let histPtr     = -1;
let selectedId  = null;
let dragState   = null;  // { source: 'palette'|'canvas', element?, nodeId? }
let ghostEl     = null;
let activeDZId  = null;
let dropZones   = [];    // [{id, type, nodeId?, x, y, w, h, mutate?: (newNode) => void}]

let _container, _navigate, _showToast;
let _elements = [];

// ── Tree helpers ─────────────────────────────────────────────────
function treeToString(ns, counters = {}) {
  return ns.map(n => {
    if (n.type === 'component') {
      const idx = counters[n.element] ?? 0;
      counters[n.element] = idx + 1;
      return `${n.element}${idx}`;
    }
    const branches = n.branches.map(b => treeToString(b, counters)).join(',');
    return `p(${branches})`;
  }).join('-');
}

function stringToTree(str) {
  // Simple recursive descent parser for impedance.py circuit string format
  str = str.trim();
  if (!str) return [];

  function parseSeq(s, pos) {
    const parts = [];
    while (pos < s.length) {
      if (s[pos] === ')' || s[pos] === ',') break;
      const [node, newPos] = parseNode(s, pos);
      parts.push(node);
      pos = newPos;
      if (pos < s.length && s[pos] === '-') pos++;
    }
    return [parts, pos];
  }

  function parseNode(s, pos) {
    if (s.startsWith('p(', pos)) {
      pos += 2;
      const branches = [];
      while (pos < s.length && s[pos] !== ')') {
        const [branch, newPos] = parseSeq(s, pos);
        branches.push(branch);
        pos = newPos;
        if (pos < s.length && s[pos] === ',') pos++;
      }
      if (s[pos] === ')') pos++;
      return [{ id: newId(), type: 'parallel', branches }, pos];
    }
    // Component token
    const match = s.slice(pos).match(/^([A-Za-z]+)\d*/);
    if (!match) throw new Error(`Parse error at pos ${pos}: "${s.slice(pos)}"`);
    const element = match[1];
    pos += match[0].length;
    return [{ id: newId(), type: 'component', element }, pos];
  }

  const [result] = parseSeq(str, 0);
  return result;
}

// ── History ──────────────────────────────────────────────────────
function saveHistory() {
  history = history.slice(0, histPtr + 1);
  history.push(JSON.parse(JSON.stringify(nodes)));
  histPtr = history.length - 1;
}

function undo() {
  if (histPtr > 0) { histPtr--; nodes = JSON.parse(JSON.stringify(history[histPtr])); renderCircuit(); syncString(); }
}
function redo() {
  if (histPtr < history.length - 1) { histPtr++; nodes = JSON.parse(JSON.stringify(history[histPtr])); renderCircuit(); syncString(); }
}

// ── Mutations ────────────────────────────────────────────────────
function insertAt(pos, node) {
  saveHistory();
  nodes = [...nodes.slice(0, pos), node, ...nodes.slice(pos)];
  selectedId = node.id;
  renderCircuit(); syncString();
}

function deleteNodeById(id) {
  saveHistory();
  function removeFrom(ns) {
    return ns
      .filter(n => n.id !== id)
      .map(n => n.type === 'parallel'
        ? { ...n, branches: n.branches.map(b => removeFrom(b)).filter(b => b.length > 0) }
        : n);
  }
  nodes = removeFrom(nodes);
  // Unwrap single-branch parallels
  function unwrap(ns) {
    return ns.flatMap(n => {
      if (n.type === 'parallel' && n.branches.length === 1) return unwrap(n.branches[0]);
      if (n.type === 'parallel') return [{ ...n, branches: n.branches.map(unwrap) }];
      return [n];
    });
  }
  nodes = unwrap(nodes);
  selectedId = null;
  renderCircuit(); syncString();
}

function makeParallelWith(id1, id2) {
  saveHistory();
  const n1 = nodes.find(n => n.id === id1);
  const n2 = nodes.find(n => n.id === id2);
  if (!n1 || !n2) return;
  const pg = { id: newId(), type: 'parallel', branches: [[n1], [n2]] };
  const i = nodes.indexOf(n1);
  nodes = nodes.filter(n => n.id !== id1 && n.id !== id2);
  nodes.splice(i, 0, pg);
  selectedId = pg.id;
  renderCircuit(); syncString();
}

function addBranchToGroup(groupId) {
  saveHistory();
  function addBranch(ns) {
    return ns.map(n => {
      if (n.id === groupId) {
        const newNode = { id: newId(), type: 'component', element: 'R' };
        return { ...n, branches: [...n.branches, [newNode]] };
      }
      if (n.type === 'parallel') return { ...n, branches: n.branches.map(b => addBranch(b)) };
      return n;
    });
  }
  nodes = addBranch(nodes);
  renderCircuit(); syncString();
}

function dropToGap(position, element) {
  insertAt(position, { id: newId(), type: 'component', element });
}

function dropOnComponent(targetId, element) {
  // Create parallel group: existing + new
  const newComp = { id: newId(), type: 'component', element };
  const existing = nodes.find(n => n.id === targetId);
  if (existing) makeParallelWith_new(targetId, newComp);
}

// Search the tree recursively and return { arr, idx } where arr[idx] has the given id.
// arr is the actual live array (top-level nodes or a branch), so splice on it works directly.
function findInTree(ns, id) {
  for (let i = 0; i < ns.length; i++) {
    if (ns[i].id === id) return { arr: ns, idx: i };
    if (ns[i].type === 'parallel') {
      for (const branch of ns[i].branches) {
        const hit = findInTree(branch, id);
        if (hit) return hit;
      }
    }
  }
  return null;
}

function makeParallelWith_new(existingId, newNode) {
  const hit = findInTree(nodes, existingId);
  if (!hit) return;
  const existing = hit.arr[hit.idx];
  const pg = { id: newId(), type: 'parallel', branches: [[existing], [newNode]] };
  hit.arr.splice(hit.idx, 1, pg);   // replace in the actual parent array, any depth
  selectedId = pg.id;
  renderCircuit(); syncString();
}

// ── Measure ──────────────────────────────────────────────────────
function measureNode(n) {
  if (n.type === 'component') return { w: COMP_W, h: COMP_H };
  const bs = n.branches.map(b => measureSeries(b));
  const maxW = Math.max(...bs.map(s => s.w), COMP_W);
  const totalH = bs.reduce((s, x) => s + x.h, 0) + Math.max(0, bs.length - 1) * V_GAP;
  return { w: maxW + BUS_W * 2, h: Math.max(totalH, COMP_H) };
}

function measureSeries(ns) {
  if (!ns.length) return { w: 0, h: COMP_H };
  const sizes = ns.map(measureNode);
  const w = sizes.reduce((s, sz) => s + sz.w, 0) + Math.max(0, ns.length - 1) * H_GAP;
  const h = Math.max(...sizes.map(sz => sz.h));
  return { w, h };
}

// ── Render ───────────────────────────────────────────────────────
function renderCircuit() {
  const svg = _container.querySelector('#circuit-svg');
  if (!svg) return;

  dropZones = [];
  const counters = {};

  const size = measureSeries(nodes);
  const totalW = Math.max(size.w, 20);
  const totalH = Math.max(size.h, COMP_H);
  const svgW  = 2 * PAD + 2 * WIRE_EXT + totalW;
  const svgH  = 2 * PAD + totalH;
  const cy    = PAD + totalH / 2;
  const startX = PAD + WIRE_EXT;

  let html = `<defs>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="2" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>`;

  // Terminal wires
  html += `<line class="wire-line" x1="${PAD}" y1="${cy}" x2="${startX}" y2="${cy}"/>`;

  const { html: seriesHtml, endX } = buildSeriesHtml(nodes, startX, cy, counters);
  html += seriesHtml;

  html += `<line class="wire-line" x1="${endX}" y1="${cy}" x2="${endX + WIRE_EXT}" y2="${cy}"/>`;

  // Terminal dots
  html += `<circle cx="${PAD}" cy="${cy}" r="4" fill="var(--border-light)"/>`;
  html += `<circle cx="${endX + WIRE_EXT}" cy="${cy}" r="4" fill="var(--border-light)"/>`;

  // Drop zones (only shown while dragging)
  if (dragState) {
    for (const dz of dropZones) {
      const active = activeDZId === dz.id;
      html += `<rect class="drop-zone ${active ? 'active' : ''}" data-dz-id="${dz.id}"
        x="${dz.x}" y="${dz.y}" width="${dz.w}" height="${dz.h}" rx="3"/>`;
    }
  }

  // Empty state hint
  if (!nodes.length) {
    html += `<text class="empty-hint" x="${svgW / 2}" y="${svgH / 2 - 8}">← Drag or click components to build your circuit</text>`;
  }

  svg.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
  svg.style.height = `${Math.max(svgH, 80)}px`;
  svg.innerHTML = html;

  // Attach events after innerHTML is set
  svg.querySelectorAll('[data-node-id]').forEach(el => {
    el.style.cursor = 'pointer';
    el.addEventListener('mousedown', e => {
      e.stopPropagation();
      startCanvasDrag(e, el.dataset.nodeId);
    });
    el.addEventListener('click', e => {
      e.stopPropagation();
      selectedId = el.dataset.nodeId === selectedId ? null : el.dataset.nodeId;
      renderCircuit();
    });
  });

  svg.querySelectorAll('.delete-btn').forEach(el => {
    el.addEventListener('click', e => { e.stopPropagation(); deleteNodeById(el.dataset.deleteId); });
  });

  svg.querySelectorAll('.add-branch-btn').forEach(el => {
    el.addEventListener('click', e => { e.stopPropagation(); addBranchToGroup(el.dataset.groupId); });
  });

  svg.addEventListener('click', () => { selectedId = null; renderCircuit(); });
}

// Builds SVG HTML for a series chain and returns endX.
// `ns` is the actual live array (top-level `nodes` or a branch array);
// mutate closures capture it directly so drops into sub-branches work.
function buildSeriesHtml(ns, startX, cy, counters) {
  let x = startX;
  let html = '';

  // Gap drop zone before first element
  dropZones.push({
    id: `gap-0-${startX}`, type: 'gap',
    x: x - 12, y: cy - COMP_H, w: 24, h: COMP_H * 2,
    mutate: (newNode) => ns.splice(0, 0, newNode),
  });

  for (let i = 0; i < ns.length; i++) {
    const node = ns[i];
    const size = measureNode(node);

    if (node.type === 'component') {
      html += buildComponentHtml(node, x, cy, counters);
    } else {
      html += buildParallelHtml(node, x, cy, counters);
    }

    x += size.w;

    if (i < ns.length - 1) {
      // Wire and gap drop zone between elements.
      // `i` is captured per-iteration by `let` — closure is correct.
      const insertAt = i + 1;
      const gapX = x;
      dropZones.push({
        id: `gap-${insertAt}-${startX}`, type: 'gap',
        x: gapX + 2, y: cy - COMP_H, w: H_GAP - 4, h: COMP_H * 2,
        mutate: (newNode) => ns.splice(insertAt, 0, newNode),
      });
      html += `<line class="wire-line" x1="${gapX}" y1="${cy}" x2="${gapX + H_GAP}" y2="${cy}"/>`;
      x += H_GAP;
    }
  }

  // Gap drop zone after last element
  dropZones.push({
    id: `gap-end-${startX}`, type: 'gap',
    x: x + 2, y: cy - COMP_H, w: 22, h: COMP_H * 2,
    mutate: (newNode) => ns.splice(ns.length, 0, newNode),
  });

  return { html, endX: x };
}

function buildComponentHtml(node, x, cy, counters) {
  const el  = node.element;
  const idx = counters[el] ?? 0;
  counters[el] = idx + 1;
  const label   = `${el}${idx}`;
  const color   = COLORS[el] || '#888';
  const selected = node.id === selectedId;

  // Drop zone: on-component (for making parallel)
  dropZones.push({ id: `comp-${node.id}`, type: 'on-component', nodeId: node.id, x, y: cy - COMP_H / 2, w: COMP_W, h: COMP_H });

  let html = `<g data-node-id="${node.id}">`;
  html += `<rect class="comp-box" x="${x}" y="${cy - COMP_H / 2}" width="${COMP_W}" height="${COMP_H}"
    stroke="${color}" rx="6" ry="6" stroke-width="${selected ? 2.5 : 2}"
    ${selected ? `filter="url(#glow)"` : ''}/>`;
  html += `<text class="comp-label" x="${x + COMP_W / 2}" y="${cy - 1}" fill="${color}">${label}</text>`;

  if (selected) {
    html += `<g class="delete-btn" data-delete-id="${node.id}">
      <circle cx="${x + COMP_W + 2}" cy="${cy - COMP_H / 2 - 2}" r="8"/>
      <text x="${x + COMP_W + 2}" y="${cy - COMP_H / 2 - 1}" class="delete-btn">✕</text>
    </g>`;
  }

  html += `</g>`;
  return html;
}

function buildParallelHtml(node, x, cy, counters) {
  const branchSizes = node.branches.map(b => measureSeries(b));
  const maxBW  = Math.max(...branchSizes.map(s => s.w), COMP_W);
  const totalH = branchSizes.reduce((s, sz) => s + sz.h, 0) + Math.max(0, branchSizes.length - 1) * V_GAP;
  const groupW = maxBW + BUS_W * 2;

  const topY   = cy - totalH / 2;
  const botY   = cy + totalH / 2;
  const leftX  = x;
  const rightX = x + groupW;

  const firstCY = topY + branchSizes[0].h / 2;
  const lastCY  = botY - branchSizes[branchSizes.length - 1].h / 2;
  const selected = node.id === selectedId;

  let html = `<g data-node-id="${node.id}">`;

  // Bus bars
  html += `<line class="bus-bar" x1="${leftX}" y1="${firstCY}" x2="${leftX}" y2="${lastCY}"
    ${selected ? `stroke="var(--accent)"` : ''}/>`;
  html += `<line class="bus-bar" x1="${rightX}" y1="${firstCY}" x2="${rightX}" y2="${lastCY}"
    ${selected ? `stroke="var(--accent)"` : ''}/>`;

  // Branches
  let branchY = topY;
  for (let i = 0; i < node.branches.length; i++) {
    const branchSize = branchSizes[i];
    const branchCY   = branchY + branchSize.h / 2;
    const branchX    = leftX + BUS_W;

    html += `<line class="wire-line" x1="${leftX}" y1="${branchCY}" x2="${branchX}" y2="${branchCY}"/>`;
    const { html: branchHtml, endX: branchEndX } = buildSeriesHtml(node.branches[i], branchX, branchCY, counters);
    html += branchHtml;
    html += `<line class="wire-line" x1="${branchEndX}" y1="${branchCY}" x2="${rightX}" y2="${branchCY}"/>`;

    branchY += branchSize.h + V_GAP;
  }

  // Add-branch button
  html += `<g class="add-branch-btn" data-group-id="${node.id}">
    <rect x="${leftX + groupW / 2 - 42}" y="${botY + 5}" width="84" height="18" rx="4" ry="4"/>
    <text x="${leftX + groupW / 2}" y="${botY + 14}">+ branch</text>
  </g>`;

  if (selected) {
    html += `<g class="delete-btn" data-delete-id="${node.id}">
      <circle cx="${rightX + 2}" cy="${topY - 2}" r="8"/>
      <text x="${rightX + 2}" y="${topY - 1}" class="delete-btn">✕</text>
    </g>`;
  }

  html += `</g>`;
  return html;
}

// ── Sync circuit string ──────────────────────────────────────────
function syncString() {
  const str = treeToString(nodes);
  const input = _container.querySelector('#circuit-string');
  if (input) input.value = str;
  setState({ circuitTree: { nodes }, circuitString: str });
}

// ── Drag-and-drop ────────────────────────────────────────────────
function startPaletteDrag(e, element) {
  dragState = { source: 'palette', element };
  createGhost(e.clientX, e.clientY, element);
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
  e.preventDefault();
}

function startCanvasDrag(e, nodeId) {
  // For now, clicking selects. True in-canvas reorder is handled by select+arrows.
  // Canvas drag will be 'pick up and re-drop':
  const node = findNode(nodes, nodeId);
  if (!node || node.type !== 'component') return;
  dragState = { source: 'canvas', nodeId, element: node.element };
  createGhost(e.clientX, e.clientY, node.element);
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
  e.preventDefault();
}

function findNode(ns, id) {
  for (const n of ns) {
    if (n.id === id) return n;
    if (n.type === 'parallel') {
      for (const b of n.branches) { const found = findNode(b, id); if (found) return found; }
    }
  }
  return null;
}

function onDragMove(e) {
  if (!dragState) return;
  moveGhost(e.clientX, e.clientY);
  updateDropHighlight(e.clientX, e.clientY);
  renderCircuit(); // re-render to show drop zone highlights
}

function onDragEnd(e) {
  if (!dragState) return;

  const dz = getActiveDZ(e.clientX, e.clientY);
  if (dz) {
    // Single history snapshot for the entire drag operation — before any mutation.
    saveHistory();
    if (dragState.source === 'canvas') {
      deleteNodeSilent(dragState.nodeId);
    }
    performDrop(dragState, dz);
  }

  destroyGhost();
  dragState = null;
  activeDZId = null;
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
  renderCircuit();
}

function deleteNodeSilent(id) {
  function removeFrom(ns) {
    return ns.filter(n => n.id !== id).map(n => n.type === 'parallel'
      ? { ...n, branches: n.branches.map(b => removeFrom(b)).filter(b => b.length > 0) }
      : n);
  }
  nodes = removeFrom(nodes);
}

function performDrop(drag, dz) {
  const newNode = { id: newId(), type: 'component', element: drag.element };
  if (dz.type === 'gap' && dz.mutate) {
    dz.mutate(newNode);
    selectedId = newNode.id;
    renderCircuit(); syncString();
  } else if (dz.type === 'on-component') {
    makeParallelWith_new(dz.nodeId, newNode);
    // makeParallelWith_new already calls renderCircuit + syncString
  }
}

function updateDropHighlight(mx, my) {
  const dz = getActiveDZ(mx, my);
  activeDZId = dz?.id || null;
}

function getActiveDZ(mx, my) {
  const svg = _container.querySelector('#circuit-svg');
  if (!svg) return null;
  const pt = svg.createSVGPoint();
  pt.x = mx; pt.y = my;
  const svgPt = pt.matrixTransform(svg.getScreenCTM().inverse());

  for (const dz of dropZones) {
    if (svgPt.x >= dz.x && svgPt.x <= dz.x + dz.w &&
        svgPt.y >= dz.y && svgPt.y <= dz.y + dz.h) {
      return dz;
    }
  }
  return null;
}

function createGhost(x, y, element) {
  const color = COLORS[element] || '#888';
  ghostEl = document.createElement('div');
  ghostEl.className = 'ghost-component';
  ghostEl.textContent = element;
  ghostEl.style.cssText = `color:${color}; border-color:${color}; background:var(--surface); left:${x}px; top:${y}px;`;
  document.body.appendChild(ghostEl);
}

function moveGhost(x, y) {
  if (ghostEl) { ghostEl.style.left = `${x}px`; ghostEl.style.top = `${y}px`; }
}

function destroyGhost() {
  if (ghostEl) { ghostEl.remove(); ghostEl = null; }
}

// ── Public view factory ──────────────────────────────────────────
export function CircuitBuilderView(container, { navigate, showToast }) {
  _container = container;
  _navigate  = navigate;
  _showToast = showToast;

  return {
    async onEnter() {
      const state = getState();

      // Unconditionally reset all module-level working state from saved state.
      // The !nodes.length guard caused stale circuit/history when navigating away and back.
      _idCounter = 0;
      nodes      = [];
      history    = [];
      histPtr    = -1;
      selectedId = null;
      dragState  = null;

      if (state.circuitString) {
        try { nodes = stringToTree(state.circuitString); } catch (_) {}
      }
      saveHistory();

      // Load elements list once
      if (!_elements.length) {
        try {
          const res = await fetch('/api/elements');
          _elements = await res.json();
        } catch (_) {}
      }

      const oc = state.optimizeConfig ?? { enabled: false, rc_min: 1, rc_max: 2, pair_types: ['CPE'], criterion: 'AIC' };
      const fitModeVal = oc.enabled ? 'optimize' : 'fixed';
      const hasCPE     = (oc.pair_types ?? ['CPE']).includes('CPE');
      const hasC       = (oc.pair_types ?? []).includes('C');
      const isAIC      = (oc.criterion ?? 'AIC') === 'AIC';

      const modeTabStyle = (active) =>
        `padding:6px 18px;font-size:13px;font-weight:600;border:1px solid var(--border);cursor:pointer;transition:background .15s,color .15s;` +
        (active
          ? `background:var(--accent);color:#fff;border-color:var(--accent);`
          : `background:var(--surface);color:var(--text-muted);`);

      container.innerHTML = `
        <div class="section-header">Circuit / Fitting Mode</div>

        <!-- Mode selector -->
        <div style="display:flex;margin-bottom:22px;">
          <button id="mode-fixed-btn" style="${modeTabStyle(fitModeVal === 'fixed')}border-radius:6px 0 0 6px;">
            Fixed Circuit
          </button>
          <button id="mode-optimize-btn" style="${modeTabStyle(fitModeVal === 'optimize')}border-radius:0 6px 6px 0;border-left:none;">
            Auto-Optimize
          </button>
        </div>

        <!-- Fixed: full circuit builder -->
        <div id="section-fixed" style="display:${fitModeVal === 'fixed' ? 'block' : 'none'};">
          <div class="section-sub" style="margin-bottom:14px;">Drag components from the palette onto the canvas, or click to append. Drop on an existing component to create a parallel branch.</div>
          <div class="circuit-workspace">
            <div class="palette">
              <div class="palette-title">Components</div>
              ${_elements.map(el => `
                <div class="palette-item" data-element="${el.symbol}" title="${el.description}">
                  <div class="palette-dot" style="background:${el.color}"></div>
                  <span>${el.symbol}</span>
                </div>
              `).join('')}
            </div>
            <div class="canvas-area">
              <div class="circuit-svg-container" id="svg-container">
                <svg id="circuit-svg" xmlns="http://www.w3.org/2000/svg"></svg>
              </div>
              <div class="circuit-toolbar">
                <button class="btn btn-secondary btn-sm" id="undo-btn" title="Undo">↩ Undo</button>
                <button class="btn btn-secondary btn-sm" id="redo-btn" title="Redo">↪ Redo</button>
                <button class="btn btn-danger btn-sm" id="clear-btn">✕ Clear</button>
                <input type="text" class="circuit-string-input" id="circuit-string" placeholder="R0-p(R1,C1)" value="${state.circuitString || ''}">
                <button class="btn btn-secondary btn-sm" id="apply-str-btn">Apply</button>
              </div>
            </div>
          </div>
        </div>

        <!-- Optimize: params only -->
        <div id="section-optimize" style="display:${fitModeVal === 'optimize' ? 'block' : 'none'};">
          <div class="section-sub" style="margin-bottom:18px;">
            The optimizer strips any existing RC pairs from your circuit and searches over the range you specify.
            Set the frame circuit (e.g. <code>R0-W0</code>) via the Fixed tab — or leave it as-is.
          </div>

          <div style="display:flex;flex-wrap:wrap;gap:28px;align-items:flex-start;padding:20px;background:var(--surface-raised,var(--surface));border-radius:8px;border:1px solid var(--border);">

            <div>
              <div style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:9px;">RC pairs to search</div>
              <div style="display:flex;align-items:center;gap:8px;font-size:13px;">
                <span style="color:var(--text-muted);">min</span>
                <input type="number" id="rc-min" value="${oc.rc_min ?? 1}" min="0" max="10"
                       style="width:56px;padding:5px 7px;background:var(--surface);border:1px solid var(--border);border-radius:5px;color:var(--text);font-size:13px;text-align:right;">
                <span style="color:var(--text-muted);">to max</span>
                <input type="number" id="rc-max" value="${oc.rc_max ?? 2}" min="1" max="10"
                       style="width:56px;padding:5px 7px;background:var(--surface);border:1px solid var(--border);border-radius:5px;color:var(--text);font-size:13px;text-align:right;">
              </div>
            </div>

            <div>
              <div style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:9px;">Restarts per variant</div>
              <div style="display:flex;align-items:center;gap:8px;font-size:13px;">
                <input type="number" id="n-restarts" value="${oc.n_restarts ?? 1}" min="1" max="20"
                       style="width:56px;padding:5px 7px;background:var(--surface);border:1px solid var(--border);border-radius:5px;color:var(--text);font-size:13px;text-align:right;"
                       title="Random re-initialisations per candidate — more restarts reduce local-minimum risk at the cost of fitting time">
                <span style="color:var(--text-muted);font-size:12px;">1 = single fit &nbsp;·&nbsp; 5–10 recommended</span>
              </div>
            </div>

            <div>
              <div style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:9px;">Pair element type</div>
              <div style="display:flex;flex-direction:column;gap:7px;">
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
                  <input type="checkbox" class="pair-type-check" value="CPE" ${hasCPE ? 'checked' : ''} style="accent-color:var(--accent);width:15px;height:15px;">
                  CPE <span style="color:var(--text-muted);font-size:12px;">(constant phase element)</span>
                </label>
                <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;">
                  <input type="checkbox" class="pair-type-check" value="C" ${hasC ? 'checked' : ''} style="accent-color:var(--accent);width:15px;height:15px;">
                  C <span style="color:var(--text-muted);font-size:12px;">(ideal capacitor)</span>
                </label>
              </div>
            </div>

            <div>
              <div style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted);margin-bottom:9px;">Selection criterion</div>
              <div style="display:flex;flex-direction:column;gap:7px;">
                <label style="display:flex;align-items:flex-start;gap:8px;font-size:13px;cursor:pointer;">
                  <input type="radio" name="criterion" value="AIC" ${isAIC ? 'checked' : ''} style="accent-color:var(--accent);margin-top:2px;">
                  <span>AIC<br><span style="color:var(--text-muted);font-size:12px;font-weight:400;">Rewards fit improvement freely — picks more RC pairs if they help at all. Use when you want the best-fitting circuit.</span></span>
                </label>
                <label style="display:flex;align-items:flex-start;gap:8px;font-size:13px;cursor:pointer;">
                  <input type="radio" name="criterion" value="BIC" ${!isAIC ? 'checked' : ''} style="accent-color:var(--accent);margin-top:2px;">
                  <span>BIC<br><span style="color:var(--text-muted);font-size:12px;font-weight:400;">Penalises extra parameters more heavily — an extra RC pair must earn its place with a meaningful fit improvement. Use when overfitting is a concern.</span></span>
                </label>
              </div>
            </div>

          </div>

          <div style="margin-top:14px;font-size:12px;color:var(--text-muted);">
            Components maintained across all variants:
            <code style="color:var(--accent);margin-left:6px;" id="frame-preview">${stripRcPairsFn(state.circuitString || '')}</code>
          </div>

          <div style="margin-top:20px;padding:14px 16px;border-radius:6px;border:1px solid var(--border);font-size:12px;line-height:1.7;color:var(--text-muted);">
            <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:8px;letter-spacing:.02em;">How auto-optimize works</div>
            <ol style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:5px;">
              <li>Your circuit's existing RC pairs (<code>p(R,CPE)</code> / <code>p(R,C)</code>) are stripped, leaving the frame — the series elements like <code>R0</code>, <code>W0</code>.</li>
              <li>For every combination of RC count (min → max) and pair type (CPE / C), a candidate circuit is generated by inserting that many pairs into the frame and fitted independently.</li>
              <li>Each fitted candidate is scored by <strong style="color:var(--text);">AIC or BIC</strong> — both balance fit quality against the number of free parameters, so adding an extra RC pair only wins if it meaningfully improves the fit.</li>
              <li>The candidate with the lowest score is selected as the result for that file. The <strong style="color:var(--text);">Variants</strong> tab in each result shows the full ranking.</li>
            </ol>
            <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
              Initial guesses and bounds from the Bounds Editor are reused for matching parameter names. New parameters introduced by added RC pairs fall back to physical defaults.
            </div>
          </div>
        </div>

        <div class="step-actions">
          <button class="btn btn-secondary" id="back-btn">← Back</button>
          <div class="spacer"></div>
          <button class="btn btn-primary" id="next-btn">Next: Set Bounds →</button>
        </div>
      `;

      // Palette: click = append, mousedown = drag
      container.querySelectorAll('.palette-item').forEach(item => {
        item.addEventListener('click', () => {
          insertAt(nodes.length, { id: newId(), type: 'component', element: item.dataset.element });
        });
        item.addEventListener('mousedown', e => {
          if (e.button !== 0) return;
          startPaletteDrag(e, item.dataset.element);
        });
      });

      container.querySelector('#undo-btn').addEventListener('click', undo);
      container.querySelector('#redo-btn').addEventListener('click', redo);
      container.querySelector('#clear-btn').addEventListener('click', () => {
        saveHistory(); nodes = []; selectedId = null; renderCircuit(); syncString();
      });

      container.querySelector('#apply-str-btn').addEventListener('click', () => {
        const val = container.querySelector('#circuit-string').value.trim();
        try {
          nodes = stringToTree(val);
          saveHistory();
          renderCircuit(); syncString();
          container.querySelector('#circuit-string').classList.remove('error');
        } catch (err) {
          container.querySelector('#circuit-string').classList.add('error');
          showToast(`Invalid circuit string: ${err.message}`, 'error');
        }
      });

      container.querySelector('#circuit-string').addEventListener('keydown', e => {
        if (e.key === 'Enter') container.querySelector('#apply-str-btn').click();
      });

      // Mode toggle buttons
      let currentMode = fitModeVal;

      function setMode(mode) {
        currentMode = mode;
        const fixedActive = mode === 'fixed';
        container.querySelector('#mode-fixed-btn').style.cssText    = modeTabStyle(fixedActive)  + 'border-radius:6px 0 0 6px;';
        container.querySelector('#mode-optimize-btn').style.cssText = modeTabStyle(!fixedActive) + 'border-radius:0 6px 6px 0;border-left:none;';
        container.querySelector('#section-fixed').style.display    = fixedActive ? 'block' : 'none';
        container.querySelector('#section-optimize').style.display = fixedActive ? 'none'  : 'block';
        if (fixedActive) {
          renderCircuit();
        } else {
          // Refresh frame preview with the current (stripped) circuit string.
          const preview = container.querySelector('#frame-preview');
          if (preview) preview.textContent = stripRcPairsFn(treeToString(nodes));
        }
      }

      container.querySelector('#mode-fixed-btn').addEventListener('click',    () => setMode('fixed'));
      container.querySelector('#mode-optimize-btn').addEventListener('click', () => setMode('optimize'));

      container.querySelector('#back-btn').addEventListener('click', () => navigate(3));
      container.querySelector('#next-btn').addEventListener('click', () => {
        if (currentMode === 'optimize') {
          const pairTypes = [...container.querySelectorAll('.pair-type-check:checked')].map(el => el.value);
          const optimizeConfig = {
            enabled: true,
            rc_min:     Math.max(0, parseInt(container.querySelector('#rc-min')?.value) || 1),
            rc_max:     Math.max(1, parseInt(container.querySelector('#rc-max')?.value) || 2),
            pair_types: pairTypes.length ? pairTypes : ['CPE'],
            criterion:  container.querySelector('input[name="criterion"]:checked')?.value || 'AIC',
            n_restarts: Math.max(1, parseInt(container.querySelector('#n-restarts')?.value) || 1),
          };
          // Persist circuit string (frame) from whatever was last built, even if empty.
          const str = treeToString(nodes);
          setState({ circuitTree: { nodes }, circuitString: str, maxStep: Math.max(getState().maxStep, 5), optimizeConfig });
          navigate(5);
        } else {
          const str = treeToString(nodes);
          if (!str) { showToast('Build a circuit first.', 'error'); return; }
          setState({ circuitTree: { nodes }, circuitString: str, maxStep: Math.max(getState().maxStep, 5), optimizeConfig: { enabled: false } });
          navigate(5);
        }
      });

      renderCircuit();
    }
  };
}
