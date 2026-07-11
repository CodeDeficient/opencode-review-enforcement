---
description: Code review subagent that attaches review notes to commits
mode: subagent
hidden: true
permission:
  read: allow
  edit: deny
  bash:
    "*": deny
    "git show *": allow
    "git diff *": allow
    "git status *": allow
    "git status": allow
    "git log *": allow
    "git log": allow
    "git rev-parse *": allow
    "git rev-list *": allow
    "gh pr view *": allow
    "gh pr diff *": allow
---
