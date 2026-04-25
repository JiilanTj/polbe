import type { Context } from "hono";
import { stream } from "hono/streaming";
import { minioClient } from "../../lib/minio";
import { config } from "../../config";

const BUCKET = config.minio.bucket;

export const filesController = {
  /**
   * Proxy request ke MinIO agar file diakses lewat domain backend.
   * GET /api/files/:path
   */
  async serve(c: Context) {
    // Ambil path lengkap (termasuk subfolder) dari parameter
    const path = c.req.param("path");
    
    if (!path) {
      return c.json({ error: "Path file wajib diisi" }, 400);
    }

    try {
      // Ambil info object (untuk content-type dan size)
      const stat = await minioClient.statObject(BUCKET, path);
      
      // Ambil data stream dari MinIO
      const dataStream = await minioClient.getObject(BUCKET, path);

      // Set headers
      c.header("Content-Type", stat.metaData["content-type"] || "application/octet-stream");
      c.header("Content-Length", stat.size.toString());
      c.header("Cache-Control", "public, max-age=31536000"); // Cache 1 tahun (immutable)

      // Stream data ke client
      return stream(c, async (stream) => {
        for await (const chunk of dataStream) {
          await stream.write(chunk);
        }
      });
    } catch (err: any) {
      return c.json({ error: "File tidak ditemukan atau gagal diakses" }, 404);
    }
  }
};
