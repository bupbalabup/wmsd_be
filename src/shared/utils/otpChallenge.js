import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { validationError } from './ApiError.js';

// One-time code primitives shared by email change and forgot-password-by-OTP (user decisions 23/11/2026).
// Stateless: the code is never stored; only its HMAC travels inside a signed, short-lived challenge token.
// Each purpose signs with its own key derived from JWT_SECRET, so a challenge never verifies as an access
// token, nor as a challenge of another purpose.

export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_SECONDS = 60;
const BASE_SECRET = process.env.JWT_SECRET || 'wmsd_default_super_secret_jwt_key_2026';
const secretFor = (purpose) => crypto.createHmac('sha256', BASE_SECRET).update(`wmsd:otp:${purpose}:v1`).digest('hex');

// In-process limits (like the forgot-password cooldown): lost on restart and not shared between instances.
const lastIssued = new Map();
const attempts = new Map();
const used = new Map();
const prune = (map, now) => { for (const [key, value] of map) if ((value?.expiresAt ?? value) < now) map.delete(key); };

export const invalidOtp = (message) => validationError(message, [{ path: 'body.otp', message }]);

/** Short keyed fingerprint, e.g. of a password hash, to bind a challenge to the current state. */
export const fingerprint = (purpose, value) => crypto.createHmac('sha256', secretFor(purpose)).update(String(value ?? '')).digest('hex').slice(0, 32);

/** Seconds left before `key` may receive another code (0 = allowed). Does not record anything. */
export function resendWait(key, now = Date.now()) {
  prune(lastIssued, now - OTP_RESEND_SECONDS * 1000);
  return Math.max(0, Math.ceil(((lastIssued.get(key) ?? 0) + OTP_RESEND_SECONDS * 1000 - now) / 1000));
}

export const recordIssued = (key, now = Date.now()) => lastIssued.set(key, now);

/** Creates a 6-digit code and a challenge token carrying `claims` plus the code's HMAC. */
export function createChallenge(purpose, claims) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const jti = crypto.randomUUID();
  const mac = crypto.createHmac('sha256', secretFor(purpose)).update(`${jti}:${code}`).digest('hex');
  const challengeToken = jwt.sign({ ...claims, purpose, mac }, secretFor(purpose), { expiresIn: OTP_TTL_MINUTES * 60, jwtid: jti });
  return { code, challengeToken, expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000) };
}

/** Verifies token, single use and attempt limit, then the code. Returns the claims; call markUsed after applying. */
export function verifyChallenge(purpose, challengeToken, otp) {
  let claims;
  try {
    claims = jwt.verify(challengeToken, secretFor(purpose));
  } catch (error) {
    throw invalidOtp(error.name === 'TokenExpiredError' ? 'Mã xác thực đã hết hạn. Vui lòng gửi lại mã.' : 'Phiên xác thực không hợp lệ. Vui lòng gửi lại mã.');
  }
  if (claims.purpose !== purpose) throw invalidOtp('Phiên xác thực không hợp lệ. Vui lòng gửi lại mã.');
  const now = Date.now();
  prune(attempts, now);
  prune(used, now);
  if (used.has(claims.jti)) throw invalidOtp('Mã xác thực đã được sử dụng. Vui lòng gửi lại mã.');
  const state = attempts.get(claims.jti) ?? { count: 0, expiresAt: claims.exp * 1000 };
  if (state.count >= OTP_MAX_ATTEMPTS) throw invalidOtp('Đã nhập sai quá số lần cho phép. Vui lòng gửi lại mã.');
  const expected = Buffer.from(claims.mac, 'hex');
  const actual = crypto.createHmac('sha256', secretFor(purpose)).update(`${claims.jti}:${otp}`).digest();
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    state.count += 1;
    attempts.set(claims.jti, state);
    const left = OTP_MAX_ATTEMPTS - state.count;
    throw invalidOtp(left > 0 ? `Mã xác thực không đúng. Còn ${left} lần thử.` : 'Đã nhập sai quá số lần cho phép. Vui lòng gửi lại mã.');
  }
  return claims;
}

export function markUsed(claims) {
  used.set(claims.jti, claims.exp * 1000);
  attempts.delete(claims.jti);
}

/** Test helper: clears the in-process rate-limit, attempt and replay state. */
export function resetOtpState() { lastIssued.clear(); attempts.clear(); used.clear(); }
