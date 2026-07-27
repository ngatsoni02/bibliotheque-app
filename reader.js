/* =========================================================================
   Moteur de lecture — EPUB (epub.js) et PDF (pdf.js), mode Reflow / Original,
   réglages de confort, TOC, recherche, notes, verrou d'écran, lecture audio.
   ========================================================================= */

const READER = {
  bookId: null, book: null, format: null,
  epubBook: null, rendition: null, locationsReady: false,
  pdfDoc: null, pdfMode: 'reflow', pdfObjectUrl: null,
  reflowPages: null, // [{pageNum, text}]
  settings: { theme: 'light', fontSize: 18, fontFamily: 'serif', lineHeight: 1.5, margins: 5, scrollMode: 'paginated', doublePage: 'off', brightness: 0, textAlign: 'left', immersive: false },
  wakeLockSentinel: null,
  sessionStart: null,
  ttsActive: false, ttsQueue: [], ttsIndex: 0,
  progress: null,
};

const THEME_COLORS = {
  light: { bg: '#f6f1e6', fg: '#1c1c1c' },
  sepia: { bg: '#e8d6b3', fg: '#3a2f1c' },
  dark: { bg: '#1c1f2b', fg: '#e9e4d6' },
};

/* ---------------------------- Settings load/save ---------------------------- */
async function loadReaderSettings() {
  const s = await idbGet('settings', 'reader-prefs');
  if (s) READER.settings = Object.assign(READER.settings, s.value);
  reflectSettingsUI();
}
function saveReaderSettings() {
  idbPut('settings', { key: 'reader-prefs', value: READER.settings });
}
function reflectSettingsUI() {
  const s = READER.settings;
  document.querySelectorAll('.theme-swatch').forEach((el) => el.classList.toggle('selected', el.dataset.theme === s.theme));
  document.getElementById('range-fontsize').value = s.fontSize;
  document.getElementById('range-lineheight').value = s.lineHeight;
  document.getElementById('range-margins').value = s.margins;
  document.getElementById('range-brightness').value = s.brightness;
  document.querySelectorAll('#font-family-control button').forEach((b) => b.classList.toggle('active', b.dataset.font === s.fontFamily));
  document.querySelectorAll('#scroll-mode-control button').forEach((b) => b.classList.toggle('active', b.dataset.mode === s.scrollMode));
  document.querySelectorAll('#double-page-control button').forEach((b) => b.classList.toggle('active', b.dataset.dp === s.doublePage));
  document.querySelectorAll('#align-control button').forEach((b) => b.classList.toggle('active', b.dataset.align === s.textAlign));
  document.getElementById('brightness-overlay').style.opacity = s.brightness / 100;
}

/* ---------------------------- Open / close reader ---------------------------- */
async function openReader(bookId) {
  const book = await idbGet('books', bookId);
  if (!book) return;
  const progress = (await idbGet('progress', bookId)) || { bookId, percent: 0, location: null, mode: 'reflow' };

  READER.bookId = bookId; READER.book = book; READER.format = book.format; READER.progress = progress;
  READER.pdfMode = progress.mode || 'reflow';

  document.getElementById('reader-title').textContent = `${book.title} — ${book.author}`;
  document.getElementById('reflow-label').textContent = READER.pdfMode === 'reflow' ? 'Reflow' : 'Original';
  document.getElementById('reader-toggle-reflow').classList.toggle('hidden', book.format !== 'pdf');
  document.getElementById('epub-container').classList.add('hidden');
  document.getElementById('pdf-container').classList.add('hidden');
  document.getElementById('double-page-group').classList.toggle('hidden', book.format !== 'epub' && READER.pdfMode !== 'original');

  document.getElementById('reader-view').classList.add('active');
  await loadReaderSettings();
  document.getElementById('reader-view').classList.toggle('immersive', !!READER.settings.immersive);

  if (book.format === 'epub') await openEpub(book, progress);
  else await openPdf(book, progress);

  applyThemeToChrome();
  requestWakeLock();
  READER.sessionStart = Date.now();
  updateProgressBar(progress.percent || 0);
}

function closeReader() {
  finalizeSession();
  stopTTS();
  releaseWakeLock();
  document.getElementById('reader-view').classList.remove('active');
  closeAllPanels();
  if (READER.rendition) { try { READER.rendition.destroy(); } catch (_) {} READER.rendition = null; }
  READER.epubBook = null; READER.pdfDoc = null; READER.reflowPages = null;
  if (READER.pdfObjectUrl) { URL.revokeObjectURL(READER.pdfObjectUrl); READER.pdfObjectUrl = null; }
  document.getElementById('pdf-original-wrap').innerHTML = '';
  document.getElementById('pdf-reflow-content').innerHTML = '';
  renderLibrary();
}
document.getElementById('reader-close').addEventListener('click', closeReader);

function toggleImmersive(force) {
  const rv = document.getElementById('reader-view');
  const next = typeof force === 'boolean' ? force : !rv.classList.contains('immersive');
  rv.classList.toggle('immersive', next);
  READER.settings.immersive = next;
  saveReaderSettings();
  if (next && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else if (!next && document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
}
document.getElementById('reader-fullscreen-btn').addEventListener('click', () => toggleImmersive());
document.getElementById('immersive-exit-btn').addEventListener('click', () => toggleImmersive(false));

function closeAllPanels() {
  document.querySelectorAll('#settings-panel,#toc-panel,#search-panel,#notes-panel').forEach((p) => p.classList.remove('open'));
}
document.querySelectorAll('[data-close-panel]').forEach((b) =>
  b.addEventListener('click', () => document.getElementById(b.dataset.closePanel).classList.remove('open')));

/* ---------------------------- EPUB ---------------------------- */
async function openEpub(book, progress) {
  const container = document.getElementById('epub-container');
  container.classList.remove('hidden');
  READER.epubBook = ePub(book.fileBlob);
  READER.rendition = READER.epubBook.renderTo(container, {
    width: '100%', height: '100%',
    flow: READER.settings.scrollMode === 'scrolled' ? 'scrolled-doc' : 'paginated',
    spread: READER.settings.doublePage === 'on' ? 'auto' : 'none',
  });
  registerEpubThemes();
  applyEpubStyleSettings();

  READER.rendition.on('relocated', (loc) => {
    let percent = progress.percent || 0;
    if (READER.locationsReady) percent = Math.round(READER.epubBook.locations.percentageFromCfi(loc.start.cfi) * 100);
    else if (READER.epubBook.spine && READER.epubBook.spine.items?.length) {
      percent = Math.round(((loc.start.index || 0) / READER.epubBook.spine.items.length) * 100);
    }
    persistProgress({ location: loc.start.cfi, percent });
  });

  await READER.rendition.display(progress.location || undefined);

  READER.rendition.on('rendered', () => {
    try {
      const contents = READER.rendition.getContents();
      const fontCssUrl = new URL('vendor/fonts/opendyslexic.css', document.baseURI).href;
      contents.forEach((c) => {
        if (c.document._tapBound) return;
        c.document._tapBound = true;
        try { c.addStylesheet(fontCssUrl); } catch (_) {}
        let tsx = 0, tsy = 0, tst = 0;
        c.document.addEventListener('touchstart', (e) => {
          if (e.touches.length !== 1) return;
          tsx = e.touches[0].clientX; tsy = e.touches[0].clientY; tst = Date.now();
        }, { passive: true });
        c.document.addEventListener('touchend', (e) => {
          const dx = e.changedTouches[0].clientX - tsx;
          const dy = e.changedTouches[0].clientY - tsy;
          if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && Date.now() - tst < 350) toggleImmersive();
        }, { passive: true });
      });
    } catch (_) {}
  });

  READER.epubBook.locations.generate(700).then(() => {
    READER.locationsReady = true;
  }).catch(() => {});

  buildEpubTOC();
}
function registerEpubThemes() {
  const r = READER.rendition;
  r.themes.register('light', { body: { background: THEME_COLORS.light.bg, color: THEME_COLORS.light.fg } });
  r.themes.register('sepia', { body: { background: THEME_COLORS.sepia.bg, color: THEME_COLORS.sepia.fg } });
  r.themes.register('dark', { body: { background: THEME_COLORS.dark.bg, color: THEME_COLORS.dark.fg } });
}
const FONT_STACKS = {
  serif: "'Iowan Old Style','Palatino Linotype', Georgia, serif",
  sans: "-apple-system, 'Segoe UI', Roboto, sans-serif",
  dyslexic: "'OpenDyslexic', 'Comic Sans MS', sans-serif",
};
function applyEpubStyleSettings() {
  const r = READER.rendition; if (!r) return;
  const s = READER.settings;
  r.themes.select(s.theme);
  r.themes.fontSize(s.fontSize + 'px');
  r.themes.font(FONT_STACKS[s.fontFamily]);
  r.themes.override('line-height', s.lineHeight);
  r.themes.override('letter-spacing', s.fontFamily === 'dyslexic' ? '0.04em' : 'normal');
  r.themes.override('text-align', s.textAlign === 'justify' ? 'justify' : 'left');
  const marginPct = s.margins * 2;
  r.themes.override('padding', `0 ${marginPct}%`);
  r.spread(s.doublePage === 'on' ? 'auto' : 'none');
}
function buildEpubTOC() {
  READER.epubBook.loaded.navigation.then((nav) => {
    const list = document.getElementById('toc-list');
    list.innerHTML = '';
    (nav.toc || []).forEach((item) => {
      const el = document.createElement('div');
      el.className = 'toc-item';
      el.textContent = item.label.trim();
      el.addEventListener('click', () => { READER.rendition.display(item.href); document.getElementById('toc-panel').classList.remove('open'); });
      list.appendChild(el);
    });
    if (!nav.toc || !nav.toc.length) list.innerHTML = '<p class="sub">Aucune table des matières disponible.</p>';
  });
}
async function searchEpub(query) {
  const results = [];
  const q = query.toLowerCase();
  const spineItems = READER.epubBook.spine.spineItems.slice(0, 60);
  for (const item of spineItems) {
    try {
      await item.load(READER.epubBook.load.bind(READER.epubBook));
      const text = (item.document?.body?.innerText || '').toLowerCase();
      const idx = text.indexOf(q);
      if (idx !== -1) {
        results.push({ href: item.href, excerpt: '…' + text.slice(Math.max(0, idx - 40), idx + 60) + '…' });
      }
      item.unload();
    } catch (_) {}
    if (results.length >= 30) break;
  }
  return results;
}

/* ---------------------------- PDF ---------------------------- */
async function openPdf(book, progress) {
  document.getElementById('pdf-container').classList.remove('hidden');
  const arrayBuffer = await book.fileBlob.arrayBuffer();
  READER.pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  buildPdfTOC();
  await ensureReflowCache();
  setPdfMode(READER.pdfMode, true);
}
async function ensureReflowCache() {
  if (READER.reflowPages) return;
  const cached = await idbGet('reflowCache', READER.bookId);
  if (cached) { READER.reflowPages = cached.pages; return; }
  toast('Préparation du mode Reflow…', 1800);
  const pages = [];
  const n = READER.pdfDoc.numPages;
  for (let i = 1; i <= n; i++) {
    const page = await READER.pdfDoc.getPage(i);
    const content = await page.getTextContent();
    pages.push({ pageNum: i, text: reconstructParagraphs(content.items) });
  }
  READER.reflowPages = pages;
  idbPut('reflowCache', { bookId: READER.bookId, pages }).catch(() => {});
}
function reconstructParagraphs(items) {
  // Regroupe les fragments de texte de pdf.js en lignes (proximité verticale)
  // puis en paragraphes (grands écarts verticaux ou fin de ligne courte).
  const lines = [];
  let curLine = null;
  let lastY = null;
  items.forEach((it) => {
    const y = Math.round(it.transform[5]);
    if (lastY === null || Math.abs(y - lastY) > 4) {
      curLine = { y, text: it.str };
      lines.push(curLine);
    } else {
      curLine.text += it.str;
    }
    lastY = y;
  });
  const paragraphs = [];
  let buf = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].text.trim();
    buf += (buf ? ' ' : '') + line;
    const nextGap = i < lines.length - 1 ? Math.abs(lines[i].y - lines[i + 1].y) : 0;
    const endsSentence = /[.!?:]$/.test(line);
    if (nextGap > 16 || (endsSentence && line.length < 70) || i === lines.length - 1) {
      if (buf.trim()) paragraphs.push(buf.trim());
      buf = '';
    }
  }
  return paragraphs;
}
function buildPdfTOC() {
  const list = document.getElementById('toc-list');
  list.innerHTML = '<p class="sub">Chargement…</p>';
  READER.pdfDoc.getOutline().then(async (outline) => {
    list.innerHTML = '';
    if (!outline || !outline.length) { list.innerHTML = '<p class="sub">Aucune table des matières disponible.</p>'; return; }
    const flat = [];
    const walk = (items, depth) => items.forEach((it) => { flat.push({ it, depth }); if (it.items?.length) walk(it.items, depth + 1); });
    walk(outline, 0);
    for (const { it, depth } of flat) {
      const el = document.createElement('div');
      el.className = 'toc-item';
      el.style.paddingLeft = (10 + depth * 14) + 'px';
      el.textContent = it.title;
      el.addEventListener('click', async () => {
        try {
          let pageNum = 1;
          if (it.dest) {
            const dest = typeof it.dest === 'string' ? await READER.pdfDoc.getDestination(it.dest) : it.dest;
            const ref = dest[0];
            pageNum = (await READER.pdfDoc.getPageIndex(ref)) + 1;
          }
          goToPdfPage(pageNum);
        } catch (_) {}
        document.getElementById('toc-panel').classList.remove('open');
      });
      list.appendChild(el);
    }
  }).catch(() => { list.innerHTML = '<p class="sub">Aucune table des matières disponible.</p>'; });
}
function goToPdfPage(pageNum) {
  if (READER.pdfMode === 'original') {
    const canvas = document.getElementById('pdf-page-' + pageNum);
    if (canvas) canvas.scrollIntoView({ block: 'start' });
  } else {
    const el = document.querySelector(`#pdf-reflow-content [data-page="${pageNum}"]`);
    if (el) el.scrollIntoView({ block: 'start', inline: 'start' });
  }
}

function setPdfMode(mode, isInitial) {
  READER.pdfMode = mode;
  document.getElementById('reflow-label').textContent = mode === 'reflow' ? 'Reflow' : 'Original';
  document.getElementById('pdf-original-wrap').classList.toggle('hidden', mode !== 'original');
  document.getElementById('pdf-reflow-wrap').classList.toggle('hidden', mode !== 'reflow');
  document.getElementById('double-page-group').classList.toggle('hidden', mode !== 'original');
  if (mode === 'reflow') renderPdfReflow(isInitial);
  else renderPdfOriginal(isInitial);
  if (!isInitial) persistProgress({ mode });
}
document.getElementById('reader-toggle-reflow').addEventListener('click', () => {
  if (READER.format !== 'pdf') return;
  setPdfMode(READER.pdfMode === 'reflow' ? 'original' : 'reflow', false);
});

function renderPdfReflow(isInitial) {
  const content = document.getElementById('pdf-reflow-content');
  content.innerHTML = '';
  READER.reflowPages.forEach((p) => {
    p.text.forEach((para, idx) => {
      const pEl = document.createElement('p');
      if (idx === 0) pEl.dataset.page = p.pageNum;
      pEl.textContent = para;
      content.appendChild(pEl);
    });
  });
  applyPdfReflowLayout();
  const wrap = document.getElementById('pdf-reflow-wrap');
  const loc = READER.progress.location || {};
  requestAnimationFrame(() => {
    if (READER.settings.scrollMode === 'paginated') {
      wrap.scrollLeft = (loc.scrollPct || 0) * Math.max(0, wrap.scrollWidth - wrap.clientWidth);
    } else {
      wrap.scrollTop = (loc.scrollPct || 0) * Math.max(0, wrap.scrollHeight - wrap.clientHeight);
    }
  });
  wrap.onscroll = throttle(() => {
    const pctX = wrap.scrollWidth > wrap.clientWidth ? wrap.scrollLeft / (wrap.scrollWidth - wrap.clientWidth) : 0;
    const pctY = wrap.scrollHeight > wrap.clientHeight ? wrap.scrollTop / (wrap.scrollHeight - wrap.clientHeight) : 0;
    const scrollPct = READER.settings.scrollMode === 'paginated' ? pctX : pctY;
    const percent = Math.round(scrollPct * 100);
    persistProgress({ location: { scrollPct }, percent });
  }, 400);
}
function applyPdfReflowLayout() {
  const wrap = document.getElementById('pdf-reflow-wrap');
  if (READER.settings.scrollMode === 'paginated') {
    wrap.style.columnWidth = wrap.clientWidth + 'px';
    wrap.style.columnGap = '0px';
    wrap.style.overflowX = 'auto'; wrap.style.overflowY = 'hidden';
    wrap.style.scrollSnapType = 'x mandatory';
  } else {
    wrap.style.columnWidth = ''; wrap.style.columnGap = '';
    wrap.style.overflowX = 'hidden'; wrap.style.overflowY = 'auto';
    wrap.style.scrollSnapType = '';
  }
}

let pdfObservers = [];
function renderPdfOriginal(isInitial) {
  const wrap = document.getElementById('pdf-original-wrap');
  wrap.innerHTML = '';
  pdfObservers.forEach((o) => o.disconnect()); pdfObservers = [];
  wrap.classList.toggle('double-page', READER.settings.doublePage === 'on');
  wrap.style.display = READER.settings.doublePage === 'on' ? 'flex' : 'flex';
  wrap.style.flexDirection = READER.settings.doublePage === 'on' ? 'row' : 'column';
  wrap.style.flexWrap = READER.settings.doublePage === 'on' ? 'wrap' : 'nowrap';
  wrap.style.justifyContent = 'center';

  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) renderPdfPageCanvas(entry.target);
    });
  }, { root: wrap, rootMargin: '600px 0px' });
  pdfObservers.push(io);

  for (let i = 1; i <= READER.pdfDoc.numPages; i++) {
    const canvas = document.createElement('canvas');
    canvas.id = 'pdf-page-' + i;
    canvas.dataset.page = i;
    canvas.style.width = READER.settings.doublePage === 'on' ? '46%' : '92%';
    wrap.appendChild(canvas);
    io.observe(canvas);
  }
  const loc = READER.progress.location || { page: 1 };
  requestAnimationFrame(() => goToPdfPage(loc.page || 1));

  wrap.onscroll = throttle(() => {
    const canvases = Array.from(wrap.querySelectorAll('canvas'));
    const wrapRect = wrap.getBoundingClientRect();
    let closest = canvases[0];
    let minDist = Infinity;
    canvases.forEach((c) => {
      const d = Math.abs(c.getBoundingClientRect().top - wrapRect.top);
      if (d < minDist) { minDist = d; closest = c; }
    });
    if (closest) {
      const page = parseInt(closest.dataset.page, 10);
      const percent = Math.round((page / READER.pdfDoc.numPages) * 100);
      persistProgress({ location: { page }, percent });
    }
  }, 400);
}
async function renderPdfPageCanvas(canvas) {
  if (canvas.dataset.rendered) return;
  canvas.dataset.rendered = '1';
  const pageNum = parseInt(canvas.dataset.page, 10);
  const page = await READER.pdfDoc.getPage(pageNum);
  const wrap = document.getElementById('pdf-original-wrap');
  const targetWidth = (READER.settings.doublePage === 'on' ? wrap.clientWidth * 0.44 : wrap.clientWidth * 0.9);
  const baseViewport = page.getViewport({ scale: 1 });
  const scale = (targetWidth / baseViewport.width) * 2; // x2 for sharpness
  const viewport = page.getViewport({ scale });
  canvas.width = viewport.width; canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
}
async function searchPdf(query) {
  await ensureReflowCache();
  const q = query.toLowerCase();
  const results = [];
  READER.reflowPages.forEach((p) => {
    p.text.forEach((para) => {
      const idx = para.toLowerCase().indexOf(q);
      if (idx !== -1 && results.length < 30) {
        results.push({ page: p.pageNum, excerpt: '…' + para.slice(Math.max(0, idx - 40), idx + 60) + '…' });
      }
    });
  });
  return results;
}

/* ---------------------------- Panels: settings / TOC / search / notes ---------------------------- */
document.getElementById('reader-settings-btn').addEventListener('click', () => {
  closeAllPanels(); document.getElementById('settings-panel').classList.add('open');
});
document.getElementById('reader-toc-btn').addEventListener('click', () => {
  closeAllPanels(); document.getElementById('toc-panel').classList.add('open');
});
document.getElementById('reader-search-btn').addEventListener('click', () => {
  closeAllPanels(); document.getElementById('search-panel').classList.add('open');
});
document.getElementById('reader-notes-btn').addEventListener('click', () => {
  closeAllPanels(); document.getElementById('notes-panel').classList.add('open'); renderNotesList();
});

document.getElementById('reader-search-input').addEventListener('input', debounce(async (e) => {
  const q = e.target.value.trim();
  const box = document.getElementById('search-results');
  if (q.length < 3) { box.innerHTML = '<p class="sub">Tapez au moins 3 caractères.</p>'; return; }
  box.innerHTML = '<p class="sub">Recherche…</p>';
  const results = READER.format === 'epub' ? await searchEpub(q) : await searchPdf(q);
  box.innerHTML = '';
  if (!results.length) { box.innerHTML = '<p class="sub">Aucun résultat.</p>'; return; }
  results.forEach((r) => {
    const el = document.createElement('div');
    el.className = 'search-result';
    el.textContent = r.excerpt;
    el.addEventListener('click', () => {
      if (READER.format === 'epub') READER.rendition.display(r.href);
      else goToPdfPage(r.page);
      document.getElementById('search-panel').classList.remove('open');
    });
    box.appendChild(el);
  });
}, 350));

/* ---- Theme / typography controls ---- */
document.querySelectorAll('.theme-swatch').forEach((el) => el.addEventListener('click', () => {
  READER.settings.theme = el.dataset.theme; reflectSettingsUI(); saveReaderSettings();
  if (READER.format === 'epub') applyEpubStyleSettings(); applyThemeToChrome();
}));
document.getElementById('range-fontsize').addEventListener('input', (e) => {
  READER.settings.fontSize = +e.target.value; saveReaderSettings();
  if (READER.format === 'epub') applyEpubStyleSettings(); else applyPdfTypography();
});
document.getElementById('range-lineheight').addEventListener('input', (e) => {
  READER.settings.lineHeight = +e.target.value; saveReaderSettings();
  if (READER.format === 'epub') applyEpubStyleSettings(); else applyPdfTypography();
});
document.getElementById('range-margins').addEventListener('input', (e) => {
  READER.settings.margins = +e.target.value; saveReaderSettings();
  if (READER.format === 'epub') applyEpubStyleSettings(); else applyPdfTypography();
});
document.getElementById('range-brightness').addEventListener('input', (e) => {
  READER.settings.brightness = +e.target.value; saveReaderSettings();
  document.getElementById('brightness-overlay').style.opacity = e.target.value / 100;
});
document.querySelectorAll('#font-family-control button').forEach((b) => b.addEventListener('click', () => {
  READER.settings.fontFamily = b.dataset.font; reflectSettingsUI(); saveReaderSettings();
  if (READER.format === 'epub') applyEpubStyleSettings(); else applyPdfTypography();
}));
document.querySelectorAll('#scroll-mode-control button').forEach((b) => b.addEventListener('click', () => {
  READER.settings.scrollMode = b.dataset.mode; reflectSettingsUI(); saveReaderSettings();
  if (READER.format === 'epub') {
    const cfi = READER.rendition?.currentLocation()?.start?.cfi;
    READER.rendition.flow(READER.settings.scrollMode === 'scrolled' ? 'scrolled-doc' : 'paginated');
    if (cfi) READER.rendition.display(cfi);
  } else if (READER.pdfMode === 'reflow') applyPdfReflowLayout();
}));
document.querySelectorAll('#double-page-control button').forEach((b) => b.addEventListener('click', () => {
  READER.settings.doublePage = b.dataset.dp; reflectSettingsUI(); saveReaderSettings();
  if (READER.format === 'epub') applyEpubStyleSettings();
  else if (READER.pdfMode === 'original') renderPdfOriginal(false);
}));
document.querySelectorAll('#align-control button').forEach((b) => b.addEventListener('click', () => {
  READER.settings.textAlign = b.dataset.align; reflectSettingsUI(); saveReaderSettings();
  if (READER.format === 'epub') applyEpubStyleSettings(); else applyPdfTypography();
}));
function applyPdfTypography() {
  const content = document.getElementById('pdf-reflow-content');
  const s = READER.settings;
  content.style.fontSize = s.fontSize + 'px';
  content.style.lineHeight = s.lineHeight;
  content.style.fontFamily = FONT_STACKS[s.fontFamily];
  content.style.letterSpacing = s.fontFamily === 'dyslexic' ? '0.04em' : 'normal';
  content.style.padding = `0 ${s.margins * 2}%`;
  content.style.textAlign = s.textAlign === 'justify' ? 'justify' : 'left';
  content.style.hyphens = s.textAlign === 'justify' ? 'auto' : 'manual';
  content.style.webkitHyphens = s.textAlign === 'justify' ? 'auto' : 'manual';
  applyPdfReflowLayout();
}
function applyThemeToChrome() {
  const c = THEME_COLORS[READER.settings.theme];
  document.getElementById('reader-body').style.background = c.bg;
  document.getElementById('pdf-reflow-content').style.color = c.fg;
  document.getElementById('pdf-original-wrap').style.background = c.bg;
  applyPdfTypography();
}

/* ---- Notes ---- */
document.getElementById('add-note-btn').addEventListener('click', async () => {
  const input = document.getElementById('new-note-input');
  const text = input.value.trim();
  if (!text) return;
  let position;
  if (READER.format === 'epub') position = { type: 'cfi', value: READER.rendition?.currentLocation()?.start?.cfi };
  else if (READER.pdfMode === 'original') position = { type: 'page', value: parseInt(document.querySelector('#pdf-original-wrap canvas[data-page]')?.dataset.page || 1, 10) };
  else position = { type: 'page', value: READER.progress.location?.scrollPct ? Math.ceil((READER.reflowPages?.length || 1) * READER.progress.location.scrollPct) : 1 };
  const note = { id: uid(), bookId: READER.bookId, text, position, createdAt: Date.now() };
  await idbPut('notes', note);
  input.value = '';
  renderNotesList();
  toast('Note enregistrée.');
});
async function renderNotesList() {
  const all = await idbGetAll('notes');
  const mine = all.filter((n) => n.bookId === READER.bookId).sort((a, b) => b.createdAt - a.createdAt);
  const box = document.getElementById('notes-list');
  box.innerHTML = mine.length ? '' : '<p class="sub">Aucune note pour ce livre.</p>';
  mine.forEach((n) => {
    const el = document.createElement('div');
    el.className = 'note-item';
    const posLabel = n.position?.type === 'cfi' ? 'position enregistrée' : `page ${n.position?.value || '?'}`;
    el.innerHTML = `<div class="note-quote">${posLabel} · ${new Date(n.createdAt).toLocaleDateString('fr-FR')}</div><div>${escapeHtml(n.text)}</div>`;
    el.addEventListener('click', () => {
      if (n.position?.type === 'cfi' && READER.format === 'epub') READER.rendition.display(n.position.value);
      else if (n.position?.type === 'page') goToPdfPage(n.position.value);
    });
    box.appendChild(el);
  });
}

/* ---------------------------- Progress persistence ---------------------------- */
function persistProgress(patch) {
  READER.progress = Object.assign(READER.progress, patch, { lastRead: Date.now() });
  if (READER.progress.percent >= 99 && !READER.progress.finishedAt) READER.progress.finishedAt = Date.now();
  idbPut('progress', READER.progress);
  updateProgressBar(READER.progress.percent || 0);
}
function updateProgressBar(percent) {
  document.getElementById('reader-progress-fill').style.width = Math.min(100, Math.max(0, percent)) + '%';
}

/* ---------------------------- Wake Lock ---------------------------- */
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    READER.wakeLockSentinel = await navigator.wakeLock.request('screen');
    READER.wakeLockSentinel.addEventListener('release', () => { READER.wakeLockSentinel = null; });
  } catch (_) {}
}
function releaseWakeLock() {
  if (READER.wakeLockSentinel) { READER.wakeLockSentinel.release().catch(() => {}); READER.wakeLockSentinel = null; }
}
document.addEventListener('visibilitychange', () => {
  const readerOpen = document.getElementById('reader-view').classList.contains('active');
  if (document.visibilityState === 'hidden') {
    releaseWakeLock();
    if (readerOpen) finalizeSession(true);
  } else if (readerOpen) {
    requestWakeLock();
    READER.sessionStart = Date.now();
  }
});
window.addEventListener('pagehide', () => finalizeSession());

/* ---------------------------- Reading sessions (for goals/stats) ---------------------------- */
function finalizeSession(keepOpen) {
  if (!READER.sessionStart || !READER.bookId) return;
  const durationSec = Math.round((Date.now() - READER.sessionStart) / 1000);
  READER.sessionStart = keepOpen ? null : null;
  if (durationSec >= 5) {
    idbPut('sessions', { id: uid(), bookId: READER.bookId, date: dateKey(), durationSec, ts: Date.now() }).catch(() => {});
  }
}

/* ---------------------------- Text-to-speech ---------------------------- */
document.getElementById('reader-tts-btn').addEventListener('click', () => {
  if (READER.ttsActive) stopTTS(); else startTTS();
});
function getCurrentText() {
  if (READER.format === 'epub') {
    const contents = READER.rendition?.getContents?.();
    if (contents && contents.length) return contents[0].document.body.innerText;
    return '';
  }
  if (READER.pdfMode === 'reflow') {
    const visible = document.querySelector('#pdf-reflow-content p');
    return Array.from(document.querySelectorAll('#pdf-reflow-content p')).map((p) => p.textContent).join(' ');
  }
  const pageEl = document.querySelector('#pdf-original-wrap canvas[data-page]');
  const pageNum = pageEl ? parseInt(pageEl.dataset.page, 10) : 1;
  const pageData = READER.reflowPages?.find((p) => p.pageNum === pageNum);
  return pageData ? pageData.text.join(' ') : '';
}
function startTTS() {
  if (!('speechSynthesis' in window)) { toast('Synthèse vocale non disponible sur ce navigateur.'); return; }
  const text = getCurrentText();
  if (!text.trim()) { toast('Aucun texte à lire sur cette vue.'); return; }
  const utter = new SpeechSynthesisUtterance(text.slice(0, 6000));
  utter.lang = 'fr-FR'; utter.rate = 1;
  utter.onend = () => {
    READER.ttsActive = false;
    document.getElementById('reader-tts-btn').classList.remove('on');
    if (READER._ttsAutoAdvance) advanceForTTS();
  };
  READER._ttsAutoAdvance = true;
  speechSynthesis.cancel();
  speechSynthesis.speak(utter);
  READER.ttsActive = true;
  document.getElementById('reader-tts-btn').classList.add('on');
}
function stopTTS() {
  READER._ttsAutoAdvance = false;
  speechSynthesis.cancel();
  READER.ttsActive = false;
  document.getElementById('reader-tts-btn').classList.remove('on');
}
function advanceForTTS() {
  if (READER.format === 'epub') READER.rendition?.next().then(() => startTTS());
  else toast('Fin de la lecture audio de cette page.');
}

/* ---------------------------- Swipe navigation (mobile/tablette) ---------------------------- */
(function setupSwipe() {
  const body = document.getElementById('reader-body');
  let startX = null, startY = null, startT = 0;
  body.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX; startY = e.touches[0].clientY; startT = Date.now();
  }, { passive: true });
  body.addEventListener('touchend', (e) => {
    if (startX === null) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    const elapsed = Date.now() - startT;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (READER.settings.scrollMode !== 'paginated') { startX = null; return; }
      if (READER.format === 'epub') { dx < 0 ? READER.rendition.next() : READER.rendition.prev(); }
      else if (READER.pdfMode === 'reflow') {
        const wrap = document.getElementById('pdf-reflow-wrap');
        wrap.scrollLeft += dx < 0 ? wrap.clientWidth : -wrap.clientWidth;
      }
    } else if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && elapsed < 350) {
      // Tap simple sans déplacement : bascule l'affichage des barres.
      toggleImmersive();
    }
    startX = null; startY = null;
  }, { passive: true });
})();

/* ---------------------------- Utils ---------------------------- */
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function throttle(fn, ms) { let last = 0; return (...a) => { const now = Date.now(); if (now - last > ms) { last = now; fn(...a); } }; }
