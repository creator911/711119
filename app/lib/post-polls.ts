import { normalizeRichBody } from "./rich-text";

export type PollDraft = { question: string; options: string[] };
export class PollValidationError extends Error {}

const POLL_BLOCK = /<blockquote\b[^>]*class=(?:"editor-poll-card"|'editor-poll-card')[^>]*>[\s\S]*?<\/blockquote>/gi;
const POLL_CONFIG = /data-poll-config=(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)')/i;
const PENDING_SLOT = '<div class="post-poll-slot" data-poll-id="0"></div>';

const decodeConfig = (value: string) => {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))) as unknown;
};

const normalizeLine = (value: unknown, maxLength: number) => typeof value === "string"
  ? value.trim().replace(/\s+/g, " ").slice(0, maxLength + 1)
  : "";

function validatedDraft(encoded: string): PollDraft {
  let parsed: unknown;
  try { parsed = decodeConfig(encoded); }
  catch { throw new PollValidationError("투표 설정을 읽지 못했습니다. 투표를 다시 만들어 주세요."); }
  const source = parsed as { question?: unknown; options?: unknown };
  const question = normalizeLine(source?.question, 100);
  const options = Array.isArray(source?.options) ? source.options.map((option) => normalizeLine(option, 60)) : [];
  if (question.length < 2 || question.length > 100) throw new PollValidationError("투표 질문은 2–100자로 입력해 주세요.");
  if (options.length < 2 || options.length > 10 || options.some((option) => !option || option.length > 60)) {
    throw new PollValidationError("투표 선택지는 2–10개, 각 1–60자로 입력해 주세요.");
  }
  if (new Set(options.map((option) => option.toLocaleLowerCase("ko-KR"))).size !== options.length) {
    throw new PollValidationError("같은 투표 선택지는 중복해서 사용할 수 없습니다.");
  }
  return { question, options };
}

export function preparePostBody(input: string) {
  const blocks = Array.from(input.matchAll(POLL_BLOCK));
  if (blocks.length > 1) throw new PollValidationError("게시글 하나에는 투표를 하나만 넣을 수 있습니다.");
  let poll: PollDraft | null = null;
  let source = input;
  if (blocks.length === 1) {
    const encoded = blocks[0][0].match(POLL_CONFIG)?.slice(1).find(Boolean);
    if (!encoded) throw new PollValidationError("투표 설정이 올바르지 않습니다. 투표를 다시 만들어 주세요.");
    poll = validatedDraft(encoded);
    source = input.replace(blocks[0][0], PENDING_SLOT);
  }
  const normalized = normalizeRichBody(source.replace(/\r\n/g, "\n"));
  return { ...normalized, poll };
}

export async function attachPostPoll(database: D1Database, postId: number, body: string, poll: PollDraft | null, createdAt: string) {
  if (!poll) return body;
  let pollId: number | null = null;
  try {
    const inserted = await database.prepare("INSERT INTO post_polls(post_id,question,created_at) VALUES(?,?,?)")
      .bind(postId, poll.question, createdAt).run();
    pollId = Number(inserted.meta.last_row_id);
    if (!Number.isInteger(pollId) || pollId < 1) throw new Error("투표 번호를 만들지 못했습니다.");
    const finalBody = body.replace('data-poll-id="0"', `data-poll-id="${pollId}"`);
    await database.batch([
      ...poll.options.map((option, index) => database.prepare("INSERT INTO post_poll_options(poll_id,position,label) VALUES(?,?,?)").bind(pollId, index + 1, option)),
      database.prepare("UPDATE posts SET body=? WHERE id=?").bind(finalBody, postId),
    ]);
    return finalBody;
  } catch (error) {
    if (pollId) {
      await database.batch([
        database.prepare("DELETE FROM post_poll_options WHERE poll_id=?").bind(pollId),
        database.prepare("DELETE FROM post_polls WHERE id=?").bind(pollId),
      ]).catch(() => undefined);
    }
    await database.prepare("DELETE FROM posts WHERE id=?").bind(postId).run().catch(() => undefined);
    throw error;
  }
}
