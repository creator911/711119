export type AdminEditableMember = {
  id: number;
  nickname: string;
  points: number;
  level: number;
  levelLocked: boolean;
  status: "active" | "suspended";
  isDirector: boolean;
  isPartner: boolean;
};

export type AdminMemberPatch = { id: number } & Partial<Omit<AdminEditableMember, "id">>;

export function buildAdminMemberPatch(current: AdminEditableMember, baseline: AdminEditableMember): AdminMemberPatch | null {
  const patch: AdminMemberPatch = { id: current.id };
  if (current.nickname !== baseline.nickname) patch.nickname = current.nickname;
  if (current.points !== baseline.points) patch.points = current.points;
  if (current.level !== baseline.level) patch.level = current.level;
  if (current.levelLocked !== baseline.levelLocked) patch.levelLocked = current.levelLocked;
  if (current.status !== baseline.status) patch.status = current.status;
  if (current.isDirector !== baseline.isDirector) patch.isDirector = current.isDirector;
  if (current.isPartner !== baseline.isPartner) patch.isPartner = current.isPartner;
  return Object.keys(patch).length > 1 ? patch : null;
}

export function chunkAdminMemberPatches<T>(patches: T[], batchSize: number): T[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError("batchSize must be a positive integer");
  const chunks: T[][] = [];
  for (let offset = 0; offset < patches.length; offset += batchSize) {
    chunks.push(patches.slice(offset, offset + batchSize));
  }
  return chunks;
}
