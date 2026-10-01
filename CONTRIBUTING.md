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

- The Claude account shows exactly three limits: 5-hour, weekly, and Fable.
- Other Claude scoped limits, spend, and credits never reach display or history.
- Raw provider responses and credentials never reach the renderer or history.
- Claude Code's own credentials are never read.
- Disconnect and any failed sign-in wipe the whole isolated sign-in partition plus the encrypted key.
- A refresh never runs during a sign-in and never overwrites or deletes a new login.
- The renderer stays sandboxed with networking disabled.

## Provider fixtures

Tests should include fields the product excludes, not just happy-path approved fields. This prevents an upstream payload expansion from silently leaking a new bucket into the widget.

Use synthetic tokens, organization IDs, paths, and account details in every fixture and diagnostic capture.

## Attribution

Preserve the MIT license and upstream Claude Usage Widget attribution. New changes should not erase upstream authorship from files substantially derived from that project.
