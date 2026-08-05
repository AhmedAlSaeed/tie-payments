import json, subprocess, re, os

tickets = json.load(open(".scratch/wayfinder/_tickets_export.json", encoding="utf-8"))
created = {}
errors = []

for t in tickets:
    title = t["title"]
    body = t["body"] + "\n\n---\nid: " + t["id"]
    label = "wayfinder:" + t["type"]
    r = subprocess.run(
        ["gh", "issue", "create", "--label", label, "--title", title, "--body", body],
        capture_output=True,
        text=True,
        cwd=os.getcwd(),
    )
    if r.returncode != 0:
        errors.append((t["id"], r.stderr.strip()))
        continue
    url = r.stdout.strip()
    num = int(url.rstrip("/").split("/")[-1])
    created[t["id"]] = {"number": num, "url": url}

json.dump(
    created,
    open(".scratch/wayfinder/_created_issues.json", "w", encoding="utf-8"),
    indent=2,
)
for k, v in created.items():
    print(f"{k:25s} #{v['number']} {v['url']}")
if errors:
    print("ERRORS:")
    for e in errors:
        print(e)
