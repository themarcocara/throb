# Audio Throb Detector

Detects low-frequency rhythmic throb sounds (80–160 Hz) in audio recordings.
Designed for real-world use cases where the sound may be quiet, partially masked
by broadband noise, or recorded on low-gain devices.

Two interfaces share the same DSP engine (`src/dsp.js`):

- **Web app** — File analysis + 24/7 live microphone recording with IndexedDB storage
- **Node.js CLI** — File analysis with full feature parity, scriptable and composable

---

## Quick start

### Web app

Requires a local HTTP server (browser security blocks `fetch()` from `file://`):

```bash
npx serve . -l 8080
# then open http://localhost:8080
```

Or with Python:

```bash
python3 -m http.server 8080
```

### CLI

```bash
node cli/throb.js detect  recording.m4a
node cli/throb.js enhance recording.m4a --out enhanced.wav
node cli/throb.js analyze recording.m4a --out ./results --enhanced --encode --viz
```

Requires **Node.js ≥ 18** and **ffmpeg in PATH** (for decoding non-WAV formats
and optional M4A encoding).

---

## File structure

```
audio-throb-detector/
├── index.html          # Web app shell — HTML, CSS, loads src/ modules
├── src/
│   ├── dsp.js          # DSP engine: filters, detect(), enhance() — shared browser/Node
│   ├── worklet.js      # AudioWorklet processor for live recording
│   ├── app.js          # File analysis tab: worker boot, UI, results, download wiring
│   ├── idb.js          # IndexedDB helpers (5 stores)
│   ├── download.js     # Unified download: buildAndDownload(), buildZip(), exportM4a()
│   ├── recording.js    # Live recording: worklet comms, event log, enhance modal
│   └── viz.js          # Visualization modal + renderVizPlot()
├── cli/
│   └── throb.js        # Node.js CLI — feature parity with web file analysis tab
├── package.json        # v2.0.0, bin: throb → cli/throb.js
└── README.md
```

---

## CLI reference

### `detect` — run detection

```bash
node cli/throb.js detect <input> [options]
```

Prints detected BPM, strength, segments, and masking context to stdout.

```bash
# Human-readable output
node cli/throb.js detect recording.m4a

# JSON output (pipe-friendly)
node cli/throb.js detect recording.m4a --json

# JSON to file
node cli/throb.js detect recording.m4a --json --out timestamps.json

# Custom threshold and window
node cli/throb.js detect recording.m4a --threshold 0.35 --window 3.0
```

### `enhance` — produce enhanced audio

```bash
node cli/throb.js enhance <input> [options]
```

Applies the envelope-shaping enhancer and writes the result.

```bash
# WAV output (default)
node cli/throb.js enhance recording.m4a --out enhanced.wav

# M4A output via ffmpeg (requires ffmpeg in PATH)
node cli/throb.js enhance recording.m4a --encode --out enhanced.m4a
```

### `analyze` — full pipeline

```bash
node cli/throb.js analyze <input> [options]
```

Runs detection, optionally enhances audio, and writes all requested artifacts
to an output directory.

```bash
# All artifacts, M4A encoded
node cli/throb.js analyze recording.m4a \
  --out ./results \
  --enhanced \
  --encode \
  --viz

# Timestamps + raw WAV only
node cli/throb.js analyze recording.m4a --out ./results

# Quiet (suppress progress, useful in scripts)
node cli/throb.js analyze recording.m4a --out ./results --quiet
```

**Output files** (all prefixed with the input stem):

| File | Contents |
|------|----------|
| `*_timestamps.json` | Detected segments with ISO timestamps, BPM, masking context |
| `*_raw.wav` / `*_raw.m4a` | Unprocessed audio at 16 kHz (default included) |
| `*_enhanced.wav` / `*_enhanced.m4a` | Envelope-shaped, throb-boosted audio |
| `*_viz.json` | All numeric series for plot reconstruction (no spectrogram matrix) |
| `*_spectrogram.json` | Full spectrogram matrix (freq × time) — can be large |

### All options

| Option | Default | Description |
|--------|---------|-------------|
| `--out <path>` | auto | Output file (detect/enhance) or directory (analyze) |
| `--enhanced` | off | Include enhanced audio in analyze output |
| `--raw` | on | Include raw audio in analyze output |
| `--no-raw` | — | Suppress raw audio |
| `--encode` | off | Encode audio as M4A via ffmpeg |
| `--viz` | off | Write visualization JSON |
| `--threshold <n>` | `0.40` | Detection confidence threshold |
| `--window <s>` | `2.0` | Analysis window length in seconds |
| `--sr <hz>` | `16000` | Internal processing sample rate |
| `--no-enhance` | — | Skip enhancement step in analyze |
| `--quiet` | off | Suppress progress output to stderr |
| `--json` | off | Output results as JSON (detect mode) |

---

## Web app — File Analysis tab

1. Drag and drop or click to select any audio/video file
   (MP4, MOV, MKV, MP3, AAC, WAV, FLAC, OGG)
2. The Web Audio API decodes it to 16 kHz mono in the browser — no upload
3. A Web Worker runs `detect()` then `enhance()` off the main thread
4. Results show: detected segments, BPM, masking context
5. A three-panel Plotly diagnostic is rendered (spectrogram / confidence+strength / autocorrelation)

**Download options** (shown once audio is decoded):

- Raw audio ☐ / Enhanced audio ☐ / Encode as M4A ☐ / Visualization data ☐
- **Download Audio** — selected audio formats (auto-zipped if >1 file)
- **Download All (ZIP)** — timestamps JSON + audio + visualization

---

## Web app — Live Recording tab

For continuous 24/7 monitoring. Best on Android Chrome plugged into charger.

**Controls:**
- **Start Recording** — requests microphone access, initialises AudioWorklet
- **Stop** — stops mic and worklet
- **📸 Save 10s Now** — immediately saves the most recent 10 seconds
- **Auto-save every N minutes** toggle + spinner — periodic background snapshots

**Auto-saved snapshots:**

| Type | Timing | Length |
|------|--------|--------|
| `detection_start` | On confirmed detection | 15 s before detection |
| `throb_end` | After throb ends | 10 s before + 5 s after end |
| `periodic` | Configurable interval (default 30 min) | Most recent 10 s |
| `manual` | On demand | Most recent 10 s |

**Audio log:**
- Per-row: ▶ Play (with enhance preview), 📊 Visualization, ⬇ Download, 🗑 Delete
- Bulk: select checkboxes → Save Selected WAV / Delete Selected / Wipe All
- Storage usage bar with persistent-storage indicator

**Platform notes:**
- Android Chrome: AudioContext continues running with screen off; WakeLock keeps
  screen dim-on. Reliable for 24/7 use on a charger.
- iOS Safari: AudioContext suspends on screen lock. A warning banner is shown.
  Foreground-only monitoring is possible while the screen is on.

---

## DSP methodology

### Detection — `detect(audio, sr, params)`

**Filter bank (Butterworth 4th-order SOS, all at 16 kHz):**

| Band | Range | Purpose |
|------|-------|---------|
| Throb | 80–160 Hz | Primary signal band |
| Ref | 300–380 Hz | Same-bandwidth noise reference |
| Mid | 300–1000 Hz | Broadband noise estimator |

**Per-window pipeline (default: 2 s window, 0.5 s hop):**

1. Bandpass filter → 20 ms RMS envelope extraction
2. FFT autocorrelation on envelope
3. Find peak AC value in rhythm range (0.3–3.5 s period = 17–200 BPM)
4. Compute masking indicators (see below)
5. `confidence = AC_peak × (1 − masking_factor × 0.7)`

**Masking model — two independent indicators:**

`masking_factor` — confidence penalty. Scaled `(mid_rms/throb_rms − 2.0) / 8.0`.
Only fires when mid-band noise exceeds 2× throb-band level (severe broadband
noise). Amplitude-invariant — the ratio is stable regardless of input gain.

`context_masked` — per-window binary flag. Set when `mid_rms > throb_rms`.
Fires under typical white-noise masking even when confidence is unaffected
(because autocorrelation survives broadband masking). Used for context
logging only — does not penalise confidence.

**Detection:** 3 consecutive windows ≥ threshold → confirmed. Masking context
(`masking_detected`, `throb_predates_mask`, etc.) computed from pre-detection
window history.

**Tuned parameters (calibrated across 3 recordings, 2 devices, 1 with masking):**

| Parameter | Value | Reason |
|-----------|-------|--------|
| `windowSec` | 2.0 s | ≥3 cycles at 100 BPM |
| `hopSec` | 0.5 s | 500 ms update rate |
| `threshold` | 0.40 | Calibrated to quieter device (111× lower amplitude) |
| `rhythmMin` | 0.3 s | Allows up to 200 BPM |
| `rhythmMax` | 3.5 s | Allows down to ~17 BPM |
| Masking scale | 2×–10× | Amplitude-invariant, only penalises severe noise |

### Enhancement — `enhance(audio, sr)`

Envelope-shaping approach — boosts periodic throb while suppressing aperiodic
noise. Does not amplify the masking noise itself.

1. Highpass 40 Hz (remove DC / infrasound)
2. Bandpass 80–160 Hz (isolate throb band)
3. 20 ms smoothed envelope extraction
4. Spectral gate: sigmoid suppression below 20th-percentile noise floor
5. Crest enhancer: `envelope^1.4` (sharpens peaks relative to troughs)
6. Reconstruct: shaped envelope × carrier
7. Blend: 65% shaped + 35% HP/LP filtered original
8. Peak-normalise to 0.5 → soft limiter tanh @ 0.95

Result: crest factor ~10 (natural), mid-band noise not amplified.

---

## Storage (web app recording)

**IndexedDB schema** — DB: `throb_detector_v1` v1:

| Store | Key | Contents |
|-------|-----|----------|
| `events` | auto id | Full detection record: timestamps, BPM, masking context, `audio_id`, `viz_id` |
| `audio` | auto id | WAV blob ~480 KB per 25 s clip, linked to event |
| `viz_data` | auto id | All numeric series for plot reconstruction + spectrogram matrix |
| `sessions` | session_id | Session metadata + platform |
| `heartbeats` | auto id | 30 s uptime pings for liveness monitoring |

**Capacity:** At 10 detections/day with 25 s clips, ~5 MB/day, ~150 MB/month.
Android Chrome quota is typically 50% of free disk space.

**Persistence:** `navigator.storage.persist()` is requested on recording start.
On Android Chrome this prevents LRU eviction. On iOS, storage may be evicted
under memory pressure regardless.

---

## Supported input formats (CLI)

Any format ffmpeg can decode: MP3, AAC, M4A, WAV, FLAC, OGG, MP4, MOV, MKV,
AIFF, WMA, and many others.

## Supported input formats (web app)

Any format the browser's Web Audio API can decode: MP3, AAC, M4A, WAV, FLAC,
OGG. MP4/MOV/MKV video files are also accepted (audio track is extracted).
