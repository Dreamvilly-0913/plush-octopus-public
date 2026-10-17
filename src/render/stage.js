import * as THREE from 'three';

// Full-screen paper-grey backdrop (no visible floor; only its shadows are drawn)
export function createBackdrop() {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uInner: { value: new THREE.Color('#e4e0dc') },
      uOuter: { value: new THREE.Color('#dad6d2') },
      uAspect: { value: 1.6 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4( position.xy, 0.9999, 1.0 ); }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uInner;
      uniform vec3 uOuter;
      uniform float uAspect;
      varying vec2 vUv;
      void main() {
        vec2 p = vUv - vec2( 0.5, 0.64 );
        p.x *= uAspect * 0.62;
        float d = length( p );
        float t = smoothstep( 0.08, 0.95, d );
        vec3 col = mix( uInner, uOuter, t );
        float n = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
        col += ( n - 0.5 ) / 400.0;
        gl_FragColor = vec4( col, 1.0 );
        #include <colorspace_fragment>
      }
    `,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;
  mesh.name = 'backdrop';
  return mesh;
}

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`;

const BLUR_FRAG = /* glsl */ `
  uniform sampler2D uTex;
  uniform vec2 uDir;
  uniform float uSigma;
  varying vec2 vUv;
  void main() {
    vec4 acc = vec4( 0.0 );
    float wsum = 0.0;
    for ( int i = -12; i <= 12; i ++ ) {
      float x = float( i );
      float w = exp( - x * x / ( 2.0 * uSigma * uSigma / 9.0 ) );
      acc += texture2D( uTex, vUv + uDir * x * ( uSigma / 3.0 ) ) * w;
      wsum += w;
    }
    gl_FragColor = acc / wsum;
  }
`;

// Soft shadows on the invisible table:
//  - an occlusion map rendered from the key light, blurred twice (sharp + wide) and mixed by the
//    average occluder height, so contact shadows stay crisp while a lifted octopus casts a soft blob
//  - a contact/ambient term rendered from directly below
export class FloorShadows {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.scene = scene;
    this.size = 512;
    this.extent = 8;
    const rtOpts = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true };
    const mk = () => new THREE.WebGLRenderTarget(this.size, this.size, rtOpts);
    this.rtOcc = mk();
    this.rtTmp = mk();
    this.rtHard = mk();
    this.rtSoft = mk();
    this.rtAO = mk();
    this.rtAOBlur = mk();

    const e = this.extent / 2;
    this.lightCam = new THREE.OrthographicCamera(-e, e, e, -e, 0.1, 60);
    this.lightCam.layers.set(1);
    this.topCam = new THREE.OrthographicCamera(-e, e, e, -e, 0.0, 3.5);
    this.topCam.layers.set(1);

    this.occMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        varying float vH;
        void main() {
          vec4 w = modelMatrix * vec4( position, 1.0 );
          vH = w.y;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vH;
        void main() { gl_FragColor = vec4( 1.0, vH, 0.0, 1.0 ); }
      `,
      side: THREE.DoubleSide,
    });
    this.aoMat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        varying float vH;
        void main() {
          vec4 w = modelMatrix * vec4( position, 1.0 );
          vH = w.y;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vH;
        void main() {
          float a = 1.0 - smoothstep( 0.0, 0.75, vH );
          gl_FragColor = vec4( a * a, 0.0, 0.0, 1.0 );
        }
      `,
      side: THREE.DoubleSide,
    });

    this.blurMat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: null }, uDir: { value: new THREE.Vector2() }, uSigma: { value: 2 } },
      vertexShader: QUAD_VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.quadScene = new THREE.Scene();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blurMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this.floorMat = new THREE.ShaderMaterial({
      uniforms: {
        uLightMat: { value: new THREE.Matrix4() },
        uTopMat: { value: new THREE.Matrix4() },
        uHard: { value: this.rtHard.texture },
        uSoft: { value: this.rtSoft.texture },
        uAO: { value: this.rtAOBlur.texture },
        uColor: { value: new THREE.Color('#4a3631') },
        uShadow: { value: 0.42 },
        uAOStrength: { value: 0.78 },
      },
      vertexShader: /* glsl */ `
        varying vec3 vW;
        void main() {
          vec4 w = modelMatrix * vec4( position, 1.0 );
          vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform mat4 uLightMat;
        uniform mat4 uTopMat;
        uniform sampler2D uHard;
        uniform sampler2D uSoft;
        uniform sampler2D uAO;
        uniform vec3 uColor;
        uniform float uShadow;
        uniform float uAOStrength;
        varying vec3 vW;
        float edgeFade( vec2 uv ) {
          vec2 e = smoothstep( 0.0, 0.12, uv ) * smoothstep( 1.0, 0.88, uv );
          return e.x * e.y;
        }
        void main() {
          vec4 lp = uLightMat * vec4( vW, 1.0 );
          vec2 luv = lp.xy / lp.w * 0.5 + 0.5;
          vec4 hard = texture2D( uHard, luv );
          vec4 soft = texture2D( uSoft, luv );
          float hAvg = soft.g / max( soft.r, 1e-3 );
          float pen = smoothstep( 0.18, 1.5, hAvg );
          float sh = mix( hard.r, soft.r * 0.9, pen ) * mix( 1.0, 0.7, pen );
          sh *= edgeFade( luv );
          vec4 tp = uTopMat * vec4( vW, 1.0 );
          vec2 tuv = tp.xy / tp.w * 0.5 + 0.5;
          float ao = texture2D( uAO, tuv ).r * edgeFade( tuv );
          float a = 1.0 - ( 1.0 - sh * uShadow ) * ( 1.0 - ao * uAOStrength );
          gl_FragColor = vec4( uColor, a );
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), this.floorMat);
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = 0.0005;
    this.floor.renderOrder = -50;
    this.floor.name = 'floor';
    scene.add(this.floor);
  }

  _blur(src, dst, sigma) {
    const r = this.renderer;
    this.blurMat.uniforms.uTex.value = src.texture;
    this.blurMat.uniforms.uSigma.value = sigma;
    this.blurMat.uniforms.uDir.value.set(1 / this.size, 0);
    r.setRenderTarget(this.rtTmp);
    r.render(this.quadScene, this.quadCam);
    this.blurMat.uniforms.uTex.value = this.rtTmp.texture;
    this.blurMat.uniforms.uDir.value.set(0, 1 / this.size);
    r.setRenderTarget(dst);
    r.render(this.quadScene, this.quadCam);
  }

  render(focus, lightDir) {
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    const prevOverride = this.scene.overrideMaterial;
    const prevShadow = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    r.setClearColor(0x000000, 0);

    // light view, centred on the octopus footprint
    const c = new THREE.Vector3(focus.x, 0.4, focus.z);
    this.lightCam.position.copy(c).addScaledVector(lightDir, -20);
    this.lightCam.up.set(0, 0, -1);
    this.lightCam.lookAt(c);
    this.lightCam.updateMatrixWorld();
    this.scene.overrideMaterial = this.occMat;
    r.setRenderTarget(this.rtOcc);
    r.clear();
    r.render(this.scene, this.lightCam);

    // from below for the contact term
    this.topCam.position.set(focus.x, -0.02, focus.z);
    this.topCam.up.set(0, 0, -1);
    this.topCam.lookAt(focus.x, 1, focus.z);
    this.topCam.updateMatrixWorld();
    this.scene.overrideMaterial = this.aoMat;
    r.setRenderTarget(this.rtAO);
    r.clear();
    r.render(this.scene, this.topCam);
    this.scene.overrideMaterial = prevOverride;

    this._blur(this.rtOcc, this.rtHard, 1.6);
    this._blur(this.rtOcc, this.rtSoft, 13);
    this._blur(this.rtAO, this.rtAOBlur, 5.5);

    const U = this.floorMat.uniforms;
    U.uLightMat.value.multiplyMatrices(this.lightCam.projectionMatrix, this.lightCam.matrixWorldInverse);
    U.uTopMat.value.multiplyMatrices(this.topCam.projectionMatrix, this.topCam.matrixWorldInverse);

    r.setRenderTarget(prevTarget);
    r.setClearColor(prevClear, prevAlpha);
    r.shadowMap.autoUpdate = prevShadow;
  }
}

// A plain fingertip that hangs from above the frame
export class Finger {
  constructor(scene) {
    const pts = [];
    const R = 0.13;
    for (let i = 0; i <= 12; i++) {
      const a = (i / 12) * Math.PI * 0.5;
      pts.push(new THREE.Vector2(Math.sin(a) * R, R - Math.cos(a) * R));
    }
    pts.push(new THREE.Vector2(0.138, 0.45));
    pts.push(new THREE.Vector2(0.146, 1.1));
    pts.push(new THREE.Vector2(0.152, 2.4));
    pts.push(new THREE.Vector2(0.156, 9));
    const geo = new THREE.LatheGeometry(pts, 48);
    const mat = new THREE.MeshPhysicalMaterial({
      color: '#f0ad8a',
      roughness: 0.52,
      metalness: 0,
      sheen: 0.6,
      sheenColor: new THREE.Color('#ffd7c2'),
      sheenRoughness: 0.5,
      clearcoat: 0.12,
      clearcoatRoughness: 0.45,
      envMapIntensity: 0.6,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.layers.enable(1);
    this.mesh.visible = false;
    this.mesh.name = 'finger';
    scene.add(this.mesh);
  }

  update(sim, visible) {
    this.mesh.visible = visible;
    if (!visible) return;
    const t = sim.finger.tip;
    this.mesh.position.set(t[0], t[1], t[2]);
  }
}
