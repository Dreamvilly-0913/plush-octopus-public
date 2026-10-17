import * as THREE from 'three';

// Velvet / minky material with shell fur.
// The same physical material is used for the solid base layer (shell 0, casts shadows) and for the
// instanced shells. Strands are placed with a jittered 3D hash in the rest-space coordinate `aRest`,
// so they never swim when the soft body deforms and there are no UV seams or pole pinches.

const COMMON_VERT = /* glsl */ `
attribute vec3 aRest;
attribute float aUnder;
attribute vec3 aTan;
attribute vec3 aBit;
#ifdef FUR_SHELL
attribute float aShell;
#endif
uniform sampler2D uFlow;
uniform float uFurLen;
uniform float uShellCount;
varying vec3 vRest;
varying float vUnder;
varying float vShellH;
varying float vNap;
varying vec3 vWorldPos;
`;

const DISPLACE = /* glsl */ `
vec3 transformed = vec3( position );
#ifdef FUR_SHELL
  float sh = ( aShell + 1.0 ) / uShellCount;
#else
  float sh = 0.0;
#endif
vec4 flow = textureLod( uFlow, uv, 0.0 );
vec2 lean = flow.rg * 2.0 - 1.0;
float leanLen = clamp( length( lean ), 0.0, 1.0 );
vec3 tA = normalize( aTan );
vec3 tB = normalize( aBit );
vec3 leanDir = tA * lean.x + tB * lean.y;
transformed += objectNormal * ( sh * uFurLen * ( 0.62 - 0.4 * leanLen ) );
transformed += leanDir * ( pow( sh, 1.35 ) * uFurLen * 0.95 );
transformed.y -= sh * sh * uFurLen * 0.1;
vShellH = sh;
vRest = aRest;
vUnder = aUnder;
vNap = flow.b * 2.0 - 1.0;
vWorldPos = transformed;
`;

const COMMON_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uUnder;
uniform vec3 uBlush;
uniform float uStrandDensity;
uniform vec3 uCheekL;
uniform vec3 uCheekR;
uniform vec3 uMouthC;
uniform vec3 uMouthX;
uniform vec3 uMouthY;
uniform vec3 uHeadC;
uniform float uHeadR;
varying vec3 vRest;
varying float vUnder;
varying float vShellH;
varying float vNap;
varying vec3 vWorldPos;

vec3 furHash33( vec3 p ) {
  p = fract( p * vec3( 0.1031, 0.1030, 0.0973 ) );
  p += dot( p, p.yxz + 33.33 );
  return fract( ( p.xxy + p.yxx ) * p.zyx );
}

float strandMask( vec3 P, float h ) {
  float hit = 0.0;
  for ( int g = 0; g < 2; g ++ ) {
    vec3 Q = P + float( g ) * vec3( 0.5, 0.37, 0.71 );
    vec3 cell = floor( Q );
    vec3 f = fract( Q );
    vec3 rnd = furHash33( cell + float( g ) * 19.19 );
    vec3 c = 0.22 + 0.56 * rnd;
    float len = 0.5 + 0.5 * fract( rnd.x * 7.31 + rnd.z * 3.17 );
    float rad = 0.56 * ( 1.0 - h / len );
    float d = length( f - c );
    hit = max( hit, step( h, len ) * step( d, rad ) );
  }
  return hit;
}

vec3 faceAlbedo( vec3 base, vec3 P ) {
  // cheeks
  vec3 dl = P - uCheekL;
  vec3 dr = P - uCheekR;
  float b = exp( - dot( dl, dl ) / 0.0068 ) + exp( - dot( dr, dr ) / 0.0068 );
  base = mix( base, uBlush, clamp( b, 0.0, 1.0 ) * 0.62 );
  // stitched "w" smile
  vec3 dm = P - uMouthC;
  float mx = abs( dot( dm, uMouthX ) );
  float my = dot( dm, uMouthY );
  if ( dot( dm, cross( uMouthX, uMouthY ) ) > -0.08 && mx < 0.12 ) {
    // one soft smile arc, stitched in dark thread
    vec2 q = vec2( mx, my - 0.058 );
    float arc = abs( length( q ) - 0.078 );
    float lower = 1.0 - smoothstep( -0.04, -0.02, q.y );
    float line = ( 1.0 - smoothstep( 0.0075, 0.0125, arc ) ) * lower;
    base = mix( base, vec3( 0.03, 0.012, 0.01 ), line );
  }
  // seam over the crown and down the back (never across the face)
  float seamZone = step( P.z, 0.32 ) * step( 0.45, P.y ) + step( P.z, -0.02 ) * step( -0.3, P.y );
  float seam = ( 1.0 - smoothstep( 0.003, 0.009, abs( P.x ) ) ) * clamp( seamZone, 0.0, 1.0 );
  base *= 1.0 - 0.22 * seam;
  return base;
}
`;

const ALBEDO = /* glsl */ `
vec3 albedo = mix( uTop, uUnder, vUnder );
#ifdef FUR_BODY
  albedo = faceAlbedo( albedo, vRest );
#endif
#ifdef FUR_SHELL
  if ( strandMask( vRest * uStrandDensity, vShellH ) < 0.5 ) discard;
#endif
// nap: pile combed against the grain stands up and reads darker; with the grain it shines
float nap = clamp( vNap, -1.0, 1.0 );
albedo *= nap < 0.0 ? 1.0 + 0.46 * nap * ( 0.55 + 0.45 * vShellH ) : 1.0 + 0.2 * nap * vShellH;
// depth in the pile + cheap occlusion near the head and the table; fibre tips catch light (frosted)
float pileAO = mix( 0.5, 1.02, pow( vShellH, 0.7 ) );
albedo = mix( albedo, vec3( 1.0 ), 0.14 * vShellH * vShellH );
float floorAO = mix( 0.62, 1.0, smoothstep( 0.0, 0.22, vWorldPos.y ) );
float headAO = 1.0;
#ifndef FUR_BODY
  float dh = length( vWorldPos - uHeadC ) - uHeadR;
  headAO = mix( 0.66, 1.0, smoothstep( 0.0, 0.35, dh ) );
#endif
vec4 diffuseColor = vec4( albedo * pileAO * floorAO * headAO, opacity );
`;

export function createFurMaterials({ flowMap, body, colors }) {
  const uniforms = {
    uFlow: { value: flowMap },
    uFurLen: { value: 0.045 },
    uShellCount: { value: 18 },
    uTop: { value: new THREE.Color(colors.top) },
    uUnder: { value: new THREE.Color(colors.under) },
    uBlush: { value: new THREE.Color(colors.blush) },
    uStrandDensity: { value: 100 },
    uCheekL: { value: new THREE.Vector3() },
    uCheekR: { value: new THREE.Vector3() },
    uMouthC: { value: new THREE.Vector3() },
    uMouthX: { value: new THREE.Vector3(1, 0, 0) },
    uMouthY: { value: new THREE.Vector3(0, 1, 0) },
    uHeadC: { value: new THREE.Vector3(0, 0.7, 0) },
    uHeadR: { value: 0.6 },
  };

  const make = (shell) => {
    const m = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0,
      sheen: 0.55,
      sheenRoughness: 0.5,
      sheenColor: new THREE.Color(colors.sheen),
      envMapIntensity: 0.5,
    });
    materials.push(m);
    m.defines = m.defines || {};
    if (shell) m.defines.FUR_SHELL = '';
    if (body) m.defines.FUR_BODY = '';
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + COMMON_VERT)
        .replace('#include <begin_vertex>', DISPLACE);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + COMMON_FRAG)
        .replace('vec4 diffuseColor = vec4( diffuse, opacity );', ALBEDO);
    };
    m.customProgramCacheKey = () => `fur-${shell ? 's' : 'b'}-${body ? 'body' : 'arm'}`;
    return m;
  };

  const materials = [];
  const base = make(false);
  const shell = make(true);
  return { base, shell, uniforms, materials };
}

export function setFurColors(mats, colors) {
  const u = mats.uniforms;
  u.uTop.value.set(colors.top);
  u.uUnder.value.set(colors.under);
  u.uBlush.value.set(colors.blush);
  for (const m of mats.materials) m.sheenColor.set(colors.sheen);
}

// Shell geometry that shares every attribute with the base geometry and adds an instanced shell index.
// It is built once for the maximum count; fewer shells are drawn by lowering instanceCount (never
// dispose it: the GPU buffers are shared with the base mesh).
export function makeShellGeometry(baseGeom, maxShells) {
  const g = new THREE.InstancedBufferGeometry();
  g.index = baseGeom.index;
  for (const name of Object.keys(baseGeom.attributes)) g.setAttribute(name, baseGeom.attributes[name]);
  const idx = new Float32Array(maxShells);
  for (let i = 0; i < maxShells; i++) idx[i] = i;
  g.setAttribute('aShell', new THREE.InstancedBufferAttribute(idx, 1));
  g.instanceCount = maxShells;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60);
  return g;
}
