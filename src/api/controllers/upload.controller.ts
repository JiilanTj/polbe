import type { Context } from "hono";
import { uploadFile, getPublicUrl } from "../../lib/minio";
import { randomBytes } from "crypto";
import type { TokenPayload } from "../../lib/jwt";

// Tipe file yang diizinkan untuk upload
const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

// Max 5 MB
const MAX_SIZE_BYTES = 5 * 1024 * 1024;

export const uploadController = {
  /**
   * POST /api/upload
   * Multipart form upload. Field: `file`
   * Returns: { url: string }
   */
  async upload(c: Context) {
    const me = c.get("user") as TokenPayload;

    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json({ error: "Request harus multipart/form-data" }, 400);
    }

    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return c.json({ error: "Field 'file' wajib diisi (multipart form)" }, 422);
    }

    const ext = ALLOWED_TYPES[file.type];
    if (!ext) {
      return c.json({
        error: `Tipe file tidak didukung. Diizinkan: ${Object.keys(ALLOWED_TYPES).join(", ")}`,
      }, 415);
    }

    if (file.size > MAX_SIZE_BYTES) {
      return c.json({ error: `Ukuran file melebihi batas 5 MB (diterima: ${(file.size / 1024 / 1024).toFixed(2)} MB)` }, 413);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const uniqueName = `${Date.now()}-${randomBytes(8).toString("hex")}.${ext}`;
    const objectName = `uploads/user-${me.sub}/${uniqueName}`;

    await uploadFile(objectName, buffer, file.type);

    return c.json({
      url: objectName, // Path relative untuk disimpan di DB
      fullUrl: getPublicUrl(objectName), // URL lengkap lewat proxy backend
    }, 201);
  },
};
