import { httpServerHandler } from 'cloudflare:node';
import { DurableObject } from 'cloudflare:workers';

// Keep module top-level work minimal: Workers reject a deploy when startup exceeds the CPU limit (error 10021).
// Mongoose, the Express app and every route/model are loaded lazily on the first request instead.
const port = 3000;
let expressHandler;
function getExpress() {
  expressHandler ??= import('./app.js').then(({ createApp }) => {
    createApp({ logRequests: false, secureCookies: true }).listen(port);
    return httpServerHandler({ port });
  });
  return expressHandler;
}

// The API and its existing models share a single MongoDB pool in this object.
export class Backend extends DurableObject {
  async connect() {
    if (!this.env.MONGODB_URI || !this.env.JWT_SECRET || !this.env.REFRESH_TOKEN_SECRET) {
      const error = new Error('Configure MONGODB_URI, JWT_SECRET and REFRESH_TOKEN_SECRET');
      error.name = 'MissingWorkerSecrets';
      throw error;
    }
    const { default: mongoose } = await import('mongoose');
    this.connection ??= mongoose.connect(this.env.MONGODB_URI, {
      maxPoolSize: 5,
      minPoolSize: 0,
      maxIdleTimeMS: 20000,
      serverSelectionTimeoutMS: 5000,
    }).catch(error => {
      this.connection = undefined;
      throw error;
    });
    return this.connection;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    // Preflight and health checks never need MongoDB.
    const needsDb = request.method !== 'OPTIONS' && path !== '/api/health' && path !== '/api/health/';
    if (needsDb) {
      try {
        await this.connect();
      } catch (error) {
        console.error('Worker database unavailable', error.name);
        const headers = new Headers();
        const origin = request.headers.get('origin');
        if (origin) {
          headers.set('Access-Control-Allow-Origin', origin);
          headers.set('Access-Control-Allow-Credentials', 'true');
          headers.set('Vary', 'Origin');
        }
        return Response.json({ message: 'Backend unavailable' }, { status: 503, headers });
      }
    }
    return (await getExpress()).fetch(request, this.env, this.ctx);
  }

  async processNotifications() {
    if (!this.env.NOTIFICATIONS_START_AT) return;
    const cutoff = new Date(this.env.NOTIFICATIONS_START_AT);
    if (!Number.isFinite(+cutoff)) throw new Error('Invalid NOTIFICATIONS_START_AT');
    await this.connect();
    const { processNotificationEvent } = await import('./modules/notifications/worker.js');
    for (let i = 0; i < 25; i++) {
      if (!await processNotificationEvent(cutoff)) break;
    }
  }
}

export default {
  fetch(request, env) {
    return env.BACKEND.getByName('api').fetch(request);
  },
  async scheduled(_event, env) {
    if (env.NOTIFICATIONS_START_AT) {
      await env.BACKEND.getByName('api').processNotifications();
    }
  },
};
