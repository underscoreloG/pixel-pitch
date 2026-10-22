import { stepBall } from './ball';
import { DT, KICK_COOLDOWN, PASS_ASSIST_CONE, PLAYER_JOG_SPEED, THROW_HEIGHT } from './constants';
import { emit } from './events';
import { random } from './rng';
import { active, dist } from './team';
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

/** Deterministic launch for a kick, before random error. Shared by the sim and the aim guide. */
export function planKick(
  s: MatchState,
  p: Footballer,
  type: KickType,
  power: number,
  dirX: number,
  dirY: number,
  sprinting: boolean,
): KickPlan {
  const ball = s.ball;
  let speed: number;
  let vz: number;
  let errorDeg: number;
  switch (type) {
    case 'pass':
      speed = 7 + 15 * power;
      vz = 0.4;
      errorDeg = 1.5 + (sprinting ? 2 : 0);
      break;
    case 'shot':
      speed = 14 + 16 * power;
      // Over-hitting skies the ball.
      vz = 1 + 4 * power + Math.max(0, power - 0.85) * 20;
      errorDeg = 2 + Math.max(0, power - 0.7) * 15 + (sprinting ? 3 : 0);
      break;
    case 'lob':
      speed = 8 + 12 * power;
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
  opts: { sprinting?: boolean; errorMul?: number; target?: number } = {},
): void {
  const plan = planKick(s, p, type, power, dirX, dirY, opts.sprinting ?? false);
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
  ball.vz = plan.vz + (type === 'shot' && !throwIn ? (random(s.rng) * 2 - 1) * 0.6 * power : 0);

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

/** Teammate closest to the aim direction, within the assist cone. */
export function findPassTarget(s: MatchState, p: Footballer, dirX: number, dirY: number): Footballer | undefined {
  let best: Footballer | undefined;
  let bestScore = Infinity;
  for (const t of active(s)) {
    if (t.team !== p.team || t.id === p.id) continue;
    const dx = t.x - p.x;
    const dy = t.y - p.y;
    const d = Math.hypot(dx, dy);
    if (d < 3 || d > 55) continue;
    const angle = Math.acos(Math.max(-1, Math.min(1, (dx * dirX + dy * dirY) / d)));
    if (angle > PASS_ASSIST_CONE) continue;
    // Prefer on-line over near: angle dominates, distance breaks ties. The keeper is a last resort.
    const score = angle * 30 + d * 0.15 + (t.gk ? 25 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

/** Where to aim a pass so it meets a moving receiver. */
export function leadPoint(p: Footballer, t: Footballer, ballSpeed: number): Vec2 {
  // Lead the run, but not by more than ~0.8 s: runners change direction.
  const flight = Math.min(0.8, dist(p, t) / Math.max(ballSpeed * 0.7, 1));
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
  const lead = leadPoint(p, t, type === 'lob' ? 8 + 12 * power : 7 + 15 * power);
  const lx = lead.x - p.x;
  const ly = lead.y - p.y;
  const l = Math.hypot(lx, ly) || 1;
  return { dirX: lx / l, dirY: ly / l, target: t.id };
}

/** Ground-pass power that reaches `distance` with a little pace left, from the rolling model. */
export function passPowerFor(distance: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (rollDistance(7 + 15 * mid) < distance + 2.5) lo = mid;
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
    if (lobCarry(8 + 12 * mid, 5 + 7 * mid) < distance) lo = mid;
    else hi = mid;
  }
  return hi;
}

function rollDistance(v0: number): number {
  const b: Ball = { x: 0, y: 0, z: 0, vx: v0, vy: 0, vz: 0.4 };
  for (let i = 0; i < 900 && b.vx > 0.05; i++) stepBall(b, DT);
  return b.x;
}

function lobCarry(speed: number, vz: number): number {
  const b: Ball = { x: 0, y: 0, z: 0, vx: speed, vy: 0, vz };
  for (let i = 0; i < 600; i++) {
    stepBall(b, DT);
    if (b.z === 0 && b.vz >= 0 && i > 2) break;
  }
  return b.x;
}

export function isSprinting(p: Footballer, sprintHeld: boolean): boolean {
  return sprintHeld && Math.hypot(p.vx, p.vy) > PLAYER_JOG_SPEED;
}
