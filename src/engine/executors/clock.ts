/**
 * kami-lens vendor port (AGPL-3.0 — see LICENSE).
 * upstream: Asphodel-OS/kamigotchi @ ef898fc9350a6085fb080419b12af96c2254e8f3
 * path:     packages/client/src/engine/executors/clock.ts
 * changes:  none
 */

import { Observable, ReplaySubject } from 'rxjs';

export interface ClockConfig {
  period: number;
  initialTime: number;
  syncInterval: number;
}

export type Clock = {
  time$: Observable<number>;
  currentTime: number;
  lastUpdateTime: number;
  update: (time: number, maintainStale?: boolean) => void;
  dispose: () => void;
};

/**
 * Create a clock optimistically keeping track of the current chain time.
 * The optimisitic chain time should be synced to the actual chain time in regular intervals using the `update` function.
 *
 * @param config
 * @returns: {@link Clock}
 */
export function createClock(config: ClockConfig): Clock {
  const { initialTime, period } = config;

  const clock = {
    currentTime: initialTime,
    lastUpdateTime: initialTime,
    time$: new ReplaySubject<number>(1),
    dispose: () => clearInterval(intervalId),
    update,
  };

  let intervalId = createTickInterval();
  emit();

  function emit() {
    clock.time$.next(clock.currentTime);
  }

  function createTickInterval() {
    return setInterval(() => {
      clock.currentTime += period;
      emit();
    }, period);
  }

  function update(time: number) {
    clearInterval(intervalId);
    clock.currentTime = time;
    clock.lastUpdateTime = time;
    emit();
    intervalId = createTickInterval();
  }

  return clock;
}
