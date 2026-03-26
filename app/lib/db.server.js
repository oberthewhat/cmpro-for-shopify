/**
 * db.server.js
 *
 * Prisma client singleton.
 * Standard Remix pattern — prevents multiple client instances during hot reload in dev.
 */

import { PrismaClient } from '@prisma/client';

let db;

if (process.env.NODE_ENV === 'production') {
  db = new PrismaClient();
} else {
  // In dev, attach to globalThis to survive HMR
  if (!globalThis.__db) {
    globalThis.__db = new PrismaClient();
  }
  db = globalThis.__db;
}

export { db };
