import { Plugin } from "@opencode/plugin"
import { describe, displayTitle, type Link } from "./links"
import { LinksRpc, type LinksChanged } from "./rpc"
import { Store, resolveRoot } from "./store"

const REMINDER = [
  "When you open a pull request or merge request, or start work on a Linear, Jira or GitHub issue, pin its URL with",
  "links_pin so the user can open it from the session sidebar. Pin other links the user will want again too, such as",
  "deployments or preview URLs.",
].join(" ")

// Subagents run in child sessions; their pins belong to the session the user is looking at.
const MAX_DEPTH = 16

function line(link: Link) {
  const info = describe(link.url)
  return `- ${link.id}: ${info.provider === "web" ? "" : info.ref + " "}${displayTitle(link)} <${link.url}>`
}

export default Plugin.define({
  id: "pinned-links",
  async setup(ctx) {
    const store = new Store(resolveRoot(ctx.options.dir))

    const rootOf = async (sessionID: string) => {
      let current = sessionID
      for (let depth = 0; depth < MAX_DEPTH; depth++) {
        const parent = await ctx.session
          .get({ sessionID: current })
          .then((session) => session.parentID ?? undefined)
          .catch(() => undefined)
        if (!parent) break
        current = parent
      }
      return current
    }

    const rpc = await ctx.rpc.register(LinksRpc, {
      list: async (input) => {
        const { sessionIDs } = input as { sessionIDs: string[] }
        return { links: await store.list(sessionIDs) }
      },
      add: async (input) => {
        const { sessionID, url, title } = input as { sessionID: string; url: string; title?: string }
        const result = await store.add({ sessionID, url, title })
        await changed({ sessionID, action: result.created ? "added" : "updated" })
        return result
      },
      rename: async (input) => {
        const { sessionID, id, title } = input as { sessionID: string; id: string; title: string }
        const link = await store.rename({ sessionID, id, title })
        if (link) await changed({ sessionID, action: "updated" })
        return link ? { link } : {}
      },
      remove: async (input) => {
        const { sessionID, ids } = input as { sessionID: string; ids: string[] }
        const removed = await store.remove({ sessionID, ids })
        if (removed.length) await changed({ sessionID, action: "removed" })
        return { removed }
      },
    })

    const changed = (event: LinksChanged) => rpc.events.emit("changed", { ...event })

    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "links", description: "Links pinned to the session sidebar in the TUI" })
      editor.add({
        name: "pin",
        description: [
          "Pin a URL to the sidebar of this session, where the user opens it in the browser with one click.",
          "Use it for pull requests and merge requests you open (GitHub, Bitbucket, GitLab), Linear, Jira and",
          "GitHub issues you work on, and other pages the user will want again, such as deployments.",
          "Pinning a URL that is already pinned updates its title. Only http and https URLs.",
        ].join(" "),
        input: {
          type: "object",
          properties: {
            url: { type: "string", description: "The full http(s) URL" },
            title: {
              type: "string",
              description: "Short label, such as the pull request or issue title. Leave it out to show the repository or page.",
            },
          },
          required: ["url"],
          additionalProperties: false,
        },
        options: { namespace: "links" },
        execute: async (input, context) => {
          const { url, title } = input as { url: string; title?: string }
          const sessionID = await rootOf(context.sessionID)
          const { link, created } = await store.add({ sessionID, url, title })
          await changed({ sessionID, action: created ? "added" : "updated", title: displayTitle(link), byAgent: created })
          return {
            content: `${created ? "Pinned" : "Already pinned; updated"} ${line(link).slice(2)}. The user sees it in the sidebar and in /links.`,
            metadata: { linkID: link.id },
          }
        },
      })
      editor.add({
        name: "unpin",
        description: "Remove pinned links from this session's sidebar by link ID or URL.",
        input: {
          type: "object",
          properties: {
            ids: { type: "array", items: { type: "string" }, description: "Link IDs from links_list" },
            urls: { type: "array", items: { type: "string" } },
          },
          additionalProperties: false,
        },
        options: { namespace: "links" },
        execute: async (input, context) => {
          const { ids, urls } = input as { ids?: string[]; urls?: string[] }
          const sessionID = await rootOf(context.sessionID)
          const removed = await store.remove({ sessionID, ids, urls })
          if (!removed.length) return { content: "No pinned link matched. Use links_list to see the pinned links." }
          await changed({ sessionID, action: "removed" })
          return { content: `Unpinned:\n${removed.map(line).join("\n")}` }
        },
      })
      editor.add({
        name: "list",
        description: "List the links pinned to this session's sidebar.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "links" },
        execute: async (_input, context) => {
          const links = await store.list([await rootOf(context.sessionID)])
          return { content: links.length ? links.map(line).join("\n") : "No links are pinned in this session." }
        },
      })
    })

    if (ctx.options.remind !== false)
      await ctx.session.hook("context", (event) => {
        event.system.push({ type: "text", text: REMINDER })
      })
  },
})
