const IMAGE_WIDTH = 7680;
const IMAGE_HEIGHT = 4320;
const MAX_RIPPLES = 18;
const RIPPLE_RADIUS = 400;
const REFRACTION_STRENGTH = .9;
const PREVIEW_ZOOM = .36;
const BACKGROUND_OVERSCAN = 24;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

const vertexSource = `
  attribute vec2 a_position;
  void main() { gl_Position = vec4(a_position, 0.0, 1.0); }
`;

const fragmentSource = `
  precision highp float;
  uniform sampler2D u_pond;
  uniform vec2 u_resolution;
  uniform vec2 u_viewport;
  uniform vec2 u_origin;
  uniform float u_backgroundZoom;
  uniform float u_effectZoom;
  uniform vec2 u_centers[${MAX_RIPPLES}];
  uniform float u_ages[${MAX_RIPPLES}];

  void main() {
    vec2 screen = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y)
      * u_viewport / u_resolution;
    vec2 displacement = vec2(0.0);
    float caustic = 0.0;
    float radius = ${RIPPLE_RADIUS.toFixed(1)} * u_effectZoom;
    for (int i = 0; i < ${MAX_RIPPLES}; i++) {
      float age = u_ages[i];
      if (age < 0.0 || age > 2.8) continue;
      vec2 delta = screen - u_centers[i];
      float distanceSquared = dot(delta, delta);
      if (distanceSquared >= radius * radius) continue;
      float distance = sqrt(distanceSquared);
      float front = age * radius / 2.6;
      float band = max(5.0, radius * .12);
      float wake = smoothstep(-band, band * .2, front - distance)
        * exp(-max(0.0, front - distance) / max(8.0, radius * .11));
      float edgeFade = 1.0 - smoothstep(radius * .48, radius, distance);
      float life = 1.0 - smoothstep(2.0, 2.8, age);
      float ripple = sin((distance - front) * .085 / max(.4, u_effectZoom))
        * wake * edgeFade * life;
      displacement += delta / max(distance, 1.0) * ripple * ${REFRACTION_STRENGTH.toFixed(1)} * 18.0 * u_effectZoom;
      caustic += max(0.0, ripple) * .012;
    }
    vec2 world = (screen + displacement - u_origin) / u_backgroundZoom;
    vec2 uv = world / vec2(${IMAGE_WIDTH.toFixed(1)}, ${IMAGE_HEIGHT.toFixed(1)}) + .5;
    vec3 water = texture2D(u_pond, uv).rgb + caustic * vec3(.7, 1.0, .9);
    gl_FragColor = vec4(water, 1.0);
  }
`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

export function createWaterSurface(canvas) {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let view = { x: 0, y: 0, k: 1 };
  let rect = { left: 0, top: 0, width: innerWidth, height: innerHeight };
  let selected = new Map();
  let transient = [];
  let frame = 0;
  let draw = () => { frame = 0; };
  const requestDraw = () => { if (!frame) frame = requestAnimationFrame(now => draw(now)); };

  async function start() {
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false });
    if (!gl) return; // The CSS image remains visible when WebGL is unavailable.
    const image = new Image();
    image.src = './assets/memory-star-map-8k.jpg';
    await image.decode();
    if (gl.getParameter(gl.MAX_TEXTURE_SIZE) < Math.max(IMAGE_WIDTH, IMAGE_HEIGHT)) return;

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const uniforms = Object.fromEntries(['u_pond', 'u_resolution', 'u_viewport', 'u_origin', 'u_backgroundZoom', 'u_effectZoom', 'u_centers[0]', 'u_ages[0]']
      .map(name => [name, gl.getUniformLocation(program, name)]));
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(uniforms.u_pond, 0);

    draw = now => {
      frame = 0;
      const dpr = Math.min(devicePixelRatio || 1, 1.25);
      const width = Math.round(innerWidth * dpr), height = Math.round(innerHeight * dpr);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width; canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
      const centers = new Float32Array(MAX_RIPPLES * 2);
      const ages = new Float32Array(MAX_RIPPLES).fill(-1);
      transient = transient.filter(node => now - node.born < 2800);
      let activeWaves = 0;
      if (!reducedMotion.matches) {
        const visible = [...selected.values()].filter(node => {
          const x = rect.left + view.x + node.x * view.k;
          const y = rect.top + view.y + node.y * view.k;
          const reach = RIPPLE_RADIUS * PREVIEW_ZOOM * view.k;
          return x > -reach && x < innerWidth + reach && y > -reach && y < innerHeight + reach;
        }).sort((a, b) => {
          const distance = node => Math.hypot(
            rect.left + view.x + node.x * view.k - innerWidth / 2,
            rect.top + view.y + node.y * view.k - innerHeight / 2);
          return distance(b) - distance(a);
        });
        const waves = [...visible.slice(-MAX_RIPPLES), ...transient].slice(0, MAX_RIPPLES);
        activeWaves = waves.length;
        for (const [index, node] of waves.entries()) {
          centers[index * 2] = rect.left + view.x + node.x * view.k;
          centers[index * 2 + 1] = rect.top + view.y + node.y * view.k;
          const age = (now - node.born) / 1000;
          ages[index] = node.once ? age : age % 2.8;
        }
      }
      gl.uniform2f(uniforms.u_resolution, width, height);
      gl.uniform2f(uniforms.u_viewport, innerWidth, innerHeight);
      const backgroundZoom = Math.max(
        (innerWidth + BACKGROUND_OVERSCAN * 2) / IMAGE_WIDTH,
        (innerHeight + BACKGROUND_OVERSCAN * 2) / IMAGE_HEIGHT,
        PREVIEW_ZOOM * view.k,
      );
      const halfWidth = IMAGE_WIDTH * backgroundZoom / 2;
      const halfHeight = IMAGE_HEIGHT * backgroundZoom / 2;
      const originX = clamp(
        innerWidth / 2 + view.x - Math.min(150, rect.width * .13),
        innerWidth + BACKGROUND_OVERSCAN - halfWidth,
        halfWidth - BACKGROUND_OVERSCAN,
      );
      const originY = clamp(
        innerHeight / 2 + view.y - rect.height / 2,
        innerHeight + BACKGROUND_OVERSCAN - halfHeight,
        halfHeight - BACKGROUND_OVERSCAN,
      );
      gl.uniform2f(uniforms.u_origin, originX, originY);
      gl.uniform1f(uniforms.u_backgroundZoom, backgroundZoom);
      gl.uniform1f(uniforms.u_effectZoom, PREVIEW_ZOOM * view.k);
      gl.uniform2fv(uniforms['u_centers[0]'], centers);
      gl.uniform1fv(uniforms['u_ages[0]'], ages);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      canvas.classList.add('ready');
      if (activeWaves && !document.hidden) requestDraw();
    };
    requestDraw();
  }

  start().catch(() => { canvas.classList.remove('ready'); });
  reducedMotion.addEventListener('change', requestDraw);
  document.addEventListener('visibilitychange', requestDraw);
  return {
    setView(nextView, nextRect) {
      view = { ...nextView };
      rect = { left: nextRect.left, top: nextRect.top, width: nextRect.width, height: nextRect.height };
      requestDraw();
    },
    setSelected(nodes) {
      const now = performance.now();
      selected = new Map(nodes.map(node => [node.id, {
        x: node.x, y: node.y, born: selected.get(node.id)?.born ?? now,
      }]));
      requestDraw();
    },
    emitAtWorld(x, y) {
      if (reducedMotion.matches) return;
      transient.push({ x, y, born: performance.now(), once: true });
      transient = transient.slice(-MAX_RIPPLES);
      requestDraw();
    },
    emitAtScreen(x, y) {
      this.emitAtWorld((x - rect.left - view.x) / view.k, (y - rect.top - view.y) / view.k);
    },
  };
}
