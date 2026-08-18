/**
 * Puzzle studio: create, edit, delete and dry-run puzzles.
 *
 * The catalogue list is rendered client-side from a bootstrapped snapshot and kept in sync after
 * each write, so saving never costs a full page reload.
 */
(function () {
  'use strict';

  const { api, toast, el, escapeHtml, readBootstrap } = window.BTH;
  const boot = readBootstrap();

  /** @type {Map<string, object>} the catalogue, keyed by id */
  const catalogue = new Map((boot.puzzles || []).map((p) => [p.id, p]));

  const form = el('puzzle-form');
  const fields = {
    originalId: el('f-original-id'),
    id: el('f-id'),
    question: el('f-question'),
    type: el('f-type'),
    difficulty: el('f-difficulty'),
    basePoints: el('f-basePoints'),
    answers: el('f-answers'),
    hints: el('f-hints'),
    explanation: el('f-explanation'),
    tags: el('f-tags'),
    isPublished: el('f-isPublished'),
  };
  const ui = {
    mode: el('editor-mode'),
    heading: el('editor-heading'),
    save: el('btn-save'),
    reset: el('btn-reset'),
    cancel: el('btn-cancel-edit'),
    message: el('form-message'),
    questionCount: el('question-count'),
    suggestedPoints: el('suggested-points'),
    idPreview: el('id-preview'),
    matchModeHelp: el('matchmode-help'),
    list: el('puzzle-list'),
    listCount: el('list-count'),
    listEmpty: el('list-empty'),
    search: el('list-search'),
    filterType: el('list-type'),
    filterDifficulty: el('list-difficulty'),
    testerInput: el('tester-input'),
    testerButton: el('btn-test'),
    testerResults: el('tester-results'),
  };

  const MATCH_MODE_HELP = {
    exact: '<strong>Exact:</strong> the whole answer must match one of the lines. Best for one-word answers.',
    partial:
      '<strong>Contains:</strong> correct if an accepted answer appears anywhere in what the player typed. Best for "explain why" puzzles.',
    regex:
      '<strong>Regex:</strong> each line is a case-insensitive pattern, e.g. <code>^(5|five)( cents)?$</code>. Powerful, and easy to get wrong — use the tester.',
  };

  // ---------------------------------------------------------------- utilities

  const linesOf = (value) =>
    String(value || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);

  const commasOf = (value) =>
    String(value || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  function slugify(input) {
    return String(input || '')
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .split('-')
      .filter(Boolean)
      .slice(0, 6)
      .join('-');
  }

  const selectedMatchMode = () => form.querySelector('input[name="matchMode"]:checked')?.value || 'exact';

  function readForm() {
    return {
      id: fields.id.value.trim() || slugify(fields.question.value),
      question: fields.question.value.trim(),
      type: fields.type.value,
      difficulty: fields.difficulty.value,
      basePoints: Number(fields.basePoints.value),
      answers: linesOf(fields.answers.value),
      hints: linesOf(fields.hints.value),
      explanation: fields.explanation.value.trim() || null,
      tags: commasOf(fields.tags.value),
      matchMode: selectedMatchMode(),
      isPublished: fields.isPublished.checked,
    };
  }

  function setMessage(text, kind) {
    if (!text) {
      ui.message.hidden = true;
      ui.message.textContent = '';
      return;
    }
    ui.message.hidden = false;
    ui.message.textContent = text;
    ui.message.className = `form__message is-${kind}`;
  }

  function clearFieldErrors() {
    form.querySelectorAll('[data-error-for]').forEach((node) => {
      node.hidden = true;
      node.textContent = '';
    });
    form.querySelectorAll('.is-invalid').forEach((node) => node.classList.remove('is-invalid'));
  }

  /** Paint server-side validation issues next to the field that caused them. */
  function showFieldErrors(issues) {
    clearFieldErrors();
    let firstField = null;
    for (const issue of issues || []) {
      const key = String(issue.path).split('.')[0];
      const target = form.querySelector(`[data-error-for="${key}"]`);
      if (target) {
        target.textContent = issue.message;
        target.hidden = false;
        const input = form.querySelector(`#f-${key}`);
        input?.classList.add('is-invalid');
        if (!firstField) firstField = input;
      }
    }
    firstField?.focus();
  }

  // ------------------------------------------------------------------ editing

  function setCreateMode() {
    form.reset();
    fields.originalId.value = '';
    fields.isPublished.checked = true;
    fields.basePoints.value = boot.defaultBasePoints?.[fields.difficulty.value] ?? 100;
    ui.mode.textContent = 'Creating';
    ui.mode.classList.remove('is-editing');
    ui.heading.textContent = 'New puzzle';
    ui.save.textContent = 'Publish puzzle';
    ui.cancel.hidden = true;
    clearFieldErrors();
    setMessage('');
    ui.testerResults.innerHTML = '';
    syncDerived();
  }

  function setEditMode(puzzle) {
    fields.originalId.value = puzzle.id;
    fields.id.value = puzzle.id;
    fields.question.value = puzzle.question || '';
    fields.type.value = puzzle.type;
    fields.difficulty.value = puzzle.difficulty;
    fields.basePoints.value = puzzle.basePoints ?? 100;
    fields.answers.value = (puzzle.answers || []).join('\n');
    fields.hints.value = (puzzle.hints || []).join('\n');
    fields.explanation.value = puzzle.explanation || '';
    fields.tags.value = (puzzle.tags || []).join(', ');
    fields.isPublished.checked = puzzle.isPublished !== false;
    form.querySelector(`input[name="matchMode"][value="${puzzle.matchMode || 'exact'}"]`).checked = true;

    ui.mode.textContent = `Editing ${puzzle.id}`;
    ui.mode.classList.add('is-editing');
    ui.heading.textContent = 'Edit puzzle';
    ui.save.textContent = 'Save changes';
    ui.cancel.hidden = false;
    clearFieldErrors();
    setMessage('');
    ui.testerResults.innerHTML = '';
    syncDerived();
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    fields.question.focus();
  }

  /** Keep the live counters, ID preview and match-mode help in step with the inputs. */
  function syncDerived() {
    ui.questionCount.textContent = String(fields.question.value.length);
    const suggested = boot.defaultBasePoints?.[fields.difficulty.value];
    if (suggested !== undefined) ui.suggestedPoints.textContent = String(suggested);
    ui.idPreview.textContent = fields.id.value.trim() || slugify(fields.question.value) || '…';
    ui.matchModeHelp.innerHTML = MATCH_MODE_HELP[selectedMatchMode()];
  }

  // ------------------------------------------------------------------- listing

  function matchesFilters(puzzle) {
    const needle = ui.search.value.trim().toLowerCase();
    if (ui.filterType.value && puzzle.type !== ui.filterType.value) return false;
    if (ui.filterDifficulty.value && puzzle.difficulty !== ui.filterDifficulty.value) return false;
    if (!needle) return true;
    return `${puzzle.id} ${puzzle.question} ${(puzzle.tags || []).join(' ')}`.toLowerCase().includes(needle);
  }

  function renderList() {
    const rows = [...catalogue.values()].filter(matchesFilters).sort((a, b) => a.id.localeCompare(b.id));

    ui.listCount.textContent = String(rows.length);
    ui.listEmpty.hidden = rows.length > 0;
    ui.list.innerHTML = rows
      .map(
        (p) => `
      <li class="puzzle-row${p.isPublished === false ? ' is-draft' : ''}" data-id="${escapeHtml(p.id)}">
        <div class="puzzle-row__main">
          <p class="puzzle-row__question">${escapeHtml(p.question)}</p>
          <p class="puzzle-row__meta">
            <span class="badge badge--${escapeHtml(p.type)}">${escapeHtml(boot.typeLabels[p.type] || p.type)}</span>
            <span class="badge badge--${escapeHtml(p.difficulty)}">${escapeHtml(boot.difficultyLabels[p.difficulty] || p.difficulty)}</span>
            <span class="puzzle-row__points">${p.basePoints} pts</span>
            ${(p.hints || []).length ? `<span class="puzzle-row__hints">${p.hints.length} hint${p.hints.length > 1 ? 's' : ''}</span>` : ''}
            ${p.isPublished === false ? '<span class="chip chip--draft">Draft</span>' : ''}
          </p>
          <p class="puzzle-row__id"><code>${escapeHtml(p.id)}</code></p>
        </div>
        <div class="puzzle-row__actions">
          <button type="button" class="btn btn--ghost btn--sm" data-action="edit">Edit</button>
          <a class="btn btn--ghost btn--sm" href="/challenge/${encodeURIComponent(p.id)}" target="_blank" rel="noopener">Preview</a>
          <button type="button" class="btn btn--danger btn--sm" data-action="delete">Delete</button>
        </div>
      </li>`
      )
      .join('');
  }

  // ------------------------------------------------------------------- actions

  async function save(event) {
    event.preventDefault();
    const payload = readForm();

    // Cheap client-side checks first, so the obvious mistakes never cost a round trip.
    const problems = [];
    if (payload.question.length < 8) problems.push({ path: 'question', message: 'Write at least 8 characters.' });
    if (!payload.answers.length) problems.push({ path: 'answers', message: 'Add at least one accepted answer.' });
    if (payload.hints.length > 5) problems.push({ path: 'hints', message: 'At most 5 hints.' });
    if (problems.length) {
      showFieldErrors(problems);
      setMessage('Fix the highlighted fields.', 'error');
      return;
    }

    const editingId = fields.originalId.value;
    ui.save.disabled = true;
    setMessage(editingId ? 'Saving…' : 'Publishing…', 'info');

    try {
      const result = editingId
        ? await api(`/api/admin/puzzles/${encodeURIComponent(editingId)}`, { method: 'PUT', body: payload })
        : await api('/api/admin/puzzles', { method: 'POST', body: payload });

      if (editingId && editingId !== result.puzzle.id) catalogue.delete(editingId);
      catalogue.set(result.puzzle.id, result.puzzle);
      renderList();
      toast(editingId ? `Updated "${result.puzzle.id}"` : `Published "${result.puzzle.id}"`, 'success');
      setCreateMode();
    } catch (error) {
      if (error.details?.issues) {
        showFieldErrors(error.details.issues);
        setMessage('The server rejected this puzzle — see the highlighted fields.', 'error');
      } else {
        setMessage(error.message, 'error');
      }
    } finally {
      ui.save.disabled = false;
    }
  }

  async function remove(id) {
    const puzzle = catalogue.get(id);
    if (!puzzle) return;
    if (!window.confirm(`Delete "${puzzle.question.slice(0, 60)}…"?\n\nThis cannot be undone.`)) return;
    try {
      await api(`/api/admin/puzzles/${encodeURIComponent(id)}`, { method: 'DELETE' });
      catalogue.delete(id);
      renderList();
      if (fields.originalId.value === id) setCreateMode();
      toast(`Deleted "${id}"`, 'info');
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function runTester() {
    const sample = ui.testerInput.value;
    if (!sample.trim()) return;
    try {
      const result = await api('/api/admin/puzzles/validate', {
        method: 'POST',
        body: { ...readForm(), sampleAnswers: [sample] },
      });

      if (!result.valid) {
        showFieldErrors(result.issues);
        setMessage('The draft is not valid yet, so it cannot be tested.', 'error');
        return;
      }
      clearFieldErrors();
      setMessage('');
      for (const check of result.samples) {
        const row = document.createElement('li');
        row.className = `tester__result is-${check.correct ? 'pass' : 'fail'}`;
        row.innerHTML = `<span class="tester__verdict">${check.correct ? 'accepted' : 'rejected'}</span> <code>${escapeHtml(check.input)}</code>`;
        ui.testerResults.prepend(row);
      }
      ui.testerInput.value = '';
      ui.testerInput.focus();
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  // -------------------------------------------------------------------- wiring

  form.addEventListener('submit', save);
  ui.reset.addEventListener('click', setCreateMode);
  ui.cancel.addEventListener('click', setCreateMode);

  fields.question.addEventListener('input', syncDerived);
  fields.id.addEventListener('input', syncDerived);
  fields.difficulty.addEventListener('change', () => {
    // Only re-suggest points while creating — never silently overwrite an author's chosen value.
    if (!fields.originalId.value) {
      fields.basePoints.value = boot.defaultBasePoints?.[fields.difficulty.value] ?? 100;
    }
    syncDerived();
  });
  form.querySelectorAll('input[name="matchMode"]').forEach((radio) => radio.addEventListener('change', syncDerived));

  ui.list.addEventListener('click', (event) => {
    const row = event.target.closest('.puzzle-row');
    if (!row) return;
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'edit') setEditMode(catalogue.get(row.dataset.id));
    if (action === 'delete') remove(row.dataset.id);
  });

  [ui.search, ui.filterType, ui.filterDifficulty].forEach((control) => {
    control.addEventListener('input', renderList);
    control.addEventListener('change', renderList);
  });

  ui.testerButton.addEventListener('click', runTester);
  ui.testerInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      runTester();
    }
  });

  // Deep link support: /admin#edit-<id> opens that puzzle in the editor.
  if (window.location.hash.startsWith('#edit-')) {
    const puzzle = catalogue.get(window.location.hash.slice(6));
    if (puzzle) setEditMode(puzzle);
  }

  renderList();
  syncDerived();
})();
