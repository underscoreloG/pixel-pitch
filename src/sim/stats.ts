import { byId, other } from './team';
import type { MatchEvent, MatchState, Team } from './types';

export interface TeamStats {
  shots: number;
  onTarget: number;
  /** Ticks with a player of this team on the ball. */
  possession: number;
  passes: number;
  /** Passes the next player to control the ball was a teammate for. */
  completed: number;
  fouls: number;
  yellow: number;
  red: number;
  corners: number;
  offsides: number;
  saves: number;
}

export interface MatchStats {
  home: TeamStats;
  away: TeamStats;
  /** Team whose pass is still looking for a receiver. */
  pendingPass: Team | null;
  /** Player on the ball last tick. */
  holder: number;
}

const emptyTeam = (): TeamStats => ({
  shots: 0,
  onTarget: 0,
  possession: 0,
  passes: 0,
  completed: 0,
  fouls: 0,
  yellow: 0,
  red: 0,
  corners: 0,
  offsides: 0,
  saves: 0,
});

export function emptyStats(): MatchStats {
  return { home: emptyTeam(), away: emptyTeam(), pendingPass: null, holder: -1 };
}

/** Folds a match event into the stats (penalty shootouts don't count). */
export function countEvent(s: MatchState, e: MatchEvent): void {
  const st = s.stats;
  const t = e.team;
  if (!t || s.settings.mode !== 'match' || s.shootout) return;
  switch (e.type) {
    case 'kick':
      if (e.kick === 'shot') {
        st[t].shots++;
        st.pendingPass = null;
      } else if (!e.header) {
        // Kicked passes only: a headed knock-down isn't one.
        st[t].passes++;
        st.pendingPass = t;
      }
      break;
    case 'goal':
      st[t].onTarget++;
      break;
    case 'save':
      st[t].saves++;
      st[other(t)].onTarget++;
      break;
    case 'foul':
      st[t].fouls++;
      break;
    case 'card':
      if (e.card === 'red') st[t].red++;
      else st[t].yellow++;
      break;
    case 'corner':
      st[t].corners++;
      break;
    case 'offside':
      st[t].offsides++;
      break;
  }
}

/** Per tick of open play: who has the ball, and whether the last pass found a teammate. */
export function countTick(s: MatchState): void {
  const st = s.stats;
  const carrier = byId(s, s.possessor);
  if (!carrier) return;
  st[carrier.team].possession++;
  if (carrier.id !== st.holder && st.pendingPass) {
    if (st.pendingPass === carrier.team) st[carrier.team].completed++;
    st.pendingPass = null;
  }
  st.holder = carrier.id;
}
