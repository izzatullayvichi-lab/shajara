#!/usr/bin/env python3
"""Build a read-only GitHub Pages site from the public family-tree seed."""
import json
import pathlib
import shutil
import subprocess
import sys

root = pathlib.Path(__file__).parent
subprocess.run([sys.executable, str(root / "build.py")], check=True, cwd=root)

dist = root / "dist"
dist.mkdir(exist_ok=True)
shutil.copytree(root / "public", dist, dirs_exist_ok=True)

index = dist / "index.html"
html = index.read_text(encoding="utf-8")
html = html.replace('<script src="/sj-adapter.js"></script>',
                    '<script src="./sj-static-adapter.js"></script>')
html = html.replace('href="/fonts/', 'href="./fonts/')
html = html.replace('url("/fonts/', 'url("./fonts/')
html = html.replace('url("/img/', 'url("./img/')
html = html.replace('fetch("/fonts/', 'fetch("./fonts/')
index.write_text(html, encoding="utf-8")

shutil.copy2(root / "public" / "sj-static-adapter.js", dist / "sj-static-adapter.js")
seed_source = (root / "lib" / "seed.js").read_text(encoding="utf-8")
seed_module = root / ".pages-seed.mjs"
try:
    seed_module.write_text(seed_source, encoding="utf-8")
    script = (
        "import seed from './.pages-seed.mjs';"
        "import { writeFile } from 'node:fs/promises';"
        "const data = {app:'shajara',version:2,meta:seed.meta,people:seed.people};"
        "await writeFile(process.argv[1], JSON.stringify(data,null,2)+'\\n','utf8');"
    )
    subprocess.run(["node", "--input-type=module", "-e", script,
                    str(dist / "shajara-data.json")], check=True, cwd=root)
finally:
    seed_module.unlink(missing_ok=True)

(dist / ".nojekyll").write_text("", encoding="utf-8")
print("GitHub Pages site built in dist/")
