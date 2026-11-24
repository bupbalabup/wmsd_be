import { z } from 'zod';

export const forgotPasswordSchema = z.object({
  body: z.strictObject({ email: z.email('Email không hợp lệ').max(254) }),
});

export const loginSchema = z.object({
  body: z.object({
    username: z.string().min(1, 'Username is required'),
    password: z.string().min(1, 'Password is required'),
  }),
});

// Self-service profile edit: contact fields only; `version` guards against lost updates.
export const updateMeSchema = z.object({
  body: z.strictObject({
    fullName: z.string().trim().min(2, 'Họ và tên tối thiểu 2 ký tự').max(160, 'Họ và tên tối đa 160 ký tự').optional(),
    phone: z.string().trim().max(30, 'Số điện thoại tối đa 30 ký tự')
      .regex(/^$|^[0-9+()\s.-]{6,30}$/, 'Số điện thoại không hợp lệ').optional(),
    version: z.number().int().min(1),
  }),
});

// User-chosen password policy (user decision 23/11/2026): 8–72 chars (bcrypt limit), upper, lower, digit, no spaces.
const newPasswordRule = z.string()
  .min(8, 'Mật khẩu mới tối thiểu 8 ký tự')
  .max(72, 'Mật khẩu mới tối đa 72 ký tự')
  .regex(/[A-Z]/, 'Mật khẩu mới cần ít nhất một chữ hoa')
  .regex(/[a-z]/, 'Mật khẩu mới cần ít nhất một chữ thường')
  .regex(/[0-9]/, 'Mật khẩu mới cần ít nhất một chữ số')
  .refine((v) => !/\s/.test(v), 'Mật khẩu mới không được chứa khoảng trắng');

export const changePasswordSchema = z.object({
  body: z.strictObject({
    currentPassword: z.string().min(1, 'Cần nhập mật khẩu hiện tại').max(200),
    newPassword: newPasswordRule,
  }),
});

// Email change by OTP sent to the new address (user decision 23/11/2026).
export const requestEmailOtpBody = z.strictObject({ newEmail: z.email('Email không hợp lệ').max(254, 'Email tối đa 254 ký tự') });
export const confirmEmailBody = z.strictObject({
  challengeToken: z.string().min(1, 'Thiếu phiên xác thực').max(2000),
  otp: z.string().regex(/^[0-9]{6}$/, 'Mã xác thực gồm 6 chữ số'),
});
export const requestEmailOtpSchema = z.object({ body: requestEmailOtpBody });
export const confirmEmailSchema = z.object({ body: confirmEmailBody });

// Forgot password, OTP option: same email body as the random-password option, then code + chosen password.
export const forgotPasswordOtpSchema = forgotPasswordSchema;
export const resetPasswordWithOtpSchema = z.object({
  body: confirmEmailBody.extend({ newPassword: newPasswordRule }),
});
