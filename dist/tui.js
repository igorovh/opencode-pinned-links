// @bun
import { createComponent as _$createComponent } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { spawn } from "child_process";
import { Plugin } from "@opencode/plugin/tui";
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";

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

var MAX_SIDEBAR_ITEMS = 10;
var ADD = "\x00add";
var CLEAR = "\x00clear";
var LIST_RETRIES = 40;
var LIST_RETRY_MS = 250;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function isUnavailable(error) {
  if (!error || typeof error !== "object") {
    const text = String(error ?? "").toLowerCase();
    return text.includes("rpc.unavailable") || text.includes("rpc is unavailable");
  }
  const record = error;
  if (record.type === "rpc.unavailable")
    return true;
  const text = String(record.message ?? "").toLowerCase();
  return text.includes("rpc.unavailable") || text.includes("rpc is unavailable");
}
function truncate(value, width) {
  if (width <= 0)
    return "";
  return value.length <= width ? value : value.slice(0, Math.max(0, width - 1)) + "\u2026";
}
function openUrl(url, onError) {
  const target = checkUrl(url);
  const openers = process.platform === "win32" ? ["explorer.exe"] : process.platform === "darwin" ? ["open"] : ["xdg-open", "wslview", "gio"];
  const attempt = (index) => {
    const command = openers[index];
    if (!command)
      return onError(`No program to open ${target}. Install xdg-utils.`);
    spawn(command, command === "gio" ? ["open", target] : [target], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }).on("error", () => attempt(index + 1)).unref();
  };
  attempt(0);
}
function asyncValue(source, load, initial) {
  const [value, setValue] = createSignal(initial);
  let request = 0;
  let disposed = false;
  onCleanup(() => disposed = true);
  createEffect(() => {
    const input = source();
    const id = ++request;
    load(input).then((result) => id === request && !disposed && setValue(() => result), () => {});
  });
  return value;
}
function createUI(context, open = openUrl) {
  const api = context.client.rpc(LinksRpc);
  const theme = () => context.theme;
  const [version, setVersion] = createSignal(0);
  const toast = (message, variant = "info") => context.ui.toast.show({
    title: "Links",
    message,
    variant
  });
  const fail = (error) => {
    const message = error instanceof Error ? error.message : typeof error?.message === "string" ? error.message : String(error);
    toast(message, "error");
  };
  const rootOf = (sessionID) => context.data.session.root(sessionID) || sessionID;
  const familyOf = (sessionID) => {
    const root = rootOf(sessionID);
    return [...new Set([root, sessionID, ...context.data.session.family(root)])];
  };
  const listLinks = async (sessionIDs) => {
    for (let attempt = 0;; attempt++) {
      try {
        return (await api.list({
          sessionIDs
        })).links;
      } catch (error) {
        if (!isUnavailable(error) || attempt >= LIST_RETRIES)
          throw error;
        await sleep(LIST_RETRY_MS);
      }
    }
  };
  const fetchLinks = async (sessionID) => listLinks(familyOf(sessionID));
  const refresh = () => setVersion((value) => value + 1);
  const stopEvents = api.events.on("changed", (event) => {
    refresh();
    const data = event.data;
    if (data.byAgent && data.title)
      context.ui.toast.show({
        title: "Link pinned",
        message: data.title,
        variant: "success",
        sessionID: data.sessionID
      });
  });
  const openLink = (link) => {
    try {
      open(link.url, (message) => toast(message, "error"));
    } catch (error) {
      fail(error);
    }
  };
  const unpin = async (link) => {
    await api.remove({
      sessionID: link.sessionID,
      ids: [link.id]
    });
    refresh();
  };
  const rename = async (link) => {
    const title = await context.ui.dialog.prompt({
      title: "Rename link",
      placeholder: describe(link.url).fallback,
      value: link.title
    });
    if (title === undefined)
      return;
    await api.rename({
      sessionID: link.sessionID,
      id: link.id,
      title
    });
    refresh();
  };
  const copy = (link) => {
    if (context.renderer.copyToClipboardOSC52(link.url))
      toast("Copied the URL");
    else
      toast("This terminal does not support copying (OSC 52)", "warning");
  };
  const add = async (sessionID, input) => {
    let text = input?.trim();
    if (!text) {
      text = (await context.ui.dialog.prompt({
        title: "Pin a link",
        placeholder: "https://\u2026 [title]"
      }))?.trim();
      if (!text)
        return;
    }
    const [url = "", ...rest] = text.split(/\s+/);
    let href;
    try {
      href = checkUrl(url);
    } catch (error) {
      return fail(error);
    }
    const {
      created
    } = await api.add({
      sessionID: rootOf(sessionID),
      url: href,
      title: rest.join(" ") || undefined
    });
    refresh();
    toast(created ? "Link pinned" : "Already pinned; title updated", "success");
  };
  const label = (link) => {
    const info = describe(link.url);
    return info.provider === "web" ? displayTitle(link) : `${info.ref} ${displayTitle(link)}`;
  };
  const openMenu = async (link, back) => {
    const action = await context.ui.dialog.select({
      title: truncate(label(link), 60),
      options: [{
        title: "Open in browser",
        value: "open",
        description: link.url
      }, {
        title: "Copy URL",
        value: "copy"
      }, {
        title: "Rename\u2026",
        value: "rename"
      }, {
        title: "Unpin",
        value: "unpin"
      }]
    });
    if (action === "open")
      openLink(link);
    if (action === "copy")
      copy(link);
    if (action === "rename")
      await rename(link);
    if (action === "unpin")
      await unpin(link);
    if (action === undefined || action === "unpin" || action === "rename")
      await back?.();
  };
  const openList = async (sessionID) => {
    const links = await fetchLinks(sessionID);
    const reopen = () => setTimeout(() => void openList(sessionID).catch(fail));
    const selected = await context.ui.dialog.select({
      title: "Pinned links",
      placeholder: "Search links",
      options: [...links.map((link) => ({
        title: label(link),
        value: link.id,
        description: link.url,
        category: "Links"
      })), {
        title: "Pin a link\u2026",
        value: ADD,
        category: "Actions"
      }, ...links.length ? [{
        title: "Unpin all",
        value: CLEAR,
        category: "Actions"
      }] : []],
      actions: [{
        bind: "ctrl+o",
        title: "Open",
        onTrigger: (id) => {
          const link = links.find((item) => item.id === id);
          if (link)
            openLink(link);
        }
      }, {
        bind: "ctrl+d",
        title: "Unpin",
        onTrigger: (id) => {
          const link = links.find((item) => item.id === id);
          if (!link)
            return;
          context.ui.dialog.clear();
          unpin(link).then(reopen, fail);
        }
      }]
    });
    if (selected === ADD)
      return add(sessionID);
    if (selected === CLEAR) {
      const confirmed = await context.ui.dialog.confirm({
        title: "Unpin all links",
        message: `Remove ${links.length} ${links.length === 1 ? "link" : "links"} from this session?`,
        label: {
          confirm: "Unpin all",
          cancel: "Cancel"
        }
      });
      if (!confirmed)
        return openList(sessionID);
      const bySession = Map.groupBy(links, (link) => link.sessionID);
      await Promise.all([...bySession].map(([id, items]) => api.remove({
        sessionID: id,
        ids: items.map((link) => link.id)
      })));
      refresh();
      return toast("Unpinned all links");
    }
    const link = links.find((item) => item.id === selected);
    if (link)
      await openMenu(link, () => openList(sessionID));
  };
  const currentSession = () => {
    const route = context.ui.router.current();
    return route.type === "session" ? route.sessionID : undefined;
  };
  const inSession = (run) => {
    const sessionID = currentSession();
    if (!sessionID)
      return toast("Open a session first", "warning");
    run(sessionID).catch(fail);
  };
  const runLinks = () => inSession(openList);
  const runPin = (input) => inSession((sessionID) => add(sessionID, input));
  function LinkRow(props) {
    const [hovered, setHovered] = createSignal(false);
    const [crossHovered, setCrossHovered] = createSignal(false);
    const info = () => describe(props.link.url);
    const ref = () => info().provider === "web" ? "\u2197" : info().ref;
    const title = () => truncate(displayTitle(props.link), props.width - ref().length - 3);
    return (() => {
      var _el$ = _$createElement("box"), _el$2 = _$createElement("text"), _el$3 = _$createElement("text"), _el$4 = _$createElement("box"), _el$5 = _$createElement("box"), _el$6 = _$createElement("text");
      _$insertNode(_el$, _el$2);
      _$insertNode(_el$, _el$3);
      _$insertNode(_el$, _el$4);
      _$insertNode(_el$, _el$5);
      _$setProp(_el$, "flexDirection", "row");
      _$setProp(_el$, "height", 1);
      _$setProp(_el$, "flexShrink", 0);
      _$setProp(_el$, "onMouseOver", () => setHovered(true));
      _$setProp(_el$, "onMouseOut", () => setHovered(false));
      _$setProp(_el$, "onMouseUp", (event) => {
        event.stopPropagation();
        if (event.button === 0)
          openLink(props.link);
        else if (event.button === 1)
          unpin(props.link).catch(fail);
        else if (event.button === 2)
          openMenu(props.link).catch(fail);
      });
      _$setProp(_el$2, "selectable", false);
      _$insert(_el$2, () => ref() + " ");
      _$setProp(_el$3, "selectable", false);
      _$insert(_el$3, title);
      _$setProp(_el$4, "flexGrow", 1);
      _$insertNode(_el$5, _el$6);
      _$setProp(_el$5, "width", 2);
      _$setProp(_el$5, "flexShrink", 0);
      _$setProp(_el$5, "onMouseOver", () => setCrossHovered(true));
      _$setProp(_el$5, "onMouseOut", () => setCrossHovered(false));
      _$setProp(_el$5, "onMouseUp", (event) => {
        event.stopPropagation();
        if (event.button === 0 && hovered())
          unpin(props.link).catch(fail);
      });
      _$setProp(_el$6, "selectable", false);
      _$insert(_el$6, () => hovered() ? " \u2715" : "  ");
      _$effect((_p$) => {
        var _v$ = hovered() ? theme().background.raised.high : undefined, _v$2 = info().provider === "web" ? theme().text.muted : theme().hue.accent[200], _v$3 = theme().text.base, _v$4 = crossHovered() ? theme().text.feedback.error.base : theme().text.muted;
        _v$ !== _p$.e && (_p$.e = _$setProp(_el$, "backgroundColor", _v$, _p$.e));
        _v$2 !== _p$.t && (_p$.t = _$setProp(_el$2, "fg", _v$2, _p$.t));
        _v$3 !== _p$.a && (_p$.a = _$setProp(_el$3, "fg", _v$3, _p$.a));
        _v$4 !== _p$.o && (_p$.o = _$setProp(_el$6, "fg", _v$4, _p$.o));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined,
        o: undefined
      });
      return _el$;
    })();
  }
  function Sidebar(props) {
    const sessionIDs = createMemo(() => familyOf(props.sessionID), [], {
      equals: (a, b) => a.join() === b.join()
    });
    const links = asyncValue(() => ({
      ids: sessionIDs(),
      version: version()
    }), async ({
      ids
    }) => listLinks(ids), []);
    const [width, setWidth] = createSignal(30);
    const list = () => void openList(props.sessionID).catch(fail);
    return _$createComponent(Show, {
      get when() {
        return links().length > 0;
      },
      get children() {
        var _el$7 = _$createElement("box"), _el$8 = _$createElement("box"), _el$9 = _$createElement("text"), _el$0 = _$createElement("b"), _el$10 = _$createElement("box"), _el$11 = _$createElement("text");
        _$insertNode(_el$7, _el$8);
        _$setProp(_el$7, "flexDirection", "column");
        _$setProp(_el$7, "flexShrink", 0);
        _$setProp(_el$7, "onSizeChange", function() {
          setWidth(this.width);
        });
        _$insertNode(_el$8, _el$9);
        _$insertNode(_el$8, _el$10);
        _$insertNode(_el$8, _el$11);
        _$setProp(_el$8, "flexDirection", "row");
        _$setProp(_el$8, "flexShrink", 0);
        _$setProp(_el$8, "onMouseUp", list);
        _$insertNode(_el$9, _el$0);
        _$insertNode(_el$0, _$createTextNode(`Links`));
        _$setProp(_el$10, "flexGrow", 1);
        _$insert(_el$11, () => String(links().length));
        _$insert(_el$7, _$createComponent(For, {
          get each() {
            return links().slice(0, MAX_SIDEBAR_ITEMS);
          },
          children: (link) => _$createComponent(LinkRow, {
            link,
            get width() {
              return width();
            }
          })
        }), null);
        _$insert(_el$7, _$createComponent(Show, {
          get when() {
            return links().length > MAX_SIDEBAR_ITEMS;
          },
          get children() {
            var _el$12 = _$createElement("box"), _el$13 = _$createElement("text");
            _$insertNode(_el$12, _el$13);
            _$setProp(_el$12, "height", 1);
            _$setProp(_el$12, "flexShrink", 0);
            _$setProp(_el$12, "onMouseUp", list);
            _$insert(_el$13, () => `\u2026 ${links().length - MAX_SIDEBAR_ITEMS} more (/links)`);
            _$effect((_$p) => _$setProp(_el$13, "fg", theme().text.muted, _$p));
            return _el$12;
          }
        }), null);
        _$effect((_p$) => {
          var _v$5 = theme().text.base, _v$6 = theme().text.muted;
          _v$5 !== _p$.e && (_p$.e = _$setProp(_el$9, "fg", _v$5, _p$.e));
          _v$6 !== _p$.t && (_p$.t = _$setProp(_el$11, "fg", _v$6, _p$.t));
          return _p$;
        }, {
          e: undefined,
          t: undefined
        });
        return _el$7;
      }
    });
  }
  return {
    Sidebar,
    runLinks,
    runPin,
    stopEvents
  };
}
var tui_default = Plugin.define({
  id: "pinned-links.tui",
  setup(context) {
    const ui = createUI(context);
    const stopSidebar = context.ui.slot({
      append: "sidebar.content",
      render: (input) => _$createComponent(ui.Sidebar, {
        get sessionID() {
          return input.sessionID;
        }
      })
    });
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "pinned-links.list",
        title: "Pinned links",
        group: "Links",
        palette: true,
        slash: {
          name: "links"
        },
        run: ui.runLinks
      }, {
        id: "pinned-links.pin",
        title: "Pin a link",
        group: "Links",
        palette: true,
        slash: {
          name: "pin",
          arguments: true
        },
        run: ui.runPin
      }]
    }));
    return () => {
      ui.stopEvents();
      stopSidebar();
    };
  }
});
export {
  createUI,
  tui_default as default,
  isUnavailable,
  openUrl
};
