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
