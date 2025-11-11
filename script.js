import {
  mat4,
  vec3,
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
uniform vec3 uColor;
uniform sampler2D uTexture;
uniform float uUseTexture;
uniform float uEmissive;

void main(void) {
  vec3 N = normalize(vNormal);
  vec3 lightDir = normalize(vec3(1.0, 0.4, 0.2));
  float diffuse = max(dot(N, lightDir), 0.0);
  float ambient = 0.25;

  vec3 baseColor = uColor;

  if (uUseTexture > 0.5) {
    vec4 texColor = texture2D(uTexture, vUV);
    if (texColor.a < 0.1) discard;   // transparency for rings
    baseColor = texColor.rgb;
  }

  vec3 color = baseColor * (ambient + diffuse * 0.9);
  color += uEmissive * vec3(1.2, 1.0, 0.7);
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
const galaxyTex = loadTexture("textures/galaxy.jpg");

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

  const img = new Image();
  img.onload = () => {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D);
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

// --- GL state ---
gl.enable(gl.DEPTH_TEST);
gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
gl.clearColor(0, 0, 0, 1);

// --- solar data (realistic tints, scaled) ---
const distanceScale = 6.0; // 1 AU -> 6 units (tweak visually)
const sizeScale = 0.28; // Earth = ~0.28 units
const orbitSlowdown = 0.5; // slow orbits by 50%

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
  gl.uniform1f(gl.getUniformLocation(program, "uEmissive"), isSun);
  gl.uniform3fv(gl.getUniformLocation(program, "uColor"), color);
  gl.uniform1f(
    gl.getUniformLocation(program, "uUseTexture"),
    texture ? 1.0 : 0.0
  );

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

function drawRing(model, texture) {
  gl.uniform1f(gl.getUniformLocation(program, "uEmissive"), 0.0);
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
  const eye = vec3.create();
  vec3.scale(eye, forward, -radiusCam);
  const up = vec3.create();
  vec3.transformQuat(up, [0, 1, 0], qTotal);

  // VP
  const view = mat4.create();
  mat4.lookAt(view, eye, [0, 0, 0], up);
  const vp = mat4.create();
  mat4.multiply(vp, projection, view);
  gl.uniformMatrix4fv(uVP, false, vp);

  // uniforms: camera & sun
  gl.uniform3fv(uCameraPos, eye);
  gl.uniform3fv(uSunPos, [0, 0, 0]);

  // clear and draw
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const t = performance.now() * 0.001;
  const timeScale = orbitSlowdown; // apply slowdown requested (50%)

  // Draw sky sphere (huge inverted sphere)

  // Sun (emissive)
  const mSun = mat4.create();
  mat4.scale(mSun, mSun, [sunRadius, sunRadius, sunRadius]);
  drawMesh(mSun, sunColor, 1);

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
