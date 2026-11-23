import { catchAsync } from "../../shared/utils/catchAsync.js";
import { formatApiResponse } from "../../shared/utils/ApiResponse.js";
import * as authService from "./auth.service.js";
import { verifyRefreshToken } from "../../config/jwt.js";
import { setCookie, clearCookie } from "../../config/cookie.js";
import { ApiError } from "../../shared/utils/ApiError.js";

export const login = catchAsync(async (req, res) => {
  const result = await authService.loginUser(
    req.body.username,
    req.body.password,
  );
  setCookie(res, "refresh_token", result.refreshToken, {
    maxAge: 7 * 24 * 60 * 60 * 1000,
  }); // Set refresh token in cookie for 7 days
  formatApiResponse(res, {
    message: "Login successful",
    data: { accessToken: result.accessToken, user: result.user },
  });
});

export const forgotPassword = catchAsync(async (req, res) => {
  await authService.forgotPassword(req.body.email);
  // Same answer whether or not the address exists, so the form cannot be used to discover accounts.
  formatApiResponse(res, { message: "Nếu email thuộc một tài khoản đang hoạt động, mật khẩu mới đã được gửi tới email đó" });
});

export const forgotPasswordOtp = catchAsync(async (req, res) => {
  const result = await authService.requestPasswordResetOtp(req.body.email);
  // Same answer whether or not the address exists.
  formatApiResponse(res, { message: "Nếu email thuộc một tài khoản đang hoạt động, mã xác thực đã được gửi tới email đó", data: result });
});

export const resetPasswordWithOtp = catchAsync(async (req, res) => {
  await authService.resetPasswordWithOtp(req.body);
  formatApiResponse(res, { message: "Đã đặt lại mật khẩu. Hãy đăng nhập bằng mật khẩu mới." });
});

export const getMe = catchAsync(async (req, res) => {
  const result = await authService.getCurrentUser(req.user._id);
  formatApiResponse(res, { data: result });
});

export const updateMe = catchAsync(async (req, res) => {
  const result = await authService.updateCurrentUser(req.user._id, req.body);
  formatApiResponse(res, { message: "Đã cập nhật thông tin tài khoản", data: result });
});

export const changePassword = catchAsync(async (req, res) => {
  await authService.changeOwnPassword(req.user._id, req.body);
  formatApiResponse(res, { message: "Đã đổi mật khẩu" });
});

export const requestEmailOtp = catchAsync(async (req, res) => {
  const result = await authService.requestOwnEmailOtp(req.user._id, req.body);
  formatApiResponse(res, { message: `Đã gửi mã xác thực tới ${result.maskedEmail}`, data: result });
});

export const confirmEmail = catchAsync(async (req, res) => {
  const result = await authService.confirmOwnEmail(req.user._id, req.body);
  formatApiResponse(res, { message: "Đã đổi email", data: result });
});

export const logout = (_req, res) => {
  clearCookie(res, "refresh_token");
  clearCookie(res, "claim_access_token");
  formatApiResponse(res, { message: "Logout successful" });
};

export const refreshToken = catchAsync(async (req, res) => {
  const decoded = verifyRefreshToken(req.cookies.refresh_token);
  if (decoded.success === false) {
    throw new ApiError(401, "Token không hợp lệ hoặc đã hết hạn");
  }
  const result = await authService.refreshToken(decoded.userId);
  formatApiResponse(res, {
    message: "Token refreshed successfully",
    data: result,
  });
});
