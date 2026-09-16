import { randomBytes } from 'crypto';
import type { IncomingMessage } from 'http';

import { WORKER_OUTBOUND_FILE_MAX_BYTES, WORKER_OUTBOUND_UPLOAD_MAX_BYTES } from '../config.js';
import type { WorkerOutboundCallbackPayload } from './types.js';

const OUTBOUND_FILE_KEY = '::';

/** Composite multipart filename: `{messageId}::{attachmentName}`. */
export function outboundMultipartFilename(messageId: string, filename: string): string {
  return `${messageId}${OUTBOUND_FILE_KEY}${filename}`;
}

export function parseOutboundMultipartFilename(composite: string): {
  messageId: string;
  filename: string;
} | null {
  const idx = composite.indexOf(OUTBOUND_FILE_KEY);
  if (idx <= 0 || idx >= composite.length - OUTBOUND_FILE_KEY.length) return null;
  const messageId = composite.slice(0, idx);
  const filename = composite.slice(idx + OUTBOUND_FILE_KEY.length);
  if (!messageId || !filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return null;
  }
  return { messageId, filename };
}

export interface OutboundMultipartFilePart {
  messageId: string;
  filename: string;
  data: Buffer;
}

export interface OutboundMultipartPayload {
  metadata: WorkerOutboundCallbackPayload;
  files: OutboundMultipartFilePart[];
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseContentDisposition(header: string): { name?: string; filename?: string } {
  const result: { name?: string; filename?: string } = {};
  for (const segment of header.split(';')) {
    const trimmed = segment.trim();
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim().toLowerCase();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (key === 'name') result.name = value;
    if (key === 'filename') result.filename = value;
    if (key === 'filename*') {
      const star = value.match(/^[^']*'[^']*'(.*)$/);
      if (star) {
        try {
          result.filename = decodeURIComponent(star[1]);
        } catch {
          result.filename = star[1];
        }
      }
    }
  }
  return result;
}

export function buildOutboundMultipartBody(
  metadata: WorkerOutboundCallbackPayload,
  fileParts: OutboundMultipartFilePart[],
): { body: Buffer; contentType: string } {
  const boundary = `----nanoclaw-out-${randomBytes(12).toString('hex')}`;
  const chunks: Buffer[] = [];

  const appendPart = (headers: string, content: Buffer) => {
    chunks.push(Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n`));
    chunks.push(content);
    chunks.push(Buffer.from('\r\n'));
  };

  appendPart(
    'Content-Disposition: form-data; name="metadata"\r\nContent-Type: application/json',
    Buffer.from(JSON.stringify(metadata), 'utf8'),
  );

  for (const part of fileParts) {
    const composite = outboundMultipartFilename(part.messageId, part.filename);
    appendPart(
      `Content-Disposition: form-data; name="file"; filename="${composite.replace(/"/g, '_')}"\r\nContent-Type: application/octet-stream`,
      part.data,
    );
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** @internal Exported for unit tests. */
export function parseOutboundMultipartBody(
  body: Buffer,
  boundary: string,
  opts: { maxFileBytes?: number; maxTotalBytes?: number } = {},
): OutboundMultipartPayload {
  const maxFileBytes = opts.maxFileBytes ?? WORKER_OUTBOUND_FILE_MAX_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? WORKER_OUTBOUND_UPLOAD_MAX_BYTES;
  if (body.length > maxTotalBytes) {
    throw new Error('Outbound multipart body too large');
  }

  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let start = 0;

  while (true) {
    const idx = body.indexOf(delimiter, start);
    if (idx < 0) break;
    if (start > 0) {
      let part = body.subarray(start, idx);
      if (part[0] === 0x0d && part[1] === 0x0a) part = part.subarray(2);
      if (part.length > 0) parts.push(part);
    }
    start = idx + delimiter.length;
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
  }

  let metadata: WorkerOutboundCallbackPayload | undefined;
  const files: OutboundMultipartFilePart[] = [];

  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;

    const headerText = part.subarray(0, headerEnd).toString('utf8');
    let content = part.subarray(headerEnd + 4);
    if (content.length >= 2 && content[content.length - 2] === 0x0d && content[content.length - 1] === 0x0a) {
      content = content.subarray(0, content.length - 2);
    }

    const headers = new Map<string, string>();
    for (const line of headerText.split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }

    const disposition = headers.get('content-disposition');
    if (!disposition) continue;

    const { name, filename } = parseContentDisposition(disposition);

    if (name === 'metadata') {
      try {
        metadata = JSON.parse(content.toString('utf8')) as WorkerOutboundCallbackPayload;
      } catch {
        throw new Error('metadata part must be valid JSON');
      }
      continue;
    }

    if (name === 'file' && filename) {
      if (content.length > maxFileBytes) {
        throw new Error(`Outbound file exceeds max size (${maxFileBytes} bytes): ${filename}`);
      }
      const parsed = parseOutboundMultipartFilename(filename);
      if (!parsed) {
        throw new Error(`Invalid outbound file part filename: ${filename}`);
      }
      files.push({
        messageId: parsed.messageId,
        filename: parsed.filename,
        data: content,
      });
    }
  }

  if (!metadata || typeof metadata.session_id !== 'string') {
    throw new Error('Outbound multipart requires metadata with session_id');
  }

  return { metadata, files };
}

export function isMultipartRequest(req: IncomingMessage): boolean {
  const ct = req.headers['content-type'] ?? '';
  return ct.toLowerCase().startsWith('multipart/form-data');
}

export async function parseOutboundMultipartRequest(
  req: IncomingMessage,
): Promise<OutboundMultipartPayload> {
  const contentType = req.headers['content-type'] ?? '';
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) {
    throw new Error('multipart/form-data requires a boundary parameter');
  }

  const body = await readBody(req, WORKER_OUTBOUND_UPLOAD_MAX_BYTES);
  return parseOutboundMultipartBody(body, boundary);
}

/** Attach parsed multipart file buffers onto outbound rows for delivery. */
export function attachOutboundMultipartFiles(
  payload: WorkerOutboundCallbackPayload,
  fileParts: OutboundMultipartFilePart[],
): WorkerOutboundCallbackPayload {
  if (fileParts.length === 0) return payload;

  const byMessage = new Map<string, OutboundMultipartFilePart[]>();
  for (const part of fileParts) {
    const list = byMessage.get(part.messageId) ?? [];
    list.push(part);
    byMessage.set(part.messageId, list);
  }

  const outbound = (payload.outbound ?? []).map((row) => {
    const parts = byMessage.get(row.id);
    if (!parts?.length) return row;
    return {
      ...row,
      files: parts.map((p) => ({ filename: p.filename })),
      file_buffers: parts.map((p) => ({ filename: p.filename, data: p.data })),
    };
  });

  return { ...payload, outbound };
}
