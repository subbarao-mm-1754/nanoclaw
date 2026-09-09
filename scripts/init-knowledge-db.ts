/**
 * One-shot: init knowledge schema and smoke-test save/search.
 * Usage: KNOWLEDGE_DATABASE_URL=... pnpm exec tsx scripts/init-knowledge-db.ts
 */
import {
  executeKnowledgeRequest,
  initKnowledgeSchema,
  closeKnowledgePool,
  isKnowledgeEnabled,
} from '../src/knowledge/store.js';

async function main(): Promise<void> {
  if (!isKnowledgeEnabled()) {
    console.error('Set KNOWLEDGE_DATABASE_URL (or DATABASE_URL) first.');
    process.exit(1);
  }
  await initKnowledgeSchema();
  const ws = 'ws-smoke-test';
  const save = await executeKnowledgeRequest({
    op: 'save',
    workspace_id: ws,
    path: 'notes/smoke.md',
    title: 'Smoke test',
    content: '# Hello\n\nAgent knowledge smoke test about quarterly reports.',
  });
  console.log('save', save);
  const search = await executeKnowledgeRequest({
    op: 'search',
    workspace_id: ws,
    query: 'quarterly',
  });
  console.log('search', search);
  await closeKnowledgePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
