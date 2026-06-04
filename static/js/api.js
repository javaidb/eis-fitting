// API helpers — thin wrappers over fetch.

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.json();
}

async function get(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

export async function pickFolder() {
  const res = await fetch('/api/pick-folder');
  if (!res.ok) throw new Error(res.statusText);
  return res.json(); // { path: string }
}

export function scanFolder(folderPath) {
  return post('/api/scan-folder', { folder_path: folderPath });
}

export function getElements() {
  return get('/api/elements');
}

export function parseCircuit(circuitString) {
  return post('/api/parse-circuit', { circuit_string: circuitString });
}

export function characterizeFiles(request) {
  return post('/api/characterize', request);
}

export async function* streamDRT(request) {
  const res = await fetch('/api/drt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop();
    for (const part of parts) {
      const line = part.trim();
      if (line.startsWith('data: ')) {
        try {
          yield JSON.parse(line.slice(6));
        } catch (_) { /* malformed */ }
      }
    }
  }

  // Flush any trailing SSE frame that wasn't terminated by a blank line.
  const tail = buffer.trim();
  if (tail.startsWith('data: ')) {
    try {
      yield JSON.parse(tail.slice(6));
    } catch (_) { /* malformed */ }
  }
}

// Returns an async generator yielding parsed SSE event objects.
export async function* streamKK(request) {
  const res = await fetch('/api/kk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop();
    for (const part of parts) {
      const line = part.trim();
      if (line.startsWith('data: ')) {
        try { yield JSON.parse(line.slice(6)); } catch (_) { /* malformed */ }
      }
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith('data: ')) {
    try { yield JSON.parse(tail.slice(6)); } catch (_) { /* malformed */ }
  }
}

export async function* streamFitting(request, signal) {
  const res = await fetch('/api/fit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop();
    for (const part of parts) {
      const line = part.trim();
      if (line.startsWith('data: ')) {
        try {
          yield JSON.parse(line.slice(6));
        } catch (_) { /* malformed */ }
      }
    }
  }

  // Flush any trailing SSE frame that wasn't terminated by a blank line.
  const tail = buffer.trim();
  if (tail.startsWith('data: ')) {
    try {
      yield JSON.parse(tail.slice(6));
    } catch (_) { /* malformed */ }
  }
}
