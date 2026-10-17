import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { OctopusSim } from './sim/octopusSim.js';
import { OctopusView } from './render/octopusView.js';
import { createBackdrop, FloorShadows, Finger } from './render/stage.js';
import { CameraRig } from './cameraRig.js';
import { Interaction } from './interaction.js';
import { bindUI } from './ui.js';

const KEY_OFFSET = new THREE.Vector3(-3.3, 7.0, 1.7);

export class App {
  constructor(canvas) {
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setClearColor('#e0dcd8', 1);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    this.scene = scene;
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.42;

    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
    this.rig = new CameraRig(this.camera);

    this.backdrop = createBackdrop();
    scene.add(this.backdrop);

    // lights: warm key from the upper left (casts the shadow down and to the right), soft sky, cool fill
    const key = new THREE.DirectionalLight('#fff4ea', 2.9);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -3.2; key.shadow.camera.right = 3.2;
    key.shadow.camera.top = 3.2; key.shadow.camera.bottom = -3.2;
    key.shadow.camera.near = 1; key.shadow.camera.far = 25;
    key.shadow.radius = 2.5;
    key.shadow.bias = -0.0006;
    key.shadow.normalBias = 0.025;
    scene.add(key, key.target);
    this.key = key;
    const hemi = new THREE.HemisphereLight('#fffaf4', '#c9bfb6', 0.85);
    scene.add(hemi);
    const fill = new THREE.DirectionalLight('#eef1ff', 0.55);
    fill.position.set(5, 2.5, 4);
    scene.add(fill);

    this.sim = new OctopusSim();
    this.view = new OctopusView(this.sim, scene);
    for (const m of [this.view.body, this.view.arms, ...this.view.eyes.map((e) => e.mesh)]) m.layers.enable(1);
    this.finger = new Finger(scene);
    this.floor = new FloorShadows(renderer, scene);

    this.tool = 'hand';
    this.interaction = new Interaction({
      canvas,
      camera: this.camera,
      sim: this.sim,
      view: this.view,
      rig: this.rig,
      setCursor: (c) => { document.body.dataset.cursor = c; },
    });
    this.ui = bindUI(this);

    this._lightDir = new THREE.Vector3();
    this._focus = new THREE.Vector3();
    this.timer = new THREE.Timer();
    this.timer.connect(document);
    this.frames = 0;
    window.addEventListener('resize', () => this.resize());
    this.resize();
    renderer.setAnimationLoop(() => this.frame());
    window.__app = this; // handy for inspection in the console
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // narrow / portrait windows use a bottom-sheet panel (see style.css)
    const narrow = w < 760 || w / h < 0.9;
    document.body.classList.toggle('narrow', narrow);
    this.camera.updateProjectionMatrix();
    this.backdrop.material.uniforms.uAspect.value = w / h;
    // overlay scale: the layout was measured on a 2560 x 1314 recording and scales with the window
    // (small type has its own minimum size in the CSS)
    const u = narrow
      ? Math.max(0.62, Math.min(0.9, w / 520))
      : Math.max(0.36, Math.min(1.3, Math.min(w / 2560, h / 1314)));
    document.documentElement.style.setProperty('--u', `${u.toFixed(4)}px`);
  }

  setTool(tool) {
    if (tool === this.tool) return;
    const wasClose = this.tool === 'comb';
    this.tool = tool;
    this.interaction.setTool(tool);
    const close = tool === 'comb';
    if (close !== wasClose) this.rig.goTo(close ? 'close' : 'wide', close ? 0.6 : 1.0);
    else this.rig.goTo(close ? 'close' : 'wide', 0.8);
    this.view.setShells(close ? 32 : 20);
  }

  setFur(name) { this.view.setFur(name); }

  action(name) {
    const sim = this.sim;
    if (name === 'shake') {
      const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
      right.y = 0; right.normalize();
      sim.shakeIt([right.x, 0, right.z]);
    } else if (name === 'squish') sim.squishIt();
    else if (name === 'toss') sim.toss();
    else if (name === 'smooth') this.view.smoothFur();
    else if (name === 'reset') {
      sim.reset();
      this.view.smoothFur();
      this.rig.goTo(this.tool === 'comb' ? 'close' : 'wide', 0.8);
    }
  }

  frame() {
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 1 / 20);
    this.interaction.update(dt);
    this.sim.step(dt);
    this.view.update();
    this.finger.update(this.sim, this.tool === 'finger' && this.sim.finger.active);
    this.rig.update(dt, this.camera.aspect);

    // key light and its shadow frustum follow the octopus around the table
    const c = this.sim.headC;
    this._focus.set(c[0], 0, c[2]);
    this.key.target.position.set(c[0], 0.5, c[2]);
    this.key.position.copy(this.key.target.position).add(KEY_OFFSET);
    this.key.target.updateMatrixWorld();
    this._lightDir.copy(this.key.target.position).sub(this.key.position).normalize();
    this.floor.render(this._focus, this._lightDir);

    this.renderer.render(this.scene, this.camera);
    this.ui.tick(performance.now());
    this.frames++;
  }
}
