"""hstats 网页端 —— 只读 HTTP 服务。

只做一件事：把 hstats 数据层的结果以 JSON 交给网页。**不写任何数据**，
不依赖 Hermes Desktop 与 gateway，绑127.0.0.1。

    .venv/bin/python -m hstats.web            # 起服务
    .venv/bin/python -m hstats.web --port 8130

安全边界：只绑 127.0.0.1，不开 CORS（浏览器同源访问即可）。
这是本机个人用的统计页，不是对外服务；一旦需要局域网访问，
必须先加鉴权，不能直接把端口放出去。
"""

from __future__ import annotations

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import core, cost

_WEB_DIR = Path(__file__).resolve().parent / "web"

# USD→CNY 汇率。缓存 12h，接口不可达时沿用旧值并标stale；
# 完全没有缓存时返回 None——页面据此显示「—」，绝不猜一个常数冒充真实汇率。
_FX_TTL = 12 * 3600
_FX_SOURCES = (
    ("ECB", "https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY"),
    ("exchangerate-api", "https://open.er-api.com/v6/latest/USD"),
)
_fx_mem: dict = {"at": 0.0, "payload": None}


def _fx() -> dict:
    now = time.time()
    if _fx_mem["payload"] and now - _fx_mem["at"] < _FX_TTL:
        return _fx_mem["payload"]
    import json as _json
    import urllib.request

    for source, url in _FX_SOURCES:
        try:
            with urllib.request.urlopen(url, timeout=8) as r:
                data = _json.loads(r.read().decode("utf-8"))
            if source == "ECB":
                rate, when = data["rates"]["CNY"], data.get("date")
            else:
                rate, when = data["rates"]["CNY"], (data.get("time_last_update_utc") or "")[:16]
            rate = float(rate)
            if rate > 0:
                payload = {"usd_cny": rate, "source": source, "rate_date": when, "stale": False}
                _fx_mem.update({"at": now, "payload": payload})
                return payload
        except Exception:
            continue
    old = _fx_mem["payload"]
    if old:
        return {**old, "stale": True}
    return {"usd_cny": None, "source": None, "rate_date": None, "stale": True,
            "note": "汇率接口不可达且无缓存，页面成本将以 USD 显示"}

# 极简缓存：同一秒内的重复请求直接复用，避免刷新页面时反复扫 300MB 库。
_CACHE: dict[str, tuple[float, object]] = {}
_CACHE_TTL = 5.0


def _cached(key: str, builder):
    now = time.time()
    hit = _CACHE.get(key)
    if hit and now - hit[0] < _CACHE_TTL:
        return hit[1]
    value = builder()
    _CACHE[key] = (now, value)
    return value


def build_payload(days: int, include_aux: bool = True) -> dict:
    """网页要的完整数据。所有口径都来自 core/cost，不在这里另算。"""
    def make() -> dict:
        health = core.check_health()
        summary = core.usage_summary(days, include_aux)
        c = cost.compute_cost(days, include_aux)
        cmp_ = cost.compare_to_hermes(days)
        table = c["price_table"]

        # 成本按模型汇总，供 donut / 柱图直接用
        cost_by_model = [
            {"model": m["model"], "cost_usd": m["cost_usd"],
             "tokens": m["tokens"], "unpriced_tokens": m.get("unpriced_tokens", 0),
             "mixed": m.get("mixed", False),
             "status": m["status"], "status_label": m["status_label"],
             "note": m["note"]}
            for m in c["by_model"]
        ]

        return {
            "days": days,
            "include_aux": include_aux,
            "generated_at": time.time(),
            "health": health.as_dict(),
            "summary": summary,
            "summary_main_only": core.usage_summary(days, False),
            "cost": {
                "cost_usd": c["cost_usd"],
                "coverage": c["coverage"],
                "priced_tokens": c["priced_tokens"],
                "total_tokens": c["total_tokens"],
                "by_model": cost_by_model,
                "daily": c["daily"],
                "unpriced": c["unpriced"],
            },
            "hermes_cost_usd": cmp_["hermes_total_usd"],
            # 汇率随数据一起下发。页面显示 ¥，但成本计算全程用 USD——
            # 汇率只影响展示，不影响算账。缺省为 None 而非猜一个常数。
            "fx": _fx(),
            "by_model": core.usage_by_model(days, include_aux),
            "by_task": core.usage_by_task(days),
            "by_source": core.usage_by_source(days),
            "by_day": core.usage_by_day(days),
            "price_table": {
                "version": table.get("version"),
                "updated": table.get("updated"),
                "currency": table.get("currency"),
                "labels": table.get("labels"),
                "entries": table.get("entries"),
                "alias_rules": table.get("alias_rules"),
                "price_history": table.get("price_history"),
            },
        }

    return _cached(f"payload:{days}:{include_aux}", make)


def build_activity(days: int = 365) -> dict:
    """近 N 天的每日 token 汇总（默认一年），供热力图用。

    单独一个端点而不是塞进 /stats：热力图要一整年（365 行），
    而 /stats 跟着顶部的时间窗口走（30 天）。两者需求不同，
    硬塞在一起会让切窗口时热力图跟着抖动。
    """
    def make() -> dict:
        rows = core.usage_by_day(days, True)
        return {"days": days, "generated_at": time.time(), "by_day": rows}
    return _cached(f"activity:{days}", make)


class Handler(BaseHTTPRequestHandler):
    server_version = "hstats"

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8"),
                   "application/json; charset=utf-8")

    def do_GET(self) -> None:  # noqa: N802
        url = urlparse(self.path)
        qs = parse_qs(url.query)

        if url.path in ("/", "/index.html"):
            f = _WEB_DIR / "index.html"
            if not f.exists():
                self._json({"error": f"missing {_WEB_DIR / 'index.html'}"}, 500)
                return
            self._send(200, f.read_bytes(), "text/html; charset=utf-8")
            return

        if url.path == "/api/stats":
            try:
                days = int(qs.get("days", ["30"])[0])
            except ValueError:
                days = 30
            days = max(1, min(days, 365))
            aux = qs.get("aux", ["1"])[0] not in ("0", "false", "no")
            try:
                self._json(build_payload(days, aux))
            except Exception as exc:                     # 出错也要让网页能显示原因
                self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)
            return

        if url.path == "/api/activity":
            try:
                days = int(qs.get("days", ["365"])[0])
            except ValueError:
                days = 365
            days = max(1, min(days, 730))
            try:
                self._json(build_activity(days))
            except Exception as exc:
                self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)
            return

        if url.path == "/api/health":
            try:
                self._json(core.check_health().as_dict())
            except Exception as exc:
                self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)
            return

        if url.path.startswith("/static/"):
            name = url.path[len("/static/"):]
            f = (_WEB_DIR / name).resolve()
            # 目录穿越防护：解析后必须仍在 web/ 内
            if not str(f).startswith(str(_WEB_DIR.resolve())) or not f.exists():
                self._json({"error": "not found"}, 404)
                return
            ctype = "text/css; charset=utf-8" if f.suffix == ".css" else \
                    "application/javascript; charset=utf-8" if f.suffix == ".js" else \
                    "image/svg+xml"
            self._send(200, f.read_bytes(), ctype)
            return

        self._json({"error": "not found"}, 404)

    def log_message(self, fmt: str, *args) -> None:
        pass          # 静默，避免刷屏


def serve(host: str = "127.0.0.1", port: int = 8130) -> None:
    if host != "127.0.0.1":
        raise SystemExit("只允许绑127.0.0.1；要开局域网请先加鉴权")
    srv = ThreadingHTTPServer((host, port), Handler)
    print(f"hstats 网页端已启动：http://{host}:{port}")
    print("  数据源 ~/.hermes/state.db（只读）")
    print("  Ctrl-C 停止")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


def main() -> int:
    ap = argparse.ArgumentParser(description="hstats 网页端")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8130)
    args = ap.parse_args()
    serve(args.host, args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())