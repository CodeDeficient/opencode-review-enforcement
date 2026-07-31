import { describe, it, expect } from "bun:test"
import { extractSha, extractPrNumber, resolveTargetShaFromArgs, type ResolverDeps, type RunResult } from "./review-note"

function ok(stdout: string): RunResult {
  return { stdout, stderr: "", exitCode: 0 }
}

function fail(exitCode = 1): RunResult {
  return { stdout: "", stderr: "error", exitCode }
}

describe("extractSha", () => {
  it("returns null for empty string", () => {
    expect(extractSha("")).toBeNull()
  })

  it("returns null when no hex present", () => {
    expect(extractSha("no hex here")).toBeNull()
  })

  it("extracts a 7-char hex SHA", () => {
    expect(extractSha("review commit abc1234")).toBe("abc1234")
  })

  it("extracts a 40-char hex SHA", () => {
    const sha = "a".repeat(40)
    expect(extractSha(`review ${sha}`)).toBe(sha)
  })

  it("returns null for a 6-char hex string (too short)", () => {
    expect(extractSha("abc123")).toBeNull()
  })

  it("returns the first hex SHA when multiple are present", () => {
    expect(extractSha("abc1234 def5678")).toBe("abc1234")
  })

  it("matches hex with mixed case", () => {
    expect(extractSha("AbCdEf1")).toBe("AbCdEf1")
  })

  it("returns null when hex is part of a longer word", () => {
    expect(extractSha("0xabc1234")).toBeNull()
  })

  it("matches hex at start of string", () => {
    expect(extractSha("abc1234 is the sha")).toBe("abc1234")
  })

  it("returns null when hex is preceded by # (PR ref)", () => {
    expect(extractSha("#1234567")).toBeNull()
  })

  it("returns null when hex is preceded by PR (explicit PR ref)", () => {
    expect(extractSha("PR 1234567")).toBeNull()
  })

  it("returns null when hex is preceded by PR in natural prompt", () => {
    expect(extractSha("Review PR 1234567")).toBeNull()
  })

  it("returns null when hex is preceded by pr- (branch name like upgrade-pr-1234567)", () => {
    expect(extractSha("Review branch upgrade-pr-1234567")).toBeNull()
  })

  it("returns null when hex is preceded by pr_ (underscore variant)", () => {
    expect(extractSha("upgrade_pr_1234567")).toBeNull()
  })

  it("returns null when hex is preceded by pr/ (path variant)", () => {
    expect(extractSha("feature/pr/1234567")).toBeNull()
  })

  it("still extracts hex after unrelated word ending in prep (not pr boundary)", () => {
    expect(extractSha("upgrade prep 1234567")).toBe("1234567")
  })
})

describe("extractPrNumber", () => {
  it("returns null for empty string", () => {
    expect(extractPrNumber("")).toBeNull()
  })

  it("returns null when no hash present", () => {
    expect(extractPrNumber("no pr here")).toBeNull()
  })

  it("extracts a PR number", () => {
    expect(extractPrNumber("review #742")).toBe("742")
  })

  it("returns the first PR number when multiple are present", () => {
    expect(extractPrNumber("#742 and #891")).toBe("742")
  })

  it("matches hash at start of string", () => {
    expect(extractPrNumber("#742 is the pr")).toBe("742")
  })

  it("extracts PR number without word boundary before hash", () => {
    expect(extractPrNumber("text#742")).toBe("742")
  })

  it("extracts PR number from 'PR 7' without hash", () => {
    expect(extractPrNumber("PR 7")).toBe("7")
  })

  it("extracts PR number from 'Review PR 7' without hash", () => {
    expect(extractPrNumber("Review PR 7")).toBe("7")
  })

  it("extracts PR number from 'PR #7' with hash", () => {
    expect(extractPrNumber("PR #7")).toBe("7")
  })

  it("returns null for incidental 'PR NNN' in prose (not a target selector)", () => {
    expect(extractPrNumber("Reviewing PR 8 changes")).toBeNull()
  })

  it("returns null for 'PR NNN' preceded by non-review word", () => {
    expect(extractPrNumber("check PR 7")).toBeNull()
  })

  it("returns null for 'PR NNN' in middle of sentence", () => {
    expect(extractPrNumber("Please review PR 8")).toBeNull()
  })
})

describe("resolveTargetShaFromArgs", () => {
  it("resolves PR 7 from prompt when description is generic", async () => {
    const deps: ResolverDeps = {
      revParse: async () => fail(),
      prView: async () => ok(JSON.stringify({ headRefOid: "prsha_from_prompt" })),
      log: () => {},
    }

    const result = await resolveTargetShaFromArgs(
      { description: "code review", prompt: "PR 7", command: "" },
      deps,
    )

    expect(result.sha).toBe("prsha_from_prompt")
    expect(result.source).toBe("PR #7")
  })

  it("resolves #7 from prompt when description is generic", async () => {
    const deps: ResolverDeps = {
      revParse: async () => fail(),
      prView: async () => ok(JSON.stringify({ headRefOid: "prsha_hashprompt" })),
      log: () => {},
    }

    const result = await resolveTargetShaFromArgs(
      { description: "code review", prompt: "#7", command: "" },
      deps,
    )

    expect(result.sha).toBe("prsha_hashprompt")
    expect(result.source).toBe("PR #7")
  })

  it("does not resolve incidental PR 8 in description", async () => {
    let prViewCalled = false
    const deps: ResolverDeps = {
      revParse: async (ref) => ref === "HEAD" ? ok("headsha") : fail(),
      prView: async () => { prViewCalled = true; return ok(JSON.stringify({ headRefOid: "prsha" })) },
      log: () => {},
    }

    const result = await resolveTargetShaFromArgs(
      { description: "Reviewing PR 8 changes", prompt: "", command: "" },
      deps,
    )

    expect(result.sha).toBe("headsha")
    expect(result.source).toBe("HEAD")
    expect(prViewCalled).toBe(false)
  })

  it("resolves SHA from prompt when description is generic", async () => {
    const deps: ResolverDeps = {
      revParse: async (ref) => ref === "abc1234" ? ok("fullsha") : fail(),
      prView: async () => fail(),
      log: () => {},
    }

    const result = await resolveTargetShaFromArgs(
      { description: "code review", prompt: "abc1234", command: "" },
      deps,
    )

    expect(result.sha).toBe("fullsha")
    expect(result.source).toBe("sha:abc1234")
  })

  it("resolves from /review command prompt with Input: prefix", async () => {
    const deps: ResolverDeps = {
      revParse: async () => fail(),
      prView: async () => ok(JSON.stringify({ headRefOid: "prsha_input" })),
      log: () => {},
    }

    const result = await resolveTargetShaFromArgs(
      { description: "", prompt: "Input: #7", command: "review" },
      deps,
    )

    expect(result.sha).toBe("prsha_input")
    expect(result.source).toBe("PR #7")
  })

  it("resolves SHA from description when description is itself a target selector", async () => {
    const deps: ResolverDeps = {
      revParse: async (ref) => ref === "def5678" ? ok("fullsha_desc") : fail(),
      prView: async () => fail(),
      log: () => {},
    }

    const result = await resolveTargetShaFromArgs(
      { description: "review commit def5678", prompt: "", command: "" },
      deps,
    )

    expect(result.sha).toBe("fullsha_desc")
    expect(result.source).toBe("sha:def5678")
  })

  it("falls back to HEAD when no target found in any field", async () => {
    const deps: ResolverDeps = {
      revParse: async (ref) => ref === "HEAD" ? ok("headsha") : fail(),
      prView: async () => fail(),
      log: () => {},
    }

    const result = await resolveTargetShaFromArgs(
      { description: "code review", prompt: "", command: "" },
      deps,
    )

    expect(result.sha).toBe("headsha")
    expect(result.source).toBe("HEAD")
  })

  it("resolves PR 7 from prompt even when description contains incidental PR 8", async () => {
    const deps: ResolverDeps = {
      revParse: async () => fail(),
      prView: async () => ok(JSON.stringify({ headRefOid: "prsha_correct" })),
      log: () => {},
    }

    const result = await resolveTargetShaFromArgs(
      { description: "Reviewing PR 8 changes", prompt: "PR 7", command: "" },
      deps,
    )

    expect(result.sha).toBe("prsha_correct")
    expect(result.source).toBe("PR #7")
  })

  it("resolves review branch <name> to the branch tip", async () => {
    const deps: ResolverDeps = {
      revParse: async (ref) => ref === "fix/something" ? ok("branchsha") : fail(),
      prView: async () => fail(),
      log: () => {},
    }

    const result = await resolveTargetShaFromArgs(
      { description: "", prompt: "review branch fix/something", command: "" },
      deps,
    )

    expect(result.sha).toBe("branchsha")
    expect(result.source).toBe("branch:fix/something")
  })

  it("does not fall back to HEAD when target selector does not resolve", async () => {
    let headCalled = false
    const deps: ResolverDeps = {
      revParse: async (ref) => { if (ref === "HEAD") headCalled = true; return fail() },
      prView: async () => fail(),
      log: () => {},
    }

    const result = await resolveTargetShaFromArgs(
      { description: "", prompt: "review branch nonexistent-branch", command: "" },
      deps,
    )

    expect(result.sha).toBeNull()
    expect(result.source).toBe("")
    expect(headCalled).toBe(false)
  })

  it("does not fall back to HEAD when explicit SHA prompt does not resolve", async () => {
    let headCalled = false
    const deps: ResolverDeps = {
      revParse: async (ref) => { if (ref === "HEAD") headCalled = true; return fail() },
      prView: async () => fail(),
      log: () => {},
    }

    const result = await resolveTargetShaFromArgs(
      { description: "", prompt: "abc1234", command: "" },
      deps,
    )

    expect(result.sha).toBeNull()
    expect(result.source).toBe("")
    expect(headCalled).toBe(false)
  })

  it("accepts command with target argument (review abc1234) in Input: path", async () => {
    const deps: ResolverDeps = {
      revParse: async (ref) => ref === "abc1234" ? ok("fullsha_cmdarg") : fail(),
      prView: async () => fail(),
      log: () => {},
    }

    const result = await resolveTargetShaFromArgs(
      { description: "", prompt: "Input: abc1234", command: "review abc1234" },
      deps,
    )

    expect(result.sha).toBe("fullsha_cmdarg")
    expect(result.source).toBe("sha:abc1234")
  })

  it("falls through to PR resolver when SHA matches but rev-parse fails", async () => {
    const deps: ResolverDeps = {
      revParse: async () => fail(),
      prView: async () => ok(JSON.stringify({ headRefOid: "prsha_fallthrough" })),
      log: () => {},
    }

    const result = await resolveTargetShaFromArgs(
      { description: "", prompt: "deadbeef #742", command: "" },
      deps,
    )

    expect(result.sha).toBe("prsha_fallthrough")
    expect(result.source).toBe("PR #742")
  })
})

describe("isCanonicalReviewInvocation", () => {
  it("returns true for /review command (no args, Input: prompt)", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ command: "review", prompt: "Input:" })).toBe(true)
  })

  it("returns true for /review <sha> command path", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ command: "review abc1234", prompt: "Input: abc1234" })).toBe(true)
  })

  it("returns true for /review <pr> command path", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ command: "review #7", prompt: "Input: #7" })).toBe(true)
  })

  it("returns true for reviewer subtask with SHA-only prompt", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ subagent_type: "reviewer", prompt: "abc1234" })).toBe(true)
  })

  it("returns true for reviewer subtask with PR ref prompt", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ subagent_type: "reviewer", prompt: "PR #7" })).toBe(true)
  })

  it("returns true for reviewer subtask with bare #PR ref", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ subagent_type: "reviewer", prompt: "#7" })).toBe(true)
  })

  it("returns false for bare branch name (must use 'review branch' prefix)", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ subagent_type: "reviewer", prompt: "deterministic-review-prompt" })).toBe(false)
  })

  it("returns true for 'review branch <name>' explicit prefix", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ subagent_type: "reviewer", prompt: "review branch deterministic-review-prompt" })).toBe(true)
  })

  it("returns true for reviewer subtask with full 40-char SHA prompt", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    const sha = "a".repeat(40)
    expect(isCanonicalReviewInvocation({ subagent_type: "reviewer", prompt: sha })).toBe(true)
  })

  it("returns true for 'Review commit <sha>' natural prompt", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ subagent_type: "reviewer", prompt: "Review commit 55f02e9f" })).toBe(true)
  })

  it("returns true for 'Review <sha>' natural prompt", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ subagent_type: "reviewer", prompt: "Review 55f02e9f" })).toBe(true)
  })

  it("returns true for 'Review PR #7' natural prompt", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ subagent_type: "reviewer", prompt: "Review PR #7" })).toBe(true)
  })

  it("returns true for 'Review PR 7' natural prompt (no hash)", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ subagent_type: "reviewer", prompt: "Review PR 7" })).toBe(true)
  })

  it("returns true for 'PR 7' prompt (no hash, no review prefix)", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ subagent_type: "reviewer", prompt: "PR 7" })).toBe(true)
  })

  it("returns false for bare numeric prompt '7' (ambiguous, not a PR ref)", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ subagent_type: "reviewer", prompt: "7" })).toBe(false)
  })

  it("returns false for 'Review 7' (bare numeric, not a PR ref)", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ subagent_type: "reviewer", prompt: "Review 7" })).toBe(false)
  })

  it("returns false for 'Review branch 7' (numeric branch name)", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ subagent_type: "reviewer", prompt: "Review branch 7" })).toBe(false)
  })

  it("returns true for 'Review branch <name>' natural prompt", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ subagent_type: "reviewer", prompt: "Review branch fix/recurring-hours-write-safety" })).toBe(true)
  })

  it("returns false for reviewer subtask with the exact bypass prompt", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    const bypass = "Review commit 66ff8f80 on branch pr1-core-recurring for correctness, security, edge cases, and code quality.\n\nFocus on:\n1. Phase 1: `validateScheduleData` catch-all — does the condition `hasStart || hasEnd || hasCanonicalDay` correctly guard against falling through to `return null`? Any edge case where it might trigger when it shouldn't, or fail to trigger when it should?\n2. Phase 4: Source checks now derive from `proposed_data` fields instead of `update_type`. Is this correct for all confirmation types? What if `updateTypesToCheck` is empty?\n3. Phase 2 & 3: UI and email schedule rendering — any XSS vectors in the email `escapeHtml` usage? Is the schedule section rendered correctly for mixed confirmations?\n4. Any TypeScript issues in test file — `as const` usage, type narrowing with `PostType.MIXED` in the MIXED-with-invalid test?\n5. Test coverage — do the 4 new test cases adequately cover the 'invalid' scope behavior?\n\nReturn:\n- Review status (pass/fail)\n- Any issues found with severity (CRITICAL/WARNING/MEDIUM/LOW)\n- Specific code locations with file path and line numbers"
    expect(isCanonicalReviewInvocation({ subagent_type: "reviewer", prompt: bypass })).toBe(false)
  })

  it("returns false for reviewer subtask with multiline prompt", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ subagent_type: "reviewer", prompt: "abc1234\ncheck edge cases" })).toBe(false)
  })

  it("returns false for reviewer subtask with empty prompt", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ subagent_type: "reviewer", prompt: "" })).toBe(false)
  })

  it("returns false for reviewer subtask with instructional one-liner", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ subagent_type: "reviewer", prompt: "Review commit abc1234 for correctness" })).toBe(false)
  })

  it("returns false for non-review task", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({})).toBe(false)
  })

  it("returns true for /review command with Input: #7 prompt", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ command: "review", prompt: "Input: #7" })).toBe(true)
  })

  it("returns true for /review command with Input: PR 7 prompt", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ command: "review", prompt: "Input: PR 7" })).toBe(true)
  })

  it("returns true for /review command with Input: abc1234 prompt", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ command: "review", prompt: "Input: abc1234" })).toBe(true)
  })

  it("returns true for /review command with Input: alone (no target)", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ command: "review", prompt: "Input:" })).toBe(true)
  })

  it("returns false for spoofed command: review with multiline custom prompt", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({
      command: "review",
      subagent_type: "reviewer",
      prompt: "Review commit abc1234 for correctness, security, and edge cases.\n\nFocus on:\n1. Any edge cases?\n2. Any bugs?",
    })).toBe(false)
  })

  it("returns false for spoofed command: review with one-line instructional prompt", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({
      command: "review",
      subagent_type: "reviewer",
      prompt: "Review commit abc1234 for correctness",
    })).toBe(false)
  })

  it("returns false for spoofed command: review with bare numeric prompt", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({
      command: "review",
      subagent_type: "reviewer",
      prompt: "7",
    })).toBe(false)
  })

  it("returns false for spoofed command: review with empty prompt", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({
      command: "review",
      subagent_type: "reviewer",
      prompt: "",
    })).toBe(false)
  })

  it("returns false for spoofed command: review with incidental prose prompt", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({
      command: "review",
      subagent_type: "reviewer",
      prompt: "Reviewing PR 8 changes",
    })).toBe(false)
  })

  it("returns true for /review command with Input: review branch name", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ command: "review", prompt: "Input: review branch fix/something" })).toBe(true)
  })

  it("returns true for /review command with Input: review commit sha", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ command: "review", prompt: "Input: review commit def5678" })).toBe(true)
  })

  it("returns false for /review command with Input: containing custom prose", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ command: "review", prompt: "Input: Review commit abc1234 for correctness" })).toBe(false)
  })

  it("returns false for /review command with Input: containing multiline prose", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ command: "review", prompt: "Input: abc1234\ncheck edge cases" })).toBe(false)
  })

  it("returns false for /review command with Input: containing long prose", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    const long = "Input: " + "a".repeat(101)
    expect(isCanonicalReviewInvocation({ command: "review", prompt: long })).toBe(false)
  })

  it("returns false for /review command with Input: containing instructional text", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ command: "review", prompt: "Input: Please review commit abc1234 for bugs" })).toBe(false)
  })

  it("returns false for /review command with Input: containing focus areas", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ command: "review", prompt: "Input: abc1234 focus on security" })).toBe(false)
  })
})
