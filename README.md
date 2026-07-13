# Épée Simulator (WebXR)

A VR épée trainer for Meta Quest that runs in the Quest browser — no app install needed. Includes a desktop mouse/keyboard mode for quick testing.

## Features

- Regulation 14m piste with en-garde, warning and end lines
- **Real blade physics**: each blade is a physical rod pinned at the guard with a grip spring. Blade-on-blade contact uses leverage-weighted impulses — forte beats foible — so parries, beats, glides and opposition emerge from the physics rather than dice rolls. Blades visibly bend under contact and bow on touches.
- **Fencing-true timing**: a surprise attack in tempo from critical distance beats the reaction parry; a telegraphed advance-lunge gets read and parried. The AI reacts faster to blade threats than to footwork.
- **Opponent momentum**: acceleration-limited footwork with stepping cadence, a readable preparation tell before each lunge, and ballistic committed drives — no mid-lunge re-aiming, so beats and dodges genuinely break attacks.
- **Épée touch model**: the swept tip must arrive point-first with axial drive (the 750g force proxy) — slaps, whips and grazes don't score. Whole body is target; double touches score for both.
- **Constant blade conversation**: the opponent seeks light engagement of your blade by default (with changes of engagement under your point) and a resting engagement yields when pushed; steel can never pass through steel, but disengages around the point are legal. You hear and feel the blade continuously — soft slither for engagement, scrapes for glides, clashes pitched by position on the blade, haptics scaled by impact.
- **Target drill mode**: a lit target appears somewhere on the opponent (weighted toward hand and forearm) after a random delay — hit it point-first before the window closes, recover to guard between reps. Tracks reaction time, accuracy and streak; the window shrinks as you streak.
- Optional **blade weight simulation** (menu toggle): grip spring softens so the blade lags and whips like a real épée — off by default for clean point training
- Scoreboard, scoring lights, 3-minute clock, bout to 15

## Run locally (desktop test mode)

```sh
cd "Fencing simulator"
python3 -m http.server 8080
```

Open http://localhost:8080 — pick a weapon, START BOUT.

- **Mouse** steers your blade (click the canvas to capture the pointer)
- **Click** thrust · **Shift+Click** lunge
- **W / S** advance / retreat · **Esc** menu

## Run on Quest

WebXR needs a **secure context** (HTTPS or localhost). Two options:

### Option A — adb reverse (recommended, no certs)

1. Enable developer mode on the Quest and connect it via USB.
2. On your Mac:
   ```sh
   python3 -m http.server 8080          # in this folder
   adb reverse tcp:8080 tcp:8080        # needs android platform-tools: brew install android-platform-tools
   ```
3. In the Quest browser open `http://localhost:8080` and press **Enter VR**.

### Option B — HTTPS on your LAN

Serve with any HTTPS-capable static server (e.g. `npx http-server -S` with a self-signed cert, or a tunnel like `cloudflared`/`ngrok`), then open the https URL in the Quest browser.

### In VR

- **Right controller** is your weapon — physically parry, beat, and thrust
- **Left thumbstick** (forward/back) does the footwork along the piste
- **Right trigger** marks the start of your attack (for priority)

## Tuning

Everything gameplay-related lives in the `CONFIG` object at the top of `main.js`:

- `CONFIG.opponent` — speed, reaction time, parry chance, attack frequency. Turn `parryChance`/`attackChance` up and `reaction` down as you improve.
- `CONFIG.momentum` — lunge speed/acceleration, the preparation-tell duration, footwork cadence
- `CONFIG.touch` — axial-speed and point-first thresholds for a valid touch
- `CONFIG.physics` — grip stiffness, contact behaviour, parry press strength, blade-weight-sim feel
