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
  // Mengembalikan URL lewat proxy backend
  return getPublicUrl(objectName)!;
}

/**
 * Hapus file dari MinIO.
 */
export async function deleteFile(objectName: string): Promise<void> {
  await minioClient.removeObject(BUCKET, objectName);
}

/**
 * Ambil URL publik dinamis lewat proxy backend.
 */
export function getPublicUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  // Jika sudah full URL (data legacy), return apa adanya
  if (path.startsWith("http")) return path;
  
  // Format: http://backend-domain.com/api/files/path/to/file.jpg
  return `${config.server.publicUrl}/api/files/${path}`;
}
