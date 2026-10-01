# Quick start

1. Launch **AI Usage Widget**. It appears in the menu bar, not the Dock.
2. Click the menu bar icon to open the usage panel.
3. If the Claude card is not connected, choose **Connect from Safari** on macOS (installed app only, needs Full Disk Access). A development run (`npm start`) and Windows/Linux use the embedded claude.ai sign-in window instead.
4. Confirm the menu bar shows text like `42%`, the tightest current limit. A `~` prefix means a stale value and `–` means no data yet.
5. Right-click the icon for Show usage, Refresh now, and Quit. Open Settings from the panel.

Expected limits:

- Claude 5h (all models).
- Claude week (all models).
- Fable week.

If other Claude models, spend, or credits appear, treat that as a regression and do not ship the build.
