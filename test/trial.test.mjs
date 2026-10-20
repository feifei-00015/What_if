import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../backend/server.mjs';
import { createTrialStore } from '../backend/trial-store.mjs';

function modelResponse(value) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { status: 200 });
}

async function setup(t, limits = {}, serverOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'what-if-trial-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'trial.json');
  const store = createTrialStore(path, { limits });
  let calls = 0;
  const credentials = [];
  const requests = [];
  let failNext = false;
  let reply;
  const server = createServer({
    baseUrl: 'https://mock.example/v1', defaultModel: 'mock-model', storedApiKey: 'server-secret',
    serveWeb: true, trialStore: store,
    ...serverOptions,
    fetchImpl: async (_url, options) => {
      calls++;
      credentials.push(options.headers.Authorization);
      requests.push({ url: String(_url), body: JSON.parse(options.body), redirect: options.redirect });
      if (failNext) { failNext = false; return new Response('', { status: 503 }); }
      if (reply) return reply(options);
      const input = JSON.parse(JSON.parse(options.body).messages[1].content);
      const result = input.scenario ? {
        premise: input.scenario, facts: ['已经分手'], timeline: [], motives: [], unknowns: [],
      } : { branches: [{ title: '平静沟通', story: '双方说清了当时的误会。', terminal: true, children: [] }] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), { status: 200 });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const stories = new Map();
  async function post(route, body, token, userKey) {
    if (route === '/prepare' && stories.has(body.storyId)) {
      const story = stories.get(body.storyId);
      body = { scenario: story.scenario, context: story.context, ...body };
    }
    if (route === '/generate' && stories.has(body.storyId)) {
      const story = stories.get(body.storyId);
      body = { frame: story.frame, branchState: '', legacyPath: [], ...body };
    }
    const response = await fetch(url + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(userKey ? { 'X-User-Api-Key': userKey } : {}) },
      body: JSON.stringify(body),
    });
    const result = { status: response.status, body: await response.json() };
    if (route === '/trial/stories' && result.body.story) stories.set(result.body.story.id, result.body.story);
    if (route === '/prepare' && result.body.frame && stories.has(body.storyId)) {
      stories.get(body.storyId).frame = result.body.frame;
    }
    return result;
  }
  return { url, path, post, credentials, requests, get calls() { return calls; }, fail() { failNext = true; },
    setReply(value) { reply = value; } };
}

test('guest token survives store restart and unfinished story resumes without another daily start', async t => {
  const app = await setup(t);
  const guest = (await app.post('/trial/guest', {})).body;
  const sameGuest = (await app.post('/trial/guest', { token: guest.token })).body;
  assert.equal(sameGuest.token, guest.token);
  const storyResult = await app.post('/trial/stories', {
    scenario: '如果分手后我道歉', context: '我们因一场误会分手，我一直想说清楚。', mode: 'light', apiKey: 'untrusted',
  }, guest.token);
  assert.equal(storyResult.status, 201);
  const story = storyResult.body.story;
  assert.equal(storyResult.body.story.visitorId, undefined);
  assert.equal((await app.post('/trial/stories', { scenario: '再来一次', context: '故事', mode: 'light' }, guest.token)).status, 409);
  const resumed = createTrialStore(app.path);
  assert.equal((await resumed.status(guest.token)).activeStoryId, story.id);
  assert.equal((await resumed.getStory(guest.token, story.id)).root.id, story.root.id);

  const withoutToken = await app.post('/prepare', { storyId: story.id });
  assert.equal(withoutToken.status, 401);
  assert.equal(app.calls, 0);
  const prepared = await app.post('/prepare', { storyId: story.id, apiKey: 'untrusted' }, guest.token);
  assert.equal(prepared.status, 200);
  assert.equal(app.calls, 1);

  const expanded = await app.post('/generate', { storyId: story.id, branchId: story.root.id, levels: 3 }, guest.token);
  assert.equal(expanded.status, 200);
  assert.equal(expanded.body.branches.length, 1);
  assert.ok(expanded.body.branches[0].id);
  assert.equal(app.calls, 2);
  assert.equal((await app.post('/generate', { storyId: story.id, branchId: story.root.id, levels: 3 }, guest.token)).status, 409);
  assert.equal(app.calls, 2);
  assert.equal((await resumed.getStory(guest.token, story.id)).status, 'complete');
  assert.equal((await resumed.status(guest.token)).remainingToday, 1);
  assert.equal((await resumed.status(guest.token)).keyPromptRequired, false);
  const second = (await app.post('/trial/stories', { scenario: '另一个如果', context: '另一段故事。', mode: 'light' }, guest.token)).body.story;
  await app.post('/prepare', { storyId: second.id }, guest.token);
  await app.post('/generate', { storyId: second.id, branchId: second.root.id, levels: 3 }, guest.token);
  assert.equal((await resumed.status(guest.token)).remainingToday, 0);
  assert.equal((await resumed.status(guest.token)).completedToday, 2);
  assert.equal((await resumed.status(guest.token)).keyPromptRequired, true);
  assert.equal((await app.post('/trial/stories', { scenario: '另一个', context: '故事', mode: 'light' }, guest.token)).status, 429);
  assert.deepEqual(app.credentials, Array(4).fill('Bearer server-secret'));
});

test('personal key is required for own-funded stories and is never persisted or charged to site quota', async t => {
  const app = await setup(t, { siteStoriesPerDay: 1, siteModelCallsPerDay: 2 });
  const token = (await app.post('/trial/guest', {})).body.token;
  const own = (await app.post('/trial/stories', {
    scenario: '如果我主动解释', context: '我们因为误会停止联系。', mode: 'normal', funding: 'own',
  }, token)).body.story;
  assert.equal(own.funding, 'own');
  assert.equal((await app.post('/prepare', { storyId: own.id, apiKey: 'body-key-must-be-ignored' }, token)).status, 400);
  assert.equal(app.calls, 0);
  assert.equal((await app.post('/prepare', { storyId: own.id }, token, 'test-user-key')).status, 200);
  assert.equal((await app.post('/generate', { storyId: own.id, branchId: own.root.id, levels: 3 }, token, 'test-user-key')).status, 200);
  assert.deepEqual(app.credentials, ['Bearer test-user-key', 'Bearer test-user-key']);
  assert.equal((await createTrialStore(app.path).status(token)).remainingToday, 2);
  assert.equal((await createTrialStore(app.path).status(token)).completedToday, 0);
  assert.equal((await readFile(app.path, 'utf8')).includes('test-user-key'), false);

  const free = (await app.post('/trial/stories', {
    scenario: '如果我打电话', context: '之后一直没有联系。', mode: 'light', funding: 'site',
  }, token)).body.story;
  assert.equal((await app.post('/prepare', { storyId: free.id }, token, 'ignored-user-key')).status, 200);
  assert.equal((await app.post('/generate', { storyId: free.id, branchId: free.root.id, levels: 3 }, token, 'ignored-user-key')).status, 200);
  assert.deepEqual(app.credentials.slice(-2), ['Bearer server-secret', 'Bearer server-secret']);
});

test('server keeps only story structure and quota, and removes the previous story on replacement', async t => {
  const app = await setup(t);
  const token = (await app.post('/trial/guest', {})).body.token;
  const first = (await app.post('/trial/stories', {
    scenario: '如果我说出私密假设', context: '只有浏览器应保存的私人往事', mode: 'light',
  }, token)).body.story;
  assert.equal((await app.post('/prepare', { storyId: first.id }, token)).status, 200);
  const generated = await app.post('/generate', { storyId: first.id, branchId: first.root.id, levels: 3 }, token);
  assert.equal(generated.status, 200);
  const stored = await readFile(app.path, 'utf8');
  for (const prose of ['私密假设', '私人往事', '已经分手', '双方说清了当时的误会', '平静沟通']) {
    assert.equal(stored.includes(prose), false, prose);
  }
  const next = (await app.post('/trial/stories', {
    scenario: '另一个故事', context: '另一个背景', mode: 'light',
  }, token)).body.story;
  assert.notEqual(next.id, first.id);
  const data = JSON.parse(await readFile(app.path, 'utf8'));
  assert.equal(data.stories[first.id], undefined);
  assert.ok(data.stories[next.id]);
  assert.equal((await fetch(`${app.url}/trial/stories/${first.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  })).status, 404);
});

test('legacy story file is scrubbed to active structure without retaining prose', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'what-if-legacy-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'trial.json');
  const token = 'a'.repeat(43);
  const active = 'active-story';
  const complete = 'complete-story';
  const { createHash } = await import('node:crypto');
  const id = createHash('sha256').update(token).digest('hex');
  await writeFile(path, JSON.stringify({
    guests: { [id]: { starts: { '2026-10-05': 2 }, completed: {}, activeStoryId: active } },
    days: { '2026-10-05': { stories: 2, modelCalls: 1 } },
    stories: {
      [active]: { id: active, visitorId: id, scenario: '私密假设', context: '私密背景',
        mode: 'light', funding: 'site', status: 'running', targetDepth: 8, frame: { facts: ['秘密事实'] },
        root: { id: 'root', title: '私密假设', story: '', children: [
          { id: 'branch', title: '私密标题', story: '私密内容', terminal: false, children: [] },
        ] } },
      [complete]: { id: complete, visitorId: id, status: 'complete',
        root: { id: 'old-root', title: '旧故事', children: [] } },
    },
  }));
  const store = createTrialStore(path);
  await store.scrubLegacy();
  const stored = await readFile(path, 'utf8');
  for (const prose of ['私密假设', '私密背景', '秘密事实', '私密标题', '私密内容', '旧故事']) {
    assert.equal(stored.includes(prose), false, prose);
  }
  const data = JSON.parse(stored);
  assert.equal(data.version, 2);
  assert.equal(data.stories[complete], undefined);
  assert.deepEqual(data.stories[active].nodes.root.children, ['branch']);
  assert.equal((await store.status(token)).activeStoryId, active);
});

test('personal API config routes both model calls while site-funded stories ignore overrides', async t => {
  const app = await setup(t);
  const token = (await app.post('/trial/guest', {})).body.token;
  const modelConfig = { baseUrl: 'https://personal.example/api/v1/', model: 'personal-model' };
  for (const funding of ['own', 'site']) {
    const story = (await app.post('/trial/stories', {
      scenario: '如果及时解释', context: '我们因为误会停止联系。', mode: 'normal', funding,
    }, token)).body.story;
    assert.equal((await app.post('/prepare', { storyId: story.id, modelConfig }, token, 'personal-key')).status, 200);
    assert.equal((await app.post('/generate', { storyId: story.id, branchId: story.root.id, levels: 3, modelConfig },
      token, 'personal-key')).status, 200);
  }
  assert.deepEqual(app.requests.map(request => [request.url, request.body.model]), [
    ['https://personal.example/api/v1/chat/completions', 'personal-model'],
    ['https://personal.example/api/v1/chat/completions', 'personal-model'],
    ['https://mock.example/v1/chat/completions', 'mock-model'],
    ['https://mock.example/v1/chat/completions', 'mock-model'],
  ]);
  assert.deepEqual(app.credentials, ['Bearer personal-key', 'Bearer personal-key', 'Bearer server-secret', 'Bearer server-secret']);
  assert.ok(app.requests.every(request => request.redirect === 'error'));
  const stored = await readFile(app.path, 'utf8');
  for (const value of ['personal-key', 'personal.example', 'personal-model']) assert.equal(stored.includes(value), false);
});

test('invalid personal API config makes no model calls and releases the claim for correction', async t => {
  const app = await setup(t);
  const token = (await app.post('/trial/guest', {})).body.token;
  const story = (await app.post('/trial/stories', {
    scenario: '如果及时解释', context: '我们因为误会停止联系。', mode: 'normal', funding: 'own',
  }, token)).body.story;
  for (const modelConfig of [null, {},
    { baseUrl: 'http://personal.example/v1', model: 'personal-model' },
    { baseUrl: 'https://user:secret@personal.example/v1', model: 'personal-model' },
    { baseUrl: 'https://personal.example/v1?key=secret', model: 'personal-model' },
    { baseUrl: 'https://personal.example/v1/chat/completions', model: 'personal-model' },
    { baseUrl: 'https://personal.example/v1', model: '' },
  ]) {
    assert.equal((await app.post('/prepare', { storyId: story.id, modelConfig }, token, 'personal-key')).status, 400);
  }
  assert.equal(app.calls, 0);
  assert.equal((await app.post('/prepare', { storyId: story.id,
    modelConfig: { baseUrl: 'https://personal.example/v1', model: 'personal-model' } }, token, 'personal-key')).status, 200);
  assert.equal(app.calls, 1);
});

test('personal API works when the site model is not configured', async t => {
  const app = await setup(t, {}, { baseUrl: '', defaultModel: '', storedApiKey: '' });
  const config = await (await fetch(`${app.url}/config`)).json();
  assert.equal(config.ready, false);
  const token = (await app.post('/trial/guest', {})).body.token;
  const story = (await app.post('/trial/stories', {
    scenario: '如果及时解释', context: '我们因为误会停止联系。', mode: 'normal', funding: 'own',
  }, token)).body.story;
  const modelConfig = { baseUrl: 'https://personal.example/v1', model: 'personal-model' };
  assert.equal((await app.post('/prepare', { storyId: story.id, modelConfig }, token, 'personal-key')).status, 200);
  assert.equal((await app.post('/generate', { storyId: story.id, branchId: story.root.id, levels: 3, modelConfig },
    token, 'personal-key')).status, 200);
  assert.deepEqual(app.requests.map(request => request.body.model), ['personal-model', 'personal-model']);
});

test('failed model call can retry the same story; global cap applies across new guest tokens', async t => {
  const app = await setup(t, { siteStoriesPerDay: 1 });
  const first = (await app.post('/trial/guest', {})).body.token;
  const created = (await app.post('/trial/stories', { scenario: '如果我主动解释', context: '发生了一次争吵。', mode: 'normal' }, first)).body.story;
  await app.post('/prepare', { storyId: created.id }, first);
  app.fail();
  const failed = await app.post('/generate', { storyId: created.id, branchId: created.root.id, levels: 3 }, first);
  assert.equal(failed.status, 502);
  assert.equal((await app.post('/generate', { storyId: created.id, branchId: created.root.id, levels: 3 }, first)).status, 200);
  const second = (await app.post('/trial/guest', {})).body.token;
  assert.equal((await app.post('/trial/stories', { scenario: '如果我回去', context: '另一段故事。', mode: 'light' }, second)).status, 429);
});

test('trial convergence validates the frontier, keeps failed output unsaved, and resumes it', async t => {
  const app = await setup(t);
  const token = (await app.post('/trial/guest', {})).body.token;
  const story = (await app.post('/trial/stories', {
    scenario: '如果我主动解释', context: '一次争吵之后我们停止交谈。', mode: 'normal',
  }, token)).body.story;
  await app.post('/prepare', { storyId: story.id }, token);
  const data = JSON.parse(await readFile(app.path, 'utf8'));
  const record = data.stories[story.id];
  let currentId = record.rootId;
  for (let depth = 1; depth <= 8; depth++) {
    const childId = `frontier-${depth}`;
    record.nodes[currentId].children = [childId];
    record.nodes[currentId].called = true;
    record.nodes[childId] = { children: [], terminal: false, depth, stage: 0, called: false };
    currentId = childId;
  }
  await writeFile(app.path, JSON.stringify(data));
  app.setReply(() => modelResponse({ branches: [{ title: '继续沟通', story: '双方继续交谈。',
    terminal: false, children: [] }] }));
  const invalidDepth = await app.post('/generate', { storyId: story.id, branchId: currentId, levels: 3 }, token);
  assert.equal(invalidDepth.status, 400);
  const failed = await app.post('/generate', { storyId: story.id, branchId: currentId, levels: 4 }, token);
  assert.equal(failed.status, 502);
  const stored = JSON.parse(await readFile(app.path, 'utf8'));
  const frontier = stored.stories[story.id].nodes[currentId];
  assert.deepEqual(frontier.children, []);
  assert.equal(frontier.claim, undefined);
  app.setReply(() => modelResponse({ branches: [{ title: '形成稳定边界',
    story: '双方接受了新的相处边界，关系逐渐稳定下来。', terminal: true, memory: '', children: [] }] }));
  const resumed = await app.post('/generate', { storyId: story.id, branchId: currentId, levels: 4 }, token);
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.branches[0].title, '形成稳定边界');
  assert.equal((await createTrialStore(app.path).status(token)).remainingToday, 1);
});
