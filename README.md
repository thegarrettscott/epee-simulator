# Épée Simulator (WebXR)

A VR épée trainer for Meta Quest that runs in the Quest browser — no app install needed. Includes a desktop mouse/keyboard mode for quick testing.

## Features

- Regulation 14m piste with en-garde, warning and end lines
- AI opponent with footwork (advance/retreat to keep distance), lunges, parry–riposte
- Épée rules: whole body is valid target, double touches score for both fencers
- Blade-on-blade clash detection with sound and controller haptics
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

Everything gameplay-related lives in the `CONFIG` object at the top of `main.js`: opponent speed, reaction time, parry chance, attack frequency, lockout timing, touch speed thresholds. Turn `parryChance`/`attackChance` up as you improve.
