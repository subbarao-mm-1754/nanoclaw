import fs from 'fs';
import path from 'path';

import type { WorkerMemoryPatch } from './types.js';

const SKIP_FILES = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'container.json', '.claude-shared.md']);
const SKIP_DIRS = new Set(['.claude-fragments']);

export interface MemoryBaseline {
  instructions: string;
  files: Map<string, string>;
}

export function captureMemoryBaseline(
  groupDir: string,
  instructions: string,
  seedFiles?: Array<{ path: string; content: string }>,
): MemoryBaseline {
  const files = new Map<string, string>();
  if (seedFiles) {
    for (const f of seedFiles) {
      files.set(normalizeRelPath(f.path), f.content);
    }
  }
  return { instructions, files };
}

/** Diff workspace agent dir against baseline; returns undefined when nothing changed. */
export function collectMemoryPatch(groupDir: string, baseline: MemoryBaseline): WorkerMemoryPatch | undefined {
  const patch: WorkerMemoryPatch = {};
  let changed = false;

  const localPath = path.join(groupDir, 'CLAUDE.local.md');
  const instructions = fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf8') : '';
  if (instructions !== baseline.instructions) {
    patch.instructions = instructions;
    changed = true;
  }

  const currentFiles = listAgentFiles(groupDir);
  const fileChanges: NonNullable<WorkerMemoryPatch['files']> = [];

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

  if (fileChanges.length > 0) {
    patch.files = fileChanges;
  }

  return changed ? patch : undefined;
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
