/**
 * utils.js — Shared utilities loaded before all other modules
 *
 * Defines $ and small helpers used at module-level across recording.js,
 * download.js, viz.js, and app.js. Must be the first <script> after Plotly.
 */

"use strict";

// Element lookup — used at top level in all modules
function $(id) { return document.getElementById(id); }

// PCM → WAV blob
function pcmToWav(samples, sr) {
    var n=samples.length, buf=new ArrayBuffer(44+n*2), v=new DataView(buf);
    function ws(o,s){for(var i=0;i<s.length;i++) v.setUint8(o+i,s.charCodeAt(i));}
    ws(0,"RIFF"); v.setUint32(4,36+n*2,true); ws(8,"WAVE"); ws(12,"fmt ");
    v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
    v.setUint32(24,sr,true); v.setUint32(28,sr*2,true);
    v.setUint16(32,2,true);  v.setUint16(34,16,true);
    ws(36,"data"); v.setUint32(40,n*2,true);
    for(var i=0;i<n;i++)
        v.setInt16(44+i*2, Math.max(-32768,Math.min(32767,Math.round(samples[i]*32767))), true);
    return new Blob([buf], {type:"audio/wav"});
}

// Trigger a file download
function dlBlob(blob, name) {
    var a = Object.assign(document.createElement("a"), {href:URL.createObjectURL(blob), download:name});
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 10000);
}

// Format duration as HH:MM:SS
function fmtDuration(ms) {
    var s=Math.floor(ms/1000), h=Math.floor(s/3600), m=Math.floor((s%3600)/60), ss=s%60;
    return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0")+":"+String(ss).padStart(2,"0");
}

// Status bar helpers — used across app.js, recording.js, download.js
function statusFile(type, msg) {
    var el = document.getElementById("progressStatus");
    if (!el) return;
    el.className = "status " + type + " active";
    el.innerHTML = (type === "loading" ? '<span class="spinner"></span>' : "") + msg;
}

function statusRec(type, msg) {
    var el = document.getElementById("recStatusMsg");
    if (!el) return;
    el.className = "status " + type + " active";
    el.innerHTML = (type === "loading" ? '<span class="spinner"></span>' : "") + msg;
}
