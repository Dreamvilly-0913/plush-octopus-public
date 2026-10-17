// Position-based soft body for the plush:
//  - the head is a shape-matched particle cluster (Müller et al. 2005) whose stiffness is the "stuffing"
//  - each arm is a Cosserat rod (Kugelstadt & Schömer 2016): particles + segment quaternions with
//    stretch–shear and bend–twist constraints, so the curled tips keep their curl while hanging
//  - interaction constraints (hand grab, finger contact / grip) and collisions run inside every substep
import {
  qMul, qNormalize, qD3, qToMat3, qNlerpToward, extractRotation,
  m3Det, m3Inverse,
} from './qmath.js';
import {
  ARM_COUNT, ARM_PARTICLES, SEG_LEN, BODY,
  buildArmRest, buildHeadParticles, armHalfWidth, armHalfHeight, surfaceDistance,
} from './rest.js';

const GRAVITY = -98.1; // 9.81 m/s^2 in units of 10 cm
const HEAD_MASS = 300; // grams
const ARM_MASS = 22.5; // grams per arm  -> 480 g total
const MAX_SPEED = 45;

export class OctopusSim {
  constructor() {
    this.params = { stuffing: 0.42, damping: 0.48 };
    this.substeps = 10;
    this.timeScale = 1;
    this.paused = false;
    this.time = 0;

    const head = buildHeadParticles();
    this.H = head.length;
    this.N = this.H + ARM_COUNT * ARM_PARTICLES;
    const N = this.N;
    this.x = new Float64Array(N * 3);
    this.p = new Float64Array(N * 3);
    this.v = new Float64Array(N * 3);
    this.rest = new Float64Array(N * 3);
    this.m = new Float64Array(N);
    this.w = new Float64Array(N);
    this.r = new Float64Array(N);
    this.isArm = new Uint8Array(N);

    // --- head particles
    for (let i = 0; i < this.H; i++) {
      const [px, py, pz] = head[i];
      this.rest.set([px, py, pz], i * 3);
      this.m[i] = HEAD_MASS / this.H;
      const dx = px, dy = py - BODY.cy, dz = pz;
      const d = Math.hypot(dx, dy, dz);
      this.r[i] = d < 1e-6 ? 0.3 : Math.max(0.05, surfaceDistance(dx, dy, dz) - d);
    }

    // --- arms
    this.arms = [];
    for (let k = 0; k < ARM_COUNT; k++) {
      const rest = buildArmRest(k);
      const base = this.H + k * ARM_PARTICLES;
      let area = 0;
      const areas = [];
      for (let j = 0; j < ARM_PARTICLES; j++) {
        const t = j / (ARM_PARTICLES - 1);
        const a = armHalfWidth(t) * armHalfHeight(t);
        areas.push(a); area += a;
      }
      for (let j = 0; j < ARM_PARTICLES; j++) {
        const i = base + j;
        const t = j / (ARM_PARTICLES - 1);
        this.rest.set(rest.pos.subarray(j * 3, j * 3 + 3), i * 3);
        this.m[i] = (ARM_MASS * areas[j]) / area;
        this.r[i] = armHalfHeight(t) * 0.92;
        this.isArm[i] = 1;
      }
      const S = ARM_PARTICLES - 1;
      const q = new Float64Array(rest.quats);
      const qRest = new Float64Array(rest.quats);
      const darboux = new Float64Array((S - 1) * 4);
      for (let s = 0; s < S - 1; s++) {
        const c = [-qRest[s * 4], -qRest[s * 4 + 1], -qRest[s * 4 + 2], qRest[s * 4 + 3]];
        qMul(c, 0, qRest, (s + 1) * 4, darboux, s * 4);
        // choose the representative closest to identity
        const dw = darboux[s * 4 + 3];
        if (dw < 0) for (let c2 = 0; c2 < 4; c2++) darboux[s * 4 + c2] *= -1;
      }
      const wq = new Float64Array(S);
      this.arms.push({ k, base, q, qRest, darboux, wq, phi: rest.phi });
    }

    // --- shape-matching cluster: head particles + the root particle of each arm
    const idx = [];
    for (let i = 0; i < this.H; i++) idx.push(i);
    for (const a of this.arms) idx.push(a.base);
    this.cl = { idx: Int32Array.from(idx), M: idx.length };
    this.cl.q = new Float64Array(idx.length * 3);
    this.cl.mass = new Float64Array(idx.length);
    this.cl.goal = new Float64Array(idx.length * 3);
    // the head is heavier per particle; arm roots behave as part of it
    this.headQ = new Float64Array([0, 0, 0, 1]);
    this.headR = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    this.headT = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    this.headC = new Float64Array(3);
    this.volume = 1;

    // the head sits on the stuffed bases of the arms: bottom-facing stuffing particles get extra
    // floor clearance while the plush is upright
    // Every bottom-facing particle touches the floor at rest, so the plush stands on a broad
    // footprint instead of balancing on one point.
    this.support = new Float64Array(this.H);
    this.supportDown = new Float64Array(this.H);
    this.restDir = new Float64Array(this.H * 3);
    for (let i = 0; i < this.H; i++) {
      const dx = this.rest[i * 3], dy = this.rest[i * 3 + 1] - BODY.cy, dz = this.rest[i * 3 + 2];
      const l = Math.hypot(dx, dy, dz) || 1;
      this.restDir.set([dx / l, dy / l, dz / l], i * 3);
      const down = -dy / l;
      if (down > 0.35) {
        this.support[i] = Math.max(0, this.rest[i * 3 + 1] - this.r[i]);
        this.supportDown[i] = down;
      }
    }

    for (let i = 0; i < N; i++) this.w[i] = 1 / this.m[i];
    for (const a of this.arms) {
      for (let s = 0; s < ARM_PARTICLES - 1; s++) {
        const w0 = this.w[a.base + s], w1 = this.w[a.base + s + 1];
        a.wq[s] = (w0 + w1) / (4 * SEG_LEN * SEG_LEN);
      }
    }

    this._initCluster();

    // effects & interaction state
    this.grab = null; // { idx: [..], wts: [..], target: [x,y,z], k }
    this.finger = {
      active: false,
      down: false,
      tip: new Float64Array([0, 4, 0]),
      R: 0.13,
      holds: new Array(ARM_COUNT).fill(null),
    };
    this.shake = null;
    this.squish = null;
    this.pendingImpulse = null;
    this.pendingTwist = 0;
    this.kinetic = 0;

    this.reset();
  }

  _initCluster() {
    const { idx, M, q, mass } = this.cl;
    let cx = 0, cy = 0, cz = 0, mt = 0;
    for (let k = 0; k < M; k++) {
      const i = idx[k];
      const mk = this.m[i] * (i < this.H ? 1 : 1.5);
      mass[k] = mk;
      cx += mk * this.rest[i * 3]; cy += mk * this.rest[i * 3 + 1]; cz += mk * this.rest[i * 3 + 2];
      mt += mk;
    }
    cx /= mt; cy /= mt; cz /= mt;
    this.cl.c0 = [cx, cy, cz];
    this.cl.mt = mt;
    const Aqq = new Float64Array(9);
    for (let k = 0; k < M; k++) {
      const i = idx[k];
      const qx = this.rest[i * 3] - cx, qy = this.rest[i * 3 + 1] - cy, qz = this.rest[i * 3 + 2] - cz;
      q[k * 3] = qx; q[k * 3 + 1] = qy; q[k * 3 + 2] = qz;
      const mk = mass[k];
      Aqq[0] += mk * qx * qx; Aqq[1] += mk * qx * qy; Aqq[2] += mk * qx * qz;
      Aqq[3] += mk * qy * qx; Aqq[4] += mk * qy * qy; Aqq[5] += mk * qy * qz;
      Aqq[6] += mk * qz * qx; Aqq[7] += mk * qz * qy; Aqq[8] += mk * qz * qz;
    }
    this.cl.Aqq = m3Inverse(Aqq, new Float64Array(9));
    this.headInertia = 0.4 * mt * BODY.rx * BODY.rx;
  }

  reset() {
    this.x.set(this.rest);
    this.p.set(this.rest);
    this.v.fill(0);
    for (const a of this.arms) a.q.set(a.qRest);
    this.headQ.set([0, 0, 0, 1]);
    this.headR.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    this.headT.set([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    this.headC.set(this.cl.c0);
    this.grab = null;
    this.finger.holds.fill(null);
    this.shake = null;
    this.squish = null;
    this.pendingImpulse = null;
    this.pendingTwist = 0;
    this.volume = 1;
    this.kinetic = 0;
    this._updateGoals();
  }

  // ------------------------------------------------------------------ stepping
  // Fixed 600 Hz substeps with an accumulator: position-based velocities are only consistent when
  // every substep has the same length, otherwise frame-time jitter pumps energy into the plush.
  step(frameDt) {
    if (this.paused) return;
    const h = 1 / 600;
    this._acc = (this._acc || 0) + Math.min(frameDt, 1 / 20) * this.timeScale;
    let n = 0;
    while (this._acc >= h && n < 36) {
      this._substep(h, (this._sub = (this._sub || 0) + 1));
      this._acc -= h;
      n++;
    }
    if (n === 36) this._acc = 0;
    if (n > 0) {
      this.time += n * h;
      this._updateGoals();
      this._stats();
    }
  }

  _substep(h, s) {
    const { x, p, v, w, N } = this;
    this._applyEffects(h);
    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      p[i3] = x[i3]; p[i3 + 1] = x[i3 + 1]; p[i3 + 2] = x[i3 + 2];
      if (w[i] === 0) continue;
      v[i3 + 1] += GRAVITY * h;
      x[i3] += v[i3] * h; x[i3 + 1] += v[i3 + 1] * h; x[i3 + 2] += v[i3 + 2] * h;
    }

    this._solveCluster();
    for (const a of this.arms) this._solveArm(a);
    this._solveInteraction(h);
    this._solveCollisions(s);

    // velocities + damping
    const d = this.params.damping;
    const air = Math.exp(-(0.18 + 1.6 * d) * h);
    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      let vx = (x[i3] - p[i3]) / h, vy = (x[i3 + 1] - p[i3 + 1]) / h, vz = (x[i3 + 2] - p[i3 + 2]) / h;
      const sp = Math.hypot(vx, vy, vz);
      if (sp > MAX_SPEED) { const f = MAX_SPEED / sp; vx *= f; vy *= f; vz *= f; }
      v[i3] = vx * air; v[i3 + 1] = vy * air; v[i3 + 2] = vz * air;
    }
    this._internalDamping(d);
  }

  _internalDamping(d) {
    const { v } = this;
    const k = 0.012 + 0.16 * d;
    // arms: Laplacian smoothing of velocities damps bending oscillation, not rigid motion
    for (const a of this.arms) {
      const b = a.base;
      for (let j = 1; j < ARM_PARTICLES - 1; j++) {
        const i3 = (b + j) * 3, l3 = (b + j - 1) * 3, r3 = (b + j + 1) * 3;
        for (let c = 0; c < 3; c++) v[i3 + c] += k * (0.5 * (v[l3 + c] + v[r3 + c]) - v[i3 + c]);
      }
    }
    // head: pull each member's velocity toward the cluster's mean motion
    const { idx, M, mass, mt } = this.cl;
    let vx = 0, vy = 0, vz = 0;
    for (let c = 0; c < M; c++) { const i3 = idx[c] * 3; vx += mass[c] * v[i3]; vy += mass[c] * v[i3 + 1]; vz += mass[c] * v[i3 + 2]; }
    vx /= mt; vy /= mt; vz /= mt;
    const kh = 0.004 + 0.05 * d;
    for (let c = 0; c < this.H; c++) {
      const i3 = idx[c] * 3;
      v[i3] += kh * (vx - v[i3]); v[i3 + 1] += kh * (vy - v[i3 + 1]); v[i3 + 2] += kh * (vz - v[i3 + 2]);
    }
  }

  // ------------------------------------------------------------------ head (shape matching)
  _clusterFit() {
    const { x } = this;
    const { idx, M, q, mass, mt, Aqq } = this.cl;
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < M; k++) {
      const i3 = idx[k] * 3; const mk = mass[k];
      cx += mk * x[i3]; cy += mk * x[i3 + 1]; cz += mk * x[i3 + 2];
    }
    cx /= mt; cy /= mt; cz /= mt;
    const A = this._Apq || (this._Apq = new Float64Array(9));
    A.fill(0);
    for (let k = 0; k < M; k++) {
      const i3 = idx[k] * 3; const mk = mass[k];
      const px = x[i3] - cx, py = x[i3 + 1] - cy, pz = x[i3 + 2] - cz;
      const qx = q[k * 3], qy = q[k * 3 + 1], qz = q[k * 3 + 2];
      A[0] += mk * px * qx; A[1] += mk * px * qy; A[2] += mk * px * qz;
      A[3] += mk * py * qx; A[4] += mk * py * qy; A[5] += mk * py * qz;
      A[6] += mk * pz * qx; A[7] += mk * pz * qy; A[8] += mk * pz * qz;
    }
    extractRotation(A, this.headQ, 3);
    qToMat3(this.headQ, 0, this.headR);
    // linear part A * Aqq, volume-normalised
    const L = this._L || (this._L = new Float64Array(9));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      L[i * 3 + j] = A[i * 3] * Aqq[j] + A[i * 3 + 1] * Aqq[3 + j] + A[i * 3 + 2] * Aqq[6 + j];
    }
    const det = m3Det(L);
    this.volume = det;
    const sc = det > 0.05 ? 1 / Math.cbrt(det) : 1;
    // a little affine "give" for squash and stretch; too much lets the head shear over under gravity
    const beta = 0.12 * (1 - this.params.stuffing) + 0.03;
    const R = this.headR, T = this.headT;
    for (let i = 0; i < 9; i++) T[i] = beta * L[i] * sc + (1 - beta) * R[i];
    this.headC[0] = cx; this.headC[1] = cy; this.headC[2] = cz;
  }

  _solveCluster() {
    this._clusterFit();
    const { x, w } = this;
    const { idx, M, q } = this.cl;
    const T = this.headT, c = this.headC;
    const st = this.params.stuffing;
    const alpha = 0.035 + 0.45 * Math.pow(st, 1.35);
    // squish: temporarily flatten the rest shape
    let sx = 1, sy = 1, sz = 1;
    if (this.squish) {
      const t = this.squish.t / this.squish.dur;
      const e = t < 0.35 ? Math.sin((t / 0.35) * Math.PI * 0.5) : Math.max(0, 1 - (t - 0.35) / 0.25);
      sy = 1 - 0.42 * e; sx = sz = 1 + 0.24 * e;
    }
    for (let k = 0; k < M; k++) {
      const i = idx[k];
      if (w[i] === 0) continue;
      const qx = q[k * 3] * sx, qy = q[k * 3 + 1] * sy, qz = q[k * 3 + 2] * sz;
      const gx = T[0] * qx + T[1] * qy + T[2] * qz + c[0];
      const gy = T[3] * qx + T[4] * qy + T[5] * qz + c[1];
      const gz = T[6] * qx + T[7] * qy + T[8] * qz + c[2];
      const a = i < this.H ? alpha : alpha * 1.4;
      const i3 = i * 3;
      x[i3] += a * (gx - x[i3]); x[i3 + 1] += a * (gy - x[i3 + 1]); x[i3 + 2] += a * (gz - x[i3 + 2]);
    }
  }

  // goal positions (for rendering residual deformation)
  _updateGoals() {
    this._clusterFit();
    const { idx, M, q, goal } = this.cl;
    const T = this.headT, c = this.headC;
    for (let k = 0; k < M; k++) {
      const qx = q[k * 3], qy = q[k * 3 + 1], qz = q[k * 3 + 2];
      goal[k * 3] = T[0] * qx + T[1] * qy + T[2] * qz + c[0];
      goal[k * 3 + 1] = T[3] * qx + T[4] * qy + T[5] * qz + c[1];
      goal[k * 3 + 2] = T[6] * qx + T[7] * qy + T[8] * qz + c[2];
    }
  }

  // ------------------------------------------------------------------ arms (Cosserat rods)
  _solveArm(a) {
    const { x, w } = this;
    const b = a.base;
    const q = a.q;
    const S = ARM_PARTICLES - 1;
    const l = SEG_LEN;
    const tq = this._tq || (this._tq = new Float64Array(4));
    const tmp = this._tmp || (this._tmp = new Float64Array(8));
    const d3 = this._d3 || (this._d3 = new Float64Array(3));

    // root follows the head orientation
    qMul(this.headQ, 0, a.qRest, 0, tq, 0);
    qNlerpToward(q, 0, tq, 0, 0.5);
    qNlerpToward(q, 4, (qMul(this.headQ, 0, a.qRest, 4, tq, 0), tq), 0, 0.15);

    // where an arm is sewn to the body it is stuffed and firm: pull the first few particles toward
    // their rest pose in the head frame, fading out along the arm. Two-way: the head feels it too.
    const T = this.headT, hc = this.headC, c0 = this.cl.c0, rest = this.rest;
    for (let j = 1; j <= 5; j++) {
      const i = b + j, i3 = i * 3;
      const k = 0.05 * (1 - (j - 1) / 5);
      const rx = rest[i3] - c0[0], ry = rest[i3 + 1] - c0[1], rz = rest[i3 + 2] - c0[2];
      const ex = T[0] * rx + T[1] * ry + T[2] * rz + hc[0] - x[i3];
      const ey = T[3] * rx + T[4] * ry + T[5] * rz + hc[1] - x[i3 + 1];
      const ez = T[6] * rx + T[7] * ry + T[8] * rz + hc[2] - x[i3 + 2];
      const el = Math.hypot(ex, ey, ez);
      if (el < 1e-9) continue;
      const nx = ex / el, ny = ey / el, nz = ez / el;
      const wh = this._headInvMass(x[i3], x[i3 + 1], x[i3 + 2], nx, ny, nz);
      const share = w[i] / (w[i] + wh);
      const corr = k * el;
      // the arm particle moves toward its seat on the head, the head toward the arm
      x[i3] += nx * corr * share; x[i3 + 1] += ny * corr * share; x[i3 + 2] += nz * corr * share;
      const J = (corr * (1 - share)) / wh;
      this._headImpulse(-nx * J, -ny * J, -nz * J, x[i3], x[i3 + 1], x[i3 + 2]);
    }

    // stretch–shear
    const ks = 0.82;
    for (let s = 0; s < S; s++) {
      const i0 = (b + s) * 3, i1 = (b + s + 1) * 3;
      const w0 = s === 0 ? w[b] * 0.25 : w[b + s], w1 = w[b + s + 1];
      const wq = a.wq[s];
      qD3(q, s * 4, d3);
      let gx = (x[i1] - x[i0]) / l - d3[0];
      let gy = (x[i1 + 1] - x[i0 + 1]) / l - d3[1];
      let gz = (x[i1 + 2] - x[i0 + 2]) / l - d3[2];
      const den = (w0 + w1) / l + 4 * wq * l + 1e-9;
      gx *= ks / den; gy *= ks / den; gz *= ks / den;
      x[i0] += w0 * gx; x[i0 + 1] += w0 * gy; x[i0 + 2] += w0 * gz;
      x[i1] -= w1 * gx; x[i1 + 1] -= w1 * gy; x[i1 + 2] -= w1 * gz;
      // corrq = (gamma, 0) * conj-ish(q e3), scaled by 2 wq l
      const qi = s * 4;
      tmp[0] = gx; tmp[1] = gy; tmp[2] = gz; tmp[3] = 0;
      tmp[4] = -q[qi + 1]; tmp[5] = q[qi]; tmp[6] = -q[qi + 3]; tmp[7] = q[qi + 2];
      qMul(tmp, 0, tmp, 4, tq, 0);
      const f = 2 * wq * l;
      q[qi] += tq[0] * f; q[qi + 1] += tq[1] * f; q[qi + 2] += tq[2] * f; q[qi + 3] += tq[3] * f;
      qNormalize(q, qi);
    }

    // bend–twist toward the rest Darboux vectors (curl)
    for (let s = 0; s < S - 1; s++) {
      const q0i = s * 4, q1i = (s + 1) * 4, di = s * 4;
      const t = s / (S - 2);
      // stuffed arms: stiff where they leave the body, softer mid-way, firm again in the curl
      const kb = 0.42 + 0.4 * (1 - t) * (1 - t) + 0.4 * t * t * t;
      const kt = 0.95;
      // omega = conj(q0) * q1
      tmp[0] = -q[q0i]; tmp[1] = -q[q0i + 1]; tmp[2] = -q[q0i + 2]; tmp[3] = q[q0i + 3];
      qMul(tmp, 0, q, q1i, tq, 0);
      const r = a.darboux;
      const mx = tq[0] - r[di], my = tq[1] - r[di + 1], mz = tq[2] - r[di + 2], mw = tq[3] - r[di + 3];
      const px = tq[0] + r[di], py = tq[1] + r[di + 1], pz = tq[2] + r[di + 2], pw = tq[3] + r[di + 3];
      let ox, oy, oz;
      if (mx * mx + my * my + mz * mz + mw * mw > px * px + py * py + pz * pz + pw * pw) { ox = px; oy = py; oz = pz; } else { ox = mx; oy = my; oz = mz; }
      const wq0 = 1, wq1 = 1;
      const inv = 1 / (wq0 + wq1);
      tmp[0] = ox * kb * inv; tmp[1] = oy * kb * inv; tmp[2] = oz * kt * inv; tmp[3] = 0;
      // corrq0 = q1 * omega * wq0 ; corrq1 = -q0 * omega * wq1
      const c0 = this._c0 || (this._c0 = new Float64Array(4));
      const c1 = this._c1 || (this._c1 = new Float64Array(4));
      qMul(q, q1i, tmp, 0, c0, 0);
      qMul(q, q0i, tmp, 0, c1, 0);
      const rootLock = s === 0 ? 0.35 : 1;
      for (let c = 0; c < 4; c++) { q[q0i + c] += c0[c] * wq0 * rootLock; q[q1i + c] -= c1[c] * wq1; }
      qNormalize(q, q0i); qNormalize(q, q1i);
    }

    // strain limiting: arms stretch when pulled, but not without bound
    for (let s = 0; s < S; s++) {
      const i0 = (b + s) * 3, i1 = (b + s + 1) * 3;
      const dx = x[i1] - x[i0], dy = x[i1 + 1] - x[i0 + 1], dz = x[i1 + 2] - x[i0 + 2];
      const d = Math.hypot(dx, dy, dz);
      const lo = l * 0.55, hi = l * 1.55;
      if (d > hi || d < lo) {
        const target = d > hi ? hi : lo;
        const nx = dx / (d || 1e-9), ny = dy / (d || 1e-9), nz = dz / (d || 1e-9);
        const w1 = w[b + s + 1];
        if (s === 0) {
          // the root belongs to the head: the pull goes into the head as a rigid body
          const wh = this._headInvMass(x[i0], x[i0 + 1], x[i0 + 2], nx, ny, nz);
          const lam = (d - target) / (wh + w1);
          x[i1] -= w1 * lam * nx; x[i1 + 1] -= w1 * lam * ny; x[i1 + 2] -= w1 * lam * nz;
          this._headImpulse(nx * lam, ny * lam, nz * lam, x[i0], x[i0 + 1], x[i0 + 2]);
        } else {
          const w0 = w[b + s];
          const lam = (d - target) / (w0 + w1);
          x[i0] += w0 * lam * nx; x[i0 + 1] += w0 * lam * ny; x[i0 + 2] += w0 * lam * nz;
          x[i1] -= w1 * lam * nx; x[i1 + 1] -= w1 * lam * ny; x[i1 + 2] -= w1 * lam * nz;
        }
      }
    }
  }

  // ------------------------------------------------------------------ head as a rigid body
  // Arm constraints that end on the head treat it as one rigid body (mass + isotropic inertia),
  // so a pull on an arm lifts and turns the whole plush instead of only tugging one particle.
  _headInvMass(px, py, pz, nx, ny, nz) {
    const c = this.headC;
    const rx = px - c[0], ry = py - c[1], rz = pz - c[2];
    const cx = ry * nz - rz * ny, cy = rz * nx - rx * nz, cz = rx * ny - ry * nx;
    return 1 / this.cl.mt + (cx * cx + cy * cy + cz * cz) / this.headInertia;
  }

  _headImpulse(Jx, Jy, Jz, px, py, pz) {
    const c = this.headC, x = this.x;
    const rx = px - c[0], ry = py - c[1], rz = pz - c[2];
    const invM = 1 / this.cl.mt, invI = 1 / this.headInertia;
    const tx = (ry * Jz - rz * Jy) * invI, ty = (rz * Jx - rx * Jz) * invI, tz = (rx * Jy - ry * Jx) * invI;
    const { idx, M } = this.cl;
    for (let k = 0; k < M; k++) {
      const i3 = idx[k] * 3;
      const qx = x[i3] - c[0], qy = x[i3 + 1] - c[1], qz = x[i3 + 2] - c[2];
      x[i3] += Jx * invM + (ty * qz - tz * qy);
      x[i3 + 1] += Jy * invM + (tz * qx - tx * qz);
      x[i3 + 2] += Jz * invM + (tx * qy - ty * qx);
    }
  }

  // ------------------------------------------------------------------ interaction
  _applyEffects(h) {
    const { v, N } = this;
    if (this.pendingImpulse) {
      const { lin, ang } = this.pendingImpulse;
      const c = this.headC;
      for (let i = 0; i < N; i++) {
        const i3 = i * 3;
        const rx = this.x[i3] - c[0], ry = this.x[i3 + 1] - c[1], rz = this.x[i3 + 2] - c[2];
        v[i3] += lin[0] + ang[1] * rz - ang[2] * ry;
        v[i3 + 1] += lin[1] + ang[2] * rx - ang[0] * rz;
        v[i3 + 2] += lin[2] + ang[0] * ry - ang[1] * rx;
      }
      this.pendingImpulse = null;
    }
    if (this.shake) {
      // side-to-side wobble in place: zero-mean velocity, smooth envelope
      const s = this.shake;
      s.t += h;
      const u = Math.min(1, s.t / s.dur);
      const env = Math.sin(u * Math.PI) ** 2;
      const w = Math.PI * 2 * 4.5;
      const vel = Math.sin(s.t * w) * 6.5 * env;
      const prev = s.vel || 0;
      const dv = vel - prev;
      s.vel = vel;
      for (let k = 0; k < this.H; k++) {
        const i3 = k * 3;
        v[i3] += s.dir[0] * dv; v[i3 + 2] += s.dir[2] * dv;
      }
      if (s.t >= s.dur) this.shake = null;
    }
    if (this.squish) {
      this.squish.t += h;
      if (this.squish.t >= this.squish.dur) this.squish = null;
    }
    if (this.pendingTwist && this.grab) {
      // twist the plush about the line from the hand down through its body, like spinning a held toy
      const ang = this.pendingTwist * 0.12;
      this.pendingTwist -= ang;
      const o = this.grab.target, c = this.headC;
      let ax = [c[0] - o[0], c[1] - o[1], c[2] - o[2]];
      const al = Math.hypot(ax[0], ax[1], ax[2]);
      ax = al > 0.05 ? [ax[0] / al, ax[1] / al, ax[2] / al] : [0, 1, 0];
      const cs = Math.cos(ang), sn = Math.sin(ang);
      for (let i = 0; i < N; i++) {
        const i3 = i * 3;
        const rx = this.x[i3] - o[0], ry = this.x[i3 + 1] - o[1], rz = this.x[i3 + 2] - o[2];
        const dot = rx * ax[0] + ry * ax[1] + rz * ax[2];
        const cx = ax[1] * rz - ax[2] * ry, cy = ax[2] * rx - ax[0] * rz, cz = ax[0] * ry - ax[1] * rx;
        const nx = rx * cs + cx * sn + ax[0] * dot * (1 - cs);
        const ny = ry * cs + cy * sn + ax[1] * dot * (1 - cs);
        const nz = rz * cs + cz * sn + ax[2] * dot * (1 - cs);
        this.x[i3] = o[0] + nx; this.x[i3 + 1] = o[1] + ny; this.x[i3 + 2] = o[2] + nz;
      }
      // the pinch turns with the hand
      const offs = this.grab.offs;
      for (let n = 0; n < offs.length; n += 3) {
        const rx = offs[n], ry = offs[n + 1], rz = offs[n + 2];
        const dot = rx * ax[0] + ry * ax[1] + rz * ax[2];
        const cx = ax[1] * rz - ax[2] * ry, cy = ax[2] * rx - ax[0] * rz, cz = ax[0] * ry - ax[1] * rx;
        offs[n] = rx * cs + cx * sn + ax[0] * dot * (1 - cs);
        offs[n + 1] = ry * cs + cy * sn + ax[1] * dot * (1 - cs);
        offs[n + 2] = rz * cs + cz * sn + ax[2] * dot * (1 - cs);
      }
      // the segment frames turn with the body
      const half = ang * 0.5, sn2 = Math.sin(half);
      const rq = [ax[0] * sn2, ax[1] * sn2, ax[2] * sn2, Math.cos(half)];
      const tmp = new Float64Array(4);
      for (const a of this.arms) {
        for (let s2 = 0; s2 < ARM_PARTICLES - 1; s2++) {
          qMul(rq, 0, a.q, s2 * 4, tmp, 0);
          a.q.set(tmp, s2 * 4);
        }
      }
      if (Math.abs(this.pendingTwist) < 1e-4) this.pendingTwist = 0;
    }
  }

  _solveInteraction(h) {
    const { x } = this;
    const g = this.grab;
    if (g) {
      const t = g.target;
      for (let n = 0; n < g.idx.length; n++) {
        const i3 = g.idx[n] * 3;
        const k = g.k * g.wts[n];
        const ox = g.offs[n * 3], oy = g.offs[n * 3 + 1], oz = g.offs[n * 3 + 2];
        x[i3] += k * (t[0] + ox - x[i3]);
        x[i3 + 1] += k * (t[1] + oy - x[i3 + 1]);
        x[i3 + 2] += k * (t[2] + oz - x[i3 + 2]);
      }
    }
    const f = this.finger;
    if (f.active) this._solveFinger(h);
  }

  _solveFinger() {
    const { x, r } = this;
    const f = this.finger;
    const tip = f.tip;
    const R = f.R;
    // reach + grip
    for (const a of this.arms) {
      const hold = f.holds[a.k];
      const b = a.base;
      if (hold) {
        const n = ARM_PARTICLES - hold.j0;
        for (let m = 0; m < n; m++) {
          const j = hold.j0 + m;
          const i3 = (b + j) * 3;
          const ang = hold.theta0 + hold.dir * m * 0.92;
          const rad = R + r[b + j] * 0.95;
          const tx = tip[0] + Math.cos(ang) * rad;
          const ty = tip[1] + hold.y0 + m * 0.028;
          const tz = tip[2] + Math.sin(ang) * rad;
          const k = m === 0 ? 0.4 : 0.3;
          if (m === 0) {
            const err = Math.hypot(tx - x[i3], ty - x[i3 + 1], tz - x[i3 + 2]);
            if (err > 0.55) { f.holds[a.k] = null; break; }
          }
          x[i3] += k * (tx - x[i3]); x[i3 + 1] += k * (ty - x[i3 + 1]); x[i3 + 2] += k * (tz - x[i3 + 2]);
        }
        continue;
      }
      // reach up toward a nearby finger
      const it = (b + ARM_PARTICLES - 1) * 3;
      const dx = tip[0] - x[it], dz = tip[2] - x[it + 2];
      const dh = Math.hypot(dx, dz);
      const above = tip[1] - x[it + 1];
      if (dh < 0.95 && above > -0.2 && above < 2.4) {
        const reach = (1 - dh / 0.95) * (f.down ? 1 : 0.65);
        for (let j = ARM_PARTICLES - 7; j < ARM_PARTICLES; j++) {
          const wgt = (j - (ARM_PARTICLES - 8)) / 7;
          const i3 = (b + j) * 3;
          const tx = tip[0], ty = tip[1] + 0.05, tz = tip[2];
          const k = 0.0045 * reach * wgt;
          x[i3] += k * (tx - x[i3]); x[i3 + 1] += k * (ty - x[i3 + 1]) * 1.4; x[i3 + 2] += k * (tz - x[i3 + 2]);
        }
      }
      // grip when the finger is down and an arm touches it
      if (f.down) {
        for (let j = 6; j < ARM_PARTICLES - 2; j++) {
          const i3 = (b + j) * 3;
          const ex = x[i3] - tip[0], ey = x[i3 + 1] - tip[1], ez = x[i3 + 2] - tip[2];
          const horiz = Math.hypot(ex, ez);
          if (ey > -0.12 && ey < 0.5 && horiz < R + r[b + j] + 0.07) {
            const j0 = Math.min(j, ARM_PARTICLES - 5);
            const i0 = (b + j0) * 3;
            const theta0 = Math.atan2(x[i0 + 2] - tip[2], x[i0] - tip[0]);
            // wind in the direction the arm is already heading around the finger
            const nx = x[i0 + 3] - x[i0], nz = x[i0 + 5] - x[i0 + 2];
            const cross = (x[i0] - tip[0]) * nz - (x[i0 + 2] - tip[2]) * nx;
            f.holds[a.k] = { j0, theta0, y0: Math.max(0.02, x[i0 + 1] - tip[1]), dir: cross >= 0 ? 1 : -1 };
            break;
          }
        }
      }
    }
    // the finger is a solid capsule pointing straight up from its tip
    for (let i = 0; i < this.N; i++) {
      const i3 = i * 3;
      const ex = x[i3] - tip[0], ey = x[i3 + 1] - tip[1], ez = x[i3 + 2] - tip[2];
      const rr = R + r[i] * 0.85;
      if (ey >= 0) {
        const d = Math.hypot(ex, ez);
        if (d < rr) {
          const s = d > 1e-6 ? rr / d : 1;
          x[i3] = tip[0] + (d > 1e-6 ? ex * s : rr); x[i3 + 2] = tip[2] + (d > 1e-6 ? ez * s : 0);
        }
      } else {
        const d = Math.hypot(ex, ey, ez);
        if (d < rr) {
          const s = rr / (d || 1e-6);
          x[i3] = tip[0] + ex * s; x[i3 + 1] = tip[1] + ey * s; x[i3 + 2] = tip[2] + ez * s;
        }
      }
    }
  }

  // ------------------------------------------------------------------ collisions
  _solveCollisions(sub) {
    const { x, p, r, N } = this;
    const HR = this.headR;
    // floor with friction
    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      let ri = r[i];
      if (i < this.H && this.support[i] > 0) {
        const d = this.restDir;
        const down = -(HR[3] * d[i * 3] + HR[4] * d[i * 3 + 1] + HR[5] * d[i * 3 + 2]);
        const d0 = this.supportDown[i];
        // full support while the particle still faces the table, fading out as the plush tips over
        const f = Math.min(1, Math.max(0, (down - 0.25) / Math.max(0.05, d0 - 0.25)));
        ri += this.support[i] * f;
      }
      if (x[i3 + 1] < ri) {
        const pen = ri - x[i3 + 1];
        x[i3 + 1] = ri;
        const dx = x[i3] - p[i3], dz = x[i3 + 2] - p[i3 + 2];
        const tl = Math.hypot(dx, dz);
        const mu = 0.85;
        if (tl > 1e-9) {
          const f = Math.min(1, (mu * pen) / tl + 0.05);
          x[i3] -= dx * f; x[i3 + 2] -= dz * f;
        }
      }
    }
    // arms vs head (ellipsoid around the fitted head frame)
    const R = this.headR;
    const c0 = this.cl.c0;
    const bc = [0, BODY.cy - c0[1], 0];
    const cx = this.headC[0] + R[0] * bc[0] + R[1] * bc[1] + R[2] * bc[2];
    const cy = this.headC[1] + R[3] * bc[0] + R[4] * bc[1] + R[5] * bc[2];
    const cz = this.headC[2] + R[6] * bc[0] + R[7] * bc[1] + R[8] * bc[2];
    for (const a of this.arms) {
      for (let j = 4; j < ARM_PARTICLES; j++) {
        const i = a.base + j, i3 = i * 3;
        const wx = x[i3] - cx, wy = x[i3 + 1] - cy, wz = x[i3 + 2] - cz;
        const lx = R[0] * wx + R[3] * wy + R[6] * wz;
        const ly = R[1] * wx + R[4] * wy + R[7] * wz;
        const lz = R[2] * wx + R[5] * wy + R[8] * wz;
        const ri = r[i] * 0.9;
        const ry = (ly > 0 ? BODY.ryTop : BODY.ryBot) + ri;
        const sx = lx / (BODY.rx * 1.04 + ri), sy = ly / ry, sz = lz / (BODY.rz * 1.04 + ri);
        const len = Math.hypot(sx, sy, sz);
        if (len < 1 && len > 1e-6) {
          const f = 1 / len;
          const nx = lx * f, ny = ly * f, nz = lz * f;
          const dx = nx - lx, dy = ny - ly, dz = nz - lz;
          x[i3] += R[0] * dx + R[1] * dy + R[2] * dz;
          x[i3 + 1] += R[3] * dx + R[4] * dy + R[5] * dz;
          x[i3 + 2] += R[6] * dx + R[7] * dy + R[8] * dz;
        }
      }
    }
    // arm–arm contact (every other substep)
    if (sub % 2 === 0) {
      const A0 = this.H;
      const NA = ARM_COUNT * ARM_PARTICLES;
      for (let ia = 0; ia < NA; ia++) {
        const ja = ia % ARM_PARTICLES;
        if (ja < 3) continue;
        const i = A0 + ia, i3 = i * 3;
        for (let ib = ia + 1; ib < NA; ib++) {
          const jb = ib % ARM_PARTICLES;
          if (jb < 3) continue;
          const sameArm = Math.floor(ia / ARM_PARTICLES) === Math.floor(ib / ARM_PARTICLES);
          if (sameArm && ib - ia < 4) continue;
          const k = A0 + ib, k3 = k * 3;
          const dx = x[k3] - x[i3], dy = x[k3 + 1] - x[i3 + 1], dz = x[k3 + 2] - x[i3 + 2];
          const rr = (r[i] + r[k]) * 0.95;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < rr * rr && d2 > 1e-12) {
            const d = Math.sqrt(d2);
            const corr = (rr - d) / d * 0.5;
            x[i3] -= dx * corr; x[i3 + 1] -= dy * corr; x[i3 + 2] -= dz * corr;
            x[k3] += dx * corr; x[k3 + 1] += dy * corr; x[k3 + 2] += dz * corr;
          }
        }
      }
    }
  }

  _stats() {
    const { v, m, N } = this;
    let ke = 0;
    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      ke += m[i] * (v[i3] * v[i3] + v[i3 + 1] * v[i3 + 1] + v[i3 + 2] * v[i3 + 2]);
    }
    // 0.5 * (g/1000) * (units/s * 0.1)^2 J  ->  mJ
    this.kinetic = ke * 0.005;
  }

  // ------------------------------------------------------------------ public helpers
  holdingCount() { return this.finger.holds.reduce((n, h) => n + (h ? 1 : 0), 0); }

  releaseAll() { this.finger.holds.fill(null); this.grab = null; }

  startGrab(particle, target, axis) {
    const { x } = this;
    const idx = [particle];
    const wts = [1];
    if (particle < this.H) {
      // a pinch of stuffing: the nearest few head particles share the pull
      const p3 = particle * 3;
      const near = [];
      for (let i = 0; i < this.H; i++) {
        if (i === particle) continue;
        const d = Math.hypot(x[i * 3] - x[p3], x[i * 3 + 1] - x[p3 + 1], x[i * 3 + 2] - x[p3 + 2]);
        near.push([d, i]);
      }
      near.sort((a, b) => a[0] - b[0]);
      for (let n = 0; n < 3; n++) { idx.push(near[n][1]); wts.push(0.45); }
    } else {
      // arm: pinch the neighbours lightly too
      const j = (particle - this.H) % ARM_PARTICLES;
      if (j > 0) { idx.push(particle - 1); wts.push(0.3); }
      if (j < ARM_PARTICLES - 1) { idx.push(particle + 1); wts.push(0.3); }
    }
    const offs = new Float64Array(idx.length * 3);
    for (let n = 0; n < idx.length; n++) {
      offs[n * 3] = x[idx[n] * 3] - x[particle * 3];
      offs[n * 3 + 1] = x[idx[n] * 3 + 1] - x[particle * 3 + 1];
      offs[n * 3 + 2] = x[idx[n] * 3 + 2] - x[particle * 3 + 2];
    }
    const isHead = particle < this.H;
    this.pendingTwist = 0;
    this.grab = { idx, wts, offs, target: Float64Array.from(target), axis: Float64Array.from(axis), k: isHead ? 0.32 : 0.5, particle };
  }

  toss() {
    const a = Math.random() * Math.PI * 2;
    this.pendingImpulse = {
      lin: [Math.cos(a) * 1.2, 24, Math.sin(a) * 1.2],
      ang: [(Math.random() - 0.5) * 9, (Math.random() - 0.5) * 7, (Math.random() - 0.5) * 9],
    };
    this.releaseAll();
  }

  shakeIt(dir) { this.shake = { t: 0, dur: 1.1, dir }; this.finger.holds.fill(null); }

  squishIt() { this.squish = { t: 0, dur: 0.9 }; }
}
