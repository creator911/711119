type OutboxDatabase = Pick<D1Database, "prepare">;

export async function enqueueOutboxJob(
  database: OutboxDatabase,
  topic: string,
  payload: unknown,
  availableAt = new Date(),
) {
  const normalizedTopic = topic.trim();
  if (!/^[a-z][a-z0-9_.:-]{1,79}$/i.test(normalizedTopic)) throw new TypeError("Invalid outbox topic");
  const now = new Date().toISOString();
  return database.prepare(`
    INSERT INTO outbox_jobs(topic,payload,status,available_at,attempts,created_at)
    VALUES(?,?,'pending',?,0,?)
  `).bind(normalizedTopic, JSON.stringify(payload ?? {}), availableAt.toISOString(), now).run();
}
