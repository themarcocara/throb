#!/usr/bin/env node
/**
 * throb.js — Audio Throb Detector CLI
 *
 * Feature parity with the web app's File Analysis tab:
 *   detect    Run detection and print results
 *   enhance   Enhance audio (envelope-shaped throb boost)
 *   analyze   Detect + enhance + output all artifacts
 *
 * Usage:
 *   node cli/throb.js detect  <input.{wav,mp3,m4a,mp4,...}>
 *   node cli/throb.js enhance <input> [--out <output.wav>]
 *   node cli/throb.js analyze <input> [options]
 *
 * Options:
 *   --out <path>          Output file path (detect: JSON, enhance: WAV/M4A,
 *                         analyze: directory for all artifacts)
 *   --enhanced            Include enhanced audio (analyze mode)
 *   --raw                 Include raw audio (analyze mode, default: true)
 *   --encode              Encode audio as M4A via ffmpeg (requires ffmpeg in PATH)
 *   --viz                 Write visualization data JSON
 *   --threshold <n>       Confidence threshold (default 0.40)
 *   --window <s>          Analysis window seconds (default 2.0)
 *   --no-enhance          Skip enhancement in analyze mode
 *   --sr <hz>             Sample rate for internal processing (default 16000)
 *   --quiet               Suppress progress output
 *   --json                Output results as JSON (detect mode)
 *
 * Examples:
 *   node cli/throb.js detect audio.m4a
 *   node cli/throb.js detect audio.m4a --json > results.json
 *   node cli/throb.js enhance audio.wav --out enhanced.wav
 *   node cli/throb.js enhance audio.wav --encode --out enhanced.m4a
 *   node cli/throb.js analyze audio.mp4 --out ./results --enhanced --encode --viz
 *
 * Requirements:
 *   Node.js >= 18  (for Web Streams, fetch, structuredClone)
 *   ffmpeg in PATH (for decoding non-WAV formats and M4A encoding)
 */

'use strict';

const fs    = require('fs');
const path  = require('path');
const cp    = require('child_process');
const os    = require('os');

// ── Load DSP engine ───────────────────────────────────────────────────────────
// src/dsp.js was written for both browser Workers and Node.js.
// We evaluate it in this module's scope via a thin shim.
const DSP_PATH = path.join(__dirname, '..', 'src', 'dsp.js');
if (!fs.existsSync(DSP_PATH)) {
    console.error('Error: src/dsp.js not found. Run from the project root.');
    process.exit(1);
}
// The DSP file uses `self.onmessage = ...` at the end (Worker message handler).
// Provide a stub so it doesn't throw.
global.self = { onmessage: null };
const vm = require('vm');
vm.runInThisContext(fs.readFileSync(DSP_PATH, 'utf8').replace('"use strict";', ''));
// detect(), enhance(), bandpassFilter() etc. are now in global scope.

// ── CLI argument parsing ──────────────────────────────────────────────────────
const args = process.argv.slice(2);

function usage() {
    console.log(`
Usage: node cli/throb.js <command> <input> [options]

Commands:
  detect   Run detection only — print/output timestamps and masking context
  enhance  Produce enhanced audio only
  analyze  Full pipeline: detect + enhance + all requested artifacts

Options:
  --out <path>       Output file or directory
  --enhanced         Include enhanced audio (analyze mode)
  --raw              Include raw audio in analyze output (default true)
  --encode           Encode audio as M4A via ffmpeg
  --viz              Write visualization data as JSON
  --threshold <n>    Detection confidence threshold  [default: 0.40]
  --window <s>       Analysis window seconds         [default: 2.0]
  --sr <hz>          Internal sample rate            [default: 16000]
  --quiet            Suppress progress messages
  --json             Print results as JSON (detect mode)
`.trim());
}

if (args.length < 2 || args[0] === '--help' || args[0] === '-h') { usage(); process.exit(0); }

const cmd       = args[0];
const inputFile = args[1];

const opts = {
    out:       getArg('--out'),
    enhanced:  hasFlag('--enhanced'),
    raw:       !hasFlag('--no-raw'),
    encode:    hasFlag('--encode'),
    viz:       hasFlag('--viz'),
    noEnhance: hasFlag('--no-enhance'),
    quiet:     hasFlag('--quiet'),
    json:      hasFlag('--json'),
    threshold: parseFloat(getArg('--threshold') || '0.40'),
    windowSec: parseFloat(getArg('--window')    || '2.0'),
    sr:        parseInt(  getArg('--sr')         || '16000'),
};

function hasFlag(f)    { return args.includes(f); }
function getArg(f)     { const i = args.indexOf(f); return i >= 0 ? args[i+1] : null; }
function log(...a)     { if (!opts.quiet) console.error(...a); }
function die(msg)      { console.error('Error:', msg); process.exit(1); }

if (!fs.existsSync(inputFile)) die(`File not found: ${inputFile}`);
if (!['detect','enhance','analyze'].includes(cmd)) die(`Unknown command: ${cmd}`);

// ── Audio decoding via ffmpeg ─────────────────────────────────────────────────
function which(bin) {
    try { cp.execSync(`which ${bin}`, {stdio:'pipe'}); return true; }
    catch { return false; }
}

function decodeToFloat32(inputPath, sr) {
    if (!which('ffmpeg')) die('ffmpeg not found in PATH. Install ffmpeg to decode audio files.');
    const tmp = path.join(os.tmpdir(), `throb_${Date.now()}.raw`);
    log(`Decoding ${path.basename(inputPath)} → ${sr} Hz mono…`);
    try {
        cp.execSync(
            `ffmpeg -y -i "${inputPath}" -ar ${sr} -ac 1 -f f32le "${tmp}"`,
            { stdio: ['ignore','ignore','ignore'] }
        );
        const buf = fs.readFileSync(tmp);
        fs.unlinkSync(tmp);
        return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    } catch(e) {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        die(`ffmpeg decoding failed for ${inputPath}: ${e.message}`);
    }
}

// ── WAV encoder ───────────────────────────────────────────────────────────────
function float32ToWav(samples, sr) {
    const n   = samples.length;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0);  buf.writeUInt32LE(36 + n*2, 4);
    buf.write('WAVE', 8);  buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr*2, 28);
    buf.writeUInt16LE(2, 32);  buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n*2, 40);
    for (let i = 0; i < n; i++)
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i*2);
    return buf;
}

// ── M4A encoding via ffmpeg ───────────────────────────────────────────────────
function encodeToM4A(wavPath, outPath) {
    if (!which('ffmpeg')) die('ffmpeg not found. Cannot encode M4A.');
    log(`Encoding M4A: ${path.basename(outPath)}…`);
    cp.execSync(
        `ffmpeg -y -i "${wavPath}" -ar 44100 -ac 2 -c:a aac -q:a 0 -movflags +faststart "${outPath}"`,
        { stdio: ['ignore','ignore','ignore'] }
    );
}

// ── Visualization data builder ────────────────────────────────────────────────
function buildVizData(result, wallClockMs, reason) {
    const r = result;
    return {
        wall_clock_iso:    new Date(wallClockMs).toISOString(),
        wall_clock_ms:     wallClockMs,
        reason,
        sr:                opts.sr,
        duration:          r.duration,
        detected:          r.detected,
        detected_at:       r.detected_at,
        bpm:               r.bpm,
        strength:          r.strength,
        threshold:         r.threshold,
        segments:          r.segments,
        times:             Array.from(r.times           || []),
        strengths:         Array.from(r.strengths       || []),
        confidences:       Array.from(r.confidences     || []),
        masking_factors:   Array.from(r.masking_factors || []),
        context_masked_arr:Array.from(r.context_masked_arr || []),
        corrFull:          Array.from(r.corrFull        || []),
        masking_detected:       r.masking_detected,
        masking_duration_s:     r.masking_duration_s,
        mask_end_estimate:      r.mask_end_estimate,
        throb_predates_mask:    r.throb_predates_mask,
        mean_ac_while_masked:   r.mean_ac_while_masked,
        peak_masking_ratio:     r.peak_masking_ratio,
        detection_method:       r.detection_method,
        // Spectrogram: full matrix (can be large — stored for plot reconstruction)
        spec_freqs: r.spectrogram ? r.spectrogram.freqs : [],
        spec_times: r.spectrogram ? r.spectrogram.times : [],
        spec_z:     r.spectrogram ? r.spectrogram.z     : [],
        spec_zmin:  r.spectrogram ? r.spectrogram.zmin  : -80,
        spec_zmax:  r.spectrogram ? r.spectrogram.zmax  : -10,
    };
}

// ── Timestamp JSON builder ────────────────────────────────────────────────────
function buildTimestampsJson(result, inputPath) {
    const stat    = fs.statSync(inputPath);
    const baseMs  = stat.mtimeMs;
    return {
        file:              path.basename(inputPath),
        detected:          result.detected,
        detected_at_s:     result.detected_at,
        bpm:               +result.bpm.toFixed(1),
        strength:          +result.strength.toFixed(4),
        threshold:         result.threshold,
        duration_s:        +result.duration.toFixed(3),
        detection_method:  result.detection_method,
        masking_detected:  result.masking_detected,
        masking_duration_s:result.masking_duration_s,
        mask_end_estimate: result.mask_end_estimate,
        throb_predates_mask:result.throb_predates_mask,
        mean_ac_while_masked:result.mean_ac_while_masked,
        peak_masking_ratio:+result.peak_masking_ratio.toFixed(4),
        masked_snr_at_detection:+result.masked_snr_at_detection.toFixed(3),
        segments: result.segments.map((seg, i) => ({
            index:           i + 1,
            start_seconds:   +seg.start.toFixed(3),
            end_seconds:     +seg.end.toFixed(3),
            start_iso:       new Date(baseMs + seg.start * 1000).toISOString(),
            end_iso:         new Date(baseMs + seg.end   * 1000).toISOString(),
            duration_seconds:+(seg.end - seg.start).toFixed(3),
            bpm:             +seg.bpm.toFixed(1),
        })),
    };
}

// ── Human-readable result printer ─────────────────────────────────────────────
function printResult(result, inputPath) {
    const r   = result;
    const sym = r.detected ? '✓' : '✗';
    console.log(`\n${sym} ${path.basename(inputPath)}`);
    console.log(`  Duration:   ${r.duration.toFixed(2)}s`);
    console.log(`  Detected:   ${r.detected ? 'YES' : 'NO'}`);
    if (r.detected) {
        console.log(`  At:         ${r.detected_at}s`);
        console.log(`  BPM:        ${r.bpm.toFixed(0)}`);
    }
    console.log(`  Strength:   ${r.strength.toFixed(4)}  (threshold ${r.threshold})`);
    console.log(`  Method:     ${r.detection_method}`);
    if (r.masking_detected) {
        console.log(`  Masking:    YES — ${r.masking_duration_s.toFixed(1)}s detected`
            + (r.mask_end_estimate ? `, ended ~${r.mask_end_estimate.toFixed(1)}s` : ''));
        console.log(`  Throb during mask: ${r.throb_predates_mask ? 'PRESENT' : 'UNCERTAIN'}`
            + (r.mean_ac_while_masked ? ` (AC=${r.mean_ac_while_masked.toFixed(3)})` : ''));
    }
    if (r.segments.length) {
        console.log(`  Segments:`);
        r.segments.forEach((s, i) =>
            console.log(`    #${i+1}: ${s.start.toFixed(2)}s → ${s.end.toFixed(2)}s  @${s.bpm.toFixed(0)} BPM`));
    }
    console.log();
}

// ── COMMANDS ──────────────────────────────────────────────────────────────────

async function cmdDetect() {
    const audio = decodeToFloat32(inputFile, opts.sr);
    log(`Running detection (${(audio.length/opts.sr).toFixed(2)}s @ ${opts.sr} Hz)…`);
    const result = detect(audio, opts.sr, {
        threshold: opts.threshold,
        windowSec: opts.windowSec,
        rhythmMin: 0.3,
        rhythmMax: 3.5,
    });

    if (opts.json) {
        const out = buildTimestampsJson(result, inputFile);
        const text = JSON.stringify(out, null, 2);
        if (opts.out) { fs.writeFileSync(opts.out, text); log(`Wrote ${opts.out}`); }
        else            console.log(text);
    } else {
        printResult(result, inputFile);
        if (opts.out) {
            const out = buildTimestampsJson(result, inputFile);
            fs.writeFileSync(opts.out, JSON.stringify(out, null, 2));
            log(`Wrote ${opts.out}`);
        }
    }
    return result;
}

async function cmdEnhance() {
    const audio   = decodeToFloat32(inputFile, opts.sr);
    log(`Enhancing (${(audio.length/opts.sr).toFixed(2)}s)…`);
    const enhanced = enhance(audio, opts.sr);

    const stem = path.join(
        path.dirname(opts.out || inputFile),
        path.basename(opts.out || inputFile, path.extname(opts.out || inputFile))
    );
    const wavPath = opts.encode ? path.join(os.tmpdir(), `throb_enh_${Date.now()}.wav`) : (opts.out || `${stem}_enhanced.wav`);

    fs.writeFileSync(wavPath, float32ToWav(enhanced, opts.sr));
    log(`WAV written: ${wavPath}`);

    if (opts.encode) {
        const m4aPath = opts.out || `${stem}_enhanced.m4a`;
        encodeToM4A(wavPath, m4aPath);
        fs.unlinkSync(wavPath);
        log(`M4A written: ${m4aPath}`);
    }
}

async function cmdAnalyze() {
    const audio = decodeToFloat32(inputFile, opts.sr);
    const dur   = (audio.length / opts.sr).toFixed(2);
    log(`Loaded: ${path.basename(inputFile)} (${dur}s @ ${opts.sr} Hz)`);

    // Detection
    log('Running detection…');
    const t0     = Date.now();
    const result = detect(audio, opts.sr, {
        threshold: opts.threshold,
        windowSec: opts.windowSec,
        rhythmMin: 0.3,
        rhythmMax: 3.5,
    });
    log(`  Done in ${((Date.now()-t0)/1000).toFixed(2)}s`);
    printResult(result, inputFile);

    // Output directory
    const outDir = opts.out || path.join(
        path.dirname(inputFile),
        path.basename(inputFile, path.extname(inputFile)) + '_throb'
    );
    fs.mkdirSync(outDir, { recursive: true });
    const stem = path.join(outDir, path.basename(inputFile, path.extname(inputFile)));

    const written = [];

    // Timestamps JSON
    const tsPath = `${stem}_timestamps.json`;
    fs.writeFileSync(tsPath, JSON.stringify(buildTimestampsJson(result, inputFile), null, 2));
    written.push(tsPath);

    // Raw audio
    if (opts.raw !== false) {
        if (opts.encode) {
            const tmpWav = path.join(os.tmpdir(), `throb_raw_${Date.now()}.wav`);
            fs.writeFileSync(tmpWav, float32ToWav(audio, opts.sr));
            const rawM4a = `${stem}_raw.m4a`;
            encodeToM4A(tmpWav, rawM4a);
            fs.unlinkSync(tmpWav);
            written.push(rawM4a);
        } else {
            const rawWav = `${stem}_raw.wav`;
            fs.writeFileSync(rawWav, float32ToWav(audio, opts.sr));
            written.push(rawWav);
        }
    }

    // Enhanced audio
    if (opts.enhanced && !opts.noEnhance) {
        log('Enhancing audio…');
        const enhanced = enhance(audio, opts.sr);
        if (opts.encode) {
            const tmpWav = path.join(os.tmpdir(), `throb_enh_${Date.now()}.wav`);
            fs.writeFileSync(tmpWav, float32ToWav(enhanced, opts.sr));
            const enhM4a = `${stem}_enhanced.m4a`;
            encodeToM4A(tmpWav, enhM4a);
            fs.unlinkSync(tmpWav);
            written.push(enhM4a);
        } else {
            const enhWav = `${stem}_enhanced.wav`;
            fs.writeFileSync(enhWav, float32ToWav(enhanced, opts.sr));
            written.push(enhWav);
        }
    }

    // Visualization data
    if (opts.viz) {
        const vd = buildVizData(result, Date.now(), 'file_analysis');
        // Split large spectrogram into separate file
        const spec = { freqs: vd.spec_freqs, times: vd.spec_times, z: vd.spec_z };
        const vdNoSpec = Object.assign({}, vd);
        delete vdNoSpec.spec_freqs; delete vdNoSpec.spec_times; delete vdNoSpec.spec_z;
        const vizPath  = `${stem}_viz.json`;
        const specPath = `${stem}_spectrogram.json`;
        fs.writeFileSync(vizPath,  JSON.stringify(vdNoSpec, null, 2));
        fs.writeFileSync(specPath, JSON.stringify(spec));
        written.push(vizPath, specPath);
    }

    log(`\nOutput (${written.length} files) → ${outDir}/`);
    written.forEach(f => log(`  ${path.relative(outDir, f)}`));
}

// ── Dispatch ──────────────────────────────────────────────────────────────────
(async () => {
    try {
        if      (cmd === 'detect')  await cmdDetect();
        else if (cmd === 'enhance') await cmdEnhance();
        else if (cmd === 'analyze') await cmdAnalyze();
    } catch(e) {
        console.error('Fatal:', e.message);
        if (!opts.quiet) console.error(e.stack);
        process.exit(1);
    }
})();
