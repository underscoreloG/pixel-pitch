import { stepBall } from './ball';
import { computeTickInfo, stepAI } from './ai';
import {
  BALL_RADIUS,
  BREAK_PAUSE,
  CENTER,
  DT,
  FREE_KICK_DISTANCE,
  GOAL_AREA_DEPTH,
  GOAL_DEPTH,
  GOAL_HEIGHT,
  GOAL_PAUSE,
  GOAL_Y_MAX,
  GOAL_Y_MIN,
  KEEPER_HOLD_TIME,
  MAX_ADDED_TIME,
  OUT_PAUSE,
  PENALTY_AREA_DEPTH,
  PENALTY_SPOT,
  PITCH_LENGTH,
  PITCH_WIDTH,
  POST_RADIUS,
  SET_PIECE_DELAY,
} from './constants';
import { emit } from './events';
import { resolveHeaders } from './header';
import { startShootout, stepShootout } from './shootout';
import { NEUTRAL, makeSubs, rest, rollRatings, tire } from './squad';
import { countTick, emptyStats } from './stats';
import { stepKeeper } from './keeper';
import { offsideOffender } from './offside';
import { canMove, coast, createFootballer, nearestHome, resolvePossession, separate, stepHuman, tickTimers } from './player';
import { createReferee, stepReferee } from './referee';
import { stepSlide } from './tackle';
import {
  FORMATION_442,
  active,
  attackDir,
  byId,
  clamp,
  dist,
  inPenaltyArea,
  keeperOf,
  kickoffSpot,
  other,
  ownGoalX,
  targetGoalX,
} from './team';
import type { Footballer, InputFrame, MatchSettings, MatchState, SetPieceType, Team } from './types';

export const NO_INPUT: InputFrame = {
  moveX: 0,
  moveY: 0,
  sprint: false,
  pass: false,
  shoot: false,
  lob: false,
  through: false,
  finesse: false,
  switch: false,
};

export const TRAINING: MatchSettings = { mode: 'training', duration: 0, difficulty: 1 };

/** Match: 11 v 11 in a 4-4-2. Training: one striker against the CPU keeper. */
export function createMatch(seed: number, settings: MatchSettings = TRAINING): MatchState {
  const players: Footballer[] = [];
  if (settings.mode === 'match') {
    for (const team of ['home', 'away'] as const)
      for (const f of FORMATION_442) players.push(createFootballer(players.length, team, f.role, f.number, f));
  } else {
    players.push(createFootballer(0, 'home', 'FW', 9, { u: 0.62, v: 0.5 }));
    players.push(createFootballer(1, 'away', 'GK', 1, { u: 0.02, v: 0.5 }));
  }
  const s: MatchState = {
    tick: 0,
    rng: { seed },
    settings: { ...settings },
    clock: 0,
    ball: { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 },
    players,
    controlled: players.find((p) => p.team === 'home' && p.number === 9)!.id,
    prevButtons: { pass: false, shoot: false, lob: false, through: false, switch: false },
    possessor: -1,
    passTarget: -1,
    passStick: null,
    passSpace: null,
    offside: null,
    period: 1,
    firstKickoff: 'home',
    shootout: null,
    stick: { x: 0, y: 0 },
    subs: { home: { made: 0, queue: [] }, away: { made: 0, queue: [] } },
    stats: emptyStats(),
    lastTouch: 'home',
    lastToucherId: -1,
    referee: createReferee(),
    score: { home: 0, away: 0 },
    phase: 'play',
    phaseTimer: 0,
    kickoffTeam: 'home',
    restart: null,
    setPiece: null,
    foul: null,
    events: [],
  };
  for (const p of players) p.ratings = p.gk ? { ...NEUTRAL } : rollRatings(seed, p.id, p.role);
  kickoff(s, 'home');
  return s;
}

/** Everyone back in shape, ball on the spot. In a match the kickoff is a dead ball the kicking side must play. */
export function kickoff(s: MatchState, team: Team): void {
  Object.assign(s.ball, { x: CENTER.x, y: CENTER.y, z: 0, vx: 0, vy: 0, vz: 0, spin: 0 });
  for (const p of active(s)) {
    const spot = p.gk
      ? { x: ownGoalX(p.team) + attackDir(p.team) * 0.5, y: CENTER.y }
      : s.settings.mode === 'training'
        ? { x: CENTER.x - 1, y: CENTER.y }
        : kickoffSpot(p, team);
    Object.assign(p, { x: spot.x, y: spot.y, vx: 0, vy: 0, facingX: attackDir(p.team), facingY: 0 });
    Object.assign(p, { charging: null, charge: 0, pending: null, slide: 0, down: 0, kickCooldown: 0, think: 0 });
    if (p.gk) Object.assign(p.gk, { state: 'positioning', stateTimer: 0, threatTimer: 0, ignoreBall: 0, facingPenalty: false });
  }
  s.possessor = -1;
  s.passTarget = -1;
  s.phase = 'play';
  s.phaseTimer = 0;
  s.lastTouch = team;
  s.restart = null;
  s.foul = null;
  s.setPiece = null;
  s.kickoffTeam = team;
  if (s.settings.mode === 'match') {
    const taker = active(s).find((p) => p.team === team && p.number === 9) ?? nearestOutfield(s, team, CENTER);
    if (taker) setPieceFor(s, 'kickoff', team, CENTER.x, CENTER.y, taker);
  } else {
    s.controlled = active(s).find((p) => p.team === 'home')!.id;
  }
  emit(s, 'kickoff', { team });
}

/** Advances the match by one fixed tick. Pure function of (state, input): no clock, no Math.random. */
export function stepMatch(s: MatchState, input: InputFrame): void {
  for (const p of s.players) tickTimers(p, DT);
  if (!s.settings.autoplay) s.stick = { x: input.moveX, y: input.moveY };

  if (s.phase === 'shootout') {
    stepShootout(s, input);
    stepReferee(s, DT);
    s.tick++;
    return;
  }

  if (s.phase === 'full-time') {
    for (const p of active(s)) coast(p, DT);
    stepReferee(s, DT);
    stepBall(s.ball, DT);
    s.tick++;
    return;
  }
  if (s.settings.mode === 'match') s.clock += DT;

  const sp = s.setPiece;
  if (sp) {
    const taker = byId(s, sp.takerId);
    if (taker && dist(taker, sp) < 1.3) sp.timer = Math.max(0, sp.timer - DT);
  }

  for (const p of active(s)) tire(s, p, DT);
  if (s.phase !== 'play' || s.setPiece) makeSubs(s);

  const auto = !!s.settings.autoplay;
  if (!auto) stepHuman(s, input, DT);
  const info = computeTickInfo(s);
  for (const p of active(s)) {
    if (p.slide > 0) stepSlide(s, p, DT);
    else if (p.gk) stepKeeper(s, p, DT);
    else if (!canMove(p)) coast(p, DT);
    else if (auto || p.id !== s.controlled) stepAI(s, p, info, DT);
  }
  separate(s);
  stepReferee(s, DT);

  if (s.phase !== 'play') {
    stepBall(s.ball, DT);
    if (s.phase === 'goal') keepInNet(s);
    s.phaseTimer -= DT;
    if (s.phaseTimer <= 0) {
      if (s.phase === 'break') startPeriod(s);
      else if (timeIsUp(s)) endPeriod(s);
      else if (s.phase === 'goal') kickoff(s, s.kickoffTeam);
      else if (s.phase === 'foul') restartFromFoul(s);
      else restartPlay(s);
    }
    s.tick++;
    return;
  }

  resolveHeaders(s);
  resolvePossession(s);
  countTick(s);
  const offender = offsideOffender(s);
  if (offender) {
    callOffside(s, offender);
    s.tick++;
    return;
  }
  const prev = { x: s.ball.x, y: s.ball.y, z: s.ball.z, vz: s.ball.vz };
  if (!s.players.some((p) => p.gk?.state === 'holding')) stepBall(s.ball, DT);
  if (prev.vz < -2 && s.ball.vz > 0) emit(s, 'bounce', { power: Math.min(1, -prev.vz / 10) });
  checkGoalLines(s, prev);
  if (s.phase === 'play') checkTouchlines(s);
  if (s.phase === 'play') checkPeriodEnd(s);
  s.tick++;
}

function checkGoalLines(s: MatchState, prev: { x: number; y: number; z: number }): void {
  const ball = s.ball;
  for (const gx of [0, PITCH_LENGTH]) {
    const out = gx === 0 ? ball.x < 0 && prev.x >= 0 : ball.x > gx && prev.x <= gx;
    if (!out) continue;
    const outward = gx === 0 ? -1 : 1;
    const f = (gx - prev.x) / (ball.x - prev.x);
    const y = prev.y + (ball.y - prev.y) * f;
    const z = prev.z + (ball.z - prev.z) * f;
    const hitDist = POST_RADIUS + BALL_RADIUS;

    for (const py of [GOAL_Y_MIN, GOAL_Y_MAX]) {
      if (Math.abs(y - py) < hitDist && z < GOAL_HEIGHT) {
        ball.x = gx - outward * hitDist;
        ball.vx = -ball.vx * 0.6;
        ball.vy += Math.sign(y - py || 1) * Math.abs(ball.vx) * 0.3;
        ball.spin = 0;
        emit(s, 'post');
        return;
      }
    }
    const betweenPosts = y > GOAL_Y_MIN && y < GOAL_Y_MAX;
    if (betweenPosts && Math.abs(z - GOAL_HEIGHT) < hitDist) {
      ball.x = gx - outward * hitDist;
      ball.vx = -ball.vx * 0.6;
      ball.spin = 0;
      ball.vz = z < GOAL_HEIGHT ? -Math.abs(ball.vz) - 1 : Math.abs(ball.vz) + 1;
      emit(s, 'bar');
      return;
    }
    const defending: Team = gx === 0 ? 'home' : 'away';
    s.possessor = -1;
    s.passTarget = -1;
    if (betweenPosts && z < GOAL_HEIGHT) {
      const scorer = other(defending);
      s.score[scorer]++;
      s.kickoffTeam = defending;
      s.phase = 'goal';
      s.phaseTimer = GOAL_PAUSE;
      emit(s, 'goal', { team: scorer, playerId: s.lastToucherId });
      return;
    }
    // Wide or over: goal kick if the attackers touched it last, corner if the defenders did.
    const goalKick = s.lastTouch !== defending;
    callOut(s, {
      type: goalKick ? 'goal-kick' : 'corner',
      team: goalKick ? defending : other(defending),
      x: goalKick ? gx - outward * GOAL_AREA_DEPTH : gx - outward * 0.5,
      y: goalKick ? CENTER.y : y < CENTER.y ? 0.5 : PITCH_WIDTH - 0.5,
    });
    return;
  }
}

function checkTouchlines(s: MatchState): void {
  const ball = s.ball;
  if (ball.y >= 0 && ball.y <= PITCH_WIDTH) return;
  s.possessor = -1;
  s.passTarget = -1;
  callOut(s, {
    type: 'throw-in',
    team: other(s.lastTouch),
    x: clamp(ball.x, 1, PITCH_LENGTH - 1),
    y: ball.y < 0 ? 0.05 : PITCH_WIDTH - 0.05,
  });
}

/** Free kick to the defenders where the offside player played the ball. */
function callOffside(s: MatchState, offender: Footballer): void {
  s.possessor = -1;
  s.passTarget = -1;
  emit(s, 'offside', { team: offender.team, playerId: offender.id });
  callOut(s, {
    type: 'free-kick',
    team: other(offender.team),
    x: clamp(offender.x, 1, PITCH_LENGTH - 1),
    y: clamp(offender.y, 1, PITCH_WIDTH - 1),
  });
}

function callOut(s: MatchState, restart: NonNullable<MatchState['restart']>): void {
  s.phase = 'out';
  s.phaseTimer = OUT_PAUSE;
  s.restart = restart;
  emit(s, restart.type, { team: restart.team });
}

function restartPlay(s: MatchState): void {
  const r = s.restart ?? { type: 'goal-kick' as const, team: 'home' as const, x: CENTER.x, y: CENTER.y };
  s.restart = null;
  s.phase = 'play';
  // Training has no CPU outfield players: every restart except the keeper's goal kick is yours.
  const team = s.settings.mode === 'training' && r.type !== 'goal-kick' ? 'home' : r.team;
  if (r.type === 'goal-kick') {
    const k = keeperOf(s, team);
    if (k) {
      k.x = ownGoalX(team) + attackDir(team) * GOAL_AREA_DEPTH;
      k.y = CENTER.y;
      k.vx = k.vy = 0;
      k.gk!.state = 'holding';
      k.gk!.stateTimer = KEEPER_HOLD_TIME;
      k.gk!.goalKick = true;
      s.lastTouch = team;
      s.lastToucherId = k.id;
      return;
    }
  }
  const taker = nearestOutfield(s, team, r);
  if (taker) setPieceFor(s, r.type, team, r.x, r.y, taker);
}

/** After the whistle and any card: send off, then a free kick or a penalty for the fouled side. */
function restartFromFoul(s: MatchState): void {
  const f = s.foul!;
  s.foul = null;
  s.phase = 'play';
  const offender = s.players[f.offenderId];
  const victim = s.players[f.victimId];
  if (f.card === 'red') {
    offender.sentOff = true;
    offender.x = -20;
    offender.y = -20;
    if (s.controlled === offender.id) s.controlled = nearestHome(s)?.id ?? -1;
  }
  const team = victim.team;
  if (f.penalty) {
    const defending = other(team);
    const spot = { x: ownGoalX(defending) + attackDir(defending) * PENALTY_SPOT, y: CENTER.y };
    const taker =
      active(s).find((p) => p.team === team && p.number === 9 && canMove(p)) ?? nearestOutfield(s, team, spot);
    if (taker) setPieceFor(s, 'penalty', team, spot.x, spot.y, taker);
  } else {
    const taker = nearestOutfield(s, team, f);
    if (taker) setPieceFor(s, 'free-kick', team, clamp(f.x, 1, PITCH_LENGTH - 1), clamp(f.y, 1, PITCH_WIDTH - 1), taker);
  }
}

function nearestOutfield(s: MatchState, team: Team, at: { x: number; y: number }): Footballer | undefined {
  let best: Footballer | undefined;
  for (const p of active(s)) {
    if (p.team !== team || p.gk) continue;
    if (!best || dist(p, at) < dist(best, at)) best = p;
  }
  return best;
}

function setPieceFor(s: MatchState, type: SetPieceType, team: Team, x: number, y: number, taker: Footballer): void {
  Object.assign(s.ball, { x, y, z: 0, vx: 0, vy: 0, vz: 0, spin: 0 });
  s.possessor = -1;
  s.passTarget = -1;
  s.setPiece = { type, team, x, y, takerId: taker.id, timer: team === 'home' ? 0.2 : SET_PIECE_DELAY };
  if (team === 'home') s.controlled = taker.id;

  if (type === 'penalty') {
    const defending = other(team);
    const dir = attackDir(team);
    // The human's taker stands right behind the ball, ready to shoot; the CPU's walks up.
    taker.x = x - dir * (team === 'home' && !s.settings.autoplay ? 0.6 : 1.5);
    taker.y = y;
    taker.facingX = dir;
    taker.facingY = 0;
    for (const p of active(s)) {
      if (p.id === taker.id) continue;
      if (p.gk && p.team === defending) {
        p.x = ownGoalX(defending) + attackDir(defending) * 0.3;
        p.y = CENTER.y;
        p.gk.facingPenalty = true;
        continue;
      }
      if (inPenaltyArea(defending, p.x, p.y) || dist(p, s.ball) < FREE_KICK_DISTANCE) {
        p.x = ownGoalX(defending) + attackDir(defending) * (PENALTY_AREA_DEPTH + 2 + (p.id % 4));
      }
    }
  } else if (type !== 'throw-in' && type !== 'kickoff') {
    // Opponents back 9.15 m.
    for (const p of active(s)) {
      if (p.team === team || p.gk) continue;
      const d = dist(p, s.ball);
      if (d >= FREE_KICK_DISTANCE) continue;
      const n = d || 1;
      const dx = d ? (p.x - x) / n : -attackDir(team);
      const dy = d ? (p.y - y) / n : 0;
      p.x = clamp(x + dx * (FREE_KICK_DISTANCE + 0.5), 0.5, PITCH_LENGTH - 0.5);
      p.y = clamp(y + dy * (FREE_KICK_DISTANCE + 0.5), 0.5, PITCH_WIDTH - 0.5);
    }
  }
  if (type === 'free-kick' || type === 'penalty') emit(s, type, { team });
}

/** Real seconds into the match at which the current period ends: halves of `duration`, extra time a third more. */
export function periodEnd(s: MatchState): number {
  const d = s.settings.duration;
  return [d / 2, d, d + d / 6, d + d / 3][s.period - 1];
}

/** The minute on the clock: 90 at full time, 120 after extra time. */
export function matchMinute(s: MatchState): number {
  const d = s.settings.duration;
  const m = s.clock <= d ? (s.clock / d) * 90 : 90 + ((s.clock - d) / (d / 3)) * 30;
  return Math.min([45, 90, 105, 120][s.period - 1], Math.floor(m));
}

function timeIsUp(s: MatchState): boolean {
  return s.settings.mode === 'match' && s.clock >= periodEnd(s);
}

/** Ends at the whistle unless an attack is live near goal; that gets a few seconds of added time. */
function checkPeriodEnd(s: MatchState): void {
  if (!timeIsUp(s)) return;
  const b = s.ball;
  const carrier = byId(s, s.possessor);
  const attackingTeam = carrier?.team ?? s.lastTouch;
  const nearGoal = Math.abs(b.x - targetGoalX(attackingTeam)) < 25;
  const attack = nearGoal && (!!carrier || Math.hypot(b.vx, b.vy) > 5 || !!s.setPiece);
  if (attack && s.clock < periodEnd(s) + MAX_ADDED_TIME) return;
  endPeriod(s);
}

/** Half-time; at full time a draw may go to extra time or penalties. */
function endPeriod(s: MatchState): void {
  const drawn = s.score.home === s.score.away;
  const rule = s.settings.ifDrawn ?? 'final';
  if (s.period === 1 || s.period === 3) startBreak(s, 'half-time');
  else if (s.period === 2 && drawn && rule === 'extra-time') startBreak(s, 'extra-time');
  else if (drawn && (s.period === 4 || rule === 'penalties')) startShootout(s);
  else endMatch(s);
}

function startBreak(s: MatchState, kind: 'half-time' | 'extra-time'): void {
  s.phase = 'break';
  s.phaseTimer = BREAK_PAUSE;
  s.possessor = -1;
  s.setPiece = null;
  s.restart = null;
  s.foul = null;
  s.offside = null;
  emit(s, kind);
}

/** The next half kicks off from where the clock says it should; the sides take turns. */
function startPeriod(s: MatchState): void {
  rest(s);
  s.clock = periodEnd(s);
  s.period++;
  kickoff(s, s.period % 2 === 0 ? other(s.firstKickoff) : s.firstKickoff);
}

function endMatch(s: MatchState): void {
  s.phase = 'full-time';
  s.possessor = -1;
  s.setPiece = null;
  s.restart = null;
  s.foul = null;
  emit(s, 'full-time');
}

/** After a goal the ball keeps moving but stays inside the net. */
function keepInNet(s: MatchState): void {
  const ball = s.ball;
  const back = ball.x > CENTER.x ? PITCH_LENGTH + GOAL_DEPTH : -GOAL_DEPTH;
  if ((ball.x > CENTER.x && ball.x > back) || (ball.x < CENTER.x && ball.x < back)) {
    ball.x = back;
    ball.vx *= -0.2;
  }
  if (ball.y < GOAL_Y_MIN || ball.y > GOAL_Y_MAX) {
    ball.y = Math.min(Math.max(ball.y, GOAL_Y_MIN), GOAL_Y_MAX);
    ball.vy *= -0.2;
  }
  if (ball.z > GOAL_HEIGHT) {
    ball.z = GOAL_HEIGHT;
    ball.vz = Math.min(ball.vz, 0);
  }
}
