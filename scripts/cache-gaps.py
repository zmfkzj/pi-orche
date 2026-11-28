"""Prompt-cache reuse of consecutive requests by gap, per provider/api/model (all session files, no age cutoff).

Pairs each assistant message with its nearest assistant ANCESTOR on the parentId chain (forks are handled; file order is not used).
Pairs are skipped when a compaction / branch summary / model change lies between them (prefix changed by design), when either
message ended in error/aborted, or when usage is missing. gap = difference of the two assistant message timestamps (minutes).
Outcome of the second request relative to the first request's prompt P = input+cacheRead+cacheWrite:
  hit: cacheRead >= 0.5 P; zero: cacheRead == 0; low: 0 < cacheRead < 0.05 P; partial: otherwise.
Usage: python3 cache_gaps.py [model-substring ...]  (default: gemini). GAPS_LIST=1 lists every pair with gap >= 30 min.
"""
import collections, glob, json, os, sys

pats = sys.argv[1:] or ["gemini"]
files = glob.glob(os.path.expanduser("~/.pi/agent/sessions") + "/**/*.jsonl", recursive=True)
files += glob.glob(os.path.expanduser("~/.pi/agent/orche") + "/**/*.jsonl", recursive=True)
edges = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 18, 20, 25, 30, 35, 40, 45, 50, 55, 60, 70, 80, 90, 105, 120, 150, 180, 240, 10**9]
BREAK = {"compaction", "branch_summary", "model_change"}
stats = collections.defaultdict(collections.Counter)
pairs = collections.defaultdict(list)
skipped = collections.Counter()
seen_ids = set()
for f in files:
    entries = {}
    order = []
    try:
        for l in open(f):
            try:
                e = json.loads(l)
            except Exception:
                continue
            if "id" in e:
                entries[e["id"]] = e
                order.append(e["id"])
    except Exception:
        continue
    for eid in order:
        e = entries[eid]
        if e.get("type") != "message":
            continue
        m = e.get("message") or {}
        if m.get("role") != "assistant" or not any(p in str(m.get("model") or "") for p in pats):
            continue
        key = (os.path.basename(f), eid)
        if key in seen_ids:
            continue
        seen_ids.add(key)
        # nearest assistant ancestor
        broke = False
        tool_names = []
        pid = e.get("parentId")
        prev = None
        while pid and pid in entries:
            a = entries[pid]
            if a.get("type") in BREAK:
                broke = True
            if a.get("type") == "message" and (a.get("message") or {}).get("role") == "assistant":
                prev = a
                break
            pid = a.get("parentId")
        if not prev:
            continue
        pm = prev["message"]
        tool_names = [c.get("name") for c in pm.get("content", []) if isinstance(c, dict) and c.get("type") == "toolCall"]
        ident = (m.get("provider"), m.get("api"), m.get("model"))
        if (pm.get("provider"), pm.get("api"), pm.get("model")) != ident:
            skipped["model differs"] += 1
            continue
        if broke:
            skipped["compaction/branch/model change between"] += 1
            continue
        if m.get("stopReason") in ("error", "aborted") or pm.get("stopReason") in ("error", "aborted"):
            skipped["error/aborted"] += 1
            continue
        u, pu = m.get("usage") or {}, pm.get("usage") or {}
        P = (pu.get("input") or 0) + (pu.get("cacheRead") or 0) + (pu.get("cacheWrite") or 0)
        if not u or P < 4096:
            skipped["no usage or prompt < 4096"] += 1
            continue
        if not m.get("timestamp") or not pm.get("timestamp"):
            continue
        gap = (m["timestamp"] - pm["timestamp"]) / 60000
        cr = u.get("cacheRead") or 0
        kind = "hit" if cr >= 0.5 * P else "zero" if cr == 0 else "low" if cr < 0.05 * P else "partial"
        b = next(i for i, (lo, hi) in enumerate(zip(edges, edges[1:])) if lo <= gap < hi)
        stats[(ident, b)][kind] += 1
        pairs[ident].append((gap, kind, P, cr, "orche" if any(n and n.startswith("orche_task") for n in tool_names) else "", os.path.basename(f)[:24]))
for ident in sorted({k[0] for k in stats}, key=str):
    print(f"\n== {ident}")
    for i, (lo, hi) in enumerate(zip(edges, edges[1:])):
        c = stats.get((ident, i))
        if not c:
            continue
        n = sum(c.values())
        print(f"  {lo:>3}-{hi if hi < 10**9 else 'inf':>3}m n={n:5d} hit={c['hit']:5d} ({c['hit']/n:6.1%}) partial={c['partial']:3d} low={c['low']:3d} zero={c['zero']:4d}")
    ps = pairs[ident]
    hits = [p for p in ps if p[1] == "hit"]
    misses = [p for p in ps if p[1] in ("zero", "low")]
    print(f"  pairs={len(ps)} longest hit gap={max((p[0] for p in hits), default=0):.1f}m  shortest miss gap={min((p[0] for p in misses), default=0):.2f}m")
    longs = sorted(p for p in ps if p[0] >= 30)
    print(f"  gaps >= 30m: {len(longs)} (hit {sum(p[1]=='hit' for p in longs)}, after orche_task {sum(p[4]=='orche' for p in longs)})")
    if os.environ.get("GAPS_LIST"):
        for p in longs:
            print(f"    {p[0]:7.1f}m {p[1]:7s} P={p[2]:7d} cr={p[3]:7d} {p[4]:5s} {p[5]}")
print("\nskipped:", dict(skipped))
