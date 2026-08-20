'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { buildTestApp, makePuzzle } = require('../helpers/testApp');
const { openPage, waitFor } = require('./helpers/browser');

/**
 * public/js/admin.js, driven through the real studio page.
 *
 * 369 lines with no coverage until now, and the surface an operator uses most. A broken
 * selector here means the studio silently stops saving - which no API test would catch,
 * because the API itself would still be fine.
 */

const SCRIPTS = ['ui.js', 'admin.js'];

const openStudio = async (app) => openPage({ app, url: '/admin', scripts: SCRIPTS });

/** Fill the editor the way an operator would, firing the events the code listens for. */
function fillForm(page, { question, answers, type, difficulty, hints, matchMode }) {
  const set = (id, value) => {
    const el = page.$id(id);
    el.value = value;
    el.dispatchEvent(new page.window.Event('input', { bubbles: true }));
    el.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  };
  if (question !== undefined) set('f-question', question);
  if (answers !== undefined) set('f-answers', answers);
  if (type !== undefined) set('f-type', type);
  if (difficulty !== undefined) set('f-difficulty', difficulty);
  if (hints !== undefined) set('f-hints', hints);
  if (matchMode !== undefined) {
    const radio = page.$(`input[name="matchMode"][value="${matchMode}"]`);
    radio.checked = true;
    radio.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  }
}

const save = async (page) => {
  page.$id('puzzle-form').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await page.settle(120);
};

test.describe('the catalogue list', () => {
  test('renders every puzzle from the bootstrapped data', async (t) => {
    const { app } = buildTestApp({
      puzzles: [
        makePuzzle({ id: 'alpha', question: 'The first studio question here.' }),
        makePuzzle({ id: 'beta', question: 'The second studio question here.' }),
      ],
    });
    const page = await openStudio(app);
    t.after(() => page.close());

    await waitFor(() => page.document.querySelectorAll('.puzzle-row').length === 2, { label: 'both rows' });
    assert.equal(page.text('#list-count'), '2');
    assert.match(page.$id('puzzle-list').textContent, /The first studio question here/);
  });

  test('search filters the list live', async (t) => {
    const { app } = buildTestApp({
      puzzles: [
        makePuzzle({ id: 'alpha', question: 'Something about pianos here.' }),
        makePuzzle({ id: 'beta', question: 'Something about guitars here.' }),
      ],
    });
    const page = await openStudio(app);
    t.after(() => page.close());

    const search = page.$id('list-search');
    search.value = 'guitars';
    search.dispatchEvent(new page.window.Event('input', { bubbles: true }));
    await page.settle(30);

    assert.equal(page.document.querySelectorAll('.puzzle-row').length, 1);
    assert.match(page.$id('puzzle-list').textContent, /guitars/);
  });

  test('type and level filters narrow the list', async (t) => {
    const { app } = buildTestApp({
      puzzles: [
        makePuzzle({ id: 'a', type: 'logic', difficulty: 'easy' }),
        makePuzzle({ id: 'b', type: 'math', difficulty: 'hard' }),
        makePuzzle({ id: 'c', type: 'math', difficulty: 'easy' }),
      ],
    });
    const page = await openStudio(app);
    t.after(() => page.close());

    const type = page.$id('list-type');
    type.value = 'math';
    type.dispatchEvent(new page.window.Event('change', { bubbles: true }));
    await page.settle(30);
    assert.equal(page.document.querySelectorAll('.puzzle-row').length, 2);

    const level = page.$id('list-difficulty');
    level.value = 'easy';
    level.dispatchEvent(new page.window.Event('change', { bubbles: true }));
    await page.settle(30);
    assert.equal(page.document.querySelectorAll('.puzzle-row').length, 1, 'filters combine');
  });

  test('tells the operator when nothing matches', async (t) => {
    const { app } = buildTestApp();
    const page = await openStudio(app);
    t.after(() => page.close());

    const search = page.$id('list-search');
    search.value = 'zzzz-no-such-puzzle';
    search.dispatchEvent(new page.window.Event('input', { bubbles: true }));
    await page.settle(30);

    assert.equal(page.$id('list-empty').hidden, false);
    assert.equal(page.document.querySelectorAll('.puzzle-row').length, 0);
  });
});

test.describe('creating a puzzle', () => {
  test('saves it and adds it to the list without a page reload', async (t) => {
    const { app } = buildTestApp({ puzzles: [] });
    const page = await openStudio(app);
    t.after(() => page.close());

    fillForm(page, {
      question: 'Which planet rotates almost entirely on its side?',
      answers: 'uranus',
      type: 'trivia',
      difficulty: 'medium',
    });
    await save(page);

    await waitFor(() => page.document.querySelectorAll('.puzzle-row').length === 1, {
      label: 'the new row to appear',
    });
    assert.match(page.$id('puzzle-list').textContent, /Which planet rotates/);

    // And it really reached the server, not just the DOM.
    const listed = await request(app).get('/api/admin/puzzles');
    assert.equal(listed.body.data.total, 1);
  });

  test('the form resets to create mode after a successful save', async (t) => {
    const { app } = buildTestApp({ puzzles: [] });
    const page = await openStudio(app);
    t.after(() => page.close());

    fillForm(page, { question: 'A perfectly valid question goes here.', answers: 'yes' });
    await save(page);

    await waitFor(() => page.$id('f-question').value === '', { label: 'the form to clear' });
    assert.equal(page.text('#editor-mode'), 'Creating');
    assert.equal(page.$id('f-original-id').value, '');
  });

  test('client-side validation blocks an empty answer list before any request', async (t) => {
    const { app } = buildTestApp({ puzzles: [] });
    const page = await openStudio(app);
    t.after(() => page.close());

    fillForm(page, { question: 'A question with no answers at all.', answers: '' });
    await save(page);

    const error = page.$('[data-error-for="answers"]');
    assert.equal(error.hidden, false);
    assert.match(error.textContent, /at least one accepted answer/i);

    const listed = await request(app).get('/api/admin/puzzles');
    assert.equal(listed.body.data.total, 0, 'nothing was sent');
  });

  test('server validation errors are painted onto the offending field', async (t) => {
    const { app } = buildTestApp({ puzzles: [] });
    const page = await openStudio(app);
    t.after(() => page.close());

    // Passes the client check (>= 8 chars) but fails the server's regex safety check.
    fillForm(page, {
      question: 'A question using an unsafe pattern.',
      answers: '(a+)+b',
      matchMode: 'regex',
    });
    await save(page);

    await waitFor(() => !page.$('[data-error-for="answers"]').hidden, {
      label: 'the server error to be shown inline',
    });
    assert.match(page.text('#form-message'), /server rejected/i);
  });
});

test.describe('the live editor helpers', () => {
  test('the character count and slug preview track the question', async (t) => {
    const { app } = buildTestApp({ puzzles: [] });
    const page = await openStudio(app);
    t.after(() => page.close());

    const question = 'What has keys but cannot open a lock?';
    fillForm(page, { question });
    await page.settle(30);

    // Derived, not hardcoded - a literal here just tests my ability to count.
    assert.equal(page.text('#question-count'), String(question.length));
    assert.equal(page.text('#id-preview'), 'what-has-keys-but-cannot-open', 'six words, slugified');
  });

  test('changing the level re-suggests base points when creating', async (t) => {
    const { app } = buildTestApp({ puzzles: [] });
    const page = await openStudio(app);
    t.after(() => page.close());

    fillForm(page, { difficulty: 'hard' });
    await page.settle(30);

    assert.equal(page.$id('f-basePoints').value, '180');
    assert.equal(page.text('#suggested-points'), '180');
  });

  test('the match-mode help changes with the selection', async (t) => {
    const { app } = buildTestApp({ puzzles: [] });
    const page = await openStudio(app);
    t.after(() => page.close());

    fillForm(page, { matchMode: 'regex' });
    await page.settle(30);
    assert.match(page.text('#matchmode-help'), /case-insensitive pattern/i);

    fillForm(page, { matchMode: 'partial' });
    await page.settle(30);
    assert.match(page.text('#matchmode-help'), /appears anywhere/i);
  });
});

test.describe('the answer tester', () => {
  test('grades a sample answer against the unsaved draft', async (t) => {
    const { app } = buildTestApp({ puzzles: [] });
    const page = await openStudio(app);
    t.after(() => page.close());

    fillForm(page, { question: 'What has keys but cannot open a lock?', answers: 'piano' });

    page.$id('tester-input').value = 'A Piano!';
    page.$id('btn-test').click();

    await waitFor(() => page.document.querySelectorAll('.tester__result').length === 1, {
      label: 'a verdict',
    });
    const row = page.$('.tester__result');
    assert.ok(row.classList.contains('is-pass'), 'a forgiving variant is accepted');
    assert.match(row.textContent, /accepted/);
  });

  test('shows a rejection for an answer that does not match', async (t) => {
    const { app } = buildTestApp({ puzzles: [] });
    const page = await openStudio(app);
    t.after(() => page.close());

    fillForm(page, { question: 'What has keys but cannot open a lock?', answers: 'piano' });

    page.$id('tester-input').value = 'guitar';
    page.$id('btn-test').click();

    await waitFor(() => page.document.querySelectorAll('.tester__result').length === 1, {
      label: 'a verdict',
    });
    assert.ok(page.$('.tester__result').classList.contains('is-fail'));
  });

  test('testing does not save the draft', async (t) => {
    const { app } = buildTestApp({ puzzles: [] });
    const page = await openStudio(app);
    t.after(() => page.close());

    fillForm(page, { question: 'A draft that must not be persisted.', answers: 'x' });
    page.$id('tester-input').value = 'x';
    page.$id('btn-test').click();
    await page.settle(120);

    const listed = await request(app).get('/api/admin/puzzles');
    assert.equal(listed.body.data.total, 0, 'the tester is a dry run');
  });
});

test.describe('editing and deleting', () => {
  test('Edit loads the puzzle into the form and switches mode', async (t) => {
    const { app } = buildTestApp({
      puzzles: [makePuzzle({ id: 'editable', question: 'A puzzle that will be edited.', difficulty: 'hard' })],
    });
    const page = await openStudio(app);
    t.after(() => page.close());

    await waitFor(() => page.$('[data-action="edit"]'), { label: 'the edit button' });
    page.$('[data-action="edit"]').click();
    await page.settle(40);

    assert.equal(page.$id('f-question').value, 'A puzzle that will be edited.');
    assert.equal(page.$id('f-difficulty').value, 'hard');
    assert.equal(page.$id('f-original-id').value, 'editable');
    assert.match(page.text('#editor-mode'), /editing editable/i);
    assert.equal(page.$id('btn-cancel-edit').hidden, false);
    assert.match(page.text('#btn-save'), /save changes/i);
  });

  test('saving an edit updates the row in place', async (t) => {
    const { app } = buildTestApp({
      puzzles: [makePuzzle({ id: 'editable', question: 'The original question text.' })],
    });
    const page = await openStudio(app);
    t.after(() => page.close());

    await waitFor(() => page.$('[data-action="edit"]'), { label: 'the edit button' });
    page.$('[data-action="edit"]').click();
    await page.settle(40);

    fillForm(page, { question: 'The rewritten question text here.' });
    await save(page);

    await waitFor(() => page.$id('puzzle-list').textContent.includes('The rewritten question text here.'), {
      label: 'the updated row',
    });
    assert.equal(page.document.querySelectorAll('.puzzle-row').length, 1, 'updated, not duplicated');
  });

  test('Cancel returns the form to create mode', async (t) => {
    const { app } = buildTestApp();
    const page = await openStudio(app);
    t.after(() => page.close());

    await waitFor(() => page.$('[data-action="edit"]'), { label: 'the edit button' });
    page.$('[data-action="edit"]').click();
    await page.settle(40);
    assert.equal(page.$id('f-original-id').value, 'test-puzzle');

    page.$id('btn-cancel-edit').click();
    await page.settle(40);

    assert.equal(page.$id('f-original-id').value, '');
    assert.equal(page.text('#editor-mode'), 'Creating');
  });

  test('Delete asks for confirmation and removes the row when granted', async (t) => {
    const { app } = buildTestApp();
    const page = await openStudio(app);
    t.after(() => page.close());

    page.window.confirm = () => true;

    await waitFor(() => page.$('[data-action="delete"]'), { label: 'the delete button' });
    page.$('[data-action="delete"]').click();

    await waitFor(() => page.document.querySelectorAll('.puzzle-row').length === 0, {
      label: 'the row to disappear',
    });

    const listed = await request(app).get('/api/admin/puzzles');
    assert.equal(listed.body.data.total, 0, 'and it really went');
  });

  test('declining the confirmation deletes nothing', async (t) => {
    const { app } = buildTestApp();
    const page = await openStudio(app);
    t.after(() => page.close());

    page.window.confirm = () => false;

    await waitFor(() => page.$('[data-action="delete"]'), { label: 'the delete button' });
    page.$('[data-action="delete"]').click();
    await page.settle(120);

    assert.equal(page.document.querySelectorAll('.puzzle-row').length, 1);
    const listed = await request(app).get('/api/admin/puzzles');
    assert.equal(listed.body.data.total, 1, 'nothing was removed');
  });
});
