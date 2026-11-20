export type Provider = "github" | "bitbucket" | "gitlab" | "linear" | "jira" | "web"

export interface Link {
  readonly id: string
  readonly sessionID: string
  readonly url: string
  readonly title: string
  readonly createdAt: number
}

export interface LinkInfo {
  readonly provider: Provider
  /** Short reference such as `#482`, `!12` or `ENG-123`; the host name for other links. */
  readonly ref: string
  /** Shown when the link has no title, such as `owner/repo`. */
  readonly fallback: string
}

export const MAX_URL = 2048
export const MAX_TITLE = 200

/** Returns the normalized URL, or throws a message the agent or the user can act on. */
export function checkUrl(input: unknown) {
  const raw = typeof input === "string" ? input.trim() : ""
  if (!raw) throw new Error("The URL is empty")
  if (raw.length > MAX_URL) throw new Error(`The URL is longer than ${MAX_URL} characters`)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Not a valid URL: ${raw}`)
  }
  // Opening a file: or custom-scheme URL would run a local program, so only web links are pinned.
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Only http and https links can be pinned, not ${url.protocol}`)
  return url.href
}

export function cleanTitle(input: unknown) {
  const title = typeof input === "string" ? input.replace(/\s+/g, " ").trim() : ""
  return title.length > MAX_TITLE ? title.slice(0, MAX_TITLE - 1) + "…" : title
}

/** Recognizes pull requests, merge requests and issues, so the sidebar can show `#482` instead of the URL. */
export function describe(href: string): LinkInfo {
  const url = new URL(href)
  const host = url.hostname.replace(/^www\./, "")
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
  const web: LinkInfo = { provider: "web", ref: host, fallback: url.pathname === "/" ? host : host + url.pathname }

  if (host === "github.com" && parts.length >= 4) {
    const [owner, repo, type, number] = parts
    if ((type === "pull" || type === "issues") && /^\d+$/.test(number!))
      return { provider: "github", ref: `#${number}`, fallback: `${owner}/${repo}` }
  }
  if (host === "bitbucket.org" && parts.length >= 4) {
    const [workspace, repo, type, number] = parts
    if ((type === "pull-requests" || type === "issues") && /^\d+$/.test(number!))
      return { provider: "bitbucket", ref: `#${number}`, fallback: `${workspace}/${repo}` }
  }
  // GitLab paths nest groups, so the type sits after a `-` segment: group/sub/repo/-/merge_requests/12.
  const dash = parts.indexOf("-")
  if (host.includes("gitlab") && dash > 0) {
    const [type, number] = parts.slice(dash + 1)
    const project = parts.slice(0, dash).join("/")
    if (type === "merge_requests" && /^\d+$/.test(number ?? "")) return { provider: "gitlab", ref: `!${number}`, fallback: project }
    if (type === "issues" && /^\d+$/.test(number ?? "")) return { provider: "gitlab", ref: `#${number}`, fallback: project }
  }
  if (host === "linear.app") {
    const issue = parts.indexOf("issue")
    const key = issue >= 0 ? parts[issue + 1] : undefined
    if (key && /^[A-Z][A-Z0-9]*-\d+$/i.test(key)) {
      const slug = parts[issue + 2]
      return { provider: "linear", ref: key.toUpperCase(), fallback: slug ? slug.replace(/-/g, " ") : key.toUpperCase() }
    }
  }
  if (host.endsWith(".atlassian.net") || host.includes("jira")) {
    const browse = parts.indexOf("browse")
    const key = (browse >= 0 ? parts[browse + 1] : undefined) ?? url.searchParams.get("selectedIssue") ?? undefined
    if (key && /^[A-Z][A-Z0-9]*-\d+$/i.test(key)) return { provider: "jira", ref: key.toUpperCase(), fallback: host }
  }
  return web
}

export function displayTitle(link: Pick<Link, "url" | "title">) {
  return link.title || describe(link.url).fallback
}
