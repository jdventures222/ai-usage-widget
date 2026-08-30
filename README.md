# AI Usage Widget

A private, low-profile macOS HUD for the subscription usage that matters on this MacBook Air.

The compact view intentionally contains only:

- One canonical Codex usage summary.
- Claude's 5-hour limit.
- Claude's weekly limit.
- Claude's Fable weekly limit.

GPT Reserve, Codex Spark, other Claude scoped/model limits, spend controls, prepaid balances, and credits are discarded before display and history storage.

## Experience

- Starts as a translucent four-row HUD without taking keyboard focus.
- Remains above normal windows and can appear on every macOS Space.
- Drag the header to move it; drag a native edge or corner to resize it.
- Remembers compact and expanded position/size independently.
- Expand for provider recovery, local history, settings, and diagnostics.
- Supports opacity, snap-corner, theme, refresh, alerts, menu-bar-only, and launch-at-login controls.

The menu-bar icon is always available as a recovery surface if the HUD is hidden.

## Data sources

### Codex

The app discovers the locally installed, already authenticated `codex` executable and performs a bounded one-shot JSON-RPC exchange with `codex app-server --stdio`. It never reads `~/.codex/auth.json`, copies a token, or launches through a shell.

Only the canonical `codex` limit group is accepted. A legacy single-limit response is accepted only when the multi-limit map is absent.

### Claude

The app uses a dedicated sandboxed Electron browser session for the existing Claude web-account integration. Its HTTP-only session cookie stays in the main process and is encrypted using Electron `safeStorage`.

The Claude and Codex subscription interfaces used here are private or experimental. They can change without notice. This project is not affiliated with Anthropic or OpenAI.

## First launch and migration

The new app uses its own identity and data directory:

```text
~/Library/Application Support/ai-usage-widget/
```

On first launch it reads the old Claude Usage Widget config as an immutable migration source. Supported history and settings are normalized, and a constrained one-time helper re-encrypts the existing Claude credential from the old Keychain identity to the new one without writing plaintext.

The old config is not modified. The old application should be moved to Trash only after the replacement passes live Claude, Codex, relaunch, and packaged checks.

## Development

Requirements: Node.js 18+ and npm 9+.

```bash
git clone https://github.com/jdventures222/ai-usage-widget.git
cd ai-usage-widget
npm ci
npm test
npm run lint
npm run audit:runtime
npm start
```

If the shell has `ELECTRON_RUN_AS_NODE` set, remove it for a development launch:

```bash
env -u ELECTRON_RUN_AS_NODE npm start
```

Build an Apple Silicon macOS bundle:

```bash
npm run build:mac:unpacked
```

## Distribution status

Local development and packaged validation are supported. A broadly distributable macOS release requires a Developer ID Application certificate and Apple notarization credentials. Do not describe an unsigned or development-signed build as notarized.

## Security and privacy

- No telemetry or hosted service.
- No renderer networking.
- No plaintext credential fallback.
- No credential-bearing IPC or diagnostics.
- Configuration permissions are hardened to owner read/write (`0600`) where supported.
- Codex child execution uses constant arguments, `shell: false`, bounded output, a deadline, and forced cleanup.
- Raw provider responses are never persisted.

See [Product requirements](docs/PRD.md), [architecture](docs/ARCHITECTURE.md), and [threat model](docs/THREAT-MODEL.md).

## Attribution

AI Usage Widget is derived from [Claude Usage Widget](https://github.com/SlavomirDurej/claude-usage-widget) by Slavomir Durej under the MIT License. Upstream copyright and attribution are preserved in the license, package metadata, Git history, and [attribution notes](docs/ATTRIBUTION.md).

Recent upstream contributors whose work is represented in the v1.7.6 baseline include:

- [@cwil2072](https://github.com/cwil2072) - macOS minimize/restore fix, usage history graph
- [@dion-jy](https://github.com/dion-jy) - Login flow architecture improvements
- [@goooseman](https://github.com/goooseman) - Login window security improvements
- [@sergkuzn](https://github.com/sergkuzn) - Linux desktop launcher & autostart documentation
- [@Dolphin2ii](https://github.com/Dolphin2ii) - Electron/electron-builder security update
- [@torsten-liermann](https://github.com/torsten-liermann) - Per-model weekly limit support (Fable)
- [@gastyg](https://github.com/gastyg) - Fable row for compact mode
- [@irishpolyglot](https://github.com/irishpolyglot) - Fable timer-pairing bug fix

## License

MIT. See [LICENSE](LICENSE).
