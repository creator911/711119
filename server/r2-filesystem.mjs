import { createHash, randomUUID } from "node:crypto";
import {
  createWriteStream,
} from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const FORMAT_VERSION = 1;
const MAX_KEY_BYTES = 1024;
const MAX_LIST_LIMIT = 1000;
const SAFE_GENERATION = /^[0-9a-f-]{36}\.data$/i;
const HTTP_METADATA_HEADERS = {
  contentType: "content-type",
  contentLanguage: "content-language",
  contentDisposition: "content-disposition",
  contentEncoding: "content-encoding",
  cacheControl: "cache-control",
};

function invalidKey(message = "Invalid R2 object key") {
  return new TypeError(message);
}

function validateKey(key, { allowEmpty = false } = {}) {
  if (typeof key !== "string") throw invalidKey("R2 object key must be a string");
  if ((!allowEmpty && key.length === 0) || Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) {
    throw invalidKey(`R2 object key must contain 1-${MAX_KEY_BYTES} UTF-8 bytes`);
  }
  if (key.includes("\0") || /[\u0000-\u001f\u007f]/u.test(key)) throw invalidKey();
  if (key.includes("\\") || isAbsolute(key) || /^[a-zA-Z]:/.test(key)) throw invalidKey();
  const segments = key.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) throw invalidKey();
  return key;
}

function keyDigest(key) {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function isInside(parent, child) {
  const result = relative(parent, child);
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result));
}

function cloneCustomMetadata(metadata) {
  if (metadata == null) return {};
  if (typeof metadata !== "object" || Array.isArray(metadata)) throw new TypeError("customMetadata must be an object");
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => {
    if (typeof value !== "string") throw new TypeError(`customMetadata.${key} must be a string`);
    return [key, value];
  }));
}

function cloneHttpMetadata(metadata) {
  if (metadata == null) return {};
  if (typeof metadata !== "object" || Array.isArray(metadata)) throw new TypeError("httpMetadata must be an object");
  const result = {};
  for (const key of Object.keys(HTTP_METADATA_HEADERS)) {
    const value = metadata[key];
    if (value !== undefined && value !== null) result[key] = String(value);
  }
  if (metadata.cacheExpiry !== undefined && metadata.cacheExpiry !== null) {
    const expiry = metadata.cacheExpiry instanceof Date ? metadata.cacheExpiry : new Date(metadata.cacheExpiry);
    if (!Number.isFinite(expiry.getTime())) throw new TypeError("httpMetadata.cacheExpiry must be a valid date");
    result.cacheExpiry = expiry.toISOString();
  }
  return result;
}

function publicHttpMetadata(metadata = {}) {
  const result = { ...metadata };
  if (result.cacheExpiry) result.cacheExpiry = new Date(result.cacheExpiry);
  return result;
}

function writeHttpMetadata(metadata, headers) {
  for (const [property, header] of Object.entries(HTTP_METADATA_HEADERS)) {
    if (metadata[property]) headers.set(header, metadata[property]);
  }
  if (metadata.cacheExpiry) headers.set("expires", new Date(metadata.cacheExpiry).toUTCString());
}

function toNodeReadable(value) {
  if (typeof value === "string") return Readable.from([Buffer.from(value)]);
  if (value instanceof ArrayBuffer) return Readable.from([Buffer.from(value)]);
  if (ArrayBuffer.isView(value)) return Readable.from([
    Buffer.from(value.buffer, value.byteOffset, value.byteLength),
  ]);
  if (typeof Blob !== "undefined" && value instanceof Blob) return Readable.fromWeb(value.stream());
  if (value && typeof value.getReader === "function") return Readable.fromWeb(value);
  if (value && (typeof value[Symbol.asyncIterator] === "function" || typeof value.pipe === "function")) {
    return Readable.from(value);
  }
  throw new TypeError("R2 put value must be a string, ArrayBuffer, typed array, Blob, or stream");
}

function bodyMethods(body, contentType) {
  const response = () => new Response(body, {
    headers: contentType ? { "content-type": contentType } : undefined,
  });
  return {
    arrayBuffer: () => response().arrayBuffer(),
    text: () => response().text(),
    json: () => response().json(),
    blob: () => response().blob(),
  };
}

function decodeCursor(cursor) {
  if (!cursor) return "";
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed?.version !== FORMAT_VERSION || typeof parsed.after !== "string") throw new Error("bad cursor");
    return parsed.after;
  } catch {
    throw new TypeError("Invalid R2 list cursor");
  }
}

function encodeCursor(after) {
  return Buffer.from(JSON.stringify({ version: FORMAT_VERSION, after }), "utf8").toString("base64url");
}

function compareKeys(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function* filesUnder(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* filesUnder(path);
    else if (entry.isFile()) yield path;
  }
}

export class FilesystemR2Bucket {
  constructor(rootOrOptions) {
    const options = typeof rootOrOptions === "string" ? { root: rootOrOptions } : rootOrOptions;
    if (!options || typeof options.root !== "string" || !options.root.trim()) {
      throw new TypeError("FilesystemR2Bucket requires a configured root directory");
    }
    this.root = resolve(options.root);
    this.storageRoot = join(this.root, ".r2-filesystem");
    this.objectRoot = join(this.storageRoot, "objects");
    this.metadataRoot = join(this.storageRoot, "metadata");
    this.tempRoot = join(this.storageRoot, "tmp");
    this.locks = new Map();
    this.ready = this.#initialize();
  }

  async #initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("R2 filesystem root must be a real directory, not a symbolic link");
    }
    this.realRoot = await realpath(this.root);
    for (const directory of [this.storageRoot, this.objectRoot, this.metadataRoot, this.tempRoot]) {
      try {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe storage directory");
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await mkdir(directory, { recursive: true, mode: 0o700 });
      }
      const resolvedDirectory = await realpath(directory);
      if (!isInside(this.realRoot, resolvedDirectory)) throw new Error("R2 storage directory escapes configured root");
    }
  }

  #paths(key) {
    const digest = keyDigest(key);
    const shard = digest.slice(0, 2);
    return {
      digest,
      shard,
      metadata: join(this.metadataRoot, shard, `${digest}.json`),
      objectDirectory: join(this.objectRoot, shard),
    };
  }

  #dataPath(paths, generation) {
    if (!SAFE_GENERATION.test(generation)) throw new Error("Invalid stored R2 object generation");
    return join(paths.objectDirectory, `${paths.digest}.${generation}`);
  }

  async #ensureStorageDirectory(directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe R2 storage directory");
    const resolvedDirectory = await realpath(directory);
    if (!isInside(this.realRoot, resolvedDirectory)) throw new Error("R2 storage directory escapes configured root");
  }

  async #withKeyLock(key, callback) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolveLock) => { release = resolveLock; });
    const queued = previous.catch(() => undefined).then(() => current);
    this.locks.set(key, queued);
    await previous.catch(() => undefined);
    try {
      return await callback();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }

  async #readStoredMetadata(key) {
    const paths = this.#paths(key);
    let source;
    try {
      const stat = await lstat(paths.metadata);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe R2 metadata file");
      source = await readFile(paths.metadata, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    let metadata;
    try {
      metadata = JSON.parse(source);
    } catch {
      throw new Error(`Corrupt R2 metadata for key ${JSON.stringify(key)}`);
    }
    if (
      metadata?.format !== FORMAT_VERSION
      || metadata.key !== key
      || !Number.isSafeInteger(metadata.size)
      || metadata.size < 0
      || typeof metadata.etag !== "string"
      || typeof metadata.uploaded !== "string"
      || !SAFE_GENERATION.test(metadata.generation)
    ) {
      throw new Error(`Invalid R2 metadata for key ${JSON.stringify(key)}`);
    }
    return { metadata, paths };
  }

  async #openStoredData(stored) {
    const path = this.#dataPath(stored.paths, stored.metadata.generation);
    try {
      const pathStat = await lstat(path);
      if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new Error("Unsafe R2 object file");
      const handle = await open(path, "r");
      const fileStat = await handle.stat();
      if (fileStat.size !== stored.metadata.size) {
        await handle.close();
        throw new Error(`R2 object size does not match metadata for key ${JSON.stringify(stored.metadata.key)}`);
      }
      return handle;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  #publicObject(metadata, include = ["httpMetadata", "customMetadata"]) {
    const object = {
      key: metadata.key,
      size: metadata.size,
      etag: metadata.etag,
      httpEtag: `"${metadata.etag}"`,
      uploaded: new Date(metadata.uploaded),
      version: metadata.generation.slice(0, -5),
      writeHttpMetadata(headers) {
        writeHttpMetadata(metadata.httpMetadata ?? {}, headers);
      },
    };
    if (include.includes("httpMetadata")) object.httpMetadata = publicHttpMetadata(metadata.httpMetadata);
    if (include.includes("customMetadata")) object.customMetadata = { ...(metadata.customMetadata ?? {}) };
    return object;
  }

  async #writeMetadataAtomic(target, metadata) {
    const temporary = join(this.tempRoot, `${randomUUID()}.json.tmp`);
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(JSON.stringify(metadata), "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, target);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async put(key, value, options = {}) {
    validateKey(key);
    await this.ready;
    const httpMetadata = cloneHttpMetadata(options.httpMetadata);
    const customMetadata = cloneCustomMetadata(options.customMetadata);
    return this.#withKeyLock(key, async () => {
      const paths = this.#paths(key);
      await Promise.all([
        this.#ensureStorageDirectory(dirname(paths.metadata)),
        this.#ensureStorageDirectory(paths.objectDirectory),
      ]);
      const current = await this.#readStoredMetadata(key);
      const generation = `${randomUUID()}.data`;
      const finalData = this.#dataPath(paths, generation);
      const temporaryData = join(this.tempRoot, `${randomUUID()}.data.tmp`);
      const hash = createHash("sha256");
      let size = 0;
      let dataCommitted = false;
      let metadataCommitted = false;
      try {
        const digestingStream = new Transform({
          transform(chunk, _encoding, callback) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            hash.update(bytes);
            callback(null, bytes);
          },
        });
        await pipeline(
          toNodeReadable(value),
          digestingStream,
          createWriteStream(temporaryData, { flags: "wx", mode: 0o600 }),
        );
        const handle = await open(temporaryData, "r+");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporaryData, finalData);
        dataCommitted = true;
        const metadata = {
          format: FORMAT_VERSION,
          key,
          size,
          etag: hash.digest("hex"),
          uploaded: new Date().toISOString(),
          generation,
          httpMetadata,
          customMetadata,
        };
        await this.#writeMetadataAtomic(paths.metadata, metadata);
        metadataCommitted = true;
        if (current && current.metadata.generation !== generation) {
          const oldData = this.#dataPath(current.paths, current.metadata.generation);
          await unlink(oldData).catch(() => undefined);
        }
        return this.#publicObject(metadata);
      } catch (error) {
        await unlink(temporaryData).catch(() => undefined);
        if (dataCommitted && !metadataCommitted) await unlink(finalData).catch(() => undefined);
        throw error;
      }
    });
  }

  async head(key) {
    validateKey(key);
    await this.ready;
    return this.#withKeyLock(key, async () => {
      const stored = await this.#readStoredMetadata(key);
      if (!stored) return null;
      const handle = await this.#openStoredData(stored);
      if (!handle) return null;
      await handle.close();
      return this.#publicObject(stored.metadata);
    });
  }

  async get(key, options = {}) {
    validateKey(key);
    await this.ready;
    return this.#withKeyLock(key, async () => {
      const stored = await this.#readStoredMetadata(key);
      if (!stored) return null;
      const fullSize = stored.metadata.size;
      let offset = 0;
      let length = fullSize;
      const range = options?.range;
      if (range !== undefined) {
        if (!range || typeof range !== "object") throw new TypeError("R2 range must be an object");
        if (range.suffix !== undefined) {
          if (!Number.isSafeInteger(range.suffix) || range.suffix < 0) throw new TypeError("Invalid R2 suffix range");
          length = Math.min(range.suffix, fullSize);
          offset = fullSize - length;
        } else {
          offset = range.offset ?? 0;
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > fullSize) throw new TypeError("Invalid R2 range offset");
          length = range.length ?? (fullSize - offset);
          if (!Number.isSafeInteger(length) || length < 0) throw new TypeError("Invalid R2 range length");
          length = Math.min(length, fullSize - offset);
        }
      }
      const handle = await this.#openStoredData(stored);
      if (!handle) return null;
      let body;
      if (length === 0) {
        await handle.close();
        body = Readable.toWeb(Readable.from([]));
      } else {
        body = Readable.toWeb(handle.createReadStream({
          autoClose: true,
          start: offset,
          end: offset + length - 1,
        }));
      }
      const object = this.#publicObject(stored.metadata);
      object.body = body;
      object.range = { offset, length };
      Object.assign(object, bodyMethods(body, object.httpMetadata?.contentType));
      return object;
    });
  }

  async delete(keyOrKeys) {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    if (keys.length > MAX_LIST_LIMIT) throw new TypeError(`R2 delete accepts at most ${MAX_LIST_LIMIT} keys`);
    for (const key of keys) validateKey(key);
    await this.ready;
    await Promise.all([...new Set(keys)].map((key) => this.#withKeyLock(key, async () => {
      const stored = await this.#readStoredMetadata(key);
      if (!stored) return;
      await unlink(stored.paths.metadata).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      await unlink(this.#dataPath(stored.paths, stored.metadata.generation)).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    })));
  }

  async list(options = {}) {
    await this.ready;
    const prefix = validateKey(options.prefix ?? "", { allowEmpty: true });
    const startAfter = options.cursor ? decodeCursor(options.cursor) : (options.startAfter ?? "");
    if (startAfter) validateKey(startAfter);
    const delimiter = options.delimiter;
    if (delimiter !== undefined && (typeof delimiter !== "string" || !delimiter)) {
      throw new TypeError("R2 list delimiter must be a non-empty string");
    }
    const limit = options.limit ?? MAX_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new TypeError(`R2 list limit must be between 1 and ${MAX_LIST_LIMIT}`);
    }
    const include = options.include ?? [];
    if (!Array.isArray(include) || include.some((value) => value !== "httpMetadata" && value !== "customMetadata")) {
      throw new TypeError("R2 list include may only contain httpMetadata and customMetadata");
    }

    const entries = [];
    for await (const metadataPath of filesUnder(this.metadataRoot)) {
      if (!metadataPath.endsWith(".json")) continue;
      let metadata;
      try {
        metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      } catch {
        throw new Error(`Corrupt R2 metadata file ${metadataPath}`);
      }
      if (metadata?.format !== FORMAT_VERSION || typeof metadata.key !== "string") {
        throw new Error(`Invalid R2 metadata file ${metadataPath}`);
      }
      if (!metadata.key.startsWith(prefix)) continue;
      if (delimiter) {
        const remainder = metadata.key.slice(prefix.length);
        const index = remainder.indexOf(delimiter);
        if (index >= 0) {
          entries.push({ type: "prefix", key: `${prefix}${remainder.slice(0, index + delimiter.length)}` });
          continue;
        }
      }
      entries.push({ type: "object", key: metadata.key, metadata });
    }

    const unique = new Map();
    for (const entry of entries) unique.set(`${entry.type}:${entry.key}`, entry);
    const sorted = [...unique.values()]
      .filter((entry) => !startAfter || compareKeys(entry.key, startAfter) > 0)
      .sort((left, right) => compareKeys(left.key, right.key));
    const page = sorted.slice(0, limit);
    const truncated = sorted.length > page.length;
    const objects = page
      .filter((entry) => entry.type === "object")
      .map((entry) => this.#publicObject(entry.metadata, include));
    const delimitedPrefixes = page.filter((entry) => entry.type === "prefix").map((entry) => entry.key);
    return {
      objects,
      truncated,
      delimitedPrefixes,
      ...(truncated && page.length ? { cursor: encodeCursor(page.at(-1).key) } : {}),
    };
  }
}

export function createFilesystemR2Bucket(rootOrOptions) {
  return new FilesystemR2Bucket(rootOrOptions);
}

export const createFileSystemR2Bucket = createFilesystemR2Bucket;

export default createFilesystemR2Bucket;
