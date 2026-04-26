import { Resend } from "resend";
import { config } from "../config";

const resend = config.email.resendApiKey ? new Resend(config.email.resendApiKey) : null;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function buildResetPasswordUrl(token: string): string {
  const baseUrl = config.email.appPublicUrl.replace(/\/$/, "");
  return `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
}

export async function sendPasswordResetEmail(input: {
  to: string;
  username?: string | null;
  token: string;
}) {
  const resetUrl = buildResetPasswordUrl(input.token);
  const safeToken = escapeHtml(input.token);

  if (!resend) {
    return { sent: false, skipped: true, resetUrl, reason: "RESEND_API_KEY belum diset" };
  }

  const displayName = input.username?.trim() || input.to;
  const safeDisplayName = escapeHtml(displayName);
  const safeResetUrl = escapeHtml(resetUrl);

  const result = await resend.emails.send({
    from: config.email.from,
    to: input.to,
    subject: "Reset password Porygon",
    text: [
      `Halo ${displayName},`,
      "",
      "Kami menerima permintaan untuk reset password akun Porygon Anda.",
      `Buka tautan berikut untuk membuat password baru: ${resetUrl}`,
      `Atau gunakan token reset ini di aplikasi: ${input.token}`,
      "",
      "Jika Anda tidak meminta reset password, abaikan email ini.",
    ].join("\n"),
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111827;">
        <h2 style="margin: 0 0 16px;">Reset password Porygon</h2>
        <p style="margin: 0 0 12px;">Halo ${safeDisplayName},</p>
        <p style="margin: 0 0 16px;">Kami menerima permintaan untuk reset password akun Anda. Klik tombol di bawah untuk membuat password baru.</p>
        <p style="margin: 0 0 20px;">
          <a href="${safeResetUrl}" style="display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 12px 18px; border-radius: 8px; font-weight: 700;">Reset Password</a>
        </p>
        <p style="margin: 0 0 8px; font-size: 14px; color: #4b5563;">Jika link tidak bisa dibuka, gunakan token ini di aplikasi:</p>
        <p style="margin: 0 0 16px; font-size: 14px; font-weight: 700; letter-spacing: 0.2px; color: #111827;">${safeToken}</p>
        <p style="margin: 0 0 8px; font-size: 14px; color: #4b5563;">Atau salin tautan ini:</p>
        <p style="margin: 0; font-size: 14px; word-break: break-all; color: #2563eb;">${safeResetUrl}</p>
        <p style="margin: 20px 0 0; font-size: 13px; color: #6b7280;">Jika Anda tidak meminta reset password, abaikan email ini.</p>
      </div>
    `,
  });

  if (result.error) {
    return { sent: false, resetUrl, error: result.error.message };
  }

  return { sent: true, resetUrl, emailId: result.data?.id ?? null };
}