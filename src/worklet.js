/**
 * worklet.js — AudioWorklet Processor for Live Throb Detection
 *
 * Runs on the dedicated audio rendering thread. Loaded via
 * AudioContext.audioWorklet.addModule() with DSP code injected at runtime
 * via postMessage({type:'init', dspCode}).
 *
 * State machine: IDLE → DETECTING → CONFIRMED → COOLDOWN
 *
 * Ring buffer: 30 s at 16 kHz (downsampled from mic rate).
 *   Detection capture:  15 s pre-detection
 *   End-of-throb:       10 s before end + 5 s after end
 *   Periodic/manual:    10 s most recent
 *
 * Messages sent to main thread:
 *   {type:'ready'}            — DSP initialised, ready to process
 *   {type:'telemetry', ...}   — per-window confidence, AC, masking, BPM
 *   {type:'stateChange', ...} — IDLE/DETECTING/CONFIRMED/COOLDOWN
 *   {type:'detected', ...}    — detection confirmed, includes audio snapshot
 *   {type:'audioSnap', ...}   — end/periodic/manual snapshots
 *   {type:'eventEnded', ...}  — throb ended, end-snap pending
 *
 * Messages accepted from main thread:
 *   {type:'init', dspCode}         — inject DSP source and start processing
 *   {type:'snapNow'}               — immediate 10 s snapshot
 *   {type:'setPeriodicSave', ...}  — enable/disable/reconfigure periodic saves
 */
// AudioWorklet processor — runs on the audio rendering thread
// Receives 128-sample chunks from mic, accumulates ring buffer,
// runs detection every 500ms, manages state machine.

const SR          = 16000;
// Ring buffer holds max(PRE_DETECT_SECS, PRE_END_SECS) + max(POST_DETECT_SECS, POST_END_SECS) + margin
// Detection capture:  15s pre-detection  + 10s post-detection = 25s
// End capture:        10s pre-end        +  5s post-end       = 15s
// Periodic snapshot:  10s most-recent
// Ring must hold at least 20s.  We use 30s for headroom.
const RING_SECS   = 30;
const RING_LEN    = SR * RING_SECS;
const HOP_SAMPS   = SR * 0.5;  // run detect every 500ms
const WIN_SAMPS   = SR * 2.0;  // 2s analysis window — captures 3+ cycles at 100BPM
const CONF_THRESH = 0.40;
const CONF_MIN    = 3;         // consecutive windows to confirm
// Detection event capture
const DET_PRE_SECS  = 15;     // audio before detection point
const DET_POST_SECS = 10;     // audio after detection point
// End-of-throb capture
const END_PRE_SECS  = 10;     // audio before end point
const END_POST_SECS =  5;     // audio after end point
const COOLDOWN_S    =  8;     // cooldown between events
// Periodic snapshot length
const PERIODIC_SECS = 10;

class ThrobProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._ring      = new Float32Array(RING_LEN);
        this._ringHead  = 0;
        this._samplesIn = 0;
        this._hopAcc    = 0;
        this._dsAccum   = 0.0;  // fractional downsampling accumulator
        this._dspReady  = false;
        // State machine
        this._state         = 'IDLE';
        this._consec        = 0;
        this._postAcc       = 0;   // samples since CONFIRMED (for detection post-window)
        this._endPostAcc    = 0;   // samples since ENDED signal (for end post-window)
        this._endingPending = false; // waiting for post-end audio
        this._cooldownAcc   = 0;
        // History
        this._acHist = [];
        this._mfHist = [];
        // Last telemetry — included in snap messages for live state context
        this._lastTelemetry = null;
        // Periodic save ticker (samples)
        this._periodicEnabled  = false;
        this._periodicInterval = 30 * 60 * SR;  // default 30 min in samples
        this._periodicAcc      = 0;

        this.port.onmessage = (e) => {
            const d = e.data;
            if (d.type === 'init') {
                try {
                    // eslint-disable-next-line no-new-func
                    new Function(d.dspCode)();
                    this._dspReady = true;
                    this.port.postMessage({ type: 'ready' });
                } catch(err) {
                    this.port.postMessage({ type: 'error', message: String(err) });
                }
            } else if (d.type === 'snapNow') {
                // Immediate snapshot — most recent PERIODIC_SECS.
                // Guard: if the ring hasn't accumulated at least 0.5s yet, the snap
                // would be too short for detect() to process. Post a warning instead
                // of sending a 0-length buffer (which produces the "0ms" UI error).
                if (this._samplesIn < Math.ceil(0.5 * SR)) {
                    this.port.postMessage({
                        type: 'warning',
                        message: 'Snap skipped: only ' +
                            (this._samplesIn / SR * 1000).toFixed(0) +
                            'ms buffered. Wait at least 0.5s after starting recording.'
                    });
                } else {
                    this._sendSnap('manual', Date.now());
                }
            } else if (d.type === 'setPeriodicSave') {
                this._periodicEnabled = d.enabled;
                if (d.resetTimer) this._periodicAcc = 0;
                if (d.intervalSecs !== undefined) {
                    const newInterval = d.intervalSecs * SR;
                    // If timer already exceeded new interval, fire immediately + reset
                    if (d.fireIfExceeded && this._periodicAcc >= newInterval) {
                        this._sendSnap('periodic', Date.now());
                        this._periodicAcc = 0;
                    }
                    this._periodicInterval = newInterval;
                }
            }
        };
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0] || !this._dspReady) return true;
        const chunk = input[0];
        const ratio = sampleRate / SR;

        // Downsample input to SR (16 kHz) using a fractional accumulator.
        // _dsAccum tracks our position in the input chunk at SR resolution.
        // We advance by 1/ratio per input sample and write to the ring only
        // when the accumulator crosses an integer boundary — i.e. exactly once
        // per output (16 kHz) sample. This ensures _samplesIn, _hopAcc, and
        // _periodicAcc all count ring-buffer (16 kHz) samples, not input samples.
        for (let i = 0; i < chunk.length; i++) {
            this._dsAccum += 1.0;
            if (this._dsAccum >= ratio) {
                this._dsAccum -= ratio;
                const srcIdx = Math.min(i, chunk.length - 1);
                this._ring[this._ringHead] = chunk[srcIdx];
                this._ringHead = (this._ringHead + 1) % RING_LEN;
                this._samplesIn++;
                this._hopAcc++;
                this._periodicAcc++;
            }
        }

        // Run detection hop
        if (this._hopAcc >= HOP_SAMPS && this._samplesIn >= WIN_SAMPS) {
            this._hopAcc = 0;
            this._runDetect();
        }

        // Detection post-window countdown (CONFIRMED state)
        if (this._state === 'CONFIRMED') {
            this._postAcc += chunk.length / ratio;
            if (this._postAcc >= DET_POST_SECS * SR) {
                // Event ended by timeout (confidence may still be high —
                // _endEvent handles the transition and schedules end-snap)
                this._endEvent('timeout');
            }
        }

        // End-of-throb post-window (capture 5s after end)
        if (this._endingPending) {
            this._endPostAcc += chunk.length / ratio;
            if (this._endPostAcc >= END_POST_SECS * SR) {
                this._endingPending = false;
                this._sendEndSnap();
            }
        }

        // Cooldown
        if (this._state === 'COOLDOWN') {
            this._cooldownAcc += chunk.length / ratio;
            if (this._cooldownAcc >= COOLDOWN_S * SR) {
                this._state = 'IDLE';
                this._cooldownAcc = 0;
                this.port.postMessage({ type: 'stateChange', state: 'IDLE' });
            }
        }

        // Periodic save
        if (this._periodicEnabled && this._periodicAcc >= this._periodicInterval) {
            this._periodicAcc = 0;
            this._sendSnap('periodic', Date.now());
        }

        return true;
    }

    _getWindow() {
        const win   = new Float32Array(WIN_SAMPS);
        const start = (this._ringHead - WIN_SAMPS + RING_LEN) % RING_LEN;
        for (let i = 0; i < WIN_SAMPS; i++)
            win[i] = this._ring[(start + i) % RING_LEN];
        return win;
    }

    // Snapshot the most recent `secs` seconds from ring buffer
    _snapSecs(secs) {
        const len   = Math.min(secs * SR, this._samplesIn, RING_LEN);
        const snap  = new Float32Array(len);
        const start = (this._ringHead - len + RING_LEN) % RING_LEN;
        for (let i = 0; i < len; i++)
            snap[i] = this._ring[(start + i) % RING_LEN];
        return snap;
    }

    // Snapshot a window ending `endOffsetSecs` ago and lasting `secs` seconds
    // endOffsetSecs=0 means right now; endOffsetSecs=5 means ending 5s ago
    _snapWindow(secs, endOffsetSecs) {
        const endOff  = Math.floor(endOffsetSecs * SR);
        const len     = Math.min(secs * SR, this._samplesIn - endOff, RING_LEN);
        const snap    = new Float32Array(Math.max(len, 0));
        const endPos  = (this._ringHead - endOff + RING_LEN * 2) % RING_LEN;
        const start   = (endPos - len + RING_LEN) % RING_LEN;
        for (let i = 0; i < len; i++)
            snap[i] = this._ring[(start + i) % RING_LEN];
        return snap;
    }

    _sendSnap(reason, wallMs) {
        const snap = this._snapSecs(PERIODIC_SECS);
        const t    = this._lastTelemetry;
        this.port.postMessage({
            type:    'audioSnap',
            reason,
            wallMs,
            wallClockIso: new Date(wallMs).toISOString(),
            audioSnap:    snap.buffer,
            durationSecs: snap.length / SR,
            // Live detection state at the moment of this snapshot
            liveState:      this._state,
            liveConf:       t ? t.confidence     : 0,
            liveStrength:   t ? t.strength        : 0,
            liveBpm:        t ? t.bpm             : 0,
            liveMaskFactor: t ? t.masking_factor  : 0,
            liveCtxMasked:  t ? t.context_masked  : 0,
            liveDetected:   this._state === 'CONFIRMED' || this._state === 'COOLDOWN',
        }, [snap.buffer]);
    }

    _sendEndSnap() {
        // Capture END_PRE_SECS before end + END_POST_SECS after end
        // At this point END_POST_SECS have elapsed since end, so:
        // window = (END_PRE_SECS + END_POST_SECS) ending right now
        const totalSecs = END_PRE_SECS + END_POST_SECS;
        const snap = this._snapSecs(totalSecs);
        const wallMs = Date.now();
        this.port.postMessage({
            type:    'audioSnap',
            reason:  'throb_end',
            wallMs,
            wallClockIso: new Date(wallMs).toISOString(),
            audioSnap:    snap.buffer,
            durationSecs: snap.length / SR,
            endPreSecs:   END_PRE_SECS,
            endPostSecs:  END_POST_SECS,
        }, [snap.buffer]);
    }

    _runDetect() {
        try {
            const win  = this._getWindow();
            // windowSec matches WIN_SAMPS/SR so detect() sees the same window;
            // rhythmMin/Max match the tuned defaults for the new samples.
            const r    = detect(win, SR, {
                windowSec: WIN_SAMPS / SR,
                hopSec: 0.5, minConf: 1,
                rhythmMin: 0.3, rhythmMax: 3.5,
                threshold: CONF_THRESH,
            });
            const conf = (r.confidences && r.confidences.length > 0)
                ? r.confidences[r.confidences.length-1] : 0;
            // confidence-penalty masking factor (0 for mild noise, >0 for severe)
            const mf   = (r.masking_factors && r.masking_factors.length > 0)
                ? r.masking_factors[r.masking_factors.length-1] : 0;
            // context masking: mid_rms > throb_rms (amplitude-invariant white-noise flag)
            // stored in context_masked_arr by detect()
            const cm   = (r.context_masked_arr && r.context_masked_arr.length > 0)
                ? r.context_masked_arr[r.context_masked_arr.length-1] : 0;

            this._acHist.push(r.strength);
            this._mfHist.push(cm);   // use context_masked for history (not confidence mf)
            if (this._acHist.length > 20) { this._acHist.shift(); this._mfHist.shift(); }

            var telem = {
                type: 'telemetry',
                confidence:     conf,
                strength:       r.strength,
                masking_factor: mf,
                context_masked: cm,
                bpm:            r.bpm,
                state:          this._state,
                wallMs:         Date.now(),
                periodicAcc:       this._periodicAcc / SR,
                periodicInterval:  this._periodicInterval / SR,
                bufferedSecs:      this._samplesIn / SR,  // how much audio is in ring
            };
            this._lastTelemetry = telem;
            this.port.postMessage(telem);

            if (this._state === 'IDLE' || this._state === 'DETECTING') {
                if (conf >= CONF_THRESH) {
                    this._consec++;
                    this._state = 'DETECTING';
                    if (this._consec >= CONF_MIN) this._confirmEvent(r);
                } else {
                    this._consec = 0;
                    this._state  = 'IDLE';
                }
            } else if (this._state === 'CONFIRMED') {
                // Check if throb has ended (confidence dropped)
                if (conf < CONF_THRESH) {
                    this._endEvent('confidence_drop');
                }
            }
        } catch(e) {
            this.port.postMessage({ type: 'dspError', message: String(e) });
        }
    }

    _confirmEvent(r) {
        this._state    = 'CONFIRMED';
        this._postAcc  = 0;
        const wallMs   = Date.now();

        // Detection snap: DET_PRE_SECS before now (ring already has it)
        const detLen   = Math.min((DET_PRE_SECS) * SR, this._samplesIn, RING_LEN);
        const snap     = new Float32Array(detLen);
        const start    = (this._ringHead - detLen + RING_LEN) % RING_LEN;
        for (let i = 0; i < detLen; i++)
            snap[i] = this._ring[(start + i) % RING_LEN];

        // _mfHist now stores context_masked (0 or 1: mid>throb = masked)
        const maskedWindows = this._mfHist.filter(m => m > 0).length;
        const meanAcMasked  = maskedWindows > 0
            ? this._acHist.filter((_,i) => this._mfHist[i] > 0.2).reduce((a,b)=>a+b,0) / maskedWindows
            : null;

        this.port.postMessage({
            type:                'detected',
            wallMs,
            wallClockIso:        new Date(wallMs).toISOString(),
            bpm:                 r.bpm,
            strength:            r.strength,
            masking_detected:    maskedWindows > 1,
            masking_duration_s:  maskedWindows * 0.5,
            mean_ac_while_masked: meanAcMasked,
            throb_predates_mask: meanAcMasked !== null && meanAcMasked > 0.40,
            peak_masking_ratio:  Math.max(...this._mfHist, 0),
            detection_method:    maskedWindows > 1 ? 'masked_then_clear' : 'clear',
            audioSnap:           snap.buffer,
            durationSecs:        detLen / SR,
            label:               'detection_start',
        }, [snap.buffer]);

        this.port.postMessage({ type: 'stateChange', state: 'CONFIRMED' });
    }

    _endEvent(reason) {
        this._state          = 'COOLDOWN';
        this._cooldownAcc    = 0;
        this._consec         = 0;
        this._endingPending  = true;   // will fire _sendEndSnap after END_POST_SECS
        this._endPostAcc     = 0;
        this.port.postMessage({ type: 'eventEnded', wallMs: Date.now(), reason });
        this.port.postMessage({ type: 'stateChange', state: 'COOLDOWN' });
    }
}

registerProcessor('throb-processor', ThrobProcessor);
