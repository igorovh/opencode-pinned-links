/** @jsxImportSource @opentui/solid */
import { spawn } from "node:child_process"
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import type { MouseEvent } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { checkUrl, describe, displayTitle, type Link } from "./links"
import { LinksRpc, type LinksChanged } from "./rpc"

const MAX_SIDEBAR_ITEMS = 10
const ADD = "\u0000add"
const CLEAR = "\u0000clear"
// The server loads the plugin on the first request for a directory, so the first
// list can fail with `rpc.unavailable`. The TUI asks only once, so retry here.
const LIST_RETRIES = 40
const LIST_RETRY_MS = 250

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/** True when the plugin RPC is not loaded yet and a retry may succeed. */
export function isUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    const text = String(error ?? "").toLowerCase()
    return text.includes("rpc.unavailable") || text.includes("rpc is unavailable")
  }
  const record = error as { type?: unknown; message?: unknown }
  if (record.type === "rpc.unavailable") return true
  const text = String(record.message ?? "").toLowerCase()
  return text.includes("rpc.unavailable") || text.includes("rpc is unavailable")
}

function truncate(value: string, width: number) {
  if (width <= 0) return ""
  return value.length <= width ? value : value.slice(0, Math.max(0, width - 1)) + "…"
}

/** Opens a URL in the default browser. Tries each opener in turn; `onError` runs when none exists. */
export function openUrl(url: string, onError: (message: string) => void) {
  // No shell is involved, and checkUrl allows only http(s), so the URL cannot start another program.
  const target = checkUrl(url)
  const openers =
    process.platform === "win32" ? ["explorer.exe"] : process.platform === "darwin" ? ["open"] : ["xdg-open", "wslview", "gio"]
  const attempt = (index: number) => {
    const command = openers[index]
    if (!command) return onError(`No program to open ${target}. Install xdg-utils.`)
    spawn(command, command === "gio" ? ["open", target] : [target], { detached: true, stdio: "ignore", windowsHide: true })
      .on("error", () => attempt(index + 1))
      .unref()
  }
  attempt(0)
}

/** Like createResource, but never suspends the host's UI while loading. */
function asyncValue<S, T>(source: () => S, load: (input: S) => Promise<T>, initial: T) {
  const [value, setValue] = createSignal<T>(initial)
  let request = 0
  let disposed = false
  onCleanup(() => (disposed = true))
  createEffect(() => {
    const input = source()
    const id = ++request
    load(input).then(
      (result) => id === request && !disposed && setValue(() => result),
      () => {},
    )
  })
  return value
}

export function createUI(context: Context, open = openUrl) {
  const api = context.client.rpc(LinksRpc)
  const theme = () => context.theme
  const [version, setVersion] = createSignal(0)

  const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
    context.ui.toast.show({ title: "Links", message, variant })
  const fail = (error: unknown) => {
    const message =
      error instanceof Error ? error.message : typeof (error as { message?: unknown })?.message === "string" ? (error as { message: string }).message : String(error)
    toast(message, "error")
  }

  // Pins live on the root session; subagent sessions show their root's links too.
  const rootOf = (sessionID: string) => context.data.session.root(sessionID) || sessionID
  const familyOf = (sessionID: string) => {
    const root = rootOf(sessionID)
    return [...new Set([root, sessionID, ...context.data.session.family(root)])]
  }

  const listLinks = async (sessionIDs: string[]): Promise<Link[]> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return ((await api.list({ sessionIDs })) as { links: Link[] }).links
      } catch (error) {
        if (!isUnavailable(error) || attempt >= LIST_RETRIES) throw error
        await sleep(LIST_RETRY_MS)
      }
    }
  }

  const fetchLinks = async (sessionID: string) => listLinks(familyOf(sessionID))

  const refresh = () => setVersion((value) => value + 1)

  const stopEvents = api.events.on("changed", (event) => {
    refresh()
    const data = event.data as unknown as LinksChanged
    if (data.byAgent && data.title)
      context.ui.toast.show({ title: "Link pinned", message: data.title, variant: "success", sessionID: data.sessionID })
  })

  const openLink = (link: Link) => {
    try {
      open(link.url, (message) => toast(message, "error"))
    } catch (error) {
      fail(error)
    }
  }

  const unpin = async (link: Link) => {
    await api.remove({ sessionID: link.sessionID, ids: [link.id] })
    refresh()
  }

  const rename = async (link: Link) => {
    const title = await context.ui.dialog.prompt({ title: "Rename link", placeholder: describe(link.url).fallback, value: link.title })
    if (title === undefined) return
    await api.rename({ sessionID: link.sessionID, id: link.id, title })
    refresh()
  }

  const copy = (link: Link) => {
    if (context.renderer.copyToClipboardOSC52(link.url)) toast("Copied the URL")
    else toast("This terminal does not support copying (OSC 52)", "warning")
  }

  /** `/pin <url> [title]` pins a link without a dialog. */
  const add = async (sessionID: string, input?: string) => {
    let text = input?.trim()
    if (!text) {
      text = (await context.ui.dialog.prompt({ title: "Pin a link", placeholder: "https://… [title]" }))?.trim()
      if (!text) return
    }
    const [url = "", ...rest] = text.split(/\s+/)
    let href: string
    try {
      href = checkUrl(url)
    } catch (error) {
      return fail(error)
    }
    const { created } = (await api.add({ sessionID: rootOf(sessionID), url: href, title: rest.join(" ") || undefined })) as {
      created: boolean
    }
    refresh()
    toast(created ? "Link pinned" : "Already pinned; title updated", "success")
  }

  const label = (link: Link) => {
    const info = describe(link.url)
    return info.provider === "web" ? displayTitle(link) : `${info.ref} ${displayTitle(link)}`
  }

  // Right-click on a sidebar row, or Enter in /links.
  const openMenu = async (link: Link, back?: () => Promise<void>) => {
    const action = await context.ui.dialog.select({
      title: truncate(label(link), 60),
      options: [
        { title: "Open in browser", value: "open", description: link.url },
        { title: "Copy URL", value: "copy" },
        { title: "Rename…", value: "rename" },
        { title: "Unpin", value: "unpin" },
      ],
    })
    if (action === "open") openLink(link)
    if (action === "copy") copy(link)
    if (action === "rename") await rename(link)
    if (action === "unpin") await unpin(link)
    if (action === undefined || action === "unpin" || action === "rename") await back?.()
  }

  const openList = async (sessionID: string): Promise<void> => {
    const links = await fetchLinks(sessionID)
    const reopen = () => setTimeout(() => void openList(sessionID).catch(fail))
    const selected = await context.ui.dialog.select<string>({
      title: "Pinned links",
      placeholder: "Search links",
      options: [
        ...links.map((link) => ({ title: label(link), value: link.id, description: link.url, category: "Links" })),
        { title: "Pin a link…", value: ADD, category: "Actions" },
        ...(links.length ? [{ title: "Unpin all", value: CLEAR, category: "Actions" }] : []),
      ],
      actions: [
        {
          bind: "ctrl+o",
          title: "Open",
          onTrigger: (id) => {
            const link = links.find((item) => item.id === id)
            if (link) openLink(link)
          },
        },
        {
          bind: "ctrl+d",
          title: "Unpin",
          onTrigger: (id) => {
            const link = links.find((item) => item.id === id)
            if (!link) return
            // The select keeps its options, so close it and show the list again without the link.
            context.ui.dialog.clear()
            void unpin(link).then(reopen, fail)
          },
        },
      ],
    })
    if (selected === ADD) return add(sessionID)
    if (selected === CLEAR) {
      const confirmed = await context.ui.dialog.confirm({
        title: "Unpin all links",
        message: `Remove ${links.length} ${links.length === 1 ? "link" : "links"} from this session?`,
        label: { confirm: "Unpin all", cancel: "Cancel" },
      })
      if (!confirmed) return openList(sessionID)
      const bySession = Map.groupBy(links, (link) => link.sessionID)
      await Promise.all([...bySession].map(([id, items]) => api.remove({ sessionID: id, ids: items.map((link) => link.id) })))
      refresh()
      return toast("Unpinned all links")
    }
    const link = links.find((item) => item.id === selected)
    if (link) await openMenu(link, () => openList(sessionID))
  }

  const currentSession = () => {
    const route = context.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }

  const inSession = (run: (sessionID: string) => Promise<void>) => {
    const sessionID = currentSession()
    if (!sessionID) return toast("Open a session first", "warning")
    void run(sessionID).catch(fail)
  }
  const runLinks = () => inSession(openList)
  const runPin = (input?: string) => inSession((sessionID) => add(sessionID, input))

  function LinkRow(props: { link: Link; width: number }) {
    const [hovered, setHovered] = createSignal(false)
    const [crossHovered, setCrossHovered] = createSignal(false)
    const info = () => describe(props.link.url)
    const ref = () => (info().provider === "web" ? "↗" : info().ref)
    const title = () => truncate(displayTitle(props.link), props.width - ref().length - 3)
    return (
      <box
        flexDirection="row"
        height={1}
        flexShrink={0}
        backgroundColor={hovered() ? theme().background.raised.high : undefined}
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onMouseUp={(event: MouseEvent) => {
          event.stopPropagation()
          if (event.button === 0) openLink(props.link)
          else if (event.button === 1) void unpin(props.link).catch(fail)
          else if (event.button === 2) void openMenu(props.link).catch(fail)
        }}
      >
        <text selectable={false} fg={info().provider === "web" ? theme().text.muted : theme().hue.accent[200]}>
          {ref() + " "}
        </text>
        <text selectable={false} fg={theme().text.base}>{title()}</text>
        <box flexGrow={1} />
        {/* Shown on row hover; only a click on the cross itself unpins. */}
        <box
          width={2}
          flexShrink={0}
          onMouseOver={() => setCrossHovered(true)}
          onMouseOut={() => setCrossHovered(false)}
          onMouseUp={(event: MouseEvent) => {
            event.stopPropagation()
            if (event.button === 0 && hovered()) void unpin(props.link).catch(fail)
          }}
        >
          <text selectable={false} fg={crossHovered() ? theme().text.feedback.error.base : theme().text.muted}>
            {hovered() ? " ✕" : "  "}
          </text>
        </box>
      </box>
    )
  }

  function Sidebar(props: { sessionID: string }) {
    const sessionIDs = createMemo(() => familyOf(props.sessionID), [], { equals: (a, b) => a.join() === b.join() })
    const links = asyncValue(
      () => ({ ids: sessionIDs(), version: version() }),
      async ({ ids }) => listLinks(ids),
      [] as Link[],
    )
    const [width, setWidth] = createSignal(30)
    const list = () => void openList(props.sessionID).catch(fail)
    return (
      <Show when={links().length > 0}>
        <box
          flexDirection="column"
          flexShrink={0}
          onSizeChange={function (this: { width: number }) {
            setWidth(this.width)
          }}
        >
          <box flexDirection="row" flexShrink={0} onMouseUp={list}>
            <text fg={theme().text.base}>
              <b>Links</b>
            </text>
            <box flexGrow={1} />
            <text fg={theme().text.muted}>{String(links().length)}</text>
          </box>
          <For each={links().slice(0, MAX_SIDEBAR_ITEMS)}>{(link) => <LinkRow link={link} width={width()} />}</For>
          <Show when={links().length > MAX_SIDEBAR_ITEMS}>
            <box height={1} flexShrink={0} onMouseUp={list}>
              <text fg={theme().text.muted}>{`… ${links().length - MAX_SIDEBAR_ITEMS} more (/links)`}</text>
            </box>
          </Show>
        </box>
      </Show>
    )
  }

  return { Sidebar, runLinks, runPin, stopEvents }
}

export default Plugin.define({
  id: "pinned-links.tui",
  setup(context) {
    const ui = createUI(context)
    const stopSidebar = context.ui.slot({
      append: "sidebar.content",
      render: (input) => <ui.Sidebar sessionID={input.sessionID} />,
    })

    // Slash completion runs while the prompt has focus, which only global layers reach.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "pinned-links.list",
          title: "Pinned links",
          group: "Links",
          palette: true,
          slash: { name: "links" },
          run: ui.runLinks,
        },
        {
          id: "pinned-links.pin",
          title: "Pin a link",
          group: "Links",
          palette: true,
          // Arguments make the first Enter only complete the command, so /links stays without them.
          slash: { name: "pin", arguments: true },
          run: ui.runPin,
        },
      ],
    }))

    return () => {
      ui.stopEvents()
      stopSidebar()
    }
  },
})
