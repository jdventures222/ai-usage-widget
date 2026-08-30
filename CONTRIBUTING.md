# Contributing

## Required checks

```bash
npm ci
npm test
npm run lint
npm run audit:runtime
git diff --check
```

Run a packaged smoke check for changes to Electron, provider transport, storage, CSP, preload IPC, migration, or window behavior.

## Product invariants

- The compact HUD has one Codex summary and exactly three Claude rows: 5-hour, weekly, and Fable.
- GPT Reserve, Codex Spark, other Claude scoped limits, spend, and credits never reach display or history.
- Raw provider responses and credentials never reach the renderer or history.
- Codex authentication files are never read.
- Provider failures remain isolated.
- Manual compact and expanded geometry survives relaunch and refresh never changes it.
- The renderer stays sandboxed with networking disabled.

## Provider fixtures

Tests should include fields the product excludes, not just happy-path approved fields. This prevents an upstream payload expansion from silently leaking a new bucket into the widget.

Use synthetic tokens, organization IDs, paths, and account details in every fixture and diagnostic capture.

## Attribution

Preserve the MIT license and upstream Claude Usage Widget attribution. New changes should not erase upstream authorship from files substantially derived from that project.
