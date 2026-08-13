"""storj_sync — background queue for best-effort Storj/R2 sync.

Generated audio/chapters are written to the local volume first; Storj upload
is a best-effort async sync afterward, never a blocking dependency for
marking a job complete. If Storj sync fails, the job still succeeds and the
file is still served from the local volume.

A single background thread drains the queue with exponential backoff. When
the queue is empty, it sleeps until a new item is enqueued (event-driven,
not polling). Connectivity returning triggers automatic catch-up upload of
anything generated while offline.

Usage:
    from storj_sync import enqueue_storj_sync
    enqueue_storj_sync(local_path, s3_key, job_id, meta)

The queue persists to disk (JSON file in ABM_DATA_DIR) so unsynced items
survive a restart — on startup, _load_pending_syncs() re-enqueues anything
that was pending when the process died.
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

_pending: list[dict] = []
_pending_lock = threading.Lock()
_wakeup = threading.Event()
_thread_started = False
_thread_lock = threading.Lock()

_DATA_DIR = Path(os.environ.get("ABM_DATA_DIR", "/var/lib/audiobook-maker/data"))
_QUEUE_FILE = _DATA_DIR / "_storj_sync_queue.json"


def _load_pending_syncs():
    """Re-enqueue any sync items that were pending when the process died."""
    global _pending
    try:
        if _QUEUE_FILE.is_file():
            with open(_QUEUE_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, list):
                with _pending_lock:
                    _pending = data
                if _pending:
                    print(f"[storj-sync] Re-enqueued {len(_pending)} pending sync(s) from disk")
    except Exception as e:
        print(f"[storj-sync] load pending failed (non-fatal): {e}")


def _persist_pending_syncs():
    """Persist the current queue to disk so it survives restarts."""
    try:
        _DATA_DIR.mkdir(parents=True, exist_ok=True)
        with _pending_lock:
            data = list(_pending)
        with open(_QUEUE_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f)
    except Exception as e:
        print(f"[storj-sync] persist pending failed (non-fatal): {e}")


def enqueue_storj_sync(local_path: str, s3_key: str, job_id: str = "",
                       meta: dict | None = None):
    """Enqueue a file for background upload to Storj/R2.

    Non-blocking: returns immediately. The background thread picks it up.
    If Storj is not enabled, this is a no-op (the file stays local-only).
    """
    try:
        import storage_backend
        if not storage_backend.is_enabled():
            return  # local-only mode — no sync needed
    except Exception:
        return
    if not os.path.exists(local_path):
        print(f"[storj-sync] skip (local file missing): {local_path}")
        return
    item = {
        "local_path": local_path,
        "s3_key": s3_key,
        "job_id": job_id,
        "meta": meta or {},
        "attempts": 0,
        "next_retry": 0.0,
        "enqueued_at": time.time(),
    }
    with _pending_lock:
        _pending.append(item)
    _persist_pending_syncs()
    _wakeup.set()
    print(f"[storj-sync] enqueued: {s3_key} ({job_id})")


def _sync_worker():
    """Background thread: drain the queue with exponential backoff.

    Retries failed uploads with backoff: 30s, 60s, 120s, 300s, 600s.
    After max retries (5), the item is dropped (logged) — the local file
    is still served, just not synced off-site.
    """
    _BACKOFFS = [30, 60, 120, 300, 600]
    _MAX_ATTEMPTS = len(_BACKOFFS)
    print("[storj-sync] background thread started")
    while True:
        # Drain all ready items
        _now = time.time()
        _ready = []
        _keep = []
        with _pending_lock:
            for item in _pending:
                if item.get("next_retry", 0) <= _now:
                    _ready.append(item)
                else:
                    _keep.append(item)
        for item in _ready:
            _local = item["local_path"]
            _key = item["s3_key"]
            if not os.path.exists(_local):
                print(f"[storj-sync] skip (local file gone): {_key}")
                continue
            try:
                import storage_backend
                storage_backend.upload_file(_local, _key)
                print(f"[storj-sync] uploaded: {_key} ({item.get('job_id', '')})")
                # Mark s3_key on the chapter entry if the job is live
                _jid = item.get("job_id", "")
                if _jid:
                    try:
                        # Best-effort: update the in-memory job's chapter_mp3s
                        import audiobook_app
                        with audiobook_app._jobs_lock:
                            _job = audiobook_app.jobs.get(_jid)
                            if _job:
                                for _ch in (_job.get("chapter_mp3s") or []):
                                    if isinstance(_ch, dict) and _ch.get("filename") == os.path.basename(_key):
                                        _ch["s3_key"] = _key
                    except Exception:
                        pass
                # Remove from queue on success
                with _pending_lock:
                    # Re-filter in case more items were added
                    _pending[:] = [i for i in _pending
                                   if not (i["local_path"] == _local and i["s3_key"] == _key)]
                _persist_pending_syncs()
            except Exception as e:
                item["attempts"] = item.get("attempts", 0) + 1
                _att = item["attempts"]
                if _att >= _MAX_ATTEMPTS:
                    print(f"[storj-sync] GIVING UP after {_att} attempts: {_key} — {e}")
                    with _pending_lock:
                        _pending[:] = [i for i in _pending
                                       if not (i["local_path"] == _local and i["s3_key"] == _key)]
                    _persist_pending_syncs()
                else:
                    _delay = _BACKOFFS[_att - 1]
                    item["next_retry"] = time.time() + _delay
                    print(f"[storj-sync] retry {_att}/{_MAX_ATTEMPTS} in {_delay}s: {_key} — {e}")
                    # Put it back in the keep list
                    with _pending_lock:
                        if item not in _pending:
                            _pending.append(item)
                    _persist_pending_syncs()
        # Wait for the next wakeup (new item) or the next retry timeout
        with _pending_lock:
            _has_pending = bool(_pending)
        if _has_pending:
            # Find the nearest retry time
            with _pending_lock:
                _next = min((i.get("next_retry", 0) for i in _pending), default=time.time() + 60)
            _timeout = max(1.0, _next - time.time())
            _wakeup.wait(timeout=min(_timeout, 60.0))
            _wakeup.clear()
        else:
            _wakeup.wait()  # sleep until enqueued
            _wakeup.clear()


def start_sync_thread():
    """Start the background sync thread (once, at import or startup)."""
    global _thread_started
    with _thread_lock:
        if _thread_started:
            return
        _thread_started = True
    _load_pending_syncs()
    t = threading.Thread(target=_sync_worker, daemon=True, name="storj-sync")
    t.start()


# Auto-start on import (safe — the thread is daemon, no-ops if queue is empty)
try:
    start_sync_thread()
except Exception as e:
    print(f"[storj-sync] failed to start background thread (non-fatal): {e}")
