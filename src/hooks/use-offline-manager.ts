"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  getAll,
  subscribe,
  refreshStatuses,
  downloadJob as managerDownloadJob,
  removeJob as managerRemoveJob,
  isDownloading,
  type OfflineStatus,
  type DownloadableJob,
} from "@/lib/offline-manager";

/**
 * useOfflineManager — React binding for offline-manager.
 *
 * Keeps a live `statuses` map in state (updated on every download tick),
 * and exposes download/remove actions. The library calls `refresh(cards)`
 * on mount and when connectivity/visibility changes so the badges reflect
 * ground truth from IndexedDB, not just the manager's memory.
 */
export function useOfflineManager() {
  // Lazy seed from the manager's current snapshot (module state may already
  // hold statuses if another component loaded records earlier).
  const [statuses, setStatuses] = useState<Record<string, OfflineStatus>>(() => getAll());
  const mountedRef = useRef(false);

  // Subscribe to manager updates (fires on every progress tick).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const unsubscribe = subscribe(() => {
      if (mountedRef.current) setStatuses(getAll());
    });
    return unsubscribe;
  }, []);

  /** Recompute statuses from IndexedDB for a set of jobs. */
  const refresh = useCallback(async (jobs: DownloadableJob[]) => {
    await refreshStatuses(jobs);
  }, []);

  const download = useCallback(async (job: DownloadableJob) => {
    await managerDownloadJob(job);
  }, []);

  const remove = useCallback(async (jobId: string) => {
    await managerRemoveJob(jobId);
  }, []);

  const downloading = useCallback((jobId: string) => isDownloading(jobId), []);

  return { statuses, refresh, download, remove, downloading };
}
