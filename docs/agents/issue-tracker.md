# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in `AhmedAlSaeed/tie-payments`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

## Wayfinding operations

Maps and tickets are GitHub issues in `AhmedAlSaeed/tie-payments`.

- **Create a map**: `gh issue create --label "wayfinder:map" --title "<map title>" --body "<map body>"`.
- **Create a ticket**: `gh issue create --label "wayfinder:<type>" -p <map-number> --title "<ticket title>" --body "..."`
  where `<type>` is one of `research`, `prototype`, `grilling`, `task`. Child relationship is expressed with a `wayfinder:map` parent (GitHub sub-issue) and/or a `Parent:` link in the body.
- **Create blocking edges**: `gh issue edit <ticket-number> --issue-depends-on <blocker-number>` (blocking uses GitHub's native issue-dependency relationship, so the frontier renders visually).
- **Fetch a ticket**: `gh issue view <number> --comments`.
- **List tickets**: `gh issue list --state open --label "wayfinder" --json number,title,labels --jq '...'`.
- **Claim**: `gh issue edit <number> --add-assignee @me` — assignment is the claim; an open unassigned ticket is unclaimed.
- **Resolve**: post a `## Resolution` comment, then `gh issue close <number>`; append a Context-Pointer line to the map issue's `## Decisions so far`.
- **Frontier query**: open, unblocked, unassigned tickets — `gh issue list --state open` filtered by those with no issues depending on them and no assignee.

## When a skill says "publish to the issue tracker"

Create a GitHub issue with the appropriate label.