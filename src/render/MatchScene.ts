import Phaser from 'phaser';
import { sfx } from '../audio/sfx';
import { stepBall } from '../sim/ball';
import {
  CENTER,
  DT,
  FOUL_PAUSE,
  GOAL_Y_MAX,
  GOAL_Y_MIN,
  KEEPER_DIVE_TIME,
  KICK_RADIUS,
  MIN_KICK_POWER,
  PITCH_LENGTH,
  PITCH_WIDTH,
} from '../sim/constants';
import { isSprinting, planKick, resolveHumanKick } from '../sim/kick';
import { NO_INPUT, createMatch, stepMatch } from '../sim/match';
import { attackDir } from '../sim/team';
import type { Ball, Footballer, InputFrame, KickType, MatchEvent, MatchSettings, MatchState, Team } from '../sim/types';
import { Menu, type Mode } from '../ui/menu';
import { type Settings, loadSettings } from '../ui/settings';
import { FIG_ANCHOR_X, FIG_ANCHOR_Y, FIG_H, FIG_W, RUN_FRAMES, dirIndex, frameName } from './figure';
import { InputReader } from './input';
import { WORLD_H, WORLD_W, project } from './projection';
import { BALL_FRAMES, GOAL_TEX_W, createTextures, goalAnchor } from './sprites';

const POWER_COLORS: Record<KickType, number> = { pass: 0x5ad65a, shot: 0xe04848, lob: 0x58a8f0, through: 0xf0d048 };
const TEAM_NAME: Record<Team, string> = { home: 'RED', away: 'BLUE' };

/** Art pixels of pitch visible across the screen, per camera setting. */
const CAMERA_VIEW_W: Record<Settings['camera'], number> = { close: 380, normal: 480, wide: 620 };

const TURN_RATE = 14; // rad/s, display-only smoothing of facing
const STRIDE = { walk: 1.5, jog: 2.6, sprint: 3.6 } as const; // meters per full run cycle
const BALL_ROLL_PER_FRAME = 0.17; // ball circumference / 4
const TELEPORT = 3; // meters; bigger jumps between ticks are not interpolated

/** Positions the renderer interpolates between sim ticks. Players are packed as x, y, vx, vy. */
interface View {
  players: Float64Array;
  rx: number;
  ry: number;
  rvx: number;
  rvy: number;
  bx: number;
  by: number;
  bz: number;
}

function snapshot(s: MatchState): View {
  const players = new Float64Array(s.players.length * 4);
  s.players.forEach((p, i) => players.set([p.x, p.y, p.vx, p.vy], i * 4));
  const { referee: r, ball: b } = s;
  return { players, rx: r.x, ry: r.y, rvx: r.vx, rvy: r.vy, bx: b.x, by: b.y, bz: b.z };
}

function interpolate(a: View, b: View, t: number): View {
  if (a.players.length !== b.players.length) return b;
  const lerp = (x0: number, x1: number, y0: number, y1: number): [number, number] =>
    Math.hypot(x1 - x0, y1 - y0) > TELEPORT ? [x1, y1] : [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
  const players = new Float64Array(b.players);
  for (let i = 0; i < players.length; i += 4) {
    const [x, y] = lerp(a.players[i], b.players[i], a.players[i + 1], b.players[i + 1]);
    players[i] = x;
    players[i + 1] = y;
  }
  const [rx, ry] = lerp(a.rx, b.rx, a.ry, b.ry);
  const [bx, by] = lerp(a.bx, b.bx, a.by, b.by);
  const bz = Math.abs(b.bz - a.bz) < TELEPORT ? a.bz + (b.bz - a.bz) * t : b.bz;
  return { ...b, players, rx, ry, bx, by, bz };
}

/** A generated-figure sprite with display-only facing and run-cycle state. */
class Figure {
  readonly sprite: Phaser.GameObjects.Sprite;
  readonly shadow: Phaser.GameObjects.Image;
  yaw: number;
  diveSide: 'R' | 'L' = 'R';
  private phase = 0;
  private idleT = 0;

  constructor(scene: Phaser.Scene, key: string, yaw: number) {
    this.yaw = yaw;
    this.shadow = scene.add.image(0, 0, 'shadow').setOrigin(0.5, 1 / 3);
    this.sprite = scene.add
      .sprite(0, 0, key, frameName('idle0', 0))
      .setOrigin(FIG_ANCHOR_X / FIG_W, FIG_ANCHOR_Y / FIG_H);
  }

  turnTo(target: number, dt: number): void {
    const d = Math.atan2(Math.sin(target - this.yaw), Math.cos(target - this.yaw));
    const max = TURN_RATE * dt;
    this.yaw += Math.max(-max, Math.min(max, d));
  }

  /** Run cycle advanced by distance covered, so feet don't slide. */
  gait(speed: number, dt: number): string {
    if (speed < 0.4) {
      this.idleT += dt;
      return `idle${Math.floor(this.idleT * 1.2) % 2}`;
    }
    const gait = speed < 2.5 ? 'walk' : speed < 7.3 ? 'jog' : 'sprint';
    this.phase = (this.phase + (speed * dt) / STRIDE[gait]) % 1;
    return `${gait}${Math.floor(this.phase * RUN_FRAMES)}`;
  }

  show(pose: string): void {
    this.sprite.setFrame(frameName(pose, dirIndex(this.yaw)));
  }

  setVisible(v: boolean): void {
    this.sprite.setVisible(v);
    this.shadow.setVisible(v);
  }

  destroy(): void {
    this.sprite.destroy();
    this.shadow.destroy();
  }
}

export class MatchScene extends Phaser.Scene {
  private state!: MatchState;
  private prev!: View;
  private acc = 0;
  /** A human game is in progress (not paused). */
  private running = false;
  /** CPU vs CPU demo playing behind the menus. */
  private demo = false;
  private mode: Mode = 'training';
  private settings = loadSettings();
  private menu!: Menu;
  private inputReader!: InputReader;
  private lastInput: InputFrame = NO_INPUT;
  private figures: Figure[] = [];
  private referee!: Figure;
  private ball!: Phaser.GameObjects.Image;
  private ballShadow!: Phaser.GameObjects.Image;
  private ballRoll = 0;
  private lastBall = { x: 0, y: 0 };
  private overlay!: Phaser.GameObjects.Graphics;
  private zoom = 1;
  private camX = WORLD_W / 2;
  private camY = WORLD_H / 2;
  private hud = document.getElementById('hud')!;
  private scoreEl = document.getElementById('score')!;
  private clockEl = document.getElementById('clock')!;
  private msgEl = document.getElementById('msg')!;
  private helpEl = document.getElementById('help')!;
  private radar = document.getElementById('radar') as HTMLCanvasElement;
  private msgTimer = 0;

  constructor() {
    super('match');
  }

  create(): void {
    createTextures(this);
    this.add.image(0, 0, 'pitch').setOrigin(0).setDepth(-10000);

    // Right goal as drawn, left goal mirrored so its goal line sits on x = 0.
    const a = goalAnchor();
    const backDepth = project(0, GOAL_Y_MIN).y - 0.5;
    const frontDepth = project(0, GOAL_Y_MAX).y + 0.5;
    const leftX = project(0, 0).x - GOAL_TEX_W + 2;
    for (const [x, flip] of [
      [a.x, false],
      [leftX, true],
    ] as const) {
      this.add.image(x, a.y, 'goal-back').setOrigin(0).setFlipX(flip).setDepth(backDepth);
      this.add.image(x, a.y, 'goal-front').setOrigin(0).setFlipX(flip).setDepth(frontDepth);
    }

    this.referee = new Figure(this, 'referee', 0);
    this.ballShadow = this.add.image(0, 0, 'shadow').setOrigin(0.5, 1 / 3);
    this.ball = this.add.image(0, 0, 'ball', 'ball0');
    this.overlay = this.add.graphics().setDepth(100000);

    this.cameras.main.setBackgroundColor('#1d3b1a');
    this.scale.on('resize', () => this.layout());
    this.layout();

    this.inputReader = new InputReader(this);
    this.startDemo();
    this.menu = new Menu(this.settings, {
      start: (mode) => this.begin(mode),
      pause: () => this.setRunning(false),
      resume: () => this.setRunning(true),
      restart: () => this.begin(this.mode),
      quit: () => {
        this.setRunning(false);
        this.startDemo();
      },
      settingsChanged: (s) => this.applySettings(s),
    });
    this.applySettings(this.settings);
  }

  private newMatch(kind: Mode | 'demo'): void {
    const settings: MatchSettings = {
      mode: kind === 'training' ? 'training' : 'match',
      duration: kind === 'demo' ? 1e9 : this.settings.matchMinutes * 60,
      difficulty: this.settings.difficulty,
      autoplay: kind === 'demo',
      assist: this.settings.assist,
    };
    this.state = createMatch(Date.now() >>> 0, settings);
    this.prev = snapshot(this.state);
    this.acc = 0;
    for (const f of this.figures) f.destroy();
    this.figures = this.state.players.map((p) => {
      const key = p.gk ? `${p.team}Keeper` : p.team;
      return new Figure(this, key, Math.atan2(p.facingY, p.facingX));
    });
  }

  private startDemo(): void {
    this.newMatch('demo');
    this.demo = true;
  }

  private begin(mode: Mode): void {
    this.mode = mode;
    this.demo = false;
    this.newMatch(mode);
    this.setRunning(true);
  }

  private setRunning(on: boolean): void {
    this.running = on;
    this.hud.hidden = !on;
    this.helpEl.hidden = !on || !this.settings.showHelp;
    this.radar.hidden = !on || this.state.settings.mode !== 'match';
    if (on) this.inputReader.disarm();
  }

  private applySettings(s: Settings): void {
    this.settings = s;
    sfx.enabled = s.sound;
    sfx.crowdEnabled = s.crowd;
    sfx.applySettings();
    this.helpEl.hidden = !this.running || !s.showHelp;
    this.layout();
  }

  /** Integer zoom so every art pixel is the same size on screen. */
  private layout(): void {
    const { width, height } = this.scale;
    const viewW = CAMERA_VIEW_W[this.settings.camera];
    this.zoom = Math.max(1, Math.round(Math.min(width / viewW, height / (viewW * 0.5))));
    this.cameras.main.setSize(width, height);
    this.cameras.main.setZoom(this.zoom);
  }

  update(_time: number, deltaMs: number): void {
    const dt = Math.min(deltaMs, 100) / 1000;
    const live = this.running || this.demo;

    if (live) {
      // Fixed-timestep sim, decoupled from display refresh; render interpolates between ticks.
      this.acc += dt;
      this.lastInput = this.running ? this.inputReader.read() : NO_INPUT;
      while (this.acc >= DT) {
        this.prev = snapshot(this.state);
        stepMatch(this.state, this.lastInput);
        this.acc -= DT;
      }
    }
    const view = live ? interpolate(this.prev, snapshot(this.state), this.acc / DT) : snapshot(this.state);

    this.drawPlayers(view, dt);
    this.drawReferee(view, dt);
    this.drawBall(view);
    this.drawOverlay(view);
    this.updateCamera(view, dt);
    const events = this.state.events.splice(0);
    if (this.running) this.handleEvents(events);
    this.updateHud(dt);
    if (this.running && this.state.settings.mode === 'match') this.drawRadar(view);
  }

  private drawPlayers(v: View, dt: number): void {
    const s = this.state;
    s.players.forEach((p, i) => {
      const fig = this.figures[i];
      if (p.sentOff) {
        fig.setVisible(false);
        return;
      }
      fig.setVisible(true);
      const x = v.players[i * 4];
      const y = v.players[i * 4 + 1];
      const speed = Math.hypot(v.players[i * 4 + 2], v.players[i * 4 + 3]);
      fig.show(p.gk ? this.keeperPose(p, fig, x, y, speed, v, dt) : this.outfieldPose(p, fig, speed, dt));
      this.place(fig, x, y);
    });
  }

  private outfieldPose(p: Footballer, fig: Figure, speed: number, dt: number): string {
    const throwIn = this.holdingThrowIn(p);
    if (throwIn) fig.turnTo(p.y < CENTER.y ? Math.PI / 2 : -Math.PI / 2, dt);
    else if (p.slide === 0 && p.down === 0) fig.turnTo(Math.atan2(p.facingY, p.facingX), dt);
    if (p.slide > 0) return 'slide';
    if (p.down > 0) return 'downR';
    if (p.tackleAnim > 0) return 'tackle';
    if (p.throwAnim > 0) return 'hold';
    if (throwIn) return 'throw';
    if (p.pending || p.fakeAnim > 0) return 'windup';
    if (p.kickAnim > 0) return p.kickAnim > 0.14 ? 'strike' : 'follow';
    return fig.gait(speed, dt);
  }

  private keeperPose(p: Footballer, fig: Figure, x: number, y: number, speed: number, v: View, dt: number): string {
    const gk = p.gk!;
    switch (gk.state) {
      case 'holding':
        fig.turnTo(attackDir(p.team) > 0 ? 0 : Math.PI, dt);
        return 'hold';
      case 'diving': {
        // Dive side relative to his body: his right is +y in pitch space when facing +x.
        fig.diveSide = gk.diveDir * Math.cos(fig.yaw) >= 0 ? 'R' : 'L';
        const progress = 1 - gk.stateTimer / KEEPER_DIVE_TIME;
        return `dive${fig.diveSide}${progress < 0.3 ? 0 : 1}`;
      }
      case 'down':
        return `down${fig.diveSide}`;
      default:
        fig.turnTo(Math.atan2(v.by - y, v.bx - x), dt);
        if (p.kickAnim > 0) return p.kickAnim > 0.14 ? 'strike' : 'follow';
        return speed > 0.6 ? fig.gait(speed, dt) : 'ready';
    }
  }

  /** Taker standing at a throw-in: shown with the ball over his head. */
  private holdingThrowIn(p: Footballer): boolean {
    const s = this.state;
    const sp = s.setPiece;
    return sp?.type === 'throw-in' && sp.takerId === p.id && Math.hypot(s.ball.x - p.x, s.ball.y - p.y) < 1.1;
  }

  private drawReferee(v: View, dt: number): void {
    const s = this.state;
    const fig = this.referee;
    const speed = Math.hypot(v.rvx, v.rvy);
    let pose: string;
    if (s.phase === 'foul' && s.foul) {
      fig.turnTo(Math.atan2(s.foul.y - v.ry, s.foul.x - v.rx), dt);
      pose = speed > 1.5 ? fig.gait(speed, dt) : this.showingCard() ? 'card' : 'point';
    } else if (s.phase === 'goal' || s.phase === 'out') {
      // Points to the centre spot after a goal, to the restart spot otherwise.
      const target = s.phase === 'goal' ? CENTER : (s.restart ?? CENTER);
      fig.turnTo(Math.atan2(target.y - v.ry, target.x - v.rx), dt);
      pose = speed > 1.5 ? fig.gait(speed, dt) : 'point';
    } else {
      fig.turnTo(Math.atan2(v.by - v.ry, v.bx - v.rx), dt);
      pose = fig.gait(speed, dt);
    }
    fig.show(pose);
    this.place(fig, v.rx, v.ry);
  }

  /** The card comes out once the referee has had a moment to reach the spot. */
  private showingCard(): boolean {
    const s = this.state;
    return !!s.foul && s.foul.card !== 'none' && s.phaseTimer < FOUL_PAUSE - 1;
  }

  private drawBall(v: View): void {
    const s = this.state;
    let { bx, by, bz } = v;
    const taker = s.setPiece ? s.players[s.setPiece.takerId] : undefined;
    if (taker && this.holdingThrowIn(taker)) {
      const i = taker.id * 4;
      bx = v.players[i];
      by = v.players[i + 1] + 0.01;
      bz = 2.1;
    }
    const d = Math.hypot(bx - this.lastBall.x, by - this.lastBall.y);
    if (d < TELEPORT) this.ballRoll += (bx >= this.lastBall.x ? 1 : -1) * d;
    this.lastBall = { x: bx, y: by };
    const frame = ((Math.floor(this.ballRoll / BALL_ROLL_PER_FRAME) % BALL_FRAMES) + BALL_FRAMES) % BALL_FRAMES;
    this.ball.setFrame(`ball${frame}`);

    const ground = project(bx, by);
    const air = project(bx, by, bz);
    const shrink = Math.max(0.45, 1 - bz * 0.12);
    this.ballShadow.setScale(0.6 * shrink, 0.7 * shrink);
    this.ballShadow.setPosition(this.snap(ground.x), this.snap(ground.y)).setDepth(ground.y - 0.3);
    this.ball.setPosition(this.snap(air.x), this.snap(air.y - 2)).setDepth(ground.y + 1.5);
    // In a keeper's hands or held overhead, the ball draws in front of the holder.
    if (bz > 0.8) this.ball.setDepth(ground.y + 3);
  }

  /** Controlled-player marker, power bar, aim guide, the referee's card. */
  private drawOverlay(v: View): void {
    const g = this.overlay;
    g.clear();
    const s = this.state;
    if (this.running) {
      const p = s.players[s.controlled];
      if (p && !p.sentOff) {
        const i = p.id * 4;
        const head = project(v.players[i], v.players[i + 1], 2.55);
        const x = this.snap(head.x);
        const y = this.snap(head.y) - 3;
        g.fillStyle(0xf4d35e, 1).fillRect(x - 2, y, 5, 1).fillRect(x - 1, y + 1, 3, 1).fillRect(x, y + 2, 1, 1);
        if (p.charging) {
          g.fillStyle(0x000000, 0.7).fillRect(x - 7, y - 5, 14, 3);
          g.fillStyle(POWER_COLORS[p.charging], 1).fillRect(x - 6, y - 4, Math.round(12 * p.charge), 1);
          if (this.settings.aimGuide) this.drawAimGuide(g, p);
        }
      }
    }
    if (s.phase === 'foul' && this.showingCard()) {
      const hand = project(v.rx, v.ry, 2.45);
      g.fillStyle(s.foul!.card === 'red' ? 0xd63c3c : 0xf4d03f, 1).fillRect(this.snap(hand.x), this.snap(hand.y) - 3, 2, 3);
    }
  }

  /**
   * Simulates the kick that would happen on release (no random error) and
   * draws its path, plus a ring sized by the aim error where it ends up.
   */
  private drawAimGuide(g: Phaser.GameObjects.Graphics, p: Footballer): void {
    const s = this.state;
    const type = p.charging!;
    const startX = s.setPiece ? s.setPiece.x : s.ball.x;
    const startY = s.setPiece ? s.setPiece.y : s.ball.y;
    if (Math.hypot(startX - p.x, startY - p.y) > KICK_RADIUS + 0.8) return;
    const input = this.lastInput;
    const power = Math.max(MIN_KICK_POWER, p.charge);
    // Same resolution as the real kick, so the guide shows the assisted result.
    const aim = resolveHumanKick(s, p, type, power, input.moveX, input.moveY, input.finesse);
    const plan = planKick(s, p, type, aim.power, aim.dirX, aim.dirY, { ...aim, sprinting: isSprinting(p, input.sprint) });
    const b: Ball = { x: startX, y: startY, z: plan.z, vx: plan.vx, vy: plan.vy, vz: plan.vz, spin: plan.spin };
    const color = POWER_COLORS[type];
    let crossedGoalLine = false;
    for (let i = 1; i <= 240; i++) {
      const px = b.x;
      stepBall(b, DT);
      if ((px < PITCH_LENGTH && b.x >= PITCH_LENGTH) || (px > 0 && b.x <= 0)) {
        crossedGoalLine = true;
        break;
      }
      if (b.y < 0 || b.y > PITCH_WIDTH) break;
      if (type === 'lob' && b.z === 0 && b.vz > 0 && i > 3) break;
      if (b.z === 0 && Math.hypot(b.vx, b.vy) < 1) break;
      if (i % 4 === 0) {
        const q = project(b.x, b.y, b.z);
        g.fillStyle(color, Math.max(0.25, 0.9 - i / 300)).fillRect(this.snap(q.x), this.snap(q.y), 1, 1);
      }
    }
    const travel = Math.hypot(b.x - startX, b.y - startY);
    const r = Math.max(0.6, travel * Math.tan((plan.errorDeg * aim.errorMul * Math.PI) / 180));
    g.fillStyle(color, 0.9);
    if (crossedGoalLine) {
      // Where it crosses the goal line, at height.
      const q = project(b.x, b.y, b.z);
      g.fillRect(this.snap(q.x) - 1, this.snap(q.y), 3, 1).fillRect(this.snap(q.x), this.snap(q.y) - 1, 1, 3);
    } else {
      for (let a = 0; a < Math.PI * 2; a += 0.25) {
        const q = project(b.x + Math.cos(a) * r, b.y + Math.sin(a) * r);
        g.fillRect(this.snap(q.x), this.snap(q.y), 1, 1);
      }
    }
    if (aim.target >= 0) {
      const t = s.players[aim.target];
      for (let a = 0; a < Math.PI * 2; a += 0.4) {
        const q = project(t.x + Math.cos(a) * 0.8, t.y + Math.sin(a) * 0.8);
        g.fillRect(this.snap(q.x), this.snap(q.y), 1, 1);
      }
    }
  }

  private place(fig: Figure, x: number, y: number): void {
    const p = project(x, y);
    const sx = this.snap(p.x);
    const sy = this.snap(p.y);
    fig.sprite.setPosition(sx, sy).setDepth(p.y + 1);
    fig.shadow.setPosition(sx, sy).setDepth(p.y - 0.5);
  }

  /** Rounds to the nearest screen pixel (1/zoom art pixels): smooth motion, no texel shimmer. */
  private snap(v: number): number {
    return Math.round(v * this.zoom) / this.zoom;
  }

  private updateCamera(v: View, dt: number): void {
    const cam = this.cameras.main;
    const s = this.state;
    // Mostly the ball, a bit the controlled player, and ahead in the ball's direction.
    const me = this.running ? s.players[s.controlled] : undefined;
    const mx = me && !me.sentOff ? v.players[me.id * 4] : v.bx;
    const my = me && !me.sentOff ? v.players[me.id * 4 + 1] : v.by;
    const look = Math.max(-6, Math.min(6, s.ball.vx * 0.3));
    const target = project(v.bx * 0.75 + mx * 0.25 + look, v.by * 0.75 + my * 0.25);
    const k = 1 - Math.exp(-dt * (this.running ? 6 : 2));
    this.camX += (target.x - this.camX) * k;
    this.camY += (target.y - this.camY) * k;

    const halfW = cam.width / this.zoom / 2;
    const halfH = cam.height / this.zoom / 2;
    const cx = WORLD_W > halfW * 2 ? Math.min(Math.max(this.camX, halfW), WORLD_W - halfW) : WORLD_W / 2;
    const cy = WORLD_H > halfH * 2 ? Math.min(Math.max(this.camY, halfH), WORLD_H - halfH) : WORLD_H / 2;
    // Align to whole screen pixels so the texel grid stays stable while scrolling.
    const ox = Math.round(cam.width / 2 - cx * this.zoom);
    const oy = Math.round(cam.height / 2 - cy * this.zoom);
    cam.centerOn((cam.width / 2 - ox) / this.zoom, (cam.height / 2 - oy) / this.zoom);
  }

  private drawRadar(v: View): void {
    const ctx = this.radar.getContext('2d');
    if (!ctx) return;
    const k = this.radar.width / PITCH_LENGTH;
    ctx.fillStyle = 'rgba(10, 30, 10, 0.8)';
    ctx.fillRect(0, 0, this.radar.width, this.radar.height);
    ctx.strokeStyle = 'rgba(240, 240, 230, 0.5)';
    ctx.strokeRect(0.5, 0.5, this.radar.width - 1, this.radar.height - 1);
    ctx.beginPath();
    ctx.moveTo(this.radar.width / 2, 0);
    ctx.lineTo(this.radar.width / 2, this.radar.height);
    ctx.stroke();
    const s = this.state;
    s.players.forEach((p, i) => {
      if (p.sentOff) return;
      ctx.fillStyle = p.team === 'home' ? (p.gk ? '#46aa50' : '#e04848') : p.gk ? '#e8d640' : '#4a7ae0';
      const x = Math.round(v.players[i * 4] * k);
      const y = Math.round(v.players[i * 4 + 1] * k);
      ctx.fillRect(x - 2, y - 2, 4, 4);
      if (p.id === s.controlled) {
        ctx.strokeStyle = '#f4d35e';
        ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
      }
    });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(Math.round(v.bx * k) - 1, Math.round(v.by * k) - 1, 3, 3);
  }

  private handleEvents(events: MatchEvent[]): void {
    for (const e of events) {
      const name = e.team ? TEAM_NAME[e.team] : '';
      switch (e.type) {
        case 'kick':
          sfx.kick(e.power ?? 0.5);
          break;
        case 'bounce':
          sfx.bounce(e.power ?? 0.3);
          break;
        case 'tackle':
        case 'block':
          sfx.bounce(0.7);
          break;
        case 'post':
        case 'bar':
          sfx.post();
          this.message(e.type === 'post' ? 'POST!' : 'CROSSBAR!');
          break;
        case 'save':
        case 'catch':
          sfx.save();
          if (e.type === 'save') this.message('SAVE!');
          break;
        case 'goal':
          sfx.whistle('long');
          sfx.cheer();
          this.message(this.state.settings.mode === 'match' ? `GOAL! ${name}` : 'GOAL!', 2.4);
          break;
        case 'foul':
          sfx.whistle('short');
          this.message('FOUL');
          break;
        case 'card': {
          const p = e.playerId !== undefined ? this.state.players[e.playerId] : undefined;
          const second = e.card === 'red' && p && p.yellow >= 2;
          const label = second ? 'SECOND YELLOW: RED CARD' : `${e.card?.toUpperCase()} CARD`;
          this.message(`${label}\n${name} #${p?.number ?? ''}`, 2.6);
          break;
        }
        case 'free-kick':
          this.message(`FREE KICK ${name}`);
          break;
        case 'penalty':
          this.message(`PENALTY ${name}!`, 2.4);
          break;
        case 'corner':
        case 'throw-in':
        case 'goal-kick': {
          sfx.whistle('short');
          const label = e.type === 'goal-kick' ? 'GOAL KICK' : e.type.toUpperCase();
          this.message(this.state.settings.mode === 'match' ? `${label} ${name}` : label);
          break;
        }
        case 'kickoff':
          sfx.whistle('short');
          break;
        case 'full-time': {
          sfx.whistle('end');
          this.message('FULL TIME', 3);
          const { home, away } = this.state.score;
          this.time.delayedCall(2600, () => {
            this.setRunning(false);
            this.menu.show('result', `RED ${home} - ${away} BLUE`);
          });
          break;
        }
      }
    }
  }

  private updateHud(dt: number): void {
    const s = this.state;
    if (s.settings.mode === 'match') {
      this.scoreEl.textContent = `RED ${s.score.home} - ${s.score.away} BLUE`;
      const minute = Math.min(90, Math.floor((s.clock / s.settings.duration) * 90));
      this.clockEl.textContent = `${minute}'`;
    } else {
      this.scoreEl.textContent = `TRAINING | GOALS ${s.score.home}`;
      this.clockEl.textContent = '';
    }
    this.msgTimer -= dt;
    if (this.msgTimer <= 0) this.msgEl.textContent = '';
  }

  private message(text: string, seconds = 1.6): void {
    this.msgEl.textContent = text;
    this.msgTimer = seconds;
  }
}
