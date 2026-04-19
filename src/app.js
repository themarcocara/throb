/**
 * app.js — Main browser application entry point
 *
 * Initialises all modules and wires up the two-tab UI:
 *
 *   Tab 1 — File Analysis
 *     Web Audio API decodes the file to 16 kHz mono Float32Array.
 *     A Web Worker (src/dsp.js) runs detect() then enhance() off the main thread.
 *     Results are rendered with Plotly (three-panel diagnostic plot).
 *     Downloads: timestamps JSON, diagnostic PNG, raw/enhanced WAV or M4A,
 *                visualization JSON/PNG — all via src/download.js.
 *
 *   Tab 2 — Live Recording
 *     See src/recording.js for architecture details.
 *
 * Module load order (all via <script> tags in index.html):
 *   Plotly CDN → src/dsp.js (workerSrc) → src/worklet.js (workletSrc)
 *   → src/idb.js → src/download.js → src/viz.js → src/recording.js → src/app.js
 */

(function () {
"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// SHARED STATE
// ─────────────────────────────────────────────────────────────────────────────
var SR           = 16000;
var audioFile    = null;
var pcm          = null;
var detResult    = null;
var enhPCM       = null;
var diagnosticPlotDiv = null;
var worker       = null;   // DSP web worker (file analysis)

// Recording state
var audioCtx     = null;
var workletNode  = null;
var micStream    = null;
var wakeLock     = null;
var sessionId    = null;
var recStartMs   = 0;
var recTimerInterval = null;
var heartbeatInterval= null;
var confHistory  = [];     // last 60 confidence values for mini-graph
var currentEventId = null; // IDB id of pending event (awaiting audio snap)
var pendingAudioSnap = null; // { buffer, wallMs } received before IDB write completes

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function fmtTime(sec) {
    var m=Math.floor(sec/60), s=(sec%60).toFixed(2).padStart(5,"0");
    return String(m).padStart(2,"0")+":"+s;
}

function fmtDuration(ms) {
    var s=Math.floor(ms/1000), h=Math.floor(s/3600), m=Math.floor((s%3600)/60), ss=s%60;
    return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0")+":"+String(ss).padStart(2,"0");
}

function dlBlob(blob, name) {
    var a=Object.assign(document.createElement("a"),{href:URL.createObjectURL(blob),download:name});
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){URL.revokeObjectURL(a.href);},10000);
}

function stem() { return audioFile ? audioFile.name.replace(/\.[^.]+$/,"") : "throb"; }

function pcmToWav(samples, sr) {
    var n=samples.length,buf=new ArrayBuffer(44+n*2),v=new DataView(buf);
    function ws(o,s){for(var i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));}
    ws(0,"RIFF");v.setUint32(4,36+n*2,true);ws(8,"WAVE");ws(12,"fmt ");
    v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
    v.setUint32(24,sr,true);v.setUint32(28,sr*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);
    ws(36,"data");v.setUint32(40,n*2,true);
    for(var i=0;i<n;i++)v.setInt16(44+i*2,Math.max(-32768,Math.min(32767,Math.round(samples[i]*32767))),true);
    return new Blob([buf],{type:"audio/wav"});
}

function statusFile(type, msg) {
    var el=$("progressStatus");
    el.className="status "+type+" active";
    el.innerHTML=(type==="loading"?'<span class="spinner"></span>':"")+msg;
}

function statusRec(type, msg) {
    var el=$("recStatusMsg");
    el.className="status "+type+" active";
    el.innerHTML=(type==="loading"?'<span class="spinner"></span>':"")+msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB SWITCHING
// ─────────────────────────────────────────────────────────────────────────────
function switchTab(tab) {
    $("tabFile").classList.toggle("active", tab==="file");
    $("tabRec").classList.toggle("active",  tab==="rec");
    $("panelFile").classList.toggle("active", tab==="file");
    $("panelRec").classList.toggle("active",  tab==="rec");
    if (tab==="rec") { loadEventLog(); updateStorageBar(); }
}
window.switchTab = switchTab;

// ─────────────────────────────────────────────────────────────────────────────
// DSP WEB WORKER (file analysis — unchanged)
// ─────────────────────────────────────────────────────────────────────────────
function startWorker() {
    var src  = $("workerSrc").textContent;
    var blob = new Blob([src],{type:"application/javascript"});
    worker   = new Worker(URL.createObjectURL(blob));
    worker.onmessage = onWorkerMsg;
    worker.onerror   = function(e){statusFile("error","Worker error: "+e.message);};
    worker.postMessage({task:"ping"});
}

function onWorkerMsg(e) {
    var m=e.data;
    if (m.type==="ready") {
        $("initStatus").classList.remove("active");
        if (audioFile) $("analyzeBtn").disabled=false;
    } else if (m.type==="detected") {
        detResult=m.result;
        renderResults(detResult);
        if ($("enhanceToggle").checked) {
            statusFile("loading","Enhancing audio…");
            var buf=pcm.buffer.slice(0);
            worker.postMessage({task:"enhance",audio:buf,sampleRate:SR},[buf]);
        } else {
            $("analyzeBtn").disabled=false;
            updateFileTabDownloads(); statusFile("success","✓ Done!");
        }
    } else if (m.type==="enhanced") {
        onEnhancedReady(new Float32Array(m.audio));
        $("analyzeBtn").disabled=false;
        statusFile("success","✓ Detection and enhancement complete!");
    } else if (m.type==="error") {
        $("analyzeBtn").disabled=false;
        statusFile("error","Error: "+m.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE ANALYSIS — input, decode, analyze
// ─────────────────────────────────────────────────────────────────────────────
$("audioInput").addEventListener("change",function(e){pick(e.target.files[0]);});
var dz=$("dropZone");
dz.addEventListener("dragover",function(e){e.preventDefault();dz.style.background="rgba(224,82,82,.1)";});
dz.addEventListener("dragleave",function(){dz.style.background="";});
dz.addEventListener("drop",function(e){e.preventDefault();dz.style.background="";pick(e.dataTransfer.files[0]);});

function pick(file) {
    if(!file) return;
    audioFile=file;
    $("fileInfo").textContent="📁 "+file.name+"  ("+(file.size/1024/1024).toFixed(1)+" MB)";
    if(!$("initStatus").classList.contains("active")) $("analyzeBtn").disabled=false;
    $("resultsSection").classList.remove("active");
}

$("analyzeBtn").addEventListener("click",function(){
    if(!audioFile) return;
    $("analyzeBtn").disabled=true;
    $("resultsSection").classList.remove("active");
    $("audioPlayerSection").style.display="none";
    $("audioFormatBox").style.display="none";
    $("downloadAudio").style.display="none";
    $("downloadAll").style.display="none";
    enhPCM=null;
    statusFile("loading","Decoding audio…");
    audioFile.arrayBuffer().then(function(buf){
        var ctx=new (window.AudioContext||window.webkitAudioContext)({sampleRate:SR});
        return ctx.decodeAudioData(buf).then(function(ab){
            ctx.close();
            var nch=ab.numberOfChannels,len=ab.length;
            pcm=new Float32Array(len);
            for(var c=0;c<nch;c++){var ch=ab.getChannelData(c);for(var i=0;i<len;i++)pcm[i]+=ch[i];}
            if(nch>1) for(var i=0;i<len;i++) pcm[i]/=nch;
            updateFileTabDownloads(); statusFile("loading","Decoded "+ab.duration.toFixed(1)+"s — running DSP…");
            var buf2=pcm.buffer.slice(0);
            worker.postMessage({task:"detect",audio:buf2,sampleRate:SR},[buf2]);
        });
    }).catch(function(err){
        $("analyzeBtn").disabled=false;
        statusFile("error","Could not decode: "+err.message+" — try WAV or MP3 if MP4 fails.");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// RESULTS RENDERING (file analysis)
// ─────────────────────────────────────────────────────────────────────────────
function renderResults(r) {
    $("resultsSection").classList.add("active");
    if(r.detected){
        var maskCtx="";
        if(r.masking_detected){
            maskCtx="<div style='background:#1a2a0a;border:1px solid #f5a623;border-radius:4px;padding:8px 12px;margin-top:8px;font-size:.85em'>"
                +"<strong style='color:#f5a623'>&#9888; Masking detected before this event</strong><br>"
                +"Masking duration: ~"+r.masking_duration_s.toFixed(1)+"s"
                +(r.mask_end_estimate?" &nbsp;|&nbsp; Mask ended ~"+r.mask_end_estimate.toFixed(1)+"s":"")+"<br>"
                +"Throb during mask: "
                +(r.throb_predates_mask
                    ?"<strong style='color:#2ecc71'>PRESENT</strong> (AC="+(r.mean_ac_while_masked||0).toFixed(3)+")"
                    :"<strong style='color:#aaa'>UNCERTAIN</strong>")
                +" &nbsp;|&nbsp; Peak masking ratio: "+r.peak_masking_ratio.toFixed(2)+"x<br>"
                +"Method: <strong style='color:#e0e0e0'>"+(r.detection_method||"clear")+"</strong>"
                +" &nbsp;|&nbsp; SNR at detection: "+(r.masked_snr_at_detection||0).toFixed(1)+"x"
                +"</div>";
        }
        $("summaryBox").innerHTML="<p style='color:#2ecc71;font-weight:bold;margin-bottom:8px'>"
            +"\u2705 Throb detected at "+(r.detected_at!==null?r.detected_at.toFixed(2):"?")+"s"
            +" \u2014 "+r.segments.length+" segment(s), ~"+r.bpm.toFixed(0)+" BPM"
            +"  (strength "+r.strength.toFixed(3)+" / threshold "+r.threshold+")</p>"+maskCtx;
    } else {
        $("summaryBox").innerHTML="<p style='color:#e74c3c;font-weight:bold;margin-bottom:12px'>"
            +"\u274C No throb detected (strength "+r.strength.toFixed(3)+" below threshold "+r.threshold+")</p>";
    }
    $("segmentList").innerHTML=r.segments.length
        ? r.segments.map(function(s,i){
            return "<li>Segment "+(i+1)+": "+s.start.toFixed(2)+"s \u2192 "
                +s.end.toFixed(2)+"s  ("+(s.end-s.start).toFixed(1)+"s, ~"+s.bpm.toFixed(0)+" BPM)</li>";
          }).join("")
        : "<li style='color:#aaa'>No segments detected.</li>";
    renderPlots(r);
}

function renderPlots(r) {
    var bg="#16213e",grid="#2a3a5e",txt="#ccc",red="#e05252",amb="#f5a623";
    var lagAxis=r.corrFull.map(function(_,i){return i/SR;}),spec=r.spectrogram;
    Plotly.newPlot($("diagnosticsPlot"),[
        {x:spec.times,y:spec.freqs,z:spec.z,type:"heatmap",colorscale:"Hot",showscale:false,zmin:-80,zmax:-10,xaxis:"x",yaxis:"y"},
        {x:r.times,y:r.strengths,type:"scatter",mode:"lines+markers",
         marker:{size:5,color:r.strengths.map(function(s){return s>=r.threshold?red:"#5588cc";})},
         line:{color:"#5588cc",width:1.5},name:"AC Strength",xaxis:"x2",yaxis:"y2"},
        {x:r.times,y:(r.context_masked_arr||[]).map(function(v){return v*r.threshold*0.8;}),
         type:"scatter",mode:"none",fill:"tozeroy",fillcolor:"rgba(245,166,35,0.18)",
         name:"Noise masking",xaxis:"x2",yaxis:"y2"},
        {x:[r.times[0]||0,r.times[r.times.length-1]||r.duration],y:[r.threshold,r.threshold],
         type:"scatter",mode:"lines",line:{color:amb,dash:"dash",width:1.5},name:"Threshold",xaxis:"x2",yaxis:"y2"},
        {x:lagAxis,y:r.corrFull,type:"scatter",mode:"lines",line:{color:red,width:1.5},name:"Autocorr",xaxis:"x3",yaxis:"y3"}
    ],{
        paper_bgcolor:bg,plot_bgcolor:bg,font:{color:txt,size:11},height:720,
        margin:{l:60,r:20,t:24,b:50},grid:{rows:3,columns:1,pattern:"independent"},
        xaxis:{gridcolor:grid,title:"Time (s)"},yaxis:{gridcolor:grid,title:"Hz",range:[0,300]},
        xaxis2:{gridcolor:grid,title:"Time (s)"},yaxis2:{gridcolor:grid,title:"Strength"},
        xaxis3:{gridcolor:grid,title:"Lag (s)",range:[0,Math.min(4,lagAxis[lagAxis.length-1]||4)]},
        yaxis3:{gridcolor:grid,title:"Autocorr"},showlegend:false,
        shapes:[
            {type:"line",x0:0,x1:1,xref:"paper",yref:"y",y0:80,y1:80,line:{color:amb,dash:"dot",width:1}},
            {type:"line",x0:0,x1:1,xref:"paper",yref:"y",y0:160,y1:160,line:{color:amb,dash:"dot",width:1}},
            {type:"line",x0:0,x1:1,xref:"paper",yref:"y2",y0:r.threshold,y1:r.threshold,line:{color:amb,dash:"dash",width:1.5}}
        ]
    },{responsive:true,displayModeBar:false});
    diagnosticPlotDiv=$("diagnosticsPlot");
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOT — fetch external DSP sources, then initialise
// ─────────────────────────────────────────────────────────────────────────────
// External text/plain <script> tags don't populate .textContent in browsers.
// Fetch the source files and inject them so the Worker/Worklet loader works.
Promise.all([
    fetch("src/dsp.js").then(function(r){ return r.text(); }),
    fetch("src/worklet.js").then(function(r){ return r.text(); })
]).then(function(texts) {
    $("workerSrc").textContent  = texts[0];
    $("workletSrc").textContent = texts[1];
    startWorker();
}).catch(function(err) {
    $("initStatus").innerHTML = "❌ Failed to load DSP engine: " + err.message
        + "<br><small>Serve from a local server — <code>npx serve .</code> — not file://</small>";
    $("initStatus").className = "status error active";
});

}());
