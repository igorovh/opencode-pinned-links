import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { checkUrl, cleanTitle, type Link } from "./links"

const SAFE_ID = /^\w[\w.-]*$/

function expandHome(file: string) {
  return file === "~" || file.startsWith("~/") || file.startsWith("~\\") ? path.join(os.homedir(), file.slice(1)) : file
}

/** The `dir` option with `~` expanded; relative paths resolve against the home directory. */
export function resolveRoot(dir: unknown) {
  if (typeof dir === "string" && dir.trim()) return path.resolve(os.homedir(), expandHome(dir.trim()))
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(data, "opencode", "pinned-links")
}

function newID() {
  return `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** Links of each session live in one JSON file, so every server location reads the same pins. */
export class Store {
  private locks = new Map<string, Promise<unknown>>()

  constructor(readonly root: string) {}

  private file(sessionID: string) {
    if (typeof sessionID !== "string" || !SAFE_ID.test(sessionID)) throw new Error("invalid session ID")
    return path.join(this.root, `${sessionID}.json`)
  }

  /** Runs read-modify-write updates of one session one at a time. */
  private exclusive<T>(sessionID: string, task: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(sessionID) ?? Promise.resolve()).then(task, task)
    const tail = run.catch(() => {})
    this.locks.set(sessionID, tail)
    void tail.then(() => this.locks.get(sessionID) === tail && this.locks.delete(sessionID))
    return run
  }

  private async read(sessionID: string): Promise<Link[]> {
    try {
      const data = JSON.parse(await readFile(this.file(sessionID), "utf8")) as { links?: Link[] }
      return Array.isArray(data.links) ? data.links : []
    } catch {
      return []
    }
  }

  private async write(sessionID: string, links: Link[]) {
    const file = this.file(sessionID)
    if (!links.length) return rm(file, { force: true })
    await mkdir(this.root, { recursive: true })
    // Write then rename, so a crash never leaves a half-written file behind.
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, JSON.stringify({ links }, null, 2))
    await rename(temp, file)
  }

  /** Newest first. */
  async list(sessionIDs: readonly string[]): Promise<Link[]> {
    const lists = await Promise.all([...new Set(sessionIDs)].map((id) => this.read(id)))
    return lists.flat().sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Pinning a URL that is already pinned keeps the link and updates its title. */
  async add(input: { sessionID: string; url: string; title?: string }) {
    const url = checkUrl(input.url)
    const title = cleanTitle(input.title)
    return this.exclusive(input.sessionID, async () => {
      const links = await this.read(input.sessionID)
      const index = links.findIndex((link) => link.url === url)
      if (index >= 0) {
        const link = { ...links[index]!, title: title || links[index]!.title }
        links[index] = link
        await this.write(input.sessionID, links)
        return { link, created: false }
      }
      const link: Link = { id: newID(), sessionID: input.sessionID, url, title, createdAt: Date.now() }
      await this.write(input.sessionID, [...links, link])
      return { link, created: true }
    })
  }

  rename(input: { sessionID: string; id: string; title: string }) {
    return this.exclusive(input.sessionID, async () => {
      const links = await this.read(input.sessionID)
      const index = links.findIndex((link) => link.id === input.id)
      if (index < 0) return undefined
      const link = { ...links[index]!, title: cleanTitle(input.title) }
      links[index] = link
      await this.write(input.sessionID, links)
      return link
    })
  }

  /** Removes links by ID or URL and returns the removed ones. */
  remove(input: { sessionID: string; ids?: readonly string[]; urls?: readonly string[] }) {
    const urls = new Set((input.urls ?? []).flatMap((url) => {
      try {
        return [checkUrl(url)]
      } catch {
        return [url]
      }
    }))
    const ids = new Set(input.ids ?? [])
    return this.exclusive(input.sessionID, async () => {
      const links = await this.read(input.sessionID)
      const removed = links.filter((link) => ids.has(link.id) || urls.has(link.url))
      if (removed.length) await this.write(input.sessionID, links.filter((link) => !removed.includes(link)))
      return removed
    })
  }

  clear(sessionID: string) {
    return this.exclusive(sessionID, async () => {
      const links = await this.read(sessionID)
      await this.write(sessionID, [])
      return links
    })
  }
}
