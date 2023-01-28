import {jest, afterEach, beforeEach, test, expect} from '@jest/globals';
import type {SpyInstance} from 'jest-mock';
import {
  Metrics,
  Reporter,
  Gauge,
  gaugeValue,
  DD_AUTH_HEADER_NAME,
  DD_DISTRIBUTION_METRIC_URL,
  State,
} from './metrics.js';
import {Response} from 'cross-fetch';
import {OptionalLoggerImpl} from '@rocicorp/logger';

let fetchSpy: SpyInstance<typeof fetch>;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(42123);
  fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockReturnValue(Promise.resolve(new Response('{}')));
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('Reporter reports', () => {
  jest.setSystemTime(0);
  // Note: it only reports if there is data to report.
  const m = newMetricsWithDataToReport();
  const g = m.gauge('name');
  const headers = {[DD_AUTH_HEADER_NAME]: 'apiKey'};
  new Reporter({
    url: DD_DISTRIBUTION_METRIC_URL,
    metrics: m,
    headers,
    intervalMs: 1 * 1000,
  });

  jest.advanceTimersByTime(1000);
  const expectedSeries = [g.flush()];

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(fetchSpy).toHaveBeenCalledWith(DD_DISTRIBUTION_METRIC_URL, {
    body: JSON.stringify({series: expectedSeries}),
    headers: {'DD-API-KEY': 'apiKey', 'Content-Type': 'application/json'},
    signal: null,
    method: 'POST',
  });
});

function newMetricsWithDataToReport() {
  const m = new Metrics();
  m.gauge('name').set(1);
  return m;
}

// eslint-disable-next-line require-await
test('Reporter logs an error on error', async () => {
  jest.setSystemTime(0);
  // Note: it only reports if there is data to report.
  const m = newMetricsWithDataToReport();
  const logSink = {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    log: jest.fn().mockImplementation(() => {}),
  };
  const optionalLogger = new OptionalLoggerImpl(logSink);
  fetchSpy.mockImplementation(() => {
    throw new Error('boom');
  });

  const headers = {[DD_AUTH_HEADER_NAME]: 'apiKey'};
  new Reporter({
    metrics: m,
    url: DD_DISTRIBUTION_METRIC_URL,
    headers,
    intervalMs: 1 * 1000,
    optionalLogger,
  });

  jest.setSystemTime(43000);
  jest.advanceTimersByTime(1000);

  await microtasksUntil(() => fetchSpy.mock.calls.length >= 1);

  expect(fetchSpy).toHaveBeenCalledTimes(1);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const lastCall = logSink.log.mock.lastCall!;
  expect(lastCall).toHaveLength(2);
  expect(lastCall[0]).toBe('error');
  expect(lastCall[1]).toMatch('boom');
});

async function microtasksUntil(p: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (p()) {
      return;
    }
    await 'microtask';
  }
}

test('Reporter does not report if no series to report', async () => {
  const r = new Reporter({
    metrics: new Metrics(),
    url: DD_DISTRIBUTION_METRIC_URL,
    headers: {[DD_AUTH_HEADER_NAME]: 'apiKey'},
  });
  await r.report();
  expect(fetchSpy).not.toHaveBeenCalled();
});

test('Reporter stops when abort is signaled', () => {
  const ac = new AbortController();
  // Note: it only reports if there is data to report.
  const m = newMetricsWithDataToReport();

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  new Reporter({
    url: DD_DISTRIBUTION_METRIC_URL,
    abortSignal: ac.signal,
    headers: {[DD_AUTH_HEADER_NAME]: 'apiKey'},
    metrics: m,
    intervalMs: 1 * 1000,
  });

  jest.setSystemTime(43000);
  ac.abort();

  jest.advanceTimersByTime(1 * 1000);
  expect(fetchSpy).toHaveBeenCalledTimes(0);
});

test('Metrics.gauge', () => {
  const m = new Metrics();

  // Same name should return the same gauge.
  const g1 = m.gauge('name');
  const g2 = m.gauge('name');
  expect(g1).toBe(g2);

  // Different name should return different gauge.
  const g3 = m.gauge('some-other-name');
  expect(g1).not.toBe(g3);
});

test('Metrics.state', () => {
  const m = new Metrics();

  // Same name/prefix should return the same state.
  const s1 = m.state('name');
  const s2 = m.state('name');
  expect(s1).toBe(s2);

  // Different name/prefix should return different State.
  const s3 = m.state('some-other-name');
  expect(s1).not.toBe(s3);
});

test('Metrics.flush', () => {
  const m = new Metrics();

  // No gauges.
  expect(m.flush()).toEqual([]);

  // One gauge.
  const g = m.gauge('name');
  g.set(3);
  expect(m.flush()).toEqual([
    {
      metric: 'name',
      points: [[42, [3]]],
    },
  ]);

  // Change the system time and add a new gauge.
  // Both gauges should have the current time.
  jest.setSystemTime(43123);
  const g2 = m.gauge('other-name');
  g2.set(4);

  expect(m.flush()).toEqual([
    {
      metric: 'name',
      points: [[43, [3]]],
    },
    {
      metric: 'other-name',
      points: [[43, [4]]],
    },
  ]);

  // Change the system time and change old gauge.
  jest.setSystemTime(44123);
  g.set(5);
  expect(m.flush()).toEqual([
    {
      metric: 'name',
      points: [[44, [5]]],
    },
    {
      metric: 'other-name',
      points: [[44, [4]]],
    },
  ]);

  // Ensure states are included.
  const s1 = m.state('s1');
  s1.set('1');
  const s2 = m.state('s2');
  s2.set('2');
  m.state('s3');
  expect(m.flush()).toEqual([
    {
      metric: 'name',
      points: [[44, [5]]],
    },
    {
      metric: 'other-name',
      points: [[44, [4]]],
    },
    {
      metric: 's1_1',
      points: [[44, [1]]],
    },
    {
      metric: 's2_2',
      points: [[44, [1]]],
    },
  ]);
});

test('Gauge', () => {
  const g = new Gauge('name');
  expect(g.flush()).toMatchObject({
    metric: 'name',
    points: [],
  });

  g.set(3);
  expect(g.flush()).toMatchObject({
    metric: 'name',
    points: [[42, [3]]],
  });

  g.set(4);
  expect(g.flush()).toMatchObject({
    metric: 'name',
    points: [[42, [4]]],
  });

  // Ensure it doesn't alias its internal state.
  const hopefullyNotAnAlias = g.flush();
  hopefullyNotAnAlias.points[0][0] = 5;
  hopefullyNotAnAlias.points[0][1] = [5];
  expect(g.flush()).toMatchObject({
    metric: 'name',
    points: [[42, [4]]],
  });
});

test('gaugeValue', () => {
  const g = new Gauge('name');
  expect(gaugeValue(g.flush())).toBeUndefined();

  g.set(3);
  expect(gaugeValue(g.flush())).toMatchObject({
    metric: 'name',
    tsSec: 42,
    value: 3,
  });
});

test('State', () => {
  const s = new State('foo');
  expect(s.flush()).toEqual(undefined);

  // Clearing an empty state should not add anything.
  s.clear();
  expect(s.flush()).toEqual(undefined);

  // Set a state.
  s.set('1');
  expect(s.flush()).toMatchObject({
    metric: 'foo_1',
    points: [[42, [1]]],
  });
  // Ensure it is not cleared on flush.
  expect(s.flush()).toMatchObject({
    metric: 'foo_1',
    points: [[42, [1]]],
  });

  // Set it again at a later time.
  jest.setSystemTime(43 * 1000);
  s.set('1');
  expect(s.flush()).toMatchObject({
    metric: 'foo_1',
    points: [[43, [1]]],
  });

  // Set a different state.
  s.set('2');
  expect(s.flush()).toMatchObject({
    metric: 'foo_2',
    points: [[43, [1]]],
  });

  // Clear it.
  s.clear();
  expect(s.flush()).toEqual(undefined);

  // Test clearOnFlush.
  const s2 = new State('foo', true /* clearOnFlush */);
  s2.set('1');
  expect(s2.flush()).toMatchObject({
    metric: 'foo_1',
    points: [[43, [1]]],
  });
  expect(s2.flush()).toEqual(undefined);
});
