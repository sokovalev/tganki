"""Spread parts of speech evenly through a deck while keeping the order inside each part."""
import json, sys, collections
PIN = 2  # keep the first N cards of the deck where they are (greetings / "I, you")
for path in sys.argv[1:]:
    d = json.load(open(path)); notes = d["notes"]
    head, rest = notes[:PIN], notes[PIN:]
    buckets = collections.defaultdict(list)
    for i, n in enumerate(rest):
        buckets[n["tags"][0] if n["tags"] else "other"].append((i, n))
    total = len(rest); scored = []
    for tag, items in buckets.items():
        k = len(items)
        for j, (i, n) in enumerate(items):
            scored.append(((j + 0.5) / k * total, i, n))   # evenly spaced target slot
    scored.sort(key=lambda t: (t[0], t[1]))
    d["notes"] = head + [n for _, _, n in scored]
    tags = [n["tags"][0] for n in d["notes"]]
    same = sum(1 for a, b in zip(tags, tags[1:]) if a == b) / max(1, len(tags) - 1)
    json.dump(d, open(path, "w"), ensure_ascii=False, indent=2)
    print(f"{path}: adjacent-same={same:.2f}; first 12: " + ", ".join(n["front"] for n in d["notes"][:12]))
