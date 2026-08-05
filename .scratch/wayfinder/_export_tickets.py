import re, glob, json

tickets = []
for f in sorted(glob.glob(".scratch/wayfinder/tickets/*.md")):
    txt = open(f, encoding="utf-8").read()
    title = txt.split("\n")[0].replace("# ", "").strip()
    # extract yaml frontmatter
    ym = re.search(r"```yaml\n(.*?)```", txt, re.DOTALL)
    meta = {}
    if ym:
        for line in ym.group(1).strip().split("\n"):
            if ":" in line:
                k, v = line.split(":", 1)
                meta[k.strip()] = v.strip().strip('"').strip("'")
    body = re.sub(r"```yaml\n.*?```", "", txt, flags=re.DOTALL).strip()
    # strip leading "# Txx — " heading from body since it's the title
    body = re.sub(r"^# .+\n+", "", body, flags=re.MULTILINE).strip()
    tickets.append(
        {
            "file": f,
            "title": title,
            "body": body,
            "id": meta.get("id", ""),
            "type": meta.get("type", "grilling"),
            "blocked_by": meta.get("blocked-by", "[]"),
        }
    )

json.dump(
    tickets,
    open(".scratch/wayfinder/_tickets_export.json", "w", encoding="utf-8"),
    indent=2,
)
for t in tickets:
    print(
        f"{t['id']:25s} {t['title']:40s} type={t['type']:10s} blocked={t['blocked_by']}"
    )
