import { PutBucketCorsCommand, S3Client } from "@aws-sdk/client-s3";

const required = ["R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

const origins = String(process.env.PUBLIC_ORIGINS || "https://www.nara001.co.kr,https://nara001.co.kr")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const client = new S3Client({
  endpoint: process.env.R2_ENDPOINT,
  region: process.env.R2_REGION || "auto",
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

await client.send(new PutBucketCorsCommand({
  Bucket: process.env.R2_BUCKET,
  CORSConfiguration: {
    CORSRules: [{
      AllowedHeaders: ["content-type"],
      AllowedMethods: ["PUT"],
      AllowedOrigins: origins,
      ExposeHeaders: ["etag"],
      MaxAgeSeconds: 3600,
    }],
  },
}));
client.destroy();
console.log(`Configured direct-upload CORS for ${origins.join(", ")}`);
