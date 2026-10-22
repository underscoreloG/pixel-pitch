import { predictCrossing, stepBall } from './ball';
import {
  CENTER,
  DT,
  FINESSE_SPIN,
  GOAL_WIDTH,
  GOAL_Y_MAX,
  GOAL_Y_MIN,
  KICK_COOLDOWN,
  PASS_ASSIST_CONE,
  PITCH_LENGTH,
  PITCH_WIDTH,
  PLAYER_JOG_SPEED,
  THROUGH_ARRIVAL,
  THROW_HEIGHT,
} from './constants';
import { emit } from './events';
import { random } from './rng';
import { active, attackDir, clamp, dist, keeperOf, other, segmentDistance, targetGoalX } from './team';
import type { Ball, Footballer, KickType, MatchState, Vec2 } from './types';

export interface KickPlan {
  vx: number;
  vy: number;
  vz: number;
  /** Height the ball leaves from (a throw-in starts overhead). */
  z: number;
  /** Max random aim error either side, degrees. */
  errorDeg: number;
  /** Side spin the ball leaves with (see Ball.spin). */
  spin: number;
}

/** How a kick is struck, beyond its type and power. */
export interface KickStyle {
  sprinting?: boolean;
  /** Curled: placement over pace, with side spin (shots and crosses). */
  finesse?: boolean;
  /** Upward speed override (assisted shots kept under the bar). */
  lift?: number;
  /** Side spin, rad/s the path turns (+ turns it from +x towards +y). */
  spin?: number;
}

/** Launch speed (m/s) of each kick at a given power. */
const passSpeed = (power: number): number => 8 + 18 * power;
const shotSpeed = (power: number): number => 22 + 13 * power;
const lobSpeed = (power: number): number => 8 + 12 * power;

/** Highest an assisted shot crosses the goal line (the bar is at 2.44 m). */
const ASSISTED_SHOT_MAX_Z = 2;

/** Deterministic launch for a kick, before random error. Shared by the sim and the aim guide. */
export function planKick(
  s: MatchState,
  p: Footballer,
  type: KickType,
  power: number,
  dirX: number,
  dirY: number,
  style: KickStyle = {},
): KickPlan {
  const ball = s.ball;
  const sprinting = !!style.sprinting;
  let speed: number;
  let vz: number;
  let errorDeg: number;
  switch (type) {
    case 'pass':
    case 'through':
      speed = passSpeed(power);
      vz = 0.4;
      errorDeg = 1.5 + (sprinting ? 2 : 0);
      break;
    case 'shot':
      if (style.finesse) {
        // Side-footed and curled: slower, lower, and more precise.
        speed = shotSpeed(power) * 0.8;
        vz = 1 + 2.5 * power;
        errorDeg = 0.9 + (sprinting ? 1.5 : 0);
      } else {
        speed = shotSpeed(power);
        // A driven shot rises a little; only a maxed-out bar adds real lift.
        vz = 1.2 + 3 * power + Math.max(0, power - 0.95) * 30;
        errorDeg = 1.5 + Math.max(0, power - 0.85) * 12 + (sprinting ? 2 : 0);
      }
      break;
    case 'lob':
      // Whipped (finesse) crosses are flatter and quicker.
      speed = lobSpeed(power) * (style.finesse ? 1.15 : 1);
      vz = (5 + 7 * power) * (style.finesse ? 0.75 : 1);
      errorDeg = 3;
      break;
  }
  let z = ball.z;
  const throwIn = s.setPiece?.type === 'throw-in';
  if (throwIn) {
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
  if (style.lift !== undefined && !throwIn) vz = style.lift;
  return {
    vx: dirX * speed + p.vx * 0.25,
    vy: dirY * speed + p.vy * 0.25,
    vz,
    z,
    errorDeg,
    spin: throwIn ? 0 : (style.spin ?? 0),
  };
}

/** Strikes the ball with random error (scaled by `errorMul`) and hands it back to the sim. */
export function kickBall(
  s: MatchState,
  p: Footballer,
  type: KickType,
  power: number,
  dirX: number,
  dirY: number,
  opts: KickStyle & { errorMul?: number; target?: number; space?: Vec2 } = {},
): void {
  const plan = planKick(s, p, type, power, dirX, dirY, opts);
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
  ball.spin = plan.spin;

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
  s.passSpace = opts.space ?? null;
  emit(s, 'kick', { power, team: p.team, playerId: p.id, kick: type });
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

/**
 * Where the receiver of a pass should run: onto a through ball's space until
 * the ball has reached it, otherwise the given meeting point on its path.
 */
export function receiveAt(s: MatchState, meet: Vec2): Vec2 {
  const sp = s.passSpace;
  if (!sp) return meet;
  const v = Math.hypot(s.ball.vx, s.ball.vy) || 1;
  const ahead = ((sp.x - s.ball.x) * s.ball.vx + (sp.y - s.ball.y) * s.ball.vy) / v;
  return ahead > 1 ? sp : meet;
}

/** Where to aim a pass so it meets a moving receiver. */
export function leadPoint(p: Footballer, t: Footballer, ballSpeed: number): Vec2 {
  // Lead the run, but only a little: runners change direction, and the receiver comes to meet the ball anyway.
  const flight = Math.min(0.4, dist(p, t) / Math.max(ballSpeed * 0.7, 1));
  return { x: t.x + t.vx * flight, y: t.y + t.vy * flight };
}

/**
 * Where a through ball goes: into the space ahead of the runner, towards the
 * goal he attacks, further the more it is charged. The stick bends it.
 */
export function throughSpace(t: Footballer, dirX: number, dirY: number, charge: number): Vec2 {
  const rx = attackDir(t.team) + dirX * 0.3;
  const ry = dirY * 0.6;
  const n = Math.hypot(rx, ry) || 1;
  const ahead = 5 + 12 * charge;
  return {
    x: clamp(t.x + (rx / n) * ahead, 5, PITCH_LENGTH - 5),
    y: clamp(t.y + (ry / n) * ahead, 2, PITCH_WIDTH - 2),
  };
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

/** Lob power that lands about `distance` away (whipped: a flatter, quicker cross). */
export function lobPowerFor(distance: number, whipped = false): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 10; i++) {
    const mid = (lo + hi) / 2;
    const k = whipped ? 1.15 : 1;
    const lift = whipped ? 0.75 : 1;
    if (lobCarry(lobSpeed(mid) * k, (5 + 7 * mid) * lift) < distance) lo = mid;
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

export interface HumanKick extends KickStyle {
  power: number;
  dirX: number;
  dirY: number;
  /** Intended receiver, -1 if none. */
  target: number;
  /** Scales the random aim error. */
  errorMul: number;
  /** Through balls: the space it is played into. */
  space?: Vec2;
}

/** Where the ball is kicked from: the set-piece spot for a dead ball. */
function kickOrigin(s: MatchState): Vec2 {
  return s.setPiece ? { x: s.setPiece.x, y: s.setPiece.y } : { x: s.ball.x, y: s.ball.y };
}

/**
 * Turns the human's stick and charge into a kick. Assisted (default): passes
 * go to the teammate in the stick direction with the right weight (charge only
 * sets how firm), through balls into the space ahead of him, shots aimed near
 * the goal are pulled inside the posts and kept under the bar, finesse shots
 * and crosses curl onto their target, the kicker's own run is allowed for, and
 * random error is small. Manual: stick direction and charge, as they are.
 */
export function resolveHumanKick(
  s: MatchState,
  p: Footballer,
  type: KickType,
  charge: number,
  moveX: number,
  moveY: number,
  finesse = false,
): HumanKick {
  const m = Math.hypot(moveX, moveY);
  const dirX = m < 0.3 ? p.facingX : moveX / m;
  const dirY = m < 0.3 ? p.facingY : moveY / m;
  const throwIn = s.setPiece?.type === 'throw-in';
  // Only shots and crosses curl; a throw-in is thrown.
  const curled = finesse && !throwIn && (type === 'shot' || type === 'lob');
  if (s.settings.assist === false) {
    const spin = curled ? curlTowards(dirX, dirY, CENTER.y - s.ball.y) * FINESSE_SPIN : 0;
    return { power: charge, dirX, dirY, target: -1, errorMul: 1, finesse: curled, spin };
  }
  if ((type === 'shot' && !throwIn) || s.setPiece?.type === 'penalty') {
    return assistShot(s, p, charge, dirX, dirY, m < 0.3, curled);
  }
  if (type === 'through' && !throwIn) return assistThrough(s, p, charge, dirX, dirY);
  const speedOf = (power: number) => (throwIn ? 6 + 10 * power : type === 'lob' ? lobSpeed(power) : passSpeed(power));

  let aim = aimFor(s, p, type, dirX, dirY, charge);
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
    ideal = throwIn
      ? throwPowerFor(d)
      : type === 'lob'
        ? lobPowerFor(d, curled)
        : passPowerFor(d, 10 + 8 * charge);
    aim = aimFor(s, p, type, dirX, dirY, ideal);
  }
  const power = type === 'pass' && !throwIn ? ideal : clamp(ideal * (0.92 + 0.16 * charge), 0.05, 1);
  const errorMul = type === 'pass' && !throwIn ? 0.2 : 0.4;
  if (curled) {
    // A whipped cross bends away from the keeper, towards the passer's side of the target.
    const lead = leadPoint(p, mate, speedOf(power));
    const spin = curlTowards(lead.x - from.x, lead.y - from.y, attackDir(p.team) * -1, true) * FINESSE_SPIN * 0.8;
    const style = { finesse: true, spin };
    return { power, ...curlHeading(s, p, type, power, style, from, lead), target: aim.target, errorMul, ...style };
  }
  return { power, ...allowForRun(p, aim.dirX, aim.dirY, speedOf(power)), target: aim.target, errorMul };
}

/** Kick direction snapped to the teammate in the aim direction (passes and lobs), led for his run. */
function aimFor(
  s: MatchState,
  p: Footballer,
  type: KickType,
  dirX: number,
  dirY: number,
  power: number,
): { dirX: number; dirY: number; target: number } {
  const t = findPassTarget(s, p, dirX, dirY);
  if (!t) return { dirX, dirY, target: -1 };
  const lead = leadPoint(p, t, type === 'lob' ? lobSpeed(power) : passSpeed(power));
  // From the ball, not the player: it sits up to a metre ahead of him.
  const from = kickOrigin(s);
  const lx = lead.x - from.x;
  const ly = lead.y - from.y;
  const l = Math.hypot(lx, ly) || 1;
  return { dirX: lx / l, dirY: ly / l, target: t.id };
}

/** Through ball: into the space ahead of the teammate in the stick direction, weighted for him to run onto. */
function assistThrough(s: MatchState, p: Footballer, charge: number, dirX: number, dirY: number): HumanKick {
  const t = findPassTarget(s, p, dirX, dirY);
  if (!t) return { power: charge, ...allowForRun(p, dirX, dirY, passSpeed(charge)), target: -1, errorMul: 0.6 };
  const from = kickOrigin(s);
  const space = throughSpace(t, dirX, dirY, charge);
  const d = Math.max(dist(from, space), 1);
  const power = passPowerFor(d, THROUGH_ARRIVAL);
  const dir = allowForRun(p, (space.x - from.x) / d, (space.y - from.y) / d, passSpeed(power));
  return { power, ...dir, target: t.id, errorMul: 0.3, space };
}

/** Aim for a curled kick so that, with `spin`, it passes through `target`. */
export function curledAim(
  s: MatchState,
  p: Footballer,
  type: KickType,
  power: number,
  spin: number,
  target: Vec2,
): { dirX: number; dirY: number } {
  return curlHeading(s, p, type, power, { finesse: true, spin }, kickOrigin(s), target);
}

/**
 * Sign of the spin that bends a ball travelling along (dx, dy) towards the
 * given side: `toward` is a y offset (or, with `alongX`, an x offset).
 */
export function curlTowards(dx: number, dy: number, toward: number, alongX = false): number {
  // Turning (dx, dy) towards n has the sign of the cross product d x n.
  const cross = alongX ? -dy * toward : dx * toward;
  return cross >= 0 ? 1 : -1;
}

/**
 * Heading that makes a spinning ball pass through `target`, found by
 * simulating its path and correcting the miss (it starts wide and bends in).
 */
function curlHeading(
  s: MatchState,
  p: Footballer,
  type: KickType,
  power: number,
  style: KickStyle,
  from: Vec2,
  target: Vec2,
): { dirX: number; dirY: number } {
  let ang = Math.atan2(target.y - from.y, target.x - from.x);
  for (let i = 0; i < 4; i++) {
    const plan = planKick(s, p, type, power, Math.cos(ang), Math.sin(ang), style);
    const b: Ball = { x: from.x, y: from.y, z: plan.z, vx: plan.vx, vy: plan.vy, vz: plan.vz, spin: plan.spin };
    let best = Infinity;
    let near: Vec2 = target;
    for (let k = 0; k < 240; k++) {
      stepBall(b, DT);
      const d = dist(b, target);
      if (d < best) {
        best = d;
        near = { x: b.x, y: b.y };
      } else if (d > best + 2) break;
    }
    let miss = Math.atan2(target.y - from.y, target.x - from.x) - Math.atan2(near.y - from.y, near.x - from.x);
    if (miss > Math.PI) miss -= Math.PI * 2;
    if (miss < -Math.PI) miss += Math.PI * 2;
    ang += miss;
  }
  return { dirX: Math.cos(ang), dirY: Math.sin(ang) };
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

/**
 * Shots roughly at goal are aimed at a point inside the posts; no stick means
 * the far corner. A finesse shot goes tighter to the post and curls in from
 * outside it.
 */
function assistShot(
  s: MatchState,
  p: Footballer,
  charge: number,
  dx: number,
  dy: number,
  neutral: boolean,
  finesse: boolean,
): HumanKick {
  const from = kickOrigin(s);
  const goalX = targetGoalX(p.team);
  const gx = goalX - from.x;
  const gy = CENTER.y - from.y;
  const dG = Math.hypot(gx, gy) || 1;
  const towardGoal = (dx * gx + dy * gy) / dG > Math.cos(0.9);
  if (dG > 40 || (!towardGoal && !neutral)) {
    const spin = finesse ? curlTowards(dx, dy, CENTER.y - from.y) * FINESSE_SPIN : 0;
    return { power: charge, dirX: dx, dirY: dy, target: -1, errorMul: 1, finesse, spin };
  }
  const margin = finesse ? 0.3 : 0.45;
  let ty: number;
  if (neutral) {
    const keeper = keeperOf(s, other(p.team));
    const side = keeper && keeper.y > CENTER.y ? -1 : 1;
    ty = CENTER.y + side * (GOAL_WIDTH / 2 - margin - 0.15);
  } else {
    // Where the stick line meets the goal line, pulled inside the posts.
    const k = Math.abs(dx) > 0.05 ? gx / dx : -1;
    ty = k > 0 ? from.y + dy * k : CENTER.y;
  }
  ty = clamp(ty, GOAL_Y_MIN + margin, GOAL_Y_MAX - margin);
  const ax = goalX - from.x;
  const ay = ty - from.y;
  const n = Math.hypot(ax, ay) || 1;
  if (finesse) {
    // Curl it in towards the middle of the goal: it starts outside the post and bends back.
    const inward = CENTER.y - ty || CENTER.y - from.y || 1;
    const style: KickStyle = { finesse: true, spin: curlTowards(ax, ay, inward) * FINESSE_SPIN };
    const dir = curlHeading(s, p, 'shot', charge, style, from, { x: goalX, y: ty });
    return { power: charge, ...dir, target: -1, errorMul: 0.2, ...style, lift: liftUnderBar(s, p, charge, dir, goalX, style) };
  }
  const dir = allowForRun(p, ax / n, ay / n, shotSpeed(charge));
  return { power: charge, ...dir, target: -1, errorMul: 0.25, lift: liftUnderBar(s, p, charge, dir, goalX, {}) };
}

/** Upward speed that brings a shot in under the bar, or undefined if it already dips under. */
function liftUnderBar(
  s: MatchState,
  p: Footballer,
  power: number,
  dir: { dirX: number; dirY: number },
  goalX: number,
  style: KickStyle,
): number | undefined {
  const plan = planKick(s, p, 'shot', power, dir.dirX, dir.dirY, style);
  const from = kickOrigin(s);
  const crossZ = (vz: number) =>
    predictCrossing({ x: from.x, y: from.y, z: plan.z, vx: plan.vx, vy: plan.vy, vz, spin: plan.spin }, goalX, 3)?.z ?? 0;
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
