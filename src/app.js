/**
 * app.js — Main browser application entry point
 *
 * Batch file analysis architecture:
 *   - batch[] array holds one job object per selected file
 *   - Each job: { file, pcm, detResult, enhPCM, status, error }
 *   - Processing is sequential (one Web Worker, one file at a time)
 *   - A sidebar file-list lets the user switch between any file's results
 *   - Per-file downloads and batch downloads share the same format checkboxes
 *
 * Module load order (all via <script> tags in index.html):
 *   Plotly CDN → src/dsp.js (workerSrc) → src/worklet.js (workletSrc)
 *   → src/idb.js → src/download.js → src/viz.js → src/recording.js → src/app.js
 */

"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// SHARED STATE
// ─────────────────────────────────────────────────────────────────────────────
var SR            = 16000;

// Batch state
var batch         = [];    // array of job objects
var activeIdx     = -1;    // which job is shown in the detail panel
var processingIdx = -1;    // which job is currently being processed

// Single-file compat aliases (used by download.js) — always point at active job
var audioFile     = null;
var pcm           = null;
var detResult     = null;
var enhPCM        = null;
var diagnosticPlotDiv = null;

// Worker
var worker        = null;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function statusFile(type, msg) {
    var el = $("progressStatus");
    el.className = "status " + type + " active";
    el.innerHTML = (type === "loading" ? '<span class="spinner"></span>' : "") + msg;
}

function stem() {
    return audioFile ? audioFile.name.replace(/\.[^.]+$/, "") : "throb";
}

function updateFileTabDownloads() {
    var hasAudio = pcm !== null;
    if (hasAudio) {
        $("audioFormatBox").style.display = "";
        $("downloadAudio").style.display  = "block";
        $("downloadAll").style.display    = "block";
    }
}

function onEnhancedReady(enhancedFloat32) {
    enhPCM = enhancedFloat32;
    // Store on active job too
    if (activeIdx >= 0) batch[activeIdx].enhPCM = enhPCM;
    var wav = pcmToWav(enhPCM, SR);
    $("audioPlayer").src = URL.createObjectURL(wav);
    $("audioPlayerSection").style.display = "";
    updateFileTabDownloads();
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB SWITCHING
// ─────────────────────────────────────────────────────────────────────────────
function switchTab(tab) {
    $("tabFile").classList.toggle("active", tab === "file");
    $("tabRec").classList.toggle("active",  tab === "rec");
    $("panelFile").classList.toggle("active", tab === "file");
    $("panelRec").classList.toggle("active",  tab === "rec");
    if (tab === "rec") { loadEventLog(); updateStorageBar(); }
}
window.switchTab = switchTab;

// ─────────────────────────────────────────────────────────────────────────────
// DSP WEB WORKER
// ─────────────────────────────────────────────────────────────────────────────
function startWorker() {
    var src  = $("workerSrc").textContent;
    var blob = new Blob([src], { type: "application/javascript" });
    worker   = new Worker(URL.createObjectURL(blob));
    worker.onmessage = onWorkerMsg;
    worker.onerror   = function(e) { statusFile("error", "Worker error: " + e.message); };
    worker.postMessage({ task: "ping" });
}

function onWorkerMsg(e) {
    var m = e.data;
    if (m.type === "ready") {
        $("initStatus").classList.remove("active");
        updateAnalyzeBtn();
    } else if (m.type === "detected") {
        onDetected(m.result);
    } else if (m.type === "enhanced") {
        onEnhancedReady(new Float32Array(m.audio));
        finishJob();
    } else if (m.type === "error") {
        onJobError(m.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// BATCH FILE MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
$("audioInput").addEventListener("change", function(e) { addFiles(e.target.files); });

var dz = $("dropZone");
dz.addEventListener("dragover",  function(e) { e.preventDefault(); dz.style.background = "rgba(224,82,82,.1)"; });
dz.addEventListener("dragleave", function()  { dz.style.background = ""; });
dz.addEventListener("drop", function(e) {
    e.preventDefault(); dz.style.background = "";
    addFiles(e.dataTransfer.files);
});

function addFiles(fileList) {
    var added = 0;
    for (var i = 0; i < fileList.length; i++) {
        var f = fileList[i];
        // Skip duplicates by name+size
        var dup = batch.some(function(j) { return j.file.name === f.name && j.file.size === f.size; });
        if (!dup) {
            batch.push({ file: f, pcm: null, detResult: null, enhPCM: null, status: "pending", error: null });
            added++;
        }
    }
    if (added > 0) {
        renderFileList();
        $("batchWorkspace").style.display = "";
        $("clearBatchBtn").style.display  = "";
        updateAnalyzeBtn();
        // Auto-select first file if nothing selected
        if (activeIdx < 0) selectFile(0);
    }
}

$("clearBatchBtn").addEventListener("click", function() {
    if (processingIdx >= 0) return; // don't clear while running
    batch = []; activeIdx = -1;
    renderFileList();
    $("batchWorkspace").style.display = "none";
    $("clearBatchBtn").style.display  = "none";
    $("batchDownloadBox").style.display = "none";
    showDetailEmpty();
    updateAnalyzeBtn();
    $("progressStatus").className = "status";
    $("audioInput").value = "";
});

function updateAnalyzeBtn() {
    var ready = $("workerSrc").textContent.length > 0 && !$("initStatus").classList.contains("active");
    var hasPending = batch.some(function(j) { return j.status === "pending"; });
    $("analyzeBtn").disabled = !ready || !hasPending;
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE LIST SIDEBAR
// ─────────────────────────────────────────────────────────────────────────────
function renderFileList() {
    var list = $("fileList");
    var total = batch.length;
    var done  = batch.filter(function(j) { return j.status === "detected" || j.status === "missed"; }).length;
    $("batchCountLabel").textContent = total + " file" + (total !== 1 ? "s" : "");
    $("batchProgressLabel").textContent = total > 0 ? done + "/" + total + " done" : "";

    list.innerHTML = batch.map(function(job, idx) {
        var badgeClass = job.status;
        var badgeText  = { pending:"—", running:"…", detected:"✓", missed:"✗", error:"!" }[job.status] || "?";
        var isActive   = idx === activeIdx ? " active" : "";
        var name = job.file.name;
        // Truncate long names for the sidebar
        var display = name.length > 28 ? name.slice(0,25) + "…" : name;
        return "<div class='file-item" + isActive + "' onclick='selectFile(" + idx + ")' title='" + name + "'>"
             + "<span class='fi-name'>" + display + "</span>"
             + "<span class='fi-badge " + badgeClass + "'>" + badgeText + "</span>"
             + "</div>";
    }).join("");

    // Show batch download box once any file is done
    var anyDone = batch.some(function(j) { return j.detResult !== null; });
    $("batchDownloadBox").style.display = anyDone ? "" : "none";
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE DETAIL PANEL
// ─────────────────────────────────────────────────────────────────────────────
function showDetailEmpty() {
    $("fileDetail").style.display      = "none";
    $("fileDetailEmpty").style.display = "";
}

window.selectFile = function(idx) {
    if (idx < 0 || idx >= batch.length) return;
    activeIdx = idx;
    renderFileList(); // refresh active highlight

    var job = batch[idx];
    // Update compat globals so download.js works
    audioFile = job.file;
    pcm       = job.pcm;
    detResult = job.detResult;
    enhPCM    = job.enhPCM;

    $("fileDetail").style.display      = "";
    $("fileDetailEmpty").style.display = "none";

    // File header
    $("detailFileName").textContent = job.file.name;
    $("detailBadge").innerHTML = badgeHtml(job);

    // Nav buttons
    $("detailPrevBtn").disabled = idx === 0;
    $("detailNextBtn").disabled = idx === batch.length - 1;

    // Results
    if (job.detResult) {
        renderResults(job.detResult);
        updateFileTabDownloads();
    } else {
        // No results yet — clear the panel
        $("summaryBox").innerHTML = "";
        $("segmentList").innerHTML = "";
        $("audioPlayerSection").style.display = "none";
        $("audioFormatBox").style.display = "none";
        $("downloadAudio").style.display = "none";
        $("downloadAll").style.display = "none";
        if (job.status === "running") {
            $("summaryBox").innerHTML = "<p style='color:#f5a623'><span class='spinner'></span>Processing…</p>";
        } else if (job.status === "error") {
            $("summaryBox").innerHTML = "<p style='color:#e74c3c'>❌ " + (job.error || "Unknown error") + "</p>";
        }
    }

    // Audio player
    if (job.enhPCM) {
        var wav = pcmToWav(job.enhPCM, SR);
        $("audioPlayer").src = URL.createObjectURL(wav);
        $("audioPlayerSection").style.display = "";
    } else {
        $("audioPlayer").src = "";
        $("audioPlayerSection").style.display = "none";
    }
};

function badgeHtml(job) {
    var map = {
        pending:  { cls:"badge-grey",  text:"Pending" },
        running:  { cls:"badge-amber", text:"Processing…" },
        detected: { cls:"badge-green", text:"✓ Detected" },
        missed:   { cls:"badge",       text:"✗ Not detected", style:"background:rgba(231,76,60,.2);color:#e74c3c;border:1px solid #e74c3c;" },
        error:    { cls:"badge",       text:"⚠ Error",        style:"background:rgba(231,76,60,.15);color:#e67e22;border:1px solid #e67e22;" },
    };
    var b = map[job.status] || map.pending;
    return "<span class='badge " + b.cls + "'" + (b.style ? " style='" + b.style + "'" : "") + ">" + b.text + "</span>";
}

$("detailPrevBtn").addEventListener("click", function() { if (activeIdx > 0) selectFile(activeIdx - 1); });
$("detailNextBtn").addEventListener("click", function() { if (activeIdx < batch.length-1) selectFile(activeIdx + 1); });

// ─────────────────────────────────────────────────────────────────────────────
// BATCH PROCESSING
// ─────────────────────────────────────────────────────────────────────────────
$("analyzeBtn").addEventListener("click", function() {
    $("analyzeBtn").disabled = true;
    processNext();
});

function processNext() {
    // Find the next pending job
    var idx = batch.findIndex(function(j) { return j.status === "pending"; });
    if (idx < 0) {
        // All done
        processingIdx = -1;
        statusFile("success", "✓ Batch complete — " + batch.length + " file(s) processed.");
        renderFileList();
        updateAnalyzeBtn();
        return;
    }
    processingIdx = idx;
    batch[idx].status = "running";
    renderFileList();

    // Show this file in the detail panel while it's processing
    selectFile(idx);

    var remaining = batch.filter(function(j) { return j.status === "pending"; }).length;
    statusFile("loading", "Processing " + batch[idx].file.name
        + " (" + (batch.length - remaining) + "/" + batch.length + ")…");

    decodeAndAnalyze(idx);
}

function decodeAndAnalyze(idx) {
    var job = batch[idx];
    job.file.arrayBuffer().then(function(buf) {
        var ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SR });
        return ctx.decodeAudioData(buf).then(function(ab) {
            ctx.close();
            var nch = ab.numberOfChannels, len = ab.length;
            var samples = new Float32Array(len);
            for (var c = 0; c < nch; c++) {
                var ch = ab.getChannelData(c);
                for (var i = 0; i < len; i++) samples[i] += ch[i];
            }
            if (nch > 1) for (var i = 0; i < len; i++) samples[i] /= nch;
            job.pcm = samples;
            pcm = samples; // keep compat alias in sync
            statusFile("loading", "Decoded " + ab.duration.toFixed(1) + "s — running DSP…");
            var buf2 = samples.buffer.slice(0);
            worker.postMessage({ task: "detect", audio: buf2, sampleRate: SR }, [buf2]);
        });
    }).catch(function(err) {
        onJobError("Could not decode: " + err.message);
    });
}

function onDetected(result) {
    var idx = processingIdx;
    if (idx < 0) return;
    var job = batch[idx];
    job.detResult = result;
    detResult = result; // compat alias

    // Render immediately so the user can see it while enhancement runs
    if (activeIdx === idx) {
        renderResults(result);
        updateFileTabDownloads();
    }

    if ($("enhanceToggle").checked) {
        statusFile("loading", "Enhancing " + job.file.name + "…");
        var buf = job.pcm.buffer.slice(0);
        worker.postMessage({ task: "enhance", audio: buf, sampleRate: SR }, [buf]);
    } else {
        finishJob();
    }
}

function finishJob() {
    var idx = processingIdx;
    if (idx < 0) return;
    var job = batch[idx];
    job.status = job.detResult && job.detResult.detected ? "detected" : "missed";
    renderFileList();

    // Refresh the detail panel if still showing this job
    if (activeIdx === idx) {
        $("detailBadge").innerHTML = badgeHtml(job);
        updateFileTabDownloads();
    }

    processNext(); // move to next pending file
}

function onJobError(msg) {
    var idx = processingIdx;
    if (idx < 0) { statusFile("error", msg); return; }
    batch[idx].status = "error";
    batch[idx].error  = msg;
    if (activeIdx === idx) {
        $("detailBadge").innerHTML = badgeHtml(batch[idx]);
        $("summaryBox").innerHTML = "<p style='color:#e74c3c'>❌ " + msg + "</p>";
    }
    renderFileList();
    statusFile("error", batch[idx].file.name + ": " + msg);
    processNext();
}

// ─────────────────────────────────────────────────────────────────────────────
// RESULTS RENDERING
// ─────────────────────────────────────────────────────────────────────────────
function renderResults(r) {
    if (r.detected) {
        var maskCtx = "";
        if (r.masking_detected) {
            maskCtx = "<div style='background:#1a2a0a;border:1px solid #f5a623;border-radius:4px;padding:8px 12px;margin-top:8px;font-size:.85em'>"
                + "<strong style='color:#f5a623'>&#9888; Masking detected before this event</strong><br>"
                + "Duration: ~" + r.masking_duration_s.toFixed(1) + "s"
                + (r.mask_end_estimate ? " &nbsp;|&nbsp; Ended ~" + r.mask_end_estimate.toFixed(1) + "s" : "") + "<br>"
                + "Throb during mask: "
                + (r.throb_predates_mask
                    ? "<strong style='color:#2ecc71'>PRESENT</strong> (AC=" + (r.mean_ac_while_masked||0).toFixed(3) + ")"
                    : "<strong style='color:#aaa'>UNCERTAIN</strong>")
                + " &nbsp;|&nbsp; Peak ratio: " + r.peak_masking_ratio.toFixed(2) + "x"
                + "</div>";
        }
        $("summaryBox").innerHTML = "<p style='color:#2ecc71;font-weight:bold;margin-bottom:8px'>"
            + "\u2705 Throb detected at " + (r.detected_at !== null ? r.detected_at.toFixed(2) : "?") + "s"
            + " \u2014 " + r.segments.length + " segment(s), ~" + r.bpm.toFixed(0) + " BPM"
            + "  (strength " + r.strength.toFixed(3) + " / threshold " + r.threshold + ")</p>" + maskCtx;
    } else {
        $("summaryBox").innerHTML = "<p style='color:#e74c3c;font-weight:bold;margin-bottom:12px'>"
            + "\u274C No throb detected (strength " + r.strength.toFixed(3) + " below threshold " + r.threshold + ")</p>";
    }
    $("segmentList").innerHTML = r.segments.length
        ? r.segments.map(function(s, i) {
            return "<li>Segment " + (i+1) + ": " + s.start.toFixed(2) + "s \u2192 "
                + s.end.toFixed(2) + "s  (" + (s.end-s.start).toFixed(1) + "s, ~" + s.bpm.toFixed(0) + " BPM)</li>";
          }).join("")
        : "<li style='color:#aaa'>No segments detected.</li>";
    renderPlots(r);
}

function renderPlots(r) {
    var bg = "#16213e", grid = "#2a3a5e", txt = "#ccc", red = "#e05252", amb = "#f5a623";
    var lagAxis = r.corrFull.map(function(_, i) { return i / SR; });
    var spec = r.spectrogram;
    Plotly.newPlot($("diagnosticsPlot"), [
        { x:spec.times, y:spec.freqs, z:spec.z, type:"heatmap",
          colorscale:"Hot", showscale:true,
          zmin:spec.zmin, zmax:spec.zmax,
          colorbar:{ title:{text:"dB",side:"right"}, thickness:12, len:0.33, y:0.83,
                     tickfont:{size:9,color:txt}, titlefont:{size:10,color:txt} },
          xaxis:"x", yaxis:"y" },
        { x:r.times, y:r.strengths, type:"scatter", mode:"lines+markers",
          marker:{ size:5, color:r.strengths.map(function(s){ return s>=r.threshold ? red : "#5588cc"; }) },
          line:{ color:"#5588cc", width:1.5 }, name:"AC Strength", xaxis:"x2", yaxis:"y2" },
        { x:r.times, y:(r.context_masked_arr||[]).map(function(v){ return v*r.threshold*0.8; }),
          type:"scatter", mode:"none", fill:"tozeroy", fillcolor:"rgba(245,166,35,0.18)",
          name:"Noise masking", xaxis:"x2", yaxis:"y2" },
        { x:[r.times[0]||0, r.times[r.times.length-1]||r.duration], y:[r.threshold, r.threshold],
          type:"scatter", mode:"lines", line:{ color:amb, dash:"dash", width:1.5 },
          name:"Threshold", xaxis:"x2", yaxis:"y2" },
        { x:lagAxis, y:r.corrFull, type:"scatter", mode:"lines",
          line:{ color:red, width:1.5 }, name:"Autocorr", xaxis:"x3", yaxis:"y3" }
    ], {
        paper_bgcolor:bg, plot_bgcolor:bg, font:{ color:txt, size:11 }, height:660,
        margin:{ l:56, r:16, t:16, b:44 },
        grid:{ rows:3, columns:1, pattern:"independent" },
        xaxis:  { gridcolor:grid, title:"Time (s)" },
        yaxis:  { gridcolor:grid, title:"Hz", range:[0,500] },
        xaxis2: { gridcolor:grid, title:"Time (s)" },
        yaxis2: { gridcolor:grid, title:"Strength" },
        xaxis3: { gridcolor:grid, title:"Lag (s)", range:[0, Math.min(4, lagAxis[lagAxis.length-1]||4)] },
        yaxis3: { gridcolor:grid, title:"Autocorr" },
        showlegend:false,
        shapes: [
            { type:"rect", x0:0, x1:1, xref:"paper", yref:"y",
              y0:80, y1:160, fillcolor:"rgba(245,166,35,0.07)", line:{width:0} },
            { type:"line", x0:0, x1:1, xref:"paper", yref:"y",   y0:80,  y1:80,  line:{ color:amb, dash:"dot",  width:1   } },
            { type:"line", x0:0, x1:1, xref:"paper", yref:"y",   y0:160, y1:160, line:{ color:amb, dash:"dot",  width:1   } },
            { type:"line", x0:0, x1:1, xref:"paper", yref:"y2",  y0:r.threshold, y1:r.threshold, line:{ color:amb, dash:"dash", width:1.5 } }
        ]
    }, { responsive:true, displayModeBar:true, displaylogo:false,
         modeBarButtonsToRemove:["lasso2d","select2d"] });
    diagnosticPlotDiv = $("diagnosticsPlot");
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-FILE DOWNLOADS
// ─────────────────────────────────────────────────────────────────────────────
$("downloadJson").addEventListener("click", function() {
    if (!detResult) return;
    var base = new Date(audioFile.lastModified);
    var json = detResult.segments.map(function(s, i) { return {
        index: i+1,
        start_seconds: +s.start.toFixed(3), end_seconds: +s.end.toFixed(3),
        start_iso: new Date(base.getTime() + s.start*1000).toISOString(),
        end_iso:   new Date(base.getTime() + s.end*1000).toISOString(),
        duration_seconds: +(s.end-s.start).toFixed(3), bpm: +s.bpm.toFixed(1)
    }; });
    dlBlob(new Blob([JSON.stringify(json, null, 2)], { type:"application/json" }), stem() + "_timestamps.json");
});

$("downloadDiag").addEventListener("click", function() {
    if (diagnosticPlotDiv)
        Plotly.downloadImage(diagnosticPlotDiv, { format:"png", width:1400, height:860, filename: stem()+"_diagnostic" });
});

$("downloadAudio").addEventListener("click", async function() {
    if (!pcm) return;
    await buildAndDownload(pcm, enhPCM, stem(), statusFile);
});

$("downloadAll").addEventListener("click", async function() {
    if (!detResult) return;
    statusFile("loading", "Building zip for " + stem() + "…");
    var opts = {
        wantRaw:      $("chkRawAudio").checked,
        wantEnhanced: $("chkEnhancedAudio").checked,
        wantEncoded:  $("chkEncodedAudio").checked,
        wantViz:      $("chkVizData").checked,
    };
    if (opts.wantViz && detResult) {
        opts.vizData = buildFileVizData(detResult, audioFile);
    }
    var audioFiles = await collectAudioFiles(pcm, enhPCM, stem(), opts, statusFile);
    var base = new Date(audioFile.lastModified);
    var jsonData = detResult.segments.map(function(s, i) { return {
        index:i+1, start_seconds:+s.start.toFixed(3), end_seconds:+s.end.toFixed(3),
        start_iso:new Date(base.getTime()+s.start*1000).toISOString(),
        end_iso:new Date(base.getTime()+s.end*1000).toISOString(),
        duration_seconds:+(s.end-s.start).toFixed(3), bpm:+s.bpm.toFixed(1)
    }; });
    var jsonBlob = new Blob([JSON.stringify(jsonData, null, 2)], { type:"application/json" });
    var vizFiles = buildVizFiles(opts, detResult, audioFile, stem());
    var allFiles = [{ name:stem()+"_timestamps.json", blob:jsonBlob }].concat(audioFiles).concat(vizFiles);
    statusFile("loading", "Compressing " + allFiles.length + " files…");
    var zipBlob = await buildZip(allFiles);
    dlBlob(zipBlob, stem() + "_throb_results.zip");
    statusFile("success", "✓ Downloaded zip with " + allFiles.length + " file(s).");
});

// ─────────────────────────────────────────────────────────────────────────────
// BATCH DOWNLOADS
// ─────────────────────────────────────────────────────────────────────────────
$("downloadBatchJson").addEventListener("click", async function() {
    var doneBatch = batch.filter(function(j) { return j.detResult !== null; });
    if (!doneBatch.length) return;
    if (doneBatch.length === 1) {
        // Single file — download directly
        var j = doneBatch[0]; var s = j.file.name.replace(/\.[^.]+$/,"");
        var base = new Date(j.file.lastModified);
        var arr = j.detResult.segments.map(function(seg,i){return{
            index:i+1,start_seconds:+seg.start.toFixed(3),end_seconds:+seg.end.toFixed(3),
            start_iso:new Date(base.getTime()+seg.start*1000).toISOString(),
            end_iso:new Date(base.getTime()+seg.end*1000).toISOString(),
            duration_seconds:+(seg.end-seg.start).toFixed(3),bpm:+seg.bpm.toFixed(1)
        };});
        dlBlob(new Blob([JSON.stringify(arr,null,2)],{type:"application/json"}), s+"_timestamps.json");
        return;
    }
    // Multiple files — one JSON with all results
    var combined = doneBatch.map(function(j) {
        var base = new Date(j.file.lastModified);
        return {
            file: j.file.name,
            detected: j.detResult.detected,
            bpm: +j.detResult.bpm.toFixed(1),
            strength: +j.detResult.strength.toFixed(4),
            masking_detected: j.detResult.masking_detected,
            detection_method: j.detResult.detection_method,
            segments: j.detResult.segments.map(function(s,i){return{
                index:i+1,start_seconds:+s.start.toFixed(3),end_seconds:+s.end.toFixed(3),
                start_iso:new Date(base.getTime()+s.start*1000).toISOString(),
                end_iso:new Date(base.getTime()+s.end*1000).toISOString(),
                duration_seconds:+(s.end-s.start).toFixed(3),bpm:+s.bpm.toFixed(1)
            };})
        };
    });
    dlBlob(new Blob([JSON.stringify(combined,null,2)],{type:"application/json"}), "throb_batch_timestamps.json");
});

$("downloadBatchAll").addEventListener("click", async function() {
    var doneBatch = batch.filter(function(j) { return j.detResult !== null; });
    if (!doneBatch.length) return;
    statusFile("loading", "Building batch zip…");
    var opts = {
        wantRaw:      $("chkRawAudio").checked,
        wantEnhanced: $("chkEnhancedAudio").checked,
        wantEncoded:  $("chkEncodedAudio").checked,
        wantViz:      $("chkVizData").checked,
    };
    var allFiles = [];
    for (var ji = 0; ji < doneBatch.length; ji++) {
        var j = doneBatch[ji];
        var s = j.file.name.replace(/\.[^.]+$/,"");
        statusFile("loading", "Packaging " + j.file.name + " (" + (ji+1) + "/" + doneBatch.length + ")…");
        // Timestamps JSON
        var base = new Date(j.file.lastModified);
        var arr = j.detResult.segments.map(function(seg,i){return{
            index:i+1,start_seconds:+seg.start.toFixed(3),end_seconds:+seg.end.toFixed(3),
            start_iso:new Date(base.getTime()+seg.start*1000).toISOString(),
            end_iso:new Date(base.getTime()+seg.end*1000).toISOString(),
            duration_seconds:+(seg.end-seg.start).toFixed(3),bpm:+seg.bpm.toFixed(1)
        };});
        allFiles.push({ name: s+"_timestamps.json",
                        blob: new Blob([JSON.stringify(arr,null,2)],{type:"application/json"}) });
        // Audio files
        if (j.pcm) {
            var audioFs = await collectAudioFiles(j.pcm, j.enhPCM, s, opts, statusFile);
            allFiles = allFiles.concat(audioFs);
        }
        // Viz
        if (opts.wantViz && j.detResult) {
            opts.vizData = buildFileVizData(j.detResult, j.file);
            allFiles = allFiles.concat(buildVizFiles(opts, j.detResult, j.file, s));
        }
    }
    statusFile("loading", "Compressing " + allFiles.length + " files…");
    var zipBlob = await buildZip(allFiles);
    dlBlob(zipBlob, "throb_batch_results.zip");
    statusFile("success", "✓ Batch zip: " + allFiles.length + " files from " + doneBatch.length + " recordings.");
});

// ─────────────────────────────────────────────────────────────────────────────
// DOWNLOAD HELPERS (extend download.js)
// ─────────────────────────────────────────────────────────────────────────────
function buildFileVizData(r, file) {
    return {
        wall_clock_ms: file ? file.lastModified : Date.now(),
        reason:"file_analysis", sr:SR,
        duration:r.duration, detected:r.detected, detected_at:r.detected_at,
        bpm:r.bpm, strength:r.strength, threshold:r.threshold, segments:r.segments,
        times:           Array.from(r.times           ||[]),
        strengths:       Array.from(r.strengths       ||[]),
        confidences:     Array.from(r.confidences     ||[]),
        masking_factors: Array.from(r.masking_factors ||[]),
        context_masked_arr: Array.from(r.context_masked_arr||[]),
        corrFull:        Array.from(r.corrFull        ||[]),
        masking_detected:r.masking_detected, masking_duration_s:r.masking_duration_s,
        mask_end_estimate:r.mask_end_estimate, throb_predates_mask:r.throb_predates_mask,
        detection_method:r.detection_method,
        spec_freqs: r.spectrogram ? r.spectrogram.freqs : [],
        spec_times: r.spectrogram ? r.spectrogram.times : [],
        spec_z:     r.spectrogram ? r.spectrogram.z     : [],
        spec_zmin:  r.spectrogram ? r.spectrogram.zmin  : -80,
        spec_zmax:  r.spectrogram ? r.spectrogram.zmax  : -10,
    };
}

async function collectAudioFiles(rawPCM, enhancedPCM, stemName, opts, onStatus) {
    var files = [];
    var resolvedEnh = enhancedPCM;
    if (opts.wantEnhanced && !resolvedEnh && rawPCM) {
        try { resolvedEnh = new Float32Array(await runEnhanceInWorker(rawPCM)); } catch(e) {}
    }
    if (opts.wantRaw && rawPCM) {
        if (opts.wantEncoded) {
            var b = await exportM4a(rawPCM, SR, onStatus);
            if (b) files.push({ name: stemName+"_raw.m4a", blob:b });
        } else {
            files.push({ name: stemName+"_raw.wav", blob:pcmToWav(rawPCM, SR) });
        }
    }
    if (opts.wantEnhanced && resolvedEnh) {
        if (opts.wantEncoded) {
            var b2 = await exportM4a(resolvedEnh, SR, onStatus);
            if (b2) files.push({ name: stemName+"_enhanced.m4a", blob:b2 });
        } else {
            files.push({ name: stemName+"_enhanced.wav", blob:pcmToWav(resolvedEnh, SR) });
        }
    }
    return files;
}

function buildVizFiles(opts, r, file, stemName) {
    if (!opts.wantViz || !opts.vizData) return [];
    var files = [];
    var vd = opts.vizData;
    var noSpec = Object.assign({}, vd); delete noSpec.spec_z;
    files.push({ name: stemName+"_viz.json",
                 blob: new Blob([JSON.stringify(noSpec,null,2)],{type:"application/json"}) });
    if (vd.spec_z && vd.spec_z.length) {
        files.push({ name: stemName+"_spectrogram.json",
                     blob: new Blob([JSON.stringify({freqs:vd.spec_freqs,times:vd.spec_times,z:vd.spec_z})],{type:"application/json"}) });
    }
    // PNG rendered from current diagnosticsPlot if it's showing this file
    if (diagnosticPlotDiv && audioFile === file) {
        // PNG captured asynchronously — caller handles this in the ZIP flow
    }
    return files;
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
