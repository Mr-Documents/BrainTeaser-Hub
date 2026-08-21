/**
 * The play surface: fetch a puzzle, run its clock, reveal hints, grade answers,
 * and keep the leaderboard and charts in sync.
 */
(function () {
  'use strict';

  const { api, toast, el, escapeHtml, storage, readBootstrap, copyToClipboard } = window.BTH;
  const boot = readBootstrap();

  const SEEN_KEY = 'bth:seen';
  const NUDGE_KEY = 'bth:signin-nudged';

  const dom = {
    loading: el('puzzle-loading'),
    loadingText: el('puzzle-loading-text'),
    card: el('puzzle-card'),
    body: el('puzzle-body'),
    badgeType: el('badge-type'),
    badgeDifficulty: el('badge-difficulty'),
    badgePoints: el('badge-points'),
    question: el('puzzle-question'),
    hints: el('hint-stack'),
    form: el('answer-form'),
    input: el('answer-input'),
    submit: el('btn-submit'),
    hintBtn: el('btn-hint'),
    hintLabel: el('hint-label'),
    hintCounter: el('hint-counter'),
    nextBtn: el('btn-next'),
    shareBtn: el('btn-share'),
    feedback: el('feedback'),
    explanation: el('explanation'),
    timerValue: el('timer-value'),
    filterType: el('filter-type'),
    filterDifficulty: el('filter-difficulty'),
    resetSeen: el('btn-reset-seen'),
    sessionPoints: el('session-points'),
    sessionSolves: el('session-solves'),
    sessionStreak: el('session-streak'),
    leaderboardBody: el('leaderboard-body'),
  };

  const state = {
    puzzle: null,
    attemptToken: null,
    solved: false,
    hintsShown: 0,
    seen: storage.get(SEEN_KEY, []),
    session: { points: 0, solves: 0, streak: 0 },
    timerId: null,
    startedAt: 0,
    busy: false,
  };

  // ------------------------------------------------------------------- timer

  function startTimer() {
    stopTimer();
    state.startedAt = Date.now();
    render();
    state.timerId = window.setInterval(render, 1000);

    function render() {
      const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
      const minutes = Math.floor(elapsed / 60);
      const seconds = String(elapsed % 60).padStart(2, '0');
      if (dom.timerValue) dom.timerValue.textContent = `${minutes}:${seconds}`;
      // The speed bonus is gone after two minutes - dim the clock so it reads as spent.
      dom.timerValue?.parentElement?.classList.toggle('is-cold', elapsed >= 120);
      dom.timerValue?.parentElement?.classList.toggle('is-hot', elapsed < 20);
    }
  }

  function stopTimer() {
    if (state.timerId) window.clearInterval(state.timerId);
    state.timerId = null;
  }

  // ----------------------------------------------------------------- rendering

  function setFeedback(text, kind) {
    if (!dom.feedback) return;
    dom.feedback.textContent = text || '';
    dom.feedback.className = `feedback${kind ? ` is-${kind}` : ''}`;
  }

  function setCardState(kind) {
    dom.card.classList.remove('is-correct', 'is-wrong');
    if (kind) dom.card.classList.add(`is-${kind}`);
  }

  function showLoading(message) {
    stopTimer();
    setFeedback('');
    setCardState(null);
    dom.explanation.hidden = true;
    dom.hints.innerHTML = '';
    dom.input.value = '';
    dom.body.hidden = true;
    dom.loading.hidden = false;
    dom.loadingText.textContent = message;
    dom.loadingText.classList.remove('is-error');
  }

  function showLoadError(message) {
    dom.loading.hidden = false;
    dom.body.hidden = true;
    dom.loadingText.textContent = message;
    dom.loadingText.classList.add('is-error');
  }

  function renderPuzzle(session) {
    state.puzzle = session.puzzle;
    state.attemptToken = session.attemptToken;
    state.solved = false;
    state.hintsShown = 0;

    const puzzle = session.puzzle;
    if (!state.seen.includes(puzzle.id)) {
      state.seen.push(puzzle.id);
      storage.set(SEEN_KEY, state.seen.slice(-500));
    }

    dom.badgeType.textContent = boot.typeLabels?.[puzzle.type] || puzzle.type;
    dom.badgeType.className = `badge badge--${puzzle.type}`;
    dom.badgeDifficulty.textContent = boot.difficultyLabels?.[puzzle.difficulty] || puzzle.difficulty;
    dom.badgeDifficulty.className = `badge badge--${puzzle.difficulty}`;
    dom.badgePoints.textContent = `${puzzle.basePoints} pts`;
    dom.question.textContent = puzzle.question;

    dom.hintBtn.hidden = !puzzle.hasHints;
    dom.hintBtn.disabled = false;
    dom.hintLabel.textContent = 'Hint';
    dom.hintCounter.textContent = puzzle.hasHints ? `0/${puzzle.hintCount}` : '';

    dom.loading.hidden = true;
    dom.body.hidden = false;
    dom.input.disabled = false;
    dom.submit.disabled = false;
    dom.input.focus({ preventScroll: true });
    startTimer();
  }

  function renderLeaderboard(entries) {
    if (!dom.leaderboardBody) return;
    if (!entries || !entries.length) {
      dom.leaderboardBody.innerHTML = '<tr><td colspan="3" class="empty">No scores yet - be first!</td></tr>';
      return;
    }
    dom.leaderboardBody.innerHTML = entries
      .map(
        (row, i) =>
          `<tr${i === 0 ? ' class="is-top"' : ''}><td>${i + 1}</td><td>${escapeHtml(row.displayName)}</td>` +
          `<td class="num">${Number(row.totalScore || 0).toLocaleString('en-US')}</td></tr>`
      )
      .join('');
  }

  function renderSession() {
    dom.sessionPoints.textContent = `${state.session.points} pts`;
    dom.sessionSolves.textContent = String(state.session.solves);
    dom.sessionStreak.textContent = state.session.streak ? `${state.session.streak} 🔥` : '-';
  }

  // -------------------------------------------------------------------- charts

  const charts = { type: null, difficulty: null, guess: null };

  const PALETTE = {
    logic: '#6366f1',
    math: '#10b981',
    word: '#f59e0b',
    lateral: '#ec4899',
    trivia: '#38bdf8',
    easy: '#38bdf8',
    medium: '#a855f7',
    hard: '#ef4444',
    correct: '#22c55e',
    wrong: '#f87171',
  };

  function chartTextColor() {
    return getComputedStyle(document.documentElement).getPropertyValue('--chart-ink').trim() || '#94a3b8';
  }

  function initCharts(stats) {
    if (typeof window.Chart === 'undefined') return;
    const ink = chartTextColor();
    const common = {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: 4 },
      animation: { duration: 350 },
    };

    const types = Object.keys(stats.completionsByType || {});
    const difficulties = Object.keys(stats.completionsByDifficulty || {});

    charts.type = new window.Chart(el('chart-type'), {
      type: 'doughnut',
      data: {
        labels: types.map((t) => boot.typeLabels?.[t] || t),
        datasets: [
          {
            data: types.map((t) => stats.completionsByType[t] || 0),
            backgroundColor: types.map((t) => PALETTE[t] || '#64748b'),
            borderWidth: 0,
          },
        ],
      },
      options: {
        ...common,
        cutout: '58%',
        plugins: {
          legend: { position: 'bottom', labels: { color: ink, boxWidth: 10, padding: 8, font: { size: 11 } } },
        },
      },
    });

    charts.difficulty = new window.Chart(el('chart-difficulty'), {
      type: 'bar',
      data: {
        labels: difficulties.map((d) => boot.difficultyLabels?.[d] || d),
        datasets: [
          {
            data: difficulties.map((d) => stats.completionsByDifficulty[d] || 0),
            backgroundColor: difficulties.map((d) => PALETTE[d] || '#64748b'),
            borderRadius: 6,
          },
        ],
      },
      options: {
        ...common,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: ink, font: { size: 11 } }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { color: ink, precision: 0 }, grid: { color: 'rgba(128,138,160,0.15)' } },
        },
      },
    });

    const cw = stats.correctVsWrong || { correct: 0, wrong: 0 };
    charts.guess = new window.Chart(el('chart-guess'), {
      type: 'bar',
      data: {
        labels: ['Correct', 'Wrong'],
        datasets: [
          {
            data: [cw.correct || 0, cw.wrong || 0],
            backgroundColor: [PALETTE.correct, PALETTE.wrong],
            borderRadius: 6,
          },
        ],
      },
      options: {
        ...common,
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, ticks: { color: ink, precision: 0 }, grid: { color: 'rgba(128,138,160,0.15)' } },
          y: { ticks: { color: ink, font: { size: 11 } }, grid: { display: false } },
        },
      },
    });
  }

  function updateCharts(stats) {
    if (!charts.type || !stats) return;
    const types = Object.keys(stats.completionsByType || {});
    charts.type.data.datasets[0].data = types.map((t) => stats.completionsByType[t] || 0);
    charts.type.update();
    const difficulties = Object.keys(stats.completionsByDifficulty || {});
    charts.difficulty.data.datasets[0].data = difficulties.map((d) => stats.completionsByDifficulty[d] || 0);
    charts.difficulty.update();
    const cw = stats.correctVsWrong || { correct: 0, wrong: 0 };
    charts.guess.data.datasets[0].data = [cw.correct || 0, cw.wrong || 0];
    charts.guess.update();
  }

  // --------------------------------------------------------------- data loading

  function currentFilters() {
    const params = new URLSearchParams();
    if (dom.filterType?.value) params.set('type', dom.filterType.value);
    if (dom.filterDifficulty?.value) params.set('difficulty', dom.filterDifficulty.value);
    if (state.seen.length) params.set('exclude', state.seen.join(','));
    return params;
  }

  async function loadRandom() {
    if (state.busy) return;
    state.busy = true;
    showLoading('Finding you a puzzle…');
    try {
      renderPuzzle(await api(`/api/puzzles/random?${currentFilters()}`));
    } catch (error) {
      showLoadError(error.message);
    } finally {
      state.busy = false;
    }
  }

  async function loadDaily() {
    showLoading("Loading today's challenge…");
    try {
      renderPuzzle(await api('/api/puzzles/daily'));
    } catch (error) {
      showLoadError(error.message);
    }
  }

  async function loadById(id) {
    showLoading('Loading the challenge…');
    try {
      renderPuzzle(await api(`/api/puzzles/${encodeURIComponent(id)}`));
    } catch (error) {
      showLoadError(`${error.message} Try a random puzzle instead.`);
    }
  }

  function loadNext() {
    // Daily and challenge modes have exactly one puzzle - "next" means going to the random pool.
    if (boot.mode === 'random') return loadRandom();
    window.location.href = '/play';
    return undefined;
  }

  // ------------------------------------------------------------------- actions

  async function revealHint() {
    if (!state.puzzle || !state.attemptToken || state.solved) return;
    dom.hintBtn.disabled = true;
    try {
      const data = await api(
        `/api/puzzles/${encodeURIComponent(state.puzzle.id)}/hint?attemptToken=${encodeURIComponent(state.attemptToken)}`
      );
      const line = document.createElement('p');
      line.className = 'hint';
      line.innerHTML = `<span class="hint__num">Hint ${data.step}</span> ${escapeHtml(data.hint)}`;
      dom.hints.appendChild(line);
      requestAnimationFrame(() => line.classList.add('is-visible'));

      state.hintsShown = data.step;
      dom.hintCounter.textContent = `${data.step}/${data.total}`;
      dom.hintBtn.disabled = data.remaining === 0;
      // Only the label - setting textContent on the button would destroy the counter span
      // with it, and it would never come back for later puzzles.
      if (data.remaining === 0) dom.hintLabel.textContent = 'No hints left';
      dom.input.focus({ preventScroll: true });
    } catch (error) {
      dom.hintBtn.disabled = false;
      if (error.code === 'attempt_expired') {
        toast('That took a while - reopening the puzzle.', 'info');
        await recoverExpiredSession(dom.input.value);
        return;
      }
      toast(error.message, 'error');
    }
  }

  async function submitAnswer(event) {
    event?.preventDefault();
    if (!state.puzzle || !state.attemptToken) {
      setFeedback('Load a puzzle first.', 'error');
      return;
    }
    if (state.solved) {
      loadNext();
      return;
    }
    const answer = dom.input.value.trim();
    if (!answer) {
      setFeedback('Type an answer first.', 'error');
      dom.input.focus();
      return;
    }

    dom.submit.disabled = true;
    try {
      const result = await api('/api/submit', {
        method: 'POST',
        // No username in the body - the server reads the signed session cookie instead.
        body: { puzzleId: state.puzzle.id, answer, attemptToken: state.attemptToken },
      });

      if (!result.correct) {
        setCardState('wrong');
        setFeedback(result.message, 'error');
        dom.card.classList.remove('shake');
        void dom.card.offsetWidth; // restart the animation
        dom.card.classList.add('shake');
        dom.input.select();
        return;
      }

      state.solved = true;
      stopTimer();
      setCardState('correct');
      setFeedback(result.message, 'success');
      dom.input.disabled = true;

      if (result.explanation) {
        dom.explanation.textContent = result.explanation;
        dom.explanation.hidden = false;
      }
      if (!result.alreadySolved) {
        state.session.points += result.pointsEarned;
        state.session.solves += 1;
        state.session.streak = result.streak || state.session.streak;
        renderSession();
        toast(result.message, 'success');

        // One gentle prompt, after they have something worth keeping - never a wall.
        if (!boot.isSignedIn && state.session.solves === 2 && !storage.get(NUDGE_KEY)) {
          storage.set(NUDGE_KEY, true);
          toast(`${state.session.points} points this session. Sign in to keep them.`, 'info', 7000);
        }
      }
      if (result.leaderboard) renderLeaderboard(result.leaderboard);
      if (result.stats) updateCharts(result.stats);

      dom.nextBtn.focus({ preventScroll: true });
    } catch (error) {
      // A sleeping host (or a deploy) drops the server-side play session. That is our fault,
      // not the player's, so recover it: reload the same puzzle and let them answer again
      // rather than dead-ending them on an error they cannot act on.
      if (error.code === 'attempt_expired' && state.puzzle) {
        await recoverExpiredSession(answer);
        return;
      }
      setFeedback(error.message, 'error');
    } finally {
      dom.submit.disabled = state.solved;
    }
  }

  /**
   * Re-open the current puzzle after its session was lost, restoring what the player typed.
   * Any hints they had already taken are gone with the session, so this is generous by
   * accident - which is the right direction for an error they did not cause.
   */
  async function recoverExpiredSession(answer) {
    const id = state.puzzle.id;
    try {
      const session = await api(`/api/puzzles/${encodeURIComponent(id)}`);
      state.attemptToken = session.attemptToken;
      state.solved = false;
      dom.input.value = answer;
      dom.input.disabled = false;
      dom.submit.disabled = false;
      setFeedback('That took a while - we reopened the puzzle. Submit again.', null);
      dom.input.focus({ preventScroll: true });
    } catch {
      setFeedback('Your session expired. Load a new puzzle to carry on.', 'error');
    }
  }

  async function shareChallenge() {
    if (!state.puzzle) return;
    const url = new URL(`/challenge/${encodeURIComponent(state.puzzle.id)}`, window.location.origin).href;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Brain Teaser Hub', text: 'Can you solve this one?', url });
        return;
      } catch {
        /* the user dismissed the share sheet - fall through to copying */
      }
    }
    toast((await copyToClipboard(url)) ? 'Challenge link copied to your clipboard.' : url, 'info', 5000);
  }

  // -------------------------------------------------------------------- wiring

  dom.form?.addEventListener('submit', submitAnswer);
  dom.hintBtn?.addEventListener('click', revealHint);
  dom.nextBtn?.addEventListener('click', loadNext);
  dom.shareBtn?.addEventListener('click', shareChallenge);

  dom.resetSeen?.addEventListener('click', () => {
    state.seen = [];
    storage.set(SEEN_KEY, []);
    toast('Seen list cleared - every puzzle is back in the pool.', 'info');
    loadRandom();
  });

  [dom.filterType, dom.filterDifficulty].forEach((select) =>
    select?.addEventListener('change', () => {
      const params = new URLSearchParams();
      if (dom.filterType.value) params.set('type', dom.filterType.value);
      if (dom.filterDifficulty.value) params.set('difficulty', dom.filterDifficulty.value);
      // Keep the URL shareable and bookmarkable without a reload.
      window.history.replaceState({}, '', params.toString() ? `/play?${params}` : '/play');
      loadRandom();
    })
  );

  document.addEventListener('keydown', (event) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName);
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'h' || event.key === 'H') {
      if (!dom.hintBtn.hidden && !dom.hintBtn.disabled) revealHint();
    } else if (event.key === 'n' || event.key === 'N') {
      loadNext();
    }
  });

  // --------------------------------------------------------------------- boot

  renderSession();

  // Chart.js is deferred; wait for load so the constructor exists.
  window.addEventListener('load', () => initCharts(boot.stats || {}));

  if (boot.mode === 'daily') loadDaily();
  else if (boot.mode === 'challenge' && boot.challengePuzzleId) loadById(boot.challengePuzzleId);
  else loadRandom();
})();
