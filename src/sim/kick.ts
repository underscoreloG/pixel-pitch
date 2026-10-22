import { predictCrossing, stepBall } from './ball';
import {
  CENTER,
  DT,
  GOAL_WIDTH,
  GOAL_Y_MAX,
  GOAL_Y_MIN,
  KICK_COOLDOWN,
  PASS_ASSIST_CONE,
  PLAYER_JOG_SPEED,
  THROW_HEIGHT,
} from './constants';
import { emit } from './events';
import { random } from './rng';
import { active, clamp, dist, keeperOf, other, segmentDistance, targetGoalX } from './team';
import type { Ball, Footballer, KickType, MatchState, Vec2 } from './types';

export interface KickPlan {
  vx: number;
  vy: number;
  vz: number;
  /** Height the ball leaves from (a throw-in starts overhead). */
  z: number;
  /** Max random aim error either side, degrees. */
  errorDeg: number;
}

/** Launch speed (m/s) of each kick at a given power. */
const passSpeed = (power: number): number => 8 + 18 * power;
const shotSpeed = (power: number): number => 22 + 13 * power;
const lobSpeed = (power: number): number => 8 + 12 * power;

/** Highest an assisted shot crosses the goal line (the bar is at 2.44 m). */
const ASSISTED_SHOT_MAX_Z = 2;

/**
 * Deterministic launch for a kick, before random error. Shared by the sim and the aim guide.
 * `lift` overrides the upward speed (assisted shots kept under the bar).
 */
export function planKick(
  s: MatchState,
  p: Footballer,
  type: KickType,
  power: number,
  dirX: number,
  dirY: number,
  sprinting: boolean,
  lift?: number,
): KickPlan {
  const ball = s.ball;
  let speed: number;
  let vz: number;
  let errorDeg: number;
  switch (type) {
    case 'pass':
      speed = passSpeed(power);
      vz = 0.4;
      errorDeg = 1.5 + (sprinting ? 2 : 0);
      break;
    case 'shot':
      speed = shotSpeed(power);
      // A driven shot rises a little; only a maxed-out bar adds real lift.
      vz = 1.2 + 3 * power + Math.max(0, power - 0.95) * 30;
      errorDeg = 1.5 + Math.max(0, power - 0.85) * 12 + (sprinting ? 2 : 0);
      break;
    case 'lob':
      speed = lobSpeed(power);
      vz = 5 + 7 * power;
      errorDeg = 3;
      break;
  }
  let z = ball.z;
  if (s.setPiece?.type === 'throw-in') {
    // Every button throws, lob throws higher. Released from above the head.
    speed = 6 + 10 * power;
    vz = (type === 'lob' ? 3 : 1.5) + 2 * power;
    errorDeg = 2;
    z = THROW_HEIGHT;
  } else if (ball.z > 0.3) {
    // Volleys are harder to keep down and on target.
    errorDeg += 4;
    vz += 1.5;
  }
  if (lift !== undefined && s.setPiece?.type !== 'throw-in') vz = lift;
  return { vx: dirX * speed + p.vx * 0.25, vy: dirY * speed + p.vy * 0.25, vz, z, errorDeg };
}

/** Strikes the ball with random error (scaled by `errorMul`) and hands it back to the sim. */
export function kickBall(
  s: MatchState,
  p: Footballer,
  type: KickType,
  power: number,
  dirX: number,
  dirY: number,
  opts: { sprinting?: boolean; errorMul?: number; target?: number; lift?: number } = {},
): void {
  const plan = planKick(s, p, type, power, dirX, dirY, opts.sprinting ?? false, opts.lift);
  const throwIn = s.setPiece?.type === 'throw-in';
  const err = ((random(s.rng) * 2 - 1) * plan.errorDeg * (opts.errorMul ?? 1) * Math.PI) / 180;
  const cos = Math.cos(err);
  const sin = Math.sin(err);
  const ball = s.ball;
  ball.x = s.setPiece ? s.setPiece.x : ball.x;
  ball.y = s.setPiece ? s.setPiece.y : ball.y;
  ball.z = plan.z;
  ball.vx = plan.vx * cos - plan.vy * sin;
  ball.vy = plan.vx * sin + plan.vy * cos;
  const wobble = (random(s.rng) * 2 - 1) * 0.6 * power * Math.min(1, opts.errorMul ?? 1);
  ball.vz = plan.vz + (type === 'shot' && !throwIn ? wobble : 0);

  const n = Math.hypot(ball.vx, ball.vy) || 1;
  p.facingX = ball.vx / n;
  p.facingY = ball.vy / n;
  p.kickCooldown = KICK_COOLDOWN;
  if (throwIn) p.throwAnim = 0.3;
  else p.kickAnim = 0.2;
  p.charging = null;
  p.charge = 0;
  p.pending = null;
  s.possessor = -1;
  s.setPiece = null;
  s.lastTouch = p.team;
  s.lastToucherId = p.id;
  s.passTarget = opts.target ?? -1;
  emit(s, 'kick', { power, team: p.team, playerId: p.id });
}

/** Teammate closest to the aim direction, within the assist cone, preferring an open lane. */
export function findPassTarget(s: MatchState, p: Footballer, dirX: number, dirY: number): Footballer | undefined {
  let best: Footballer | undefined;
  let bestScore = Infinity;
  const opps = active(s).filter((o) => o.team !== p.team);
  for (const t of active(s)) {
    if (t.team !== p.team || t.id === p.id) continue;
    const dx = t.x - p.x;
    const dy = t.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d < 1.5 || d > 55) continue;
    const angle = Math.acos(Math.max(-1, Math.min(1, (dx * dirX + dy * dirY) / d)));
    if (angle > PASS_ASSIST_CONE) continue;
    // Prefer on-line over near: angle dominates, distance breaks ties. The keeper is a last resort,
    // and a mate with an opponent sitting in the lane loses out to an open one nearby.
    const lane = Math.min(...opps.map((o) => segmentDistance(o, p, t)));
    const score = angle * 30 + d * 0.15 + (t.gk ? 25 : 0) + Math.max(0, 3 - lane) * 4;
    if (score < bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

/** Where to aim a pass so it meets a moving receiver. */
export function leadPoint(p: Footballer, t: Footballer, ballSpeed: number): Vec2 {
  // Lead the run, but only a little: runners change direction, and the receiver comes to meet the ball anyway.
  const flight = Math.min(0.4, dist(p, t) / Math.max(ballSpeed * 0.7, 1));
  return { x: t.x + t.vx * flight, y: t.y + t.vy * flight };
}

/** Kick direction from the stick (or facing), snapped to a teammate for passes and lobs. */
export function aimFor(
  s: MatchState,
  p: Footballer,
  type: KickType,
  moveX: number,
  moveY: number,
  power: number,
): { dirX: number; dirY: number; target: number } {
  let dx = moveX;
  let dy = moveY;
  const m = Math.hypot(dx, dy);
  if (m < 0.3) {
    dx = p.facingX;
    dy = p.facingY;
  } else {
    dx /= m;
    dy /= m;
  }
  if (type === 'shot' || s.setPiece?.type === 'penalty') return { dirX: dx, dirY: dy, target: -1 };
  const t = findPassTarget(s, p, dx, dy);
  if (!t) return { dirX: dx, dirY: dy, target: -1 };
  const lead = leadPoint(p, t, type === 'lob' ? lobSpeed(power) : passSpeed(power));
  // From the ball, not the player: it sits up to a metre ahead of him.
  const from = kickOrigin(s);
  const lx = lead.x - from.x;
  const ly = lead.y - from.y;
  const l = Math.hypot(lx, ly) || 1;
  return { dirX: lx / l, dirY: ly / l, target: t.id };
}

/** Ground-pass power that still has `arrival` m/s of pace when it gets `distance` away. */
export function passPowerFor(distance: number, arrival = 10): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (speedAfter(passSpeed(mid), distance) < arrival) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Lob power that lands about `distance` away. */
export function lobPowerFor(distance: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    if (lobCarry(lobSpeed(mid), 5 + 7 * mid) < distance) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** Ball speed once a pass struck at `v0` has travelled `distance` (0 if it stops short). */
function speedAfter(v0: number, distance: number): number {
  const b: Ball = { x: 0, y: 0, z: 0, vx: v0, vy: 0, vz: 0.4 };
  for (let i = 0; i < 900 && b.vx > 0.05; i++) {
    stepBall(b, DT);
    if (b.x >= distance) return b.vx;
  }
  return 0;
}

function lobCarry(speed: number, vz: number): number {
  const b: Ball = { x: 0, y: 0, z: 0, vx: speed, vy: 0, vz };
  for (let i = 0; i < 600; i++) {
    stepBall(b, DT);
    if (b.z === 0 && b.vz >= 0 && i > 2) break;
  }
  return b.x;
}

export interface HumanKick {
  power: number;
  dirX: number;
  dirY: number;
  /** Intended receiver, -1 if none. */
  target: number;
  /** Scales the random aim error. */
  errorMul: number;
  /** Upward speed override (assisted shots kept under the bar). */
  lift?: number;
}

/** Where the ball is kicked from: the set-piece spot for a dead ball. */
function kickOrigin(s: MatchState): Vec2 {
  return s.setPiece ? { x: s.setPiece.x, y: s.setPiece.y } : { x: s.ball.x, y: s.ball.y };
}

/**
 * Turns the human's stick and charge into a kick. Assisted (default): passes
 * go to the teammate in the stick direction with the right weight (charge only
 * sets how firm), shots aimed near the goal are pulled inside the posts and kept
 * under the bar, the kicker's own run is allowed for, and random error is small.
 * Manual: stick direction and charge, as they are.
 */
export function resolveHumanKick(
  s: MatchState,
  p: Footballer,
  type: KickType,
  charge: number,
  moveX: number,
  moveY: number,
): HumanKick {
  const m = Math.hypot(moveX, moveY);
  const dirX = m < 0.3 ? p.facingX : moveX / m;
  const dirY = m < 0.3 ? p.facingY : moveY / m;
  if (s.settings.assist === false) return { power: charge, dirX, dirY, target: -1, errorMul: 1 };
  const throwIn = s.setPiece?.type === 'throw-in';
  if ((type === 'shot' && !throwIn) || s.setPiece?.type === 'penalty') {
    return assistShot(s, p, charge, dirX, dirY, m < 0.3);
  }
  const speedOf = (power: number) => (throwIn ? 6 + 10 * power : type === 'lob' ? lobSpeed(power) : passSpeed(power));

  let aim = aimFor(s, p, type, moveX, moveY, charge);
  if (aim.target < 0) {
    const run = allowForRun(p, aim.dirX, aim.dirY, speedOf(charge));
    return { power: charge, ...run, target: -1, errorMul: 0.6 };
  }
  const mate = s.players[aim.target];
  const from = kickOrigin(s);
  let ideal = charge;
  // The lead point depends on ball speed and the speed on the distance: two rounds settle it.
  for (let i = 0; i < 2; i++) {
    const d = dist(from, leadPoint(p, mate, speedOf(ideal)));
    // Ground passes: the charge sets how firmly it arrives, from 10 m/s (tap) to 18 m/s (full bar).
    // The receiver is set for it and takes either.
    ideal = throwIn ? throwPowerFor(d) : type === 'lob' ? lobPowerFor(d) : passPowerFor(d, 10 + 8 * charge);
    aim = aimFor(s, p, type, moveX, moveY, ideal);
  }
  const power = type === 'pass' && !throwIn ? ideal : clamp(ideal * (0.92 + 0.16 * charge), 0.05, 1);
  return {
    power,
    ...allowForRun(p, aim.dirX, aim.dirY, speedOf(power)),
    target: aim.target,
    errorMul: type === 'pass' && !throwIn ? 0.2 : 0.4,
  };
}

/**
 * Foot direction that sends the ball exactly along `dir` once the kicker's own
 * run is added (a quarter of his velocity carries into the ball).
 */
function allowForRun(p: Footballer, dirX: number, dirY: number, speed: number): { dirX: number; dirY: number } {
  const wx = p.vx * 0.25;
  const wy = p.vy * 0.25;
  const along = dirX * wx + dirY * wy;
  const k = along + Math.sqrt(Math.max(0, along * along - (wx * wx + wy * wy) + speed * speed));
  return { dirX: (k * dirX - wx) / speed, dirY: (k * dirY - wy) / speed };
}

/** Shots roughly at goal are aimed at a point inside the posts; no stick means the far corner. */
function assistShot(s: MatchState, p: Footballer, charge: number, dx: number, dy: number, neutral: boolean): HumanKick {
  const from = kickOrigin(s);
  const goalX = targetGoalX(p.team);
  const gx = goalX - from.x;
  const gy = CENTER.y - from.y;
  const dG = Math.hypot(gx, gy) || 1;
  const towardGoal = (dx * gx + dy * gy) / dG > Math.cos(0.9);
  if (dG > 40 || (!towardGoal && !neutral)) return { power: charge, dirX: dx, dirY: dy, target: -1, errorMul: 1 };
  let ty: number;
  if (neutral) {
    const keeper = keeperOf(s, other(p.team));
    const side = keeper && keeper.y > CENTER.y ? -1 : 1;
    ty = CENTER.y + side * (GOAL_WIDTH / 2 - 0.6);
  } else {
    // Where the stick line meets the goal line, pulled inside the posts.
    const k = Math.abs(dx) > 0.05 ? gx / dx : -1;
    ty = k > 0 ? from.y + dy * k : CENTER.y;
  }
  ty = clamp(ty, GOAL_Y_MIN + 0.45, GOAL_Y_MAX - 0.45);
  const ax = goalX - from.x;
  const ay = ty - from.y;
  const n = Math.hypot(ax, ay) || 1;
  const dir = allowForRun(p, ax / n, ay / n, shotSpeed(charge));
  return { power: charge, ...dir, target: -1, errorMul: 0.25, lift: liftUnderBar(s, p, charge, dir, goalX) };
}

/** Upward speed that brings a shot in under the bar, or undefined if it already dips under. */
function liftUnderBar(s: MatchState, p: Footballer, power: number, dir: { dirX: number; dirY: number }, goalX: number): number | undefined {
  const plan = planKick(s, p, 'shot', power, dir.dirX, dir.dirY, false);
  const from = kickOrigin(s);
  const crossZ = (vz: number) =>
    predictCrossing({ x: from.x, y: from.y, z: plan.z, vx: plan.vx, vy: plan.vy, vz }, goalX, 3)?.z ?? 0;
  if (crossZ(plan.vz) <= ASSISTED_SHOT_MAX_Z) return undefined;
  let lo = 0;
  let hi = plan.vz;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    if (crossZ(mid) > ASSISTED_SHOT_MAX_Z) hi = mid;
    else lo = mid;
  }
  return lo;
}

/** Throw-in power that lands about 90% of the way (it bounces on to the receiver). */
function throwPowerFor(distance: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    const b: Ball = { x: 0, y: 0, z: THROW_HEIGHT, vx: 6 + 10 * mid, vy: 0, vz: 1.5 + 2 * mid };
    for (let j = 0; j < 300 && !(b.z === 0 && b.vz >= 0 && j > 2); j++) stepBall(b, DT);
    if (b.x < distance * 0.9) lo = mid;
    else hi = mid;
  }
  return hi;
}

export function isSprinting(p: Footballer, sprintHeld: boolean): boolean {
  return sprintHeld && Math.hypot(p.vx, p.vy) > PLAYER_JOG_SPEED;
}
