// Shared value-coloring helpers for file tables (EIS Lab, Map Columns).
// Numeric columns get a blue → orange gradient scaled to the column's range;
// string columns get one stable hue per distinct value.

// Format a display value without unnecessary scientific notation.
export function fmtNum(v) {
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

const GRAD_LO = [74, 154, 222];   // #4a9ade — theme blue
const GRAD_HI = [230, 126, 34];   // #e67e22 — theme orange

export function lerpColor(t) {
  const c = GRAD_LO.map((lo, i) => Math.round(lo + (GRAD_HI[i] - lo) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function isNumericVal(v) {
  return v != null && v !== '' && Number.isFinite(Number(v));
}

// One style descriptor per field: {type:'numeric',min,max} or {type:'categorical',colors:Map}
// `charMap` is a Map of path → {label: value}; `files` have a .path each.
export function computeFieldStyles(fields, files, charMap) {
  const styles = {};
  for (const field of fields) {
    const vals = files
      .map(f => (charMap.get(f.path) || {})[field])
      .filter(v => v != null && v !== '');
    if (!vals.length) { styles[field] = null; continue; }

    if (vals.every(isNumericVal)) {
      const nums = vals.map(Number);
      styles[field] = { type: 'numeric', min: Math.min(...nums), max: Math.max(...nums) };
    } else {
      // Distinct values in sorted order → deterministic hues, spread via the
      // golden angle so neighboring categories stay distinguishable.
      const uniq = [...new Set(vals.map(String))].sort();
      const colors = new Map();
      uniq.forEach((v, i) => {
        colors.set(v, `hsl(${Math.round((i * 137.5) % 360)}, 55%, 65%)`);
      });
      styles[field] = { type: 'categorical', colors };
    }
  }
  return styles;
}

export function idCellHtml(value, style, suffix = '') {
  if (value == null || value === '') return '—';
  const disp = (typeof value === 'number' ? fmtNum(value) : value) + suffix;
  if (!style) return `${disp}`;
  let color;
  if (style.type === 'numeric') {
    const t = style.max > style.min ? (Number(value) - style.min) / (style.max - style.min) : 0.5;
    color = lerpColor(t);
  } else {
    color = style.colors.get(String(value)) ?? 'var(--text-muted)';
  }
  return `<span class="lab-id-chip" style="color:${color};background:color-mix(in srgb, ${color} 14%, transparent);">${disp}</span>`;
}
