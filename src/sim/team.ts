import { CENTER, PENALTY_AREA_DEPTH, PENALTY_AREA_WIDTH, PITCH_LENGTH, PITCH_WIDTH } from './constants';
import type { Footballer, MatchState, Role, Team, Vec2 } from './types';

export const other = (t: Team): Team => (t === 'home' ? 'away' : 'home');
/** +1 when the team attacks towards +x. */
export const attackDir = (t: Team): number => (t === 'home' ? 1 : -1);
export const ownGoalX = (t: Team): number => (t === 'home' ? 0 : PITCH_LENGTH);
export const targetGoalX = (t: Team): number => (t === 'home' ? PITCH_LENGTH : 0);

/** Team-relative length coordinate: 0 at own goal line, 1 at the opponent's. */
export function teamU(t: Team, x: number): number {
  return t === 'home' ? x / PITCH_LENGTH : 1 - x / PITCH_LENGTH;
}

/** Team-relative (u, v) to pitch coordinates. v is mirrored for the away side so "right back" means the same thing. */
export function toPitch(t: Team, u: number, v: number): Vec2 {
  return t === 'home' ? { x: u * PITCH_LENGTH, y: v * PITCH_WIDTH } : { x: (1 - u) * PITCH_LENGTH, y: (1 - v) * PITCH_WIDTH };
}

export function inPenaltyArea(defending: Team, x: number, y: number): boolean {
  const gx = ownGoalX(defending);
  return Math.abs(x - gx) < PENALTY_AREA_DEPTH && Math.abs(y - CENTER.y) < PENALTY_AREA_WIDTH / 2;
}

/** 4-4-2, as seen by a team attacking +x with its right side at +y. */
export const FORMATION_442: { role: Role; number: number; u: number; v: number }[] = [
  { role: 'GK', number: 1, u: 0.02, v: 0.5 },
  { role: 'DF', number: 2, u: 0.2, v: 0.85 },
  { role: 'DF', number: 5, u: 0.18, v: 0.62 },
  { role: 'DF', number: 6, u: 0.18, v: 0.38 },
  { role: 'DF', number: 3, u: 0.2, v: 0.15 },
  { role: 'MF', number: 7, u: 0.42, v: 0.86 },
  { role: 'MF', number: 8, u: 0.4, v: 0.6 },
  { role: 'MF', number: 4, u: 0.4, v: 0.4 },
  { role: 'MF', number: 11, u: 0.42, v: 0.14 },
  { role: 'FW', number: 9, u: 0.62, v: 0.58 },
  { role: 'FW', number: 10, u: 0.6, v: 0.42 },
];

export function active(s: MatchState): Footballer[] {
  return s.players.filter((p) => !p.sentOff);
}

export function byId(s: MatchState, id: number): Footballer | undefined {
  return id >= 0 ? s.players[id] : undefined;
}

export function keeperOf(s: MatchState, t: Team): Footballer | undefined {
  return s.players.find((p) => p.team === t && p.gk && !p.sentOff);
}

/** Team that has the ball: carrier's, keeper holding it, or the last to touch a loose ball. */
export function teamInPossession(s: MatchState): Team {
  const carrier = byId(s, s.possessor);
  if (carrier) return carrier.team;
  const holder = s.players.find((p) => p.gk?.state === 'holding');
  return holder ? holder.team : s.lastTouch;
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Distance from a point to the segment a-b (how close a player is to a passing lane). */
export function segmentDistance(pt: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby || 1;
  const t = clamp(((pt.x - a.x) * abx + (pt.y - a.y) * aby) / l2, 0, 1);
  return Math.hypot(pt.x - (a.x + abx * t), pt.y - (a.y + aby * t));
}

/** Where a player stands in the team shape right now: slides with the ball, pushes up in possession. */
export function formationSpot(s: MatchState, p: Footballer): Vec2 {
  const ballU = teamU(p.team, s.ball.x);
  const ballV = p.team === 'home' ? s.ball.y / PITCH_WIDTH : 1 - s.ball.y / PITCH_WIDTH;
  const attacking = teamInPossession(s) === p.team;
  let u = p.slot.u + (ballU - 0.5) * 0.5 + (attacking ? 0.08 : -0.06);
  const v = p.slot.v + (ballV - 0.5) * 0.3;
  if (p.role === 'DF') u = clamp(u, 0.06, 0.62);
  else if (p.role === 'MF') u = clamp(u, 0.15, 0.82);
  else if (p.role === 'FW') u = clamp(u, 0.3, 0.9);
  return toPitch(p.team, u, clamp(v, 0.04, 0.96));
}

/** Kickoff shape: everyone in their own half, the kicking side's striker on the ball. */
export function kickoffSpot(p: Footballer, kicking: Team): Vec2 {
  if (p.team === kicking && p.number === 9) return toPitch(p.team, 0.494, 0.5);
  if (p.team === kicking && p.number === 10) return toPitch(p.team, 0.47, 0.6);
  const u = Math.min(p.slot.u * 0.75, p.team === kicking ? 0.45 : 0.4);
  return toPitch(p.team, u, p.slot.v);
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
