#!/usr/bin/env python3
"""corral: Corral from an agent's shell. `corral help` lists what it can do; the list comes from
Corral itself, so it is always current. Arguments are `--key value` pairs; anything else is the
message text. Works only inside a Corral turn, which gives it CORRAL_API and CORRAL_TOKEN."""
import json
import os
import sys
import urllib.error
import urllib.request

api, token = os.environ.get("CORRAL_API"), os.environ.get("CORRAL_TOKEN")
if not api or not token:
    sys.exit("corral: run this from a Corral agent's turn")
args = sys.argv[1:]
action = args[0] if args else "help"
body, words, rest = {}, [], args[1:]
i = 0
while i < len(rest):
    arg = rest[i]
    if arg.startswith("--") and len(arg) > 2:
        key, _, value = arg[2:].partition("=")
        if not _:
            if i + 1 < len(rest) and not rest[i + 1].startswith("--"):
                value = rest[i + 1]
                i += 1
            else:
                value = "true"
        body[key.replace("-", "_")] = value
    else:
        words.append(arg)
    i += 1
if words:
    body["text"] = " ".join(words)
helping = action in ("help", "-h", "--help")
request = urllib.request.Request(
    api if helping else f"{api}/{action}",
    data=None if helping else json.dumps(body).encode(),
    headers={"X-Corral-Token": token, "Content-Type": "application/json"},
    method="GET" if helping else "POST",
)
try:
    with urllib.request.urlopen(request, timeout=120) as response:
        print(response.read().decode().rstrip())
except urllib.error.HTTPError as e:
    text = e.read().decode()
    try:
        text = json.loads(text).get("error", text)
    except ValueError:
        pass
    sys.exit(f"corral {action}: {text}")
except urllib.error.URLError as e:
    sys.exit(f"corral: Corral is not reachable ({e.reason})")
