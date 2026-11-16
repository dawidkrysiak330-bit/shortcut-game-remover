"""Router AI (w stylu OmniRoute), skille (SKILL.md) i czat z kontekstem grafu.
Tylko stdlib. Konfiguracja: data/providers.json (lokalnie, klucze nie opuszczają folderu)."""
import json, os, re, time, urllib.request, urllib.error
from pathlib import Path

APP = Path(__file__).resolve().parent
DATA, SKILLS = APP / "data", APP / "skills"
CFG, LOG = DATA / "providers.json", DATA / "router.log.jsonl"
DEFAULT = {
    "providers": {
        "ollama": {"base_url": "http://127.0.0.1:11434/v1", "api_key": "", "api_key_env": ""},
        "openai": {"base_url": "https://api.openai.com/v1", "api_key": "", "api_key_env": "OPENAI_API_KEY"},
        "openrouter": {"base_url": "https://openrouter.ai/api/v1", "api_key": "", "api_key_env": "OPENROUTER_API_KEY"},
    },
    "routes": {
        "default": {"strategy": "fallback", "targets": [
            {"provider": "ollama", "model": "llama3.1"},
            {"provider": "openrouter", "model": "meta-llama/llama-3.1-8b-instruct:free"},
            {"provider": "openai", "model": "gpt-4o-mini"}]}},
}
_rr, _down = {}, {}       # round-robin liczniki, circuit breaker (provider -> do kiedy pauza)
COOLDOWN = 60


def load_cfg():
    if not CFG.exists():
        DATA.mkdir(exist_ok=True)
        CFG.write_text(json.dumps(DEFAULT, indent=2))
        try: os.chmod(CFG, 0o600)
        except OSError: pass
    return json.loads(CFG.read_text())


def masked(cfg):
    c = json.loads(json.dumps(cfg))
    for p in c.get("providers", {}).values():
        if p.get("api_key"): p["api_key"] = "***"
    return c


def save_cfg(new):
    old = load_cfg()
    for name, p in new.get("providers", {}).items():
        if p.get("api_key") == "***":
            p["api_key"] = old.get("providers", {}).get(name, {}).get("api_key", "")
    if not isinstance(new.get("routes"), dict) or not isinstance(new.get("providers"), dict):
        raise ValueError("config musi mieć 'providers' i 'routes'")
    CFG.write_text(json.dumps(new, indent=2, ensure_ascii=False))
    try: os.chmod(CFG, 0o600)
    except OSError: pass


def targets_for(cfg, model):
    if model in cfg["routes"]:
        r = cfg["routes"][model]
        t = list(r["targets"])
        if r.get("strategy") == "round_robin" and t:
            i = _rr.get(model, 0) % len(t); _rr[model] = i + 1
            t = t[i:] + t[:i]
        return t
    if "/" in model and model.split("/", 1)[0] in cfg["providers"]:
        p, m = model.split("/", 1)
        return [{"provider": p, "model": m}]
    raise ValueError(f"nieznana trasa/model: {model}")


def call(cfg, tg, body):
    p = cfg["providers"][tg["provider"]]
    key = p.get("api_key") or (os.environ.get(p.get("api_key_env", ""), "") if p.get("api_key_env") else "")
    payload = dict(body, model=tg["model"], stream=False)
    req = urllib.request.Request(p["base_url"].rstrip("/") + "/chat/completions",
                                 json.dumps(payload).encode(), {"Content-Type": "application/json"})
    if key: req.add_header("Authorization", "Bearer " + key)
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def log(**kw):
    DATA.mkdir(exist_ok=True)
    with LOG.open("a") as f: f.write(json.dumps(dict(kw, ts=int(time.time()))) + "\n")


def route_chat(body):
    """Próbuje kolejnych celów trasy; zwraca (odpowiedź, provider, model) albo rzuca RuntimeError."""
    cfg, errs = load_cfg(), []
    for tg in targets_for(cfg, body.get("model") or "default"):
        pn = tg["provider"]
        if _down.get(pn, 0) > time.time():
            errs.append(f"{pn}: pominięty (circuit breaker)"); continue
        t0 = time.time()
        try:
            out = call(cfg, tg, {k: v for k, v in body.items() if k != "model"})
            log(provider=pn, model=tg["model"], ok=True, ms=int((time.time() - t0) * 1000))
            return out, pn, tg["model"]
        except Exception as e:
            _down[pn] = time.time() + COOLDOWN
            msg = f"{pn}/{tg['model']}: {getattr(e, 'code', '')} {str(e)[:150]}"
            errs.append(msg)
            log(provider=pn, model=tg["model"], ok=False, ms=int((time.time() - t0) * 1000), err=msg)
    raise RuntimeError("; ".join(errs) or "brak celów w trasie")


def stats():
    agg = {}
    if LOG.exists():
        for line in LOG.read_text().splitlines()[-500:]:
            try: e = json.loads(line)
            except ValueError: continue
            a = agg.setdefault(e["provider"], {"ok": 0, "fail": 0, "ms": 0})
            a["ok" if e["ok"] else "fail"] += 1
            if e["ok"]: a["ms"] += e["ms"]
    for n, a in agg.items():
        a["avg_ms"] = a["ms"] // a["ok"] if a["ok"] else None; del a["ms"]
        a["paused_s"] = max(0, int(_down.get(n, 0) - time.time()))
    return agg


# ---------- skille ----------
def parse_skill(path):
    text = path.read_text(encoding="utf-8", errors="replace")
    meta, body = {}, text
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", text, re.S)
    if m:
        for line in m.group(1).splitlines():
            if ":" in line:
                k, v = line.split(":", 1); meta[k.strip()] = v.strip().strip("\"'")
        body = m.group(2)
    return {"name": meta.get("name", path.parent.name), "description": meta.get("description", ""),
            "dir": path.parent.name, "body": body.strip()}


def list_skills():
    return sorted((parse_skill(p) for p in SKILLS.glob("*/SKILL.md")), key=lambda s: s["name"]) if SKILLS.is_dir() else []


# ---------- czat ----------
def chat(d, root):
    skills = {s["name"]: s for s in list_skills()}
    sys_parts = ["Jesteś asystentem wbudowanym w Graphify - lokalną aplikację z grafem notatek. Odpowiadaj po polsku, zwięźle."]
    for n in d.get("skills", []):
        if n in skills: sys_parts.append(f"## Skill: {n}\n{skills[n]['body']}")
    ctx = []
    for rel in d.get("notes", [])[:6]:
        p = (root / rel).resolve()
        if root.resolve() in p.parents and p.is_file():
            ctx.append(f"### {rel}\n{p.read_text(encoding='utf-8', errors='replace')[:6000]}")
    if ctx: sys_parts.append("## Notatki z grafu (kontekst)\n" + "\n\n".join(ctx))
    msgs = [{"role": "system", "content": "\n\n".join(sys_parts)}] + [
        {"role": m["role"], "content": m["content"]} for m in d["messages"] if m.get("role") in ("user", "assistant")]
    out, pn, mn = route_chat({"model": d.get("route") or "default", "messages": msgs})
    return {"reply": out["choices"][0]["message"]["content"], "provider": pn, "model": mn}


def handle(method, path, q, data, root):
    """Zwraca (kod, obiekt) albo None gdy ścieżka nie należy do tego modułu."""
    try:
        if method == "GET":
            if path == "/api/skills":
                return 200, [{k: v for k, v in s.items() if k != "body"} for s in list_skills()]
            if path == "/api/router": return 200, {"config": masked(load_cfg()), "stats": stats()}
            if path == "/v1/models":
                return 200, {"object": "list", "data": [{"id": r, "object": "model"} for r in load_cfg()["routes"]]}
        elif method == "POST":
            if path == "/api/router": save_cfg(data); return 200, {"ok": True}
            if path == "/api/chat": return 200, chat(data, root)
            if path == "/v1/chat/completions":
                out, pn, mn = route_chat(data); out["x_graphify_route"] = f"{pn}/{mn}"; return 200, out
    except Exception as e:
        return 502 if isinstance(e, RuntimeError) else 400, {"error": str(e)}
    return None
