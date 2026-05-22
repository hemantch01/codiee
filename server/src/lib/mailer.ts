import dotenv from "dotenv";
import nodemailer from "nodemailer";

// Module-load env reads — load .env before touching SMTP_* (same as quota-client).
dotenv.config({ quiet: true });

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 1025);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || "Codiee <no-reply@codiee.local>";

const transporter = SMTP_HOST
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    })
  : null;

/** Send the signup OTP email. Without SMTP_HOST configured the code is logged to the
 * server console instead — local/dev signup works with zero mail setup. */
export async function sendOtpEmail(to: string, code: string): Promise<void> {
  const subject = "Your Codiee verification code";
  const text =
    `Your Codiee verification code is: ${code}\n\n` +
    `It expires in 10 minutes and can be used once.\n` +
    `If you didn't request this, you can ignore this email.`;
  const html =
    `<p>Your Codiee verification code is:</p>` +
    `<p style="font-size:28px;font-weight:bold;letter-spacing:6px">${code}</p>` +
    `<p>It expires in 10 minutes and can be used once. ` +
    `If you didn't request this, you can ignore this email.</p>`;

  if (!transporter) {
    console.warn(`[mailer] SMTP_HOST not set — OTP for ${to}: ${code}`);
    return;
  }

  await transporter.sendMail({ from: SMTP_FROM, to, subject, text, html });
}
