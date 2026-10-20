const NS = 'http://www.w3.org/2000/svg';
const OFFSETS = [[-8, -5.5], [-6, -8], [-3.8, -2], [-1.4, -2.2], [1.4, 2.2], [3.8, 2], [6, 8], [8, 5.5]];

function path(from, first, second, to) {
  return `M ${from.x} ${from.y} C ${first.x} ${first.y}, ${second.x} ${second.y}, ${to.x} ${to.y}`;
}

function makeEdge(svg, motionSvg, from, to, onSelect) {
  const group = document.createElementNS(NS, 'g');
  group.classList.add('edge');
  group.dataset.from = from.id;
  group.dataset.to = to.id;
  if (to.node.terminal) group.classList.add('ending');
  const addPath = name => {
    const line = document.createElementNS(NS, 'path');
    line.classList.add(name);
    group.append(line);
    return line;
  };
  const halo = addPath('beam-halo');
  const glow = addPath('beam-glow');
  const threads = OFFSETS.map((_, index) => {
    const thread = addPath('beam-thread');
    if (index === 3 || index === 4) thread.classList.add('beam-thread-center');
    return thread;
  });
  const hit = addPath('beam-hit');
  hit.addEventListener('pointerdown', event => event.stopPropagation());
  hit.addEventListener('click', event => { event.stopPropagation(); onSelect(to); });
  svg.append(group);
  const motionGroup = document.createElementNS(NS, 'g');
  motionGroup.classList.add('edge', 'beam-motion-edge');
  const runner = document.createElementNS(NS, 'g');
  runner.classList.add('beam-runner');
  const highlight = document.createElementNS(NS, 'path');
  highlight.classList.add('beam-highlight-main');
  highlight.setAttribute('d', 'M -18 0 L 8 0');
  runner.append(highlight);
  const motion = document.createElementNS(NS, 'animateMotion');
  motion.setAttribute('begin', 'indefinite');
  motion.setAttribute('dur', '6.4s');
  motion.setAttribute('repeatCount', 'indefinite');
  motion.setAttribute('rotate', 'auto');
  runner.append(motion);
  motionGroup.append(runner);
  motionSvg.append(motionGroup);
  let active = false;
  let guided = false;
  let started = false;
  let offscreen = false;
  let endpoints;
  const updateMotion = () => {
    if (!(active || guided) && started) {
      motion.endElement();
      started = false;
    } else if ((active || guided) && endpoints && !started && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      motion.beginElement();
      started = true;
    }
  };

  return {
    from, to,
    setActive(value) {
      active = value;
      group.classList.toggle('active', value);
      motionGroup.classList.toggle('active', value);
      updateMotion();
    },
    setGuided(value) {
      guided = value;
      group.classList.toggle('guided', value);
      motionGroup.classList.toggle('guided', value);
      updateMotion();
    },
    setViewport(view, rect) {
      if (!endpoints) return;
      const [a, b] = endpoints;
      const margin = 24 + 60 * view.k;
      const hidden = Math.max(a.x, b.x) * view.k + view.x < -margin
        || Math.min(a.x, b.x) * view.k + view.x > rect.width + margin
        || Math.max(a.y, b.y) * view.k + view.y < -margin
        || Math.min(a.y, b.y) * view.k + view.y > rect.height + margin;
      if (hidden !== offscreen) {
        group.style.display = hidden ? 'none' : '';
        motionGroup.style.display = hidden ? 'none' : '';
        offscreen = hidden;
      }
    },
    paint(a, b) {
      endpoints = [a, b];
      const dx = b.x - a.x, dy = b.y - a.y;
      const length = Math.max(1, Math.hypot(dx, dy));
      const direction = { x: dx / length, y: dy / length };
      const side = dy < 0 ? -1 : 1;
      const start = { x: a.x + 22 * .82, y: a.y + side * 22 * .57 };
      const end = { x: b.x - direction.x * 18, y: b.y - direction.y * 18 };
      const reach = end.x - start.x;
      const bend = Math.min(48, Math.max(18, Math.abs(reach) * .12));
      const first = { x: start.x + reach * .37, y: start.y + side * bend };
      const second = { x: end.x - reach * .31, y: end.y + side * bend * .75 };
      const center = path(start, first, second, end);
      for (const line of [halo, glow, hit]) line.setAttribute('d', center);
      motion.setAttribute('path', center);
      updateMotion();
      const normal = { x: -direction.y, y: direction.x };
      for (const [index, thread] of threads.entries()) {
        const [one, two] = OFFSETS[index];
        thread.setAttribute('d', path(start,
          { x: first.x + normal.x * one, y: first.y + normal.y * one },
          { x: second.x + normal.x * two, y: second.y + normal.y * two }, end));
      }
    },
  };
}

export function createStoryBeams(edges, onSelect) {
  const svg = document.createElementNS(NS, 'svg');
  svg.classList.add('filaments');
  svg.setAttribute('width', '1');
  svg.setAttribute('height', '1');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<defs>
    <linearGradient id="story-beam-gradient" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#dff5f2" stop-opacity=".12"/>
      <stop offset=".48" stop-color="#b7d5d6" stop-opacity=".62"/>
      <stop offset="1" stop-color="#d9ece8" stop-opacity=".18"/>
    </linearGradient>
  </defs>`;
  const motionSvg = document.createElementNS(NS, 'svg');
  motionSvg.classList.add('filaments', 'beam-motion-layer');
  motionSvg.setAttribute('width', '1');
  motionSvg.setAttribute('height', '1');
  motionSvg.setAttribute('aria-hidden', 'true');
  motionSvg.innerHTML = `<defs>
    <linearGradient id="story-beam-highlight" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff8df" stop-opacity="0"/>
      <stop offset=".55" stop-color="#fff5d2" stop-opacity=".92"/>
      <stop offset="1" stop-color="#dda958" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="story-beam-guide-highlight" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#e8e1ef" stop-opacity="0"/>
      <stop offset=".55" stop-color="#e8e1ef" stop-opacity=".8"/>
      <stop offset="1" stop-color="#bfb3d0" stop-opacity="0"/>
    </linearGradient>
  </defs>`;
  return { svg, motionSvg, beams: edges.map(({ from, to }) => makeEdge(svg, motionSvg, from, to, onSelect)) };
}
