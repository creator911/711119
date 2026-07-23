import type { ActiveSystemAnnouncement } from "./system-announcements";

export type ActiveAnnouncementSnapshot = {
  announcements: ActiveSystemAnnouncement[];
  etag: string;
  expiresAt: number;
};

let cachedSnapshot: ActiveAnnouncementSnapshot | null = null;
let snapshotRefresh: Promise<ActiveAnnouncementSnapshot> | null = null;
let cacheGeneration = 0;

export async function activeAnnouncementSnapshot(
  load: () => Promise<Omit<ActiveAnnouncementSnapshot, "expiresAt">>,
  ttlMs: number,
) {
  const now = Date.now();
  if (cachedSnapshot && cachedSnapshot.expiresAt > now) return cachedSnapshot;
  if (snapshotRefresh) return snapshotRefresh;
  const refreshGeneration = cacheGeneration;
  const refresh = load().then((snapshot) => ({ ...snapshot, expiresAt: Date.now() + ttlMs }));
  snapshotRefresh = refresh;
  try {
    const refreshed = await refresh;
    if (refreshGeneration === cacheGeneration) cachedSnapshot = refreshed;
    return refreshed;
  } finally {
    if (snapshotRefresh === refresh) snapshotRefresh = null;
  }
}

export function invalidateActiveAnnouncementSnapshot() {
  cacheGeneration += 1;
  cachedSnapshot = null;
  snapshotRefresh = null;
}
