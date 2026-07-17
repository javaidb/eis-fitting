import { getState, setState } from '../state.js';
import { scanFolder, pickFolder } from '../api.js';

export function FileLoaderView(container, { navigate, showToast }) {

  container.innerHTML = `
    <div class="section-header">Load EIS Files</div>
    <div class="section-sub">Enter the absolute path to a folder containing your CSV files.</div>

    <div class="card">
      <div class="card-title">Folder Path</div>
      <div class="row" style="align-items:flex-end; gap:10px;">
        <div class="col">
          <label>Absolute folder path</label>
          <input type="text" id="folder-input" placeholder="e.g. C:\\Users\\you\\data\\eis">
        </div>
        <button class="btn btn-secondary" id="browse-btn" title="Open folder picker">📁 Browse…</button>
        <button class="btn btn-primary" id="scan-btn">Scan Folder</button>
      </div>
    </div>

    <div id="file-list-card" class="card" style="display:none;">
      <div class="card-title">Found Files <span id="file-count" class="chip"></span></div>
      <input type="text" id="file-filter" class="file-filter" placeholder="🔍 Filter files by keyword…">
      <div class="file-list" id="file-list"></div>
    </div>

    <div class="step-actions">
      <div class="spacer"></div>
      <button class="btn btn-primary" id="next-btn" disabled>Next: Map Columns →</button>
    </div>
  `;

  const folderInput = container.querySelector('#folder-input');
  const browseBtn   = container.querySelector('#browse-btn');
  const scanBtn     = container.querySelector('#scan-btn');
  const fileListCard = container.querySelector('#file-list-card');
  const fileFilter  = container.querySelector('#file-filter');
  const fileList    = container.querySelector('#file-list');
  const fileCount   = container.querySelector('#file-count');
  const nextBtn     = container.querySelector('#next-btn');

  // Restore saved path
  const saved = getState();
  if (saved.folderPath) folderInput.value = saved.folderPath;
  if (saved.files?.length) renderFiles();

  browseBtn.addEventListener('click', async () => {
    browseBtn.disabled = true;
    browseBtn.textContent = '⏳ Opening…';
    try {
      const { path } = await pickFolder();
      if (path) {
        folderInput.value = path;
        scanBtn.click();
      }
    } catch (err) {
      showToast('Could not open folder picker.', 'error');
    } finally {
      browseBtn.disabled = false;
      browseBtn.textContent = '📁 Browse…';
    }
  });

  folderInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') scanBtn.click();
  });

  scanBtn.addEventListener('click', async () => {
    const path = folderInput.value.trim();
    if (!path) { showToast('Enter a folder path first.', 'error'); return; }

    scanBtn.textContent = 'Scanning…';
    scanBtn.disabled = true;

    try {
      const data = await scanFolder(path);
      setState({
        folderPath: path,
        files: data.files,
        discardedFiles: [],   // fresh scan resets any excluded files
        detectedRoles: data.detected_roles,
        maxStep: Math.max(getState().maxStep, 2),
      });
      fileFilter.value = '';
      renderFiles();
      showToast(`Found ${data.files.length} file(s).`, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      scanBtn.textContent = 'Scan Folder';
      scanBtn.disabled = false;
    }
  });

  nextBtn.addEventListener('click', () => navigate(2));

  fileFilter.addEventListener('input', () => renderFiles());

  fileList.addEventListener('click', e => {
    const btn = e.target.closest('.file-item-remove');
    if (!btn) return;
    removeFile(decodeURIComponent(btn.dataset.path));
  });

  function removeFile(path) {
    const s = getState();
    const files = (s.files || []).filter(f => f.path !== path);
    const removed = (s.files || []).find(f => f.path === path);
    const kkData = { ...s.kkData };
    delete kkData[path];
    setState({
      files,
      // Drop any per-file results so downstream steps stay consistent.
      fitResults: (s.fitResults || []).filter(r => r?.path !== path),
      drtResults: (s.drtResults || []).filter(r => r?.path !== path),
      kkData,
      drtSelectedFile: s.drtSelectedFile?.path === path ? null : s.drtSelectedFile,
    });
    renderFiles();
    showToast(`Removed ${removed?.filename ?? 'file'} from analysis.`, 'success');
  }

  function renderFiles() {
    const files = getState().files || [];
    if (!files.length) {
      fileListCard.style.display = 'none';
      nextBtn.disabled = true;
      return;
    }

    const keyword = fileFilter.value.trim().toLowerCase();
    const shown = keyword
      ? files.filter(f => f.filename.toLowerCase().includes(keyword))
      : files;

    fileListCard.style.display = '';
    fileCount.textContent = keyword ? `${shown.length} / ${files.length}` : files.length;
    fileList.innerHTML = shown.length ? shown.map(f => `
      <div class="file-item">
        <span style="color:var(--accent); font-size:16px;">📄</span>
        <span class="file-item-name">${f.filename}</span>
        <span class="file-item-meta">${f.columns.length} cols · ${f.row_count} rows</span>
        <span class="chip" style="font-size:10px;">${f.columns.slice(0,3).join(', ')}${f.columns.length > 3 ? '…' : ''}</span>
        <button class="file-item-remove" data-path="${encodeURIComponent(f.path)}" title="Remove from analysis">✕</button>
      </div>
    `).join('') : '<div class="file-list-empty">No files match this keyword.</div>';
    nextBtn.disabled = false;
  }

  return {
    onEnter() {
      const s = getState();
      if (s.folderPath) folderInput.value = s.folderPath;
      renderFiles();
      nextBtn.disabled = !(s.files?.length);
    }
  };
}
