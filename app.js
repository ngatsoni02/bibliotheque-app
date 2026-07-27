/* =========================================================================
   Bibliothèque — Application de lecture EPUB/PDF (PWA, 100% locale)
   Toutes les données (livres, progression, notes, objectifs) restent
   sur l'appareil : IndexedDB pour les fichiers, aucune requête serveur.
   ========================================================================= */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

/* ---------------------------- IndexedDB ---------------------------- */
const DB_NAME = 'biblio-db';
const DB_VERSION = 1;
let dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = (e) => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('progress')) db.createObjectStore('progress', { keyPath: 'bookId' });
    if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    if (!db.objectStoreNames.contains('reflowCache')) db.createObjectStore('reflowCache', { keyPath: 'bookId' });
  };
  req.onsuccess = (e) => resolve(e.target.result);
  req.onerror = (e) => reject(e);
});

function idbTx(storeName, mode) {
  return dbPromise.then((db) => db.transaction(storeName, mode).objectStore(storeName));
}
function idbGet(store, key) {
  return idbTx(store, 'readonly').then((os) => new Promise((res, rej) => {
    const r = os.get(key);
    r.onsuccess = () => res(r.result || null);
    r.onerror = () => rej(r.error);
  }));
}
function idbGetAll(store) {
  return idbTx(store, 'readonly').then((os) => new Promise((res, rej) => {
    const r = os.getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
  }));
}
function idbPut(store, value) {
  return idbTx(store, 'readwrite').then((os) => new Promise((res, rej) => {
    const r = os.put(value);
    r.onsuccess = () => res(value);
    r.onerror = () => rej(r.error);
  }));
}
function idbDelete(store, key) {
  return idbTx(store, 'readwrite').then((os) => new Promise((res, rej) => {
    const r = os.delete(key);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  }));
}

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function isoWeekStart(d = new Date()) {
  const date = new Date(d);
  const day = (date.getDay() + 6) % 7; // Monday = 0
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - day);
  return date;
}
function dateKey(d = new Date()) { return new Date(d).toISOString().slice(0, 10); }

/* ---------------------------- UI helpers ---------------------------- */
function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }
document.querySelectorAll('[data-close-modal]').forEach((b) =>
  b.addEventListener('click', () => closeModal(b.dataset.closeModal)));
document.querySelectorAll('.modal-overlay').forEach((ov) =>
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.remove('active'); }));

function switchView(viewId) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  document.getElementById(viewId).classList.add('active');
  document.querySelectorAll('.spine-btn[data-view]').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === viewId));
  if (viewId === 'view-stats') renderStats();
}
document.querySelectorAll('.spine-btn[data-view]').forEach((b) =>
  b.addEventListener('click', () => switchView(b.dataset.view)));

/* ---------------------------- Import ---------------------------- */
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
document.getElementById('btn-import').addEventListener('click', () => openModal('modal-import'));
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault(); dropZone.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

async function handleFiles(fileList) {
  const files = Array.from(fileList);
  const progressEl = document.getElementById('import-progress');
  for (const file of files) {
    progressEl.textContent = `Import de « ${file.name} »…`;
    try {
      const ext = file.name.toLowerCase().endsWith('.pdf') ? 'pdf'
        : file.name.toLowerCase().endsWith('.epub') ? 'epub' : null;
      if (!ext) { toast(`Format non supporté : ${file.name}`); continue; }
      if (ext === 'epub') await importEpub(file);
      else await importPdf(file);
      toast(`« ${file.name} » ajouté à la bibliothèque.`);
    } catch (err) {
      console.error(err);
      toast(`Impossible d'ouvrir « ${file.name} » — le fichier est peut-être protégé par DRM ou corrompu.`, 4200);
    }
  }
  progressEl.textContent = '';
  fileInput.value = '';
  closeModal('modal-import');
  renderLibrary();
}

async function importEpub(file) {
  const arrayBuffer = await file.arrayBuffer();
  const book = ePub(arrayBuffer.slice(0));
  await book.opened; // rejette si le fichier est corrompu / DRM
  const metadata = await book.loaded.metadata;
  let coverBlob = null;
  try {
    const coverUrl = await book.coverUrl();
    if (coverUrl) {
      const resp = await fetch(coverUrl);
      coverBlob = await resp.blob();
    }
  } catch (_) { /* pas de couverture, on générera une vignette */ }

  const id = uid();
  await idbPut('books', {
    id,
    title: metadata.title || file.name.replace(/\.epub$/i, ''),
    author: metadata.creator || 'Auteur inconnu',
    format: 'epub',
    fileBlob: file,
    coverBlob,
    addedAt: Date.now(),
    favorite: false,
    collection: 'to-read',
  });
  await idbPut('progress', { bookId: id, percent: 0, location: null, mode: 'reflow', lastRead: null });
}

async function importPdf(file) {
  const arrayBuffer = await file.arrayBuffer();
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;
  } catch (err) {
    if (err && err.name === 'PasswordException') throw new Error('PDF protégé par mot de passe / DRM');
    throw err;
  }
  const metadata = await pdf.getMetadata().catch(() => ({}));
  const info = (metadata && metadata.info) || {};

  const page1 = await pdf.getPage(1);
  const viewport = page1.getViewport({ scale: 0.6 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width; canvas.height = viewport.height;
  await page1.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  const coverBlob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));

  const id = uid();
  await idbPut('books', {
    id,
    title: info.Title || file.name.replace(/\.pdf$/i, ''),
    author: info.Author || 'Auteur inconnu',
    format: 'pdf',
    fileBlob: file,
    coverBlob,
    addedAt: Date.now(),
    favorite: false,
    collection: 'to-read',
    totalPages: pdf.numPages,
  });
  await idbPut('progress', { bookId: id, percent: 0, location: { page: 1, scrollPct: 0 }, mode: 'reflow', lastRead: null });
}

/* ---------------------------- Library rendering ---------------------------- */
async function renderLibrary() {
  const books = await idbGetAll('books');
  const progresses = await idbGetAll('progress');
  const progMap = Object.fromEntries(progresses.map((p) => [p.bookId, p]));

  const search = document.getElementById('search-library').value.trim().toLowerCase();
  const sort = document.getElementById('sort-select').value;
  const collection = document.getElementById('collection-select').value;

  let list = books.filter((b) => {
    if (search && !(b.title.toLowerCase().includes(search) || b.author.toLowerCase().includes(search))) return false;
    if (collection === 'favorites') return !!b.favorite;
    if (collection === 'to-read') return (b.collection || 'to-read') === 'to-read' && (progMap[b.id]?.percent || 0) < 2;
    if (collection === 'reading') return (progMap[b.id]?.percent || 0) >= 2 && (progMap[b.id]?.percent || 0) < 98;
    if (collection === 'finished') return (progMap[b.id]?.percent || 0) >= 98;
    return true;
  });

  list.sort((a, b) => {
    const pa = progMap[a.id] || {}; const pb = progMap[b.id] || {};
    if (sort === 'title') return a.title.localeCompare(b.title);
    if (sort === 'author') return a.author.localeCompare(b.author);
    if (sort === 'progress') return (pb.percent || 0) - (pa.percent || 0);
    if (sort === 'added') return b.addedAt - a.addedAt;
    return (pb.lastRead || 0) - (pa.lastRead || 0) || (b.addedAt - a.addedAt);
  });

  const grid = document.getElementById('library-grid');
  grid.innerHTML = '';
  document.getElementById('empty-state').classList.toggle('hidden', books.length > 0);
  document.getElementById('library-count').textContent = `${books.length} livre${books.length > 1 ? 's' : ''}`;

  for (const book of list) {
    const p = progMap[book.id] || { percent: 0 };
    const card = document.createElement('div');
    card.className = 'book-card';
    const coverHTML = book.coverBlob
      ? `<img class="book-cover" src="${URL.createObjectURL(book.coverBlob)}" alt="">`
      : `<div class="book-cover generated" style="background:hsl(${hashHue(book.title)},38%,28%)">${escapeHtml(book.title)}</div>`;
    card.innerHTML = `
      ${coverHTML}
      <div class="book-badges"><span class="badge">${book.format.toUpperCase()}</span></div>
      ${book.favorite ? '<div class="book-fav">★</div>' : ''}
      <button class="book-delete" title="Supprimer">✕</button>
      <div class="book-info">
        <p class="book-title">${escapeHtml(book.title)}</p>
        <p class="book-author">${escapeHtml(book.author)}</p>
      </div>
      <div class="book-progress-bar"><div class="book-progress-fill" style="width:${Math.round(p.percent || 0)}%"></div></div>
    `;
    card.addEventListener('click', (e) => {
      if (e.target.closest('.book-delete')) return;
      openReader(book.id);
    });
    card.querySelector('.book-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Supprimer « ${book.title} » de la bibliothèque ?`)) {
        await idbDelete('books', book.id);
        await idbDelete('progress', book.id);
        await idbDelete('reflowCache', book.id);
        renderLibrary();
      }
    });
    grid.appendChild(card);
  }
}
function hashHue(str) { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

['search-library', 'sort-select', 'collection-select'].forEach((id) =>
  document.getElementById(id).addEventListener('input', renderLibrary));

/* ---------------------------- Backup / restore ---------------------------- */
document.getElementById('btn-backup').addEventListener('click', () => openModal('modal-backup'));
document.getElementById('export-backup-btn').addEventListener('click', async () => {
  const [progress, sessions, notes, settings] = await Promise.all([
    idbGetAll('progress'), idbGetAll('sessions'), idbGetAll('notes'), idbGetAll('settings'),
  ]);
  const books = (await idbGetAll('books')).map(({ fileBlob, coverBlob, ...rest }) => rest);
  const backup = { version: 1, exportedAt: Date.now(), books, progress, sessions, notes, settings };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `bibliotheque-sauvegarde-${dateKey()}.json`;
  a.click();
  toast('Sauvegarde exportée.');
});
document.getElementById('import-backup-btn').addEventListener('click', () => document.getElementById('import-backup-input').click());
document.getElementById('import-backup-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    for (const p of data.progress || []) await idbPut('progress', p);
    for (const s of data.sessions || []) await idbPut('sessions', s);
    for (const n of data.notes || []) await idbPut('notes', n);
    for (const st of data.settings || []) await idbPut('settings', st);
    // Merge book metadata for titles/authors we don't already have (files must be re-imported).
    for (const b of data.books || []) {
      const existing = await idbGet('books', b.id);
      if (!existing) toast(`« ${b.title} » : réimportez le fichier pour restaurer ce livre.`, 3800);
    }
    toast('Sauvegarde restaurée (réimportez les fichiers de livres manquants).', 4200);
    renderLibrary();
  } catch (err) {
    toast('Fichier de sauvegarde invalide.');
  }
  e.target.value = '';
});

/* ---------------------------- Storage usage ---------------------------- */
document.getElementById('btn-storage').addEventListener('click', async () => {
  const details = document.getElementById('storage-details');
  details.innerHTML = 'Calcul en cours…';
  openModal('modal-storage');
  if (navigator.storage && navigator.storage.estimate) {
    const { usage, quota } = await navigator.storage.estimate();
    const pct = quota ? Math.round((usage / quota) * 100) : 0;
    const mb = (n) => (n / (1024 * 1024)).toFixed(1);
    details.innerHTML = `
      <div class="big-num">${mb(usage)}<small> Mo utilisés sur ${mb(quota)} Mo</small></div>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%;background:${pct > 80 ? 'var(--ember)' : 'var(--moss)'}"></div></div>
      ${pct > 80 ? `<div class="goal-alert">⚠️ Le stockage approche de la limite du navigateur (${pct}%). Supprimez des livres ou exportez votre sauvegarde.</div>` : ''}
      <p class="sub" style="margin-top:14px;">Le quota dépend du navigateur et de l'espace disque disponible ; il n'est pas illimité pour le stockage hors-ligne.</p>
    `;
  } else {
    details.innerHTML = '<p class="sub">Estimation du stockage non disponible sur ce navigateur.</p>';
  }
});

/* ---------------------------- Boot ---------------------------- */
renderLibrary();
