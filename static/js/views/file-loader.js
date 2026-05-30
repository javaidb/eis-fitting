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
  const fileList    = container.querySelector('#file-list');
  const fileCount   = container.querySelector('#file-count');
  const nextBtn     = container.querySelector('#next-btn');

  // Restore saved path
  const saved = getState();
  if (saved.folderPath) folderInput.value = saved.folderPath;
  if (saved.files?.length) renderFiles(saved.files);

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
        detectedRoles: data.detected_roles,
        maxStep: Math.max(getState().maxStep, 2),
      });
      renderFiles(data.files);
      showToast(`Found ${data.files.length} file(s).`, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      scanBtn.textContent = 'Scan Folder';
      scanBtn.disabled = false;
    }
  });

  nextBtn.addEventListener('click', () => navigate(2));

  function renderFiles(files) {
    if (!files.length) { fileListCard.style.display = 'none'; return; }

    fileListCard.style.display = '';
    fileCount.textContent = files.length;
    fileList.innerHTML = files.map(f => `
      <div class="file-item">
        <span style="color:var(--accent); font-size:16px;">📄</span>
        <span class="file-item-name">${f.filename}</span>
        <span class="file-item-meta">${f.columns.length} cols · ${f.row_count} rows</span>
        <span class="chip" style="font-size:10px;">${f.columns.slice(0,3).join(', ')}${f.columns.length > 3 ? '…' : ''}</span>
      </div>
    `).join('');
    nextBtn.disabled = false;
  }

  return {
    onEnter() {
      const s = getState();
      if (s.folderPath) folderInput.value = s.folderPath;
      if (s.files?.length) renderFiles(s.files);
      nextBtn.disabled = !(s.files?.length);
    }
  };
}
