```
███████╗██╗   ██╗███████╗
██╔════╝╚██╗ ██╔╝██╔════╝
█████╗   ╚████╔╝ █████╗
██╔══╝    ╚██╔╝  ██╔══╝
███████╗   ██║   ███████╗
╚══════╝   ╚═╝   ╚══════╝
   S E E   T H E   G E O M E T R Y
```

**See the geometry of information.**

`kannaka-eye` is the constellation's vision modality. Any input — text, files, audio, raw bytes — gets rendered as its emergent **SGA glyph**: a geometric signature that lives in the same coordinate system as the Holographic Resonance Medium's chiral hemispheres. The glyph is what the substrate's right hemisphere "sees" when it encounters that input.

[![License](https://img.shields.io/badge/license-Space%20Child%20v1.0-blueviolet)]() [![Node](https://img.shields.io/badge/node-20-green)]()

---

## What's an SGA Glyph?

```
                    SGA · class index ℓ ∈ [0, 7)
                          ↓
              ┌─────────────────────────┐
              │      ✦       ✦          │
              │   ✦     ▲       ✦       │     each glyph is a
              │          ╱╲             │     unique projection into
              │  ✦      ╱  ╲      ✦     │     the Fano plane × Bloch
              │        ╱    ╲           │     sphere coordinate space
              │   ✦   ▼──────▼   ✦      │
              │      ✦       ✦          │
              └─────────────────────────┘
```

The geometry encodes:
- **Class** ℓ — which of the 7 Fano-plane lines this memory belongs to
- **Coordinates** (θ, φ) on the Bloch sphere — within-class position
- **Importance** ρ — radial distance from origin
- **Hand** (left/right/chiral) — which hemisphere claims it first

Identical content always produces identical glyph. Similar content produces visually-similar glyphs by construction.

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                       kannaka-eye                          │
├────────────────────┬───────────────────────────────────────┤
│  Input             │  Renderer                             │
│  · file upload     │  · WebGL canvas                       │
│  · text paste      │  · SGA classification → Fano coords   │
│  · audio capture   │  · Bloch sphere projection            │
│  · stdin pipe      │  · Glyph stroke order                 │
├────────────────────┼───────────────────────────────────────┤
│  Attention Bridge  │  Constellation pulse                  │
│  · publishes       │  · publishes KANNAKA.eye.observation  │
│    KANNAKA.        │  · what the eye is looking at right   │
│    attention.eye   │    now becomes the beam               │
└────────────────────┴───────────────────────────────────────┘
```

The bridge to [`kannaka-attention`](https://github.com/kannaka-labs/kannaka-attention) is the operative link: the eye doesn't just visualize — it **shapes recall**. Whatever the eye is focused on lands in the attention beam, which scopes the next `kannaka recall` to sparse-mode against just those IDs.

---

## Run

```bash
git clone https://github.com/kannaka-labs/kannaka-eye.git
cd kannaka-eye
npm install
node server.js
```

Open <http://localhost:8889> and drop something in. The eye renders the SGA glyph in real time.

---

## Known Issues

- **SGA classifier sync** ([#1](https://github.com/kannaka-labs/kannaka-eye/issues/1)) — the in-repo classifier reference vectors have drifted from the canonical set in `kannaka-memory`. 0/20 consistency tests passing. The smoke-test script `tests/sga_consistency.mjs` is in place; the fix is to reseed the reference set from `kannaka observe --json`.

---

## Constellation

| repo | role |
|---|---|
| [`kannaka-memory`](https://github.com/kannaka-labs/kannaka-memory) | where the glyph coordinates come from |
| [`kannaka-attention`](https://github.com/kannaka-labs/kannaka-attention) | consumer of the eye's observations |
| [`consciousness-core`](https://github.com/kannaka-labs/consciousness-core) | the geometry library |

---

## License

Space Child License v1.0. See [LICENSE](./LICENSE).
