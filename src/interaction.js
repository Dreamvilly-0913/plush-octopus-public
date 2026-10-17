import * as THREE from 'three';
import { ARM_PARTICLES } from './sim/rest.js';

const RING_VERTS = 19; // must match octopusView (RING + 1)
const SUB = 4;
const ARM_VERTS = ((ARM_PARTICLES - 1) * SUB + 1 + 6) * RING_VERTS;
const HOVER_HEIGHT = 2.15;

export class Interaction {
  constructor({ canvas, camera, sim, view, rig, setCursor }) {
    this.canvas = canvas;
    this.camera = camera;
    this.sim = sim;
    this.view = view;
    this.rig = rig;
    this.setCursor = setCursor;
    this.tool = 'hand';
    this.ray = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.mode = null;
    this.pointers = new Map();
    this.plane = new THREE.Plane();
    this.grabStart = new THREE.Vector3();
    this.grabOrigin = new THREE.Vector3();
    this.lastBrush = null;
    this.fingerTarget = HOVER_HEIGHT;
    this.fingerXZ = null;
    this.hoverHit = false;
    this._v = new THREE.Vector3();

    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', (e) => this._up(e));
    canvas.addEventListener('pointerleave', () => this._leave());
    canvas.addEventListener('pointerenter', (e) => this._enter(e));
    canvas.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setTool(tool) {
    this.tool = tool;
    this.mode = null;
    this.sim.grab = null;
    this.rig.dragging = false;
    const f = this.sim.finger;
    if (tool !== 'finger') {
      f.active = false;
      f.down = false;
      f.holds.fill(null);
    } else {
      f.tip[1] = 6;
      this.fingerTarget = HOVER_HEIGHT;
      if (this.fingerXZ) f.active = true;
    }
    this._cursor();
  }

  _setNDC(e) {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
  }

  _pick() {
    const hits = this.ray.intersectObjects([this.view.body, this.view.arms], false);
    return hits.length ? hits[0] : null;
  }

  _cursor() {
    if (this.tool === 'finger') return this.setCursor('none');
    if (this.mode === 'grab' || this.mode === 'orbit') return this.setCursor('grabbing');
    if (this.tool === 'comb') return this.setCursor(this.hoverHit || this.mode === 'brush' ? 'brush' : 'default');
    return this.setCursor(this.hoverHit ? 'grab' : 'default');
  }

  // particle nearest to a hit on the body or an arm
  _particleFor(hit) {
    const sim = this.sim;
    if (hit.object === this.view.arms) {
      const v = hit.face.a;
      const k = Math.floor(v / ARM_VERTS);
      const ring = Math.floor((v % ARM_VERTS) / RING_VERTS);
      const j = Math.min(ARM_PARTICLES - 1, Math.round(ring / SUB));
      if (j >= 2) return sim.H + k * ARM_PARTICLES + j;
    }
    let best = 0, bd = Infinity;
    for (let i = 0; i < sim.H; i++) {
      const d = Math.hypot(sim.x[i * 3] - hit.point.x, sim.x[i * 3 + 1] - hit.point.y, sim.x[i * 3 + 2] - hit.point.z) - sim.r[i] * 0.5;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  _down(e) {
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic or already-released pointer */ }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2 && this.mode === 'grab') {
      const [a, b] = [...this.pointers.values()];
      this.twistAngle = Math.atan2(b.y - a.y, b.x - a.x);
      return;
    }
    if (this.pointers.size > 1) return;
    this._setNDC(e);
    this.lastX = e.clientX;
    this.lastY = e.clientY;

    if (this.tool === 'finger') {
      this.sim.finger.active = true;
      if (!this.fingerXZ) this._updateFingerXZ();
      this.sim.finger.down = true;
      return;
    }

    const hit = this._pick();
    if (hit && this.tool === 'hand') {
      const i = this._particleFor(hit);
      const sim = this.sim;
      const p = new THREE.Vector3(sim.x[i * 3], sim.x[i * 3 + 1], sim.x[i * 3 + 2]);
      const camDir = this.camera.getWorldDirection(this._v).clone();
      this.plane.setFromNormalAndCoplanarPoint(camDir, hit.point);
      this.grabStart.copy(hit.point);
      this.grabOrigin.copy(p);
      sim.startGrab(i, [p.x, p.y, p.z], [camDir.x, camDir.y, camDir.z]);
      this.mode = 'grab';
    } else if (hit && this.tool === 'comb') {
      this.mode = 'brush';
      this.lastBrush = hit.point.clone();
    } else {
      this.mode = 'orbit';
      this.rig.dragging = true;
    }
    this._cursor();
  }

  _move(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this._setNDC(e);

    if (this.pointers.size === 2 && this.mode === 'grab') {
      const [a, b] = [...this.pointers.values()];
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      let d = ang - this.twistAngle;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      this.sim.pendingTwist += d;
      this.twistAngle = ang;
      return;
    }

    if (this.tool === 'finger') {
      this.sim.finger.active = true;
      this._updateFingerXZ();
      return;
    }

    if (this.mode === 'grab' && this.sim.grab) {
      const hitP = this.ray.ray.intersectPlane(this.plane, this._v);
      if (hitP) {
        const t = this.grabOrigin.clone().add(hitP.sub(this.grabStart));
        t.x = THREE.MathUtils.clamp(t.x, -5.5, 5.5);
        t.z = THREE.MathUtils.clamp(t.z, -5.5, 5.5);
        t.y = THREE.MathUtils.clamp(t.y, 0.04, 5);
        this.sim.grab.target[0] = t.x; this.sim.grab.target[1] = t.y; this.sim.grab.target[2] = t.z;
      }
      return;
    }
    if (this.mode === 'orbit') {
      this.rig.orbit(e.clientX - this.lastX, e.clientY - this.lastY);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      return;
    }
    if (this.mode === 'brush') {
      const hit = this._pick();
      if (hit) {
        const d = hit.point.clone().sub(this.lastBrush);
        const len = d.length();
        if (len > 0.006) {
          this.view.comb(hit, d.divideScalar(len), Math.min(1, len / 0.05 + 0.35));
          this.lastBrush.copy(hit.point);
        }
      }
      return;
    }
    // hover feedback (throttled by the frame loop via flag)
    this._hoverDirty = true;
  }

  _up(e) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size > 0) return;
    if (this.tool === 'finger') {
      this.sim.finger.down = false;
      return;
    }
    if (this.mode === 'grab') this.sim.grab = null;
    this.mode = null;
    this.rig.dragging = false;
    this._cursor();
  }

  _leave() {
    if (this.tool === 'finger' && this.pointers.size === 0) {
      this.sim.finger.active = false;
      this.sim.finger.down = false;
      this.fingerXZ = null;
    }
    this.hoverHit = false;
    if (!this.mode) this._cursor();
  }

  _enter(e) {
    if (this.tool === 'finger') {
      this._setNDC(e);
      const f = this.sim.finger;
      f.tip[1] = 6;
      this.fingerTarget = HOVER_HEIGHT;
      f.active = true;
      this._updateFingerXZ();
    }
  }

  _wheel(e) {
    if (this.mode === 'grab' && this.sim.grab) {
      e.preventDefault();
      this.sim.pendingTwist += THREE.MathUtils.clamp(e.deltaY, -120, 120) * 0.0045;
    }
  }

  // The finger hangs over whatever is under the cursor (an arm, the head or the table) and is
  // pressed straight down onto it. While it is carrying the octopus, only the table is used, so it
  // does not climb the plush that hangs from it.
  _updateFingerXZ() {
    const f = this.sim.finger;
    const holding = this.sim.holdingCount() > 0;
    let point = null;
    if (!holding && !f.down) {
      const hit = this._pick();
      if (hit) point = hit.point;
    }
    if (!point) {
      // pressed or carrying: slide in the horizontal plane of the spot we pressed on
      const planeY = f.down || holding ? Math.min(1.6, this.surfaceY || 0) : 0;
      const r = this.ray.ray;
      if (r.direction.y < -1e-4 && r.origin.y > planeY) {
        const t = (planeY - r.origin.y) / r.direction.y;
        point = this._v.copy(r.origin).addScaledVector(r.direction, t);
      }
    }
    if (!point) return;
    this.fingerXZ = [THREE.MathUtils.clamp(point.x, -6, 6), THREE.MathUtils.clamp(point.z, -6, 6)];
    if (!f.down && !holding) this.surfaceY = point.y;
  }

  _pressHeight() {
    const f = this.sim.finger;
    if (this.sim.holdingCount() > 0) return f.tip[1];
    const down = new THREE.Raycaster(new THREE.Vector3(f.tip[0], 8, f.tip[2]), new THREE.Vector3(0, -1, 0));
    const hits = down.intersectObjects([this.view.body, this.view.arms], false);
    if (hits.length) return Math.max(f.R * 0.6, hits[0].point.y - 0.08);
    return f.R * 0.55;
  }

  update(dt) {
    const f = this.sim.finger;
    if (this.tool === 'finger' && f.active && this.fingerXZ) {
      const holding = this.sim.holdingCount() > 0;
      const hover = holding ? 1.95 : Math.max(0.55, (this.surfaceY || 0) + 0.5);
      this.fingerTarget = f.down ? this._pressHeight() : hover;
      const ky = 1 - Math.exp(-dt * (f.down ? 12 : 8));
      const kx = 1 - Math.exp(-dt * 22);
      if (f.tip[1] > 5) { f.tip[0] = this.fingerXZ[0]; f.tip[2] = this.fingerXZ[1]; }
      f.tip[0] += (this.fingerXZ[0] - f.tip[0]) * kx;
      f.tip[2] += (this.fingerXZ[1] - f.tip[2]) * kx;
      f.tip[1] += (this.fingerTarget - f.tip[1]) * ky;
    }
    if (this._hoverDirty && !this.mode && this.tool !== 'finger') {
      this._hoverDirty = false;
      this.hoverHit = !!this._pick();
      this._cursor();
    }
  }
}
