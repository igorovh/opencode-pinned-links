// @bun
import { Plugin } from "@opencode/plugin";

var MAX_URL = 2048;
var MAX_TITLE = 200;
function checkUrl(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw)
    throw new Error("The URL is empty");
  if (raw.length > MAX_URL)
    throw new Error(`The URL is longer than ${MAX_URL} characters`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`Only http and https links can be pinned, not ${url.protocol}`);
  return url.href;
}
function cleanTitle(input) {
  const title = typeof input === "string" ? input.replace(/\s+/g, " ").trim() : "";
  return title.length > MAX_TITLE ? title.slice(0, MAX_TITLE - 1) + "\u2026" : title;
}
function describe(href) {
  const url = new URL(href);
  const host = url.hostname.replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const web = { provider: "web", ref: host, fallback: url.pathname === "/" ? host : host + url.pathname };
  if (host === "github.com" && parts.length >= 4) {
    const [owner, repo, type, number] = parts;
    if ((type === "pull" || type === "issues") && /^\d+$/.test(number))
      return { provider: "github", ref: `#${number}`, fallback: `${owner}/${repo}` };
  }
  if (host === "bitbucket.org" && parts.length >= 4) {
    const [workspace, repo, type, number] = parts;
    if ((type === "pull-requests" || type === "issues") && /^\d+$/.test(number))
      return { provider: "bitbucket", ref: `#${number}`, fallback: `${workspace}/${repo}` };
  }
  const dash = parts.indexOf("-");
  if (host.includes("gitlab") && dash > 0) {
    const [type, number] = parts.slice(dash + 1);
    const project = parts.slice(0, dash).join("/");
    if (type === "merge_requests" && /^\d+$/.test(number ?? ""))
      return { provider: "gitlab", ref: `!${number}`, fallback: project };
    if (type === "issues" && /^\d+$/.test(number ?? ""))
      return { provider: "gitlab", ref: `#${number}`, fallback: project };
  }
  if (host === "linear.app") {
    const issue = parts.indexOf("issue");
    const key = issue >= 0 ? parts[issue + 1] : undefined;
    if (key && /^[A-Z][A-Z0-9]*-\d+$/i.test(key)) {
      const slug = parts[issue + 2];
      return { provider: "linear", ref: key.toUpperCase(), fallback: slug ? slug.replace(/-/g, " ") : key.toUpperCase() };
    }
  }
  if (host.endsWith(".atlassian.net") || host.includes("jira")) {
    const browse = parts.indexOf("browse");
    const key = (browse >= 0 ? parts[browse + 1] : undefined) ?? url.searchParams.get("selectedIssue") ?? undefined;
    if (key && /^[A-Z][A-Z0-9]*-\d+$/i.test(key))
      return { provider: "jira", ref: key.toUpperCase(), fallback: host };
  }
  return web;
}
function displayTitle(link) {
  return link.title || describe(link.url).fallback;
}

import { Rpc } from "@opencode/plugin/rpc";
var object = { type: "object" };
var links = { type: "array", items: object };
var LinksRpc = Rpc.define({
  id: "pinned-links",
  methods: {
    list: {
      input: {
        type: "object",
        properties: { sessionIDs: { type: "array", items: { type: "string" } } },
        required: ["sessionIDs"]
      },
      output: { type: "object", properties: { links }, required: ["links"] }
    },
    add: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, url: { type: "string" }, title: { type: "string" } },
        required: ["sessionID", "url"]
      },
      output: { type: "object", properties: { link: object, created: { type: "boolean" } }, required: ["link", "created"] }
    },
    rename: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, id: { type: "string" }, title: { type: "string" } },
        required: ["sessionID", "id", "title"]
      },
      output: { type: "object", properties: { link: object } }
    },
    remove: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, ids: { type: "array", items: { type: "string" } } },
        required: ["sessionID", "ids"]
      },
      output: { type: "object", properties: { removed: links }, required: ["removed"] }
    }
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          action: { type: "string", enum: ["added", "updated", "removed"] },
          title: { type: "string" },
          byAgent: { type: "boolean" }
        },
        required: ["sessionID", "action"]
      }
    }
  }
});

import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";
var SAFE_ID = /^\w[\w.-]*$/;
function expandHome(file) {
  return file === "~" || file.startsWith("~/") || file.startsWith("~\\") ? path.join(os.homedir(), file.slice(1)) : file;
}
function resolveRoot(dir) {
  if (typeof dir === "string" && dir.trim())
    return path.resolve(os.homedir(), expandHome(dir.trim()));
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(data, "opencode", "pinned-links");
}
function newID() {
  return `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

class Store {
  root;
  locks = new Map;
  constructor(root) {
    this.root = root;
  }
  file(sessionID) {
    if (typeof sessionID !== "string" || !SAFE_ID.test(sessionID))
      throw new Error("invalid session ID");
    return path.join(this.root, `${sessionID}.json`);
  }
  exclusive(sessionID, task) {
    const run = (this.locks.get(sessionID) ?? Promise.resolve()).then(task, task);
    const tail = run.catch(() => {});
    this.locks.set(sessionID, tail);
    tail.then(() => this.locks.get(sessionID) === tail && this.locks.delete(sessionID));
    return run;
  }
  async read(sessionID) {
    try {
      const data = JSON.parse(await readFile(this.file(sessionID), "utf8"));
      return Array.isArray(data.links) ? data.links : [];
    } catch {
      return [];
    }
  }
  async write(sessionID, links) {
    const file = this.file(sessionID);
    if (!links.length)
      return rm(file, { force: true });
    await mkdir(this.root, { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, JSON.stringify({ links }, null, 2));
    await rename(temp, file);
  }
  async list(sessionIDs) {
    const lists = await Promise.all([...new Set(sessionIDs)].map((id) => this.read(id)));
    return lists.flat().sort((a, b) => b.createdAt - a.createdAt);
  }
  async add(input) {
    const url = checkUrl(input.url);
    const title = cleanTitle(input.title);
    return this.exclusive(input.sessionID, async () => {
      const links = await this.read(input.sessionID);
      const index = links.findIndex((link) => link.url === url);
      if (index >= 0) {
        const link = { ...links[index], title: title || links[index].title };
        links[index] = link;
        await this.write(input.sessionID, links);
        return { link, created: false };
      }
      const link = { id: newID(), sessionID: input.sessionID, url, title, createdAt: Date.now() };
      await this.write(input.sessionID, [...links, link]);
      return { link, created: true };
    });
  }
  rename(input) {
    return this.exclusive(input.sessionID, async () => {
      const links = await this.read(input.sessionID);
      const index = links.findIndex((link) => link.id === input.id);
      if (index < 0)
        return;
      const link = { ...links[index], title: cleanTitle(input.title) };
      links[index] = link;
      await this.write(input.sessionID, links);
      return link;
    });
  }
  remove(input) {
    const urls = new Set((input.urls ?? []).flatMap((url) => {
      try {
        return [checkUrl(url)];
      } catch {
        return [url];
      }
    }));
    const ids = new Set(input.ids ?? []);
    return this.exclusive(input.sessionID, async () => {
      const links = await this.read(input.sessionID);
      const removed = links.filter((link) => ids.has(link.id) || urls.has(link.url));
      if (removed.length)
        await this.write(input.sessionID, links.filter((link) => !removed.includes(link)));
      return removed;
    });
  }
  clear(sessionID) {
    return this.exclusive(sessionID, async () => {
      const links = await this.read(sessionID);
      await this.write(sessionID, []);
      return links;
    });
  }
}

var REMINDER = [
  "When you open a pull request or merge request, or start work on a Linear, Jira or GitHub issue, pin its URL with",
  "links_pin so the user can open it from the session sidebar. Pin other links the user will want again too, such as",
  "deployments or preview URLs."
].join(" ");
var MAX_DEPTH = 16;
function line(link) {
  const info = describe(link.url);
  return `- ${link.id}: ${info.provider === "web" ? "" : info.ref + " "}${displayTitle(link)} <${link.url}>`;
}
var src_default = Plugin.define({
  id: "pinned-links",
  async setup(ctx) {
    const store = new Store(resolveRoot(ctx.options.dir));
    const rootOf = async (sessionID) => {
      let current = sessionID;
      for (let depth = 0;depth < MAX_DEPTH; depth++) {
        const parent = await ctx.session.get({ sessionID: current }).then((session) => session.parentID ?? undefined).catch(() => {
          return;
        });
        if (!parent)
          break;
        current = parent;
      }
      return current;
    };
    const rpc = await ctx.rpc.register(LinksRpc, {
      list: async (input) => {
        const { sessionIDs } = input;
        return { links: await store.list(sessionIDs) };
      },
      add: async (input) => {
        const { sessionID, url, title } = input;
        const result = await store.add({ sessionID, url, title });
        await changed({ sessionID, action: result.created ? "added" : "updated" });
        return result;
      },
      rename: async (input) => {
        const { sessionID, id, title } = input;
        const link = await store.rename({ sessionID, id, title });
        if (link)
          await changed({ sessionID, action: "updated" });
        return link ? { link } : {};
      },
      remove: async (input) => {
        const { sessionID, ids } = input;
        const removed = await store.remove({ sessionID, ids });
        if (removed.length)
          await changed({ sessionID, action: "removed" });
        return { removed };
      }
    });
    const changed = (event) => rpc.events.emit("changed", { ...event });
    await ctx.tool.transform((editor) => {
      editor.namespace({ name: "links", description: "Links pinned to the session sidebar in the TUI" });
      editor.add({
        name: "pin",
        description: [
          "Pin a URL to the sidebar of this session, where the user opens it in the browser with one click.",
          "Use it for pull requests and merge requests you open (GitHub, Bitbucket, GitLab), Linear, Jira and",
          "GitHub issues you work on, and other pages the user will want again, such as deployments.",
          "Pinning a URL that is already pinned updates its title. Only http and https URLs."
        ].join(" "),
        input: {
          type: "object",
          properties: {
            url: { type: "string", description: "The full http(s) URL" },
            title: {
              type: "string",
              description: "Short label, such as the pull request or issue title. Leave it out to show the repository or page."
            }
          },
          required: ["url"],
          additionalProperties: false
        },
        options: { namespace: "links" },
        execute: async (input, context) => {
          const { url, title } = input;
          const sessionID = await rootOf(context.sessionID);
          const { link, created } = await store.add({ sessionID, url, title });
          await changed({ sessionID, action: created ? "added" : "updated", title: displayTitle(link), byAgent: created });
          return {
            content: `${created ? "Pinned" : "Already pinned; updated"} ${line(link).slice(2)}. The user sees it in the sidebar and in /links.`,
            metadata: { linkID: link.id }
          };
        }
      });
      editor.add({
        name: "unpin",
        description: "Remove pinned links from this session's sidebar by link ID or URL.",
        input: {
          type: "object",
          properties: {
            ids: { type: "array", items: { type: "string" }, description: "Link IDs from links_list" },
            urls: { type: "array", items: { type: "string" } }
          },
          additionalProperties: false
        },
        options: { namespace: "links" },
        execute: async (input, context) => {
          const { ids, urls } = input;
          const sessionID = await rootOf(context.sessionID);
          const removed = await store.remove({ sessionID, ids, urls });
          if (!removed.length)
            return { content: "No pinned link matched. Use links_list to see the pinned links." };
          await changed({ sessionID, action: "removed" });
          return { content: `Unpinned:
${removed.map(line).join(`
`)}` };
        }
      });
      editor.add({
        name: "list",
        description: "List the links pinned to this session's sidebar.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { namespace: "links" },
        execute: async (_input, context) => {
          const links = await store.list([await rootOf(context.sessionID)]);
          return { content: links.length ? links.map(line).join(`
`) : "No links are pinned in this session." };
        }
      });
    });
    if (ctx.options.remind !== false)
      await ctx.session.hook("context", (event) => {
        event.system.push({ type: "text", text: REMINDER });
      });
  }
});
export {
  src_default as default
};
