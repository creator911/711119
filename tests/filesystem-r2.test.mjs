import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createFilesystemR2Bucket } from "../server/r2-filesystem.mjs";

test("filesystem R2 compatibility stores each supported body type and serves ranges and metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "portal-r2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bucket = createFilesystemR2Bucket({ root });

  const arrayBuffer = new TextEncoder().encode("array-buffer").buffer;
  await bucket.put("media/array.txt", arrayBuffer, {
    httpMetadata: { contentType: "text/plain", cacheControl: "public, max-age=60" },
    customMetadata: { uploader: "test" },
  });
  await bucket.put("media/blob.txt", new Blob(["blob-body"], { type: "text/plain" }));
  await bucket.put("media/bytes.bin", new Uint8Array([0, 1, 2, 3]));
  await bucket.put("media/web-stream.txt", new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("web-"));
      controller.enqueue(new TextEncoder().encode("stream"));
      controller.close();
    },
  }));
  await bucket.put("media/node-stream.txt", Readable.from(["node-", "stream"]));
  await bucket.put("nested/one/value.txt", "nested-one");
  await bucket.put("nested/two/value.txt", "nested-two");

  const head = await bucket.head("media/array.txt");
  assert.equal(head.size, 12);
  assert.equal(head.httpMetadata.contentType, "text/plain");
  assert.equal(head.customMetadata.uploader, "test");
  assert.match(head.etag, /^[0-9a-f]{64}$/);
  const headers = new Headers();
  head.writeHttpMetadata(headers);
  assert.equal(headers.get("content-type"), "text/plain");
  assert.equal(headers.get("cache-control"), "public, max-age=60");

  assert.equal(await (await bucket.get("media/blob.txt")).text(), "blob-body");
  assert.deepEqual([...new Uint8Array(await (await bucket.get("media/bytes.bin")).arrayBuffer())], [0, 1, 2, 3]);
  assert.equal(await (await bucket.get("media/web-stream.txt")).text(), "web-stream");
  assert.equal(await (await bucket.get("media/node-stream.txt")).text(), "node-stream");
  const range = await bucket.get("media/array.txt", { range: { offset: 6, length: 6 } });
  assert.deepEqual(range.range, { offset: 6, length: 6 });
  assert.equal(await range.text(), "buffer");

  const firstPage = await bucket.list({ prefix: "media/", limit: 2, include: ["httpMetadata", "customMetadata"] });
  assert.equal(firstPage.objects.length, 2);
  assert.equal(firstPage.truncated, true);
  assert.ok(firstPage.cursor);
  const secondPage = await bucket.list({ prefix: "media/", limit: 10, cursor: firstPage.cursor });
  assert.equal(secondPage.objects.length, 3);
  assert.equal(secondPage.truncated, false);
  const delimiterPage = await bucket.list({ prefix: "nested/", delimiter: "/", limit: 1 });
  assert.deepEqual(delimiterPage.delimitedPrefixes, ["nested/one/"]);
  const nextDelimiterPage = await bucket.list({ prefix: "nested/", delimiter: "/", cursor: delimiterPage.cursor });
  assert.deepEqual(nextDelimiterPage.delimitedPrefixes, ["nested/two/"]);

  await bucket.delete(["media/blob.txt", "media/bytes.bin"]);
  assert.equal(await bucket.head("media/blob.txt"), null);
  assert.equal(await bucket.get("media/bytes.bin"), null);
});

test("filesystem R2 compatibility blocks traversal and keeps the prior object after a failed streaming overwrite", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "portal-r2-security-"));
  const root = join(parent, "bucket");
  t.after(() => rm(parent, { recursive: true, force: true }));
  const bucket = createFilesystemR2Bucket(root);

  for (const key of ["../escape.txt", "safe/../../escape.txt", "C:\\escape.txt", "/escape.txt"]) {
    await assert.rejects(bucket.put(key, "forbidden"), /Invalid R2 object key/);
  }
  assert.equal(existsSync(join(parent, "escape.txt")), false);

  await bucket.put("safe/object.txt", "original");
  await bucket.put("safe/successful-overwrite.txt", "before");
  await bucket.put("safe/successful-overwrite.txt", "after");
  assert.equal(await (await bucket.get("safe/successful-overwrite.txt")).text(), "after");
  const broken = Readable.from((async function* () {
    yield "partial replacement";
    throw new Error("simulated upload failure");
  })());
  await assert.rejects(bucket.put("safe/object.txt", broken), /simulated upload failure/);
  assert.equal(await (await bucket.get("safe/object.txt")).text(), "original");

  const storedFiles = [];
  async function collect(directory) {
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else storedFiles.push(path);
    }
  }
  await collect(join(root, ".r2-filesystem"));
  assert.equal(storedFiles.some((path) => path.includes("safe/object.txt")), false);
  const metadataSources = await Promise.all(storedFiles.filter((path) => path.endsWith(".json")).map((path) => readFile(path, "utf8")));
  assert.equal(metadataSources.some((source) => source.includes('"key":"safe/object.txt"')), true);
});
