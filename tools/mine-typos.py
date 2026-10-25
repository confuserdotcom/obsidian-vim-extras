#!/usr/bin/env python3
"""Real typo -> fix pairs from a vault's git history (auto-commits keep the typo in one commit
and the fix in a later one). For every changed line pair that differs by exactly one word, the
pair is kept when the old word is in no word list, the new one is, and they are close.

    python3 tools/mine-typos.py ~/Licence fr.txt en.txt > tools/typos.json

Prints [{"typo", "fix", "context"}] (context = the fixed line, to detect its language).
"""
import json, re, subprocess, sys

WORD = re.compile(r"[^\W\d_]+(?:['’-][^\W\d_]+)*")


def words_of(path):
    out = set()
    for line in open(path, encoding="utf-8"):
        w = line.split()
        if w:
            out.add(w[0].lower())
    return out


def lev(a, b):
    d = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        p, d[0] = d[0], i
        for j, y in enumerate(b, 1):
            p, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, p + (x != y))
    return d[-1]



def main():
    vault, *lists = sys.argv[1:]
    known = set().union(*(words_of(p) for p in lists))
    log = subprocess.run(["git", "-C", vault, "log", "-p", "-U0", "--no-color", "--format=@@commit %h", "--", "*.md"],
                         capture_output=True, text=True, errors="replace").stdout
    pairs, seen = [], set()
    minus, plus = [], []

    def flush():
        for old, new in zip(minus, plus):
            a, b = WORD.findall(old), WORD.findall(new)
            if len(a) != len(b) or len(a) < 2:
                continue
            diff = [(x, y) for x, y in zip(a, b) if x != y]
            if not 1 <= len(diff) <= 3:
                continue
            for typo, fix in diff:
                keep(typo, fix, new)
        minus.clear(), plus.clear()

    def keep(typo, fix, new):
        if len(typo) < 3 or typo.lower() in known or fix.lower() not in known:
            return
        if lev(typo.lower(), fix.lower()) > 3 or typo.lower() == fix.lower() or (typo, fix) in seen:
            return
        seen.add((typo, fix))
        pairs.append({"typo": typo, "fix": fix, "context": new.strip()[:200]})

    for line in log.splitlines():
        if line.startswith("-") and not line.startswith("---"):
            if plus:
                flush()
            minus.append(line[1:])
        elif line.startswith("+") and not line.startswith("+++"):
            plus.append(line[1:])
        else:
            flush()
    flush()
    json.dump(pairs, sys.stdout, ensure_ascii=False, indent=1)


main()
