# mysa_exporter

A [Prometheus](https://prometheus.io/) exporter for
[Mysa](https://getmysa.com) smart thermostats (including the electric
baseboard line), built on
[`mysa-js-sdk`](https://www.npmjs.com/package/mysa-js-sdk).

Mysa thermostats have no local API. This exporter logs into Mysa's cloud
API once, then polls it on a timer and caches the result in memory —
`/metrics` is served from that cache rather than hitting Mysa's API on
every Prometheus scrape. Mysa's API is unofficial and reverse-engineered
(via [`mysa-js-sdk`](https://github.com/bourquep/mysa2mqtt)), so treat this
exporter the same way: it can break if Mysa changes their backend.

## Metrics

Per thermostat (labeled `device_id`, `name`):

| metric | meaning |
|---|---|
| `mysa_device_info` | static metadata (`model`, `home_id`); value always 1 |
| `mysa_device_temperature_celsius` | ambient temperature (calibration-corrected when available) |
| `mysa_device_setpoint_celsius` | target temperature |
| `mysa_device_humidity_percent` | relative humidity, 0-100 |
| `mysa_device_current_amps` | instantaneous current draw |
| `mysa_device_voltage_volts` | live voltage measurement, or nominal if unavailable |
| `mysa_device_power_watts` | estimated as voltage × current — **not** a direct measurement |
| `mysa_device_duty_cycle_ratio` | fraction of time the heating relay has been on, 0-1 |
| `mysa_device_heating_active` | 1 if duty cycle is currently above 0 |
| `mysa_device_connected` | 1 if the device last reported itself connected |
| `mysa_device_rssi_dbm` | Wi-Fi signal strength |
| `mysa_device_heatsink_temperature_celsius` | internal heatsink temperature, when reported |
| `mysa_device_state_age_seconds` | time since Mysa last updated this device's reading — watch this for stale/offline devices |
| `mysa_device_thermostat_mode_code` | raw, **undocumented** Mysa mode code; only the baseboard (BB-\*) on/off encoding (1=off, 3=heat) is confirmed, from [dlenski/mysotherm](https://github.com/dlenski/mysotherm)'s protocol reverse-engineering — prefer `mysa_device_heating_active` |

Exporter self-observability (no labels):

| metric | meaning |
|---|---|
| `mysa_exporter_up` | 1 if the last poll of Mysa's API succeeded, 0 otherwise |
| `mysa_exporter_last_poll_timestamp_seconds` | unix timestamp of the last completed poll |
| `mysa_exporter_poll_duration_seconds` | duration of the last poll |
| `mysa_exporter_poll_errors_total` | count of failed polls |
| `mysa_exporter_devices` | number of devices last seen on the account |

`mysa_exporter_up` and `poll_errors_total` are deliberately separate from
Prometheus's own scrape `up{job="mysa"}`: a failed poll of Mysa's API is a
different failure mode than the exporter process itself being down, and
`/metrics` keeps serving the last-known-good values either way. Standard
Node.js process metrics (`mysa_exporter_process_*`, `mysa_exporter_nodejs_*`)
are also exposed via
[`@prometheus-io/client`](https://www.npmjs.com/package/@prometheus-io/client).

## Configuration

All via environment variables:

| variable | default | meaning |
|---|---|---|
| `MYSA_USERNAME` | *(required)* | Mysa account email |
| `MYSA_PASSWORD` | *(required)* | Mysa account password |
| `MYSA_EXPORTER_LISTEN_ADDRESS` | `127.0.0.1` | bind address |
| `MYSA_EXPORTER_PORT` | `9499` | bind port |
| `MYSA_EXPORTER_POLL_INTERVAL_SECONDS` | `60` | how often to poll Mysa's API |

## Running it

Requires Node.js ≥24.15.0 (`mysa-js-sdk`'s own requirement).

```bash
npm ci --omit=dev
MYSA_USERNAME=you@example.com MYSA_PASSWORD=your-password node index.mjs
```

`GET /metrics` for Prometheus, `GET /healthz` for a plain liveness check
(reports the process as healthy independently of whether the last poll of
Mysa's API succeeded).

### Ansible / gitops

This is consumed as a pinned release by the `mysa_exporter` Ansible role in
[majorsilence/linux-setup-scripts](https://github.com/majorsilence/linux-setup-scripts/tree/main/gitops/ansible/roles/mysa_exporter)
— see that repo for a full systemd-hardened deployment plus a companion
Grafana dashboard.

## Releasing

Each architecture-specific tarball
(`mysa_exporter-<version>.linux-<amd64|arm64>.tar.gz`) bundles the app
together with `node_modules` already installed for that architecture (built
against the pinned Node.js version in `.github/workflows/release.yml`), so
consumers don't need npm registry access at deploy time — just download,
verify against `sha256sums.txt`, extract, and run with the matching Node.js
version.

To cut a release: bump `version` in `package.json`, commit, then push a
matching tag (`git tag v0.1.0 && git push origin v0.1.0`). CI builds both
architectures and publishes a GitHub Release with the tarballs and
`sha256sums.txt`.

## Disclaimer

This project uses `mysa-js-sdk`, which itself uses undocumented and
unsupported Mysa APIs, without Mysa's consent. Mysa may change their APIs
at any time and break this exporter. Not affiliated with or endorsed by
Mysa.

## License

MIT
