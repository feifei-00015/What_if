import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../backend/server.mjs';
import { createTrialStore } from '../backend/trial-store.mjs';
import { SUBTREE_STRATEGY, PREVIOUS_SUBTREE_STRATEGY, SUBTREE_MODES, subtreeTask, subtreeProgress, markSubtreeStage } from '../web/generation-flow.mjs';

const frame = { premise: '如果当时主动沟通', facts: ['双方发生争执'], timeline: [], motives: [], unknowns: [] };
const node = (title = '回应尚待明确', children = [], terminal = false) => ({
  title, story: '双方说明了自己的想法，核心分歧仍待解决。', terminal,
  memory: terminal || children.length ? '' : '已说明想法；分歧仍待解决', children,
});
const envelope = value => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }] }));
async function server(t, reply, store) {
  const requests = [];
  const app = createServer({ baseUrl: 'https://mock.example/v1', defaultModel: 'qwen3.8-flash',
    storedApiKey: 'mock-secret', trialStore: store,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const input = JSON.parse(body.messages[1].content);
      requests.push({ body, input });
      return reply(input, requests.length);
    } });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => app.close());
  return { requests, async post(path, input, token) {
    if (path === '/generate' && input.storyId) input = { frame, branchState: '', legacyPath: [], ...input };
    const response = await fetch(`http://127.0.0.1:${app.address().port}${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(input) });
    return { status: response.status, data: await response.json() };
  } };
}
const request = (mode = 'normal', stage = 1, depth = 0, generationStrategy = SUBTREE_STRATEGY) => ({
  frame, generationStrategy, stage, mode, depth,
  targetDepth: SUBTREE_MODES[mode].depth, levels: subtreeTask(mode, stage, generationStrategy).levels,
});

test('local subtree budgets yield mode depth envelopes without a global route quota', () => {
  for (const [mode, depth, leaves] of [['light', 8, [5, 3, 2]], ['normal', 10, [8, 4, 2]], ['deep', 12, [11, 4, 2]]]) {
    const tasks = [1, 2, 3].map(stage => subtreeTask(mode, stage));
    assert.equal(tasks.reduce((n, task) => n + task.levels, 0), depth);
    assert.deepEqual(tasks.map(task => task.maxLeaves), leaves);
    assert.ok(tasks.every(task => task.maxNodes <= 96));
  }
});

test('all frontier siblings finish before advancing stages, including after serialization', () => {
  const root = node('root', markSubtreeStage([node('A'), node('B')], 1));
  const a = root.children[0];
  a.children = markSubtreeStage([node('A2')], 2);
  let progress = subtreeProgress(JSON.parse(JSON.stringify(root)));
  assert.deepEqual(progress.pending.map(item => [item.node.title, item.stage]), [['B', 2], ['A2', 3]]);
  root.children[1].children = markSubtreeStage([node('B2')], 2);
  progress = subtreeProgress(root);
  assert.deepEqual(progress.pending.map(item => item.node.title), ['A2', 'B2']);
  for (const item of progress.pending) item.node.children = markSubtreeStage([node('开放结尾')], 3);
  assert.equal(subtreeProgress(root).pending.length, 0);
  assert.equal(subtreeProgress(root).capped, 2);
  assert.equal(subtreeProgress(root).ended, 0);
});

test('each full-subtree stage sends its own mission and complete ancestor context', async t => {
  const app = await server(t, () => envelope({ branches: [node()] }));
  for (const mode of Object.keys(SUBTREE_MODES)) {
    let depth = 0;
    for (const stage of [1, 2, 3]) {
      const result = await app.post('/generate', { ...request(mode, stage, depth), branchState: '已解决道歉问题',
        legacyPath: depth ? [{ title: '已经道歉', story: '双方已接受道歉。', assumption: '' }] : [] });
      assert.equal(result.status, 200, JSON.stringify(result));
      const { body, input } = app.requests.at(-1);
      assert.equal(input.stage, stage);
      assert.equal(input.maxLeaves, subtreeTask(mode, stage).maxLeaves);
      assert.equal(body.max_completion_tokens, 32768);
      assert.equal(body.response_format.type, 'json_schema');
      assert.equal(input.legacyPath.length, depth ? 1 : 0);
      assert.match(body.messages[0].content, /一次性返回全部节点/);
      assert.ok(body.messages[0].content.includes(['【近期变化】', '【实际磨合】', '【长期收束】'][stage - 1]));
      assert.doesNotMatch(body.messages[0].content, /15 条|30 条|45–55/);
      assert.doesNotMatch(body.messages[0].content, /当前分支尚未到达整体深度的三分之二/);
      assert.equal(input.totalRoutes, undefined);
      depth += subtreeTask(mode, stage).levels;
    }
  }
});

function overBudgetTree() {
  return ['A', 'B', 'C'].map(title => node(title,
    [0, 1].map(i => node(`${title}${i}`, [node(`${title}${i}0`), node(`${title}${i}1`)]))));
}

for (const [strategy, keepCount] of [[PREVIOUS_SUBTREE_STRATEGY, 10], [SUBTREE_STRATEGY, 8]]) {
test(`12 valid routes are selected down to ${keepCount} for ${strategy} without truncating the tree`, async t => {
  const original = overBudgetTree();
  let selectionInput;
  const app = await server(t, input => {
    if (input.routes) {
      selectionInput = input;
      return envelope({ keepLeafPaths: [...input.routes.slice(0, keepCount - 1), input.routes.at(-1)].map(route => route.id) });
    }
    return envelope({ branches: original });
  });
  const result = await app.post('/generate', request('normal', 1, 0, strategy));
  assert.equal(result.status, 200);
  assert.equal(app.requests.length, 2);
  assert.equal(selectionInput.routes.length, 12);
  assert.equal(selectionInput.keepCount, keepCount);
  assert.deepEqual(selectionInput.requiredRootGroups, ['0', '1', '2']);
  assert.equal(app.requests[1].input.requestedLevels, undefined);
  assert.match(app.requests[1].body.messages[0].content, /不要重新生成树/);
  const schema = app.requests[1].body.response_format.json_schema.schema;
  assert.equal(schema.properties.keepLeafPaths.maxItems, keepCount);
  const leaves = [];
  function visit(nodes, depth) {
    for (const item of nodes) {
      if (item.children.length) visit(item.children, depth + 1);
      else { assert.equal(depth, 3); leaves.push(item); }
    }
  }
  visit(result.data.branches, 1);
  assert.equal(leaves.length, keepCount);
  assert.equal(result.data.branches.length, 3);
  assert.ok(leaves.every(item => item.memory === '已说明想法；分歧仍待解决' && !item.terminal));
  assert.deepEqual(leaves[0], original[0].children[0].children[0]);
});
}

for (const problem of ['duplicate', 'unknown', 'too-many', 'wrong-shape']) {
  test(`invalid route selection (${problem}) is retried once and rejected if still invalid`, async t => {
    const app = await server(t, input => {
      if (!input.routes) return envelope({ branches: overBudgetTree() });
      const ids = [...input.routes.slice(0, input.keepCount - 1), input.routes.at(-1)].map(route => route.id);
      if (problem === 'duplicate') ids[0] = ids[1];
      if (problem === 'unknown') ids[0] = '9.9.9';
      if (problem === 'too-many') ids.push(input.routes[input.keepCount - 1].id);
      return envelope(problem === 'wrong-shape' ? { branches: [] } : { keepLeafPaths: ids });
    });
    const result = await app.post('/generate', request());
    assert.equal(result.status, 502);
    assert.match(result.data.error, /路线筛选不正确/);
    assert.equal(app.requests.length, 3);
  });
}

test('invalid route selection recovers without regenerating the subtree', async t => {
  const app = await server(t, (input, call) => input.routes
    ? envelope({ keepLeafPaths: call === 2 ? []
      : [...input.routes.slice(0, input.keepCount - 1), input.routes.at(-1)].map(route => route.id) })
    : envelope({ branches: overBudgetTree() }));
  const result = await app.post('/generate', request());
  assert.equal(result.status, 200);
  assert.equal(app.requests.length, 3);
  assert.ok(app.requests.slice(1).every(item => item.input.routes));
});

test('invalid model envelope recovers on the second full-subtree call', async t => {
  const app = await server(t, (_input, call) => call === 1
    ? new Response('not json') : envelope({ branches: [node()] }));
  const result = await app.post('/generate', request());
  assert.equal(result.status, 200);
  assert.deepEqual(app.requests.map(item => item.input.requestedLevels), [3, 3]);
});

test('route selection preserves top-level diversity where the local budget allows it', async t => {
  // 7 + 1 leaves; keeping only the first four would erase the second primary direction.
  const a = node('A', [node('A0', [node(), node(), node()]), node('A1', [node(), node()]), node('A2', [node(), node()])]);
  const app = await server(t, input => input.routes
    ? envelope({ keepLeafPaths: input.routes.slice(0, input.keepCount).map(route => route.id) })
    : envelope({ branches: [a, node('B')] }));
  const result = await app.post('/generate', request('normal', 2, 3));
  assert.equal(result.status, 502);
  assert.match(result.data.error, /路线筛选不正确/);
});

for (const kind of ['timeout', 'truncated', 'bad-json', 'extra-field', 'half-sentence', 'mixed']) {
  test(`whole subtree ${kind} repairs once and never falls back to partial layers`, async t => {
    const app = await server(t, () => {
      if (kind === 'timeout') throw new DOMException('mock timeout', 'TimeoutError');
      if (kind === 'truncated') return new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"branches":[]}' } }] }));
      if (kind === 'bad-json') return new Response(JSON.stringify({ choices: [{ message: { content: '{"branches":[' } }] }));
      if (kind === 'extra-field') return envelope({ branches: [{ ...node(), extra: 'wrong' }] });
      if (kind === 'half-sentence') return envelope({ branches: [{ ...node(), story: '用户持续表达关心，但对方将这种' }] });
      return envelope({ branches: [{ ...node('双方可能复合或分开'), terminal: true, memory: '' }] });
    });
    const result = await app.post('/generate', request());
    assert.equal(result.status, 502);
    assert.deepEqual(app.requests.map(item => item.input.requestedLevels), [3, 3]);
  });
}

test('quota response is not retried, and invalid strategy never calls model', async t => {
  const app = await server(t, () => new Response('', { status: 429 }));
  assert.equal((await app.post('/generate', { ...request(), stage: 4 })).status, 400);
  assert.equal(app.requests.length, 0);
  assert.equal((await app.post('/generate', request())).status, 502);
  assert.equal(app.requests.length, 1);
});

test('trial enforces stage order, resumes atomic subtree commits and counts open endings complete once', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'what-if-stages-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'store.json');
  let store = createTrialStore(file);
  const guest = await store.guest();
  const story = await store.createStory(guest.token, { scenario: '如果主动沟通', context: '我们吵架了',
    mode: 'normal', generationStrategy: SUBTREE_STRATEGY });
  assert.equal(story.targetDepth, 10);
  const prepare = await store.claimPrepare(guest.token, story.id);
  await store.finishPrepare(guest.token, story.id, prepare.claim, frame);
  let invalid = false;
  const app = await server(t, input => envelope({ branches: invalid ? [{ ...node(), memory: '' }]
    : input.stage === 1 ? [node('A'), node('B')] : [node(`stage-${input.stage}`)] }), store);
  const generate = (id, levels) => app.post('/generate', { storyId: story.id, branchId: id, levels, stage: 3 }, guest.token);
  assert.equal((await generate(story.root.id, 1)).status, 400);
  const first = await generate(story.root.id, 3);
  assert.equal(first.status, 200);
  const [a, b] = first.data.branches;
  assert.equal(a.generationStage, 1);
  assert.equal((await generate(b.id, 3)).status, 409);
  const next = await generate(a.id, 3);
  assert.equal(next.status, 200);
  assert.equal((await generate(next.data.branches[0].id, 4)).status, 409);
  invalid = true;
  assert.equal((await generate(b.id, 3)).status, 502);
  store = createTrialStore(file);
  let restored = await store.getStory(guest.token, story.id);
  assert.equal(restored.root.children[1].children.length, 0);
  assert.equal(restored.root.children[0].children.length, 1);
  invalid = false;
  assert.equal((await generate(b.id, 3)).status, 200);
  restored = await store.getStory(guest.token, story.id);
  for (const item of subtreeProgress(restored.root).pending) {
    assert.equal(item.stage, 3);
    assert.equal((await generate(item.node.id, 4)).status, 200);
  }
  restored = await store.getStory(guest.token, story.id);
  assert.equal(restored.status, 'complete');
  assert.equal(subtreeProgress(restored.root).capped, 2);
  assert.equal((await store.status(guest.token)).completedToday, 1);
  const count = app.requests.length;
  assert.equal((await generate(a.id, 3)).status, 409);
  assert.equal(app.requests.length, count);
  assert.equal((await store.status(guest.token)).completedToday, 1);
  assert.equal((await store.status(guest.token)).remainingToday, 0);
});

test('persisted v1 trial resumes with its original budget and prompt after restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'what-if-v1-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'store.json');
  const store = createTrialStore(file);
  const guest = await store.guest();
  const story = await store.createStory(guest.token, { scenario: '如果主动沟通', context: '我们吵架了',
    mode: 'normal', generationStrategy: PREVIOUS_SUBTREE_STRATEGY });
  const prepare = await store.claimPrepare(guest.token, story.id);
  await store.finishPrepare(guest.token, story.id, prepare.claim, frame);
  const firstApp = await server(t, () => envelope({ branches: [node()] }), store);
  const first = await firstApp.post('/generate', { storyId: story.id, branchId: story.root.id, levels: 3 }, guest.token);
  assert.equal(first.status, 200);
  const restoredStore = createTrialStore(file);
  const app = await server(t, () => envelope({ branches: [node()] }), restoredStore);
  const next = await app.post('/generate', { storyId: story.id, branchId: first.data.branches[0].id,
    levels: 3, generationStrategy: SUBTREE_STRATEGY, stage: 3 }, guest.token);
  assert.equal(next.status, 200);
  assert.equal(app.requests[0].input.stage, 2);
  assert.equal(app.requests[0].input.maxLeaves, 5);
  assert.doesNotMatch(app.requests[0].body.messages[0].content, /【实际磨合】/);
  const saved = await restoredStore.getStory(guest.token, story.id);
  assert.equal(saved.generationStrategy, PREVIOUS_SUBTREE_STRATEGY);
  assert.equal(saved.root.children[0].children[0].generationStage, 2);
  assert.equal((await restoredStore.status(guest.token)).remainingToday, 0);
});

test('route selection commits only the validated tree and consumes model-call quota, not another story', async t => {
  for (const budget of [1, 2]) {
    const store = createTrialStore(null, { limits: { storyModelCalls: budget } });
    const guest = await store.guest();
    const story = await store.createStory(guest.token, { scenario: '如果及时沟通', context: '我们发生争执。',
      mode: 'normal', generationStrategy: SUBTREE_STRATEGY });
    const prepare = await store.claimPrepare(guest.token, story.id);
    await store.finishPrepare(guest.token, story.id, prepare.claim, frame);
    const app = await server(t, input => input.routes
      ? envelope({ keepLeafPaths: [...input.routes.slice(0, input.keepCount - 1), input.routes.at(-1)].map(route => route.id) })
      : envelope({ branches: overBudgetTree() }), store);
    const result = await app.post('/generate', { storyId: story.id, branchId: story.root.id, levels: 3 }, guest.token);
    const saved = await store.getStory(guest.token, story.id);
    assert.equal((await store.status(guest.token)).remainingToday, 0);
    assert.equal(saved.modelCalls, budget);
    if (budget === 1) {
      assert.equal(result.status, 429);
      assert.equal(saved.root.children.length, 0);
      assert.equal(app.requests.length, 1);
    } else {
      assert.equal(result.status, 200);
      assert.equal(subtreeProgress(saved.root).pending.length, 8);
      assert.ok(subtreeProgress(saved.root).pending.every(item => item.stage === 2));
      assert.equal(saved.root.children.length, 3);
      assert.equal(app.requests.length, 2);
    }
  }
});

test('route selection retry stops at the story call quota without saving a partial tree', async t => {
  const store = createTrialStore(null, { limits: { storyModelCalls: 2 } });
  const guest = await store.guest();
  const story = await store.createStory(guest.token, { scenario: '如果及时沟通', context: '我们发生争执。',
    mode: 'normal', generationStrategy: SUBTREE_STRATEGY });
  const prepare = await store.claimPrepare(guest.token, story.id);
  await store.finishPrepare(guest.token, story.id, prepare.claim, frame);
  const app = await server(t, input => input.routes
    ? envelope({ keepLeafPaths: [] }) : envelope({ branches: overBudgetTree() }), store);
  const result = await app.post('/generate', { storyId: story.id, branchId: story.root.id, levels: 3 }, guest.token);
  assert.equal(result.status, 429);
  assert.equal(app.requests.length, 2);
  const saved = await store.getStory(guest.token, story.id);
  assert.equal(saved.modelCalls, 2);
  assert.deepEqual(saved.root.children, []);
});
