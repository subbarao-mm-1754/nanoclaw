import type { IncomingMessage } from 'http';

import { WORKER_MAX_BODY_BYTES } from '../config.js';
import type { WorkerAgentFile } from './types.js';
import { WorkerValidationError } from './validate.js';

export interface MultipartPreparePayload {
  metadata: unknown;
  attachments: WorkerAgentFile[];
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
      // RFC 5987: charset'lang'encoded-value
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

function normalizeAttachmentPath(filename: string): string {
  const normalized = filename.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || pathIsAbsolute(normalized)) {
    throw new WorkerValidationError(`Invalid attachment path: ${filename}`);
  }
  return normalized;
}

function pathIsAbsolute(p: string): boolean {
  return /^[a-zA-Z]:/.test(p) || p.startsWith('/');
}

/** @internal Exported for unit tests. */
export function parseMultipartBody(body: Buffer, boundary: string): MultipartPreparePayload {
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
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break; // --
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
  }

  let metadata: unknown;
  const attachments: WorkerAgentFile[] = [];

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
        metadata = JSON.parse(content.toString('utf8'));
      } catch {
        throw new WorkerValidationError('metadata part must be valid JSON');
      }
      continue;
    }

    if (name === 'file' || name === 'files') {
      if (!filename) {
        throw new WorkerValidationError('file attachment requires a filename (used as workspace-relative path)');
      }
      attachments.push({
        path: normalizeAttachmentPath(filename),
        content,
      });
    }
  }

  if (metadata === undefined) {
    throw new WorkerValidationError('multipart prepare request requires a metadata part (JSON)');
  }

  return { metadata, attachments };
}

export function isMultipartRequest(req: IncomingMessage): boolean {
  const ct = req.headers['content-type'] ?? '';
  return ct.toLowerCase().startsWith('multipart/form-data');
}

/** Parse multipart/form-data prepare body: metadata JSON + file attachments. */
export async function parseMultipartPrepareRequest(req: IncomingMessage): Promise<MultipartPreparePayload> {
  const contentType = req.headers['content-type'] ?? '';
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  if (!boundary) {
    throw new WorkerValidationError('multipart/form-data requires a boundary parameter');
  }

  const body = await readBody(req, WORKER_MAX_BODY_BYTES);
  return parseMultipartBody(body, boundary);
}
