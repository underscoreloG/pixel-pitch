import { predictCrossing, stepBall } from './ball';
import {
  AI_LEVELS,
  BALL_RADIUS,
  CENTER,
  DT,
  GOAL_AREA_DEPTH,
  GOAL_AREA_WIDTH,
  GOAL_HEIGHT,
  GOAL_WIDTH,
  KEEPER_ACCEL,
  KEEPER_DIVE_TIME,
  KEEPER_HOLD_TIME,
  KEEPER_LEVELS,
  KEEPER_MAX_CATCH_SPEED,
  KEEPER_MAX_DIVING_Z,
  KEEPER_MAX_STANDING_Z,
  KEEPER_REACH_DIVING,
  KEEPER_REACH_STANDING,
  KEEPER_RECOVER_TIME,
  KEEPER_SPEED,
  KEEPER_SURE_CATCH_SPEED,
  PENALTY_READ,
  PITCH_WIDTH,
} from './constants';
import { emit } from './events';
import { kickBall, passPowerFor, puntPowerFor } from './kick';
import { random, randomRange } from './rng';
import { active, attackDir, byId, clamp, dist, inPenaltyArea, ownGoalX } from './team';
import type { Ball, Footballer, MatchState } from './types';

/** Chance a keeper bites on a fake shot, per difficulty. */
const BITE_CHANCE = [0.75, 0.55, 0.35];
/** Chance a hard shot right at the edge of a diving keeper's reach gets past him, per difficulty. */
const FINGERTIP_MISS = [0.95, 0.8, 0.6];

export function stepKeeper(s: MatchState, k: Footballer, dt: number): void {
  const gk = k.gk!;
  const ball = s.ball;
  const dir = attackDir(k.team);
  gk.stateTimer = Math.max(0, gk.stateTimer - dt);
  gk.ignoreBall = Math.max(0, gk.ignoreBall - dt);

  switch (gk.state) {
    case 'holding':
      k.vx = 0;
      k.vy = 0;
      k.facingX = dir;
      k.facingY = 0;
      ball.x = k.x + dir * 0.35;
      ball.y = k.y;
      ball.z = 1;
      ball.vx = ball.vy = ball.vz = 0;
      ball.spin = 0;
      if (gk.stateTimer === 0 && s.phase === 'play') distribute(s, k);
      return;

    case 'diving':
      if (gk.stateTimer === 0) {
        gk.state = 'down';
        gk.stateTimer = KEEPER_RECOVER_TIME;
        k.vx = 0;
        k.vy = 0;
      }
      break;

    case 'down':
      if (gk.stateTimer === 0) gk.state = 'positioning';
      break;

    case 'positioning':
      if (penaltyGuess(s, k) || biteOnFake(s, k)) break;
      if (!react(s, k, dt)) moveTo(k, positionTarget(s, k), dt, shooterWindingUp(s, k) ? 1.5 : KEEPER_SPEED);
      break;
  }

  k.x += k.vx * dt;
  k.y += k.vy * dt;
  if (gk.state !== 'down') tryClaimBall(s, k);
}

/**
 * From 11 m there is no time to react: as the penalty is struck the keeper
 * commits to a side. He reads it right with PENALTY_READ odds, otherwise he
 * goes the wrong way or (sometimes) stays put and reacts as normal. The
 * human's keeper dives the way the stick is held, or stays up without it.
 */
function penaltyGuess(s: MatchState, k: Footballer): boolean {
  const gk = k.gk!;
  if (!gk.facingPenalty || s.setPiece) return false;
  gk.facingPenalty = false;
  let dive: number;
  if (k.team === 'home' && !s.settings.autoplay) {
    if (Math.abs(s.stick.y) < 0.3) return false;
    dive = Math.sign(s.stick.y);
  } else {
    const crossing = predictCrossing(s.ball, k.x, 2);
    if (!crossing) return false;
    const side = Math.sign(crossing.y - CENTER.y) || (random(s.rng) < 0.5 ? 1 : -1);
    const read = random(s.rng) < PENALTY_READ[s.settings.difficulty];
    if (!read && random(s.rng) < 0.08) return false;
    dive = read ? side : -side;
  }
  gk.state = 'diving';
  gk.stateTimer = KEEPER_DIVE_TIME;
  gk.diveDir = dive;
  k.vx = 0;
  k.vy = gk.diveDir * KEEPER_LEVELS[s.settings.difficulty].diveSpeed;
  return true;
}

/** An opponent fakes a shot close in: the keeper may commit early and go down the wrong way. */
function biteOnFake(s: MatchState, k: Footballer): boolean {
  const faker = active(s).find((p) => p.team !== k.team && p.lastFakeTick === s.tick);
  if (!faker || dist(faker, { x: ownGoalX(k.team), y: CENTER.y }) > 20) return false;
  if (random(s.rng) > BITE_CHANCE[s.settings.difficulty]) return false;
  const gk = k.gk!;
  gk.state = 'diving';
  gk.stateTimer = KEEPER_DIVE_TIME;
  gk.diveDir = faker.facingY >= 0 ? 1 : -1;
  k.vx = 0;
  k.vy = gk.diveDir * 4;
  return true;
}

/** Sets his feet (barely moves) while an opponent winds up a shot in range. */
function shooterWindingUp(s: MatchState, k: Footballer): boolean {
  const carrier = byId(s, s.possessor);
  return (
    !!carrier &&
    carrier.team !== k.team &&
    carrier.charging === 'shot' &&
    dist(carrier, { x: ownGoalX(k.team), y: CENTER.y }) < 25
  );
}

/** Reads a shot on goal and dives if it can't be reached on foot. Returns true if it took over movement. */
function react(s: MatchState, k: Footballer, dt: number): boolean {
  const gk = k.gk!;
  const ball = s.ball;
  const dir = attackDir(k.team);
  const incoming = -dir * ball.vx > 4 && dir * (ball.x - k.x) > 0 && s.possessor < 0;
  const crossing = incoming ? predictCrossing(ball, k.x, 2) : null;
  const onTarget =
    crossing !== null && Math.abs(crossing.y - CENTER.y) < GOAL_WIDTH / 2 + 1.5 && crossing.z < GOAL_HEIGHT + 0.6;
  if (!onTarget || !crossing) {
    gk.threatTimer = 0;
    return false;
  }

  const level = KEEPER_LEVELS[s.settings.difficulty];
  gk.threatTimer += dt;
  if (gk.threatTimer < level.reaction) return false;

  const lateral = crossing.y - k.y;
  const t = Math.max(crossing.t, 0.05);
  const onFoot = KEEPER_REACH_STANDING + KEEPER_SPEED * t * 0.7;
  // On his feet if he can get there, or while it's still far off: diving now would leave him on the ground as it arrives.
  if (Math.abs(lateral) <= onFoot || t > KEEPER_DIVE_TIME) {
    moveTo(k, { x: k.x, y: crossing.y }, dt, KEEPER_SPEED);
    return true;
  }
  gk.state = 'diving';
  gk.stateTimer = KEEPER_DIVE_TIME;
  gk.diveDir = Math.sign(lateral);
  k.vx = 0;
  // Some dives are better than others: a corner he can only just reach is a coin toss, not a sure save.
  const spring = level.diveSpeed * (0.7 + 0.35 * random(s.rng));
  k.vy = gk.diveDir * Math.min(spring, Math.abs(lateral) / t);
  return true;
}

/** Narrows the angle: sits on the ball-to-goal line, further out the closer the ball. Rushes 1v1s. */
function positionTarget(s: MatchState, k: Footballer): { x: number; y: number } {
  const ball = s.ball;
  const goalX = ownGoalX(k.team);
  if (s.setPiece?.type === 'penalty') return { x: goalX + attackDir(k.team) * 0.3, y: CENTER.y };

  // Loose ball in the box and the keeper gets there first: go and claim it.
  const carrier = byId(s, s.possessor);
  const ballSpeed = Math.hypot(ball.vx, ball.vy);
  if (!carrier && !s.setPiece && inPenaltyArea(k.team, ball.x, ball.y) && ballSpeed < 8 && ball.z < 1.5) {
    const keeperDist = dist(k, ball);
    const nearestOpp = Math.min(...active(s).filter((p) => p.team !== k.team).map((p) => dist(p, ball)));
    if (keeperDist < nearestOpp + 2) return { x: ball.x + ball.vx * 0.3, y: ball.y + ball.vy * 0.3 };
  }
  // A high ball dropping into his six-yard box: come and take it.
  if (!carrier && !s.setPiece && ball.z > 1) {
    const drop = dropPoint(ball);
    if (drop && Math.abs(drop.x - goalX) < GOAL_AREA_DEPTH + 1 && Math.abs(drop.y - CENTER.y) < GOAL_AREA_WIDTH / 2) {
      return drop;
    }
  }

  const gx = ball.x - goalX;
  const gy = ball.y - CENTER.y;
  const d = Math.max(Math.hypot(gx, gy), 0.001);
  let off = clamp(0.5 + (35 - d) * 0.1, 0.5, 4);
  if (carrier && carrier.team !== k.team && d < 14) off = clamp(d * 0.6, 0.5, 7);
  return {
    x: goalX + (gx / d) * off,
    y: CENTER.y + clamp((gy / d) * off, -GOAL_WIDTH / 2 - 0.5, GOAL_WIDTH / 2 + 0.5),
  };
}

/** Where a high ball comes down to a keeper's catching height, within 2 s. */
function dropPoint(ball: Ball): { x: number; y: number } | null {
  const b = { ...ball };
  for (let i = 0; i < 120; i++) {
    stepBall(b, DT);
    if (b.vz < 0 && b.z <= 2.3) return { x: b.x, y: b.y };
  }
  return null;
}

function moveTo(k: Footballer, target: { x: number; y: number }, dt: number, maxSpeed: number): void {
  const dx = target.x - k.x;
  const dy = target.y - k.y;
  const d = Math.hypot(dx, dy);
  // Arrive behaviour: full speed when far, ease in when close.
  const speed = Math.min(maxSpeed, d * 4);
  const tvx = d > 0.01 ? (dx / d) * speed : 0;
  const tvy = d > 0.01 ? (dy / d) * speed : 0;
  const dvx = tvx - k.vx;
  const dvy = tvy - k.vy;
  const dv = Math.hypot(dvx, dvy);
  const maxDv = KEEPER_ACCEL * dt;
  if (dv > maxDv) {
    k.vx += (dvx / dv) * maxDv;
    k.vy += (dvy / dv) * maxDv;
  } else {
    k.vx = tvx;
    k.vy = tvy;
  }
  if (d > 0.3) {
    k.facingX = dx / d;
    k.facingY = dy / d;
  }
}

/** Catch or parry when the ball is within reach. Harder, higher shots are more often parried. */
function tryClaimBall(s: MatchState, k: Footballer): void {
  const gk = k.gk!;
  const ball = s.ball;
  if (gk.ignoreBall > 0 || s.setPiece || (s.phase !== 'play' && s.phase !== 'shootout')) return;
  // Hands only inside his own box.
  if (!inPenaltyArea(k.team, ball.x, ball.y)) return;
  const carrier = byId(s, s.possessor);
  if (carrier?.team === k.team) return;
  const diving = gk.state === 'diving';
  const reach = (diving ? KEEPER_REACH_DIVING : KEEPER_REACH_STANDING) + BALL_RADIUS;
  const maxZ = diving ? KEEPER_MAX_DIVING_Z : KEEPER_MAX_STANDING_Z;
  if (dist(ball, k) > reach || ball.z > maxZ) return;

  const speed = Math.hypot(ball.vx, ball.vy, ball.vz);
  // A firm shot at full stretch can beat the dive: fingertips aren't hands.
  if (diving) {
    const stretch = clamp((Math.abs(ball.y - k.y) - 0.3) / (reach - 0.3), 0, 1);
    if (random(s.rng) < stretch * stretch * clamp((speed - 15) / 15, 0, 1) * FINGERTIP_MISS[s.settings.difficulty]) {
      gk.ignoreBall = 0.3;
      return;
    }
  }
  const t = clamp((speed - KEEPER_SURE_CATCH_SPEED) / (KEEPER_MAX_CATCH_SPEED - KEEPER_SURE_CATCH_SPEED), 0, 1);
  const catchChance = (1 - 0.85 * t) * (diving ? 0.8 : 1) * KEEPER_LEVELS[s.settings.difficulty].catchFactor;
  const wasShot = speed > 12;
  if (carrier) carrier.kickCooldown = Math.max(carrier.kickCooldown, 0.4);
  s.possessor = -1;
  s.passTarget = -1;
  s.lastTouch = k.team;
  s.lastToucherId = k.id;

  if (random(s.rng) < catchChance) {
    gk.state = 'holding';
    gk.stateTimer = KEEPER_HOLD_TIME;
    emit(s, wasShot ? 'save' : 'catch', { team: k.team, playerId: k.id });
    return;
  }
  const dir = attackDir(k.team);
  ball.vx = dir * (Math.abs(ball.vx) * 0.35 + 2);
  ball.spin = 0;
  ball.vy = ball.vy * 0.3 + randomRange(s.rng, -5, 5);
  ball.vz = randomRange(s.rng, 1.5, 4);
  gk.ignoreBall = 0.4;
  emit(s, 'save', { team: k.team, playerId: k.id });
}

/** Rolls it to a free defender if one is open, otherwise kicks long to the strikers. */
/**
 * Goal kicks go long, upfield to the attacker with most room. After a catch he
 * rolls it to a defender only if nobody is near him; otherwise long too.
 */
function distribute(s: MatchState, k: Footballer): void {
  const gk = k.gk!;
  const goalKick = gk.goalKick;
  gk.goalKick = false;
  const mates = active(s).filter((p) => p.team === k.team && !p.gk);
  const opps = active(s).filter((p) => p.team !== k.team);
  const room = (at: { x: number; y: number }) => Math.min(...opps.map((o) => dist(o, at)));
  gk.state = 'positioning';
  gk.ignoreBall = 0.6;
  const errorMul = AI_LEVELS[s.settings.difficulty].accuracy;
  const open = goalKick
    ? undefined
    : mates
        .filter((m) => m.role === 'DF' && dist(m, k) < 30 && room(m) > 12)
        .sort((a, b) => dist(a, k) - dist(b, k))[0];
  if (open) {
    const d = dist(open, k);
    kickBall(s, k, 'pass', passPowerFor(d), (open.x - k.x) / d, (open.y - k.y) / d, { errorMul, target: open.id });
    return;
  }
  // Land it where a teammate upfield gets there well before any opponent: on him, or wider of him.
  const dir = attackDir(k.team);
  let best: { mate: Footballer; spot: { x: number; y: number }; race: number } | undefined;
  for (const m of mates) {
    if (m.role === 'DF' || dir * (m.x - k.x) < 30) continue;
    const wide = Math.sign(m.y - CENTER.y) || 1;
    for (const off of [0, 6]) {
      const want = { x: m.x, y: clamp(m.y + wide * off, 3, PITCH_WIDTH - 3) };
      const d = dist(k, want);
      const spot = d > MAX_PUNT ? { x: k.x + ((want.x - k.x) / d) * MAX_PUNT, y: k.y + ((want.y - k.y) / d) * MAX_PUNT } : want;
      const race = room(spot) - dist(m, spot);
      if (!best || race > best.race) best = { mate: m, spot, race };
    }
  }
  const spot = best?.spot ?? { x: k.x + dir * 55, y: CENTER.y + (random(s.rng) < 0.5 ? -18 : 18) };
  const d = dist(k, spot) || 1;
  kickBall(s, k, 'lob', puntPowerFor(d), (spot.x - k.x) / d, (spot.y - k.y) / d, {
    errorMul,
    target: best?.mate.id,
    punt: true,
  });
}

/** Furthest a keeper's kick is aimed (it bounces on from there). */
const MAX_PUNT = 62;
