#!/usr/bin/env node
/**
 * Regression tests for the May bug batch (issues #21, #22, #24, #26) plus a
 * guard for the already-fixed #27. Hermetic: spawns the real server on a free
 * port with the native classifier forced to an unusable path, and drives the
 * affected endpoints. No external deps, no network beyond localhost.
 *
 *   #21  /api/constellation reports classifier from an ACTUAL native probe,
 *        not from KANNAKA_BIN file presence. With a binary path that can't
 *        classify, it must report "fallback" (pre-fix: lied "native").
 *   #24  /api/constellation.svg must NOT light the Memory node unless the
 *        native classifier is verified (pre-fix: Memory hardcoded active).
 *   #26  the served page must route large-file progress to #canvasInfo, not a
 *        nonexistent #info-text node (pre-fix: null deref on >1 MB uploads).
 *   #27  /api/radio must preserve an explicit tempo_bpm: 0 as a feature byte
 *        (pre-fix: 0 was treated as falsy/absent and dropped).
 *   #22  attention-bridge parses nats://user:pass@host into user/pass, and a
 *        bare nats://token@host into a token (pre-fix: user:pass sent as one
 *        auth_token).
 *   #48  startup does not announce "Native classifier: <path>" for a path it
 *        never checked; an explicit-but-missing KANNAKA_BIN warns instead.
 *   #35  the attention bridge honours the constellation-wide
 *        KANNAKA_NATS_URL (pre-fix: only the generic NATS_URL was read, so a
 *        correctly-configured box silently published to localhost:4222).
 *   #37  a fallback-classified /api/radio glyph still carries
 *        levelDistribution (pre-fix: buildGlyphFromBytes omitted it, so the
 *        viewer's resonance-ring layer silently did not render).
 *   #38  the Radio preset renders the glyph /api/radio already returned
 *        instead of re-POSTing to /api/process (pre-fix: one radio click
 *        published the same listening event to attention twice, the second
 *        time mislabelled "bytes" instead of "audio").
 *   #41  /api/constellation exposes a `memory` object instead of forcing
 *        callers to infer memory status from the `classifier` string.
 *   #43  the viewer renders dominantClass 0 as "0", not an em dash (pre-fix:
 *        `|| '—'` treated a legitimate class 0 as "no data").
 *   #46  /api/constellation and constellation.svg report attention-bridge
 *        state (pre-fix: a dead Eye->Attention link left every surface
 *        looking healthy while glyphs were silently dropped).
 *   #47  a fatal NATS -ERR drops the socket so the 5s reconnect fires
 *        (pre-fix: -ERR only logged, and _scheduleReconnect() is reachable
 *        only from 'close' — a broker that rejected auth without closing left
 *        the bridge permanently dead).
 *   #64  radio's own `running: false` beats Eye's reachability inference
 *        (pre-fix: `running: true` was a literal on the "we got JSON" branch,
 *        so a stopped radio answering 200 read as live).
 *   #68  no class id decodes to an impossible h2=4 (pre-fix: everything above
 *        83 was aliased to 95, collapsing twelve ids onto one point outside
 *        the advertised 0..3 range).
 *   #71  a publish the broker REFUSES is not counted as published (pre-fix:
 *        a standing permissions denial left `published` climbing while the
 *        broker accepted nothing).
 *   #72  a write to an already-destroyed socket is not a delivery (pre-fix:
 *        the cached `_connected` flag lags the 'close' event, so glyphs sent
 *        into a dead socket during reconnect churn counted as published).
 *
 * Usage: node tests/bug_batch.mjs   (exit 0 iff all pass)
 */

import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import net from "net";
import http from "http";
import { readFileSync } from "fs";

import { AttentionBridge, parseNatsUrl, isFatalNatsError, resolveNatsUrl, DEFAULT_NATS_URL } from "../attention-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EYE_DIR = join(__dirname, "..");

// A path that cannot exist: server.js short-circuits KANNAKA_BIN auto-detect
// on this truthy value, then execFile fails with ENOENT so the native probe
// resolves false. This makes "binary configured but unusable" deterministic
// on every host — the exact condition #21 is about.
const FAKE_BIN = join(__dirname, "__no_native_classifier__", "kannaka");

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`PASS  ${name}`);
    passed++;
  } else {
    console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`);
    failed++;
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function request(port, path, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, timeout: 10000 },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("request timed out")); });
    req.end();
  });
}

async function waitReady(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "unknown";
  while (Date.now() < deadline) {
    try {
      const res = await request(port, "/api/attention/stats", "GET");
      if (res.status === 200) return;
      lastErr = `status ${res.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not become ready in ${timeoutMs}ms (last: ${lastErr})`);
}

// Minimal stub of kannaka-radio: answers /api/perception with an explicit
// tempo_bpm of 0 (the #27 edge case) and no other perception fields beyond
// valence/energy.
function startStubRadio() {
  // `state.idle` flips the stub to Radio's real IDLE payload — a byte-for-byte
  // copy of the initial value in kannaka-radio's server/perception.js. Every
  // field is PRESENT and zeroed, which is precisely why the #16 "no perception
  // fields" guard does not catch it. (#56)
  // `state.stateBody`, when set, is served from /api/state — the endpoint the
  // constellation surfaces poll to decide whether Radio is up. Null means 404,
  // i.e. radio unreachable, which is the default for every other test here.
  const state = { idle: false, stateBody: null };
  const IDLE = {
    mel_spectrogram: Array(128).fill(0),
    mfcc: Array(13).fill(0),
    tempo_bpm: 0,
    spectral_centroid: 0,
    rms_energy: 0,
    pitch: 0,
    valence: 0.5,
    status: "no_perception",
    track_info: null,
  };
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === "/api/perception") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(
          state.idle ? IDLE : { tempo_bpm: 0, valence: 0.5, rms_energy: 0.25 },
        ));
      } else if (req.url === "/api/state" && state.stateBody) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(state.stateBody));
      } else {
        res.writeHead(404);
        res.end("{}");
      }
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port, state }));
  });
}

async function main() {
  // ── #22: pure parser unit tests (no server needed) ──
  {
    const up = parseNatsUrl("nats://alice:secret@127.0.0.1:45229");
    check("#22 user:pass URL → user field", up.user === "alice", `got user=${JSON.stringify(up.user)}`);
    check("#22 user:pass URL → pass field", up.pass === "secret", `got pass=${JSON.stringify(up.pass)}`);
    check("#22 user:pass URL → no token", up.token === null, `got token=${JSON.stringify(up.token)}`);
    check("#22 user:pass URL → host/port", up.host === "127.0.0.1" && up.port === 45229, `got ${up.host}:${up.port}`);

    const tk = parseNatsUrl("nats://sometoken@host:4222");
    check("#22 token URL → token field", tk.token === "sometoken", `got token=${JSON.stringify(tk.token)}`);
    check("#22 token URL → no user/pass", tk.user === null && tk.pass === null, `got user=${tk.user} pass=${tk.pass}`);

    const plain = parseNatsUrl("nats://localhost:4222");
    check("#22 plain URL → no creds", plain.user === null && plain.token === null, `got user=${plain.user} token=${plain.token}`);
  }

  // ── #35: KANNAKA_NATS_URL is the constellation-wide setting ──
  //
  // The bridge read only the generic NATS_URL, so a box configured the
  // constellation way silently fell back to localhost:4222 and published
  // attention into a broker nobody was listening to.
  {
    check("#35 KANNAKA_NATS_URL is honoured",
      resolveNatsUrl({ KANNAKA_NATS_URL: "nats://broker:4222" }) === "nats://broker:4222");
    check("#35 KANNAKA_NATS_URL outranks the generic NATS_URL",
      resolveNatsUrl({ KANNAKA_NATS_URL: "nats://specific:4222", NATS_URL: "nats://generic:4222" }) === "nats://specific:4222",
      "the constellation-specific name must win, same rule as RADIO_PORT over PORT");
    check("#35 NATS_URL still works when KANNAKA_NATS_URL is unset",
      resolveNatsUrl({ NATS_URL: "nats://legacy:4222" }) === "nats://legacy:4222",
      "existing deployments must not break");
    check("#35 falls back to localhost when neither is set",
      resolveNatsUrl({}) === DEFAULT_NATS_URL);
    check("#35 blank/whitespace values do not shadow the next source",
      resolveNatsUrl({ KANNAKA_NATS_URL: "   ", NATS_URL: "nats://real:4222" }) === "nats://real:4222",
      "an empty env var is not a configured broker");
  }

  // ── #47: a fatal -ERR must drop the socket so a reconnect is scheduled ──
  //
  // Pre-fix, `-ERR` only logged. `_scheduleReconnect()` is reachable ONLY from
  // the socket 'close' handler, so a broker that rejected auth WITHOUT closing
  // the TCP connection stranded the bridge permanently: `_connected` never
  // went true, every later glyph was dropped, and nothing ever retried.
  {
    check("#47 authorization violation is classified fatal",
      isFatalNatsError("-ERR 'Authorization Violation'") === true);
    check("#47 permissions violation is classified NON-fatal",
      isFatalNatsError("-ERR 'Permissions Violation for Publish to KANNAKA.attention.eye'") === false,
      "tearing down on a per-subject permissions error would just reconnect-loop");

    // Fake broker that sends INFO then -ERR and then deliberately HOLDS the
    // socket open — the exact condition the bug needs.
    const held = [];
    const broker = net.createServer((sock) => {
      held.push(sock);
      sock.write("INFO {\"server_id\":\"fake\"}\r\n");
      sock.on("data", () => {});
      setTimeout(() => { try { sock.write("-ERR 'Authorization Violation'\r\n"); } catch { /* gone */ } }, 30);
      sock.on("error", () => {});
    });
    const bport = await new Promise((res) => broker.listen(0, "127.0.0.1", () => res(broker.address().port)));

    // Point this instance at the fake broker explicitly. attention-bridge.js
    // is CommonJS and reads NATS_URL once at module load, so setting the env
    // here and re-importing with a cache-busting query does NOT work: the CJS
    // require cache keys on the resolved path and ignores the query, handing
    // back the already-evaluated module still aimed at localhost:4222.
    const bridge = new AttentionBridge({ url: `nats://127.0.0.1:${bport}` });
    bridge.connect();

    await new Promise((r) => setTimeout(r, 400));

    const st = bridge.stats();
    check("#47 bridge is not left believing it is connected",
      st.connected === false, `stats=${JSON.stringify(st)}`);
    check("#47 a reconnect is actually scheduled after a fatal -ERR",
      st.reconnectPending === true,
      `nothing is retrying, so the link is permanently dead; stats=${JSON.stringify(st)}`);
    check("#47 the reason is reported, not just 'disconnected'",
      typeof st.lastError === "string" && st.lastError.includes("Authorization Violation"),
      `got lastError=${JSON.stringify(st.lastError)}`);
    check("#47 glyphs published while down are counted as dropped",
      bridge.publishGlyph({ foldSequence: [1], amplitudes: [1] }, "text") === false &&
      bridge.stats().dropped >= 1,
      `stats=${JSON.stringify(bridge.stats())}`);

    // Stop the 5s retry so the test process can exit promptly.
    if (bridge._reconnectTimer) clearTimeout(bridge._reconnectTimer);
    for (const s of held) { try { s.destroy(); } catch { /* ignore */ } }
    broker.close();
  }

  // ── #72: a write to a dead socket is not a delivery ──
  //
  // `_connected` is updated from the 'close' event, which lands a tick or more
  // after the socket is actually gone. Publishing in that window wrote to a
  // destroyed socket, did not throw, and counted as delivered — so stats
  // overstated delivery during exactly the reconnect churn that loses glyphs.
  {
    const glyph = { foldSequence: [1], amplitudes: [1], phases: [0] };

    const dead = new AttentionBridge({ url: "nats://127.0.0.1:1" });
    dead._connected = true; // stale flag: 'close' has not fired yet
    dead._client = { destroyed: true, writable: false, writes: [], write(d) { this.writes.push(d); return false; } };
    const deadOk = dead.publishGlyph(glyph, "text");
    check("#72 publishing to a destroyed socket returns false",
      deadOk === false, `got ${deadOk}`);
    check("#72 nothing is written to a destroyed socket",
      dead._client.writes.length === 0, `wrote ${dead._client.writes.length} frame(s)`);
    check("#72 the glyph is counted as dropped, not published",
      dead.stats().published === 0 && dead.stats().dropped === 1,
      `stats=${JSON.stringify(dead.stats())}`);
    check("#72 the stale connected flag is corrected on the spot",
      dead.stats().connected === false,
      "stats must not keep claiming connected once the socket is known dead");

    // The guard must not cost a healthy publish.
    const live = new AttentionBridge({ url: "nats://127.0.0.1:1" });
    live._connected = true;
    live._client = { destroyed: false, writable: true, writes: [], write(d) { this.writes.push(d); return true; } };
    check("#72 a live socket still publishes",
      live.publishGlyph(glyph, "text") === true && live.stats().published === 1,
      `stats=${JSON.stringify(live.stats())}`);
    check("#72 backpressure (write returning false) is not treated as a drop",
      (() => {
        const bp = new AttentionBridge({ url: "nats://127.0.0.1:1" });
        bp._connected = true;
        bp._client = { destroyed: false, writable: true, write() { return false; } };
        return bp.publishGlyph(glyph, "text") === true && bp.stats().dropped === 0;
      })(),
      "a false return means the frame is buffered for 'drain', not lost");
  }

  // ── #71: a publish the broker refuses is not a publish ──
  //
  // A permissions violation is non-fatal to the CONNECTION (#47) but standing
  // for the SUBJECT: every later PUB is refused too. The bridge kept
  // incrementing `published` anyway, so /api/attention/stats showed healthy
  // delivery while the broker accepted nothing.
  {
    const glyph = { foldSequence: [1], amplitudes: [1], phases: [0] };
    const socks = [];
    const broker = net.createServer((sock) => {
      socks.push(sock);
      sock.setEncoding("utf-8");
      sock.write("INFO {\"server_id\":\"deny\"}\r\n");
      sock.on("error", () => {});
      sock.on("data", (d) => {
        if (d.includes("PING")) sock.write("PONG\r\n");
        if (d.includes("PUB ")) sock.write("-ERR 'Permissions Violation for Publish to KANNAKA.attention.eye'\r\n");
      });
    });
    const bport = await new Promise((res) => broker.listen(0, "127.0.0.1", () => res(broker.address().port)));
    const bridge = new AttentionBridge({ url: `nats://127.0.0.1:${bport}` });
    bridge.connect();
    await new Promise((r) => setTimeout(r, 300));

    check("#71 the bridge connects before the denial",
      bridge.stats().connected === true, `stats=${JSON.stringify(bridge.stats())}`);
    bridge.publishGlyph(glyph, "text");
    await new Promise((r) => setTimeout(r, 300));

    const st = bridge.stats();
    check("#71 a refused publish is not counted as published",
      st.published === 0, `stats=${JSON.stringify(st)}`);
    check("#71 the refused glyph is counted as dropped",
      st.dropped === 1, `stats=${JSON.stringify(st)}`);
    check("#71 the standing denial is reported",
      st.publishDenied === true,
      `connected-but-refused must be distinguishable from delivering; stats=${JSON.stringify(st)}`);
    check("#71 later glyphs are dropped rather than optimistically counted",
      bridge.publishGlyph(glyph, "text") === false && bridge.stats().dropped === 2,
      `stats=${JSON.stringify(bridge.stats())}`);
    check("#71 the connection is NOT torn down — that would reconnect-loop",
      bridge.stats().connected === true, `stats=${JSON.stringify(bridge.stats())}`);

    if (bridge._reconnectTimer) clearTimeout(bridge._reconnectTimer);
    if (bridge._client) { try { bridge._client.destroy(); } catch { /* ignore */ } }
    for (const s of socks) { try { s.destroy(); } catch { /* ignore */ } }
    broker.close();
    await new Promise((r) => setTimeout(r, 50));
    if (bridge._reconnectTimer) clearTimeout(bridge._reconnectTimer);
  }

  const stub = await startStubRadio();
  const port = await getFreePort();
  const child = spawn(process.execPath, ["server.js", "--port", String(port)], {
    cwd: EYE_DIR,
    env: {
      ...process.env,
      KANNAKA_BIN: FAKE_BIN,           // native classifier configured but unusable
      EYE_PORT: "",
      NATS_URL: "nats://127.0.0.1:1",  // dead NATS; bridge stays silent
      RADIO_URL: `http://127.0.0.1:${stub.port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  child.stdout.on("data", (d) => (serverLog += d));
  child.stderr.on("data", (d) => (serverLog += d));

  try {
    await waitReady(port);

    // ── #21: constellation classifier is honest ──
    {
      const res = await request(port, "/api/constellation", "GET");
      const body = JSON.parse(res.body);
      check("#21 /api/constellation classifier is 'fallback' when native unusable",
        body.classifier === "fallback", `got ${JSON.stringify(body.classifier)}`);
    }

    // ── #48: the startup line must not claim a classifier it never checked ──
    //
    // This server was spawned with KANNAKA_BIN pointed at FAKE_BIN, which does
    // not exist — exactly the condition in the report. Pre-fix it printed
    // "[eye] Native classifier: <path>" unconditionally, so a typo'd env var
    // read as a working native setup in the logs.
    {
      check("#48 startup does not announce a native classifier that is absent",
        !/\[eye\] Native classifier: /.test(serverLog),
        `serverLog claimed a native classifier:\n${serverLog.slice(0, 300)}`);
      check("#48 startup warns that KANNAKA_BIN points at nothing",
        /KANNAKA_BIN is set to .* but no file exists there/.test(serverLog),
        `expected an explicit warning; got:\n${serverLog.slice(0, 300)}`);
      check("#48 the warning says why auto-detection did not rescue it",
        /Auto-detection is skipped/.test(serverLog),
        `the operator needs to know the explicit setting suppressed auto-detect`);
    }

    // ── #24: SVG does not light Memory without a verified probe ──
    {
      const res = await request(port, "/api/constellation.svg", "GET");
      const svg = res.body;
      check("#24 SVG omits Memory node label when native unverified",
        !svg.includes(">Memory<"), "SVG still contains a Memory label");
      check("#24 SVG status text marks memory UNVERIFIED (binary set, probe failed)",
        svg.includes("memory:UNVERIFIED"), `status text: ${(svg.match(/eye:ON[^<]*/) || [""])[0]}`);
    }

    // ── #26: large-file progress targets #canvasInfo, not #info-text ──
    {
      const res = await request(port, "/", "GET");
      const html = res.body;
      check("#26 page routes large-file progress to #canvasInfo",
        html.includes("getElementById('canvasInfo').textContent"),
        "no canvasInfo progress write found");

      // #37: a fallback-classified radio glyph must still carry the
      // resonance-ring layer. The test server has no usable native classifier,
      // so /api/radio necessarily takes the fallback branch — exactly the path
      // that used to return a glyph with no levelDistribution at all.
      {
        const r = await request(port, "/api/radio");
        if (r.status === 200) {
          const rb = JSON.parse(r.body);
          // Read defensively: when this regresses, levelDistribution is
          // ABSENT, and a test that throws on the missing field would abort
          // the whole suite instead of reporting a clean failure.
          const ld = rb.glyph && Array.isArray(rb.glyph.levelDistribution)
            ? rb.glyph.levelDistribution
            : null;
          check("#37 fallback radio glyph carries levelDistribution",
            ld !== null,
            `glyph keys=${JSON.stringify(rb.glyph && Object.keys(rb.glyph))}`);
          check("#37 levelDistribution has the 8 buckets the viewer renders",
            ld !== null && ld.length === 8,
            `len=${ld === null ? "absent" : ld.length}`);
          check("#37 levelDistribution is normalised to sum ~1",
            ld !== null && Math.abs(ld.reduce((s, v) => s + v, 0) - 1) < 1e-9,
            `sum=${ld === null ? "absent" : ld.reduce((s, v) => s + v, 0)}`);
          check("#37 the fallback branch is genuinely the one under test",
            rb.glyph && rb.glyph.classifier === "fallback",
            `classifier=${rb.glyph && rb.glyph.classifier}`);
        } else {
          check("#37 /api/radio reachable for levelDistribution check", false,
            `status=${r.status} body=${r.body.slice(0, 120)}`);
        }
      }

      // #56: Radio's IDLE payload must not become a glyph. When nothing is
      // playing, perception.js emits every field present but ZEROED with an
      // explicit status: "no_perception" — so the #16 "no perception fields"
      // guard sails past it and the eye rendered a confident glyph for
      // silence. Radio itself refuses to broadcast this payload over WS
      // (server/index.js), so the marker is an existing contract.
      {
        stub.state.idle = true;
        try {
          const r = await request(port, "/api/radio");
          const rb = (() => { try { return JSON.parse(r.body); } catch { return {}; } })();
          check("#56 idle radio does not return a glyph",
            !rb.glyph,
            `glyph=${JSON.stringify(rb.glyph && Object.keys(rb.glyph))}`);
          check("#56 idle radio is reported as idle, not as perception",
            rb.idle === true && rb.status === "no_perception",
            `idle=${rb.idle} status=${JSON.stringify(rb.status)}`);
          // Radio is healthy — it simply has nothing to perceive — so this is
          // not an upstream failure and must not be a 5xx.
          check("#56 idle is not reported as an upstream failure",
            r.status === 200,
            `status=${r.status}`);
          // The preset UI renders `error` and otherwise falls through to
          // classifying `radio.features`; without a message it would try to
          // classify undefined.
          check("#56 idle carries a human-readable message for the preset UI",
            typeof rb.error === "string" && rb.error.length > 0,
            `error=${JSON.stringify(rb.error)}`);
          check("#56 idle response carries no feature bytes",
            !Array.isArray(rb.features) || rb.features.length === 0,
            `featureCount=${Array.isArray(rb.features) ? rb.features.length : "absent"}`);
        } finally {
          stub.state.idle = false;
        }
      }

      // #38: one radio click must produce ONE attention publish. /api/radio
      // already classifies and publishes as "audio"; re-POSTing to
      // /api/process published the same listening event again as "bytes".
      check("#38 radio preset renders the glyph it was already given",
        html.includes("displayGlyph(radio.glyph)"),
        "radio preset should reuse the returned glyph, not re-classify");
      check("#38 radio preset does not unconditionally re-POST to /api/process",
        !/radio\.track \+ ' \(' \+ radio\.featureCount \+ ' features\)';\s*processInput\(/.test(html),
        "an unconditional processInput() after /api/radio double-publishes");
      check("#38 a null glyph still falls back to classifying locally",
        html.includes("processInput(radio.features, 'bytes')"),
        "the fallback must survive for when buildGlyphFromBytes returns null");

      // #43: class 0 is a real SGA class. `|| '—'` rendered it as "no data".
      // Asserted against served page source, same approach as #26 — there is
      // no browser harness in this repo.
      check("#43 dominantClass uses ?? so class 0 is not masked",
        html.includes("glyph.dominantClass ?? '—'"),
        "expected nullish coalescing for dominantClass");
      check("#43 dominantClass no longer uses || for its placeholder",
        !html.includes("glyph.dominantClass || '—'"),
        "|| masks a legitimate class 0 as an em dash");
      check("#26 page has no active #info-text null-deref call",
        !html.includes("getElementById('info-text').textContent"),
        "page still writes to a nonexistent #info-text element");
    }

    // ── #27: explicit tempo_bpm: 0 is preserved ──
    {
      const res = await request(port, "/api/radio", "GET");
      const body = JSON.parse(res.body);
      // features = [tempo(0), valence, rms] — tempo must be present.
      check("#27 /api/radio preserves tempo_bpm:0 (featureCount includes tempo)",
        body.featureCount === 3, `got featureCount=${body.featureCount}, features=${JSON.stringify(body.features)}`);
      check("#27 /api/radio emits the 0 tempo byte first",
        Array.isArray(body.features) && body.features[0] === 0,
        `features=${JSON.stringify(body.features)}`);
    }

    // ── #46: constellation surfaces must include the attention bridge ──
    //
    // The server under test has no NATS broker, so its bridge is down and
    // every glyph is being dropped. Pre-fix all three surfaces still looked
    // healthy, because none of them mentioned the bridge at all.
    {
      const res = await request(port, "/api/constellation");
      const body = JSON.parse(res.body);
      check("#46 /api/constellation includes attention state",
        body.attention !== undefined, `keys=${Object.keys(body).join(",")}`);
      check("#46 attention reports disconnected with no broker",
        body.attention && body.attention.connected === false,
        `attention=${JSON.stringify(body.attention)}`);
      check("#46 attention exposes the dropped counter",
        body.attention && typeof body.attention.dropped === "number",
        `attention=${JSON.stringify(body.attention)}`);
      check("#46 attention exposes retry state so a dead link is diagnosable",
        body.attention && "reconnectPending" in body.attention && "lastError" in body.attention,
        `attention=${JSON.stringify(body.attention)}`);

      // ── #41: memory gets its own object, not an inferred `classifier` ──
      check("#41 /api/constellation includes a memory object",
        body.memory !== undefined && typeof body.memory === "object",
        `keys=${Object.keys(body).join(",")}`);
      check("#41 memory reports unverified when a binary is set but unusable",
        body.memory && body.memory.status === "unverified" && body.memory.available === false,
        `memory=${JSON.stringify(body.memory)}`);
      check("#41 memory distinguishes 'configured' from 'usable'",
        body.memory && body.memory.binaryConfigured === true,
        `the test server sets KANNAKA_BIN to an unusable path; memory=${JSON.stringify(body.memory)}`);
      check("#41 classifier is retained for backwards compatibility",
        body.classifier === "fallback", `got classifier=${JSON.stringify(body.classifier)}`);

      const svg = await request(port, "/api/constellation.svg");
      check("#46 SVG status line reports attention",
        /attention:(ON|OFF)/.test(svg.body), `status line missing attention`);
      check("#46 SVG reports attention OFF when the bridge is down",
        /attention:OFF/.test(svg.body), `expected attention:OFF`);
      check("#46 SVG does not light an Attention node while disconnected",
        !svg.body.includes(">Attention<"),
        "a dark bridge must not render as an active constellation node");
    }

    // ── #64: radio's own "not running" beats our reachability inference ──
    //
    // #17 already stopped a non-2xx from reading as up. What remained is the
    // opposite direction: a healthy 200 whose BODY says the service is
    // stopped was still reported as running, because `running: true` was a
    // literal on the "we got JSON" branch.
    {
      stub.state.stateBody = { running: false, currentAlbum: "Nothing", playlist: [], currentTrackIdx: 0 };
      const body = JSON.parse((await request(port, "/api/constellation")).body);
      check("#64 an explicit running:false is not reported as running",
        body.radio && body.radio.running === false,
        `radio=${JSON.stringify(body.radio)}`);
      check("#64 reachable stays true — radio answered, it is just stopped",
        body.radio && body.radio.reachable === true,
        `reachable must distinguish "answered 200" from "is running"; radio=${JSON.stringify(body.radio)}`);
      const svgStopped = await request(port, "/api/constellation.svg");
      check("#64 SVG reports radio OFF for a stopped radio",
        /radio:OFF/.test(svgStopped.body), "status line still claims radio:ON");
      check("#64 SVG does not light a Radio node for a stopped radio",
        !svgStopped.body.includes(">Radio<"),
        "a stopped radio must not render as an active constellation node");

      // …and a radio that does not self-report is still trusted as running,
      // which is the shape kannaka-radio's real /api/state actually has.
      stub.state.stateBody = { currentAlbum: "Live", current: { title: "T" } };
      const up = JSON.parse((await request(port, "/api/constellation")).body);
      check("#64 a payload with no `running` field is still reported running",
        up.radio && up.radio.running === true && up.radio.reachable === true,
        `radio=${JSON.stringify(up.radio)}`);
      stub.state.stateBody = null;
    }

    // ── #68: no class decodes to an impossible h2 ──
    //
    // Both decoders aliased anything above 83 to 95, which decodes to h2=4 —
    // outside 0..3 in the eye's own 84-class space AND outside canonical's.
    // Twelve distinct ids became one impossible point. The native classifier
    // does emit those ids (canonical dominant_class 91 is in kannaka-memory's
    // reference vectors) and the served page decodes whatever /api/process
    // returns, so this is reachable, not theoretical.
    //
    // NOT under test: that 84..95 decode to twelve DISTINCT points. The eye's
    // 84-class JS decode is a deliberate divergence from canonical's 96-class
    // scheme — see the contract note at the top of sga_consistency.mjs.
    {
      const page = await request(port, "/");
      const src = page.body;
      const start = src.indexOf("function decodeClassIndexClient(");
      let depth = 0, entered = false, i = start;
      for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === "{") { depth++; entered = true; }
        else if (ch === "}") { depth--; if (entered && depth === 0) { i++; break; } }
      }
      const decode = eval(`(${src.slice(start, i).replace("function decodeClassIndexClient", "function")})`);
      const bad = [];
      for (let c = 0; c <= 95; c++) {
        const { h2, d, l } = decode(c);
        if (!(h2 >= 0 && h2 <= 3) || !(d >= 0 && d <= 2) || !(l >= 0 && l <= 6)) {
          bad.push(`${c}->{h2:${h2},d:${d},l:${l}}`);
        }
      }
      check("#68 every class 0..95 decodes inside the advertised ranges",
        bad.length === 0, `out of range: ${bad.slice(0, 5).join(" ")}`);
      check("#68 canonical class 91 no longer decodes to h2=4",
        decode(91).h2 === 3, `got ${JSON.stringify(decode(91))}`);
      check("#68 classes at or below 83 are untouched",
        decode(83).h2 === 3 && decode(83).d === 2 && decode(83).l === 6 && decode(27).h2 === 1,
        `83->${JSON.stringify(decode(83))} 27->${JSON.stringify(decode(27))}`);
      // The server-side twin is not reachable through any endpoint — the eye's
      // own classifier clamps to 83 before it ever decodes — so this one is
      // source-level. Comment lines are stripped first: the prose explaining
      // the fix names the old constant, and would otherwise satisfy itself.
      const serverCode = readFileSync(join(EYE_DIR, "server.js"), "utf8")
        .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      check("#68 the server-side decoder matches",
        !/classIndex\s*=\s*95/.test(serverCode),
        "server.js still aliases out-of-range classes to 95");
    }
  } catch (e) {
    console.error(`Fatal: ${e.message}`);
    console.error("--- server log ---\n" + serverLog);
    failed++;
  } finally {
    child.kill();
    stub.srv.close();
  }

  console.log("---");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`Fatal: ${e.message}`);
  process.exit(1);
});
