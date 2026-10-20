import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../backend/server.mjs';
import { createTrialStore } from '../backend/trial-store.mjs';
import { apiUrl } from '../web/api-config.mjs';

const frame = {
  premise: '如果分手后我主动道歉',
  facts: ['两人已经分开'],
  timeline: ['分手后一周没有联系'],
  motives: ['我想表达歉意'],
  unknowns: ['对方是否愿意沟通'],
};

function modelResponse(value) {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(value) } }],
  }), { status: 200 });
}

async function startServer(options, t) {
  const server = createServer({ baseUrl: 'https://mock.example/v1', ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('visual artwork and styles are served with their browser content types', async t => {
  const url = await startServer({ serveWeb: true }, t);
  for (const [route, type] of [
    ['/lake.css', 'text/css'],
    ['/visual/water-surface.css', 'text/css'],
    ['/visual/light-beams.css', 'text/css'],
    ['/visual/node-ripples.css', 'text/css'],
    ['/visual/memory-star-ui.css', 'text/css'],
    ['/visual/water-surface.mjs', 'text/javascript'],
    ['/api-config.mjs', 'text/javascript'],
    ['/visual/light-beams.mjs', 'text/javascript'],
    ['/generation-flow.mjs', 'text/javascript'],
    ['/assets/lake-horizon.jpg', 'image/jpeg'],
    ['/assets/lake-overhead.jpg', 'image/jpeg'],
    ['/assets/memory-star-map-8k.jpg', 'image/jpeg'],
    ['/assets/paper-ball.svg', 'image/svg+xml'],
    ['/assets/what-if-logo.svg', 'image/svg+xml'],
  ]) {
    const response = await fetch(`${url}${route}`);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get('content-type').split(';')[0], type);
    assert.ok((await response.arrayBuffer()).byteLength > 0);
  }
});

test('static page can address a separate API origin and the API permits only its configured page origin', async t => {
  assert.equal(apiUrl('/config'), '/config');
  assert.equal(apiUrl('/config', 'https://api.example.com/'), 'https://api.example.com/config');
  const pageOrigin = 'https://example.github.io';
  const url = await startServer({
    defaultModel: 'mock-model', storedApiKey: 'server-secret', allowedOrigin: pageOrigin,
    trialStore: createTrialStore(),
  }, t);
  const config = await fetch(`${url}/config`, { headers: { Origin: pageOrigin } });
  assert.equal(config.status, 200);
  assert.equal(config.headers.get('access-control-allow-origin'), pageOrigin);
  assert.equal((await config.json()).trial, true);
  const preflight = await fetch(`${url}/trial/guest`, {
    method: 'OPTIONS', headers: { Origin: pageOrigin, 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,authorization' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), pageOrigin);
  const guest = await fetch(`${url}/trial/guest`, {
    method: 'POST', headers: { Origin: pageOrigin, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(guest.status, 200);
  assert.equal(guest.headers.get('access-control-allow-origin'), pageOrigin);
  assert.ok((await guest.json()).token);
  assert.equal((await fetch(`${url}/config`, { headers: { Origin: 'https://wrong.example' } })).status, 403);
});

test('opening form asks for the real story before the counterfactual', async t => {
  const url = await startServer({ serveWeb: true }, t);
  const html = await (await fetch(`${url}/`)).text();
  const context = html.indexOf('name="context"');
  const scenario = html.indexOf('name="scenario"');
  assert.ok(context >= 0 && scenario > context);
  assert.match(html, /name="context"[^>]*required/);
  assert.match(html, /name="scenario"[^>]*required/);
  assert.match(html, /<span>01<\/span>[\s\S]*说出你的故事/);
  assert.match(html, /<span>02<\/span>[\s\S]*如果……/);
  assert.match(html, /id="star-flight"/);
  assert.match(html, /<img class="brand-logo" src="\.\/assets\/what-if-logo\.svg" alt="What_if">/);
  assert.doesNotMatch(html, /id="paper-flight"/);
});

test('long story is structured once and the saved key stays on the server', async t => {
  const secret = 'stored-test-secret';
  let seen;
  const url = await startServer({
    defaultModel: 'qwen3.8-flash', storedApiKey: secret, serveWeb: true,
    fetchImpl: async (_url, options) => {
      seen = options;
      return modelResponse({ ...frame, premise: '模型擅自增加了一个结果' });
    },
  }, t);
  const config = await (await fetch(`${url}/config`)).text();
  assert.equal(config.includes(secret), false);
  const response = await fetch(`${url}/prepare`, {
    method: 'POST', body: JSON.stringify({ scenario: frame.premise, context: '分手后我很难过，反复想起那场争吵。' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).frame, frame);
  assert.equal(seen.headers.Authorization, `Bearer ${secret}`);
  const request = JSON.parse(seen.body);
  assert.match(request.messages[0].content, /故事资料整理员/);
  assert.match(request.messages[0].content, /facts、timeline、motives 只能来自 narrative/);
  assert.match(request.messages[0].content, /scenario 中的愿望、假设、预期结果和人物反应一律不能写成已知事实/);
  assert.match(request.messages[1].content, /反复想起那场争吵/);
  assert.deepEqual(JSON.parse(request.messages[1].content), {
    scenario: frame.premise,
    narrative: '分手后我很难过，反复想起那场争吵。',
  });
  assert.equal(request.response_format.type, 'json_object');
});

test('a short hypothesis needs no extra model call for structure', async t => {
  let calls = 0;
  const url = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only',
    fetchImpl: async () => { calls++; throw new Error('unexpected'); },
  }, t);
  const response = await fetch(`${url}/prepare`, {
    method: 'POST', body: JSON.stringify({ scenario: '如果我道歉', context: '' }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).frame, {
    premise: '如果我道歉', facts: [], timeline: [], motives: [], unknowns: [],
  });
  assert.equal(calls, 0);
});

test('invalid story frame is regenerated once before continuing', async t => {
  const requests = [];
  const url = await startServer({
    defaultModel: 'qwen3.8-flash', storedApiKey: 'test-only',
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return modelResponse(requests.length === 1 ? { ...frame, facts: 'wrong shape' } : frame);
    },
  }, t);
  const response = await fetch(`${url}/prepare`, { method: 'POST', body: JSON.stringify({
    scenario: frame.premise, context: '分手后我很难过，反复想起那场争吵。',
  }) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).frame, frame);
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages[0].content, /格式不正确/);
});

test('invalid model envelope is retried once and exhausted without extra calls', async t => {
  let calls = 0;
  const url = await startServer({
    defaultModel: 'qwen3.8-flash', storedApiKey: 'test-only',
    fetchImpl: async () => { calls++; return new Response('not json'); },
  }, t);
  const response = await fetch(`${url}/prepare`, { method: 'POST', body: JSON.stringify({
    scenario: frame.premise, context: '分手后我很难过，反复想起那场争吵。',
  }) });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /无法识别/);
  assert.equal(calls, 2);
});

test('continuation sends the story frame and only the selected branch memory', async t => {
  let seen;
  const url = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only',
    fetchImpl: async (_url, options) => {
      seen = JSON.parse(options.body);
      return modelResponse({ branches: [
        { title: '继续交谈', story: '对方解释了当时的想法。', terminal: false,
          memory: '道歉已被接受；双方继续交谈，关系尚未确定', children: [] },
      ] });
    },
  }, t);
  const response = await fetch(`${url}/generate`, {
    method: 'POST', body: JSON.stringify({
      frame, branchState: '我已道歉；对方愿意谈，但没有决定复合',
      currentEvent: { title: '愿意谈谈', story: '对方回复了消息。' },
      legacyPath: [{ title: '另一条线', story: '不相关内容', assumption: '' }],
      depth: 4, levels: 4, targetDepth: 12,
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).branches[0].memory, '道歉已被接受；双方继续交谈，关系尚未确定');
  const input = JSON.parse(seen.messages[1].content);
  assert.deepEqual(input.storyFrame, frame);
  assert.equal(input.branchState, '我已道歉；对方愿意谈，但没有决定复合');
  assert.equal(input.currentEvent.title, '愿意谈谈');
  assert.equal(input.legacyPath, undefined);
  assert.equal(JSON.stringify(input).includes('另一条线'), false);
  assert.equal(input.requestedLevels, 4);
  assert.equal(input.currentDepth, 4);
  assert.equal(input.targetDepth, 12);
  assert.equal(seen.temperature, 0.3);
  assert.match(seen.messages[0].content, /相对稳定的状态/);
  assert.match(seen.messages[0].content, /targetDepth 大于等于 5/);
});

test('four-level subtree needs memory on every open leaf and obeys depth', async t => {
  const chain = { title: '第四步', story: '故事还没有结束。', terminal: false,
    memory: '双方已沟通，仍未决定是否重建关系', children: [] };
  const subtree = { branches: [
    { title: '告一段落', story: '双方接受了分开。', terminal: true, children: [] },
    { title: '第一步', story: '重新联系。', terminal: false, children: [
      { title: '第二步', story: '开始沟通。', terminal: false, children: [
        { title: '第三步', story: '理解分歧。', terminal: false, children: [chain] },
      ] },
    ] },
  ] };
  const url = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only',
    fetchImpl: async () => modelResponse(subtree),
  }, t);
  const base = { frame, depth: 0 };
  const okay = await fetch(`${url}/generate`, { method: 'POST', body: JSON.stringify({ ...base, levels: 4 }) });
  assert.equal(okay.status, 200);
  assert.equal((await okay.json()).branches[1].children[0].children[0].children[0].memory, chain.memory);
  const tooDeep = await fetch(`${url}/generate`, { method: 'POST', body: JSON.stringify({ ...base, levels: 3 }) });
  assert.equal(tooDeep.status, 502);
  chain.memory = '';
  const noMemory = await fetch(`${url}/generate`, { method: 'POST', body: JSON.stringify({ ...base, levels: 4 }) });
  assert.equal(noMemory.status, 502);
});

test('generation prompt specifies the exact branch JSON contract', async t => {
  let prompt;
  const url = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only',
    fetchImpl: async (_url, options) => {
      prompt = JSON.parse(options.body).messages[0].content;
      return modelResponse({ branches: [] });
    },
  }, t);
  const response = await fetch(`${url}/generate`, {
    method: 'POST', body: JSON.stringify({ frame, levels: 2 }),
  });
  assert.equal(response.status, 200);
  assert.match(prompt, /唯一顶层字段是 branches/);
  assert.match(prompt, /title、story、terminal、memory、children 五个字段/);
  assert.match(prompt, /terminal=false 且 children=\[\]：memory 必须为非空字符串/);
  assert.match(prompt, /任何节点不得超过 requestedLevels 层/);
  assert.match(prompt, /所有层合计不得超过 maxStoryNodes/);
  assert.match(prompt, /story 必须是以句末标点结束的完整句子/);
  assert.match(prompt, /不能写入兄弟分支的结果/);
  assert.match(prompt, /到达这一层只表示本批停止/);
  assert.doesNotMatch(prompt, /结构示例|"branches":\[\{/);
});

test('an invalid open leaf is repaired at the same level with a specific instruction', async t => {
  const seen = [];
  const url = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      seen.push(request);
      return modelResponse({ branches: [{
        title: '继续沟通', story: '双方继续交谈。', terminal: false,
        ...(seen.length === 1 ? {} : { memory: '已恢复交谈；后续安排仍待确定' }),
        children: [],
      }] });
    },
  }, t);
  const response = await fetch(`${url}/generate`, {
    method: 'POST', body: JSON.stringify({ frame, levels: 3 }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).branches[0].memory, '已恢复交谈；后续安排仍待确定');
  assert.equal(seen.length, 2);
  assert.equal(JSON.parse(seen[0].messages[1].content).requestedLevels, 3);
  assert.equal(JSON.parse(seen[1].messages[1].content).requestedLevels, 3);
  assert.match(seen[1].messages[0].content, /branches\[0\].*memory 必须记录当前状态/);
});

test('repeated invalid output reports the node path and missing field', async t => {
  const url = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only',
    fetchImpl: async () => modelResponse({ branches: [{
      title: '继续沟通', story: '双方继续交谈。', terminal: false, children: [],
    }] }),
  }, t);
  const response = await fetch(`${url}/generate`, {
    method: 'POST', body: JSON.stringify({ frame, levels: 1 }),
  });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /branches\[0\].*memory 必须记录当前状态/);
});

test('a JSON null reply is reported as a branch format error', async t => {
  const url = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only',
    fetchImpl: async () => modelResponse(null),
  }, t);
  const response = await fetch(`${url}/generate`, {
    method: 'POST', body: JSON.stringify({ frame, levels: 1 }),
  });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /branches 应为数组/);
});

test('a story cut off mid-sentence is regenerated before it is saved', async t => {
  const seen = [];
  const url = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      seen.push(request);
      return modelResponse({ branches: [{
        title: '恢复交谈',
        story: seen.length === 1 ? '对方愿意交流，但仍然' : '对方愿意交流，但分歧尚未解决。',
        terminal: false, memory: '已经恢复交谈；分歧仍未解决', children: [],
      }] });
    },
  }, t);
  const response = await fetch(`${url}/generate`, {
    method: 'POST', body: JSON.stringify({ frame, levels: 3 }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).branches[0].story, '对方愿意交流，但分歧尚未解决。');
  assert.equal(seen.length, 2);
  assert.equal(JSON.parse(seen[1].messages[1].content).requestedLevels, 3);
  assert.match(seen[1].messages[0].content, /branches\[0\].*story 必须以完整句子结束/);
});

test('a complete story without final punctuation is saved with a full stop', async t => {
  let calls = 0;
  const url = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only',
    fetchImpl: async () => {
      calls++;
      return modelResponse({ branches: [{
        title: '恢复交谈', story: '双方开始重新沟通', terminal: false,
        memory: '双方已恢复沟通；分歧能否解决仍待确定', children: [],
      }] });
    },
  }, t);
  const response = await fetch(`${url}/generate`, {
    method: 'POST', body: JSON.stringify({ frame, levels: 1 }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).branches[0].story, '双方开始重新沟通。');
  assert.equal(calls, 1);
});

test('invalid requests and rejected origins never reach the model', async t => {
  let calls = 0;
  const url = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only', allowedOrigin: 'http://localhost:8000',
    fetchImpl: async () => { calls++; throw new Error('unexpected'); },
  }, t);
  const preflight = await fetch(`${url}/prepare`, {
    method: 'OPTIONS', headers: { Origin: 'http://localhost:8000' },
  });
  assert.equal(preflight.status, 204);
  const rejected = await fetch(`${url}/prepare`, {
    method: 'POST', headers: { Origin: 'https://other.example' }, body: '{}',
  });
  assert.equal(rejected.status, 403);
  const invalidFrame = await fetch(`${url}/generate`, { method: 'POST', body: JSON.stringify({ frame: {} }) });
  assert.equal(invalidFrame.status, 400);
  const overLimit = await fetch(`${url}/generate`, {
    method: 'POST', body: JSON.stringify({ frame, depth: 9, levels: 2 }),
  });
  assert.equal(overLimit.status, 400);
  const overSelectedDepth = await fetch(`${url}/generate`, {
    method: 'POST', body: JSON.stringify({ frame, depth: 5, levels: 2, targetDepth: 6 }),
  });
  assert.equal(overSelectedDepth.status, 400);
  const invalidSelectedDepth = await fetch(`${url}/generate`, {
    method: 'POST', body: JSON.stringify({ frame, depth: 0, levels: 1, targetDepth: 16 }),
  });
  assert.equal(invalidSelectedDepth.status, 400);
  for (const [mode, targetDepth] of [['light', 9], ['normal', 13], ['deep', 16]]) {
    const response = await fetch(`${url}/generate`, {
      method: 'POST', body: JSON.stringify({ frame, mode, targetDepth, levels: 1 }),
    });
    assert.equal(response.status, 400);
  }
  const invalidMode = await fetch(`${url}/generate`, {
    method: 'POST', body: JSON.stringify({ frame, mode: 'unknown', targetDepth: 8, levels: 1 }),
  });
  assert.equal(invalidMode.status, 400);
  assert.equal(calls, 0);
});

test('each mode sends its depth and per-parent branching limit to the model', async t => {
  const seen = [];
  const url = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only',
    fetchImpl: async (_url, options) => {
      seen.push(JSON.parse(JSON.parse(options.body).messages[1].content));
      return modelResponse({ branches: [] });
    },
  }, t);
  for (const [mode, targetDepth, maxChildren] of [
    ['light', 8, 2], ['normal', 12, 3], ['deep', 15, 5],
  ]) {
    const response = await fetch(`${url}/generate`, {
      method: 'POST', body: JSON.stringify({ frame, mode, targetDepth, depth: targetDepth - 1, levels: 1 }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(seen.at(-1), {
      storyFrame: frame, branchState: '初始状态', currentEvent: null,
      currentDepth: targetDepth - 1, targetDepth, mode, maxChildren,
      maxStoryNodes: 96, legacyPath: [], requestedLevels: 1,
    });
  }
});

test('light mode repairs three siblings and still rejects an unresolved excess', async t => {
  const branch = index => ({ title: `方向${index}`, story: `形成方向${index}。`, terminal: true, children: [] });
  let calls = 0;
  const url = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only',
    fetchImpl: async (_url, options) => {
      calls++;
      const input = JSON.parse(JSON.parse(options.body).messages[1].content);
      if (calls === 2) assert.equal(input.previousBranches.length, 3);
      return modelResponse({ branches: [branch(1), branch(2), ...(calls === 1 ? [branch(3)] : [])] });
    },
  }, t);
  const body = JSON.stringify({ frame, mode: 'light', targetDepth: 8, levels: 1 });
  const repaired = await fetch(`${url}/generate`, { method: 'POST', body });
  assert.equal(repaired.status, 200);
  assert.equal((await repaired.json()).branches.length, 2);
  assert.equal(calls, 2);
  const rejected = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only',
    fetchImpl: async () => modelResponse({ branches: [branch(1), branch(2), branch(3)] }),
  }, t);
  const excess = await fetch(`${rejected}/generate`, { method: 'POST', body });
  assert.equal(excess.status, 502);
});

test('deep mode accepts five siblings but rejects six', async t => {
  const branch = index => ({ title: `方向${index}`, story: `形成方向${index}。`, terminal: true, children: [] });
  let count = 5;
  const url = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only',
    fetchImpl: async () => modelResponse({ branches: Array.from({ length: count }, (_, index) => branch(index + 1)) }),
  }, t);
  const body = JSON.stringify({ frame, mode: 'deep', targetDepth: 15, levels: 1 });
  const accepted = await fetch(`${url}/generate`, { method: 'POST', body });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).branches.length, 5);
  count = 6;
  const rejected = await fetch(`${url}/generate`, { method: 'POST', body });
  assert.equal(rejected.status, 502);
});

test('light mode also enforces the limit inside a generated subtree', async t => {
  let calls = 0;
  const child = index => ({ title: `后续${index}`, story: `形成后续${index}。`, terminal: true, children: [] });
  const url = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only',
    fetchImpl: async () => {
      calls++;
      return modelResponse({ branches: [{
        title: '开始沟通', story: '双方愿意交谈。', terminal: false,
        children: [child(1), child(2), ...(calls === 1 ? [child(3)] : [])],
      }] });
    },
  }, t);
  const response = await fetch(`${url}/generate`, {
    method: 'POST', body: JSON.stringify({ frame, mode: 'light', targetDepth: 8, levels: 2 }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).branches[0].children.length, 2);
  assert.equal(calls, 2);
});

test('an empty continuation naturally ends the current branch', async t => {
  const url = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only',
    fetchImpl: async () => modelResponse({ branches: [] }),
  }, t);
  const response = await fetch(`${url}/generate`, {
    method: 'POST', body: JSON.stringify({ frame, levels: 4 }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).branches, []);
});

test('different paths with the same ending both remain in the tree', async t => {
  const url = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only',
    fetchImpl: async () => modelResponse({ branches: [
      { title: '直接道歉', story: '两人谈过后决定各自向前。', terminal: true, children: [] },
      { title: '先冷静再道歉', story: '经过一段时间的沟通，两人也决定各自向前。', terminal: true, children: [] },
    ] }),
  }, t);
  const response = await fetch(`${url}/generate`, {
    method: 'POST', body: JSON.stringify({ frame, levels: 1 }),
  });
  assert.equal(response.status, 200);
  const { branches } = await response.json();
  assert.deepEqual(branches.map(branch => branch.title), ['直接道歉', '先冷静再道歉']);
  assert.equal(branches.every(branch => branch.terminal), true);
});

test('a mixed terminal outcome is revised before reaching the story tree', async t => {
  let calls = 0;
  const url = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only',
    fetchImpl: async (_url, options) => {
      calls++;
      const input = JSON.parse(JSON.parse(options.body).messages[1].content);
      if (calls === 2) assert.equal(input.previousBranches[0].title, '妥协或僵持');
      return modelResponse({ branches: calls === 1
        ? [{ title: '妥协或僵持', story: '双方可能和解或彻底分开。', terminal: true, children: [] }]
        : [{ title: '暂未达成一致', story: '双方仍需时间理解彼此的想法。', terminal: true, children: [] }] });
    },
  }, t);
  const response = await fetch(`${url}/generate`, { method: 'POST', body: JSON.stringify({ frame, depth: 0, levels: 1 }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).branches[0].title, '暂未达成一致');
  assert.equal(calls, 2);
});

test('equivalent causes joined by 或 are accepted as one shared outcome', async t => {
  let calls = 0;
  const url = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only',
    fetchImpl: async () => {
      calls++;
      return modelResponse({ branches: [
        { title: '联系未建立', story: '对方未回复或拒绝沟通，道歉没有开启新的对话。', terminal: true, children: [] },
      ] });
    },
  }, t);
  const response = await fetch(`${url}/generate`, { method: 'POST', body: JSON.stringify({ frame, levels: 1 }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).branches[0].title, '联系未建立');
  assert.equal(calls, 1);
});

test('a repeatedly mixed outcome becomes a resumable open branch instead of aborting', async t => {
  let calls = 0;
  const mixed = { branches: [
    { title: '复合或分开', story: '双方可能复合，也可能彻底分开。', terminal: true, children: [] },
  ] };
  const url = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only',
    fetchImpl: async () => { calls++; return modelResponse(mixed); },
  }, t);
  const response = await fetch(`${url}/generate`, { method: 'POST', body: JSON.stringify({ frame, levels: 1 }) });
  assert.equal(response.status, 200);
  const branch = (await response.json()).branches[0];
  assert.equal(branch.title, '走向仍待明确');
  assert.equal(branch.terminal, false);
  assert.match(branch.memory, /仍需/);
  assert.equal(calls, 2);
});

test('timed-out multi-level generation retries the same branch at one level', async t => {
  const requestedLevels = [];
  const url = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only',
    fetchImpl: async (_url, options) => {
      const input = JSON.parse(JSON.parse(options.body).messages[1].content);
      requestedLevels.push(input.requestedLevels);
      assert.equal(input.branchState, '已经离家；在车站遇见旧识');
      if (requestedLevels.length === 1) {
        const error = new Error('timed out');
        error.name = 'TimeoutError';
        throw error;
      }
      return modelResponse({ branches: [
        { title: '暂时落脚', story: '旧识提供了短暂的住处。', terminal: false,
          memory: '已经离家；在车站遇见旧识；暂时有住处，后续尚未决定', children: [] },
      ] });
    },
  }, t);
  const response = await fetch(`${url}/generate`, {
    method: 'POST', body: JSON.stringify({ frame, branchState: '已经离家；在车站遇见旧识', levels: 3, depth: 5, targetDepth: 12 }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(requestedLevels, [3, 1]);
  assert.equal((await response.json()).branches[0].title, '暂时落脚');
});

test('rate limiting is reported without an automatic retry', async t => {
  let calls = 0;
  const url = await startServer({
    defaultModel: 'stored-model', storedApiKey: 'test-only',
    fetchImpl: async () => { calls++; return new Response('', { status: 429 }); },
  }, t);
  const response = await fetch(`${url}/generate`, {
    method: 'POST', body: JSON.stringify({ frame, levels: 3 }),
  });
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /请求过于频繁/);
  assert.equal(calls, 1);
});

test('model JSON wrapped in explanation and a code fence is accepted', async t => {
  let calls = 0;
  const url = await startServer({
    defaultModel: 'qwen3.8-flash', storedApiKey: 'test-only',
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [{ message: {
        content: `以下是结果：\n\`\`\`json\n${JSON.stringify({ branches: [] })}\n\`\`\``,
      }, finish_reason: 'stop' }] }), { status: 200 });
    },
  }, t);
  const response = await fetch(`${url}/generate`, {
    method: 'POST', body: JSON.stringify({ frame, levels: 1 }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).branches, []);
  assert.equal(calls, 1);
});

test('malformed model JSON is retried once with a stricter format instruction', async t => {
  let calls = 0;
  let secondPrompt = '';
  const url = await startServer({
    defaultModel: 'qwen3.8-flash', storedApiKey: 'test-only',
    fetchImpl: async (_url, options) => {
      calls++;
      secondPrompt = JSON.parse(options.body).messages[0].content;
      return calls === 1
        ? new Response(JSON.stringify({ choices: [{ message: { content: '{"branches":[' }, finish_reason: 'length' }] }), { status: 200 })
        : modelResponse({ branches: [] });
    },
  }, t);
  const response = await fetch(`${url}/generate`, {
    method: 'POST', body: JSON.stringify({ frame, levels: 1 }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).branches, []);
  assert.equal(calls, 2);
  assert.match(secondPrompt, /完整、可解析的 JSON/);
});

test('convergence uses phase-specific prompts, schema and larger model budgets', async t => {
  const seen = [];
  const url = await startServer({
    defaultModel: 'qwen3.8-flash', storedApiKey: 'test-only',
    fetchImpl: async (_url, options) => {
      seen.push(JSON.parse(options.body));
      return modelResponse({ branches: [] });
    },
  }, t);
  for (const [mode, targetDepth, depth, levels, children] of [
    ['light', 8, 6, 2, 2], ['normal', 12, 8, 4, 3], ['deep', 15, 10, 5, 5],
  ]) {
    const response = await fetch(`${url}/generate`, { method: 'POST', body: JSON.stringify({
      frame, mode, targetDepth, depth, levels,
    }) });
    assert.equal(response.status, 200);
    const request = seen.at(-1);
    const input = JSON.parse(request.messages[1].content);
    assert.equal(input.maxStoryNodes, 96);
    assert.equal(input.maxChildren, children);
    assert.equal(input.requestedLevels, levels);
    assert.match(request.messages[0].content, /【收敛阶段】/);
    assert.match(request.messages[0].content, new RegExp(`【本批边界】本次最多生成 ${levels} 层`));
    assert.doesNotMatch(request.messages[0].content, /结构示例/);
    assert.equal(request.response_format.type, 'json_schema');
    assert.equal(request.response_format.json_schema.strict, true);
    assert.deepEqual(request.response_format.json_schema.schema.required, ['branches']);
    assert.deepEqual(request.response_format.json_schema.schema.properties.branches.items.required,
      ['title', 'story', 'terminal', 'memory', 'children']);
    assert.equal(request.max_completion_tokens, 32768);
  }
  const one = await fetch(`${url}/generate`, { method: 'POST', body: JSON.stringify({
    frame, mode: 'normal', targetDepth: 12, depth: 11, levels: 1,
  }) });
  assert.equal(one.status, 200);
  assert.match(seen.at(-1).messages[0].content, /【本批边界】本次最多生成 1 层/);
  assert.doesNotMatch(seen.at(-1).messages[0].content, /结构示例/);
  assert.equal(seen.at(-1).response_format.json_schema.schema.properties.branches.items.properties.children.maxItems, 0);
});

test('exploration cannot cross the phase boundary', async t => {
  let calls = 0;
  let prompt;
  const url = await startServer({
    defaultModel: 'mock-model', storedApiKey: 'test-only',
    fetchImpl: async (_url, options) => {
      calls++;
      prompt = JSON.parse(options.body).messages[0].content;
      return modelResponse({ branches: [] });
    },
  }, t);
  const invalid = await fetch(`${url}/generate`, { method: 'POST', body: JSON.stringify({
    frame, mode: 'normal', targetDepth: 12, depth: 7, levels: 2,
  }) });
  assert.equal(invalid.status, 400);
  assert.equal(calls, 0);
  const valid = await fetch(`${url}/generate`, { method: 'POST', body: JSON.stringify({
    frame, mode: 'normal', targetDepth: 12, depth: 7, levels: 1,
  }) });
  assert.equal(valid.status, 200);
  assert.equal(calls, 1);
  assert.match(prompt, /【探索阶段】/);
  assert.match(prompt, /【本批边界】本次最多生成 1 层/);
  assert.doesNotMatch(prompt, /结构示例/);
});

test('late generation falls back from full remainder to two and one levels', async t => {
  const levelsSeen = [];
  const url = await startServer({
    defaultModel: 'mock-model', storedApiKey: 'test-only',
    fetchImpl: async (_url, options) => {
      const levels = JSON.parse(JSON.parse(options.body).messages[1].content).requestedLevels;
      levelsSeen.push(levels);
      if (levels === 4) {
        const error = new Error('timed out');
        error.name = 'TimeoutError';
        throw error;
      }
      if (levels === 2) return modelResponse({ branches: null });
      return modelResponse({ branches: [{ title: '关系仍待明确', story: '双方尚未决定如何继续相处。',
        terminal: false, memory: '双方仍有分歧；后续相处方式待定', children: [] }] });
    },
  }, t);
  const response = await fetch(`${url}/generate`, { method: 'POST', body: JSON.stringify({
    frame, mode: 'normal', targetDepth: 12, depth: 8, levels: 4,
  }) });
  assert.equal(response.status, 200);
  assert.deepEqual(levelsSeen, [4, 2, 2, 1]);
  assert.equal((await response.json()).branches[0].terminal, false);
});

test('truncated late JSON skips another full-size request and retries two levels', async t => {
  const levelsSeen = [];
  const url = await startServer({
    defaultModel: 'qwen3.8-flash', storedApiKey: 'test-only',
    fetchImpl: async (_url, options) => {
      const levels = JSON.parse(JSON.parse(options.body).messages[1].content).requestedLevels;
      levelsSeen.push(levels);
      if (levels === 4) return new Response(JSON.stringify({
        choices: [{ message: { content: '{"branches":[' }, finish_reason: 'length' }],
      }), { status: 200 });
      return modelResponse({ branches: [{ title: '继续磨合', story: '双方开始调整沟通方式。',
        terminal: false, memory: '已开始调整沟通；能否稳定仍待确定', children: [] }] });
    },
  }, t);
  const response = await fetch(`${url}/generate`, { method: 'POST', body: JSON.stringify({
    frame, mode: 'normal', targetDepth: 12, depth: 8, levels: 4,
  }) });
  assert.equal(response.status, 200);
  assert.deepEqual(levelsSeen, [4, 2]);
});

test('late subtree over 96 nodes is rejected before a smaller batch is saved', async t => {
  function largeTree() {
    let remaining = 97;
    function make(depth) {
      if (!remaining) return null;
      remaining--;
      const children = depth < 4 ? Array.from({ length: 3 }, () => make(depth + 1)).filter(Boolean) : [];
      return { title: '普通变化', story: '双方的相处状态发生变化。', terminal: !children.length,
        memory: '', children };
    }
    return { branches: Array.from({ length: 3 }, () => make(1)).filter(Boolean) };
  }
  const levelsSeen = [];
  const url = await startServer({
    defaultModel: 'mock-model', storedApiKey: 'test-only',
    fetchImpl: async (_url, options) => {
      const levels = JSON.parse(JSON.parse(options.body).messages[1].content).requestedLevels;
      levelsSeen.push(levels);
      return levels === 4 ? modelResponse(largeTree()) : modelResponse({ branches: [{
        title: '暂时稳定', story: '双方形成了暂时稳定的相处方式。', terminal: true, memory: '', children: [],
      }] });
    },
  }, t);
  const response = await fetch(`${url}/generate`, { method: 'POST', body: JSON.stringify({
    frame, mode: 'normal', targetDepth: 12, depth: 8, levels: 4,
  }) });
  assert.equal(response.status, 200);
  assert.deepEqual(levelsSeen, [4, 4, 2]);
  assert.equal((await response.json()).branches.length, 1);
});
