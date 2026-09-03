import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Prefer the web/ folder next to this module (tsx → src/gateway/web).
 * Fall back to src/gateway/web from cwd when running a compiled dist/
 * build that doesn't copy static assets.
 */
function resolveWebRoot(): string {
  const beside = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
  if (fs.existsSync(path.join(beside, 'index.html'))) return beside;
  const fromSrc = path.resolve(process.cwd(), 'src', 'gateway', 'web');
  if (fs.existsSync(path.join(fromSrc, 'index.html'))) return fromSrc;
  return beside;
}

const WEB_ROOT = resolveWebRoot();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

export function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string): boolean {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  if (rel.startsWith('/assets/')) rel = rel.slice('/assets'.length);
  if (!rel.startsWith('/') || rel.includes('..')) {
    jsonResponse(res, 400, { error: 'Invalid path' });
    return true;
  }

  const filePath = path.join(WEB_ROOT, rel);
  if (!filePath.startsWith(WEB_ROOT)) {
    jsonResponse(res, 403, { error: 'Forbidden' });
    return true;
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return false;
  }

  const ext = path.extname(filePath);
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': ext === '.html' || ext === '.js' ? 'no-cache' : 'public, max-age=3600',
  });
  res.end(body);
  return true;
}

export function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<unknown> {
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

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

export function requireString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function normalizeAgentFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

function assertValidAgentFilePath(filePath: string, index: number): string {
  const normalized = normalizeAgentFilePath(filePath);
  if (!normalized || normalized.includes('..') || /^([a-zA-Z]:[/\\]|\/)/.test(normalized)) {
    throw new Error(`files[${index}].path must be a relative path without .. segments`);
  }
  return normalized;
}

export function parseAgentFiles(raw: unknown): Array<{ path: string; content: string }> {
  if (!Array.isArray(raw)) throw new Error('files must be an array');
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`files[${i}] must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    return {
      path: assertValidAgentFilePath(requireString(obj, 'path'), i),
      content: typeof obj.content === 'string' ? obj.content : '',
    };
  });
}

export function bearerToken(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token || null;
}
