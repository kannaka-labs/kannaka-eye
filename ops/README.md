# kannaka-eye ops (Oracle deploy)

The eye is the constellation's vision modality. Running it closes the
**attention-as-gravity** loop: it perceives content (its own UI, or the radio
via `/api/radio`), renders an SGA glyph, and publishes it to
`KANNAKA.attention.eye`. `kannaka attention serve` consumes those glyph events,
pulls same-Fano-line memories into the beam (gravity), and serves O(K) recall.

## Deploy

```bash
# on the box:
cd /home/opc && git clone https://github.com/kannaka-labs/kannaka-eye.git   # first time
cd /home/opc/kannaka-eye && git pull                                      # updates
chmod +x ops/run-eye.sh
sudo install -m644 ops/kannaka-eye.service /etc/systemd/system/kannaka-eye.service
sudo systemctl daemon-reload && sudo systemctl enable --now kannaka-eye

# feeder: nudge the eye to glyph the radio's current output every minute
( crontab -l 2>/dev/null | grep -v 'api/radio';
  echo '* * * * * curl -fsS http://localhost:3335/api/radio >/dev/null 2>&1' ) | crontab -
```

## Requirements

- Node 20+ (uses global `fetch`; zero npm deps — raw TCP NATS).
- `/home/opc/.kannaka-nats.env` (NATS_USER / NATS_PASSWORD for kannaka_internal)
  — `KANNAKA.attention.eye` is not in anon's allow-list, so the eye must auth.
- `KANNAKA_BIN=/home/opc/.local/bin/kannaka` so the native classifier sets the
  dominant Fano line the same way kannaka-memory does (gravity alignment).
- Port 3335 (3333 = local default, 3334 = observatory).

## Verify

```bash
systemctl status kannaka-eye
curl -s http://localhost:3335/api/attention/stats   # publish counts
curl -s http://localhost:3335/api/radio >/dev/null  # force one emit
journalctl -u kannaka-attention -n 20 | grep glyph-gravity   # consumer pulled same-line memories
cat /tmp/kannaka-attention-beam.json                # beam warmed
```

## Enabling gravity

Recall-side and beam-side gravity are gated by `KANNAKA_GLYPH_GRAVITY=<gain>`
(e.g. 0.5) on the consuming services (kannaka-attention, kannaka-swarm-serve)
via systemd drop-ins. Default 0.0 = inert.
