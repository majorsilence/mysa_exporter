// Smoke test: starts the real exporter against intentionally-invalid Mysa
// credentials (no real account needed) and checks it comes up, serves
// /metrics and /healthz, and records the failed poll on its own
// self-observability metrics instead of crashing. This mirrors the
// exporter's actual failure-handling contract, not just that it boots.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'index.mjs');
const PORT = 19599;

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for exporter to listen')), 15000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening on')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`exporter exited early with code ${code}`));
    });
  });
}

test('exporter serves /metrics and /healthz, and reports a failed poll as unhealthy (not a crash)', async () => {
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      MYSA_USERNAME: 'smoke-test@example.invalid',
      MYSA_PASSWORD: 'not-a-real-password',
      MYSA_EXPORTER_LISTEN_ADDRESS: '127.0.0.1',
      MYSA_EXPORTER_PORT: String(PORT),
      MYSA_EXPORTER_POLL_INTERVAL_SECONDS: '30',
    },
  });

  try {
    await waitForListening(child);

    const health = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    assert.equal(health.status, 200);

    const metricsRes = await fetch(`http://127.0.0.1:${PORT}/metrics`);
    assert.equal(metricsRes.status, 200);
    const body = await metricsRes.text();

    assert.match(body, /^mysa_exporter_up 0$/m, 'a failed poll must report itself as down, not silently succeed');
    assert.match(body, /^mysa_exporter_poll_errors_total [1-9]\d*$/m);
    assert.match(body, /^mysa_exporter_devices 0$/m);
    assert.match(body, /^# HELP mysa_device_temperature_celsius /m, 'metric descriptors register even with zero devices');
  } finally {
    child.kill('SIGTERM');
  }
});
