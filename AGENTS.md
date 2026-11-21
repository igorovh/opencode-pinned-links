# Agent notes

## Checks

- Run `bun run typecheck`, `bun test` and `bun run compile` before you push. CI fails when `dist/` does not match
  `src/`, so commit the rebuilt `dist/` with every source change.

## Demo recordings

- `bun run record -- --out demo.gif --step "type /links" --step "key Enter"` records the real OpenCode TUI with this
  checkout's plugin, through [opencode-tui-recorder](https://github.com/igorovh/opencode-tui-recorder) and
  `recorder.config.ts`. It needs `opencode` (V2), `ttyd` and `ffmpeg` on `PATH` (or `OPENCODE_BIN` and `TTYD_BIN`)
  and Playwright's Chromium. Run it without steps to see the step list. An `--out` ending in `.png` saves a
  screenshot.
- `bun run tui serve` keeps a recording open, and `bun run tui begin`, `bun run tui <step>`, `bun run tui screen`,
  `bun run tui rec-start` and `bun run tui rec-stop --out demo.gif` drive it one step at a time; every step
  prints the screen. tidy's review uses this to try steps before it records.
- `recorder.config.ts` pins four sample links over the RPC before the TUI starts; `pin <url> [title]` pins more
  during the recording, the way the agent would.
- Never left-click a link in a recording: it opens a real browser on the machine. Use `right`, `unpin` and `/links`.
- `expect` and `expect-not` steps fail the recording when the screen does not match, so a recording doubles as a
  test. Put them after every action. A failed check stops the steps but still writes the file, then exits with 1.
  A broken recording, such as an unknown step or a timeout, exits with 2.
- Every PR that changes what the sidebar or `/links` shows must include a screenshot or GIF of the change, before
  and after.

## Pull requests

- PRs are squash-merged and the title becomes the changelog entry, so it must be a Conventional Commit such as
  `feat: pin links from the prompt` or `fix: keep links after a rename`.

## Releases

- tagpr keeps a `chore: release vX.Y.Z` PR open; merging it tags the release and publishes the GitHub release.
- Do not bump the version, create a tag, or merge the release PR until the user has confirmed the change works in
  their OpenCode. Commit fixes locally and wait for that confirmation.
