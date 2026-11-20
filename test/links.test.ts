import { expect, test } from "bun:test"
import { checkUrl, cleanTitle, describe as info, displayTitle } from "../src/links"

test.each([
  ["https://github.com/acme/web/pull/482", { provider: "github", ref: "#482", fallback: "acme/web" }],
  ["https://github.com/acme/web/pull/482/files", { provider: "github", ref: "#482", fallback: "acme/web" }],
  ["https://github.com/acme/web/issues/7", { provider: "github", ref: "#7", fallback: "acme/web" }],
  ["https://bitbucket.org/team/api/pull-requests/31/overview", { provider: "bitbucket", ref: "#31", fallback: "team/api" }],
  ["https://gitlab.com/group/sub/app/-/merge_requests/12", { provider: "gitlab", ref: "!12", fallback: "group/sub/app" }],
  ["https://gitlab.example.com/ops/infra/-/issues/9", { provider: "gitlab", ref: "#9", fallback: "ops/infra" }],
  ["https://linear.app/acme/issue/ENG-123/dark-mode-toggle", { provider: "linear", ref: "ENG-123", fallback: "dark mode toggle" }],
  ["https://acme.atlassian.net/browse/OPS-42", { provider: "jira", ref: "OPS-42", fallback: "acme.atlassian.net" }],
  ["https://www.example.com/", { provider: "web", ref: "example.com", fallback: "example.com" }],
  ["https://github.com/acme/web", { provider: "web", ref: "github.com", fallback: "github.com/acme/web" }],
])("describe %s", (url, expected) => {
  expect(info(url)).toEqual(expected as ReturnType<typeof info>)
})

test("only http and https URLs pass, so a click never runs a local program", () => {
  expect(checkUrl("  https://example.com/a?b=1&c=2 ")).toBe("https://example.com/a?b=1&c=2")
  expect(() => checkUrl("file:///C:/Windows/System32/calc.exe")).toThrow("Only http and https")
  expect(() => checkUrl("javascript:alert(1)")).toThrow("Only http and https")
  expect(() => checkUrl("C:\\Windows\\notepad.exe")).toThrow()
  expect(() => checkUrl("example.com")).toThrow("Not a valid URL")
  expect(() => checkUrl("")).toThrow("empty")
})

test("titles collapse whitespace and fall back to the repository", () => {
  expect(cleanTitle("  Fix\n login   redirect ")).toBe("Fix login redirect")
  expect(cleanTitle("x".repeat(300))).toHaveLength(200)
  expect(displayTitle({ url: "https://github.com/acme/web/pull/1", title: "" })).toBe("acme/web")
})
