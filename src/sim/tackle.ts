import {
  CENTER,
  FALL_TIME,
  FOUL_PAUSE,
  SLIDE_RECOVER,
  SLIDE_SPEED,
  SLIDE_TIME,
  TACKLE_ANIM,
  TACKLE_COOLDOWN,
  TACKLE_RANGE,
} from './constants';
import { emit } from './events';
import { random, randomRange } from './rng';
import { active, byId, dist, inPenaltyArea, other, ownGoalX, teamU } from './team';
import type { Card, Footballer, MatchState } from './types';

/** True if `tackler` comes in from behind the player he is challenging. */
function fromBehind(tackler: Footballer, victim: Footballer): boolean {
  const dx = tackler.x - victim.x;
  const dy = tackler.y - victim.y;
  const d = Math.hypot(dx, dy) || 1;
  return (victim.facingX * dx + victim.facingY * dy) / d < -0.3;
}

/**
 * Standing tackle on the carrier. Clean tackles poke the ball loose; a failed
 * one from behind can trip the carrier, which is a foul.
 */
export function standingTackle(s: MatchState, tackler: Footballer, carrier: Footballer, success: number): void {
  tackler.tackleCooldown = TACKLE_COOLDOWN;
  tackler.tackleAnim = TACKLE_ANIM;
  const dx = carrier.x - tackler.x;
  const dy = carrier.y - tackler.y;
  const d = Math.hypot(dx, dy) || 1;
  tackler.facingX = dx / d;
  tackler.facingY = dy / d;
  if (d > TACKLE_RANGE || s.possessor !== carrier.id) return;

  const behind = fromBehind(tackler, carrier);
  const fast = Math.hypot(carrier.vx, carrier.vy) > 7;
  const chance = success * (behind ? 0.5 : 1) * (fast ? 0.8 : 1);
  if (random(s.rng) < chance) {
    const ball = s.ball;
    const bx = ball.x - tackler.x;
    const by = ball.y - tackler.y;
    const bd = Math.hypot(bx, by) || 1;
    const speed = randomRange(s.rng, 3, 6);
    ball.vx = (bx / bd) * speed + tackler.vx * 0.3;
    ball.vy = (by / bd) * speed + tackler.vy * 0.3;
    ball.vz = 0;
    s.possessor = -1;
    carrier.kickCooldown = 0.35;
    s.lastTouch = tackler.team;
    s.lastToucherId = tackler.id;
    emit(s, 'tackle', { team: tackler.team, playerId: tackler.id });
  } else if (behind && random(s.rng) < 0.5) {
    commitFoul(s, tackler, carrier, randomRange(s.rng, 0.2, 0.85));
  } else {
    // Missed: off balance for a moment.
    tackler.vx *= 0.3;
    tackler.vy *= 0.3;
  }
}

export function startSlide(s: MatchState, p: Footballer, dirX: number, dirY: number): void {
  const n = Math.hypot(dirX, dirY) || 1;
  const speed = Math.max(SLIDE_SPEED, Math.hypot(p.vx, p.vy) * 1.1);
  p.facingX = dirX / n;
  p.facingY = dirY / n;
  p.vx = p.facingX * speed;
  p.vy = p.facingY * speed;
  p.slide = SLIDE_TIME;
  p.slideWonBall = false;
  p.tackleCooldown = TACKLE_COOLDOWN * 1.5;
  p.charging = null;
  p.pending = null;
  emit(s, 'tackle', { team: p.team, playerId: p.id, power: 0.3 });
}

/** Moves a sliding player; ball first is clean, man first is a foul. */
export function stepSlide(s: MatchState, p: Footballer, dt: number): void {
  const ball = s.ball;
  const slow = Math.max(0, 1 - 2.2 * dt);
  p.vx *= slow;
  p.vy *= slow;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  const feet = { x: p.x + p.facingX * 0.6, y: p.y + p.facingY * 0.6 };

  if (!p.slideWonBall && dist(feet, ball) < 0.8 && ball.z < 0.6 && s.phase === 'play') {
    const carrier = byId(s, s.possessor);
    if (!carrier || carrier.team !== p.team) {
      if (carrier) carrier.kickCooldown = 0.4;
      const speed = randomRange(s.rng, 6, 10);
      ball.vx = p.facingX * speed + randomRange(s.rng, -1.5, 1.5);
      ball.vy = p.facingY * speed + randomRange(s.rng, -1.5, 1.5);
      ball.vz = randomRange(s.rng, 0, 1);
      s.possessor = -1;
      s.lastTouch = p.team;
      s.lastToucherId = p.id;
      p.slideWonBall = true;
    }
  }

  for (const o of active(s)) {
    if (o.team === p.team || o.down > 0 || dist(feet, o) > 0.7 || s.phase !== 'play') continue;
    if (p.slideWonBall) {
      o.down = 0.8; // took the ball, then the man: a fair trip
    } else {
      const speed = Math.hypot(p.vx, p.vy);
      commitFoul(s, p, o, 0.25 + (fromBehind(p, o) ? 0.35 : 0) + speed / 40 + randomRange(s.rng, 0, 0.25));
    }
    break;
  }

  p.slide = Math.max(0, p.slide - dt);
  if (p.slide === 0) {
    p.down = SLIDE_RECOVER;
    p.vx = 0;
    p.vy = 0;
  }
}

/**
 * Whistle, card by severity (>= 0.65 yellow, >= 1.0 red), straight red for
 * denying an obvious goal-scoring opportunity. In the box it's a penalty.
 */
export function commitFoul(s: MatchState, offender: Footballer, victim: Footballer, severity: number): void {
  if (s.phase !== 'play') return;
  let card: Card = severity >= 1 ? 'red' : severity >= 0.65 ? 'yellow' : 'none';
  if (denyingGoal(s, offender, victim)) card = 'red';
  if (offender.gk && card === 'red') card = 'yellow'; // keep keepers on: no sub system yet
  if (card === 'yellow') {
    offender.yellow++;
    if (offender.yellow >= 2) card = 'red';
  }

  const penalty = inPenaltyArea(offender.team, victim.x, victim.y);
  s.foul = { offenderId: offender.id, victimId: victim.id, x: victim.x, y: victim.y, card, penalty };
  s.phase = 'foul';
  s.phaseTimer = FOUL_PAUSE;
  s.possessor = -1;
  s.passTarget = -1;
  s.ball.vx *= 0.3;
  s.ball.vy *= 0.3;
  victim.down = FALL_TIME;
  emit(s, 'foul', { team: offender.team, playerId: offender.id });
  if (card !== 'none') emit(s, 'card', { team: offender.team, playerId: offender.id, card });
}

/** Victim was through on goal: attacking third, central, no defender but the keeper between him and goal. */
function denyingGoal(s: MatchState, offender: Footballer, victim: Footballer): boolean {
  if (teamU(victim.team, victim.x) < 0.7 || Math.abs(victim.y - CENTER.y) > 20) return false;
  if (s.possessor !== victim.id && dist(victim, s.ball) > 2) return false;
  const goalX = ownGoalX(other(victim.team));
  const victimToGoal = Math.abs(goalX - victim.x);
  return !active(s).some(
    (d) => d.team === offender.team && d.id !== offender.id && !d.gk && Math.abs(goalX - d.x) < victimToGoal,
  );
}
