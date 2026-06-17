/**
 * Cinematic 3D particle transition for Gaussian-splat scenes.
 * Physics faithfully adapted from Godot's GPU particle disintegration shader.
 *
 * DISINTEGRATE
 *   A `progress` value tweens 0→1 over DIS_SWEEP_FRAMES.
 *   Each particle has a noise-hash threshold; it activates the frame progress
 *   crosses that threshold — producing the organic "crack" scatter pattern.
 *   Once active the particle gets a one-time velocity kick (random direction
 *   within a spread cone from the centroid), then every frame accumulates:
 *     force = gravity
 *           + normalize(vel)  * linear_accel   (push along direction of travel)
 *           + normalize(diff) * radial_accel   (push outward from centroid)
 *           + perpendicular   * tangent_accel  (swirl / spin)
 *     vel += force
 *     speed = |vel|;  speed -= damping;  vel = normalize(vel) * max(0, speed)
 *   Each particle also has a per-particle lifetime fraction (slight random
 *   variation).  After that lifetime the colour fades to zero (particle gone).
 *   Un-activated particles stay at their scene positions in full colour —
 *   the shape holds together while pieces scatter from it.
 *
 * CONSTRUCT
 *   Particles begin from wherever they ended after disassemble (already spread
 *   in 3D — no sphere blob).  Activation is staggered so edge particles of the
 *   new scene arrive first (outline forms before the interior fills).
 *   Each particle follows an ease-out cubic path toward its target with a small
 *   sine-envelope noise detour for organic curvature.  Colour transitions from
 *   dim electric-blue to true scene colour as the particle locks in.
 */

import * as THREE from "three";

const MAX_PARTICLES = 100_000;
const PARTICLE_CAP  = 28_000;   // hard cap on rendered particles — prevents additive blowout

// ── Disintegration (Godot shader physics) ─────────────────────────────────────
const DIS_SWEEP_FRAMES   = 85;   // frames over which progress 0→1 sweeps (~1.4 s)
const DIS_TOTAL_FRAMES   = 160;  // total animation length including particle lifetimes (~2.7 s)
const DIS_LIFETIME_FRAC  = 0.60; // each particle lives DIS_TOTAL * 0.60 frames after activation
const DIS_VEL_MIN        = 0.022;
const DIS_VEL_MAX        = 0.068;
const DIS_LINEAR_ACCEL   = 0.0045; // Godot: push along velocity direction
const DIS_RADIAL_ACCEL   = 0.0035; // Godot: push outward from emitter origin (centroid)
const DIS_TANGENT_ACCEL  = 0.0028; // Godot: perpendicular spin / swirl
const DIS_GRAVITY        = 0.00035;
const DIS_DAMPING        = 0.0018; // Godot: linear speed reduction per frame (not exponential)

// ── Construction ──────────────────────────────────────────────────────────────
const CON_TOTAL_FRAMES = 145;   // ~2.4 s
const CON_DELAY_MAX    = 55;    // edge particles: delay 0; centre: up to 55 frames
const CON_NOISE_AMP    = 0.10;  // path-curve amplitude (fraction of scene radius)

// ── Helpers ───────────────────────────────────────────────────────────────────

// Godot hash — deterministic per-particle randomness
function godotHash(x) {
  x = x >>> 0;
  x = (((x >> 16) ^ x) * 0x45d9f3b) >>> 0;
  x = (((x >> 16) ^ x) * 0x45d9f3b) >>> 0;
  x = ((x >> 16) ^ x) >>> 0;
  return x / 0xFFFFFFFF;
}

// Seeded LCG matching Godot's rand_from_seed
function lcgSeed(s) {
  s = s | 0;
  if (s === 0) s = 305420679;
  const k = (s / 127773) | 0;
  s = (16807 * (s - k * 127773) - 2836 * k) | 0;
  if (s < 0) s += 2147483647;
  return [s, ((s >>> 0) % 65536) / 65535];
}

function rand(seedRef) {
  const [ns, v] = lcgSeed(seedRef[0]);
  seedRef[0] = ns;
  return v;
}

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

// Soft glow sprite — sharp bright core, wide diffuse halo
function makeGlowTexture() {
  const sz = 64, cvs = document.createElement("canvas");
  cvs.width = cvs.height = sz;
  const ctx = cvs.getContext("2d"), h = sz / 2;
  const g = ctx.createRadialGradient(h, h, 0, h, h, h);
  g.addColorStop(0,    "rgba(255,255,255,1)");
  g.addColorStop(0.08, "rgba(240,248,255,0.95)");
  g.addColorStop(0.22, "rgba(180,215,255,0.60)");
  g.addColorStop(0.50, "rgba(100,160,255,0.18)");
  g.addColorStop(1,    "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, sz, sz);
  return new THREE.CanvasTexture(cvs);
}

// ── ParticleStage ─────────────────────────────────────────────────────────────
export class ParticleStage {
  constructor() {
    this._canvas = document.createElement("canvas");
    Object.assign(this._canvas.style, {
      position: "fixed", inset: "0",
      width: "100vw", height: "100vh",
      zIndex: "10", pointerEvents: "none",
      opacity: "0",
    });
    document.body.appendChild(this._canvas);

    this._renderer = new THREE.WebGLRenderer({
      canvas: this._canvas, alpha: true,
      antialias: false, powerPreference: "high-performance",
    });
    this._renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this._renderer.setClearColor(0x000000, 0);

    this._scene = new THREE.Scene();
    this._cam   = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 100);
    this._cam.up.set(0, -1, 0);
    this._cam.position.set(0, 0, -3);
    this._cam.lookAt(0, 0, 1);

    this._geo  = new THREE.BufferGeometry();
    this._posA = new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
    this._colA = new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
    this._posA.setUsage(THREE.DynamicDrawUsage);
    this._colA.setUsage(THREE.DynamicDrawUsage);
    this._geo.setAttribute("position", this._posA);
    this._geo.setAttribute("color",    this._colA);
    this._geo.setDrawRange(0, 0);

    this._mat = new THREE.PointsMaterial({
      size: 0.028,
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
      map: makeGlowTexture(),
      alphaTest: 0.001,
    });
    this._scene.add(new THREE.Points(this._geo, this._mat));

    // Pre-allocated working buffers
    this._vel      = new Float32Array(MAX_PARTICLES * 3);
    this._startPos = new Float32Array(MAX_PARTICLES * 3);
    this._thresh   = new Float32Array(MAX_PARTICLES);
    this._actFrame = new Int32Array(MAX_PARTICLES).fill(-1);  // frame activated (-1 = not yet)
    this._lifeLen  = new Float32Array(MAX_PARTICLES);         // individual lifetime in frames
    this._delay    = new Int32Array(MAX_PARTICLES);

    this._count      = 0;
    this._targetPos  = null;
    this._targetCol  = null;
    this._hasScatter = false;  // true after first disassemble has run
    this._pendingPos = null;   // PLY data loaded async, consumed by next construct
    this._pendingCol = null;
    this._pendingCnt = 0;
    this._active     = false;
    this._raf        = null;

    window.addEventListener("resize", () => this._resize());
    this._resize();
    this._loop();
  }

  _resize() {
    this._renderer.setSize(innerWidth, innerHeight);
    this._cam.aspect = innerWidth / innerHeight;
    this._cam.updateProjectionMatrix();
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    if (this._active) this._renderer.render(this._scene, this._cam);
  }

  // ── Visibility ───────────────────────────────────────────────────────────────

  // Instant reveal — no CSS transition. Used when particles need to cover
  // the Gaussian viewer before the overlay lifts.
  showInstant() {
    console.log("[showInstant] count=" + this._count);
    this._active = true;
    this._canvas.style.transition = "none";
    this._canvas.style.opacity = "1";
    // Restore positions/colours from last construct so the old scene
    // is visible as a particle cloud when the overlay lifts.
    if (this._count > 0 && this._targetPos) {
      const n = this._count;
      const pos = this._posA.array, col = this._colA.array;
      for (let i = 0; i < n; i++) {
        pos[i*3]   = this._targetPos[i*3];
        pos[i*3+1] = this._targetPos[i*3+1];
        pos[i*3+2] = this._targetPos[i*3+2];
        col[i*3]   = this._targetCol[i*3];
        col[i*3+1] = this._targetCol[i*3+1];
        col[i*3+2] = this._targetCol[i*3+2];
      }
      this._geo.setDrawRange(0, n);
      this._posA.needsUpdate = true;
      this._colA.needsUpdate = true;
    }
  }

  hide() {
    return new Promise(resolve => {
      this._canvas.style.transition = "opacity 0.5s ease";
      this._canvas.style.opacity = "0";
      setTimeout(() => { this._active = false; resolve(); }, 530);
    });
  }

  // Store parsed PLY data so the NEXT construct() call uses real scene positions.
  cacheTarget(positions, colors, count) {
    this._pendingPos = positions;
    this._pendingCol = colors;
    this._pendingCnt = Math.min(count, PARTICLE_CAP);
  }

  // ── Disintegration ────────────────────────────────────────────────────────────
  // Faithfully implements the Godot crack shader physics in 3D.
  disassemble() {
    console.log("[disassemble] count=" + this._count + " hasTarget=" + !!this._targetPos);
    if (!this._count || !this._targetPos) return Promise.resolve();

    const n       = this._count;
    const pos     = this._posA.array;
    const col     = this._colA.array;
    const vel     = this._vel;
    const thresh  = this._thresh;
    const actF    = this._actFrame;
    const lifeLen = this._lifeLen;
    const tPos    = this._targetPos;
    const tCol    = this._targetCol;

    // Restore to resting scene positions
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      pos[i3]   = tPos[i3];   pos[i3+1] = tPos[i3+1]; pos[i3+2] = tPos[i3+2];
      col[i3]   = tCol[i3];   col[i3+1] = tCol[i3+1]; col[i3+2] = tCol[i3+2];
      vel[i3]   = 0;          vel[i3+1] = 0;           vel[i3+2] = 0;
      actF[i]   = -1;
      // Godot: lifetime slightly randomised per particle
      lifeLen[i] = DIS_TOTAL_FRAMES * DIS_LIFETIME_FRAC * (0.8 + godotHash(i * 29 + 7) * 0.4);
      // Crack pattern: pure noise threshold (Godot crack.gdshader)
      thresh[i] = godotHash(i * 7 + 3);
    }

    // Scene centroid — used as radial/tangential origin (Godot: velocity_pivot / EMISSION_TRANSFORM)
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += pos[i*3]; cy += pos[i*3+1]; cz += pos[i*3+2]; }
    cx /= n; cy /= n; cz /= n;

    this._geo.setDrawRange(0, n);
    this._posA.needsUpdate = true;
    this._colA.needsUpdate = true;

    return new Promise(resolve => {
      let frame = 0;

      const tick = () => {
        const progress = Math.min(frame / DIS_SWEEP_FRAMES, 1);

        for (let i = 0; i < n; i++) {
          const i3 = i * 3;

          // ── Activation (Godot: if VELOCITY == 0 and progress > threshold) ──
          if (actF[i] < 0 && progress > thresh[i]) {
            actF[i] = frame;
            // Initial velocity: random direction within spread cone from centroid
            // Godot: get_random_direction_from_spread * initial_velocity_multiplier
            const seed = [((i * 13 + 1) * 0x45d9f3b) >>> 0];
            const r1 = rand(seed), r2 = rand(seed), r3 = rand(seed);
            // Outward base direction
            const dx0 = pos[i3]-cx, dy0 = pos[i3+1]-cy, dz0 = pos[i3+2]-cz;
            const d0  = Math.sqrt(dx0*dx0 + dy0*dy0 + dz0*dz0) || 1;
            // Random spread: perturb outward direction
            const spread = 1.2; // radians half-angle (~70°)
            const rx = (r1 - 0.5) * spread, ry = (r2 - 0.5) * spread, rz = (r3 - 0.5) * spread;
            const vx = dx0/d0 + rx, vy = dy0/d0 + ry, vz = dz0/d0 + rz;
            const vl = Math.sqrt(vx*vx + vy*vy + vz*vz) || 1;
            const mag = DIS_VEL_MIN + godotHash(i * 17 + 5) * (DIS_VEL_MAX - DIS_VEL_MIN);
            vel[i3]   = (vx/vl) * mag;
            vel[i3+1] = (vy/vl) * mag;
            vel[i3+2] = (vz/vl) * mag;
          }

          if (actF[i] < 0) continue; // not yet activated — stays at scene position

          const localT = (frame - actF[i]) / lifeLen[i]; // 0→1 over particle lifetime

          if (localT >= 1.0) {
            // Godot: ACTIVE = false — particle gone, colour to zero
            col[i3] = col[i3+1] = col[i3+2] = 0;
            continue;
          }

          // ── Godot physics forces ──────────────────────────────────────────
          const diff_x = pos[i3]-cx, diff_y = pos[i3+1]-cy, diff_z = pos[i3+2]-cz;
          const diff_d = Math.sqrt(diff_x*diff_x + diff_y*diff_y + diff_z*diff_z) || 1;

          const spd = Math.sqrt(vel[i3]*vel[i3] + vel[i3+1]*vel[i3+1] + vel[i3+2]*vel[i3+2]);

          let fx = 0, fy = DIS_GRAVITY, fz = 0;   // gravity (Godot: gravity vec3)

          // linear_accel: along velocity direction (Godot: normalize(VELOCITY)*linear_accel)
          if (spd > 0.0001) {
            fx += (vel[i3]   / spd) * DIS_LINEAR_ACCEL;
            fy += (vel[i3+1] / spd) * DIS_LINEAR_ACCEL;
            fz += (vel[i3+2] / spd) * DIS_LINEAR_ACCEL;
          }

          // radial_accel: outward from centroid (Godot: normalize(pos-org)*radial_accel)
          fx += (diff_x / diff_d) * DIS_RADIAL_ACCEL;
          fy += (diff_y / diff_d) * DIS_RADIAL_ACCEL;
          fz += (diff_z / diff_d) * DIS_RADIAL_ACCEL;

          // tangent_accel: perpendicular in the horizontal XZ plane
          // Godot: normalize(diff.yx * vec2(-1,1)) * tangent_accel
          // In 3D: use XZ plane perpendicular
          const txzLen = Math.sqrt(diff_z*diff_z + diff_x*diff_x) || 1;
          const swSign = godotHash(i * 23 + 9) > 0.5 ? 1 : -1;
          fx += swSign * (-diff_z / txzLen) * DIS_TANGENT_ACCEL;
          fz += swSign * ( diff_x / txzLen) * DIS_TANGENT_ACCEL;

          vel[i3]   += fx;
          vel[i3+1] += fy;
          vel[i3+2] += fz;

          // ── Linear damping (Godot: v -= damping * delta) ─────────────────
          const newSpd = Math.sqrt(vel[i3]*vel[i3] + vel[i3+1]*vel[i3+1] + vel[i3+2]*vel[i3+2]);
          if (newSpd > DIS_DAMPING) {
            const s = (newSpd - DIS_DAMPING) / newSpd;
            vel[i3] *= s; vel[i3+1] *= s; vel[i3+2] *= s;
          } else {
            vel[i3] = vel[i3+1] = vel[i3+2] = 0;
          }

          pos[i3]   += vel[i3];
          pos[i3+1] += vel[i3+1];
          pos[i3+2] += vel[i3+2];

          // ── Colour: scene → electric blue-white → black ──────────────────
          // Phase 1 (0→0.35 lifetime): bleach toward blue-white (heating up)
          // Phase 2 (0.35→1.0 lifetime): fade to black (particle burns out)
          const BLEACH_END = 0.35;
          if (localT < BLEACH_END) {
            const b = localT / BLEACH_END;  // 0→1
            col[i3]   = tCol[i3]   * (1-b) + 0.65 * b;
            col[i3+1] = tCol[i3+1] * (1-b) + 0.80 * b;
            col[i3+2] = tCol[i3+2] * (1-b) + 1.00 * b;
          } else {
            const f = 1 - (localT - BLEACH_END) / (1 - BLEACH_END); // 1→0
            col[i3]   = 0.65 * f;
            col[i3+1] = 0.80 * f;
            col[i3+2] = 1.00 * f;
          }
        }

        this._posA.needsUpdate = true;
        this._colA.needsUpdate = true;

        frame++;
        if (frame < DIS_TOTAL_FRAMES) {
          requestAnimationFrame(tick);
        } else {
          this._hasScatter = true;
          resolve();
        }
      };

      requestAnimationFrame(tick);
    });
  }

  // ── Construction ──────────────────────────────────────────────────────────────
  // Consumes cached PLY data (from cacheTarget) if available, otherwise animates
  // a volumetric placeholder so the user ALWAYS sees something immediately.
  // Starting positions come from the disassemble scatter (hasScatter=true) or
  // a visible cloud spread within the camera frustum (first load).
  construct() {
    // Consume cached PLY data (set by background parseSplatPly call)
    let positions = this._pendingPos;
    let colors    = this._pendingCol;
    let count     = this._pendingCnt;
    this._pendingPos = null;
    this._pendingCol = null;
    this._pendingCnt = 0;

    // No real PLY data available — generate a vivid volumetric cloud as target.
    // Particles sweep from invisible space into a sphere-cloud, then the real
    // Gaussian appears underneath when the overlay fades.
    if (!positions || !count) {
      const n = PARTICLE_CAP;
      positions = new Float32Array(n * 3);
      colors    = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        // Roughly sphere-distributed, radius ~1.2 (fits the typical scene scale)
        const th = godotHash(i * 7  + 1) * Math.PI * 2;
        const ph = Math.acos(2 * godotHash(i * 7  + 2) - 1);
        const r  = 0.4 + godotHash(i * 7  + 3) * 0.8;
        positions[i*3]   = r * Math.sin(ph) * Math.cos(th);
        positions[i*3+1] = r * Math.cos(ph) * 0.6;   // flatten Y slightly
        positions[i*3+2] = r * Math.sin(ph) * Math.sin(th);
        // Bright blue-white palette for placeholder
        const t = godotHash(i * 13 + 5);
        colors[i*3]   = 0.3 + t * 0.7;
        colors[i*3+1] = 0.5 + t * 0.5;
        colors[i*3+2] = 1.0;
      }
      count = n;
    }

    const n         = Math.min(count, PARTICLE_CAP);
    this._count     = n;
    this._targetPos = positions;
    this._targetCol = colors;

    const pos      = this._posA.array;
    const col      = this._colA.array;
    const startPos = this._startPos;
    const delay    = this._delay;

    // Centroid of new scene
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) {
      cx += positions[i*3]; cy += positions[i*3+1]; cz += positions[i*3+2];
    }
    cx /= n; cy /= n; cz /= n;

    // Per-particle distance → arrival delay (edge particles arrive first)
    let maxD = 0;
    const dists = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const dx = positions[i3]-cx, dy = positions[i3+1]-cy, dz = positions[i3+2]-cz;
      dists[i] = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if (dists[i] > maxD) maxD = dists[i];
    }
    const invMaxD = maxD > 0 ? 1 / maxD : 1;
    for (let i = 0; i < n; i++) {
      delay[i] = Math.round((1 - dists[i] * invMaxD) * CON_DELAY_MAX);
    }

    // Starting positions:
    //  hasScatter=true  → use the positions left over from disassemble (already spread)
    //  hasScatter=false → spread within the visible frustum so particles are on-screen
    //                     immediately (camera at z=-3, FOV 60°, frustum ±1.7 units at z=0)
    const hasScatter = this._hasScatter;
    const FRUSTUM_R  = 1.6;  // just inside visible area
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      if (hasScatter) {
        startPos[i3]   = pos[i3];
        startPos[i3+1] = pos[i3+1];
        startPos[i3+2] = pos[i3+2];
      } else {
        // Visible spread: random positions within the frustum + small z offset
        const sx = (godotHash(i*31+1) - 0.5) * FRUSTUM_R * 2;
        const sy = (godotHash(i*31+2) - 0.5) * FRUSTUM_R;
        const sz = (godotHash(i*31+3) - 0.5) * FRUSTUM_R * 2;
        startPos[i3]   = pos[i3]   = cx + sx;
        startPos[i3+1] = pos[i3+1] = cy + sy;
        startPos[i3+2] = pos[i3+2] = cz + sz;
      }
      col[i3] = 0.15; col[i3+1] = 0.22; col[i3+2] = 0.50;
    }

    // Per-particle path-curve direction (perpendicular arc for organic motion)
    const noiseDir = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const dx = positions[i3]   - startPos[i3];
      const dz = positions[i3+2] - startPos[i3+2];
      const hl = Math.sqrt(dx*dx + dz*dz) || 1;
      const sg = godotHash(i * 41 + 11) > 0.5 ? 1 : -1;
      noiseDir[i3]   = sg * (-dz / hl);
      noiseDir[i3+1] = (godotHash(i * 41 + 13) - 0.5) * 0.6;
      noiseDir[i3+2] = sg * ( dx / hl);
    }
    const noiseAmp = Math.min((maxD || 1) * CON_NOISE_AMP, 0.20);

    this._active = true;  // ensure renderer is live
    this._geo.setDrawRange(0, n);
    this._posA.needsUpdate = true;
    this._colA.needsUpdate = true;

    console.log("[construct] n=" + n + " hasScatter=" + hasScatter + " hasPlY=" + (this._targetPos !== positions || !!positions));

    const activeFrames = CON_TOTAL_FRAMES - CON_DELAY_MAX;

    return new Promise(resolve => {
      let frame = 0;

      const tick = () => {
        for (let i = 0; i < n; i++) {
          const i3 = i * 3;
          if (frame < delay[i]) continue;

          const localT = Math.min((frame - delay[i]) / activeFrames, 1);
          const eased  = easeOutCubic(localT);
          const curve  = noiseAmp * Math.sin(Math.PI * eased);

          const tx = positions[i3],   ty = positions[i3+1],   tz = positions[i3+2];
          const sx = startPos[i3],    sy = startPos[i3+1],    sz = startPos[i3+2];

          pos[i3]   = sx + (tx-sx)*eased + noiseDir[i3]   * curve;
          pos[i3+1] = sy + (ty-sy)*eased + noiseDir[i3+1] * curve;
          pos[i3+2] = sz + (tz-sz)*eased + noiseDir[i3+2] * curve;

          col[i3]   = 0.15*(1-eased) + colors[i3]  *eased;
          col[i3+1] = 0.22*(1-eased) + colors[i3+1]*eased;
          col[i3+2] = 0.50*(1-eased) + colors[i3+2]*eased;
        }

        this._posA.needsUpdate = true;
        this._colA.needsUpdate = true;

        frame++;
        frame < CON_TOTAL_FRAMES ? requestAnimationFrame(tick) : resolve();
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
