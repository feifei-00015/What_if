import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutTree, zoomAt } from '../web/map-layout.mjs';
const node = (children = []) => ({ title: '同样的结局也保留', children });
test('single root has finite bounds and stays at the origin', () => {
  const graph = layoutTree(node());
  assert.equal(graph.nodes.length, 1);
  assert.equal(graph.nodes[0].y, 0);
  assert.ok(graph.bounds.right > graph.bounds.left);
});
test('unbalanced paths stay distinct and do not collide within a column', () => {
  const root = node([node(), node([node(), node([node(), node()])]), node()]);
  const graph = layoutTree(root);
  assert.equal(graph.nodes.length, 8);
  assert.equal(new Set(graph.nodes.map(n => n.id)).size, 8);
  for (const { from, to } of graph.edges) assert.ok(to.x > from.x);
  for (const entry of graph.nodes) for (const other of graph.nodes) {
    if (entry.id !== other.id && entry.depth === other.depth) assert.ok(Math.abs(entry.y - other.y) >= 120);
  }
});
test('a large tree preserves all nodes and root position', () => {
  const build = depth => node(depth ? [build(depth - 1), build(depth - 1)] : []);
  const graph = layoutTree(build(8));
  assert.equal(graph.nodes.length, 511);
  assert.equal(graph.nodes[0].y, 0);
  assert.ok(graph.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y)));
});
test('later branches do not spread the choices near the start', () => {
  const initial = node([node(), node(), node()]);
  const grow = depth => node(depth ? [grow(depth - 1), grow(depth - 1), grow(depth - 1)] : []);
  const expanded = node([grow(4), node(), grow(4)]);
  for (const scale of [1, .3]) {
    const before = layoutTree(initial, { scale });
    const after = layoutTree(expanded, { scale });
    for (const id of ['r', 'r.0', 'r.1', 'r.2']) {
      const first = before.nodes.find(entry => entry.id === id);
      const grown = after.nodes.find(entry => entry.id === id);
      assert.deepEqual({ x: grown.x, y: grown.y }, { x: first.x, y: first.y });
    }
    const choices = after.nodes.filter(entry => entry.depth === 1);
    const width = (Math.max(...choices.map(entry => entry.y)) - Math.min(...choices.map(entry => entry.y))) * scale;
    assert.ok(width <= 300, `first choices spread ${width}px at ${scale} zoom`);
    const last = after.nodes.filter(entry => entry.depth === 5);
    const fanWidth = (Math.max(...last.map(entry => entry.y)) - Math.min(...last.map(entry => entry.y))) * scale;
    assert.ok(fanWidth > width * 3);
  }
});
test('children of each parent form a distinct cluster at later depths', () => {
  const build = depth => node(depth ? Array.from({ length: 3 }, () => build(depth - 1)) : []);
  for (const scale of [1, .3]) {
    const graph = layoutTree(build(4), { scale });
    const layers = new Map();
    for (const entry of graph.nodes) {
      if (!layers.has(entry.depth)) layers.set(entry.depth, []);
      layers.get(entry.depth).push(entry);
    }
    for (const [depth, entries] of layers) {
      if (depth < 2) continue;
      for (let i = 1; i < entries.length; i++) {
        if (entries[i].parent === entries[i - 1].parent) continue;
        const gap = (entries[i].y - entries[i - 1].y) * scale;
        assert.ok(gap >= 185, `depth ${depth} neighboring families have only ${gap}px between them`);
      }
    }
  }
});
test('opening a branch gives its descendants room without moving unrelated branches right', () => {
  const root = node([node([node(), node()]), node([node(), node()]), node()]);
  const compact = layoutTree(root, { scale: .7 });
  const expanded = layoutTree(root, { openIds: ['r.0'], scale: .7 });
  const get = (graph, id) => graph.nodes.find(entry => entry.id === id);
  const addedSpace = get(expanded, 'r.0.0').x - get(compact, 'r.0.0').x;
  assert.ok(addedSpace > 100 && addedSpace < 200);
  assert.equal(get(expanded, 'r.1.0').x, get(compact, 'r.1.0').x);
  assert.ok(Math.abs(get(expanded, 'r.0').y - get(expanded, 'r.1').y) >
    Math.abs(get(compact, 'r.0').y - get(compact, 'r.1').y));
});
test('opened ancestors stay connected at overview scale', () => {
  const graph = layoutTree(node([node([node()])]), { openIds: ['r', 'r.0', 'r.0.0'], scale: .3 });
  for (const { from, to } of graph.edges) {
    const screenGap = (to.x - from.x) * .3;
    assert.ok(screenGap >= 350 && screenGap <= 380);
  }
});
test('large branching trees reserve label space at minimum zoom', () => {
  const build = depth => node(depth ? Array.from({ length: 5 }, () => build(depth - 1)) : []);
  const graph = layoutTree(build(4), { scale: .3 });
  assert.equal(graph.nodes.length, 781);
  for (const { from, to } of graph.edges) {
    assert.ok((to.x - from.x) * .3 >= 270);
  }
  const byDepth = new Map();
  for (const entry of graph.nodes) {
    const peers = byDepth.get(entry.depth) || [];
    peers.push(entry);
    byDepth.set(entry.depth, peers);
  }
  for (const peers of byDepth.values()) {
    peers.sort((a, b) => a.y - b.y);
    for (let i = 1; i < peers.length; i++) {
      const spacing = (peers[i].y - peers[i - 1].y) * .3;
      assert.ok(spacing >= (peers[i].depth >= 4 ? 140 : 100));
    }
  }
  const first = byDepth.get(1);
  assert.ok((first.at(-1).y - first[0].y) * .3 <= 450);
});
test('zoom keeps the world point under the cursor and clamps extremes', () => {
  const view = { x: 130, y: -30, k: .7 };
  const next = zoomAt(view, 1.4, 400, 300);
  assert.equal((400 - view.x) / view.k, (400 - next.x) / next.k);
  assert.equal((300 - view.y) / view.k, (300 - next.y) / next.k);
  assert.equal(zoomAt(view, 100, 0, 0).k, 1);
  assert.equal(zoomAt(view, 0, 0, 0).k, .3);
});
