// How `bun run record` and `bun run tui` set up the real OpenCode TUI with this plugin (opencode-tui-recorder).
import { defineRecorder, type Context } from "opencode-tui-recorder"

const LINKS = [
  { url: "https://example.com/preview/settings", title: "Preview: settings page" },
  { url: "https://linear.app/acme/issue/ENG-214/dark-mode-for-settings", title: "Dark mode for settings" },
  { url: "https://bitbucket.org/acme/api/pull-requests/57", title: "Theme tokens endpoint" },
  { url: "https://github.com/acme/web/pull/482", title: "Add dark mode to settings" },
]

// The server loads the plugin on the first request for a directory, so its RPC is unavailable until then.
async function rpc(ctx: Context, directory: string, method: string, input: Record<string, unknown>) {
  for (let attempt = 0; ; attempt++) {
    const response = await ctx.api(`/api/rpc/pinned-links/${method}`, { query: { "location[directory]": directory }, body: { input } })
    if (response.ok) return
    const text = await response.text()
    if (!text.includes("rpc.unavailable") || attempt >= 40) throw new Error(`pinned-links/${method} failed: ${response.status} ${text}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

// Pins the way the agent does, so no model runs.
function pin(ctx: Context, url: string, title?: string) {
  const session = ctx.sessions[0]!
  return rpc(ctx, session.directory, "add", { sessionID: session.id, url, title })
}

export default defineRecorder({
  config: ({ plugin }) => ({
    "opencode.json": { plugins: [plugin] },
    "cli.json": { tabs: { mode: "off" } },
  }),
  sessions: [{ project: "web", title: "Dark mode for settings" }],
  attach: true,
  viewport: { width: 1280, height: 600 },
  ready: { label: "the Links section", test: (lines) => lines.some((line) => line.includes("Links")) },
  match: "rightmost",
  async seed(ctx) {
    for (const link of LINKS) await pin(ctx, link.url, link.title)
    // On Windows the TUI asks from the recorder's own directory and lists only once, so load the plugin there too.
    await rpc(ctx, process.cwd(), "list", { sessionIDs: [ctx.sessions[0]!.id] })
  },
  steps: {
    pin: {
      usage: "pin <url> [title]         pin a link as the agent would, through the RPC",
      run: (ctx) => {
        const [url, ...title] = ctx.arg.split(" ")
        return pin(ctx, url!, title.join(" ") || undefined)
      },
    },
    unpin: {
      usage: "unpin <text>              hover that row, then click its cross",
      async run(ctx) {
        const row = await ctx.cell(ctx.arg)
        await ctx.page.mouse.move(row.x, row.y, { steps: 12 })
        await ctx.sleep(400)
        const cross = await ctx.cell(ctx.arg, { char: "✕" })
        await ctx.page.mouse.move(cross.x, cross.y, { steps: 8 })
        await ctx.sleep(400)
        await ctx.page.mouse.click(cross.x, cross.y)
      },
    },
  },
})
