# patch_hint.py — ヒント語を足し、ヒントを小分け側にも効かせ、モデルを medium にする
#   使い方: python3 patch_hint.py        （~/clinic-app/main.py を書き換え。元は main.py.pre_hint に保存）
#   戻す  : cp main.py.pre_hint main.py
import os, re, shutil, sys
p = os.path.join(os.environ.get("APP", os.path.expanduser("~/clinic-app")), "main.py")
src = open(p, encoding="utf-8").read()
lines = src.split("\n")
bak = p.replace("main.py", "main.py.pre_hint")
if not os.path.exists(bak):
    shutil.copy(p, bak)
ADD = ["咳止め", "点鼻薬", "痛み止め", "鼻汁", "鼻水", "胃潰瘍", "メイアクト", "耳鼻科", "ロキソニン"]
pat = re.compile(r'^(\s*)hint\s*=\s*"(.*)"\s*$')
idx = [i for i, l in enumerate(lines) if pat.match(l)]
done = False
if len(idx) == 1:
    i = idx[0]
    m = pat.match(lines[i])
    old = m.group(2)
    new = (old + " " + " ".join(w for w in ADD if w not in old)).strip()
    lines[i] = None                      # 関数内の hint 行は消し、外側の hint を使う
    j = next((k for k, l in enumerate(lines) if l and l.startswith("import chunk_api")), None)
    if j is None:
        print("NG: chunk_api の行が見つかりません"); sys.exit(1)
    lines.insert(j, 'hint = "%s"' % new)
    done = True
elif len(idx) == 0 and any(l and l.startswith("hint") for l in lines):
    print("INFO: hint は既に外側にあります。語の追加はしません")
else:
    print("NG: hint の行が%d個あり、自動では直せません。中止" % len(idx)); sys.exit(1)
out = "\n".join(l for l in lines if l is not None)
out = out.replace('WhisperModel("small"', 'WhisperModel("medium"')
compile(out, p, "exec")
open(p, "w", encoding="utf-8").write(out)
print("OK: hint_moved=%s medium=%s" % (done, 'WhisperModel("medium"' in out))
print("次を実行: sudo systemctl restart clinic")
