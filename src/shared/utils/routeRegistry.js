import Router from "router";

// Express 5 (router v2) keeps no string path for mounted routers, so the API catalogue could not rebuild full
// URLs. This module, imported before any route file, remembers the mount path of every `use()` layer.
// It only annotates layers; routing behaviour is unchanged (user decision 23/11/2026: API catalogue).

const MOUNT = Symbol.for("wmsd.mountPath");
const originalUse = Router.prototype.use;

if (!Router.prototype.use[MOUNT]) {
  const patchedUse = function use(...args) {
    const before = this.stack.length;
    const result = originalUse.apply(this, args);
    const path = typeof args[0] === "string" ? args[0] : "/";
    for (const layer of this.stack.slice(before)) layer[MOUNT] = path;
    return result;
  };
  patchedUse[MOUNT] = true;
  Router.prototype.use = patchedUse;
}

const join = (...parts) => ("/" + parts.join("/")).replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
const moduleOf = (url) => url.split("/").filter(Boolean)[1] ?? "api";

/** Lists `{ method, url, module }` for every route reachable from the Express app's router. */
export function discoverRoutes(app) {
  const found = new Map();
  const walk = (stack, prefix) => {
    for (const layer of stack ?? []) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const routePath of paths) {
          if (typeof routePath !== "string") continue;
          const url = join(prefix, routePath);
          for (const method of Object.keys(layer.route.methods).filter((m) => layer.route.methods[m])) {
            const upper = method === "_all" ? "ANY" : method.toUpperCase();
            found.set(`${upper} ${url}`, { method: upper, url, module: moduleOf(url) });
          }
        }
      } else if (Array.isArray(layer.handle?.stack)) {
        walk(layer.handle.stack, join(prefix, layer[MOUNT] ?? "/"));
      }
    }
  };
  walk(app.router?.stack ?? app._router?.stack, "/");
  return [...found.values()].sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
}
