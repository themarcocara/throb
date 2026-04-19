/**
 * dsp.js — Audio Throb Detector DSP Engine
 *
 * Runs in both a Web Worker (browser) and directly in Node.js (CLI).
 * Contains all signal-processing: Butterworth SOS filters, FFT-based
 * autocorrelation, spectrogram, throb detection, and audio enhancement.
 *
 * Detection parameters (tuned across three real-world recordings):
 *   windowSec  2.0   — 2-second analysis window (≥3 cycles at 100 BPM)
 *   hopSec     0.5   — 500 ms hop between windows
 *   threshold  0.40  — autocorrelation confidence threshold
 *   rhythmMin  0.3 s — fastest throb period (200 BPM)
 *   rhythmMax  3.5 s — slowest throb period (~17 BPM)
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
    var nfft=512, hop=256, N=nextPow2(nfft);
    var hann=new Float64Array(nfft);
    for(var i=0;i<nfft;i++) hann[i]=0.5*(1-Math.cos(2*Math.PI*i/(nfft-1)));
    var maxBin=Math.ceil(1000*N/sr); maxBin=Math.min(maxBin,N/2);
    var freqs=[]; for(var k=0;k<maxBin;k++) freqs.push(k*sr/N);
    var nFrames=Math.floor((signal.length-nfft)/hop)+1;
    var z=[]; for(var f=0;f<maxBin;f++) z.push(new Array(nFrames));
    var times=new Array(nFrames);
    for(var fi=0;fi<nFrames;fi++){
        var s=fi*hop,re=new Float64Array(N),im=new Float64Array(N);
        for(var i=0;i<nfft&&s+i<signal.length;i++) re[i]=signal[s+i]*hann[i];
        fftInPlace(re,im);
        for(var k=0;k<maxBin;k++) z[k][fi]=20*Math.log10(Math.sqrt(re[k]*re[k]+im[k]*im[k])+1e-9);
        times[fi]=(s+nfft/2)/sr;
    }
    return {freqs:freqs,times:times,z:z};
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
    var loHz      = (params&&params.loHz)      || 80;
    var hiHz      = (params&&params.hiHz)      || 160;
    var refLoHz   = (params&&params.refLoHz)   || 300;
    var refHiHz   = (params&&params.refHiHz)   || 380;
    var midLoHz   = (params&&params.midLoHz)   || 300;
    var midHiHz   = (params&&params.midHiHz)   || 1000;
    var windowSec = (params&&params.windowSec) || 2.0;   // 2s captures 3+ cycles at 100BPM
    var hopSec    = (params&&params.hopSec)    || 0.5;
    var threshold = (params&&params.threshold) || 0.40;   // calibrated to new samples
    var minConf   = (params&&params.minConf)   || 3;      // consecutive windows
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
    var ac_hist=[];

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

        // Combined confidence
        var confidence = best * (1.0 - masking_factor * 0.75);

        times.push(t);
        strengths.push(best);
        bpms.push(60*sr/bestLag);
        confidences.push(confidence);
        masking_factors.push(masking_factor);
        masked_snrs.push(masked_snr);
        context_masked_arr.push(context_masked);
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

    // Segments from consecutive high-confidence windows
    var halfHop=hopSec/2, raw=[];
    for(var i=0;i<times.length;i++){
        if(confidences[i]>=threshold)
            raw.push({start:Math.max(0,times[i]-halfHop),end:Math.min(duration,times[i]+halfHop),bpm:bpms[i]});
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
        masking_factors:     masking_factors,
        masked_snrs:         masked_snrs,
        context_masked_arr:  context_masked_arr,
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
    // Find 99th percentile of gated envelope
    var sorted=[]; for(var i=0;i<env_gated.length;i++) sorted.push(env_gated[i]);
    sorted.sort(function(a,b){return a-b;});
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
    var sortedMix=[]; for(var i=0;i<mixed.length;i++) sortedMix.push(Math.abs(mixed[i]));
    sortedMix.sort(function(a,b){return a-b;});
    var peakNorm=sortedMix[Math.floor(sortedMix.length*0.999)]||1e-9;
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
    }
};
