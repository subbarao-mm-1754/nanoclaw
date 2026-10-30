# Releasing ZClaw

ZClaw versions live in `package.json`. A release is a tagged commit on `main` plus a short note in `CHANGELOG.md`.

## Cut a release

1. Bump the version in `package.json`.
2. Add a `CHANGELOG.md` entry for that version.
3. Commit both in one change.
4. Tag the commit `vX.Y.Z` and publish it.

The current version is the one in `package.json`. Each published tag is a stable release.
