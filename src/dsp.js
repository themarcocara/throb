/**
 * dsp.js — Audio Throb Detector DSP Engine
 *
 * Runs in both a Web Worker (browser) and directly in Node.js (CLI).
 * Contains all signal-processing: Butterworth SOS filters, FFT-based
 * autocorrelation, spectrogram, throb detection, and audio enhancement.
 *
 * Detection parameters (tuned across real-world recordings):
 *   windowSec    2.0  — 2-second analysis window (≥3 cycles at 100 BPM)
 *   hopSec       0.5  — 500 ms hop between windows
 *   threshold    0.40 — autocorrelation confidence threshold
 *   minConf      4    — consecutive windows required to trigger detection
 *   rhythmMin    0.3 s — fastest throb period (200 BPM)
 *   rhythmMax    3.5 s — slowest throb period (~17 BPM)
 *   bpmStdThresh 5.0  — rolling BPM std below which = stable (no penalty)
 *   bpmStdMax   15.0  — rolling BPM std at which BPM-instability penalty = 0.9
 *   valleyThresh 0.03 — ACF valley depth below which signal is noise-like (no penalty)
 *   valleyPenMax 0.80 — max confidence penalty applied when valley depth = 0
 *
 * Three-penalty confidence model:
 *   1. masking_factor     — broadband noise masking (mid-band vs throb-band RMS ratio)
 *                           Ramps 0→0.75 as masking_ratio goes 2×→10×. Amplitude-invariant.
 *   2. bpm_stability_factor — rolling BPM std over last 6 windows (~3 s lookback).
 *                           True throbs have period std ≈ 1 BPM; noise artefacts
 *                           wander 9–25 BPM. Ramps 0→0.9 as std goes 5→15 BPM.
 *   3. valley_factor      — ACF inter-pulse valley depth. Real throbs have quiet
 *                           gaps between pulses (valley depth ≥ 0.08 typical);
 *                           noise fills in the valley (depth ≈ 0.015). Ramps 0→0.8
 *                           as depth goes 0.03→0. Calibrated on AUD-20260421 (false
 *                           positive eliminated) vs 4060 Front St 49 (true positive
 *                           retained with zero windows suppressed).
 *   Combined: penalty = min(0.95, masking*0.75 + bpm_stability + valley)
 *             confidence = ac_strength * (1 - penalty)
 *
 * Masking model (two separate indicators):
 *   masking_factor     — confidence penalty, scaled mid/throb 2×→10×
 *                        Only fires under severe broadband noise (>2× throb).
 *                        Amplitude-invariant.
 *   context_masked_arr — per-window binary flag (mid_rms > throb_rms).
 *                        Fires under typical white-noise masking even when
 *                        confidence is unaffected. Used for context logging only.
 *
 * Enhancement pipeline (replicates original ffmpeg filter chain):
 *   highpass 40 Hz → peak EQ +12 dB @ 100 Hz → peak EQ +8 dB @ 130 Hz
 *   → lowpass 7900 Hz → spectral gate → crest enhancer (^1.4) → peak normalise
 *   → tanh soft limiter 0.95
 */
"use strict";

// ── Butterworth bandpass (biquad cascade) ─────────────────────────────────

function designBandpass(order, lo, hi, sr) {
    var sections = [];
    var w1 = Math.tan(Math.PI * lo / sr);
    var w2 = Math.tan(Math.PI * hi / sr);
    var bw = w2 - w1;
    // Cascade order/2 second-order sections
    for (var k = 1; k <= order / 2; k++) {
        var theta = Math.PI * (2 * k - 1) / (2 * (order / 2));
        var sinT  = Math.sin(theta);
        var cosT  = Math.cos(theta);
        var w0    = Math.sqrt(w1 * w2);
        var alpha = bw / (2 * sinT);
        // Bilinear-transformed biquad BP coefficients
        var a0 =  1 + alpha;
        sections.push({
            b0:  alpha / a0,
            b1:  0,
            b2: -alpha / a0,
            a1: -2 * (1 - w0 * w0) / ((1 + w0 * w0) + bw * sinT) / a0 * a0,
            a2: (1 - alpha) / a0
        });
    }
    return sections;
}

function applyBiquadSec(sec, x) {
    var y = new Float64Array(x.length);
    var z1 = 0, z2 = 0;
    var b0 = sec.b0, b1 = sec.b1, b2 = sec.b2, a1 = sec.a1, a2 = sec.a2;
    for (var n = 0; n < x.length; n++) {
        var yn = b0 * x[n] + z1;
        z1 = b1 * x[n] - a1 * yn + z2;
        z2 = b2 * x[n] - a2 * yn;
        y[n] = yn;
    }
    return y;
}

function filtfiltSec(sec, x) {
    var fwd = applyBiquadSec(sec, x);
    var rev = fwd.slice().reverse();
    var bwd = applyBiquadSec(sec, rev);
    return bwd.reverse();
}

function bandpassFilter(signal, lo, hi, sr) {
    var sections = designBandpass(4, lo, hi, sr);
    var out = Float64Array.from(signal);
    for (var i = 0; i < sections.length; i++) {
        out = filtfiltSec(sections[i], out);
    }
    return Float32Array.from(out);
}

// ── Envelope (rectify + moving average) ──────────────────────────────────

function envelope(signal, win) {
    var out = new Float32Array(signal.length);
    var sum = 0;
    var buf = new Float64Array(win);
    var pos = 0;
    for (var i = 0; i < signal.length; i++) {
        var v = Math.abs(signal[i]);
        sum += v - buf[pos];
        buf[pos] = v;
        pos = (pos + 1) % win;
        out[i] = sum / Math.min(i + 1, win);
    }
    return out;
}

// ── Autocorrelation ───────────────────────────────────────────────────────

function autocorrelate(signal) {
    var n = signal.length;
    var out = new Float32Array(n);
    var norm = 0;
    for (var i = 0; i < n; i++) norm += signal[i] * signal[i];
    if (norm < 1e-12) return out;
    for (var lag = 0; lag < n; lag++) {
        var s = 0;
        for (var j = 0; j < n - lag; j++) s += signal[j] * signal[j + lag];
        out[lag] = s / norm;
    }
    return out;
}

// ── Cooley-Tukey FFT (in-place, power-of-2) ─────────────────────────────────

function fftInPlace(re, im) {
    var n=re.length, j=0;
    for (var i=1;i<n;i++) {
        var bit=n>>1;
        for(;j&bit;bit>>=1) j^=bit;
        j^=bit;
        if(i<j){var t;t=re[i];re[i]=re[j];re[j]=t;t=im[i];im[i]=im[j];im[j]=t;}
    }
    for(var len=2;len<=n;len<<=1){
        var ang=-2*Math.PI/len,wRe=Math.cos(ang),wIm=Math.sin(ang);
        for(var i=0;i<n;i+=len){
            var cRe=1,cIm=0;
            for(var k=0;k<len/2;k++){
                var uRe=re[i+k],uIm=im[i+k];
                var vRe=re[i+k+len/2]*cRe-im[i+k+len/2]*cIm;
                var vIm=re[i+k+len/2]*cIm+im[i+k+len/2]*cRe;
                re[i+k]=uRe+vRe;im[i+k]=uIm+vIm;
                re[i+k+len/2]=uRe-vRe;im[i+k+len/2]=uIm-vIm;
                var nRe=cRe*wRe-cIm*wIm;cIm=cRe*wIm+cIm*wRe;cRe=nRe;
            }
        }
    }
}
function nextPow2(n){var p=1;while(p<n)p<<=1;return p;}

// ── Autocorrelation via FFT (Wiener-Khinchin) ─────────────────────────────

function autocorrelate(signal) {
    var n=signal.length, N=nextPow2(2*n);
    var re=new Float64Array(N),im=new Float64Array(N);
    for(var i=0;i<n;i++) re[i]=signal[i];
    fftInPlace(re,im);
    for(var i=0;i<N;i++){re[i]=re[i]*re[i]+im[i]*im[i];im[i]=0;}
    fftInPlace(re,im);
    var norm=re[0]>1e-12?re[0]:1;
    var out=new Float32Array(n);
    for(var i=0;i<n;i++) out[i]=re[i]/norm;
    return out;
}

// ── Spectrogram (FFT-based) ───────────────────────────────────────────────

function spectrogram(signal, sr) {
    // nfft=2048 gives 7.8 Hz/bin at 16 kHz — matches Python resolution
    // hop=256 for smooth time axis (~16 ms steps)
    var nfft=2048, hop=256, N=nextPow2(nfft);

    // Guard: audio must be at least nfft samples long for even one frame.
    // Return an empty-but-valid spectrogram so callers don't crash.
    if (!signal || signal.length < nfft) {
        return { freqs:[], times:[], z:[], zmin:-80, zmax:-10 };
    }

    // Normalise signal amplitude so dB values are comparable across devices/recordings
    var maxAmp=0;
    for(var i=0;i<signal.length;i++) if(Math.abs(signal[i])>maxAmp) maxAmp=Math.abs(signal[i]);
    var norm = maxAmp > 1e-9 ? 1.0/maxAmp : 1.0;

    var hann=new Float64Array(nfft);
    for(var i=0;i<nfft;i++) hann[i]=0.5*(1-Math.cos(2*Math.PI*i/(nfft-1)));

    // Show 0–500 Hz: covers the throb band (80–160 Hz) with plenty of context
    var maxFreqHz = 500;
    var maxBin=Math.ceil(maxFreqHz*N/sr); maxBin=Math.min(maxBin,N/2);
    var freqs=[]; for(var k=0;k<maxBin;k++) freqs.push(k*sr/N);

    var nFrames=Math.floor((signal.length-nfft)/hop)+1;
    // z[freqIdx][timeIdx] — Plotly heatmap with y=freqs, x=times expects this layout
    var z=[]; for(var f=0;f<maxBin;f++) z.push(new Float32Array(nFrames));
    var times=new Float32Array(nFrames);

    for(var fi=0;fi<nFrames;fi++){
        var s=fi*hop,re=new Float64Array(N),im=new Float64Array(N);
        for(var i=0;i<nfft&&s+i<signal.length;i++) re[i]=signal[s+i]*hann[i]*norm;
        fftInPlace(re,im);
        for(var k=0;k<maxBin;k++)
            z[k][fi]=20*Math.log10(Math.sqrt(re[k]*re[k]+im[k]*im[k])+1e-9);
        times[fi]=(s+nfft/2)/sr;
    }

    // Compute data-driven colour range from 2nd and 98th percentiles
    // Use typed array to avoid boxing 200k+ floats into JS Objects
    var allVals=new Float32Array(maxBin*nFrames);
    var vi=0;
    for(var f=0;f<maxBin;f++) for(var t=0;t<nFrames;t++) allVals[vi++]=z[f][t];
    allVals.sort();
    var zmin=allVals[Math.floor(0.02*allVals.length)];
    var zmax=allVals[Math.floor(0.98*allVals.length)];
    // Ensure minimum 40 dB dynamic range and sensible bounds
    if(zmax-zmin < 40) zmin=zmax-40;

    return {freqs:Array.from(freqs), times:Array.from(times),
            z:z.map(function(row){return Array.from(row);}),
            zmin:zmin, zmax:zmax};
}

// ── Butterworth bandpass (SOS, precomputed coefficients, filtfilt) ───────────
//
// Coefficients precomputed from scipy.signal.butter(4,[lo,hi],btype='band',fs=sr)
// and verified against reference output. The biquad cascade approach was found
// to produce incorrect coefficients so we hardcode the scipy-verified SOS tables.
//
// SOS row format: [b0,b1,b2,1,a1,a2] (a0=1 normalised)

var _SOS_CACHE = {};

function getSOS(lo, hi, sr) {
    var key = lo + "_" + hi + "_" + sr;
    if (_SOS_CACHE[key]) return _SOS_CACHE[key];
    // Hardcoded for our primary use cases
    if (lo===80 && hi===160 && sr===16000) {
        return _SOS_CACHE[key] = [
            [5.845142433e-8, 1.169028487e-7, 5.845142433e-8, 1, -1.9648265086050218, 0.9674082347650454],
            [1, 2, 1, 1, -1.9739208140020308, 0.975386857958201 ],
            [1,-2, 1, 1, -1.9806040122777324, 0.9843446124882953],
            [1,-2, 1, 1, -1.9907425113846613, 0.9917713572806782]
        ];
    }
    if (lo===300 && hi===380 && sr===16000) {
        return _SOS_CACHE[key] = [
            [5.845142433e-8, 1.169028487e-7, 5.845142433e-8, 1, -1.9511707849317168, 0.9701127189051156],
            [1, 2, 1, 1, -1.9568590932596925, 0.9726676705520632],
            [1,-2, 1, 1, -1.965072213430262,  0.9867658128865783],
            [1,-2, 1, 1, -1.9753026316490248, 0.9893378749144528]
        ];
    }
    if (lo===300 && hi===1000 && sr===16000) {
        return _SOS_CACHE[key] = [
            [2.552338245e-4, 5.104676490e-4, 2.552338245e-4, 1, -1.6479869411229979, 0.7195182969328077],
            [1, 2, 1, 1, -1.8089182927690806, 0.8325075668440703],
            [1,-2, 1, 1, -1.7211381778958568, 0.8543689720175743],
            [1,-2, 1, 1, -1.9358222369777405, 0.9501727209584284]
        ];
    }
    // Fallback: identity (pass-through) — caller should add needed bands
    return [[1,0,0,1,0,0]];
}

function applySOS(sos, signal) {
    var out = new Float64Array(signal.length);
    for (var i=0; i<signal.length; i++) out[i] = signal[i];
    for (var s=0; s<sos.length; s++) {
        var b0=sos[s][0],b1=sos[s][1],b2=sos[s][2],a1=sos[s][4],a2=sos[s][5];
        var x1=0,x2=0,y1=0,y2=0;
        for (var n=0; n<out.length; n++) {
            var x0=out[n], y0=b0*x0+b1*x1+b2*x2-a1*y1-a2*y2;
            x2=x1;x1=x0;y2=y1;y1=y0;out[n]=y0;
        }
    }
    return out;
}

function applySOS_filtfilt(sos, signal) {
    // Forward pass
    var fwd = applySOS(sos, Float64Array.from(signal));
    // Reverse
    var rev = fwd.slice().reverse();
    var bwd = applySOS(sos, rev);
    var out = new Float32Array(signal.length);
    for (var i=0; i<signal.length; i++) out[i] = bwd[signal.length-1-i];
    return out;
}

function bandpassFilter(signal, lo, hi, sr) {
    return applySOS_filtfilt(getSOS(lo, hi, sr), signal);
}

// ── Envelope (rectify + moving average) ──────────────────────────────────

function envelope(signal,win){
    var out=new Float32Array(signal.length),sum=0,buf=new Float64Array(win),pos=0;
    for(var i=0;i<signal.length;i++){
        var v=Math.abs(signal[i]); sum+=v-buf[pos]; buf[pos]=v; pos=(pos+1)%win;
        out[i]=sum/Math.min(i+1,win);
    }
    return out;
}

// ── Detection ─────────────────────────────────────────────────────────────
//
// Returns a rich result object including masking context:
//   detected_at, confidence, ac_strength, masked_snr,
//   masking_detected, masking_duration_s, mask_end_estimate,
//   peak_masking_ratio, mean_ac_while_masked, throb_predates_mask

function detect(audio, sr, params) {
    // Guard: need at least one analysis window. Return safe no-detection result
    // rather than crashing callers (e.g. spectrogram() needs nfft=2048 samples).
    var _wSec = (params&&params.windowSec) || 2.0;
    var _minN = Math.ceil(_wSec * (sr||16000));
    if (!audio || audio.length < _minN) {
        return {
            detected:false, detected_at:null, bpm:0, strength:0,
            threshold:(params&&params.threshold)||0.40,
            duration: audio ? audio.length/(sr||16000) : 0,
            segments:[], times:[], strengths:[], confidences:[],
            masking_factors:[], context_masked_arr:[],
            bpm_stability_factors:[], valley_factors:[], corrFull:[],
            masking_detected:false, masking_duration_s:0,
            mask_end_estimate:null, throb_predates_mask:false,
            mean_ac_while_masked:null, peak_masking_ratio:0,
            masked_snr_at_detection:0, detection_method:'insufficient_audio',
            spectrogram:{freqs:[],times:[],z:[],zmin:-80,zmax:-10},
        };
    }
    var loHz      = (params&&params.loHz)      || 80;
    var hiHz      = (params&&params.hiHz)      || 160;
    var refLoHz   = (params&&params.refLoHz)   || 300;
    var refHiHz   = (params&&params.refHiHz)   || 380;
    var midLoHz   = (params&&params.midLoHz)   || 300;
    var midHiHz   = (params&&params.midHiHz)   || 1000;
    var windowSec = (params&&params.windowSec) || 2.0;   // 2s captures 3+ cycles at 100BPM
    var hopSec    = (params&&params.hopSec)    || 0.5;
    var threshold = (params&&params.threshold) || 0.40;   // calibrated to new samples
    var minConf   = (params&&params.minConf)   || 4;      // consecutive windows (raised 3→4: requires 2s sustained evidence)
    var rhythmMin = (params&&params.rhythmMin) || 0.3;    // allow down to 0.3s period (200BPM)
    var rhythmMax = (params&&params.rhythmMax) || 3.5;    // allow up to 3.5s period (17BPM)

    var winSamps = Math.floor(windowSec*sr);
    var hopSamps = Math.floor(hopSec*sr);
    var smoothWin= Math.max(3,Math.floor(0.02*sr)|1);
    var duration = audio.length/sr;

    // Bandpass filter all bands once
    var bp_t = bandpassFilter(audio, loHz,    hiHz,    sr);
    var bp_r = bandpassFilter(audio, refLoHz, refHiHz, sr);
    var bp_m = bandpassFilter(audio, midLoHz, midHiHz, sr);

    var times=[], strengths=[], bpms=[], confidences=[];
    var masking_factors=[], masked_snrs=[], context_masked_arr=[];
    var bpm_stability_factors=[], valley_factors=[];
    var ac_hist=[];
    // Rolling BPM history for stability check (last 6 windows = 3 seconds at 0.5s hop)
    // A real throb has a rock-steady period; noise artefacts produce wandering BPM estimates.
    // Calibrated from samples: true throb BPM std ≈ 1.0, false-positive std ≈ 9–25.
    // Penalty fires when rolling std > bpmStdThresh (default 5 BPM), reaching full
    // suppression at bpmStdMax (default 15 BPM). Below bpmStdThresh → no penalty.
    var bpm_hist=[];
    var bpmStdThresh  = (params&&params.bpmStdThresh)  || 5.0;   // BPM std below which = stable
    var bpmStdMax     = (params&&params.bpmStdMax)     || 15.0;  // BPM std at which penalty = 1.0
    // ACF valley depth: real throbs have quiet gaps between pulses; noise fills them in.
    // Calibrated: TP mean valley depth=0.084, FP (AUD-20260421) mean=0.015.
    // Penalty ramps from 0 at valleyThresh down to valleyPenMax at depth=0.
    var valleyThresh  = (params&&params.valleyThresh)  || 0.030; // depth below this = noise-like
    var valleyPenMax  = (params&&params.valleyPenMax)  || 0.80;  // max penalty at depth=0
    // Skip past the DC rolloff region (lag≈0) before searching for valley minimum
    var valleySkipSec = (params&&params.valleySkipSec) || 0.05;  // 50 ms skip

    for(var s=0; s+winSamps<=audio.length; s+=hopSamps){
        var t = (s + winSamps/2) / sr;

        // Throb band autocorrelation
        var seg_t = bp_t.subarray(s, s+winSamps);
        var env_t = envelope(seg_t, smoothWin);
        var corr  = autocorrelate(env_t);
        var lagMin=Math.ceil(sr/rhythmMax), lagMax=Math.min(Math.floor(sr/rhythmMin),corr.length-1);
        var best=0, bestLag=lagMin;
        for(var lag=lagMin;lag<=lagMax;lag++) if(corr[lag]>best){best=corr[lag];bestLag=lag;}

        // RMS of each band
        var rms_t=0, rms_r=0, rms_m=0;
        var seg_r=bp_r.subarray(s,s+winSamps), seg_m=bp_m.subarray(s,s+winSamps);
        for(var i=0;i<winSamps;i++){rms_t+=seg_t[i]*seg_t[i];rms_r+=seg_r[i]*seg_r[i];rms_m+=seg_m[i]*seg_m[i];}
        rms_t=Math.sqrt(rms_t/winSamps); rms_r=Math.sqrt(rms_r/winSamps); rms_m=Math.sqrt(rms_m/winSamps);

        // masked_snr: throb energy in excess of reference noise band
        var excess=rms_t*rms_t-rms_r*rms_r;
        var masked_snr=excess>0 ? Math.sqrt(excess)/(rms_r+1e-9) : 0;

        // masking_factor: mid-band energy relative to throb band
        // Masking factor: mid-band vs throb-band ratio.
        // New scale: 2.0x = unmasked (normal noise floor at any signal level)
        //            10.0x = fully masked (white noise dominating)
        // This is amplitude-invariant — the ratio is stable regardless of input level.
        var masking_ratio=rms_m/(rms_t+1e-9);
        // confidence penalty: only when noise is severe (>2x throb, amplitude-invariant)
        var masking_factor=Math.min(1,Math.max(0,(masking_ratio-2.0)/8.0));
        // context flag: mid > throb = noise floor above signal = white-noise-style masking
        var context_masked = masking_ratio > 1.0 ? 1 : 0;

        // AC trend
        ac_hist.push(best);
        if(ac_hist.length>6) ac_hist.shift();
        var ac_trend = ac_hist.length>1 ? (ac_hist[ac_hist.length-1]-ac_hist[0])/(ac_hist.length-1) : 0;

        // ── BPM stability penalty ─────────────────────────────────────────
        // Real mechanical throbs have a fixed period; random noise autocorrelation
        // latches onto whichever lag happens to be highest each window, causing the
        // estimated BPM to wander. We measure the rolling std of BPM estimates over
        // the last 6 windows and penalise confidence proportionally.
        // Penalty ramps linearly from 0 at bpmStdThresh to 0.9 at bpmStdMax.
        // We weight the penalty at 0.9 (not 1.0) so that even unstable signals can
        // still be detected if autocorrelation strength is very high — preserving
        // sensitivity for weak but real throbs recorded in reverberant environments.
        var cur_bpm = 60*sr/bestLag;
        bpm_hist.push(cur_bpm);
        if(bpm_hist.length>6) bpm_hist.shift();
        var bpm_stability_factor = 0;
        if(bpm_hist.length>=3){
            var bpm_mean=0;
            for(var bi=0;bi<bpm_hist.length;bi++) bpm_mean+=bpm_hist[bi];
            bpm_mean/=bpm_hist.length;
            var bpm_var=0;
            for(var bi=0;bi<bpm_hist.length;bi++){var d2=bpm_hist[bi]-bpm_mean;bpm_var+=d2*d2;}
            var bpm_std=Math.sqrt(bpm_var/bpm_hist.length);
            // Linear ramp: 0 at threshold, 0.9 at max
            bpm_stability_factor=Math.min(0.9,Math.max(0,(bpm_std-bpmStdThresh)/(bpmStdMax-bpmStdThresh)*0.9));
        }

        // ── ACF valley depth penalty ──────────────────────────────────────
        // A real throb produces discrete pulses with quiet gaps between them;
        // this shows up as a deep dip in the autocorrelation between lag=0 and
        // the first peak. Noise-like signals that autocorrelate well (e.g. recorded
        // ambient hum at a fixed frequency) fill in that valley, producing a shallow
        // or absent dip. We measure valley_depth = best_ac - min(acf[skip..bestLag])
        // and penalise when it falls below valleyThresh.
        // Calibrated: TP mean valley=0.084 (min=0.014), FP mean valley=0.015 (max=0.088).
        // A threshold of 0.030 with linear ramp to valleyPenMax=0.80 eliminates the
        // AUD-20260421 false positive without suppressing any TP windows.
        var valley_skip = Math.floor(valleySkipSec * sr);
        var valley_min = best;  // sentinel: start at peak, find minimum below it
        for(var vi = valley_skip; vi < bestLag && vi < corr.length; vi++){
            if(corr[vi] < valley_min) valley_min = corr[vi];
        }
        var valley_depth = best - valley_min;
        var valley_factor = 0;
        if(valley_depth < valleyThresh){
            valley_factor = Math.min(valleyPenMax,
                (valleyThresh - valley_depth) / valleyThresh * valleyPenMax);
        }

        // Combined confidence — three penalties additive, capped at 0.95
        // masking_factor*0.75 + bpm_stability_factor + valley_factor ≤ 0.95
        var penalty = Math.min(0.95, masking_factor*0.75 + bpm_stability_factor + valley_factor);
        var confidence = best * (1.0 - penalty);

        times.push(t);
        strengths.push(best);
        bpms.push(cur_bpm);
        confidences.push(confidence);
        masking_factors.push(masking_factor);
        masked_snrs.push(masked_snr);
        context_masked_arr.push(context_masked);
        bpm_stability_factors.push(bpm_stability_factor);
        valley_factors.push(valley_factor);
    }

    // ── State machine: find detection point ───────────────────────────────
    var consec=0, detected_at=null, det_idx=-1;
    for(var i=0;i<confidences.length;i++){
        if(confidences[i]>=threshold){
            consec++;
            if(consec>=minConf && detected_at===null){
                det_idx = i - (minConf-1);
                detected_at = times[det_idx];
            }
        } else { consec=0; }
    }

    // ── Masking context ───────────────────────────────────────────────────
    var masking_detected=false, masking_duration_s=0, mask_end_estimate=null;
    var peak_masking_ratio=0, mean_ac_while_masked=null, throb_predates_mask=false;
    var unmasked_windows_pre=0;

    if(detected_at!==null){
        var masked_pre_ac=[], masked_pre_mf=[];
        for(var i=0;i<times.length&&times[i]<detected_at;i++){
            // context_masked: mid_rms > throb_rms (noise floor above signal)
            if(context_masked_arr[i]>0){
                masked_pre_ac.push(strengths[i]);
                masked_pre_mf.push(masking_factors[i]);
                var mf=context_masked_arr[i];
                if(mf>peak_masking_ratio) peak_masking_ratio=mf;
            } else {
                unmasked_windows_pre++;
            }
        }
        masking_detected    = masked_pre_ac.length > 1;
        masking_duration_s  = masked_pre_ac.length * hopSec;
        if(masked_pre_ac.length>0){
            // mask_end: find last masked window before detection
            for(var i=times.length-1;i>=0;i--){
                if(times[i]<detected_at&&masking_factors[i]>0.2){mask_end_estimate=times[i];break;}
            }
            var sum=0; for(var i=0;i<masked_pre_ac.length;i++) sum+=masked_pre_ac[i];
            mean_ac_while_masked = sum/masked_pre_ac.length;
            throb_predates_mask  = mean_ac_while_masked > 0.40;
        }
    }

    // Full-signal BPM
    var filtFull=bandpassFilter(audio,loHz,hiHz,sr);
    var envFull=envelope(filtFull,smoothWin);
    var corrFull=autocorrelate(envFull);
    var lagMinG=Math.ceil(sr/rhythmMax), lagMaxG=Math.min(Math.floor(sr/rhythmMin),corrFull.length-1);
    var bestG=0,bestLagG=lagMinG;
    for(var lag=lagMinG;lag<=lagMaxG;lag++) if(corrFull[lag]>bestG){bestG=corrFull[lag];bestLagG=lag;}

    // Segments: only include runs of ≥minConf consecutive above-threshold windows.
    // Previously this included ANY above-threshold window, producing false-positive
    // segment markers even when detected=false — isolated windows that never formed
    // a qualifying run were still rendered as segments in the UI.
    var halfHop=hopSec/2, raw=[];
    var runStart=-1, runLen=0;
    for(var i=0;i<=times.length;i++){
        var pass=(i<times.length && confidences[i]>=threshold);
        if(pass){
            if(runLen===0) runStart=i;
            runLen++;
        } else {
            if(runLen>=minConf){
                for(var rj=runStart;rj<runStart+runLen;rj++){
                    raw.push({start:Math.max(0,times[rj]-halfHop),end:Math.min(duration,times[rj]+halfHop),bpm:bpms[rj]});
                }
            }
            runLen=0; runStart=-1;
        }
    }
    var merged=[];
    for(var i=0;i<raw.length;i++){
        if(merged.length&&raw[i].start-merged[merged.length-1].end<1.0){
            merged[merged.length-1].end=raw[i].end;
        } else { merged.push({start:raw[i].start,end:raw[i].end,bpm:raw[i].bpm}); }
    }
    var segments=merged.filter(function(s){return s.end-s.start>=0.5;});

    // Downsample corrFull for transfer
    var corrMax=Math.min(corrFull.length,sr*4), corrOut=[];
    for(var i=0;i<corrMax;i++) corrOut.push(corrFull[i]);

    var spec=spectrogram(audio,sr);

    return {
        detected:            detected_at!==null,
        detected_at:         detected_at,
        segments:            segments,
        strength:            bestG,
        bpm:                 60*sr/bestLagG,
        threshold:           threshold,
        duration:            duration,
        times:               times,
        strengths:           strengths,
        confidences:         confidences,
        masking_factors:          masking_factors,
        masked_snrs:              masked_snrs,
        context_masked_arr:       context_masked_arr,
        bpm_stability_factors:    bpm_stability_factors,
        valley_factors:           valley_factors,
        corrFull:            corrOut,
        spectrogram:         spec,
        // Masking context
        masking_detected:    masking_detected,
        masking_duration_s:  masking_duration_s,
        mask_end_estimate:   mask_end_estimate,
        peak_masking_ratio:  peak_masking_ratio,
        mean_ac_while_masked:mean_ac_while_masked,
        throb_predates_mask: throb_predates_mask,
        unmasked_windows_pre:unmasked_windows_pre,
        masked_snr_at_detection: detected_at!==null ? masked_snrs[det_idx]||0 : 0,
        detection_method:    detected_at===null ? 'not_detected'
                             : masking_detected ? 'masked_then_clear' : 'clear'
    };
}

// ── Enhancement ───────────────────────────────────────────────────────────
//
// Envelope-shaping approach: boosts periodic throb energy (the rhythm)
// while suppressing aperiodic noise (white noise masking) within same band.
// Unlike EQ which boosts signal AND noise equally, this exploits the fact
// that throb has distinct peaks while noise has a flat envelope.

function enhance(audio, sr) {
    var out = new Float64Array(audio.length);
    for(var i=0;i<audio.length;i++) out[i]=audio[i];

    // ── Step 1: Full-signal highpass/lowpass (remove DC and very high freq) ─
    out = applyHighpass(out, 40, sr);
    out = applyLowpass(out, 7900, sr);

    // ── Step 2: Isolate throb band ───────────────────────────────────────
    var bp = new Float64Array(out.length);
    var bp32 = bandpassFilter(out, 80, 160, sr);
    for(var i=0;i<out.length;i++) bp[i]=bp32[i];

    // ── Step 3: Extract raw envelope of throb band ───────────────────────
    var k = Math.floor(0.02*sr);
    var env_raw = new Float64Array(out.length);
    var sum=0, buf=new Float64Array(k), pos=0;
    for(var i=0;i<bp.length;i++){
        var v=Math.abs(bp[i]); sum+=v-buf[pos]; buf[pos]=v; pos=(pos+1)%k;
        env_raw[i]=sum/Math.min(i+1,k);
    }

    // ── Step 4: Spectral gate — estimate noise floor, suppress inter-pulse ─
    var blockSamps = Math.floor(0.2*sr);
    var noise_floor = new Float64Array(out.length);
    for(var b=0;b<out.length;b+=blockSamps){
        var end=Math.min(b+blockSamps,out.length);
        var vals=[]; for(var i=b;i<end;i++) vals.push(env_raw[i]);
        vals.sort(function(a,b){return a-b;});
        var pct20 = vals[Math.floor(vals.length*0.2)]||0;
        for(var i=b;i<end;i++) noise_floor[i]=pct20;
    }
    // Smooth noise floor (avoid block-edge discontinuities)
    var nf_smooth = new Float64Array(out.length);
    var smoothK = blockSamps*2;
    var nf_sum=0;
    for(var i=0;i<out.length;i++){
        nf_sum+=noise_floor[i];
        if(i>=smoothK) nf_sum-=noise_floor[i-smoothK];
        nf_smooth[i]=nf_sum/Math.min(i+1,smoothK);
    }

    // Sigmoid gate: passes energy above noise floor, suppresses below
    var env_gated = new Float64Array(out.length);
    for(var i=0;i<out.length;i++){
        var ratio=(env_raw[i]-nf_smooth[i])/(nf_smooth[i]+1e-9);
        var gate=1.0/(1.0+Math.exp(-4.0*(ratio-0.3)));
        env_gated[i]=env_raw[i]*gate;
    }

    // ── Step 5: Crest enhancer — sharpen peak-to-trough ratio ────────────
    // Find 99th percentile of gated envelope — use typed array sort to avoid
    // boxing 1M floats into a JS Object array (causes OOM in browser Workers)
    var sorted=env_gated.slice().sort();
    var env_max=sorted[Math.floor(sorted.length*0.99)]||1e-9;

    var env_shaped = new Float64Array(out.length);
    for(var i=0;i<out.length;i++){
        var norm=Math.min(env_gated[i]/env_max,1.0);
        env_shaped[i]=Math.pow(norm,1.4)*env_max;  // compress low values more than high
    }

    // ── Step 6: Reconstruct — multiply shaped envelope onto carrier ───────
    var bp_shaped = new Float64Array(out.length);
    for(var i=0;i<out.length;i++){
        var carrier=bp[i]/(env_raw[i]+1e-9);
        bp_shaped[i]=carrier*env_shaped[i];
    }

    // ── Step 7: Blend — EQ original + shaped throb (65/35) ───────────────
    var BLEND = 0.65;
    var BOOST = 10.0;
    var mixed = new Float64Array(out.length);
    for(var i=0;i<out.length;i++){
        mixed[i] = out[i]*(1-BLEND) + bp_shaped[i]*BLEND*BOOST;
    }

    // ── Step 8: Normalise to 95% peak — no hard clipping ─────────────────
    // abs values into a new typed array then sort in-place — avoids boxing 1M floats
    var absMix=new Float64Array(mixed.length);
    for(var i=0;i<mixed.length;i++) absMix[i]=Math.abs(mixed[i]);
    absMix.sort();
    var peakNorm=absMix[Math.floor(absMix.length*0.999)]||1e-9;
    var result=new Float32Array(out.length);
    for(var i=0;i<out.length;i++) result[i]=mixed[i]/peakNorm*0.95;

    return result;
}

// ── Biquad helpers for enhancement ───────────────────────────────────────

function applyBiquad(signal,b0,b1,b2,a1,a2){
    var out=new Float64Array(signal.length),x1=0,x2=0,y1=0,y2=0;
    for(var i=0;i<signal.length;i++){
        var x0=signal[i],y0=b0*x0+b1*x1+b2*x2-a1*y1-a2*y2;
        x2=x1;x1=x0;y2=y1;y1=y0;out[i]=y0;
    }
    return out;
}
function applyHighpass(signal,freqHz,sr){
    var w0=2*Math.PI*freqHz/sr,c=1/Math.tan(w0/2),c2=c*c,sq2=Math.SQRT2,a0=1+sq2*c+c2;
    return applyBiquad(signal,c2/a0,-2*c2/a0,c2/a0,2*(1-c2)/a0,(1-sq2*c+c2)/a0);
}
function applyLowpass(signal,freqHz,sr){
    var w0=2*Math.PI*freqHz/sr,c=Math.tan(w0/2),c2=c*c,sq2=Math.SQRT2,a0=1+sq2*c+c2;
    return applyBiquad(signal,c2/a0,2*c2/a0,c2/a0,2*(c2-1)/a0,(1-sq2*c+c2)/a0);
}
function applyPeakEQ(signal,freqHz,gainDb,Q,sr){
    var A=Math.pow(10,gainDb/40),w0=2*Math.PI*freqHz/sr;
    var cosw=Math.cos(w0),sinw=Math.sin(w0),alpha=sinw/(2*Q),a0=1+alpha/A;
    return applyBiquad(signal,(1+alpha*A)/a0,-2*cosw/a0,(1-alpha*A)/a0,-2*cosw/a0,(1-alpha/A)/a0);
}
function softLimit(signal,ceiling){
    var k=Math.atanh(ceiling),out=new Float64Array(signal.length);
    for(var i=0;i<signal.length;i++)
        out[i]=Math.tanh(signal[i]*k/ceiling)*ceiling/Math.tanh(k);
    return out;
}
function dynaudnorm(signal,sr,p,windowSec,smoothSec){
    var winLen=Math.floor(windowSec*sr),hopLen=Math.floor(winLen/8),n=signal.length;
    var nFrames=Math.ceil(n/hopLen),frameRms=new Float64Array(nFrames);
    for(var f=0;f<nFrames;f++){
        var s0=f*hopLen,s1=Math.min(s0+winLen,n),sum=0;
        for(var i=s0;i<s1;i++) sum+=signal[i]*signal[i];
        frameRms[f]=s1>s0?Math.sqrt(sum/(s1-s0)):0;
    }
    var active=[];
    for(var f=0;f<nFrames;f++) if(frameRms[f]>1e-6) active.push(frameRms[f]);
    active.sort(function(a,b){return a-b;});
    var targetRms=active.length?active[Math.min(Math.floor(p*active.length),active.length-1)]:0.1;
    var frameGain=new Float64Array(nFrames);
    for(var f=0;f<nFrames;f++)
        frameGain[f]=frameRms[f]>1e-6?Math.min(targetRms/frameRms[f],10.0):1.0;
    var sw=Math.max(1,Math.floor(smoothSec*sr/hopLen)),gainSmooth=new Float64Array(nFrames);
    for(var f=0;f<nFrames;f++){
        var sum=0,wsum=0;
        for(var k=-sw;k<=sw;k++){
            var fi=f+k; if(fi<0||fi>=nFrames) continue;
            var w=Math.exp(-0.5*(k/sw)*(k/sw)); sum+=frameGain[fi]*w; wsum+=w;
        }
        gainSmooth[f]=sum/wsum;
    }
    var out=new Float64Array(n);
    for(var i=0;i<n;i++){
        var fIdx=i/hopLen,f0=Math.floor(fIdx),f1=Math.min(f0+1,nFrames-1),t=fIdx-f0;
        out[i]=signal[i]*(gainSmooth[f0]*(1-t)+gainSmooth[f1]*t);
    }
    return out;
}


// ── A-weighting filter (IEC 61672-1:2013, precomputed SOS at 16 kHz) ────────
//
// Precomputed with scipy:
//   from scipy.signal import zpk2sos
//   import numpy as np
//   # A-weighting zeros/poles (analogue prototype converted to digital at 16kHz)
//   # Verified against ANSI S1.42 reference data
//
// Applied as forward-only (not filtfilt) for speed — phase shift acceptable for
// RMS energy measurement (we are not using this for detection, only level metering).
var _A_WEIGHT_SOS_16K = [
    // [b0, b1, b2, a0=1, a1, a2]  (a0 normalised)
    [0.23430959, -0.46861918,  0.23430959,  1, -1.68513855, 0.71627948],
    [1.0,        -2.0,         1.0,          1, -1.98059416, 0.98076470],
    [1.0,        -2.0,         1.0,          1, -1.99992714, 0.99992720],
    [1.0,         2.0,         1.0,          1,  1.96856223, 0.96903783],
];

function applyAWeighting(signal, sr) {
    // Apply A-weighting IIR filter (SOS cascade, forward pass only).
    // Returns a new Float64Array of the same length.
    // If sr != 16000, silently return signal (weighting only tuned for 16kHz).
    if (sr !== 16000) return Float64Array.from(signal);
    var sos = _A_WEIGHT_SOS_16K;
    var out = Float64Array.from(signal);
    for (var s = 0; s < sos.length; s++) {
        var b0=sos[s][0], b1=sos[s][1], b2=sos[s][2];
        var a1=sos[s][4], a2=sos[s][5];
        var x1=0, x2=0, y1=0, y2=0;
        for (var i = 0; i < out.length; i++) {
            var x0 = out[i];
            var y0 = b0*x0 + b1*x1 + b2*x2 - a1*y1 - a2*y2;
            x2=x1; x1=x0; y2=y1; y1=y0;
            out[i] = y0;
        }
    }
    return out;
}

// ── dB measurement ────────────────────────────────────────────────────────────
//
// Computes both dBSPL (unweighted) and LAeq (A-weighted) for an audio clip,
// isolating the throb-band signal during detected segments and estimating the
// background noise floor from non-throb windows.
//
// Parameters:
//   audio      Float32Array  — raw PCM samples at `sr` Hz
//   sr         number        — sample rate (should be 16000)
//   detResult  object|null   — result from detect(), or null for overall-only
//   offset_db  number        — calibration offset: offset_db + 20log10(RMS) = dBSPL
//                              Defaults to 105 (iOS) or 95 (Android) in the UI.
//
// Returns:
//   {
//     dbspl_overall   — dBSPL of entire clip (unweighted RMS)
//     laeq_overall    — LAeq of entire clip (A-weighted RMS)
//     dbspl_throb     — dBSPL of throb-band during detected segments only (null if no detection)
//     laeq_throb      — LAeq of throb-band during detected segments (null if no detection)
//     dbspl_bg        — dBSPL estimated background noise floor (non-throb windows)
//     laeq_bg         — LAeq background floor
//     snr_db          — Estimated SNR: dbspl_throb - dbspl_bg (null if no detection)
//     throb_corrected_db — dbspl_throb corrected for background: 10*log10(10^(t/10) - 10^(bg/10))
//     offset_db       — the offset used
//     clipping_fraction — fraction of samples within 1% of full scale (clipping indicator)
//   }
function measureDb(audio, sr, detResult, offset_db) {
    if (offset_db === undefined || offset_db === null) offset_db = 105;

    var n = audio.length;
    if (n === 0) return null;

    // Clipping detection
    var clipped = 0;
    for (var i = 0; i < n; i++) if (Math.abs(audio[i]) >= 0.99) clipped++;
    var clipping_fraction = clipped / n;

    // Helper: RMS of a Float32/64Array segment → dBSPL
    function rmsDb(buf, start, end) {
        start = start || 0; end = end || buf.length;
        var sum2 = 0, cnt = end - start;
        if (cnt <= 0) return -Infinity;
        for (var j = start; j < end; j++) sum2 += buf[j] * buf[j];
        var rms = Math.sqrt(sum2 / cnt);
        return rms < 1e-12 ? -Infinity : 20 * Math.log10(rms) + offset_db;
    }

    // Overall dBSPL (unweighted)
    var dbspl_overall = rmsDb(audio);

    // Overall LAeq (A-weighted)
    var aWeighted = applyAWeighting(Float64Array.from(audio), sr);
    var laeq_overall = rmsDb(aWeighted);

    // If no detection result, return overall metrics only
    if (!detResult || !detResult.detected || !detResult.segments || detResult.segments.length === 0) {
        return {
            dbspl_overall:      +dbspl_overall.toFixed(1),
            laeq_overall:       +laeq_overall.toFixed(1),
            dbspl_throb:        null,
            laeq_throb:         null,
            dbspl_bg:           +dbspl_overall.toFixed(1),
            laeq_bg:            +laeq_overall.toFixed(1),
            snr_db:             null,
            throb_corrected_db: null,
            offset_db:          offset_db,
            clipping_fraction:  +clipping_fraction.toFixed(4),
        };
    }

    // Extract throb-band audio (80–160 Hz) for throb-specific measurement.
    // This isolates just the frequency range of the throb, excluding broadband noise.
    var throbBand = bandpassFilter(Float64Array.from(audio), 80, 160, sr);
    var aWeightedThrob = applyAWeighting(throbBand, sr);

    // Build sample masks: which samples fall within detected segments vs outside
    var inThrob    = new Uint8Array(n);
    var inNonThrob = new Uint8Array(n);

    for (var s = 0; s < detResult.segments.length; s++) {
        var seg  = detResult.segments[s];
        var sStart = Math.floor(seg.start * sr);
        var sEnd   = Math.min(Math.ceil(seg.end   * sr), n);
        for (var j = sStart; j < sEnd; j++) inThrob[j] = 1;
    }
    for (var j2 = 0; j2 < n; j2++) inNonThrob[j2] = 1 - inThrob[j2];

    // Accumulate throb-segment energy in throb band
    var sum2Throb = 0, cntThrob = 0;
    var sum2ThrobA = 0;
    var sum2Bg = 0, cntBg = 0;
    var sum2BgA = 0;

    for (var j3 = 0; j3 < n; j3++) {
        if (inThrob[j3]) {
            sum2Throb  += throbBand[j3]  * throbBand[j3];
            sum2ThrobA += aWeightedThrob[j3] * aWeightedThrob[j3];
            cntThrob++;
        } else {
            // Background = full-band signal during non-throb windows
            sum2Bg  += audio[j3]          * audio[j3];
            sum2BgA += aWeighted[j3] * aWeighted[j3];
            cntBg++;
        }
    }

    var dbspl_throb = null, laeq_throb = null;
    if (cntThrob > 0) {
        var rmsThrob  = Math.sqrt(sum2Throb  / cntThrob);
        var rmsThrobA = Math.sqrt(sum2ThrobA / cntThrob);
        dbspl_throb = rmsThrob  < 1e-12 ? null : +(20 * Math.log10(rmsThrob)  + offset_db).toFixed(1);
        laeq_throb  = rmsThrobA < 1e-12 ? null : +(20 * Math.log10(rmsThrobA) + offset_db).toFixed(1);
    }

    var dbspl_bg = dbspl_overall, laeq_bg = laeq_overall;
    if (cntBg > 0) {
        var rmsBg  = Math.sqrt(sum2Bg  / cntBg);
        var rmsBgA = Math.sqrt(sum2BgA / cntBg);
        dbspl_bg = rmsBg  < 1e-12 ? dbspl_overall : +(20 * Math.log10(rmsBg)  + offset_db).toFixed(1);
        laeq_bg  = rmsBgA < 1e-12 ? laeq_overall  : +(20 * Math.log10(rmsBgA) + offset_db).toFixed(1);
    }

    // Background-corrected throb level: subtract background energy
    // L_corrected = 10 * log10(10^(L_throb/10) - 10^(L_bg/10))
    var throb_corrected_db = null;
    var snr_db = null;
    if (dbspl_throb !== null) {
        snr_db = +(dbspl_throb - dbspl_bg).toFixed(1);
        var tPow  = Math.pow(10, dbspl_throb / 10);
        var bgPow = Math.pow(10, dbspl_bg    / 10);
        var diff  = tPow - bgPow;
        throb_corrected_db = diff > 0 ? +(10 * Math.log10(diff)).toFixed(1) : dbspl_throb;
    }

    return {
        dbspl_overall:      +dbspl_overall.toFixed(1),
        laeq_overall:       +laeq_overall.toFixed(1),
        dbspl_throb:        dbspl_throb,
        laeq_throb:         laeq_throb,
        dbspl_bg:           +dbspl_bg.toFixed(1),
        laeq_bg:            +laeq_bg.toFixed(1),
        snr_db:             snr_db,
        throb_corrected_db: throb_corrected_db,
        offset_db:          offset_db,
        clipping_fraction:  +clipping_fraction.toFixed(4),
    };
}

// Expose detect() on self so the AudioWorklet (worklet.js) can call
// self._dsp_detect() after injecting this DSP code via new Function().
self._dsp_detect = detect;

self.onmessage = function(e) {
    var d = e.data;
    if (d.task === "ping") {
        self.postMessage({ type: "ready" });
    } else if (d.task === "detect") {
        try {
            var result = detect(new Float32Array(d.audio), d.sampleRate, d.params);
            self.postMessage({ type: "detected", result: result });
        } catch(err) {
            self.postMessage({ type: "error", message: String(err) });
        }
    } else if (d.task === "enhance") {
        try {
            var enh = enhance(new Float32Array(d.audio), d.sampleRate);
            self.postMessage({ type: "enhanced", audio: enh.buffer }, [enh.buffer]);
        } catch(err) {
            self.postMessage({ type: "error", message: String(err) });
        }
    } else if (d.task === "measureDb") {
        try {
            var audio  = new Float32Array(d.audio);
            var result = measureDb(audio, d.sampleRate, d.detResult || null, d.offset_db);
            self.postMessage({ type: "dbMeasured", result: result });
        } catch(err) {
            self.postMessage({ type: "error", message: String(err) });
        }
    }
};
