import json, subprocess, os

created = json.load(open(".scratch/wayfinder/_created_issues.json", encoding="utf-8"))


def gh_graphql(q):
    return subprocess.run(
        ["gh", "api", "graphql", "-f", "query=" + q],
        capture_output=True,
        text=True,
        cwd=os.getcwd(),
    )


# resolve node ids for all issues
for k, v in created.items():
    if "nodeId" in v:
        continue
    r = gh_graphql(
        'query { repository(owner:"AhmedAlSaeed", name:"tie-payments") { issue(number:%d) { id } } }'
        % v["number"]
    )
    if r.returncode != 0:
        print("ERR resolve", k, r.stderr)
        continue
    data = json.loads(r.stdout[r.stdout.find("{") :])
    v["nodeId"] = data["data"]["repository"]["issue"]["id"]

json.dump(
    created,
    open(".scratch/wayfinder/_created_issues.json", "w", encoding="utf-8"),
    indent=2,
)
print({k: v.get("nodeId", "ERR")[:8] for k, v in created.items()})
