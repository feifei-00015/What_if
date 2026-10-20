import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { plannedLevels, SUBTREE_MODES, isSubtreeStrategy, subtreeTask, subtreeProgress, markSubtreeStage } from '../web/generation-flow.mjs';

const DEFAULT_LIMITS = { guestStoriesPerDay: 2, siteStoriesPerDay: 50, storyModelCalls: 80, siteModelCallsPerDay: 1000 };
const MODE_DEPTH = { light: 8, normal: 12, deep: 15 };
const CLAIM_MS = 15 * 60 * 1000;

export class TrialError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function dayAt(time) {
  return new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function visitorId(token) {
  if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token)) throw new TrialError(401, '访客凭证无效，请刷新页面');
  return createHash('sha256').update(token).digest('hex');
}

function metadataTree(story, id = story.rootId) {
  const node = story.nodes[id];
  return { id, terminal: node.terminal, generationStage: node.stage,
    children: node.children.map(child => metadataTree(story, child)) };
}

function hasPending(root, depth, limit) {
  if (root.children.length) return root.children.some(child => hasPending(child, depth + 1, limit));
  return !root.terminal && depth < limit;
}

function addIds(branches) {
  return branches.map(branch => ({ ...branch, id: randomUUID(), children: addIds(branch.children) }));
}

function recordNodes(nodes, branches, depth) {
  for (const branch of branches) {
    nodes[branch.id] = { children: branch.children.map(child => child.id), terminal: branch.terminal,
      depth, stage: branch.generationStage || 0, called: false };
    recordNodes(nodes, branch.children, depth + 1);
  }
}

function removeDescendants(nodes, id) {
  for (const childId of nodes[id].children) {
    removeDescendants(nodes, childId);
    delete nodes[childId];
  }
}

function hasLaterCall(nodes, id) {
  return nodes[id].children.some(childId => nodes[childId].called || hasLaterCall(nodes, childId));
}

function stripLegacy(data) {
  if (data.version === 2) return data;
  const activeIds = new Set(Object.values(data.guests || {}).map(guest => guest.activeStoryId).filter(Boolean));
  const stories = {};
  for (const id of activeIds) {
    const old = data.stories?.[id];
    if (!old?.root?.id) continue;
    const nodes = {};
    function walk(node, depth) {
      nodes[node.id] = { children: (node.children || []).map(child => child.id), terminal: node.terminal === true,
        depth, stage: node.generationStage || 0, called: !!node.children?.length };
      for (const child of node.children || []) walk(child, depth + 1);
    }
    walk(old.root, 0);
    stories[id] = { id, visitorId: old.visitorId, mode: old.mode, funding: old.funding || 'site',
      generationStrategy: old.generationStrategy, createdDay: old.createdDay, targetDepth: old.targetDepth,
      status: old.status, createdAt: old.createdAt, modelCalls: old.modelCalls || 0,
      callsByDay: old.callsByDay || {}, prepared: !!old.frame, rootId: old.root.id, nodes };
  }
  for (const guest of Object.values(data.guests || {})) guest.currentStoryId = guest.activeStoryId || null;
  return { version: 2, guests: data.guests || {}, stories, days: data.days || {} };
}

export function createTrialStore(filePath, { now = Date.now, limits = {}, stateBackend } = {}) {
  const caps = { ...DEFAULT_LIMITS, ...limits };
  let pending = Promise.resolve();
  let memory = { version: 2, guests: {}, stories: {}, days: {} };

  async function load() {
    if (stateBackend) return (await stateBackend.load()).data;
    if (!filePath) return memory;
    try { return stripLegacy(JSON.parse(await readFile(filePath, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') return { version: 2, guests: {}, stories: {}, days: {} };
      throw error;
    }
  }

  async function change(action) {
    const task = pending.then(async () => {
      if (stateBackend) {
        for (let attempt = 0; attempt < 30; attempt++) {
          const { data, revision } = await stateBackend.load();
          const result = action(data);
          if (await stateBackend.save(data, revision)) return result;
          await new Promise(resolve => setTimeout(resolve, Math.min(100, 5 + attempt * 5)));
        }
        throw new TrialError(503, '访问人数较多，请稍后重试');
      }
      const data = await load();
      const result = action(data);
      if (filePath) {
        await mkdir(dirname(filePath), { recursive: true });
        const temp = `${filePath}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
        await rename(temp, filePath);
      } else memory = data;
      return result;
    });
    pending = task.catch(() => {});
    return task;
  }

  async function view(action) {
    await pending;
    return action(await load());
  }

  function owned(data, token, storyId) {
    const id = visitorId(token);
    if (!data.guests[id]) throw new TrialError(401, '访客凭证已失效，请刷新页面');
    const story = data.stories[storyId];
    if (!story || story.visitorId !== id) throw new TrialError(404, '找不到这个故事');
    return { guest: data.guests[id], story };
  }

  function guestStatus(guest) {
    const day = dayAt(now());
    const starts = guest.starts[day] || 0;
    const completed = guest.completed[day] || 0;
    return {
      day,
      remainingToday: Math.max(0, caps.guestStoriesPerDay - starts),
      completedToday: completed,
      keyPromptRequired: starts >= caps.guestStoriesPerDay && completed >= caps.guestStoriesPerDay,
      activeStoryId: guest.activeStoryId,
      currentStoryId: guest.currentStoryId || null,
    };
  }

  return {
    async scrubLegacy() { return change(() => {}); },
    async guest(token) {
      return change(data => {
        let id;
        try { id = visitorId(token); } catch { id = null; }
        if (!id || !data.guests[id]) {
          token = randomBytes(32).toString('base64url');
          id = visitorId(token);
          data.guests[id] = { createdAt: now(), starts: {}, completed: {}, activeStoryId: null, currentStoryId: null };
        }
        return { token, ...guestStatus(data.guests[id]) };
      });
    },
    async status(token) {
      return view(data => {
        const guest = data.guests[visitorId(token)];
        if (!guest) throw new TrialError(401, '访客凭证已失效，请刷新页面');
        return guestStatus(guest);
      });
    },
    async createStory(token, { scenario, context, mode, funding = 'site', generationStrategy }) {
      if (typeof context !== 'string' || !context.trim() || context.length > 12000 ||
          typeof scenario !== 'string' || !scenario.trim() || scenario.length > 2000 ||
          (generationStrategy !== undefined && !isSubtreeStrategy(generationStrategy)) ||
          !Object.hasOwn(MODE_DEPTH, mode) || !['site', 'own'].includes(funding)) {
        throw new TrialError(400, '请填写故事和“如果”，并选择有效的推演模式');
      }
      return change(data => {
        const id = visitorId(token);
        const guest = data.guests[id];
        if (!guest) throw new TrialError(401, '访客凭证已失效，请刷新页面');
        if (guest.activeStoryId) throw new TrialError(409, '你还有未完成的故事，请先继续或放弃它');
        const day = dayAt(now());
        if (funding === 'site') {
          const site = data.days[day] ||= { stories: 0, modelCalls: 0 };
          if ((guest.starts[day] || 0) >= caps.guestStoriesPerDay) throw new TrialError(429, '今天的两次免费新故事已用完，可配置自己的模型 API 继续使用');
          if (site.stories >= caps.siteStoriesPerDay || site.modelCalls >= caps.siteModelCallsPerDay) {
            throw new TrialError(429, '今天的全站体验额度已用完，可配置自己的模型 API 继续使用');
          }
          guest.starts[day] = (guest.starts[day] || 0) + 1;
          site.stories++;
        }
        if (guest.currentStoryId) delete data.stories[guest.currentStoryId];
        const storyId = randomUUID();
        const rootId = randomUUID();
        const targetDepth = isSubtreeStrategy(generationStrategy) ? SUBTREE_MODES[mode].depth : MODE_DEPTH[mode];
        data.stories[storyId] = { id: storyId, visitorId: id, mode, funding, generationStrategy,
          createdDay: day, targetDepth, status: 'running', createdAt: now(), modelCalls: 0,
          callsByDay: {}, prepared: false, rootId,
          nodes: { [rootId]: { children: [], terminal: false, depth: 0, stage: 0, called: false } } };
        guest.activeStoryId = storyId;
        guest.currentStoryId = storyId;
        return { id: storyId, scenario: scenario.trim(), context: context.trim(), mode, funding,
          ...(generationStrategy ? { generationStrategy } : {}), createdDay: day, targetDepth,
          status: 'running', frame: null,
          root: { id: rootId, title: scenario.trim(), story: '', terminal: false, children: [] } };
      });
    },
    async getStory(token, storyId) {
      return view(data => {
        const { story } = owned(data, token, storyId);
        return { id: story.id, status: story.status, funding: story.funding, mode: story.mode,
          generationStrategy: story.generationStrategy, modelCalls: story.modelCalls,
          root: metadataTree(story) };
      });
    },
    async claimPrepare(token, storyId) {
      return change(data => {
        const { story } = owned(data, token, storyId);
        if (story.status !== 'running') throw new TrialError(409, '这个故事已停止推演');
        if (story.prepareClaim && now() - story.prepareClaim.at < CLAIM_MS) throw new TrialError(409, '故事正在整理中，请稍后继续');
        const claim = randomUUID();
        story.prepareClaim = { id: claim, at: now() };
        return { claim, funding: story.funding };
      });
    },
    async finishPrepare(token, storyId, claim, frame) {
      return change(data => {
        const { story } = owned(data, token, storyId);
        if (story.prepareClaim?.id !== claim) throw new TrialError(409, '故事整理请求已失效');
        story.prepared = true;
        delete story.prepareClaim;
        return frame;
      });
    },
    async releasePrepare(token, storyId, claim) {
      return change(data => {
        const { story } = owned(data, token, storyId);
        if (story.prepareClaim?.id === claim) delete story.prepareClaim;
      });
    },
    async claimExpand(token, storyId, branchId, requestedLevels) {
      return change(data => {
        const { story } = owned(data, token, storyId);
        if (!story.prepared) throw new TrialError(409, '请先整理原始故事');
        const node = story.nodes[branchId];
        if (!node) throw new TrialError(404, '找不到这个故事分支');
        if (node.terminal || node.depth >= story.targetDepth || node.stage === 3) {
          throw new TrialError(409, '这条分支已经结束');
        }
        if (story.status !== 'running') throw new TrialError(409, '这个故事已停止推演');
        if (node.claim && now() - node.claim.at < CLAIM_MS) throw new TrialError(409, '这条分支正在生成中，请稍后继续');
        if (node.children.length && hasLaterCall(story.nodes, branchId)) {
          throw new TrialError(409, '这条分支的后续已经生成');
        }
        const staged = isSubtreeStrategy(story.generationStrategy);
        const next = staged ? subtreeProgress(metadataTree(story)).pending[0] : null;
        if (staged && !node.children.length && next?.node.id !== branchId) {
          throw new TrialError(409, '请按当前阶段的分支顺序继续推演');
        }
        const task = staged ? subtreeTask(story.mode, (node.stage || 0) + 1, story.generationStrategy) : null;
        const levels = task?.levels ?? plannedLevels(node.depth, story.targetDepth, story.mode === 'deep' ? 2 : 3);
        if (!Number.isInteger(requestedLevels) || requestedLevels !== levels) throw new TrialError(400, '推演层数与当前故事不一致');
        const claim = randomUUID();
        node.claim = { id: claim, at: now() };
        return { claim, funding: story.funding, input: { mode: story.mode,
          targetDepth: story.targetDepth, generationStrategy: story.generationStrategy,
          depth: node.depth, levels,
          ...(staged ? { stage: task.stage } : {}) } };
      });
    },
    async finishExpand(token, storyId, branchId, claim, branches) {
      return change(data => {
        const { guest, story } = owned(data, token, storyId);
        const node = story.nodes[branchId];
        if (node?.claim?.id !== claim) throw new TrialError(409, '分支生成请求已失效');
        const children = addIds(branches);
        if (isSubtreeStrategy(story.generationStrategy)) markSubtreeStage(children, node.stage + 1);
        removeDescendants(story.nodes, branchId);
        recordNodes(story.nodes, children, node.depth + 1);
        node.children = children.map(child => child.id);
        node.terminal = !children.length;
        node.called = true;
        delete node.claim;
        const root = metadataTree(story);
        if (isSubtreeStrategy(story.generationStrategy)
          ? !subtreeProgress(root).pending.length
          : !hasPending(root, 0, story.targetDepth)) {
          story.status = 'complete';
          story.completedAt = now();
          if (story.funding === 'site') {
            const day = story.createdDay || dayAt(story.createdAt);
            guest.completed[day] = (guest.completed[day] || 0) + 1;
          }
          if (guest.activeStoryId === storyId) guest.activeStoryId = null;
        }
        return structuredClone(children);
      });
    },
    async releaseExpand(token, storyId, branchId, claim) {
      return change(data => {
        const { story } = owned(data, token, storyId);
        const node = story.nodes[branchId];
        if (node?.claim?.id === claim) delete node.claim;
      });
    },
    async consumeModelCall(token, storyId, branchId, claim) {
      return change(data => {
        const { story } = owned(data, token, storyId);
        if (branchId) {
          const node = story.nodes[branchId];
          if (node?.claim?.id !== claim) throw new TrialError(409, '分支生成请求已失效');
          node.claim.at = now();
        } else if (story.prepareClaim?.id !== claim) throw new TrialError(409, '故事整理请求已失效');
        const day = dayAt(now());
        const site = data.days[day] ||= { stories: 0, modelCalls: 0 };
        if (story.funding === 'site' && (story.callsByDay[day] || 0) >= caps.storyModelCalls) {
          throw new TrialError(429, '这个故事今天的推演额度已用完，明天可以继续当前故事');
        }
        if (story.funding === 'site' && site.modelCalls >= caps.siteModelCallsPerDay) {
          throw new TrialError(429, '今天的全站推演额度已用完，明天可以继续当前故事');
        }
        story.modelCalls++;
        story.callsByDay[day] = (story.callsByDay[day] || 0) + 1;
        if (story.funding === 'site') site.modelCalls++;
      });
    },
    async abandon(token, storyId) {
      return change(data => {
        const { guest } = owned(data, token, storyId);
        delete data.stories[storyId];
        if (guest.activeStoryId === storyId) guest.activeStoryId = null;
        if (guest.currentStoryId === storyId) guest.currentStoryId = null;
        return guestStatus(guest);
      });
    },
  };
}
