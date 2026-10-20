export function layoutTree(root, { openIds = [], scale = 1 } = {}) {
  const open = new Set(openIds);
  const zoom = Math.max(0.06, scale);
  const nodes = [];
  const edges = [];
  const layers = [];
  const columnGap = Math.max(310, 270 / zoom);
  const rowGap = Math.max(120, 105 / zoom);
  function collect(node, id, depth, parent = null, siblingIndex = 0, siblingCount = 1) {
    const x = parent ? parent.x + columnGap + Math.min(75, (depth - 1) * 15) / zoom +
      (open.has(parent.id) ? 95 / zoom : 0) : 0;
    const entry = { node, id, depth, parent, x, y: 0, siblingIndex, siblingCount };
    nodes.push(entry);
    if (parent) edges.push({ from: parent, to: entry });
    (layers[depth] ||= []).push(entry);
    node.children.forEach((child, i) => collect(child, `${id}.${i}`, depth + 1, entry, i, node.children.length));
  }
  collect(root, 'r', 0);

  // Place one depth at a time: distant descendants must not pull the first choices apart.
  for (const layer of layers.slice(1)) {
    const spacing = rowGap + Math.min(60, (layer[0].depth - 1) * 12) / zoom;
    const blocks = [];
    let offset = 0;
    for (let i = 0; i < layer.length; i++) {
      const entry = layer[i];
      const previous = layer[i - 1];
      if (previous) offset += spacing +
        (entry.parent !== previous.parent ? 75 / zoom : 0) + (
        open.has(entry.id) || open.has(previous.id) ||
        (entry.parent === previous.parent && open.has(entry.parent.id)) ? 25 / zoom : 0);
      const parent = entry.parent;
      const trajectory = parent.parent ? (parent.y - parent.parent.y) * 0.35 : 0;
      const desired = parent.y + trajectory + (entry.siblingIndex - (entry.siblingCount - 1) / 2) * spacing;
      blocks.push({ start: i, end: i, sum: desired - offset, count: 1 });
      // Merge overlapping groups, keeping each layer close to its parents without label collisions.
      while (blocks.length > 1 && blocks.at(-2).sum / blocks.at(-2).count > blocks.at(-1).sum / blocks.at(-1).count) {
        const last = blocks.pop();
        const prior = blocks.at(-1);
        prior.end = last.end;
        prior.sum += last.sum;
        prior.count += last.count;
      }
      entry.offset = offset;
    }
    for (const block of blocks) {
      const position = block.sum / block.count;
      for (let i = block.start; i <= block.end; i++) layer[i].y = position + layer[i].offset;
    }
  }
  return { nodes, edges, bounds: {
    left: -Math.max(100, 40 / zoom),
    right: Math.max(...nodes.map(n => n.x + Math.max(240, (open.has(n.id) ? 360 : 150) / zoom))),
    top: Math.min(...nodes.map(n => n.y)) - Math.max(90, 50 / zoom),
    bottom: Math.max(...nodes.map(n => n.y)) + Math.max(90, 50 / zoom),
  } };
}

export function zoomAt(view, scale, x, y) {
  const k = Math.max(0.3, Math.min(1, scale));
  return { k, x: x - (x - view.x) * k / view.k, y: y - (y - view.y) * k / view.k };
}
