import { layoutTree, zoomAt } from './map-layout.mjs';
import { generationPhase, plannedLevels, storyProgress, SUBTREE_STRATEGY, SUBTREE_MODES, isSubtreeStrategy, subtreeTask, subtreeProgress, markSubtreeStage } from './generation-flow.mjs';
import { createStoryBeams } from './visual/light-beams.mjs';
import { createWaterSurface } from './visual/water-surface.mjs';
const STORAGE_KEY = 'what-if-tree-v2';
const BACKUP_KEY = 'what-if-tree-v2-backup';
const REBUILD_KEY = 'what-if-tree-v2-rebuild';
const ACTIVE_STORY_KEY = 'what-if-active-story-id';
const GENERATION_VERSION = 2;
const GUEST_KEY = 'what-if-guest-token';
const OWN_KEY = 'what-if-own-api-key';
const OWN_BASE_URL = 'what-if-own-base-url';
const OWN_MODEL = 'what-if-own-model';
const KEY_PROMPT_DAY = 'what-if-key-prompt-day';
const MODES = {
  light: { depth: 8, batchLevels: 3, description: '三阶段推演，约 15 条路线；主要路径约 6–8 层。' },
  normal: { depth: 12, batchLevels: 3, description: '三阶段推演，约 30 条路线；主要路径约 8–10 层。' },
  deep: { depth: 15, batchLevels: 2, description: '三阶段推演，约 45–55 条路线；主要路径约 10–12 层。' },
};

const form = document.querySelector('#form');
const status = document.querySelector('#status');
const treeView = document.querySelector('#tree');
const treeScroll = document.querySelector('#tree-scroll');
const waterSurface = createWaterSurface(document.querySelector('#water-surface'));
const clearButton = document.querySelector('#clear');
const resumeButton = document.querySelector('#resume');
const stopButton = document.querySelector('#stop');
const rerunButton = document.querySelector('#rerun');
const modeInputs = [...document.querySelectorAll('input[name="mode"]')];
const modeNote = document.querySelector('#mode-note');
const applyModeButton = document.querySelector('#apply-mode');
const submitButton = form.querySelector('button[type="submit"]');
const modelInfo = document.querySelector('#model-info');
const storyTitle = document.querySelector('#story-title');
const contextError = document.querySelector('#context-error');
const scenarioError = document.querySelector('#scenario-error');
const statsView = document.querySelector('#stats');
const frameView = document.querySelector('#frame-view');
const frameContent = document.querySelector('#frame-content');
let tree = loadTree();
if (tree?.id && !localStorage.getItem(ACTIVE_STORY_KEY)) localStorage.setItem(ACTIVE_STORY_KEY, tree.id);
let ready = false;
let siteReady = false;
let siteModel = '';
let busy = false;
let autoRunning = false;
let stopRequested = false;
let rebuildCandidate = null;
let trialEnabled = false;
let guestToken = localStorage.getItem(GUEST_KEY);
let trialInfo = null;
let ownApiKey = sessionStorage.getItem(OWN_KEY) || '';
let ownBaseUrl = sessionStorage.getItem(OWN_BASE_URL) || '';
let ownModel = sessionStorage.getItem(OWN_MODEL) || '';
let siteQuotaExhausted = false;
const keyDialog = document.querySelector('#api-key-dialog');
const keyInput = document.querySelector('#api-key-input');
const baseUrlInput = document.querySelector('#api-base-url-input');
const modelInput = document.querySelector('#api-model-input');
const keyError = document.querySelector('#api-key-error');
const keyMenuButton = document.querySelector('#open-api-key');

function hasOwnApiConfig() {
  return !!(ownApiKey && ownBaseUrl && ownModel);
}

function openKeyDialog() {
  if (!trialEnabled || keyDialog.open) return;
  document.querySelector('.menu').open = false;
  document.querySelector('#api-key-description').textContent = !siteReady
    ? '填写接口地址、模型名称和 API Key，使用自己的模型服务继续推演；模型费用由你的账号承担。'
    : trialInfo?.remainingToday > 0 && !siteQuotaExhausted
      ? '可以提前配置自己的模型服务；今天剩余的免费故事会优先使用站点额度。使用个人配置时，模型费用由你的账号承担。'
      : `${siteQuotaExhausted ? '本站今天的免费额度已用完。' : '今天的两次免费故事已用完。'}填写接口地址、模型名称和 API Key 后可以继续创建故事；模型费用由你的账号承担。`;
  baseUrlInput.value = ownBaseUrl;
  modelInput.value = ownModel;
  keyInput.value = ownApiKey;
  keyError.textContent = '';
  document.querySelector('#api-key-remove').hidden = !ownApiKey;
  keyDialog.showModal();
  (ownBaseUrl ? keyInput : baseUrlInput).focus();
}

function maybePromptForKey() {
  if (!trialEnabled || !trialInfo?.keyPromptRequired || hasOwnApiConfig() ||
      sessionStorage.getItem(KEY_PROMPT_DAY) === trialInfo.day) return;
  sessionStorage.setItem(KEY_PROMPT_DAY, trialInfo.day);
  openKeyDialog();
}

keyMenuButton.addEventListener('click', openKeyDialog);
document.querySelector('#api-key-close').addEventListener('click', () => keyDialog.close());
document.querySelector('#api-key-remove').addEventListener('click', () => {
  ownApiKey = '';
  ownBaseUrl = '';
  ownModel = '';
  sessionStorage.removeItem(OWN_KEY);
  sessionStorage.removeItem(OWN_BASE_URL);
  sessionStorage.removeItem(OWN_MODEL);
  ready = siteReady;
  setBusy(busy);
  keyDialog.close();
  updateTrialNote();
});
document.querySelector('#api-key-form').addEventListener('submit', event => {
  event.preventDefault();
  const value = keyInput.value.trim();
  const baseUrl = baseUrlInput.value.trim();
  const model = modelInput.value.trim();
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || baseUrl.length > 2048 ||
        /\/chat\/completions\/?$/.test(url.pathname)) throw new Error();
  } catch {
    keyError.textContent = '请填写 HTTPS 接口根地址，不包含 /chat/completions、账号密码或查询参数';
    return;
  }
  if (!model || model.length > 200) {
    keyError.textContent = '请输入有效的模型名称（不超过 200 字）';
    return;
  }
  if (!value || value.length > 2048) {
    keyError.textContent = '请输入有效的 API Key';
    return;
  }
  ownApiKey = value;
  ownBaseUrl = baseUrl;
  ownModel = model;
  sessionStorage.setItem(OWN_KEY, value);
  sessionStorage.setItem(OWN_BASE_URL, baseUrl);
  sessionStorage.setItem(OWN_MODEL, model);
  ready = siteReady || hasOwnApiConfig();
  setBusy(busy);
  keyDialog.close();
  updateTrialNote();
  status.textContent = '模型 API 已在本次浏览器会话中配置。可以继续推演或新建故事。';
});

function updateTrialNote() {
  if (!trialInfo) return;
  const note = document.querySelector('#trial-info');
  note.textContent = trialInfo.activeStoryId
    ? '当前故事可暂停后继续'
    : trialInfo.remainingToday > 0 && !siteQuotaExhausted
      ? `免费体验 · 今天还可新建 ${trialInfo.remainingToday} 个故事`
      : `${siteQuotaExhausted ? '本站免费额度已用完' : '免费次数已用完'} · ${hasOwnApiConfig() ? '已配置个人 API' : '可配置个人 API'}`;
  keyMenuButton.textContent = hasOwnApiConfig() ? '管理我的 API' : '配置自己的 API';
  modelInfo.textContent = (tree?.funding === 'own' || !siteReady || trialInfo.remainingToday === 0 || siteQuotaExhausted) && hasOwnApiConfig()
    ? `个人模型 · ${ownModel}` : siteReady ? `本站模型 · ${siteModel}` : '尚未配置模型 API';
}

async function trialFetch(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(guestToken ? { Authorization: `Bearer ${guestToken}` } : {}) },
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return result;
}

async function refreshTrialStatus() {
  const previousDay = trialInfo?.day;
  trialInfo = await trialFetch('/trial/status');
  if (previousDay && previousDay !== trialInfo.day) siteQuotaExhausted = false;
  updateTrialNote();
}

async function createTrialStory({ scenario, context, mode }) {
  const funding = siteReady && trialInfo?.remainingToday > 0 && !siteQuotaExhausted ? 'site' : 'own';
  if (funding === 'own' && !hasOwnApiConfig()) {
    openKeyDialog();
    throw new Error('请先配置接口地址、模型名称和 API Key，再新建故事');
  }
  let story;
  try {
    ({ story } = await trialFetch('/trial/stories', {
      method: 'POST', body: JSON.stringify({ scenario, context, mode, funding, generationStrategy: SUBTREE_STRATEGY }),
    }));
  } catch (error) {
    if (funding === 'site' && error.status === 429) {
      await refreshTrialStatus();
      siteQuotaExhausted = error.message.includes('全站体验额度');
      updateTrialNote();
      if (hasOwnApiConfig()) return createTrialStory({ scenario, context, mode });
      openKeyDialog();
    }
    throw error;
  }
  await refreshTrialStatus();
  return { ...story, generationVersion: GENERATION_VERSION };
}

function normalizeMode(value) {
  return Object.hasOwn(MODES, value) ? value : 'normal';
}

function normalizeDepth(value, mode = 'normal') {
  const depth = Number(value);
  return Number.isInteger(depth) && depth >= 2 && depth <= MODES[normalizeMode(mode)].depth
    ? depth : MODES[normalizeMode(mode)].depth;
}

function roundLimit(source = tree) {
  return normalizeDepth(source?.targetDepth, source?.mode);
}

function selectedMode() {
  return normalizeMode(modeInputs.find(input => input.checked)?.value);
}

function selectMode(mode) {
  modeInputs.find(input => input.value === normalizeMode(mode)).checked = true;
}

selectMode(tree?.mode);

function updateModeControl() {
  const selected = selectedMode();
  modeNote.textContent = MODES[selected].description + '路线数为参考，实际随故事变化；稳定结局会提前结束。';
  applyModeButton.hidden = !tree || (selected === normalizeMode(tree.mode) && tree.generationStrategy === SUBTREE_STRATEGY);
  applyModeButton.disabled = busy || !ready || !tree;
}

function pathItem(node) {
  return { title: node.title, story: node.story, assumption: node.assumption || '' };
}

function loadTree() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const saved = JSON.parse(raw);
    const activeId = localStorage.getItem(ACTIVE_STORY_KEY);
    if (activeId && saved?.id !== activeId) return null;
    if (saved?.root && !isSubtreeStrategy(saved.generationStrategy) &&
        !localStorage.getItem('what-if-before-three-stage')) {
      // Retain the old browser story independently of rerun/restore controls.
      try { localStorage.setItem('what-if-before-three-stage', raw); } catch {}
    }
    if (saved?.root && typeof saved.scenario === 'string') {
      function normalize(node) {
        node.terminal = node.terminal === true;
        node.children ||= [];
        for (const child of node.children) normalize(child);
      }
      normalize(saved.root);
      const legacy = !Object.hasOwn(saved, 'mode');
      saved.mode = normalizeMode(saved.mode);
      saved.targetDepth = normalizeDepth(saved.targetDepth ?? (legacy ? 10 : undefined), saved.mode);
      return saved;
    }
    const old = JSON.parse(localStorage.getItem('what-if-tree-v1'));
    if (old && typeof old.scenario === 'string' && Array.isArray(old.nodes)) {
      const migrated = {
        scenario: old.scenario, context: old.context || '',
        mode: 'normal', targetDepth: 10,
        root: { title: old.scenario, story: old.context || '', terminal: false, children: old.nodes },
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      localStorage.removeItem('what-if-tree-v1');
      return migrated;
    }
  } catch {
    status.textContent = '本机保存的故事树无法读取，请重新开始。';
  }
  return null;
}

function saveTree(source = tree, key = STORAGE_KEY) {
  try {
    const activeId = localStorage.getItem(ACTIVE_STORY_KEY);
    if (source?.id && activeId && source.id !== activeId) return false;
    localStorage.setItem(key, JSON.stringify(source));
    return true;
  } catch {
    return false;
  }
}

function clearStoredStories() {
  for (const key of [STORAGE_KEY, BACKUP_KEY, REBUILD_KEY, 'what-if-before-three-stage', 'what-if-tree-v1']) {
    localStorage.removeItem(key);
  }
}

function replaceStoredStory(source) {
  source.id ||= crypto.randomUUID();
  try {
    const saved = JSON.stringify(source);
    clearStoredStories();
    localStorage.setItem(ACTIVE_STORY_KEY, source.id);
    localStorage.setItem(STORAGE_KEY, saved);
    return true;
  } catch {
    try { clearStoredStories(); } catch {}
    return false;
  }
}

async function abandonUnsavedStory(source) {
  if (!trialEnabled) return;
  try {
    await trialFetch(`/trial/stories/${source.id}/abandon`, { method: 'POST', body: '{}' });
    await refreshTrialStatus();
  } catch {}
}

function leafStats(source = tree) {
  return isSubtreeStrategy(source.generationStrategy)
    ? subtreeProgress(source.root) : storyProgress(source.root, roundLimit(source));
}

async function prepareStory(source = tree) {
  const response = await fetch('/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(trialEnabled ? { Authorization: `Bearer ${guestToken}` } : {}),
      ...(trialEnabled && source.funding === 'own' ? { 'X-User-Api-Key': ownApiKey } : {}) },
    body: JSON.stringify(trialEnabled ? { storyId: source.id, scenario: source.scenario, context: source.context,
      ...(source.funding === 'own' ? { modelConfig: { baseUrl: ownBaseUrl, model: ownModel } } : {}) }
      : { scenario: source.scenario, context: source.context }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result.frame;
}

async function generate(source, node, path, levels, stage) {
  const response = await fetch('/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(trialEnabled ? { Authorization: `Bearer ${guestToken}` } : {}),
      ...(trialEnabled && source.funding === 'own' ? { 'X-User-Api-Key': ownApiKey } : {}) },
    body: JSON.stringify(trialEnabled ? { storyId: source.id, branchId: node.id, levels,
      frame: source.frame,
      branchState: node.memory || '',
      currentEvent: node === source.root ? null : { title: node.title, story: node.story },
      legacyPath: stage || !node.memory ? path : [],
      ...(source.funding === 'own' ? { modelConfig: { baseUrl: ownBaseUrl, model: ownModel } } : {}) } : {
      frame: source.frame,
      branchState: node.memory || '',
      currentEvent: node === source.root ? null : { title: node.title, story: node.story },
      legacyPath: stage || !node.memory ? path : [],
      ...(stage ? { generationStrategy: source.generationStrategy, stage } : {}),
      depth: path.length,
      mode: normalizeMode(source.mode),
      targetDepth: roundLimit(source),
      levels,
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  function makeNode(branch) {
    return {
      ...(branch.id ? { id: branch.id } : {}),
      title: branch.title, story: branch.story, terminal: branch.terminal,
      memory: branch.memory,
      children: branch.children.map(makeNode),
    };
  }
  const children = result.branches.map(makeNode);
  return stage ? markSubtreeStage(children, stage) : children;
}

function setBusy(value) {
  busy = value;
  submitButton.disabled = value || !ready || !!tree;
  for (const input of modeInputs) input.disabled = value;
  applyModeButton.disabled = value || !ready || !tree;
  clearButton.disabled = value;
  resumeButton.disabled = value;
  rerunButton.disabled = value;
  keyMenuButton.disabled = value;
}

async function runAuto({ source = tree, key = STORAGE_KEY, rebuilding = false } = {}) {
  if (busy || !source || !ready) return;
  if (trialEnabled && source.funding === 'own' && !hasOwnApiConfig()) {
    status.textContent = '继续这条故事需要配置你的模型 API。';
    openKeyDialog();
    return;
  }
  if (trialEnabled && !source.id) {
    status.textContent = '旧本机故事仍可浏览；免费体验请新建故事。';
    return;
  }
  autoRunning = true;
  stopRequested = false;
  stopButton.disabled = false;
  setBusy(true);
  render();
  let calls = 0;
  let failure = '';
  if (!source.frame) {
    status.textContent = '正在把原始故事整理成事实、时间线、动机与未知信息……';
    try {
      source.frame = await prepareStory(source);
      if (!saveTree(source, key)) throw new Error('本机保存空间不足，请先保留当前页面');
      if (!rebuilding) render();
    } catch (error) {
      failure = `故事整理中断：${error.message}`;
    }
  }
  while (!failure && !stopRequested) {
    const { pending, exploring } = leafStats(source);
    if (!pending.length) break;
    const { node, path, stage } = pending[0];
    const depth = roundLimit(source);
    const task = stage ? subtreeTask(normalizeMode(source.mode), stage, source.generationStrategy) : null;
    const levels = task?.levels ?? plannedLevels(path.length, depth, MODES[normalizeMode(source.mode)].batchLevels);
    const phase = generationPhase(path.length, depth);
    status.textContent = `${rebuilding ? '正在重建旧故事' : stage ? `第 ${stage}/3 阶段 · ${['', '发现可能性', '合理深化', '自然收束'][stage]}` : phase === 'explore' ? '正在探索' : '正在收敛'}「${node.title}」 · 第 ${calls + 1} 批请求 · ${stage || phase === 'explore' ? exploring : pending.length} 条走向待完成`;
    calls++;
    try {
      const children = await generate(source, node, path.map(pathItem), levels, stage);
      if (children.length) node.children.push(...children);
      else node.terminal = true;
      if (!saveTree(source, key)) throw new Error('本机保存空间不足，请先保留当前页面');
      if (!rebuilding) render();
    } catch (error) {
      failure = `「${node.title}」推演中断：${error.message}`;
      break;
    }
  }
  autoRunning = false;
  setBusy(false);
  const { pending, ended, capped } = leafStats(source);
  if (rebuilding && !failure && pending.length === 0) {
    source.generationVersion = GENERATION_VERSION;
    if (saveTree(source)) {
      tree = source;
      rebuildCandidate = null;
      localStorage.removeItem(REBUILD_KEY);
      status.textContent = `旧故事已按新的推演规则重建：${ended} 条走向已结束。`;
      render();
      showRoot();
      return;
    }
    failure = '本机保存空间不足，新树已暂存，旧树仍可浏览。';
  }
  render();
  if (rebuilding) {
    status.textContent = failure || (stopRequested ? '旧故事重建已暂停，进度已保存。' : '旧故事重建进度已保存。');
    return;
  }
  status.textContent = failure || (pending.length === 0
    ? `推演完成：${ended} 条故事线自然结束${capped ? `，${capped} 条${isSubtreeStrategy(source.generationStrategy) ? '保留开放结尾' : `抵达 ${roundLimit(source)} 轮目标`}` : ''}。`
    : stopRequested ? `已暂停。${ended} 条已结束，${pending.length} 条待续。`
      : `已保存进度。${pending.length} 条待续，可继续计算。`);
  if (trialEnabled) {
    await refreshTrialStatus().catch(() => {});
    if (!failure && pending.length === 0) maybePromptForKey();
  }
}

function startRebuildIfNeeded() {
  if (trialEnabled) return;
  if (!tree || tree.generationVersion === GENERATION_VERSION || !ready) return;
  try {
    const backup = JSON.parse(localStorage.getItem(BACKUP_KEY));
    if (!backup || backup.scenario !== tree.scenario) localStorage.setItem(BACKUP_KEY, JSON.stringify(tree));
    const staged = JSON.parse(localStorage.getItem(REBUILD_KEY));
    rebuildCandidate = staged?.root && staged.scenario === tree.scenario ? staged : {
      scenario: tree.scenario, context: tree.context || '', frame: tree.frame,
      mode: normalizeMode(tree.mode),
      targetDepth: roundLimit(tree),
      generationVersion: GENERATION_VERSION, attempted: false,
      root: { title: tree.scenario, story: '', terminal: false, children: [] },
    };
    rebuildCandidate.mode = normalizeMode(rebuildCandidate.mode);
    rebuildCandidate.targetDepth = normalizeDepth(rebuildCandidate.targetDepth ?? tree.targetDepth, rebuildCandidate.mode);
    if (!rebuildCandidate.attempted) {
      rebuildCandidate.attempted = true;
      if (!saveTree(rebuildCandidate, REBUILD_KEY)) throw new Error('本机保存空间不足');
      render();
      runAuto({ source: rebuildCandidate, key: REBUILD_KEY, rebuilding: true });
    } else {
      render();
      status.textContent = '旧故事仍可浏览；重建进度已保存，可点击「继续重建」。';
    }
  } catch (error) {
    rebuildCandidate = null;
    status.textContent = `旧故事备份或重建失败：${error.message}`;
  }
}

const storyPanel = document.querySelector('#story-panel');
const storyCards = document.querySelector('#story-cards');
const pathCount = document.querySelector('#path-count');
const drawerPanel = document.querySelector('#drawer-panel');
const drawerToggle = document.querySelector('#drawer-toggle');
const starFlight = document.querySelector('#star-flight');
let drawerOpen = !tree;
let view = { x: 150, y: 350, k: 1 };
let graph = { nodes: [], edges: [], bounds: null };
let renderedBeams = [];
let openPanels = new Map();
let cards = new Map();
let previewId = null;
let previewDeck = null;
let paintedPositions = new Map();
let knownIds = new Set();
let freshUntil = new Map();
let renderedRoot = null;
let viewFrame = 0;
let layoutFrame = 0;
let cameraFrame = 0;
let panelFrame = 0;

function setDrawer(open) {
  drawerOpen = open;
  drawerPanel.hidden = !open;
  storyPanel.classList.toggle('suspended', open);
  drawerToggle.setAttribute('aria-expanded', String(open));
  drawerToggle.textContent = open ? '收起 ⌃' : tree ? '查看原始故事 ⌄' : '说出你的故事 ⌄';
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function enterStarMap() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    render(); showRoot(); setDrawer(false);
    return;
  }
  const card = drawerPanel.getBoundingClientRect();
  const canvas = treeScroll.getBoundingClientRect();
  const landing = {
    x: canvas.left + Math.min(150, canvas.width * .13),
    y: canvas.top + canvas.height / 2,
  };
  document.body.classList.add('is-transitioning');
  try {
    await pause(330);
    starFlight.hidden = false;
    const start = { x: card.left + card.width / 2 - 9, y: card.top + card.height / 2 - 9 };
    const flight = starFlight.animate([
      { left: `${start.x}px`, top: `${start.y}px`, transform: 'scale(.15)', opacity: 0, offset: 0 },
      { left: `${start.x}px`, top: `${start.y}px`, transform: 'scale(1.45)', opacity: 1, offset: .28 },
      { left: `${landing.x - 9}px`, top: `${landing.y - 9}px`, transform: 'scale(.72)', opacity: 1, offset: .82 },
      { left: `${landing.x - 9}px`, top: `${landing.y - 9}px`, transform: 'scale(2.2)', opacity: 0, offset: 1 },
    ], { duration: 1450, easing: 'cubic-bezier(.34,.08,.25,1)', fill: 'forwards' });
    render(); showRoot(); setDrawer(false);
    await flight.finished;
    flight.cancel();
  } finally {
    starFlight.hidden = true;
    document.body.classList.remove('is-transitioning');
  }
}

function applyView() {
  treeView.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  const mapRect = treeScroll.getBoundingClientRect();
  waterSurface.setView(view, mapRect);
  for (const beam of renderedBeams) beam.setViewport(view, mapRect);
  const nodeScale = Math.max(1, 1 / view.k);
  treeView.style.setProperty('--node-scale', String(nodeScale));
  treeView.style.setProperty('--label-scale', String(Math.max(1, 0.8 / view.k) / nodeScale));
  treeView.classList.toggle('overview', view.k < 0.55);
  document.querySelector('#zoom-value').textContent = `${Math.round(view.k * 100)}%`;
}

function scheduleView() {
  if (viewFrame) return;
  viewFrame = requestAnimationFrame(() => { viewFrame = 0; applyView(); });
}

function stopCamera() {
  if (cameraFrame) cancelAnimationFrame(cameraFrame);
  cameraFrame = 0;
}

function centerNode(entry) {
  stopCamera();
  const targetX = treeScroll.clientWidth / 2 - entry.x * view.k;
  const targetY = treeScroll.clientHeight / 2 - entry.y * view.k;
  const startX = view.x, startY = view.y;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    view.x = targetX; view.y = targetY; applyView();
    return;
  }
  const started = performance.now();
  const step = now => {
    const progress = Math.min(1, (now - started) / 480);
    const eased = 1 - (1 - progress) ** 3;
    view.x = startX + (targetX - startX) * eased;
    view.y = startY + (targetY - startY) * eased;
    applyView();
    cameraFrame = progress < 1 ? requestAnimationFrame(step) : 0;
  };
  cameraFrame = requestAnimationFrame(step);
}

function activeId() { return [...openPanels.values()].at(-1) || null; }

function closeFromDepth(depth) {
  const closing = [...openPanels.keys()].filter(d => d >= depth);
  if (!closing.length) return;
  for (const d of closing) openPanels.delete(d);
  previewId = null;
  highlightPath();
  syncCards({ center: true });
}

function highlightPath() {
  const active = new Set();
  const current = graph.nodes.find(n => n.id === activeId());
  const next = new Set(graph.nodes.filter(n => n.parent === current).map(n => n.id));
  for (const id of openPanels.values()) {
    let entry = graph.nodes.find(n => n.id === id);
    while (entry) { active.add(entry.id); entry = entry.parent; }
  }
  for (const button of treeView.querySelectorAll('.map-node')) {
    const selected = active.has(button.dataset.nodeId);
    button.classList.toggle('selected', selected);
    button.classList.toggle('next-choice', next.has(button.dataset.nodeId));
    button.setAttribute('aria-expanded', String(selected));
  }
  for (const beam of renderedBeams) {
    beam.setActive(active.has(beam.to.id));
    beam.setGuided(next.has(beam.to.id));
  }
  waterSurface.setSelected(graph.nodes.filter(node => active.has(node.id)));
}

function makeCard(entry, preview = false) {
  const card = document.createElement('article');
  card.className = 'story-card';
  if (!preview) {
    card.tabIndex = 0;
    card.setAttribute('aria-label', `聚焦${entry.node.title}`);
  }
  card.dataset.nodeId = entry.id;
  card.dataset.depth = String(entry.depth);
  if (!preview) {
    card.addEventListener('click', event => {
      if (event.target.closest('button')) return;
      selectCard(entry.id);
    });
    card.addEventListener('keydown', event => {
      if (event.target !== card || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault(); selectCard(entry.id);
    });
  }
  const top = document.createElement('div'); top.className = 'story-card-top';
  const round = document.createElement('span');
  round.textContent = entry.depth ? String(entry.depth).padStart(2, '0') : 'ORIGIN / 起点';
  if (preview) {
    const hint = document.createElement('span'); hint.textContent = '下一步 · 待选择';
    top.append(round, hint);
  } else {
    const close = document.createElement('button'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', `关闭${entry.node.title}及其后续详情`);
    close.addEventListener('click', () => closeFromDepth(entry.depth));
    top.append(round, close);
  }
  const title = document.createElement('h2'); title.textContent = entry.node.title;
  const story = document.createElement('p'); story.textContent = entry.node.story || (entry.depth === 0 ? tree.context || '这个如果，是所有可能性的起点。' : '');
  const assumption = document.createElement('p'); assumption.hidden = !entry.node.assumption;
  if (entry.node.assumption) assumption.textContent = `追加假设：${entry.node.assumption}`;
  card.append(top, title, story, assumption);
  if (preview) {
    const confirm = document.createElement('button');
    confirm.type = 'button'; confirm.className = 'deck-confirm';
    confirm.setAttribute('aria-label', `选择${entry.node.title}，继续查看下一步`);
    confirm.innerHTML = '<span aria-hidden="true">✓</span> 选择这条 <span aria-hidden="true">→</span>';
    confirm.addEventListener('click', () => selectCard(entry.id));
    card.append(confirm);
  }
  return card;
}

function selectCard(id, direction = 0, keepArrowFocus = false) {
  const entry = graph.nodes.find(node => node.id === id);
  if (!entry) return;
  openNode(entry, direction);
  if (keepArrowFocus && direction) {
    cards.get(entry.depth)?.querySelector(`.deck-arrow.${direction < 0 ? 'previous' : 'next'}`)?.focus({ preventScroll: true });
  }
}

function browsePreview(id, direction = 0, keepArrowFocus = false) {
  const entry = graph.nodes.find(node => node.id === id);
  if (!entry || entry.parent?.id !== activeId()) return;
  previewId = id;
  syncPreview(direction);
  revealLastCard();
  if (keepArrowFocus && direction) {
    previewDeck?.querySelector(`.deck-arrow.${direction < 0 ? 'previous' : 'next'}`)?.focus({ preventScroll: true });
  }
}

function makeDeck(entry, preview = false) {
  const deck = document.createElement('div');
  deck.className = `story-deck${preview ? ' is-preview' : ''}`;
  deck.dataset.nodeId = entry.id;
  deck.dataset.depth = String(entry.depth);
  deck.dataset.siblingCount = String(entry.siblingCount);
  deck.style.order = String(entry.depth);
  const siblings = entry.parent ? graph.nodes.filter(node => node.parent === entry.parent) : [];
  if (siblings.length > 1) {
    deck.classList.add('has-siblings');
    for (const [direction, name] of [[-1, 'previous'], [1, 'next']]) {
      const target = siblings[(entry.siblingIndex + direction + siblings.length) % siblings.length];
      if (siblings.length > 2 || direction === (entry.siblingIndex === 0 ? 1 : -1)) {
        const peek = document.createElement('button');
        peek.type = 'button'; peek.className = `deck-peek ${name}`;
        peek.setAttribute('aria-label', `切换到${target.node.title}`);
        peek.title = target.node.title;
        const peekTitle = document.createElement('span'); peekTitle.textContent = target.node.title;
        peek.append(peekTitle);
        peek.addEventListener('click', event => preview
          ? browsePreview(target.id, direction, event.detail === 0)
          : selectCard(target.id, direction, event.detail === 0));
        deck.append(peek);
      }
    }
  }
  deck.append(makeCard(entry, preview));
  if (siblings.length > 1) {
    for (const [direction, name, symbol] of [[-1, 'previous', '‹'], [1, 'next', '›']]) {
      const target = siblings[(entry.siblingIndex + direction + siblings.length) % siblings.length];
      const arrow = document.createElement('button');
      arrow.type = 'button'; arrow.className = `deck-arrow ${name}`;
      arrow.textContent = symbol;
      arrow.setAttribute('aria-label', `切换到${target.node.title}`);
      arrow.title = target.node.title;
      arrow.addEventListener('click', event => preview
        ? browsePreview(target.id, direction, event.detail === 0)
        : selectCard(target.id, direction, event.detail === 0));
      deck.append(arrow);
    }
  }
  return deck;
}

function retireDeck(deck, direction = 0) {
  deck.style.top = `${deck.offsetTop}px`;
  deck.style.left = `${deck.offsetLeft}px`;
  deck.style.width = `${deck.offsetWidth}px`;
  deck.classList.remove('enter-left', 'enter-right');
  deck.classList.add('leaving');
  if (direction) deck.classList.add(direction > 0 ? 'leave-left' : 'leave-right');
  setTimeout(() => deck.remove(), 250);
}

function syncPreview(direction = 0) {
  const current = graph.nodes.find(node => node.id === activeId());
  const children = current ? graph.nodes.filter(node => node.parent === current) : [];
  if (!children.some(node => node.id === previewId)) previewId = children[0]?.id || null;
  const entry = children.find(node => node.id === previewId);
  if (previewDeck?.dataset.nodeId === previewId && Number(previewDeck.dataset.siblingCount) === entry?.siblingCount) return;
  if (previewDeck) { retireDeck(previewDeck, entry ? direction : 0); previewDeck = null; }
  if (!entry) return;
  previewDeck = makeDeck(entry, true);
  if (direction) previewDeck.classList.add(direction > 0 ? 'enter-right' : 'enter-left');
  storyCards.append(previewDeck);
}

function revealLastCard() {
  const latest = cards.get(Math.max(...openPanels.keys(), -1));
  if (!latest) return;
  stopPanelScroll();
  panelFrame = requestAnimationFrame(() => {
    panelFrame = 0;
    if (!latest.isConnected) return;
    const last = previewDeck || latest;
    const target = Math.max(0, last.offsetHeight > storyCards.clientHeight - 42
      ? last.offsetTop - 22
      : last.offsetTop + last.offsetHeight + 20 - storyCards.clientHeight);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { storyCards.scrollTop = target; return; }
    const start = storyCards.scrollTop;
    const began = performance.now();
    const step = now => {
      const phase = Math.min(1, (now - began) / 420);
      storyCards.scrollTop = start + (target - start) * (1 - (1 - phase) ** 3);
      panelFrame = phase < 1 ? requestAnimationFrame(step) : 0;
    };
    panelFrame = requestAnimationFrame(step);
  });
}

function stopPanelScroll() {
  if (panelFrame) cancelAnimationFrame(panelFrame);
  panelFrame = 0;
}

for (const eventName of ['wheel', 'touchstart', 'pointerdown']) {
  storyCards.addEventListener(eventName, stopPanelScroll, { passive: true });
}

function syncCards({ switchedDepth = -1, direction = 0, center = false } = {}) {
  let slide = direction;
  for (const [depth, deck] of cards) {
    const entry = graph.nodes.find(node => node.id === openPanels.get(depth));
    if (entry?.id === deck.dataset.nodeId && entry.siblingCount === Number(deck.dataset.siblingCount)) continue;
    cards.delete(depth);
    if (entry?.id === deck.dataset.nodeId) { deck.remove(); continue; }
    if (depth === switchedDepth && entry && !slide) {
      const previous = graph.nodes.find(node => node.id === deck.dataset.nodeId);
      if (previous?.parent === entry.parent) slide = Math.sign(entry.siblingIndex - previous.siblingIndex);
    }
    retireDeck(deck, depth === switchedDepth ? slide : 0);
  }
  for (const [depth, id] of [...openPanels].sort((a, b) => a[0] - b[0])) {
    const entry = graph.nodes.find(n => n.id === id);
    if (!entry) { openPanels.delete(depth); cards.delete(depth); continue; }
    if (!cards.has(depth)) {
      const deck = makeDeck(entry);
      if (depth === switchedDepth && slide) deck.classList.add(slide > 0 ? 'enter-right' : 'enter-left');
      cards.set(depth, deck);
      storyCards.append(deck);
    }
  }
  syncPreview();
  pathCount.textContent = `${openPanels.size} 个节点`;
  if (center) revealLastCard();
}

function openNode(entry, direction = 0) {
  const path = [];
  for (let current = entry; current; current = current.parent) path.unshift(current);
  openPanels = new Map(path.map(node => [node.depth, node.id]));
  previewId = null;
  highlightPath();
  syncCards({ switchedDepth: entry.depth, direction, center: true });
  centerNode(entry);
}

function renderMap({ focusId = activeId(), animate = false } = {}) {
  stopCamera();
  const isNewTree = renderedRoot !== tree.root;
  if (layoutFrame) { cancelAnimationFrame(layoutFrame); layoutFrame = 0; }
  const startingView = { ...view };
  const oldGraph = graph;
  const oldPositions = new Map(paintedPositions);
  const centerX = (treeScroll.clientWidth / 2 - view.x) / view.k;
  const centerY = (treeScroll.clientHeight / 2 - view.y) / view.k;
  const anchor = oldGraph.nodes.find(n => n.id === focusId) || oldGraph.nodes.reduce((best, n) =>
    !best || Math.hypot(n.x - centerX, n.y - centerY) < Math.hypot(best.x - centerX, best.y - centerY) ? n : best, null);
  if (isNewTree) {
    stopPanelScroll();
    openPanels.clear(); cards.clear(); storyCards.replaceChildren(); pathCount.textContent = '0 个节点';
    previewId = null; previewDeck = null;
    storyCards.style.paddingTop = ''; storyCards.style.paddingBottom = '';
    knownIds = new Set(); freshUntil = new Map(); paintedPositions.clear();
  }
  graph = layoutTree(tree.root, { openIds: [], scale: view.k });
  if (!isNewTree && anchor) {
    const moved = graph.nodes.find(n => n.id === anchor.id);
    const old = oldPositions.get(anchor.id) || anchor;
    if (moved) { view.x += (old.x - moved.x) * view.k; view.y += (old.y - moved.y) * view.k; }
  }
  const { svg, motionSvg, beams } = createStoryBeams(graph.edges, entry => { if (!suppressClick) openNode(entry); });
  renderedBeams = beams;
  const fragment = document.createDocumentFragment(); fragment.append(svg, motionSvg);
  const nodeElements = new Map();
  for (const entry of graph.nodes) {
    const button = document.createElement('button'); button.type = 'button';
    if (!isNewTree && !knownIds.has(entry.id)) freshUntil.set(entry.id, Date.now() + 6000);
    const fresh = freshUntil.get(entry.id) > Date.now();
    button.className = `map-node${entry.depth === 0 ? ' root' : ''}${entry.node.terminal ? ' ending' : entry.depth >= roundLimit() ? ' limit' : ''}${fresh ? ' fresh' : ''}`;
    button.dataset.nodeId = entry.id;
    button.setAttribute('aria-label', `${entry.node.title}，${entry.depth === 0 ? '起点' : `第 ${entry.depth} 轮`}，查看详情`);
    button.setAttribute('aria-haspopup', 'dialog');
    for (const name of ['cell-core', 'node-label']) {
      const span = document.createElement('span'); span.className = name;
      if (name === 'node-label') span.textContent = entry.node.title;
      else span.setAttribute('aria-hidden', 'true');
      button.append(span);
    }
    button.addEventListener('pointerenter', () => waterSurface.emitAtWorld(entry.x, entry.y));
    button.addEventListener('focus', () => waterSurface.emitAtWorld(entry.x, entry.y));
    button.addEventListener('click', () => { if (!suppressClick) openNode(entry); });
    fragment.append(button); nodeElements.set(entry.id, button);
  }
  treeView.replaceChildren(fragment);
  knownIds = new Set(graph.nodes.map(n => n.id));
  renderedRoot = tree.root;
  highlightPath(); syncCards();
  const endingView = { ...view };
  const duration = animate && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 280 : 0;
  function paint(t) {
    view.x = startingView.x + (endingView.x - startingView.x) * t;
    view.y = startingView.y + (endingView.y - startingView.y) * t;
    const current = new Map();
    for (const entry of graph.nodes) {
      const old = oldPositions.get(entry.id) || entry.parent && oldPositions.get(entry.parent.id) || entry;
      const x = old.x + (entry.x - old.x) * t, y = old.y + (entry.y - old.y) * t;
      current.set(entry.id, { x, y, depth: entry.depth });
      const button = nodeElements.get(entry.id); button.style.left = `${x}px`; button.style.top = `${y}px`;
    }
    for (const beam of beams) beam.paint(current.get(beam.from.id), current.get(beam.to.id));
    paintedPositions = current; applyView();
  }
  if (!duration) paint(1);
  else {
    const started = performance.now();
    paint(0);
    const step = now => {
      const phase = Math.min(1, (now - started) / duration);
      paint(1 - Math.pow(1 - phase, 3));
      if (phase < 1) layoutFrame = requestAnimationFrame(step);
      else layoutFrame = 0;
    };
    layoutFrame = requestAnimationFrame(step);
  }
  if (isNewTree) showRoot(); else applyView();
}

function renderFrame() {
  frameView.hidden = !tree?.frame;
  frameContent.replaceChildren();
  if (!tree?.frame) return;
  const sections = [
    ['改变的选择', [tree.frame.premise]],
    ['已知事实', tree.frame.facts],
    ['事件顺序', tree.frame.timeline],
    ['已明确的心情与动机', tree.frame.motives],
    ['仍不知道的事', tree.frame.unknowns],
  ];
  for (const [title, items] of sections) {
    if (!items.length) continue;
    const heading = document.createElement('h3');
    heading.textContent = title;
    const list = document.createElement('ul');
    for (const item of items) {
      const line = document.createElement('li');
      line.textContent = item;
      list.append(line);
    }
    frameContent.append(heading, list);
  }
}

function render() {
  document.body.classList.toggle('is-intro', !tree);
  document.body.classList.toggle('has-story', !!tree);
  submitButton.disabled = busy || !ready || !!tree;
  rerunButton.disabled = busy || !ready || !tree;
  form.elements.scenario.readOnly = !!tree;
  form.elements.context.readOnly = !!tree;
  document.querySelector('#form-foot').hidden = !!tree;
  document.querySelector('#readonly-note').hidden = !tree;
  document.querySelector('#empty-note').hidden = !!tree;
  updateModeControl();
  renderFrame();
  if (!tree) {
    stopPanelScroll();
    treeView.replaceChildren(); graph = { nodes: [], edges: [], bounds: null }; renderedRoot = null;
    openPanels.clear(); cards.clear(); paintedPositions.clear(); storyCards.replaceChildren(); pathCount.textContent = '0 个节点';
    previewId = null; previewDeck = null;
    storyCards.style.paddingTop = ''; storyCards.style.paddingBottom = '';
    resumeButton.hidden = true; stopButton.hidden = true;
    statsView.textContent = '一个念头，万千可能';
    document.querySelector('#progress-fill').style.width = '0%';
    storyTitle.textContent = '从真实的故事，走向另一种可能';
    setDrawer(drawerOpen); return;
  }
  const { pending, ended, capped, deepest, stage } = leafStats();
  storyTitle.textContent = '故事的起点';
  const limit = roundLimit();
  statsView.textContent = `${stage ? `阶段 ${stage}/3 · ${deepest} 层` : `${deepest} / ${limit} 轮`} · ${ended} 条已结束 · ${pending.length} 条待延伸${capped ? ` · ${capped} 条${stage ? '开放结尾' : '达目标'}` : ''}`;
  document.querySelector('#progress-fill').style.width = `${stage ? (pending.length ? (stage - 1) / 3 * 100 : 100) : Math.min(100, deepest / limit * 100)}%`;
  resumeButton.hidden = autoRunning || (trialEnabled && !tree.id) || (!rebuildCandidate && pending.length === 0);
  resumeButton.textContent = rebuildCandidate ? '继续重建' : '继续推演';
  document.querySelector('#restore-old').hidden = !localStorage.getItem(BACKUP_KEY);
  stopButton.hidden = !autoRunning;
  form.elements.scenario.value = tree.scenario;
  form.elements.context.value = tree.context || '';
  renderMap();
  setDrawer(drawerOpen);
}

function showRoot() {
  stopCamera();
  view = { k: 1, x: Math.min(150, treeScroll.clientWidth * 0.13), y: treeScroll.clientHeight / 2 };
  if (openPanels.size) renderMap({ focusId: 'r' });
  applyView();
}

let drag = null;
let suppressClick = false;
treeScroll.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  stopCamera();
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false };
  suppressClick = false;
});
treeScroll.addEventListener('pointermove', event => {
  if (!drag || drag.id !== event.pointerId) return;
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 5) return;
  if (!drag.moved) treeScroll.setPointerCapture(event.pointerId);
  drag.moved = true; suppressClick = true;
  treeScroll.classList.add('dragging');
  view.x = drag.vx + dx; view.y = drag.vy + dy; scheduleView();
});
function finishDrag(event) {
  if (!drag || drag.id !== event.pointerId) return;
  if (!drag.moved && event.target === treeScroll) waterSurface.emitAtScreen(event.clientX, event.clientY);
  if (treeScroll.hasPointerCapture(event.pointerId)) treeScroll.releasePointerCapture(event.pointerId);
  treeScroll.classList.remove('dragging'); drag = null;
  setTimeout(() => { suppressClick = false; }, 0);
}
treeScroll.addEventListener('pointerup', finishDrag);
treeScroll.addEventListener('pointercancel', finishDrag);
let zoomLayoutTimer = 0;
function scheduleZoomLayout(focusId) {
  clearTimeout(zoomLayoutTimer);
  zoomLayoutTimer = setTimeout(() => renderMap({ focusId }), 150);
}
treeScroll.addEventListener('wheel', event => {
  event.preventDefault();
  stopCamera();
  const rect = treeScroll.getBoundingClientRect();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
  const deltaX = event.deltaX * unit;
  const deltaY = event.deltaY * unit;
  if (!event.ctrlKey) {
    view.x -= deltaX;
    view.y -= deltaY;
    scheduleView();
    return;
  }
  const pointX = (event.clientX - rect.left - view.x) / view.k;
  const pointY = (event.clientY - rect.top - view.y) / view.k;
  const nearest = graph.nodes.reduce((best, n) => !best || Math.hypot(n.x - pointX, n.y - pointY) < Math.hypot(best.x - pointX, best.y - pointY) ? n : best, null);
  const next = zoomAt(view, view.k * Math.exp(-Math.max(-200, Math.min(200, deltaY)) * .002), event.clientX - rect.left, event.clientY - rect.top);
  if (next.k === view.k) return;
  view = next;
  scheduleView();
  scheduleZoomLayout(nearest?.id);
}, { passive: false });
function zoomBy(factor) {
  stopCamera();
  const pointX = (treeScroll.clientWidth / 2 - view.x) / view.k;
  const pointY = (treeScroll.clientHeight / 2 - view.y) / view.k;
  const nearest = graph.nodes.reduce((best, n) => !best || Math.hypot(n.x - pointX, n.y - pointY) < Math.hypot(best.x - pointX, best.y - pointY) ? n : best, null);
  const next = zoomAt(view, view.k * factor, treeScroll.clientWidth / 2, treeScroll.clientHeight / 2);
  if (next.k === view.k) return;
  view = next;
  applyView();
  scheduleZoomLayout(nearest?.id);
}
treeScroll.addEventListener('keydown', event => {
  if (event.target !== treeScroll) return;
  const moves = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] };
  if (moves[event.key]) { event.preventDefault(); stopCamera(); view.x += moves[event.key][0]; view.y += moves[event.key][1]; applyView(); }
  if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomBy(1.2); }
  if (event.key === '-') { event.preventDefault(); zoomBy(1 / 1.2); }
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (openPanels.size) closeFromDepth(Math.max(...openPanels.keys()));
  else if (drawerOpen) setDrawer(false);
});
document.querySelector('#zoom-in').addEventListener('click', () => zoomBy(1.2));
document.querySelector('#zoom-out').addEventListener('click', () => zoomBy(1 / 1.2));
drawerToggle.addEventListener('click', () => setDrawer(!drawerOpen));
window.addEventListener('resize', () => { applyView(); });
for (const input of modeInputs) input.addEventListener('change', updateModeControl);

function validateStoryInput(field, errorView, message) {
  const valid = !!field.value.trim();
  field.setAttribute('aria-invalid', String(!valid));
  errorView.textContent = valid ? '' : message;
  return valid;
}

for (const [field, errorView] of [
  [form.elements.context, contextError],
  [form.elements.scenario, scenarioError],
]) field.addEventListener('input', () => {
  if (field.value.trim()) {
    field.setAttribute('aria-invalid', 'false');
    errorView.textContent = '';
  }
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || tree || !ready) return;
  const scenario = form.elements.scenario.value.trim();
  const context = form.elements.context.value.trim();
  const contextValid = validateStoryInput(form.elements.context, contextError, '请先说出你的故事');
  const scenarioValid = validateStoryInput(form.elements.scenario, scenarioError, '请写下你的“如果”');
  if (!contextValid || !scenarioValid) {
    (contextValid ? form.elements.scenario : form.elements.context).focus();
    return;
  }
  const mode = selectedMode();
  try {
    tree = trialEnabled ? await createTrialStory({ scenario, context, mode }) : {
      scenario, context, mode, targetDepth: SUBTREE_MODES[mode].depth, generationVersion: GENERATION_VERSION, generationStrategy: SUBTREE_STRATEGY,
      root: { title: scenario, story: '', terminal: false, children: [] },
    };
  } catch (error) {
    status.textContent = error.message;
    return;
  }
  if (!replaceStoredStory(tree)) {
    await abandonUnsavedStory(tree);
    tree = null;
    status.textContent = '本机保存空间不足，无法开始推演。';
    return;
  }
  status.textContent = '你的故事正在汇聚成一枚星光……';
  await enterStarMap();
  await runAuto();
});

resumeButton.addEventListener('click', () => rebuildCandidate
  ? runAuto({ source: rebuildCandidate, key: REBUILD_KEY, rebuilding: true }) : runAuto());

async function rerunCurrentStory() {
  if (busy || !tree || !ready) return;
  const previous = tree;
  const mode = selectedMode();
  try {
    if (trialEnabled && trialInfo?.activeStoryId) throw new Error('当前故事尚未完成，请先继续推演；重新推演会新建一个故事');
    tree = trialEnabled ? await createTrialStory({ scenario: previous.scenario, context: previous.context || '', mode }) : {
      scenario: previous.scenario, context: previous.context || '', frame: previous.frame,
      mode, targetDepth: SUBTREE_MODES[mode].depth, generationVersion: GENERATION_VERSION, generationStrategy: SUBTREE_STRATEGY,
      root: { title: previous.scenario, story: '', terminal: false, children: [] },
    };
  } catch (error) {
    status.textContent = error.message;
    return;
  }
  if (!replaceStoredStory(tree)) {
    await abandonUnsavedStory(tree);
    tree = null;
    render();
    status.textContent = '本机保存空间不足，无法重新推演。';
    return;
  }
  render();
  rebuildCandidate = null;
  localStorage.removeItem(REBUILD_KEY);
  showRoot();
  setDrawer(false);
  await runAuto();
}

rerunButton.addEventListener('click', rerunCurrentStory);
applyModeButton.addEventListener('click', rerunCurrentStory);
stopButton.addEventListener('click', () => {
  stopRequested = true;
  stopButton.disabled = true;
  status.textContent = '当前请求完成后暂停。';
});
clearButton.addEventListener('click', async () => {
  if (busy) return;
  if (trialEnabled && tree?.id) {
    try {
      await trialFetch(`/trial/stories/${tree.id}/abandon`, { method: 'POST', body: '{}' });
      await refreshTrialStatus();
    } catch (error) {
      if (error.status !== 404) {
        status.textContent = error.message;
        return;
      }
    }
  }
  tree = null;
  rebuildCandidate = null;
  localStorage.setItem(ACTIVE_STORY_KEY, crypto.randomUUID());
  clearStoredStories();
  form.elements.scenario.value = '';
  form.elements.context.value = '';
  form.elements.scenario.setAttribute('aria-invalid', 'false');
  form.elements.context.setAttribute('aria-invalid', 'false');
  scenarioError.textContent = '';
  contextError.textContent = '';
  selectMode('normal');
  render();
  status.textContent = '可以说出新的故事，再写下一个“如果”。';
  setDrawer(true);
});
document.querySelector('#jump-root').addEventListener('click', showRoot);
document.querySelector('#restore-old').addEventListener('click', () => {
  if (busy) return;
  try {
    const backup = JSON.parse(localStorage.getItem(BACKUP_KEY));
    if (!backup?.root) throw new Error('备份无法读取');
    backup.generationVersion = GENERATION_VERSION;
    const legacy = !Object.hasOwn(backup, 'mode');
    backup.mode = normalizeMode(backup.mode);
    backup.targetDepth = normalizeDepth(backup.targetDepth ?? (legacy ? 10 : undefined), backup.mode);
    if (!saveTree(backup)) throw new Error('本机保存空间不足');
    tree = backup;
    selectMode(tree.mode);
    rebuildCandidate = null;
    localStorage.removeItem(REBUILD_KEY);
    render(); showRoot();
    status.textContent = '已恢复旧版故事。';
  } catch (error) { status.textContent = `恢复失败：${error.message}`; }
});

render();
window.addEventListener('storage', event => {
  if (event.key !== ACTIVE_STORY_KEY && event.key !== STORAGE_KEY) return;
  tree = loadTree();
  if (tree) selectMode(tree.mode);
  render();
  status.textContent = tree ? '另一个标签页已更新当前故事。' : '另一个标签页已清除当前故事。';
});
if (tree) {
  const { pending, capped } = leafStats();
  status.textContent = pending.length ? '已恢复故事。点击「继续推演」探索剩余走向。'
    : capped ? isSubtreeStrategy(tree.generationStrategy) ? '已恢复故事树；部分故事线保留开放结尾。' : `已恢复故事树；部分故事线到达 ${roundLimit()} 轮目标。` : '已恢复完整的故事树。';
}
try {
  const response = await fetch('/config');
  const config = await response.json();
  trialEnabled = config.trial === true;
  siteReady = config.ready === true;
  siteModel = config.model || '';
  ready = siteReady || (trialEnabled && hasOwnApiConfig());
  modelInfo.textContent = siteReady ? `本站模型 · ${siteModel}` : '尚未配置模型 API';
  if (trialEnabled) {
    keyMenuButton.hidden = false;
    const guest = await trialFetch('/trial/guest', { method: 'POST', body: JSON.stringify({ token: guestToken }) });
    guestToken = guest.token;
    localStorage.setItem(GUEST_KEY, guestToken);
    await refreshTrialStatus();
    if (trialInfo.currentStoryId && tree?.id !== trialInfo.currentStoryId) {
      tree = null;
      localStorage.setItem(ACTIVE_STORY_KEY, crypto.randomUUID());
      clearStoredStories();
    }
    if (trialInfo.activeStoryId && tree?.id === trialInfo.activeStoryId) {
      selectMode(tree.mode);
      drawerOpen = false;
      status.textContent = '已恢复本浏览器保存的故事，可以继续推演。';
    } else if (trialInfo.activeStoryId && !tree) {
      await trialFetch(`/trial/stories/${trialInfo.activeStoryId}/abandon`, { method: 'POST', body: '{}' });
      await refreshTrialStatus();
      status.textContent = '本浏览器没有保存上次的故事，已清除无法续算的任务。';
    } else if (tree?.id) {
      selectMode(tree.mode);
    }
  }
} catch (error) {
  modelInfo.textContent = '本机模型连接失败或访客身份无法恢复';
  status.textContent = `访客初始化失败：${error.message}`;
  ready = false;
}
render();
if (tree) showRoot();
startRebuildIfNeeded();
maybePromptForKey();
