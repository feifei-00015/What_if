import { createServer } from '../backend/server.mjs';

const port = Number(process.env.DEMO_PORT || 8000);
const app = createServer({
  baseUrl: 'https://mock.example/v1',
  defaultModel: 'mock-model',
  storedApiKey: 'demo-only',
  allowedOrigin: `http://localhost:${port}`,
  serveWeb: true,
  fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    const input = JSON.parse(request.messages[1].content);
    if (request.messages[0].content.includes('故事资料整理员')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        premise: input.scenario,
        facts: ['两人已经分开'],
        timeline: ['分手之后尚未认真谈过'],
        motives: ['用户希望表达歉意'],
        unknowns: ['对方是否愿意重新沟通'],
      }) } }] }), { status: 200 });
    }
    const branches = input.branchState === '初始状态' ? [
      { title: '好好告别', story: '这次道歉让双方放下了未说出口的话。', terminal: true, children: [] },
      { title: '重新联系', story: '对方愿意听你说完。', terminal: false, children: [
        { title: '谨慎交谈', story: '你们谈起当年的分歧。', terminal: false, children: [
          { title: '重新理解', story: '双方逐渐理解彼此的处境。', terminal: false, children: [
            { title: '仍需时间', story: '你们没有急着决定关系。', terminal: false,
              memory: '道歉已被听见；双方理解分歧，但尚未决定是否重新交往', children: [] },
          ] },
        ] },
      ] },
    ] : input.stage === 2 ? [
      { title: '讨论相处方式', story: '双方开始讨论如何避免过去的沟通误会。', terminal: false, children: [
        { title: '尝试调整边界', story: '双方同意保留各自的空间，再观察相处是否舒服。', terminal: false, children: [
          { title: '调整有待验证', story: '新的安排已经开始实行，但双方还需要时间确认是否适合。', terminal: false,
            memory: '已接受道歉并约定相处边界；新的安排尚待验证', children: [] },
        ] },
      ] },
    ] : [
      { title: '各自向前', story: '经历这段对话后，彼此都能更平静地继续生活。', terminal: true, children: [] },
    ];
    function clip(nodes, depth = 1) {
      for (const node of nodes) {
        node.memory ||= '';
        if (depth >= input.requestedLevels && node.children.length) {
          node.children = [];
          node.memory = '道歉已被听见；双方仍在沟通，关系尚未确定';
        }
        clip(node.children, depth + 1);
      }
    }
    clip(branches);
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ branches }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  },
});
app.listen(port, '127.0.0.1', () => console.log(`Demo at http://localhost:${port}`));
