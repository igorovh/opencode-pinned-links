import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Store } from "../src/store"

let root: string
beforeEach(async () => (root = await mkdtemp(path.join(os.tmpdir(), "links-store-"))))
afterEach(() => rm(root, { recursive: true, force: true }))

test("pinning the same URL twice keeps one link and takes the new title", async () => {
  const store = new Store(root)
  const first = await store.add({ sessionID: "ses_a", url: "https://github.com/acme/web/pull/1", title: "Draft" })
  const second = await store.add({ sessionID: "ses_a", url: "https://github.com/acme/web/pull/1", title: "Fix login" })
  expect(first.created).toBe(true)
  expect(second).toEqual({ created: false, link: { ...first.link, title: "Fix login" } })
  expect(await new Store(root).list(["ses_a"])).toEqual([second.link])
})

test("links are listed newest first across sessions and survive a new store", async () => {
  const store = new Store(root)
  const older = await store.add({ sessionID: "ses_a", url: "https://example.com/a" })
  while (Date.now() <= older.link.createdAt) await Bun.sleep(1)
  const newer = await store.add({ sessionID: "ses_b", url: "https://example.com/b" })
  expect((await new Store(root).list(["ses_a", "ses_b"])).map((link) => link.id)).toEqual([newer.link.id, older.link.id])
})

test("concurrent pins in one session are all kept", async () => {
  const store = new Store(root)
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.add({ sessionID: "ses_a", url: `https://example.com/${i}` })))
  expect(await store.list(["ses_a"])).toHaveLength(10)
})

test("remove by ID or URL, rename, and the file goes away with the last link", async () => {
  const store = new Store(root)
  const a = await store.add({ sessionID: "ses_a", url: "https://example.com/a" })
  await store.add({ sessionID: "ses_a", url: "https://example.com/b" })
  expect((await store.rename({ sessionID: "ses_a", id: a.link.id, title: " Docs " }))?.title).toBe("Docs")
  expect((await store.remove({ sessionID: "ses_a", ids: [a.link.id] })).map((link) => link.title)).toEqual(["Docs"])
  expect(await store.remove({ sessionID: "ses_a", urls: ["https://example.com/b"] })).toHaveLength(1)
  expect(await readdir(root)).toEqual([])
})

test("session IDs cannot escape the store directory", async () => {
  const store = new Store(path.join(root, "store"))
  expect(store.add({ sessionID: "../evil", url: "https://example.com" })).rejects.toThrow("invalid session ID")
  expect(store.add({ sessionID: "ses_a", url: "file:///etc/passwd" })).rejects.toThrow("Only http and https")
})
