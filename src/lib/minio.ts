import * as Minio from "minio";
import { config } from "../config";

export const minioClient = new Minio.Client({
  endPoint: config.minio.endpoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
});

const BUCKET = config.minio.bucket;

/**
 * Pastikan bucket ada. Dipanggil saat server start.
 */
export async function ensureBucket(): Promise<void> {
  const exists = await minioClient.bucketExists(BUCKET);
  if (!exists) {
    await minioClient.makeBucket(BUCKET);
    // Set bucket policy ke public-read agar file bisa diakses langsung via URL
    const policy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { AWS: ["*"] },
          Action: ["s3:GetObject"],
          Resource: [`arn:aws:s3:::${BUCKET}/*`],
        },
      ],
    });
    await minioClient.setBucketPolicy(BUCKET, policy);
    console.log(`[MinIO] Bucket '${BUCKET}' dibuat.`);
  }
}

/**
 * Upload buffer/stream ke MinIO, return URL publik.
 */
export async function uploadFile(
  objectName: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  await minioClient.putObject(BUCKET, objectName, buffer, buffer.length, {
    "Content-Type": contentType,
  });
  return `${config.minio.publicUrl}/${BUCKET}/${objectName}`;
}

/**
 * Hapus file dari MinIO.
 */
export async function deleteFile(objectName: string): Promise<void> {
  await minioClient.removeObject(BUCKET, objectName);
}
