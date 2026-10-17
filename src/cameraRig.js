import * as THREE from 'three';

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Turntable camera. "Hand" and "Finger" share the wide view, "Comb" moves in close.
export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.presets = {
      wide: { dist: 10.4, el: 0.36, target: new THREE.Vector3(0, 0.4, 0) },
      close: { dist: 5.45, el: 0.2, target: new THREE.Vector3(0, 0.66, 0) },
    };
    const p = this.presets.wide;
    this.s = { az: 0, el: p.el, dist: p.dist, target: p.target.clone() };
    this.tween = null;
    this.spin = { az: 0, el: 0 };
    this.dragging = false;
  }

  goTo(name, duration = 1.0) {
    const to = this.presets[name];
    let az = this.s.az % (Math.PI * 2);
    if (az > Math.PI) az -= Math.PI * 2;
    if (az < -Math.PI) az += Math.PI * 2;
    this.s.az = az;
    this.spin.az = this.spin.el = 0;
    this.tween = {
      t: 0, duration,
      from: { az, el: this.s.el, dist: this.s.dist, target: this.s.target.clone() },
      to: { az: 0, el: to.el, dist: to.dist, target: to.target.clone() },
    };
  }

  orbit(dx, dy) {
    this.tween = null;
    const daz = -dx * 0.0046;
    const del = dy * 0.0032;
    this.s.az += daz;
    this.s.el = THREE.MathUtils.clamp(this.s.el + del, 0.05, 1.15);
    this.spin.az = daz * 60;
    this.spin.el = del * 60;
  }

  update(dt, aspect) {
    const s = this.s;
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.duration);
      const e = ease(tw.t);
      s.az = tw.from.az + (tw.to.az - tw.from.az) * e;
      s.el = tw.from.el + (tw.to.el - tw.from.el) * e;
      s.dist = tw.from.dist + (tw.to.dist - tw.from.dist) * e;
      s.target.lerpVectors(tw.from.target, tw.to.target, e);
      if (tw.t >= 1) this.tween = null;
    } else if (!this.dragging) {
      // a little inertia after letting go of the table
      const k = Math.exp(-dt * 6);
      this.spin.az *= k; this.spin.el *= k;
      s.az += this.spin.az * dt;
      s.el = THREE.MathUtils.clamp(s.el + this.spin.el * dt, 0.05, 1.15);
    }
    // keep the whole octopus (about 3.2 units across) in frame on narrow windows
    const hHalf = Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * aspect);
    const halfWidth = 1.9 * (s.dist / this.presets.wide.dist);
    const d = Math.max(s.dist, halfWidth / Math.tan(hHalf));
    const c = this.camera;
    c.position.set(
      s.target.x + Math.sin(s.az) * Math.cos(s.el) * d,
      s.target.y + Math.sin(s.el) * d,
      s.target.z + Math.cos(s.az) * Math.cos(s.el) * d,
    );
    c.lookAt(s.target);
  }
}
