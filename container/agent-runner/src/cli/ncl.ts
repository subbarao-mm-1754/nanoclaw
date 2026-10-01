#!/usr/bin/env bun
/**
 * ncl — NanoClaw CLI client (container edition).
 *
 * Host-side `ncl` / central-DB admin CLI was removed from the gateway+worker
 * product. This stub remains so the container image wrapper does not break;
 * it always exits with an error.
 */
const message =
  'ncl is not available in the gateway+worker product (host admin CLI removed). Use gateway APIs / Studio instead.\n';

process.stderr.write(message);
process.exit(1);
