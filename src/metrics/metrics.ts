import type {OptionalLogger} from '@rocicorp/logger';

export interface ReporterOptions {
  metrics: Metrics;
  // url can be set to DD_DISTRIBUTION_METRIC_URL for Datadog.
  url: string;
  // headers can be used to pass auth headers to the server.
  headers?: Record<string, string>;
  // intervalMs defaults to 2 minutes.
  intervalMs?: number | undefined;
  abortSignal?: AbortSignal | undefined;
  // If a OptionalLogger is not provided, the Reporter is silent.
  optionalLogger?: OptionalLogger | undefined;
  // Note: tags are taken at the Metrics level.
}

/**
 * Reporter periodically reports metrics to an HTTP endpoint. It uses an interval
 * instead of a timer because we want to keep to the desired interval as
 * closely as possible. A typical pattern for sampling a client is for the
 * client to report metrics on a given interval and then rollup metrics on
 * the server on the same interval. The extent to which the interval drifts
 * skews the counts seen by the server.
 */
export class Reporter {
  private readonly _metrics: Metrics;
  private readonly _url: string;
  private readonly _headers: Record<string, string>;
  private readonly _intervalMs: number;
  private _intervalID: ReturnType<typeof setInterval> | 0 = 0;
  private readonly _abortSignal: AbortSignal | undefined;
  private readonly _logger: OptionalLogger | undefined;

  constructor(options: ReporterOptions) {
    this._metrics = options.metrics;
    this._url = options.url;
    this._headers = options.headers || {};
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
      await report(this._url, this._headers, allSeries);
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
// reported a metric in the same second, we'd lose one of them. And also, the HTTP
// API does not support the rich set of statsd-supported metrics like Sets. Distribution,
// count, and rate is all you get, an distribution is the easiest to aggregate.
//
// API we use:
//   https://docs.datadoghq.com/api/latest/metrics/#submit-distribution-points
// More on aggregation:
//   https://docs.datadoghq.com/developers/dogstatsd/data_aggregation/#why-aggregate-metrics
// Constraints on submission types (see "API" rows):
//   https://docs.datadoghq.com/metrics/types/?tab=count#submission-types-and-datadog-in-app-types
export const DD_DISTRIBUTION_METRIC_URL =
  'https://api.datadoghq.com/api/v1/distribution_points';
export const DD_AUTH_HEADER_NAME = 'DD-API-KEY';

// report sends a set of metrics to Datadog. It throws unless the server
// returns 200.
export async function report(
  url: string,
  extraHeaders: Record<string, string>,
  allSeries: DatadogSeries[],
  abortSignal?: AbortSignal,
) {
  const headers = {
    // Note: no compression atm.
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  const body = JSON.stringify({series: allSeries});
  const res = await fetch(url, {
    method: 'POST',
    headers,
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
  private _gauges: Map<string, Gauge> = new Map();
  private _states: Map<string, State> = new Map();
  // Possibly tags should be per-metric, but for now we just have one set.
  // Background: https://docs.datadoghq.com/getting_started/tagging/
  // TODO should probably have host and service as well for the server side.
  private readonly _tags: string[];

  constructor(tags: string[] = []) {
    this._tags = tags;
  }

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

  // state returns a state with the given name. If a state with that name
  // already exists, it is returned.
  public state(name: string, clearOnFlush = false) {
    let state = this._states.get(name);
    if (state === undefined) {
      state = new State(name, clearOnFlush);
      this._states.set(name, state);
    }
    return state;
  }

  // Flushes all metrics to an array of time series (plural), one DatadogSeries
  // per metric.
  public flush(): DatadogSeries[] {
    const allSeries: DatadogSeries[] = [];
    for (const gauge of this._gauges.values()) {
      const series = gauge.flush();
      if (this._tags.length > 0) {
        series.tags = this._tags;
      }
      allSeries.push(series);
    }
    for (const state of this._states.values()) {
      const series = state.flush();
      if (series !== undefined) {
        if (this._tags.length > 0) {
          series.tags = this._tags;
        }
        allSeries.push(series);
      }
    }
    return allSeries;
  }
}

// These two types are Datadog's. Yeah, I don't like them either.

/** DatadogSeries is a time series of points for a single metric. */
export type DatadogSeries = {
  metric: string; // We call this 'name' bc 'metric' is overloaded in code.
  points: DatadogPoint[];
  tags?: string[];
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
  private _value: number | undefined = undefined;

  constructor(name: string) {
    this._name = name;
  }

  public set(value: number) {
    this._value = value;
  }

  public flush(): DatadogSeries {
    // Gauge reports the timestamp at flush time, not at the point the value was
    // recorded.
    const points =
      this._value === undefined ? [] : [newDatadagPoint(t(), this._value)];
    return {metric: this._name, points};
  }
}

export function gaugeValue(series: DatadogSeries):
  | {
      metric: string;
      tsSec: number; // We use ms everywhere for consistency but Datadog uses seconds :(
      value: number;
    }
  | undefined {
  if (series.points.length === 0) {
    return undefined;
  }
  return {
    metric: series.metric,
    tsSec: series.points[0][0],
    value: series.points[0][1][0],
  };
}

function t() {
  return Math.round(Date.now() / 1000);
}

/**
 * State is a metric type that represents a specific state that the system is
 * in, for example the state of a connection which may be 'open' or 'closed'.
 * The state is given a name/prefix at construction time (eg 'connection') and
 * then can be set to a specific state (eg 'open'). The prefix is prepended to
 * the set state (eg, 'connection_open') and a value of 1 is reported.
 * Unset/cleared states are not reported.
 *
 * Example:
 *   const s = new State('connection');
 *   s.set('open');
 *   s.flush(); // returns {metric: 'connection_open', points: [[now(), [1]]]}
 */
export class State {
  private readonly _prefix: string;
  private readonly _clearOnFlush: boolean;
  private _current: string | undefined = undefined;

  constructor(prefix: string, clearOnFlush = false) {
    this._prefix = prefix;
    this._clearOnFlush = clearOnFlush;
  }

  public set(state: string) {
    this._current = state;
  }

  public clear() {
    this._current = undefined;
  }

  public flush(): DatadogSeries | undefined {
    if (this._current === undefined) {
      return undefined;
    }
    const gauge = new Gauge([this._prefix, this._current].join('_'));
    gauge.set(1);
    const series = gauge.flush();
    if (this._clearOnFlush) {
      this.clear();
    }
    return series;
  }
}
