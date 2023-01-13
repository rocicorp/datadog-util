// @ts-check

import path from 'path';
import {fileURLToPath} from 'url';
import {build} from 'esbuild';

// @ts-ignore
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function buildESM() {
  return buildInternal({
    format: 'esm',
    entryPoints: [path.join(__dirname, 'src', 'mod.ts')],
    outfile: path.join(__dirname, 'out/datadog-utils.js'),
  });
}

function buildMetricsCLI() {
  return buildInternal({
    format: 'esm',
    entryPoints: [path.join(__dirname, 'tool', 'report-metrics.ts')],
    outfile: path.join(__dirname, 'out', 'report-metrics.js'),
  });
}

/**
 * @param {Partial<import("esbuild").BuildOptions>} options
 */
function buildInternal(options) {
  return build({
    bundle: true,
    minify: true,
    target: 'esnext',
    ...options,
  });
}

try {
  // @ts-ignore
  await Promise.all([buildESM(), buildMetricsCLI()]);
} catch {
  process.exitCode = 1;
}
