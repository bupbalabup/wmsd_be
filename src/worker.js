import { httpServerHandler } from 'cloudflare:node';
import { DurableObject } from 'cloudflare:workers';
import mongoose from 'mongoose';
import { createApp } from './app.js';
import { processNotificationEvent } from './modules/notifications/worker.js';

const port = 3000;
createApp({ logRequests: false, secureCookies: true }).listen(port);
const express = httpServerHandler({ port });

// The API and its existing models share a single MongoDB pool in this object.
export class Backend extends DurableObject {
  connect() {
    if (!this.env.MONGODB_URI || !this.env.JWT_SECRET || !this.env.REFRESH_TOKEN_SECRET) {
      throw new Error('Configure MONGODB_URI, JWT_SECRET and REFRESH_TOKEN_SECRET');
    }
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
    if (path !== '/api/health' && path !== '/api/health/') {
      try {
        await this.connect();
      } catch (error) {
        console.error('Worker database unavailable', error.name);
        return Response.json({ message: 'Backend unavailable' }, { status: 503 });
      }
    }
    return express.fetch(request, this.env, this.ctx);
  }

  async processNotifications() {
    if (!this.env.NOTIFICATIONS_START_AT) return;
    const cutoff = new Date(this.env.NOTIFICATIONS_START_AT);
    if (!Number.isFinite(+cutoff)) throw new Error('Invalid NOTIFICATIONS_START_AT');
    await this.connect();
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
