import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';

/* ============================================================
   Fencing Simulator — WebXR (Quest browser) + desktop test mode
   Piste runs along the Z axis. Player starts at z=+2 facing -Z,
   opponent at z=-2 facing +Z. Units are meters.
   ============================================================ */

const CONFIG = {
  boutScore: 15,
  boutTime: 180,           // seconds
  lockout: 0.25,           // double-touch lockout window (s)
  touchSpeed: 1.1,         // min tip speed (m/s) for a valid thrust
  cutSpeed: 2.2,           // min lateral tip speed for a sabre cut
  clashDist: 0.075,        // blade-to-blade contact distance
  resetPause: 1.6,         // pause after a touch (s)
  piste: { length: 14, width: 1.5 },
  opponent: {
    preferredDist: 2.05,   // fencing measure they try to keep
    speed: 1.5,            // footwork speed m/s
    lungeSpeed: 3.4,
    lungeReach: 1.05,
    attackChance: 0.55,    // per second, when in distance
    parryChance: 0.72,     // chance to attempt parry on incoming thrust
    reaction: 0.07,        // seconds before parry starts
  },
};

const WEAPONS = {
  epee: { label: 'Épée', target: ['torso', 'head', 'arm', 'leg'], offTarget: [], cuts: false },
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

  // Gym floor
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 60),
    new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.9 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  // Piste (metallic strip)
  const { length: L, width: W } = CONFIG.piste;
  const piste = new THREE.Mesh(
    new THREE.BoxGeometry(W, 0.02, L),
    new THREE.MeshStandardMaterial({ color: 0x8a8f98, roughness: 0.35, metalness: 0.75 })
  );
  piste.position.y = 0.01;
  piste.receiveShadow = true;
  scene.add(piste);

  // Piste lines: center, en-garde (±2m), warning (±5m), end (±7m)
  const lineMat = new THREE.MeshStandardMaterial({ color: 0xe8eaf0, roughness: 0.5 });
  const zs = [0, 2, -2, 5, -5, 6.9, -6.9];
  for (const z of zs) {
    const line = new THREE.Mesh(new THREE.BoxGeometry(W, 0.022, 0.05), lineMat);
    line.position.set(0, 0.012, z);
    scene.add(line);
  }
  // Warning zones (last 2m) tinted
  for (const s of [1, -1]) {
    const warn = new THREE.Mesh(
      new THREE.BoxGeometry(W, 0.021, 2),
      new THREE.MeshStandardMaterial({ color: 0xa03c3c, roughness: 0.5, metalness: 0.4 })
    );
    warn.position.set(0, 0.011, s * 6);
    scene.add(warn);
  }

  // Simple gym walls for depth cues
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x1b2029, roughness: 1 });
  const backA = new THREE.Mesh(new THREE.PlaneGeometry(40, 8), wallMat);
  backA.position.set(0, 4, -22); scene.add(backA);
  const backB = backA.clone(); backB.rotation.y = Math.PI; backB.position.z = 22; scene.add(backB);
  const sideA = new THREE.Mesh(new THREE.PlaneGeometry(60, 8), wallMat);
  sideA.rotation.y = Math.PI / 2; sideA.position.set(-14, 4, 0); scene.add(sideA);
  const sideB = sideA.clone(); sideB.rotation.y = -Math.PI / 2; sideB.position.x = 14; scene.add(sideB);

  // Overhead lamps (visual only)
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

/* ---------------- Sword factory ---------------- */

function makeSword(color = 0xd8dde6) {
  const g = new THREE.Group();

  const guard = new THREE.Mesh(
    new THREE.SphereGeometry(0.065, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color, metalness: 0.85, roughness: 0.3 })
  );
  guard.rotation.x = -Math.PI / 2; // bowl opens toward the hand
  g.add(guard);

  const grip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.016, 0.02, 0.14, 12),
    new THREE.MeshStandardMaterial({ color: 0x2b2118, roughness: 0.9 })
  );
  grip.rotation.x = Math.PI / 2;
  grip.position.z = 0.08;
  g.add(grip);

  const blade = new THREE.Mesh(
    new THREE.CylinderGeometry(0.004, 0.009, 0.9, 8),
    new THREE.MeshStandardMaterial({ color: 0xc9cfd9, metalness: 0.95, roughness: 0.25 })
  );
  blade.rotation.x = Math.PI / 2;
  blade.position.z = -0.45;
  blade.castShadow = true;
  g.add(blade);

  const tip = new THREE.Mesh(
    new THREE.SphereGeometry(0.012, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xff4444, emissive: 0x661111 })
  );
  tip.position.z = -0.9;
  g.add(tip);

  // Local reference points for hit math (blade points down -Z)
  g.userData.basePoint = new THREE.Vector3(0, 0, 0);
  g.userData.tipPoint = new THREE.Vector3(0, 0, -0.9);
  g.userData.tipMesh = tip;
  return g;
}

function bladeSegment(sword, outBase, outTip) {
  outBase.copy(sword.userData.basePoint).applyMatrix4(sword.matrixWorld);
  outTip.copy(sword.userData.tipPoint).applyMatrix4(sword.matrixWorld);
}

/* ---------------- Opponent fencer ---------------- */

function buildOpponent() {
  const o = new THREE.Group();
  o.position.set(0, 0, -2);

  const jacket = new THREE.MeshStandardMaterial({ color: 0xf0f0ec, roughness: 0.8 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23262c, roughness: 0.6 });
  const breeches = new THREE.MeshStandardMaterial({ color: 0xe8e8e2, roughness: 0.85 });

  const parts = []; // { node, zone, radius }

  // Torso — slightly crouched en-garde, profile toward the player
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.42, 6, 14), jacket);
  torso.position.set(0, 1.12, 0);
  torso.rotation.x = 0.14;
  torso.castShadow = true;
  o.add(torso);
  parts.push({ node: torso, zone: 'torso', radius: 0.21 });

  // Head + mask
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.115, 20, 16), dark);
  head.position.set(0, 1.58, 0.04);
  head.castShadow = true;
  o.add(head);
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.55),
    new THREE.MeshStandardMaterial({ color: 0x111318, roughness: 0.4, metalness: 0.6, transparent: true, opacity: 0.85 })
  );
  mesh.rotation.x = Math.PI / 2.6;
  head.add(mesh);
  const bib = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 0.12, 12), jacket);
  bib.position.y = -0.12; head.add(bib);
  parts.push({ node: head, zone: 'head', radius: 0.15 });

  // Legs — fencing stance (front leg toward player = +Z)
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

  // Back arm, tucked behind
  const backArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.3, 4, 10), jacket);
  backArm.position.set(-0.14, 1.28, -0.14); backArm.rotation.z = 0.9; backArm.rotation.x = -0.8;
  backArm.castShadow = true;
  o.add(backArm);
  parts.push({ node: backArm, zone: 'arm', radius: 0.1 });

  // Weapon arm: shoulder pivot -> forearm -> sword. Extension animates rotation+reach.
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
playerSword.castShadow = true;

// Desktop: sword hangs off a hand anchor inside the rig; mouse steers it.
const handAnchor = new THREE.Group();
handAnchor.position.set(0.22, 1.25, -0.35);
rig.add(handAnchor);
handAnchor.add(playerSword);

// Player body target (for opponent's attacks): capsule at rig location
const playerTarget = {
  radius: 0.2,
  center: new THREE.Vector3(),
  update() {
    this.center.set(rig.position.x, 1.15, rig.position.z);
    // In VR, follow the actual head position
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
  function clash() {
    const c = ensure();
    const len = 0.09, buf = c.createBuffer(1, c.sampleRate * len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (d.length * 0.25));
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2400;
    const g = c.createGain(); g.gain.value = 0.5;
    src.connect(f).connect(g).connect(c.destination);
    src.start();
    buzzer(3400 + Math.random() * 800, 0.06, 'triangle', 0.08);
  }
  return { buzzer, clash, ensure };
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

function segmentSegmentDistance(p1, q1, p2, q2) {
  // Standard closest-distance between two segments
  const d1 = new THREE.Vector3().subVectors(q1, p1);
  const d2 = new THREE.Vector3().subVectors(q2, p2);
  const r = new THREE.Vector3().subVectors(p1, p2);
  const a = d1.lengthSq(), e = d2.lengthSq(), f = d2.dot(r);
  let s, t;
  if (a <= 1e-9 && e <= 1e-9) return p1.distanceTo(p2);
  if (a <= 1e-9) { s = 0; t = THREE.MathUtils.clamp(f / e, 0, 1); }
  else {
    const c = d1.dot(r);
    if (e <= 1e-9) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
    else {
      const b = d1.dot(d2), denom = a * e - b * b;
      s = denom > 1e-9 ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
    }
  }
  const c1 = new THREE.Vector3().copy(p1).addScaledVector(d1, s);
  const c2 = new THREE.Vector3().copy(p2).addScaledVector(d2, t);
  return c1.distanceTo(c2);
}

/* ---------------- Match state ---------------- */

const match = {
  started: false,
  paused: true,
  scorePlayer: 0,
  scoreOpp: 0,
  time: CONFIG.boutTime,
  phase: 'ready',          // ready | fencing | halt | over
  priority: null,          // 'player' | 'opponent' | null — simplified right of way
  lock: null,              // { first, timer, touches: {player, opponent, playerOff, oppOff} }
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
  state: 'engarde',        // engarde | advance | retreat | lunge | recover | parry | riposte
  stateTime: 0,
  ext: 0.15,               // arm extension 0..1
  extTarget: 0.15,
  lungeZ: 0,               // forward offset during lunge
  parryDir: 0,             // lateral parry angle
  parryTimer: 0,
  reactTimer: 0,
  bob: Math.random() * 10,
  attacking: false,
};

function aiSetState(s) {
  ai.state = s;
  ai.stateTime = 0;
}

function updateOpponent(dt, playerTip, playerTipSpeed, playerApproaching) {
  const o = opp.group;
  ai.stateTime += dt;
  ai.bob += dt;

  playerTarget.update();
  const dist = Math.abs(o.position.z - playerTarget.center.z);
  const C = CONFIG.opponent;

  // --- state machine ---
  switch (ai.state) {
    case 'engarde': {
      ai.extTarget = 0.15;
      ai.attacking = false;
      if (dist > C.preferredDist + 0.25) aiSetState('advance');
      else if (dist < C.preferredDist - 0.35) aiSetState('retreat');
      else if (dist < C.preferredDist + 0.35 && Math.random() < C.attackChance * dt) {
        aiSetState('lunge');
        ai.attacking = true;
        if (!match.priority) match.priority = 'opponent';
      }
      break;
    }
    case 'advance': {
      o.position.z += C.speed * dt * Math.sign(playerTarget.center.z - o.position.z);
      if (dist <= C.preferredDist) aiSetState('engarde');
      break;
    }
    case 'retreat': {
      o.position.z -= C.speed * 1.2 * dt * Math.sign(playerTarget.center.z - o.position.z);
      if (dist >= C.preferredDist || o.position.z < -6.5) aiSetState('engarde');
      break;
    }
    case 'lunge': {
      ai.extTarget = 1;
      if (ai.stateTime > 0.1) ai.lungeZ += C.lungeSpeed * dt;
      ai.lungeZ = Math.min(ai.lungeZ, C.lungeReach);
      if (ai.stateTime > 0.55) aiSetState('recover');
      break;
    }
    case 'recover': {
      ai.extTarget = 0.15;
      ai.attacking = false;
      ai.lungeZ = Math.max(0, ai.lungeZ - 2.5 * dt);
      if (ai.lungeZ === 0 && ai.stateTime > 0.4) {
        aiSetState(dist < C.preferredDist - 0.2 ? 'retreat' : 'engarde');
      }
      break;
    }
    case 'parry': {
      ai.extTarget = 0.55;
      ai.parryTimer -= dt;
      if (ai.parryTimer <= 0) {
        // riposte!
        aiSetState('riposte');
        ai.attacking = true;
        match.priority = 'opponent';
      }
      break;
    }
    case 'riposte': {
      ai.extTarget = 1;
      if (ai.stateTime > 0.1) ai.lungeZ = Math.min(ai.lungeZ + C.lungeSpeed * 1.1 * dt, C.lungeReach * 0.9);
      if (ai.stateTime > 0.45) aiSetState('recover');
      break;
    }
  }

  // --- parry reaction: player blade incoming toward their target ---
  if ((ai.state === 'engarde' || ai.state === 'advance' || ai.state === 'retreat') && match.phase === 'fencing') {
    const tipToTorso = playerTip.distanceTo(_t1.setFromMatrixPosition(opp.torso.matrixWorld));
    if (tipToTorso < 1.15 && playerApproaching && playerTipSpeed > 1.8) {
      ai.reactTimer += dt;
      if (ai.reactTimer > C.reaction) {
        if (Math.random() < C.parryChance) {
          aiSetState('parry');
          ai.parryTimer = 0.32 + Math.random() * 0.15;
          ai.reactTimer = 0;
          ai.parryFeedback = false;
          // parry to the side the blade is on (quarte/sixte)
          ai.parryDir = playerTip.x > o.position.x ? 1 : -1;
        } else {
          ai.reactTimer = -0.35; // failed the read — beaten this exchange
        }
      }
    } else if (ai.reactTimer > 0) {
      ai.reactTimer = 0;
    } else if (ai.reactTimer < 0) {
      ai.reactTimer = Math.min(0, ai.reactTimer + dt); // cooldown recovers between exchanges
    }
  }

  // --- pose / animation ---
  ai.ext = THREE.MathUtils.damp(ai.ext, ai.extTarget, 12, dt);

  // en-garde bob
  const bobY = Math.sin(ai.bob * 2.1) * 0.015 + Math.sin(ai.bob * 5.3) * 0.006;
  o.position.y = bobY - (ai.lungeZ > 0.05 ? 0.08 : 0);

  // face the player
  const faceDir = Math.sign(playerTarget.center.z - o.position.z) || 1;
  o.rotation.y = faceDir > 0 ? 0 : Math.PI;

  o.position.z = THREE.MathUtils.clamp(o.position.z, -6.8, 6.8);

  // weapon arm: extension aims the blade at the player's chest;
  // during a parry it drives at the player's blade instead (opposition)
  const arm = opp.armPivot;
  const target = _t2.set(playerTarget.center.x, playerTarget.center.y + 0.15, playerTarget.center.z);
  if (ai.state === 'parry') {
    target.set((pBase.x + pTip.x) / 2, (pBase.y + pTip.y) / 2, (pBase.z + pTip.z) / 2);
  }
  arm.updateMatrixWorld();
  const armPos = _t3.setFromMatrixPosition(arm.matrixWorld);
  const aim = _t1.subVectors(target, armPos).normalize();

  // blend between relaxed guard pose and full-extension aim
  const relaxedPitch = -0.25, relaxedYaw = faceDir > 0 ? 0.15 : Math.PI - 0.15;
  const aimYaw = Math.atan2(aim.x, aim.z);
  const aimPitch = -Math.asin(THREE.MathUtils.clamp(aim.y, -1, 1)) + 0.02;
  const localYaw = faceDir > 0 ? aimYaw : aimYaw - Math.PI;

  let yaw = THREE.MathUtils.lerp(relaxedYaw - (faceDir > 0 ? 0 : Math.PI), localYaw, ai.ext);
  let pitch = THREE.MathUtils.lerp(relaxedPitch, aimPitch, ai.ext);

  // parry: small lateral beat across the incoming blade
  if (ai.state === 'parry') {
    yaw += ai.parryDir * 0.18;
  }

  arm.rotation.set(pitch, yaw, 0);
  // reach: slide sword forward with extension + lunge
  opp.sword.position.z = 0.55 + ai.ext * 0.18 + ai.lungeZ * 0.5;
  arm.position.z = 0.1 + ai.lungeZ * 0.5;
}

/* ---------------- Combat resolution ---------------- */

const pBase = new THREE.Vector3(), pTip = new THREE.Vector3();
const oBase = new THREE.Vector3(), oTip = new THREE.Vector3();
const prevPTip = new THREE.Vector3(), prevOTip = new THREE.Vector3();
const sweptP = new THREE.Vector3(), sweptO = new THREE.Vector3(); // last frame's tips, for swept checks
const pTipVel = new THREE.Vector3(), oTipVel = new THREE.Vector3();
let clashCooldown = 0;

function registerTouch(side, off = false) {
  // side: 'player' | 'opponent'; off = off-target (foil)
  if (match.phase !== 'fencing') {
    if (!match.lock) return;
  }
  if (!match.lock) {
    match.lock = { timer: CONFIG.lockout, touches: {} };
    match.phase = 'lockout';
  }
  const key = off ? side + 'Off' : side;
  if (match.lock.touches[key]) return;
  match.lock.touches[key] = true;
  audio.buzzer(off ? 220 : (side === 'player' ? 520 : 440), 0.5);
  pulseHaptic(0.8, 120);
}

function resolveLock() {
  const t = match.lock.touches;
  match.lock = null;
  const W = WEAPONS[weaponKey];

  const pOn = !!t.player, oOn = !!t.opponent;
  const pOff = !!t.playerOff, oOff = !!t.opponentOff;

  setLights({
    player: pOn, opp: oOn,
    playerWhite: pOff, oppWhite: oOff,
  });

  let msg = '';
  if (pOn && oOn) {
    if (weaponKey === 'epee') {
      match.scorePlayer++; match.scoreOpp++;
      msg = 'Double touch!';
    } else {
      // simplified right of way
      if (match.priority === 'player') { match.scorePlayer++; msg = 'Attack touch — you!'; }
      else if (match.priority === 'opponent') { match.scoreOpp++; msg = 'Attack touch — opponent'; }
      else { msg = 'Simultaneous — no touch'; }
    }
  } else if (pOn) {
    match.scorePlayer++;
    msg = 'Touch!';
  } else if (oOn) {
    match.scoreOpp++;
    msg = 'Touch against';
  } else if (pOff || oOff) {
    msg = 'Off target — halt';
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
  // return to en-garde lines
  opp.group.position.z = -2;
  ai.lungeZ = 0; ai.ext = 0.15;
  ai.reactTimer = 0; ai.attacking = false;
  aiSetState('engarde');
  if (!renderer.xr.isPresenting) rig.position.z = 2;
  else {
    // in VR shift the rig so the player's head is back at z=+2
    const head = new THREE.Vector3();
    camera.getWorldPosition(head);
    rig.position.z += 2 - head.z;
    rig.position.x -= head.x;
  }
  desktop.lungeT = 0;
  match.priority = null;
  setLights({});
  match.phase = 'fencing';
  showMessage('En garde … Allez!', 1.0);
}

function updateCombat(dt) {
  bladeSegment(playerSword, pBase, pTip);
  bladeSegment(opp.sword, oBase, oTip);

  if (dt > 0) {
    pTipVel.subVectors(pTip, prevPTip).divideScalar(dt);
    oTipVel.subVectors(oTip, prevOTip).divideScalar(dt);
  }
  sweptP.copy(prevPTip); prevPTip.copy(pTip);
  sweptO.copy(prevOTip); prevOTip.copy(oTip);

  clashCooldown -= dt;

  // ---- blade-on-blade contact ----
  const bladeDist = segmentSegmentDistance(pBase, pTip, oBase, oTip);
  if (bladeDist < CONFIG.clashDist && clashCooldown <= 0) {
    clashCooldown = 0.18;
    audio.clash();
    pulseHaptic(0.4, 40);

    // A parry beats the attack: defender takes priority
    if (ai.state === 'parry') {
      match.priority = 'opponent';
    } else if (ai.attacking && pTipVel.length() > 1.0) {
      // player's blade actively met the opponent's during their attack → parry
      match.priority = 'player';
      showMessage('Parried!', 0.7);
      if (ai.state === 'lunge' || ai.state === 'riposte') aiSetState('recover');
    }
  }

  if (match.phase !== 'fencing' && match.phase !== 'lockout') return;

  const W = WEAPONS[weaponKey];

  // ---- player scoring: tip vs opponent body parts ----
  const pSpeed = pTipVel.length();
  const towardOpp = pTipVel.z < -0.2; // tip must be moving toward the opponent
  const parryBlocks = ai.state === 'parry'; // a won parry roll deflects the attack

  for (const part of opp.parts) {
    const c = _t1.setFromMatrixPosition(part.node.matrixWorld);
    const d = pointSegmentDistance(c, pBase, pTip);
    // thrust: swept tip path crosses the part (robust against frame tunneling)
    const tipD = pointSegmentDistance(c, sweptP, pTip);
    const thrust = tipD < part.radius && pSpeed > CONFIG.touchSpeed && towardOpp;
    const cut = W.cuts && d < part.radius && pSpeed > CONFIG.cutSpeed;
    if (thrust || cut) {
      if (parryBlocks) {
        if (!ai.parryFeedback) {
          ai.parryFeedback = true;
          audio.clash();
          pulseHaptic(0.5, 60);
          showMessage('Parried!', 0.8);
          match.priority = 'opponent';
        }
      } else if (W.target.includes(part.zone)) registerTouch('player');
      else if (W.offTarget.includes(part.zone)) registerTouch('player', true);
      // sabre below the waist: no light at all
      break;
    }
  }

  // ---- opponent scoring: their swept tip vs player capsule ----
  playerTarget.update();
  const oTipD = pointSegmentDistance(playerTarget.center, sweptO, oTip);
  const oSpeed = oTipVel.length();
  if (ai.attacking && oTipD < playerTarget.radius + 0.12 && oSpeed > 0.6) {
    registerTouch('opponent');
    aiSetState('recover');
  }

  // ---- lockout countdown ----
  if (match.lock) {
    match.lock.timer -= dt;
    if (match.lock.timer <= 0) resolveLock();
  }
}

/* ---------------- Desktop controls ---------------- */

const desktop = {
  yaw: 0, pitch: 0,
  thrustT: 0,        // 0..1 thrust animation
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

  // footwork
  let move = 0;
  if (desktop.keys['KeyW']) move -= 1;
  if (desktop.keys['KeyS']) move += 1;
  if (match.phase === 'fencing') {
    rig.position.z += move * 1.6 * dt;
    rig.position.z = THREE.MathUtils.clamp(rig.position.z, 0.6, 6.8);
  }

  // camera: fixed en-garde eye, slight lean with blade
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

  // blade pose from mouse
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
  playerSword.rotation.set(-0.5, 0, 0); // natural grip angle
  vrWeaponController.grip.add(playerSword);
}

renderer.xr.addEventListener('sessionstart', () => {
  if (vrWeaponController) attachSwordToVR();
  // place the rig so the player stands at the en-garde line facing the opponent
  rig.position.set(0, 0, 2);
});
renderer.xr.addEventListener('sessionend', () => {
  if (vrWeaponController) vrWeaponController.grip.remove(playerSword);
  playerSword.position.set(0, 0, 0);
  playerSword.rotation.set(0, 0, 0);
  handAnchor.add(playerSword);
});

function updateVR(dt) {
  if (!renderer.xr.isPresenting) return;
  // left stick: advance / retreat along the piste
  const off = vrOffhandController?.controller.userData.gamepad;
  if (off && off.axes.length >= 4 && match.phase === 'fencing') {
    const v = off.axes[3]; // forward = -1
    if (Math.abs(v) > 0.15) {
      rig.position.z += v * 1.8 * dt;
      rig.position.z = THREE.MathUtils.clamp(rig.position.z, -6.8, 6.8);
    }
  }
}

function pulseHaptic(intensity, ms) {
  const gp = vrWeaponController?.controller.userData.gamepad;
  const act = gp?.hapticActuators?.[0];
  if (act?.pulse) act.pulse(intensity, ms);
}

/* ---------------- Menu ---------------- */

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
window.SIM = { match, desktop, rig, opp, ai, CONFIG, WEAPONS, playerSword };

function step(dt) {
  window.__testTick?.(dt);

  if (match.started) {
    if (match.phase === 'fencing' || match.phase === 'lockout') {
      match.time = Math.max(0, match.time - dt);
      if (match.time === 0 && match.phase === 'fencing') {
        match.phase = 'over';
        endBout();
      }
    }
    if (match.phase === 'halt') {
      match.haltTimer -= dt;
      if (match.haltTimer <= 0) resetPhrase();
    }

    updateDesktop(dt);
    updateVR(dt);

    // player tip kinematics for the AI
    bladeSegment(playerSword, pBase, pTip);
    const playerApproaching = pTipVel.z < -0.3;
    updateOpponent(dt, pTip, pTipVel.length(), playerApproaching);

    updateCombat(dt);

    // update timer display once a second-ish
    if (Math.floor(match.time) !== Math.floor(match.time + dt)) updateHud();
  } else {
    // idle: opponent bobs on guard behind the menu
    updateDesktop(dt);
    updateOpponent(dt, pTip, 0, false);
  }

  renderer.render(scene, camera);
}

window.SIM.step = step;
renderer.setAnimationLoop(() => step(Math.min(clock.getDelta(), 0.05)));
