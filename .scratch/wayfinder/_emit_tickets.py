import json, base64, sys

tickets = json.load(open(".scratch/wayfinder/_tickets_export.json", encoding="utf-8"))
for t in tickets:
    payload = json.dumps(
        {
            "title": t["title"],
            "body": t["body"],
            "id": t["id"],
            "type": t["type"],
            "blocked_by": t["blocked_by"],
        }
    )
    b64 = base64.b64encode(payload.encode()).decode()
    print(t["id"] + "\t" + t["type"] + "\t" + b64)
