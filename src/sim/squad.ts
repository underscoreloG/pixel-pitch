import { PLAYER_JOG_SPEED, SUBS_PER_TEAM } from './constants';
import { emit } from './events';
import { random } from './rng';
import { active, clamp } from './team';
import type { Footballer, MatchState, Ratings, Role, Team } from './types';

/** First bench shirt number. */
const BENCH_FROM = 12;
/** The CPU starts making changes from this minute, for players below this stamina. */
const CPU_SUB_MINUTE = 55;
const CPU_SUB_STAMINA = 0.65;

export const NEUTRAL: Ratings = { pace: 1, shooting: 1, passing: 1, tackling: 1 };

/**
 * Everyone a little different, deterministic from the match seed: about
 * +-6% on each, forwards finish better, midfielders pass better, defenders
 * tackle better.
 */
export function rollRatings(seed: number, key: number, role: Role): Ratings {
  const rng = { seed: (seed ^ Math.imul(key + 1, 0x9e3779b1)) >>> 0 };
  const vary = () => 0.94 + random(rng) * 0.12;
  return {
    pace: vary(),
    shooting: vary() + (role === 'FW' ? 0.04 : role === 'DF' ? -0.04 : 0),
    passing: vary() + (role === 'MF' ? 0.04 : 0),
    tackling: vary() + (role === 'DF' ? 0.04 : role === 'FW' ? -0.04 : 0),
  };
}

/** Top-speed multiplier: his pace, less a little as he tires. */
export function speedFactor(p: Footballer): number {
  return p.ratings.pace * (0.85 + 0.15 * p.stamina);
}

/**
 * Sprinting drains stamina, jogging a little, standing about recovers it.
 * Scaled to the match length, so a busy player ends a match at about half.
 */
export function tire(s: MatchState, p: Footballer, dt: number): void {
  if (s.settings.mode !== 'match' || p.gk) return;
  const speed = Math.hypot(p.vx, p.vy);
  const rate = speed > PLAYER_JOG_SPEED + 0.5 ? 4 : speed > 3 ? 1.2 : -1.5;
  p.stamina = clamp(p.stamina - (rate * dt) / s.settings.duration, 0.2, 1);
}

/** Half-time: a breather. */
export function rest(s: MatchState): void {
  for (const p of s.players) p.stamina = Math.min(1, p.stamina + 0.1);
}

export function subsLeft(s: MatchState, team: Team): number {
  return SUBS_PER_TEAM - s.subs[team].made;
}

/** Ask for a change: it is made at the next stoppage. */
export function queueSub(s: MatchState, team: Team, id: number): boolean {
  const p = s.players[id];
  const subs = s.subs[team];
  if (!p || p.team !== team || p.sentOff || subsLeft(s, team) - subs.queue.length <= 0 || subs.queue.includes(id)) {
    return false;
  }
  subs.queue.push(id);
  return true;
}

/** At a stoppage: the changes asked for, and the CPU's own once players tire. */
export function makeSubs(s: MatchState): void {
  if (s.settings.mode !== 'match') return;
  for (const team of ['home', 'away'] as const) {
    const subs = s.subs[team];
    const cpu = team === 'away' || !!s.settings.autoplay;
    if (cpu && subs.queue.length === 0 && subsLeft(s, team) > 0 && minute(s) >= CPU_SUB_MINUTE) {
      const tired = active(s)
        .filter((p) => p.team === team && !p.gk && p.stamina < CPU_SUB_STAMINA)
        .sort((a, b) => a.stamina - b.stamina)[0];
      if (tired) subs.queue.push(tired.id);
    }
    for (const id of subs.queue.splice(0)) {
      const p = s.players[id];
      if (p.sentOff || subsLeft(s, team) <= 0) continue;
      const off = p.number;
      // The new man takes the same place in the team.
      p.number = BENCH_FROM + subs.made;
      p.ratings = rollRatings(s.rng.seed, 1000 + p.id * 10 + subs.made, p.role);
      p.stamina = 1;
      p.yellow = 0;
      subs.made++;
      emit(s, 'sub', { team, playerId: p.id, offNumber: off });
    }
  }
}

function minute(s: MatchState): number {
  return (s.clock / s.settings.duration) * 90;
}
