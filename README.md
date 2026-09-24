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
| `mysa_device_current_amps` | load current as reported by the device. On real baseboards it stays non-zero while the heater is idle, so read it as the heater's connected load, not a live draw |
| `mysa_device_voltage_volts` | live voltage measurement, or nominal if unavailable |
| `mysa_device_power_watts` | estimated average power: voltage × current × heating duty cycle — **not** a direct measurement; absent if the device reports no duty cycle |
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

### Installing as a systemd service

Each [release](https://github.com/majorsilence/mysa_exporter/releases)
tarball bundles the app, `node_modules` already installed for that
architecture, a ready-to-use systemd unit, and an env file template — no
npm registry access needed on the target machine.

```bash
# 1. Node.js >=24.15.0 must already be installed and on PATH (e.g. from
#    https://nodejs.org/, your distro package, or nvm) -- not bundled here,
#    since it's a shared system runtime, not part of the app.

# 2. Download + verify + extract
curl -fsSLO https://github.com/majorsilence/mysa_exporter/releases/download/v1.1.0/mysa_exporter-1.1.0.linux-amd64.tar.gz
curl -fsSLO https://github.com/majorsilence/mysa_exporter/releases/download/v1.1.0/sha256sums.txt
sha256sum --check --ignore-missing sha256sums.txt
tar xzf mysa_exporter-1.0.0.linux-amd64.tar.gz
sudo mv mysa_exporter-1.0.0.linux-amd64 /opt/mysa_exporter

# 3. Create the service user
sudo useradd --system --shell /usr/sbin/nologin --no-create-home mysa_exporter

# 4. Credentials
sudo cp /opt/mysa_exporter/systemd/mysa_exporter.env.example /etc/mysa_exporter.env
sudo "$EDITOR" /etc/mysa_exporter.env   # fill in MYSA_USERNAME / MYSA_PASSWORD
sudo chown root:mysa_exporter /etc/mysa_exporter.env
sudo chmod 640 /etc/mysa_exporter.env

# 5. Install + start the unit
sudo cp /opt/mysa_exporter/systemd/mysa_exporter.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mysa_exporter
```

`systemd/mysa_exporter.service` assumes the app lives at `/opt/mysa_exporter`
(rename the extracted, version-named directory to that, as above) and that
`node` resolves on `PATH` (`ExecStart=/usr/bin/env node index.mjs`) — edit
both if your setup differs. It runs as the unprivileged `mysa_exporter`
system user with `ProtectSystem=strict`/`NoNewPrivileges`/etc.

### Grafana dashboard

`grafana/dashboard.json` is a ready-made dashboard: per-thermostat current
readings table, temperature-vs-setpoint, humidity, heating duty cycle,
estimated power draw, and connectivity. It expects a Prometheus datasource
with UID `prometheus` scraping this exporter under job name `mysa` — either
rename your datasource's UID to `prometheus`, or open the dashboard's JSON
model after importing and change the datasource references. Import it via
Grafana's UI (Dashboards → New → Import, upload the file) or drop it into a
provisioned dashboards directory.

## Releasing

Each architecture-specific tarball
(`mysa_exporter-<version>.linux-<amd64|arm64>.tar.gz`) bundles the app,
`node_modules` already installed for that architecture (built against the
pinned Node.js version in `.github/workflows/release.yml`), the systemd
unit + env template (`systemd/`), and the Grafana dashboard
(`grafana/dashboard.json`) — everything in "Installing as a systemd
service" and "Grafana dashboard" above comes from inside the tarball.
Consumers don't need npm registry access at deploy time — just download,
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
