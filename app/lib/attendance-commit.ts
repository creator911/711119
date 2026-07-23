type AttendanceCommitDatabase = Pick<D1Database, "prepare" | "batch">;

export type AttendanceCommitIdentity = {
  userId: number;
  date: string;
  createdAt: string;
  points: number;
};

export class AttendanceCommitConflict extends Error {
  constructor() {
    super("attendance_member_state_changed");
  }
}

/**
 * Commits the guarded attendance transaction and resolves an ambiguous remote
 * response from durable state. D1 batches are atomic, so the exact attendance
 * row proves every dependent points, ledger, level and streak statement in the
 * same batch committed as well.
 */
export async function commitAttendanceBatch(
  database: AttendanceCommitDatabase,
  statements: D1PreparedStatement[],
  identity: AttendanceCommitIdentity,
) {
  let results: Awaited<ReturnType<AttendanceCommitDatabase["batch"]>> | null = null;
  try {
    results = await database.batch(statements);
  } catch (batchError) {
    const durableAttendance = await database.prepare(`
      SELECT id FROM attendance
      WHERE user_id=? AND attendance_date=? AND created_at=? AND points_awarded=?
      LIMIT 1
    `).bind(identity.userId, identity.date, identity.createdAt, identity.points)
      .first<{ id: number }>().catch(() => null);
    if (!durableAttendance) throw batchError;
    return;
  }

  if (Number(results[0]?.meta?.changes) !== 1) throw new AttendanceCommitConflict();
}
