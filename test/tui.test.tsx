/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Context, DialogSelectOptions, KeymapLayer } from "@opencode/plugin/tui/context"
import { RGBA, type CliRenderer } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { createUI } from "../src/tui"
import { Store } from "../src/store"

// Every theme token resolves to the same grey, whatever its path.
function fakeTheme(): any {
  const color = RGBA.fromHex("#888888")
  const handler: ProxyHandler<RGBA> = {
    get(target, prop) {
      if (prop in target) {
        const value = Reflect.get(target, prop, target)
        return typeof value === "function" ? value.bind(target) : value
      }
      return new Proxy(color, handler)
    },
  }
  return new Proxy(color, handler)
}

let root: string
afterEach(() => rm(root, { recursive: true, force: true }))

async function setup() {
  root = await mkdtemp(path.join(os.tmpdir(), "links-tui-"))
  const store = new Store(root)
  await store.add({ sessionID: "ses_a", url: "https://github.com/acme/web/pull/482", title: "Fix login redirect" })
  await Bun.sleep(2)
  await store.add({ sessionID: "ses_a", url: "https://linear.app/acme/issue/ENG-7/dark-mode" })

  const opened: string[] = []
  const toasts: string[] = []
  const selects: DialogSelectOptions<unknown>[] = []
  const listeners: ((event: { data: unknown }) => void)[] = []
  let pick: (options: DialogSelectOptions<unknown>) => unknown = () => undefined
  let resolveSelect: ((value: unknown) => void) | undefined

  const rpc = {
    list: async ({ sessionIDs }: { sessionIDs: string[] }) => ({ links: await store.list(sessionIDs) }),
    add: (input: { sessionID: string; url: string; title?: string }) => store.add(input),
    rename: async (input: { sessionID: string; id: string; title: string }) => ({ link: await store.rename(input) }),
    remove: async ({ sessionID, ids }: { sessionID: string; ids: string[] }) => ({ removed: await store.remove({ sessionID, ids }) }),
    events: { on: (_: string, listener: (event: { data: unknown }) => void) => (listeners.push(listener), () => {}) },
  }

  const context = (renderer: CliRenderer) =>
    ({
      renderer,
      theme: fakeTheme(),
      client: { rpc: () => rpc },
      data: { session: { root: (id: string) => id, family: () => [] } },
      ui: {
        toast: { show: (options: { message: string }) => toasts.push(options.message) },
        router: { current: () => ({ type: "session", sessionID: "ses_a" }) },
        dialog: {
          clear: () => resolveSelect?.(undefined),
          prompt: async () => undefined,
          select: (options: DialogSelectOptions<unknown>) => {
            selects.push(options)
            return new Promise((resolve) => {
              resolveSelect = resolve
              const value = pick(options)
              if (value !== "keep-open") resolve(value)
            })
          },
        },
      },
    }) as unknown as Context

  let ui!: ReturnType<typeof createUI>
  function Host() {
    ui = createUI(context(useRenderer()), (url) => void opened.push(url))
    return (
      <box width={36} flexDirection="column">
        <ui.Sidebar sessionID="ses_a" />
      </box>
    )
  }

  const rendered = await testRender(() => <Host />, { width: 60, height: 12 })
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      await Bun.sleep(20)
      await rendered.renderOnce()
    }
  }
  await settle()
  const clickText = async (text: string) => {
    const lines = rendered.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes(text))
    expect(y).toBeGreaterThanOrEqual(0)
    const x = lines[y]!.indexOf(text)
    await rendered.mockMouse.moveTo(x, y)
    await rendered.mockMouse.click(x, y)
    await settle()
  }
  const setPick = (next: typeof pick) => (pick = next)
  return { ...rendered, ui, store, opened, toasts, selects, listeners, settle, clickText, setPick }
}

test("the sidebar lists pins newest first and a click opens the URL", async () => {
  const t = await setup()
  const frame = t.captureCharFrame()
  expect(frame).toContain("Links")
  expect(frame.indexOf("ENG-7 dark mode")).toBeLessThan(frame.indexOf("#482 Fix login redirect"))

  await t.clickText("Fix login")
  expect(t.opened).toEqual(["https://github.com/acme/web/pull/482"])
  t.renderer.destroy()
})

test("the cross on a hovered row unpins it without opening it", async () => {
  const t = await setup()
  const lines = () => t.captureCharFrame().split("\n")
  const y = lines().findIndex((line) => line.includes("Fix login"))
  expect(lines()[y]).not.toContain("✕")
  await t.mockMouse.moveTo(lines()[y]!.indexOf("Fix login"), y)
  await t.settle()
  const x = lines()[y]!.indexOf("✕")
  expect(x).toBeGreaterThan(0)
  await t.mockMouse.click(x, y)
  await t.settle()
  expect(t.opened).toEqual([])
  expect(t.captureCharFrame()).not.toContain("Fix login")
  expect((await t.store.list(["ses_a"])).map((link) => link.url)).toEqual(["https://linear.app/acme/issue/ENG-7/dark-mode"])
  t.renderer.destroy()
})

test("/links unpins with ctrl+d and shows the list again", async () => {
  const t = await setup()
  t.setPick(() => "keep-open")
  t.ui.runLinks()
  await t.settle()
  const first = t.selects[0]!
  expect(first.options.map((option) => option.title)).toEqual([
    "ENG-7 dark mode",
    "#482 Fix login redirect",
    "Pin a link…",
    "Unpin all",
  ])
  const unpin = first.actions!.find((action) => action.title === "Unpin")! as { onTrigger: (value: unknown) => void }
  unpin.onTrigger(first.options[1]!.value)
  await t.settle()
  expect(t.selects[1]!.options.map((option) => option.title)).toEqual(["ENG-7 dark mode", "Pin a link…", "Unpin all"])
  expect(t.captureCharFrame()).not.toContain("Fix login")
  t.renderer.destroy()
})

test("/pin <url> <title> pins to the current session", async () => {
  const t = await setup()
  t.ui.runPin("https://bitbucket.org/team/api/pull-requests/31 Retry webhooks")
  await t.settle()
  expect(t.toasts).toEqual(["Link pinned"])
  expect(t.captureCharFrame()).toContain("#31 Retry webhooks")

  t.ui.runPin("notaurl")
  await t.settle()
  expect(t.toasts.at(-1)).toContain("Not a valid URL")
  t.renderer.destroy()
})

test("a pin by the agent refreshes the sidebar and shows a toast", async () => {
  const t = await setup()
  await t.store.add({ sessionID: "ses_a", url: "https://example.com/preview", title: "Preview" })
  for (const listener of t.listeners)
    listener({ data: { sessionID: "ses_a", action: "added", title: "Preview", byAgent: true } })
  await t.settle()
  expect(t.toasts).toEqual(["Preview"])
  expect(t.captureCharFrame()).toContain("↗ Preview")
  t.renderer.destroy()
})
