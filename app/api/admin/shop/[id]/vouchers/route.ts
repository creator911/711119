import { env } from "cloudflare:workers";
import { adminSession } from "../../../../../lib/admin-auth";
import { deliverPendingShopPurchases, publicShopProduct, shopProduct } from "../../../../../lib/shop";

type MediaBucket = {
  put: (key: string, value: ArrayBuffer, options: { httpMetadata: { contentType: string }; customMetadata: Record<string, string> }) => Promise<unknown>;
  delete: (key: string | string[]) => Promise<unknown>;
};

type AvailableVoucherRow = {
  id: number;
  objectKey: string;
  originalName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
};

type DeletedVoucherRow = Pick<AvailableVoucherRow, "id" | "objectKey">;

const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};
const FILE_LIMIT = 5 * 1024 * 1024;
const TOTAL_LIMIT = 100 * 1024 * 1024;
const LIST_LIMIT = 60;
const DELETE_BATCH_LIMIT = 500;
const SELECTED_DELETE_LIMIT = 80;
const CLEANUP_RETRY_LIMIT = 100;

const productResponse = async (productId: number) => {
  const saved = await shopProduct(env.DB, productId, true);
  if (!saved) return null;
  return {
    ...publicShopProduct(saved),
    active: saved.status === "active",
    pendingPurchases: Number(saved.pendingPurchases),
    deliveredPurchases: Number(saved.deliveredPurchases),
  };
};

const productIdFromContext = async (context: { params: Promise<{ id: string }> }) => {
  const productId = Number((await context.params).id);
  return Number.isInteger(productId) && productId > 0 ? productId : null;
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const operator = await adminSession(request, env);
  if (!operator) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  const productId = await productIdFromContext(context);
  if (!productId) return Response.json({ error: "상품 번호를 확인해 주세요." }, { status: 400 });
  if (!await shopProduct(env.DB, productId, true)) return Response.json({ error: "상품을 찾을 수 없습니다." }, { status: 404 });

  const bucket = (env as unknown as { MEDIA?: MediaBucket }).MEDIA;
  if (bucket) await retryPendingVoucherCleanup(bucket, productId);

  const url = new URL(request.url);
  const cursorValue = url.searchParams.get("cursor") ?? "0";
  const cursor = Number(cursorValue);
  if (!Number.isSafeInteger(cursor) || cursor < 0) return Response.json({ error: "목록 위치를 확인해 주세요." }, { status: 400 });

  const rows = (await env.DB.prepare(`
    SELECT id,object_key AS objectKey,original_name AS originalName,content_type AS contentType,
           size_bytes AS sizeBytes,created_at AS createdAt
    FROM shop_vouchers
    WHERE product_id=? AND status='available' AND purchase_id IS NULL AND id>?
    ORDER BY id ASC LIMIT ?
  `).bind(productId, cursor, LIST_LIMIT + 1).all<AvailableVoucherRow>()).results;
  const hasMore = rows.length > LIST_LIMIT;
  const vouchers = rows.slice(0, LIST_LIMIT).map((row) => ({
    id: Number(row.id),
    originalName: row.originalName,
    contentType: row.contentType,
    sizeBytes: Number(row.sizeBytes),
    createdAt: row.createdAt,
    imageUrl: `/api/shop/vouchers/${row.id}/image`,
  }));
  const product = await productResponse(productId);
  if (!product) return Response.json({ error: "상품을 찾을 수 없습니다." }, { status: 404 });
  return Response.json({
    vouchers,
    hasMore,
    nextCursor: hasMore ? vouchers.at(-1)?.id ?? null : null,
    product,
  }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const operator = await adminSession(request, env);
  if (!operator) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  const productId = await productIdFromContext(context);
  if (!productId) return Response.json({ error: "상품 번호를 확인해 주세요." }, { status: 400 });
  if (!await shopProduct(env.DB, productId, true)) return Response.json({ error: "상품을 찾을 수 없습니다." }, { status: 404 });

  const form = await request.formData();
  const files = form.getAll("files").filter((value): value is File => value instanceof File && value.size > 0);
  if (!files.length || files.length > 30) return Response.json({ error: "지급 이미지는 한 번에 1~30개까지 추가할 수 있습니다." }, { status: 400 });
  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > TOTAL_LIMIT) return Response.json({ error: "한 번에 추가하는 이미지의 전체 용량은 100MB 이하여야 합니다." }, { status: 413 });
  for (const file of files) {
    if (!IMAGE_TYPES[file.type]) return Response.json({ error: "JPG, PNG, GIF, WebP 이미지만 지급 이미지로 사용할 수 있습니다." }, { status: 415 });
    if (file.size > FILE_LIMIT) return Response.json({ error: "지급 이미지는 한 장당 5MB 이하여야 합니다." }, { status: 413 });
  }

  const bucket = (env as unknown as { MEDIA: MediaBucket }).MEDIA;
  if (!bucket) return Response.json({ error: "파일 저장소가 설정되지 않았습니다." }, { status: 503 });
  const uploaded: Array<{ key: string; file: File }> = [];
  let voucherRowsCreated = false;
  try {
    for (const file of files) {
      const key = `shop-private/${crypto.randomUUID()}.${IMAGE_TYPES[file.type]}`;
      await bucket.put(key, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type },
        customMetadata: { uploader: operator.username, purpose: `shop-voucher:${productId}`, originalName: file.name.slice(0, 160) },
      });
      uploaded.push({ key, file });
    }
    const createdAt = new Date().toISOString();
    await env.DB.batch(uploaded.map(({ key, file }) => env.DB.prepare(`
      INSERT INTO shop_vouchers(product_id,object_key,original_name,content_type,size_bytes,status,created_at)
      VALUES(?,?,?,?,?,'available',?)
    `).bind(productId, key, file.name.slice(0, 160), file.type, file.size, createdAt)));
    voucherRowsCreated = true;
    const delivered = await deliverPendingShopPurchases(env.DB, productId, uploaded.length).catch((error) => {
      console.error("Automatic shop delivery failed after voucher registration", error);
      return [];
    });
    const saved = await productResponse(productId);
    if (!saved) throw new Error("Saved shop product is unavailable");
    return Response.json({
      uploaded: uploaded.length,
      delivered: delivered.length,
      product: saved,
    }, { status: 201 });
  } catch (error) {
    if (!voucherRowsCreated && uploaded.length) {
      await bucket.delete(uploaded.map((item) => item.key)).catch(() => Promise.all(uploaded.map((item) => bucket.delete(item.key).catch(() => undefined))));
    }
    console.error("Admin shop voucher upload failed", error);
    return Response.json({ error: "자동상품 지급 이미지를 저장하지 못했습니다." }, { status: 500 });
  }
}

const parseDeleteRequest = async (request: Request) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { error: "삭제 요청 형식을 확인해 주세요." } as const;
  }
  if (!body || typeof body !== "object") return { error: "삭제 요청 형식을 확인해 주세요." } as const;
  const candidate = body as { mode?: unknown; ids?: unknown };
  if (candidate.mode === "all") return { mode: "all" as const, ids: [] };
  if (candidate.mode !== "selected" || !Array.isArray(candidate.ids)) return { error: "삭제 방식을 확인해 주세요." } as const;
  const ids = [...new Set(candidate.ids.map(Number))];
  if (!ids.length || ids.length > SELECTED_DELETE_LIMIT || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) {
    return { error: `삭제할 이미지는 한 번에 1~${SELECTED_DELETE_LIMIT}개까지 선택해 주세요.` } as const;
  }
  return { mode: "selected" as const, ids };
};

const removeBucketObjects = async (bucket: MediaBucket, rows: DeletedVoucherRow[]) => {
  const removed: DeletedVoucherRow[] = [];
  const pending: DeletedVoucherRow[] = [];
  for (let offset = 0; offset < rows.length; offset += 100) {
    const chunk = rows.slice(offset, offset + 100);
    try {
      await bucket.delete(chunk.map((row) => row.objectKey));
      removed.push(...chunk);
    } catch (error) {
      console.error("Admin shop voucher storage cleanup batch failed", error);
      const results = await Promise.allSettled(chunk.map((row) => bucket.delete(row.objectKey)));
      results.forEach((result, index) => {
        (result.status === "fulfilled" ? removed : pending).push(chunk[index]);
      });
    }
  }
  return { removed, pending };
};

const deleteCompletedCleanupRows = async (rows: DeletedVoucherRow[]) => {
  for (let offset = 0; offset < rows.length; offset += SELECTED_DELETE_LIMIT) {
    const ids = rows.slice(offset, offset + SELECTED_DELETE_LIMIT).map((row) => row.id);
    if (!ids.length) continue;
    const placeholders = ids.map(() => "?").join(",");
    await env.DB.prepare(`
      DELETE FROM shop_voucher_cleanup_queue
      WHERE voucher_id IN (${placeholders})
    `).bind(...ids).run();
  }
};

const markCleanupFailures = async (rows: DeletedVoucherRow[]) => {
  for (let offset = 0; offset < rows.length; offset += SELECTED_DELETE_LIMIT) {
    const ids = rows.slice(offset, offset + SELECTED_DELETE_LIMIT).map((row) => row.id);
    if (!ids.length) continue;
    const placeholders = ids.map(() => "?").join(",");
    await env.DB.prepare(`
      UPDATE shop_voucher_cleanup_queue
      SET attempts=attempts+1,last_error='storage_delete_failed'
      WHERE voucher_id IN (${placeholders})
    `).bind(...ids).run();
  }
};

const retryPendingVoucherCleanup = async (bucket: MediaBucket, productId: number) => {
  try {
    const pendingRows = (await env.DB.prepare(`
      SELECT voucher_id AS id,object_key AS objectKey
      FROM shop_voucher_cleanup_queue
      WHERE product_id=?
      ORDER BY attempts ASC,voucher_id ASC LIMIT ?
    `).bind(productId, CLEANUP_RETRY_LIMIT).all<DeletedVoucherRow>()).results;
    if (!pendingRows.length) return;
    const cleanup = await removeBucketObjects(bucket, pendingRows);
    await deleteCompletedCleanupRows(cleanup.removed);
    await markCleanupFailures(cleanup.pending);
  } catch (error) {
    // The cleanup queue is durable, so the next admin list/delete request safely
    // retries any object whose storage or queue update failed.
    console.error("Admin shop voucher pending cleanup retry failed", error);
  }
};

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const operator = await adminSession(request, env);
  if (!operator) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  const productId = await productIdFromContext(context);
  if (!productId) return Response.json({ error: "상품 번호를 확인해 주세요." }, { status: 400 });
  if (!await shopProduct(env.DB, productId, true)) return Response.json({ error: "상품을 찾을 수 없습니다." }, { status: 404 });

  const parsed = await parseDeleteRequest(request);
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
  const bucket = (env as unknown as { MEDIA: MediaBucket }).MEDIA;
  if (!bucket) return Response.json({ error: "파일 저장소가 설정되지 않았습니다." }, { status: 503 });

  try {
    await retryPendingVoucherCleanup(bucket, productId);
    const cleanupToken = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    let queueStatement;
    if (parsed.mode === "selected") {
      const placeholders = parsed.ids.map(() => "?").join(",");
      queueStatement = env.DB.prepare(`
        INSERT OR IGNORE INTO shop_voucher_cleanup_queue(
          voucher_id,product_id,object_key,cleanup_token,created_at
        )
        SELECT id,product_id,object_key,?,?
        FROM shop_vouchers
        WHERE product_id=? AND status='available' AND purchase_id IS NULL
          AND id IN (${placeholders})
      `).bind(cleanupToken, createdAt, productId, ...parsed.ids);
    } else {
      queueStatement = env.DB.prepare(`
        INSERT OR IGNORE INTO shop_voucher_cleanup_queue(
          voucher_id,product_id,object_key,cleanup_token,created_at
        )
        SELECT id,product_id,object_key,?,?
        FROM shop_vouchers
        WHERE product_id=? AND status='available' AND purchase_id IS NULL
        ORDER BY id ASC LIMIT ?
      `).bind(cleanupToken, createdAt, productId, DELETE_BATCH_LIMIT);
    }

    await env.DB.batch([
      queueStatement,
      env.DB.prepare(`
        DELETE FROM shop_vouchers
        WHERE product_id=? AND status='available' AND purchase_id IS NULL
          AND id IN (
            SELECT voucher_id FROM shop_voucher_cleanup_queue WHERE cleanup_token=?
          )
      `).bind(productId, cleanupToken),
    ]);
    const deletedRows = (await env.DB.prepare(`
      SELECT voucher_id AS id,object_key AS objectKey
      FROM shop_voucher_cleanup_queue
      WHERE cleanup_token=? ORDER BY voucher_id ASC
    `).bind(cleanupToken).all<DeletedVoucherRow>()).results;

    // Queue insertion and the guarded voucher-row delete are one transaction.
    // A simultaneous purchase therefore either claims the voucher first or leaves
    // it to this cleanup, never both. Failed object deletes remain in the queue.
    const cleanup = await removeBucketObjects(bucket, deletedRows);
    await deleteCompletedCleanupRows(cleanup.removed);
    await markCleanupFailures(cleanup.pending);
    const remainingRow = await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM shop_vouchers
      WHERE product_id=? AND status='available' AND purchase_id IS NULL
    `).bind(productId).first<{ count: number }>();
    const product = await productResponse(productId);
    if (!product) throw new Error("Saved shop product is unavailable");
    const remainingAvailable = Number(remainingRow?.count ?? 0);
    const requested = parsed.mode === "selected" ? parsed.ids.length : deletedRows.length;
    return Response.json({
      deleted: deletedRows.length,
      skipped: Math.max(0, requested - deletedRows.length),
      remainingAvailable,
      hasMore: parsed.mode === "all" && remainingAvailable > 0,
      storageCleanupPending: cleanup.pending.length,
      product,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Admin shop voucher delete failed", error);
    return Response.json({ error: "지급 이미지를 삭제하지 못했습니다." }, { status: 500 });
  }
}
