import type {OptionalLogger} from '@rocicorp/logger';

export interface ReporterOptions {
  datadogApiKey: string;
  metrics: Metrics;
  // intervalMs defaults to 2 minutes.
  intervalMs?: number | undefined;
  abortSignal?: AbortSignal | undefined;
  // If a OptionalLogger is not provided, the Reporter is silent.
  optionalLogger?: OptionalLogger | undefined;
  // Should probably also take tags (eg, env, version). Will
  // probalby need to take host and service too for the server side.
}

/**
 * Reporter periodically reports metrics to Datadog. It uses an interval
 * instead of a timer because we want to keep to the desired interval as
 * closely as possible. A typical pattern for sampling a client is for the
 * client to report metrics on a given interval and then rollup metrics on
 * the server on the same interval. The extent to which the interval drifts
 * skews the counts seen by the server.
 */
export class Reporter {
  private readonly _metrics: Metrics;
  private readonly _apiKey: string;
  private readonly _intervalMs: number;
  private _intervalID: ReturnType<typeof setInterval> | 0 = 0;
  private readonly _abortSignal: AbortSignal | undefined;
  private readonly _logger: OptionalLogger | undefined;

  constructor(options: ReporterOptions) {
    this._metrics = options.metrics;
    this._apiKey = options.datadogApiKey;
    this._intervalMs = options.intervalMs || 2 * 60 * 1000; // 2 minutes.
    this._abortSignal = options.abortSignal;
    this._logger = options.optionalLogger;

    if (this._abortSignal !== undefined) {
      this._abortSignal.addEventListener('abort', () => {
        this._stopInterval();
        this._logger?.debug?.('Metrics Reporter aborted');
      });
    }

    this._startInterval();
  }

  private _startInterval() {
    if (this._intervalID) {
      return;
    }

    this._intervalID = setInterval(() => {
      void this.report();
    }, this._intervalMs);

    this._logger?.debug?.('Metrics Reporter starter');
  }

  private _stopInterval() {
    if (this._intervalID) {
      clearInterval(this._intervalID);
      this._intervalID = 0;
    }
  }

  async report() {
    const allSeries = this._metrics.flush();
    if (allSeries.length === 0) {
      this._logger?.debug?.('No metrics to report');
      return;
    }

    try {
      // TODO add a timeout to the fetch.
      await report(this._apiKey, allSeries);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      this._logger?.error?.(`Error reporting metrics: ${e}`);
    }
  }
}

// Important! We submit *all* metrics as distributions. This is because
// Datadog only counts a single point per second per metric for non-distribution
// metric types. (It expects that they have been pre-aggregated eg by statsd.)
// So if we submitted non-distribution metrics and two clients (or DOs)
// reported a metric in the same second, we'd lose one of them.
const DD_DISTRIBUTION_METRIC_URL =
  'https://api.datadoghq.com/api/v1/distribution_points';

// report sends a set of metrics to Datadog. It throws unless the server
// returns 200.
export async function report(
  apiKey: string,
  allSeries: DatadogSeries[],
  abortSignal?: AbortSignal,
) {
  const body = JSON.stringify({series: allSeries});
  const res = await fetch(DD_DISTRIBUTION_METRIC_URL, {
    method: 'POST',
    headers: {
      // Note: no compression atm.
      'Content-Type': 'application/json',
      'DD-API-KEY': apiKey,
    },
    signal: abortSignal ?? null,
    body,
  });
  if (!res.ok) {
    const maybeBody = await res.text();
    throw new Error(
      `unexpected response: ${res.status} ${res.statusText} body: ${maybeBody}`,
    );
  }
  return res;
}

/**
 * Metrics keeps track of the set of metrics in use and flushes them
 * to a format suitable for reporting to Datadog.
 */
export class Metrics {
  // We currently only support Gauge metrics.
  private _gauges: Map<string, Gauge> = new Map();

  // gauge returns a gauge with the given name. If a gauge with that name
  // already exists, it is returned.
  public gauge(name: string) {
    let gauge = this._gauges.get(name);
    if (gauge === undefined) {
      gauge = new Gauge(name);
      this._gauges.set(name, gauge);
    }
    return gauge;
  }

  // Flushes all metrics to an array of time series (plural), one DatadogSeries
  // per metric.
  public flush(): DatadogSeries[] {
    const allSeries: DatadogSeries[] = [];
    for (const gauge of this._gauges.values()) {
      const series = gauge.flush();
      allSeries.push(series);
    }
    return allSeries;
  }
}

// These two types are Datadog's. Yeah, I don't like them either.

/** DatadogSeries is a time series of points for a single metric. */
export type DatadogSeries = {
  metric: string; // We call this 'name' bc 'metric' is overloaded in code.
  points: DatadogPoint[];
};
/**
 * A point is a second-resolution timestamp and a set of values for that
 * timestamp. A point represents exactly one second in time and the values
 * are those recorded for that second. The first element of this array
 * is the timestamp and the second element is an array of values.
 */
export type DatadogPoint = [number, number[]];

function newDatadagPoint(ts: number, value: number): DatadogPoint {
  return [ts, [value]];
}

/**
 * Gauge is a metric type that represents a single value that can go up and
 * down. It's typically used to track discrete values or counts eg the number
 * of active users, number of connections, cpu load, etc. A gauge retains
 * its value when flushed.
 *
 * We use a Gauge to sample at the client. If we are interested in tracking
 * a metric value *per client*, the client can note the latest value in
 * a Gauge metric. The metric is periodically reported to Datadog. On the
 * server, we graph the value of the metric rolled up over the periodic
 * reporting period, that is, counted over a span of time equal to the
 * reporting period. The result is ~one point per client per reporting
 * period.
 */
export class Gauge {
  private readonly _name: string;
  private _point: DatadogPoint | undefined = undefined;

  constructor(name: string) {
    this._name = name;
  }

  public set(value: number) {
    this._point = newDatadagPoint(t(), value);
  }

  public flush(): DatadogSeries {
    // We don't want to alias the internal state so we return a copy.
    const points: DatadogPoint[] =
      this._point === undefined ? [] : [[this._point[0], [this._point[1][0]]]];
    return {metric: this._name, points};
  }
}

export function gaugeValue(
  series: DatadogSeries,
): {tsSec: number; value: number} | undefined {
  if (series.points.length === 0) {
    return undefined;
  }
  return {tsSec: series.points[0][0], value: series.points[0][1][0]};
}

function t() {
  return Math.round(Date.now() / 1000);
}
