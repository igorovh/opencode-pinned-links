# Agent notes

## Checks

- Run `bun run typecheck`, `bun test` and `bun run compile` before you push. CI fails when `dist/` does not match
  `src/`, so commit the rebuilt `dist/` with every source change.

## Demo recordings

- `bun run record -- --out demo.gif --step "type /links" --step "key Enter"` records the real OpenCode TUI with this
  checkout's plugin. It needs `opencode` (V2), `ttyd` and `ffmpeg` on `PATH` (or `OPENCODE_BIN` and `TTYD_BIN`) and
  Playwright's Chromium. Run it without steps to see the step list. An `--out` ending in `.png` saves a screenshot.
- The script pins four sample links over the RPC before the TUI starts; `pin <url> [title]` pins more during the
  recording, the way the agent would.
- Never left-click a link in a recording: it opens a real browser on the machine. Use `right`, `unpin` and `/links`.
- `expect` and `expect-not` steps fail the recording when the screen does not match, so a recording doubles as a
  test. Put them after every action.
- Every PR that changes what the sidebar or `/links` shows must include a screenshot or GIF of the change, before
  and after.

## Pull requests

- PRs are squash-merged and the title becomes the changelog entry, so it must be a Conventional Commit such as
  `feat: pin links from the prompt` or `fix: keep links after a rename`.

## Releases

- tagpr keeps a `chore: release vX.Y.Z` PR open; merging it tags the release and publishes the GitHub release.
- Do not bump the version, create a tag, or merge the release PR until the user has confirmed the change works in
  their OpenCode. Commit fixes locally and wait for that confirmation.
