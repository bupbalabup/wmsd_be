const defaults = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict",
  path: "/",
};

const setCookie = (res, name, value, options = {}) => {
  res.cookie(name, value, {
    ...defaults,
    secure: defaults.secure || res.req?.app?.locals.secureCookies === true,
    ...options,
  });
};

const clearCookie = (res, name, options = {}) => {
  res.clearCookie(name, {
    ...defaults,
    secure: defaults.secure || res.req?.app?.locals.secureCookies === true,
    ...options,
  });
};

export { setCookie, clearCookie };
