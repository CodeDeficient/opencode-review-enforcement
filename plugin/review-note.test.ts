import { describe, it, expect } from "bun:test"
import { extractSha, extractPrNumber, isReviewTask, resolveTargetSha, type ResolverDeps, type RunResult } from "./review-note"

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
})

describe("isReviewTask", () => {
  it("returns true when command is exactly 'review'", () => {
    expect(isReviewTask({ command: "review" })).toBe(true)
  })

  it("returns true when command starts with 'review' and includes extra text", () => {
    expect(isReviewTask({ command: "review 4c2df93" })).toBe(true)
  })

  it("returns true when subagent_type is 'reviewer' without command", () => {
    expect(isReviewTask({ subagent_type: "reviewer" })).toBe(true)
  })

  it("returns true when both command and subagent_type are set", () => {
    expect(isReviewTask({ command: "review 4c2df93", subagent_type: "reviewer" })).toBe(true)
  })

  it("returns false when command is a non-review command", () => {
    expect(isReviewTask({ command: "build" })).toBe(false)
  })

  it("returns false when command starts with review but is not a review command", () => {
    expect(isReviewTask({ command: "reviewer" })).toBe(false)
    expect(isReviewTask({ command: "reviewNotes" })).toBe(false)
  })

  it("returns false for empty args", () => {
    expect(isReviewTask({})).toBe(false)
  })
})

describe("resolveTargetSha", () => {
  it("returns HEAD when no SHA and no PR are present", async () => {
    const deps: ResolverDeps = {
      revParse: async (ref) => ref === "HEAD" ? ok("abc1234") : fail(),
      prView: async () => fail(),
      log: () => {},
    }

    const result = await resolveTargetSha("", deps)

    expect(result.sha).toBe("abc1234")
    expect(result.source).toBe("HEAD")
  })

  it("returns null when all resolvers fail", async () => {
    const deps: ResolverDeps = {
      revParse: async () => fail(),
      prView: async () => fail(),
      log: () => {},
    }

    const result = await resolveTargetSha("", deps)

    expect(result.sha).toBeNull()
    expect(result.source).toBe("")
  })

  it("resolves a PR number and returns headRefOid", async () => {
    const deps: ResolverDeps = {
      revParse: async () => fail(),
      prView: async () => ok(JSON.stringify({ headRefOid: "prsha123" })),
      log: () => {},
    }

    const result = await resolveTargetSha("review #742", deps)

    expect(result.sha).toBe("prsha123")
    expect(result.source).toBe("PR #742")
  })

  it("resolves a valid SHA and does not consult PR resolver", async () => {
    let prViewCalled = false
    const deps: ResolverDeps = {
      revParse: async (ref) => ref === "abc1234" ? ok("fullsha123") : fail(),
      prView: async () => { prViewCalled = true; return fail() },
      log: () => {},
    }

    const result = await resolveTargetSha("review commit abc1234", deps)

    expect(result.sha).toBe("fullsha123")
    expect(result.source).toBe("sha:abc1234")
    expect(prViewCalled).toBe(false)
  })

  it("falls through to PR resolver when SHA matches but rev-parse fails (THE BUG)", async () => {
    const deps: ResolverDeps = {
      revParse: async (ref) => ref === "deadbeef" ? fail(1) : ref === "HEAD" ? ok("headsha") : fail(),
      prView: async () => ok(JSON.stringify({ headRefOid: "prsha789" })),
      log: () => {},
    }

    const result = await resolveTargetSha("review commit deadbeef #742", deps)

    expect(result.sha).toBe("prsha789")
    expect(result.source).toBe("PR #742")
  })

  it("falls through to PR resolver when 7+ digit PR number is not mistaken for SHA", async () => {
    const deps: ResolverDeps = {
      revParse: async (ref) => ref === "HEAD" ? ok("headsha") : fail(),
      prView: async () => ok(JSON.stringify({ headRefOid: "pr_long" })),
      log: () => {},
    }

    const result = await resolveTargetSha("review #1234567", deps)

    expect(result.sha).toBe("pr_long")
    expect(result.source).toBe("PR #1234567")
  })

  it("treats bare decimal in prompt as SHA, overriding PR ref", async () => {
    let prViewCalled = false
    const deps: ResolverDeps = {
      revParse: async (ref) => ref === "1234567" ? ok("bare_decimal_sha") : fail(),
      prView: async () => { prViewCalled = true; return ok(JSON.stringify({ headRefOid: "prsha" })) },
      log: () => {},
    }

    const result = await resolveTargetSha("review issue 1234567 and check #742", deps)

    expect(result.sha).toBe("bare_decimal_sha")
    expect(result.source).toBe("sha:1234567")
    expect(prViewCalled).toBe(false)
  })

  it("falls through to HEAD when SHA fails and PR fails", async () => {
    const deps: ResolverDeps = {
      revParse: async (ref) => ref === "HEAD" ? ok("headsha") : fail(),
      prView: async () => fail(),
      log: () => {},
    }

    const result = await resolveTargetSha("review commit deadbeef #742", deps)

    expect(result.sha).toBe("headsha")
    expect(result.source).toBe("HEAD")
  })

  it("falls through to HEAD when PR returns malformed JSON", async () => {
    const deps: ResolverDeps = {
      revParse: async (ref) => ref === "HEAD" ? ok("headsha") : fail(),
      prView: async () => ok("not valid json"),
      log: () => {},
    }

    const result = await resolveTargetSha("#742", deps)

    expect(result.sha).toBe("headsha")
    expect(result.source).toBe("HEAD")
  })

  it("falls through to HEAD when PR returns headRefOid as null", async () => {
    const deps: ResolverDeps = {
      revParse: async (ref) => ref === "HEAD" ? ok("headsha") : fail(),
      prView: async () => ok(JSON.stringify({ headRefOid: null })),
      log: () => {},
    }

    const result = await resolveTargetSha("#742", deps)

    expect(result.sha).toBe("headsha")
    expect(result.source).toBe("HEAD")
  })

  it("returns null when all three resolvers fail", async () => {
    const deps: ResolverDeps = {
      revParse: async () => fail(),
      prView: async () => fail(),
      log: () => {},
    }

    const result = await resolveTargetSha("deadbeef #742", deps)

    expect(result.sha).toBeNull()
    expect(result.source).toBe("")
  })

  it("resolves 'PR 7' without hash via extractPrNumber", async () => {
    const deps: ResolverDeps = {
      revParse: async () => fail(),
      prView: async () => ok(JSON.stringify({ headRefOid: "prsha_nohash" })),
      log: () => {},
    }

    const result = await resolveTargetSha("PR 7", deps)

    expect(result.sha).toBe("prsha_nohash")
    expect(result.source).toBe("PR #7")
  })

  it("resolves 'Review PR 7' without hash via extractPrNumber", async () => {
    const deps: ResolverDeps = {
      revParse: async () => fail(),
      prView: async () => ok(JSON.stringify({ headRefOid: "prsha_review" })),
      log: () => {},
    }

    const result = await resolveTargetSha("Review PR 7", deps)

    expect(result.sha).toBe("prsha_review")
    expect(result.source).toBe("PR #7")
  })

  it("extracts SHA from prompt content in searchText", async () => {
    const deps: ResolverDeps = {
      revParse: async (ref) => ref === "def5678" ? ok("fullpromptsha") : fail(),
      prView: async () => fail(),
      log: () => {},
    }

    const result = await resolveTargetSha("Please carefully review commit def5678 for any issues", deps)

    expect(result.sha).toBe("fullpromptsha")
    expect(result.source).toBe("sha:def5678")
  })
})

describe("isCanonicalReviewInvocation", () => {
  it("returns true for /review command (no args)", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ command: "review" })).toBe(true)
  })

  it("returns true for /review <sha> command path", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ command: "review abc1234" })).toBe(true)
  })

  it("returns true for /review <pr> command path", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ command: "review #7" })).toBe(true)
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

  it("returns true for reviewer subtask with branch-name prompt", () => {
    const { isCanonicalReviewInvocation } = require("./review-note")
    expect(isCanonicalReviewInvocation({ subagent_type: "reviewer", prompt: "deterministic-review-prompt" })).toBe(true)
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
})
