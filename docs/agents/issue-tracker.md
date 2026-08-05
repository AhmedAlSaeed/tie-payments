# Issue tracker: Local Markdown

Issues and PRDs for this repo live as markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The PRD is `.scratch/<feature-slug>/PRD.md`
- Implementation issues are `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`
- Triage state is recorded as a `Status:` line near the top of each issue file (see `triage-labels.md` for the role strings)
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## When a skill says "publish to the issue tracker"

Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed).

## Wayfinding operations

Maps and tickets live under `.scratch/wayfinder/`.

- **Create a map**: write `.scratch/wayfinder/map/map.md`; front-matter carries `label: wayfinder:map` and a stable `id` (e.g. `map-001`).
- **Create a ticket**: write `.scratch/wayfinder/tickets/<NN>-<slug>.md`, numbered from `01`, with front-matter: `id`, `parent: map-<NN>`, `type: research|prototype|grilling|task`, `status: open`, and optional `blocked-by: [<id>, ...]`.
- **Fetch a ticket**: read the file at the path; `id` is the stable reference.
- **List tickets**: read `.scratch/wayfinder/tickets/` directory; parse front-matter for status, type, blocking.
- **Claim**: set `assigned: <dev>` in front-matter.
- **Resolve**: append a `## Resolution` section at the bottom with the answer, then set `status: closed`.
- **Close**: set `status: closed` in front-matter.
- **Blocking** (no native tracker UI): front-matter `blocked-by` list. A ticket is unblocked when every ticket in its `blocked-by` list is `status: closed`.
- **Frontier query**: open, unblocked, unassigned tickets = `status: open`, every `blocked-by` id closed, no `assigned`.
