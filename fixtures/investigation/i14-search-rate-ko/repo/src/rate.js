/** Calls fn once, `ms` after the last call, with the last arguments. */
export function debounce(fn, ms, timers = globalThis) {
  let timer;
  return (...args) => {
    timers.clearTimeout(timer);
    timer = timers.setTimeout(() => fn(...args), ms);
  };
}

/** Calls fn at most once per `ms`. */
export function throttle(fn, ms, now = () => Date.now()) {
  let last = -Infinity;
  return (...args) => {
    const t = now();
    if (t - last >= ms) {
      last = t;
      fn(...args);
    }
  };
}
