import fs from 'fs';
import path from 'path';

import type { WorkerMemoryPatch } from './types.js';

/** Composed/read-only artifacts — not returned in memory patches. */
const SKIP_FILES = new Set(['CLAUDE.md', 'container.json', '.claude-shared.md']);
const SKIP_DIRS = new Set(['.claude-fragments']);

export interface MemoryBaseline {
  files: Map<string, string>;
}

export function captureMemoryBaseline(
  groupDir: string,
  seedFiles?: Array<{ path: string; content: string }>,
): MemoryBaseline {
  const files = new Map<string, string>();
  if (seedFiles) {
    for (const f of seedFiles) {
      const content = Buffer.isBuffer(f.content) ? f.content.toString('utf8') : f.content;
      files.set(normalizeRelPath(f.path), content);
    }
  } else if (fs.existsSync(groupDir)) {
    for (const [relPath, content] of listAgentFiles(groupDir)) {
      files.set(relPath, content);
    }
  }
  return { files };
}

/** Diff workspace agent dir against baseline; returns undefined when nothing changed. */
export function collectMemoryPatch(groupDir: string, baseline: MemoryBaseline): WorkerMemoryPatch | undefined {
  const currentFiles = listAgentFiles(groupDir);
  const fileChanges: NonNullable<WorkerMemoryPatch['files']> = [];
  let changed = false;

  for (const [relPath, content] of currentFiles) {
    if (baseline.files.get(relPath) !== content) {
      fileChanges.push({ path: relPath, content });
      changed = true;
    }
  }

  for (const relPath of baseline.files.keys()) {
    if (!currentFiles.has(relPath)) {
      fileChanges.push({ path: relPath, content: '', deleted: true });
      changed = true;
    }
  }

  return changed ? { files: fileChanges } : undefined;
}

function listAgentFiles(groupDir: string): Map<string, string> {
  const files = new Map<string, string>();

  function walk(dir: string, prefix: string): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) {
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
        if (entry.isFile() && SKIP_FILES.has(entry.name)) continue;
      }
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full, rel);
      } else if (entry.isFile()) {
        if (SKIP_FILES.has(entry.name)) continue;
        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(full);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) continue;
        files.set(normalizeRelPath(rel), fs.readFileSync(full, 'utf8'));
      }
    }
  }

  walk(groupDir, '');
  return files;
}

function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, '/');
}
