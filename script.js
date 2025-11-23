import {
  mat4,
  vec3,
  vec4,
  quat,
} from "https://cdn.jsdelivr.net/npm/gl-matrix@3.4.3/esm/index.js";

const canvas = document.getElementById("glCanvas");
const gl = canvas.getContext("webgl");
if (!gl) throw new Error("WebGL not supported");

// --- resize / projection helpers ---
function resizeCanvasToDisplaySize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.floor(window.innerWidth * dpr);
  const h = Math.floor(window.innerHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}
window.addEventListener("resize", () => {
  resizeCanvasToDisplaySize();
  updateProjection();
});
resizeCanvasToDisplaySize();

const projection = mat4.create();
function updateProjection() {
  mat4.perspective(
    projection,
    Math.PI / 4,
    canvas.width / canvas.height,
    0.1,
    2000.0
  );
}
updateProjection();

// --- UI / interaction state ---
const tooltipEl = document.getElementById('tooltip');
let pointerX = 0, pointerY = 0; // client (CSS) pixels
let hoveredPlanet = null;
let lockedPlanet = null; // when set, camera will orbit/look at this planet
const cameraTarget = vec3.fromValues(0,0,0); // smoothed target

canvas.addEventListener('mousemove', (e) => {
  // keep pointer location for hover detection (CSS pixels)
  pointerX = e.clientX;
  pointerY = e.clientY;
});

canvas.addEventListener('click', (e) => {
  // on click, toggle lock to the currently hovered object (planet or sun)
  if (hoveredPlanet) {
    if (lockedPlanet && lockedPlanet.name === hoveredPlanet.name) lockedPlanet = null;
    else lockedPlanet = hoveredPlanet;
  }
});

// --- shaders (world-space lighting + emissive sun) ---
const vsSource = `
attribute vec3 aPosition;
attribute vec3 aNormal;
attribute vec2 aUV;
varying vec2 vUV;
uniform mat4 uModel;
uniform mat4 uVP;
varying vec3 vNormal;
varying vec3 vWorldPos;
void main() {
  vec4 worldPos = uModel * vec4(aPosition, 1.0);
  vWorldPos = worldPos.xyz;
  vNormal = mat3(uModel) * aNormal;
  vUV = aUV; // pass to fragment
  gl_Position = uVP * worldPos;
}
`;

const fsSource = `
precision mediump float;
varying vec3 vNormal;
varying vec2 vUV;
varying vec3 vWorldPos;
uniform vec3 uColor;
uniform sampler2D uTexture;
uniform float uUseTexture;
uniform float uEmissive;
uniform float uIsSky;
uniform float uSkyDim;
uniform float uSkyRepeat;
uniform float uSunIntensity;
uniform vec3 uSunPos;

void main(void) {
  if (uIsSky > 0.5) {
    vec2 skyUV = vec2(vUV.x * uSkyRepeat, vUV.y);
    vec4 texColor = texture2D(uTexture, skyUV);
    gl_FragColor = vec4(texColor.rgb * uSkyDim, texColor.a);
    return;
  }
  vec3 N = normalize(vNormal);
  // compute light direction from sun position to the fragment in world space
  vec3 lightDir = normalize(uSunPos - vWorldPos);
  float diffuse = max(dot(N, lightDir), 0.0);
  float ambient = 0.18;
  // optional distance attenuation for a softer, more physical falloff
  float dist = length(uSunPos - vWorldPos);
  float attenuation = 1.0 / (1.0 + 0.0015 * dist * dist);

  vec3 baseColor = uColor;

  if (uUseTexture > 0.5) {
    vec4 texColor = texture2D(uTexture, vUV);
    if (texColor.a < 0.1) discard;   // transparency for rings
    baseColor = texColor.rgb;
  }

  vec3 color = baseColor * (ambient + diffuse * uSunIntensity * attenuation);
  color += uEmissive * vec3(1.2, 1.0, 0.7) * attenuation;
  gl_FragColor = vec4(color, 1.0);
}


`;

// --- compile/link ---
function createShader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    console.error(gl.getShaderInfoLog(s));
  return s;
}
const vsh = createShader(gl.VERTEX_SHADER, vsSource);
const fsh = createShader(gl.FRAGMENT_SHADER, fsSource);
const program = gl.createProgram();
gl.attachShader(program, vsh);
gl.attachShader(program, fsh);
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS))
  console.error(gl.getProgramInfoLog(program));
gl.useProgram(program);

// --- sphere geometry (shared) ---
function createSphere(latBands, longBands, radius, invert = false) {
  const pos = [],
    norm = [],
    idx = [],
    uv = [];
  for (let lat = 0; lat <= latBands; lat++) {
    const theta = (lat * Math.PI) / latBands;
    const sinT = Math.sin(theta),
      cosT = Math.cos(theta);
    for (let lon = 0; lon <= longBands; lon++) {
      const phi = (lon * 2 * Math.PI) / longBands;
      const sinP = Math.sin(phi),
        cosP = Math.cos(phi);
      const x = cosP * sinT,
        y = cosT,
        z = sinP * sinT;
      const nx = invert ? -x : x;
      const ny = invert ? -y : y;
      const nz = invert ? -z : z;
      pos.push(radius * x, radius * y, radius * z);
      norm.push(nx, ny, nz);
      uv.push(lon / longBands, 1 - lat / latBands);
    }
  }
  for (let lat = 0; lat < latBands; lat++) {
    for (let lon = 0; lon < longBands; lon++) {
      const first = lat * (longBands + 1) + lon;
      const second = first + longBands + 1;
      if (invert) {
        idx.push(first, first + 1, second, second, first + 1, second + 1);
      } else {
        idx.push(first, second, first + 1, second, second + 1, first + 1);
      }
    }
  }
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(norm),
    uvs: new Float32Array(uv),
    indices: new Uint16Array(idx),
  };
}

function createRing(innerR, outerR, segments = 64) {
  const pos = [],
    uv = [],
    idx = [];

  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * 2 * Math.PI;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);

    // inner edge
    pos.push(innerR * cosT, 0, innerR * sinT);
    uv.push(0, i / segments);

    // outer edge
    pos.push(outerR * cosT, 0, outerR * sinT);
    uv.push(1, i / segments);

    // indices
    if (i < segments) {
      const base = i * 2;
      idx.push(base, base + 1, base + 2);
      idx.push(base + 1, base + 3, base + 2);
    }
  }

  return {
    positions: new Float32Array(pos),
    uvs: new Float32Array(uv),
    indices: new Uint16Array(idx),
  };
}

const sphere = createSphere(36, 36, 1.0);
const skySphere = createSphere(36, 36, 1.0, true);
// sky buffers (separate from the planet sphere buffers)
const skyPosBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, skyPosBuffer);
gl.bufferData(gl.ARRAY_BUFFER, skySphere.positions, gl.STATIC_DRAW);

const skyNormalBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, skyNormalBuffer);
gl.bufferData(gl.ARRAY_BUFFER, skySphere.normals, gl.STATIC_DRAW);

const skyIndexBuffer = gl.createBuffer();
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, skyIndexBuffer);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, skySphere.indices, gl.STATIC_DRAW);

const skyUVBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, skyUVBuffer);
gl.bufferData(gl.ARRAY_BUFFER, skySphere.uvs, gl.STATIC_DRAW);
const posBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
gl.bufferData(gl.ARRAY_BUFFER, sphere.positions, gl.STATIC_DRAW);

const normalBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
gl.bufferData(gl.ARRAY_BUFFER, sphere.normals, gl.STATIC_DRAW);

const indexBuffer = gl.createBuffer();
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sphere.indices, gl.STATIC_DRAW);

const uvBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
gl.bufferData(gl.ARRAY_BUFFER, sphere.uvs, gl.STATIC_DRAW);

const aUV = gl.getAttribLocation(program, "aUV");
gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);
gl.enableVertexAttribArray(aUV);

const ring = createRing(1.3, 2.5, 128); // base shape (we’ll scale later)
const ringPosBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, ringPosBuffer);
gl.bufferData(gl.ARRAY_BUFFER, ring.positions, gl.STATIC_DRAW);

const ringUVBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, ringUVBuffer);
gl.bufferData(gl.ARRAY_BUFFER, ring.uvs, gl.STATIC_DRAW);

const ringIndexBuffer = gl.createBuffer();
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ringIndexBuffer);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ring.indices, gl.STATIC_DRAW);

const saturnRingTex = loadTexture("textures/saturn_ring.png");
const galaxyTex = loadTexture("textures/space.png");
// --- Loading Textures for each planet ---

function loadTexture(url) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([255, 255, 255, 255])
  );

  function isPowerOf2(v) {
    return (v & (v - 1)) === 0;
  }
  function nextPowerOf2(v) {
    v--; v |= v >> 1; v |= v >> 2; v |= v >> 4; v |= v >> 8; v |= v >> 16; v++;
    return v;
  }

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    gl.bindTexture(gl.TEXTURE_2D, texture);

    // If image dimensions are already power-of-two we can use REPEAT and mipmaps.
    if (isPowerOf2(img.width) && isPowerOf2(img.height)) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    } else {
      // Resize non-power-of-two image to nearest power-of-two so we can repeat it.
      const cvs = document.createElement('canvas');
      cvs.width = nextPowerOf2(img.width);
      cvs.height = nextPowerOf2(img.height);
      const ctx = cvs.getContext('2d');
      ctx.drawImage(img, 0, 0, cvs.width, cvs.height);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cvs);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    }
  };
  img.onerror = () => {
    console.warn('Failed to load texture:', url);
  };
  img.src = url;

  return texture;
}

// --- locations ---
const aPosition = gl.getAttribLocation(program, "aPosition");
const aNormal = gl.getAttribLocation(program, "aNormal");
const uModel = gl.getUniformLocation(program, "uModel");
const uVP = gl.getUniformLocation(program, "uVP");
const uSunPos = gl.getUniformLocation(program, "uSunPos");
const uCameraPos = gl.getUniformLocation(program, "uCameraPos");
const uColor = gl.getUniformLocation(program, "uColor");
const uIsSun = gl.getUniformLocation(program, "uIsSun");
const uIsSky = gl.getUniformLocation(program, "uIsSky");
const uSkyDim = gl.getUniformLocation(program, "uSkyDim");
const uSkyRepeat = gl.getUniformLocation(program, "uSkyRepeat");
const uEmissiveLoc = gl.getUniformLocation(program, "uEmissive");
const uUseTextureLoc = gl.getUniformLocation(program, "uUseTexture");
const uTextureLoc = gl.getUniformLocation(program, "uTexture");
const uSunIntensityLoc = gl.getUniformLocation(program, "uSunIntensity");

// --- GL state ---
gl.enable(gl.DEPTH_TEST);
gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
gl.clearColor(0, 0, 0, 1);

// --- solar data (realistic tints, scaled) ---
const distanceScale = 6.0; // 1 AU -> 6 units (tweak visually)
const sizeScale = 0.28; // Earth = ~0.28 units
let orbitSlowdown = 0.5; // slow orbits by 50% (adjustable via UI)

// wire up orbit speed slider UI (if present)
const orbitSlider = document.getElementById('orbitSpeedSlider');
const orbitLabel = document.getElementById('orbitSpeedLabel');
const orbitPauseBtn = document.getElementById('orbitPauseBtn');
const orbitResetBtn = document.getElementById('orbitResetBtn');
const sunEmissiveSlider = document.getElementById('sunEmissiveSlider');
const sunEmissiveLabel = document.getElementById('sunEmissiveLabel');

// simulation time & pause state
let simTime = 0.0;
let lastRealTime = performance.now();
let paused = false;

// pending value while user drags the slider; applied on change (release)
let pendingOrbit = orbitSlowdown;

// sun emissive control (brightness coming from origin)
let sunEmissive = 2.0; // default emissive brightness for the Sun on load
if (sunEmissiveSlider && sunEmissiveLabel) {
  const updateSunLabel = (v) => {
    sunEmissiveLabel.textContent = `Sun Brightness: x${v.toFixed(1)}`;
  };
  sunEmissiveSlider.value = sunEmissive;
  updateSunLabel(sunEmissive);
  sunEmissiveSlider.addEventListener('input', (e) => {
    sunEmissive = parseFloat(e.target.value);
    updateSunLabel(sunEmissive);
  });
}

if (orbitSlider && orbitLabel) {
  const updateOrbitLabel = (v, preview = false) => {
    orbitLabel.textContent = `Time Dilation: x${v.toFixed(2)}`;
  };
  orbitSlider.value = orbitSlowdown;
  pendingOrbit = orbitSlowdown;
  updateOrbitLabel(orbitSlowdown);

  // while dragging, only update the label/preview
  orbitSlider.addEventListener('input', (e) => {
    pendingOrbit = parseFloat(e.target.value);
    updateOrbitLabel(pendingOrbit, true);
  });

  // apply the chosen speed when the user releases (change event)
  orbitSlider.addEventListener('change', (e) => {
    orbitSlowdown = parseFloat(e.target.value);
    pendingOrbit = orbitSlowdown;
    updateOrbitLabel(orbitSlowdown, false);
  });

  // Pause / Resume
  if (orbitPauseBtn) {
    orbitPauseBtn.addEventListener('click', () => {
      paused = !paused;
      orbitPauseBtn.textContent = paused ? 'Resume' : 'Pause';
      // reset lastRealTime so there's no big jump when resuming
      lastRealTime = performance.now();
    });
  }

  // Reset to default
  if (orbitResetBtn) {
    orbitResetBtn.addEventListener('click', () => {
      const def = 0.5;
      orbitSlider.value = def;
      orbitSlowdown = def;
      pendingOrbit = def;
      updateOrbitLabel(def, false);
      // reset sun emissive as well
      const sunDef = 2.0;
      sunEmissive = sunDef;
      if (sunEmissiveSlider) sunEmissiveSlider.value = sunDef;
      if (sunEmissiveLabel) sunEmissiveLabel.textContent = `Sun Brightness: x${sunDef.toFixed(1)}`;
    });
  }

  // Grid toggle button (if present in HTML)
  const gridToggleBtn = document.getElementById('gridToggleBtn');
  if (gridToggleBtn) {
    gridToggleBtn.addEventListener('click', () => {
      gridVisible = !gridVisible;
      gridToggleBtn.textContent = gridVisible ? 'Grid: On' : 'Grid: Off';
    });
  }
}

const planets = [
  {
    name: "Mercury",
    distAU: 0.39,
    size: 0.38,
    color: [0.68, 0.63, 0.58],
    period: 88,
  },
  {
    name: "Venus",
    distAU: 0.72,
    size: 0.95,
    color: [0.91, 0.78, 0.56],
    period: 225,
  },
  {
    name: "Earth",
    distAU: 1.0,
    size: 1.0,
    color: [0.18, 0.5, 0.86],
    period: 365,
    moons: [
      {
        name: "Moon",
        relDist: 0.004,
        size: 0.27,
        color: [0.8, 0.8, 0.82],
        period: 27,
      },
    ],
  },
  {
    name: "Mars",
    distAU: 1.52,
    size: 0.53,
    color: [0.86, 0.44, 0.31],
    period: 687,
    moons: [
      {
        name: "Phobos",
        relDist: 0.0015,
        size: 0.011,
        color: [0.6, 0.6, 0.6],
        period: 0.32,
      },
      {
        name: "Deimos",
        relDist: 0.003,
        size: 0.006,
        color: [0.7, 0.7, 0.7],
        period: 1.26,
      },
    ],
  },
  {
    name: "Jupiter",
    distAU: 5.2,
    size: 11.21,
    color: [0.9, 0.77, 0.6],
    period: 4333,
    moons: [
      {
        name: "Io",
        relDist: 0.0028,
        size: 0.285,
        color: [0.9, 0.7, 0.4],
        period: 1.77,
      },
      {
        name: "Europa",
        relDist: 0.0045,
        size: 0.245,
        color: [0.9, 0.95, 1.0],
        period: 3.55,
      },
      {
        name: "Ganymede",
        relDist: 0.007,
        size: 0.413,
        color: [0.8, 0.8, 0.75],
        period: 7.15,
      },
      {
        name: "Callisto",
        relDist: 0.012,
        size: 0.378,
        color: [0.7, 0.7, 0.65],
        period: 16.69,
      },
    ],
  },
  {
    name: "Saturn",
    distAU: 9.58,
    size: 9.45,
    color: [0.94, 0.86, 0.64],
    period: 10759,
    moons: [
      {
        name: "Titan",
        relDist: 0.02,
        size: 0.4,
        color: [0.87, 0.72, 0.55],
        period: 15.95,
      },
    ],
    hasRing: true,
  },
  {
    name: "Uranus",
    distAU: 19.2,
    size: 4.01,
    color: [0.6, 0.85, 0.92],
    period: 30687,
    moons: [
      {
        name: "Titania",
        relDist: 0.01,
        size: 0.15,
        color: [0.8, 0.8, 0.85],
        period: 8.7,
      },
    ],
  },
  {
    name: "Neptune",
    distAU: 30.05,
    size: 3.88,
    color: [0.3, 0.45, 0.8],
    period: 60190,
    moons: [
      {
        name: "Triton",
        relDist: 0.01,
        size: 0.22,
        color: [0.9, 0.9, 0.95],
        period: 5.88,
      },
    ],
  },
];

for (const p of planets) {
  p.phase = Math.random() * Math.PI * 2; // random start angle
  p.distance = p.distAU * distanceScale;
  p.visualSize = Math.max(0.04, p.size * sizeScale);

  p.texture = loadTexture(`textures/${p.name.toLowerCase()}.jpg`);

  if (p.moons) {
    for (const m of p.moons) {
      m.visualDist = Math.max(0.09, m.relDist * distanceScale * 35);
      m.visualSize = Math.max(0.01, m.size * sizeScale);
      m.texture = loadTexture(`textures/${m.name.toLowerCase()}.jpg`);
    }
  }
}

const sunColor = [1.0, 0.95, 0.7];
const sunRadius = 1.8;

  // --- asteroid belt (points) ---
  const ASTEROID_COUNT = 1400;
  const asteroids = new Array(ASTEROID_COUNT);
  for (let i = 0; i < ASTEROID_COUNT; i++) {
    // radius between ~2.2 and 3.5 AU (between Mars and Jupiter)
    const rAU = 2.2 + Math.random() * 1.6;
    const radius = rAU * distanceScale;
    const phase = Math.random() * Math.PI * 2;
    const speed = (0.6 + Math.random() * 0.8) * (0.5 / (rAU)); // slower further out
    const incl = (Math.random() - 0.5) * 0.06; // small inclination
    const sizePx = 0.8 + Math.random() * 1.6; // point size in pixels
    const gray = 0.4 + Math.random() * 0.4;
    asteroids[i] = { radius, phase, speed, incl, sizePx, color: [gray, gray, gray] };
  }

  // create asteroid GL program (simple point sprite)
  const vsAst = `
  attribute vec3 aPosition;
  attribute float aSize;
  attribute vec3 aColor;
  uniform mat4 uVP;
  uniform float uPointScale;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    gl_Position = uVP * vec4(aPosition, 1.0);
    gl_PointSize = aSize * uPointScale;
  }
  `;

  const fsAst = `
  precision mediump float;
  varying vec3 vColor;
  void main() {
    // circular disc inside the point
    vec2 coord = gl_PointCoord - 0.5;
    float r = length(coord);
    if (r > 0.5) discard;
    float alpha = smoothstep(0.5, 0.45, r);
    gl_FragColor = vec4(vColor, alpha);
  }
  `;

  const vshAst = createShader(gl.VERTEX_SHADER, vsAst);
  const fshAst = createShader(gl.FRAGMENT_SHADER, fsAst);
  const astProgram = gl.createProgram();
  gl.attachShader(astProgram, vshAst);
  gl.attachShader(astProgram, fshAst);
  gl.linkProgram(astProgram);
  let astLinked = true;
  if (!gl.getProgramParameter(astProgram, gl.LINK_STATUS)) {
    console.error('Asteroid program link error:', gl.getProgramInfoLog(astProgram));
    astLinked = false;
  }

  let aPosAst = -1, aSizeAst = -1, aColorAst = -1, uVPAst = null, uPointScale = null;
  const astPosBuffer = gl.createBuffer();
  const astSizeBuffer = gl.createBuffer();
  const astColorBuffer = gl.createBuffer();
  // typed arrays reused each frame
  const astPosArray = new Float32Array(ASTEROID_COUNT * 3);
  const astSizeArray = new Float32Array(ASTEROID_COUNT);
  const astColorArray = new Float32Array(ASTEROID_COUNT * 3);
  if (astLinked) {
    aPosAst = gl.getAttribLocation(astProgram, 'aPosition');
    aSizeAst = gl.getAttribLocation(astProgram, 'aSize');
    aColorAst = gl.getAttribLocation(astProgram, 'aColor');
    uVPAst = gl.getUniformLocation(astProgram, 'uVP');
    uPointScale = gl.getUniformLocation(astProgram, 'uPointScale');
  } else {
    // if asteroid program failed, skip asteroid rendering
    console.warn('Asteroid rendering disabled due to shader/link error');
  }

// --- grid (horizontal XZ plane) ---
// simple unlit line shader to draw a grid on the XZ plane at y=0
const vsGridSrc = `
attribute vec3 aPosition;
uniform mat4 uVP;
uniform mat4 uModel;
varying vec3 vWorldPos;
void main() {
  vec4 wp = uModel * vec4(aPosition, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = uVP * wp;
}
`;
const fsGridSrc = `
precision mediump float;
varying vec3 vWorldPos;
uniform vec3 uColor;
uniform float uAlpha;
uniform float uFadeStart; // distance where fade begins
uniform float uFadeEnd;   // distance where fade reaches 0
void main() {
  float r = length(vWorldPos.xz);
  float fade = 1.0;
  if (r > uFadeStart) {
    fade = 1.0 - smoothstep(uFadeStart, uFadeEnd, r);
  }
  float outA = uAlpha * fade;
  if (outA <= 0.001) discard;
  gl_FragColor = vec4(uColor, outA);
}
`;
const vshGrid = createShader(gl.VERTEX_SHADER, vsGridSrc);
const fshGrid = createShader(gl.FRAGMENT_SHADER, fsGridSrc);
const gridProgram = gl.createProgram();
gl.attachShader(gridProgram, vshGrid);
gl.attachShader(gridProgram, fshGrid);
gl.linkProgram(gridProgram);
if (!gl.getProgramParameter(gridProgram, gl.LINK_STATUS)) {
  console.error('Grid program link error:', gl.getProgramInfoLog(gridProgram));
}

// grid buffer (positions only)
const gridBuffer = gl.createBuffer();
let gridVertexCount = 0;
const gridModel = mat4.create(); // identity by default
let gridVisible = true; // toggleable by UI
// fade parameters (will be set relative to grid size)
let gridFadeStart = 200.0;
let gridFadeEnd = 400.0;

// utility: build grid vertices for XZ plane centered at origin
function buildGrid(size = 600, divisions = 40) {
  const half = size * 0.5;
  const step = size / divisions;
  const verts = [];
  // lines parallel to X (varying Z)
  for (let i = 0; i <= divisions; i++) {
    const z = -half + i * step;
    verts.push(-half, 0, z, half, 0, z);
  }
  // lines parallel to Z (varying X)
  for (let i = 0; i <= divisions; i++) {
    const x = -half + i * step;
    verts.push(x, 0, -half, x, 0, half);
  }
  const arr = new Float32Array(verts);
  gl.bindBuffer(gl.ARRAY_BUFFER, gridBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
  gridVertexCount = arr.length / 3;
}
let gridSize = 800;
let gridDivisions = 64;
buildGrid(gridSize, gridDivisions);

// keep fade parameters in sync with grid size by default
gridFadeStart = gridSize * 0.25;
gridFadeEnd = gridSize * 0.5;

// API: update/rebuild the grid at runtime. Call from console or hook a UI.
function updateGrid(size, divisions) {
  gridSize = typeof size === 'number' ? size : gridSize;
  gridDivisions = typeof divisions === 'number' ? divisions : gridDivisions;
  buildGrid(gridSize, gridDivisions);
  // adjust fades if caller didn't supply explicit ones
  gridFadeStart = gridSize * 0.25;
  gridFadeEnd = gridSize * 0.5;
}

// convenience alias exposed for quick console tweaks: `setGrid(size, divisions)`
window.setGrid = (size, divisions) => updateGrid(size, divisions);

// convenience: set grid fade radii (in world units)
window.setGridFade = (start, end) => {
  if (typeof start === 'number') gridFadeStart = start;
  if (typeof end === 'number') gridFadeEnd = end;
};

// build an initial grid sized reasonably relative to typical camera
// (grid already initialized above with `gridSize` / `gridDivisions`)

// --- camera (quaternion + momentum + smooth zoom) ---
let yaw = 0,
  pitch = 0;
let yawVel = 0,
  pitchVel = 0;
let radiusCam = 120,
  targetRadius = 120; // start zoomed out so full system is visible
const minZoom = 10,
  maxZoom = 400;
const sensitivity = 0.0014;
let dragging = false,
  lastX = 0,
  lastY = 0;

canvas.addEventListener("mousedown", (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  yawVel = pitchVel = 0;
});
canvas.addEventListener("mouseup", () => {
  dragging = false;
});
canvas.addEventListener("mouseleave", () => {
  dragging = false;
});
canvas.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  yaw -= dx * sensitivity; // inverted/hands-on drag
  pitch += dy * sensitivity;
  yawVel = -dx * sensitivity * 0.8; // momentum proportional to drag
  pitchVel = -dy * sensitivity * 0.8;
});
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    targetRadius += e.deltaY * 0.35; // stronger zoom step
    targetRadius = Math.max(minZoom, Math.min(maxZoom, targetRadius));
  },
  { passive: false }
);

const velocityDamping = 0.94;
const zoomSmooth = 0.14;

// --- draw helpers ---
function setModel(m) {
  gl.uniformMatrix4fv(uModel, false, m);
}
function drawMesh(model, color, isSun = 0, texture = null) {
  // use the configurable sun emissive when drawing the sun, otherwise use provided value (or 0)
  let emissiveVal = 0.0;
  if (isSun > 0) emissiveVal = sunEmissive;
  else emissiveVal = isSun || 0.0;
  gl.uniform1f(uEmissiveLoc, emissiveVal);
  // ensure sky-mode is off for regular meshes
  gl.uniform1f(uIsSky, 0.0);
  gl.uniform3fv(gl.getUniformLocation(program, "uColor"), color);
  gl.uniform1f(gl.getUniformLocation(program, "uUseTexture"), texture ? 1.0 : 0.0);

  if (texture) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(program, "uTexture"), 0);
  }

  setModel(model);
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
  gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(aPosition);
  gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
  gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(aNormal);
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
  gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(aUV);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);

  gl.drawElements(gl.TRIANGLES, sphere.indices.length, gl.UNSIGNED_SHORT, 0);
}

function drawSky(model, texture) {
  // Draw sky first without writing depth so everything else renders on top
  gl.depthMask(false);
  gl.uniform1f(uIsSky, 1.0);
  gl.uniform1f(uEmissiveLoc, 0.0);
  gl.uniform3fv(gl.getUniformLocation(program, "uColor"), [1, 1, 1]);
  gl.uniform1f(gl.getUniformLocation(program, "uUseTexture"), 1.0);

  // set sky dim and repeat
  gl.uniform1f(uSkyDim, 0.57);
  gl.uniform1f(uSkyRepeat, 2.0);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(gl.getUniformLocation(program, "uTexture"), 0);

  setModel(model);

  gl.bindBuffer(gl.ARRAY_BUFFER, skyPosBuffer);
  gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(aPosition);

  gl.bindBuffer(gl.ARRAY_BUFFER, skyNormalBuffer);
  gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(aNormal);

  gl.bindBuffer(gl.ARRAY_BUFFER, skyUVBuffer);
  gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(aUV);

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, skyIndexBuffer);
  gl.drawElements(gl.TRIANGLES, skySphere.indices.length, gl.UNSIGNED_SHORT, 0);

  gl.depthMask(true);
  gl.uniform1f(uIsSky, 0.0);
}

// draw a simple white outline by rendering the backfaces of a slightly scaled model
function drawOutline(model, thickness = 1.03) {
  // scale model outwards
  const om = mat4.clone(model);
  mat4.scale(om, om, [thickness, thickness, thickness]);
  // render only backfaces of the scaled model so the silhouette appears
  // but don't overwrite the depth buffer so the original sphere remains visible
  const prevDepthMask = gl.getParameter(gl.DEPTH_WRITEMASK);
  gl.depthMask(false);
  // use LEQUAL so backfaces that are at the same depth as the original pass
  const prevDepthFunc = gl.getParameter(gl.DEPTH_FUNC);
  gl.depthFunc(gl.LEQUAL);

  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.FRONT);

  gl.uniform1f(uIsSky, 0.0);
  gl.uniform1f(uUseTextureLoc, 0.0);
  gl.uniform3fv(uColor, [1.0, 1.0, 1.0]);
  gl.uniform1f(uEmissiveLoc, 2.0);

  setModel(om);

  gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
  gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(aPosition);

  gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
  gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(aNormal);

  // UVs not needed but keep attribute enabled state consistent
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
  gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(aUV);

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.drawElements(gl.TRIANGLES, sphere.indices.length, gl.UNSIGNED_SHORT, 0);

  // restore state
  gl.disable(gl.CULL_FACE);
  gl.depthFunc(prevDepthFunc);
  gl.depthMask(prevDepthMask);
}

// helper: project a world-space point to canvas pixel coordinates (device pixels)
function worldToCanvasPoint(worldPos, vpMat) {
  const v = vec4.fromValues(worldPos[0], worldPos[1], worldPos[2], 1.0);
  vec4.transformMat4(v, v, vpMat);
  if (Math.abs(v[3]) < 1e-6) return null;
  v[0] /= v[3];
  v[1] /= v[3];
  // NDC -> canvas (device) pixels
  const x = (v[0] * 0.5 + 0.5) * canvas.width;
  const y = (-v[1] * 0.5 + 0.5) * canvas.height;
  return [x, y, v[2]];
}

function showTooltip(text, canvasX, canvasY) {
  if (!tooltipEl) return;
  tooltipEl.style.display = 'block';
  // convert canvas device pixels back to CSS pixels for positioning
  const dpr = window.devicePixelRatio || 1;
  tooltipEl.style.left = `${Math.round(canvasX / dpr + 8)}px`;
  tooltipEl.style.top = `${Math.round(canvasY / dpr + 8)}px`;
  tooltipEl.textContent = text;
}

function hideTooltip() {
  if (!tooltipEl) return;
  tooltipEl.style.display = 'none';
}

function drawRing(model, texture) {
  gl.uniform1f(uEmissiveLoc, 0.7);
  gl.uniform3fv(gl.getUniformLocation(program, "uColor"), [1, 1, 1]);
  gl.uniform1f(gl.getUniformLocation(program, "uUseTexture"), 1.0);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.uniform1i(gl.getUniformLocation(program, "uTexture"), 0);
  gl.uniform1f(gl.getUniformLocation(program, "uUseTexture"), 1.0);

  setModel(model);

  gl.bindBuffer(gl.ARRAY_BUFFER, ringPosBuffer);
  gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(aPosition);

  gl.bindBuffer(gl.ARRAY_BUFFER, ringUVBuffer);
  gl.vertexAttribPointer(aUV, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(aUV);

  gl.disableVertexAttribArray(aNormal); // not needed for flat rings

  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ringIndexBuffer);
  gl.drawElements(gl.TRIANGLES, ring.indices.length, gl.UNSIGNED_SHORT, 0);
}

// draw the horizontal grid on the XZ plane
function drawGrid(vpMat) {
  if (!gridVisible) return;

  // choose color and alpha that stay subtle
  const gridColor = [0.6, 0.6, 0.6];
  const gridAlpha = 0.16;

  gl.useProgram(gridProgram);
  const aPosGrid = gl.getAttribLocation(gridProgram, 'aPosition');
  const uVPGrid = gl.getUniformLocation(gridProgram, 'uVP');
  const uModelGrid = gl.getUniformLocation(gridProgram, 'uModel');
  const uColorGrid = gl.getUniformLocation(gridProgram, 'uColor');
  const uAlphaGrid = gl.getUniformLocation(gridProgram, 'uAlpha');
  const uFadeStartLoc = gl.getUniformLocation(gridProgram, 'uFadeStart');
  const uFadeEndLoc = gl.getUniformLocation(gridProgram, 'uFadeEnd');

  gl.uniformMatrix4fv(uVPGrid, false, vpMat);
  gl.uniformMatrix4fv(uModelGrid, false, gridModel);
  gl.uniform3fv(uColorGrid, gridColor);
  gl.uniform1f(uAlphaGrid, gridAlpha);
  gl.uniform1f(uFadeStartLoc, gridFadeStart);
  gl.uniform1f(uFadeEndLoc, gridFadeEnd);

  gl.bindBuffer(gl.ARRAY_BUFFER, gridBuffer);
  gl.enableVertexAttribArray(aPosGrid);
  gl.vertexAttribPointer(aPosGrid, 3, gl.FLOAT, false, 0, 0);

  // lines should respect depth so planets occlude grid where appropriate
  gl.drawArrays(gl.LINES, 0, gridVertexCount);

  // restore main program
  gl.useProgram(program);
}

// --- render loop ---
function render() {
  resizeCanvasToDisplaySize();
  updateProjection();

  // smooth zoom interpolation
  radiusCam += (targetRadius - radiusCam) * zoomSmooth;

  // momentum
  if (!dragging) {
    yaw += yawVel;
    pitch += pitchVel;
    yawVel *= velocityDamping;
    pitchVel *= velocityDamping;
    if (Math.abs(yawVel) < 1e-8) yawVel = 0;
    if (Math.abs(pitchVel) < 1e-8) pitchVel = 0;
  } else {
    yaw += yawVel * 0.2;
    pitch += pitchVel * 0.2;
  }

  // avoid exact singularities
  const pitchLimit = Math.PI / 2 - 0.001;
  pitch = Math.max(-pitchLimit, Math.min(pitchLimit, pitch));

  // camera quaternion
  const qYaw = quat.create();
  quat.setAxisAngle(qYaw, [0, 1, 0], yaw);
  const qPitch = quat.create();
  quat.setAxisAngle(qPitch, [1, 0, 0], pitch);
  const qTotal = quat.create();
  quat.multiply(qTotal, qYaw, qPitch);

  const forward = vec3.create();
  vec3.transformQuat(forward, [0, 0, 1], qTotal);
  // position the camera relative to the current camera target so
  // zoom and orbit happen around the selected target (not always the origin)
  const eye = vec3.create();
  const eyeOffset = vec3.create();
  vec3.scale(eyeOffset, forward, -radiusCam);
  vec3.add(eye, cameraTarget, eyeOffset);
  const up = vec3.create();
  vec3.transformQuat(up, [0, 1, 0], qTotal);

  // VP
  const view = mat4.create();
  // use smoothed camera target; if locked to a planet we'll update desiredTarget below
  mat4.lookAt(view, eye, cameraTarget, up);
  const vp = mat4.create();
  mat4.multiply(vp, projection, view);
  gl.uniformMatrix4fv(uVP, false, vp);

  // uniforms: camera & sun
  gl.uniform3fv(uCameraPos, eye);
  gl.uniform3fv(uSunPos, [0, 0, 0]);
  // set sunlight intensity for diffuse lighting
  if (uSunIntensityLoc) gl.uniform1f(uSunIntensityLoc, sunEmissive);

  // clear and draw
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // update simulation time (respecting pause)
  const nowReal = performance.now();
  if (!paused) {
    simTime += (nowReal - lastRealTime) * 0.001; // seconds
  }
  lastRealTime = nowReal;
  const t = simTime;
  const timeScale = orbitSlowdown; // apply slowdown requested

  // Draw sky sphere (huge inverted sphere)
  const mSky = mat4.create();
  // scale to be large relative to camera distance
  const skyScale = Math.max(600, radiusCam * 1.6);
  mat4.scale(mSky, mSky, [skyScale, skyScale, skyScale]);
  drawSky(mSky, galaxyTex);

  // draw ground/grid on XZ plane under the scene
  drawGrid(vp);

  // Sun (emissive)
  const mSun = mat4.create();
  mat4.scale(mSun, mSun, [sunRadius, sunRadius, sunRadius]);
  drawMesh(mSun, sunColor, 10.0);

  // prepare for hover detection: track nearest planet under cursor
  hoveredPlanet = null;
  const dpr = window.devicePixelRatio || 1;
  const pointerCanvasX = pointerX * dpr;
  const pointerCanvasY = pointerY * dpr;
  let bestDistSq = Infinity;

  // check sun hover first so the sun is clickable like planets
  const sunWorld = [0, 0, 0];
  const sunScr = worldToCanvasPoint(sunWorld, vp);
  if (sunScr) {
    const sunOff = [sunRadius, 0, 0];
    const sunScr2 = worldToCanvasPoint(sunOff, vp);
    let sunRadiusPx = 12;
    if (sunScr2) sunRadiusPx = Math.max(6, Math.hypot(sunScr2[0] - sunScr[0], sunScr2[1] - sunScr[1]));
    const dxs = sunScr[0] - pointerCanvasX;
    const dys = sunScr[1] - pointerCanvasY;
    const distSs = dxs * dxs + dys * dys;
    if (distSs < sunRadiusPx * sunRadiusPx) {
      bestDistSq = distSs;
      hoveredPlanet = { name: 'Sun', isSun: true, _screen: sunScr, worldPos: sunWorld };
    }
  }

  // planets & moons
  for (const p of planets) {
    // compute angle; visually tweaked speed formula for nicer motion
    const orbitalSpeed = (10.0 * Math.PI) / (p.period || 365);
    const angle =
      (t * orbitalSpeed * timeScale * 5.0) /
      Math.sqrt(Math.max(0.0001, p.distAU));
    const px = Math.cos(angle) * p.distance;
    const pz = Math.sin(angle) * p.distance;

    const pm = mat4.create();
    mat4.translate(pm, pm, [px, 0, pz]);
    mat4.scale(pm, pm, [p.visualSize, p.visualSize, p.visualSize]);
    drawMesh(pm, p.color, 0, p.texture);

    // compute planet screen position and approximate radius in pixels
    const worldPos = [px, 0, pz];
    const scr = worldToCanvasPoint(worldPos, vp);
    if (scr) {
      // approximate radius: project a small offset and measure
      const offset = [px + p.visualSize, 0, pz];
      const scr2 = worldToCanvasPoint(offset, vp);
      let radiusPx = 12; // fallback
      if (scr2) {
        const dx = scr2[0] - scr[0];
        const dy = scr2[1] - scr[1];
        radiusPx = Math.max(6, Math.hypot(dx, dy));
      }
      const dxp = scr[0] - pointerCanvasX;
      const dyp = scr[1] - pointerCanvasY;
      const distSq = dxp * dxp + dyp * dyp;
      if (distSq < radiusPx * radiusPx && distSq < bestDistSq) {
        bestDistSq = distSq;
        hoveredPlanet = p;
        hoveredPlanet._screen = scr;
      }
    }

    // simple ring for Saturn (flat scaled sphere)
    if (p.hasRing) {
      const ringModel = mat4.clone(pm);
      mat4.rotateX(ringModel, ringModel, Math.PI / 1.07); // flat
      mat4.scale(ringModel, ringModel, [
        p.visualSize * 0.5,
        p.visualSize * 0.5,
        p.visualSize * 0.5,
      ]);
      drawRing(ringModel, saturnRingTex);
    }

    if (p.moons) {
      for (let i = 0; i < p.moons.length; i++) {
        const m = p.moons[i];
        const moonSpeed = (2.0 * Math.PI) / (m.period || 27);
        const mangle = t * moonSpeed * timeScale * (1.0 + 0.12 * i);
        const mx = px + Math.cos(mangle) * (m.visualDist + p.visualSize * 0.6);
        const mz = pz + Math.sin(mangle) * (m.visualDist + p.visualSize * 0.6);
        const mm = mat4.create();
        mat4.translate(mm, mm, [mx, 0, mz]);
        mat4.scale(mm, mm, [m.visualSize, m.visualSize, m.visualSize]);
        drawMesh(mm, m.color, 0, m.texture);
      }
    }
  }

  // update asteroid positions into buffers and draw them
  if (astLinked) {
    for (let i = 0; i < ASTEROID_COUNT; i++) {
    const a = asteroids[i];
    const ang = a.phase + t * a.speed;
    const x = Math.cos(ang) * a.radius;
    const z = Math.sin(ang) * a.radius;
    const y = Math.sin(ang * 3.14) * a.radius * a.incl; // small vertical oscillation by inclination
    astPosArray[i * 3 + 0] = x;
    astPosArray[i * 3 + 1] = y;
    astPosArray[i * 3 + 2] = z;
    astSizeArray[i] = a.sizePx;
    astColorArray[i * 3 + 0] = a.color[0];
    astColorArray[i * 3 + 1] = a.color[1];
    astColorArray[i * 3 + 2] = a.color[2];
    }

    // upload buffers
    gl.useProgram(astProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, astPosBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, astPosArray, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aPosAst);
    gl.vertexAttribPointer(aPosAst, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, astSizeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, astSizeArray, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aSizeAst);
    gl.vertexAttribPointer(aSizeAst, 1, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, astColorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, astColorArray, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(aColorAst);
    gl.vertexAttribPointer(aColorAst, 3, gl.FLOAT, false, 0, 0);

    gl.uniformMatrix4fv(uVPAst, false, vp);
    // scale point size with DPI and a small camera-distance compensation
    const pointScale = 1.0 * dpr * Math.max(0.6, 120.0 / radiusCam);
    gl.uniform1f(uPointScale, pointScale);

    // blending for soft points
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.POINTS, 0, ASTEROID_COUNT);

    // restore main program
    gl.useProgram(program);
  }

  // Update cameraTarget: if locked to a planet, aim at its current world position; smooth the target
  const desiredTarget = vec3.fromValues(0,0,0);
  // draw outline for the hovered object (sun or planet) after hover detection
  if (hoveredPlanet) {
    if (hoveredPlanet.isSun) {
      drawOutline(mat4.clone(mSun), 1.03);
    } else {
      // find planet object and compute its current model matrix
      const p = planets.find((pl) => pl.name === hoveredPlanet.name) || hoveredPlanet;
      const orbitalSpeed = (10.0 * Math.PI) / (p.period || 365);
      const angle =
        (t * orbitalSpeed * timeScale * 5.0) /
        Math.sqrt(Math.max(0.0001, p.distAU));
      const px = Math.cos(angle) * p.distance;
      const pz = Math.sin(angle) * p.distance;
      const pm = mat4.create();
      mat4.translate(pm, pm, [px, 0, pz]);
      mat4.scale(pm, pm, [p.visualSize, p.visualSize, p.visualSize]);
      drawOutline(pm, 1.03);
    }
  }
  if (lockedPlanet) {
    // if the sun is locked, target origin
    if (lockedPlanet.isSun) {
      desiredTarget[0] = 0;
      desiredTarget[1] = 0;
      desiredTarget[2] = 0;
    } else {
      // lockedPlanet may be a planet object or a transient object with the planet's name
      let p = lockedPlanet;
      if (!p.distAU) p = planets.find((pl) => pl.name === lockedPlanet.name) || lockedPlanet;
      const orbitalSpeed = (10.0 * Math.PI) / (p.period || 365);
      const angle =
        (t * orbitalSpeed * timeScale * 5.0) /
        Math.sqrt(Math.max(0.0001, p.distAU));
      const px = Math.cos(angle) * p.distance;
      const pz = Math.sin(angle) * p.distance;
      desiredTarget[0] = px;
      desiredTarget[1] = 0;
      desiredTarget[2] = pz;
    }
  }
  // smooth blend
  vec3.lerp(cameraTarget, cameraTarget, desiredTarget, 0.12);

  // show/hide tooltip based on hover
  if (hoveredPlanet) {
    showTooltip(hoveredPlanet.name, hoveredPlanet._screen[0], hoveredPlanet._screen[1]);
  } else {
    hideTooltip();
  }

  requestAnimationFrame(render);
}

// init attribute bindings (static)
gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
gl.enableVertexAttribArray(aPosition);
gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
gl.enableVertexAttribArray(aNormal);
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);

// start
requestAnimationFrame(render);
