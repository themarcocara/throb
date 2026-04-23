/**
 * recording.js — Live microphone recording, AudioWorklet management,
 *                IndexedDB event log, and enhance-event modal
 *
 * Live recording architecture:
 *   getUserMedia → AudioContext → AudioWorkletNode (src/worklet.js)
 *   → ring buffer → detect() every 500 ms → postMessage to main thread
 *   → saveAudioSnap() → IndexedDB (events + audio + viz_data stores)
 *
 * Audio snapshots saved automatically on:
 *   detection_start — 15 s before confirmed detection
 *   throb_end       — 10 s before + 5 s after end of throb
 *   periodic        — configurable interval (default 30 min), most recent 10 s
 *   manual          — "Save 10s Now" button
 *
 * Periodic save: timer runs inside the AudioWorklet (sample-accurate).
 *   Enabling from disabled → resets timer to 0.
 *   Changing interval with timer already exceeded → fires immediately + resets.
 *
 * WakeLock: screen WakeLock requested on recording start. Auto-reacquired
 *   on visibility change (WakeLock is released when tab is hidden).
 *
 * iOS caveat: AudioContext suspends on screen lock. The foreground-only
 *   banner is shown automatically on iPhone/iPad/iPod.
 */

// ─────────────────────────────────────────────────────────────────────────────
// LIVE RECORDING
// ─────────────────────────────────────────────────────────────────────────────
var isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent)&&!window.MSStream;
if(isIOS) { $("iosBanner").classList.add("active"); }
var confHistory = [];
// Dedicated Worker for live per-hop detection (kept off the audio rendering thread).
var _liveDetectWorker  = null;
var _liveDetectPending = false;

$("startRecBtn").addEventListener("click", startRecording);
$("stopRecBtn").addEventListener("click",  stopRecording);
$("snapNowBtn").addEventListener("click",  function(){
    if(workletNode) workletNode.port.postMessage({type:"snapNow"});
});

if ($("micProcessingToggle")) {
    try {
        var savedMicProcessing = localStorage.getItem("throb_mic_processing");
        if (savedMicProcessing !== null) {
            $("micProcessingToggle").checked = (savedMicProcessing === "true");
        }
    } catch(e) {}

    $("micProcessingToggle").addEventListener("change", function() {
        try { localStorage.setItem("throb_mic_processing", String(this.checked)); } catch(e) {}
    });
}

// ── Periodic save toggle + interval ──────────────────────────────────────────
$("periodicToggle").addEventListener("change", function(){
    var enabled = this.checked;
    if(workletNode){
        workletNode.port.postMessage({
            type:"setPeriodicSave",
            enabled: enabled,
            resetTimer: enabled,   // reset timer when enabling from off
            fireIfExceeded: false,
        });
    }
    updatePeriodicLabel(enabled, 0);
});

$("periodicIntervalInput").addEventListener("change", function(){
    var mins = Math.max(1, Math.min(1440, parseInt(this.value)||30));
    this.value = mins;
    if(workletNode){
        workletNode.port.postMessage({
            type:"setPeriodicSave",
            enabled: $("periodicToggle").checked,
            intervalSecs: mins * 60,
            fireIfExceeded: true,   // fire immediately if already exceeded
            resetTimer: false,      // continue timer from current position
        });
    }
});

function updatePeriodicLabel(enabled, elapsedSecs) {
    var el = $("periodicNextLabel");
    if(!enabled){ el.textContent="— disabled —"; el.style.color="#555"; return; }
    var mins = parseInt($("periodicIntervalInput").value)||30;
    var remaining = Math.max(0, mins*60 - elapsedSecs);
    var m = Math.floor(remaining/60), s = Math.floor(remaining%60);
    el.textContent = "next in "+m+"m "+String(s).padStart(2,"0")+"s";
    el.style.color = "#7ec8e3";
}

async function startRecording() {
    $("startRecBtn").disabled=true;
    statusRec("loading","Requesting microphone access…");
    try {
        confHistory = [];
        if(navigator.storage&&navigator.storage.persist){
            await navigator.storage.persist();
        }
        var useMicProcessing = !!($("micProcessingToggle") && $("micProcessingToggle").checked);
        micStream=await navigator.mediaDevices.getUserMedia({
            audio:{
                echoCancellation: useMicProcessing,
                noiseSuppression: useMicProcessing,
                autoGainControl: useMicProcessing
            }
        });
        audioCtx=new (window.AudioContext||window.webkitAudioContext)();
        // Silent oscillator keeps AudioContext alive
        var osc=audioCtx.createOscillator(),gain=audioCtx.createGain();
        gain.gain.value=0; osc.connect(gain); gain.connect(audioCtx.destination); osc.start();

        var workletCode=$("workletSrc").textContent;
        var dspCode=$("workerSrc").textContent;
        var workletBlob=new Blob([workletCode],{type:"application/javascript"});
        var workletUrl=URL.createObjectURL(workletBlob);
        await audioCtx.audioWorklet.addModule(workletUrl);
        URL.revokeObjectURL(workletUrl);

        workletNode=new AudioWorkletNode(audioCtx,"throb-processor",{numberOfInputs:1,numberOfOutputs:0});
        workletNode.port.onmessage=onWorkletMessage;
        workletNode.port.postMessage({type:"init",dspCode:dspCode});

        var src=audioCtx.createMediaStreamSource(micStream);
        src.connect(workletNode);

        await acquireWakeLock();

        sessionId="sess_"+Date.now();
        recStartMs=Date.now();
        var platform=isIOS?"ios_safari":(navigator.userAgent.includes("Android")?"android_chrome":"desktop");
        await idbPut("sessions",{session_id:sessionId,start_iso:new Date().toISOString(),
            last_heartbeat_iso:new Date().toISOString(),event_count:0,platform:platform});

        recTimerInterval=setInterval(function(){
            $("recTimer").textContent=fmtDuration(Date.now()-recStartMs);
        },1000);
        heartbeatInterval=setInterval(writeHeartbeat,30000);

        $("stopRecBtn").disabled=false;
        // snapNowBtn starts disabled - will be enabled by telemetry when bufferedSecs >= 0.5
        $("snapNowBtn").disabled=true;
        statusRec("success","✅ Recording active. Monitoring for throb sound…");

    } catch(e) {
        $("startRecBtn").disabled=false;
        statusRec("error","Failed to start: "+e.message);
    }
}

async function stopRecording() {
    if(micStream){micStream.getTracks().forEach(function(t){t.stop();});micStream=null;}
    if(workletNode){workletNode.disconnect();workletNode=null;}
    if(audioCtx){audioCtx.close();audioCtx=null;}
    if(_liveDetectWorker){_liveDetectWorker.terminate();_liveDetectWorker=null;}
    _liveDetectPending=false;
    clearInterval(recTimerInterval);
    clearInterval(heartbeatInterval);
    releaseWakeLock();
    $("startRecBtn").disabled=false;
    $("stopRecBtn").disabled=true;
    $("snapNowBtn").disabled=true;
    $("recDot").className="rec-dot idle";
    $("recStateLabel").textContent="Idle";
    statusRec("info","Recording stopped. Events saved to log.");
    loadEventLog();
}

async function writeHeartbeat() {
    var now=new Date().toISOString();
    await idbAdd("heartbeats",{session_id:sessionId,iso:now,uptime_s:Math.floor((Date.now()-recStartMs)/1000)});
    await idbPut("sessions",{session_id:sessionId,start_iso:new Date(recStartMs).toISOString(),
        last_heartbeat_iso:now,event_count:0,platform:""});
    $("heartbeatLabel").textContent="Last heartbeat: "+now.replace("T"," ").slice(0,19)+" UTC";
}

// ── Worklet message handler ───────────────────────────────────────────────────
function onWorkletMessage(e) {
    var m=e.data;
    if(m.type==="ready"){
        statusRec("success","✅ DSP ready. Listening for throb…");
    }
    else if(m.type==="telemetry"){
        $("liveConf").textContent=(m.confidence*100).toFixed(0)+"%";
        $("liveConf").style.color=m.confidence>=0.52?"#2ecc71":m.confidence>=0.35?"#f5a623":"#e0e0e0";
        $("liveAC").textContent=m.strength.toFixed(3);
        $("liveMask").textContent=m.masking_factor.toFixed(3);
        $("liveBPM").textContent=m.bpm>0?m.bpm.toFixed(0):"—";
        confHistory.push(m.confidence);
        if(confHistory.length>90) confHistory.shift();
        drawConfCanvas();
        // Update periodic countdown
        if($("periodicToggle").checked){
            updatePeriodicLabel(true, m.periodicAcc||0);
        }
        // Enable Save 10s Now only once ring has ≥0.5s buffered
        // (the hard minimum for detect+spectrogram to work)
        if(m.bufferedSecs !== undefined) {
            var snapBtn = $("snapNowBtn");
            if(snapBtn) snapBtn.disabled = m.bufferedSecs < 0.5;
        }
    }
    else if(m.type==="hopWindow"){
        // The worklet has extracted a 2s analysis window and handed it off here
        // so that detect() runs in a Worker rather than on the audio rendering thread.
        // We skip this hop if the previous one is still pending to avoid queuing.
        if(!_liveDetectPending){
            _liveDetectPending=true;
            runLiveDetectInWorker(new Float32Array(m.audioWindow)).then(function(r){
                _liveDetectPending=false;
                if(workletNode) workletNode.port.postMessage({type:"detectResult",result:r});
            }).catch(function(err){
                _liveDetectPending=false;
                console.warn("live detect failed:",err);
            });
        }
    }
    else if(m.type==="stateChange"){
        var dot=$("recDot"),lbl=$("recStateLabel");
        dot.className="rec-dot "+m.state.toLowerCase();
        lbl.textContent=m.state.charAt(0)+m.state.slice(1).toLowerCase();
        if(m.state==="CONFIRMED") statusRec("loading","🔴 Throb detected! Capturing audio…");
        if(m.state==="COOLDOWN")  statusRec("success","✅ Event logged. Cooldown before next detection.");
        if(m.state==="IDLE")      statusRec("success","✅ Recording active. Listening…");
    }
    else if(m.type==="detected"){
        // Detection-start audio snapshot
        saveAudioSnap(m, "detection_start");
    }
    else if(m.type==="audioSnap"){
        // End-of-throb, periodic, or manual snapshot
        saveAudioSnap(m, m.reason||"manual");
    }
    else if(m.type==="eventEnded"){
        // The worklet will fire an 'audioSnap' with reason='throb_end' after 5s
        statusRec("loading","⏳ Throb ended. Capturing end audio (5s buffer)…");
    }
    else if(m.type==="error"||m.type==="dspError"){
        statusRec("error","DSP error: "+m.message);
    }
}

// ── Save an audio snapshot to IndexedDB ──────────────────────────────────────
async function saveAudioSnap(m, reason) {
    try {
        var snapArr = new Float32Array(m.audioSnap);

        // Guard: reject snaps that are too short to be useful.
        // nfft=2048 (128ms) is the hard minimum for spectrogram();
        // we use 0.5s as a practical floor so detect() has enough context.
        var MIN_SNAP_SAMPLES = Math.floor(SR * 0.5);  // 8000 samples @ 16kHz
        if (snapArr.length < MIN_SNAP_SAMPLES) {
            console.warn('saveAudioSnap: snap too short (' + snapArr.length +
                ' samples, need ' + MIN_SNAP_SAMPLES + ') — discarding.');
            statusRec('info', '⚠ Snap discarded: too short (' +
                (snapArr.length / SR * 1000).toFixed(0) + 'ms). ' +
                'Wait at least 0.5s after starting recording.');
            return;
        }
        // Respect the "save audio" toggle — when off, store null and skip audio blob
        var saveAudio = !$("saveAudioToggle") || $("saveAudioToggle").checked;
        var wavBlob   = saveAudio ? pcmToWav(snapArr, SR) : null;
        var audioId   = null;
        if (saveAudio) {
            audioId = await idbAdd("audio",{
                session_id:    sessionId,
                pcm_blob:      wavBlob,
                duration_s:    snapArr.length / SR,
                sample_rate:   SR,
                wall_clock_iso: m.wallClockIso,
                reason:        reason,
            });
        }

        // Compute visualization data via DSP worker and store it
        var vizId = null;
        try {
            var vizResult = await runDetectInWorker(snapArr);
            // Keep only the numeric fields needed to reconstruct the plot;
            // drop spectrogram.z (large matrix) but keep freqs/times for axis labels
            var vizData = {
                session_id:      sessionId,
                wall_clock_iso:  m.wallClockIso,
                wall_clock_ms:   m.wallMs,
                reason:          reason,
                sr:              SR,
                duration:        vizResult.duration,
                detected:        vizResult.detected,
                detected_at:     vizResult.detected_at,
                bpm:             vizResult.bpm,
                strength:        vizResult.strength,
                threshold:       vizResult.threshold,
                segments:        vizResult.segments,
                times:           Array.from(vizResult.times        || []),
                strengths:       Array.from(vizResult.strengths    || []),
                confidences:     Array.from(vizResult.confidences  || []),
                masking_factors:    Array.from(vizResult.masking_factors    || []),
                context_masked_arr: Array.from(vizResult.context_masked_arr || []),
                corrFull:           Array.from(vizResult.corrFull           || []),
                masking_detected:      vizResult.masking_detected,
                masking_duration_s:    vizResult.masking_duration_s,
                mask_end_estimate:     vizResult.mask_end_estimate,
                throb_predates_mask:   vizResult.throb_predates_mask,
                mean_ac_while_masked:  vizResult.mean_ac_while_masked,
                peak_masking_ratio:    vizResult.peak_masking_ratio,
                detection_method:      vizResult.detection_method,
                // Spectrogram: keep full z matrix (compressed by JSON)
                spec_freqs:  vizResult.spectrogram ? vizResult.spectrogram.freqs : [],
                spec_times:  vizResult.spectrogram ? vizResult.spectrogram.times : [],
                spec_z:      vizResult.spectrogram ? vizResult.spectrogram.z     : [],
                spec_zmin:   vizResult.spectrogram ? vizResult.spectrogram.zmin  : -80,
                spec_zmax:   vizResult.spectrogram ? vizResult.spectrogram.zmax  : -10,
            };
            vizId = await idbAdd("viz_data", vizData);
        } catch(vizErr) {
            console.warn("viz compute failed (non-fatal):", vizErr);
        }

        // Measure dB levels (throb-specific, background-corrected)
        var dbResult = null;
        try {
            var calOffset = calGetOffset();
            var dbDetResult = null;
            try {
                dbDetResult = await runDetectInWorker(snapArr);
            } catch(e) {}
            dbResult = measureDb(snapArr, SR, dbDetResult, calOffset);
        } catch(dbErr) {
            console.warn("dB measurement failed (non-fatal):", dbErr);
        }

        var eventRec = {
            session_id:            sessionId,
            wall_clock_iso:        m.wallClockIso,
            wall_clock_ms:         m.wallMs,
            label:                 reason,
            bpm:                   +(m.bpm||m.liveBpm||0).toFixed(1),
            strength:              +(m.strength||m.liveStrength||0).toFixed(4),
            masking_detected:      m.masking_detected||false,
            masking_duration_s:    m.masking_duration_s||0,
            mask_end_estimate:     m.mask_end_estimate||null,
            throb_predates_mask:   m.throb_predates_mask||false,
            mean_ac_while_masked:  m.mean_ac_while_masked||null,
            peak_masking_ratio:    +(m.peak_masking_ratio||0).toFixed(4),
            detection_method:      m.detection_method||"",
            audio_id:              audioId,
            viz_id:                vizId,
            duration_s:            snapArr.length / SR,
            // Live detection state at the moment of this snapshot
            live_state:            m.liveState||null,
            live_confidence:       +(m.liveConf||0).toFixed(4),
            live_strength:         +(m.liveStrength||0).toFixed(4),
            live_bpm:              +(m.liveBpm||0).toFixed(1),
            live_mask_factor:      +(m.liveMaskFactor||0).toFixed(4),
            live_ctx_masked:       m.liveCtxMasked||0,
            live_throb_detected:   m.liveDetected||false,
            audio_saved:           saveAudio,
            // dB measurements (throb-specific, background-corrected)
            dbspl_throb:           dbResult ? dbResult.dbspl_throb        : null,
            laeq_throb:            dbResult ? dbResult.laeq_throb         : null,
            dbspl_overall:         dbResult ? dbResult.dbspl_overall      : null,
            laeq_overall:          dbResult ? dbResult.laeq_overall       : null,
            dbspl_bg:              dbResult ? dbResult.dbspl_bg           : null,
            snr_db:                dbResult ? dbResult.snr_db             : null,
            throb_corrected_db:    dbResult ? dbResult.throb_corrected_db : null,
            clipping_fraction:     dbResult ? dbResult.clipping_fraction  : null,
            cal_offset_db:         calGetOffset(),
        };
        var savedEventId = await idbAdd("events", eventRec);
        if($("panelRec").classList.contains("active")){
            loadEventLog(); updateStorageBar();
        }
        // Auto-upload if enabled (fire-and-forget, non-blocking)
        autoUploadEvent(savedEventId, reason).catch(function(e){ console.warn("autoUpload:",e); });
    } catch(err) {
        console.error("saveAudioSnap failed:",err);
        statusRec("error","Save failed: "+err.message);
    }
}

// Run detect() in the DSP worker, returns the result object
function runDetectInWorker(samples) {
    return new Promise(function(resolve, reject) {
        var w   = getEnhWorker();   // reuse the dedicated on-demand worker
        var buf = samples.buffer.slice(0);
        w.onmessage = function(e) {
            if (e.data.type === "detected") {
                w.onmessage = null;
                resolve(e.data.result);
            } else if (e.data.type === "error") {
                w.onmessage = null;
                reject(new Error(e.data.message));
            }
        };
        w.postMessage({ task: "detect", audio: buf, sampleRate: SR }, [buf]);
    });
}

// Dedicated worker for live per-hop detection — separate from _enhWorker so
// snap analysis and live detection never share a worker and block each other.
function getLiveDetectWorker() {
    if (_liveDetectWorker) return _liveDetectWorker;
    var src  = $("workerSrc").textContent;
    var blob = new Blob([src], { type: "application/javascript" });
    _liveDetectWorker = new Worker(URL.createObjectURL(blob));
    return _liveDetectWorker;
}

// Run a lightweight detect() pass on the 2s hop window sent by the worklet.
// Params mirror what the worklet previously passed to self._dsp_detect().
function runLiveDetectInWorker(samples) {
    return new Promise(function(resolve, reject) {
        var w   = getLiveDetectWorker();
        var buf = samples.buffer.slice(0);
        w.onmessage = function(e) {
            if (e.data.type === "detected") {
                w.onmessage = null;
                resolve(e.data.result);
            } else if (e.data.type === "error") {
                w.onmessage = null;
                reject(new Error(e.data.message));
            }
        };
        w.postMessage({
            task: "detect",
            audio: buf,
            sampleRate: SR,
            params: {
                windowSec: 2.0,
                hopSec: 0.5,
                minConf: 1,
                rhythmMin: 0.3,
                rhythmMax: 3.5,
                threshold: 0.40,
                useWindowStats: true,
                includeSegments: false,
                includeCorrFull: false,
                includeSpectrogram: false,
            }
        }, [buf]);
    });
}

// ── Visual feedback toggle ───────────────────────────────────────────────────
// Restore saved preference on load
(function(){
    try {
        var toggle = $("visualFeedbackToggle");
        var content = $("visualFeedbackContent");
        if (!toggle || !content) return;
        var saved = localStorage.getItem('throb_visual_feedback');
        if (saved !== null) {
            var enabled = saved === 'true';
            toggle.checked = enabled;
            content.style.display = enabled ? "" : "none";
        }
    } catch(e) { /* localStorage not available */ }
})();

if ($("visualFeedbackToggle")) {
    $("visualFeedbackToggle").addEventListener("change", function(){
        var content = $("visualFeedbackContent");
        var enabled = this.checked;
        if (content) content.style.display = enabled ? "" : "none";
        // Persist preference
        try {
            localStorage.setItem('throb_visual_feedback', String(enabled));
        } catch(e) { /* localStorage not available */ }
    });
}

// ── Mini confidence canvas ───────────────────────────────────────────────────
function drawConfCanvas() {
    // Skip drawing if visual feedback is disabled
    var vfToggle = $("visualFeedbackToggle");
    var canvas = $("confCanvas");
    if (!canvas) return;
    if (vfToggle && !vfToggle.checked) return;
    
    var dpr=window.devicePixelRatio||1;
    canvas.width=canvas.offsetWidth*dpr;
    var ctx=canvas.getContext("2d"),w=canvas.width,h=canvas.height;
    ctx.clearRect(0,0,w,h);
    ctx.strokeStyle="rgba(245,166,35,0.5)";ctx.lineWidth=1;ctx.setLineDash([4,4]);
    ctx.beginPath();ctx.moveTo(0,h*(1-0.52));ctx.lineTo(w,h*(1-0.52));ctx.stroke();
    ctx.setLineDash([]);
    if(!confHistory.length) return;
    var step=w/Math.max(confHistory.length,1);
    ctx.beginPath();
    for(var i=0;i<confHistory.length;i++){
        var x=i*step,y=h*(1-confHistory[i]);
        if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
    }
    ctx.strokeStyle="#e05252";ctx.lineWidth=1.5;ctx.stroke();
    ctx.lineTo((confHistory.length-1)*step,h);ctx.lineTo(0,h);ctx.closePath();
    ctx.fillStyle="rgba(224,82,82,0.15)";ctx.fill();
}

// ── Event log ─────────────────────────────────────────────────────────────────
var _selectedIds = new Set();

function typeColor(label) {
    if(label==="detection_start") return "#2ecc71";
    if(label==="throb_end")       return "#e05252";
    return "#f5a623";  // periodic / manual
}
function typeLabel(label) {
    if(label==="detection_start") return "🟢 Start";
    if(label==="throb_end")       return "🔴 End";
    if(label==="periodic")        return "🟡 Periodic";
    return "🟡 Manual";
}

// ── Upload status list ───────────────────────────────────────────────────────

function addUploadStatus(eventId, label) {
    var id = ++_uploadIdSeq;
    _uploadStatuses.push({ id, eventId, label: label||'event', status:'pending', msg:'Uploading…' });
    renderUploadStatuses();
    return id;
}

function setUploadStatus(id, status, msg) {
    var s = _uploadStatuses.find(function(x){ return x.id===id; });
    if (s) { s.status = status; s.msg = msg; }
    renderUploadStatuses();
}

function renderUploadStatuses() {
    var wrap = $("uploadStatusWrap");
    var list = $("uploadStatusList");
    if (!wrap || !list) return;
    if (_uploadStatuses.length === 0) { wrap.style.display = "none"; return; }
    wrap.style.display = "";
    list.innerHTML = _uploadStatuses.slice().reverse().map(function(s) {
        var color = s.status==="ok"?"#2ecc71":s.status==="fail"?"#e74c3c":"#f5a623";
        var icon  = s.status==="ok"?"✅":s.status==="fail"?"❌":"⏳";
        var retryBtn = s.status==="fail"
            ? "<button class='btn-secondary btn-sm' style='padding:2px 8px;font-size:.75em;margin-left:6px;' "
              +"onclick='retryUpload("+s.id+")''>Retry</button>"
            : "";
        var clearBtn = "<button class='btn-secondary btn-sm' style='padding:2px 8px;font-size:.75em;margin-left:4px;background:rgba(80,80,80,.3);' "
                      +"onclick='clearUploadStatus("+s.id+")'>✕</button>";
        return "<div style='display:flex;align-items:center;padding:5px 9px;border-bottom:1px solid #1a2a3e;gap:6px;'>"
            +"<span style='color:"+color+";'>"+icon+"</span>"
            +"<span style='flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' title='"+s.msg+"'>"
            +"<strong style='color:#e0e0e0;'>"+s.label+"</strong>"
            +" <span style='color:#888;font-size:.9em;'>"+s.msg+"</span>"
            +"</span>"
            +retryBtn+clearBtn
            +"</div>";
    }).join("");
}

window.clearUploadStatus = function(id) {
    _uploadStatuses = _uploadStatuses.filter(function(s){ return s.id!==id; });
    renderUploadStatuses();
};

window.retryUpload = function(id) {
    var s = _uploadStatuses.find(function(x){ return x.id===id; });
    if (!s || !s.eventId) return;
    var url = getUploadUrl();
    if (!url) { setUploadStatus(id,"fail","No URL configured"); return; }
    s.status = "pending"; s.msg = "Retrying…";
    renderUploadStatuses();
    doUploadEvent(s.eventId, url, id);
};

// ── Core upload function ──────────────────────────────────────────────────────

async function doUploadEvent(eventId, url, statusId) {
    // statusId is optional — if supplied, updates that status entry;
    // otherwise creates a new one.
    try {
        var ev  = await idbGet("events", eventId);
        if (!ev) { if(statusId) setUploadStatus(statusId,"fail","Event not found"); return; }

        var sid = statusId || addUploadStatus(eventId, ev.label||"event");

        // Build form-data fields
        var fd  = new FormData();

        // 1. Event JSON (strip blob fields — they go as separate form fields)
        var evClean = Object.assign({}, ev);
        delete evClean.pcm_blob;
        fd.append("event", JSON.stringify(evClean));

        // 2. Viz data
        if (ev.viz_id) {
            try {
                var vd = await idbGet("viz_data", ev.viz_id);
                if (vd) {
                    // Split spectrogram out separately (can be large)
                    var spec    = { freqs: vd.spec_freqs||[], times: vd.spec_times||[], z: vd.spec_z||[] };
                    var vdClean = Object.assign({}, vd);
                    delete vdClean.spec_freqs; delete vdClean.spec_times; delete vdClean.spec_z;
                    fd.append("viz_data",    JSON.stringify(vdClean));
                    if (spec.z && spec.z.length) fd.append("spectrogram", JSON.stringify(spec));
                }
            } catch(e) { console.warn("viz fetch for upload:", e); }
        }

        // 3. Audio — fetch from IDB, try to encode to M4A
        if (ev.audio_id) {
            try {
                var audioRec = await idbGet("audio", ev.audio_id);
                if (audioRec && audioRec.pcm_blob) {
                    var audioBlob = audioRec.pcm_blob;
                    var mimeType  = "audio/wav";
                    // Try M4A encoding if AudioEncoder available
                    try {
                        var wavData  = await audioRec.pcm_blob.arrayBuffer();
                        var pcmFloat = parseWavToFloat32(wavData);
                        var m4aBlob  = await exportM4a(pcmFloat, audioRec.sample_rate||SR, function(){});
                        if (m4aBlob) { audioBlob = m4aBlob; mimeType = "audio/mp4"; }
                    } catch(encErr) { console.warn("M4A encode for upload failed, using WAV:", encErr); }
                    fd.append("audio", audioBlob, mimeType==="audio/mp4"?"audio.m4a":"audio.wav");
                }
            } catch(e) { console.warn("audio fetch for upload:", e); }
        }

        setUploadStatus(sid, "pending", "Sending…");
        var resp  = await fetch(url, { method:"POST", body:fd });
        var json  = await resp.json().catch(function(){ return {}; });
        if (resp.ok && json.ok) {
            setUploadStatus(sid, "ok", "Saved " + (json.saved||[]).length + " file(s) on server");
        } else {
            setUploadStatus(sid, "fail", "Server error " + resp.status + ": " + (json.error||resp.statusText));
        }
    } catch(err) {
        if (statusId) setUploadStatus(statusId, "fail", err.message);
        else {
            var ev2 = await idbGet("events", eventId).catch(function(){ return null; });
            var sid2 = addUploadStatus(eventId, ev2 ? (ev2.label||"event") : "event");
            setUploadStatus(sid2, "fail", err.message);
        }
    }
}

window.uploadEventById = function(eventId) {
    var url = getUploadUrl();
    if (!url) { statusRec("error","Set an upload URL first."); return; }
    var sid = addUploadStatus(eventId, "event");
    doUploadEvent(eventId, url, sid);
};

async function uploadSelectedEvents() {
    var url = getUploadUrl();
    if (!url) { statusRec("error","Set an upload URL first."); return; }
    if (_selectedIds.size === 0) return;
    for (var id of _selectedIds) {
        var sid = addUploadStatus(id, "event");
        await doUploadEvent(id, url, sid);
    }
}

async function autoUploadEvent(eventId, label) {
    if (!uploadEnabled()) return;
    var url = getUploadUrl();
    if (!url) return;
    var sid = addUploadStatus(eventId, label||"event");
    doUploadEvent(eventId, url, sid);
}

async function loadEventLog() {
    try {
        var events=await idbGetAll("events");
        events.sort(function(a,b){return b.wall_clock_ms-a.wall_clock_ms;});
        var tbody=$("eventTableBody");
        $("eventCount").textContent=events.length+" event"+(events.length!==1?"s":"");
        // Clean up stale selection
        _selectedIds.forEach(function(id){ if(!events.find(function(e){return e.id===id;})) _selectedIds.delete(id); });
        updateSelectionUI();
        if(!events.length){
            tbody.innerHTML='<tr><td colspan="8" class="no-events">No events yet. Start recording to begin monitoring.</td></tr>';
            return;
        }
        
        // Check if recording is active and if we're using onboard speakers
        var isRecording = micStream !== null && micStream !== undefined;
        var shouldDisablePlayback = false;
        
        // Try to detect audio output device (only supported in some browsers)
        // Note: Device detection relies on MediaDevices API and device label heuristics
        // which may vary across browsers/platforms. Labels may be empty or use different
        // naming conventions depending on browser permissions and OS.
        if (isRecording && navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
            try {
                var devices = await navigator.mediaDevices.enumerateDevices();
                var audioOutputs = devices.filter(function(d) { return d.kind === 'audiooutput'; });
                
                // Heuristic 1: If we have multiple audio output devices, assume at least one is external
                // Heuristic 2: Check if any device label suggests external audio
                // (headphones, Bluetooth, USB, AirPods, etc. vs built-in speakers)
                var hasMultipleOutputs = audioOutputs.length > 1;
                var hasExternalAudio = audioOutputs.some(function(d) { 
                    var label = (d.label || '').toLowerCase();
                    // Common patterns for external audio across platforms
                    return label.includes('headphone') || label.includes('headset') ||
                           label.includes('bluetooth') || label.includes('airpod') ||
                           label.includes('usb') || label.includes('external') ||
                           label.includes('line out') || label.includes('hdmi');
                });
                // Disable playback if recording and no external audio detected
                // Conservative: if we have multiple outputs OR detected external device, allow playback
                shouldDisablePlayback = !hasMultipleOutputs && !hasExternalAudio;
            } catch(e) {
                // Can't detect devices, play it safe and allow playback
                shouldDisablePlayback = false;
            }
        }
        
        tbody.innerHTML=events.map(function(ev,i){
            var dt=new Date(ev.wall_clock_ms);
            var dateStr=dt.toLocaleDateString()+" "+dt.toLocaleTimeString();
            var maskBadge=ev.masking_detected
                ?"<span class='badge badge-amber'>Masked "+ev.masking_duration_s.toFixed(0)+"s</span>"
                :(ev.live_ctx_masked?"<span class='badge badge-grey' title='Mid-band noise present'>Noise</span>":"<span class='badge badge-grey'>None</span>");
            var dur=ev.duration_s?(ev.duration_s.toFixed(1)+"s"):"—";
            // For periodic/manual use live values; for detection events use detection values
            var useConf = (ev.label==="periodic"||ev.label==="manual") ? ev.live_confidence : ev.strength;
            var useBpm  = (ev.label==="periodic"||ev.label==="manual") ? ev.live_bpm        : ev.bpm;
            var conf=useConf?(+useConf).toFixed(3):"—";
            var bpm=useBpm?(+useBpm).toFixed(0):"—";
            // Audio saved indicator
            var audioIcon=ev.audio_saved===false?"<span title='No audio saved' style='color:#555;font-size:.8em;'>🔇</span>":"";
            var chk=_selectedIds.has(ev.id)?"checked":"";
            
            // Determine if play button should be disabled
            var playDisabled = shouldDisablePlayback ? " disabled" : "";
            var playTitle = shouldDisablePlayback ? " title='Playback disabled during recording (using onboard speakers)'" : "";
            var playBtn = ev.audio_saved !== false 
                ? "<button class='btn-secondary btn-sm' onclick='openEnhanceModal("+ev.id+")'"+playDisabled+playTitle+">▶ Play</button> "
                : "<button class='btn-secondary btn-sm' disabled title='No audio saved'>▶ Play</button> ";
            
            return "<tr id='row-"+ev.id+"'>"
                +"<td><input type='checkbox' "+chk+" onchange='toggleSelect("+ev.id+",this.checked)' style='accent-color:#e05252;'></td>"
                +"<td><span style='color:"+typeColor(ev.label)+";font-size:.9em;'>"+typeLabel(ev.label)+"</span>"+audioIcon+"</td>"
                +"<td style='font-size:.8em;'>"+dateStr+"</td>"
                +"<td>"+bpm+"</td>"
                +"<td>"+conf+"</td>"
                +"<td>"+maskBadge+"</td>"
                +"<td>"+dur+"</td>"
                +(ev.dbspl_throb!==null&&ev.dbspl_throb!==undefined?"<td style='color:#7ec8e3;font-variant-numeric:tabular-nums;'>"+ev.dbspl_throb.toFixed(1)+"<br><span style='font-size:.75em;color:#aaa;'>"+((ev.laeq_throb!==null&&ev.laeq_throb!==undefined)?ev.laeq_throb.toFixed(1)+" dBA":"")+(ev.snr_db!==null&&ev.snr_db!==undefined?" / SNR "+ev.snr_db.toFixed(1):"")+"</span></td>":"<td style='color:#555;'>—</td>")
                +"<td style='white-space:nowrap;'>"
                  +playBtn
                  +"<button class='btn-secondary btn-sm' onclick='openVizModal("+ev.id+")' title='View visualization'>📊</button> "
                  +"<button class='btn-secondary btn-sm' onclick='downloadEventWav("+ev.id+")' title='Download'>⬇</button> "
                  +"<button class='btn-secondary btn-sm' onclick='uploadEventById("+ev.id+")' title='Upload to server'>⬆</button> "
                  +"<button class='btn-secondary btn-sm' style='background:linear-gradient(135deg,#5a1a1a,#7a2020);' onclick='deleteSingleEvent("+ev.id+")' title='Delete'>🗑</button>"
                +"</td>"
                +"</tr>";
        }).join("");
    } catch(err) { console.error("loadEventLog:",err); }
}

window.toggleSelect = function(id, checked) {
    if(checked) _selectedIds.add(id); else _selectedIds.delete(id);
    updateSelectionUI();
};

function updateSelectionUI() {
    var n=_selectedIds.size;
    $("selectionCount").textContent=n>0?n+" selected":"";
    $("saveSelWavBtn").disabled=n===0;
    $("deleteSelBtn").disabled=n===0;
    if($("uploadSelBtn")) $("uploadSelBtn").disabled=n===0;
    $("selectAllChk").checked=false;
    $("selectAllChkHeader").checked=false;
}

function syncSelectAll(checked) {
    $("selectAllChk").checked=checked;
    $("selectAllChkHeader").checked=checked;
    var rows=document.querySelectorAll("#eventTableBody input[type=checkbox]");
    rows.forEach(function(cb){
        var id=parseInt(cb.closest("tr").id.replace("row-",""));
        cb.checked=checked;
        if(checked) _selectedIds.add(id); else _selectedIds.delete(id);
    });
    updateSelectionUI();
}
$("selectAllChk").addEventListener("change",function(){syncSelectAll(this.checked);});
$("selectAllChkHeader").addEventListener("change",function(){syncSelectAll(this.checked);});

$("refreshLogBtn").addEventListener("click",function(){loadEventLog();updateStorageBar();});

$("clearLogBtn").addEventListener("click",async function(){
    if(!confirm("Wipe ALL recorded events and audio? This cannot be undone.")) return;
    await idbClear("events");await idbClear("audio");
    await idbClear("heartbeats");await idbClear("sessions");
    _selectedIds.clear();
    loadEventLog();updateStorageBar();
});

$("deleteSelBtn").addEventListener("click",async function(){
    if(!_selectedIds.size) return;
    if(!confirm("Delete "+_selectedIds.size+" selected event(s)? This cannot be undone.")) return;
    for(var id of _selectedIds){
        try {
            var ev=await idbGet("events",id);
            if(ev&&ev.audio_id) await idbDelete("audio",ev.audio_id);
            await idbDelete("events",id);
        } catch(e){ console.warn("delete failed for id",id,e); }
    }
    _selectedIds.clear();
    loadEventLog();updateStorageBar();
});

$("saveSelWavBtn").addEventListener("click",async function(){
    if(!_selectedIds.size) return;
    for(var id of _selectedIds){
        try {
            var ev=await idbGet("events",id);
            if(!ev||!ev.audio_id) continue;
            var audioRec=await idbGet("audio",ev.audio_id);
            if(!audioRec||!audioRec.pcm_blob) continue;
            var dt=new Date(ev.wall_clock_ms);
            var stem=dt.toISOString().replace(/[:.]/g,"-").slice(0,19);
            dlBlob(audioRec.pcm_blob, stem+"_"+ev.label+".wav");
            await new Promise(function(r){setTimeout(r,200);});  // stagger downloads
        } catch(e){ console.warn("save selected failed for",id,e); }
    }
});

window.deleteSingleEvent = async function(id) {
    if(!confirm("Delete this event?")) return;
    try {
        var ev=await idbGet("events",id);
        if(ev&&ev.audio_id) await idbDelete("audio",ev.audio_id);
        await idbDelete("events",id);
        _selectedIds.delete(id);
    } catch(e){ console.error(e); }
    loadEventLog();updateStorageBar();
};

window.downloadEventWav = async function(id) {
    try {
        var ev=await idbGet("events",id);
        if(!ev||!ev.audio_id){alert("No audio for this event.");return;}
        var audioRec=await idbGet("audio",ev.audio_id);
        if(!audioRec||!audioRec.pcm_blob){alert("Audio data missing.");return;}
        var dt=new Date(ev.wall_clock_ms);
        var s=dt.toISOString().replace(/[:.]/g,"-").slice(0,19)+"_"+(ev.label||"event");
        var raw=parseWavToFloat32(await audioRec.pcm_blob.arrayBuffer());
        var wantViz=$("modalChkViz")?$("modalChkViz").checked:false;
        var vd=null;
        if(wantViz){
            try{
                if(ev.viz_id) vd=await idbGet("viz_data",ev.viz_id);
                if(!vd){var res=await runDetectInWorker(raw);
                    vd={wall_clock_ms:ev.wall_clock_ms,reason:ev.label,sr:SR,
                        duration:res.duration,detected:res.detected,detected_at:res.detected_at,
                        bpm:res.bpm,strength:res.strength,threshold:res.threshold,
                        segments:res.segments,
                        times:Array.from(res.times||[]),strengths:Array.from(res.strengths||[]),
                        confidences:Array.from(res.confidences||[]),
                        masking_factors:Array.from(res.masking_factors||[]),
                        corrFull:Array.from(res.corrFull||[]),
                        masking_detected:res.masking_detected,detection_method:res.detection_method,
                        spec_freqs:res.spectrogram?res.spectrogram.freqs:[],
                        spec_times:res.spectrogram?res.spectrogram.times:[],
                        spec_z:res.spectrogram?res.spectrogram.z:[],
                        spec_zmin:res.spectrogram?res.spectrogram.zmin:-80,
                        spec_zmax:res.spectrogram?res.spectrogram.zmax:-10,
                    };}
            }catch(e2){console.warn("viz load row:",e2);}
        }
        var opts={
            wantRaw:      $("modalChkRaw")      ? $("modalChkRaw").checked      : true,
            wantEnhanced: $("modalChkEnhanced")  ? $("modalChkEnhanced").checked  : false,
            wantEncoded:  $("modalChkEncoded")   ? $("modalChkEncoded").checked   : false,
            wantViz:      wantViz, vizData:vd,
        };
        await buildAndDownload(raw, null, s, statusRec, opts);
    } catch(e){ console.error(e); statusRec("error","Download failed: "+e.message); }
};

$("exportAllBtn").addEventListener("click",async function(){
    var events=await idbGetAll("events");
    if(!events.length){alert("No events to export.");return;}
    dlBlob(new Blob([JSON.stringify(events,null,2)],{type:"application/json"}),"throb_all_events.json");
});

// ─────────────────────────────────────────────────────────────────────────────
// ENHANCE MODAL (for log entries)
// ─────────────────────────────────────────────────────────────────────────────
var _enhModalEventId=null;
var _enhModalRawPCM=null;
var _enhModalPCM=null;
var _enhModalWallMs=null;
var _enhModalLabel=null;

window.openEnhanceModal=async function(eventId){
    _enhModalEventId=eventId;
    _enhModalPCM=null;
    $("enhanceModalTitle").textContent="Enhancing event #"+eventId+"…";
    $("enhanceModalInfo").textContent="Loading audio…";
    $("enhanceModalPlayer").src="";
    showModal("enhanceModal");

    try {
        var ev=await idbGet("events",eventId);
        var audioRec=await idbGet("audio",ev.audio_id);
        if(!audioRec||!audioRec.pcm_blob){
            $("enhanceModalInfo").textContent="No audio data found for this event.";
            return;
        }

        // Decode WAV blob back to Float32Array
        var buf=await audioRec.pcm_blob.arrayBuffer();
        var raw=parseWavToFloat32(buf);
        _enhModalRawPCM=raw;
        _enhModalWallMs=ev.wall_clock_ms;
        _enhModalLabel=ev.label||"event";

        // Play raw audio by default; user can click Preview Enhanced
        var rawWav=pcmToWav(raw,SR);
        $("enhanceModalPlayer").src=URL.createObjectURL(rawWav);

        var dt=new Date(ev.wall_clock_ms);
        $("enhanceModalTitle").textContent="Event — "+dt.toLocaleDateString()+" "+dt.toLocaleTimeString();
        $("enhanceModalInfo").textContent=
            "Type: "+(ev.label||"—")+"  |  BPM: "+(ev.bpm||0).toFixed(0)
            +(ev.masking_detected?"  |  ⚠ Masking: "+ev.masking_duration_s.toFixed(0)+"s":"")
            +"\nRaw audio loaded. Click ▶ Preview Enhanced to hear enhancement.";

    } catch(err) {
        $("enhanceModalInfo").textContent="Error: "+err.message;
    }
};

function parseWavToFloat32(buffer) {
    var view=new DataView(buffer);
    var offset=12;
    while(offset+8<=buffer.byteLength){
        var id=String.fromCharCode(view.getUint8(offset),view.getUint8(offset+1),view.getUint8(offset+2),view.getUint8(offset+3));
        var size=view.getUint32(offset+4,true);
        if(id==="data"){
            var n=size/2; var out=new Float32Array(n);
            for(var i=0;i<n;i++) out[i]=view.getInt16(offset+8+i*2,true)/32768.0;
            return out;
        }
        offset+=8+size+(size&1);
    }
    throw new Error("WAV data chunk not found");
}

// Dedicated worker for on-demand enhancement (recording log playback / downloads).
// Kept separate from the batch `worker` so it can never intercept batch messages.
var _enhWorker = null;

// ── Upload state ──────────────────────────────────────────────────────────────
var _uploadStatuses = [];    // [{id, eventId, label, status:'pending'|'ok'|'fail', msg, retry}]
var _uploadIdSeq    = 0;

function getUploadUrl() {
    var el = $("uploadUrlInput");
    return el ? el.value.trim() : "";
}
function uploadEnabled() {
    var el = $("uploadToggle");
    return el ? el.checked : false;
}

function getEnhWorker() {
    if (_enhWorker) return _enhWorker;
    var src  = $("workerSrc").textContent;
    var blob = new Blob([src], { type: "application/javascript" });
    _enhWorker = new Worker(URL.createObjectURL(blob));
    return _enhWorker;
}

function runEnhanceInWorker(samples) {
    return new Promise(function(resolve, reject) {
        var w   = getEnhWorker();
        var buf = samples.buffer.slice(0);
        w.onmessage = function(e) {
            if (e.data.type === "enhanced") {
                w.onmessage = null;
                resolve(e.data.audio);
            } else if (e.data.type === "error") {
                w.onmessage = null;
                reject(new Error(e.data.message));
            }
            // ignore "ready" ping and other messages
        };
        w.postMessage({ task: "enhance", audio: buf, sampleRate: SR }, [buf]);
    });
}

$("uploadSelBtn").addEventListener("click", function(){ uploadSelectedEvents(); });

$("clearAllUploadStatusBtn").addEventListener("click", function(){
    _uploadStatuses = [];
    renderUploadStatuses();
});

$("testUploadBtn").addEventListener("click", async function(){
    var url = getUploadUrl();
    if (!url) { statusRec("error","Enter an upload URL first."); return; }
    try {
        var r = await fetch(url.replace("/upload","") + "/", {method:"GET"});
        var j = await r.json().catch(function(){return {};});
        statusRec(j.ok?"success":"error", j.ok
            ? "✅ Server OK — label: "+(j.label||"?")+"  uptime: "+(j.uptime_s||0)+"s"
            : "❌ Server responded: "+JSON.stringify(j));
    } catch(e) {
        statusRec("error", "❌ Could not reach server: "+e.message);
    }
});

// Persist uploadUrl to localStorage
$("uploadUrlInput").addEventListener("change", function(){
    try { localStorage.setItem("throb_upload_url", this.value.trim()); } catch(e){}
});
// Restore on load
(function(){
    try {
        var saved = localStorage.getItem("throb_upload_url");
        if (saved && $("uploadUrlInput")) $("uploadUrlInput").value = saved;
    } catch(e){}
})();

$("enhanceModalClose").addEventListener("click",function(){
    hideModal("enhanceModal");
    $("enhanceModalPlayer").src="";
    _enhModalRawPCM=null; _enhModalPCM=null;
});

// Preview enhanced audio on demand
$("enhanceModalPlay").addEventListener("click",async function(){
    if(!_enhModalRawPCM){statusRec("error","No raw audio.");return;}
    $("enhanceModalInfo").textContent="Enhancing…";
    try {
        var buf=await runEnhanceInWorker(_enhModalRawPCM);
        _enhModalPCM=new Float32Array(buf);
        var wav=pcmToWav(_enhModalPCM,SR);
        $("enhanceModalPlayer").src=URL.createObjectURL(wav);
        $("enhanceModalInfo").textContent="Playing enhanced audio.";
    } catch(e) { $("enhanceModalInfo").textContent="Enhancement failed: "+e.message; }
});

$("enhanceModalDl").addEventListener("click",async function(){
    if(!_enhModalRawPCM){statusRec("error","No audio loaded.");return;}
    var dt=new Date(_enhModalWallMs||Date.now());
    var s=dt.toISOString().replace(/[:.]/g,"-").slice(0,19);
    var vd=null;
    if($("modalChkViz").checked && _enhModalEventId){
        try{
            var ev=await idbGet("events",_enhModalEventId);
            if(ev&&ev.viz_id) vd=await idbGet("viz_data",ev.viz_id);
            if(!vd){
                // compute on demand
                var res=await runDetectInWorker(_enhModalRawPCM);
                vd={
                    wall_clock_ms:_enhModalWallMs,reason:_enhModalLabel,sr:SR,
                    duration:res.duration,detected:res.detected,detected_at:res.detected_at,
                    bpm:res.bpm,strength:res.strength,threshold:res.threshold,
                    segments:res.segments,
                    times:Array.from(res.times||[]),strengths:Array.from(res.strengths||[]),
                    confidences:Array.from(res.confidences||[]),
                    masking_factors:Array.from(res.masking_factors||[]),
                    corrFull:Array.from(res.corrFull||[]),
                    masking_detected:res.masking_detected,
                    masking_duration_s:res.masking_duration_s,
                    mask_end_estimate:res.mask_end_estimate,
                    throb_predates_mask:res.throb_predates_mask,
                    detection_method:res.detection_method,
                    spec_freqs:res.spectrogram?res.spectrogram.freqs:[],
                    spec_times:res.spectrogram?res.spectrogram.times:[],
                    spec_z:res.spectrogram?res.spectrogram.z:[],
                };
            }
        }catch(e){console.warn("viz load for modal:",e);}
    }
    var opts={
        wantRaw:      $("modalChkRaw").checked,
        wantEnhanced: $("modalChkEnhanced").checked,
        wantEncoded:  $("modalChkEncoded").checked,
        wantViz:      $("modalChkViz").checked,
        vizData:      vd,
    };
    await buildAndDownload(_enhModalRawPCM, _enhModalPCM, s+"_"+(_enhModalLabel||"event"), statusRec, opts);
});

// ─────────────────────────────────────────────────────────────────────────────
// WAKELOCK
// ─────────────────────────────────────────────────────────────────────────────
async function acquireWakeLock() {
    if(!("wakeLock" in navigator)) {
        $("wakelockBadge").textContent="🔒 WakeLock N/A";
        return;
    }
    try {
        wakeLock=await navigator.wakeLock.request("screen");
        $("wakelockBadge").className="wakelock-badge";
        $("wakelockBadge").textContent="🔒 WakeLock ON";
        wakeLock.addEventListener("release",function(){
            $("wakelockBadge").className="wakelock-badge off";
            $("wakelockBadge").textContent="🔒 WakeLock released";
        });
    } catch(e) {
        $("wakelockBadge").textContent="🔒 WakeLock failed";
    }
}

function releaseWakeLock() {
    if(wakeLock) { wakeLock.release(); wakeLock=null; }
    $("wakelockBadge").className="wakelock-badge off";
    $("wakelockBadge").textContent="🔒 WakeLock off";
}

// Re-acquire WakeLock if tab becomes visible again (WakeLock auto-releases on hide)
document.addEventListener("visibilitychange",function(){
    if(document.visibilityState==="visible"&&micStream) acquireWakeLock();
});

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE BAR
// ─────────────────────────────────────────────────────────────────────────────
async function updateStorageBar() {
    var est=await idbStorageEstimate();
    if(!est) return;
    $("storageWrap").style.display="block";
    var pct=est.quota>0?Math.min(100,est.usage/est.quota*100):0;
    $("storageBarFill").style.width=pct.toFixed(1)+"%";
    var usedMB=(est.usage/1024/1024).toFixed(1);
    var quotaMB=(est.quota/1024/1024).toFixed(0);
    $("storageLabel").textContent="Storage: "+usedMB+" MB used of "+quotaMB+" MB quota ("+pct.toFixed(1)+"%)";
}

// ── Calibration Modal ─────────────────────────────────────────────────────────
//
// Supports five methods:
//   default  — platform-based offset (iOS 105, Android 95, NIOSH/ASA research)
//   dual     — two-point: quiet room + indoor voice, averaged (recommended)
//   quiet    — quiet room only (single-point)
//   voice    — indoor voice at 1m only (single-point)
//   manual   — direct offset entry
//
// Two-point math:
//   For each measurement: offset_i = target_i_dBSPL − measured_dBFS_i
//   Final offset = mean(offset_1, offset_2) when both steps complete.
//   If only one step done, use that step's offset.
//   If the two offsets diverge by >5 dB, display a warning (AGC or room issue).

window.openCalModal = function() {
    calRefreshDisplay();
    calSelectTab(calGetMethod() === 'default' ? 'default' :
                 calGetMethod() === 'dual'    ? 'dual'    :
                 calGetMethod());
    showModal('calModal');
    calLiveStart();
};

// ── Persistent offset helpers (in utils.js: calGetOffset/calSetOffset) ────────

function calRefreshDisplay() {
    var offset = calGetOffset();
    var method = calGetMethod();
    var el = $('calOffsetDisplay');
    if (el) el.textContent = (offset >= 0 ? '+' : '') + offset.toFixed(1) + ' dB';
    var mel = $('calMethodDisplay');
    if (mel) {
        var labels = {
            default: 'Platform default',
            dual:    'Two-point (quiet + voice)',
            quiet:   'Quiet room only',
            voice:   'Indoor voice only',
            manual:  'Manual',
        };
        mel.textContent = labels[method] || method;
    }
    if ($('calManualSlider')) $('calManualSlider').value = offset.toFixed(1);
    if ($('calManualRange'))  $('calManualRange').value  = offset.toFixed(1);
}

// ── Tab switching ─────────────────────────────────────────────────────────────

window.calSelectTab = function(tab) {
    ['Default','Dual','Quiet','Voice','Manual'].forEach(function(p) {
        var panel = $('calPanel' + p);
        var btn   = $('calTab'   + p);
        if (!panel || !btn) return;
        var active = p.toLowerCase() === tab;
        panel.style.display = active ? '' : 'none';
        btn.className = active ? 'btn-sm' : 'btn-sm btn-secondary';
    });
};

// ── Platform default ──────────────────────────────────────────────────────────

window.calApplyDefault = function(type) {
    var offset = type === 'ios' ? 105 : type === 'android' ? 95 : calDefaultOffset();
    calSetOffset(offset);
    calSetMethod('default');
    calRefreshDisplay();
    statusRec('success', '✅ Calibration: +' + offset.toFixed(1) + ' dB (' + type + ' default)');
};

// ── Audio capture helper ──────────────────────────────────────────────────────
// Captures `secs` seconds of microphone audio with all processing disabled.
// Returns a Float32Array of PCM samples.

function calCapture(secs, onProgress) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
        return Promise.reject(new Error('Microphone not available'));

    return navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    }).then(function(stream) {
        var ctx    = new (window.AudioContext || window.webkitAudioContext)();
        var src    = ctx.createMediaStreamSource(stream);
        var bufSize = 4096;
        var proc   = ctx.createScriptProcessor(bufSize, 1, 1);
        var chunks = [];
        var startMs = Date.now();

        return new Promise(function(resolve, reject) {
            proc.onaudioprocess = function(e) {
                var buf = e.inputBuffer.getChannelData(0);
                chunks.push(new Float32Array(buf));
                var elapsed = (Date.now() - startMs) / 1000;
                if (onProgress) onProgress(Math.min(elapsed / secs, 1.0));
                if (elapsed >= secs) {
                    proc.disconnect(); src.disconnect();
                    stream.getTracks().forEach(function(t) { t.stop(); });
                    ctx.close();
                    // Concatenate
                    var total = chunks.reduce(function(s,c) { return s+c.length; }, 0);
                    var out   = new Float32Array(total);
                    var off2  = 0;
                    chunks.forEach(function(c) { out.set(c, off2); off2 += c.length; });
                    resolve(out);
                }
            };
            src.connect(proc);
            proc.connect(ctx.destination);
        });
    });
}

// Compute dBFS from a Float32Array (RMS, unweighted)
function calRmsDbfs(samples) {
    var sum2 = 0;
    for (var i = 0; i < samples.length; i++) sum2 += samples[i] * samples[i];
    var rms = Math.sqrt(sum2 / Math.max(samples.length, 1));
    return rms < 1e-12 ? -96 : 20 * Math.log10(rms);
}

// ── Two-point calibration state ───────────────────────────────────────────────

var _dualOffsets = { step1: null, step2: null };  // null = not yet measured

function dualUpdateResult() {
    var o1  = _dualOffsets.step1;
    var o2  = _dualOffsets.step2;
    var box = $('dualResultBox');
    var txt = $('dualResultText');
    if (!box || !txt) return;

    var lines = [];
    if (o1 !== null) lines.push('Quiet room:&nbsp; <strong>' + (o1 >= 0?'+':'') + o1.toFixed(1) + ' dB</strong>');
    if (o2 !== null) lines.push('Indoor voice:&nbsp; <strong>' + (o2 >= 0?'+':'') + o2.toFixed(1) + ' dB</strong>');

    if (o1 !== null && o2 !== null) {
        var avg  = (o1 + o2) / 2;
        var diff = Math.abs(o1 - o2);
        lines.push('Average: <strong style="color:#f5a623;">' + (avg >= 0?'+':'') + avg.toFixed(1) + ' dB</strong>');
        if (diff > 5) {
            lines.push('<span style="color:#e74c3c;">⚠ Steps differ by ' + diff.toFixed(1) +
                ' dB (>5 dB). AGC may be active, or room acoustics are unusual. ' +
                'Consider retrying in a different environment.</span>');
        } else {
            lines.push('<span style="color:#2ecc71;">✓ Steps agree within ' + diff.toFixed(1) + ' dB — good calibration.</span>');
        }
    } else if (o1 !== null || o2 !== null) {
        var single = o1 !== null ? o1 : o2;
        lines.push('Single-point offset: <strong style="color:#f5a623;">' +
            (single >= 0?'+':'') + single.toFixed(1) + ' dB</strong>');
        lines.push('<span style="color:#aaa;">(Complete both steps for better accuracy.)</span>');
    }

    if (lines.length > 0) {
        box.style.display = '';
        txt.innerHTML = lines.join('<br>');
    } else {
        box.style.display = 'none';
    }
}

window.dualRunStep = function(step) {
    var isQuiet  = step === 1;
    var targetEl = isQuiet ? $('dualQuietTarget') : $('dualVoiceTarget');
    var secsEl   = isQuiet ? $('dualQuietSecs')   : $('dualVoiceSecs');
    var statusEl = isQuiet ? $('dualQuietStatus') : $('dualVoiceStatus');
    var badgeEl  = isQuiet ? $('dualStep1Badge')  : $('dualStep2Badge');
    var btnEl    = isQuiet ? $('dualQuietBtn')    : $('dualVoiceBtn');
    var dfltDb   = isQuiet ? 35 : 60;

    var targetDb = targetEl ? (parseFloat(targetEl.value) || dfltDb) : dfltDb;
    var secs     = secsEl   ? (parseInt(secsEl.value)     || 5)      : 5;

    if (statusEl) statusEl.textContent = '🎙 Starting measurement…';
    if (btnEl)    btnEl.disabled = true;
    if (badgeEl)  { badgeEl.textContent = 'measuring…'; badgeEl.style.background='rgba(245,166,35,.2)'; badgeEl.style.color='#f5a623'; }

    calCapture(secs, function(frac) {
        if (statusEl) statusEl.textContent = '🎙 ' + Math.round(frac * 100) + '% captured…';
    }).then(function(samples) {
        var dbfs   = calRmsDbfs(samples);
        var offset = targetDb - dbfs;
        offset = Math.max(60, Math.min(140, offset));
        _dualOffsets[isQuiet ? 'step1' : 'step2'] = offset;

        if (statusEl) statusEl.textContent =
            '✅ Measured dBFS=' + dbfs.toFixed(1) + '  →  offset=' +
            (offset >= 0?'+':'') + offset.toFixed(1) + ' dB';
        if (badgeEl) {
            badgeEl.textContent = '✓ done';
            badgeEl.style.background = 'rgba(46,204,113,.2)';
            badgeEl.style.color = '#2ecc71';
        }
        if (btnEl) btnEl.disabled = false;
        dualUpdateResult();
    }).catch(function(e) {
        if (statusEl) statusEl.textContent = '❌ ' + e.message;
        if (badgeEl)  { badgeEl.textContent = 'error'; badgeEl.style.color='#e74c3c'; }
        if (btnEl)    btnEl.disabled = false;
    });
};

window.dualApplyResult = function() {
    var o1 = _dualOffsets.step1;
    var o2 = _dualOffsets.step2;
    var final;
    if (o1 !== null && o2 !== null)  final = (o1 + o2) / 2;
    else if (o1 !== null)            final = o1;
    else if (o2 !== null)            final = o2;
    else                             return;
    final = Math.max(60, Math.min(140, final));
    calSetOffset(final);
    calSetMethod('dual');
    calRefreshDisplay();
    var steps = (o1 !== null && o2 !== null) ? 'two-point average' : 'single-point';
    statusRec('success', '✅ Two-point calibration applied: +' + final.toFixed(1) + ' dB (' + steps + ')');
    hideModal('calModal');
};

// ── Single-step capture (quiet / voice tabs) ──────────────────────────────────

window.calRunCapture = function(mode) {
    var targetEl = mode === 'quiet' ? $('calQuietTarget') : $('calVoiceTarget');
    var statusEl = mode === 'quiet' ? $('calQuietStatus') : $('calVoiceStatus');
    var btnEl    = mode === 'quiet' ? $('calQuietBtn')    : $('calVoiceBtn');
    var dfltDb   = mode === 'quiet' ? 35 : 60;
    var targetDb = targetEl ? (parseFloat(targetEl.value) || dfltDb) : dfltDb;
    var secs     = 5;

    if (statusEl) statusEl.textContent = '🎙 Recording ' + secs + 's…';
    if (btnEl)    btnEl.disabled = true;

    calCapture(secs, function(frac) {
        if (statusEl) statusEl.textContent = '🎙 ' + Math.round(frac * 100) + '% captured…';
    }).then(function(samples) {
        var dbfs   = calRmsDbfs(samples);
        var offset = Math.max(60, Math.min(140, targetDb - dbfs));
        calSetOffset(offset);
        calSetMethod(mode);
        calRefreshDisplay();
        if (statusEl) statusEl.textContent =
            '✅ Offset: +' + offset.toFixed(1) + ' dB  (dBFS=' + dbfs.toFixed(1) + ')';
        statusRec('success', '✅ Calibration offset: +' + offset.toFixed(1) + ' dB (' + mode + ')');
        if (btnEl) btnEl.disabled = false;
    }).catch(function(e) {
        if (statusEl) statusEl.textContent = '❌ ' + e.message;
        if (btnEl)    btnEl.disabled = false;
    });
};

// ── Manual tab ────────────────────────────────────────────────────────────────

window.calPreviewManual = function(v) {
    if ($('calManualRange'))  $('calManualRange').value = v;
    var el = $('calOffsetDisplay');
    if (el) el.textContent = (+v >= 0 ? '+' : '') + (+v).toFixed(1) + ' dB';
};

window.calSyncSlider = function(v) {
    if ($('calManualSlider')) $('calManualSlider').value = v;
    var el = $('calOffsetDisplay');
    if (el) el.textContent = (+v >= 0 ? '+' : '') + (+v).toFixed(1) + ' dB';
};

window.calApplyManual = function() {
    var v = parseFloat(($('calManualSlider') || {}).value || '105');
    calSetOffset(v);
    calSetMethod('manual');
    calRefreshDisplay();
    statusRec('success', '✅ Manual calibration offset: +' + v.toFixed(1) + ' dB');
    hideModal('calModal');
};

// ── Live level display in modal ───────────────────────────────────────────────
// Uses the existing worklet ring buffer (only active when recording is running).

var _calLiveTimer = null;

function calLiveStart() {
    clearInterval(_calLiveTimer);
    _calLiveTimer = setInterval(function() {
        var modal = $('calModal');
        if (!modal || !modal.classList.contains('active')) {
            clearInterval(_calLiveTimer); return;
        }
        var el = $('calLiveReading');
        if (!el) return;
        // If recording is active we have a live RMS in _lastTelemetry
        if (typeof workletNode !== 'undefined' && workletNode) {
            el.textContent = '(live monitoring active — see Live Signal panel)';
        } else {
            el.textContent = '— (start recording for live reading)';
        }
    }, 1000);
}
