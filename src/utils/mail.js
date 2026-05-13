import nodemailer from 'nodemailer';
import { config } from '../config.js';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getTransport() {
  const { smtpHost, smtpUser, smtpPass } = config;
  if (!smtpHost || !smtpUser || !smtpPass) return null;
  return nodemailer.createTransport({
    host: smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: { user: smtpUser, pass: smtpPass },
  });
}

export function isMailConfigured() {
  return Boolean(config.smtpHost && config.smtpUser && config.smtpPass);
}

/**
 * @param {string} to
 * @param {string} resetLink
 * @param {string} [displayName]
 */
export async function sendPasswordResetEmail(to, resetLink, displayName) {
  const transport = getTransport();
  if (!transport) {
    throw new Error('SMTP not configured');
  }
  const from = config.emailFrom || config.smtpUser;
  const subject = 'Reset your ServeNCare password';
  const greeting = displayName ? `Hello ${escapeHtml(displayName)}` : 'Hello';
  const safeLink = escapeHtml(resetLink);
  const text = `${displayName ? `Hello ${displayName}` : 'Hello'},\n\nWe received a request to reset your password. Open the link below within 1 hour:\n\n${resetLink}\n\nIf you did not request this, you can ignore this email.\n`;
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Inter,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(15,23,42,0.08);">
          <tr>
            <td style="background:linear-gradient(135deg,#059669,#0d9488);padding:28px 32px;text-align:center;">
              <div style="display:inline-block;background:rgba(255,255,255,0.2);color:#fff;font-weight:800;font-size:14px;letter-spacing:0.06em;padding:8px 14px;border-radius:999px;">ServeNCare</div>
              <h1 style="margin:20px 0 0;font-size:22px;font-weight:800;color:#ffffff;line-height:1.3;">Reset your password</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 32px 24px;">
              <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#334155;">${greeting},</p>
              <p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:#64748b;">We received a request to reset your password. This link is valid for <strong style="color:#0f172a;">1 hour</strong>. If you did not ask for this, you can safely ignore this email.</p>
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 auto 28px;">
                <tr>
                  <td style="border-radius:12px;background:linear-gradient(135deg,#059669,#10b981);">
                    <a href="${safeLink}" style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">Create new password</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px;font-size:12px;line-height:1.5;color:#94a3b8;">Or copy this link into your browser:</p>
              <p style="margin:0 0 24px;font-size:12px;line-height:1.5;color:#64748b;word-break:break-all;background:#f8fafc;padding:12px 14px;border-radius:8px;border:1px solid #e2e8f0;">${safeLink}</p>
              <p style="margin:0;font-size:13px;line-height:1.55;color:#94a3b8;">Stay secure — never share this link with anyone.</p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">© ServeNCare · Password reset notification</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  await transport.sendMail({
    from,
    to,
    subject,
    text,
    html,
  });
}
