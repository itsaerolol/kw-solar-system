import { mat4, vec3, quat } from "https://cdn.jsdelivr.net/npm/gl-matrix@3.4.3/esm/index.js";

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
window.addEventListener("resize", () => { resizeCanvasToDisplaySize(); updateProjection(); });
resizeCanvasToDisplaySize();

const projection = mat4.create();
function updateProjection() {
  mat4.perspective(projection, Math.PI / 4, canvas.width / canvas.height, 0.1, 2000.0);
}
updateProjection();

// --- shaders (world-space lighting + emissive sun) ---
const vsSource = `
attribute vec3 aPosition;
attribute vec3 aNormal;
uniform mat4 uModel;
uniform mat4 uVP;
varying vec3 vNormal;
varying vec3 vWorldPos;
void main() {
  vec4 worldPos = uModel * vec4(aPosition, 1.0);
  vWorldPos = worldPos.xyz;
  vNormal = mat3(uModel) * aNormal;
  gl_Position = uVP * worldPos;
}
`;

const fsSource = `
precision mediump float;
varying vec3 vNormal;
uniform vec3 uColor;
uniform float uEmissive; // 0 for planets, 1 for the Sun

void main(void) {
  vec3 N = normalize(vNormal);
  
  // Sunlight from a fixed direction (e.g., from the +X side)
  vec3 lightDir = normalize(vec3(1.0, 0.4, 0.2));
  
  // Directional lighting intensity
  float diffuse = max(dot(N, lightDir), 0.0);
  
  // Moderate ambient (not full dark, but not flat)
  float ambient = 0.25;
  
  // Base color lit by diffuse + ambient
  vec3 color = uColor * (ambient + diffuse * 0.9);
  
  // If emissive (Sun), make it glow brighter
  color += uEmissive * vec3(1.2, 1.0, 0.7);
  
  gl_FragColor = vec4(color, 1.0);
}
`;



// --- compile/link ---
function createShader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
  return s;
}
const vsh = createShader(gl.VERTEX_SHADER, vsSource);
const fsh = createShader(gl.FRAGMENT_SHADER, fsSource);
const program = gl.createProgram();
gl.attachShader(program, vsh);
gl.attachShader(program, fsh);
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(program));
gl.useProgram(program);

// --- sphere geometry (shared) ---
function createSphere(latBands, longBands, radius) {
  const pos = [], norm = [], idx = [];
  for (let lat = 0; lat <= latBands; lat++) {
    const theta = lat * Math.PI / latBands;
    const sinT = Math.sin(theta), cosT = Math.cos(theta);
    for (let lon = 0; lon <= longBands; lon++) {
      const phi = lon * 2 * Math.PI / longBands;
      const sinP = Math.sin(phi), cosP = Math.cos(phi);
      const x = cosP * sinT, y = cosT, z = sinP * sinT;
      pos.push(radius * x, radius * y, radius * z);
      norm.push(x, y, z);
    }
  }
  for (let lat = 0; lat < latBands; lat++) {
    for (let lon = 0; lon < longBands; lon++) {
      const first = lat * (longBands + 1) + lon;
      const second = first + longBands + 1;
      idx.push(first, second, first + 1, second, second + 1, first + 1);
    }
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(norm), indices: new Uint16Array(idx) };
}

const sphere = createSphere(36, 36, 1.0);
const posBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
gl.bufferData(gl.ARRAY_BUFFER, sphere.positions, gl.STATIC_DRAW);

const normalBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
gl.bufferData(gl.ARRAY_BUFFER, sphere.normals, gl.STATIC_DRAW);

const indexBuffer = gl.createBuffer();
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, sphere.indices, gl.STATIC_DRAW);

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
gl.clearColor(0, 0, 0, 1);

// --- solar data (realistic tints, scaled) ---
const distanceScale = 6.0;   // 1 AU -> 6 units (tweak visually)
const sizeScale = 0.28;      // Earth = ~0.28 units
const orbitSlowdown = 0.5;   // slow orbits by 50%

const planets = [
    
  { name:"Mercury", distAU:0.39, size:0.38, color:[0.68,0.63,0.58], period:88 },
  { name:"Venus",   distAU:0.72, size:0.95, color:[0.91,0.78,0.56], period:225 },
  { name:"Earth",   distAU:1.00, size:1.00, color:[0.18,0.5,0.86], period:365, moons:[
      { name:"Moon", relDist:0.004, size:0.27, color:[0.8,0.8,0.82], period:27 }
    ]},
  { name:"Mars",    distAU:1.52, size:0.53, color:[0.86,0.44,0.31], period:687, moons:[
      { name:"Phobos", relDist:0.0015, size:0.011, color:[0.6,0.6,0.6], period:0.32 },
      { name:"Deimos", relDist:0.003, size:0.006, color:[0.7,0.7,0.7], period:1.26 }
    ]},
  { name:"Jupiter", distAU:5.20, size:11.21, color:[0.9,0.77,0.6], period:4333, moons:[
      { name:"Io", relDist:0.0028, size:0.285, color:[0.9,0.7,0.4], period:1.77 },
      { name:"Europa", relDist:0.0045, size:0.245, color:[0.9,0.95,1.0], period:3.55 },
      { name:"Ganymede", relDist:0.007, size:0.413, color:[0.8,0.8,0.75], period:7.15 },
      { name:"Callisto", relDist:0.012, size:0.378, color:[0.7,0.7,0.65], period:16.69 }
    ]},
  { name:"Saturn",  distAU:9.58, size:9.45, color:[0.94,0.86,0.64], period:10759, moons:[
      { name:"Titan", relDist:0.02, size:0.4, color:[0.87,0.72,0.55], period:15.95 }
    ], hasRing:true },
  { name:"Uranus",  distAU:19.2, size:4.01, color:[0.6,0.85,0.92], period:30687, moons:[
      { name:"Titania", relDist:0.01, size:0.15, color:[0.8,0.8,0.85], period:8.7 }
    ]},
  { name:"Neptune", distAU:30.05, size:3.88, color:[0.3,0.45,0.8], period:60190, moons:[
      { name:"Triton", relDist:0.01, size:0.22, color:[0.9,0.9,0.95], period:5.88 }
    ]}
];

for (const p of planets) {
  p.phase = Math.random() * Math.PI * 2; // random start angle
  p.distance = p.distAU * distanceScale;
  p.visualSize = Math.max(0.04, p.size * sizeScale);
  if (p.moons) {
    for (const m of p.moons) {
      m.visualDist = Math.max(0.09, m.relDist * distanceScale * 35); // boost for visibility
      m.visualSize = Math.max(0.01, m.size * sizeScale);
    }
  }
}

const sunColor = [1.0, 0.95, 0.7];
const sunRadius = 1.8;

// --- camera (quaternion + momentum + smooth zoom) ---
let yaw = 0, pitch = 0;
let yawVel = 0, pitchVel = 0;
let radiusCam = 120, targetRadius = 120; // start zoomed out so full system is visible
const minZoom = 2, maxZoom = 400;
const sensitivity = 0.0014;
let dragging = false, lastX = 0, lastY = 0;

canvas.addEventListener("mousedown", e => { dragging = true; lastX = e.clientX; lastY = e.clientY; yawVel = pitchVel = 0; });
canvas.addEventListener("mouseup", () => { dragging = false; });
canvas.addEventListener("mouseleave", () => { dragging = false; });
canvas.addEventListener("mousemove", e => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  yaw -= dx * sensitivity;          // inverted/hands-on drag
  pitch += dy * sensitivity;
  yawVel = -dx * sensitivity * 0.8;  // momentum proportional to drag
  pitchVel = -dy * sensitivity * 0.8;
});
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  targetRadius += e.deltaY * 0.35; // stronger zoom step
  targetRadius = Math.max(minZoom, Math.min(maxZoom, targetRadius));
}, { passive: false });

const velocityDamping = 0.94;
const zoomSmooth = 0.14;

// --- draw helpers ---
function setModel(m) { gl.uniformMatrix4fv(uModel, false, m); }
function drawMesh(model, color, isSun = 0) {
  gl.uniform1i(uIsSun, isSun);
  gl.uniform3fv(uColor, color);
  setModel(model);
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
  gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(aPosition);
  gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
  gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(aNormal);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.drawElements(gl.TRIANGLES, sphere.indices.length, gl.UNSIGNED_SHORT, 0);
}

// --- render loop ---
function render() {
  resizeCanvasToDisplaySize();
  updateProjection();

  // smooth zoom interpolation
  radiusCam += (targetRadius - radiusCam) * zoomSmooth;

  // momentum
  if (!dragging) {
    yaw += yawVel; pitch += pitchVel;
    yawVel *= velocityDamping; pitchVel *= velocityDamping;
    if (Math.abs(yawVel) < 1e-8) yawVel = 0;
    if (Math.abs(pitchVel) < 1e-8) pitchVel = 0;
  } else {
    yaw += yawVel * 0.2; pitch += pitchVel * 0.2;
  }

  // avoid exact singularities
  const pitchLimit = Math.PI/2 - 0.001;
  pitch = Math.max(-pitchLimit, Math.min(pitchLimit, pitch));

  // camera quaternion
  const qYaw = quat.create(); quat.setAxisAngle(qYaw, [0,1,0], yaw);
  const qPitch = quat.create(); quat.setAxisAngle(qPitch, [1,0,0], pitch);
  const qTotal = quat.create(); quat.multiply(qTotal, qYaw, qPitch);

  const forward = vec3.create(); vec3.transformQuat(forward, [0,0,1], qTotal);
  const eye = vec3.create(); vec3.scale(eye, forward, -radiusCam);
  const up = vec3.create(); vec3.transformQuat(up, [0,1,0], qTotal);

  // VP
  const view = mat4.create(); mat4.lookAt(view, eye, [0,0,0], up);
  const vp = mat4.create(); mat4.multiply(vp, projection, view);
  gl.uniformMatrix4fv(uVP, false, vp);

  // uniforms: camera & sun
  gl.uniform3fv(uCameraPos, eye);
  gl.uniform3fv(uSunPos, [0,0,0]);

  // clear and draw
  gl.viewport(0,0,canvas.width,canvas.height);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const t = performance.now() * 0.001;
  const timeScale = orbitSlowdown; // apply slowdown requested (50%)

  // Sun (emissive)
  const mSun = mat4.create(); mat4.scale(mSun, mSun, [sunRadius, sunRadius, sunRadius]);
  drawMesh(mSun, sunColor, 1);

  // planets & moons
  for (const p of planets) {
    // compute angle; visually tweaked speed formula for nicer motion
    const orbitalSpeed = (100.0 * Math.PI) / (p.period || 365);
    const angle = t * orbitalSpeed * timeScale * 5.0 / Math.sqrt(Math.max(0.0001, p.distAU));
    const px = Math.cos(angle) * p.distance;
    const pz = Math.sin(angle) * p.distance;

    const pm = mat4.create();
    mat4.translate(pm, pm, [px, 0, pz]);
    mat4.scale(pm, pm, [p.visualSize, p.visualSize, p.visualSize]);
    drawMesh(pm, p.color, 0);

    // simple ring for Saturn (flat scaled sphere)
    if (p.hasRing) {
      const ring = mat4.clone(pm);
      mat4.scale(ring, ring, [2.1, 0.02, 2.1]);
      drawMesh(ring, [0.92,0.85,0.66], 0);
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
        drawMesh(mm, m.color, 0);
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

