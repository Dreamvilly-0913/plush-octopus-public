import * as THREE from 'three';
import {
  ARM_COUNT, ARM_PARTICLES, SEG_LEN, BODY, bodyPoint, bodyNormal, armHalfWidth, armHalfHeight, FUR_COLORS,
} from '../sim/rest.js';
import { slerpInto, qD2, m3Cofactor } from '../sim/qmath.js';
import { createFurMaterials, makeShellGeometry, setFurColors } from './furMaterial.js';

const NT = 64; // head rings (polar)
const NP = 84; // head segments (azimuth)
const RING = 18; // arm cross-section segments
const SUB = 4; // rings per rod segment
const CAP = 6; // rings closing the tip
const ROD_RINGS = (ARM_PARTICLES - 1) * SUB + 1;
const ARM_RINGS = ROD_RINGS + CAP;
const ARM_VERTS = ARM_RINGS * (RING + 1);
const SKIN_K = 5;

// natural grain directions in the (aTan, aBit) frame
const BODY_GRAIN = [0, 1]; // down from the crown
const ARM_GRAIN = [1, 0]; // out toward the tip
const GRAIN_LEAN = 0.55;

function makeFlowTexture(w, h, grain) {
  const data = new Uint8Array(w * h * 4);
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.userData = { w, h, grain, lean: new Float32Array(w * h * 2), nap: new Float32Array(w * h) };
  resetFlow(tex);
  return tex;
}

function resetFlow(tex) {
  const { w, h, grain, lean, nap } = tex.userData;
  for (let i = 0; i < w * h; i++) {
    lean[i * 2] = grain[0] * GRAIN_LEAN;
    lean[i * 2 + 1] = grain[1] * GRAIN_LEAN;
    nap[i] = 0;
  }
  encodeFlow(tex);
}

function encodeFlow(tex) {
  const { w, h, lean, nap } = tex.userData;
  const d = tex.image.data;
  for (let i = 0; i < w * h; i++) {
    d[i * 4] = Math.round((lean[i * 2] * 0.5 + 0.5) * 255);
    d[i * 4 + 1] = Math.round((lean[i * 2 + 1] * 0.5 + 0.5) * 255);
    d[i * 4 + 2] = Math.round((nap[i] * 0.5 + 0.5) * 255);
    d[i * 4 + 3] = 255;
  }
  tex.needsUpdate = true;
}

function irisTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#080404';
  g.fillRect(0, 0, 256, 256);
  const grad = g.createRadialGradient(128, 128, 20, 128, 128, 112);
  grad.addColorStop(0, '#2a100a');
  grad.addColorStop(0.45, '#57210f');
  grad.addColorStop(0.78, '#2e110a');
  grad.addColorStop(1, '#080404');
  g.fillStyle = grad;
  g.beginPath(); g.arc(128, 128, 112, 0, Math.PI * 2); g.fill();
  // fibres
  g.globalAlpha = 0.22;
  for (let i = 0; i < 90; i++) {
    const a = (i / 90) * Math.PI * 2 + Math.random() * 0.05;
    g.strokeStyle = i % 2 ? '#8c3b25' : '#2a0e09';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(128 + Math.cos(a) * 44, 128 + Math.sin(a) * 44);
    g.lineTo(128 + Math.cos(a) * 104, 128 + Math.sin(a) * 104);
    g.stroke();
  }
  g.globalAlpha = 1;
  g.fillStyle = '#050303';
  g.beginPath(); g.arc(128, 128, 40, 0, Math.PI * 2); g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class OctopusView {
  constructor(sim, scene) {
    this.sim = sim;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.colors = FUR_COLORS.coral;
    this.flowBody = makeFlowTexture(160, 80, BODY_GRAIN);
    this.flowArms = makeFlowTexture(72, ARM_COUNT * 18, ARM_GRAIN);
    this._buildBody();
    this._buildArms();
    this._buildEyes();
    this._buildDebug();
    this.setShells(20);
    this.setPile(7);
    this.update();
  }

  // ------------------------------------------------------------------ head
  _buildBody() {
    const sim = this.sim;
    const nv = (NT + 1) * (NP + 1);
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(nv * 3);
    const nor = new Float32Array(nv * 3);
    const tan = new Float32Array(nv * 3);
    const bit = new Float32Array(nv * 3);
    const uv = new Float32Array(nv * 2);
    const rest = new Float32Array(nv * 3);
    const under = new Float32Array(nv);
    this.bRel = new Float32Array(nv * 3);
    this.bN0 = new Float32Array(nv * 3);
    this.bT0 = new Float32Array(nv * 3);
    this.bB0 = new Float32Array(nv * 3);
    this.bSkinI = new Int32Array(nv * SKIN_K);
    this.bSkinW = new Float32Array(nv * SKIN_K);
    const c0 = sim.cl.c0;
    const { idx, M } = sim.cl;
    const memberRest = [];
    for (let k = 0; k < M; k++) memberRest.push([sim.rest[idx[k] * 3], sim.rest[idx[k] * 3 + 1], sim.rest[idx[k] * 3 + 2]]);
    const p = [0, 0, 0], n = [0, 0, 0], pa = [0, 0, 0], pb = [0, 0, 0];
    const e = 1e-3;
    let v = 0;
    for (let it = 0; it <= NT; it++) {
      const theta = Math.min(Math.PI - 1e-4, Math.max(1e-4, (it / NT) * Math.PI));
      for (let ip = 0; ip <= NP; ip++, v++) {
        const phi = (ip / NP) * Math.PI * 2;
        bodyPoint(theta, phi, p);
        bodyNormal(theta, phi, n);
        bodyPoint(theta, phi + e, pa);
        bodyPoint(Math.min(theta + e, Math.PI - 1e-5), phi, pb);
        let tx = pa[0] - p[0], ty = pa[1] - p[1], tz = pa[2] - p[2];
        let tl = Math.hypot(tx, ty, tz);
        if (tl < 1e-7) { tx = Math.cos(phi); ty = 0; tz = -Math.sin(phi); tl = 1; }
        let bx = pb[0] - p[0], by = pb[1] - p[1], bz = pb[2] - p[2];
        let bl = Math.hypot(bx, by, bz) || 1;
        this.bRel.set([p[0] - c0[0], p[1] - c0[1], p[2] - c0[2]], v * 3);
        this.bN0.set(n, v * 3);
        this.bT0.set([tx / tl, ty / tl, tz / tl], v * 3);
        this.bB0.set([bx / bl, by / bl, bz / bl], v * 3);
        rest.set([p[0], p[1] - BODY.cy, p[2]], v * 3);
        uv[v * 2] = ip / NP;
        uv[v * 2 + 1] = it / NT;
        // skin weights to the nearest cluster particles
        const ds = [];
        for (let k = 0; k < M; k++) {
          const m = memberRest[k];
          ds.push([(m[0] - p[0]) ** 2 + (m[1] - p[1]) ** 2 + (m[2] - p[2]) ** 2, k]);
        }
        ds.sort((a, b) => a[0] - b[0]);
        let ws = 0;
        for (let s = 0; s < SKIN_K; s++) {
          const wgt = Math.exp(-ds[s][0] / 0.05);
          this.bSkinI[v * SKIN_K + s] = ds[s][1];
          this.bSkinW[v * SKIN_K + s] = wgt;
          ws += wgt;
        }
        for (let s = 0; s < SKIN_K; s++) this.bSkinW[v * SKIN_K + s] /= ws || 1;
      }
    }
    const index = [];
    for (let it = 0; it < NT; it++) {
      for (let ip = 0; ip < NP; ip++) {
        const a = it * (NP + 1) + ip, b = a + NP + 1;
        if (it > 0) index.push(a, b, a + 1);
        if (it < NT - 1) index.push(a + 1, b, b + 1);
      }
    }
    g.setIndex(index);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aTan', new THREE.BufferAttribute(tan, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aBit', new THREE.BufferAttribute(bit, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aRest', new THREE.BufferAttribute(rest, 3));
    g.setAttribute('aUnder', new THREE.BufferAttribute(under, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60);
    this.bodyGeom = g;

    this.bodyMats = createFurMaterials({ flowMap: this.flowBody, body: true, colors: this.colors });
    this.body = new THREE.Mesh(g, this.bodyMats.base);
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    this.body.frustumCulled = false;
    this.body.name = 'body';
    this.group.add(this.body);

    // face feature anchors (head-local rest coordinates)
    const local = (theta, phi) => { const q = bodyPoint(theta, phi); return new THREE.Vector3(q[0], q[1] - BODY.cy, q[2]); };
    const U = this.bodyMats.uniforms;
    U.uCheekL.value.copy(local(0.535 * Math.PI, -0.62));
    U.uCheekR.value.copy(local(0.535 * Math.PI, 0.62));
    U.uMouthC.value.copy(local(0.5 * Math.PI, 0));
    const up = local(0.49 * Math.PI, 0).sub(local(0.51 * Math.PI, 0)).normalize();
    U.uMouthY.value.copy(up);
    U.uMouthX.value.set(1, 0, 0);
  }

  // ------------------------------------------------------------------ arms
  _buildArms() {
    const nv = ARM_COUNT * ARM_VERTS;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(nv * 3);
    const nor = new Float32Array(nv * 3);
    const tan = new Float32Array(nv * 3);
    const bit = new Float32Array(nv * 3);
    const uv = new Float32Array(nv * 2);
    const rest = new Float32Array(nv * 3);
    const under = new Float32Array(nv);
    const index = [];
    const totalLen = SEG_LEN * (ARM_PARTICLES - 1) + armHalfHeight(1);
    for (let k = 0; k < ARM_COUNT; k++) {
      const base = k * ARM_VERTS;
      for (let r = 0; r < ARM_RINGS; r++) {
        let sRest, t;
        if (r < ROD_RINGS) { sRest = (r / SUB) * SEG_LEN; t = r / (ROD_RINGS - 1); } else {
          const c = r - ROD_RINGS + 1;
          sRest = SEG_LEN * (ARM_PARTICLES - 1) + Math.sin((c / CAP) * Math.PI * 0.5) * armHalfHeight(1);
          t = 1;
        }
        const w0 = armHalfWidth(t), h0 = armHalfHeight(t);
        for (let s = 0; s <= RING; s++) {
          const v = base + r * (RING + 1) + s;
          const th = (s / RING) * Math.PI * 2;
          const sn = Math.sin(th);
          uv[v * 2] = Math.min(0.999, sRest / totalLen);
          uv[v * 2 + 1] = (k + (s / RING) * 0.94 + 0.03) / ARM_COUNT;
          rest.set([k * 7.31 + sRest, Math.cos(th) * w0, sn * h0], v * 3);
          // underside = the flat cream face of the arm (sharp-ish fabric boundary at the sides)
          under[v] = smooth(-0.1, -0.3, sn);
        }
      }
      for (let r = 0; r < ARM_RINGS - 1; r++) {
        for (let s = 0; s < RING; s++) {
          const a = base + r * (RING + 1) + s, b = a + RING + 1;
          index.push(a, a + 1, b, a + 1, b + 1, b);
        }
      }
    }
    g.setIndex(index);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aTan', new THREE.BufferAttribute(tan, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aBit', new THREE.BufferAttribute(bit, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aRest', new THREE.BufferAttribute(rest, 3));
    g.setAttribute('aUnder', new THREE.BufferAttribute(under, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60);
    this.armGeom = g;
    this.armMats = createFurMaterials({ flowMap: this.flowArms, body: false, colors: this.colors });
    this.arms = new THREE.Mesh(g, this.armMats.base);
    this.arms.castShadow = true;
    this.arms.receiveShadow = true;
    this.arms.frustumCulled = false;
    this.arms.name = 'arms';
    this.group.add(this.arms);
    this._pq = new Float64Array(ARM_PARTICLES * 4);
    this._rq = new Float64Array(4);
  }

  // ------------------------------------------------------------------ eyes
  _buildEyes() {
    const geo = new THREE.SphereGeometry(1, 48, 32);
    const p = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) * 0.5 + 0.5, p.getY(i) * 0.5 + 0.5);
    const mat = new THREE.MeshPhysicalMaterial({
      map: irisTexture(),
      roughness: 0.2,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      envMapIntensity: 2.4,
      specularIntensity: 1,
    });
    this.eyes = [];
    const c0 = this.sim.cl.c0;
    for (const side of [-1, 1]) {
      const theta = 0.455 * Math.PI, phi = side * 0.64;
      const a = bodyPoint(theta, phi);
      const n = bodyNormal(theta, phi);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.scale.set(0.136, 0.136, 0.08);
      mesh.castShadow = true;
      mesh.name = 'eye';
      const nz = new THREE.Vector3(...n);
      const qRest = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), nz);
      // nearest cluster members for the residual blend
      const { idx, M } = this.sim.cl;
      const ds = [];
      for (let k = 0; k < M; k++) {
        const i3 = idx[k] * 3;
        ds.push([(this.sim.rest[i3] - a[0]) ** 2 + (this.sim.rest[i3 + 1] - a[1]) ** 2 + (this.sim.rest[i3 + 2] - a[2]) ** 2, k]);
      }
      ds.sort((x, y) => x[0] - y[0]);
      const skin = ds.slice(0, SKIN_K).map(([d, k]) => [k, Math.exp(-d / 0.05)]);
      const ws = skin.reduce((s, x) => s + x[1], 0);
      skin.forEach((x) => { x[1] /= ws; });
      this.eyes.push({ mesh, rel: [a[0] - c0[0], a[1] - c0[1], a[2] - c0[2]], n, qRest, skin });
      this.group.add(mesh);
    }
  }

  // ------------------------------------------------------------------ debug "Mesh" overlay
  _buildDebug() {
    const sim = this.sim;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(sim.N * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const pts = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x1d1a18, size: 4, sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.85 }));
    pts.renderOrder = 10;
    const segs = [];
    for (const a of sim.arms) for (let j = 0; j < ARM_PARTICLES - 1; j++) segs.push(a.base + j, a.base + j + 1);
    for (let i = 0; i < sim.H; i++) segs.push(i, sim.H - 1);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', g.attributes.position);
    lg.setIndex(segs);
    const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x1d1a18, transparent: true, opacity: 0.5, depthTest: false }));
    lines.renderOrder = 10;
    const wireMat = new THREE.MeshBasicMaterial({ color: 0x2a2521, wireframe: true, transparent: true, opacity: 0.18, depthWrite: false });
    const bodyWire = new THREE.Mesh(this.bodyGeom, wireMat);
    const armWire = new THREE.Mesh(this.armGeom, wireMat);
    for (const m of [bodyWire, armWire]) { m.frustumCulled = false; m.renderOrder = 9; }
    this.debug = new THREE.Group();
    this.debug.add(bodyWire, armWire, lines, pts);
    this.debug.visible = false;
    this.debugPts = g;
    this.group.add(this.debug);
  }

  setDebug(on) {
    this.debug.visible = on;
    for (const m of [this.bodyShells, this.armShells]) if (m) m.visible = !on;
  }

  // ------------------------------------------------------------------ fur controls
  setShells(n) {
    const MAX = 32;
    n = Math.min(MAX, n);
    if (!this.bodyShells) {
      this.bodyShells = new THREE.Mesh(makeShellGeometry(this.bodyGeom, MAX), this.bodyMats.shell);
      this.armShells = new THREE.Mesh(makeShellGeometry(this.armGeom, MAX), this.armMats.shell);
      for (const m of [this.bodyShells, this.armShells]) {
        m.frustumCulled = false;
        m.receiveShadow = true;
        m.castShadow = false;
        m.name = 'fur';
        this.group.add(m);
      }
    }
    this.shellCount = n;
    for (const m of [this.bodyShells, this.armShells]) {
      m.geometry.instanceCount = n;
      m.visible = !(this.debug && this.debug.visible);
    }
    this.bodyMats.uniforms.uShellCount.value = n;
    this.armMats.uniforms.uShellCount.value = n;
  }

  setPile(mm) {
    // a long pile lies down more than it stands up; mm -> sim units (1 unit = 100 mm)
    const len = (mm / 100) * 1.05;
    this.bodyMats.uniforms.uFurLen.value = len;
    this.armMats.uniforms.uFurLen.value = len * 0.9;
  }

  setFur(name) {
    this.colors = FUR_COLORS[name];
    setFurColors(this.bodyMats, this.colors);
    setFurColors(this.armMats, this.colors);
  }

  smoothFur() { resetFlow(this.flowBody); resetFlow(this.flowArms); }

  // Paint the nap map. `hit` is a raycast intersection on the body or arm base mesh,
  // `dir` the stroke direction in world space.
  comb(hit, dir, strength = 1) {
    const isBody = hit.object === this.body;
    const tex = isBody ? this.flowBody : this.flowArms;
    const geom = isBody ? this.bodyGeom : this.armGeom;
    const { w, h, lean, nap, grain } = tex.userData;
    const f = hit.face;
    const bc = hit.barycoord;
    const T = geom.attributes.aTan, B = geom.attributes.aBit;
    const tv = [0, 0, 0], bv = [0, 0, 0];
    for (const [vi, wt] of [[f.a, bc.x], [f.b, bc.y], [f.c, bc.z]]) {
      tv[0] += T.getX(vi) * wt; tv[1] += T.getY(vi) * wt; tv[2] += T.getZ(vi) * wt;
      bv[0] += B.getX(vi) * wt; bv[1] += B.getY(vi) * wt; bv[2] += B.getZ(vi) * wt;
    }
    const tl = Math.hypot(...tv) || 1, bl = Math.hypot(...bv) || 1;
    let lx = (dir.x * tv[0] + dir.y * tv[1] + dir.z * tv[2]) / tl;
    let ly = (dir.x * bv[0] + dir.y * bv[1] + dir.z * bv[2]) / bl;
    const ll = Math.hypot(lx, ly);
    if (ll < 1e-4) return;
    lx /= ll; ly /= ll;
    const against = -(lx * grain[0] + ly * grain[1]); // +1 fully against the grain
    const uv = hit.uv;
    const cx = uv.x * w, cy = uv.y * h;
    const rad = isBody ? 6.4 : 4.2;
    const ry = isBody ? rad : rad * 0.9;
    const x0 = Math.floor(cx - rad - 1), x1 = Math.ceil(cx + rad + 1);
    const y0 = Math.max(0, Math.floor(cy - ry - 1)), y1 = Math.min(h - 1, Math.ceil(cy + ry + 1));
    const armRow = isBody ? -1 : Math.floor(uv.y * ARM_COUNT);
    for (let yy = y0; yy <= y1; yy++) {
      if (armRow >= 0 && Math.floor(((yy + 0.5) / h) * ARM_COUNT) !== armRow) continue;
      for (let xx = x0; xx <= x1; xx++) {
        let xw = xx;
        if (isBody) xw = ((xx % w) + w) % w; else if (xx < 0 || xx >= w) continue;
        const d = Math.hypot((xx + 0.5 - cx) / rad, (yy + 0.5 - cy) / ry);
        if (d >= 1) continue;
        const a = (1 - d * d) * 0.55 * strength;
        const i = yy * w + xw;
        const nx = lean[i * 2] + (lx * 0.95 - lean[i * 2]) * a;
        const ny = lean[i * 2 + 1] + (ly * 0.95 - lean[i * 2 + 1]) * a;
        lean[i * 2] = nx; lean[i * 2 + 1] = ny;
        nap[i] += (-against - nap[i]) * a;
      }
    }
    encodeFlow(tex);
  }

  // ------------------------------------------------------------------ per-frame update
  update() {
    this._updateBody();
    this._updateArms();
    this._updateEyes();
    const sim = this.sim;
    // head centre for the arm occlusion term
    const hc = this._headCentre();
    for (const U of [this.bodyMats.uniforms, this.armMats.uniforms]) {
      U.uHeadC.value.set(hc[0], hc[1], hc[2]);
      U.uHeadR.value = 0.5;
    }
    if (this.debug.visible) {
      this.debugPts.attributes.position.array.set(sim.x);
      this.debugPts.attributes.position.needsUpdate = true;
    }
  }

  _headCentre() {
    const sim = this.sim, T = sim.headT, c = sim.headC, c0 = sim.cl.c0;
    const rx = -c0[0], ry = BODY.cy - c0[1], rz = -c0[2];
    return [
      T[0] * rx + T[1] * ry + T[2] * rz + c[0],
      T[3] * rx + T[4] * ry + T[5] * rz + c[1],
      T[6] * rx + T[7] * ry + T[8] * rz + c[2],
    ];
  }

  _updateBody() {
    const sim = this.sim;
    const T = sim.headT, c = sim.headC;
    const cof = this._cof || (this._cof = new Float64Array(9));
    m3Cofactor(T, cof);
    const { idx, M, goal } = sim.cl;
    const res = this._res || (this._res = new Float64Array(M * 3));
    for (let k = 0; k < M; k++) {
      const i3 = idx[k] * 3;
      res[k * 3] = sim.x[i3] - goal[k * 3];
      res[k * 3 + 1] = sim.x[i3 + 1] - goal[k * 3 + 1];
      res[k * 3 + 2] = sim.x[i3 + 2] - goal[k * 3 + 2];
    }
    const g = this.bodyGeom;
    const P = g.attributes.position.array, N = g.attributes.normal.array;
    const TA = g.attributes.aTan.array, BA = g.attributes.aBit.array;
    const rel = this.bRel, n0 = this.bN0, t0 = this.bT0, b0 = this.bB0;
    const si = this.bSkinI, sw = this.bSkinW;
    const nv = P.length / 3;
    for (let v = 0; v < nv; v++) {
      const v3 = v * 3;
      const rx = rel[v3], ry = rel[v3 + 1], rz = rel[v3 + 2];
      let px = T[0] * rx + T[1] * ry + T[2] * rz + c[0];
      let py = T[3] * rx + T[4] * ry + T[5] * rz + c[1];
      let pz = T[6] * rx + T[7] * ry + T[8] * rz + c[2];
      for (let s = 0; s < SKIN_K; s++) {
        const k = si[v * SKIN_K + s], wgt = sw[v * SKIN_K + s];
        px += res[k * 3] * wgt; py += res[k * 3 + 1] * wgt; pz += res[k * 3 + 2] * wgt;
      }
      P[v3] = px; P[v3 + 1] = py; P[v3 + 2] = pz;
      const nx = n0[v3], ny = n0[v3 + 1], nz = n0[v3 + 2];
      let mx = cof[0] * nx + cof[1] * ny + cof[2] * nz;
      let my = cof[3] * nx + cof[4] * ny + cof[5] * nz;
      let mz = cof[6] * nx + cof[7] * ny + cof[8] * nz;
      const ml = Math.hypot(mx, my, mz) || 1;
      N[v3] = mx / ml; N[v3 + 1] = my / ml; N[v3 + 2] = mz / ml;
      const tx = t0[v3], ty = t0[v3 + 1], tz = t0[v3 + 2];
      TA[v3] = T[0] * tx + T[1] * ty + T[2] * tz; TA[v3 + 1] = T[3] * tx + T[4] * ty + T[5] * tz; TA[v3 + 2] = T[6] * tx + T[7] * ty + T[8] * tz;
      const bx = b0[v3], by = b0[v3 + 1], bz = b0[v3 + 2];
      BA[v3] = T[0] * bx + T[1] * by + T[2] * bz; BA[v3 + 1] = T[3] * bx + T[4] * by + T[5] * bz; BA[v3 + 2] = T[6] * bx + T[7] * by + T[8] * bz;
    }
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
    g.attributes.aTan.needsUpdate = true;
    g.attributes.aBit.needsUpdate = true;
  }

  _updateArms() {
    const sim = this.sim;
    const x = sim.x;
    const g = this.armGeom;
    const P = g.attributes.position.array, N = g.attributes.normal.array;
    const TA = g.attributes.aTan.array, BA = g.attributes.aBit.array;
    const pq = this._pq, rq = this._rq;
    const d2 = [0, 0, 0];
    const S = ARM_PARTICLES - 1;
    for (const a of sim.arms) {
      const b = a.base;
      const q = a.q;
      // per-particle frames
      pq.set(q.subarray(0, 4), 0);
      for (let j = 1; j < S; j++) slerpInto(q, (j - 1) * 4, q, j * 4, 0.5, pq, j * 4);
      pq.set(q.subarray((S - 1) * 4, S * 4), S * 4);
      const vbase = a.k * ARM_VERTS;
      let endT = [0, 0, 1], endC = [0, 0, 0], endD1 = [1, 0, 0], endD2 = [0, 1, 0];
      for (let r = 0; r < ARM_RINGS; r++) {
        let cx, cy, cz, tx, ty, tz, w, hgt, capA = 0;
        if (r < ROD_RINGS) {
          const u = r / SUB;
          let j = Math.floor(u);
          let f = u - j;
          if (j >= S) { j = S - 1; f = 1; }
          const i0 = b + Math.max(0, j - 1), i1 = b + j, i2 = b + j + 1, i3 = b + Math.min(S, j + 2);
          const p0 = [x[i0 * 3], x[i0 * 3 + 1], x[i0 * 3 + 2]];
          const p1 = [x[i1 * 3], x[i1 * 3 + 1], x[i1 * 3 + 2]];
          const p2 = [x[i2 * 3], x[i2 * 3 + 1], x[i2 * 3 + 2]];
          const p3 = [x[i3 * 3], x[i3 * 3 + 1], x[i3 * 3 + 2]];
          if (j === 0) for (let c = 0; c < 3; c++) p0[c] = 2 * p1[c] - p2[c];
          if (j + 2 > S) for (let c = 0; c < 3; c++) p3[c] = 2 * p2[c] - p1[c];
          const f2 = f * f, f3 = f2 * f;
          const C = [0, 0, 0], D = [0, 0, 0];
          for (let c = 0; c < 3; c++) {
            const A0 = 2 * p1[c], A1 = -p0[c] + p2[c], A2 = 2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c], A3 = -p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c];
            C[c] = 0.5 * (A0 + A1 * f + A2 * f2 + A3 * f3);
            D[c] = 0.5 * (A1 + 2 * A2 * f + 3 * A3 * f2);
          }
          cx = C[0]; cy = C[1]; cz = C[2];
          const dl = Math.hypot(D[0], D[1], D[2]) || 1;
          tx = D[0] / dl; ty = D[1] / dl; tz = D[2] / dl;
          slerpInto(pq, j * 4, pq, (j + 1) * 4, f, rq, 0);
          qD2(rq, 0, d2);
          const t = (j + f) / S;
          // thinner where stretched (the stuffing has to go somewhere)
          const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
          const thin = Math.min(1.12, Math.max(0.62, Math.sqrt(SEG_LEN / Math.max(1e-4, segLen))));
          w = armHalfWidth(t) * thin;
          hgt = armHalfHeight(t) * thin;
          if (r === ROD_RINGS - 1) { endT = [tx, ty, tz]; endC = [cx, cy, cz]; }
        } else {
          const c = r - ROD_RINGS + 1;
          capA = (c / CAP) * Math.PI * 0.5;
          const capLen = armHalfHeight(1) * 1.05;
          cx = endC[0] + endT[0] * Math.sin(capA) * capLen;
          cy = endC[1] + endT[1] * Math.sin(capA) * capLen;
          cz = endC[2] + endT[2] * Math.sin(capA) * capLen;
          [tx, ty, tz] = endT;
          d2[0] = endD2[0]; d2[1] = endD2[1]; d2[2] = endD2[2];
          const sc = Math.max(0.04, Math.cos(capA));
          w = armHalfWidth(1) * sc;
          hgt = armHalfHeight(1) * sc;
        }
        // orthonormal frame around the spline tangent
        const dt = d2[0] * tx + d2[1] * ty + d2[2] * tz;
        let ux = d2[0] - tx * dt, uy = d2[1] - ty * dt, uz = d2[2] - tz * dt;
        const ul = Math.hypot(ux, uy, uz) || 1;
        ux /= ul; uy /= ul; uz /= ul;
        const lx = uy * tz - uz * ty, ly = uz * tx - ux * tz, lz = ux * ty - uy * tx; // d1 = d2 x d3
        if (r === ROD_RINGS - 1) { endD1 = [lx, ly, lz]; endD2 = [ux, uy, uz]; }
        for (let s = 0; s <= RING; s++) {
          const v = vbase + r * (RING + 1) + s, v3 = v * 3;
          const th = (s / RING) * Math.PI * 2;
          const cs = Math.cos(th), sn = Math.sin(th);
          const hh = sn < 0 ? hgt * 0.8 : hgt;
          P[v3] = cx + lx * w * cs + ux * hh * sn;
          P[v3 + 1] = cy + ly * w * cs + uy * hh * sn;
          P[v3 + 2] = cz + lz * w * cs + uz * hh * sn;
          let nx = lx * cs / w + ux * sn / hh, ny = ly * cs / w + uy * sn / hh, nz = lz * cs / w + uz * sn / hh;
          let nl = Math.hypot(nx, ny, nz) || 1;
          nx /= nl; ny /= nl; nz /= nl;
          if (capA > 0) {
            const ca = Math.cos(capA), sa = Math.sin(capA);
            nx = nx * ca + tx * sa; ny = ny * ca + ty * sa; nz = nz * ca + tz * sa;
            nl = Math.hypot(nx, ny, nz) || 1;
            nx /= nl; ny /= nl; nz /= nl;
          }
          N[v3] = nx; N[v3 + 1] = ny; N[v3 + 2] = nz;
          TA[v3] = tx; TA[v3 + 1] = ty; TA[v3 + 2] = tz;
          BA[v3] = -lx * sn + ux * cs; BA[v3 + 1] = -ly * sn + uy * cs; BA[v3 + 2] = -lz * sn + uz * cs;
        }
      }
    }
    g.attributes.position.needsUpdate = true;
    g.attributes.normal.needsUpdate = true;
    g.attributes.aTan.needsUpdate = true;
    g.attributes.aBit.needsUpdate = true;
  }

  _updateEyes() {
    const sim = this.sim;
    const T = sim.headT, c = sim.headC;
    const { idx, goal } = sim.cl;
    const hq = new THREE.Quaternion(sim.headQ[0], sim.headQ[1], sim.headQ[2], sim.headQ[3]);
    for (const e of this.eyes) {
      const [rx, ry, rz] = e.rel;
      let px = T[0] * rx + T[1] * ry + T[2] * rz + c[0];
      let py = T[3] * rx + T[4] * ry + T[5] * rz + c[1];
      let pz = T[6] * rx + T[7] * ry + T[8] * rz + c[2];
      for (const [k, wgt] of e.skin) {
        const i3 = idx[k] * 3;
        px += (sim.x[i3] - goal[k * 3]) * wgt;
        py += (sim.x[i3 + 1] - goal[k * 3 + 1]) * wgt;
        pz += (sim.x[i3 + 2] - goal[k * 3 + 2]) * wgt;
      }
      e.mesh.quaternion.copy(hq).multiply(e.qRest);
      const n = new THREE.Vector3(0, 0, 1).applyQuaternion(e.mesh.quaternion);
      e.mesh.position.set(px, py, pz).addScaledVector(n, 0.004);
    }
  }
}

function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
