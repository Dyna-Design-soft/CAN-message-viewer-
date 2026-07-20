// Tiny pub/sub event bus shared across the app.
//
// Topics in use:
//   'dbc:changed'        -> { clusters }           (load/unload/reparse)
//   'log:loaded'         -> { store, stats, fileName, format }
//   'log:cleared'        -> {}
//   'live:state'         -> { state: 'stopped'|'running'|'paused', source }
//   'live:frames'        -> { store, appended }    (batch appended to live store)
//   'live:status'        -> { ch, state, busLoad, ... }
//   'playback:time'      -> { t }                  (current playback time, seconds)
//   'playback:state'     -> { playing }
//   'selection:changed'  -> { signals: [qualifiedName...] }
//   'channelmap:changed' -> { map }

export class EventBus {
  #handlers = new Map();

  on(topic, fn) {
    let set = this.#handlers.get(topic);
    if (!set) this.#handlers.set(topic, (set = new Set()));
    set.add(fn);
    return () => this.off(topic, fn);
  }

  off(topic, fn) {
    this.#handlers.get(topic)?.delete(fn);
  }

  emit(topic, payload) {
    const set = this.#handlers.get(topic);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`event handler for "${topic}" failed`, err);
      }
    }
  }
}

export const bus = new EventBus();
