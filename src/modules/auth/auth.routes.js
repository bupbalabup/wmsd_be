import { Router } from "express";
import { login, logout, getMe, updateMe, changePassword, requestEmailOtp, confirmEmail, refreshToken, forgotPassword, forgotPasswordOtp, resetPasswordWithOtp } from "./auth.controller.js";
import { validate } from "../../middlewares/validate.js";
import { authenticate } from "../../middlewares/auth.js";
import { loginSchema, forgotPasswordSchema, updateMeSchema, changePasswordSchema, requestEmailOtpSchema, confirmEmailSchema, forgotPasswordOtpSchema, resetPasswordWithOtpSchema } from "./auth.validation.js";

const router = Router();

router.post("/login", validate(loginSchema), login);
// Public: emails a new random password to the account that owns the address.
router.post("/forgot-password", validate(forgotPasswordSchema), forgotPassword);
// Public, OTP option: emails a code to the account, then the user sets a password of their choice.
router.post("/forgot-password/otp", validate(forgotPasswordOtpSchema), forgotPasswordOtp);
router.post("/forgot-password/reset", validate(resetPasswordWithOtpSchema), resetPasswordWithOtp);
// Cookie cleanup must also work when the access token is expired or missing.
router.post("/logout", logout);
router.get("/me", authenticate, getMe);
// Account owner only: the target is always req.user, never an id from the request.
router.patch("/me", authenticate, validate(updateMeSchema), updateMe);
router.post("/me/password", authenticate, validate(changePasswordSchema), changePassword);
router.post("/me/email/otp", authenticate, validate(requestEmailOtpSchema), requestEmailOtp);
router.post("/me/email", authenticate, validate(confirmEmailSchema), confirmEmail);
router.post("/refresh", refreshToken);

export default router;
