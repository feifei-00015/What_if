export function convergenceDepth(targetDepth) {
  return Math.ceil(targetDepth * 2 / 3);
}

export function generationPhase(depth, targetDepth) {
  return depth < convergenceDepth(targetDepth) ? 'explore' : 'converge';
}

export function plannedLevels(depth, targetDepth, batchLevels) {
  if (depth >= targetDepth) return 0;
  return generationPhase(depth, targetDepth) === 'explore'
    ? Math.min(batchLevels, convergenceDepth(targetDepth) - depth)
    : targetDepth - depth;
}

export function storyProgress(root, targetDepth) {
  const early = [];
  const late = [];
  let ended = 0;
  let capped = 0;
  let deepest = 0;
  const queue = [{ node: root, path: [] }];
  for (const current of queue) {
    const { node, path } = current;
    deepest = Math.max(deepest, path.length);
    if (node.children.length) {
      for (const child of node.children) queue.push({ node: child, path: [...path, child] });
    } else if (node.terminal) ended++;
    else if (path.length >= targetDepth) capped++;
    else if (generationPhase(path.length, targetDepth) === 'explore') early.push(current);
  }
  function visit(node, path) {
    if (node.children.length) {
      for (const child of node.children) visit(child, [...path, child]);
    } else if (!node.terminal && path.length < targetDepth &&
        generationPhase(path.length, targetDepth) === 'converge') {
      late.push({ node, path });
    }
  }
  visit(root, []);
  return { pending: [...early, ...late], ended, capped, deepest, exploring: early.length };
}

// Model output stays five-field JSON; this version and stage are storage metadata.
export const PREVIOUS_SUBTREE_STRATEGY = 'three-stage-v1';
export const SUBTREE_STRATEGY = 'three-stage-v2';
const PREVIOUS_SUBTREE_MODES = {
  light: { depth: 8, stages: [[2, 3, 4, 6], [2, 2, 2, 3], [2, 3, 1, 2]] },
  normal: { depth: 10, stages: [[3, 3, 6, 10], [3, 3, 3, 5], [2, 4, 1, 2]] },
  deep: { depth: 12, stages: [[3, 4, 10, 14], [4, 4, 4, 5], [3, 4, 1, 2]] },
};
export const SUBTREE_MODES = {
  light: { depth: 8, stages: [[2, 3, 4, 5], [2, 2, 2, 3], [2, 3, 1, 2]] },
  normal: { depth: 10, stages: [[3, 3, 6, 8], [3, 3, 3, 4], [2, 4, 1, 2]] },
  deep: { depth: 12, stages: [[3, 4, 9, 11], [4, 4, 3, 4], [3, 4, 1, 2]] },
};

export function isSubtreeStrategy(value) {
  return value === SUBTREE_STRATEGY || value === PREVIOUS_SUBTREE_STRATEGY;
}

export function subtreeTask(mode, stage, strategy = SUBTREE_STRATEGY) {
  const modes = strategy === PREVIOUS_SUBTREE_STRATEGY ? PREVIOUS_SUBTREE_MODES : SUBTREE_MODES;
  const spec = modes[mode]?.stages[stage - 1];
  if (!spec) return null;
  const [minLevels, levels, minLeaves, maxLeaves] = spec;
  return { stage, strategy, minLevels, levels, minLeaves, maxLeaves, maxNodes: levels * maxLeaves };
}

export function markSubtreeStage(branches, stage) {
  for (const node of branches) {
    node.generationStage = stage;
    markSubtreeStage(node.children, stage);
  }
  return branches;
}

export function subtreeProgress(root) {
  const pending = [];
  let ended = 0, capped = 0, deepest = 0;
  function visit(node, path) {
    deepest = Math.max(deepest, path.length);
    if (node.children.length) {
      for (const child of node.children) visit(child, [...path, child]);
    } else if (node.terminal) ended++;
    else if ((node.generationStage || 0) >= 3) capped++;
    else pending.push({ node, path, stage: (node.generationStage || 0) + 1 });
  }
  visit(root, []);
  // Stable ordering: complete a stage's frontier in tree order before the next stage.
  pending.sort((a, b) => a.stage - b.stage);
  const stage = pending[0]?.stage || 3;
  return { pending, ended, capped, deepest, stage,
    exploring: pending.filter(item => item.stage === stage).length };
}
