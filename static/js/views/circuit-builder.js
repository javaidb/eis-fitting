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
let dropZones   = [];    // [{id, type, index?, nodeId?, groupId?, x, y, w, h}]

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

function makeParallelWith_new(existingId, newNode) {
  saveHistory();
  const existing = nodes.find(n => n.id === existingId);
  if (!existing) return;
  const pg = { id: newId(), type: 'parallel', branches: [[existing], [newNode]] };
  const i = nodes.indexOf(existing);
  nodes = nodes.filter(n => n.id !== existingId);
  nodes.splice(i, 0, pg);
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

  const { html: seriesHtml, endX } = buildSeriesHtml(nodes, startX, cy, counters, true);
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

// Builds SVG HTML for a series chain and returns endX
function buildSeriesHtml(ns, startX, cy, counters, isTopLevel) {
  let x = startX;
  let html = '';

  // Gap drop zone before first element
  dropZones.push({ id: `gap-0-${startX}`, type: 'gap', index: isTopLevel ? 0 : -1, x: x - 12, y: cy - COMP_H, w: 24, h: COMP_H * 2 });

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
      // Wire and gap drop zone between elements
      const gapX = x;
      dropZones.push({ id: `gap-${i + 1}-${startX}`, type: 'gap', index: isTopLevel ? i + 1 : -1, x: gapX + 2, y: cy - COMP_H, w: H_GAP - 4, h: COMP_H * 2 });
      html += `<line class="wire-line" x1="${gapX}" y1="${cy}" x2="${gapX + H_GAP}" y2="${cy}"/>`;
      x += H_GAP;
    }
  }

  // Gap drop zone after last element
  dropZones.push({ id: `gap-end-${startX}`, type: 'gap', index: isTopLevel ? ns.length : -1, x: x + 2, y: cy - COMP_H, w: 22, h: COMP_H * 2 });

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
    const { html: branchHtml, endX: branchEndX } = buildSeriesHtml(node.branches[i], branchX, branchCY, counters, false);
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
    if (dragState.source === 'canvas') {
      // Remove the original node first
      saveHistory();
      const origId = dragState.nodeId;
      const origElement = dragState.element;
      deleteNodeSilent(origId);
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
  if (dz.type === 'gap' && dz.index >= 0) {
    nodes.splice(dz.index, 0, newNode);
    selectedId = newNode.id;
  } else if (dz.type === 'on-component') {
    makeParallelWith_new(dz.nodeId, newNode);
    return; // already calls renderCircuit + syncString
  }
  renderCircuit(); syncString();
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

      // Load elements list once
      if (!_elements.length) {
        try {
          const res = await fetch('/api/elements');
          _elements = await res.json();
        } catch (_) {}
      }

      // Restore circuit from state
      if (state.circuitString && !nodes.length) {
        try {
          nodes = stringToTree(state.circuitString);
          saveHistory();
        } catch (_) { nodes = []; }
      }

      container.innerHTML = `
        <div class="section-header">Build Circuit</div>
        <div class="section-sub">Drag components from the palette onto the canvas, or click to append. Drop on an existing component to create a parallel branch.</div>

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

      container.querySelector('#back-btn').addEventListener('click', () => navigate(3));
      container.querySelector('#next-btn').addEventListener('click', () => {
        const str = treeToString(nodes);
        if (!str) { showToast('Build a circuit first.', 'error'); return; }
        setState({ circuitTree: { nodes }, circuitString: str, maxStep: Math.max(getState().maxStep, 5) });
        navigate(5);
      });

      if (!history.length) saveHistory();
      renderCircuit();
    }
  };
}
