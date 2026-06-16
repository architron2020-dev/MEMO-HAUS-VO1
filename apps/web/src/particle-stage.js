// Physics-based particle disintegration / construction for Gaussian-splat transitions.
//
// Each particle has a position, velocity, and a target. During disintegration
// the particles are given outward impulses and drift under damping. During
// construction they are pulled toward their target Gaussian position by a
// spring force, also with damping — so they overshoot slightly and settle,
// giving a natural weighted feel.

import * as THREE from "three";

const MAX_PARTICLES   = 100_000;
const DT              = 1 / 60;      // physics timestep (seconds)
const DISINT_SPRING   = 0.0;         // no spring during disintegration
const DISINT_DAMP     = 0.94;        // velocity multiplier each frame (air resistance)
const DISINT_IMPULSE  = 0.06;        // initial outward kick magnitude
const DISINT_FRAMES   = 80;          // ~1.3 s at 60 fps

const CONST_SPRING    = 0.08;        // spring constant pulling to target
const CONST_DAMP      = 0.78;        // damping (< 1 = energy loss)
const CONST_FRAMES    = 110;         // ~1.8 s at 60 fps

// Soft circular glow sprite
function glowTexture() {
  const sz = 64, cvs = document.createElement("canvas");
  cvs.width = cvs.height = sz;
  const ctx = cvs.getContext("2d"), h = sz / 2;
  const g = ctx.createRadialGradient(h, h, 0, h, h, h);
  g.addColorStop(0,    "rgba(255,255,255,1)");
  g.addColorStop(0.2,  "rgba(255,255,255,0.85)");
  g.addColorStop(0.55, "rgba(200,220,255,0.25)");
  g.addColorStop(1,    "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, sz, sz);
  return new THREE.CanvasTexture(cvs);
}

export class ParticleStage {
  constructor() {
    this._canvas = document.createElement("canvas");
    Object.assign(this._canvas.style, {
      position: "fixed", inset: "0",
      width: "100vw", height: "100vh",
      zIndex: "10", pointerEvents: "none",
      opacity: "0", transition: "opacity 0.45s ease",
    });
    document.body.appendChild(this._canvas);

    this._renderer = new THREE.WebGLRenderer({
      canvas: this._canvas, alpha: true,
      antialias: false, powerPreference: "high-performance",
    });
    this._renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this._renderer.setClearColor(0x000000, 0);

    this._scene = new THREE.Scene();

    // Camera mirrors GaussianSplats3D exactly
    this._cam = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
    this._cam.up.set(0, -1, 0);
    this._cam.position.set(0, 0, -3);
    this._cam.lookAt(0, 0, 1);

    // Geometry — pre-allocated once
    this._geo  = new THREE.BufferGeometry();
    this._posA = new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
    this._colA = new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
    this._posA.setUsage(THREE.DynamicDrawUsage);
    this._colA.setUsage(THREE.DynamicDrawUsage);
    this._geo.setAttribute("position", this._posA);
    this._geo.setAttribute("color",    this._colA);
    this._geo.setDrawRange(0, 0);

    this._mat = new THREE.PointsMaterial({
      size: 0.015,
      vertexColors: true,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
      map: glowTexture(),
      alphaTest: 0.001,
    });
    this._scene.add(new THREE.Points(this._geo, this._mat));

    // Physics buffers (velocity, reused across animations)
    this._vel = new Float32Array(MAX_PARTICLES * 3);

    // Runtime state
    this._count      = 0;
    this._targetPos  = null;   // resting Gaussian positions of current scene
    this._targetCol  = null;
    this._active     = false;
    this._raf        = null;

    window.addEventListener("resize", () => this._resize());
    this._resize();
    this._loop();
  }

  // ─── internal ────────────────────────────────────────────────────────────

  _resize() {
    this._renderer.setSize(innerWidth, innerHeight);
    this._cam.aspect = innerWidth / innerHeight;
    this._cam.updateProjectionMatrix();
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    if (this._active) this._renderer.render(this._scene, this._cam);
  }

  _centroid(pos, n) {
    let x = 0, y = 0, z = 0;
    for (let i = 0; i < n; i++) { x += pos[i*3]; y += pos[i*3+1]; z += pos[i*3+2]; }
    return [x/n, y/n, z/n];
  }

  // ─── public ──────────────────────────────────────────────────────────────

  show() {
    this._active = true;
    this._canvas.style.opacity = "1";
  }

  hide() {
    return new Promise(resolve => {
      this._canvas.style.opacity = "0";
      setTimeout(() => { this._active = false; resolve(); }, 500);
    });
  }

  // Particles explode outward from the scene centroid under an initial impulse,
  // then slow down under damping. Colour fades to black as they drift.
  disassemble() {
    if (!this._count || !this._targetPos) return Promise.resolve();

    const n   = this._count;
    const pos = this._posA.array;
    const col = this._colA.array;
    const vel = this._vel;

    // Seed positions from stored target (where particles rest after last construction)
    pos.set(this._targetPos.subarray(0, n * 3));
    col.set(this._targetCol.subarray(0, n * 3));

    const [cx, cy, cz] = this._centroid(pos, n);

    // Give each particle an outward impulse from the centroid
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      let dx = pos[i3]     - cx;
      let dy = pos[i3 + 1] - cy;
      let dz = pos[i3 + 2] - cz;
      const len = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
      // Randomise magnitude so particles reach different distances
      const mag = DISINT_IMPULSE * (0.5 + Math.random());
      vel[i3]     = (dx / len) * mag;
      vel[i3 + 1] = (dy / len) * mag;
      vel[i3 + 2] = (dz / len) * mag;
    }

    this.show();
    this._geo.setDrawRange(0, n);
    this._posA.needsUpdate = true;
    this._colA.needsUpdate = true;

    return new Promise(resolve => {
      let frame = 0;
      const tick = () => {
        const progress = frame / DISINT_FRAMES;   // 0 → 1
        const alpha    = 1 - progress;            // linear fade-out

        for (let i = 0; i < n; i++) {
          const i3 = i * 3;

          // Integrate velocity
          pos[i3]     += vel[i3];
          pos[i3 + 1] += vel[i3 + 1];
          pos[i3 + 2] += vel[i3 + 2];

          // Damping (air resistance)
          vel[i3]     *= DISINT_DAMP;
          vel[i3 + 1] *= DISINT_DAMP;
          vel[i3 + 2] *= DISINT_DAMP;

          // Fade colour toward black
          col[i3]     = this._targetCol[i3]     * alpha;
          col[i3 + 1] = this._targetCol[i3 + 1] * alpha;
          col[i3 + 2] = this._targetCol[i3 + 2] * alpha;
        }

        this._posA.needsUpdate = true;
        this._colA.needsUpdate = true;

        frame++;
        frame < DISINT_FRAMES ? requestAnimationFrame(tick) : resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  // Particles are initialised slightly scattered around their Gaussian targets
  // and pulled in by a spring force. Damping < 1 causes them to overshoot
  // slightly and settle — giving a natural weighted, bouncy arrival.
  // Colour brightens from black to true Gaussian colour as they arrive.
  construct(positions, colors, count) {
    this._count     = count;
    this._targetPos = positions;
    this._targetCol = colors;

    const pos = this._posA.array;
    const col = this._colA.array;
    const vel = this._vel;

    // Seed positions: Gaussian target + small random sphere offset
    for (let i = 0; i < count; i++) {
      const i3    = i * 3;
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      const r     = 0.3 + Math.random() * 0.9;
      pos[i3]     = positions[i3]     + r * Math.sin(phi) * Math.cos(theta);
      pos[i3 + 1] = positions[i3 + 1] + r * Math.sin(phi) * Math.sin(theta);
      pos[i3 + 2] = positions[i3 + 2] + r * Math.cos(phi);
      // Start with zero velocity and black colour
      vel[i3] = vel[i3 + 1] = vel[i3 + 2] = 0;
      col[i3] = col[i3 + 1] = col[i3 + 2] = 0;
    }

    this._geo.setDrawRange(0, count);
    this._posA.needsUpdate = true;
    this._colA.needsUpdate = true;

    return new Promise(resolve => {
      let frame = 0;
      const tick = () => {
        const progress = frame / CONST_FRAMES;

        for (let i = 0; i < count; i++) {
          const i3 = i * 3;

          // Spring force toward target
          const fx = (positions[i3]     - pos[i3])     * CONST_SPRING;
          const fy = (positions[i3 + 1] - pos[i3 + 1]) * CONST_SPRING;
          const fz = (positions[i3 + 2] - pos[i3 + 2]) * CONST_SPRING;

          vel[i3]     = (vel[i3]     + fx) * CONST_DAMP;
          vel[i3 + 1] = (vel[i3 + 1] + fy) * CONST_DAMP;
          vel[i3 + 2] = (vel[i3 + 2] + fz) * CONST_DAMP;

          pos[i3]     += vel[i3];
          pos[i3 + 1] += vel[i3 + 1];
          pos[i3 + 2] += vel[i3 + 2];

          // Colour brightens as particles arrive (use progress as alpha proxy)
          const brightness = Math.min(progress * 1.6, 1);
          col[i3]     = colors[i3]     * brightness;
          col[i3 + 1] = colors[i3 + 1] * brightness;
          col[i3 + 2] = colors[i3 + 2] * brightness;
        }

        this._posA.needsUpdate = true;
        this._colA.needsUpdate = true;

        frame++;
        frame < CONST_FRAMES ? requestAnimationFrame(tick) : resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this._renderer.dispose();
    this._geo.dispose();
    this._mat.dispose();
    this._canvas.remove();
  }
}
