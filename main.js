import * as THREE from 'three';

/* =========================================================
   鹏城飞驰 — a tiny low-poly Shenzhen driving game
   World axes: x = east, z = south (north is -z), y = up.
   A car's heading h gives forward = (sin h, cos h) on the XZ plane.
   ========================================================= */

const IS_TOUCH = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
if (IS_TOUCH) document.body.classList.add('touch');

const FONT = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Hiragino Sans GB",sans-serif';
const MAP = { minX: -400, maxX: 400, minZ: -280, maxZ: 280 };
const XHW = 10; // half width of north-south roads
const XROADS = [
  { x: -300, name: '新洲路' }, { x: -180, name: '益田路' }, { x: -60, name: '金田路' },
  { x: 60, name: '皇岗路' }, { x: 180, name: '华强北路' }, { x: 300, name: '燕南路' },
];
const ZROADS = [
  { z: -220, name: '红荔路', hw: 10 }, { z: -110, name: '福中路', hw: 10 },
  { z: 0, name: '深南大道', hw: 20 }, { z: 110, name: '福华路', hw: 10 }, { z: 220, name: '滨河大道', hw: 10 },
];
const LANES_SMALL = [2.5, 7.5];
const LANES_SHENNAN = [5.5, 10.5, 15.5];

const PLAYER_MAX = 40;      // m/s  (144 km/h)
const CAR_R = 2.1;          // collision radius of a car
const LIGHT_CYCLE = 22;

const rand = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapAngle = (a) => { while (a > Math.PI) a -= Math.PI * 2; while (a < -Math.PI) a += Math.PI * 2; return a; };

/* ---------------- renderer / scene ---------------- */
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !IS_TOUCH, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, IS_TOUCH ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = !IS_TOUCH;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const FOG_COLOR = new THREE.Color(0xe69a78);
scene.fog = new THREE.Fog(FOG_COLOR, 140, 720);
scene.background = FOG_COLOR;

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.5, 2000);

// sky dome with vertex-colour gradient (dusk)
{
  const geo = new THREE.SphereGeometry(1500, 32, 16);
  const cols = [];
  const top = new THREE.Color(0x2a2c6e), mid = new THREE.Color(0xb3608a), hor = new THREE.Color(0xffa36b), low = new THREE.Color(0xe69a78);
  const p = geo.attributes.position, c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i) / 1500;
    if (y > 0.35) c.copy(mid).lerp(top, Math.min(1, (y - 0.35) / 0.5));
    else if (y > 0.04) c.copy(hor).lerp(mid, (y - 0.04) / 0.31);
    else c.copy(low).lerp(hor, clamp((y + 0.05) / 0.09, 0, 1));
    cols.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  sky.renderOrder = -1;
  scene.add(sky);
  scene.userData.sky = sky;
}

scene.add(new THREE.HemisphereLight(0xa8b4ff, 0x6a5040, 1.25));
const sun = new THREE.DirectionalLight(0xffc49a, 2.0);
sun.position.set(-150, 120, 60);
scene.add(sun, sun.target);
if (renderer.shadowMap.enabled) {
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = sun.shadow.camera; s.left = -110; s.right = 110; s.top = 110; s.bottom = -110; s.near = 10; s.far = 500;
  sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.6;
}

/* ---------------- geometry helpers ---------------- */
const tmpColor = new THREE.Color();
function colorize(geo, hex) {
  tmpColor.set(hex);
  const n = geo.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = tmpColor.r; a[i * 3 + 1] = tmpColor.g; a[i * 3 + 2] = tmpColor.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return geo;
}
function cbox(w, h, d, x, y, z, hex, rotY = 0) {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  return colorize(g, hex);
}
function mergeGeos(list) {
  let total = 0;
  for (const g of list) total += g.attributes.position.count;
  const hasUV = list.every((g) => g.attributes.uv), hasCol = list.every((g) => g.attributes.color);
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3);
  const uv = hasUV ? new Float32Array(total * 2) : null, col = hasCol ? new Float32Array(total * 3) : null;
  let o = 0;
  for (const g of list) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    if (uv) uv.set(g.attributes.uv.array, o * 2);
    if (col) col.set(g.attributes.color.array, o * 3);
    o += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (uv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

/* ---------------- canvas textures ---------------- */
const maxAniso = renderer.capabilities.getMaxAnisotropy();
function canvasTex(cv, repeat = false) {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, maxAniso);
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  return t;
}

// building facade: returns {map, emissive}. One tile = 16 x 16 world units, 4 floors x 4 window columns.
function facadeTextures(base, win, lit, style) {
  const S = 256, cv = document.createElement('canvas'), ce = document.createElement('canvas');
  cv.width = cv.height = ce.width = ce.height = S;
  const g = cv.getContext('2d'), e = ce.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, S, S);
  e.fillStyle = '#000'; e.fillRect(0, 0, S, S);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const x = c * 64, y = r * 64;
      let wx, wy, ww, wh;
      if (style === 'glass') { wx = x + 6; wy = y + 8; ww = 52; wh = 46; }
      else if (style === 'strip') { wx = x + 4; wy = y + 18; ww = 58; wh = 26; }
      else { wx = x + 14; wy = y + 14; ww = 36; wh = 36; }
      const on = Math.random() < lit;
      g.fillStyle = on ? '#ffd9a0' : win; g.fillRect(wx, wy, ww, wh);
      if (style === 'glass') { g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(wx, wy, ww, 6); }
      if (on) { e.fillStyle = Math.random() < 0.3 ? '#bfe4ff' : '#ffc878'; e.fillRect(wx, wy, ww, wh); }
    }
  }
  // keep bottom-left corner plain (roof UVs sample it)
  g.fillStyle = base; g.fillRect(0, S - 12, 12, 12); e.fillStyle = '#000'; e.fillRect(0, S - 12, 12, 12);
  return { map: canvasTex(cv, true), emissive: canvasTex(ce, true) };
}

// text sign texture
function textTexture(text, o = {}) {
  const pxPerUnit = o.ppu || 64;
  const W = Math.min(2048, Math.round((o.w || 8) * pxPerUnit)), H = Math.min(1024, Math.round((o.h || 2) * pxPerUnit));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = o.bg || '#1450a8'; g.fillRect(0, 0, W, H);
  if (o.border) { g.strokeStyle = o.border; g.lineWidth = Math.max(4, H * 0.06); g.strokeRect(g.lineWidth / 2 + 3, g.lineWidth / 2 + 3, W - g.lineWidth - 6, H - g.lineWidth - 6); }
  g.fillStyle = o.fg || '#fff';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  if (o.glow) { g.shadowColor = o.glow; g.shadowBlur = H * 0.12; }
  if (o.vertical) {
    const chars = [...text], n = chars.length, step = (H * 0.9) / n;
    const fs = Math.min(W * 0.78, step * 0.92);
    g.font = `900 ${fs}px ${FONT}`;
    chars.forEach((ch, i) => g.fillText(ch, W / 2, H * 0.05 + step * (i + 0.5)));
  } else {
    const hasSub = !!o.sub;
    let fs = H * (hasSub ? 0.5 : 0.66);
    g.font = `900 ${fs}px ${FONT}`;
    const maxW = W * 0.9; const mw = g.measureText(text).width;
    if (mw > maxW) { fs *= maxW / mw; g.font = `900 ${fs}px ${FONT}`; }
    g.fillText(text, W / 2, hasSub ? H * 0.4 : H * 0.53);
    if (hasSub) {
      g.shadowBlur = 0;
      g.font = `700 ${H * 0.2}px ${FONT}`; g.globalAlpha = 0.9;
      g.fillText(o.sub, W / 2, H * 0.78);
    }
  }
  return canvasTex(cv);
}

const signBackMat = new THREE.MeshLambertMaterial({ color: 0x2b2b33 });
// A sign readable from both sides. Plane faces +z in local space (rotate group to aim).
function makeSign(text, o = {}) {
  const w = o.w || 8, h = o.h || 2;
  const group = new THREE.Group();
  const tex = textTexture(text, o);
  const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  const plane = new THREE.PlaneGeometry(w, h);
  const front = new THREE.Mesh(plane, mat); front.position.z = 0.13;
  group.add(front);
  if (o.double !== false) { const back = new THREE.Mesh(plane, mat); back.rotation.y = Math.PI; back.position.z = -0.13; group.add(back); }
  if (o.backing !== false) group.add(new THREE.Mesh(new THREE.BoxGeometry(w + 0.25, h + 0.25, 0.22), signBackMat));
  return group;
}

/* ---------------- world data ---------------- */
const obstacles = []; // {minX,maxX,minZ,maxZ}
function addObstacle(cx, cz, w, d) { obstacles.push({ minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2 }); }

const staticParts = [];  // vertex-coloured geometry merged into one mesh
const buildingParts = [[], [], [], [], []]; // per facade variant
const FACADES = [
  facadeTextures('#5d7fa3', '#2b3b55', 0.35, 'glass'),   // blue glass (CBD)
  facadeTextures('#c9b79a', '#4a4440', 0.30, 'window'),  // beige concrete
  facadeTextures('#6a6d75', '#30333a', 0.30, 'strip'),   // grey strip windows
  facadeTextures('#d9d6cf', '#3d4652', 0.28, 'window'),  // white tile residential
  facadeTextures('#3f5a6b', '#1d2b36', 0.45, 'glass'),   // dark glass
];

// textured building box with world-scaled UVs (one texture tile = 16 units)
function buildingBox(variant, w, h, d, cx, baseY, cz) {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
  const uv = g.attributes.uv;
  // face order after toNonIndexed: +x,-x,+y,-y,+z,-z (6 verts each)
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 6; v++) {
      const i = f * 6 + v;
      if (f === 2 || f === 3) { uv.setXY(i, 0.01, 0.01); continue; }
      const along = (f < 2 ? d : w) / 16, up = h / 16;
      uv.setXY(i, uv.getX(i) * along, uv.getY(i) * up);
    }
  }
  g.translate(cx, baseY + h / 2, cz);
  buildingParts[variant].push(g);
}

function addBuilding(cx, cz, w, d, h, variant) {
  buildingBox(variant, w, h, d, cx, 0, cz);
  addObstacle(cx, cz, w, d);
  const roll = Math.random();
  if (roll < 0.35 && h > 18) {
    // stepped crown
    const k = rand(0.55, 0.8), ch = rand(3, Math.min(14, h * 0.25));
    buildingBox(variant, w * k, ch, d * k, cx, h, cz);
    if (Math.random() < 0.5) staticParts.push(cbox(0.4, rand(4, 10), 0.4, cx + rand(-1, 1), h + ch + 3, cz, 0x9a9aa0));
  } else if (roll < 0.7) {
    // roof machinery
    staticParts.push(cbox(w * 0.3, 2, d * 0.25, cx + w * 0.15, h + 1, cz - d * 0.1, 0x8f8f94));
    staticParts.push(cbox(w * 0.9, 0.6, d * 0.9, cx, h + 0.3, cz, 0x7a7a80));
  } else {
    staticParts.push(cbox(w + 0.4, 0.8, d + 0.4, cx, h + 0.4, cz, 0x55575e));
  }
}

const signs = new THREE.Group();
scene.add(signs);
function placeSign(sign, x, y, z, rotY = 0) { sign.position.set(x, y, z); sign.rotation.y = rotY; signs.add(sign); return sign; }

/* ---------------- ground & roads ---------------- */
{
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshLambertMaterial({ color: 0x5f6b55 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.05; ground.receiveShadow = true;
  scene.add(ground);
}

function roadTexture(halfW, lanes, median) {
  const ppu = 8, W = 20 * ppu, H = halfW * 2 * ppu;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#3a3c42'; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 260; i++) { g.fillStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'},0.05)`; g.fillRect(Math.random() * W, Math.random() * H, 2, 2); }
  const yOf = (off) => H / 2 + off * ppu;
  g.fillStyle = '#e8e8e8';
  g.fillRect(0, yOf(-halfW + 0.6), W, 3); g.fillRect(0, yOf(halfW - 0.6) - 3, W, 3);
  if (!median) { g.fillStyle = '#f2c230'; g.fillRect(0, yOf(0) - 4, W, 2.5); g.fillRect(0, yOf(0) + 1.5, W, 2.5); }
  g.fillStyle = '#e8e8e8';
  for (let k = 0; k < lanes.length - 1; k++) {
    const div = (lanes[k] + lanes[k + 1]) / 2;
    for (const s of [-1, 1]) for (let x = 0; x < W; x += 80) g.fillRect(x + 10, yOf(s * div) - 1.5, 48, 3);
  }
  const t = canvasTex(cv, true);
  return t;
}

const asphaltMat = new THREE.MeshLambertMaterial({ color: 0x3a3c42 });
{
  const len = MAP.maxX - MAP.minX + 120;
  const lenZ = MAP.maxZ - MAP.minZ + 120;
  for (const r of ZROADS) {
    const tex = roadTexture(r.hw, r.hw > 10 ? LANES_SHENNAN : LANES_SMALL, r.hw > 10);
    tex.repeat.set(len / 20, 1);
    const g = new THREE.PlaneGeometry(len, r.hw * 2); g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex }));
    m.position.set(0, 0.02, r.z); m.receiveShadow = true; scene.add(m);
  }
  const texX = roadTexture(XHW, LANES_SMALL, false); texX.repeat.set(lenZ / 20, 1);
  const matX = new THREE.MeshLambertMaterial({ map: texX });
  for (const r of XROADS) {
    const g = new THREE.PlaneGeometry(lenZ, XHW * 2); g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, matX);
    m.rotation.y = Math.PI / 2; m.position.set(r.x, 0.025, 0); m.receiveShadow = true; scene.add(m);
  }
  // intersections + crosswalks
  const stripes = [];
  for (const xr of XROADS) for (const zr of ZROADS) {
    const g = new THREE.PlaneGeometry(XHW * 2, zr.hw * 2); g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, asphaltMat); m.position.set(xr.x, 0.035, zr.z); m.receiveShadow = true; scene.add(m);
    for (const s of [-1, 1]) {
      for (let off = -zr.hw + 1.2; off < zr.hw - 0.8; off += 1.7) stripes.push([xr.x + s * (XHW + 2), zr.z + off, 3.2, 0.8]);
      for (let off = -XHW + 1.2; off < XHW - 0.8; off += 1.7) stripes.push([xr.x + off, zr.z + s * (zr.hw + 2), 0.8, 3.2]);
    }
  }
  const im = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xe6e6e6 }), stripes.length);
  const mtx = new THREE.Matrix4();
  stripes.forEach((s, i) => { mtx.makeScale(s[2], 1, s[3]); mtx.setPosition(s[0], 0.045, s[1]); im.setMatrixAt(i, mtx); });
  im.receiveShadow = true;
  scene.add(im);
}

/* ---------------- blocks ---------------- */
function intervals(roads, key, hwOf, min, max) {
  const out = []; let start = min;
  for (const r of roads) { out.push([start, r[key] - hwOf(r)]); start = r[key] + hwOf(r); }
  out.push([start, max]);
  return out;
}
const xBlocks = intervals(XROADS, 'x', () => XHW, MAP.minX - 60, MAP.maxX + 60);
const zBlocks = intervals(ZROADS, 'z', (r) => r.hw, MAP.minZ - 60, MAP.maxZ + 60);

const trees = []; // [x, z, scale, colorHex]
function treeAt(x, z, s = 1) { trees.push([x, z, s * rand(0.85, 1.15), pick([0x3f7d3a, 0x4d8c3f, 0x2f6b3a, 0x5c9440])]); }

function fillRegion(x0, x1, z0, z1, opts = {}) {
  const W = x1 - x0, D = z1 - z0;
  if (W < 8 || D < 8) return;
  const nx = Math.max(1, Math.round(W / (opts.lot || 26))), nz = Math.max(1, Math.round(D / (opts.lot || 26)));
  const lw = W / nx, ld = D / nz;
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    if (Math.random() < (opts.gap ?? 0.08)) { treeAt(x0 + lw * (i + 0.5), z0 + ld * (j + 0.5), 1.2); continue; }
    const w = Math.max(6, lw - rand(2.5, 7)), d = Math.max(6, ld - rand(2.5, 7));
    const cx = x0 + lw * (i + 0.5) + rand(-0.8, 0.8), cz = z0 + ld * (j + 0.5) + rand(-0.8, 0.8);
    let h = rand(opts.hMin || 12, opts.hMax || 42);
    if (Math.random() < 0.12) h *= 1.5;
    const variant = opts.variants ? pick(opts.variants) : randi(0, 4);
    addBuilding(cx, cz, w, d, h, variant);
  }
}

const NEON_TEXTS = ['电子世界', '手机大卖场', '数码广场', '电脑城', '芯片元器件', '无人机体验店', 'LED灯饰', '配件批发', '二手数码',
  '维修中心', '通讯市场', '创客空间', '电子市场', '耳机音响', '智能硬件', '充电宝', '摄影器材', '游戏机'];
const NEON_COLORS = [['#ff2d6f', '#fff'], ['#00e5ff', '#002b36'], ['#ffd400', '#3a1a00'], ['#7cff4f', '#073000'], ['#ff7a1a', '#fff'], ['#b06bff', '#fff']];
const SIDEWALK = 0x9d9c97;
for (const [bx0, bx1] of xBlocks) for (const [bz0, bz1] of zBlocks) {
  const cx = (bx0 + bx1) / 2, cz = (bz0 + bz1) / 2;
  staticParts.push(cbox(bx1 - bx0, 0.16, bz1 - bz0, cx, 0.08, cz, SIDEWALK));
  const x0 = bx0 + 4.5, x1 = bx1 - 4.5, z0 = bz0 + 4.5, z1 = bz1 - 4.5;
  const outside = bx1 <= MAP.minX + 1 || bx0 >= MAP.maxX - 1 || bz1 <= MAP.minZ + 1 || bz0 >= MAP.maxZ - 1;
  const isBlock = (ax, az) => Math.abs(cx - ax) < 1 && Math.abs(cz - az) < 1;

  // special blocks
  if (isBlock(-120, 60)) continue;   // 平安金融中心
  if (isBlock(-120, -60)) continue;  // 市民中心
  if (isBlock(-120, -165)) continue; // 莲花山
  if (Math.abs(cx - 120) < 1 && (isBlock(120, -165) || isBlock(120, -60))) { // west of 华强北
    huaqiangFrontage(cx, bz0, bz1, -1);
    fillRegion(x0, 136, z0, z1, { hMin: 14, hMax: 40 });
    continue;
  }
  if (Math.abs(cx - 240) < 1 && (isBlock(240, -165) || isBlock(240, -60))) { // east of 华强北
    huaqiangFrontage(cx, bz0, bz1, 1);
    if (isBlock(240, -165)) fillRegion(224, x1, z0, z1, { hMin: 14, hMax: 40 });
    continue;
  }
  const nearShennan = Math.abs(cz) < 120, cbd = cx < 80;
  if (outside) fillRegion(x0, x1, z0, z1, { hMin: 18, hMax: 55, gap: 0 });
  else if (nearShennan && cbd) fillRegion(x0, x1, z0, z1, { hMin: 24, hMax: 72, variants: [0, 0, 4, 4, 2, 1], lot: 30 });
  else if (nearShennan) fillRegion(x0, x1, z0, z1, { hMin: 16, hMax: 55 });
  else fillRegion(x0, x1, z0, z1, { hMin: 10, hMax: 38, variants: [1, 2, 3, 3], gap: 0.12 });
}

/* ---------------- 华强北 ---------------- */
function huaqiangFrontage(blockCx, bz0, bz1, side) {
  // side = -1: block west of the road (facade faces +x); side = +1: east (faces -x)
  const roadX = 180, faceX = roadX + side * (XHW + 5), depth = 20;
  const cx = faceX + side * depth / 2;
  let z = bz0 + 5;
  while (z < bz1 - 10) {
    const len = Math.min(rand(14, 24), bz1 - 5 - z);
    if (len < 8) break;
    const h = rand(14, 30);
    addBuilding(cx, z + len / 2, depth, len - 1.5, h, pick([1, 2, 3, 4]));
    const [bg, fg] = pick(NEON_COLORS);
    const rot = side < 0 ? Math.PI / 2 : -Math.PI / 2;
    const fx = faceX + side * -0.05 - side * 0.3;
    if (Math.random() < 0.55) {
      placeSign(makeSign(pick(NEON_TEXTS), { w: Math.min(12, len - 3), h: 2.6, bg, fg, glow: fg, double: false, backing: false }), fx, rand(6, Math.min(12, h - 2)), z + len / 2, rot);
    } else {
      const t = pick(NEON_TEXTS).slice(0, 5);
      placeSign(makeSign(t, { w: 2.6, h: Math.max(6, t.length * 2.2), bg, fg, glow: fg, vertical: true, double: false, backing: false }), fx, h * 0.55, z + len / 2 + rand(-len / 4, len / 4), rot);
    }
    // ground-floor shop band
    placeSign(makeSign(pick(NEON_TEXTS), { w: len - 3, h: 1.4, bg: '#1d1d24', fg: pick(['#ffd400', '#00e5ff', '#ff5a8a', '#ffffff']), double: false, backing: false }), fx, 3.6, z + len / 2, rot);
    z += len;
  }
}
// 华强北 gateway arch over the road just north of Shennan
{
  const zA = -30;
  staticParts.push(cbox(1.6, 11, 1.6, 180 - 11.5, 5.5, zA, 0xb8302a), cbox(1.6, 11, 1.6, 180 + 11.5, 5.5, zA, 0xb8302a));
  staticParts.push(cbox(26, 0.8, 2, 180, 11.4, zA, 0x8c2420));
  addObstacle(180 - 11.5, zA, 1.6, 1.6); addObstacle(180 + 11.5, zA, 1.6, 1.6);
  placeSign(makeSign('华强北', { w: 18, h: 4.2, bg: '#c21f2a', fg: '#ffe066', border: '#ffd34d', glow: '#ffae00', sub: 'HUAQIANGBEI · 电子第一街' }), 180, 9, zA, 0);
}
// SEG-style tower (赛格广场) east of 华强北
{
  const x = 248, z = -62, w = 30, h = 102;
  buildingBox(4, w, h, w, x, 0, z);
  buildingBox(4, w * 0.8, 6, w * 0.8, x, h, z);
  addObstacle(x, z, w, w);
  staticParts.push(cbox(0.8, 26, 0.8, x - 6, h + 6 + 13, z, 0xc8c8cc), cbox(0.8, 22, 0.8, x + 6, h + 6 + 11, z, 0xc8c8cc));
  placeSign(makeSign('赛格广场', { w: 22, h: 4.5, bg: '#0f2a52', fg: '#ffffff', glow: '#6fd3ff', double: false, backing: false }), x - w / 2 - 0.3, h - 6, z, -Math.PI / 2);
  placeSign(makeSign('赛格广场', { w: 22, h: 4.5, bg: '#0f2a52', fg: '#ffffff', glow: '#6fd3ff', double: false, backing: false }), x, h - 6, z + w / 2 + 0.3, 0);
  placeSign(makeSign('赛格电子市场', { w: 20, h: 2.6, bg: '#e03a1e', fg: '#fff', double: false, backing: false }), x - w / 2 - 0.3, 6, z, -Math.PI / 2);
}

/* ---------------- 平安金融中心 (stylised) ---------------- */
const towerMats = [];
{
  const cx = -120, cz = 60;
  // facade texture: glass with silver vertical ribs
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 128;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 128, 0); grad.addColorStop(0, '#6f8fb0'); grad.addColorStop(0.5, '#a9c3db'); grad.addColorStop(1, '#6f8fb0');
  g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  g.fillStyle = 'rgba(30,45,70,0.35)'; for (let y = 0; y < 128; y += 16) g.fillRect(0, y, 128, 3);
  g.fillStyle = '#e6eaee'; g.fillRect(0, 0, 10, 128); g.fillRect(118, 0, 10, 128);
  const ce = document.createElement('canvas'); ce.width = 128; ce.height = 128;
  const e = ce.getContext('2d'); e.fillStyle = '#000'; e.fillRect(0, 0, 128, 128);
  for (let y = 4; y < 128; y += 16) for (let x = 14; x < 114; x += 20) if (Math.random() < 0.45) { e.fillStyle = '#8fb8ff'; e.fillRect(x, y, 14, 9); }
  const map = canvasTex(cv, true), em = canvasTex(ce, true);
  map.repeat.set(8, 26); em.repeat.set(8, 26);
  const mat = new THREE.MeshLambertMaterial({ map, emissiveMap: em, emissive: 0xffffff, emissiveIntensity: 0.55, flatShading: true });
  towerMats.push(mat);
  const tower = new THREE.Group();
  // shaft: octagon (chamfered square) tapering upward
  const sections = [[0, 120, 19, 16.5], [120, 150, 16.5, 13.5], [150, 166, 13.5, 10], [166, 176, 10, 6.5]];
  for (const [y0, y1, r0, r1] of sections) {
    const geo = new THREE.CylinderGeometry(r1, r0, y1 - y0, 8, 1);
    geo.rotateY(Math.PI / 8);
    const m = new THREE.Mesh(geo, mat); m.position.y = (y0 + y1) / 2; m.castShadow = true; tower.add(m);
  }
  // corner ribs
  const ribMat = new THREE.MeshLambertMaterial({ color: 0xdfe4ea });
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + k * Math.PI / 2;
    const rib = new THREE.Mesh(new THREE.BoxGeometry(1.6, 121, 1.6), ribMat);
    rib.position.set(Math.sin(a) * 17.1, 60, Math.cos(a) * 17.1);
    rib.rotation.set(Math.cos(a) * -0.0193, 0, Math.sin(a) * 0.0193);
    tower.add(rib);
  }
  const spire = new THREE.Mesh(new THREE.ConeGeometry(1.6, 42, 6), ribMat);
  spire.position.y = 176 + 21; tower.add(spire);
  // podium
  const pod = new THREE.Mesh(new THREE.BoxGeometry(64, 12, 52), new THREE.MeshLambertMaterial({ color: 0x8aa2b8 }));
  pod.position.y = 6; pod.castShadow = pod.receiveShadow = true; tower.add(pod);
  tower.position.set(cx, 0, cz);
  scene.add(tower);
  addObstacle(cx, cz, 64, 52);
  // plaza
  staticParts.push(cbox(96, 0.2, 76, cx, 0.12, cz, 0xb9b3a6));
  // signs
  placeSign(makeSign('平安金融中心', { w: 30, h: 4.6, bg: '#0a1d3a', fg: '#ffffff', glow: '#7fc4ff', border: '#7fc4ff', sub: 'PING AN FINANCE CENTER', double: false }), cx, 8, cz - 26.4, Math.PI);
  placeSign(makeSign('平安金融中心', { w: 22, h: 4, bg: '#0a1d3a', fg: '#ffffff', glow: '#7fc4ff', double: false, backing: false }), cx, 160, cz - 11.2, Math.PI);
  placeSign(makeSign('平安金融中心', { w: 22, h: 4, bg: '#0a1d3a', fg: '#ffffff', glow: '#7fc4ff', double: false, backing: false }), cx, 160, cz + 11.2, 0);
  placeSign(makeSign('平安金融中心', { w: 22, h: 4, bg: '#0a1d3a', fg: '#ffffff', glow: '#7fc4ff', double: false, backing: false }), cx - 11.2, 160, cz, -Math.PI / 2);
  placeSign(makeSign('平安金融中心', { w: 22, h: 4, bg: '#0a1d3a', fg: '#ffffff', glow: '#7fc4ff', double: false, backing: false }), cx + 11.2, 160, cz, Math.PI / 2);
  for (let i = 0; i < 10; i++) treeAt(cx - 44 + i * 9.7, cz - 34, 0.9);
}

/* ---------------- 市民中心 & 莲花山 ---------------- */
{
  const cx = -120, cz = -60;
  staticParts.push(cbox(96, 0.2, 76, cx, 0.12, cz, 0xb9b3a6));
  buildingBox(1, 30, 14, 34, cx - 26, 0, cz - 4); addObstacle(cx - 26, cz - 4, 30, 34);
  buildingBox(1, 30, 14, 34, cx + 26, 0, cz - 4); addObstacle(cx + 26, cz - 4, 30, 34);
  buildingBox(0, 18, 20, 30, cx, 0, cz - 4); addObstacle(cx, cz - 4, 18, 30);
  // big wing roof
  const roofGroup = new THREE.Group();
  const flat = new THREE.Mesh(new THREE.BoxGeometry(92, 2.4, 40), new THREE.MeshLambertMaterial({ color: 0xa9bccf, flatShading: true }));
  flat.position.set(cx, 22.5, cz - 4); flat.castShadow = true;
  roofGroup.add(flat);
  const bump = new THREE.Mesh(new THREE.SphereGeometry(14, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xd8c27a, flatShading: true }));
  bump.position.set(cx, 23.5, cz - 4); bump.scale.set(1, 0.45, 1);
  roofGroup.add(bump);
  scene.add(roofGroup);
  placeSign(makeSign('市民中心', { w: 16, h: 3.2, bg: '#7a1f1f', fg: '#ffe9a8', glow: '#ffb347', double: false }), cx, 6, cz + 13.4, 0);
}
{
  const cx = -120, cz = -165;
  staticParts.push(cbox(100, 0.25, 90, cx, 0.13, cz, 0x5c8a4a));
  const hill = new THREE.Mesh(new THREE.IcosahedronGeometry(28, 1), new THREE.MeshLambertMaterial({ color: 0x4f8a45, flatShading: true }));
  hill.scale.set(1.2, 0.55, 1); hill.position.set(cx, -2, cz - 6); hill.receiveShadow = true;
  scene.add(hill);
  addObstacle(cx, cz - 6, 56, 46);
  for (let i = 0; i < 45; i++) { const a = rand(0, Math.PI * 2), r = rand(30, 44); treeAt(cx + Math.cos(a) * r, cz + Math.sin(a) * r * 0.85, 1.1); }
  placeSign(makeSign('莲花山公园', { w: 12, h: 2.6, bg: '#2f4a2a', fg: '#f5e6b8', double: true }), cx, 2.2, cz + 40, 0);
}

/* ---------------- 深南大道: median, trees, gantries ---------------- */
{
  let start = MAP.minX - 60;
  const segs = [];
  for (const r of XROADS) { segs.push([start, r.x - XHW - 1]); start = r.x + XHW + 1; }
  segs.push([start, MAP.maxX + 60]);
  for (const [a, b] of segs) {
    staticParts.push(cbox(b - a, 0.4, 3.2, (a + b) / 2, 0.2, 0, 0x8a8a86), cbox(b - a - 0.4, 0.1, 2.6, (a + b) / 2, 0.42, 0, 0x4d8a3c));
    obstacles.push({ minX: a, maxX: b, minZ: -1.6, maxZ: 1.6 });
    for (let x = a + 6; x < b - 4; x += 11) treeAt(x, 0, 0.9);
    for (let x = a + 4; x < b - 2; x += 14) { treeAt(x, -22.5, 1); treeAt(x + 7, 22.5, 1); }
  }
  for (const gx of [-240, 0, 240]) {
    for (const pz of [-21.5, 21.5]) { staticParts.push(cbox(0.7, 8.5, 0.7, gx, 4.25, pz, 0x707680)); addObstacle(gx, pz, 0.7, 0.7); }
    staticParts.push(cbox(0.7, 8.5, 0.7, gx, 4.25, 0, 0x707680));
    staticParts.push(cbox(0.6, 0.6, 44, gx, 8.3, 0, 0x707680));
    const east = gx < 100 ? '华强北 →' : '罗湖 →', west = gx > -100 ? '← 平安金融中心' : '← 南山';
    placeSign(makeSign('深南大道', { w: 13, h: 4, bg: '#1559b5', fg: '#fff', border: '#fff', sub: `SHENNAN BLVD   ${east}`, double: false }), gx - 0.5, 10.2, 10.5, -Math.PI / 2);
    placeSign(makeSign('深南大道', { w: 13, h: 4, bg: '#1559b5', fg: '#fff', border: '#fff', sub: `${west}   SHENNAN BLVD`, double: false }), gx + 0.5, 10.2, -10.5, Math.PI / 2);
  }
}

/* ---------------- traffic lights + street-name signs ---------------- */
const lampMats = {};
const LAMP_ON = { r: 0xff2a2a, y: 0xffc21a, g: 0x2bff6a }, LAMP_OFF = { r: 0x3a1010, y: 0x3a2c08, g: 0x0c2e14 };
for (const axis of ['ew', 'ns']) for (const c of ['r', 'y', 'g']) lampMats[axis + c] = new THREE.MeshBasicMaterial({ color: LAMP_OFF[c], toneMapped: false });
{
  const poles = [], heads = [], lamps = { ewr: [], ewy: [], ewg: [], nsr: [], nsy: [], nsg: [] };
  const nameSignCache = {};
  for (const xr of XROADS) for (const zr of ZROADS) {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const px = xr.x + sx * (XHW + 1.6), pz = zr.z + sz * (zr.hw + 1.6);
      poles.push([px, 3, pz, 0.25, 6, 0.25]);
      heads.push([px, 6.6, pz, 0.9, 2.6, 0.9]);
      addObstacle(px, pz, 0.5, 0.5);
      ['r', 'y', 'g'].forEach((c, k) => {
        const y = 7.5 - k * 0.85;
        // faces +-x show the east-west signal, faces +-z show north-south
        lamps['ew' + c].push([px + 0.47, y, pz], [px - 0.47, y, pz]);
        lamps['ns' + c].push([px, y, pz + 0.47], [px, y, pz - 0.47]);
      });
    }
    // street name plates on the NE corner pole
    const px = xr.x + XHW + 1.6, pz = zr.z - zr.hw - 1.6;
    const mk = (t) => { if (!nameSignCache[t]) nameSignCache[t] = textTexture(t, { w: 5, h: 1.1, bg: '#1559b5', fg: '#fff', border: '#fff', ppu: 48 }); return nameSignCache[t]; };
    const plateGeo = new THREE.PlaneGeometry(5, 1.1);
    const s1 = new THREE.Group();
    const m1 = new THREE.MeshBasicMaterial({ map: mk(zr.name), toneMapped: false, side: THREE.DoubleSide });
    s1.add(new THREE.Mesh(plateGeo, m1));
    s1.position.set(px + 2.6, 9.2, pz); signs.add(s1);
    const s2 = new THREE.Group();
    const m2 = new THREE.MeshBasicMaterial({ map: mk(xr.name), toneMapped: false, side: THREE.DoubleSide });
    s2.add(new THREE.Mesh(plateGeo, m2));
    s2.position.set(px, 8.0, pz - 2.6); s2.rotation.y = Math.PI / 2; signs.add(s2);
    poles.push([px, 4.6, pz, 0.2, 9.2, 0.2]);
  }
  const mtx = new THREE.Matrix4();
  const inst = (list, geo, mat) => {
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((p, i) => { mtx.makeScale(p[3] ?? 1, p[4] ?? 1, p[5] ?? 1); mtx.setPosition(p[0], p[1], p[2]); im.setMatrixAt(i, mtx); });
    scene.add(im); return im;
  };
  inst(poles, new THREE.CylinderGeometry(1, 1, 1, 6), new THREE.MeshLambertMaterial({ color: 0x5c626b }));
  inst(heads, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0x1e2126 }));
  const lampGeo = new THREE.SphereGeometry(0.34, 6, 4);
  for (const k in lamps) inst(lamps[k], lampGeo, lampMats[k]);
}

function lightState(t) {
  const c = ((t % LIGHT_CYCLE) + LIGHT_CYCLE) % LIGHT_CYCLE;
  if (c < 8) return { ew: 'g', ns: 'r' };
  if (c < 10) return { ew: 'y', ns: 'r' };
  if (c < 11) return { ew: 'r', ns: 'r' };
  if (c < 19) return { ew: 'r', ns: 'g' };
  if (c < 21) return { ew: 'r', ns: 'y' };
  return { ew: 'r', ns: 'r' };
}
let lastLightKey = '';
function updateLampMaterials(ls) {
  const key = ls.ew + ls.ns;
  if (key === lastLightKey) return;
  lastLightKey = key;
  for (const axis of ['ew', 'ns']) for (const c of ['r', 'y', 'g']) lampMats[axis + c].color.setHex(ls[axis] === c ? LAMP_ON[c] : LAMP_OFF[c]);
}

/* ---------------- boundary skyline (blocks the void beyond the map) ---------------- */
{
  for (const r of ZROADS) for (const s of [-1, 1]) buildingBox(randi(0, 4), 16, rand(22, 50), r.hw * 2 + 10, s * (MAP.maxX + 22), 0, r.z);
  for (const r of XROADS) for (const s of [-1, 1]) buildingBox(randi(0, 4), XHW * 2 + 10, rand(22, 50), 16, r.x, 0, s * (MAP.maxZ + 22));
}

/* ---------------- trees (instanced) ---------------- */
{
  const n = trees.length;
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.35, 2.4, 5), new THREE.MeshLambertMaterial({ color: 0x6b4a32 }), n);
  const crownGeo = new THREE.IcosahedronGeometry(1.9, 0);
  const crown = new THREE.InstancedMesh(crownGeo, new THREE.MeshLambertMaterial({ flatShading: true }), n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler();
  trees.forEach(([x, z, sc, col], i) => {
    m.makeScale(sc, sc, sc); m.setPosition(x, 1.2 * sc, z); trunk.setMatrixAt(i, m);
    e.set(0, Math.random() * 6, 0); q.setFromEuler(e); s.set(sc, sc * 1.2, sc); p.set(x, 3.6 * sc, z);
    m.compose(p, q, s); crown.setMatrixAt(i, m); crown.setColorAt(i, tmpColor.set(col));
  });
  crown.castShadow = true;
  scene.add(trunk, crown);
}

/* ---------------- merge static meshes ---------------- */
{
  const m = new THREE.Mesh(mergeGeos(staticParts), new THREE.MeshLambertMaterial({ vertexColors: true }));
  m.receiveShadow = true; m.castShadow = true; scene.add(m);
  buildingParts.forEach((parts, i) => {
    if (!parts.length) return;
    const f = FACADES[i];
    const mesh = new THREE.Mesh(mergeGeos(parts), new THREE.MeshLambertMaterial({ map: f.map, emissiveMap: f.emissive, emissive: 0xffffff, emissiveIntensity: 0.85 }));
    mesh.castShadow = true; mesh.receiveShadow = true; scene.add(mesh);
  });
}

/* =========================================================
   Vehicles
   ========================================================= */
const carGeoCache = {};
function carGeometry(kind, bodyHex) {
  const key = kind + bodyHex;
  if (carGeoCache[key]) return carGeoCache[key];
  const parts = [];
  const glass = 0x1c2733, dark = 0x1a1a1d;
  {
    parts.push(cbox(2.0, 0.7, 4.4, 0, 0.75, 0, bodyHex));
    parts.push(cbox(1.74, 0.62, 2.2, 0, 1.4, -0.25, glass));
    parts.push(cbox(1.6, 0.1, 1.9, 0, 1.75, -0.25, bodyHex));
    parts.push(cbox(2.04, 0.22, 4.46, 0, 0.45, 0, 0x2a2a2e));
    for (const z of [-1.4, 1.4]) for (const x of [-0.95, 0.95]) parts.push(colorize(new THREE.CylinderGeometry(0.42, 0.42, 0.34, 8).rotateZ(Math.PI / 2).toNonIndexed().translate(x, 0.42, z), dark));
    for (const x of [-0.65, 0.65]) { parts.push(cbox(0.42, 0.2, 0.06, x, 0.86, 2.21, 0xfff3c4)); parts.push(cbox(0.42, 0.18, 0.06, x, 0.86, -2.21, 0xd81e1e)); }
    if (kind === 'taxi') parts.push(cbox(0.8, 0.28, 0.4, 0, 1.94, -0.2, 0xfff2a0));
    if (kind === 'police') {
      parts.push(cbox(2.06, 0.26, 3.2, 0, 0.92, 0.1, 0x1446c2));
      parts.push(cbox(1.3, 0.12, 0.4, 0, 1.86, -0.25, 0x333333));
    }
    if (kind === 'player') {
      parts.push(cbox(0.36, 0.72, 4.42, -0.38, 0.76, 0, 0xffffff), cbox(0.36, 0.72, 4.42, 0.38, 0.76, 0, 0xffffff));
      parts.push(cbox(1.9, 0.12, 0.5, 0, 1.25, -2.05, 0x222222), cbox(0.12, 0.3, 0.12, -0.7, 1.08, -2.05, 0x222222), cbox(0.12, 0.3, 0.12, 0.7, 1.08, -2.05, 0x222222));
    }
  }
  return (carGeoCache[key] = mergeGeos(parts));
}
const carMat = new THREE.MeshLambertMaterial({ vertexColors: true });
const policeRed = new THREE.MeshBasicMaterial({ color: 0xff2030, toneMapped: false });
const policeBlue = new THREE.MeshBasicMaterial({ color: 0x2060ff, toneMapped: false });
const policeTextTex = textTexture('POLICE 警察', { w: 3.2, h: 0.5, bg: '#ffffff', fg: '#1446c2', ppu: 80 });

function makeCarMesh(kind, hex) {
  const mesh = new THREE.Group();
  const body = new THREE.Mesh(carGeometry(kind, hex), carMat);
  body.castShadow = true;
  mesh.add(body);
  if (kind === 'police') {
    const lb = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.22, 0.38), policeRed); lb.position.set(-0.35, 1.97, -0.25);
    const rb = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.22, 0.38), policeBlue); rb.position.set(0.35, 1.97, -0.25);
    mesh.add(lb, rb);
    const tm = new THREE.MeshBasicMaterial({ map: policeTextTex });
    const pg = new THREE.PlaneGeometry(3.0, 0.42);
    const l = new THREE.Mesh(pg, tm); l.position.set(1.04, 0.95, 0.1); l.rotation.y = Math.PI / 2;
    const r = new THREE.Mesh(pg, tm); r.position.set(-1.04, 0.95, 0.1); r.rotation.y = -Math.PI / 2;
    mesh.add(l, r);
    mesh.userData.bars = [lb, rb];
  }
  scene.add(mesh);
  return mesh;
}

class Car {
  constructor(kind, hex, opts = {}) {
    this.kind = kind;
    this.mesh = makeCarMesh(kind, hex);
    this.x = 0; this.z = 0; this.h = 0; this.v = 0; this.steer = 0;
    this.maxSpeed = opts.maxSpeed || PLAYER_MAX;
    this.accel = opts.accel || 15;
    this.radius = CAR_R;
    this.mass = opts.mass || 1;
    this.roll = 0;
  }
  get fx() { return Math.sin(this.h); }
  get fz() { return Math.cos(this.h); }
  drive(throttle, steerIn, dt, steerRate = 5) {
    this.steer += clamp(steerIn - this.steer, -steerRate * dt, steerRate * dt);
    let v = this.v;
    if (throttle > 0) {
      if (v < 0) v += 32 * throttle * dt;
      else v += this.accel * throttle * (1 - Math.pow(v / this.maxSpeed, 2)) * dt + 0.0;
    } else if (throttle < 0) {
      if (v > 0.5) v += 34 * throttle * dt;
      else v = Math.max(-11, v + 9 * throttle * dt);
    } else {
      v -= Math.sign(v) * Math.min(Math.abs(v), 4 * dt);
    }
    v -= v * 0.05 * dt;
    this.v = clamp(v, -11, this.maxSpeed);
    const sp = Math.abs(this.v);
    const turnRate = 2.1 - 1.0 * Math.min(1, sp / this.maxSpeed);
    const dir = clamp(this.v / 5, -1, 1);
    this.h -= this.steer * turnRate * dir * dt;
    this.x += this.fx * this.v * dt;
    this.z += this.fz * this.v * dt;
    this.roll += ((-this.steer * dir * Math.min(1, sp / 25) * 0.07) - this.roll) * Math.min(1, dt * 6);
  }
  collideStatic() {
    let impact = 0;
    const r = this.radius;
    for (const b of obstacles) {
      if (this.x < b.minX - r || this.x > b.maxX + r || this.z < b.minZ - r || this.z > b.maxZ + r) continue;
      const cx = clamp(this.x, b.minX, b.maxX), cz = clamp(this.z, b.minZ, b.maxZ);
      let dx = this.x - cx, dz = this.z - cz, d2 = dx * dx + dz * dz;
      let nx, nz, push;
      if (d2 < 1e-6) {
        // centre inside the box: push out along the shallowest side
        const l = this.x - b.minX, rr = b.maxX - this.x, t = this.z - b.minZ, bt = b.maxZ - this.z;
        const m = Math.min(l, rr, t, bt);
        if (m === l) { nx = -1; nz = 0; push = l + r; } else if (m === rr) { nx = 1; nz = 0; push = rr + r; }
        else if (m === t) { nx = 0; nz = -1; push = t + r; } else { nx = 0; nz = 1; push = bt + r; }
      } else if (d2 < r * r) {
        const d = Math.sqrt(d2); nx = dx / d; nz = dz / d; push = r - d;
      } else continue;
      this.x += nx * push; this.z += nz * push;
      const dot = this.fx * nx + this.fz * nz;
      const into = -dot * this.v; // >0 when moving into the wall
      if (into > 0) {
        impact = Math.max(impact, into);
        this.v *= 1 - 0.85 * Math.abs(dot);
      }
    }
    const minX = MAP.minX + 4, maxX = MAP.maxX - 4, minZ = MAP.minZ + 4, maxZ = MAP.maxZ - 4;
    if (this.x < minX || this.x > maxX || this.z < minZ || this.z > maxZ) {
      this.x = clamp(this.x, minX, maxX); this.z = clamp(this.z, minZ, maxZ);
      impact = Math.max(impact, Math.abs(this.v) * 0.5); this.v *= 0.4;
    }
    return impact;
  }
  sync() {
    this.mesh.position.set(this.x, 0, this.z);
    this.mesh.rotation.set(0, this.h, this.roll, 'YXZ');
  }
}

/* ---------------- player ---------------- */
const player = new Car('player', 0xff6a1a, { maxSpeed: PLAYER_MAX, accel: 17 });

/* ---------------- traffic ---------------- */
const TRAFFIC_COLORS = [0xd9d9dc, 0x2b2b30, 0x9aa3ad, 0xb02424, 0x1f3f7a, 0xe8e2d0, 0x3f6e4a, 0x7a5a3a, 0xf0f0f0];
const traffic = [];
function laneSpawn(t) {
  // choose a road and a lane, not inside an intersection
  for (let tries = 0; tries < 30; tries++) {
    const ew = Math.random() < 0.58;
    if (ew) {
      const r = Math.random() < 0.45 ? ZROADS[2] : pick(ZROADS);
      const lanes = r.hw > 10 ? LANES_SHENNAN : LANES_SMALL;
      const dir = Math.random() < 0.5 ? 1 : -1;
      const s = rand(MAP.minX, MAP.maxX);
      if (XROADS.some((xr) => Math.abs(xr.x - s) < XHW + 6)) continue;
      Object.assign(t, { axis: 'ew', road: r.z, dir, lane: dir * pick(lanes), s });
    } else {
      const r = pick(XROADS); const dir = Math.random() < 0.5 ? 1 : -1;
      const s = rand(MAP.minZ, MAP.maxZ);
      if (ZROADS.some((zr) => Math.abs(zr.z - s) < zr.hw + 6)) continue;
      Object.assign(t, { axis: 'ns', road: r.x, dir, lane: -dir * pick(LANES_SMALL), s });
    }
    t.place();
    if (Math.hypot(t.car.x - player.x, t.car.z - player.z) < 25) continue;
    if (traffic.some((o) => o !== t && Math.hypot(o.car.x - t.car.x, o.car.z - t.car.z) < 9)) continue;
    return;
  }
}
class TrafficCar {
  constructor() {
    const r = Math.random();
    const kind = r < 0.2 ? 'taxi' : 'car';
    const color = kind === 'taxi' ? 0x1f6fd6 : pick(TRAFFIC_COLORS);
    this.car = new Car(kind, color, { maxSpeed: 20 });
    this.cruise = rand(10, 15);
    this.ox = 0; this.oz = 0; this.oh = 0; this.bvx = 0; this.bvz = 0; this.bvh = 0; this.bumpT = 0;
    this.car.v = this.cruise;
    laneSpawn(this);
  }
  baseHeading() { return this.axis === 'ew' ? (this.dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (this.dir > 0 ? 0 : Math.PI); }
  place() {
    const c = this.car;
    if (this.axis === 'ew') { c.x = this.s + this.ox; c.z = this.road + this.lane + this.oz; }
    else { c.x = this.road + this.lane + this.ox; c.z = this.s + this.oz; }
    c.h = this.baseHeading() + this.oh;
  }
  distToStop() {
    let best = Infinity;
    if (this.axis === 'ew') {
      for (const xr of XROADS) { const stop = xr.x - this.dir * (XHW + 3.5); const a = (stop - this.s) * this.dir; if (a > -0.5 && a < best) best = a; }
    } else {
      for (const zr of ZROADS) { const stop = zr.z - this.dir * (zr.hw + 3.5); const a = (stop - this.s) * this.dir; if (a > -0.5 && a < best) best = a; }
    }
    return best;
  }
  update(dt, ls, vehicles) {
    const c = this.car;
    if (this.bumpT > 0) {
      this.bumpT -= dt;
      this.ox += this.bvx * dt; this.oz += this.bvz * dt; this.oh += this.bvh * dt;
      const damp = Math.exp(-dt * 2.5); this.bvx *= damp; this.bvz *= damp; this.bvh *= damp;
      c.v = 0;
      this.place();
      return;
    }
    // drift back into the lane after a bump
    const k = Math.min(1, dt * 1.2);
    this.ox -= this.ox * k; this.oz -= this.oz * k; this.oh -= this.oh * k;
    let target = this.cruise;
    const light = ls[this.axis];
    const ds = this.distToStop();
    const half = 2.2;
    if (light !== 'g' && ds < 30) {
      const committed = light === 'y' && ds < 5;
      if (!committed) target = Math.min(target, Math.max(0, (ds - half) * 0.7));
    }
    const fx = Math.sin(this.baseHeading()), fz = Math.cos(this.baseHeading());
    for (const o of vehicles) {
      if (o === c) continue;
      const rx = o.x - c.x, rz = o.z - c.z;
      const along = rx * fx + rz * fz;
      if (along <= 0 || along > 18) continue;
      const lat = Math.abs(rx * fz - rz * fx);
      if (lat < 2.8) target = Math.min(target, Math.max(0, (along - half - 4.5) * 1.1));
    }
    c.v += clamp(target - c.v, -14 * dt, 5 * dt);
    this.s += this.dir * c.v * dt;
    const lo = this.axis === 'ew' ? MAP.minX - 30 : MAP.minZ - 30, hi = this.axis === 'ew' ? MAP.maxX + 30 : MAP.maxZ + 30;
    if (this.s > hi) this.s = lo + 1; else if (this.s < lo) this.s = hi - 1;
    this.place();
    c.h = this.baseHeading() + this.oh;
  }
  bump(ix, iz, strength) {
    this.bumpT = 2.5;
    this.bvx += ix * strength * 0.6; this.bvz += iz * strength * 0.6; this.bvh += rand(-1, 1) * strength * 0.12;
  }
}

/* ---------------- police ---------------- */
const police = [];
const nodes = [];
XROADS.forEach((xr, i) => ZROADS.forEach((zr, j) => nodes.push({ i, j, x: xr.x, z: zr.z })));
const nodeAt = (i, j) => nodes.find((n) => n.i === i && n.j === j);
function nearestNode(x, z) {
  let best = null, bd = Infinity;
  for (const n of nodes) { const d = Math.abs(n.x - x) + Math.abs(n.z - z); if (d < bd) { bd = d; best = n; } }
  return best;
}
const policeMax = () => 39 + game.stars * 1.5;
class Police {
  constructor(spawnNode) {
    this.car = new Car('police', 0xf4f4f4, { maxSpeed: policeMax(), accel: 19, mass: 1.3 });
    this.car.x = spawnNode.x; this.car.z = spawnNode.z;
    this.car.h = Math.atan2(player.x - spawnNode.x, player.z - spawnNode.z);
    this.car.v = 12;
    this.target = spawnNode; this.mode = 'nav';
    this.stuckT = 0; this.reverseT = 0;
  }
  update(dt) {
    const c = this.car;
    c.maxSpeed = policeMax();
    const dx = player.x - c.x, dz = player.z - c.z, dist = Math.hypot(dx, dz);
    if (dist < 55) this.mode = 'chase';
    else if (dist > 75 && this.mode === 'chase') { this.mode = 'nav'; this.target = nearestNode(c.x, c.z); }
    let tx, tz;
    if (this.mode === 'chase') {
      const lead = Math.min(1, dist / 30) * 0.7;
      tx = player.x + player.fx * player.v * lead; tz = player.z + player.fz * player.v * lead;
    } else {
      if (Math.hypot(this.target.x - c.x, this.target.z - c.z) < 11) {
        const pn = nearestNode(player.x, player.z);
        const di = pn.i - this.target.i, dj = pn.j - this.target.j;
        if (di === 0 && dj === 0) { this.mode = 'chase'; }
        else {
          let ni = this.target.i, nj = this.target.j;
          if (Math.abs(di) > Math.abs(dj) || (Math.abs(di) === Math.abs(dj) && Math.abs(c.fx) > Math.abs(c.fz))) ni += Math.sign(di);
          else nj += Math.sign(dj);
          this.target = nodeAt(ni, nj);
        }
      }
      tx = this.target.x; tz = this.target.z;
    }
    const desired = Math.atan2(tx - c.x, tz - c.z);
    const diff = wrapAngle(desired - c.h);
    let throttle = 1, steer = clamp(-diff * 2.2, -1, 1);
    if (Math.abs(diff) > 1.0 && c.v > 18) throttle = -0.6;
    if (this.mode === 'chase' && dist < 30) {
      // close in to box the player in, instead of ramming straight through
      const desired = Math.abs(player.v) + Math.max(0, dist - 5) * 1.3 + 2;
      if (c.v > desired + 2) throttle = -1; else if (c.v > desired) throttle = 0;
    }
    if (this.reverseT > 0) {
      this.reverseT -= dt; throttle = -1; steer = -steer;
    } else {
      if (Math.abs(c.v) < 2) this.stuckT += dt; else this.stuckT = 0;
      if (this.stuckT > 1.3) { this.reverseT = 1.1; this.stuckT = 0; }
    }
    c.drive(throttle, steer, dt, 8);
    c.collideStatic();
    const bars = c.mesh.userData.bars;
    const flash = Math.floor(game.time * 6) % 2 === 0;
    bars[0].visible = flash; bars[1].visible = !flash;
  }
  remove() { scene.remove(this.car.mesh); }
}

/* =========================================================
   Audio (all synthesised with WebAudio, no external files)
   ========================================================= */
const sfx = {
  ctx: null, muted: false,
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.7; this.master.connect(ctx.destination);
    // engine
    this.eFilter = ctx.createBiquadFilter(); this.eFilter.type = 'lowpass'; this.eFilter.frequency.value = 500; this.eFilter.Q.value = 3;
    this.eGain = ctx.createGain(); this.eGain.gain.value = 0.0;
    this.eFilter.connect(this.eGain); this.eGain.connect(this.master);
    this.o1 = ctx.createOscillator(); this.o1.type = 'sawtooth'; this.o1.frequency.value = 50;
    this.o2 = ctx.createOscillator(); this.o2.type = 'square'; this.o2.frequency.value = 25;
    const g2 = ctx.createGain(); g2.gain.value = 0.5;
    this.o1.connect(this.eFilter); this.o2.connect(g2); g2.connect(this.eFilter);
    this.o1.start(); this.o2.start();
    // siren
    this.sGain = ctx.createGain(); this.sGain.gain.value = 0; this.sGain.connect(this.master);
    const sf = ctx.createBiquadFilter(); sf.type = 'bandpass'; sf.frequency.value = 1100; sf.Q.value = 0.8; sf.connect(this.sGain);
    this.s1 = ctx.createOscillator(); this.s1.type = 'square'; this.s1.frequency.value = 800; this.s1.connect(sf); this.s1.start();
    this.s2 = ctx.createOscillator(); this.s2.type = 'triangle'; this.s2.frequency.value = 803; this.s2.connect(sf); this.s2.start();
    // noise for crashes
    const len = ctx.sampleRate * 0.6, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
    this.noise = buf;
  },
  resume() { if (this.ctx && this.ctx.state !== 'running') this.ctx.resume(); },
  setMuted(m) { this.muted = m; if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.7, this.ctx.currentTime, 0.05); },
  update(speed, throttle, sirenVol, time, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const r = Math.min(1, Math.abs(speed) / PLAYER_MAX);
    const gears = 5, gpos = r * gears, gear = Math.min(gears - 1, Math.floor(gpos)), rpm = gpos - gear;
    const f = 42 + gear * 7 + rpm * 62 + Math.max(0, throttle) * 10;
    this.o1.frequency.setTargetAtTime(f, t, 0.05);
    this.o2.frequency.setTargetAtTime(f / 2, t, 0.05);
    this.eFilter.frequency.setTargetAtTime(300 + rpm * 500 + Math.max(0, throttle) * 600 + r * 500, t, 0.08);
    this.eGain.gain.setTargetAtTime(active ? 0.09 + Math.max(0, throttle) * 0.07 + r * 0.04 : 0, t, 0.1);
    // wail siren
    const sf = 720 + 520 * (0.5 + 0.5 * Math.sin(time * 2.4));
    this.s1.frequency.setTargetAtTime(sf, t, 0.02); this.s2.frequency.setTargetAtTime(sf * 1.004, t, 0.02);
    this.sGain.gain.setTargetAtTime(active ? sirenVol : 0, t, 0.15);
  },
  crash(intensity) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource(); src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900 + intensity * 60;
    const g = this.ctx.createGain(); g.gain.setValueAtTime(Math.min(0.9, 0.15 + intensity * 0.04), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    src.connect(f); f.connect(g); g.connect(this.master); src.start(t);
  },
  beep(freqs, dur = 0.12, type = 'square', vol = 0.12) {
    if (!this.ctx) return;
    let t = this.ctx.currentTime;
    for (const fr of freqs) {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type; o.frequency.value = fr; g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.02); t += dur * 0.9;
    }
  },
};

/* =========================================================
   Input
   ========================================================= */
const keys = { up: false, down: false, left: false, right: false };
const KEYMAP = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', Space: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
window.addEventListener('keydown', (e) => {
  const k = KEYMAP[e.code];
  if (k) { keys[k] = true; e.preventDefault(); }
  if (e.code === 'KeyM') toggleMute();
  if (e.code === 'Enter') { if (game.state === 'title') startGame(); else if (game.state === 'over') restart(); }
});
window.addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k) { keys[k] = false; e.preventDefault(); } });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
document.querySelectorAll('.tbtn').forEach((el) => {
  const k = el.dataset.k;
  const on = (e) => { e.preventDefault(); keys[k] = true; el.classList.add('active'); sfx.resume(); };
  const off = (e) => { e.preventDefault(); keys[k] = false; el.classList.remove('active'); };
  el.addEventListener('pointerdown', (e) => { try { el.setPointerCapture(e.pointerId); } catch (_) {} on(e); });
  el.addEventListener('pointerup', off); el.addEventListener('pointercancel', off); el.addEventListener('lostpointercapture', off);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
});
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
const muteBtn = document.getElementById('muteBtn');
function toggleMute() { sfx.setMuted(!sfx.muted); muteBtn.textContent = sfx.muted ? '🔇' : '🔊'; }
muteBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMute(); });
if (IS_TOUCH) document.getElementById('ctrlHint').textContent = '👆 左下 ◀ ▶ 转向，右下 油门 / 刹车';

/* =========================================================
   Game state & HUD
   ========================================================= */
const $ = (id) => document.getElementById(id);
const hud = { score: $('score'), best: $('best'), stars: $('stars'), starEls: [...$('stars').children], speed: $('speed'), msg: $('msg'),
  bustWrap: $('bustWrap'), bust: $('bust'), bustLabel: $('bustLabel'), escape: $('escapeLabel') };
const game = { state: 'title', time: 0, lightT: 0, score: 0, stars: 0, lastOffense: -10, escapeT: 0, bust: 0,
  spawnT: 0, best: +(localStorage.getItem('pc_best') || 0), escapes: 0, maxStars: 0, inter: null };
hud.best.textContent = '最高 ' + game.best;

let msgTimer = 0;
function showMsg(html, dur = 2) { hud.msg.innerHTML = html; hud.msg.classList.add('show'); msgTimer = dur; }

function addWanted(reason) {
  if (game.state !== 'play') return;
  if (game.time - game.lastOffense < 2.5) return;
  game.lastOffense = game.time;
  const before = game.stars;
  game.stars = Math.min(5, game.stars + 1);
  game.maxStars = Math.max(game.maxStars, game.stars);
  game.escapeT = 0;
  showMsg(`${reason}<small>${game.stars > before ? '通缉等级 +1' : '已是最高通缉！'}</small>`, 2.2);
  sfx.beep([660, 520], 0.12, 'square', 0.1);
}

function spawnPolice() {
  // every other police car tries to cut the player off from the front
  const ahead = police.length % 2 === 1;
  const ok = (n, wantAhead) => {
    const dx = n.x - player.x, dz = n.z - player.z, d = Math.hypot(dx, dz);
    if (d < 95 || d > 230) return false;
    if (!wantAhead) return true;
    return (dx * player.fx + dz * player.fz) / d > 0.5;
  };
  let list = nodes.filter((n) => ok(n, ahead));
  if (!list.length) list = nodes.filter((n) => ok(n, false));
  if (!list.length) list = nodes;
  const n = pick(list);
  police.push(new Police(n));
}

function resetTraffic() {
  for (const t of traffic) scene.remove(t.car.mesh);
  traffic.length = 0;
  const N = IS_TOUCH ? 34 : 50;
  for (let i = 0; i < N; i++) traffic.push(new TrafficCar());
}

function resetPlayer() {
  player.x = -255; player.z = 10.5; player.h = Math.PI / 2; player.v = 0; player.steer = 0;
  player.sync();
}

function clearPolice() { for (const p of police) p.remove(); police.length = 0; }

function startGame() {
  sfx.init(); sfx.resume();
  $('startScreen').classList.add('hidden');
  if (IS_TOUCH) {
    const el = document.documentElement;
    if (el.requestFullscreen) el.requestFullscreen().then(() => screen.orientation?.lock?.('landscape').catch(() => {})).catch(() => {});
  }
  game.state = 'play';
  game.lightT = 0; game.lastOffense = game.time; prevInter = null;
  showMsg('出发！<small>沿深南大道向东开，前方就是华强北</small>', 3);
}
function restart() {
  clearPolice(); resetPlayer();
  Object.assign(game, { state: 'play', score: 0, stars: 0, lastOffense: game.time, escapeT: 0, bust: 0, escapes: 0, maxStars: 0, inter: null });
  game.lightT = 0;
  $('overScreen').classList.add('hidden');
  sfx.resume();
}
function gameOver() {
  game.state = 'over';
  const s = Math.floor(game.score);
  if (s > game.best) { game.best = s; localStorage.setItem('pc_best', String(s)); }
  hud.best.textContent = '最高 ' + game.best;
  $('finalScore').textContent = s;
  $('finalBest').textContent = '历史最高 ' + game.best;
  $('finalStats').textContent = `甩掉警察 ${game.escapes} 次 · 最高通缉 ${'★'.repeat(game.maxStars) || '无'}`;
  setTimeout(() => $('overScreen').classList.remove('hidden'), 900);
  sfx.beep([523, 392, 330, 262], 0.22, 'triangle', 0.15);
}
$('startBtn').addEventListener('click', startGame);
$('againBtn').addEventListener('click', restart);

/* ---------------- intersection / red light detection ---------------- */
function intersectionAt(x, z) {
  for (let i = 0; i < XROADS.length; i++) {
    if (Math.abs(x - XROADS[i].x) >= XHW) continue;
    for (let j = 0; j < ZROADS.length; j++) if (Math.abs(z - ZROADS[j].z) < ZROADS[j].hw) return i * 10 + j;
  }
  return null;
}

/* ---------------- collisions between vehicles ---------------- */
function vehicleCollisions(allCars) {
  for (let a = 0; a < allCars.length; a++) {
    const A = allCars[a];
    for (let b = a + 1; b < allCars.length; b++) {
      const B = allCars[b];
      const dx = B.x - A.x, dz = B.z - A.z, rr = A.radius + B.radius;
      if (Math.abs(dx) > rr || Math.abs(dz) > rr) continue;
      const d = Math.hypot(dx, dz);
      if (d >= rr || d < 1e-4) continue;
      const nx = dx / d, nz = dz / d, overlap = rr - d;
      const avx = A.fx * A.v, avz = A.fz * A.v, bvx = B.fx * B.v, bvz = B.fz * B.v;
      const closing = (avx - bvx) * nx + (avz - bvz) * nz; // >0 when approaching
      const aT = A.traffic, bT = B.traffic;
      // positional separation (traffic is pushed more, it's "lighter" in game terms)
      const wa = aT ? 0.7 : bT ? 0.3 : 0.5, wb = 1 - wa;
      if (!aT) { A.x -= nx * overlap * wa; A.z -= nz * overlap * wa; }
      if (!bT) { B.x += nx * overlap * wb; B.z += nz * overlap * wb; }
      if (closing > 0) {
        const imp = closing;
        if (!aT) A.v *= 1 - Math.min(0.7, Math.abs(A.fx * nx + A.fz * nz) * 0.75);
        if (!bT) B.v *= 1 - Math.min(0.7, Math.abs(B.fx * nx + B.fz * nz) * 0.75);
        if (aT) aT.bump(-nx, -nz, imp + 4);
        if (bT) bT.bump(nx, nz, imp + 4);
        if (A === player || B === player) {
          const other = A === player ? B : A;
          if (imp > 3) sfx.crash(imp);
          if (other.traffic && imp > 4) addWanted('撞车了！');
          else if (other.kind === 'police') {
            const sgn = A === player ? 1 : -1; // n points from A to B
            const own = (player.fx * nx + player.fz * nz) * player.v * sgn;
            if (own > 9) addWanted('撞了警车！');
          }
        }
      } else if (aT || bT) {
        // resting contact with a traffic car: nudge it
        if (aT) { aT.ox -= nx * overlap; aT.oz -= nz * overlap; aT.place(); }
        if (bT) { bT.ox += nx * overlap; bT.oz += nz * overlap; bT.place(); }
      }
    }
  }
}

/* =========================================================
   Minimap
   ========================================================= */
const mm = $('minimap');
const mmCtx = mm.getContext('2d');
let mmBg = null;
function buildMinimap() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = mm.clientWidth, h = mm.clientHeight;
  mm.width = w * dpr; mm.height = h * dpr;
  const bg = document.createElement('canvas'); bg.width = mm.width; bg.height = mm.height;
  const g = bg.getContext('2d');
  const sx = bg.width / (MAP.maxX - MAP.minX), sz = bg.height / (MAP.maxZ - MAP.minZ);
  const X = (x) => (x - MAP.minX) * sx, Z = (z) => (z - MAP.minZ) * sz;
  g.fillStyle = 'rgba(30,30,50,0.9)'; g.fillRect(0, 0, bg.width, bg.height);
  g.fillStyle = '#4a7a42'; g.fillRect(X(-170), Z(-210), (100) * sx, 90 * sz);
  g.fillStyle = '#8a8a96';
  for (const r of ZROADS) { g.fillStyle = r.hw > 10 ? '#d9c38a' : '#8a8a96'; g.fillRect(0, Z(r.z - r.hw), bg.width, r.hw * 2 * sz); }
  g.fillStyle = '#8a8a96';
  for (const r of XROADS) { g.fillStyle = r.x === 180 ? '#ff7aa8' : '#8a8a96'; g.fillRect(X(r.x - XHW), 0, XHW * 2 * sx, bg.height); }
  g.fillStyle = '#7fc4ff'; g.fillRect(X(-135), Z(45), 30 * sx, 30 * sz);
  g.fillStyle = '#fff'; g.font = `bold ${10 * dpr}px ${FONT}`; g.textAlign = 'center';
  g.fillText('平安', X(-120), Z(95)); g.fillText('华强北', X(180), Z(-240) + 2 * dpr); g.fillText('市民中心', X(-120), Z(-70));
  g.fillStyle = '#ffe9a8'; g.textAlign = 'right'; g.fillText('深南大道', bg.width - 3 * dpr, Z(-24));
  mmBg = { canvas: bg, X, Z, dpr };
}
function drawMinimap() {
  if (!mmBg) return;
  const { X, Z, dpr } = mmBg;
  mmCtx.clearRect(0, 0, mm.width, mm.height);
  mmCtx.drawImage(mmBg.canvas, 0, 0);
  const flash = Math.floor(game.time * 5) % 2 === 0;
  for (const p of police) { mmCtx.fillStyle = flash ? '#ff3344' : '#3377ff'; mmCtx.beginPath(); mmCtx.arc(X(p.car.x), Z(p.car.z), 3.2 * dpr, 0, Math.PI * 2); mmCtx.fill(); }
  mmCtx.save();
  mmCtx.translate(X(player.x), Z(player.z));
  mmCtx.rotate(-player.h + Math.PI);
  mmCtx.fillStyle = '#ffb347'; mmCtx.strokeStyle = '#000'; mmCtx.lineWidth = 1 * dpr;
  mmCtx.beginPath(); mmCtx.moveTo(0, -6 * dpr); mmCtx.lineTo(4 * dpr, 5 * dpr); mmCtx.lineTo(-4 * dpr, 5 * dpr); mmCtx.closePath(); mmCtx.fill(); mmCtx.stroke();
  mmCtx.restore();
}

/* =========================================================
   Main loop
   ========================================================= */
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
function placeCameraInstant() {
  camPos.set(player.x - player.fx * 11, 5, player.z - player.fz * 11);
  camLook.set(player.x + player.fx * 4, 1.5, player.z + player.fz * 4);
  camera.position.copy(camPos); camera.lookAt(camLook);
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.fov = w < h ? 78 : 62;
  camera.updateProjectionMatrix();
  buildMinimap();
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', () => setTimeout(onResize, 200));

resetPlayer();
resetTraffic();
onResize();
placeCameraInstant();

let last = performance.now();
let prevInter = null;
function step(dt) {
  game.time += dt;
  game.lightT += dt;
  const ls = lightState(game.lightT);
  updateLampMaterials(ls);
  const playing = game.state === 'play';

  // player
  let throttle = 0, steer = 0;
  if (playing) {
    throttle = (keys.up ? 1 : 0) - (keys.down ? 1 : 0);
    steer = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  }
  player.drive(throttle, steer, dt);
  if (game.state === 'over') player.v *= Math.exp(-dt * 3);
  const wallHit = player.collideStatic();
  if (wallHit > 7) sfx.crash(wallHit);

  // red light check
  const inter = intersectionAt(player.x, player.z);
  if (playing && inter !== null && prevInter === null && Math.abs(player.v) > 4) {
    const axis = Math.abs(player.fx) > Math.abs(player.fz) ? 'ew' : 'ns';
    if (ls[axis] === 'r') addWanted('闯红灯！');
  }
  prevInter = inter;

  // traffic
  const vehicles = [player, ...police.map((p) => p.car), ...traffic.map((t) => t.car)];
  for (const t of traffic) t.update(dt, ls, vehicles);

  // police management
  if (playing && game.stars > 0) {
    const want = Math.min(5, game.stars + (game.stars >= 3 ? 1 : 0));
    game.spawnT -= dt;
    if (police.length < want && game.spawnT <= 0) { spawnPolice(); game.spawnT = 2.5; }
  }
  for (const p of police) p.update(dt);

  // vehicle collisions
  const all = [player, ...police.map((p) => p.car)];
  for (const t of traffic) { t.car.traffic = t; all.push(t.car); }
  vehicleCollisions(all);

  // wanted / escape / bust logic
  if (playing && game.stars > 0) {
    let nearest = Infinity;
    for (const p of police) nearest = Math.min(nearest, Math.hypot(p.car.x - player.x, p.car.z - player.z));
    const seen = nearest < 90;
    if (seen) game.escapeT = 0; else game.escapeT += dt;
    const need = 5 + game.stars * 2;
    hud.stars.classList.toggle('blink', !seen && police.length > 0);
    hud.escape.textContent = !seen && police.length > 0 ? `脱离视线 ${Math.max(0, need - game.escapeT).toFixed(1)}s` : (seen ? '警察就在附近！' : '');
    game.score += game.stars * 6 * dt;
    if (game.escapeT >= need && police.length > 0) {
      const bonus = game.stars * 500;
      game.score += bonus; game.escapes++;
      showMsg(`甩掉警察！<small>+${bonus} 分</small>`, 2.5);
      sfx.beep([523, 659, 784, 1047], 0.13, 'triangle', 0.14);
      game.stars = 0; game.escapeT = 0; game.bust = 0;
      clearPolice();
    }
    if (nearest < 6.8) game.bust += dt * (Math.abs(player.v) < 7 ? 1 : 0.4);
    else game.bust = Math.max(0, game.bust - dt * 0.6);
    if (game.bust >= 2) { game.bust = 2; gameOver(); }
  } else if (playing) {
    hud.stars.classList.remove('blink'); hud.escape.textContent = '';
    game.bust = 0;
  }
}

function render(dt) {
  player.sync();
  for (const p of police) p.car.sync();
  for (const t of traffic) t.car.sync();

  // camera
  const sp = Math.abs(player.v);
  const dist = 10.5 + sp * 0.07, height = 4.4 + sp * 0.03;
  // pull the camera in if a building sits between it and the car
  let d = dist;
  for (let t = 2; t <= dist; t += 1) {
    const px = player.x - player.fx * t, pz = player.z - player.fz * t;
    if (obstacles.some((b) => b.maxX - b.minX > 4 && b.maxZ - b.minZ > 4 && px > b.minX - 0.6 && px < b.maxX + 0.6 && pz > b.minZ - 0.6 && pz < b.maxZ + 0.6)) { d = Math.max(2.5, t - 1.2); break; }
  }
  const want = new THREE.Vector3(player.x - player.fx * d, height + (dist - d) * 0.5, player.z - player.fz * d);
  const k = 1 - Math.exp(-dt * 4.5);
  camPos.lerp(want, k);
  camLook.lerp(new THREE.Vector3(player.x + player.fx * 5, 1.6, player.z + player.fz * 5), 1 - Math.exp(-dt * 8));
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  scene.userData.sky.position.copy(camera.position);
  sun.position.set(player.x - 150, 130, player.z + 70);
  sun.target.position.set(player.x, 0, player.z);

  // HUD
  hud.score.textContent = Math.floor(game.score);
  hud.speed.textContent = Math.round(sp * 3.6);
  hud.starEls.forEach((el, i) => el.classList.toggle('on', i < game.stars));
  const b = game.bust / 2;
  hud.bustWrap.style.display = b > 0.01 ? 'block' : 'none';
  hud.bustLabel.style.display = b > 0.01 ? 'block' : 'none';
  hud.bust.style.width = (b * 100).toFixed(0) + '%';
  if (msgTimer > 0) { msgTimer -= dt; if (msgTimer <= 0) hud.msg.classList.remove('show'); }
  drawMinimap();

  // audio
  let sirenVol = 0;
  for (const p of police) { const d = Math.hypot(p.car.x - player.x, p.car.z - player.z); sirenVol = Math.max(sirenVol, Math.pow(Math.max(0, 1 - d / 200), 1.5) * 0.16); }
  const throttle = game.state === 'play' ? (keys.up ? 1 : 0) : 0;
  sfx.update(player.v, throttle, sirenVol, game.time, game.state !== 'title');

  renderer.render(scene, camera);
}

function frame(now) {
  let dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (game.state === 'title') {
    // slow orbit around the start area for the title screen
    game.time += dt; game.lightT += dt;
    updateLampMaterials(lightState(game.lightT));
    const ls = lightState(game.lightT);
    const vehicles = [player, ...traffic.map((t) => t.car)];
    for (const t of traffic) t.update(dt, ls, vehicles);
    for (const t of traffic) t.car.sync();
    player.sync();
    const a = game.time * 0.08;
    camera.position.set(-120 + Math.cos(a) * 230, 95, 30 + Math.sin(a) * 230);
    camera.lookAt(-120, 60, 30);
    scene.userData.sky.position.copy(camera.position);
    sun.position.set(-270, 130, 130); sun.target.position.set(-120, 0, 60);
    renderer.render(scene, camera);
    camPos.copy(camera.position); placeCameraInstant();
  } else {
    // sub-step physics for stability
    const steps = dt > 1 / 45 ? 2 : 1;
    for (let i = 0; i < steps; i++) step(dt / steps);
    render(dt);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
document.addEventListener('visibilitychange', () => { if (document.hidden) sfx.ctx?.suspend(); else if (game.state !== 'title') sfx.resume(); last = performance.now(); });

