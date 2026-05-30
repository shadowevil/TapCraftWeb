import glob, os
os.chdir(os.path.join(os.path.dirname(__file__), "..", "TapCraftWeb", "wwwroot", "js"))
out = []
for f in sorted(glob.glob("*.js")):
    data = open(f, "rb").read()
    bad = [i for i in range(len(data)) if data[i] > 127]
    if bad:
        out.append("%s: %d non-ascii bytes at %s" % (f, len(bad), bad))
        for i in bad[:10]:
            ctx = data[max(0, i - 12):i + 12]
            out.append("   ctx offset %d: %r" % (i, ctx))
print("\n".join(out) if out else "ALL PURE ASCII")
