import crypto from 'node:crypto';
import { ApiError } from './ApiError.js';

// Sends mail through nodemailer. Env: SMTP_HOST, SMTP_PORT (465 = implicit TLS, 587 = STARTTLS), SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM.
// MAIL_TRANSPORT=console prints the message to the server log instead (local development only).

const TIMEOUT_MS = 15000;
const PASSWORD_CHARS = {
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  lower: 'abcdefghijkmnopqrstuvwxyz',
  digit: '23456789',
};

/** Random password with letters and digits (ambiguous characters such as 0/O and 1/l/I left out). */
export function generatePassword(length = 12) {
  const all = Object.values(PASSWORD_CHARS).join('');
  const pick = (set) => set[crypto.randomInt(set.length)];
  // At least one upper-case letter, one lower-case letter and one digit, the rest random.
  const chars = [pick(PASSWORD_CHARS.upper), pick(PASSWORD_CHARS.lower), pick(PASSWORD_CHARS.digit)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// nodemailer is loaded on first use, so the server still starts if the package is missing.
async function createTransport() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const { default: nodemailer } = await import('nodemailer');
  return nodemailer.createTransport({
    host, port,
    secure: port === 465 || process.env.SMTP_SECURE === 'true', // 465 = TLS from the start, otherwise STARTTLS when offered
    ...(process.env.SMTP_USER && { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' } }),
    connectionTimeout: TIMEOUT_MS, greetingTimeout: TIMEOUT_MS, socketTimeout: TIMEOUT_MS,
  });
}

export async function sendMail({ to, subject, text }) {
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  if (process.env.MAIL_TRANSPORT === 'console') {
    console.info(`[mail:console] to=${to} subject=${subject}\n${text}`);
    return;
  }
  if (!process.env.SMTP_HOST || !from) throw new ApiError(503, 'Chưa cấu hình gửi email (SMTP_HOST, MAIL_FROM)');
  try {
    const transport = await createTransport();
    await transport.sendMail({ from, to, subject, text });
  } catch (error) {
    console.error('[mail] send failed:', error.message);
    throw new ApiError(502, 'Không gửi được email. Vui lòng thử lại sau');
  }
}

const productionAppUrl = 'https://wmsd.tanthuong.workers.dev';

function loginUrl() {
  const base = process.env.APP_URL?.trim().replace(/\/+$/, '');
  if (process.env.NODE_ENV !== 'production') return base ? base + '/login' : '';

  try {
    const url = new URL(base);
    if (url.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      return new URL('/login', url).href;
    }
  } catch {
    // A missing or invalid runtime value falls back to the public frontend.
  }
  return productionAppUrl + '/login';
}

export const passwordMail = ({ fullName, username, password, reason }) => {
  const url = loginUrl();
  return {
    subject: reason === 'created' ? 'Tài khoản Tân Thương đã được tạo' : 'Mật khẩu mới cho tài khoản Tân Thương',
    text: [
      `Xin chào ${fullName},`, '',
      reason === 'created' ? 'Tài khoản của bạn trên hệ thống Tân Thương đã được tạo.' : 'Bạn vừa yêu cầu cấp lại mật khẩu cho tài khoản Tân Thương.',
      `Tên đăng nhập: ${username}`, `Mật khẩu: ${password}`, '',
      url ? 'Đăng nhập tại: ' + url : '',
      'Nếu bạn không thực hiện yêu cầu này, hãy liên hệ quản trị viên ngay.',
    ].filter((line, index, all) => line !== '' || all[index - 1] !== '').join('\n'),
  };
};
