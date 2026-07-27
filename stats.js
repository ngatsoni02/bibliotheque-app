/* =========================================================================
   Objectifs de lecture & statistiques intelligentes
   ========================================================================= */

async function getGoal() {
  const g = await idbGet('settings', 'reading-goal');
  return g ? Object.assign({ booksPerWeek: 1, hoursPerWeek: 3, linkedBookIds: [] }, g.value) : { booksPerWeek: 1, hoursPerWeek: 3, linkedBookIds: [] };
}
async function setGoal(booksPerWeek, hoursPerWeek, linkedBookIds) {
  await idbPut('settings', { key: 'reading-goal', value: { booksPerWeek, hoursPerWeek, linkedBookIds: linkedBookIds || [] } });
}

async function renderGoalBooksChecklist(linked) {
  const books = await idbGetAll('books');
  const box = document.getElementById('goal-books-list');
  box.innerHTML = books.length ? '' : '<p class="sub">Aucun livre dans la bibliothèque pour l’instant.</p>';
  books.forEach((b) => {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 2px;font-size:12.5px;cursor:pointer;';
    const checked = linked.includes(b.id) ? 'checked' : '';
    row.innerHTML = `<input type="checkbox" value="${b.id}" ${checked}> <span>${escapeHtml(b.title)}</span>`;
    box.appendChild(row);
  });
}

document.getElementById('btn-edit-goal').addEventListener('click', async () => {
  const g = await getGoal();
  document.getElementById('goal-books').value = g.booksPerWeek;
  document.getElementById('goal-hours').value = g.hoursPerWeek;
  await renderGoalBooksChecklist(g.linkedBookIds || []);
  openModal('modal-goal');
});
document.getElementById('save-goal-btn').addEventListener('click', async () => {
  const books = Math.max(0, +document.getElementById('goal-books').value || 0);
  const hours = Math.max(0, +document.getElementById('goal-hours').value || 0);
  const linkedBookIds = Array.from(document.querySelectorAll('#goal-books-list input:checked')).map((i) => i.value);
  await setGoal(books, hours, linkedBookIds);
  closeModal('modal-goal');
  toast('Objectif mis à jour.');
  renderStats();
});

function computeStreak(sessionDates) {
  const set = new Set(sessionDates);
  let streak = 0;
  let cursor = new Date();
  // Le jour courant ne casse pas la série s'il n'a pas encore de session.
  if (!set.has(dateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (set.has(dateKey(cursor))) { streak++; cursor.setDate(cursor.getDate() - 1); }
  return streak;
}

async function renderStats() {
  const [goal, sessions, progresses, books] = await Promise.all([
    getGoal(), idbGetAll('sessions'), idbGetAll('progress'), idbGetAll('books'),
  ]);
  const grid = document.getElementById('stats-grid');
  grid.innerHTML = '';

  const weekStart = isoWeekStart();
  const weekSessions = sessions.filter((s) => new Date(s.ts) >= weekStart);
  const secondsThisWeek = weekSessions.reduce((a, s) => a + s.durationSec, 0);
  const hoursThisWeek = secondsThisWeek / 3600;

  const booksFinishedThisWeek = progresses.filter((p) => p.finishedAt && p.finishedAt >= weekStart.getTime()).length;

  const daysElapsed = Math.min(7, Math.floor((Date.now() - weekStart.getTime()) / 86400000) + 1);
  const expectedHoursPace = (goal.hoursPerWeek / 7) * daysElapsed;
  const expectedBooksPace = (goal.booksPerWeek / 7) * daysElapsed;
  const behindHours = goal.hoursPerWeek > 0 && hoursThisWeek < expectedHoursPace * 0.7;
  const behindBooks = goal.booksPerWeek > 0 && booksFinishedThisWeek < expectedBooksPace * 0.7;

  const uniqueDays = [...new Set(sessions.map((s) => s.date))];
  const streak = computeStreak(uniqueDays);

  const totalSeconds = sessions.reduce((a, s) => a + s.durationSec, 0);
  const avgBook = (() => {
    // vitesse moyenne = % de progression gagné par seconde de lecture, moyennée sur les livres actifs
    const active = progresses.filter((p) => p.percent > 0 && p.percent < 99);
    if (!active.length || !totalSeconds) return null;
    const totalPercentGained = progresses.reduce((a, p) => a + (p.percent || 0), 0);
    const speedPctPerSec = totalPercentGained / Math.max(totalSeconds, 1) / 100; // fraction/sec
    return speedPctPerSec;
  })();

  /* --- Card: objectif hebdo (livres) --- */
  grid.appendChild(makeCard(`
    <h3>Objectif — livres cette semaine</h3>
    <div class="big-num">${booksFinishedThisWeek}<small> / ${goal.booksPerWeek}</small></div>
    <div class="progress-track"><div class="progress-fill" style="width:${goal.booksPerWeek ? Math.min(100, (booksFinishedThisWeek / goal.booksPerWeek) * 100) : 0}%"></div></div>
    ${behindBooks ? `<div class="goal-alert">📉 Vous êtes en retard sur votre objectif de livres cette semaine.</div>` : ''}
  `));

  /* --- Card: objectif hebdo (heures) --- */
  grid.appendChild(makeCard(`
    <h3>Objectif — heures cette semaine</h3>
    <div class="big-num">${hoursThisWeek.toFixed(1)}<small> / ${goal.hoursPerWeek} h</small></div>
    <div class="progress-track"><div class="progress-fill" style="width:${goal.hoursPerWeek ? Math.min(100, (hoursThisWeek / goal.hoursPerWeek) * 100) : 0}%"></div></div>
    ${behindHours ? `<div class="goal-alert">⏱️ Rythme un peu lent pour atteindre votre objectif d'heures cette semaine.</div>` : ''}
  `));

  /* --- Card: série de jours --- */
  grid.appendChild(makeCard(`
    <h3>Jours consécutifs de lecture</h3>
    <div class="big-num">${streak}<small> jour${streak > 1 ? 's' : ''}</small></div>
    <p class="sub" style="margin-top:8px;">${streak > 0 ? 'Continuez ainsi !' : 'Lisez aujourd’hui pour démarrer une série.'}</p>
  `));

  /* --- Card: temps total --- */
  grid.appendChild(makeCard(`
    <h3>Temps de lecture cumulé</h3>
    <div class="big-num">${(totalSeconds / 3600).toFixed(1)}<small> heures, tous livres</small></div>
  `));

  /* --- Card: livre en cours + ETA --- */
  const inProgress = books
    .map((b) => ({ b, p: progresses.find((p) => p.bookId === b.id) }))
    .filter((x) => x.p && x.p.percent > 0 && x.p.percent < 99)
    .sort((a, c) => (c.p.lastRead || 0) - (a.p.lastRead || 0))[0];
  if (inProgress) {
    let etaText = 'estimation indisponible';
    if (avgBook) {
      const remainingFraction = (100 - inProgress.p.percent) / 100;
      const secondsLeft = remainingFraction / avgBook;
      const hoursLeft = secondsLeft / 3600;
      etaText = hoursLeft < 1 ? `${Math.round(hoursLeft * 60)} min restantes` : `${hoursLeft.toFixed(1)} h restantes`;
    }
    grid.appendChild(makeCard(`
      <h3>En cours — ${escapeHtml(inProgress.b.title)}</h3>
      <div class="big-num">${Math.round(inProgress.p.percent)}<small> % lu</small></div>
      <div class="progress-track"><div class="progress-fill" style="width:${inProgress.p.percent}%"></div></div>
      <p class="sub" style="margin-top:10px;">À votre rythme actuel : ${etaText}.</p>
    `, () => openReader(inProgress.b.id)));
  }

  /* --- Card: suggestion --- */
  const notStarted = books.filter((b) => {
    const p = progresses.find((pp) => pp.bookId === b.id);
    return !p || p.percent < 2;
  }).sort((a, c) => c.addedAt - a.addedAt);
  if (notStarted.length) {
    const s = notStarted[0];
    const coverSrc = s.coverBlob ? URL.createObjectURL(s.coverBlob) : '';
    grid.appendChild(makeCard(`
      <h3>Prochaine lecture suggérée</h3>
      <div class="suggestion-book">
        ${coverSrc ? `<img src="${coverSrc}">` : ''}
        <div><strong style="font-size:13px;">${escapeHtml(s.title)}</strong><br><span class="sub">${escapeHtml(s.author)}</span></div>
      </div>
    `, () => openReader(s.id)));
  }

  if (goal.linkedBookIds && goal.linkedBookIds.length) {
    const linkedBooks = books.filter((b) => goal.linkedBookIds.includes(b.id));
    const finishedCount = linkedBooks.filter((b) => {
      const p = progresses.find((pp) => pp.bookId === b.id);
      return p && p.percent >= 98;
    }).length;
    const rows = linkedBooks.map((b) => {
      const p = progresses.find((pp) => pp.bookId === b.id) || { percent: 0 };
      return `<div style="display:flex;justify-content:space-between;font-size:12px;margin-top:6px;">
        <span>${escapeHtml(b.title)}</span><span style="opacity:.6;">${Math.round(p.percent || 0)}%</span>
      </div>`;
    }).join('');
    grid.appendChild(makeCard(`
      <h3>Livres de l'objectif</h3>
      <div class="big-num">${finishedCount}<small> / ${linkedBooks.length} terminés</small></div>
      ${rows}
    `));
  }

  if (!books.length) {
    grid.innerHTML = '<div class="empty-state"><h2>Pas encore de statistiques</h2><p>Importez et lisez un livre pour voir vos progrès ici.</p></div>';
  }
}
function makeCard(html, onClick) {
  const div = document.createElement('div');
  div.className = 'card';
  div.innerHTML = html;
  if (onClick) { div.style.cursor = 'pointer'; div.addEventListener('click', onClick); }
  return div;
}
