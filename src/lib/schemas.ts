import { z } from "zod";

// ─── Auth ─────────────────────────────────────────────────────
export const registerSchema = z.object({
  email: z.string().email("Format email tidak valid"),
  username: z
    .string()
    .min(3, "Username minimal 3 karakter")
    .max(50, "Username maksimal 50 karakter")
    .regex(/^[a-zA-Z0-9_]+$/, "Username hanya boleh huruf, angka, dan underscore"),
  password: z.string().min(8, "Password minimal 8 karakter"),
  referralCode: z.string().optional(),
});

export const loginSchema = z.object({
  email: z.string().email("Format email tidak valid"),
  password: z.string().min(1, "Password wajib diisi"),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email("Format email tidak valid"),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, "Token wajib diisi"),
  newPassword: z.string().min(8, "Password baru minimal 8 karakter"),
});

// ─── Me ───────────────────────────────────────────────────────
export const updateProfileSchema = z
  .object({
    username: z
      .string()
      .min(3)
      .max(50)
      .regex(/^[a-zA-Z0-9_]+$/, "Username hanya boleh huruf, angka, dan underscore")
      .optional(),
    avatarUrl: z.string().optional(),
    currentPassword: z.string().optional(),
    newPassword: z.string().min(8, "Password baru minimal 8 karakter").optional(),
  })
  .refine(
    (d) => !d.newPassword || !!d.currentPassword,
    { message: "currentPassword wajib diisi untuk ganti password", path: ["currentPassword"] },
  );

// ─── Polls ────────────────────────────────────────────────────
export const pollCreateSchema = z.object({
  title: z.string().min(5, "Judul minimal 5 karakter").max(500),
  description: z.string().max(2000).optional(),
  category: z.string().max(100).optional(),
  options: z
    .array(z.string().min(1).max(200))
    .min(2, "Minimal 2 opsi")
    .max(10, "Maksimal 10 opsi"),
  imageUrl: z.string().optional(),
  startAt: z.string().datetime({ message: "startAt harus ISO datetime" }).optional(),
  endAt: z.string().datetime({ message: "endAt harus ISO datetime" }).optional(),
  livesPerVote: z.number().int().min(1).max(1000).default(1),
  platformFeePercent: z.number().min(0).max(100).default(30),
  sourceArticleIds: z.array(z.number().int()).optional(),
  aiGenerated: z.boolean().default(false),
});

export const pollVoteSchema = z.object({
  optionIndex: z.number().int().min(0, "optionIndex tidak boleh negatif"),
});

export const pollResolveSchema = z.object({
  winnerOptionIndex: z.number().int().min(0, "winnerOptionIndex tidak boleh negatif"),
});

export const pollStatusSchema = z.object({
  status: z.enum(["draft", "active", "resolved", "closed"]),
});

// ─── Topup ────────────────────────────────────────────────────
export const topupCreateSchema = z.object({
  packageId: z.number().int().positive("packageId harus > 0"),
  proofImageUrl: z.string().min(1, "proofImageUrl wajib diisi"),
  walletAddress: z.string().optional(),
});

// ─── Withdrawal ───────────────────────────────────────────────
export const withdrawalCreateSchema = z.object({
  usdtAmount: z
    .number()
    .positive("usdtAmount harus > 0")
    .min(1, "Minimum withdrawal 1 USDT"),
  walletAddress: z.string().min(5, "walletAddress wajib diisi"),
});

// ─── Admin ────────────────────────────────────────────────────
export const adminCreditSchema = z.object({
  amount: z.number().int().refine((v) => v !== 0, "amount tidak boleh 0"),
  note: z.string().max(500).optional(),
});

export const adminRoleSchema = z.object({
  role: z.enum(["user", "admin", "platform"]),
});

export const adminTopupActionSchema = z.object({
  note: z.string().max(500).optional(),
  txHash: z.string().optional(),
});

// ─── Packages ─────────────────────────────────────────────────
export const packageCreateSchema = z.object({
  label: z.string().min(1).max(100),
  usdtPrice: z.number().positive("usdtPrice harus > 0"),
  livesAmount: z.number().int().positive("livesAmount harus > 0"),
  sortOrder: z.number().int().min(0).optional(),
});

// ─── CLOB Orders ─────────────────────────────────────────────
export const orderPlaceSchema = z.object({
  side: z.enum(["buy", "sell"]),
  optionIndex: z.number().int().min(0),
  price: z
    .number()
    .gt(0, "price harus > 0")
    .lt(1, "price harus < 1")
    .refine((v) => Number(v.toFixed(4)) === v || true, "max 4 desimal"),
  size: z.number().int().min(1, "size minimal 1 share").max(100_000, "size maksimal 100.000"),
  expiresAt: z.string().datetime({ message: "format datetime tidak valid" }).optional(),
});

// ─── Comments ─────────────────────────────────────────────────
export const commentCreateSchema = z.object({
  body: z.string().min(1, "Komentar tidak boleh kosong").max(1000, "Komentar max 1000 karakter"),
});
