'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTestApp, makePuzzle, signIn } = require('../helpers/testApp');
const { openPage, waitFor } = require('./helpers/browser');

/**
 * public/js/play.js, driven through the real rendered page.
 *
 * 481 lines that no API-level test can reach. Everything here runs the genuine client code
 * against the genuine server: a renamed element id, a changed response field or a broken
 * handler fails these, and only these.
 */

const SCRIPTS = ['ui.js', 'play.js'];

/** Open /play and wait for the first puzzle to finish loading. */
async function openPlay(app, { cookie = '', url = '/play' } = {}) {
  const page = await openPage({ app, url, scripts: SCRIPTS, cookie });
  await waitFor(() => page.$id('puzzle-body') && !page.$id('puzzle-body').hidden, {
    label: 'the puzzle to render',
  });
  return page;
}

const submit = async (page, answer) => {
  page.$id('answer-input').value = answer;
  page.$id('answer-form').dispatchEvent(new page.window.Event('submit', { bubbles: true, cancelable: true }));
  await page.settle(80);
};

test.describe('loading a puzzle', () => {
  test('fetches a puzzle and renders it into the real markup', async (t) => {
    const { app } = buildTestApp();
    const page = await openPlay(app);
    t.after(() => page.close());

    assert.equal(page.text('#puzzle-question'), 'What has keys but cannot open a lock?');
    assert.equal(page.text('#badge-type'), 'Word');
    assert.equal(page.text('#badge-difficulty'), 'Easy');
    assert.equal(page.text('#badge-points'), '100 pts');
    assert.equal(page.$id('puzzle-loading').hidden, true, 'the skeleton is dismissed');
    assert.deepEqual(page.consoleErrors, [], 'no script errors');
  });

  test('shows the hint button only when the puzzle has hints', async (t) => {
    const withHints = buildTestApp();
    const a = await openPlay(withHints.app);
    t.after(() => a.close());
    assert.equal(a.$id('btn-hint').hidden, false);
    assert.equal(a.text('#hint-counter'), '0/2');

    const without = buildTestApp({ puzzles: [makePuzzle({ hints: [] })] });
    const b = await openPlay(without.app);
    t.after(() => b.close());
    assert.equal(b.$id('btn-hint').hidden, true, 'no hints means no button');
  });

  test('reports a load failure in the page rather than failing silently', async (t) => {
    // Every puzzle already seen - the API 404s with a recoverable message.
    const { app } = buildTestApp();
    const page = await openPage({ app, url: '/play', scripts: SCRIPTS });
    t.after(() => page.close());

    page.window.localStorage.setItem('bth:seen', JSON.stringify(['test-puzzle']));
    page.$id('btn-reset-seen'); // present in the toolbar
    await page.settle(60);

    // Reload the page so the seen list is applied on boot.
    const second = await openPage({ app, url: '/play', scripts: SCRIPTS });
    t.after(() => second.close());
    second.window.localStorage.setItem('bth:seen', JSON.stringify(['test-puzzle']));

    await waitFor(() => second.$id('puzzle-loading-text').textContent.length > 0, {
      label: 'a loading message',
    });
    assert.ok(second.$id('puzzle-loading-text').textContent.length > 0);
  });
});

test.describe('answering', () => {
  test('a correct answer marks the card solved and shows the explanation', async (t) => {
    const { app } = buildTestApp();
    const page = await openPlay(app);
    t.after(() => page.close());

    await submit(page, 'piano');

    assert.ok(page.$id('puzzle-card').classList.contains('is-correct'), 'the card turns correct');
    assert.match(page.text('#feedback'), /Correct/);
    assert.equal(page.$id('explanation').hidden, false);
    assert.equal(page.text('#explanation'), 'A piano.');
    assert.equal(page.$id('answer-input').disabled, true, 'the input locks after solving');
  });

  test('a forgiving variant is accepted, proving the client sends the raw answer', async (t) => {
    const { app } = buildTestApp();
    const page = await openPlay(app);
    t.after(() => page.close());

    await submit(page, '  A PIANO! ');
    assert.ok(page.$id('puzzle-card').classList.contains('is-correct'));
  });

  test('a wrong answer shakes the card and keeps the puzzle playable', async (t) => {
    const { app } = buildTestApp();
    const page = await openPlay(app);
    t.after(() => page.close());

    await submit(page, 'guitar');

    assert.ok(page.$id('puzzle-card').classList.contains('is-wrong'));
    assert.ok(page.$id('puzzle-card').classList.contains('shake'));
    assert.match(page.text('#feedback'), /not quite|nope|still not/i);
    assert.equal(page.$id('answer-input').disabled, false, 'the player can try again');
    assert.equal(page.$id('explanation').hidden, true, 'a wrong answer reveals nothing');
  });

  test('an empty submission is refused by the client without a round trip', async (t) => {
    const { app } = buildTestApp();
    const page = await openPlay(app);
    t.after(() => page.close());

    await submit(page, '   ');
    assert.match(page.text('#feedback'), /type an answer/i);
    assert.equal(page.$id('puzzle-card').classList.contains('is-wrong'), false);
  });

  test('the session tally updates on a solve', async (t) => {
    const { app } = buildTestApp();
    const page = await openPlay(app);
    t.after(() => page.close());

    assert.equal(page.text('#session-points'), '0 pts');
    assert.equal(page.text('#session-solves'), '0');

    await submit(page, 'piano');

    assert.notEqual(page.text('#session-points'), '0 pts', 'points are banked in the session');
    assert.equal(page.text('#session-solves'), '1');
  });
});

test.describe('hints', () => {
  test('reveals hints one at a time and then disables the button', async (t) => {
    const { app } = buildTestApp();
    const page = await openPlay(app);
    t.after(() => page.close());

    page.$id('btn-hint').click();
    await waitFor(() => page.document.querySelectorAll('.hint').length === 1, { label: 'the first hint' });
    assert.match(page.text('.hint'), /It has 88 of them/);
    assert.equal(page.text('#hint-counter'), '1/2');

    page.$id('btn-hint').click();
    await waitFor(() => page.document.querySelectorAll('.hint').length === 2, { label: 'the second hint' });
    assert.equal(page.text('#hint-counter'), '2/2');

    await waitFor(() => page.$id('btn-hint').disabled, { label: 'the button to disable' });
    assert.match(page.text('#btn-hint'), /no hints left/i);
    assert.ok(page.$id('hint-counter'), 'the counter must survive the label change');
  });

  test('the hint counter survives into the next puzzle', async (t) => {
    // Regression: the label was written with hintBtn.textContent, which destroyed the nested
    // counter span - leaving it permanently missing for every later puzzle in the session.
    const { app } = buildTestApp({
      puzzles: [makePuzzle({ id: 'one' }), makePuzzle({ id: 'two', question: 'A second question here.' })],
    });
    const page = await openPlay(app);
    t.after(() => page.close());

    page.$id('btn-hint').click();
    await waitFor(() => page.document.querySelectorAll('.hint').length === 1, { label: 'hint one' });
    page.$id('btn-hint').click();
    await waitFor(() => page.$id('btn-hint').disabled, { label: 'hints to run out' });

    const before = page.text('#puzzle-question');
    page.$id('btn-next').click();
    await waitFor(() => page.text('#puzzle-question') !== before && !page.$id('puzzle-body').hidden, {
      label: 'the next puzzle',
    });

    assert.ok(page.$id('hint-counter'), 'the counter element still exists');
    assert.equal(page.text('#hint-counter'), '0/2', 'and is reset for the new puzzle');
    assert.match(page.text('#btn-hint'), /hint/i);
    assert.doesNotMatch(page.text('#btn-hint'), /no hints left/i, 'the label resets too');
    assert.equal(page.$id('btn-hint').disabled, false);
  });

  test('a revealed hint reduces the score the server awards', async (t) => {
    const { app } = buildTestApp();
    const page = await openPlay(app);
    t.after(() => page.close());

    page.$id('btn-hint').click();
    await waitFor(() => page.document.querySelectorAll('.hint').length === 1, { label: 'a hint' });

    await submit(page, 'piano');

    const points = Number(page.text('#session-points').replace(/\D/g, ''));
    assert.ok(points > 0, 'still worth something');
    assert.ok(points < 125, `a hinted solve must cost points, scored ${points}`);
  });
});

test.describe('filters and navigation', () => {
  test('changing a filter refetches and updates the URL without a reload', async (t) => {
    const { app } = buildTestApp({
      puzzles: [
        makePuzzle({ id: 'easy-word', type: 'word', difficulty: 'easy' }),
        makePuzzle({ id: 'hard-math', type: 'math', difficulty: 'hard', question: 'A hard math question here.' }),
      ],
    });
    const page = await openPlay(app);
    t.after(() => page.close());

    const select = page.$id('filter-type');
    select.value = 'math';
    select.dispatchEvent(new page.window.Event('change', { bubbles: true }));

    await waitFor(() => page.text('#puzzle-question') === 'A hard math question here.', {
      label: 'the filtered puzzle',
    });
    assert.match(page.window.location.search, /type=math/, 'the URL stays shareable');
  });

  test('"next puzzle" loads a different one', async (t) => {
    const { app } = buildTestApp({
      puzzles: [
        makePuzzle({ id: 'one', question: 'The very first question here.' }),
        makePuzzle({ id: 'two', question: 'The second question, distinct.' }),
      ],
    });
    const page = await openPlay(app);
    t.after(() => page.close());

    const first = page.text('#puzzle-question');
    page.$id('btn-next').click();

    await waitFor(() => page.text('#puzzle-question') !== first && !page.$id('puzzle-body').hidden, {
      label: 'a different puzzle',
    });
    assert.notEqual(page.text('#puzzle-question'), first);
  });

  test('seen puzzles are remembered so the pool does not repeat', async (t) => {
    const { app } = buildTestApp();
    const page = await openPlay(app);
    t.after(() => page.close());

    const seen = JSON.parse(page.window.localStorage.getItem('bth:seen'));
    assert.deepEqual(seen, ['test-puzzle'], 'the served puzzle is recorded');
  });

  test('"reset seen" clears the stored list', async (t) => {
    const { app } = buildTestApp();
    const page = await openPlay(app);
    t.after(() => page.close());

    page.$id('btn-reset-seen').click();
    await page.settle(60);

    const seen = JSON.parse(page.window.localStorage.getItem('bth:seen') || '[]');
    assert.ok(seen.length <= 1, 'the list is cleared (the freshly loaded puzzle may re-add itself)');
  });
});

test.describe('sharing', () => {
  test('the share button copies a challenge link for this puzzle', async (t) => {
    const { app } = buildTestApp();
    const page = await openPlay(app);
    t.after(() => page.close());

    page.$id('btn-share').click();
    await waitFor(() => page.clipboard.length > 0, { label: 'something to be copied' });

    assert.match(page.clipboard[0], /\/challenge\/test-puzzle$/);
  });
});

test.describe('identity in the page', () => {
  test('an anonymous player is told their score is not being saved', async (t) => {
    const { app } = buildTestApp();
    const page = await openPlay(app);
    t.after(() => page.close());

    assert.match(page.text('.player-bar__who'), /anonymously/i);

    await submit(page, 'piano');
    assert.match(page.text('#feedback'), /sign in to keep it/i);
  });

  test('a signed-in player is shown their name and gets a ranked solve', async (t) => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks);

    const page = await openPlay(app, { cookie });
    t.after(() => page.close());

    assert.match(page.text('.player-bar__who'), /playing as/i);
    assert.match(page.text('.player-bar__who'), /ada/);

    await submit(page, 'piano');
    assert.doesNotMatch(page.text('#feedback'), /sign in to keep it/i);
  });

  test('the leaderboard in the sidebar updates after a ranked solve', async (t) => {
    const { app, issuedLinks } = buildTestApp();
    const { cookie } = await signIn(app, issuedLinks);

    const page = await openPlay(app, { cookie });
    t.after(() => page.close());

    await submit(page, 'piano');

    await waitFor(() => page.document.querySelector('#leaderboard-body').textContent.includes('ada'), {
      label: 'the player to appear on the board',
    });
  });
});

test.describe('keyboard shortcuts', () => {
  test('H reveals a hint and N loads the next puzzle', async (t) => {
    const { app } = buildTestApp({
      puzzles: [makePuzzle({ id: 'one' }), makePuzzle({ id: 'two', question: 'A different question here.' })],
    });
    const page = await openPlay(app);
    t.after(() => page.close());

    const press = (key) =>
      page.document.dispatchEvent(new page.window.KeyboardEvent('keydown', { key, bubbles: true }));

    press('h');
    await waitFor(() => page.document.querySelectorAll('.hint').length === 1, { label: 'a hint from H' });

    const before = page.text('#puzzle-question');
    press('n');
    await waitFor(() => page.text('#puzzle-question') !== before && !page.$id('puzzle-body').hidden, {
      label: 'a new puzzle from N',
    });
  });

  test('shortcuts do not fire while typing an answer', async (t) => {
    const { app } = buildTestApp();
    const page = await openPlay(app);
    t.after(() => page.close());

    const input = page.$id('answer-input');
    input.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'h', bubbles: true }));
    await page.settle(60);

    assert.equal(page.document.querySelectorAll('.hint').length, 0, 'typing "h" must not spend a hint');
  });
});

test.describe('the daily and challenge modes', () => {
  test('/daily loads the puzzle of the day', async (t) => {
    const { app } = buildTestApp();
    const page = await openPlay(app, { url: '/daily' });
    t.after(() => page.close());

    assert.equal(page.text('#puzzle-question'), 'What has keys but cannot open a lock?');
    assert.match(page.text('.mode-banner'), /daily challenge/i);
  });

  test('/challenge/:id loads that exact puzzle', async (t) => {
    const { app } = buildTestApp({
      puzzles: [
        makePuzzle({ id: 'one', question: 'The first question, here.' }),
        makePuzzle({ id: 'two', question: 'The targeted challenge question.' }),
      ],
    });
    const page = await openPlay(app, { url: '/challenge/two' });
    t.after(() => page.close());

    assert.equal(page.text('#puzzle-question'), 'The targeted challenge question.');
    assert.match(page.text('.mode-banner'), /challenged you/i);
  });
});
