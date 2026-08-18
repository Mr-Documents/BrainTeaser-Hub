'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { matchAnswer, normalize, canonicalize, isSafeRegexSource } = require('../../src/domain/answerMatcher');

const correct = (answer, puzzle) => matchAnswer(answer, puzzle).correct;

test.describe('normalization', () => {
  test('casefolds, strips punctuation and collapses whitespace', () => {
    assert.equal(normalize('  An   ECHO!!  '), 'an echo');
  });

  test('strips accents so "café" and "cafe" are the same answer', () => {
    assert.equal(normalize('CAFÉ'), 'cafe');
  });

  test('canonicalization drops a leading article and maps number words to digits', () => {
    assert.equal(canonicalize('The Echo'), 'echo');
    assert.equal(canonicalize('eight'), '8');
    assert.equal(canonicalize("a bookkeeper's"), 'bookkeepers');
  });
});

test.describe('exact mode', () => {
  const puzzle = { answers: ['echo'], matchMode: 'exact' };

  test('accepts the answer regardless of case, padding, punctuation or article', () => {
    for (const input of ['echo', 'Echo', '  ECHO  ', 'an echo', 'The Echo!', 'écho']) {
      assert.equal(correct(input, puzzle), true, `expected "${input}" to be accepted`);
    }
  });

  test('rejects a different word and an empty submission', () => {
    assert.equal(correct('shadow', puzzle), false);
    assert.equal(correct('', puzzle), false);
    assert.equal(correct('   ', puzzle), false);
  });

  test('accepts a spelled-out number for a numeric answer, and vice versa', () => {
    assert.equal(correct('eight', { answers: ['8'] }), true);
    assert.equal(correct('8', { answers: ['eight'] }), true);
  });

  test('any of several accepted answers matches', () => {
    const multi = { answers: ['piano', 'keyboard'], matchMode: 'exact' };
    assert.equal(correct('keyboard', multi), true);
    assert.equal(correct('piano', multi), true);
    assert.equal(correct('organ', multi), false);
  });
});

test.describe('partial mode', () => {
  const puzzle = { answers: ['photographer'], matchMode: 'partial' };

  test('accepts the phrase embedded in a longer sentence', () => {
    assert.equal(correct('she is a photographer, obviously', puzzle), true);
  });

  test('accepts a submission that is itself contained in the accepted answer', () => {
    assert.equal(correct('photographer', { answers: ['she is a photographer'], matchMode: 'partial' }), true);
  });

  test('respects word boundaries so a substring of a longer word does not match', () => {
    assert.equal(correct('start', { answers: ['art'], matchMode: 'partial' }), false);
    assert.equal(correct('the art of it', { answers: ['art'], matchMode: 'partial' }), true);
  });
});

test.describe('regex mode', () => {
  test('treats each accepted answer as a case-insensitive pattern', () => {
    const puzzle = { answers: ['^(5|five)( cents)?$'], matchMode: 'regex' };
    assert.equal(correct('five cents', puzzle), true);
    assert.equal(correct('5', puzzle), true);
    assert.equal(correct('ten', puzzle), false);
  });

  test('skips a pattern that does not compile instead of throwing', () => {
    const puzzle = { answers: ['([unclosed', 'valid'], matchMode: 'regex' };
    assert.doesNotThrow(() => matchAnswer('valid', puzzle));
    assert.equal(correct('valid', puzzle), true);
  });

  test('refuses catastrophic-backtracking patterns', () => {
    assert.equal(isSafeRegexSource('(a+)+b'), false);
    assert.equal(isSafeRegexSource('x'.repeat(500)), false);
    assert.equal(isSafeRegexSource('^(5|five)$'), true);
  });

  test('a rejected pattern cannot accept an answer', () => {
    assert.equal(correct('aaaaaaaaaaaaaaaaaaaa!', { answers: ['(a+)+b'], matchMode: 'regex' }), false);
  });
});

test('a puzzle with no answers can never be solved', () => {
  assert.equal(correct('anything', { answers: [] }), false);
  assert.equal(correct('anything', {}), false);
});

test('non-string submissions are rejected rather than crashing', () => {
  assert.equal(correct(null, { answers: ['echo'] }), false);
  assert.equal(correct(undefined, { answers: ['echo'] }), false);
});
