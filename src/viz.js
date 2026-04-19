/**
 * viz.js — Visualization modal and Plotly plot renderer
 *
 * openVizModal(eventId)
 *   Opens the 📊 modal for a recorded event. Loads viz_data from IndexedDB.
 *   If no stored viz_data, runs detect() on the stored audio and backfills.
 *
 * renderVizPlot(container, vizData)
 *   Renders a three-panel Plotly diagnostic plot into `container`:
 *     Panel 1 — Spectrogram heatmap (0–300 Hz, Hot colorscale)
 *     Panel 2 — Confidence (green), AC strength (blue), masking factor (amber),
 *               noise masking fill (amber), threshold line (dashed),
 *               detected segments (red fill), detected_at marker (green line)
 *     Panel 3 — Full-signal autocorrelation with beat period marker
 *
 * vizData fields expected: sr, duration, detected, detected_at, bpm, strength,
 *   threshold, segments, times[], strengths[], confidences[], masking_factors[],
 *   context_masked_arr[], corrFull[], spec_freqs[], spec_times[], spec_z[][]
 */

// ─────────────────────────────────────────────────────────────────────────────
// VISUALIZATION MODAL
// ─────────────────────────────────────────────────────────────────────────────

var _currentVizData = null;   // viz data currently shown in modal

$("vizModalClose").addEventListener("click",  function(){ hideModal("vizModal"); });
$("vizModalDlClose").addEventListener("click", function(){ hideModal("vizModal"); });

$("vizModalDlJson").addEventListener("click", function(){
    if (!_currentVizData) return;
    var dt   = new Date(_currentVizData.wall_clock_ms);
    var stem = dt.toISOString().replace(/[:.]/g,"-").slice(0,19)+"_viz";
    // Omit spec_z from JSON export to keep it manageable; include separate spec file
    var payload = Object.assign({}, _currentVizData);
    delete payload.spec_z;  // exported separately below
    dlBlob(new Blob([JSON.stringify(payload, null, 2)],{type:"application/json"}), stem+".json");
});

$("vizModalDlPng").addEventListener("click", function(){
    if (!_currentVizData) return;
    var dt   = new Date(_currentVizData.wall_clock_ms);
    var stem = dt.toISOString().replace(/[:.]/g,"-").slice(0,19)+"_viz";
    Plotly.downloadImage($("vizModalPlot"),{format:"png",width:1400,height:860,filename:stem});
});

window.openVizModal = async function(eventId) {
    showModal("vizModal");
    $("vizModalTitle").textContent = "Loading visualization…";
    $("vizModalInfo").textContent  = "";
    $("vizModalPlot").innerHTML    = "";

    try {
        var ev = await idbGet("events", eventId);
        if (!ev) throw new Error("Event not found");

        var vd = null;
        if (ev.viz_id) {
            vd = await idbGet("viz_data", ev.viz_id);
        }

        // If no stored viz_data, compute on the fly from stored audio
        if (!vd && ev.audio_id) {
            $("vizModalInfo").textContent = "Computing visualization from audio…";
            var audioRec = await idbGet("audio", ev.audio_id);
            if (audioRec && audioRec.pcm_blob) {
                var buf = await audioRec.pcm_blob.arrayBuffer();
                var raw = parseWavToFloat32(buf);
                var res = await runDetectInWorker(raw);
                vd = {
                    wall_clock_iso:  ev.wall_clock_iso,
                    wall_clock_ms:   ev.wall_clock_ms,
                    reason:          ev.label,
                    sr:              SR,
                    duration:        res.duration,
                    detected:        res.detected,
                    detected_at:     res.detected_at,
                    bpm:             res.bpm,
                    strength:        res.strength,
                    threshold:       res.threshold,
                    segments:        res.segments,
                    times:           Array.from(res.times           || []),
                    strengths:       Array.from(res.strengths       || []),
                    confidences:     Array.from(res.confidences     || []),
                    masking_factors: Array.from(res.masking_factors || []),
                    corrFull:        Array.from(res.corrFull        || []),
                    masking_detected:     res.masking_detected,
                    masking_duration_s:   res.masking_duration_s,
                    mask_end_estimate:    res.mask_end_estimate,
                    throb_predates_mask:  res.throb_predates_mask,
                    mean_ac_while_masked: res.mean_ac_while_masked,
                    peak_masking_ratio:   res.peak_masking_ratio,
                    detection_method:     res.detection_method,
                    spec_freqs: res.spectrogram ? res.spectrogram.freqs : [],
                    spec_times: res.spectrogram ? res.spectrogram.times : [],
                    spec_z:     res.spectrogram ? res.spectrogram.z     : [],
                };
                // Backfill into IDB for next time
                try {
                    var newVizId = await idbAdd("viz_data", vd);
                    ev.viz_id = newVizId;
                    await idbPut("events", ev);
                } catch(e2) { console.warn("viz backfill failed:", e2); }
            }
        }

        if (!vd) throw new Error("No visualization data available for this event.");

        _currentVizData = vd;
        var dt = new Date(vd.wall_clock_ms);
        $("vizModalTitle").textContent = "Visualization — " + dt.toLocaleDateString() + " " + dt.toLocaleTimeString();
        $("vizModalInfo").textContent  =
            (vd.label||"") + "  |  BPM: " + (vd.bpm||0).toFixed(0)
            + "  |  Strength: " + (vd.strength||0).toFixed(3)
            + "  |  Method: " + (vd.detection_method||"—")
            + (vd.masking_detected ? "  |  ⚠ Masked " + (vd.masking_duration_s||0).toFixed(0) + "s" : "");

        renderVizPlot($("vizModalPlot"), vd);

    } catch(err) {
        $("vizModalTitle").textContent = "Error";
        $("vizModalInfo").textContent  = err.message;
    }
};

function renderVizPlot(container, vd) {
    var bg   = "#16213e", grid = "#2a3a5e", txt = "#ccc";
    var red  = "#e05252", amb  = "#f5a623";
    var SR_v = vd.sr || SR;
    var lagAxis = (vd.corrFull||[]).map(function(_,i){ return i/SR_v; });

    var traces = [];

    // ── Spectrogram ───────────────────────────────────────────────────────────
    if (vd.spec_z && vd.spec_z.length > 0) {
        traces.push({
            x: vd.spec_times, y: vd.spec_freqs, z: vd.spec_z,
            type:"heatmap", colorscale:"Hot", showscale:false,
            zmin:-80, zmax:-10, xaxis:"x", yaxis:"y", name:"Spectrogram"
        });
    }

    // ── Confidence + strength ─────────────────────────────────────────────────
    if (vd.confidences && vd.confidences.length) {
        traces.push({
            x: vd.times, y: vd.confidences,
            type:"scatter", mode:"lines",
            line:{color:"#2ecc71",width:1.5}, name:"Confidence",
            xaxis:"x2", yaxis:"y2"
        });
    }
    if (vd.strengths && vd.strengths.length) {
        traces.push({
            x: vd.times, y: vd.strengths,
            type:"scatter", mode:"lines+markers",
            marker:{size:4, color: vd.strengths.map(function(s){ return s>=(vd.threshold||0.40)?red:"#5588cc"; })},
            line:{color:"#5588cc",width:1.2}, name:"AC Strength",
            xaxis:"x2", yaxis:"y2"
        });
    }
    if (vd.context_masked_arr && vd.context_masked_arr.length) {
        traces.push({
            x: vd.times,
            y: vd.context_masked_arr.map(function(v){ return v*(vd.threshold||0.40)*0.8; }),
            type:"scatter", mode:"none",
            fill:"tozeroy", fillcolor:"rgba(245,166,35,0.18)",
            name:"Noise masking",
            xaxis:"x2", yaxis:"y2"
        });
    }
    if (vd.masking_factors && vd.masking_factors.length) {
        traces.push({
            x: vd.times, y: vd.masking_factors,
            type:"scatter", mode:"lines",
            line:{color:amb, width:1, dash:"dot"}, name:"Masking factor",
            xaxis:"x2", yaxis:"y2"
        });
    }
    // Threshold line
    var tMax = vd.duration || ((vd.times||[]).slice(-1)[0]||0);
    traces.push({
        x:[0, tMax], y:[vd.threshold||0.52, vd.threshold||0.52],
        type:"scatter", mode:"lines",
        line:{color:amb,dash:"dash",width:1.2}, name:"Threshold",
        xaxis:"x2", yaxis:"y2"
    });

    // ── Autocorrelation ───────────────────────────────────────────────────────
    if (vd.corrFull && vd.corrFull.length) {
        traces.push({
            x: lagAxis, y: vd.corrFull,
            type:"scatter", mode:"lines",
            line:{color:red,width:1.5}, name:"Autocorr",
            xaxis:"x3", yaxis:"y3"
        });
    }

    // Segment highlight shapes on strength panel
    var shapes = [
        {type:"line",x0:0,x1:1,xref:"paper",yref:"y",y0:80,y1:80,line:{color:amb,dash:"dot",width:0.8}},
        {type:"line",x0:0,x1:1,xref:"paper",yref:"y",y0:160,y1:160,line:{color:amb,dash:"dot",width:0.8}},
    ];
    (vd.segments||[]).forEach(function(seg){
        shapes.push({
            type:"rect", xref:"x2", yref:"paper",
            x0:seg.start, x1:seg.end, y0:0.34, y1:0.66,
            fillcolor:"rgba(224,82,82,0.15)", line:{width:0}
        });
    });
    if (vd.detected_at !== null && vd.detected_at !== undefined) {
        shapes.push({type:"line",xref:"x2",yref:"paper",x0:vd.detected_at,x1:vd.detected_at,y0:0.34,y1:0.66,line:{color:"#2ecc71",width:1.5}});
    }

    var layout = {
        paper_bgcolor:bg, plot_bgcolor:bg,
        font:{color:txt,size:10},
        height: 580,
        margin:{l:56,r:16,t:12,b:44},
        grid:{rows:3,columns:1,pattern:"independent"},
        xaxis: {gridcolor:grid,title:"Time (s)"},
        yaxis: {gridcolor:grid,title:"Hz",range:[0,300]},
        xaxis2:{gridcolor:grid,title:"Time (s)"},
        yaxis2:{gridcolor:grid,title:"Score",range:[0,1.05]},
        xaxis3:{gridcolor:grid,title:"Lag (s)",range:[0,Math.min(4,lagAxis[lagAxis.length-1]||4)]},
        yaxis3:{gridcolor:grid,title:"Autocorr"},
        legend:{x:1.01,y:1,bgcolor:"rgba(0,0,0,.5)",font:{size:9}},
        showlegend:true,
        shapes:shapes,
    };

    Plotly.newPlot(container, traces, layout, {responsive:true,displayModeBar:true});
}
