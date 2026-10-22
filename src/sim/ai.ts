import { stepBall } from './ball';
import {
  AI_LEVELS,
  CENTER,
  DT,
  AI_DRIBBLE_PACE,
  FINESSE_SPIN,
  FREE_KICK_DISTANCE,
  GOAL_WIDTH,
  HEADER_MAX_Z,
  KICK_RADIUS,
  PENALTY_AREA_DEPTH,
  PITCH_LENGTH,
  PITCH_WIDTH,
  PLAYER_SPRINT_SPEED,
  SLIDE_RANGE,
  TACKLE_RANGE,
  THROUGH_ARRIVAL,
} from './constants';
import { curlTowards, curledAim, kickBall, leadPoint, lobPowerFor, passPowerFor, receiveAt, throughSpace } from './kick';
import { offsideLineU, offsidePosition } from './offside';
import { speedFactor } from './squad';
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
  segmentDistance,
  targetGoalX,
  teamU,
  toPitch,
} from './team';
import type { Footballer, MatchState, Team, Vec2 } from './types';

/** Shared per-tick facts so 20 brains don't each recompute them. */
export interface TickInfo {
  /** Ball positions (with height) every 0.1 s for the next 2 s. */
  path: (Vec2 & { z: number })[];
  /** Per team, the outfield player who can reach the ball first. */
  chaser: Record<Team, number>;
  /** Per team, the second one (covers or supports). */
  second: Record<Team, number>;
}

export function computeTickInfo(s: MatchState): TickInfo {
  const b = { ...s.ball };
  const path: TickInfo['path'] = [{ x: b.x, y: b.y, z: b.z }];
  for (let i = 1; i <= 120; i++) {
    stepBall(b, DT);
    if (i % 6 === 0) path.push({ x: b.x, y: b.y, z: b.z });
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

/** First sample time at which the player could be at the ball (overhead balls only once they come down to head height). */
function interceptTime(p: Footballer, path: TickInfo['path']): number {
  for (let i = 0; i < path.length; i++) {
    const t = i * 0.1;
    if (path[i].z <= HEADER_MAX_Z && dist(p, path[i]) <= PLAYER_SPRINT_SPEED * t + 0.6) return t;
  }
  return 2 + dist(p, path[path.length - 1]) / PLAYER_SPRINT_SPEED;
}

function interceptPoint(p: Footballer, path: TickInfo['path']): Vec2 {
  for (let i = 0; i < path.length; i++) {
    if (path[i].z <= HEADER_MAX_Z && dist(p, path[i]) <= PLAYER_SPRINT_SPEED * i * 0.1 + 0.6) return path[i];
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
    // With the ball the CPU is a step slower than its markers, so a chaser can get back at it.
    level.speed * speedFactor(p) * (s.possessor === p.id ? AI_DRIBBLE_PACE : 1),
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
    const meet = interceptPoint(p, info.path);
    return { ...(s.passTarget === p.id ? receiveAt(s, meet) : meet), sprint: true };
  }

  if (carrier && carrier.team !== p.team) {
    // Home teammates leave pressing to the human unless he is far away.
    const humanFar =
      p.team !== 'home' || !!s.settings.autoplay || dist(s.players[s.controlled], carrier) > 12;
    if (info.chaser[p.team] === p.id && humanFar) return press(s, p, carrier);
    if (info.second[p.team] === p.id) return cover(p, carrier);
    // The defender in front of a carrier running at goal steps out to meet him.
    if (p.role === 'DF' && goalSideDefender(s, p.team, carrier) === p.id) return press(s, p, carrier);
  }

  // A cross coming (a teammate wide in the final third, or one in the air): attack the box.
  const run = boxRun(s, p, carrier);
  if (run) return run;

  return onside(s, p, formationSpot(s, p));
}

/**
 * Holds a run at the offside line until the ball is played: no further forward
 * than the second-last defender (or the ball). Without offside, strikers still
 * stay roughly level with the last defender to keep the shape.
 */
function onside<T extends Vec2>(s: MatchState, p: Footballer, spot: T): T {
  let line: number;
  if (s.settings.offside !== false && s.settings.mode === 'match') line = offsideLineU(s, p.team) - 0.6 / PITCH_LENGTH;
  else if (p.role === 'FW') line = Math.max(lastDefenderU(s, other(p.team)), teamU(p.team, s.ball.x));
  else return spot;
  const u = Math.min(teamU(p.team, spot.x), line);
  return { ...spot, x: p.team === 'home' ? u * PITCH_LENGTH : (1 - u) * PITCH_LENGTH };
}

/** A teammate the referee would flag if he played it now. */
function flagged(s: MatchState, mate: Footballer): boolean {
  return s.settings.offside !== false && s.settings.mode === 'match' && offsidePosition(s, mate);
}

/** Wide in the final third: a crossing position. */
function wide(team: Team, at: Vec2): boolean {
  return teamU(team, at.x) > 0.7 && Math.abs(at.y - CENTER.y) > 14;
}

/**
 * Forwards (and the winger on the far side) go to the near post, the far post
 * and the penalty spot while a teammate is wide in the final third or his
 * cross is in the air.
 */
function boxRun(s: MatchState, p: Footballer, carrier: Footballer | undefined): Target | undefined {
  const ball = s.ball;
  const crossing = carrier ? carrier.team === p.team && wide(p.team, carrier) : false;
  const inFlight = !carrier && s.lastTouch === p.team && ball.z > 0.8 && teamU(p.team, ball.x) > 0.6;
  if (!crossing && !inFlight) return undefined;
  const side = Math.sign(ball.y - CENTER.y) || 1;
  const farWinger = p.role === 'MF' && Math.sign(p.y - CENTER.y) === -side && Math.abs(p.slot.v - 0.5) > 0.25;
  if (p.role !== 'FW' && !farWinger) return undefined;
  const goalX = targetGoalX(p.team);
  const dir = attackDir(p.team);
  const spot =
    farWinger
      ? { x: goalX - dir * 11, y: CENTER.y - side * 1 }
      : p.number === 9
        ? { x: goalX - dir * 6, y: CENTER.y + side * 2.5 }
        : { x: goalX - dir * 7, y: CENTER.y - side * 3.5 };
  return onside(s, p, { ...spot, sprint: true });
}

/** The best teammate in the box to cross to, if any: the one with most room. */
function crossTarget(s: MatchState, p: Footballer, opps: Footballer[]): { mate: Footballer; spot: Vec2 } | undefined {
  if (!wide(p.team, p)) return undefined;
  const dir = attackDir(p.team);
  let best: { mate: Footballer; spot: Vec2; room: number } | undefined;
  for (const m of active(s)) {
    if (m.team !== p.team || m.gk || m.id === p.id || !inPenaltyArea(other(p.team), m.x, m.y) || flagged(s, m)) continue;
    if (Math.abs(m.y - CENTER.y) > 10) continue;
    const spot = { x: m.x + dir, y: m.y };
    const room = Math.min(...opps.map((o) => dist(o, spot)));
    if (!best || room > best.room) best = { mate: m, spot, room };
  }
  return best;
}

/** Nearest defender of `team` between the carrier and his own goal, once the carrier is within 35 m of it. */
function goalSideDefender(s: MatchState, team: Team, carrier: Footballer): number {
  const goal = { x: ownGoalX(team), y: CENTER.y };
  const carrierToGoal = dist(carrier, goal);
  if (carrierToGoal > 35) return -1;
  let best = -1;
  let bestD = 18;
  for (const d of active(s)) {
    if (d.team !== team || d.role !== 'DF' || !canMove(d) || dist(d, goal) > carrierToGoal) continue;
    const gap = dist(d, carrier);
    if (gap < bestD) {
      bestD = gap;
      best = d.id;
    }
  }
  return best;
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
    if (d < TACKLE_RANGE) standingTackle(s, p, carrier, level.tackle);
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
    // Wide in the final third with someone in the box: cross it, sooner if pressed or near the byline.
    const cross = crossTarget(s, p, opps);
    if (cross && (teamU(p.team, p.x) > 0.84 || pressure < 4 || random(s.rng) < 0.35)) {
      const d = dist(p, cross.spot) || 1;
      const opts = { errorMul: level.accuracy, target: cross.mate.id };
      if (random(s.rng) < 0.4) {
        // Whipped, bending away from the keeper.
        const spin = curlTowards(cross.spot.x - p.x, cross.spot.y - p.y, -attackDir(p.team), true) * FINESSE_SPIN * 0.8;
        const power = lobPowerFor(d, true);
        const aim = curledAim(s, p, 'lob', power, spin, cross.spot);
        kickBall(s, p, 'lob', power, aim.dirX, aim.dirY, { ...opts, finesse: true, spin });
      } else {
        kickBall(s, p, 'lob', lobPowerFor(d), (cross.spot.x - p.x) / d, (cross.spot.y - p.y) / d, opts);
      }
      return { x: p.x, y: p.y };
    }
    const pass = bestPass(s, p, opps);
    if (pass && (pass.score > 6 || (pressure < 2.5 && pass.score > -3) || teamU(p.team, p.x) < 0.2)) {
      const d = dist(p, pass.lead);
      const n = d || 1;
      const opts = { errorMul: level.accuracy, target: pass.mate.id };
      if (pass.through) {
        const space = pass.lead;
        kickBall(s, p, 'through', passPowerFor(d, THROUGH_ARRIVAL), (space.x - p.x) / n, (space.y - p.y) / n, { ...opts, space });
        return { x: p.x, y: p.y };
      }
      const lofted = d > 28 || pass.laneBlocked;
      const power = lofted ? lobPowerFor(d) : passPowerFor(d);
      kickBall(s, p, lofted ? 'lob' : 'pass', power, (pass.lead.x - p.x) / n, (pass.lead.y - p.y) / n, opts);
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
  const ty = goal.y + side * (GOAL_WIDTH / 2 - 0.6 - (penalty ? random(s.rng) * 0.8 : 0));
  const dx = goal.x - p.x;
  const dy = ty - p.y;
  const n = Math.hypot(dx, dy) || 1;
  const power = penalty ? 0.62 + random(s.rng) * 0.18 : clamp(0.6 + toGoal * 0.014, 0.6, 0.92);
  // From the edge of the box, sometimes curl it in instead of driving it.
  if (!penalty && toGoal > 11 && toGoal < 26 && random(s.rng) < 0.4) {
    const spin = curlTowards(dx, dy, CENTER.y - ty) * FINESSE_SPIN;
    const dir = curledAim(s, p, 'shot', power, spin, { x: goal.x, y: ty });
    kickBall(s, p, 'shot', power, dir.dirX, dir.dirY, { errorMul: level.accuracy, finesse: true, spin });
    return;
  }
  kickBall(s, p, 'shot', power, dx / n, dy / n, { errorMul: level.accuracy });
}

interface PassOption {
  mate: Footballer;
  lead: Vec2;
  score: number;
  laneBlocked: boolean;
  /** Played into the space ahead of him rather than to his feet. */
  through?: boolean;
}

/** Scores every teammate: forward progress, space around him, and how open the lane is. */
function bestPass(s: MatchState, p: Footballer, opps: Footballer[]): PassOption | undefined {
  let best: PassOption | undefined;
  for (const mate of active(s)) {
    if (mate.team !== p.team || mate.id === p.id || mate.gk || !canMove(mate) || flagged(s, mate)) continue;
    const d = dist(p, mate);
    if (d < 6 || d > 45) continue;
    const lead = leadPoint(p, mate, 16);
    const progress = (teamU(p.team, lead.x) - teamU(p.team, p.x)) * PITCH_LENGTH;
    const space = Math.min(10, ...opps.map((o) => dist(o, lead)));
    const lane = Math.min(10, ...opps.map((o) => segmentDistance(o, p, lead)));
    const laneBlocked = lane < 1.8;
    const marked = space < 3 ? -6 : 0;
    const score = progress * 0.5 + space + marked - d * 0.05 + (laneBlocked ? -8 : lane * 0.4);
    if (!best || score > best.score) best = { mate, lead, score, laneBlocked };

    // A runner in the attacking half can be played in behind, if he wins the race to the space.
    if (mate.role === 'DF' || teamU(p.team, mate.x) < 0.5) continue;
    const gap = throughSpace(mate, attackDir(p.team), 0, 0.35);
    const race = Math.min(...opps.map((o) => dist(o, gap))) - dist(mate, gap);
    const tLane = Math.min(10, ...opps.map((o) => segmentDistance(o, p, gap)));
    if (race < 1.5 || tLane < 2.5) continue;
    const tProgress = (teamU(p.team, gap.x) - teamU(p.team, p.x)) * PITCH_LENGTH;
    const tScore = tProgress * 0.5 + Math.min(8, race * 1.5) - 3 - dist(p, gap) * 0.05 + tLane * 0.4;
    if (!best || tScore > best.score) best = { mate, lead: gap, score: tScore, laneBlocked: false, through: true };
  }
  return best;
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
