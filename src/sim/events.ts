import type { MatchEvent, MatchEventType, MatchState } from './types';

const MAX_EVENTS = 32;

export function emit(s: MatchState, type: MatchEventType, extra: Partial<MatchEvent> = {}): void {
  s.events.push({ type, tick: s.tick, ...extra });
  if (s.events.length > MAX_EVENTS) s.events.shift();
}
