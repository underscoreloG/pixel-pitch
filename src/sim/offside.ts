import { PITCH_LENGTH } from './constants';
import { active, teamU } from './team';
import type { Footballer, MatchState, SetPieceType, Team } from './types';

/** Level is onside: the benefit of the doubt, in metres. */
const OFFSIDE_TOLERANCE = 0.3;
/** Restarts nobody can be offside from. */
const NO_OFFSIDE_FROM: SetPieceType[] = ['throw-in', 'goal-kick', 'corner'];

/**
 * The offside line for `team` attacking, in its team coordinates (u): the
 * second-last opponent (the keeper is usually the last) or the ball,
 * whichever is nearer the goal, and never short of halfway.
 */
export function offsideLineU(s: MatchState, team: Team): number {
  const depth = active(s)
    .filter((d) => d.team !== team)
    .map((d) => teamU(team, d.x))
    .sort((a, b) => b - a);
  return Math.max(depth[1] ?? 0, teamU(team, s.ball.x), 0.5);
}

export function offsidePosition(s: MatchState, p: Footballer, line = offsideLineU(s, p.team)): boolean {
  return teamU(p.team, p.x) > line + OFFSIDE_TOLERANCE / PITCH_LENGTH;
}

/** As a player plays the ball: note which teammates are in an offside position at that moment. */
export function markOffside(s: MatchState, kicker: Footballer): void {
  s.offside = null;
  if (s.settings.offside === false || s.settings.mode !== 'match') return;
  if (s.setPiece && NO_OFFSIDE_FROM.includes(s.setPiece.type)) return;
  const line = offsideLineU(s, kicker.team);
  const ids = active(s)
    .filter((q) => q.team === kicker.team && q.id !== kicker.id && offsidePosition(s, q, line))
    .map((q) => q.id);
  if (ids.length > 0) s.offside = { team: kicker.team, kickerId: kicker.id, ids };
}

/**
 * After the touches of a tick: an offside player who is the next to play the
 * ball is the offender. Anyone else touching it (an onside teammate, an
 * opponent) ends that phase of play.
 */
export function offsideOffender(s: MatchState): Footballer | undefined {
  const o = s.offside;
  if (!o || s.lastToucherId === o.kickerId) return undefined;
  s.offside = null;
  return o.ids.includes(s.lastToucherId) ? s.players[s.lastToucherId] : undefined;
}
