import { Hono } from "hono";
import { filesController } from "../controllers/files.controller";

export const filesRoutes = new Hono();

// Menggunakan wildcard {path:.*} agar bisa menangkap subfolder (misal: uploads/user-1/abc.jpg)
filesRoutes.get("/:path{.*}", filesController.serve);
