#! /usr/bin/env node

import {
  DD_AUTH_HEADER_NAME,
  DD_DISTRIBUTION_METRIC_URL,
  gaugeValue,
  Metrics,
  report,
} from '../src/metrics/metrics.js';

// This is a very basic and not-polished script to test receiving and graphing
// metrics on the Datadog side. It's not intended to be a good example of how to
// use the metrics library. Start this script and then go to the Datadog dashboard
// and build or play with a dashboard over the time_to_connect_ms metric. There will be
// one data point per "client" per sample interval. To create a stack graph of the data
// with one data point per client per sample interval, use the count aggregator
// and a rollup over the sample period. For example, if the sample interval is 20s,
// you can compute the number of clients with latency <20s using:
//    count(v: v<=20000):time_to_connect_ms{*}.as_count().rollup(10)
//       or with tags:
//    count(v: v<=20000):time_to_connect_ms{service:foo,env:prod}.as_count().rollup(10)
// Note you probably have to enable advanced:percentiles for the metric, you can
// do so in datadog under Metrics > Summary after searching for 'time_to_connect_ms'.
//
// This is modeled as measuring latency to connect to a server, with some clients
// that never connect. The script starts all clients in the never connected state
// which reports its latency as LATENCY_NEVER. NUM_CONNECT_NEVER will never connect.
// Every sample period (10s) the script will randomly select a client to (re)connect.
// If the client is part of the NUM_CONNECT_NEVER group it will connect with a random
// latency < 20s. If not, it will connect with a random latency < 100s.
//
// The effect is that you should see all clients starting in the unconnected state and
// then gradually every 10s a new client will connect. At steady state you'll see shifts
// in counts of clients with latency < 20s and < 100s as they are randomly reconnected.
// At all times the total number of data points in the sample period should be equal or
// close to NUM_CLIENTS.
//
// It also sends last_connect_error with half the clients starting in a random error
// state and then each period having one client either clear its error if any or 
// pick a new error with p 0.5.
//
// Note that the datadog endpoint does not support CORS so this works from the command
// line but will not work directly from the browser. In the browser we proxy calls 
// through reflect server.
//
// IMPORTANT NOTE: the reporting interval here is 10s so rollup on the graph needs to
// be 10s too. The "real" reporting period should not be this low, it is 2m in reflect
// and the dashboards should have a rollup over 120 (2m in seconds). The graphs will be
// way off and non-sensical if there is a reporting period - rollup window mismatch.
const LATENCY_NEVER_MS = 600 * 1000;
const NUM_CLIENTS = 20;
const NUM_CONNECT_NEVER = 5;
const NUM_CONNECT_FAST = 10;
const SAMPLE_INTERVAL_MS = 10 * 1000;
const metrics = [];
const LAST_CONNECT_ERRORS = [
  // Note: state metric name 'last_connect_error' gets prepended to these
  // for reporting eg 'last_connect_error_auth_invalidated'.
  'auth_invalidated',
  'client_not_found',
  'invalid_connection_request',
  'invalid_message',
  'ping_timeout',
  'room_closed',
  'room_not_found',
  'unauthorized',
  'unexpected_base_cookie',
  'unexpected_last_mutation_id',
];

const apiKey = process.env.DATADOG_API_KEY;
if (apiKey === undefined || apiKey === '') {
  throw 'DATADOG_API_KEY must be set';
}

// Each client has its own Metrics.
// TODO: we could use Reporter to report the metrics. This script was pre-Reporter.
for (let i = 0; i < NUM_CLIENTS; i++) {
  const m = new Metrics();
  metrics.push(m);
}

// Each client has its own latency Gauge and connect error State.
const latencies = [];
const lces = [];
for (let i = 0; i < NUM_CLIENTS; i++) {
  const l = metrics[i].gauge('time_to_connect_ms');
  l.set(LATENCY_NEVER_MS);
  latencies.push(l);

  const lce = metrics[i].state('last_connect_error');
  lces.push(lce);
  if (i < NUM_CLIENTS/2) {
    lce.set(LAST_CONNECT_ERRORS[randInt(0, LAST_CONNECT_ERRORS.length-1)]);
  }

}

for (;;) {
  // We have to refresh the gauge each time so a new timestamp and thus data point
  // is created.
  for (const l of latencies) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    l.set(gaugeValue(l.flush())!.value);
  }

  // Pick a random client.
  const i = randInt(NUM_CONNECT_NEVER, latencies.length - 1);

  // Record latency metric.
  const l = latencies[i];
  // Set its connection latency.
  if (i >= NUM_CONNECT_NEVER && i < NUM_CONNECT_NEVER + NUM_CONNECT_FAST) {
    l.set(randInt(1, 20 * 1000));
  } else {
    l.set(randInt(1, 100 * 1000));
  }

  // Record last connection error metric.
  const lce = lces[i];
  if (randInt(0, 1) == 0) {
    lce.clear();
  } else {
    lce.set(LAST_CONNECT_ERRORS[randInt(0, LAST_CONNECT_ERRORS.length-1)]);
  }

  await sleep(SAMPLE_INTERVAL_MS);

  // Report all metrics.
  const promises = [];
  for (const m of metrics) {
    const logLine: string[] = m
      .flush()
      .map(s => `${s.metric}:${gaugeValue(s)?.value}`);
    console.log(logLine);

    const f = async () => {
      const resp = await report(
        DD_DISTRIBUTION_METRIC_URL,
        {[DD_AUTH_HEADER_NAME]: apiKey},
        m.flush(),
      );
      console.log(resp.ok, JSON.stringify(await resp.json()));
    };
    promises.push(f());
  }

  try {
    await Promise.all(promises);
  } catch (e) {
    console.error(e);
  }
}

function sleep(ms = 0, setTimeout = globalThis.setTimeout): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// The min and max are inclusive.
function randInt(min: number, max: number) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1) + min);
}
