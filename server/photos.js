// GroundTruth — encrypted photo store (Sections 4.1 / 15).
//
// Photos are stored AES-256-GCM ENCRYPTED AT REST and referenced only by the
// SHA-256 hash of their *plaintext* bytes (so the main submissions table never
// holds image data, only a hash). EXIF/device metadata is already stripped in
// the browser before upload; this layer adds encryption.
//
// The 32-byte key comes from GT_PHOTO_KEY when provided (hex, base64, or any
// passphrase), otherwise a random key is generated once and persisted in the
// data dir so the prototype can still decrypt across server restarts.

import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEY_PATH = join(__dirname, 'data', 'photo.key');

function loadKey() {
  const env = process.env.GT_PHOTO_KEY;
  if (env) {
    if (/^[0-9a-fA-F]{64}$/.test(env)) return Buffer.from(env, 'hex');
    const b64 = Buffer.from(env, 'base64');
    if (b64.length === 32) return b64;
    return crypto.createHash('sha256').update(env).digest(); // derive from passphrase
  }
  if (existsSync(KEY_PATH)) return readFileSync(KEY_PATH);
  const key = crypto.randomBytes(32);
  try { writeFileSync(KEY_PATH, key, { mode: 0o600 }); } catch (_) { /* read-only fs — key lives in memory only */ }
  return key;
}

const KEY = loadKey();

const insertPhoto = db.prepare(
  `INSERT OR IGNORE INTO photos (hash, mime, iv, tag, data, width, height, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);

// Returns the SHA-256 hash of the plaintext image (the reference stored on the
// submission). Identical bytes hash equally, so the same photo is stored once.
export function storePhoto({ base64, mime = 'image/jpeg', width = null, height = null }) {
  const plain = Buffer.from(stripDataUrl(String(base64)), 'base64');
  if (!plain.length) throw new Error('empty photo');
  const hash = crypto.createHash('sha256').update(plain).digest('hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  insertPhoto.run(hash, mime, iv, tag, enc, width, height, new Date().toISOString());
  return hash;
}

// Decrypts a stored photo (used by the Analyst view in a later step).
export function getPhoto(hash) {
  const row = db.prepare('SELECT * FROM photos WHERE hash = ?').get(hash);
  if (!row) return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(row.iv));
  decipher.setAuthTag(Buffer.from(row.tag));
  const plain = Buffer.concat([decipher.update(Buffer.from(row.data)), decipher.final()]);
  return { data: plain, mime: row.mime, width: row.width, height: row.height };
}

function stripDataUrl(b64) {
  const i = b64.indexOf('base64,');
  return i >= 0 ? b64.slice(i + 7) : b64;
}
