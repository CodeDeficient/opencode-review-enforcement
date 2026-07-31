#!/bin/bash
# Review Note Enforcement — append this block to your .husky/pre-push
# or source it from your existing pre-push hook.
#
# Requires: a .review-baseline file containing the SHA of the oldest
# commit that should be exempt from review enforcement.
#
# Blocks pushes when any commit in the push range lacks a git note
# containing the marker "Reviewed-by: opencode-review-subagent".

# --- REVIEW NOTE ENFORCEMENT ---
echo "🔍 Checking review notes on commits..."
REVIEW_MARKER="Reviewed-by: opencode-review-subagent"
BASELINE=""
if [ -f ".review-baseline" ]; then
  BASELINE=$(cat .review-baseline | tr -d '[:space:]')
fi

UNREVIEWED_SHAS=""
while read local_ref local_sha remote_ref remote_sha; do
  # Skip deletions
  [ "$local_sha" = "0000000000000000000000000000000000000000" ] && continue

  # Determine commit range
  if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
    # New branch: check commits since merge-base with origin/main
    MB=$(git merge-base origin/main "$local_sha" 2>/dev/null || echo "")
    if [ -n "$MB" ]; then
      RANGE="$MB..$local_sha"
    else
      RANGE="$local_sha"
    fi
  else
    RANGE="$remote_sha..$local_sha"
  fi

  for sha in $(git rev-list --no-merges "$RANGE" 2>/dev/null); do
    # Skip commits at or before baseline
    if [ -n "$BASELINE" ] && git merge-base --is-ancestor "$sha" "$BASELINE" 2>/dev/null; then
      continue
    fi

    NOTE=$(git notes --ref=reviews show "$sha" 2>/dev/null || true)
    if [ -z "$NOTE" ] || ! echo "$NOTE" | grep -q "$REVIEW_MARKER"; then
      UNREVIEWED_SHAS="$UNREVIEWED_SHAS $sha"
    fi
  done
done

if [ -n "$UNREVIEWED_SHAS" ]; then
  echo ""
  echo "████████████████████████████████████████████████████████████████████"
  echo "█                                                                  █"
  echo "█  🚨  PUSH BLOCKED: UNREVIEWED COMMITS  🚨                       █"
  echo "█                                                                  █"
  echo "█  The following commits have not been reviewed:                   █"
  for sha in $UNREVIEWED_SHAS; do
    SHORT=$(git log --oneline -1 "$sha" 2>/dev/null || echo "$sha")
    echo "█    $SHORT"
  done
  echo "█                                                                  █"
  echo "█  Every commit must have a review note attached.                  █"
  echo "█  Run /review <sha> for each commit before pushing.              █"
  echo "█                                                                  █"
  echo "█  To mark existing commits as exempt, update .review-baseline     █"
  echo "█  with the SHA of the oldest commit that requires review.         █"
  echo "████████████████████████████████████████████████████████████████████"
  echo ""
  exit 1
fi
echo "✅ All commits have review notes"
