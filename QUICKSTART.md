# Quick start

1. Launch **AI Usage Widget**.
2. Confirm the compact HUD shows Codex plus Claude 5-hour, weekly, and Fable rows.
3. If Claude asks for authentication, expand the widget and choose **Connect Claude**.
4. If Codex reports a missing CLI, expand Settings and choose the authenticated `codex` executable.
5. Drag the header to move the HUD. Resize it from a native edge or corner.
6. Use the expand control for history and settings; collapse it to return to the four-row view.

The HUD remembers compact and expanded geometry separately. Changing **Snap to** in Settings intentionally moves the current mode to that corner; ordinary refreshes do not move it.

Expected rows:

- Codex: canonical general usage only.
- Claude 5h.
- Claude week.
- Fable.

If Spark, GPT Reserve, other Claude models, spend, or credits appear, treat that as a regression and do not ship the build.
