import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';

/* ============================================================
   Épée Simulator — WebXR (Quest browser) + desktop test mode
   Piste runs along the Z axis. Player starts at z=+2 facing -Z,
   opponent at z=-2 facing +Z. Units are meters.

   Physics model: each blade is a rigid rod pinned at the guard.
   The hand (controller) is authoritative for the guard position
   and the *intended* direction; the physical blade direction has
   angular velocity, a grip-spring toward the intended direction,
   and leverage-weighted contact impulses against the other blade
   (contact near the tip deflects a blade far more than contact
   near the guard — forte beats foible).
   ============================================================ */

const CONFIG = {
  boutScore: 15,
  boutTime: 180,           // seconds
  lockout: 0.25,           // double-touch lockout window (s)
  resetPause: 1.6,         // pause after a touch (s)
  piste: { length: 14, width: 1.5 },

  // valid touch = swept tip crosses target AND motion is a thrust:
  touch: {
    axialSpeed: 1.0,       // min tip speed along the blade axis (m/s) — proxy for the 750g tip force
    alignment: 0.55,       // min cos(angle between tip velocity and blade axis) — kills slaps/whips
    pointFirst: 0.45,      // min cos(blade axis vs surface normal) — a turned point skids off
  },

  physics: {
    substeps: 6,
    contactRadius: 0.048,  // engagement distance — blades that look adjacent DO interact
    pressOvershoot: 1.8,   // separation factor under an active press — the carry ratchet
    idleOvershoot: 1.15,   // gentle ratchet for incidental contact
    restitution: 0.35,     // lively taps — a beat leaves the other blade swinging
    engagedSoften: 0.8,    // grip softens in light contact so blades ride each other
    engageYield: 1.8,      // a resting engagement gives way when pushed — it is not a parry
    leverageEps: 0.06,     // even near-guard contact moves a blade slightly
    maxDeflect: 0.75,      // rad — hand grip limit on blade deflection
    gripK: 2400, gripD: 95,      // player grip spring (blade weight sim OFF — near 1:1)
    inertiaK: 350, inertiaD: 12, // player grip spring (blade weight sim ON — lag + whip)
    shockThreshold: 0.9,         // impact (m/s) that momentarily knocks a grip loose
    parryYield: 0.3,             // a parrying grip resists contact displacement
    parryPress: 0,               // lateral follow-offset on the parry aim (0 = pure glide)
    beatAimShake: 0.15,          // how much a hard beat jolts the attacker's committed aim (m per m/s)
    oppGuardK: 1100,       // opponent grip by state
    oppAttackK: 1500,
    oppParryK: 2100,
    flexK: 230, flexD: 9,  // blade bow (visual) spring
  },

  opponent: {
    preferredDist: 2.05,   // fencing measure they try to keep
    speed: 1.5,            // footwork speed m/s
    attackChance: 0.55,    // per second, when in distance
    parryChance: 0.72,     // chance to attempt a parry on an incoming thrust
    reaction: 0.14,        // s to react to a fast blade (body reads take +0.1s)
    pointWander: 0.05,     // living point: aim wander amplitude en garde (m)
    armPickRange: [2.1, 2.65], // distance band for picks at the hand
    // action repertoire base weights (habit-learning scales these live)
    planWeights: { simple: 1, feint: 0.9, beat: 0.7, armPick: 0.9, trap: 0.5, second: 0.5 },
  },

  momentum: {
    maxAccel: 7,           // m/s² footwork — no instant direction changes
    lungeAccel: 18,        // m/s² explosive lunge drive
    lungeSpeed: 2.4,       // m/s body speed at full drive
    tellTime: 0.16,        // s of readable preparation before the lunge launches
    driveTime: 0.40,       // s of committed, unabortable drive
    cadence: 2.6,          // Hz stepping rhythm for advances/retreats
  },

  bladeInertia: false,     // simulate weapon weight on the player's blade (menu toggle)
};

const WEAPONS = {
  epee: { label: 'Épée', target: ['torso', 'head', 'arm', 'leg'], offTarget: [] },
};

const weaponKey = 'epee';

const TRAINING_MODES = {
  bout: { label: 'Full bout', time: 180, score: 15, objective: 'Fence a complete three-minute bout to 15.' },
  distance: { label: 'Distance control', time: 60, score: 999, objective: 'Stay at effective measure (1.85–2.35 m) without being hit.' },
  parry: { label: 'Parry–riposte', time: 75, score: 8, objective: 'Deflect the committed attack, then land the riposte.' },
  stop: { label: 'Stop hit', time: 75, score: 8, objective: 'Hit during the opponent’s preparation or committed drive.' },
  hand: { label: 'Hand pick', time: 75, score: 10, objective: 'Control the point and score specifically on the weapon arm or hand.' },
  double: { label: 'No doubles', time: 90, score: 10, objective: 'Score cleanly. Every double touch counts against the drill.' },
  target: { label: 'Target drill', time: 90, score: 999, objective: 'Hit the lit target point-first before it fades. Recover to guard between touches.' },
};

const OPPONENT_STYLES = {
  beginner: { speed: 1.05, attackChance: 0.30, parryChance: 0.38, reaction: 0.28, weights: { simple: 2.5, feint: .2, beat: .1, armPick: .3, trap: .1, second: .1 } },
  pressure: { speed: 1.85, attackChance: .85, parryChance: .55, reaction: .17, preferredDist: 1.75, weights: { simple: 1.8, feint: .5, beat: .5, armPick: .4, trap: .15, second: .25 } },
  counter: { speed: 1.55, attackChance: .42, parryChance: .76, reaction: .12, preferredDist: 2.35, weights: { simple: .5, feint: .7, beat: .3, armPick: 1.4, trap: 1.8, second: .8 } },
  blade: { speed: 1.4, attackChance: .58, parryChance: .84, reaction: .14, weights: { simple: .4, feint: 1, beat: 2.2, armPick: .5, trap: .4, second: 1.3 } },
  adaptive: { speed: 1.5, attackChance: .55, parryChance: .72, reaction: .14, preferredDist: 2.05, weights: { simple: 1, feint: .9, beat: .7, armPick: .9, trap: .5, second: .5 } },
};

/* ---------------- Renderer / scene ---------------- */

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.xr.enabled = true;
document.getElementById('app').appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x10141c);
scene.fog = new THREE.Fog(0x10141c, 18, 42);

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.05, 100);

// Player rig: moves along the piste; camera lives inside it.
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ---------------- Environment ---------------- */

function buildEnvironment() {
  const hemi = new THREE.HemisphereLight(0xcfd8ff, 0x30281e, 0.85);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(6, 10, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -10; key.shadow.camera.right = 10;
  key.shadow.camera.top = 10; key.shadow.camera.bottom = -10;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0x8fb0ff, 0.4);
  fill.position.set(-6, 8, -6);
  scene.add(fill);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 60),
    new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.9 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const { width: W, length: L } = CONFIG.piste;
  const piste = new THREE.Mesh(
    new THREE.BoxGeometry(W, 0.02, L),
    new THREE.MeshStandardMaterial({ color: 0x8a8f98, roughness: 0.35, metalness: 0.75 })
  );
  piste.position.y = 0.01;
  piste.receiveShadow = true;
  scene.add(piste);

  const lineMat = new THREE.MeshStandardMaterial({ color: 0xe8eaf0, roughness: 0.5 });
  for (const z of [0, 2, -2, 5, -5, 6.9, -6.9]) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(W, 0.022, 0.05), lineMat);
    line.position.set(0, 0.012, z);
    scene.add(line);
  }
  for (const s of [1, -1]) {
    const warn = new THREE.Mesh(
      new THREE.BoxGeometry(W, 0.021, 2),
      new THREE.MeshStandardMaterial({ color: 0xa03c3c, roughness: 0.5, metalness: 0.4 })
    );
    warn.position.set(0, 0.011, s * 6);
    scene.add(warn);
  }

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x1b2029, roughness: 1 });
  const backA = new THREE.Mesh(new THREE.PlaneGeometry(40, 8), wallMat);
  backA.position.set(0, 4, -22); scene.add(backA);
  const backB = backA.clone(); backB.rotation.y = Math.PI; backB.position.z = 22; scene.add(backB);
  const sideA = new THREE.Mesh(new THREE.PlaneGeometry(60, 8), wallMat);
  sideA.rotation.y = Math.PI / 2; sideA.position.set(-14, 4, 0); scene.add(sideA);
  const sideB = sideA.clone(); sideB.rotation.y = -Math.PI / 2; sideB.position.x = 14; scene.add(sideB);

  for (let z = -12; z <= 12; z += 8) {
    const lamp = new THREE.Mesh(
      new THREE.BoxGeometry(3, 0.1, 0.8),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf5f2e8, emissiveIntensity: 1.4 })
    );
    lamp.position.set(0, 7.5, z);
    scene.add(lamp);
  }
}
buildEnvironment();

/* ---------------- Scoreboard + lights (visible in VR too) ---------------- */

const board = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = 384;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 1.2),
    new THREE.MeshBasicMaterial({ map: tex })
  );
  mesh.position.set(0, 3.2, -9.5);
  scene.add(mesh);

  const lightL = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.28, 0.06),
    new THREE.MeshBasicMaterial({ color: 0x330a0a }));
  lightL.position.set(-1.0, 2.35, -9.5); scene.add(lightL);
  const lightR = lightL.clone();
  lightR.material = new THREE.MeshBasicMaterial({ color: 0x0a2410 });
  lightR.position.x = 1.0; scene.add(lightR);

  function draw(scoreOpp, scorePlayer, time, wLabel, msg) {
    ctx.fillStyle = '#0d1118'; ctx.fillRect(0, 0, 1024, 384);
    ctx.strokeStyle = '#2a3242'; ctx.lineWidth = 6; ctx.strokeRect(6, 6, 1012, 372);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ff5a5a'; ctx.font = '700 150px sans-serif';
    ctx.fillText(String(scoreOpp), 250, 210);
    ctx.fillStyle = '#4be36e';
    ctx.fillText(String(scorePlayer), 774, 210);
    ctx.fillStyle = '#e8eaf0'; ctx.font = '600 72px sans-serif';
    const m = Math.floor(time / 60), s = Math.floor(time % 60);
    ctx.fillText(`${m}:${String(s).padStart(2, '0')}`, 512, 160);
    ctx.font = '400 40px sans-serif'; ctx.fillStyle = '#9aa3b5';
    ctx.fillText(wLabel.toUpperCase(), 512, 230);
    ctx.font = '600 52px sans-serif'; ctx.fillStyle = '#ffd34d';
    if (msg) ctx.fillText(msg, 512, 330);
    tex.needsUpdate = true;
  }

  function setLights(opp, player, oppWhite, playerWhite) {
    lightL.material.color.set(opp ? 0xff2a2a : (oppWhite ? 0xf5f5f5 : 0x330a0a));
    lightR.material.color.set(player ? 0x27e04d : (playerWhite ? 0xf5f5f5 : 0x0a2410));
  }

  return { draw, setLights };
})();

/* ---------------- Blade physics ---------------- */

const PH = CONFIG.physics;
const BLADE_LEN = 0.9;
const _b1 = new THREE.Vector3(), _b2 = new THREE.Vector3(), _b3 = new THREE.Vector3();

class BladePhys {
  constructor() {
    this.len = BLADE_LEN;
    this.root = new THREE.Vector3();
    this.prevRoot = new THREE.Vector3();
    this.rootVel = new THREE.Vector3();
    this.dir = new THREE.Vector3(0, 0, -1);     // physical blade direction (unit)
    this.dirVel = new THREE.Vector3();          // tangential velocity of dir (1/s)
    this.targetDir = new THREE.Vector3(0, 0, -1); // where the hand points the blade
    this.stiffness = PH.gripK;
    this.damping = PH.gripD;
    this.flex = 0; this.flexVel = 0;            // blade bow (visual), rad
    this.flexAxis = new THREE.Vector3(0, 1, 0); // world axis of the bow rotation
    this.tipPrev = new THREE.Vector3();
    this.tipNow = new THREE.Vector3();
    this.yield = 1;    // contact-displacement multiplier (parry grip < 1)
    this.shock = 0;    // grip knocked loose by a hard beat (s remaining)
    this.engagedT = 0; // in light blade contact right now (s remaining)
    this.init = false;
  }

  reset() {
    this.init = false;
    this.dirVel.set(0, 0, 0);
    this.flex = 0; this.flexVel = 0;
    this.shock = 0; this.engagedT = 0;
  }

  setTargets(rootWorld, dirWorld, frameDt) {
    this.prevRoot.copy(this.root);
    this.root.copy(rootWorld);
    this.targetDir.copy(dirWorld).normalize();
    if (!this.init) {
      this.init = true;
      this.prevRoot.copy(this.root);
      this.rootVel.set(0, 0, 0);
      this.dir.copy(this.targetDir);
      this.tip(this.tipNow); this.tipPrev.copy(this.tipNow);
      return;
    }
    if (frameDt > 0) this.rootVel.subVectors(this.root, this.prevRoot).divideScalar(frameDt);
    // teleport guard (VR sword reparenting, phrase resets)
    if (this.rootVel.lengthSq() > 400) {
      this.rootVel.set(0, 0, 0);
      this.dir.copy(this.targetDir);
      this.dirVel.set(0, 0, 0);
    }
  }

  substep(dt) {
    // grip spring toward the hand's intended direction (tangential error);
    // a hard beat momentarily loosens the grip so displacement sticks,
    // and light engagement softens it so blades visibly ride each other
    this.shock = Math.max(0, this.shock - dt);
    this.engagedT = Math.max(0, this.engagedT - dt);
    const k = this.shock > 0 ? this.stiffness * 0.25
      : this.engagedT > 0 ? this.stiffness * PH.engagedSoften : this.stiffness;
    _b1.subVectors(this.targetDir, this.dir);
    _b1.addScaledVector(this.dir, -_b1.dot(this.dir));
    this.dirVel.addScaledVector(_b1, k * dt);
    this.dirVel.multiplyScalar(Math.max(0, 1 - this.damping * dt));
    this.dir.addScaledVector(this.dirVel, dt).normalize();
    this.dirVel.addScaledVector(this.dir, -this.dirVel.dot(this.dir));

    // the hand can only be twisted so far
    const cos = this.dir.dot(this.targetDir);
    if (cos < Math.cos(PH.maxDeflect)) {
      _b2.copy(this.dir).addScaledVector(this.targetDir, -cos);
      if (_b2.lengthSq() > 1e-10) {
        _b2.normalize();
        this.dir.copy(this.targetDir).multiplyScalar(Math.cos(PH.maxDeflect))
          .addScaledVector(_b2, Math.sin(PH.maxDeflect)).normalize();
        this.dirVel.multiplyScalar(0.5);
      }
    }

    // blade bow (visual spring)
    this.flexVel += -this.flex * PH.flexK * dt;
    this.flexVel *= Math.max(0, 1 - PH.flexD * dt);
    this.flex += this.flexVel * dt;
  }

  tip(out) { return out.copy(this.root).addScaledVector(this.dir, this.len); }
  velAt(s, out) { return out.copy(this.rootVel).addScaledVector(this.dirVel, s * this.len); }

  // rotate the rod about the guard so the point at fraction s displaces by `disp`
  displaceAt(s, disp) {
    const scale = 1 / Math.max(s * this.len, 0.08);
    this.dir.addScaledVector(disp, scale).normalize();
    this.dirVel.addScaledVector(this.dir, -this.dirVel.dot(this.dir));
  }

  // change the velocity of the point at fraction s by `dv`
  impulseAt(s, dv) {
    const scale = 1 / Math.max(s * this.len, 0.08);
    this.dirVel.addScaledVector(dv, scale);
    this.dirVel.addScaledVector(this.dir, -this.dirVel.dot(this.dir));
  }

  deflection() { return Math.acos(THREE.MathUtils.clamp(this.dir.dot(this.targetDir), -1, 1)); }

  kickFlex(amount, axisWorld) {
    this.flexVel += amount;
    this.flexAxis.copy(axisWorld);
  }
}

const pBlade = new BladePhys();
const oBlade = new BladePhys();

// closest points between two segments, with parameters
const _sp = { s: 0, t: 0, dist: 0, pA: new THREE.Vector3(), pB: new THREE.Vector3() };
const _d1 = new THREE.Vector3(), _d2 = new THREE.Vector3(), _dr = new THREE.Vector3();

function closestSegSeg(p1, q1, p2, q2, out) {
  _d1.subVectors(q1, p1); _d2.subVectors(q2, p2); _dr.subVectors(p1, p2);
  const a = _d1.lengthSq(), e = _d2.lengthSq(), f = _d2.dot(_dr);
  let s, t;
  if (a <= 1e-9 && e <= 1e-9) { s = 0; t = 0; }
  else if (a <= 1e-9) { s = 0; t = THREE.MathUtils.clamp(f / e, 0, 1); }
  else {
    const c = _d1.dot(_dr);
    if (e <= 1e-9) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
    else {
      const b = _d1.dot(_d2), denom = a * e - b * b;
      s = denom > 1e-9 ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
    }
  }
  out.s = s; out.t = t;
  out.pA.copy(p1).addScaledVector(_d1, s);
  out.pB.copy(p2).addScaledVector(_d2, t);
  out.dist = out.pA.distanceTo(out.pB);
  return out;
}

const _cn = new THREE.Vector3(), _cvA = new THREE.Vector3(), _cvB = new THREE.Vector3();
const _tA = new THREE.Vector3(), _tB = new THREE.Vector3(), _cx = new THREE.Vector3();
const crossState = { side: 0 }; // which side of each other the blades are on

// one blade-vs-blade contact solve; returns event info or null
function bladeContact(A, B) {
  A.tip(_tA); B.tip(_tB);
  closestSegSeg(A.root, _tA, B.root, _tB, _sp);

  // ---- hard non-crossing: steel cannot pass through steel ----
  // Track the signed separation along the blades' common perpendicular.
  // A sign flip with both closest points on the blades' interior means a
  // blade tunneled through the other this substep — project it back.
  // (Flips beyond a tip are legal: that is a disengage around the point.)
  _cx.crossVectors(A.dir, B.dir);
  const cxLen = _cx.length();
  if (cxLen > 1e-4) {
    _cx.divideScalar(cxLen);
    const signed = _b3.subVectors(_sp.pA, _sp.pB).dot(_cx);
    const side = signed >= 0 ? 1 : -1;
    const interior = _sp.s > 0.04 && _sp.s < 0.96 && _sp.t > 0.04 && _sp.t < 0.96;
    if (crossState.side !== 0 && side !== crossState.side && interior && _sp.dist < 0.14) {
      const wA = (_sp.s * _sp.s + PH.leverageEps) * A.yield;
      const wB = (_sp.t * _sp.t + PH.leverageEps) * B.yield;
      const wSum = wA + wB;
      const corr = PH.contactRadius * crossState.side - signed;
      A.displaceAt(_sp.s, _b3.copy(_cx).multiplyScalar(corr * wA / wSum));
      B.displaceAt(_sp.t, _b3.copy(_cx).multiplyScalar(-corr * wB / wSum));
      A.tip(_tA); B.tip(_tB);
      closestSegSeg(A.root, _tA, B.root, _tB, _sp);
    } else {
      crossState.side = side;
    }
  }

  if (_sp.dist >= PH.contactRadius) return null;

  // both grips feel the engagement
  A.engagedT = 0.08;
  B.engagedT = 0.08;

  if (_sp.dist > 1e-6) _cn.subVectors(_sp.pA, _sp.pB).divideScalar(_sp.dist);
  else _cn.set(0, 1, 0);

  // leverage: force at the foible turns a blade easily, at the forte barely;
  // yield < 1 = a braced grip (parry) gives ground reluctantly
  const wA = (_sp.s * _sp.s + PH.leverageEps) * A.yield;
  const wB = (_sp.t * _sp.t + PH.leverageEps) * B.yield;
  const wSum = wA + wB;

  // positional separation — resolves past the surface (overshoot) so a
  // sustained press ratchets the weaker-held blade instead of stalling
  const os = (A.yield < 1 || B.yield < 1) ? PH.pressOvershoot : PH.idleOvershoot;
  const pen = PH.contactRadius * os - _sp.dist;
  A.displaceAt(_sp.s, _b3.copy(_cn).multiplyScalar(pen * wA / wSum));
  B.displaceAt(_sp.t, _b3.copy(_cn).multiplyScalar(-pen * wB / wSum));

  // impulse if approaching
  A.velAt(_sp.s, _cvA); B.velAt(_sp.t, _cvB);
  _cvA.sub(_cvB); // relative velocity at contact
  const vn = _cvA.dot(_cn);
  let impact = 0;
  if (vn < 0) {
    impact = -vn;
    const dv = (1 + PH.restitution) * impact;
    A.impulseAt(_sp.s, _b3.copy(_cn).multiplyScalar(dv * wA / wSum));
    B.impulseAt(_sp.t, _b3.copy(_cn).multiplyScalar(-dv * wB / wSum));
  }
  // a solid beat knocks both grips for a moment — displacement sticks
  if (impact > PH.shockThreshold) {
    const dur = Math.min(0.2, 0.05 + impact * 0.03);
    A.shock = Math.max(A.shock, dur);
    B.shock = Math.max(B.shock, dur);
  }
  // sustained opposition from a braced parry overwhelms the wrist
  if (B.yield < 1) A.shock = Math.max(A.shock, 0.06);
  if (A.yield < 1) B.shock = Math.max(B.shock, 0.06);
  const slide = Math.sqrt(Math.max(0, _cvA.lengthSq() - vn * vn));
  return { impact, slide, sA: _sp.s, sB: _sp.t, nx: _cn.x, ny: _cn.y, nz: _cn.z };
}

/* ---------------- Sword visuals (segmented, bendable blade) ---------------- */

const SEGN = 6;
const SEG_W = (() => { // tip-weighted bend distribution
  const w = []; let sum = 0;
  for (let i = 0; i < SEGN; i++) { w.push(i + 1); sum += i + 1; }
  return w.map(v => v / sum);
})();

function makeSword(color = 0xd8dde6) {
  const g = new THREE.Group();

  const guard = new THREE.Mesh(
    new THREE.SphereGeometry(0.065, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color, metalness: 0.85, roughness: 0.3 })
  );
  guard.rotation.x = -Math.PI / 2;
  g.add(guard);

  const grip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.016, 0.02, 0.14, 12),
    new THREE.MeshStandardMaterial({ color: 0x2b2118, roughness: 0.9 })
  );
  grip.rotation.x = Math.PI / 2;
  grip.position.z = 0.08;
  g.add(grip);

  // blade: chain of joints so it can bend under contact and bow on touches
  const segLen = BLADE_LEN / SEGN;
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0xc9cfd9, metalness: 0.95, roughness: 0.25 });
  const joints = [];
  let parent = g;
  for (let i = 0; i < SEGN; i++) {
    const joint = new THREE.Group();
    joint.position.z = i === 0 ? 0 : -segLen;
    parent.add(joint);
    const rBase = THREE.MathUtils.lerp(0.009, 0.0035, i / SEGN);
    const rTip = THREE.MathUtils.lerp(0.009, 0.0035, (i + 1) / SEGN);
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(rTip, rBase, segLen, 8), bladeMat);
    seg.rotation.x = -Math.PI / 2; // cylinder +Y → -Z (tipward taper)
    seg.position.z = -segLen / 2;
    seg.castShadow = true;
    joint.add(seg);
    joints.push(joint);
    parent = joint;
  }
  const tip = new THREE.Mesh(
    new THREE.SphereGeometry(0.012, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xff4444, emissive: 0x661111 })
  );
  tip.position.z = -segLen;
  joints[SEGN - 1].add(tip);

  g.userData.joints = joints;
  return g;
}

const _q = new THREE.Quaternion(), _qi = new THREE.Quaternion(), _qj = new THREE.Quaternion();
const _axW = new THREE.Vector3(), _axL = new THREE.Vector3(), _flexL = new THREE.Vector3();
const _ldir = new THREE.Vector3(), _base = new THREE.Vector3(0, 0, -1);

// pose the segmented blade along the physical rod + bow flex
function updateBladeVisual(sword, blade) {
  sword.getWorldQuaternion(_q);
  _qi.copy(_q).invert();
  _ldir.copy(blade.dir).applyQuaternion(_qi); // physical dir in sword-local space

  _axW.crossVectors(_base, _ldir);
  const sin = _axW.length();
  const angle = Math.atan2(sin, THREE.MathUtils.clamp(_base.dot(_ldir), -1, 1));
  if (sin > 1e-6) _axL.copy(_axW).divideScalar(sin); else _axL.set(1, 0, 0);

  _flexL.copy(blade.flexAxis).applyQuaternion(_qi);
  if (_flexL.lengthSq() < 1e-8) _flexL.set(1, 0, 0); else _flexL.normalize();
  const bow = THREE.MathUtils.clamp(blade.flex, -0.55, 0.55);

  const joints = sword.userData.joints;
  for (let i = 0; i < SEGN; i++) {
    joints[i].quaternion.setFromAxisAngle(_axL, angle * SEG_W[i]);
    if (Math.abs(bow) > 0.002) {
      _qj.setFromAxisAngle(_flexL, bow * SEG_W[i]);
      joints[i].quaternion.multiply(_qj);
    }
  }
}

/* ---------------- Opponent fencer ---------------- */

function buildOpponent() {
  const o = new THREE.Group();
  o.position.set(0, 0, -2);

  const jacket = new THREE.MeshStandardMaterial({ color: 0xf0f0ec, roughness: 0.8 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.6 });
  const breeches = new THREE.MeshStandardMaterial({ color: 0xe8e8e2, roughness: 0.85 });

  const parts = []; // { node, zone, radius }

  // torso — profiled fencing stance: deeper than wide, weapon shoulder leading
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.42, 6, 14), jacket);
  torso.position.set(0, 1.12, 0);
  torso.scale.set(0.76, 1, 1.16);
  torso.rotation.set(0.14, -0.5, 0);
  torso.castShadow = true;
  o.add(torso);
  parts.push({ node: torso, zone: 'torso', radius: 0.2 });

  // shoulder line, weapon shoulder forward
  const shoulders = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.24, 4, 10), jacket);
  shoulders.position.set(0.02, 1.4, 0.02);
  shoulders.rotation.set(Math.PI / 2 - 0.12, 0, -0.35);
  shoulders.castShadow = true;
  o.add(shoulders);
  parts.push({ node: shoulders, zone: 'torso', radius: 0.14 });

  // hips, also profiled
  const pelvis = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 10), breeches);
  pelvis.position.set(0, 0.94, -0.02);
  pelvis.scale.set(0.75, 0.65, 1.15);
  pelvis.rotation.y = -0.4;
  pelvis.castShadow = true;
  o.add(pelvis);
  parts.push({ node: pelvis, zone: 'torso', radius: 0.16 });

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 20, 16), dark);
  head.position.set(0, 1.58, 0.04);
  head.castShadow = true;
  o.add(head);
  const mask = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.55),
    new THREE.MeshStandardMaterial({ color: 0x111318, roughness: 0.4, metalness: 0.6, transparent: true, opacity: 0.85 })
  );
  mask.rotation.x = Math.PI / 2.6;
  head.add(mask);
  const bib = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 0.12, 12), jacket);
  bib.position.y = -0.12; head.add(bib);
  parts.push({ node: head, zone: 'head', radius: 0.15 });

  // Legs — articulated: hip and knee pivots so footwork and lunges show.
  // Front leg toward the player (+Z local).
  function buildLeg(front) {
    const hip = new THREE.Group();
    hip.position.set(front ? 0.06 : -0.1, 0.92, front ? 0.16 : -0.2);
    const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.3, 4, 10), breeches);
    thigh.position.y = -0.19;
    thigh.castShadow = true;
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -0.4;
    hip.add(knee);
    const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.32, 4, 10), jacket);
    shin.position.y = -0.19;
    shin.castShadow = true;
    knee.add(shin);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.05, 0.26), dark);
    foot.position.set(0, -0.41, 0.07);
    if (!front) { foot.rotation.y = 1.35; foot.position.z = 0.02; } // back foot turned out
    foot.castShadow = true;
    knee.add(foot);
    o.add(hip);
    parts.push({ node: thigh, zone: 'leg', radius: 0.11 });
    parts.push({ node: shin, zone: 'leg', radius: 0.1 });
    parts.push({ node: foot, zone: 'leg', radius: 0.09 });
    return { hip, knee };
  }
  const legF = buildLeg(true);
  const legB = buildLeg(false);

  // rear arm: hangs relaxed behind the rear hip, modern épée carriage
  const backArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.28, 4, 10), jacket);
  backArm.position.set(-0.1, 1.18, -0.2); backArm.rotation.z = 0.25; backArm.rotation.x = -0.35;
  backArm.castShadow = true;
  o.add(backArm);
  parts.push({ node: backArm, zone: 'arm', radius: 0.09 });

  // neck
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.08, 10), jacket);
  neck.position.set(0, 1.46, 0.02);
  o.add(neck);

  // Weapon arm: shoulder→elbow→wrist chain, posed by two-bone IK each frame.
  // Segments are direct children of the group; solveArm sets their transforms.
  const upperArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.24, 4, 10), jacket);
  const forearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.044, 0.22, 4, 10), jacket);
  upperArm.castShadow = true; forearm.castShadow = true;
  o.add(upperArm); o.add(forearm);
  parts.push({ node: upperArm, zone: 'arm', radius: 0.1 });
  parts.push({ node: forearm, zone: 'arm', radius: 0.09 });

  const hand = new THREE.Group();
  o.add(hand);
  const glove = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), dark);
  glove.position.z = 0.06;
  hand.add(glove);
  parts.push({ node: glove, zone: 'arm', radius: 0.08 });

  const sword = makeSword(0xb9bfca);
  hand.add(sword); // blade along hand -Z; the IK orients the hand

  scene.add(o);

  return { group: o, parts, sword, torso, head, legF, legB, backArm, upperArm, forearm, hand };
}

const opp = buildOpponent();

/* --- two-bone arm IK (in the opponent group's local space) --- */

const ARM_A = 0.34, ARM_B = 0.32; // upper arm, forearm lengths
const _ikN = new THREE.Vector3(), _ikP = new THREE.Vector3(), _ikE = new THREE.Vector3();
const _ikS = new THREE.Vector3(), _ikH = new THREE.Vector3(), _ikT = new THREE.Vector3();
const _ikD = new THREE.Vector3(), _segDir = new THREE.Vector3();
const _yUp = new THREE.Vector3(0, 1, 0), _negZ = new THREE.Vector3(0, 0, -1);

function setSeg(mesh, from, to) {
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  _segDir.subVectors(to, from).normalize();
  mesh.quaternion.setFromUnitVectors(_yUp, _segDir);
}

// positions upperArm/forearm between shoulder S and wrist H; returns clamped H
function solveArm(S, H) {
  _ikN.subVectors(H, S);
  let d = _ikN.length();
  d = THREE.MathUtils.clamp(d, 0.12, ARM_A + ARM_B - 0.015);
  _ikN.normalize();
  H.copy(S).addScaledVector(_ikN, d);
  // elbow pole: out to the side and down, like a real weapon arm
  _ikP.set(0.55, -0.8, -0.1);
  _ikP.addScaledVector(_ikN, -_ikP.dot(_ikN)).normalize();
  const cosA = (ARM_A * ARM_A + d * d - ARM_B * ARM_B) / (2 * ARM_A * d);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  _ikE.copy(S).addScaledVector(_ikN, ARM_A * cosA).addScaledVector(_ikP, ARM_A * sinA);
  setSeg(opp.upperArm, S, _ikE);
  setSeg(opp.forearm, _ikE, H);
  return H;
}

/* ---------------- Player sword ---------------- */

const playerSword = makeSword();

// Desktop: sword hangs off a hand anchor inside the rig; mouse steers it.
const handAnchor = new THREE.Group();
handAnchor.position.set(0.22, 1.25, -0.35);
rig.add(handAnchor);
handAnchor.add(playerSword);

// Player body target (for the opponent's attacks)
const playerTarget = {
  radius: 0.2,
  center: new THREE.Vector3(),
  update() {
    this.center.set(rig.position.x, 1.15, rig.position.z);
    if (renderer.xr.isPresenting) {
      const head = new THREE.Vector3();
      camera.getWorldPosition(head);
      this.center.set(head.x, 1.15, head.z);
    }
  },
};

// Full épée target set on the player: hand and forearm (behind the guard,
// along the weapon axis — in VR that IS your controller), mask, body.
// Checked smallest-first so touches attribute to the right zone.
const playerVols = [
  { pos: new THREE.Vector3(), radius: 0.085, zone: 'hand' },
  { pos: new THREE.Vector3(), radius: 0.09, zone: 'arm' },
  { pos: new THREE.Vector3(), radius: 0.14, zone: 'mask' },
  { pos: new THREE.Vector3(), radius: 0.3, zone: 'body' },
];

function updatePlayerVols() {
  playerTarget.update();
  playerVols[0].pos.copy(pBlade.root).addScaledVector(pBlade.dir, -0.1);
  playerVols[1].pos.copy(pBlade.root).addScaledVector(pBlade.dir, -0.3);
  if (renderer.xr.isPresenting) camera.getWorldPosition(playerVols[2].pos);
  else playerVols[2].pos.set(rig.position.x, 1.62, rig.position.z);
  playerVols[3].pos.copy(playerTarget.center);
}

/* ---------------- Audio ---------------- */

const audio = (() => {
  let ctx = null;
  function ensure() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function buzzer(freq = 440, dur = 0.45, type = 'square', vol = 0.18) {
    const c = ensure();
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    o.connect(g).connect(c.destination);
    o.start(); o.stop(c.currentTime + dur);
  }
  // intensity 0..1; s = contact position on the struck blade (0 guard → 1 tip: tip rings higher)
  function clash(intensity = 0.5, s = 0.5) {
    const c = ensure();
    const len = 0.09, buf = c.createBuffer(1, c.sampleRate * len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (d.length * 0.25));
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1800 + s * 1600;
    const g = c.createGain(); g.gain.value = 0.15 + 0.45 * intensity;
    src.connect(f).connect(g).connect(c.destination);
    src.start();
    buzzer(1800 + s * 2200, 0.05 + intensity * 0.03, 'triangle', 0.04 + intensity * 0.07);
  }
  // blades sliding along each other
  function scrape(intensity = 0.5) {
    const c = ensure();
    const len = 0.05, buf = c.createBuffer(1, c.sampleRate * len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (d.length * 0.5));
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2600 + Math.random() * 900; f.Q.value = 2;
    const g = c.createGain(); g.gain.value = Math.min(0.2, 0.05 + 0.12 * intensity);
    src.connect(f).connect(g).connect(c.destination);
    src.start();
  }
  return { buzzer, clash, scrape, ensure };
})();

/* ---------------- Geometry helpers ---------------- */

const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3(), _t3 = new THREE.Vector3();
const _ps1 = new THREE.Vector3(), _ps2 = new THREE.Vector3(), _ps3 = new THREE.Vector3();

function pointSegmentDistance(p, a, b) {
  _ps1.subVectors(b, a);
  const len2 = _ps1.lengthSq();
  if (len2 === 0) return p.distanceTo(a);
  let t = _ps2.subVectors(p, a).dot(_ps1) / len2;
  t = Math.max(0, Math.min(1, t));
  _ps3.copy(a).addScaledVector(_ps1, t);
  return p.distanceTo(_ps3);
}

/* ---------------- Match state ---------------- */

const match = {
  started: false,
  scorePlayer: 0,
  scoreOpp: 0,
  time: CONFIG.boutTime,
  phase: 'ready',          // ready | fencing | lockout | halt | over
  priority: null,
  lock: null,
  haltTimer: 0,
  boardMsg: '',
  mode: 'bout',
  style: 'adaptive',
  overtime: false,
  paused: false,
};

let session = null;
function freshSession() {
  return {
    startedAt: Date.now(), attacks: 0, touchesFor: 0, touchesAgainst: 0, doubles: 0,
    parries: 0, ripostes: 0, handHits: 0, cleanHits: 0, measureTime: 0,
    totalFencingTime: 0, zones: {}, lastAttackAt: 0, lastParryAt: 0,
  };
}

function coach(text, dur = 2.1) {
  const el = document.getElementById('coach');
  el.textContent = text; el.classList.add('show');
  clearTimeout(coach._timer);
  coach._timer = setTimeout(() => el.classList.remove('show'), dur * 1000);
}

function saveSession(summary) {
  try {
    const history = JSON.parse(localStorage.getItem('epeeSessions') || '[]');
    history.unshift(summary);
    localStorage.setItem('epeeSessions', JSON.stringify(history.slice(0, 20)));
    localStorage.setItem('epeePrefs', JSON.stringify({ mode: match.mode, style: match.style, inertia: CONFIG.bladeInertia }));
  } catch (_) {}
}

function getHistory() {
  try { return JSON.parse(localStorage.getItem('epeeSessions') || '[]'); } catch (_) { return []; }
}

function updateDrillHud() {
  const box = document.getElementById('drillHud');
  if (match.mode === 'bout' || !match.started) { box.style.display = 'none'; return; }
  const mode = TRAINING_MODES[match.mode]; box.style.display = 'block';
  document.getElementById('drillName').textContent = mode.label;
  document.getElementById('drillObjective').textContent = mode.objective;
  let progress = `${match.scorePlayer} clean touches`;
  if (match.mode === 'distance') progress = `${Math.floor(session?.measureTime || 0)}s in measure`;
  if (match.mode === 'double') progress = `${match.scorePlayer} clean · ${session?.doubles || 0} doubles`;
  if (match.mode === 'target') progress = `${drill.hits} hits · ${drill.misses} missed · streak ${drill.streak}`;
  document.getElementById('drillProgress').textContent = progress;
}

const hud = {
  scoreL: document.getElementById('scoreL'),
  scoreR: document.getElementById('scoreR'),
  timer: document.getElementById('timer'),
  weaponTag: document.getElementById('weaponTag'),
  message: document.getElementById('message'),
  lightL: document.getElementById('lightL'),
  lightR: document.getElementById('lightR'),
  lightLW: document.getElementById('lightLW'),
  lightRW: document.getElementById('lightRW'),
  overlay: document.getElementById('overlay'),
};

let msgTimeout = null;
function showMessage(text, dur = 1.4) {
  hud.message.textContent = text;
  hud.message.classList.add('show');
  match.boardMsg = text;
  clearTimeout(msgTimeout);
  msgTimeout = setTimeout(() => {
    hud.message.classList.remove('show');
    match.boardMsg = '';
  }, dur * 1000);
}

function setLights({ opp = false, player = false, oppWhite = false, playerWhite = false }) {
  hud.lightL.classList.toggle('on', opp);
  hud.lightR.classList.toggle('on', player);
  hud.lightLW.classList.toggle('on', oppWhite);
  hud.lightRW.classList.toggle('on', playerWhite);
  board.setLights(opp, player, oppWhite, playerWhite);
}

function updateHud() {
  if (match.mode === 'target' && match.started) {
    hud.scoreL.textContent = drill.misses;
    hud.scoreR.textContent = drill.hits;
    hud.timer.textContent = drill.lastMs ? drill.lastMs + 'ms' : '—';
    const avg = drill.reactions.length
      ? Math.round(drill.reactions.reduce((a, b) => a + b, 0) / drill.reactions.length * 1000)
      : 0;
    hud.weaponTag.textContent = avg
      ? `TARGET DRILL · avg ${avg}ms · streak ${drill.streak}`
      : 'TARGET DRILL';
    board.draw(drill.misses, drill.hits, match.time, 'DRILL', match.boardMsg);
    return;
  }
  hud.scoreL.textContent = match.scoreOpp;
  hud.scoreR.textContent = match.scorePlayer;
  const m = Math.floor(match.time / 60), s = Math.floor(match.time % 60);
  hud.timer.textContent = `${m}:${String(s).padStart(2, '0')}`;
  hud.weaponTag.textContent = WEAPONS[weaponKey].label;
  board.draw(match.scoreOpp, match.scorePlayer, match.time, WEAPONS[weaponKey].label, match.boardMsg);
}

/* ---------------- Opponent AI ---------------- */

const ai = {
  state: 'engarde',        // engarde | advance | retreat | lunge | riposte | recover | parry
  stateTime: 0,
  vel: 0,                  // body velocity along z — momentum, not teleports
  ext: 0.15,
  extTarget: 0.15,
  parryDir: 0,
  parryTimer: 0,
  reactTimer: 0,
  bob: Math.random() * 10,
  prevDist: 2.05,
  stepPhase: 0,            // leg-cycle phase, advances with body speed
  lungeT: 0,               // 0 en-garde → 1 full lunge pose
  plan: null,              // current tactical action {type, target, disengageDir, ...}
  memory: { parryL: 0, parryR: 0, playerAdvances: 0 }, // reads of YOUR habits
  advCool: 0,
  guardBias: { x: 0, y: 0, tx: 0, ty: 0, t: 0 },       // slow line changes / invitations
  engage: { side: 1, timer: 0, changing: 0 },          // blade-engagement seeking
  attacking: false,
  parryMsg: false,         // 'Parried!' shown for this parry
  beatMsg: false,          // 'Deflected!' shown for this attack
  aimFrozen: false,        // committed drives can't re-aim
  frozenAim: new THREE.Vector3(),
};

function aiSetState(s) {
  ai.state = s;
  ai.stateTime = 0;
  if (s === 'parry') ai.parryMsg = false;
  if (s === 'lunge' || s === 'riposte') ai.beatMsg = false;
}

function applyOpponentStyle(styleKey) {
  const p = OPPONENT_STYLES[styleKey] || OPPONENT_STYLES.adaptive;
  CONFIG.opponent.speed = p.speed;
  CONFIG.opponent.attackChance = p.attackChance;
  CONFIG.opponent.parryChance = p.parryChance;
  CONFIG.opponent.reaction = p.reaction;
  CONFIG.opponent.preferredDist = p.preferredDist || 2.05;
  CONFIG.opponent.planWeights = { ...p.weights };
  if (match.mode === 'parry') { CONFIG.opponent.attackChance = .95; CONFIG.opponent.parryChance = .2; }
  if (match.mode === 'stop') { CONFIG.opponent.attackChance = .82; CONFIG.opponent.reaction += .08; }
  if (match.mode === 'hand') { CONFIG.opponent.attackChance = .22; CONFIG.opponent.parryChance = .45; }
  if (match.mode === 'distance') { CONFIG.opponent.attackChance = .38; }
}

// pick the next action from the repertoire, weighted by what YOU have shown
function choosePlan(dist) {
  const C = CONFIG.opponent, mem = ai.memory;
  const w = { ...C.planWeights };
  const parries = mem.parryL + mem.parryR;
  w.feint *= 1 + Math.min(2, parries * 0.25);      // you parry a lot → he feints
  w.second *= 1 + Math.min(2, parries * 0.2);      // ...and sets traps for your riposte
  w.beat *= 1 + Math.min(1.5, mem.playerAdvances * 0.1);
  w.trap *= 1 + Math.min(2, mem.playerAdvances * 0.15); // you rush in → he baits it
  if (dist < C.armPickRange[0] || dist > C.armPickRange[1]) w.armPick = 0;

  let sum = 0;
  for (const k in w) sum += w[k];
  let r = Math.random() * sum, type = 'simple';
  for (const k in w) { r -= w[k]; if (r <= 0) { type = k; break; } }
  if (match.mode === 'parry' || match.mode === 'stop') type = 'simple';
  if (match.mode === 'hand' && type === 'trap') type = 'simple';

  // disengage around the side you habitually parry toward
  const disengageDir = mem.parryR > mem.parryL ? -1 : mem.parryL > mem.parryR ? 1
    : (Math.random() < 0.5 ? 1 : -1);
  ai.plan = {
    type, disengageDir,
    target: type === 'armPick' ? 'hand' : (Math.random() < 0.15 ? 'mask' : 'body'),
  };
  if (type === 'trap') { ai.plan.window = 0.9; aiSetState('retreat'); }
  else if (type === 'beat') aiSetState('beat');
  else aiSetState('lunge');
}

function updateOpponent(dt) {
  const o = opp.group;
  ai.stateTime += dt;
  ai.bob += dt;

  playerTarget.update();
  const C = CONFIG.opponent, M = CONFIG.momentum;
  const sign = Math.sign(playerTarget.center.z - o.position.z) || 1;
  const dist = Math.abs(o.position.z - playerTarget.center.z);

  // stepping rhythm — humans move in pulses, not glides
  const cadence = 0.55 + 0.45 * Math.sin(ai.bob * Math.PI * 2 * M.cadence);

  // how fast is the player closing? (he reads your footwork, with some latency)
  const closing = dt > 0 ? (ai.prevDist - dist) / dt : 0;
  ai.prevDist = dist;
  ai.advCool -= dt;
  if (closing > 1.3 && ai.advCool <= 0) { ai.advCool = 1; ai.memory.playerAdvances++; }

  let desired = 0;
  let accel = M.maxAccel;
  let inTell = false;

  switch (ai.state) {
    case 'engarde': {
      ai.extTarget = 0.26 + 0.08 * Math.sin(ai.bob * 0.8); // carried forward, seeking the blade
      ai.attacking = false;
      if (match.mode === 'target') desired = 0.35 * Math.sin(ai.bob * 0.5); // slow drift — distance work
      if (dist > C.preferredDist + 0.25) aiSetState('advance');
      else if (dist < C.preferredDist - 0.35) aiSetState('retreat');
      else if (match.mode !== 'target' && match.phase === 'fencing' &&
               Math.random() < C.attackChance * dt) choosePlan(dist);
      break;
    }
    case 'advance': {
      ai.extTarget = 0.15;
      desired = C.speed * cadence * sign;
      if (dist <= C.preferredDist) aiSetState('engarde');
      break;
    }
    case 'retreat': {
      desired = -C.speed * 1.15 * cadence * sign;
      if (ai.plan?.type === 'trap') {
        // false retreat: invite the advance, counter into it
        ai.plan.window -= dt;
        if (closing > 0.9 && dist < 2.6 && dist > 1.5) {
          ai.plan = { type: 'counter', target: Math.random() < 0.6 ? 'hand' : 'body' };
          aiSetState('lunge');
        } else if (ai.plan.window <= 0) {
          ai.plan = null;
          aiSetState('engarde');
        }
      } else if (dist >= C.preferredDist || o.position.z < -6.5) aiSetState('engarde');
      break;
    }
    case 'beat': {
      // sharp blade take before the attack
      ai.extTarget = 0.75;
      desired = 0.4 * sign;
      if (ai.stateTime > 0.16) {
        if (ai.plan) ai.plan.skipTell = true; // the beat WAS the preparation
        aiSetState('lunge');
      }
      break;
    }
    case 'lunge': {
      const plan = ai.plan || { type: 'simple' };
      const tell = plan.skipTell ? 0 : plan.type === 'counter' ? 0.06
        : plan.type === 'armPick' ? 0.1 : M.tellTime;
      const drive = plan.type === 'armPick' ? 0.24 : plan.type === 'second' ? 0.3
        : plan.type === 'feint' ? 0.5 : M.driveTime;
      if (ai.stateTime < tell) {
        // preparation — readable if you watch for it
        inTell = true;
        ai.extTarget = 0.55;
      } else if (ai.stateTime < tell + drive) {
        // committed, ballistic drive — cannot abort
        ai.extTarget = 1;
        desired = M.lungeSpeed * (plan.type === 'armPick' ? 0.55 : 1) * sign;
        accel = M.lungeAccel;
        if (!ai.attacking) {
          ai.attacking = true;
          if (!match.priority) match.priority = 'opponent';
        }
        // second intention: the shallow attack drew your parry — counter-time
        if (plan.type === 'second' && oBlade.deflection() > 0.3) {
          ai.parryTimer = 0.3;
          ai.parryDir = pBlade.tipNow.x > o.position.x ? 1 : -1;
          aiSetState('parry');
        }
      } else {
        aiSetState('recover');
      }
      break;
    }
    case 'riposte': {
      if (ai.stateTime < 0.06) {
        ai.extTarget = 0.8;
      } else if (ai.stateTime < 0.36) {
        ai.extTarget = 1;
        desired = M.lungeSpeed * 0.9 * sign;
        accel = M.lungeAccel;
        if (!ai.attacking) {
          ai.attacking = true;
          match.priority = 'opponent';
        }
      } else {
        aiSetState('recover');
      }
      break;
    }
    case 'recover': {
      ai.attacking = false;
      ai.extTarget = 0.2;
      desired = dist < C.preferredDist - 0.15 ? -C.speed * 1.2 * sign : 0;
      // remise: the attack was deflected but no riposte is coming — renew it
      if (ai.beatMsg && !ai.plan && ai.stateTime > 0.08 && ai.stateTime < 0.2 &&
          pTipVel.z > -0.5 && Math.random() < 3 * dt) {
        ai.plan = { type: 'counter', target: 'body' };
        aiSetState('riposte');
      } else if (ai.stateTime > 0.45 && Math.abs(ai.vel) < 0.25) {
        ai.plan = null;
        aiSetState(dist < C.preferredDist - 0.3 ? 'retreat' : 'engarde');
      }
      break;
    }
    case 'parry': {
      ai.extTarget = 0.6;
      ai.parryTimer -= dt;
      if (ai.parryTimer <= 0) aiSetState('riposte');
      break;
    }
  }

  // attack on preparation: rushing into distance gets counterattacked (often to the arm)
  if (match.mode !== 'target' &&
      (ai.state === 'engarde' || ai.state === 'advance') && match.phase === 'fencing' &&
      closing > 1.3 && dist < 2.3 && dist > 1.4 && Math.random() < 2.5 * dt) {
    ai.plan = { type: 'counter', target: 'hand' };
    aiSetState('lunge');
  }

  // --- momentum: acceleration-limited body velocity ---
  const dv = THREE.MathUtils.clamp(desired - ai.vel, -accel * dt, accel * dt);
  ai.vel += dv;
  o.position.z += ai.vel * dt;
  if (o.position.z < -6.8 || o.position.z > 6.8) {
    o.position.z = THREE.MathUtils.clamp(o.position.z, -6.8, 6.8);
    ai.vel = 0;
  }

  // --- parry reaction (blocked while committed to a drive) ---
  // they react to a fast blade OR to the body suddenly closing distance —
  // a slow creep doesn't read as an attack, a rushed advance draws the parry
  const committed = (ai.state === 'lunge' && ai.attacking) || ai.state === 'beat' ||
                    ai.state === 'riposte' || ai.state === 'parry' || ai.state === 'recover';
  if (!committed && match.phase === 'fencing' && match.mode !== 'target') {
    const tipToTorso = pBlade.tipNow.distanceTo(_t1.setFromMatrixPosition(opp.torso.matrixWorld));
    const approaching = pTipVel.z < -0.3;
    const bladeThreat = tipToTorso < 1.15 && approaching && pTipVel.length() > 1.8;
    const bodyThreat = closing > 0.7 && dist < 2.35 && tipToTorso < 1.6;
    // blade threats are recognized fast; reading footwork takes longer —
    // so a surprise attack in tempo beats the parry, a prepared one gets read
    const needed = bladeThreat ? C.reaction : C.reaction + 0.1;
    if (bladeThreat || bodyThreat) {
      ai.reactTimer += dt;
      if (ai.reactTimer > needed) {
        if (Math.random() < C.parryChance) {
          aiSetState('parry');
          ai.parryTimer = 0.32 + Math.random() * 0.15;
          ai.reactTimer = 0;
          ai.parryDir = pBlade.tipNow.x > o.position.x ? 1 : -1;
        } else {
          ai.reactTimer = -0.35; // failed the read — beaten this exchange
        }
      }
    } else if (ai.reactTimer > 0) {
      ai.reactTimer = 0;
    } else if (ai.reactTimer < 0) {
      ai.reactTimer = Math.min(0, ai.reactTimer + dt);
    }
  }

  // --- pose / animation ---
  ai.ext = THREE.MathUtils.damp(ai.ext, ai.extTarget, 12, dt);

  // lunge pose blend: snaps in with the drive, releases through the recovery
  const lungeTarget = ai.attacking ? 1 : (inTell ? 0.18 : 0);
  ai.lungeT = THREE.MathUtils.damp(ai.lungeT, lungeTarget, ai.attacking ? 16 : 7, dt);
  const L = ai.lungeT;

  // footwork: legs shuffle with actual body speed (front foot leads, back follows)
  ai.stepPhase += Math.abs(ai.vel) * dt * 9;
  const stepF = Math.sin(ai.stepPhase) * 0.16 * (1 - L);
  const stepB = Math.sin(ai.stepPhase - Math.PI * 0.6) * 0.13 * (1 - L);
  opp.legF.hip.rotation.x = 0.48 + stepF + L * 0.52;
  opp.legF.knee.rotation.x = -0.62 - Math.max(0, Math.sin(ai.stepPhase)) * 0.22 * (1 - L) - L * 0.45;
  opp.legB.hip.rotation.x = -0.55 + stepB - L * 0.35;
  opp.legB.knee.rotation.x = 0.75 - L * 0.62;

  // torso drives forward and down into the lunge; back arm throws back
  opp.torso.rotation.x = 0.14 + L * 0.32;
  opp.backArm.rotation.x = -0.35 - L * 1.1; // throws back on the lunge

  const bobY = Math.sin(ai.bob * 2.1) * 0.015 + Math.sin(ai.bob * 5.3) * 0.006;
  const dip = inTell ? 0.035 * (ai.stateTime / M.tellTime) : L * 0.13;
  o.position.y = bobY - dip;

  const faceDir = sign;
  o.rotation.y = faceDir > 0 ? 0 : Math.PI;

  // --- aim resolution: what is the point doing right now? ---
  updatePlayerVols();
  const target = _t2;
  if (ai.state === 'parry') {
    // opposition: aim through the player's blade, gliding from their foible
    // toward their forte — the rods stay crossed so the press never breaks
    const slide = THREE.MathUtils.lerp(0.6, 0.2, THREE.MathUtils.clamp(ai.stateTime / 0.3, 0, 1));
    target.copy(pBlade.root).addScaledVector(pBlade.dir, slide * pBlade.len);
    target.x += ai.parryDir * PH.parryPress;
  } else if (ai.state === 'beat') {
    target.copy(pBlade.root).addScaledVector(pBlade.dir, 0.55 * pBlade.len);
  } else {
    const planAim = ai.plan && (ai.state === 'lunge' || ai.state === 'riposte');
    const tName = planAim ? (ai.plan.target || 'body') : 'engage';
    let wanderScale = 1;
    if (tName === 'hand') target.copy(playerVols[0].pos);
    else if (tName === 'mask') target.copy(playerVols[2].pos);
    else if (tName === 'engage' && match.mode === 'target') {
      // drill dummy: hold a quiet low line out of the way — present the target
      target.set(playerTarget.center.x + 0.45, 0.65, playerTarget.center.z);
    }
    else if (tName === 'engage') {
      // default blade conversation: rest the point lightly against the
      // player's blade, periodically changing engagement under the point;
      // when the blade is absent, the point threatens the body instead
      const eng = ai.engage;
      const bladePresent =
        Math.abs(pBlade.tipNow.x - playerTarget.center.x) < 0.55 &&
        pBlade.tipNow.y > 0.6 && pBlade.tipNow.y < 1.8 &&
        pBlade.tipNow.distanceTo(_t1.setFromMatrixPosition(opp.torso.matrixWorld)) < 2.4 &&
        pTipVel.length() < 1.5; // a fast blade is an attack — stop resting, defend
      if (bladePresent) {
        wanderScale = 0.25;
        eng.timer -= dt;
        if (eng.timer <= 0) {
          eng.timer = 1.2 + Math.random() * 1.6;
          eng.side *= -1;
          eng.changing = 0.18;
        }
        target.copy(pBlade.root).addScaledVector(pBlade.dir, 0.55 * pBlade.len);
        target.x += eng.side * 0.035;
        if (eng.changing > 0) {
          eng.changing -= dt;
          target.y -= 0.22; // change of engagement passes under the point
        }
      } else {
        target.set(playerTarget.center.x, playerTarget.center.y + 0.15, playerTarget.center.z);
      }
    } else {
      target.set(playerTarget.center.x, playerTarget.center.y + 0.15, playerTarget.center.z);
    }

    // feint: show one line, then disengage UNDER the point into another —
    // blades can't pass through each other, so the route is around the tip
    if (ai.plan?.type === 'feint' && ai.attacking) {
      const dT = ai.stateTime - M.tellTime;
      if (dT > 0.14 && dT < 0.3) {
        const s = Math.sin(((dT - 0.14) / 0.16) * Math.PI);
        target.x += ai.plan.disengageDir * 0.3 * s;
        target.y -= 0.24 * s;
      }
    }

    // living point: the tip is never still on guard
    if (!ai.attacking) {
      const t = ai.bob;
      target.x += (Math.sin(t * 1.9) + 0.5 * Math.sin(t * 3.7 + 1.3)) * C.pointWander * wanderScale;
      target.y += (Math.sin(t * 2.6 + 0.7) + 0.4 * Math.sin(t * 4.3)) * C.pointWander * 0.8 * wanderScale;
    }
  }

  // committed drives can't re-aim — but a feint commits late: the disengage IS the re-aim
  const freezeReady = !(ai.plan?.type === 'feint' && ai.stateTime < M.tellTime + 0.3);
  if (ai.attacking && (ai.state === 'lunge' || ai.state === 'riposte') && freezeReady) {
    if (!ai.aimFrozen) { ai.aimFrozen = true; ai.frozenAim.copy(target); }
    target.copy(ai.frozenAim);
  } else if (!ai.attacking) {
    ai.aimFrozen = false;
  }

  // --- pose the arm chain: two-bone IK toward the aim, wrist steers the point ---
  _ikT.copy(target).sub(o.position);
  _ikT.x *= faceDir; _ikT.z *= faceDir; // world → group-local (yaw is 0 or π)
  const S = _ikS.set(0.09, 1.4, 0.16 + L * 0.22 + ai.vel * faceDir * 0.02);
  _ikD.subVectors(_ikT, S).normalize();
  const reach = 0.34 + ai.ext * 0.34;
  const H = _ikH.copy(S).addScaledVector(_ikD, reach);
  H.y -= 0.02;

  // slow guard shifts — invitations and line changes between actions
  const gb = ai.guardBias;
  gb.t -= dt;
  if (gb.t <= 0) {
    gb.t = 2 + Math.random() * 2.5;
    gb.tx = (Math.random() - 0.5) * 0.14;
    gb.ty = (Math.random() - 0.5) * 0.1;
  }
  gb.x = THREE.MathUtils.damp(gb.x, gb.tx, 1.5, dt);
  gb.y = THREE.MathUtils.damp(gb.y, gb.ty, 1.5, dt);
  H.x += gb.x * (1 - ai.ext);
  H.y += gb.y * (1 - ai.ext);

  solveArm(S, H);
  opp.hand.position.copy(H);
  _ikD.subVectors(_ikT, H).normalize();
  opp.hand.quaternion.setFromUnitVectors(_negZ, _ikD);

  // head tracks the player
  _t1.copy(playerVols[2].pos).sub(o.position);
  _t1.x *= faceDir; _t1.z *= faceDir;
  _t1.sub(opp.head.position);
  const hYaw = THREE.MathUtils.clamp(Math.atan2(_t1.x, _t1.z), -0.7, 0.7);
  const hPitch = THREE.MathUtils.clamp(-Math.atan2(_t1.y, Math.hypot(_t1.x, _t1.z)), -0.35, 0.45);
  opp.head.rotation.set(hPitch, hYaw, 0);

  // grip strength by intent
  oBlade.stiffness = (ai.state === 'parry' || ai.state === 'beat') ? PH.oppParryK
    : (ai.attacking ? PH.oppAttackK : PH.oppGuardK);
  oBlade.damping = 1.7 * Math.sqrt(oBlade.stiffness);
  oBlade.yield = ai.state === 'parry' ? PH.parryYield
    : ai.state === 'beat' ? 0.55
    : ai.attacking ? 1
    : PH.engageYield; // resting blade gives way when pushed
}

/* ---------------- Blade physics step + contact feedback ---------------- */

const pTipVel = new THREE.Vector3(), oTipVel = new THREE.Vector3();
const _rootV = new THREE.Vector3(), _dirV = new THREE.Vector3();
let clashTimer = 0, scrapeTimer = 0;

function swordWorldPose(sword, outRoot, outDir) {
  sword.getWorldPosition(outRoot);
  sword.getWorldQuaternion(_q);
  outDir.set(0, 0, -1).applyQuaternion(_q);
}

function stepBladePhysics(dt) {
  rig.updateMatrixWorld(true);
  opp.group.updateMatrixWorld(true);

  swordWorldPose(playerSword, _rootV, _dirV);
  pBlade.setTargets(_rootV, _dirV, dt);
  swordWorldPose(opp.sword, _rootV, _dirV);
  oBlade.setTargets(_rootV, _dirV, dt);

  pBlade.tipPrev.copy(pBlade.tipNow);
  oBlade.tipPrev.copy(oBlade.tipNow);

  let strongest = null;
  const sdt = dt / PH.substeps;
  for (let k = 0; k < PH.substeps; k++) {
    pBlade.substep(sdt);
    oBlade.substep(sdt);
    const ev = bladeContact(pBlade, oBlade);
    if (ev && (!strongest || ev.impact > strongest.impact)) strongest = ev;
  }

  pBlade.tip(pBlade.tipNow);
  oBlade.tip(oBlade.tipNow);
  if (dt > 0) {
    pTipVel.subVectors(pBlade.tipNow, pBlade.tipPrev).divideScalar(dt);
    oTipVel.subVectors(oBlade.tipNow, oBlade.tipPrev).divideScalar(dt);
  }

  // a hard beat on a committed attack jolts the attacker's arm — their
  // frozen aim shifts with the blow, so a good beat makes the attack miss
  if (strongest && strongest.impact > PH.shockThreshold && ai.attacking && ai.aimFrozen) {
    ai.frozenAim.x -= strongest.nx * Math.min(0.3, strongest.impact * PH.beatAimShake);
    ai.frozenAim.y -= strongest.ny * Math.min(0.3, strongest.impact * PH.beatAimShake);
    ai.frozenAim.z -= strongest.nz * Math.min(0.3, strongest.impact * PH.beatAimShake);
  }

  // --- contact feedback: you should FEEL the blade the whole time ---
  clashTimer -= dt; scrapeTimer -= dt;
  if (strongest) {
    if (strongest.impact > 0.3 && clashTimer <= 0) {
      clashTimer = 0.1;
      const inten = Math.min(1, strongest.impact / 3.5);
      audio.clash(inten, strongest.sB);
      pulseHaptic(0.2 + 0.75 * inten, 15 + inten * 40);
      // beats visibly shiver the blades
      _t1.crossVectors(pBlade.dir, oBlade.dir);
      if (_t1.lengthSq() > 1e-6) {
        pBlade.kickFlex(strongest.impact * 0.25, _t1.normalize());
        oBlade.kickFlex(-strongest.impact * 0.25, _t1);
      }
    } else if (strongest.slide > 0.12 && scrapeTimer <= 0) {
      scrapeTimer = 0.09;
      audio.scrape(Math.min(1, strongest.slide / 2));
      pulseHaptic(0.12, 10);
    } else if (scrapeTimer <= 0) {
      // resting engagement: faint presence tick
      scrapeTimer = 0.16;
      audio.scrape(0.15);
      pulseHaptic(0.06, 8);
    }
  }

  // --- emergent parry/beat messages from actual blade deflection ---
  if (match.phase === 'fencing') {
    if (ai.state === 'parry' && !ai.parryMsg && pBlade.deflection() > 0.28) {
      ai.parryMsg = true;
      match.priority = 'opponent';
      showMessage('Parried!', 0.8);
      coach('Your attack was read. Prepare with the blade or change line.');
    }
    if (ai.attacking && !ai.beatMsg && oBlade.deflection() > 0.33) {
      ai.beatMsg = true;
      match.priority = 'player';
      showMessage('Deflected!', 0.7);
      if (session) { session.parries++; session.lastParryAt = performance.now(); }
      coach('Good deflection—finish the riposte while the opponent recovers.');
      // learn which side you habitually defend toward
      if (pBlade.tipNow.x > playerTarget.center.x) ai.memory.parryR++;
      else ai.memory.parryL++;
    }
  }
}

/* ---------------- Combat resolution ---------------- */

function registerTouch(side, zone = '') {
  if (match.phase !== 'fencing' && !match.lock) return;
  if (!match.lock) {
    match.lock = { timer: CONFIG.lockout, touches: {}, zones: {} };
    match.phase = 'lockout';
  }
  if (match.lock.touches[side]) return;
  match.lock.touches[side] = true;
  match.lock.zones[side] = zone;
  audio.buzzer(side === 'player' ? 520 : 440, 0.5);
  pulseHaptic(0.9, 120);
}

function resolveLock() {
  const t = match.lock.touches;
  const zones = match.lock.zones;
  match.lock = null;

  const pOn = !!t.player, oOn = !!t.opponent;
  const recentParry = !!(session?.lastParryAt && performance.now() - session.lastParryAt < 1500);
  setLights({ player: pOn, opp: oOn });

  const zoneTag = (z) => (z && z !== 'body' && z !== 'torso') ? ` — ${z}!` : '!';
  let msg = '';
  if (pOn && oOn) {
    match.scorePlayer++; match.scoreOpp++;
    if (session) { session.doubles++; session.touchesFor++; session.touchesAgainst++; }
    msg = 'Double touch!';
    coach('Double touch—recover behind the guard or control the opponent’s blade.');
  } else if (pOn) {
    match.scorePlayer++;
    if (session) {
      session.touchesFor++; session.cleanHits++; session.zones[zones.player] = (session.zones[zones.player] || 0) + 1;
      if (zones.player === 'arm' || zones.player === 'hand') session.handHits++;
      if (recentParry) session.ripostes++;
    }
    msg = 'Touch' + zoneTag(zones.player);
    if (match.mode === 'hand' && zones.player !== 'arm' && zones.player !== 'hand') coach('Valid touch, but this drill scores point control on the weapon arm.');
    else if (ai.attacking) coach('Good timing—your point arrived during the opponent’s action.');
    else coach(`Clean touch${zones.player ? ` to ${zones.player}` : ''}.`);
  } else if (oOn) {
    match.scoreOpp++;
    if (session) session.touchesAgainst++;
    msg = 'Touch against' + zoneTag(zones.opponent);
    coach(ai.attacking ? 'Late defense—meet the blade earlier or make the opponent fall short.' : 'You entered distance without control. Reset the measure.');
  }

  if (match.mode === 'hand' && pOn && !oOn && zones.player !== 'arm' && zones.player !== 'hand') match.scorePlayer--;
  if (match.mode === 'parry' && pOn && !oOn && !recentParry) { match.scorePlayer--; coach('Touch landed, but the drill scores only an immediate riposte after blade contact.'); }
  if (match.mode === 'stop' && pOn && !oOn && !ai.attacking) { match.scorePlayer--; coach('Touch landed outside the attack. Wait for the preparation, then stop-hit in tempo.'); }
  if (match.mode === 'double' && pOn && oOn) match.scorePlayer = Math.max(0, match.scorePlayer - 2);

  showMessage(msg, CONFIG.resetPause);
  match.phase = 'halt';
  match.haltTimer = CONFIG.resetPause;
  updateHud();
  updateDrillHud();

  if (match.overtime || match.scorePlayer >= CONFIG.boutScore || (match.mode === 'bout' && match.scoreOpp >= CONFIG.boutScore)) {
    endBout();
  }
}

function endBout() {
  match.phase = 'over';
  const won = match.mode === 'bout' ? match.scorePlayer > match.scoreOpp : match.scorePlayer >= TRAINING_MODES[match.mode].score;
  showMessage(won ? 'Session complete!' : 'Time — review your session', 3);
  setTimeout(showSessionReport, 900);
}

function showSessionReport() {
  match.started = false; match.paused = false;
  drill.active = false;
  drillMesh.visible = false;
  document.exitPointerLock?.();
  document.getElementById('drillHud').style.display = 'none';
  const s = session || freshSession();
  const accuracy = s.attacks ? Math.round((s.touchesFor / s.attacks) * 100) : 0;
  const parryRate = s.parries ? Math.round((s.ripostes / s.parries) * 100) : 0;
  const cleanRate = s.touchesFor ? Math.round((s.cleanHits / s.touchesFor) * 100) : 0;
  const mode = TRAINING_MODES[match.mode];
  const summary = { date: Date.now(), mode: match.mode, style: match.style, scoreFor: match.scorePlayer, scoreAgainst: match.scoreOpp, accuracy, doubles: s.doubles };
  saveSession(summary);
  document.getElementById('menuMain').style.display = 'none';
  document.getElementById('report').style.display = 'block';
  document.getElementById('reportResult').textContent = `${mode.label} · ${match.scorePlayer}–${match.scoreOpp} · ${OPPONENT_STYLES[match.style] ? match.style : 'adaptive'} opponent`;
  const metrics = [
    [accuracy + '%', 'attack conversion'], [s.cleanHits, 'clean touches'], [s.doubles, 'double touches'],
    [s.parries, 'parries'], [parryRate + '%', 'riposte conversion'],
    match.mode === 'target'
      ? [drill.reactions.length ? Math.round(drill.reactions.reduce((a, b) => a + b, 0) / drill.reactions.length * 1000) + 'ms' : '—', 'avg reaction']
      : [match.mode === 'distance' ? Math.floor(s.measureTime) + 's' : cleanRate + '%', match.mode === 'distance' ? 'time in measure' : 'clean-hit rate'],
  ];
  document.getElementById('reportGrid').innerHTML = metrics.map(([v,l]) => `<div class="metric"><b>${v}</b><span>${l}</span></div>`).join('');
  let advice = 'Build the next session around distance: arrive in measure with the point threatening, then leave after the action.';
  if (s.doubles >= 3) advice = 'Priority focus: reduce double touches. Control the blade or make the opponent fall short before finishing.';
  else if (s.parries >= 2 && parryRate < 40) advice = 'Your defense is finding the blade, but the riposte is late. Make the return immediately from the parry.';
  else if (accuracy < 25 && s.attacks >= 4) advice = 'Your attack volume is high relative to conversion. Wait for a clearer distance or create the opening with a beat or disengage.';
  else if (s.handHits >= 3) advice = 'Strong point control on the weapon arm. Next, combine the hand threat with a body finish when the guard reacts.';
  document.getElementById('reportCoach').textContent = advice;
  const history = getHistory();
  const prev = history[1];
  document.getElementById('historyLine').textContent = prev ? `Previous ${TRAINING_MODES[prev.mode]?.label || 'session'}: ${prev.scoreFor}–${prev.scoreAgainst}, ${prev.accuracy}% conversion` : 'Your results are now saved on this device.';
  hud.overlay.style.display = 'flex';
}

function resetPhrase() {
  opp.group.position.z = -2;
  ai.vel = 0;
  ai.ext = 0.15;
  ai.reactTimer = 0; ai.attacking = false;
  ai.plan = null; ai.aimFrozen = false;
  aiSetState('engarde');
  if (!renderer.xr.isPresenting) rig.position.z = 2;
  else {
    const head = new THREE.Vector3();
    camera.getWorldPosition(head);
    rig.position.z += 2 - head.z;
    rig.position.x -= head.x;
  }
  desktop.lungeT = 0;
  pBlade.reset();
  oBlade.reset();
  crossState.side = 0;
  match.priority = null;
  setLights({});
  match.phase = 'fencing';
  showMessage('En garde … Allez!', 1.0);
}

/* ---------------- Target drill: accuracy + reaction + technique ---------------- */

const drill = {
  active: false,
  phase: 'return',      // return (recover to guard) → wait (random delay) → live
  t: 0, delay: 0, window: 1.7,
  spot: null,
  targetPos: new THREE.Vector3(),
  hits: 0, misses: 0, streak: 0,
  reactions: [],
  lastMs: 0,
  flash: 0,
};

// weighted toward hand/forearm — épée bread and butter
const DRILL_SPOTS = [
  { name: 'hand', node: () => opp.hand, r: 0.055, w: 3 },
  { name: 'forearm', node: () => opp.forearm, r: 0.06, w: 3 },
  { name: 'upper arm', node: () => opp.upperArm, r: 0.06, w: 2 },
  { name: 'chest', node: () => opp.torso, r: 0.07, w: 2 },
  { name: 'mask', node: () => opp.head, r: 0.06, w: 1.5 },
  { name: 'thigh', node: () => opp.legF.hip.children[0], r: 0.065, w: 1.5 },
  { name: 'foot', node: () => opp.legF.knee.children[1], r: 0.055, w: 1 },
];

const drillMesh = new THREE.Mesh(
  new THREE.SphereGeometry(1, 18, 14),
  new THREE.MeshBasicMaterial({ color: 0xffd34d, transparent: true, opacity: 0.85 })
);
drillMesh.visible = false;
scene.add(drillMesh);

function drillPickSpot() {
  let sum = 0;
  for (const s of DRILL_SPOTS) sum += s.w;
  let r = Math.random() * sum;
  for (const s of DRILL_SPOTS) { r -= s.w; if (r <= 0) return s; }
  return DRILL_SPOTS[0];
}

function drillResult(hit, msg) {
  if (hit) {
    drill.hits++; drill.streak++;
    drill.lastMs = Math.round(drill.t * 1000);
    drill.reactions.push(drill.t);
    drill.flash = 0.25;
    match.scorePlayer++;
    if (session) {
      session.attacks++; session.touchesFor++; session.cleanHits++;
      if (drill.spot && (drill.spot.name === 'hand' || drill.spot.name === 'forearm')) session.handHits++;
    }
    audio.buzzer(1500, 0.1, 'sine', 0.2);
    audio.buzzer(2000, 0.14, 'sine', 0.12);
    showMessage(`${drill.lastMs} ms`, 0.9);
    pulseHaptic(0.7, 60);
  } else {
    drill.misses++; drill.streak = 0;
    match.scoreOpp++;
    if (session) session.attacks++;
    audio.buzzer(170, 0.25, 'square', 0.14);
    showMessage(msg, 0.9);
  }
  drill.phase = 'return';
  drill.t = 0;
  drillMesh.visible = false;
  updateHud();
}

function updateDrill(dt) {
  if (!drill.active) return;
  drill.flash = Math.max(0, drill.flash - dt);
  drillMesh.material.color.set(drill.flash > 0 ? 0x35e065 : 0xffd34d);

  playerTarget.update();
  const tipOut = Math.abs(playerTarget.center.z - pBlade.tipNow.z);

  switch (drill.phase) {
    case 'return': { // no camping extended — recover to guard between reps
      if (tipOut < 1.35) {
        drill.t += dt;
        if (drill.t > 0.2) {
          drill.phase = 'wait';
          drill.t = 0;
          drill.delay = 0.6 + Math.random() * 1.8;
        }
      } else drill.t = 0;
      break;
    }
    case 'wait': {
      drill.t += dt;
      if (drill.t >= drill.delay) {
        drill.spot = drillPickSpot();
        drill.window = Math.max(0.85, 1.7 - drill.streak * 0.06);
        drill.phase = 'live';
        drill.t = 0;
        drillMesh.visible = true;
        audio.buzzer(880, 0.09, 'sine', 0.18);
      }
      break;
    }
    case 'live': {
      drill.t += dt;
      if (drill.t > drill.window) drillResult(false, 'Too slow');
      break;
    }
  }

  if (drill.spot && drillMesh.visible) {
    drill.spot.node().getWorldPosition(drill.targetPos);
    drillMesh.position.copy(drill.targetPos);
    drillMesh.scale.setScalar(drill.spot.r * (1 + 0.15 * Math.sin(drill.t * 12)));
  }
}

// same force gates as a real touch — slaps and grazes don't count
function drillCombat() {
  if (!drill.active || drill.phase !== 'live') return;
  const pSpeed = pTipVel.length();
  if (pSpeed < 1e-3) return;
  const axial = pTipVel.dot(pBlade.dir);
  const alignment = axial / pSpeed;
  if (axial < CONFIG.touch.axialSpeed || alignment < CONFIG.touch.alignment) return;

  drill.spot.node().getWorldPosition(drill.targetPos);
  if (pointSegmentDistance(drill.targetPos, pBlade.tipPrev, pBlade.tipNow) < drill.spot.r + 0.02) {
    _t3.subVectors(drill.targetPos, pBlade.tipNow).normalize();
    if (pBlade.dir.dot(_t3) >= CONFIG.touch.pointFirst - 0.1) {
      drillResult(true);
      return;
    }
  }
  // a clean touch anywhere else = wrong spot
  for (const part of opp.parts) {
    const c = _t1.setFromMatrixPosition(part.node.matrixWorld);
    if (pointSegmentDistance(c, pBlade.tipPrev, pBlade.tipNow) < part.radius) {
      _t3.subVectors(c, pBlade.tipNow).normalize();
      if (pBlade.dir.dot(_t3) >= CONFIG.touch.pointFirst) drillResult(false, 'Wrong spot');
      return;
    }
  }
}

const _flexKick = new THREE.Vector3();

function updateCombat(dt) {
  if (match.phase !== 'fencing' && match.phase !== 'lockout') return;
  if (match.mode === 'target') { drillCombat(); return; }

  const W = WEAPONS[weaponKey];

  // ---- player scoring: physical tip, thrust-force model ----
  // valid épée touch: the swept tip crosses the target AND the tip is being
  // driven along the blade axis (the 750g-tip-force proxy) — not slapped across it
  const pSpeed = pTipVel.length();
  if (pSpeed > 1e-3) {
    const axial = pTipVel.dot(pBlade.dir);
    const alignment = axial / pSpeed;
    if (axial > CONFIG.touch.axialSpeed && alignment > CONFIG.touch.alignment) {
      for (const part of opp.parts) {
        const c = _t1.setFromMatrixPosition(part.node.matrixWorld);
        if (pointSegmentDistance(c, pBlade.tipPrev, pBlade.tipNow) < part.radius) {
          // point-first: the blade axis must drive into the surface, not skid across it
          _t3.subVectors(c, pBlade.tipNow).normalize();
          if (pBlade.dir.dot(_t3) < CONFIG.touch.pointFirst) break;
          if (W.target.includes(part.zone)) {
            registerTouch('player', part.zone);
            // blade bows on the touch
            _flexKick.copy(pTipVel).addScaledVector(pBlade.dir, -axial);
            if (_flexKick.lengthSq() < 1e-4) _flexKick.set(0, 1, 0);
            _t2.crossVectors(pBlade.dir, _flexKick.normalize());
            if (_t2.lengthSq() > 1e-6) pBlade.kickFlex(Math.min(3, axial * 0.8), _t2.normalize());
          }
          break;
        }
      }
    }
  }

  // ---- opponent scoring: same force model against the full player target set ----
  const oSpeed = oTipVel.length();
  if (ai.attacking && oSpeed > 1e-3) {
    const axialO = oTipVel.dot(oBlade.dir);
    const alignO = axialO / oSpeed;
    if (axialO > CONFIG.touch.axialSpeed * 0.8 && alignO > CONFIG.touch.alignment) {
      updatePlayerVols();
      for (const v of playerVols) {
        if (pointSegmentDistance(v.pos, oBlade.tipPrev, oBlade.tipNow) >= v.radius) continue;
        // the bell guard blocks shots coming straight down the weapon line —
        // hand touches need angulation (or your blade wandering off line)
        if (v.zone === 'hand' && oBlade.dir.dot(pBlade.dir) < -0.85) continue;
        _t3.subVectors(v.pos, oBlade.tipNow).normalize();
        if (oBlade.dir.dot(_t3) < CONFIG.touch.pointFirst) break;
        registerTouch('opponent', v.zone);
        _t2.crossVectors(oBlade.dir, _t1.set(0, 1, 0));
        if (_t2.lengthSq() > 1e-6) oBlade.kickFlex(Math.min(3, axialO * 0.8), _t2.normalize());
        aiSetState('recover');
        break;
      }
    }
  }

  if (match.lock) {
    match.lock.timer -= dt;
    if (match.lock.timer <= 0) resolveLock();
  }
}

/* ---------------- Desktop controls ---------------- */

const desktop = {
  yaw: 0, pitch: 0,
  thrustT: 0,
  thrusting: false,
  lunge: false,
  lungeT: 0,
  keys: {},
  pointerLocked: false,
};

renderer.domElement.addEventListener('click', () => {
  if (!match.started || renderer.xr.isPresenting) return;
  if (!desktop.pointerLocked) renderer.domElement.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  desktop.pointerLocked = document.pointerLockElement === renderer.domElement;
});

document.addEventListener('mousemove', (e) => {
  if (!desktop.pointerLocked) return;
  desktop.yaw -= e.movementX * 0.0022;
  desktop.pitch -= e.movementY * 0.0022;
  desktop.yaw = THREE.MathUtils.clamp(desktop.yaw, -0.9, 0.9);
  desktop.pitch = THREE.MathUtils.clamp(desktop.pitch, -0.7, 0.6);
});

document.addEventListener('mousedown', (e) => {
  if (!desktop.pointerLocked || match.phase !== 'fencing') return;
  audio.ensure();
  desktop.thrusting = true;
  if (session) { session.attacks++; session.lastAttackAt = performance.now(); }
  if (e.shiftKey) desktop.lunge = true;
  if (!match.priority) match.priority = 'player';
});
document.addEventListener('mouseup', () => {
  desktop.thrusting = false;
  desktop.lunge = false;
});

document.addEventListener('keydown', (e) => {
  desktop.keys[e.code] = true;
  if (e.code === 'Escape' && match.started) {
    match.paused = true;
    hud.overlay.style.display = 'flex';
    document.getElementById('report').style.display = 'none';
    document.getElementById('menuMain').style.display = 'block';
    document.getElementById('menuTitle').style.display = 'none';
    document.getElementById('pauseTitle').style.display = 'block';
    document.getElementById('resumeBtn').style.display = 'inline-block';
    document.getElementById('startBtn').textContent = 'RESTART SESSION';
  }
});
document.addEventListener('keyup', (e) => { desktop.keys[e.code] = false; });

function updateDesktop(dt) {
  if (renderer.xr.isPresenting) return;

  let move = 0;
  if (desktop.keys['KeyW']) move -= 1;
  if (desktop.keys['KeyS']) move += 1;
  if (match.phase === 'fencing') {
    rig.position.z += move * 1.6 * dt;
    rig.position.z = THREE.MathUtils.clamp(rig.position.z, 0.6, 6.8);
  }

  camera.position.set(0, 1.62, 0);
  camera.rotation.set(desktop.pitch * 0.12, desktop.yaw * 0.12, 0);

  // thrust: fixed-duration extension (~0.22s out, 0.3s back) so it moves at human speed
  desktop.thrustT = THREE.MathUtils.clamp(
    desktop.thrustT + (desktop.thrusting ? dt / 0.22 : -dt / 0.3), 0, 1);

  // lunge carries the whole rig forward (~0.35s out, 0.5s recover)
  const prevLunge = desktop.lungeT;
  desktop.lungeT = THREE.MathUtils.clamp(
    desktop.lungeT + (desktop.lunge ? dt / 0.35 : -dt / 0.5), 0, 1);
  if (match.phase === 'fencing') rig.position.z += (prevLunge - desktop.lungeT) * 0.85;

  handAnchor.rotation.set(desktop.pitch, desktop.yaw, 0);
  handAnchor.position.set(0.22, 1.25 - desktop.thrustT * 0.06, -0.35 - desktop.thrustT * 0.42);
}

/* ---------------- VR controls ---------------- */

let vrWeaponController = null;
let vrOffhandController = null;
const controllers = [renderer.xr.getController(0), renderer.xr.getController(1)];
const grips = [renderer.xr.getControllerGrip(0), renderer.xr.getControllerGrip(1)];
controllers.forEach((c) => rig.add(c));
grips.forEach((g) => rig.add(g));

controllers.forEach((controller, i) => {
  controller.addEventListener('connected', (e) => {
    controller.userData.handedness = e.data.handedness;
    controller.userData.gamepad = e.data.gamepad;
    if (e.data.handedness === 'right') {
      vrWeaponController = { controller, grip: grips[i] };
      attachSwordToVR();
    } else {
      vrOffhandController = { controller, grip: grips[i] };
    }
  });
  controller.addEventListener('selectstart', () => {
    if (controller.userData.handedness === 'right' && match.phase === 'fencing') {
      if (!match.priority) match.priority = 'player';
      if (session) { session.attacks++; session.lastAttackAt = performance.now(); }
    }
  });
});

function attachSwordToVR() {
  handAnchor.remove(playerSword);
  playerSword.position.set(0, 0, 0.02);
  playerSword.rotation.set(-0.5, 0, 0);
  vrWeaponController.grip.add(playerSword);
  pBlade.reset();
}

renderer.xr.addEventListener('sessionstart', () => {
  if (vrWeaponController) attachSwordToVR();
  rig.position.set(0, 0, 2);
});
renderer.xr.addEventListener('sessionend', () => {
  if (vrWeaponController) vrWeaponController.grip.remove(playerSword);
  playerSword.position.set(0, 0, 0);
  playerSword.rotation.set(0, 0, 0);
  handAnchor.add(playerSword);
  pBlade.reset();
});

function updateVR(dt) {
  if (!renderer.xr.isPresenting) return;
  const off = vrOffhandController?.controller.userData.gamepad;
  if (off && off.axes.length >= 4 && match.phase === 'fencing') {
    const v = off.axes[3];
    if (Math.abs(v) > 0.15) {
      rig.position.z += v * 1.8 * dt;
      rig.position.z = THREE.MathUtils.clamp(rig.position.z, -6.8, 6.8);
    }
  }
}

function pulseHaptic(intensity, ms) {
  const gp = vrWeaponController?.controller.userData.gamepad;
  const act = gp?.hapticActuators?.[0];
  if (act?.pulse) act.pulse(Math.min(1, intensity), ms);
}

/* ---------------- Menu ---------------- */

function applyInertiaSetting() {
  pBlade.stiffness = CONFIG.bladeInertia ? PH.inertiaK : PH.gripK;
  pBlade.damping = CONFIG.bladeInertia ? PH.inertiaD : PH.gripD;
}
applyInertiaSetting();

const inertiaChk = document.getElementById('inertiaChk');
if (inertiaChk) {
  inertiaChk.checked = CONFIG.bladeInertia;
  inertiaChk.addEventListener('change', () => {
    CONFIG.bladeInertia = inertiaChk.checked;
    applyInertiaSetting();
  });
}

function selectChoice(groupId, key, attr) {
  document.querySelectorAll(`#${groupId} .choice`).forEach((b) => b.classList.toggle('sel', b.dataset[attr] === key));
}

document.querySelectorAll('#modeChoices .choice').forEach((btn) => btn.addEventListener('click', () => {
  match.mode = btn.dataset.mode; selectChoice('modeChoices', match.mode, 'mode');
  document.getElementById('modeDesc').textContent = TRAINING_MODES[match.mode].objective;
}));
document.querySelectorAll('#styleChoices .choice').forEach((btn) => btn.addEventListener('click', () => {
  match.style = btn.dataset.style; selectChoice('styleChoices', match.style, 'style');
}));

try {
  const prefs = JSON.parse(localStorage.getItem('epeePrefs') || '{}');
  if (TRAINING_MODES[prefs.mode]) match.mode = prefs.mode;
  if (OPPONENT_STYLES[prefs.style]) match.style = prefs.style;
  if (typeof prefs.inertia === 'boolean') { CONFIG.bladeInertia = prefs.inertia; inertiaChk.checked = prefs.inertia; applyInertiaSetting(); }
  selectChoice('modeChoices', match.mode, 'mode'); selectChoice('styleChoices', match.style, 'style');
  document.getElementById('modeDesc').textContent = TRAINING_MODES[match.mode].objective;
} catch (_) {}

function openMainMenu() {
  document.getElementById('report').style.display = 'none';
  document.getElementById('menuMain').style.display = 'block';
  document.getElementById('menuTitle').style.display = 'block';
  document.getElementById('pauseTitle').style.display = 'none';
  document.getElementById('resumeBtn').style.display = 'none';
  document.getElementById('startBtn').textContent = 'START SESSION';
}

function startSession() {
  audio.ensure();
  const mode = TRAINING_MODES[match.mode];
  CONFIG.boutScore = mode.score; CONFIG.boutTime = mode.time;
  applyOpponentStyle(match.style);
  hud.overlay.style.display = 'none';
  document.getElementById('report').style.display = 'none';
  match.started = true; match.paused = false; match.overtime = false;
  match.scorePlayer = 0; match.scoreOpp = 0; match.time = mode.time;
  session = freshSession();
  ai.memory.parryL = 0; ai.memory.parryR = 0; ai.memory.playerAdvances = 0;
  drill.active = match.mode === 'target';
  drill.phase = 'return'; drill.t = 0;
  drill.hits = 0; drill.misses = 0; drill.streak = 0;
  drill.reactions = []; drill.lastMs = 0;
  drillMesh.visible = false;
  updateHud(); updateDrillHud(); resetPhrase();
  coach(mode.objective, 3.4);
  if (!renderer.xr.isPresenting) renderer.domElement.requestPointerLock();
}

document.getElementById('startBtn').addEventListener('click', () => {
  startSession();
});

document.getElementById('resumeBtn').addEventListener('click', () => {
  match.paused = false; hud.overlay.style.display = 'none';
  if (!renderer.xr.isPresenting) renderer.domElement.requestPointerLock();
});
document.getElementById('menuBtn').addEventListener('click', openMainMenu);
document.getElementById('againBtn').addEventListener('click', startSession);

/* ---------------- Main loop ---------------- */

const clock = new THREE.Clock();
updateHud();

// Debug/test hook (harmless in production; lets automated tests drive the sim)
window.SIM = { match, desktop, rig, opp, ai, CONFIG, WEAPONS, playerSword, pBlade, oBlade, applyInertiaSetting, aiSetState, choosePlan, playerVols, drill, drillMesh };

function step(dt) {
  window.__testTick?.(dt);

  if (match.started && !match.paused) {
    if (match.phase === 'fencing' || match.phase === 'lockout') {
      match.time = Math.max(0, match.time - dt);
      if (session) {
        session.totalFencingTime += dt;
        const dist = Math.abs(opp.group.position.z - playerTarget.center.z);
        if (dist >= 1.85 && dist <= 2.35) session.measureTime += dt;
      }
      if (match.time === 0 && match.phase === 'fencing') {
        if (match.mode === 'bout' && match.scorePlayer === match.scoreOpp && !match.overtime) {
          match.overtime = true; match.time = 60; showMessage('Priority minute — sudden death', 2.5); coach('Scores are tied. The next touch wins.');
        } else endBout();
      }
    }
    if (match.phase === 'halt') {
      match.haltTimer -= dt;
      if (match.haltTimer <= 0) resetPhrase();
    }

    updateDesktop(dt);
    updateVR(dt);
    updateOpponent(dt);
    stepBladePhysics(dt);
    updateCombat(dt);
    if (match.mode === 'target') updateDrill(dt);
    updateDrillHud();

    if (Math.floor(match.time) !== Math.floor(match.time + dt)) updateHud();
  } else {
    updateDesktop(dt);
    updateOpponent(dt);
    stepBladePhysics(dt);
  }

  updateBladeVisual(playerSword, pBlade);
  updateBladeVisual(opp.sword, oBlade);

  renderer.render(scene, camera);
}

window.SIM.step = step;
renderer.setAnimationLoop(() => step(Math.min(clock.getDelta(), 0.05)));
