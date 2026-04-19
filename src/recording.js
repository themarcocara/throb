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

$("startRecBtn").addEventListener("click", startRecording);
$("stopRecBtn").addEventListener("click",  stopRecording);
$("snapNowBtn").addEventListener("click",  function(){
    if(workletNode) workletNode.port.postMessage({type:"snapNow"});
});

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
        if(navigator.storage&&navigator.storage.persist){
            await navigator.storage.persist();
        }
        micStream=await navigator.mediaDevices.getUserMedia({
            audio:{ echoCancellation:false, noiseSuppression:false, autoGainControl:false }
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
        $("snapNowBtn").disabled=false;
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
        var wavBlob = pcmToWav(snapArr, SR);
        var audioId = await idbAdd("audio",{
            session_id:    sessionId,
            pcm_blob:      wavBlob,
            duration_s:    snapArr.length / SR,
            sample_rate:   SR,
            wall_clock_iso: m.wallClockIso,
            reason:        reason,
        });

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

        var eventRec = {
            session_id:            sessionId,
            wall_clock_iso:        m.wallClockIso,
            wall_clock_ms:         m.wallMs,
            label:                 reason,
            bpm:                   +(m.bpm||0).toFixed(1),
            strength:              +(m.strength||0).toFixed(4),
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
        };
        await idbAdd("events", eventRec);
        if($("panelRec").classList.contains("active")){
            loadEventLog(); updateStorageBar();
        }
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

// ── Mini confidence canvas ───────────────────────────────────────────────────
function drawConfCanvas() {
    var canvas=$("confCanvas"),dpr=window.devicePixelRatio||1;
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
        tbody.innerHTML=events.map(function(ev,i){
            var dt=new Date(ev.wall_clock_ms);
            var dateStr=dt.toLocaleDateString()+" "+dt.toLocaleTimeString();
            var maskBadge=ev.masking_detected
                ?"<span class='badge badge-amber'>Masked "+ev.masking_duration_s.toFixed(0)+"s</span>"
                :"<span class='badge badge-grey'>None</span>";
            var dur=ev.duration_s?(ev.duration_s.toFixed(1)+"s"):"—";
            var conf=ev.strength?(ev.strength.toFixed(3)):"—";
            var bpm=ev.bpm?ev.bpm.toFixed(0):"—";
            var chk=_selectedIds.has(ev.id)?"checked":"";
            return "<tr id='row-"+ev.id+"'>"
                +"<td><input type='checkbox' "+chk+" onchange='toggleSelect("+ev.id+",this.checked)' style='accent-color:#e05252;'></td>"
                +"<td><span style='color:"+typeColor(ev.label)+";font-size:.9em;'>"+typeLabel(ev.label)+"</span></td>"
                +"<td style='font-size:.8em;'>"+dateStr+"</td>"
                +"<td>"+bpm+"</td>"
                +"<td>"+conf+"</td>"
                +"<td>"+maskBadge+"</td>"
                +"<td>"+dur+"</td>"
                +"<td style='white-space:nowrap;'>"
                  +"<button class='btn-secondary btn-sm' onclick='openEnhanceModal("+ev.id+")'>▶ Play</button> "
                  +"<button class='btn-secondary btn-sm' onclick='openVizModal("+ev.id+")' title='View visualization'>📊</button> "
                  +"<button class='btn-secondary btn-sm' onclick='downloadEventWav("+ev.id+")' title='Download'>⬇</button> "
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
