/**
 * download.js — Unified audio download, zip builder, and M4A encoder
 *
 * buildAndDownload(rawPCM, enhPCM, stemName, onStatus, opts)
 *   Assembles and downloads audio files according to user checkbox selections.
 *   opts: { wantRaw, wantEnhanced, wantEncoded, wantViz, vizData }
 *   Single file → direct download. Two or more files → auto-zipped.
 *
 * buildZip(files)
 *   Pure-JS ZIP builder. Uses CompressionStream (deflate-raw) where available,
 *   falls back to STORE. No external dependencies.
 *
 * M4A export — staged fallback:
 *   Stage 1: Native AudioEncoder API (Chrome/Edge 94+, zero download)
 *            Upsamples mono 16 kHz → stereo 44100 Hz for maximum quality.
 *   Stage 2: ffmpeg.wasm (lazy-loaded ~30 MB on user consent, all browsers)
 *   Stage 3: WAV fallback (always available)
 *
 * exportM4a(samples, sr, onStatus) → Blob | null
 */

// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED AUDIO DOWNLOAD
// ─────────────────────────────────────────────────────────────────────────────
//
// buildAndDownload(rawPCM, enhPCM, stemName, onStatus, opts)
//   rawPCM:  Float32Array | null
//   enhPCM:  Float32Array | null  (null = not yet computed; will be computed if requested)
//   stemName: filename stem (no extension)
//   onStatus: function(type, msg) for progress feedback
//   opts: { wantRaw, wantEnhanced, wantEncoded }  — read from checkboxes if omitted
//
// Rules:
//  - Exactly one file → download directly (no zip)
//  - Two or more files → zip
//  - Encoding (M4A) applied to whichever audio variants are selected
//  - If wantEnhanced and enhPCM===null, run enhancement in worker first

async function buildAndDownload(rawPCM, enhPCM, stemName, onStatus, opts) {
    onStatus = onStatus || statusFile;

    // Read options from checkboxes if not provided
    if (!opts) {
        opts = {
            wantRaw:      $("chkRawAudio")      ? $("chkRawAudio").checked      : true,
            wantEnhanced: $("chkEnhancedAudio")  ? $("chkEnhancedAudio").checked  : false,
            wantEncoded:  $("chkEncodedAudio")   ? $("chkEncodedAudio").checked   : false,
            wantViz:      $("chkVizData")        ? $("chkVizData").checked        : false,
        };
    }

    // Compute enhanced if requested and not provided
    if (opts.wantEnhanced && !enhPCM && rawPCM) {
        onStatus("loading", "Running enhancement…");
        try {
            var buf = await runEnhanceInWorker(rawPCM);
            enhPCM = new Float32Array(buf);
        } catch(e) {
            onStatus("error", "Enhancement failed: " + e.message);
            return;
        }
    }

    // Collect file entries: { name, blob }
    var files = [];

    if (opts.wantRaw && rawPCM) {
        if (opts.wantEncoded) {
            onStatus("loading", "Encoding raw audio as M4A…");
            var blob = await exportM4a(rawPCM, SR, onStatus);
            if (blob) files.push({ name: stemName + "_raw.m4a", blob });
        } else {
            files.push({ name: stemName + "_raw.wav", blob: pcmToWav(rawPCM, SR) });
        }
    }

    if (opts.wantEnhanced && enhPCM) {
        if (opts.wantEncoded) {
            onStatus("loading", "Encoding enhanced audio as M4A…");
            var blob = await exportM4a(enhPCM, SR, onStatus);
            if (blob) files.push({ name: stemName + "_enhanced.m4a", blob });
        } else {
            files.push({ name: stemName + "_enhanced.wav", blob: pcmToWav(enhPCM, SR) });
        }
    }

    // Add visualization files if requested
    if (opts.wantViz && opts.vizData) {
        // JSON (without spec_z which can be large — store it separately)
        var vizExport = Object.assign({}, opts.vizData);
        delete vizExport.spec_z;
        files.push({ name: stemName + "_viz.json",
                     blob: new Blob([JSON.stringify(vizExport,null,2)],{type:"application/json"}) });
        // Spectrogram data separately if present
        if (opts.vizData.spec_z && opts.vizData.spec_z.length) {
            var specExport = { freqs: opts.vizData.spec_freqs, times: opts.vizData.spec_times, z: opts.vizData.spec_z };
            files.push({ name: stemName + "_spectrogram.json",
                         blob: new Blob([JSON.stringify(specExport)],{type:"application/json"}) });
        }
        // PNG: render to a hidden div, screenshot, then remove
        if (typeof Plotly !== "undefined") {
            try {
                var hiddenDiv = document.createElement("div");
                hiddenDiv.style.cssText="position:fixed;left:-9999px;top:0;width:1200px;height:700px;";
                document.body.appendChild(hiddenDiv);
                renderVizPlot(hiddenDiv, opts.vizData);
                var pngDataUrl = await Plotly.toImage(hiddenDiv,{format:"png",width:1400,height:860});
                document.body.removeChild(hiddenDiv);
                var pngBase64 = pngDataUrl.split(",")[1];
                var pngBytes  = Uint8Array.from(atob(pngBase64), function(c){return c.charCodeAt(0);});
                files.push({ name: stemName + "_viz.png",
                             blob: new Blob([pngBytes],{type:"image/png"}) });
            } catch(vizPngErr) { console.warn("viz PNG failed:", vizPngErr); }
        }
    }

    if (!files.length) {
        onStatus("error", "No output format selected. Check at least one option.");
        return;
    }

    if (files.length === 1) {
        dlBlob(files[0].blob, files[0].name);
        onStatus("success", "✓ Downloaded: " + files[0].name);
    } else {
        onStatus("loading", "Building zip…");
        var zipBlob = await buildZip(files);
        dlBlob(zipBlob, stemName + "_audio.zip");
        onStatus("success", "✓ Downloaded zip with " + files.length + " files.");
    }
}

// Lightweight synchronous zip builder (STORE + DEFLATE-less for simplicity;
// uses DecompressionStream/CompressionStream if available, otherwise STORE)
async function buildZip(files) {
    // We use the native Compression Streams API (Chrome 80+, Firefox 113+)
    // to deflate each file. Fall back to STORE if unavailable.
    var entries = [];
    var dataOffset = 0;

    for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var rawBytes = await blobToUint8Array(f.blob);
        var compressed = rawBytes;
        var method = 0;  // STORE

        if (typeof CompressionStream !== "undefined") {
            try {
                var cs = new CompressionStream("deflate-raw");
                var writer = cs.writable.getWriter();
                writer.write(rawBytes);
                writer.close();
                var chunks = [];
                var reader = cs.readable.getReader();
                while (true) {
                    var r = await reader.read();
                    if (r.done) break;
                    chunks.push(r.value);
                }
                var totalLen = chunks.reduce(function(a,c){return a+c.length;},0);
                compressed = new Uint8Array(totalLen);
                var pos = 0;
                for (var j=0;j<chunks.length;j++){compressed.set(chunks[j],pos);pos+=chunks[j].length;}
                method = 8;  // DEFLATE
            } catch(e) {
                compressed = rawBytes; method = 0;
            }
        }

        var nameBytes = new TextEncoder().encode(f.name);
        var crc = crc32(rawBytes);
        var now = new Date();
        var dosDate = ((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate();
        var dosTime = (now.getHours()<<11)|(now.getMinutes()<<5)|(now.getSeconds()>>1);

        // Local file header
        var lfh = new DataView(new ArrayBuffer(30 + nameBytes.length));
        setU32(lfh,0,0x04034b50); setU16(lfh,4,20); setU16(lfh,6,0);
        setU16(lfh,8,method); setU16(lfh,10,dosTime); setU16(lfh,12,dosDate);
        setU32(lfh,14,crc); setU32(lfh,18,compressed.length); setU32(lfh,22,rawBytes.length);
        setU16(lfh,26,nameBytes.length); setU16(lfh,28,0);
        new Uint8Array(lfh.buffer).set(nameBytes, 30);

        entries.push({
            name: nameBytes, crc, method,
            rawLen: rawBytes.length, compLen: compressed.length,
            dosDate, dosTime,
            lfhOffset: dataOffset,
            lfhBytes: new Uint8Array(lfh.buffer),
            data: compressed,
        });
        dataOffset += lfh.buffer.byteLength + compressed.length;
    }

    // Central directory
    var cdParts = [];
    var cdSize = 0;
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var cd = new DataView(new ArrayBuffer(46 + e.name.length));
        setU32(cd,0,0x02014b50); setU16(cd,4,20); setU16(cd,6,20); setU16(cd,8,0);
        setU16(cd,10,e.method); setU16(cd,12,e.dosTime); setU16(cd,14,e.dosDate);
        setU32(cd,16,e.crc); setU32(cd,20,e.compLen); setU32(cd,24,e.rawLen);
        setU16(cd,28,e.name.length); setU16(cd,30,0); setU16(cd,32,0);
        setU16(cd,34,0); setU16(cd,36,0); setU32(cd,38,0); setU32(cd,42,e.lfhOffset);
        new Uint8Array(cd.buffer).set(e.name, 46);
        cdParts.push(new Uint8Array(cd.buffer));
        cdSize += cd.buffer.byteLength;
    }

    // End of central directory
    var eocd = new DataView(new ArrayBuffer(22));
    setU32(eocd,0,0x06054b50); setU16(eocd,4,0); setU16(eocd,6,0);
    setU16(eocd,8,entries.length); setU16(eocd,10,entries.length);
    setU32(eocd,12,cdSize); setU32(eocd,16,dataOffset); setU16(eocd,20,0);

    // Assemble
    var parts = [];
    for (var i=0;i<entries.length;i++){parts.push(entries[i].lfhBytes);parts.push(entries[i].data);}
    for (var i=0;i<cdParts.length;i++) parts.push(cdParts[i]);
    parts.push(new Uint8Array(eocd.buffer));

    var totalLen = parts.reduce(function(a,p){return a+p.length;},0);
    var out = new Uint8Array(totalLen), pos = 0;
    for (var i=0;i<parts.length;i++){out.set(parts[i],pos);pos+=parts[i].length;}
    return new Blob([out], {type:"application/zip"});
}

function setU16(dv,off,v){dv.setUint16(off,v,true);}
function setU32(dv,off,v){dv.setUint32(off,v,true);}

function crc32(bytes) {
    var table = crc32._t;
    if (!table) {
        table = crc32._t = new Uint32Array(256);
        for (var i=0;i<256;i++){
            var c=i;
            for(var j=0;j<8;j++) c=c&1?(0xEDB88320^(c>>>1)):c>>>1;
            table[i]=c;
        }
    }
    var crc = 0xFFFFFFFF;
    for (var i=0;i<bytes.length;i++) crc=table[(crc^bytes[i])&0xFF]^(crc>>>8);
    return (crc^0xFFFFFFFF)>>>0;
}

function blobToUint8Array(blob) {
    return blob.arrayBuffer().then(function(ab){return new Uint8Array(ab);});
}

// Per-file and batch download handlers are in src/app.js

async function buildAndDownload(rawPCM, enhPCM, stemName, onStatus, opts) {
    onStatus = onStatus || statusFile;

    // Read options from checkboxes if not provided
    if (!opts) {
        opts = {
            wantRaw:      $("chkRawAudio")      ? $("chkRawAudio").checked      : true,
            wantEnhanced: $("chkEnhancedAudio")  ? $("chkEnhancedAudio").checked  : false,
            wantEncoded:  $("chkEncodedAudio")   ? $("chkEncodedAudio").checked   : false,
            wantViz:      $("chkVizData")        ? $("chkVizData").checked        : false,
        };
    }

    // Compute enhanced if requested and not provided
    if (opts.wantEnhanced && !enhPCM && rawPCM) {
        onStatus("loading", "Running enhancement…");
        try {
            var buf = await runEnhanceInWorker(rawPCM);
            enhPCM = new Float32Array(buf);
        } catch(e) {
            onStatus("error", "Enhancement failed: " + e.message);
            return;
        }
    }

    // Collect file entries: { name, blob }
    var files = [];

    if (opts.wantRaw && rawPCM) {
        if (opts.wantEncoded) {
            onStatus("loading", "Encoding raw audio as M4A…");
            var blob = await exportM4a(rawPCM, SR, onStatus);
            if (blob) files.push({ name: stemName + "_raw.m4a", blob });
        } else {
            files.push({ name: stemName + "_raw.wav", blob: pcmToWav(rawPCM, SR) });
        }
    }

    if (opts.wantEnhanced && enhPCM) {
        if (opts.wantEncoded) {
            onStatus("loading", "Encoding enhanced audio as M4A…");
            var blob = await exportM4a(enhPCM, SR, onStatus);
            if (blob) files.push({ name: stemName + "_enhanced.m4a", blob });
        } else {
            files.push({ name: stemName + "_enhanced.wav", blob: pcmToWav(enhPCM, SR) });
        }
    }

    // Add visualization files if requested
    if (opts.wantViz && opts.vizData) {
        // JSON (without spec_z which can be large — store it separately)
        var vizExport = Object.assign({}, opts.vizData);
        delete vizExport.spec_z;
        files.push({ name: stemName + "_viz.json",
                     blob: new Blob([JSON.stringify(vizExport,null,2)],{type:"application/json"}) });
        // Spectrogram data separately if present
        if (opts.vizData.spec_z && opts.vizData.spec_z.length) {
            var specExport = { freqs: opts.vizData.spec_freqs, times: opts.vizData.spec_times, z: opts.vizData.spec_z };
            files.push({ name: stemName + "_spectrogram.json",
                         blob: new Blob([JSON.stringify(specExport)],{type:"application/json"}) });
        }
        // PNG: render to a hidden div, screenshot, then remove
        if (typeof Plotly !== "undefined") {
            try {
                var hiddenDiv = document.createElement("div");
                hiddenDiv.style.cssText="position:fixed;left:-9999px;top:0;width:1200px;height:700px;";
                document.body.appendChild(hiddenDiv);
                renderVizPlot(hiddenDiv, opts.vizData);
                var pngDataUrl = await Plotly.toImage(hiddenDiv,{format:"png",width:1400,height:860});
                document.body.removeChild(hiddenDiv);
                var pngBase64 = pngDataUrl.split(",")[1];
                var pngBytes  = Uint8Array.from(atob(pngBase64), function(c){return c.charCodeAt(0);});
                files.push({ name: stemName + "_viz.png",
                             blob: new Blob([pngBytes],{type:"image/png"}) });
            } catch(vizPngErr) { console.warn("viz PNG failed:", vizPngErr); }
        }
    }

    if (!files.length) {
        onStatus("error", "No output format selected. Check at least one option.");
        return;
    }

    if (files.length === 1) {
        dlBlob(files[0].blob, files[0].name);
        onStatus("success", "✓ Downloaded: " + files[0].name);
    } else {
        onStatus("loading", "Building zip…");
        var zipBlob = await buildZip(files);
        dlBlob(zipBlob, stemName + "_audio.zip");
        onStatus("success", "✓ Downloaded zip with " + files.length + " files.");
    }
}

// Lightweight synchronous zip builder (STORE + DEFLATE-less for simplicity;
// uses DecompressionStream/CompressionStream if available, otherwise STORE)
async function buildZip(files) {
    // We use the native Compression Streams API (Chrome 80+, Firefox 113+)
    // to deflate each file. Fall back to STORE if unavailable.
    var entries = [];
    var dataOffset = 0;

    for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var rawBytes = await blobToUint8Array(f.blob);
        var compressed = rawBytes;
        var method = 0;  // STORE

        if (typeof CompressionStream !== "undefined") {
            try {
                var cs = new CompressionStream("deflate-raw");
                var writer = cs.writable.getWriter();
                writer.write(rawBytes);
                writer.close();
                var chunks = [];
                var reader = cs.readable.getReader();
                while (true) {
                    var r = await reader.read();
                    if (r.done) break;
                    chunks.push(r.value);
                }
                var totalLen = chunks.reduce(function(a,c){return a+c.length;},0);
                compressed = new Uint8Array(totalLen);
                var pos = 0;
                for (var j=0;j<chunks.length;j++){compressed.set(chunks[j],pos);pos+=chunks[j].length;}
                method = 8;  // DEFLATE
            } catch(e) {
                compressed = rawBytes; method = 0;
            }
        }

        var nameBytes = new TextEncoder().encode(f.name);
        var crc = crc32(rawBytes);
        var now = new Date();
        var dosDate = ((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate();
        var dosTime = (now.getHours()<<11)|(now.getMinutes()<<5)|(now.getSeconds()>>1);

        // Local file header
        var lfh = new DataView(new ArrayBuffer(30 + nameBytes.length));
        setU32(lfh,0,0x04034b50); setU16(lfh,4,20); setU16(lfh,6,0);
        setU16(lfh,8,method); setU16(lfh,10,dosTime); setU16(lfh,12,dosDate);
        setU32(lfh,14,crc); setU32(lfh,18,compressed.length); setU32(lfh,22,rawBytes.length);
        setU16(lfh,26,nameBytes.length); setU16(lfh,28,0);
        new Uint8Array(lfh.buffer).set(nameBytes, 30);

        entries.push({
            name: nameBytes, crc, method,
            rawLen: rawBytes.length, compLen: compressed.length,
            dosDate, dosTime,
            lfhOffset: dataOffset,
            lfhBytes: new Uint8Array(lfh.buffer),
            data: compressed,
        });
        dataOffset += lfh.buffer.byteLength + compressed.length;
    }

    // Central directory
    var cdParts = [];
    var cdSize = 0;
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var cd = new DataView(new ArrayBuffer(46 + e.name.length));
        setU32(cd,0,0x02014b50); setU16(cd,4,20); setU16(cd,6,20); setU16(cd,8,0);
        setU16(cd,10,e.method); setU16(cd,12,e.dosTime); setU16(cd,14,e.dosDate);
        setU32(cd,16,e.crc); setU32(cd,20,e.compLen); setU32(cd,24,e.rawLen);
        setU16(cd,28,e.name.length); setU16(cd,30,0); setU16(cd,32,0);
        setU16(cd,34,0); setU16(cd,36,0); setU32(cd,38,0); setU32(cd,42,e.lfhOffset);
        new Uint8Array(cd.buffer).set(e.name, 46);
        cdParts.push(new Uint8Array(cd.buffer));
        cdSize += cd.buffer.byteLength;
    }

    // End of central directory
    var eocd = new DataView(new ArrayBuffer(22));
    setU32(eocd,0,0x06054b50); setU16(eocd,4,0); setU16(eocd,6,0);
    setU16(eocd,8,entries.length); setU16(eocd,10,entries.length);
    setU32(eocd,12,cdSize); setU32(eocd,16,dataOffset); setU16(eocd,20,0);

    // Assemble
    var parts = [];
    for (var i=0;i<entries.length;i++){parts.push(entries[i].lfhBytes);parts.push(entries[i].data);}
    for (var i=0;i<cdParts.length;i++) parts.push(cdParts[i]);
    parts.push(new Uint8Array(eocd.buffer));

    var totalLen = parts.reduce(function(a,p){return a+p.length;},0);
    var out = new Uint8Array(totalLen), pos = 0;
    for (var i=0;i<parts.length;i++){out.set(parts[i],pos);pos+=parts[i].length;}
    return new Blob([out], {type:"application/zip"});
}

function setU16(dv,off,v){dv.setUint16(off,v,true);}
function setU32(dv,off,v){dv.setUint32(off,v,true);}

function crc32(bytes) {
    var table = crc32._t;
    if (!table) {
        table = crc32._t = new Uint32Array(256);
        for (var i=0;i<256;i++){
            var c=i;
            for(var j=0;j<8;j++) c=c&1?(0xEDB88320^(c>>>1)):c>>>1;
            table[i]=c;
        }
    }
    var crc = 0xFFFFFFFF;
    for (var i=0;i<bytes.length;i++) crc=table[(crc^bytes[i])&0xFF]^(crc>>>8);
    return (crc^0xFFFFFFFF)>>>0;
}

function blobToUint8Array(blob) {
    return blob.arrayBuffer().then(function(ab){return new Uint8Array(ab);});
}

// Per-file and batch download handlers are in src/app.js

// ─────────────────────────────────────────────────────────────────────────────
// M4A EXPORT (staged fallback — shared by file + recording)
// ─────────────────────────────────────────────────────────────────────────────
var _ffmpegResolve=null;
$("ffmpegCancel").addEventListener("click",function(){hideModal("ffmpegModal");if(_ffmpegResolve){_ffmpegResolve(false);_ffmpegResolve=null;}});
$("ffmpegConfirm").addEventListener("click",function(){hideModal("ffmpegModal");if(_ffmpegResolve){_ffmpegResolve(true);_ffmpegResolve=null;}});
function showModal(id){var el=$(id);el.classList.add("active");}
function hideModal(id){var el=$(id);el.classList.remove("active");}

async function exportM4a(samples,sr,onStatus) {
    onStatus=onStatus||statusFile;
    onStatus("loading","Preparing M4A export…");
    if(typeof AudioEncoder!=="undefined"){
        try{
            onStatus("loading","Encoding with native codec (320 kbps AAC)…");
            var blob=await encodeWithAudioEncoder(samples,sr,320000);
            return blob;
        }catch(e){console.warn("AudioEncoder failed:",e);}
    }
    var confirmed=await new Promise(function(resolve){
        _ffmpegResolve=resolve; showModal("ffmpegModal");
    });
    if(!confirmed){onStatus("success","M4A cancelled — use WAV instead.");return null;}
    try{
        var blob=await encodeWithFfmpeg(samples,sr,320);
        return blob;
    }catch(e){
        console.warn("ffmpeg failed:",e);
        onStatus("error","M4A encoding failed: "+e.message+" — falling back to WAV.");
        return null;
    }
}

async function encodeWithAudioEncoder(pcmSamples,sampleRate,bitrate){
    var codecStr="mp4a.40.2";
    var support=await AudioEncoder.isConfigSupported({codec:codecStr,sampleRate:sampleRate,numberOfChannels:1,bitrate:bitrate});
    if(!support.supported) throw new Error("AAC not supported");
    var chunks=[],config=null;
    var enc=new AudioEncoder({
        output:function(chunk,meta){if(meta&&meta.decoderConfig)config=meta.decoderConfig;var b=new Uint8Array(chunk.byteLength);chunk.copyTo(b);chunks.push({data:b,duration:chunk.duration,timestamp:chunk.timestamp,type:chunk.type});},
        error:function(e){throw e;}
    });
    var TARGET_SR=44100,ratio=TARGET_SR/sampleRate;
    var upLen=Math.floor(pcmSamples.length*ratio);
    var up=new Float32Array(upLen*2);
    for(var i=0;i<upLen;i++){
        var sf=i/ratio,si=Math.floor(sf),t=sf-si;
        var s0=pcmSamples[Math.min(si,pcmSamples.length-1)],s1=pcmSamples[Math.min(si+1,pcmSamples.length-1)];
        var val=s0+t*(s1-s0); up[i*2]=val; up[i*2+1]=val;
    }
    enc.configure({codec:codecStr,sampleRate:TARGET_SR,numberOfChannels:2,bitrate:bitrate});
    var FRAME=1024,timestamp=0;
    for(var i=0;i<upLen;i+=FRAME){
        var end=Math.min(i+FRAME,upLen),nF=end-i,frame=new Float32Array(FRAME*2);
        frame.set(up.subarray(i*2,end*2));
        var ad=new AudioData({format:"f32-planar",sampleRate:TARGET_SR,numberOfFrames:FRAME,numberOfChannels:2,timestamp:timestamp,data:frame});
        enc.encode(ad); ad.close();
        timestamp+=Math.round(FRAME/TARGET_SR*1e6);
    }
    await enc.flush(); enc.close();
    if(!chunks.length) throw new Error("No AAC chunks produced");
    return buildM4aContainer(chunks,config,TARGET_SR,2,upLen,bitrate);
}

function buildM4aContainer(chunks,decoderConfig,sampleRate,channels,totalPcmSamples,bitrate){
    bitrate=bitrate||320000;
    var asc;
    if(decoderConfig&&decoderConfig.description){asc=new Uint8Array(decoderConfig.description);}
    else{
        var freqTable=[96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];
        var freqIdx=freqTable.indexOf(sampleRate);if(freqIdx<0)freqIdx=4;
        var word=(2<<11)|(freqIdx<<7)|(channels<<3);
        asc=new Uint8Array([(word>>8)&0xFF,word&0xFF]);
    }
    var FRAME_DUR=1024,totalFrames=chunks.length;
    var mdatDataSize=chunks.reduce(function(a,c){return a+c.data.length;},0);
    var sampleSizes=chunks.map(function(c){return c.data.length;});
    function u8(v){return[v&0xFF];}
    function u16be(v){return[(v>>8)&0xFF,v&0xFF];}
    function u24be(v){return[(v>>16)&0xFF,(v>>8)&0xFF,v&0xFF];}
    function u32be(v){return[(v>>>24)&0xFF,(v>>16)&0xFF,(v>>8)&0xFF,v&0xFF];}
    function str4(s){return[s.charCodeAt(0),s.charCodeAt(1),s.charCodeAt(2),s.charCodeAt(3)];}
    function box(name,payload){var size=8+payload.length;return[].concat(u32be(size),str4(name),Array.from(payload));}
    function fullbox(name,version,flags,payload){return box(name,[].concat([version],u24be(flags),Array.from(payload)));}
    function concat(){var total=0;for(var i=0;i<arguments.length;i++)total+=arguments[i].length;var out=new Uint8Array(total),pos=0;for(var i=0;i<arguments.length;i++){out.set(arguments[i],pos);pos+=arguments[i].length;}return out;}
    var ftyp=box("ftyp",[].concat(str4("M4A "),u32be(0x200),str4("M4A "),str4("mp42"),str4("isom")));
    var duration=totalFrames*FRAME_DUR;
    var mvhd=fullbox("mvhd",0,0,[].concat(u32be(0),u32be(0),u32be(sampleRate),u32be(duration),u32be(0x00010000),u16be(0x0100),[0,0,0,0,0,0,0,0,0,0],u32be(0x00010000),u32be(0),u32be(0),u32be(0),u32be(0x00010000),u32be(0),u32be(0),u32be(0),u32be(0x40000000),[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],u32be(2)));
    var tkhd=fullbox("tkhd",0,3,[].concat(u32be(0),u32be(0),u32be(1),u32be(0),u32be(duration),[0,0,0,0,0,0,0,0],u16be(0),u16be(0),u16be(0x0100),u16be(0),u32be(0x00010000),u32be(0),u32be(0),u32be(0),u32be(0x00010000),u32be(0),u32be(0),u32be(0),u32be(0x40000000),u32be(0),u32be(0)));
    var mdhd=fullbox("mdhd",0,0,[].concat(u32be(0),u32be(0),u32be(sampleRate),u32be(duration),u16be(0x55C4),u16be(0)));
    var hdlr=fullbox("hdlr",0,0,[].concat(u32be(0),str4("soun"),u32be(0),u32be(0),u32be(0),[83,111,117,110,100,72,97,110,100,108,101,114,0]));
    var smhd=fullbox("smhd",0,0,[].concat(u16be(0),u16be(0)));
    var drefPayload=[].concat(u32be(1),[0,0,0,12],str4("url "),[0,0,0,1]);
    var dref=fullbox("dref",0,0,drefPayload);
    var dinf=box("dinf",new Uint8Array(dref));
    function esLen(n){return[n&0x7F];}
    var dsi=[].concat([0x05],esLen(asc.length),Array.from(asc));
    var dcInfo=[].concat([0x04],esLen(13+dsi.length),[0x40],[0x15],u24be(0),u32be(bitrate||320000),u32be(bitrate||320000),dsi);
    var slConfig=[0x06,0x01,0x02];
    var esDesc=[].concat([0x03],esLen(3+dcInfo.length+slConfig.length),u16be(1),[0x00],dcInfo,slConfig);
    var esds=fullbox("esds",0,0,esDesc);
    var mp4aPayload=[].concat([0,0,0,0,0,0],u16be(1),u32be(0),u32be(0),u16be(channels),u16be(16),u16be(0),u16be(0),u32be(sampleRate<<16),Array.from(new Uint8Array(box("esds",new Uint8Array(esds)))));
    var mp4a=box("mp4a",new Uint8Array(mp4aPayload));
    var stsd=fullbox("stsd",0,0,[].concat(u32be(1),Array.from(new Uint8Array(mp4a))));
    var stts=fullbox("stts",0,0,[].concat(u32be(1),u32be(totalFrames),u32be(FRAME_DUR)));
    var stszEntries=[];sampleSizes.forEach(function(sz){stszEntries=stszEntries.concat(u32be(sz));});
    var stsz=fullbox("stsz",0,0,[].concat(u32be(0),u32be(totalFrames),stszEntries));
    var stsc=fullbox("stsc",0,0,[].concat(u32be(1),u32be(1),u32be(totalFrames),u32be(1)));
    var stco=fullbox("stco",0,0,[].concat(u32be(1),u32be(0)));
    var stbl=box("stbl",concat(new Uint8Array(stsd),new Uint8Array(stts),new Uint8Array(stsz),new Uint8Array(stsc),new Uint8Array(stco)));
    var minf=box("minf",concat(new Uint8Array(smhd),new Uint8Array(dinf),new Uint8Array(stbl)));
    var mdia=box("mdia",concat(new Uint8Array(mdhd),new Uint8Array(hdlr),new Uint8Array(minf)));
    var trak=box("trak",concat(new Uint8Array(tkhd),new Uint8Array(mdia)));
    var moov=box("moov",concat(new Uint8Array(mvhd),new Uint8Array(trak)));
    var mdatOffset=ftyp.length+moov.length+8;
    var moovArr=new Uint8Array(moov);
    for(var i=0;i<moovArr.length-4;i++){
        if(moovArr[i]===115&&moovArr[i+1]===116&&moovArr[i+2]===99&&moovArr[i+3]===111){
            var off=i+12;moovArr[off]=(mdatOffset>>>24)&0xFF;moovArr[off+1]=(mdatOffset>>>16)&0xFF;moovArr[off+2]=(mdatOffset>>>8)&0xFF;moovArr[off+3]=mdatOffset&0xFF;break;
        }
    }
    var mdatHeader=new Uint8Array([].concat(u32be(8+mdatDataSize),str4("mdat")));
    var mdatData=new Uint8Array(mdatDataSize);
    var pos=0;chunks.forEach(function(c){mdatData.set(c.data,pos);pos+=c.data.length;});
    var ftypArr=new Uint8Array(ftyp),total=ftypArr.length+moovArr.length+mdatHeader.length+mdatData.length;
    var out=new Uint8Array(total),p=0;
    out.set(ftypArr,p);p+=ftypArr.length;out.set(moovArr,p);p+=moovArr.length;out.set(mdatHeader,p);p+=mdatHeader.length;out.set(mdatData,p);
    return new Blob([out],{type:"audio/mp4"});
}

var _ffmpegInstance=null;
async function encodeWithFfmpeg(pcmSamples,sampleRate,kbps){
    if(!window.FFmpegWASM){
        await loadScript("https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.6/dist/umd/ffmpeg.js");
        if(!window.FFmpegWASM) throw new Error("ffmpeg.wasm failed to load");
    }
    if(!_ffmpegInstance){
        var FF=window.FFmpegWASM; _ffmpegInstance=new FF.FFmpeg();
        _ffmpegInstance.on("progress",function(p){statusFile("loading","Encoding M4A… "+Math.round(p.progress*100)+"%");});
        await _ffmpegInstance.load();
    }
    var ff=_ffmpegInstance;
    var wavBlob=pcmToWav(pcmSamples,sampleRate);
    var wavBuf=await wavBlob.arrayBuffer();
    await ff.writeFile("input.wav",new Uint8Array(wavBuf));
    await ff.exec(["-i","input.wav","-ar","44100","-ac","2","-c:a","aac","-q:a","0","-movflags","+faststart","output.m4a"]);
    var outData=await ff.readFile("output.m4a");
    await ff.deleteFile("input.wav"); await ff.deleteFile("output.m4a");
    return new Blob([outData],{type:"audio/mp4"});
}

function loadScript(src){
    return new Promise(function(resolve,reject){
        var s=document.createElement("script");s.src=src;
        s.onload=resolve;s.onerror=function(){reject(new Error("Failed to load "+src));};
        document.head.appendChild(s);
    });
}
