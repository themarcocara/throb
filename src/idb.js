/**
 * idb.js — IndexedDB helpers for persistent event storage
 *
 * Schema (DB: throb_detector_v1, version 1):
 *
 *   events     { id, session_id, wall_clock_iso, wall_clock_ms, label,
 *                bpm, strength, masking_detected, masking_duration_s,
 *                mask_end_estimate, throb_predates_mask, mean_ac_while_masked,
 *                peak_masking_ratio, detection_method, audio_id, viz_id,
 *                duration_s }
 *
 *   audio      { id, session_id, pcm_blob (WAV), duration_s, sample_rate,
 *                wall_clock_iso, reason }
 *
 *   viz_data   { id, session_id, wall_clock_iso, wall_clock_ms, reason, sr,
 *                duration, detected, detected_at, bpm, strength, threshold,
 *                segments, times[], strengths[], confidences[],
 *                masking_factors[], context_masked_arr[], corrFull[],
 *                spec_freqs[], spec_times[], spec_z[][] }
 *
 *   sessions   { session_id, start_iso, last_heartbeat_iso, event_count,
 *                platform }
 *
 *   heartbeats { id, session_id, iso, uptime_s }
 *
 * Storage: navigator.storage.persist() is requested on recording start.
 * Quota: Chrome Android grants ~50% of free disk space.
 * Eviction: LRU only when critically low; persistent storage bypasses eviction.
 */

// ─────────────────────────────────────────────────────────────────────────────
// INDEXEDDB HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// ── IndexedDB helpers ─────────────────────────────────────────────────────
var DB_NAME    = 'throb_detector_v1';
var DB_VERSION = 1;
var _db        = null;

function idbOpen() {
    return new Promise(function(resolve, reject) {
        if (_db) { resolve(_db); return; }
        var req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function(e) {
            var db = e.target.result;
            if (!db.objectStoreNames.contains('events')) {
                var es = db.createObjectStore('events', { keyPath:'id', autoIncrement:true });
                es.createIndex('session_id', 'session_id', { unique:false });
                es.createIndex('wall_clock_ms', 'wall_clock_ms', { unique:false });
            }
            if (!db.objectStoreNames.contains('audio')) {
                db.createObjectStore('audio', { keyPath:'id', autoIncrement:true });
            }
            if (!db.objectStoreNames.contains('viz_data')) {
                db.createObjectStore('viz_data', { keyPath:'id', autoIncrement:true });
            }
            if (!db.objectStoreNames.contains('sessions')) {
                db.createObjectStore('sessions', { keyPath:'session_id' });
            }
            if (!db.objectStoreNames.contains('heartbeats')) {
                db.createObjectStore('heartbeats', { keyPath:'id', autoIncrement:true });
            }
        };
        req.onsuccess  = function(e) { _db = e.target.result; resolve(_db); };
        req.onerror    = function(e) { reject(e.target.error); };
    });
}

function idbPut(store, value) {
    return idbOpen().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx  = db.transaction(store, 'readwrite');
            var req = tx.objectStore(store).put(value);
            req.onsuccess = function() { resolve(req.result); };
            req.onerror   = function() { reject(req.error); };
        });
    });
}

function idbAdd(store, value) {
    return idbOpen().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx  = db.transaction(store, 'readwrite');
            var req = tx.objectStore(store).add(value);
            req.onsuccess = function() { resolve(req.result); };
            req.onerror   = function() { reject(req.error); };
        });
    });
}

function idbGetAll(store, indexName, query) {
    return idbOpen().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx = db.transaction(store, 'readonly');
            var os = tx.objectStore(store);
            var req = indexName ? os.index(indexName).getAll(query) : os.getAll();
            req.onsuccess = function() { resolve(req.result); };
            req.onerror   = function() { reject(req.error); };
        });
    });
}

function idbGet(store, key) {
    return idbOpen().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx  = db.transaction(store, 'readonly');
            var req = tx.objectStore(store).get(key);
            req.onsuccess = function() { resolve(req.result); };
            req.onerror   = function() { reject(req.error); };
        });
    });
}

function idbDelete(store, key) {
    return idbOpen().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx  = db.transaction(store, 'readwrite');
            var req = tx.objectStore(store).delete(key);
            req.onsuccess = function() { resolve(); };
            req.onerror   = function() { reject(req.error); };
        });
    });
}

function idbClear(store) {
    return idbOpen().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx  = db.transaction(store, 'readwrite');
            var req = tx.objectStore(store).clear();
            req.onsuccess = function() { resolve(); };
            req.onerror   = function() { reject(req.error); };
        });
    });
}

function idbStorageEstimate() {
    if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(null);
    return navigator.storage.estimate();
}
