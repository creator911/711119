export type PostPollResult = {
  id: number;
  question: string;
  totalVotes: number;
  selectedOptionId: number | null;
  options: Array<{ id: number; label: string; votes: number; percentage: number }>;
};

export async function loadPostPoll(database: D1Database, postId: number, userId?: number | null): Promise<PostPollResult | null> {
  const poll = await database.prepare("SELECT id,question FROM post_polls WHERE post_id=?").bind(postId).first<{ id: number; question: string }>();
  if (!poll) return null;
  const optionRows = await database.prepare(`
    SELECT o.id,o.label,o.position,COUNT(v.id) AS votes
    FROM post_poll_options o
    LEFT JOIN post_poll_votes v ON v.option_id=o.id
    WHERE o.poll_id=?
    GROUP BY o.id,o.label,o.position
    ORDER BY o.position ASC
  `).bind(poll.id).all<{ id: number; label: string; position: number; votes: number }>();
  const selected = userId ? await database.prepare("SELECT option_id AS optionId FROM post_poll_votes WHERE poll_id=? AND user_id=?")
    .bind(poll.id, userId).first<{ optionId: number }>() : null;
  const totalVotes = optionRows.results.reduce((total, option) => total + Number(option.votes), 0);
  return {
    id: poll.id,
    question: poll.question,
    totalVotes,
    selectedOptionId: selected?.optionId ?? null,
    options: optionRows.results.map((option) => {
      const votes = Number(option.votes);
      return { id: option.id, label: option.label, votes, percentage: totalVotes ? Math.round(votes / totalVotes * 100) : 0 };
    }),
  };
}
