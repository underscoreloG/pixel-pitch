import { countEvent } from './stats';
import type { MatchEvent, MatchEventType, MatchState } from './types';

const MAX_EVENTS = 32;

export function emit(s: MatchState, type: MatchEventType, extra: Partial<MatchEvent> = {}): void {
  const e: MatchEvent = { type, tick: s.tick, ...extra };
  s.events.push(e);
  countEvent(s, e);
  if (s.events.length > MAX_EVENTS) s.events.shift();
}
