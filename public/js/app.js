(function () {
  const el = (id) => document.getElementById(id);

  const puzzleLoading = el('puzzle-loading');
  const puzzleBody = el('puzzle-body');
  const badgeType = el('badge-type');
  const badgeDifficulty = el('badge-difficulty');
  const badgePoints = el('badge-points');
  const puzzleQuestion = el('puzzle-question');
  const hintStack = el('hint-stack');
  const answerInput = el('answer-input');
  const btnSubmit = el('btn-submit');
  const btnHint = el('btn-hint');
  const btnNew = el('btn-new');
  const btnShareChallenge = el('btn-share-challenge');
  const shareFeedback = el('share-feedback');
  const btnResetSeen = el('btn-reset-seen');
  const feedback = el('feedback');
  const filterType = el('filter-type');
  const filterDifficulty = el('filter-difficulty');
  const usernameInput = el('username');
  const leaderboardBody = el('leaderboard-body');

  let currentPuzzle = null;
  let attemptToken = null;
  const seenIds = [];

  function readPageConfig() {
    const node = document.getElementById('page-config');
    if (!node) return { challengePuzzleId: null, isChallengeRoute: false };
    try {
      const raw = JSON.parse(node.textContent);
      return {
        challengePuzzleId: raw.challengePuzzleId || null,
        isChallengeRoute: !!raw.isChallengeRoute,
      };
    } catch {
      return { challengePuzzleId: null, isChallengeRoute: false };
    }
  }

  const pageConfig = readPageConfig();
  const isChallengeRoute = pageConfig.isChallengeRoute;

  const typeLabels = { logic: 'Logic', math: 'Math', word: 'Word' };
  const diffLabels = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

  let chartType = null;
  let chartDifficulty = null;
  let chartGuess = null;

  function readInitialStats() {
    const node = document.getElementById('initial-stats');
    try {
      return JSON.parse(node.textContent);
    } catch {
      return null;
    }
  }

  function chartPalette() {
    return {
      logic: 'rgba(99, 102, 241, 0.85)',
      math: 'rgba(16, 185, 129, 0.85)',
      word: 'rgba(245, 158, 11, 0.85)',
      easy: 'rgba(56, 189, 248, 0.85)',
      medium: 'rgba(168, 85, 247, 0.85)',
      hard: 'rgba(239, 68, 68, 0.85)',
      correct: 'rgba(34, 197, 94, 0.85)',
      wrong: 'rgba(248, 113, 113, 0.85)',
    };
  }

  function initCharts(stats) {
    const C = chartPalette();
    const typeLabelsArr = ['logic', 'math', 'word'];
    const diffLabelsArr = ['easy', 'medium', 'hard'];

    const typeData = typeLabelsArr.map((k) => stats.completionsByType[k] || 0);
    const diffData = diffLabelsArr.map((k) => stats.completionsByDifficulty[k] || 0);

    const ctx1 = document.getElementById('chart-type');
    const ctx2 = document.getElementById('chart-difficulty');
    const ctx3 = document.getElementById('chart-guess');

    const commonOpts = {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 4, right: 4, bottom: 4, left: 4 } },
    };

    chartType = new Chart(ctx1, {
      type: 'pie',
      data: {
        labels: typeLabelsArr.map((k) => typeLabels[k] || k),
        datasets: [
          {
            data: typeData,
            backgroundColor: [C.logic, C.math, C.word],
            borderWidth: 0,
          },
        ],
      },
      options: {
        ...commonOpts,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              boxWidth: 12,
              padding: 10,
              font: { size: window.matchMedia('(max-width: 480px)').matches ? 10 : 12 },
            },
          },
        },
      },
    });

    chartDifficulty = new Chart(ctx2, {
      type: 'bar',
      data: {
        labels: diffLabelsArr.map((k) => diffLabels[k] || k),
        datasets: [
          {
            label: 'Solves',
            data: diffData,
            backgroundColor: [C.easy, C.medium, C.hard],
            borderRadius: 6,
          },
        ],
      },
      options: {
        ...commonOpts,
        scales: {
          x: { ticks: { maxRotation: 45, minRotation: 0, font: { size: 11 } } },
          y: { beginAtZero: true, ticks: { stepSize: 1 } },
        },
        plugins: { legend: { display: false } },
      },
    });

    const cw = stats.correctVsWrong || { correct: 0, wrong: 0 };
    chartGuess = new Chart(ctx3, {
      type: 'bar',
      data: {
        labels: ['Correct solves', 'Wrong guesses'],
        datasets: [
          {
            data: [cw.correct || 0, cw.wrong || 0],
            backgroundColor: [C.correct, C.wrong],
            borderRadius: 6,
          },
        ],
      },
      options: {
        ...commonOpts,
        scales: {
          x: { ticks: { maxRotation: 30, font: { size: 10 } } },
          y: { beginAtZero: true, ticks: { stepSize: 1 } },
        },
        plugins: { legend: { display: false } },
      },
    });
  }

  function updateCharts(stats) {
    if (!chartType || !stats) return;
    const typeLabelsArr = ['logic', 'math', 'word'];
    const diffLabelsArr = ['easy', 'medium', 'hard'];
    chartType.data.datasets[0].data = typeLabelsArr.map((k) => stats.completionsByType[k] || 0);
    chartType.update();
    chartDifficulty.data.datasets[0].data = diffLabelsArr.map((k) => stats.completionsByDifficulty[k] || 0);
    chartDifficulty.update();
    const cw = stats.correctVsWrong || { correct: 0, wrong: 0 };
    chartGuess.data.datasets[0].data = [cw.correct || 0, cw.wrong || 0];
    chartGuess.update();
  }

  function setFeedback(text, kind) {
    feedback.textContent = text;
    feedback.classList.remove('feedback-success', 'feedback-error', 'feedback-neutral');
    if (kind === 'ok') feedback.classList.add('feedback-success');
    else if (kind === 'bad') feedback.classList.add('feedback-error');
    else feedback.classList.add('feedback-neutral');
  }

  function clearFeedback() {
    feedback.textContent = '';
    feedback.classList.remove('feedback-success', 'feedback-error', 'feedback-neutral');
  }

  function renderLeaderboard(entries) {
    if (!entries || !entries.length) {
      leaderboardBody.innerHTML = '<tr><td colspan="3">No scores yet — be first!</td></tr>';
      return;
    }
    leaderboardBody.innerHTML = entries
      .map(
        (row, i) =>
          `<tr class="${i === 0 ? 'top-rank' : ''}"><td>${i + 1}</td><td>${escapeHtml(row.username)}</td><td>${row.totalScore}</td></tr>`
      )
      .join('');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function applyPuzzleCardState(kind) {
    const card = el('puzzle-card');
    card.classList.remove('state-correct', 'state-wrong');
    if (kind === 'correct') card.classList.add('state-correct');
    if (kind === 'wrong') card.classList.add('state-wrong');
  }

  function revealPuzzle(puzzle, token) {
    currentPuzzle = puzzle;
    attemptToken = token;
    if (puzzle && puzzle.id && !seenIds.includes(puzzle.id)) seenIds.push(puzzle.id);

    badgeType.textContent = typeLabels[puzzle.type] || puzzle.type;
    badgeDifficulty.textContent = diffLabels[puzzle.difficulty] || puzzle.difficulty;
    badgePoints.textContent = (puzzle.basePoints || 0) + ' pts';
    puzzleQuestion.textContent = puzzle.question;

    if (puzzle.hasHints) {
      btnHint.classList.remove('hidden');
      btnHint.classList.add('hint-pulse');
    } else {
      btnHint.classList.add('hidden');
      btnHint.classList.remove('hint-pulse');
    }

    puzzleLoading.classList.add('hidden');
    puzzleBody.classList.remove('hidden');
    btnShareChallenge.classList.remove('hidden');
    shareFeedback.classList.add('hidden');
    shareFeedback.textContent = '';
    answerInput.focus();
  }

  function beginPuzzleLoad() {
    clearFeedback();
    applyPuzzleCardState(null);
    puzzleLoading.textContent = 'Loading a puzzle…';
    puzzleLoading.classList.remove('hidden');
    puzzleBody.classList.add('hidden');
    btnShareChallenge.classList.add('hidden');
    shareFeedback.classList.add('hidden');
    shareFeedback.textContent = '';
    hintStack.innerHTML = '';
    answerInput.value = '';
  }

  async function loadPuzzle() {
    beginPuzzleLoad();

    const params = new URLSearchParams();
    const t = filterType.value;
    const d = filterDifficulty.value;
    if (t) params.set('type', t);
    if (d) params.set('difficulty', d);
    if (seenIds.length) params.set('exclude', seenIds.join(','));

    try {
      const { data } = await axios.get('/api/puzzles/random?' + params.toString());
      if (!data.ok) throw new Error(data.error || 'Failed');
      revealPuzzle(data.data.puzzle, data.data.attemptToken);
    } catch (err) {
      puzzleLoading.textContent = err.response?.data?.error || err.message || 'Could not load puzzle.';
      const hint = 'Try “Reset seen”, change filters, or add puzzles in Admin.';
      puzzleLoading.textContent += ' ' + hint;
    }
  }

  async function loadPuzzleById(id) {
    beginPuzzleLoad();
    puzzleLoading.textContent = 'Loading challenge…';
    try {
      const { data } = await axios.get('/api/puzzles/' + encodeURIComponent(id));
      if (!data.ok) throw new Error(data.error || 'Failed');
      revealPuzzle(data.data.puzzle, data.data.attemptToken);
    } catch (err) {
      puzzleLoading.textContent = err.response?.data?.error || err.message || 'Could not load this puzzle.';
      puzzleLoading.textContent += ' Try another link or go back to the home page.';
    }
  }

  async function copyChallengeLink() {
    if (!currentPuzzle || !currentPuzzle.id) return;
    const url = new URL('/challenge/' + encodeURIComponent(currentPuzzle.id), window.location.origin).href;
    try {
      await navigator.clipboard.writeText(url);
      shareFeedback.textContent = 'Challenge link copied — send it to a friend.';
      shareFeedback.classList.remove('hidden');
    } catch {
      shareFeedback.textContent = url;
      shareFeedback.classList.remove('hidden');
    }
  }

  async function submitAnswer() {
    if (!currentPuzzle || !attemptToken) {
      setFeedback('Load a puzzle first.', 'bad');
      return;
    }
    const answer = answerInput.value;
    const username = usernameInput.value.trim() || 'Anonymous';
    applyPuzzleCardState(null);
    try {
      const { data } = await axios.post('/api/submit', {
        puzzleId: currentPuzzle.id,
        answer,
        username,
        attemptToken,
      });
      if (!data.ok) throw new Error(data.error || 'Submit failed');

      const r = data.data;
      if (r.correct) {
        applyPuzzleCardState('correct');
        setFeedback(r.message || 'Correct!', 'ok');
        if (r.leaderboard) renderLeaderboard(r.leaderboard);
        if (r.stats) updateCharts(r.stats);
        else {
          const s = await axios.get('/api/stats');
          if (s.data.ok) updateCharts(s.data.data);
        }
      } else {
        applyPuzzleCardState('wrong');
        setFeedback(r.message || 'Incorrect', 'bad');
      }
    } catch (err) {
      setFeedback(err.response?.data?.error || err.message, 'bad');
    }
  }

  async function takeHint() {
    if (!currentPuzzle || !attemptToken || !currentPuzzle.hasHints) return;
    try {
      const { data } = await axios.get(
        '/api/puzzles/' + encodeURIComponent(currentPuzzle.id) + '/hint?attemptToken=' + encodeURIComponent(attemptToken)
      );
      if (!data.ok) throw new Error(data.error || 'No hint');
      const row = document.createElement('div');
      row.className = 'hint-line hint-reveal';
      row.textContent = data.data.hint;
      hintStack.appendChild(row);
      requestAnimationFrame(() => row.classList.add('hint-visible'));
    } catch (err) {
      setFeedback(err.response?.data?.error || err.message, 'bad');
    }
  }

  btnSubmit.addEventListener('click', submitAnswer);
  answerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAnswer();
  });
  btnHint.addEventListener('click', takeHint);
  btnShareChallenge.addEventListener('click', copyChallengeLink);
  btnNew.addEventListener('click', () => {
    if (isChallengeRoute) {
      window.location.href = '/';
      return;
    }
    loadPuzzle();
  });
  btnResetSeen.addEventListener('click', () => {
    seenIds.length = 0;
    loadPuzzle();
  });

  const initial = readInitialStats();
  if (typeof Chart !== 'undefined' && initial) initCharts(initial);

  if (pageConfig.challengePuzzleId) {
    loadPuzzleById(pageConfig.challengePuzzleId);
  } else {
    loadPuzzle();
  }

  axios.get('/api/leaderboard?limit=10').then((res) => {
    if (res.data.ok) renderLeaderboard(res.data.data.entries);
  });
})();
