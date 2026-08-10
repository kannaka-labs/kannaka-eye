/**
 * attention-bridge.js — kannaka-eye NATS publisher.
 *
 * Emits `KANNAKA.attention.eye` messages on every classified glyph so the
 * kannaka-attention beam (and any other downstream subscriber) sees a fresh
 * gravity event each time the eye processes input.
 *
 * Plural chiral mirror: each eye process declares a hemisphere — "left" or
 * "right" — via the KANNAKA_EYE_HEMISPHERE env var. Run two instances
 * (KANNAKA_EYE_HEMISPHERE=left on port 3333, =right on 3334) to get the
 * mirror pair. Subscribers can fold both into the same beam, or treat them
 * as separate attention sources.
 *
 * No npm deps — uses raw NATS TCP protocol (PING/PONG + PUB), the same
 * pattern kannaka-radio's nats-client.js uses. Connection is best-effort:
 * a missing NATS server doesn't break HTTP glyph serving.
 */

"use strict";

const net = require("net");

const DEFAULT_NATS_URL = "nats://localhost:4222";

/**
 * Resolve the broker URL from the environment.
 *
 * KANNAKA_NATS_URL is the constellation-wide setting (kannaka-memory resolves
 * it in ask.rs / identity.rs). The eye read only the generic NATS_URL, so on a
 * box configured the constellation way it silently fell back to localhost:4222
 * and published attention into a broker nobody was listening to. The specific
 * name wins over the generic one — same rule as RADIO_PORT over PORT. (#35)
 *
 * Pure and exported so the precedence is testable without re-importing this
 * module: it is CommonJS, so env read at load cannot be refreshed by an
 * `import(...?bust=N)` — the CJS require cache ignores the query string.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function resolveNatsUrl(env = process.env) {
  const pick = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  return pick(env.KANNAKA_NATS_URL) || pick(env.NATS_URL) || DEFAULT_NATS_URL;
}

const NATS_URL = resolveNatsUrl();
const NATS_TOKEN = process.env.NATS_TOKEN || null;
// Oracle NATS uses user/password authz (the kannaka_internal account). The
// KANNAKA.attention.eye subject is not in anon's publish allow-list, so the
// eye must authenticate to emit glyphs.
const NATS_USER = process.env.NATS_USER || null;
const NATS_PASSWORD = process.env.NATS_PASSWORD || null;
const HEMISPHERE = (process.env.KANNAKA_EYE_HEMISPHERE || "left").toLowerCase();
const SUBJECT = "KANNAKA.attention.eye";
const SOURCE_NAME = `kannaka-eye:${HEMISPHERE}`;

function parseNatsUrl(u) {
  // nats://[user:pass@ | token@]host[:port]
  // A credential containing ':' is username/password (NATS authz — the
  // kannaka_internal account uses this); a bare credential is a token.
  // Pre-fix the whole credential was returned as `token`, so a standard
  // `nats://user:pass@host` URL was sent as auth_token and never authed. (#22)
  const m = u.match(/^nats:\/\/(?:([^@]+)@)?([^:/]+)(?::(\d+))?/i);
  if (!m) return { host: "localhost", port: 4222, user: null, pass: null, token: null };
  const cred = m[1] || null;
  let user = null, pass = null, token = null;
  if (cred != null) {
    const ci = cred.indexOf(":");
    if (ci >= 0) { user = cred.slice(0, ci); pass = cred.slice(ci + 1); }
    else { token = cred; }
  }
  return {
    host: m[2] || "localhost",
    port: m[3] ? parseInt(m[3], 10) : 4222,
    user,
    pass,
    token,
  };
}

/**
 * NATS `-ERR` lines that leave the connection usable.
 *
 * Per the NATS protocol most `-ERR`s are fatal and the server closes the
 * socket, but a permissions violation (or an invalid subject) is scoped to the
 * offending operation — the connection stays up and is still good for other
 * subjects. Tearing down on those would produce a pointless reconnect loop.
 */
const NON_FATAL_ERR = /permissions violation|invalid subject/i;

/**
 * A non-fatal `-ERR` that nonetheless means our publishes are being refused.
 *
 * Non-fatal only describes the CONNECTION; the eye is publish-only, so a
 * standing publish denial makes that connection useless to us even though the
 * socket stays up.
 */
const PUBLISH_DENIED_ERR = /permissions violation for publish/i;

/** @returns {boolean} true when this `-ERR` should cost us the connection. */
function isFatalNatsError(line) {
  return !NON_FATAL_ERR.test(line);
}

class AttentionBridge {
  /**
   * @param {object} [opts]
   * @param {string} [opts.url] Broker URL override. Defaults to NATS_URL.
   *   Module-level env is read once at load, and this file is CommonJS — so a
   *   test cannot re-read it by re-importing with a cache-busting query (the
   *   CJS require cache keys on the resolved path and ignores the query).
   *   An explicit override is the honest way to point an instance somewhere
   *   else; production passes nothing and behaves exactly as before.
   */
  constructor(opts = {}) {
    this._url = opts.url || NATS_URL;
    this._client = null;
    this._connected = false;
    this._buffer = "";
    this._reconnectTimer = null;
    this._published = 0;
    this._dropped = 0;
    this._lastError = null;
    // Set when the broker refuses publishes to SUBJECT. NATS has no per-message
    // ack, so `_published` is necessarily optimistic — but a publish-permission
    // denial is not per-message, it is standing: every subsequent PUB to this
    // subject will be refused too. Once we have seen one there is no longer any
    // basis for calling a write a delivery. Cleared on reconnect. (#71)
    this._publishDenied = false;
  }

  connect() {
    // A reconnect may land on a broker with different authz, so the standing
    // denial does not survive it.
    this._publishDenied = false;
    const parsed = parseNatsUrl(this._url);
    const { host, port } = parsed;
    // Auth precedence (#22): explicit env vars win, then credentials embedded
    // in NATS_URL. user/pass (if present) takes precedence over a token so a
    // `nats://user:pass@host` URL authenticates instead of being sent as a
    // bare token.
    let user = null, pass = null, authToken = null;
    if (NATS_USER) { user = NATS_USER; pass = NATS_PASSWORD || ""; }
    else if (parsed.user) { user = parsed.user; pass = parsed.pass || ""; }
    if (NATS_TOKEN) authToken = NATS_TOKEN;
    else if (!user && parsed.token) authToken = parsed.token;
    const authMode = user ? "user" : authToken ? "token" : "none";
    const sock = net.createConnection({ host, port }, () => {
      // Wait for INFO before sending CONNECT (per NATS protocol).
    });
    sock.setEncoding("utf-8");
    sock.on("data", (chunk) => {
      this._buffer += chunk;
      const lines = this._buffer.split("\r\n");
      this._buffer = lines.pop();
      for (const line of lines) {
        // A fatal -ERR destroyed the socket earlier in this same chunk; the
        // remaining lines belong to a connection that no longer exists, and
        // writing a PONG to a destroyed socket just raises another error.
        if (this._client !== sock) break;
        if (line.startsWith("INFO ")) {
          // Send CONNECT — minimal, no subscriptions needed (publish-only).
          const connect = { verbose: false, pedantic: false, lang: "node-raw", name: SOURCE_NAME, protocol: 1 };
          // user/pass and token are mutually exclusive auth modes; prefer
          // user/pass when we have it.
          if (user) { connect.user = user; connect.pass = pass; }
          else if (authToken) connect.auth_token = authToken;
          sock.write(`CONNECT ${JSON.stringify(connect)}\r\n`);
          // Send PING to test the connection.
          sock.write("PING\r\n");
        } else if (line === "PONG") {
          if (!this._connected) {
            this._connected = true;
            console.log(`[attention-bridge] connected to ${host}:${port} (hemisphere=${HEMISPHERE}, auth=${authMode})`);
          }
        } else if (line === "PING") {
          sock.write("PONG\r\n");
        } else if (line.startsWith("-ERR")) {
          this._lastError = line;
          if (isFatalNatsError(line)) {
            // Pre-fix this only logged. `_scheduleReconnect()` is reachable
            // ONLY from the socket 'close' handler, so an -ERR the broker did
            // not follow with a close — an auth rejection that leaves the TCP
            // connection open — stranded the bridge forever: `_connected`
            // never went true, every later glyph was dropped, and
            // /api/attention/stats reported disconnected with nothing
            // retrying. Destroy explicitly so 'close' fires and the existing
            // 5s backoff takes over. (#47)
            console.warn(`[attention-bridge] fatal NATS error, dropping connection to retry: ${line}`);
            this._connected = false;
            this._client = null;
            try { sock.destroy(); } catch (_) { /* already gone */ }
            break;
          }
          // Non-fatal: scoped to the offending operation, connection stays
          // usable. Reconnecting here would loop without fixing anything.
          console.warn(`[attention-bridge] NATS error: ${line}`);
          // …but if the refused operation is publishing to OUR subject, the
          // connection being usable is cold comfort: the eye's only reason to
          // hold it is gone. This -ERR is the broker's response to the PUB we
          // just counted as delivered, so reconcile that count and stop
          // claiming delivery until a reconnect proves otherwise. Pre-fix
          // /api/attention/stats showed a rising `published` while the broker
          // refused every single glyph. (#71)
          if (PUBLISH_DENIED_ERR.test(line) && !this._publishDenied) {
            this._publishDenied = true;
            console.warn("[attention-bridge] broker refuses publishes to " +
              `${SUBJECT} — counting glyphs as dropped until reconnect`);
            if (this._published > 0) { this._published--; this._dropped++; }
          }
        }
      }
    });
    sock.on("error", (e) => {
      if (this._connected) console.warn(`[attention-bridge] socket error: ${e.message}`);
      this._connected = false;
    });
    sock.on("close", () => {
      this._connected = false;
      this._client = null;
      this._scheduleReconnect();
    });
    this._client = sock;
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  /**
   * Publish a glyph event. Best-effort: returns true on send, false if
   * disconnected. The HTTP path keeps working regardless.
   *
   * @param {object} glyph  Output of /api/process (foldSequence, amplitudes, ...)
   * @param {string} sourceType "text" | "bytes" | "numbers"
   */
  publishGlyph(glyph, sourceType) {
    const sock = this._client;
    // `_connected` is a CACHED flag updated from the 'close' event, and that
    // event lands a tick or more after the socket is actually gone. During a
    // reconnect window the flag still said connected, write() on the dead
    // socket did not throw, and the glyph was counted as delivered — so
    // /api/attention/stats overstated delivery exactly when transport churn
    // made it matter. Ask the socket, not the cache. (#72)
    if (!this._connected || !sock || sock.destroyed || sock.writable === false) {
      // Correct the stale flag rather than waiting for 'close', so stats read
      // true immediately and the reconnect path is not delayed.
      if (sock && (sock.destroyed || sock.writable === false)) this._connected = false;
      this._dropped++;
      return false;
    }
    if (this._publishDenied) {
      this._dropped++;
      return false;
    }
    // Canonical envelope per consciousness-core/docs/nats-contract.yaml:
    //   schema_version: "1.0" (string)
    //   ts:             unix-ms (number)
    //   agent_id:       publisher identity
    // Pre-fix the eye emitted schema_version: 1 + ISO ts, forcing every
    // downstream consumer to special-case the eye instead of treating
    // it as a normal constellation producer. (#5)
    const envelope = {
      schema_version: "1.0",
      ts: Date.now(),
      agent_id: process.env.EYE_AGENT_ID || "kannaka-eye",
      source: SOURCE_NAME,
      hemisphere: HEMISPHERE,
      source_type: sourceType || glyph.sourceType || "unknown",
      glyph: {
        fold_sequence: glyph.foldSequence,
        amplitudes: glyph.amplitudes,
        phases: glyph.phases,
        fano_signature: glyph.fanoSignature,
        centroid: glyph.centroid,
        dominant_class: glyph.dominantClass,
        classes_used: glyph.classesUsed,
        total_energy: glyph.totalEnergy,
        compression_ratio: glyph.compressionRatio,
        classifier: glyph.classifier,
      },
    };
    const payload = JSON.stringify(envelope);
    const payloadBytes = Buffer.byteLength(payload, "utf-8");
    try {
      // A `false` return is BACKPRESSURE, not failure — the frame is buffered
      // and will flush on 'drain'. Treating it as a drop would invent losses on
      // any large payload, so the liveness check above is what guards delivery.
      sock.write(`PUB ${SUBJECT} ${payloadBytes}\r\n${payload}\r\n`);
      this._published++;
      return true;
    } catch (e) {
      console.warn(`[attention-bridge] publish failed: ${e.message}`);
      return false;
    }
  }

  stats() {
    return {
      connected: this._connected,
      hemisphere: HEMISPHERE,
      published: this._published,
      dropped: this._dropped,
      // Last -ERR seen from the broker, so a bridge that is down for an
      // auth/permissions reason says WHY rather than just "connected: false".
      lastError: this._lastError,
      reconnectPending: this._reconnectTimer != null,
      // Connected but refused: the socket is up and `connected` is true, yet
      // every glyph is being dropped at the broker. Without this the two look
      // identical from outside. (#71)
      publishDenied: this._publishDenied,
    };
  }
}

module.exports = { AttentionBridge, HEMISPHERE, SUBJECT, parseNatsUrl, isFatalNatsError, resolveNatsUrl, DEFAULT_NATS_URL };
