// Small allocation-free helpers for quaternions (x, y, z, w) and 3x3 matrices (row-major, length 9)
// stored in plain typed arrays. Used inside the inner simulation loops.

export function qMul(a, ai, b, bi, out, oi) {
  const ax = a[ai], ay = a[ai + 1], az = a[ai + 2], aw = a[ai + 3];
  const bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3];
  out[oi] = aw * bx + ax * bw + ay * bz - az * by;
  out[oi + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[oi + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[oi + 3] = aw * bw - ax * bx - ay * by - az * bz;
}

export function qNormalize(q, i) {
  const l = Math.hypot(q[i], q[i + 1], q[i + 2], q[i + 3]) || 1;
  q[i] /= l; q[i + 1] /= l; q[i + 2] /= l; q[i + 3] /= l;
}

// third director d3 = q * e3 * conj(q)
export function qD3(q, i, out) {
  const x = q[i], y = q[i + 1], z = q[i + 2], w = q[i + 3];
  out[0] = 2 * (x * z + w * y);
  out[1] = 2 * (y * z - w * x);
  out[2] = w * w - x * x - y * y + z * z;
  return out;
}

// second director d2 = q * e2 * conj(q)
export function qD2(q, i, out) {
  const x = q[i], y = q[i + 1], z = q[i + 2], w = q[i + 3];
  out[0] = 2 * (x * y - w * z);
  out[1] = w * w - x * x + y * y - z * z;
  out[2] = 2 * (y * z + w * x);
  return out;
}

// first director d1 = q * e1 * conj(q)
export function qD1(q, i, out) {
  const x = q[i], y = q[i + 1], z = q[i + 2], w = q[i + 3];
  out[0] = w * w + x * x - y * y - z * z;
  out[1] = 2 * (x * y + w * z);
  out[2] = 2 * (x * z - w * y);
  return out;
}

// quaternion from orthonormal basis columns (d1, d2, d3)
export function qFromBasis(d1, d2, d3, out, oi) {
  const m00 = d1[0], m01 = d2[0], m02 = d3[0];
  const m10 = d1[1], m11 = d2[1], m12 = d3[1];
  const m20 = d1[2], m21 = d2[2], m22 = d3[2];
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s; x = (m21 - m12) * s; y = (m02 - m20) * s; z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  out[oi] = x; out[oi + 1] = y; out[oi + 2] = z; out[oi + 3] = w;
  qNormalize(out, oi);
}

export function qToMat3(q, i, m) {
  const x = q[i], y = q[i + 1], z = q[i + 2], w = q[i + 3];
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  m[0] = 1 - 2 * (yy + zz); m[1] = 2 * (xy - wz); m[2] = 2 * (xz + wy);
  m[3] = 2 * (xy + wz); m[4] = 1 - 2 * (xx + zz); m[5] = 2 * (yz - wx);
  m[6] = 2 * (xz - wy); m[7] = 2 * (yz + wx); m[8] = 1 - 2 * (xx + yy);
  return m;
}

// q <- normalize(q + t * (target - q)) taking the short way round
export function qNlerpToward(q, qi, t, ti, k) {
  let dot = q[qi] * t[ti] + q[qi + 1] * t[ti + 1] + q[qi + 2] * t[ti + 2] + q[qi + 3] * t[ti + 3];
  const s = dot < 0 ? -1 : 1;
  for (let c = 0; c < 4; c++) q[qi + c] += k * (s * t[ti + c] - q[qi + c]);
  qNormalize(q, qi);
}

export function slerpInto(a, ai, b, bi, t, out, oi) {
  let ax = a[ai], ay = a[ai + 1], az = a[ai + 2], aw = a[ai + 3];
  let bx = b[bi], by = b[bi + 1], bz = b[bi + 2], bw = b[bi + 3];
  let cos = ax * bx + ay * by + az * bz + aw * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  let k0, k1;
  if (cos > 0.9995) { k0 = 1 - t; k1 = t; } else {
    const th = Math.acos(cos), s = Math.sin(th);
    k0 = Math.sin((1 - t) * th) / s; k1 = Math.sin(t * th) / s;
  }
  out[oi] = ax * k0 + bx * k1; out[oi + 1] = ay * k0 + by * k1; out[oi + 2] = az * k0 + bz * k1; out[oi + 3] = aw * k0 + bw * k1;
  qNormalize(out, oi);
}

// ---------- 3x3 ----------
export function m3MulVec(m, x, y, z, out) {
  out[0] = m[0] * x + m[1] * y + m[2] * z;
  out[1] = m[3] * x + m[4] * y + m[5] * z;
  out[2] = m[6] * x + m[7] * y + m[8] * z;
  return out;
}

export function m3Mul(a, b, out) {
  const r = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  out.set(r);
  return out;
}

export function m3Det(m) {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

export function m3Inverse(m, out) {
  const d = m3Det(m) || 1e-12;
  const r = [
    (m[4] * m[8] - m[5] * m[7]) / d, (m[2] * m[7] - m[1] * m[8]) / d, (m[1] * m[5] - m[2] * m[4]) / d,
    (m[5] * m[6] - m[3] * m[8]) / d, (m[0] * m[8] - m[2] * m[6]) / d, (m[2] * m[3] - m[0] * m[5]) / d,
    (m[3] * m[7] - m[4] * m[6]) / d, (m[1] * m[6] - m[0] * m[7]) / d, (m[0] * m[4] - m[1] * m[3]) / d,
  ];
  for (let i = 0; i < 9; i++) out[i] = r[i];
  return out;
}

// cofactor matrix = det * inverse^T, used to transform normals under a linear map
export function m3Cofactor(m, out) {
  out[0] = m[4] * m[8] - m[5] * m[7]; out[1] = m[5] * m[6] - m[3] * m[8]; out[2] = m[3] * m[7] - m[4] * m[6];
  out[3] = m[2] * m[7] - m[1] * m[8]; out[4] = m[0] * m[8] - m[2] * m[6]; out[5] = m[1] * m[6] - m[0] * m[7];
  out[6] = m[1] * m[5] - m[2] * m[4]; out[7] = m[2] * m[3] - m[0] * m[5]; out[8] = m[0] * m[4] - m[1] * m[3];
  return out;
}

// Rotation extraction, Müller et al. 2016 "A Robust Method to Extract the Rotational Part of Deformations".
// A is row-major; q is warm-started and updated in place.
const _R = new Float64Array(9);
export function extractRotation(A, q, iters) {
  for (let it = 0; it < iters; it++) {
    qToMat3(q, 0, _R);
    // columns of R and A
    const r0x = _R[0], r0y = _R[3], r0z = _R[6];
    const r1x = _R[1], r1y = _R[4], r1z = _R[7];
    const r2x = _R[2], r2y = _R[5], r2z = _R[8];
    const a0x = A[0], a0y = A[3], a0z = A[6];
    const a1x = A[1], a1y = A[4], a1z = A[7];
    const a2x = A[2], a2y = A[5], a2z = A[8];
    let ox = (r0y * a0z - r0z * a0y) + (r1y * a1z - r1z * a1y) + (r2y * a2z - r2z * a2y);
    let oy = (r0z * a0x - r0x * a0z) + (r1z * a1x - r1x * a1z) + (r2z * a2x - r2x * a2z);
    let oz = (r0x * a0y - r0y * a0x) + (r1x * a1y - r1y * a1x) + (r2x * a2y - r2y * a2x);
    const den = Math.abs(r0x * a0x + r0y * a0y + r0z * a0z + r1x * a1x + r1y * a1y + r1z * a1z + r2x * a2x + r2y * a2y + r2z * a2z) + 1e-9;
    ox /= den; oy /= den; oz /= den;
    const w = Math.hypot(ox, oy, oz);
    if (w < 1e-9) break;
    const s = Math.sin(w * 0.5) / w;
    const dq = [ox * s, oy * s, oz * s, Math.cos(w * 0.5)];
    const nq = new Float64Array(4);
    qMul(dq, 0, q, 0, nq, 0);
    q[0] = nq[0]; q[1] = nq[1]; q[2] = nq[2]; q[3] = nq[3];
    qNormalize(q, 0);
  }
}
