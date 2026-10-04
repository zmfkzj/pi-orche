function metricKey(name, labels) {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error('Invalid metric name');
  const sorted = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([name, sorted]);
}
/** In-memory metrics with detached snapshots and explicit histogram boundaries. */
export function createMetrics(boundaries = [1, 5, 10, 50, 100, 500]) {
  if (!boundaries.every((n, i) => Number.isFinite(n) && (i === 0 || n > boundaries[i - 1]))) {
    throw new RangeError('Histogram boundaries must be increasing');
  }
  boundaries = [...boundaries];
  const counters = new Map();
  const gauges = new Map();
  const histograms = new Map();
  const finite = n => {
    if (!Number.isFinite(n)) throw new TypeError('Finite measurement required');
  };
  return {
    increment(name, amount = 1, labels = {}) {
      finite(amount);
      if (amount < 0) throw new RangeError('Counter cannot decrease');
      const key = metricKey(name, labels);
      counters.set(key, (counters.get(key) || 0) + amount);
    },
    gauge(name, value, labels = {}) {
      finite(value);
      gauges.set(metricKey(name, labels), value);
    },
    observe(name, value, labels = {}) {
      finite(value);
      const key = metricKey(name, labels);
      let histogram = histograms.get(key);
      if (!histogram) {
        histogram = { count: 0, sum: 0, buckets: boundaries.map(le => ({ le, count: 0 })) };
        histograms.set(key, histogram);
      }
      histogram.count++;
      histogram.sum += value;
      for (const bucket of histogram.buckets) {
        if (value <= bucket.le) bucket.count++;
      }
    },
    snapshot() {
      const rows = (map, type) => [...map].map(([key, value]) => {
        const [name, entries] = JSON.parse(key);
        return { type, name, labels: Object.fromEntries(entries), value: structuredClone(value) };
      });
      return [...rows(counters, 'counter'), ...rows(gauges, 'gauge'), ...rows(histograms, 'histogram')]
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    reset() {
      counters.clear();
      gauges.clear();
      histograms.clear();
    },
  };
}
export function measure(metrics, name, now, fn) {
  return async (...args) => {
    const start = now();
    try {
      const result = await fn(...args);
      metrics.increment(name + '_success');
      return result;
    } catch (error) {
      metrics.increment(name + '_failure');
      throw error;
    } finally {
      metrics.observe(name + '_duration', now() - start);
    }
  };
}
