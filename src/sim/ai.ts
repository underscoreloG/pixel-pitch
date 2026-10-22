import { stepBall } from './ball';
import {
  AI_LEVELS,
  CENTER,
  DT,
  FREE_KICK_DISTANCE,
  GOAL_WIDTH,
  KICK_RADIUS,
  PENALTY_AREA_DEPTH,
  PITCH_LENGTH,
  PITCH_WIDTH,
  PLAYER_SPRINT_SPEED,
  SLIDE_RANGE,
  TACKLE_RANGE,
} from './constants';
import { kickBall, leadPoint, lobPowerFor, passPowerFor } from './kick';
import { canKickNow, canMove, locomote } from './player';
import { random } from './rng';
import { standingTackle, startSlide } from './tackle';
import {
  active,
  attackDir,
  byId,
  clamp,
  dist,
  formationSpot,
  inPenaltyArea,
  keeperOf,
  other,
  ownGoalX,
  targetGoalX,
  teamU,
  toPitch,
} from './team';
import type { Footballer, MatchState, Team, Vec2 } from './types';

/** Shared per-tick facts so 20 brains don't each recompute them. */
export interface TickInfo {
  /** Ball positions every 0.1 s for the next 2 s. */
  path: Vec2[];
  /** Per team, the outfield player who can reach the ball first. */
  chaser: Record<Team, number>;
  /** Per team, the second one (covers or supports). */
  second: Record<Team, number>;
}

export function computeTickInfo(s: MatchState): TickInfo {
  const b = { ...s.ball };
  const path: Vec2[] = [{ x: b.x, y: b.y }];
  for (let i = 1; i <= 120; i++) {
    stepBall(b, DT);
    if (i % 6 === 0) path.push({ x: b.x, y: b.y });
  }
  const chaser: Record<Team, number> = { home: -1, away: -1 };
  const second: Record<Team, number> = { home: -1, away: -1 };
  for (const team of ['home', 'away'] as const) {
    const ranked = active(s)
      .filter((p) => p.team === team && !p.gk && canMove(p))
      .map((p) => ({ id: p.id, t: interceptTime(p, path) }))
      .sort((a, b) => a.t - b.t);
    chaser[team] = ranked[0]?.id ?? -1;
    second[team] = ranked[1]?.id ?? -1;
  }
  return { path, chaser, second };
}

/** First sample time at which the player could be at the ball. */
function interceptTime(p: Footballer, path: Vec2[]): number {
  for (let i = 0; i < path.length; i++) {
    const t = i * 0.1;
    if (dist(p, path[i]) <= PLAYER_SPRINT_SPEED * t + 0.6) return t;
  }
  return 2 + dist(p, path[path.length - 1]) / PLAYER_SPRINT_SPEED;
}

function interceptPoint(p: Footballer, path: Vec2[]): Vec2 {
  for (let i = 0; i < path.length; i++) {
    if (dist(p, path[i]) <= PLAYER_SPRINT_SPEED * i * 0.1 + 0.6) return path[i];
  }
  return path[path.length - 1];
}

/** One CPU-controlled outfield player for one tick: move, and maybe kick or tackle. */
export function stepAI(s: MatchState, p: Footballer, info: TickInfo, dt: number): void {
  const level = AI_LEVELS[s.settings.difficulty];
  const target = decide(s, p, info);
  const dx = target.x - p.x;
  const dy = target.y - p.y;
  const d = Math.hypot(dx, dy);
  // Arrive: ease off near the spot so the team shape doesn't jitter.
  const urgency = target.sprint ? 1 : Math.max(0.3, Math.min(1, d / 4));
  const stop = target.precise ? 0.1 : 0.4;
  locomote(
    p,
    d > stop ? (dx / d) * urgency : 0,
    d > stop ? (dy / d) * urgency : 0,
    !!target.sprint && d > 2,
    s.possessor === p.id,
    dt,
    level.speed,
  );
  if (d <= stop && target.faceX !== undefined) {
    p.facingX = target.faceX;
    p.facingY = target.faceY ?? 0;
  }
}

interface Target extends Vec2 {
  sprint?: boolean;
  /** Stop right on the spot (set-piece run-up) instead of roughly near it. */
  precise?: boolean;
  faceX?: number;
  faceY?: number;
}

function decide(s: MatchState, p: Footballer, info: TickInfo): Target {
  const ball = s.ball;
  const sp = s.setPiece;

  if (sp) {
    if (sp.takerId === p.id) return takeSetPiece(s, p);
    return keepDistance(s, p, formationSpot(s, p));
  }
  if (s.phase !== 'play') return formationSpot(s, p);

  const carrier = byId(s, s.possessor);
  if (carrier?.id === p.id) return carry(s, p);

  // Receiver of a pass, or first to a loose ball (unless it's a pass to a teammate): go and get it.
  const passToMate = s.passTarget >= 0 && s.players[s.passTarget].team === p.team;
  if (
    s.passTarget === p.id ||
    (!carrier && !passToMate && info.chaser[p.team] === p.id && !keeperHolding(s))
  ) {
    return { ...interceptPoint(p, info.path), sprint: true };
  }

  if (carrier && carrier.team !== p.team) {
    // Home teammates leave pressing to the human unless he is far away.
    const humanFar =
      p.team !== 'home' || !!s.settings.autoplay || dist(s.players[s.controlled], carrier) > 12;
    if (info.chaser[p.team] === p.id && humanFar) return press(s, p, carrier);
    if (info.second[p.team] === p.id) return cover(p, carrier);
  }

  const spot = formationSpot(s, p);
  // Strikers stay level with the last defender at most (a rough onside line).
  if (p.role === 'FW') {
    const line = lastDefenderU(s, other(p.team));
    const u = Math.min(teamU(p.team, spot.x), Math.max(line, teamU(p.team, ball.x)));
    spot.x = p.team === 'home' ? u * PITCH_LENGTH : (1 - u) * PITCH_LENGTH;
  }
  return spot;
}

function keeperHolding(s: MatchState): boolean {
  return s.players.some((q) => q.gk?.state === 'holding');
}

/** Deepest outfield defender of `team`, in the attackers' team coordinates. */
function lastDefenderU(s: MatchState, team: Team): number {
  const attackers = other(team);
  let deepest = 0;
  for (const d of active(s)) if (d.team === team && !d.gk) deepest = Math.max(deepest, teamU(attackers, d.x));
  return deepest;
}

/** Close down the carrier from the goal side; tackle when close, sometimes slide. */
function press(s: MatchState, p: Footballer, carrier: Footballer): Target {
  const level = AI_LEVELS[s.settings.difficulty];
  const goal = { x: ownGoalX(p.team), y: CENTER.y };
  const toGoalX = goal.x - carrier.x;
  const toGoalY = goal.y - carrier.y;
  const g = Math.hypot(toGoalX, toGoalY) || 1;
  const d = dist(p, carrier);
  if (p.think === 0 && p.tackleCooldown === 0) {
    p.think = level.decision;
    if (d < TACKLE_RANGE && random(s.rng) < 0.6) standingTackle(s, p, carrier, level.tackle);
    else if (d > 1.5 && d < SLIDE_RANGE && behind(p, carrier) && random(s.rng) < 0.08) {
      startSlide(s, p, s.ball.x - p.x, s.ball.y - p.y);
    }
  }
  // Close in: from far, cut off the route to goal; when near, go for the ball itself.
  if (d < 3) return { x: s.ball.x, y: s.ball.y };
  const aheadX = carrier.x + carrier.vx * 0.3 + (toGoalX / g) * 0.8;
  const aheadY = carrier.y + carrier.vy * 0.3 + (toGoalY / g) * 0.8;
  return { x: aheadX, y: aheadY, sprint: true };
}

function behind(p: Footballer, carrier: Footballer): boolean {
  const dx = p.x - carrier.x;
  const dy = p.y - carrier.y;
  return (carrier.facingX * dx + carrier.facingY * dy) / (Math.hypot(dx, dy) || 1) < -0.3;
}

/** Sit between the carrier and goal, a few meters off. */
function cover(p: Footballer, carrier: Footballer): Target {
  const goal = { x: ownGoalX(p.team), y: CENTER.y };
  const dx = goal.x - carrier.x;
  const dy = goal.y - carrier.y;
  const d = Math.hypot(dx, dy) || 1;
  const off = Math.min(8, d * 0.5);
  return { x: carrier.x + (dx / d) * off, y: carrier.y + (dy / d) * off };
}

/** With the ball: shoot in range, pass to a better-placed teammate, otherwise dribble at goal. */
function carry(s: MatchState, p: Footballer): Target {
  const level = AI_LEVELS[s.settings.difficulty];
  const goal = { x: targetGoalX(p.team), y: CENTER.y };
  const toGoal = dist(p, goal);
  const opps = active(s).filter((o) => o.team !== p.team);
  const pressure = Math.min(...opps.map((o) => dist(o, p)));

  if (p.think === 0 && canKickNow(s, p)) {
    p.think = level.decision;
    const angleOk = Math.abs(p.y - CENTER.y) < toGoal * 0.8;
    if (angleOk && (toGoal < 16 || (toGoal < 25 && (pressure < 3 || random(s.rng) < 0.3)))) {
      shoot(s, p, goal, toGoal);
      return { x: p.x, y: p.y };
    }
    const pass = bestPass(s, p, opps);
    if (pass && (pass.score > 6 || (pressure < 2.5 && pass.score > -3) || teamU(p.team, p.x) < 0.2)) {
      const d = dist(p, pass.lead);
      const lofted = d > 28 || pass.laneBlocked;
      const power = lofted ? lobPowerFor(d) : passPowerFor(d);
      const n = d || 1;
      kickBall(s, p, lofted ? 'lob' : 'pass', power, (pass.lead.x - p.x) / n, (pass.lead.y - p.y) / n, {
        errorMul: level.accuracy,
        target: pass.mate.id,
      });
      return { x: p.x, y: p.y };
    }
  }

  // Dribble at goal, sidestepping opponents in front (never turning back on them).
  const fx = (goal.x - p.x) / toGoal;
  const fy = (goal.y - p.y) / toGoal;
  let dx = fx;
  let dy = fy;
  let space = true;
  for (const o of opps) {
    const ox = p.x - o.x;
    const oy = p.y - o.y;
    const od = Math.hypot(ox, oy);
    if (od > 7 || -(ox * fx + oy * fy) <= 0) continue;
    if (od < 4) space = false;
    // Perpendicular to the run, on the side away from the defender.
    const side = Math.sign(ox * -fy + oy * fx) || 1;
    dx += -fy * side * (2.5 / od);
    dy += fx * side * (2.5 / od);
  }
  const n = Math.hypot(dx, dy) || 1;
  // Stay on the pitch.
  const ty = clamp(p.y + (dy / n) * 5, 2, PITCH_WIDTH - 2);
  return { x: p.x + (dx / n) * 5, y: ty, sprint: space };
}

function shoot(s: MatchState, p: Footballer, goal: Vec2, toGoal: number, penalty = false): void {
  const level = AI_LEVELS[s.settings.difficulty];
  const keeper = keeperOf(s, other(p.team));
  // Far post from the keeper, a little inside it. Penalties: a random side, a bit of variety.
  const side = penalty ? (random(s.rng) < 0.5 ? 1 : -1) : keeper && keeper.y > CENTER.y ? -1 : 1;
  const ty = goal.y + side * (GOAL_WIDTH / 2 - 0.7 - (penalty ? random(s.rng) * 0.8 : 0));
  const dx = goal.x - p.x;
  const dy = ty - p.y;
  const n = Math.hypot(dx, dy) || 1;
  const power = penalty ? 0.62 + random(s.rng) * 0.18 : clamp(0.5 + toGoal * 0.012, 0.5, 0.82);
  kickBall(s, p, 'shot', power, dx / n, dy / n, { errorMul: level.accuracy });
}

interface PassOption {
  mate: Footballer;
  lead: Vec2;
  score: number;
  laneBlocked: boolean;
}

/** Scores every teammate: forward progress, space around him, and how open the lane is. */
function bestPass(s: MatchState, p: Footballer, opps: Footballer[]): PassOption | undefined {
  let best: PassOption | undefined;
  for (const mate of active(s)) {
    if (mate.team !== p.team || mate.id === p.id || mate.gk || !canMove(mate)) continue;
    const d = dist(p, mate);
    if (d < 6 || d > 45) continue;
    const lead = leadPoint(p, mate, 16);
    const progress = (teamU(p.team, lead.x) - teamU(p.team, p.x)) * PITCH_LENGTH;
    const space = Math.min(10, ...opps.map((o) => dist(o, lead)));
    const lane = Math.min(10, ...opps.map((o) => segmentDistance(o, p, lead)));
    const laneBlocked = lane < 2.5;
    const marked = space < 3 ? -6 : 0;
    const score = progress * 0.5 + space + marked - d * 0.05 + (laneBlocked ? -8 : lane * 0.4);
    if (!best || score > best.score) best = { mate, lead, score, laneBlocked };
  }
  return best;
}

function segmentDistance(pt: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby || 1;
  const t = clamp(((pt.x - a.x) * abx + (pt.y - a.y) * aby) / l2, 0, 1);
  return Math.hypot(pt.x - (a.x + abx * t), pt.y - (a.y + aby * t));
}

/** Walk up behind the dead ball, then play it once the delay is over. */
function takeSetPiece(s: MatchState, p: Footballer): Target {
  const sp = s.setPiece!;
  const dir = attackDir(p.team);
  // Approach from behind, facing upfield (or infield for a throw-in).
  const fx = sp.type === 'throw-in' ? 0 : dir;
  const fy = sp.type === 'throw-in' ? (sp.y < CENTER.y ? 1 : -1) : 0;
  const spot = { x: sp.x - fx * 0.6, y: sp.y - fy * 0.6, faceX: fx, faceY: fy, precise: true };
  if (dist(p, sp) > KICK_RADIUS * 0.9 || sp.timer > 0) return spot;

  const level = AI_LEVELS[s.settings.difficulty];
  const goal = { x: targetGoalX(p.team), y: CENTER.y };
  const toGoal = dist(sp, goal);
  if (sp.type === 'penalty' || (sp.type === 'free-kick' && toGoal < 26)) {
    shoot(s, p, goal, toGoal, sp.type === 'penalty');
    return spot;
  }
  if (sp.type === 'corner') {
    // Cross towards the penalty spot area, near a teammate if one is there.
    const pen = { x: goal.x - dir * 9, y: CENTER.y + (random(s.rng) - 0.5) * 10 };
    const d = dist(sp, pen);
    kickBall(s, p, 'lob', lobPowerFor(d), (pen.x - sp.x) / d, (pen.y - sp.y) / d, { errorMul: level.accuracy });
    return spot;
  }
  const opps = active(s).filter((o) => o.team !== p.team);
  const pass = bestPass(s, p, opps);
  if (pass) {
    const d = dist(sp, pass.lead);
    const lofted = d > 28 || pass.laneBlocked;
    kickBall(
      s,
      p,
      lofted ? 'lob' : 'pass',
      lofted ? lobPowerFor(d) : passPowerFor(d),
      (pass.lead.x - sp.x) / d,
      (pass.lead.y - sp.y) / d,
      { errorMul: level.accuracy, target: pass.mate.id },
    );
  } else {
    kickBall(s, p, 'lob', 0.7, dir, 0, { errorMul: level.accuracy });
  }
  return spot;
}

/** Opponents of a set piece stay 9.15 m from the ball; nobody but the taker in the box at a penalty. */
function keepDistance(s: MatchState, p: Footballer, spot: Vec2): Vec2 {
  const sp = s.setPiece!;
  if (sp.type === 'kickoff') {
    // Everyone in their own half, the defending side outside the centre circle.
    const half = toPitch(p.team, 0.48, 0).x;
    const x = p.team === 'home' ? Math.min(spot.x, half) : Math.max(spot.x, half);
    const away = p.team !== sp.team ? FREE_KICK_DISTANCE + 0.5 : 0;
    const d = dist({ x, y: spot.y }, sp);
    if (d >= away) return { x, y: spot.y };
    const n = d || 1;
    return { x: sp.x + ((x - sp.x) / n) * away, y: sp.y + ((spot.y - sp.y) / n) * away };
  }
  if (sp.type === 'penalty') {
    const defending = other(sp.team);
    if (!inPenaltyArea(defending, spot.x, spot.y)) return spot;
    const edge = ownGoalX(defending) + attackDir(defending) * (PENALTY_AREA_DEPTH + 1.5);
    return { x: edge, y: spot.y };
  }
  if (p.team === sp.team || sp.type === 'throw-in') return spot;
  const dx = spot.x - sp.x;
  const dy = spot.y - sp.y;
  const d = Math.hypot(dx, dy);
  if (d >= FREE_KICK_DISTANCE + 0.5) return spot;
  const n = d || 1;
  return { x: sp.x + (dx / n) * (FREE_KICK_DISTANCE + 0.5), y: sp.y + (dy / n) * (FREE_KICK_DISTANCE + 0.5) };
}
