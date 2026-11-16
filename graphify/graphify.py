#!/usr/bin/env python3
"""Graphify - lokalna aplikacja budująca graf powiązań z plików w folderze.

Użycie:
    python3 graphify.py                 # skanuje ./vault
    python3 graphify.py ścieżka/do/folderu
    python3 graphify.py --port 8765 --no-browser

Wszystko (notatki, układ grafu, cache) leży w folderze aplikacji. Zero zależności.
"""
import argparse, json, os, re, sys, threading, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

APP_DIR = Path(__file__).resolve().parent
STATIC = APP_DIR / "static"
DATA = APP_DIR / "data"
TEXT_EXT = {".md", ".txt", ".rst", ".py", ".js", ".ts", ".jsx", ".tsx", ".html", ".css", ".json"}
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".idea", ".vscode"}
MAX_SIZE = 1_000_000

WIKI = re.compile(r"\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]")
MDLINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)\)")
TAG = re.compile(r"(?<![\w/&])#([A-Za-z0-9_À-ɏ-]{2,})")
PY_IMPORT = re.compile(r"^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w., ]+))", re.M)
JS_IMPORT = re.compile(r"""(?:from\s+|require\(\s*|import\s*\(\s*|import\s+)['"](\.{1,2}/[^'"]+)['"]""")


def read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def scan(root: Path) -> dict:
    files = []
    for dp, dns, fns in os.walk(root):
        dns[:] = sorted(d for d in dns if d not in SKIP_DIRS and not d.startswith("."))
        for fn in sorted(fns):
            p = Path(dp) / fn
            if p.suffix.lower() in TEXT_EXT and p.stat().st_size <= MAX_SIZE:
                files.append(p)

    rel = {p: p.relative_to(root).as_posix() for p in files}
    by_stem, by_rel = {}, {}
    for p, r in rel.items():
        by_stem.setdefault(p.stem.lower(), []).append(r)
        by_rel[r.lower()] = r

    nodes, edges, seen = {}, set(), set()

    def add_node(i, **kw):
        nodes.setdefault(i, {"id": i, **kw})

    def resolve_path(src_rel, target):
        base = Path(src_rel).parent
        cand = os.path.normpath((base / target).as_posix()).replace("\\", "/")
        cand = cand.split("#")[0]
        for c in (cand, cand + ".md", cand + ".js", cand + ".ts", cand + ".py", cand + "/index.js"):
            if c.lower() in by_rel:
                return by_rel[c.lower()]
        return None

    for p in files:
        r = rel[p]
        parts = r.split("/")
        add_node(r, label=p.stem, kind="file", ext=p.suffix.lower().lstrip("."),
                 group=parts[0] if len(parts) > 1 else "(root)", words=0)
    for p in files:
        r, text, ext = rel[p], read(p), p.suffix.lower()
        nodes[r]["words"] = len(text.split())

        def link(dst, kind):
            if dst and dst != r and (r, dst, kind) not in seen:
                seen.add((r, dst, kind)); edges.add((r, dst, kind))

        if ext in (".md", ".txt", ".rst"):
            for m in WIKI.finditer(text):
                name = m.group(1).strip()
                hit = resolve_path(r, name) or (by_stem.get(Path(name).stem.lower()) or [None])[0]
                if hit:
                    link(hit, "link")
                else:
                    gid = "?" + name.lower()
                    add_node(gid, label=name, kind="ghost", group="(brak pliku)")
                    link(gid, "link")
            for m in MDLINK.finditer(text):
                t = m.group(1)
                if "://" not in t and not t.startswith("mailto:"):
                    link(resolve_path(r, t), "link")
            for m in TAG.finditer(text):
                tid = "#" + m.group(1).lower()
                add_node(tid, label="#" + m.group(1).lower(), kind="tag", group="(tagi)")
                link(tid, "tag")
        elif ext == ".py":
            for m in PY_IMPORT.finditer(text):
                for mod in re.split(r"[,\s]+", (m.group(1) or m.group(2) or "").strip()):
                    if mod:
                        hit = (by_stem.get(mod.split(".")[-1].lower()) or [None])[0]
                        if hit and hit.endswith(".py"):
                            link(hit, "import")
        elif ext in (".js", ".ts", ".jsx", ".tsx"):
            for m in JS_IMPORT.finditer(text):
                link(resolve_path(r, m.group(1)), "import")
        elif ext == ".html":
            for m in re.finditer(r"""(?:href|src)=["']([^"':#]+)""", text):
                link(resolve_path(r, m.group(1)), "link")

    deg = {}
    for a, b, _ in edges:
        deg[a] = deg.get(a, 0) + 1
        deg[b] = deg.get(b, 0) + 1
    for i, n in nodes.items():
        n["degree"] = deg.get(i, 0)
    return {"root": str(root), "nodes": list(nodes.values()),
            "edges": [{"source": a, "target": b, "kind": k} for a, b, k in sorted(edges)]}


def make_handler(root: Path):
    root = root.resolve()

    def safe(rel):
        p = (root / rel).resolve()
        if root != p and root not in p.parents:
            raise PermissionError
        return p

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a): pass

        def send(self, code, body, ctype="application/json"):
            if not isinstance(body, bytes):
                body = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype != "application/octet-stream" else ""))
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            try:
                if u.path == "/api/graph":
                    return self.send(200, scan(root))
                if u.path == "/api/file":
                    p = safe(q["path"][0])
                    return self.send(200, {"path": q["path"][0], "content": read(p)})
                if u.path == "/api/layout":
                    f = DATA / "layout.json"
                    return self.send(200, json.loads(f.read_text()) if f.exists() else {})
                name = "index.html" if u.path == "/" else u.path.lstrip("/")
                f = (STATIC / name).resolve()
                if STATIC not in f.parents or not f.is_file():
                    return self.send(404, {"error": "not found"})
                ct = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}.get(f.suffix, "application/octet-stream")
                return self.send(200, f.read_bytes(), ct)
            except PermissionError:
                self.send(403, {"error": "forbidden"})
            except Exception as e:
                self.send(400, {"error": str(e)})

        def do_POST(self):
            u = urlparse(self.path)
            try:
                data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                if u.path == "/api/layout":
                    DATA.mkdir(exist_ok=True)
                    (DATA / "layout.json").write_text(json.dumps(data))
                    return self.send(200, {"ok": True})
                if u.path == "/api/note":
                    title = re.sub(r'[\\/:*?"<>|]', "", data.get("title", "").strip())[:80]
                    if not title:
                        return self.send(400, {"error": "brak tytułu"})
                    p = safe(title + ".md")
                    if not p.exists():
                        p.write_text(data.get("content") or f"# {title}\n\n", encoding="utf-8")
                    return self.send(200, {"path": p.relative_to(root).as_posix()})
                if u.path == "/api/save":
                    p = safe(data["path"])
                    if p.suffix.lower() not in TEXT_EXT:
                        raise PermissionError
                    p.write_text(data["content"], encoding="utf-8")
                    return self.send(200, {"ok": True})
                self.send(404, {"error": "not found"})
            except PermissionError:
                self.send(403, {"error": "forbidden"})
            except Exception as e:
                self.send(400, {"error": str(e)})
    return H


def main():
    ap = argparse.ArgumentParser(description="Graphify - graf z folderu")
    ap.add_argument("folder", nargs="?", default=str(APP_DIR / "vault"))
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    root = Path(a.folder).expanduser()
    if not root.is_dir():
        sys.exit(f"Nie ma folderu: {root}")
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(root))
    url = f"http://127.0.0.1:{a.port}"
    print(f"Graphify: {root.resolve()}\n  -> {url}  (Ctrl+C kończy)")
    if not a.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
