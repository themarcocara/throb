#!/usr/bin/env node
/**
 * throb-server.js — HTTP receiver for Audio Throb Detector uploads
 *
 * Accepts POST /upload from the web app or CLI, saves all associated data
 * (event JSON, viz JSON, spectrogram JSON, audio WAV/M4A) to per-context
 * output folders.  A single process hosts multiple independent contexts,
 * each on its own port with its own output folder.
 *
 * Usage:
 *   # Single context (quick start)
 *   node server/throb-server.js --port 3001 --out ./data
 *
 *   # Multiple contexts from config file
 *   node server/throb-server.js --config server/config.yml
 *
 *   # Config file + CLI override for first context
 *   node server/throb-server.js --config server/config.yml --port 3001
 *
 * Config file (YAML or JSON):
 *   contexts:
 *     - port: 3001
 *       out: ./apartment
 *       label: apartment
 *     - port: 3002
 *       out: ./office
 *       label: office
 *
 * POST /upload  (multipart/form-data)
 *   event        — JSON string: full event record
 *   viz_data     — JSON string: viz numeric series (optional)
 *   spectrogram  — JSON string: spectrogram matrix (optional)
 *   audio        — binary blob: WAV or M4A file (optional)
 *
 * GET /          — health check, returns { ok, label, port, out, uptime_s }
 *
 * CORS: all origins allowed (web app may run on a different host/port).
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

// ── Minimal YAML/JSON config loader ──────────────────────────────────────────
function loadConfig(filePath) {
    const src = fs.readFileSync(filePath, 'utf8').trim();
    if (src.startsWith('{') || src.startsWith('[')) return JSON.parse(src);

    // Minimal YAML: parse a "contexts:" list of key:value maps
    const contexts = [];
    let current = null;
    for (const rawLine of src.split('\n')) {
        const line = rawLine.replace(/#.*$/, '').trimEnd();
        if (!line.trim()) continue;

        if (/^[a-zA-Z]/.test(line)) { current = null; continue; }  // top-level key

        const listMatch = line.match(/^\s+-\s+(.*)/);
        if (listMatch) {
            current = {};
            contexts.push(current);
            const kv = listMatch[1].match(/^(\w+):\s*(.*)$/);
            if (kv) current[kv[1]] = coerce(kv[2].trim());
            continue;
        }
        const kvMatch = line.match(/^\s+(\w+):\s*(.*)$/);
        if (kvMatch && current) current[kvMatch[1]] = coerce(kvMatch[2].trim());
    }
    return { contexts };
}

function coerce(v) {
    v = v.replace(/^['"]|['"]$/g, '');
    return /^\d+$/.test(v) ? parseInt(v) : v;
}

// ── CLI argument parsing ──────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function arg(f)  { const i = argv.indexOf(f); return i >= 0 ? argv[i+1] : null; }
function flag(f) { return argv.includes(f); }

if (flag('--help') || flag('-h')) {
    console.log(`
Throb Server — receives upload POSTs from the Audio Throb Detector

Usage:
  node server/throb-server.js [options]

Options:
  --port <n>       Port number                   [default: 3001]
  --out  <dir>     Output directory              [default: ./throb-data]
  --label <s>      Context label for logs        [default: "default"]
  --config <file>  YAML/JSON config for multiple contexts
  --help           Show this help

Single context (quick):
  node server/throb-server.js --port 3001 --out ./recordings

Multiple contexts (config file):
  node server/throb-server.js --config server/config.yml

Config file format (YAML):
  contexts:
    - port: 3001
      out: ./apartment
      label: apartment
    - port: 3002
      out: ./office
      label: office

Endpoints:
  GET  /          Health check
  POST /upload    Receive event data (multipart/form-data)
    Fields: event (JSON), viz_data (JSON), spectrogram (JSON), audio (file)
`.trim());
    process.exit(0);
}

// ── Resolve contexts ──────────────────────────────────────────────────────────
let contexts = [];

const configPath = arg('--config');
if (configPath) {
    if (!fs.existsSync(configPath)) { console.error(`Config not found: ${configPath}`); process.exit(1); }
    const cfg = loadConfig(configPath);
    contexts = cfg.contexts || [];
}

// CLI flags set or override the first context
const cliPort  = arg('--port');
const cliOut   = arg('--out');
const cliLabel = arg('--label');

if (cliPort || cliOut) {
    if (contexts.length === 0) {
        contexts.push({
            port:  cliPort  ? parseInt(cliPort)  : 3001,
            out:   cliOut   || './throb-data',
            label: cliLabel || 'default',
        });
    } else {
        if (cliPort)  contexts[0].port  = parseInt(cliPort);
        if (cliOut)   contexts[0].out   = cliOut;
        if (cliLabel) contexts[0].label = cliLabel;
    }
}

if (contexts.length === 0) {
    contexts.push({ port: 3001, out: './throb-data', label: 'default' });
}

// ── Multipart/form-data parser (zero external deps) ──────────────────────────
function parseMultipart(body, boundary) {
    const parts = {};
    const sep   = Buffer.from('--' + boundary);

    let pos = 0;
    while (pos < body.length) {
        const bStart = bufIndexOf(body, sep, pos);
        if (bStart < 0) break;
        pos = bStart + sep.length;
        if (body[pos] === 45 && body[pos+1] === 45) break;  // final '--'
        if (body[pos] === 13) pos += 2;                      // skip \r\n

        const hEnd = bufIndexOf(body, Buffer.from('\r\n\r\n'), pos);
        if (hEnd < 0) break;
        const headers = body.slice(pos, hEnd).toString();
        pos = hEnd + 4;

        const nextBound = bufIndexOf(body, sep, pos);
        if (nextBound < 0) break;
        const content = body.slice(pos, nextBound - 2);  // strip \r\n before boundary
        pos = nextBound;

        const nameM  = headers.match(/name="([^"]+)"/);
        const fileM  = headers.match(/filename="([^"]+)"/);
        const ctypeM = headers.match(/Content-Type:\s*([^\r\n]+)/i);
        if (!nameM) continue;

        if (fileM) {
            parts[nameM[1]] = {
                filename:    fileM[1],
                contentType: ctypeM ? ctypeM[1].trim() : 'application/octet-stream',
                buffer:      content,
            };
        } else {
            parts[nameM[1]] = content.toString('utf8');
        }
    }
    return parts;
}

function bufIndexOf(buf, search, from = 0) {
    outer: for (let i = from; i <= buf.length - search.length; i++) {
        for (let j = 0; j < search.length; j++) {
            if (buf[i+j] !== search[j]) continue outer;
        }
        return i;
    }
    return -1;
}

// ── Request handler (one per context) ────────────────────────────────────────
function makeHandler(ctx) {
    return function (req, res) {
        // CORS preflight
        res.setHeader('Access-Control-Allow-Origin',  '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

        // Health check
        if (req.method === 'GET' && (req.url === '/' || req.url === '' || req.url === '/health')) {
            send(res, 200, {
                ok: true, label: ctx.label, port: ctx.port,
                out: ctx.out, uptime_s: Math.floor(process.uptime()),
            });
            return;
        }

        if (req.method !== 'POST' || !req.url.startsWith('/upload')) {
            send(res, 404, { ok: false, error: 'Not found. Use: GET / or POST /upload' });
            return;
        }

        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            try {
                const body = Buffer.concat(chunks);
                const ct   = req.headers['content-type'] || '';

                let parts = {};
                const boundM = ct.match(/boundary=([^\s;]+)/);
                if (boundM) {
                    parts = parseMultipart(body, boundM[1]);
                } else {
                    // Plain JSON body (CLI usage)
                    parts.event = body.toString('utf8');
                }

                // Parse event
                const eventStr = typeof parts.event === 'string' ? parts.event : '{}';
                const event    = JSON.parse(eventStr);

                // Build output stem
                const iso   = (event.wall_clock_iso || new Date().toISOString())
                                  .replace(/[:.]/g, '-').slice(0, 19);
                const label = (event.label || 'event').replace(/[^a-z0-9_\-]/gi, '_');
                const stem  = path.join(ctx.out, `${iso}_${label}`);

                const saved = [];

                // ── event JSON ─────────────────────────────────────────────
                const evPath = `${stem}_event.json`;
                fs.writeFileSync(evPath, JSON.stringify(event, null, 2));
                saved.push(path.basename(evPath));

                // ── viz data ───────────────────────────────────────────────
                for (const [field, outSuffix] of [['viz_data','_viz.json'],['spectrogram','_spectrogram.json']]) {
                    if (!parts[field]) continue;
                    const str = typeof parts[field] === 'string'
                        ? parts[field] : parts[field].buffer.toString('utf8');
                    const p = `${stem}${outSuffix}`;
                    fs.writeFileSync(p, str);
                    saved.push(path.basename(p));
                }

                // ── audio file ─────────────────────────────────────────────
                if (parts.audio && parts.audio.buffer && parts.audio.buffer.length > 0) {
                    const ext  = (parts.audio.contentType || '').includes('mp4') ? '.m4a' : '.wav';
                    const aPath = `${stem}_audio${ext}`;
                    fs.writeFileSync(aPath, parts.audio.buffer);
                    saved.push(path.basename(aPath));
                }

                const ts = new Date().toISOString().replace('T',' ').slice(0,19);
                console.log(`[${ctx.label}] ${ts}  ${label}  →  ${saved.length} file(s): ${saved.join(', ')}`);

                send(res, 200, { ok: true, id: path.basename(stem), saved });

            } catch(e) {
                console.error(`[${ctx.label}] Upload error:`, e.message);
                send(res, 400, { ok: false, error: e.message });
            }
        });

        req.on('error', e => send(res, 500, { ok: false, error: e.message }));
    };
}

function send(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

// ── Start all contexts ────────────────────────────────────────────────────────
console.log(`\nThrob Server  (${contexts.length} context${contexts.length > 1 ? 's' : ''})\n`);

let started = 0;
for (const ctx of contexts) {
    ctx.label = ctx.label || `port-${ctx.port}`;
    ctx.out   = path.resolve(ctx.out);
    fs.mkdirSync(ctx.out, { recursive: true });

    http.createServer(makeHandler(ctx)).listen(ctx.port, () => {
        console.log(`  [${ctx.label}]  http://localhost:${ctx.port}/upload  →  ${ctx.out}`);
        if (++started === contexts.length) console.log('\nReady. Ctrl+C to stop.\n');
    }).on('error', e => {
        console.error(`  [${ctx.label}]  port ${ctx.port}: ${e.message}`);
        process.exit(1);
    });
}

process.on('SIGINT',  () => { console.log('\nStopped.'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\nStopped.'); process.exit(0); });
