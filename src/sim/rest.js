// Rest geometry of the plush, in sim units (1 unit = 10 cm). y is up, the floor is y = 0,
// and the octopus faces +z (towards the default camera).
import { qFromBasis } from './qmath.js';

export const ARM_COUNT = 8;
export const ARM_PARTICLES = 16; // 15 rod segments per arm
export const SEG_LEN = 0.081;
export const ARM_LEN = SEG_LEN * (ARM_PARTICLES - 1);

export const BODY = {
  cy: 0.8, // centre height of the head
  rx: 0.63,
  rz: 0.63,
  ryTop: 0.8,
  ryBot: 0.54,
};

const DEG = Math.PI / 180;

// Head profile: polar angle theta (0 = crown, PI = underside) -> [radial scale, y offset]
// The crown is a slightly "full" superellipse so the head reads round and stuffed, not egg-like.
export function bodyProfile(theta) {
  const s = Math.sin(theta);
  const c = Math.cos(theta);
  const ex = c > 0 ? 0.94 : 1;
  const se = Math.pow(Math.max(0, s), ex);
  const ce = Math.sign(c) * Math.pow(Math.abs(c), ex);
  const bulge = 1 + 0.04 * Math.exp(-(((theta - 0.5 * Math.PI) / (0.2 * Math.PI)) ** 2));
  const skirt = 1 + 0.05 * Math.exp(-(((theta - 0.8 * Math.PI) / (0.1 * Math.PI)) ** 2));
  const r = se * bulge * skirt;
  const y = ce > 0 ? ce * BODY.ryTop : ce * BODY.ryBot;
  return [r, y];
}

// phi = 0 faces +z (front), increasing towards +x
export function bodyPoint(theta, phi, out = [0, 0, 0]) {
  const [r, y] = bodyProfile(theta);
  out[0] = BODY.rx * r * Math.sin(phi);
  out[1] = BODY.cy + y;
  out[2] = BODY.rz * r * Math.cos(phi);
  return out;
}

export function bodyNormal(theta, phi, out = [0, 0, 0]) {
  const e = 1e-3;
  const p = bodyPoint(theta, phi, [0, 0, 0]);
  const pt = bodyPoint(Math.min(theta + e, Math.PI - 1e-4), phi, [0, 0, 0]);
  const pp = bodyPoint(theta, phi + e, [0, 0, 0]);
  const tx = pt[0] - p[0], ty = pt[1] - p[1], tz = pt[2] - p[2];
  let px = pp[0] - p[0], py = pp[1] - p[1], pz = pp[2] - p[2];
  if (Math.hypot(px, py, pz) < 1e-9) { // poles
    out[0] = 0; out[1] = theta < 1 ? 1 : -1; out[2] = 0; return out;
  }
  // n = dp/dtheta x dp/dphi points outward
  let nx = ty * pz - tz * py, ny = tz * px - tx * pz, nz = tx * py - ty * px;
  const l = Math.hypot(nx, ny, nz) || 1;
  out[0] = nx / l; out[1] = ny / l; out[2] = nz / l;
  return out;
}

// Direction from the head centre -> distance to the rest surface along that direction
export function surfaceDistance(dx, dy, dz) {
  const l = Math.hypot(dx, dy, dz) || 1;
  const ux = dx / l, uy = dy / l, uz = dz / l;
  const theta = Math.acos(Math.max(-1, Math.min(1, uy)));
  const phi = Math.atan2(ux, uz);
  // iterate: the profile is not a pure ellipsoid, so refine theta a couple of times
  let th = theta;
  for (let i = 0; i < 6; i++) {
    const p = bodyPoint(th, phi);
    const ry = p[1] - BODY.cy;
    const rr = Math.hypot(p[0], p[2]);
    const a = Math.atan2(rr, ry);
    th += theta - a;
    th = Math.max(1e-4, Math.min(Math.PI - 1e-4, th));
  }
  const p = bodyPoint(th, phi);
  return Math.hypot(p[0], p[1] - BODY.cy, p[2]);
}

// Arm thickness profile; t = 0 at the root, 1 at the tip
export function armHalfWidth(t) { return 0.185 * (1 - 0.42 * t) + 0.01; }
export function armHalfHeight(t) { return 0.152 * (1 - 0.42 * t) + 0.006; }

// Curvature profile (degrees per joint) along the 15 segments: arc down onto the floor,
// run flat, then a strong upward curl at the tip.
const TURNS = [8, 8, 7, 6, 4, 1, 0, -1, 0, 4, 15, 30, 40, 44, 44];
const START_ANGLE = -34; // degrees, pointing outward and down

export function buildArmRest(k) {
  const phi = ((k + 0.5) / ARM_COUNT) * Math.PI * 2;
  // a small, deliberate irregularity so the arms do not look stamped out
  const jitter = [0.0, 0.6, -0.4, 0.3, -0.7, 0.4, -0.2, 0.5][k];
  const er = [Math.sin(phi), 0, Math.cos(phi)];
  const ey = [0, 1, 0];

  const rootR = 0.27;
  const rootY = 0.25;
  let u = rootR;
  let v = rootY;
  let ang = START_ANGLE * DEG;
  const uv = [[u, v]];
  const angs = [];
  for (let s = 0; s < ARM_PARTICLES - 1; s++) {
    const turn = (TURNS[s] + (s > 9 ? jitter * 3 : 0)) * DEG;
    ang += turn * 0.5;
    angs.push(ang);
    u += Math.cos(ang) * SEG_LEN;
    v += Math.sin(ang) * SEG_LEN;
    ang += turn * 0.5;
    uv.push([u, v]);
  }

  const pos = new Float64Array(ARM_PARTICLES * 3);
  for (let j = 0; j < ARM_PARTICLES; j++) {
    pos[j * 3] = er[0] * uv[j][0];
    pos[j * 3 + 1] = uv[j][1];
    pos[j * 3 + 2] = er[2] * uv[j][0];
  }

  // segment frames: d3 along the rod, d2 = the top (fur) side, d1 = lateral
  const quats = new Float64Array((ARM_PARTICLES - 1) * 4);
  for (let s = 0; s < ARM_PARTICLES - 1; s++) {
    const a = angs[s];
    const d3 = [er[0] * Math.cos(a), Math.sin(a), er[2] * Math.cos(a)];
    const d2 = [-er[0] * Math.sin(a), Math.cos(a), -er[2] * Math.sin(a)];
    const d1 = [d2[1] * d3[2] - d2[2] * d3[1], d2[2] * d3[0] - d2[0] * d3[2], d2[0] * d3[1] - d2[1] * d3[0]];
    qFromBasis(d1, d2, d3, quats, s * 4);
  }
  return { phi, pos, quats, er, ey };
}

// Points filling the head; they form the shape-matched stuffing cluster.
// Rings with 8-fold symmetry (mirror-symmetric front/back and left/right) so the plush sits level.
export function buildHeadParticles() {
  const pts = [];
  const at = (polar, az, scale) => {
    const y = Math.cos(polar), r = Math.sin(polar);
    const ry = y > 0 ? BODY.ryTop : BODY.ryBot;
    pts.push([Math.sin(az) * r * BODY.rx * scale, BODY.cy + y * ry * scale, Math.cos(az) * r * BODY.rz * scale]);
  };
  const ring = (polar, n, offset, scale) => {
    for (let k = 0; k < n; k++) at(polar, ((k + offset) / n) * Math.PI * 2, scale);
  };
  at(0, 0, 0.78);
  ring(Math.PI * 0.25, 8, 0.5, 0.78);
  ring(Math.PI * 0.5, 8, 0, 0.78);
  ring(Math.PI * 0.75, 8, 0.5, 0.78);
  at(Math.PI, 0, 0.78);
  ring(Math.PI * 0.33, 4, 0, 0.42);
  ring(Math.PI * 0.67, 4, 0.5, 0.42);
  pts.push([0, BODY.cy, 0]);
  return pts;
}

export const FUR_COLORS = {
  coral: { top: '#f0805f', under: '#f6d6c4', blush: '#f06a6e', sheen: '#ffb59c' },
  lilac: { top: '#ac94d7', under: '#ece4f7', blush: '#f08aa8', sheen: '#d4c4f2' },
  lagoon: { top: '#55a6a9', under: '#e0f3ef', blush: '#f0909c', sheen: '#a2d9d8' },
};
