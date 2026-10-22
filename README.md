# Pixel Pitch

Browser football game: FIFA-style gameplay, pixel-art look. Red (you) vs Blue (CPU), 11 v 11.

**Play it: https://underscorelog.github.io/pixel-pitch/**

![Kickoff, with the aim guide leading a pass into the winger's run](docs/screenshots/kickoff.png)

| | |
|---|---|
| ![Attack on goal](docs/screenshots/shot.png) | ![Keeper claims the ball under pressure](docs/screenshots/attack.png) |
| Attack on goal: the keeper narrows the angle and dives | Close camera: the keeper claims the ball under pressure |
| ![Yellow card](docs/screenshots/card.png) | ![Generated sprites](docs/screenshots/sprites.png) |
| Fouls are judged by severity: the referee shows the card | Sprites are generated from a 3D skeleton: sprint, kick, tackle, slide in 16 directions |

## Features

- 11 v 11 in a 4-4-2, team AI that presses, covers, keeps shape, passes and shoots
- Ball physics in 3D: height, air drag, bounces, rolling friction, posts and crossbar
- Charged passes, shots, lobs and through balls, pass assist towards the teammate you aim at, fake shots
- Ball spin: curled finesse shots and whipped crosses; headers and aerial duels, chest control
- Aim guide showing the predicted path and landing spot, sized by the kick's inaccuracy
- Standing and slide tackles, fouls judged by severity, yellow and red cards, free kicks and penalties
- Offside (switchable), corners, goal kicks, throw-ins and kickoffs, with a referee following play
- Two halves; a draw can go to extra time and a penalty shootout (you dive for your keeper on CPU penalties)
- Player ratings, stamina and three substitutions a side; full-time match stats
- Keyboard, gamepad (menus too) and on-screen touch controls
- Training mode (you against the keeper), match clock, three difficulty levels
- Deterministic simulation: same seed and inputs, same match

## Run

```bash
npm install
npm run dev      # http://localhost:5180
npm test         # simulation tests (physics, rules, AI soak test)
npm run build    # typecheck + production bundle in dist/
```

Every push to `main` runs the tests, builds and deploys to GitHub Pages (`.github/workflows/pages.yml`).

`sprites.html` (dev server only) shows every generated sprite frame: `/sprites.html?kit=home&poses=jog,sprint&dirs=0,4,8,12`.

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Move | Arrows | Left stick |
| Sprint | Shift | RT |
| Pass / hold to press and tackle | S | A |
| Shoot / slide tackle | D | B |
| Lob / cross | A | X |
| Through ball | W | Y |
| Finesse (hold with shoot or lob: curled shot, whipped cross) | E | RB |
| Switch player | Q | LB |
| Pause / substitutions | Esc | Start |

Hold a kick button to charge, release to kick. Press another kick button while charging to fake.
A through ball goes into the space ahead of the teammate you aim at (more charge, further ahead) and he runs onto it.
Passes and lobs snap to the teammate in the stick direction (preferring one with an open lane) with the right weight; control follows the pass.
Shots aimed near the goal are pulled inside the posts and kept under the bar, and kicks on the run allow for your momentum (Options > KICKS: MANUAL turns the assistance off).
Defending: hold S to run at the ball carrier and tackle when in range; getting your body on the ball can win it too.
Headers: hold or tap a kick key as a high ball reaches your player (D at goal, S to a teammate, A to clear); without one he cushions it down.
On a CPU penalty, hold up or down as it is struck and your keeper dives that way.
Menus work with the gamepad (d-pad, A, B, Start). On a touch screen an on-screen stick and buttons replace the keyboard (full tilt sprints).

## How it's built

- `src/sim`: the game itself, plain TypeScript with no Phaser imports. Fixed 60 Hz tick, seeded RNG, so a match is reproducible from (seed, inputs). Keep `Math.random` and wall-clock time out of here.
  - `ball.ts` 3D ball (height, air drag, bounces, rolling friction)
  - `player.ts` movement, possession, human input; `kick.ts` kick model, pass assist, aim preview
  - `ai.ts` team AI (press, cover, shape, passing, dribbling, shooting); `keeper.ts` goalkeepers
  - `tackle.ts` tackles, fouls, cards; `match.ts` rules, restarts, set pieces, clock; `referee.ts`
- `src/render`: Phaser 4 renderer. Sprites are generated at startup from a small 3D skeleton (`figure.ts`), 16 facing directions. Integer zoom, sub-pixel positions, interpolation between sim ticks.
- `src/ui`: DOM menus and settings (saved in localStorage). `src/audio`: synthesized sound effects.

## Not done yet

Sides don't switch ends at half-time (you always attack right). No recorded crowd sound, no team or kit selection, no replays.
The CPU still plays a lot of long balls; fewer of them currently makes its defending leak goals.
