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
    contactRadius: 0.028,  // blade-to-blade contact distance (with flex contact patch)
    pressOvershoot: 2.2,   // separation factor under an active press — the carry ratchet
    idleOvershoot: 1.2,    // gentle ratchet for incidental contact
    restitution: 0.2,
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
    reaction: 0.12,        // s to react to a fast blade (body reads take +0.1s)
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
    this.init = false;
  }

  reset() {
    this.init = false;
    this.dirVel.set(0, 0, 0);
    this.flex = 0; this.flexVel = 0;
    this.shock = 0;
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
    // a hard beat momentarily loosens the grip so displacement sticks
    this.shock = Math.max(0, this.shock - dt);
    const k = this.shock > 0 ? this.stiffness * 0.25 : this.stiffness;
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
const _tA = new THREE.Vector3(), _tB = new THREE.Vector3();

// one blade-vs-blade contact solve; returns event info or null
function bladeContact(A, B) {
  A.tip(_tA); B.tip(_tB);
  closestSegSeg(A.root, _tA, B.root, _tB, _sp);
  if (_sp.dist >= PH.contactRadius) return null;

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

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.42, 6, 14), jacket);
  torso.position.set(0, 1.12, 0);
  torso.rotation.x = 0.14;
  torso.castShadow = true;
  o.add(torso);
  parts.push({ node: torso, zone: 'torso', radius: 0.21 });

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

  const frontThigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.34, 4, 10), breeches);
  frontThigh.position.set(0.02, 0.72, 0.16); frontThigh.rotation.x = 0.55;
  o.add(frontThigh);
  const frontShin = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.36, 4, 10), jacket);
  frontShin.position.set(0.02, 0.3, 0.34); frontShin.rotation.x = -0.15;
  o.add(frontShin);
  const backThigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.34, 4, 10), breeches);
  backThigh.position.set(-0.06, 0.72, -0.2); backThigh.rotation.x = -0.7; backThigh.rotation.z = 0.15;
  o.add(backThigh);
  const backShin = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.36, 4, 10), jacket);
  backShin.position.set(-0.09, 0.28, -0.38); backShin.rotation.x = 0.5;
  o.add(backShin);
  for (const leg of [frontThigh, frontShin, backThigh, backShin]) {
    leg.castShadow = true;
    parts.push({ node: leg, zone: 'leg', radius: 0.11 });
  }

  const backArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.3, 4, 10), jacket);
  backArm.position.set(-0.14, 1.28, -0.14); backArm.rotation.z = 0.9; backArm.rotation.x = -0.8;
  backArm.castShadow = true;
  o.add(backArm);
  parts.push({ node: backArm, zone: 'arm', radius: 0.1 });

  const armPivot = new THREE.Group();
  armPivot.position.set(0.16, 1.38, 0.1);
  o.add(armPivot);

  const upperArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.26, 4, 10), jacket);
  upperArm.rotation.x = Math.PI / 2;
  upperArm.position.z = 0.15;
  upperArm.castShadow = true;
  armPivot.add(upperArm);
  parts.push({ node: upperArm, zone: 'arm', radius: 0.1 });

  const forearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.24, 4, 10), jacket);
  forearm.rotation.x = Math.PI / 2;
  forearm.position.z = 0.4;
  forearm.castShadow = true;
  armPivot.add(forearm);
  parts.push({ node: forearm, zone: 'arm', radius: 0.09 });

  const sword = makeSword(0xb9bfca);
  sword.position.set(0, 0, 0.55);
  sword.rotation.y = Math.PI; // blade points +Z (toward player)
  armPivot.add(sword);

  scene.add(o);

  return { group: o, parts, armPivot, sword, torso, head };
}

const opp = buildOpponent();

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
};

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

  let desired = 0;
  let accel = M.maxAccel;
  let inTell = false;

  switch (ai.state) {
    case 'engarde': {
      ai.extTarget = 0.15;
      ai.attacking = false;
      if (dist > C.preferredDist + 0.25) aiSetState('advance');
      else if (dist < C.preferredDist - 0.35) aiSetState('retreat');
      else if (match.phase === 'fencing' && Math.random() < C.attackChance * dt) aiSetState('lunge');
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
      if (dist >= C.preferredDist || o.position.z < -6.5) aiSetState('engarde');
      break;
    }
    case 'lunge': {
      if (ai.stateTime < M.tellTime) {
        // preparation — readable if you watch for it
        inTell = true;
        ai.extTarget = 0.55;
      } else if (ai.stateTime < M.tellTime + M.driveTime) {
        // committed, ballistic drive — cannot abort
        ai.extTarget = 1;
        desired = M.lungeSpeed * sign;
        accel = M.lungeAccel;
        if (!ai.attacking) {
          ai.attacking = true;
          if (!match.priority) match.priority = 'opponent';
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
      if (ai.stateTime > 0.45 && Math.abs(ai.vel) < 0.25) {
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
  const closing = dt > 0 ? (ai.prevDist - dist) / dt : 0;
  ai.prevDist = dist;
  const committed = (ai.state === 'lunge' && ai.stateTime >= M.tellTime) ||
                    ai.state === 'riposte' || ai.state === 'parry' || ai.state === 'recover';
  if (!committed && match.phase === 'fencing') {
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

  const bobY = Math.sin(ai.bob * 2.1) * 0.015 + Math.sin(ai.bob * 5.3) * 0.006;
  const dip = inTell ? 0.03 * (ai.stateTime / M.tellTime) : (ai.attacking ? 0.06 : 0);
  o.position.y = bobY - dip;

  const faceDir = sign;
  o.rotation.y = faceDir > 0 ? 0 : Math.PI;

  // weapon arm: aim at the player's chest; during a parry, drive at the player's blade
  const arm = opp.armPivot;
  const target = _t2.set(playerTarget.center.x, playerTarget.center.y + 0.15, playerTarget.center.z);
  if (ai.state === 'parry') {
    // opposition: aim through the player's blade, gliding from their foible
    // toward their forte — the rods stay crossed so the press never breaks
    const slide = THREE.MathUtils.lerp(0.6, 0.2, THREE.MathUtils.clamp(ai.stateTime / 0.3, 0, 1));
    _t3.copy(pBlade.root).addScaledVector(pBlade.dir, slide * pBlade.len);
    target.copy(_t3);
    // follow-offset: always press a little past wherever the blade is now,
    // so the carry is sustained as the blade gives ground
    target.x += ai.parryDir * PH.parryPress;
  }

  // once the drive is committed the arm is ballistic — no mid-lunge re-aiming.
  // this is what makes beats, deflections and dodges pay off.
  if (ai.attacking && (ai.state === 'lunge' || ai.state === 'riposte')) {
    if (!ai.aimFrozen) { ai.aimFrozen = true; ai.frozenAim.copy(target); }
    target.copy(ai.frozenAim);
  } else {
    ai.aimFrozen = false;
  }
  arm.updateMatrixWorld();
  const armPos = _t3.setFromMatrixPosition(arm.matrixWorld);
  const aim = _t1.subVectors(target, armPos).normalize();

  const relaxedPitch = -0.25, relaxedYaw = faceDir > 0 ? 0.15 : Math.PI - 0.15;
  const aimYaw = Math.atan2(aim.x, aim.z);
  const aimPitch = -Math.asin(THREE.MathUtils.clamp(aim.y, -1, 1)) + 0.02;
  const localYaw = faceDir > 0 ? aimYaw : aimYaw - Math.PI;

  // a parry aims the blade precisely regardless of arm extension
  const aimBlend = ai.state === 'parry' ? 1 : ai.ext;
  const yaw = THREE.MathUtils.lerp(relaxedYaw - (faceDir > 0 ? 0 : Math.PI), localYaw, aimBlend);
  const pitch = THREE.MathUtils.lerp(relaxedPitch, aimPitch, aimBlend);

  arm.rotation.set(pitch, yaw, 0);
  opp.sword.position.z = 0.55 + ai.ext * 0.25;

  // grip strength by intent
  oBlade.stiffness = ai.state === 'parry' ? PH.oppParryK : (ai.attacking ? PH.oppAttackK : PH.oppGuardK);
  oBlade.damping = 1.7 * Math.sqrt(oBlade.stiffness);
  oBlade.yield = ai.state === 'parry' ? PH.parryYield : 1;
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

  // --- contact feedback: sound + haptics scaled by impact, pitched by position ---
  clashTimer -= dt; scrapeTimer -= dt;
  if (strongest) {
    if (strongest.impact > 0.55 && clashTimer <= 0) {
      clashTimer = 0.1;
      const inten = Math.min(1, strongest.impact / 4);
      audio.clash(inten, strongest.sB);
      pulseHaptic(0.25 + 0.7 * inten, 18 + inten * 35);
      // hard beats visibly shiver the blades
      _t1.crossVectors(pBlade.dir, oBlade.dir);
      if (_t1.lengthSq() > 1e-6) {
        pBlade.kickFlex(strongest.impact * 0.25, _t1.normalize());
        oBlade.kickFlex(-strongest.impact * 0.25, _t1);
      }
    } else if (strongest.slide > 0.35 && scrapeTimer <= 0) {
      scrapeTimer = 0.08;
      audio.scrape(Math.min(1, strongest.slide / 2.5));
      pulseHaptic(0.15, 12);
    }
  }

  // --- emergent parry/beat messages from actual blade deflection ---
  if (match.phase === 'fencing') {
    if (ai.state === 'parry' && !ai.parryMsg && pBlade.deflection() > 0.28) {
      ai.parryMsg = true;
      match.priority = 'opponent';
      showMessage('Parried!', 0.8);
    }
    if (ai.attacking && !ai.beatMsg && oBlade.deflection() > 0.33) {
      ai.beatMsg = true;
      match.priority = 'player';
      showMessage('Deflected!', 0.7);
    }
  }
}

/* ---------------- Combat resolution ---------------- */

function registerTouch(side) {
  if (match.phase !== 'fencing' && !match.lock) return;
  if (!match.lock) {
    match.lock = { timer: CONFIG.lockout, touches: {} };
    match.phase = 'lockout';
  }
  if (match.lock.touches[side]) return;
  match.lock.touches[side] = true;
  audio.buzzer(side === 'player' ? 520 : 440, 0.5);
  pulseHaptic(0.9, 120);
}

function resolveLock() {
  const t = match.lock.touches;
  match.lock = null;

  const pOn = !!t.player, oOn = !!t.opponent;
  setLights({ player: pOn, opp: oOn });

  let msg = '';
  if (pOn && oOn) {
    match.scorePlayer++; match.scoreOpp++;
    msg = 'Double touch!';
  } else if (pOn) {
    match.scorePlayer++;
    msg = 'Touch!';
  } else if (oOn) {
    match.scoreOpp++;
    msg = 'Touch against';
  }

  showMessage(msg, CONFIG.resetPause);
  match.phase = 'halt';
  match.haltTimer = CONFIG.resetPause;
  updateHud();

  if (match.scorePlayer >= CONFIG.boutScore || match.scoreOpp >= CONFIG.boutScore) {
    endBout();
  }
}

function endBout() {
  match.phase = 'over';
  const won = match.scorePlayer > match.scoreOpp;
  showMessage(won ? '🏆 Bout won!' : 'Bout lost — again!', 5);
  setTimeout(() => { hud.overlay.style.display = 'flex'; match.started = false; }, 2600);
}

function resetPhrase() {
  opp.group.position.z = -2;
  ai.vel = 0;
  ai.ext = 0.15;
  ai.reactTimer = 0; ai.attacking = false;
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
  match.priority = null;
  setLights({});
  match.phase = 'fencing';
  showMessage('En garde … Allez!', 1.0);
}

const _flexKick = new THREE.Vector3();

function updateCombat(dt) {
  if (match.phase !== 'fencing' && match.phase !== 'lockout') return;

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
            registerTouch('player');
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

  // ---- opponent scoring: same force model against the player capsule ----
  playerTarget.update();
  const oSpeed = oTipVel.length();
  if (ai.attacking && oSpeed > 1e-3) {
    const axialO = oTipVel.dot(oBlade.dir);
    const alignO = axialO / oSpeed;
    _t3.subVectors(playerTarget.center, oBlade.tipNow).normalize();
    if (axialO > CONFIG.touch.axialSpeed * 0.8 && alignO > CONFIG.touch.alignment &&
        oBlade.dir.dot(_t3) > CONFIG.touch.pointFirst &&
        pointSegmentDistance(playerTarget.center, oBlade.tipPrev, oBlade.tipNow) < playerTarget.radius + 0.12) {
      registerTouch('opponent');
      _t2.crossVectors(oBlade.dir, _t1.set(0, 1, 0));
      if (_t2.lengthSq() > 1e-6) oBlade.kickFlex(Math.min(3, axialO * 0.8), _t2.normalize());
      aiSetState('recover');
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
    hud.overlay.style.display = 'flex';
    match.started = false;
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

document.getElementById('startBtn').addEventListener('click', () => {
  audio.ensure();
  hud.overlay.style.display = 'none';
  match.started = true;
  match.scorePlayer = 0;
  match.scoreOpp = 0;
  match.time = CONFIG.boutTime;
  updateHud();
  resetPhrase();
  if (!renderer.xr.isPresenting) renderer.domElement.requestPointerLock();
});

/* ---------------- Main loop ---------------- */

const clock = new THREE.Clock();
updateHud();

// Debug/test hook (harmless in production; lets automated tests drive the sim)
window.SIM = { match, desktop, rig, opp, ai, CONFIG, WEAPONS, playerSword, pBlade, oBlade, applyInertiaSetting };

function step(dt) {
  window.__testTick?.(dt);

  if (match.started) {
    if (match.phase === 'fencing' || match.phase === 'lockout') {
      match.time = Math.max(0, match.time - dt);
      if (match.time === 0 && match.phase === 'fencing') {
        endBout();
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
