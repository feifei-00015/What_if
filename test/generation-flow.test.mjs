import test from 'node:test';
import assert from 'node:assert/strict';
import { convergenceDepth, generationPhase, plannedLevels, storyProgress } from '../web/generation-flow.mjs';

function node(title, children = []) {
  return { title, terminal: false, children };
}

test('all modes change phase at two thirds and exploration stops at the boundary', () => {
  for (const [target, boundary, batch] of [[8, 6, 3], [12, 8, 3], [15, 10, 2]]) {
    assert.equal(convergenceDepth(target), boundary);
    assert.equal(generationPhase(boundary - 1, target), 'explore');
    assert.equal(generationPhase(boundary, target), 'converge');
    assert.equal(plannedLevels(boundary - 1, target, batch), 1);
    assert.equal(plannedLevels(boundary, target, batch), target - boundary);
    assert.equal(plannedLevels(target, target, batch), 0);
  }
  assert.equal(convergenceDepth(10), 7);
});

test('late pending leaves follow tree order and finish one frontier subtree first', () => {
  const a4 = node('A4');
  const b4 = node('B4');
  const a = node('A', [node('A2', [node('A3', [a4])])]);
  const b = node('B', [node('B2', [node('B3', [b4])])]);
  const root = node('root', [a, b]);
  assert.deepEqual(storyProgress(root, 6).pending.map(item => item.node.title), ['A4', 'B4']);
  a4.children = [node('A5')];
  assert.deepEqual(storyProgress(root, 6).pending.map(item => item.node.title), ['A5', 'B4']);
  a4.children[0].children = [node('A6')];
  assert.deepEqual(storyProgress(root, 6).pending.map(item => item.node.title), ['B4']);
  assert.equal(storyProgress(root, 6).capped, 1);
});

test('unresolved early leaves are explored before the convergence frontier', () => {
  const late = node('late');
  const early = node('early');
  const root = node('root', [node('A', [node('A2', [node('A3', [late])])]), early]);
  assert.deepEqual(storyProgress(root, 6).pending.map(item => item.node.title), ['early', 'late']);
});
