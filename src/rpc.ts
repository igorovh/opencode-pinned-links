import { Rpc } from "@opencode/plugin/rpc"

export interface LinksChanged {
  readonly sessionID: string
  readonly action: "added" | "updated" | "removed"
  /** Set when the agent pinned a new link, so the TUI can show a toast. */
  readonly title?: string
  readonly byAgent?: boolean
}

const object = { type: "object" } as const
const links = { type: "array", items: object } as const

export const LinksRpc = Rpc.define({
  id: "pinned-links",
  methods: {
    list: {
      input: {
        type: "object",
        properties: { sessionIDs: { type: "array", items: { type: "string" } } },
        required: ["sessionIDs"],
      },
      output: { type: "object", properties: { links }, required: ["links"] },
    },
    add: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, url: { type: "string" }, title: { type: "string" } },
        required: ["sessionID", "url"],
      },
      output: { type: "object", properties: { link: object, created: { type: "boolean" } }, required: ["link", "created"] },
    },
    rename: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, id: { type: "string" }, title: { type: "string" } },
        required: ["sessionID", "id", "title"],
      },
      output: { type: "object", properties: { link: object } },
    },
    remove: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, ids: { type: "array", items: { type: "string" } } },
        required: ["sessionID", "ids"],
      },
      output: { type: "object", properties: { removed: links }, required: ["removed"] },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          action: { type: "string", enum: ["added", "updated", "removed"] },
          title: { type: "string" },
          byAgent: { type: "boolean" },
        },
        required: ["sessionID", "action"],
      },
    },
  },
})
