import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import plugin from "../src/index"
import { Store } from "../src/store"

let root: string
beforeEach(async () => (root = await mkdtemp(path.join(os.tmpdir(), "links-server-"))))
afterEach(() => rm(root, { recursive: true, force: true }))

type Tool = { name: string; execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }> }

async function setup(options: Record<string, unknown> = {}) {
  const tools: Tool[] = []
  const events: unknown[] = []
  const hooks: string[] = []
  const parents: Record<string, string> = { ses_child: "ses_root", ses_grandchild: "ses_child" }
  const ctx = {
    options: { dir: root, ...options },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, parentID: parents[sessionID] }),
      hook: async (name: string) => void hooks.push(name),
    },
    rpc: { register: async () => ({ events: { emit: async (_: string, data: unknown) => void events.push(data) } }) },
    tool: {
      transform: async (callback: (editor: object) => void) =>
        callback({ namespace: () => {}, add: (tool: Tool) => tools.push(tool) }),
    },
  } as unknown as Context
  await plugin.setup(ctx)
  const tool = (name: string) => tools.find((item) => item.name === name)!
  return { tool, events, hooks }
}

test("a pin from a subagent lands on the root session the user sees, and tells the TUI", async () => {
  const { tool, events } = await setup()
  const result = await tool("pin").execute(
    { url: "https://github.com/acme/web/pull/482", title: "Fix login" },
    { sessionID: "ses_grandchild" },
  )
  expect(result.content).toContain("Pinned")
  expect(result.content).toContain("#482 Fix login")
  const [link] = await new Store(root).list(["ses_root"])
  expect(link).toMatchObject({ sessionID: "ses_root", url: "https://github.com/acme/web/pull/482", title: "Fix login" })
  expect(events).toEqual([{ sessionID: "ses_root", action: "added", title: "Fix login", byAgent: true }])
})

test("list and unpin by URL", async () => {
  const { tool } = await setup()
  await tool("pin").execute({ url: "https://linear.app/acme/issue/ENG-1/dark-mode" }, { sessionID: "ses_root" })
  expect((await tool("list").execute({}, { sessionID: "ses_child" })).content).toContain("ENG-1 dark mode")
  expect((await tool("unpin").execute({ urls: ["https://example.com"] }, { sessionID: "ses_root" })).content).toContain(
    "No pinned link matched",
  )
  await tool("unpin").execute({ urls: ["https://linear.app/acme/issue/ENG-1/dark-mode"] }, { sessionID: "ses_root" })
  expect((await tool("list").execute({}, { sessionID: "ses_root" })).content).toBe("No links are pinned in this session.")
})

test("a non-web URL is refused", async () => {
  const { tool } = await setup()
  expect(tool("pin").execute({ url: "file:///etc/passwd" }, { sessionID: "ses_root" })).rejects.toThrow("Only http and https")
})

test("the reminder is on by default and off with remind: false", async () => {
  expect((await setup()).hooks).toEqual(["context"])
  expect((await setup({ remind: false })).hooks).toEqual([])
})
