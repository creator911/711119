import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function bodyValue(value) {
  if (value && typeof value.getReader === "function") return Readable.fromWeb(value);
  if (typeof Blob !== "undefined" && value instanceof Blob) return Readable.fromWeb(value.stream());
  return value;
}
function metadataOf(value = {}) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

function publicObject(result) {
  if (!result) return null;
  const body = result.Body?.transformToWebStream?.();
  return {
    body,
    size: Number(result.ContentLength ?? 0),
    etag: String(result.ETag ?? "").replace(/^"|"$/g, ""),
    uploaded: result.LastModified,
    httpMetadata: {
      contentType: result.ContentType,
      contentLanguage: result.ContentLanguage,
      contentDisposition: result.ContentDisposition,
      contentEncoding: result.ContentEncoding,
      cacheControl: result.CacheControl,
    },
    customMetadata: result.Metadata ?? {},
  };
}

export class S3R2Bucket {
  constructor({
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    region = "auto",
  }) {
    if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
      throw new Error("R2 endpoint, credentials, and bucket are required");
    }
    this.bucket = bucket;
    this.client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: false,
    });
  }

  async put(key, value, options = {}) {
    const body = bodyValue(value);
    const inferredLength = typeof body?.byteLength === "number"
      ? Number(body.byteLength)
      : typeof body?.size === "number"
        ? Number(body.size)
        : undefined;
    const contentLength = Number.isFinite(Number(options.size))
      ? Number(options.size)
      : inferredLength;
    const result = await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentLength: Number.isFinite(contentLength) ? contentLength : undefined,
      ContentType: options.httpMetadata?.contentType,
      ContentLanguage: options.httpMetadata?.contentLanguage,
      ContentDisposition: options.httpMetadata?.contentDisposition,
      ContentEncoding: options.httpMetadata?.contentEncoding,
      CacheControl: options.httpMetadata?.cacheControl,
      Metadata: metadataOf(options.customMetadata),
    }));
    return {
      key,
      etag: String(result.ETag ?? "").replace(/^"|"$/g, ""),
      version: result.VersionId,
    };
  }

  async head(key) {
    try {
      return publicObject(await this.client.send(new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })));
    } catch (error) {
      if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound") return null;
      throw error;
    }
  }

  async get(key, options = {}) {
    try {
      const range = options.range
        ? `bytes=${options.range.offset}-${options.range.offset + options.range.length - 1}`
        : undefined;
      return publicObject(await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: range,
      })));
    } catch (error) {
      if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NoSuchKey") return null;
      throw error;
    }
  }

  async delete(keys) {
    const values = Array.isArray(keys) ? keys : [keys];
    if (!values.length) return;
    if (values.length === 1) {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: values[0] }));
      return;
    }
    for (let offset = 0; offset < values.length; offset += 1_000) {
      await this.client.send(new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Quiet: true, Objects: values.slice(offset, offset + 1_000).map((Key) => ({ Key })) },
      }));
    }
  }

  async list(options = {}) {
    const result = await this.client.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: options.prefix,
      ContinuationToken: options.cursor,
      MaxKeys: options.limit,
    }));
    return {
      objects: (result.Contents ?? []).map((object) => ({
        key: object.Key,
        size: Number(object.Size ?? 0),
        etag: String(object.ETag ?? "").replace(/^"|"$/g, ""),
        uploaded: object.LastModified,
      })),
      truncated: Boolean(result.IsTruncated),
      cursor: result.NextContinuationToken,
    };
  }

  async createPresignedPutUrl(key, {
    expiresIn = 300,
    contentType,
    customMetadata,
  } = {}) {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      Metadata: metadataOf(customMetadata),
    });
    return getSignedUrl(this.client, command, { expiresIn });
  }

  destroy() {
    this.client.destroy();
  }
}

export function createS3R2BucketFromEnvironment(environment = process.env) {
  if (!environment.R2_ENDPOINT) return null;
  return new S3R2Bucket({
    endpoint: environment.R2_ENDPOINT,
    accessKeyId: environment.R2_ACCESS_KEY_ID,
    secretAccessKey: environment.R2_SECRET_ACCESS_KEY,
    bucket: environment.R2_BUCKET,
    region: environment.R2_REGION ?? "auto",
  });
}
