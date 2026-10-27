/**
 * Private document storage. Files are stored outside any public/static directory
 * and are only streamed through authorised API endpoints.
 *
 * LocalStorage is implemented and tested. A Supabase Storage (private bucket)
 * adapter is awaiting configuration — see README "Integrations awaiting configuration".
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface StoredObject {
  key: string;
  sha256: string;
  size: number;
}

export interface Storage {
  put(buf: Buffer, ext: string): Promise<StoredObject>;
  read(key: string): Promise<Buffer>;
}

export class LocalStorage implements Storage {
  constructor(private root: string) {
    fs.mkdirSync(root, { recursive: true });
  }
  private pathFor(key: string) {
    if (!/^[a-f0-9-]{36}\.(pdf|jpg|png|mp4|mov|webm)$/.test(key)) throw new Error('Invalid storage key');
    return path.join(this.root, key);
  }
  async put(buf: Buffer, ext: string): Promise<StoredObject> {
    const key = `${crypto.randomUUID()}.${ext}`;
    await fs.promises.writeFile(this.pathFor(key), buf, { flag: 'wx' });
    return { key, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
  }
  async read(key: string): Promise<Buffer> {
    return fs.promises.readFile(this.pathFor(key));
  }
}

export class MemoryStorage implements Storage {
  private m = new Map<string, Buffer>();
  async put(buf: Buffer, ext: string) {
    const key = `${crypto.randomUUID()}.${ext}`;
    this.m.set(key, buf);
    return { key, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
  }
  async read(key: string) {
    const b = this.m.get(key);
    if (!b) throw new Error('not found');
    return b;
  }
}

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Visit video recordings only (EVC evidence); a system limit, not a regulatory one. */
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

/** Recognises MP4 / MOV (ISO base media `ftyp` box) and WebM (EBML header) from the file content. */
export function sniffVideo(buf: Buffer): { ext: 'mp4' | 'mov' | 'webm'; mime: string } | null {
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    return buf.subarray(8, 12).toString('latin1') === 'qt  ' ? { ext: 'mov', mime: 'video/quicktime' } : { ext: 'mp4', mime: 'video/mp4' };
  }
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { ext: 'webm', mime: 'video/webm' };
  return null;
}

/**
 * Technical inspection only: is the file structurally complete, and does a PDF contain a
 * signature dictionary? This never establishes legal authenticity or certificate validity.
 */
export function inspectFile(buf: Buffer, kind: 'pdf' | 'jpg' | 'png') {
  if (kind === 'pdf') {
    const tail = buf.subarray(Math.max(0, buf.length - 2048)).toString('latin1');
    const body = buf.toString('latin1');
    const readable = tail.includes('%%EOF');
    return {
      kind,
      readable,
      readabilityNote: readable ? undefined : 'The PDF has no end-of-file marker (%%EOF); it may be truncated or corrupt.',
      signatureStructure: /\/ByteRange\s*\[/.test(body) && /\/Type\s*\/Sig\b|\/SubFilter\s*\/(adbe|ETSI)/.test(body),
    };
  }
  if (kind === 'png') {
    const readable = buf.includes(Buffer.from('IEND'));
    return { kind, readable, readabilityNote: readable ? undefined : 'The PNG image is missing its end chunk; it may be truncated.', signatureStructure: false };
  }
  const readable = buf.length > 4 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
  return { kind, readable, readabilityNote: readable ? undefined : 'The JPEG image is missing its end marker; it may be truncated.', signatureStructure: false };
}

/** Checks the real file signature, not just the declared type or extension. */
export function sniffType(buf: Buffer): { ext: 'pdf' | 'jpg' | 'png'; mime: string } | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return { ext: 'pdf', mime: 'application/pdf' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  return null;
}
