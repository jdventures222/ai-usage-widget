# Installation

## Target MacBook Air

The local Apple Silicon build is produced with:

```bash
npm ci
npm test
npm run lint
npm run audit:runtime
npm run build:mac:unpacked
```

Install the verified bundle at:

```text
/Applications/AI Usage Widget.app
```

Launch it from Finder once so macOS registers the application identity and login item. The app starts in compact mode and restores the last saved position and size.

## Account prerequisites

- Codex CLI installed and authenticated with the intended ChatGPT/Codex account.
- Claude account authenticated either through legacy migration or the app's dedicated Claude sign-in window.

No OpenAI API key or Anthropic API key is used.

## Migration

First launch reads, but never modifies:

```text
~/Library/Application Support/claude-usage-widget/config.json
```

The replacement writes to:

```text
~/Library/Application Support/ai-usage-widget/config.json
```

Keep the legacy config as rollback data. Move the old app bundle to Trash only after the packaged replacement reports both providers live and survives relaunch.

## Signing limitation

A local or development-signed app can be installed on this Mac. Public distribution requires a Developer ID Application certificate and Apple notarization. Never bypass Gatekeeper or clear quarantine as a substitute for a valid release pipeline.

## Uninstall

Quit AI Usage Widget, move `/Applications/AI Usage Widget.app` to Trash, and optionally archive or remove its application-support directory. Removing the app bundle does not delete account data or revoke either provider account.
