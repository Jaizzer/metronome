import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreIndex } from '../src/restore.js';

const practices = [{ id: 1 }, { id: 2 }, { id: 3 }];

test('reopens the routine that was shown', () => {
	assert.equal(restoreIndex(practices, 3, 1), 2);
});

test('falls back to the selection when the shown routine was deleted', () => {
	assert.equal(restoreIndex(practices, 99, 2), 1);
});

test('falls back to the first routine when nothing saved exists', () => {
	assert.equal(restoreIndex(practices, null, undefined), 0);
	assert.equal(restoreIndex(practices, 99, 98), 0);
	assert.equal(restoreIndex([], 1), 0);
});
