import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { createFilesystemR2Bucket } from "../r2-filesystem.mjs";
import { createS3R2BucketFromEnvironment } from "../r2-s3.mjs";

const sourceDirectory = path.resolve(process.env.NARA_MEDIA_DIR || path.join(process.env.NARA_DATA_DIR || ".nara-data", "media"));
const reportPath = path.resolve(process.env.R2_MIGRATION_REPORT || "outputs/r2-migration-report.json");
const target = createS3R2BucketFromEnvironment();
if (!target) throw new Error("R2 environment is incomplete");
const source = createFilesystemR2Bucket(sourceDirectory);
const startedAt = new Date().toISOString();
const copied = [];
const skipped = [];
const manifestHash = createHash("sha256");
let sourceObjects = 0;
let sourceBytes = 0;
let cursor;

async function bodySha256(body) {
  if (!body) throw new Error("Object body is unavailable");
  const hash = createHash("sha256");
  const stream = typeof body.getReader === "function" ? Readable.fromWeb(body) : body;
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

do {
  const page = await source.list({ cursor, limit: 500 });
  for (const item of page.objects) {
    sourceObjects += 1;
    sourceBytes += Number(item.size);
    const sourceObject = await source.get(item.key);
    if (!sourceObject) throw new Error(`Source object disappeared during verification: ${item.key}`);
    const sourceSha256 = await bodySha256(sourceObject.body);
    if (sourceSha256 !== item.etag) throw new Error(`Source checksum mismatch for ${item.key}`);
    manifestHash.update(`${item.key}\u0000${item.size}\u0000${sourceSha256}\n`);
    const existing = await target.head(item.key);
    if (existing
      && Number(existing.size) === Number(item.size)
      && existing.customMetadata?.["nara-sha256"] === sourceSha256) {
      const targetObject = await target.get(item.key);
      if (targetObject && await bodySha256(targetObject.body) === sourceSha256) {
        skipped.push({ key: item.key, size: Number(item.size), sha256: sourceSha256 });
        continue;
      }
    }
    const uploadObject = await source.get(item.key);
    if (!uploadObject) throw new Error(`Source object disappeared during copy: ${item.key}`);
    await target.put(item.key, uploadObject.body, {
      size: Number(item.size),
      httpMetadata: uploadObject.httpMetadata,
      customMetadata: {
        ...uploadObject.customMetadata,
        "nara-sha256": sourceSha256,
      },
    });
    const verified = await target.head(item.key);
    const targetObject = await target.get(item.key);
    const targetSha256 = targetObject ? await bodySha256(targetObject.body) : "";
    if (!verified
      || Number(verified.size) !== Number(item.size)
      || verified.customMetadata?.["nara-sha256"] !== sourceSha256
      || targetSha256 !== sourceSha256) {
      throw new Error(`R2 verification failed for ${item.key}`);
    }
    copied.push({ key: item.key, size: Number(item.size), sha256: sourceSha256, etag: verified.etag });
  }
  cursor = page.truncated ? page.cursor : undefined;
} while (cursor);

const report = {
  sourceDirectory,
  startedAt,
  completedAt: new Date().toISOString(),
  sourceObjects,
  sourceBytes,
  verifiedObjects: copied.length + skipped.length,
  verifiedBytes: copied.reduce((sum, item) => sum + item.size, 0)
    + skipped.reduce((sum, item) => sum + item.size, 0),
  manifestSha256: manifestHash.digest("hex"),
  copiedObjects: copied.length,
  copiedBytes: copied.reduce((sum, item) => sum + item.size, 0),
  skippedObjects: skipped.length,
  skippedBytes: skipped.reduce((sum, item) => sum + item.size, 0),
  skipped,
  copied,
};
if (report.sourceObjects !== report.verifiedObjects || report.sourceBytes !== report.verifiedBytes) {
  throw new Error("R2 manifest totals do not match after migration");
}
mkdirSync(path.dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
target.destroy();
console.log(JSON.stringify(report));
