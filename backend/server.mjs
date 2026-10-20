import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fetch as modelFetch } from 'undici';
import { FORMAT_REPAIR_PROMPT, REPAIR_PROMPT, STRUCTURE_PROMPT, generationPrompt, subtreePrompt, ROUTE_SELECTION_PROMPT } from './prompt.mjs';
import { createTrialStore, TrialError } from './trial-store.mjs';
import { createTablestoreState } from './tablestore-state.mjs';
import { assertPublicModelUrl, modelDispatcher } from './model-network.mjs';
import { convergenceDepth, generationPhase, SUBTREE_MODES, isSubtreeStrategy, subtreeTask } from '../web/generation-flow.mjs';

const MAX_BODY_BYTES = 128 * 1024;
const MODES = {
  light: { depth: 8, children: 2, nodes: 24 },
  normal: { depth: 12, children: 3, nodes: 24 },
  deep: { depth: 15, children: 5, nodes: 32 },
};
const CONVERGENCE_NODES = 96;

function branchResponseSchema(levels, maxChildren) {
  function node(remaining) {
    return {
      type: 'object', additionalProperties: false,
      properties: {
        title: { type: 'string' }, story: { type: 'string' }, terminal: { type: 'boolean' },
        memory: { type: 'string' },
        children: { type: 'array', maxItems: remaining > 1 ? maxChildren : 0,
          items: remaining > 1 ? node(remaining - 1)
            : { type: 'object', properties: {}, required: [], additionalProperties: false } },
      },
      required: ['title', 'story', 'terminal', 'memory', 'children'],
    };
  }
  return {
    type: 'object', additionalProperties: false,
    properties: { branches: { type: 'array', maxItems: maxChildren, items: node(levels) } },
    required: ['branches'],
  };
}

function normalizeFrame(frame) {
  if (!frame || typeof frame.premise !== 'string' || !frame.premise.trim() || frame.premise.length > 2000) {
    throw new Error('故事脉络格式不正确');
  }
  function list(value) {
    if (!Array.isArray(value) || value.length > 12 ||
        value.some(item => typeof item !== 'string' || !item.trim() || item.length > 180)) {
      throw new Error('故事脉络格式不正确');
    }
    return value;
  }
  return {
    premise: frame.premise.trim(), facts: list(frame.facts), timeline: list(frame.timeline),
    motives: list(frame.motives), unknowns: list(frame.unknowns),
  };
}

function normalizeBranches(branches, levels, limits) {
  let count = 0;
  let leaves = 0;
  function invalid(path, reason) {
    throw new Error(`模型返回的分支格式不正确：${path} ${reason}`);
  }
  function normalize(list, depth, path = 'branches') {
    if (!Array.isArray(list)) invalid(path, '应为数组');
    if (list.length > limits.children) throw new Error(`模型返回的子分支超过 ${limits.children} 个上限`);
    return list.map((branch, index) => {
      count++;
      const here = `${path}[${index}]`;
      if (count > limits.nodes) invalid(here, `超过本批 ${limits.nodes} 个节点上限`);
      if (depth > levels) invalid(here, `超过本批 ${levels} 层上限`);
      if (!branch || typeof branch !== 'object' || Array.isArray(branch)) invalid(here, '应为对象');
      if (typeof branch.title !== 'string' || !branch.title.trim()) invalid(here, 'title 必须是非空文字');
      if (typeof branch.story !== 'string' || !branch.story.trim()) invalid(here, 'story 必须是非空文字');
      let story = branch.story.trim();
      if (!/[。！？.!?][”’」）)]?$/.test(story)) {
        if (story.length < 8 || /[，,；;：:、…]$|(?:但|却|将|把|对|向|从|在|和|与|为|的|地|得|仍然|正在|这种|这个|这些|因为|所以|如果|如何|是否|可能|需要|认为|决定|开始|继续|逐渐|尚未)$/.test(story)) {
          invalid(here, 'story 必须以完整句子结束，不能停在半句话');
        }
        story += '。';
      }
      if (typeof branch.terminal !== 'boolean') invalid(here, 'terminal 必须是 true 或 false');
      if (!Array.isArray(branch.children)) invalid(here, 'children 必须是数组');
      if (branch.memory !== undefined && (typeof branch.memory !== 'string' || branch.memory.length > 300)) {
        invalid(here, 'memory 必须是不超过 300 字的文字');
      }
      if (!branch.terminal && branch.children.length === 0 && !branch.memory?.trim()) {
        invalid(here, '未结束且没有子节点，memory 必须记录当前状态');
      }
      if (!branch.children.length && ++leaves > (limits.leaves ?? Infinity)) {
        invalid(here, `超过本次子树 ${limits.leaves} 条叶端路径上限`);
      }
      if (limits.strict && (Object.keys(branch).some(key => !['title', 'story', 'terminal', 'memory', 'children'].includes(key)) ||
          typeof branch.memory !== 'string' || (branch.terminal && branch.memory !== ''))) {
        invalid(here, '必须遵守五字段契约，结束节点 memory 必须为空');
      }
      if (branch.terminal && branch.children.length) invalid(here, '已结束节点的 children 必须为空');
      return {
        title: branch.title, story, terminal: branch.terminal,
        memory: branch.memory || '',
        children: normalize(branch.children, depth + 1, `${here}.children`),
      };
    });
  }
  return normalize(branches, 1);
}

// Select complete existing routes, never truncate an intermediate node into a new ending.
function leafRoutes(branches, prefix = '', ancestors = []) {
  return branches.flatMap((node, index) => {
    const id = prefix ? `${prefix}.${index}` : `${index}`;
    const events = [...ancestors, { title: node.title, story: node.story }];
    return node.children.length ? leafRoutes(node.children, id, events)
      : [{ id, events, terminal: node.terminal, memory: node.memory }];
  });
}

function retainRoutes(branches, selection, count, routes, requiredGroups) {
  const paths = selection?.keepLeafPaths;
  const allowed = new Set(routes.map(route => route.id));
  if (!selection || Object.keys(selection).length !== 1 || !Array.isArray(paths) ||
      paths.length !== count || new Set(paths).size !== count || paths.some(path => !allowed.has(path)) ||
      requiredGroups.some(group => !paths.some(path => path.split('.')[0] === group))) {
    throw new Error('模型返回的路线筛选不正确，未保存超额子树；请继续当前任务');
  }
  const selected = new Set(paths);
  function keep(nodes, prefix = '') {
    return nodes.flatMap((node, index) => {
      const id = prefix ? `${prefix}.${index}` : `${index}`;
      if (!node.children.length) return selected.has(id) ? [node] : [];
      const children = keep(node.children, id);
      return children.length ? [{ ...node, children }] : [];
    });
  }
  return keep(branches);
}

function exceedsBranchLimit(branches, limit) {
  return Array.isArray(branches) && (branches.length > limit ||
    branches.some(branch => exceedsBranchLimit(branch?.children, limit)));
}

function hasMixedOutcome(branches) {
  const opposites = /(和解|复合|改善|接受|妥协).{0,12}(或|还是|也可能).{0,12}(分开|决裂|恶化|拒绝|僵持)|(分开|决裂|恶化|拒绝|僵持).{0,12}(或|还是|也可能).{0,12}(和解|复合|改善|接受|妥协)/;
  return branches.some(branch => opposites.test(branch.title) ||
    (branch.terminal && (opposites.test(branch.story) || /若[^。；]+(?:则|就)[^。；]+[；。][^。；]*若[^。；]+(?:则|就)/.test(branch.story))) ||
    hasMixedOutcome(branch.children));
}

function deferMixedOutcomes(branches) {
  return branches.map(branch => {
    if (branch.terminal && hasMixedOutcome([branch])) return {
      title: '走向仍待明确',
      story: '现有信息还不足以判断这条分支会形成哪一种稳定状态，关键回应仍待发生。',
      terminal: false,
      memory: branch.memory || '当前出现多个可能结果；仍需根据下一次关键回应分别展开',
      children: [],
    };
    return { ...branch, children: deferMixedOutcomes(branch.children) };
  });
}

class ModelResponseError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ModelResponseError';
    this.code = code;
  }
}

function parseModelJson(raw, finishReason) {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ModelResponseError('模型没有返回可用文本', 'empty_response');
  }
  const cleaned = raw
    .replace(/^\uFEFF/, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
  const candidates = [cleaned];
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  if (finishReason === 'length') {
    throw new ModelResponseError('模型回复过长并被截断', 'truncated_response');
  }
  throw new ModelResponseError('模型回复不是完整 JSON，已自动重试仍未恢复', 'invalid_json');
}

async function requestModel({ fetchImpl, baseUrl, apiKey, model, prompt, input, temperature, beforeRequest,
  responseSchema, maxOutputTokens = 8192, timeoutMs = 90000, retryTruncated = true, retryJson = true }) {
  const endpoint = new URL('chat/completions', `${baseUrl.href.replace(/\/+$/, '')}/`);
  for (let formatAttempt = 0; formatAttempt < 2; formatAttempt++) {
    if (beforeRequest) await beforeRequest();
    const upstream = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      dispatcher: modelDispatcher,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: prompt + (formatAttempt
            ? '\n\n上一次回复不是完整的 JSON。本次必须只返回一个完整、可解析的 JSON 对象，不要添加说明、思考过程或 Markdown。'
            : '') },
          { role: 'user', content: JSON.stringify(input) },
        ],
        temperature,
        ...(model === 'qwen3.8-flash' ? {
          reasoning_effort: 'medium',
          response_format: responseSchema
            ? { type: 'json_schema', json_schema: { name: 'what_if_branches', strict: true, schema: responseSchema } }
            : { type: 'json_object' },
          ...(responseSchema ? { max_completion_tokens: maxOutputTokens } : { max_tokens: maxOutputTokens }),
        } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!upstream.ok) {
      const status = upstream.status;
      throw new Error(status === 401 || status === 403 ? '模型接口拒绝了密钥或访问权限'
        : status === 429 ? '模型接口请求过于频繁或额度不足'
          : status >= 500 ? `模型服务暂时不可用（HTTP ${status}）` : `模型接口返回 HTTP ${status}`);
    }
    try {
      let result;
      try {
        result = JSON.parse(await upstream.text());
      } catch {
        throw new ModelResponseError('模型接口返回了无法识别的数据', 'invalid_envelope');
      }
      const choice = result?.choices?.[0];
      if (choice?.finish_reason === 'length') {
        throw new ModelResponseError('模型回复过长并被截断', 'truncated_response');
      }
      return parseModelJson(choice?.message?.content, choice?.finish_reason);
    } catch (error) {
      if (error instanceof ModelResponseError && (error.code !== 'truncated_response' || retryTruncated) &&
          formatAttempt === 0 && retryJson) continue;
      throw error;
    }
  }
}

function send(res, status, data, origin) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
  });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw new Error('请求内容过长');
    }
  }
  return JSON.parse(body);
}

export function createServer({
  baseUrl = process.env.AI_BASE_URL,
  defaultModel = process.env.AI_MODEL,
  storedApiKey = process.env.AI_API_KEY,
  allowedOrigin = process.env.ALLOWED_ORIGIN || 'http://localhost:8000',
  fetchImpl = modelFetch,
  serveWeb = false,
  trialStore,
} = {}) {
  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const corsOrigin = origin === allowedOrigin ? origin : undefined;
    if (serveWeb && req.method === 'GET' && ['/', '/test-page.mjs', '/api-config.mjs', '/generation-flow.mjs', '/map-layout.mjs', '/lake.css', '/visual/water-surface.mjs', '/visual/light-beams.mjs', '/visual/water-surface.css', '/visual/light-beams.css', '/visual/node-ripples.css', '/visual/memory-star-ui.css', '/assets/lake-horizon.jpg', '/assets/lake-overhead.jpg', '/assets/lake-overhead-8k.jpg', '/assets/memory-star-map-8k.jpg', '/assets/paper-ball.svg', '/assets/what-if-logo.svg'].includes(req.url)) {
      const path = req.url === '/' ? '../web/index.html' : `../web${req.url}`;
      const body = await readFile(new URL(path, import.meta.url));
      res.writeHead(200, {
        'Content-Type': req.url === '/' ? 'text/html; charset=utf-8'
          : req.url.endsWith('.css') ? 'text/css; charset=utf-8'
            : req.url.endsWith('.jpg') ? 'image/jpeg'
              : req.url.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(body);
    }
    if (req.url === '/config' && req.method === 'GET') {
      if (origin && !corsOrigin) return send(res, 403, { error: '来源不允许' });
      return send(res, 200, { model: defaultModel || '', ready: !!(baseUrl && defaultModel && storedApiKey), trial: !!trialStore }, corsOrigin);
    }
    if (req.method === 'OPTIONS') {
      if ((!['/prepare', '/generate'].includes(req.url) && !req.url?.startsWith('/trial/')) || !corsOrigin) {
        return send(res, 403, { error: '来源不允许' });
      }
      res.writeHead(204, {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Api-Key',
        Vary: 'Origin',
      });
      return res.end();
    }
    if (req.url === '/health' && req.method === 'GET') {
      return send(res, 200, { ok: true });
    }
    if (trialStore && req.url?.startsWith('/trial/')) {
      if (origin && !corsOrigin) return send(res, 403, { error: '来源不允许' });
      try {
        const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
        const parts = req.url.split('/');
        if (req.url === '/trial/guest' && req.method === 'POST') {
          const body = await readBody(req);
          return send(res, 200, await trialStore.guest(body?.token), corsOrigin);
        }
        if (req.url === '/trial/status' && req.method === 'GET') {
          return send(res, 200, await trialStore.status(token), corsOrigin);
        }
        if (req.url === '/trial/stories' && req.method === 'POST') {
          const body = await readBody(req);
          return send(res, 201, { story: await trialStore.createStory(token, body || {}) }, corsOrigin);
        }
        if (parts.length === 4 && parts[2] === 'stories' && req.method === 'GET') {
          return send(res, 200, { story: await trialStore.getStory(token, parts[3]) }, corsOrigin);
        }
        if (parts.length === 5 && parts[2] === 'stories' && parts[4] === 'abandon' && req.method === 'POST') {
          return send(res, 200, await trialStore.abandon(token, parts[3]), corsOrigin);
        }
        return send(res, 404, { error: '接口不存在' }, corsOrigin);
      } catch (error) {
        return send(res, error instanceof TrialError ? error.status : error instanceof SyntaxError ? 400 : 503,
          { error: error instanceof TrialError ? error.message
            : error instanceof SyntaxError ? '请输入有效的 JSON' : '服务暂时不可用，请稍后重试' }, corsOrigin);
      }
    }
    if (!['/prepare', '/generate'].includes(req.url) || req.method !== 'POST') {
      return send(res, 404, { error: '接口不存在' }, corsOrigin);
    }
    if (origin && !corsOrigin) return send(res, 403, { error: '来源不允许' });
    let input;
    try {
      input = await readBody(req);
    } catch {
      return send(res, 400, { error: '请输入有效的 JSON，且内容不超过 128 KB' }, corsOrigin);
    }
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const trialRequest = trialStore ? input : null;
    let claim;
    const { apiKey, model } = input || {};
    let effectiveApiKey = trialStore ? storedApiKey : storedApiKey || apiKey;
    let effectiveModel = trialStore ? defaultModel : defaultModel || model;
    let effectiveBaseUrl = baseUrl;
    let parsedBaseUrl;
    if (trialStore) {
      try {
        if (typeof input?.storyId !== 'string') throw new TrialError(400, '缺少故事编号');
        claim = req.url === '/prepare'
          ? await trialStore.claimPrepare(token, input.storyId)
          : await trialStore.claimExpand(token, input.storyId, input.branchId, input.levels);
        if (claim.existing) return send(res, 200,
          req.url === '/prepare' ? { frame: claim.existing } : { branches: claim.existing }, corsOrigin);
        if (claim.funding === 'own') {
          effectiveApiKey = req.headers['x-user-api-key'];
          if (input.modelConfig !== undefined) {
            effectiveBaseUrl = input.modelConfig?.baseUrl;
            effectiveModel = input.modelConfig?.model;
          }
        }
        if (typeof effectiveApiKey !== 'string' || !effectiveApiKey.trim() || effectiveApiKey.length > 2048) {
          if (req.url === '/prepare') await trialStore.releasePrepare(token, input.storyId, claim.claim);
          else await trialStore.releaseExpand(token, input.storyId, input.branchId, claim.claim);
          throw new TrialError(400, claim.funding === 'own' ? '请先配置有效的个人 API Key' : '本机模型尚未配置');
        }
        if (req.url === '/prepare') {
          input = { scenario: input.scenario, context: input.context };
        } else {
          const { frame, branchState, currentEvent, legacyPath } = input;
          input = { frame, branchState, currentEvent, legacyPath, ...claim.input };
        }
      } catch (error) {
        return send(res, error instanceof TrialError ? error.status : 503,
          { error: error instanceof TrialError ? error.message : '服务暂时不可用，请稍后重试' }, corsOrigin);
      }
    }

    try {
      try {
        if (typeof effectiveBaseUrl !== 'string' || effectiveBaseUrl.length > 2048) throw new Error();
        parsedBaseUrl = new URL(effectiveBaseUrl);
        if (parsedBaseUrl.protocol !== 'https:' || parsedBaseUrl.username || parsedBaseUrl.password ||
            parsedBaseUrl.search || parsedBaseUrl.hash || /\/chat\/completions\/?$/.test(parsedBaseUrl.pathname)) throw new Error();
        assertPublicModelUrl(parsedBaseUrl);
      } catch {
        throw new TrialError(400, '请输入有效的 HTTPS 模型接口根地址，不含 /chat/completions、账号密码或查询参数');
      }
      if (typeof effectiveModel !== 'string' || !effectiveModel.trim() || effectiveModel.length > 200 ||
          typeof effectiveApiKey !== 'string' || !effectiveApiKey.trim()) {
        throw new TrialError(400, claim?.funding === 'own' ? '请先配置有效的模型名称和 API Key' : '本机模型尚未配置');
      }
      if (req.url === '/prepare') {
        const { scenario, context = '' } = input || {};
        if (typeof scenario !== 'string' || !scenario.trim() || scenario.length > 2000 ||
            typeof context !== 'string' || context.length > 12000) {
          return send(res, 400, { error: '请填写假设；背景故事不能超过 12000 字' }, corsOrigin);
        }
        if (!context.trim() && scenario.length < 120) {
          const frame = {
            premise: scenario.trim(), facts: [], timeline: [], motives: [], unknowns: [],
          };
          if (trialStore) await trialStore.finishPrepare(token, trialRequest.storyId, claim.claim, frame);
          return send(res, 200, { frame }, corsOrigin);
        }
        let frame;
        let repairMessage = '';
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const parsed = await requestModel({
              fetchImpl, baseUrl: parsedBaseUrl, apiKey: effectiveApiKey, model: effectiveModel,
              prompt: STRUCTURE_PROMPT + (repairMessage ? `\n\n上一次回复格式不正确：${repairMessage}。请重新返回完整 JSON 对象。` : ''),
              input: { scenario, narrative: context }, temperature: 0.1, retryJson: false,
              beforeRequest: trialStore ? () => trialStore.consumeModelCall(token, trialRequest.storyId,
                undefined, claim.claim) : undefined,
            });
            frame = normalizeFrame({ ...parsed, premise: scenario.trim() });
            break;
          } catch (error) {
            if (attempt || !(error instanceof ModelResponseError || error.message === '故事脉络格式不正确')) throw error;
            repairMessage = error.message;
          }
        }
        if (trialStore) await trialStore.finishPrepare(token, trialRequest.storyId, claim.claim, frame);
        return send(res, 200, { frame }, corsOrigin);
      }

      const { frame, branchState = '', currentEvent = null, legacyPath = [], levels = 1, depth = 0, mode = 'normal' } = input || {};
      const staged = isSubtreeStrategy(input?.generationStrategy);
      const task = staged ? subtreeTask(mode, input.stage, input.generationStrategy) : null;
      const limits = Object.hasOwn(MODES, mode) ? MODES[mode] : null;
      const targetDepth = input?.targetDepth ?? (input?.mode ? limits?.depth : 10);
      let storyFrame;
      try {
        storyFrame = normalizeFrame(frame);
      } catch {
        return send(res, 400, { error: '故事脉络格式不正确，请重新整理' }, corsOrigin);
      }
      const phase = Number.isInteger(depth) && Number.isInteger(targetDepth) && targetDepth >= 2
        ? generationPhase(depth, targetDepth) : null;
      const phaseEnd = phase === 'explore' ? convergenceDepth(targetDepth) : targetDepth;
      const maxLevels = task ? task.levels : phase === 'explore' ? Math.min(4, phaseEnd - depth) : Math.min(5, targetDepth - depth);
      if ((input?.generationStrategy !== undefined && !staged) ||
          (staged && (!Number.isInteger(input.stage) || !task || levels !== task.levels || targetDepth !== SUBTREE_MODES[mode]?.depth ||
            (input.stage === 1 && depth !== 0) || (input.stage > 1 && depth < input.stage - 1))) ||
          typeof branchState !== 'string' || branchState.length > 300 ||
          !limits ||
          !Number.isInteger(levels) || levels < 1 || levels > maxLevels ||
          !Number.isInteger(targetDepth) || targetDepth < 2 || targetDepth > limits.depth ||
          !Number.isInteger(depth) || depth < 0 || depth + levels > targetDepth ||
          !Array.isArray(legacyPath) || legacyPath.length > 15 ||
          legacyPath.some(node => !node || typeof node.title !== 'string' ||
            typeof node.story !== 'string' || typeof node.assumption !== 'string') ||
          (currentEvent !== null && (!currentEvent || typeof currentEvent.title !== 'string' ||
            typeof currentEvent.story !== 'string'))) {
        return send(res, 400, { error: '请填写有效的分支状态；推演不能跨越阶段分界或超过当前模式深度' }, corsOrigin);
      }
      const batchLimits = task
        ? { ...limits, nodes: task.maxNodes, leaves: task.maxLeaves, strict: true }
        : { ...limits, nodes: phase === 'converge' ? CONVERGENCE_NODES : limits.nodes };
      const levelAttempts = staged ? [levels] : [...new Set(phase === 'converge'
        ? [levels, Math.min(2, levels), 1] : [levels, 1])];
      let lastError;
      for (const requestedLevels of levelAttempts) {
        let previousBranches;
        let repairPrompt = '';
        let selectionCandidate;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            let parsed;
            if (selectionCandidate) {
              const routes = leafRoutes(selectionCandidate);
              const requiredGroups = selectionCandidate.length <= task.maxLeaves
                ? selectionCandidate.map((_, index) => String(index)) : [];
              for (let selectionAttempt = 0; selectionAttempt < 2; selectionAttempt++) {
                try {
                  const selection = await requestModel({
                    fetchImpl, baseUrl: parsedBaseUrl, apiKey: effectiveApiKey, model: effectiveModel,
                    prompt: ROUTE_SELECTION_PROMPT + (selectionAttempt
                      ? '\n\n上一次路线筛选结果格式不正确。请只返回符合要求的 keepLeafPaths JSON 对象。' : ''),
                    input: { storyFrame, ancestorPath: legacyPath, branchState, currentEvent,
                      routes, keepCount: task.maxLeaves, requiredRootGroups: requiredGroups },
                    temperature: 0.1, maxOutputTokens: 2048, timeoutMs: 90000, retryJson: false, retryTruncated: false,
                    beforeRequest: trialStore ? () => trialStore.consumeModelCall(token, trialRequest.storyId,
                      trialRequest.branchId, claim.claim) : undefined,
                    responseSchema: effectiveModel === 'qwen3.8-flash' ? {
                      type: 'object', additionalProperties: false, required: ['keepLeafPaths'],
                      properties: { keepLeafPaths: { type: 'array', minItems: task.maxLeaves, maxItems: task.maxLeaves,
                        items: { type: 'string', enum: routes.map(route => route.id) } } },
                    } : undefined,
                  });
                  parsed = { branches: retainRoutes(selectionCandidate, selection, task.maxLeaves, routes, requiredGroups) };
                  break;
                } catch (error) {
                  if (selectionAttempt || !(error instanceof ModelResponseError ||
                      /路线筛选不正确/.test(error.message || ''))) throw error;
                }
              }
            } else parsed = await requestModel({
              fetchImpl, baseUrl: parsedBaseUrl, apiKey: effectiveApiKey, model: effectiveModel,
              prompt: (task ? subtreePrompt(task) : generationPrompt(phase, requestedLevels)) + (attempt ? `\n\n【修正任务】\n${repairPrompt}` : ''),
              input: {
                storyFrame, branchState: branchState || '初始状态', currentEvent,
                currentDepth: depth, targetDepth, mode, maxChildren: limits.children,
                maxStoryNodes: batchLimits.nodes,
                ...(staged || !branchState ? { legacyPath } : {}), requestedLevels,
                ...(task ? { stage: task.stage, suggestedLeafRange: [task.minLeaves, task.maxLeaves],
                  maxLeaves: task.maxLeaves } : {}),
                ...(previousBranches ? { previousBranches } : {}),
              },
              temperature: 0.3,
              beforeRequest: trialStore ? () => trialStore.consumeModelCall(token, trialRequest.storyId,
                trialRequest.branchId, claim.claim) : undefined,
              responseSchema: effectiveModel === 'qwen3.8-flash'
                ? branchResponseSchema(requestedLevels, limits.children) : undefined,
              maxOutputTokens: staged || phase === 'converge' ? 32768 : 8192,
              timeoutMs: staged || phase === 'converge' ? 180000 : 90000,
              retryTruncated: !staged && requestedLevels === 1, retryJson: !staged,
            });
            if (exceedsBranchLimit(parsed?.branches, limits.children)) {
              const error = new Error(`模型返回的子分支超过 ${limits.children} 个上限`);
              if (attempt === 0) {
                previousBranches = parsed.branches;
                repairPrompt = `${REPAIR_PROMPT}\n具体问题：${error.message}`;
                continue;
              }
              throw error;
            }
            let branches;
            try {
              if (staged && (!parsed || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, 'branches'))) {
                throw new Error('模型返回的分支格式不正确：顶层只能包含 branches');
              }
              // Validate all content before asking the model to choose among valid complete routes.
              branches = normalizeBranches(parsed?.branches, requestedLevels, task
                ? { ...batchLimits, leaves: Infinity, nodes: CONVERGENCE_NODES } : batchLimits);
            } catch (error) {
              if (attempt === 0) {
                repairPrompt = `${FORMAT_REPAIR_PROMPT}\n具体问题：${error.message}`;
                previousBranches = parsed?.branches;
                continue;
              }
              throw error;
            }
            if (hasMixedOutcome(branches)) {
              if (attempt === 0) {
                previousBranches = branches;
                repairPrompt = REPAIR_PROMPT;
                continue;
              }
              if (!staged && requestedLevels === 1) branches = deferMixedOutcomes(branches);
              if (hasMixedOutcome(branches)) throw new Error('模型返回的分支把不同结局写在一起');
            }
            if (task && leafRoutes(branches).length > task.maxLeaves && attempt === 0) {
              selectionCandidate = branches;
              continue;
            }
            if (task) branches = normalizeBranches(branches, requestedLevels, batchLimits);
            const saved = trialStore
              ? await trialStore.finishExpand(token, trialRequest.storyId, trialRequest.branchId, claim.claim, branches)
              : branches;
            return send(res, 200, { branches: saved }, corsOrigin);
          } catch (error) {
            if (error instanceof TrialError || !(error instanceof ModelResponseError ||
                error.name === 'TimeoutError' || error.name === 'AbortError' ||
                /^模型返回的(?:分支|子分支)/.test(error.message || ''))) throw error;
            lastError = error;
            if (staged && attempt === 0) {
              repairPrompt = `${FORMAT_REPAIR_PROMPT}\n具体问题：${error.message}。仍须一次输出完整子树，不得降为单层。`;
              continue;
            }
            break;
          }
        }
      }
      throw lastError;
    } catch (error) {
      if (trialStore && claim?.claim) {
        try {
          if (req.url === '/prepare') await trialStore.releasePrepare(token, trialRequest.storyId, claim.claim);
          else await trialStore.releaseExpand(token, trialRequest.storyId, trialRequest.branchId, claim.claim);
        } catch {}
      }
      console.warn('模型请求失败：', error.name, error.message, error.cause?.code || '');
      const message = error.name === 'TimeoutError' || error.name === 'AbortError'
        ? '等待模型回复超时，已有进度已保留，请继续当前任务'
        : error instanceof TypeError ? '无法连接模型接口，请检查网络后重试'
          : /^(模型|故事脉络)/.test(error.message || '') ? error.message
            : '模型请求失败，请稍后重试';
      return send(res, error instanceof TrialError ? error.status : 502,
        { error: error instanceof TrialError ? error.message : message }, corsOrigin);
    }
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (!process.env.TABLESTORE_TABLE) {
    throw new Error('公开接口需要配置共享的 TABLESTORE_TABLE');
  }
  const freeEnabled = process.env.SITE_FREE_ENABLED === 'true';
  const baseUrl = process.env.AI_BASE_URL;
  if (freeEnabled && (!baseUrl || new URL(baseUrl).protocol !== 'https:' ||
      !process.env.AI_MODEL || !process.env.AI_API_KEY)) {
    throw new Error('启用免费体验前，必须配置 HTTPS AI_BASE_URL、AI_MODEL 和 AI_API_KEY');
  }
  const port = Number(process.env.CAPort || process.env.PORT || 9000);
  const stateBackend = createTablestoreState({
    endpoint: process.env.TABLESTORE_ENDPOINT,
    instance: process.env.TABLESTORE_INSTANCE,
    table: process.env.TABLESTORE_TABLE,
  });
  await stateBackend.load();
  const trialStore = createTrialStore(null, { stateBackend,
    limits: freeEnabled ? {} : { guestStoriesPerDay: 0, siteStoriesPerDay: 0, siteModelCallsPerDay: 0 } });
  createServer({ trialStore, storedApiKey: freeEnabled ? process.env.AI_API_KEY : null })
    .listen(port, '0.0.0.0', () => {
    console.log(`What_if API listening on ${port}`);
  });
}
