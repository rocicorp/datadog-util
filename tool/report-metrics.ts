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
// and build or play with a dashboard over the test_latency metric. There will be
// one data point per "client" per sample interval. To create a stack graph of the data
// with one data point per client per sample interval, use the count aggregator
// and a rollup over the sample period. For example, if the sample interval is 20s,
// you can compute the number of clients with latency <20s using:
//    count(v: v<=20000):test_latency_ms{*}.as_count().rollup(20)
//       or with tags:
//    count(v: v<=20000):test_latency_ms{service:foo,env:prod}.as_count().rollup(20)
// Note you probably have to enable advanced:percentiles for the metric, you can
// do so in datadog under Metrics > Summary after searching for 'test_latency_ms'.
//
// This is modeled as measuring latency to connect to a server, with some clients
// that never connect. The script starts all clients in the never connected state
// which reports its latency as LATENCY_NEVER. NUM_CONNECT_NEVER will never connect.
// Every sample period (20s) the script will randomly select a client to (re)connect.
// If the client is part of the NUM_CONNECT_NEVER group it will connect with a random
// latency < 20s. If not, it will connect with a random latency < 100s.
//
// The effect is that you should see all clients starting in the unconnected state and
// then gradually every 20s a new client will connect. At steady state you'll see shifts
// in counts of clients with latency < 20s and < 100s as they are randomly reconnected.
// At all times the total number of data points in the sample period should be equal or
// close to NUM_CLIENTS.
//
// Note that the datadog endpoint does not support CORS so this works from the command
// line but will not work directly from the browser. One option is to proxy calls through
// a server, which is a good idea anyway to aggregate datapoints.
const LATENCY_NEVER_MS = 600 * 1000;
const NUM_CLIENTS = 20;
const NUM_CONNECT_NEVER = 5;
const NUM_CONNECT_FAST = 10;
const SAMPLE_INTERVAL_MS = 20 * 1000;
const metrics = [];

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

// Each client has its own Gauge.
const latencies = [];
for (let i = 0; i < NUM_CLIENTS; i++) {
  const l = metrics[i].gauge('test_latency_ms');
  l.set(LATENCY_NEVER_MS);
  latencies.push(l);
}

for (;;) {
  // We have to refresh the gauge each time so a new timestamp and thus data point
  // is created.
  for (const l of latencies) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    l.set(gaugeValue(l.flush())!.value);
  }

  // Pick a random client that is potentially connectable.
  const i = randInt(NUM_CONNECT_NEVER, latencies.length - 1);
  const l = latencies[i];
  // Set its connection latency.
  if (i >= NUM_CONNECT_NEVER && i < NUM_CONNECT_NEVER + NUM_CONNECT_FAST) {
    l.set(randInt(1, 20 * 1000));
  } else {
    l.set(randInt(1, 100 * 1000));
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
