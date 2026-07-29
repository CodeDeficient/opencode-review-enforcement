import type { Plugin } from "@opencode-ai/plugin"

const REVIEW_MARKER = "Reviewed-by: opencode-review-subagent"
const SERVICE = "review-note-plugin"

export type LogLevel = "info" | "warn" | "error"

function log(client: unknown, level: LogLevel, message: string): void {
  const c = client as { app?: { log?: (input: { body: { service: string; level: LogLevel; message: string } }) => void } }
  void c?.app?.log?.({
    body: { service: SERVICE, level, message },
  })
}

/** Extract a PR number (#NNN or PR NNN) from a string. */
export function extractPrNumber(text: string): string | null {
  const match = text.match(/#(\d+)/) || text.match(/(?:^|\s)PR\s+(\d+)\b/i)
  return match ? match[1] : null
}

/** Extract a bare 7–40 char hex SHA from a string, rejecting #-prefixed hex (PR refs). */
export function extractSha(text: string): string | null {
  const match = text.match(/(?<!#)\b([0-9a-f]{7,40})\b/i)
  return match ? match[1] : null
}

export function isReviewTask(args: { command?: string; subagent_type?: string }): boolean {
  return args.command === "review" || args.command?.startsWith("review ") === true || args.subagent_type === "reviewer"
}

export function isCanonicalReviewInvocation(args: {
  command?: string
  subagent_type?: string
  prompt?: string
}): boolean {
  if (args.command === "review" || args.command?.startsWith("review ") === true) {
    return true
  }

  if (args.subagent_type !== "reviewer") {
    return false
  }

  return isTargetOnlyPrompt(args.prompt ?? "")
}

function isTargetOnlyPrompt(prompt: string): boolean {
  const trimmed = prompt.trim()
  if (!trimmed) return false
  if (trimmed.includes("\n")) return false

  const target = stripTargetSelectorPrefix(trimmed)
  if (!target) return false

  if (/^[0-9a-f]{7,40}$/i.test(target)) return true

  if (/^(PR\s+)?#\d+$/i.test(target)) return true
  if (/^PR\s+\d+$/i.test(target)) return true

  if (/^\d+$/.test(target)) return false

  if (target.length <= 100 && /^[\w\-.\\/]+$/.test(target)) return true

  return false
}

function stripTargetSelectorPrefix(text: string): string {
  const lower = text.toLowerCase()
  const prefixes = ["review commit ", "review branch ", "review "]
  for (const prefix of prefixes) {
    if (lower.startsWith(prefix)) {
      return text.slice(prefix.length).trim()
    }
  }
  return text
}

export type RunResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export interface ResolverDeps {
  revParse(ref: string): Promise<RunResult>
  prView(prNum: string): Promise<RunResult>
  log(level: LogLevel, message: string): void
}

export async function resolveTargetSha(
  searchText: string,
  deps: ResolverDeps,
): Promise<{ sha: string | null; source: string }> {
  let sha: string | null = null
  let source = ""

  const hexSha = extractSha(searchText)
  if (hexSha) {
    deps.log("info", `Found SHA ${hexSha}, resolving to full hash`)
    const result = await deps.revParse(hexSha)
    if (result.exitCode === 0) {
      sha = result.stdout.trim() || null
      source = `sha:${hexSha}`
    } else {
      deps.log("warn", `git rev-parse failed for ${hexSha} (exit ${result.exitCode}), falling through`)
    }
  }

  if (!sha) {
    const prNum = extractPrNumber(searchText)
    if (prNum) {
      deps.log("info", `Found PR #${prNum}, resolving headRefOid`)
      const result = await deps.prView(prNum)
      if (result.exitCode === 0) {
        try {
          const json = JSON.parse(result.stdout)
          sha = json.headRefOid ?? null
          source = `PR #${prNum}`
        } catch {
          deps.log("warn", `Failed to parse gh pr view output for PR #${prNum}, falling through to HEAD`)
        }
      } else {
        deps.log("warn", `gh pr view failed for PR #${prNum} (exit ${result.exitCode}), falling through to HEAD`)
      }
    }
  }

  if (!sha) {
    deps.log("info", "Falling back to HEAD")
    const result = await deps.revParse("HEAD")
    if (result.exitCode === 0) {
      sha = result.stdout.trim() || null
      source = "HEAD"
    } else {
      deps.log("warn", `git rev-parse HEAD failed (exit ${result.exitCode})`)
    }
  }

  return { sha, source }
}

export default (async ({ $, client }) => {
  return {
    "tool.execute.after": async (input: any, output: any) => {
      if (input?.tool !== "task") return

      const args = (input.args ?? {}) as {
        prompt?: string
        description?: string
        command?: string
        subagent_type?: string
      }

      if (!isCanonicalReviewInvocation(args)) {
        log(client, "info", "Skipped review note for non-canonical reviewer invocation")
        return
      }

      const reviewText = output?.output ?? ""
      const description = args.description ?? ""
      const prompt = args.prompt ?? ""
      const command = args.command ?? ""
      const searchText = `${description} ${prompt} ${command}`

      const deps: ResolverDeps = {
        revParse: async (ref) => {
          const result = await $`git rev-parse ${ref}`.nothrow().quiet()
          return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode ?? 1 }
        },
        prView: async (prNum) => {
          const result = await $`gh pr view ${prNum} --json headRefOid`.nothrow().quiet()
          return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode ?? 1 }
        },
        log: (level, message) => log(client, level, message),
      }

      try {
        const { sha, source } = await resolveTargetSha(searchText, deps)

        if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
          log(client, "warn", `Could not resolve a valid SHA (source=${source}, sha=${sha ?? "null"})`)
          return
        }

        const hasIssues = /CRITICAL|WARNING/i.test(reviewText)
        const status = hasIssues ? "failed" : "passed"
        const note = `${REVIEW_MARKER}\nReview-Status: ${status}\n\n${reviewText}`

        await $`git notes add -f -m ${note} ${sha}`.quiet()
        log(client, "info", `Attached review note (${status}) to ${sha.slice(0, 7)} (source=${source})`)
      } catch (error) {
        log(client, "error", `Failed to attach review note: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}) satisfies Plugin
