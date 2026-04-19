#!/usr/bin/env node
/**
 * throb.js — Audio Throb Detector CLI
 *
 * Commands:
 *   detect   Run detection — print results and optionally write JSON
 *   enhance  Produce enhanced audio
 *   analyze  Full pipeline: detect + enhance + all requested artifacts
 *
 * All three commands accept one or more input files.  Shell glob expansion
 * works naturally:
 *
 *   node cli/throb.js detect  *.m4a
 *   node cli/throb.js detect  a.m4a b.wav c.mp3 --json
 *   node cli/throb.js enhance *.wav --encode
 *   node cli/throb.js analyze *.m4a --out ./results --enhanced --encode --viz
 *
 * Single-file behaviour is identical to before.  Multi-file behaviour:
 *
 *   detect  — results printed sequentially; --json emits a JSON array;
 *             --out is treated as a directory (one JSON per file written there)
 *   enhance — each file is enhanced in place next to the original, or inside
 *             --out directory if specified
 *   analyze — --out is a directory; each file gets its own sub-directory
 *             named after the input stem (e.g. ./results/recording1/)
 *             A batch_summary.json is also written at the top of --out
 *
 * Options:
 *   --out <path>       Output file (single-file detect/enhance) or directory
 *   --enhanced         Include enhanced audio in analyze output
 *   --raw              Include raw audio in analyze output (default: on)
 *   --no-raw           Suppress raw audio output
 *   --encode           Encode audio as M4A via ffmpeg (requires ffmpeg in PATH)
 *   --viz              Write visualization data JSON
 *   --threshold <n>    Detection confidence threshold  [default: 0.40]
 *   --window <s>       Analysis window seconds         [default: 2.0]
 *   --sr <hz>          Internal sample rate            [default: 16000]
 *   --no-enhance       Skip enhancement step in analyze mode
 *   --quiet            Suppress progress output to stderr
 *   --json             Print results as JSON (detect mode)
 *   --continue-on-error  Skip failed files instead of exiting (multi-file)
 *
 * Requirements:
 *   Node.js >= 18
 *   ffmpeg in PATH  (for decoding non-WAV formats and M4A encoding)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');
const os   = require('os');

// ── DSP engine ────────────────────────────────────────────────────────────────
const DSP_PATH = path.join(__dirname, '..', 'src', 'dsp.js');
if (!fs.existsSync(DSP_PATH)) {
    console.error('Error: src/dsp.js not found. Run from the project root.');
    process.exit(1);
}
global.self = { onmessage: null };
const vm = require('vm');
vm.runInThisContext(fs.readFileSync(DSP_PATH, 'utf8').replace('"use strict";', ''));

// ── Argument parsing ──────────────────────────────────────────────────────────
const rawArgs = process.argv.slice(2);

function usage() {
    console.log(`
Usage: node cli/throb.js <command> <file> [file …] [options]

Commands:
  detect   Detect throb — print results, optionally write JSON
  enhance  Produce enhanced audio
  analyze  Full pipeline: detect + enhance + all requested artifacts

Examples:
  node cli/throb.js detect  recording.m4a
  node cli/throb.js detect  *.m4a --json > batch.json
  node cli/throb.js detect  a.m4a b.m4a --json --out ./reports
  node cli/throb.js enhance *.wav --encode
  node cli/throb.js analyze *.m4a --out ./results --enhanced --encode --viz

Options:
  --out <path>         Output file (single) or directory (multiple / analyze)
  --enhanced           Include enhanced audio in analyze output
  --raw                Include raw audio in analyze output [default: on]
  --no-raw             Suppress raw audio output
  --encode             Encode audio as M4A via ffmpeg
  --viz                Write visualization data JSON
  --threshold <n>      Confidence threshold          [default: 0.40]
  --window <s>         Analysis window seconds       [default: 2.0]
  --sr <hz>            Internal sample rate          [default: 16000]
  --no-enhance         Skip enhancement in analyze mode
  --quiet              Suppress progress output
  --json               Output results as JSON (detect mode)
  --continue-on-error  Skip failed files instead of aborting
`.trim());
}

if (rawArgs.length === 0 || rawArgs[0] === '--help' || rawArgs[0] === '-h') {
    usage(); process.exit(0);
}

const cmd = rawArgs[0];
if (!['detect','enhance','analyze'].includes(cmd)) {
    console.error(`Unknown command: ${cmd}`);
    usage(); process.exit(1);
}

// ── Split positional (input files) from named flags ───────────────────────────
// Named flags that consume the next token as a value:
const VALUE_FLAGS = new Set(['--out','--threshold','--window','--sr']);

const inputFiles = [];
const flagMap    = {};   // flag → value (or true for boolean flags)

{
    let i = 1;  // skip the command
    while (i < rawArgs.length) {
        const a = rawArgs[i];
        if (a.startsWith('--')) {
            if (VALUE_FLAGS.has(a)) {
                flagMap[a] = rawArgs[i+1];
                i += 2;
            } else {
                flagMap[a] = true;
                i++;
            }
        } else {
            // Positional — treat as an input file
            inputFiles.push(a);
            i++;
        }
    }
}

if (inputFiles.length === 0) {
    console.error('Error: no input files specified.');
    usage(); process.exit(1);
}

// Validate input files before doing any work
const missing = inputFiles.filter(f => !fs.existsSync(f));
if (missing.length > 0) {
    console.error('Error: file(s) not found:\n' + missing.map(f => '  ' + f).join('\n'));
    process.exit(1);
}

const opts = {
    out:            flagMap['--out']        || null,
    enhanced:       !!flagMap['--enhanced'],
    raw:            !flagMap['--no-raw'],
    encode:         !!flagMap['--encode'],
    viz:            !!flagMap['--viz'],
    noEnhance:      !!flagMap['--no-enhance'],
    quiet:          !!flagMap['--quiet'],
    json:           !!flagMap['--json'],
    continueOnErr:  !!flagMap['--continue-on-error'],
    threshold:      parseFloat(flagMap['--threshold'] || '0.40'),
    windowSec:      parseFloat(flagMap['--window']    || '2.0'),
    sr:             parseInt(  flagMap['--sr']         || '16000'),
};

const isBatch = inputFiles.length > 1;

function log(...a)  { if (!opts.quiet) console.error(...a); }
function die(msg)   { console.error('Error:', msg); process.exit(1); }
function stem(p)    { return path.basename(p, path.extname(p)); }

// ── Audio I/O ─────────────────────────────────────────────────────────────────
function which(bin) {
    try { cp.execSync(`which ${bin}`, { stdio: 'pipe' }); return true; }
    catch { return false; }
}

function decodeToFloat32(inputPath) {
    if (!which('ffmpeg')) die('ffmpeg not found in PATH.');
    const tmp = path.join(os.tmpdir(), `throb_${process.pid}_${Date.now()}.raw`);
    log(`  Decoding ${path.basename(inputPath)}…`);
    try {
        cp.execSync(
            `ffmpeg -y -i "${inputPath}" -ar ${opts.sr} -ac 1 -f f32le "${tmp}"`,
            { stdio: ['ignore','ignore','ignore'] }
        );
        const buf = fs.readFileSync(tmp);
        fs.unlinkSync(tmp);
        return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    } catch(e) {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        throw new Error(`Decoding failed: ${e.message}`);
    }
}

function float32ToWav(samples) {
    const n = samples.length, sr = opts.sr;
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

function encodeToM4A(wavPath, outPath) {
    if (!which('ffmpeg')) die('ffmpeg not found. Cannot encode M4A.');
    log(`  Encoding M4A: ${path.basename(outPath)}…`);
    cp.execSync(
        `ffmpeg -y -i "${wavPath}" -ar 44100 -ac 2 -c:a aac -q:a 0 -movflags +faststart "${outPath}"`,
        { stdio: ['ignore','ignore','ignore'] }
    );
}

// ── Data builders ─────────────────────────────────────────────────────────────
function buildDetectParams() {
    return { threshold: opts.threshold, windowSec: opts.windowSec, rhythmMin: 0.3, rhythmMax: 3.5 };
}

function buildTimestampsJson(result, inputPath) {
    const baseMs = fs.statSync(inputPath).mtimeMs;
    return {
        file:                path.basename(inputPath),
        detected:            result.detected,
        detected_at_s:       result.detected_at,
        bpm:                 +result.bpm.toFixed(1),
        strength:            +result.strength.toFixed(4),
        threshold:           result.threshold,
        duration_s:          +result.duration.toFixed(3),
        detection_method:    result.detection_method,
        masking_detected:    result.masking_detected,
        masking_duration_s:  result.masking_duration_s,
        mask_end_estimate:   result.mask_end_estimate,
        throb_predates_mask: result.throb_predates_mask,
        mean_ac_while_masked:result.mean_ac_while_masked,
        peak_masking_ratio:  +result.peak_masking_ratio.toFixed(4),
        masked_snr_at_detection: +result.masked_snr_at_detection.toFixed(3),
        segments: result.segments.map((s, i) => ({
            index:           i + 1,
            start_seconds:   +s.start.toFixed(3),
            end_seconds:     +s.end.toFixed(3),
            start_iso:       new Date(baseMs + s.start * 1000).toISOString(),
            end_iso:         new Date(baseMs + s.end   * 1000).toISOString(),
            duration_seconds:+(s.end - s.start).toFixed(3),
            bpm:             +s.bpm.toFixed(1),
        })),
    };
}

function buildVizData(result, inputPath) {
    const r = result;
    return {
        wall_clock_iso:     new Date(fs.statSync(inputPath).mtimeMs).toISOString(),
        wall_clock_ms:      fs.statSync(inputPath).mtimeMs,
        reason:             'file_analysis',
        sr:                 opts.sr,
        duration:           r.duration,   detected:      r.detected,
        detected_at:        r.detected_at, bpm:          r.bpm,
        strength:           r.strength,   threshold:     r.threshold,
        segments:           r.segments,
        times:              Array.from(r.times            || []),
        strengths:          Array.from(r.strengths        || []),
        confidences:        Array.from(r.confidences      || []),
        masking_factors:    Array.from(r.masking_factors  || []),
        context_masked_arr: Array.from(r.context_masked_arr || []),
        corrFull:           Array.from(r.corrFull         || []),
        masking_detected:       r.masking_detected,
        masking_duration_s:     r.masking_duration_s,
        mask_end_estimate:      r.mask_end_estimate,
        throb_predates_mask:    r.throb_predates_mask,
        mean_ac_while_masked:   r.mean_ac_while_masked,
        peak_masking_ratio:     r.peak_masking_ratio,
        detection_method:       r.detection_method,
        spec_freqs: r.spectrogram ? r.spectrogram.freqs : [],
        spec_times: r.spectrogram ? r.spectrogram.times : [],
        spec_z:     r.spectrogram ? r.spectrogram.z     : [],
        spec_zmin:  r.spectrogram ? r.spectrogram.zmin  : -80,
        spec_zmax:  r.spectrogram ? r.spectrogram.zmax  : -10,
    };
}

function printResult(result, inputPath, idx, total) {
    const r   = result;
    const sym = r.detected ? '✓' : '✗';
    const prefix = total > 1 ? `[${idx+1}/${total}] ` : '';
    console.log(`\n${prefix}${sym} ${path.basename(inputPath)}`);
    console.log(`  Duration:  ${r.duration.toFixed(2)}s`);
    console.log(`  Detected:  ${r.detected ? 'YES' : 'NO'}`);
    if (r.detected) {
        console.log(`  At:        ${r.detected_at}s`);
        console.log(`  BPM:       ${r.bpm.toFixed(0)}`);
    }
    console.log(`  Strength:  ${r.strength.toFixed(4)}  (threshold ${r.threshold})`);
    console.log(`  Method:    ${r.detection_method}`);
    if (r.masking_detected) {
        console.log(`  Masking:   YES — ${r.masking_duration_s.toFixed(1)}s`
            + (r.mask_end_estimate ? `, ended ~${r.mask_end_estimate.toFixed(1)}s` : ''));
        console.log(`  Throb during mask: ${r.throb_predates_mask ? 'PRESENT' : 'UNCERTAIN'}`
            + (r.mean_ac_while_masked ? ` (AC=${r.mean_ac_while_masked.toFixed(3)})` : ''));
    }
    if (r.segments.length) {
        r.segments.forEach((s, i) =>
            console.log(`  Seg ${i+1}: ${s.start.toFixed(2)}s → ${s.end.toFixed(2)}s  @${s.bpm.toFixed(0)} BPM`));
    }
}

// ── write helpers ─────────────────────────────────────────────────────────────
function writeAudio(audio, enhanced, stemName, outDir) {
    const written = [];
    if (opts.raw) {
        if (opts.encode) {
            const tmp = path.join(os.tmpdir(), `throb_raw_${Date.now()}.wav`);
            fs.writeFileSync(tmp, float32ToWav(audio));
            const out = path.join(outDir, stemName + '_raw.m4a');
            encodeToM4A(tmp, out); fs.unlinkSync(tmp);
            written.push(out);
        } else {
            const out = path.join(outDir, stemName + '_raw.wav');
            fs.writeFileSync(out, float32ToWav(audio));
            written.push(out);
        }
    }
    if (opts.enhanced && !opts.noEnhance && enhanced) {
        if (opts.encode) {
            const tmp = path.join(os.tmpdir(), `throb_enh_${Date.now()}.wav`);
            fs.writeFileSync(tmp, float32ToWav(enhanced));
            const out = path.join(outDir, stemName + '_enhanced.m4a');
            encodeToM4A(tmp, out); fs.unlinkSync(tmp);
            written.push(out);
        } else {
            const out = path.join(outDir, stemName + '_enhanced.wav');
            fs.writeFileSync(out, float32ToWav(enhanced));
            written.push(out);
        }
    }
    return written;
}

function writeViz(result, inputPath, stemName, outDir) {
    if (!opts.viz) return [];
    const vd     = buildVizData(result, inputPath);
    const spec   = { freqs: vd.spec_freqs, times: vd.spec_times, z: vd.spec_z };
    const noSpec = Object.assign({}, vd);
    delete noSpec.spec_freqs; delete noSpec.spec_times; delete noSpec.spec_z;
    const vizPath  = path.join(outDir, stemName + '_viz.json');
    const specPath = path.join(outDir, stemName + '_spectrogram.json');
    fs.writeFileSync(vizPath,  JSON.stringify(noSpec, null, 2));
    fs.writeFileSync(specPath, JSON.stringify(spec));
    return [vizPath, specPath];
}

// ── Single-file core processors ───────────────────────────────────────────────
// These return a result object; error propagation is the caller's responsibility.

async function processOneDetect(inputPath) {
    const audio  = decodeToFloat32(inputPath);
    log(`  Running detection (${(audio.length/opts.sr).toFixed(2)}s)…`);
    return detect(audio, opts.sr, buildDetectParams());
}

async function processOneEnhance(inputPath, outDir) {
    const audio    = decodeToFloat32(inputPath);
    log(`  Enhancing (${(audio.length/opts.sr).toFixed(2)}s)…`);
    const enhanced = enhance(audio, opts.sr);
    const s        = stem(inputPath);

    if (opts.encode) {
        const tmp = path.join(os.tmpdir(), `throb_enh_${Date.now()}.wav`);
        fs.writeFileSync(tmp, float32ToWav(enhanced));
        const out = path.join(outDir, s + '_enhanced.m4a');
        encodeToM4A(tmp, out); fs.unlinkSync(tmp);
        log(`  → ${out}`);
    } else {
        const out = path.join(outDir, s + '_enhanced.wav');
        fs.writeFileSync(out, float32ToWav(enhanced));
        log(`  → ${out}`);
    }
}

async function processOneAnalyze(inputPath, outDir) {
    const audio  = decodeToFloat32(inputPath);
    const s      = stem(inputPath);
    log(`  Running detection (${(audio.length/opts.sr).toFixed(2)}s)…`);
    const t0     = Date.now();
    const result = detect(audio, opts.sr, buildDetectParams());
    log(`  Done in ${((Date.now()-t0)/1000).toFixed(2)}s`);

    // Always write timestamps
    const ts = path.join(outDir, s + '_timestamps.json');
    fs.writeFileSync(ts, JSON.stringify(buildTimestampsJson(result, inputPath), null, 2));
    const written = [ts];

    // Enhanced audio (compute once if needed)
    let enhanced = null;
    if ((opts.enhanced || opts.raw) && !opts.noEnhance) {
        if (opts.enhanced) {
            log('  Enhancing…');
            enhanced = enhance(audio, opts.sr);
        }
    }

    written.push(...writeAudio(audio, enhanced, s, outDir));
    written.push(...writeViz(result, inputPath, s, outDir));

    log(`  Output (${written.length} files) → ${outDir}/`);
    written.forEach(f => log(`    ${path.relative(outDir, f)}`));

    return result;
}

// ── Command: detect ───────────────────────────────────────────────────────────
async function cmdDetect() {
    const results  = [];
    const errors   = [];

    for (let i = 0; i < inputFiles.length; i++) {
        const f = inputFiles[i];
        if (isBatch) log(`\n[${i+1}/${inputFiles.length}] ${path.basename(f)}`);
        try {
            const result = await processOneDetect(f);
            results.push({ file: f, result });

            if (!opts.json) {
                printResult(result, f, i, inputFiles.length);
            }
        } catch(e) {
            errors.push({ file: f, error: e.message });
            if (!opts.continueOnErr) throw e;
            console.error(`  ⚠ Skipped: ${e.message}`);
        }
    }

    if (opts.json) {
        // JSON output: array for batch, object for single
        const payload = results.length === 1
            ? buildTimestampsJson(results[0].result, results[0].file)
            : results.map(({ file, result }) => buildTimestampsJson(result, file));

        const text = JSON.stringify(payload, null, 2);

        if (opts.out) {
            if (isBatch || fs.existsSync(opts.out) && fs.statSync(opts.out).isDirectory()) {
                // Write one file per result into the directory
                fs.mkdirSync(opts.out, { recursive: true });
                for (const { file, result } of results) {
                    const p = path.join(opts.out, stem(file) + '_timestamps.json');
                    fs.writeFileSync(p, JSON.stringify(buildTimestampsJson(result, file), null, 2));
                    log(`Wrote ${p}`);
                }
            } else {
                fs.writeFileSync(opts.out, text);
                log(`Wrote ${opts.out}`);
            }
        } else {
            console.log(text);
        }
    } else if (opts.out) {
        // Human-readable mode with --out: write one JSON per file into directory
        fs.mkdirSync(opts.out, { recursive: true });
        for (const { file, result } of results) {
            const p = path.join(opts.out, stem(file) + '_timestamps.json');
            fs.writeFileSync(p, JSON.stringify(buildTimestampsJson(result, file), null, 2));
            log(`Wrote ${p}`);
        }
    }

    if (isBatch) {
        const det = results.filter(r => r.result.detected).length;
        // Always route summary to stderr so JSON-to-stdout piping works cleanly
        console.error(`\nSummary: ${det}/${results.length} detected`
            + (errors.length ? `, ${errors.length} error(s)` : ''));
    }
}

// ── Command: enhance ──────────────────────────────────────────────────────────
async function cmdEnhance() {
    if (inputFiles.length === 1 && opts.out && !fs.existsSync(opts.out)) {
        // Single file, --out is the explicit output file path
        const audio    = decodeToFloat32(inputFiles[0]);
        log(`Enhancing (${(audio.length/opts.sr).toFixed(2)}s)…`);
        const enhanced = enhance(audio, opts.sr);
        if (opts.encode) {
            const tmp = path.join(os.tmpdir(), `throb_enh_${Date.now()}.wav`);
            fs.writeFileSync(tmp, float32ToWav(enhanced));
            encodeToM4A(tmp, opts.out);
            fs.unlinkSync(tmp);
            log(`M4A written: ${opts.out}`);
        } else {
            fs.writeFileSync(opts.out, float32ToWav(enhanced));
            log(`WAV written: ${opts.out}`);
        }
        return;
    }

    // Multi-file or --out is a directory: enhance each file into outDir
    const outDir = opts.out || null;   // null = write beside original
    if (outDir) fs.mkdirSync(outDir, { recursive: true });

    for (let i = 0; i < inputFiles.length; i++) {
        const f = inputFiles[i];
        if (isBatch) log(`\n[${i+1}/${inputFiles.length}] ${path.basename(f)}`);
        try {
            const dir = outDir || path.dirname(f);
            await processOneEnhance(f, dir);
        } catch(e) {
            if (!opts.continueOnErr) throw e;
            console.error(`  ⚠ Skipped: ${e.message}`);
        }
    }
}

// ── Command: analyze ──────────────────────────────────────────────────────────
async function cmdAnalyze() {
    // For analyze, --out is always a base directory.
    // Single file: output goes directly into outDir (no sub-directory).
    // Multiple files: each gets its own sub-directory: outDir/<stem>/
    const baseDir = opts.out || path.join(
        path.dirname(inputFiles[0]),
        inputFiles.length === 1
            ? stem(inputFiles[0]) + '_throb'
            : 'throb_results'
    );
    fs.mkdirSync(baseDir, { recursive: true });

    const summaryRows = [];
    const errors      = [];

    for (let i = 0; i < inputFiles.length; i++) {
        const f = inputFiles[i];
        if (isBatch) log(`\n[${i+1}/${inputFiles.length}] ${path.basename(f)}`);

        // Single file: write directly into baseDir.
        // Multiple files: write into baseDir/<stem>/
        const outDir = isBatch
            ? path.join(baseDir, stem(f))
            : baseDir;
        if (isBatch) fs.mkdirSync(outDir, { recursive: true });

        try {
            const result = await processOneAnalyze(f, outDir);
            printResult(result, f, i, inputFiles.length);
            summaryRows.push({
                file:    path.basename(f),
                out_dir: outDir,
                detected:          result.detected,
                detected_at_s:     result.detected_at,
                bpm:               +result.bpm.toFixed(1),
                strength:          +result.strength.toFixed(4),
                detection_method:  result.detection_method,
                masking_detected:  result.masking_detected,
                error:             null,
            });
        } catch(e) {
            summaryRows.push({ file: path.basename(f), out_dir: outDir, error: e.message });
            errors.push({ file: f, error: e.message });
            if (!opts.continueOnErr) throw e;
            console.error(`  ⚠ Skipped: ${e.message}`);
        }
    }

    // Write batch summary JSON at the base directory level
    if (isBatch) {
        const summaryPath = path.join(baseDir, 'batch_summary.json');
        fs.writeFileSync(summaryPath, JSON.stringify(summaryRows, null, 2));
        const det = summaryRows.filter(r => r.detected).length;
        console.log(`\nSummary: ${det}/${inputFiles.length} detected`
            + (errors.length ? `, ${errors.length} error(s)` : '')
            + `\nBatch summary → ${summaryPath}`);
    }
}

// ── Dispatch ──────────────────────────────────────────────────────────────────
(async () => {
    try {
        if      (cmd === 'detect')  await cmdDetect();
        else if (cmd === 'enhance') await cmdEnhance();
        else if (cmd === 'analyze') await cmdAnalyze();
    } catch(e) {
        console.error('\nFatal:', e.message);
        if (!opts.quiet) console.error(e.stack);
        process.exit(1);
    }
})();
