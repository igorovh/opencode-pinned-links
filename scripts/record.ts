// Records the real OpenCode TUI with this plugin: bun run record -- --out demo.gif --step "type /links"
// Needs opencode (OPENCODE_BIN), ttyd (TTYD_BIN) and ffmpeg. Links are pinned through the RPC, so no model runs.
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"
import { chromium, type Page } from "playwright"

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "demo.gif" },
    step: { type: "string", multiple: true, default: [] },
    steps: { type: "string" },
    plugin: { type: "string", default: path.join(import.meta.dir, "..") },
    width: { type: "string", default: "1280" },
    height: { type: "string", default: "600" },
  },
})

const STEPS_HELP = `Steps, one per --step or per line of --steps <file>:
  wait <ms>                 pause
  hover <text>              move the pointer onto the row showing <text>
  right <text>              right-click that row (a left click would open a real browser)
  unpin <text>              hover that row, then click its cross
  pin <url> [title]         pin a link as the agent would, through the RPC
  key <keys>                press keys, such as Enter, ctrl+d or escape
  type <text>               type text, such as /links (add "key Enter" to run it)
  expect <text>             fail unless <text> shows within 5 s
  expect-not <text>         fail unless <text> is gone within 5 s
An --out ending in .png saves a screenshot after the steps instead of a GIF.`

const LINKS = [
  { url: "https://example.com/preview/settings", title: "Preview: settings page" },
  { url: "https://linear.app/acme/issue/ENG-214/dark-mode-for-settings", title: "Dark mode for settings" },
  { url: "https://bitbucket.org/acme/api/pull-requests/57", title: "Theme tokens endpoint" },
  { url: "https://github.com/acme/web/pull/482", title: "Add dark mode to settings" },
]

const opencodeBin = process.env.OPENCODE_BIN ?? "opencode"
const ttydBin = process.env.TTYD_BIN ?? "ttyd"
const steps = [...values.step!, ...(values.steps ? readFileSync(values.steps, "utf8").split(/\r?\n/) : [])]
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
if (!steps.length) console.log(`No steps given, so it shows the sidebar at rest.\n${STEPS_HELP}`)

const work = mkdtempSync(path.join(os.tmpdir(), "pinned-links-record-"))
const project = path.join(work, "repos", "web")
const serverPort = 40000 + Math.floor(Math.random() * 20000)
const ttydPort = serverPort + 1
// ttyd listens on every interface and the terminal is writable, so keep others on the network out.
const ttydCredential = { username: "record", password: crypto.randomUUID() }
const password = "record"
const env = {
  ...process.env,
  HOME: work,
  USERPROFILE: work,
  XDG_CONFIG_HOME: path.join(work, "config"),
  XDG_DATA_HOME: path.join(work, "data"),
  XDG_STATE_HOME: path.join(work, "state"),
  XDG_CACHE_HOME: path.join(work, "cache"),
  OPENCODE_SERVER_PASSWORD: password,
}
const children: ChildProcess[] = []
const output: string[] = []
const start = (bin: string, args: string[], options: { cwd?: string } = {}) => {
  const child = spawn(bin, args, { env, ...options, stdio: ["ignore", "ignore", "pipe"] })
  child.stderr!.on("data", (chunk) => output.push(`${path.basename(bin)}: ${chunk}`))
  children.push(child)
  return child
}
const stopAll = () => {
  for (const child of children) {
    if (child.exitCode !== null || !child.pid) continue
    if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)])
    else child.kill("SIGTERM")
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until<T>(label: string, read: () => Promise<T | undefined>, timeout = 60000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await read().catch(() => undefined)
    if (value) return value
    await sleep(250)
  }
  throw new Error(`Timed out waiting for ${label}\n${output.join("").slice(-4000)}`)
}

const api = `http://127.0.0.1:${serverPort}`
const auth = { authorization: `Basic ${btoa(`opencode:${password}`)}`, "content-type": "application/json" }
let sessionID = ""

async function pin(url: string, title?: string) {
  const query = new URLSearchParams({ "location[directory]": project })
  const response = await fetch(`${api}/api/rpc/pinned-links/add?${query}`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ input: { sessionID, url, title } }),
  })
  if (!response.ok) throw new Error(`Pinning ${url} failed: ${response.status} ${await response.text()}`)
}

try {
  mkdirSync(project, { recursive: true })
  spawnSync("git", ["-C", project, "init", "-q"])
  spawnSync("git", ["-C", project, "-c", "user.name=demo", "-c", "user.email=demo@example.com", "commit", "-q", "--allow-empty", "-m", "init"])
  mkdirSync(path.join(env.XDG_CONFIG_HOME, "opencode"), { recursive: true })
  const plugin = path.resolve(values.plugin!).replaceAll("\\", "/")
  writeFileSync(path.join(env.XDG_CONFIG_HOME, "opencode", "opencode.json"), JSON.stringify({ update: "disable", plugins: [plugin] }))
  writeFileSync(path.join(env.XDG_CONFIG_HOME, "opencode", "cli.json"), JSON.stringify({ tabs: { mode: "off" } }))

  start(opencodeBin, ["serve", "--port", String(serverPort)])
  await until("the OpenCode server", async () => (await fetch(`${api}/api/info`, { headers: auth })).ok || undefined)

  const created = await fetch(`${api}/api/session`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ title: "Dark mode for settings", location: { directory: project } }),
  })
  if (!created.ok) throw new Error(`Creating a session failed: ${created.status} ${await created.text()}`)
  sessionID = ((await created.json()) as { data: { id: string } }).data.id
  for (const link of LINKS) await pin(link.url, link.title)

  start(
    ttydBin,
    ["-p", String(ttydPort), "-c", `${ttydCredential.username}:${ttydCredential.password}`, "-W", "-t", "fontSize=15", "-t", "disableLeaveAlert=true", opencodeBin, "--server", api, "--session", sessionID],
    { cwd: project },
  )
  await until("ttyd", async () => (await fetch(`http://127.0.0.1:${ttydPort}`, { headers: { authorization: `Basic ${btoa(`${ttydCredential.username}:${ttydCredential.password}`)}` } })).ok || undefined)

  const width = Number(values.width)
  const height = Number(values.height)
  const png = values.out!.endsWith(".png")
  const browser = await chromium.launch()
  const context = await browser.newContext({
    httpCredentials: ttydCredential,
    viewport: { width, height },
    ...(png ? {} : { recordVideo: { dir: path.join(work, "video"), size: { width, height } } }),
  })
  const page = await context.newPage()
  let ready = 0
  let failure: Error | undefined
  try {
    const started = Date.now()
    await page.goto(`http://127.0.0.1:${ttydPort}`)
    await until("the Links section", async () => (await screenLines(page)).some((line) => line.includes("Links")) || undefined)
    await sleep(1500)
    ready = (Date.now() - started) / 1000
    for (const step of steps) {
      try {
        await runStep(page, step)
      } catch (error) {
        failure = error as Error
        break
      }
      await sleep(700)
    }
    await sleep(1000)
    if (png) await page.screenshot({ path: values.out! })
  } finally {
    await context.close()
    await browser.close()
  }

  if (!png) {
    const ffmpeg = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-ss",
        ready.toFixed(2),
        "-i",
        await page.video()!.path(),
        "-vf",
        "fps=12,scale='min(960,iw)':-1:flags=lanczos,mpdecimate,split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
        "-fps_mode",
        "vfr",
        values.out!,
      ],
      { stdio: "inherit" },
    )
    if (ffmpeg.status !== 0) throw new Error("ffmpeg failed")
  }
  console.log(`Wrote ${values.out}`)
  if (failure) throw failure
} finally {
  stopAll()
  rmSync(work, { recursive: true, force: true, maxRetries: 5 })
}

// ttyd exposes its xterm.js instance as window.term.
async function screenLines(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const term = (window as any).term
    if (!term) return []
    const buffer = term.buffer.active
    return Array.from({ length: term.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString() ?? "")
  })
}

// The sidebar is on the right, so take the rightmost match.
async function cellOf(page: Page, text: string, cross = false) {
  const lines = await screenLines(page)
  let row = -1
  lines.forEach((line, index) => {
    if (line.includes(text) && (row === -1 || line.lastIndexOf(text) > lines[row]!.lastIndexOf(text))) row = index
  })
  if (row === -1) throw new Error(`No row shows "${text}"`)
  const line = lines[row]!
  let col = line.lastIndexOf(text) + Math.floor(text.length / 2)
  if (cross) {
    col = line.indexOf("✕", line.lastIndexOf(text))
    if (col === -1) throw new Error(`The row "${text}" shows no cross`)
  }
  const box = await page.evaluate(() => {
    const term = (window as any).term
    const rect = document.querySelector(".xterm-screen")!.getBoundingClientRect()
    return { x: rect.left, y: rect.top, width: rect.width / term.cols, height: rect.height / term.rows }
  })
  return { x: box.x + (col + 0.5) * box.width, y: box.y + (row + 0.5) * box.height }
}

async function runStep(page: Page, step: string) {
  const [verb, ...rest] = step.split(" ")
  const arg = rest.join(" ")
  console.log(`> ${step}`)
  switch (verb) {
    case "wait":
      return sleep(Number(arg))
    case "hover": {
      const at = await cellOf(page, arg)
      return page.mouse.move(at.x, at.y, { steps: 12 })
    }
    case "right": {
      const at = await cellOf(page, arg)
      await page.mouse.move(at.x, at.y, { steps: 12 })
      await sleep(300)
      return page.mouse.click(at.x, at.y, { button: "right" })
    }
    case "unpin": {
      const row = await cellOf(page, arg)
      await page.mouse.move(row.x, row.y, { steps: 12 })
      await sleep(400)
      const cross = await cellOf(page, arg, true)
      await page.mouse.move(cross.x, cross.y, { steps: 8 })
      await sleep(400)
      return page.mouse.click(cross.x, cross.y)
    }
    case "pin": {
      const [url, ...title] = rest
      return pin(url!, title.join(" ") || undefined)
    }
    case "key":
      return page.keyboard.press(arg.split("+").map(keyName).join("+"))
    case "type":
      return page.keyboard.type(arg, { delay: 60 })
    case "expect":
    case "expect-not": {
      if (!arg) throw new Error(`Step "${step}" needs text to match`)
      const want = verb === "expect"
      const end = Date.now() + 5000
      while (Date.now() < end) {
        if ((await screenLines(page)).some((line) => line.includes(arg)) === want) return
        await sleep(200)
      }
      const screen = (await screenLines(page)).map((line) => line.trimEnd()).join("\n")
      throw new Error(`Step "${step}" failed: the screen ${want ? "never showed" : "still shows"} "${arg}"\n${screen}`)
    }
    default:
      throw new Error(`Unknown step "${step}"\n${STEPS_HELP}`)
  }
}

// Playwright names modifiers Control, Alt, Shift and Meta, and keys like Enter and Escape.
function keyName(key: string) {
  const aliases: Record<string, string> = { ctrl: "Control", control: "Control", meta: "Meta", esc: "Escape", up: "ArrowUp", down: "ArrowDown" }
  const lower = key.toLowerCase()
  if (aliases[lower]) return aliases[lower]
  return key.length === 1 ? key : key[0]!.toUpperCase() + key.slice(1)
}
