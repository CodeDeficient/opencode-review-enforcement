import type { Plugin } from "@opencode-ai/plugin"

const REVIEW_MARKER = "Reviewed-by: opencode-review-subagent"
const SERVICE = "review-note-plugin"

type LogLevel = "info" | "warn" | "error"

function log(client: unknown, level: LogLevel, message: string): void {
  const c = client as { app?: { log?: (input: { body: { service: string; level: LogLevel; message: string } }) => void } }
  void c?.app?.log?.({
    body: { service: SERVICE, level, message },
  })
}

/** Extract a PR number (#NNN) from a string. */
function extractPrNumber(text: string): string | null {
  const match = text.match(/#(\d+)/)
  return match ? match[1] : null
}

/** Extract a bare 7–40 char hex SHA from a string. */
function extractSha(text: string): string | null {
  const match = text.match(/\b([0-9a-f]{7,40})\b/i)
  return match ? match[1] : null
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

      const isReview = args.command === "review" || args.subagent_type === "reviewer"
      if (!isReview) return

      const reviewText = output?.output ?? ""
      const description = args.description ?? ""
      const prompt = args.prompt ?? ""
      const searchText = `${description} ${prompt}`

      try {
        let sha: string | null = null
        let source = ""

        const prNum = extractPrNumber(searchText)
        if (prNum) {
          log(client, "info", `Found PR #${prNum} in description, resolving headRefOid`)
          const result = await $`gh pr view ${prNum} --json headRefOid`.quiet()
          const json = JSON.parse(result.stdout.toString())
          sha = json.headRefOid ?? null
          source = `PR #${prNum}`
        }

        if (!sha) {
          const hexSha = extractSha(description)
          if (hexSha) {
            log(client, "info", `Found SHA ${hexSha} in description, resolving to full hash`)
            const result = await $`git rev-parse ${hexSha}`.quiet()
            sha = result.stdout.toString().trim() || null
            source = `description:${hexSha}`
          }
        }

        if (!sha) {
          log(client, "info", "No SHA or PR found in description, falling back to HEAD")
          const result = await $`git rev-parse HEAD`.quiet()
          sha = result.stdout.toString().trim() || null
          source = "HEAD"
        }

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