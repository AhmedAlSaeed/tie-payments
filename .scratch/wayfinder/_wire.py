import json, subprocess, os

created = json.load(open(".scratch/wayfinder/_created_issues.json", encoding="utf-8"))


def gh_graphql(q):
    return subprocess.run(
        ["gh", "api", "graphql", "-f", "query=" + q],
        capture_output=True,
        text=True,
        cwd=os.getcwd(),
    )


# add map #1 node
map_node = None
r = gh_graphql(
    'query { repository(owner:"AhmedAlSaeed", name:"tie-payments") { issue(number:1) { id } } }'
)
map_node = json.loads(r.stdout)["data"]["repository"]["issue"]["id"]

# 1. parentage: every ticket -> map (#1)
print("=== PARENT (sub-issues) ===")
for k, v in created.items():
    q = (
        'mutation { addSubIssue(input: {issueId: "%s", subIssueId: "%s"}) { clientMutationId } }'
        % (map_node, v["nodeId"])
    )
    r = gh_graphql(q)
    ok = "errors" not in r.stdout or "data" in r.stdout and '"errors"' not in r.stdout
    ok = '"errors"' not in r.stdout
    print(
        f"parent {k} (#{v['number']}): {'OK' if ok else 'FAIL ' + r.stdout.strip()[:140]}"
    )

# 2. blocking edges
blocking = {
    "gateway-abstraction": ["research-gateways", "research-surrealdb"],
    "invoice-engine": ["research-surrealdb"],
    "subscription-engine": ["invoice-engine"],
    "webhook-engine": ["api-surface"],
    "sandbox": ["gateway-abstraction"],
    "schema-engine": ["research-surrealdb", "api-surface"],
}
print("=== BLOCKING ===")
for ticket, blockers in blocking.items():
    t = created[ticket]["nodeId"]
    for b in blockers:
        bnode = created[b]["nodeId"]
        q = (
            'mutation { addBlockedBy(input: {issueId: "%s", blockingIssueId: "%s"}) { clientMutationId } }'
            % (t, bnode)
        )
        r = gh_graphql(q)
        ok = '"errors"' not in r.stdout
        print(
            f"block {ticket} <- {b}: {'OK' if ok else 'FAIL ' + r.stdout.strip()[:140]}"
        )
