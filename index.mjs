// Prometheus exporter for Mysa smart thermostats.
//
// Polls Mysa's cloud REST API (via mysa-js-sdk) on a timer rather than
// scraping it live per Prometheus request: the API is unofficial/
// reverse-engineered, so every request is a liability, and Prometheus
// scrapes far more often than thermostat readings actually change.
// Results are cached in memory and served from /metrics on demand.
import { createServer } from 'node:http';
import { MysaApiClient, MysaApiError, UnauthenticatedError } from 'mysa-js-sdk';
import client from '@prometheus-io/client';
import { estimatedPowerWatts, stateAgeSeconds } from './readings.mjs';

const MYSA_USERNAME = process.env.MYSA_USERNAME;
const MYSA_PASSWORD = process.env.MYSA_PASSWORD;
const LISTEN_ADDRESS = process.env.MYSA_EXPORTER_LISTEN_ADDRESS || '127.0.0.1';
const LISTEN_PORT = Number(process.env.MYSA_EXPORTER_PORT || 9499);
const POLL_INTERVAL_SECONDS = Number(process.env.MYSA_EXPORTER_POLL_INTERVAL_SECONDS || 60);

if (!MYSA_USERNAME || !MYSA_PASSWORD) {
  console.error('MYSA_USERNAME and MYSA_PASSWORD must both be set');
  process.exit(1);
}

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'mysa_exporter_' });

const up = new client.Gauge({
  name: 'mysa_exporter_up',
  help: '1 if the last poll of the Mysa API succeeded, 0 otherwise',
  registers: [registry]
});
const lastPollTimestamp = new client.Gauge({
  name: 'mysa_exporter_last_poll_timestamp_seconds',
  help: 'Unix timestamp of the last completed poll attempt',
  registers: [registry]
});
const pollDuration = new client.Gauge({
  name: 'mysa_exporter_poll_duration_seconds',
  help: 'Duration of the last poll of the Mysa API',
  registers: [registry]
});
const pollErrors = new client.Counter({
  name: 'mysa_exporter_poll_errors_total',
  help: 'Total number of failed polls of the Mysa API',
  registers: [registry]
});
const deviceCount = new client.Gauge({
  name: 'mysa_exporter_devices',
  help: 'Number of Mysa devices last seen on the account',
  registers: [registry]
});

const deviceLabelNames = ['device_id', 'name'];
const info = new client.Gauge({
  name: 'mysa_device_info',
  help: 'Static Mysa device metadata; value is always 1',
  labelNames: [...deviceLabelNames, 'model', 'home_id'],
  registers: [registry]
});
const temperature = new client.Gauge({
  name: 'mysa_device_temperature_celsius',
  help: 'Ambient temperature reported by the device (calibration-corrected when available)',
  labelNames: deviceLabelNames,
  registers: [registry]
});
const setPoint = new client.Gauge({
  name: 'mysa_device_setpoint_celsius',
  help: 'Target temperature (thermostat setpoint)',
  labelNames: deviceLabelNames,
  registers: [registry]
});
const humidity = new client.Gauge({
  name: 'mysa_device_humidity_percent',
  help: 'Relative humidity reported by the device, 0-100',
  labelNames: deviceLabelNames,
  registers: [registry]
});
const current = new client.Gauge({
  name: 'mysa_device_current_amps',
  help: 'Load current reported by the device. Observed to stay non-zero while the heater is idle, '
    + 'so read it as the heater\'s connected load, not a live draw -- see mysa_device_power_watts',
  labelNames: deviceLabelNames,
  registers: [registry]
});
const voltage = new client.Gauge({
  name: 'mysa_device_voltage_volts',
  help: 'Line voltage; live measurement when reported, otherwise the device\'s nominal voltage',
  labelNames: deviceLabelNames,
  registers: [registry]
});
const power = new client.Gauge({
  name: 'mysa_device_power_watts',
  help: 'Estimated average power: voltage x current x heating-relay duty cycle '
    + '(not a direct device measurement; absent when the device reports no duty cycle)',
  labelNames: deviceLabelNames,
  registers: [registry]
});
const dutyCycle = new client.Gauge({
  name: 'mysa_device_duty_cycle_ratio',
  help: 'Fraction of time the heating relay has been on, 0-1',
  labelNames: deviceLabelNames,
  registers: [registry]
});
const heatingActive = new client.Gauge({
  name: 'mysa_device_heating_active',
  help: '1 if the heating relay duty cycle is currently above 0, 0 otherwise',
  labelNames: deviceLabelNames,
  registers: [registry]
});
const connected = new client.Gauge({
  name: 'mysa_device_connected',
  help: '1 if the device last reported itself connected, 0 otherwise',
  labelNames: deviceLabelNames,
  registers: [registry]
});
const rssi = new client.Gauge({
  name: 'mysa_device_rssi_dbm',
  help: 'Wi-Fi signal strength',
  labelNames: deviceLabelNames,
  registers: [registry]
});
const heatSinkTemperature = new client.Gauge({
  name: 'mysa_device_heatsink_temperature_celsius',
  help: 'Internal heatsink temperature, when reported by the device',
  labelNames: deviceLabelNames,
  registers: [registry]
});
const stateAge = new client.Gauge({
  name: 'mysa_device_state_age_seconds',
  help: 'Time since the device state was last updated by Mysa, per the API-reported timestamp',
  labelNames: deviceLabelNames,
  registers: [registry]
});
const thermostatModeCode = new client.Gauge({
  name: 'mysa_device_thermostat_mode_code',
  help: 'Raw, undocumented TstatMode code from the Mysa API. Observed on baseboard (BB-*) ' +
    'devices: 1=off, 3=heat. Not confirmed for other device types -- prefer ' +
    'mysa_device_heating_active or mysa_device_duty_cycle_ratio where possible.',
  labelNames: deviceLabelNames,
  registers: [registry]
});

const logger = {
  debug: () => {},
  info: (message, ...meta) => console.log(message, ...meta),
  warn: (message, ...meta) => console.warn(message, ...meta),
  error: (message, ...meta) => console.error(message, ...meta)
};

const mysa = new MysaApiClient({ username: MYSA_USERNAME, password: MYSA_PASSWORD }, { logger });

// deviceId -> {device_id, name, model, home_id}
let knownDevices = new Map();

function removeStaleDevices(currentDeviceIds) {
  for (const [deviceId, deviceLabels] of knownDevices) {
    if (currentDeviceIds.has(deviceId)) {
      continue;
    }
    const { device_id, name } = deviceLabels;
    const labels = { device_id, name };
    info.remove({ ...labels, model: deviceLabels.model, home_id: deviceLabels.home_id });
    for (const gauge of [
      temperature, setPoint, humidity, current, voltage, power, dutyCycle,
      heatingActive, connected, rssi, heatSinkTemperature, stateAge, thermostatModeCode
    ]) {
      gauge.remove(labels);
    }
    knownDevices.delete(deviceId);
  }
}

function setIfPresent(gauge, labels, timestampedValue) {
  if (timestampedValue !== undefined && timestampedValue.v !== undefined) {
    gauge.set(labels, Number(timestampedValue.v));
  }
}

async function poll() {
  const start = Date.now();
  try {
    const [devices, states] = await Promise.all([mysa.getDevices(), mysa.getDeviceStates()]);
    const deviceIds = new Set(Object.keys(devices.DevicesObj));

    for (const [deviceId, device] of Object.entries(devices.DevicesObj)) {
      const labels = { device_id: deviceId, name: device.Name || deviceId };
      const model = device.Model || 'unknown';
      const homeId = device.Home || '';
      knownDevices.set(deviceId, { ...labels, model, home_id: homeId });
      info.set({ ...labels, model, home_id: homeId }, 1);

      const state = states.DeviceStatesObj[deviceId];
      if (!state) {
        continue;
      }

      const correctedOrSensorTemp = state.CorrectedTemp ?? state.SensorTemp;
      setIfPresent(temperature, labels, correctedOrSensorTemp);
      setIfPresent(setPoint, labels, state.SetPoint);
      setIfPresent(humidity, labels, state.Humidity);
      setIfPresent(current, labels, state.Current);
      setIfPresent(rssi, labels, state.Rssi);
      setIfPresent(heatSinkTemperature, labels, state.HeatSink);
      setIfPresent(thermostatModeCode, labels, state.TstatMode);

      const liveVoltage = state.Voltage?.v ?? device.Voltage;
      if (liveVoltage !== undefined) {
        voltage.set(labels, Number(liveVoltage));
      }
      const estimatedPower = estimatedPowerWatts(state.Current?.v, liveVoltage, state.Duty?.v);
      if (estimatedPower !== undefined) {
        power.set(labels, estimatedPower);
      }

      if (state.Duty?.v !== undefined) {
        const duty = Number(state.Duty.v);
        dutyCycle.set(labels, duty);
        heatingActive.set(labels, duty > 0 ? 1 : 0);
      }

      if (state.Connected?.v !== undefined) {
        connected.set(labels, state.Connected.v ? 1 : 0);
      }

      if (state.Timestamp !== undefined) {
        stateAge.set(labels, stateAgeSeconds(state.Timestamp, Date.now()));
      }
    }

    removeStaleDevices(deviceIds);
    deviceCount.set(deviceIds.size);
    up.set(1);
  } catch (error) {
    pollErrors.inc();
    up.set(0);
    if (error instanceof UnauthenticatedError) {
      logger.error(`Mysa authentication failed: ${error.message}`);
    } else if (error instanceof MysaApiError) {
      logger.error(`Mysa API error ${error.status} (${error.statusText})`);
    } else {
      logger.error(`Mysa poll failed: ${error.message ?? error}`);
    }
  } finally {
    lastPollTimestamp.set(Date.now() / 1000);
    pollDuration.set((Date.now() - start) / 1000);
  }
}

const server = createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.setHeader('Content-Type', registry.contentType);
    res.end(await registry.metrics());
    return;
  }
  if (req.url === '/healthz') {
    res.writeHead(200).end('ok');
    return;
  }
  res.writeHead(404).end('not found; see /metrics');
});

async function main() {
  try {
    await mysa.login();
    logger.info('Logged in to Mysa');
  } catch (error) {
    logger.error(`Initial Mysa login failed, will keep retrying on each poll: ${error.message ?? error}`);
  }

  await poll();
  const interval = setInterval(poll, POLL_INTERVAL_SECONDS * 1000);

  server.listen(LISTEN_PORT, LISTEN_ADDRESS, () => {
    logger.info(`mysa-exporter listening on ${LISTEN_ADDRESS}:${LISTEN_PORT}`);
  });

  const shutdown = () => {
    clearInterval(interval);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
