import type { Plugin } from "@opencode-ai/plugin"

const REVIEW_MARKER = "Reviewed-by: opencode-review-subagent"
const REVIEW_NOTES_REF = "reviews"
const SERVICE = "review-note-plugin"

export type LogLevel = "info" | "warn" | "error"

function log(client: unknown, level: LogLevel, message: string): void {
  const c = client as { app?: { log?: (input: { body: { service: string; level: LogLevel; message: string } }) => void } }
  void c?.app?.log?.({
    body: { service: SERVICE, level, message },
  })
}

/** Extract a PR number (#NNN or explicit PR NNN target selector) from a string. */
export function extractPrNumber(text: string): string | null {
  const match = text.match(/#(\d+)/) || text.trim().match(/^(?:review\s+)?PR\s+(\d+)\b/i)
  return match ? match[1] : null
}

/** Extract a bare 7–40 char hex SHA from a string, rejecting #-prefixed hex (PR refs) and PR-prefixed decimals. */
export function extractSha(text: string): string | null {
  const regex = /(?<!#)\b([0-9a-f]{7,40})\b/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const before = text.slice(0, match.index).trimEnd()
    if (!/pr[\W_]*$/i.test(before)) return match[1]
  }
  return null
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
    const prompt = (args.prompt ?? "").trim()
    if (!prompt.startsWith("Input:")) return false
    const afterInput = prompt.slice("Input:".length).trim()
    if (!afterInput) return true
    if (afterInput.includes("\n")) return false
    if (afterInput.length > 100) return false
    if (/^(?:review\s+)?(?:commit\s+)?[0-9a-f]{7,40}$/i.test(afterInput)) return true
    if (/^(?:review\s+)?(?:PR\s+)?#\d+$/i.test(afterInput)) return true
    if (/^(?:review\s+)?PR\s+\d+$/i.test(afterInput)) return true
    if (/^review\s+branch\s+[\w\-.\\/]+$/i.test(afterInput)) return true
    return false
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

  if (/^review\s+branch\s+/i.test(trimmed) && target.length <= 100 && /^[\w\-.\\/]+$/.test(target)) return true

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

export async function resolveTargetShaFromArgs(
  args: { description?: string; prompt?: string; command?: string },
  deps: ResolverDeps,
): Promise<{ sha: string | null; source: string }> {
  const description = args.description ?? ""
  const prompt = args.prompt ?? ""
  const command = args.command ?? ""

  const tryResolve = async (text: string): Promise<{ sha: string | null; source: string } | null> => {
    const hexSha = extractSha(text)
    if (hexSha) {
      const result = await deps.revParse(hexSha)
      if (result.exitCode === 0) {
        return { sha: result.stdout.trim() || null, source: `sha:${hexSha}` }
      }
      deps.log("warn", `rev-parse failed for SHA ${hexSha} (exit ${result.exitCode})`)
    }

    const prNum = extractPrNumber(text)
    if (prNum) {
      const result = await deps.prView(prNum)
      if (result.exitCode === 0) {
        try {
          const json = JSON.parse(result.stdout)
          if (json.headRefOid) {
            return { sha: json.headRefOid, source: `PR #${prNum}` }
          }
          deps.log("warn", `PR #${prNum} returned null headRefOid`)
        } catch {
          deps.log("warn", `Failed to parse gh pr view output for PR #${prNum}`)
        }
      } else {
        deps.log("warn", `gh pr view failed for PR #${prNum} (exit ${result.exitCode})`)
      }
    }

    return null
  }

  const isTargetSelector = (text: string): boolean => {
    const trimmed = text.trim()
    if (!trimmed) return false
    if (/^(?:review\s+)?(?:commit\s+)?[0-9a-f]{7,40}$/i.test(trimmed)) return true
    if (/^(?:review\s+)?(?:PR\s+)?#\d+$/i.test(trimmed)) return true
    if (/^(?:review\s+)?PR\s+\d+$/i.test(trimmed)) return true
    if (/^review\s+branch\s+[\w\-.\\/]+$/i.test(trimmed)) return true
    return false
  }

  if (prompt && isTargetSelector(prompt)) {
    const result = await tryResolve(prompt)
    if (result) return result
  }

  if (command === "review" && prompt.startsWith("Input:")) {
    const target = prompt.slice("Input:".length).trim()
    if (target) {
      const result = await tryResolve(target)
      if (result) return result
    }
  }

  if (description && isTargetSelector(description)) {
    const result = await tryResolve(description)
    if (result) return result
  }

  const combined = `${description} ${prompt} ${command}`
  const combinedSha = extractSha(combined)
  if (combinedSha) {
    const result = await deps.revParse(combinedSha)
    if (result.exitCode === 0) {
      return { sha: result.stdout.trim() || null, source: `sha:${combinedSha}` }
    }
  }

  const combinedPr = extractPrNumber(combined)
  if (combinedPr) {
    const result = await deps.prView(combinedPr)
    if (result.exitCode === 0) {
      try {
        const json = JSON.parse(result.stdout)
        if (json.headRefOid) {
          return { sha: json.headRefOid, source: `PR #${combinedPr}` }
        }
      } catch {}
    }
  }

  deps.log("info", "Falling back to HEAD")
  const result = await deps.revParse("HEAD")
  if (result.exitCode === 0) {
    return { sha: result.stdout.trim() || null, source: "HEAD" }
  }

  return { sha: null, source: "" }
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
        const { sha, source } = await resolveTargetShaFromArgs(args, deps)

        if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
          log(client, "warn", `Could not resolve a valid SHA (source=${source}, sha=${sha ?? "null"})`)
          return
        }

        const hasIssues = /CRITICAL|WARNING/i.test(reviewText)
        const status = hasIssues ? "failed" : "passed"
        const note = `${REVIEW_MARKER}\nReview-Status: ${status}\n\n${reviewText}`

        await $`git notes --ref=${REVIEW_NOTES_REF} add -f -m ${note} ${sha}`.quiet()
        log(client, "info", `Attached review note (${status}) to ${sha.slice(0, 7)} (source=${source})`)
      } catch (error) {
        log(client, "error", `Failed to attach review note: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}) satisfies Plugin
