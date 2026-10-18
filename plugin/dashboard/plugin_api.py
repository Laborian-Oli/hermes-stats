"""hermes-stats — Hermes Desktop 统计中心 · Python 后端。

只读聚合 Hermes 会话 / 用量 / cron 数据，供桌面插件 /stats 页面与状态栏消费。
运行于 gateway 进程内；import 的均为官方既有模块，不修改任何核心代码。

路由挂载于 /api/plugins/hermes-stats/ 之下（桌面插件 ctx.rest 命名空间）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Query

logger = logging.getLogger("hermes-stats")

# 改动是否生效看 build.id；进程身份看 build.pid / build.started
_BUILD_ID = "2026-10-11b"
_PROCESS_START = time.time()

# 必须用绝对路径加载 pricing：插件宿主把 plugin_api.py 以受管模块方式载入，
# 其包搜索路径不含本目录，裸 `import pricing` 会 ModuleNotFoundError（静默变成
# has_pricing=false，页面悄悄退回旧成本字段）。踩过一次，记在这里。
def _load_pricing():
    import importlib.util

    path = Path(__file__).resolve().parent / "pricing.py"
    if not path.exists():
        logger.error("hermes-stats: 找不到 %s，成本将退回旧字段", path)
        return None
    spec = importlib.util.spec_from_file_location("hermes_stats_pricing", path)
    if spec is None or spec.loader is None:
        logger.error("hermes-stats: 无法为 %s 构造 module spec", path)
        return None
    module = importlib.util.module_from_spec(spec)
    # 必须先注册进 sys.modules：@dataclass 在处理 __module__ 时会回查
    # sys.modules[cls.__module__].__dict__，没注册会 AttributeError。
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(spec.name, None)
        logger.exception("hermes-stats: 加载 %s 失败，成本将退回旧字段", path)
        return None
    return module


_pricing = _load_pricing()
logger.info("hermes-stats: 价格引擎 %s", "已加载" if _pricing else "未加载（成本口径会退化）")

router = APIRouter()

_MAX_DAYS = 365


# --------------------------------------------------------------------------- fx
# 成本单价以美元计价（DeepSeek 官方账单单位是 USD），前端展示统一换算成人民币。
# 汇率来源依次尝试：ECB 参考汇率（frankfurter.dev）→ exchangerate-api（open.er-api.com）→ 兜底常数。
# 结果缓存 12h（进程内 + ~/.hermes/cache/hermes-stats-fx.json）；接口全挂时沿用旧值并标 stale=true。

_FX_TTL = 12 * 3600
_FX_FALLBACK = 7.10
_FX_SOURCES = (
    ("ECB", "https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY"),
    ("exchangerate-api", "https://open.er-api.com/v6/latest/USD"),
)
_fx_mem: dict = {"at": 0.0, "payload": None}


def _fx_parse(source: str, data: dict) -> dict | None:
    """从各家响应里取 USD→CNY 与其报价日；结构不符返回 None 换下一家。"""
    try:
        if source == "ECB":
            rate, date = data["rates"]["CNY"], data.get("date")
        else:
            rate, date = data["rates"]["CNY"], (data.get("time_last_update_utc") or "")[:16]
        rate = float(rate)
    except (KeyError, TypeError, ValueError):
        return None
    return {"usd_cny": rate, "source": source, "rate_date": date} if rate > 0 else None


def _fx_disk_path() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home()) / "cache" / "hermes-stats-fx.json"


def _fx_disk_read() -> dict | None:
    try:
        with open(_fx_disk_path(), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) and float(data.get("usd_cny") or 0) > 0 else None
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return None


def _fx_disk_write(payload: dict) -> None:
    try:
        path = _fx_disk_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f)
    except OSError:
        pass


def _fx_fetch() -> dict | None:
    try:
        import httpx
    except ImportError:
        return None
    for source, url in _FX_SOURCES:
        try:
            resp = httpx.get(url, timeout=8)
            resp.raise_for_status()
            got = _fx_parse(source, resp.json())
            if got:
                return got
        except Exception:
            continue
    return None


def _fx_rate() -> dict:
    now = time.time()
    cached = _fx_mem["payload"]
    if cached and now - _fx_mem["at"] < _FX_TTL:
        return cached
    got = _fx_fetch()
    if got:
        payload = {**got, "fetched_at": now, "stale": False}
        _fx_mem.update({"at": now, "payload": payload})
        _fx_disk_write(payload)
        return payload
    old = _fx_mem["payload"] or _fx_disk_read()
    if old:
        return {**old, "stale": True}
    return {
        "usd_cny": _FX_FALLBACK,
        "source": "fallback",
        "rate_date": None,
        "fetched_at": now,
        "stale": True,
    }


# --------------------------------------------------------------------------- pricing
# Hermes 自己记的 estimated_cost_usd 大面积是 unknown（MiniMax M3 / M3.1、gpt-5.6 全系列
# 都是 0），页面于是把真金白银显示成 ¥0。这里按 session_model_usage 逐条按自带价格表
# 重算，把「查不到价」的 token 单独统计出来交前端显示「—」，而不是假装 0。


def _reprice(cutoff: float) -> dict:
    """按 (model, base_url) 重算成本。返回 totals / by_model / daily / unpriced 四块。"""
    from hermes_cli.web_routers.analytics import _open_session_db_for_profile

    db = _open_session_db_for_profile(None, read_only=True)
    try:
        conn = db._conn
        # 汇总维度必须能定出唯一时段。DeepSeek 峰谷按 UTC 整点切换（01/04/06/10），
        # 而中国法定节假日会让「同一天内峰谷分布」不确定——宁可用更细的粒度，
        # 也不能拿一个 MAX(last_seen) 概括整段（会把大量谷时段误判成峰或反之）。
        # 故汇总到「天 × 星期」，避开跨时段的混淆；节假日例外在下方注释说明。
        rows = conn.execute(
            """SELECT model, billing_base_url,
                      date(last_seen, 'unixepoch') AS day,
                      CAST(strftime('%w', last_seen, 'unixepoch') AS INTEGER) AS dow,
                      MIN(last_seen) AS ts,
                      SUM(COALESCE(input_tokens, 0))    AS i,
                      SUM(COALESCE(output_tokens, 0))   AS o,
                      SUM(COALESCE(cache_read_tokens, 0)) AS cr,
                      SUM(COALESCE(cache_write_tokens, 0)) AS cw
               FROM session_model_usage WHERE last_seen > ?
               GROUP BY model, billing_base_url, day, dow""",
            (cutoff,),
        ).fetchall()
        # 按天再分一层：峰谷与历史价都随时间变，只按整段汇总会算错。
        # 同一天内若跨越调价日或峰谷切换，误差在一天量级内，可接受。
        daily_rows = conn.execute(
            """SELECT date(last_seen, 'unixepoch', 'localtime') AS day,
                      model, billing_base_url, MIN(last_seen) AS ts,
                      SUM(COALESCE(input_tokens, 0))      AS i,
                      SUM(COALESCE(output_tokens, 0))     AS o,
                      SUM(COALESCE(cache_read_tokens, 0)) AS cr,
                      SUM(COALESCE(cache_write_tokens, 0)) AS cw
               FROM session_model_usage WHERE last_seen > ?
               GROUP BY day, model, billing_base_url""",
            (cutoff,),
        ).fetchall()
    finally:
        db.close()

    def _one(row):
        # 用该行的时间戳取价：峰谷价与历史价都靠它判定。
        # 汇总到「天×星期」后，同一段内的调用几乎总在同一档；
        # 峰时段集中在 UTC 01-10，一个 UTC 日最多跨 2 个峰段，取当天最早一条
        # 属于保守侧（更可能落在谷价），但对中文节假日例外无能为力——
        # 那类偏差已由文档说明。
        rate = _pricing.lookup(row["model"], row["billing_base_url"], ts=row["ts"])
        i, o, cr, cw = row["i"] or 0, row["o"] or 0, row["cr"] or 0, row["cw"] or 0
        tokens = i + o + cr + cw
        priced = _pricing.is_priced(rate)
        cost = _pricing.compute(i, o, cr, cw, rate) if priced else 0.0
        return rate, tokens, cost, priced

    by_model: dict[str, dict] = {}
    unpriced: dict[str, int] = {}
    total_cost = total_priced = total_tokens = 0.0

    for row in rows:
        rate, tokens, cost, priced = _one(row)
        m = (row["model"] or "未知模型")
        slot = by_model.setdefault(m, {"model": m, "cost_usd": 0.0, "tokens": 0,
                                       "status": rate.status, "status_label": _pricing.STATUS_LABELS.get(rate.status, rate.status),
                                       "note": rate.note, "confidence": rate.confidence})
        slot["cost_usd"] += cost
        slot["tokens"] += tokens
        # 同一模型混了「已定价」和「未定价」端点时，以已定价为准，避免把定价的模型标成未知
        if priced:
            slot["status"], slot["status_label"], slot["confidence"], slot["note"] = rate.status, _pricing.STATUS_LABELS.get(rate.status, rate.status), rate.confidence, rate.note
        total_cost += cost
        total_tokens += tokens
        if priced:
            total_priced += tokens
        else:
            unpriced[m] = unpriced.get(m, 0) + tokens

    daily: dict[str, float] = defaultdict(float)
    for row in daily_rows:
        rate, _tokens, cost, priced = _one(row)
        if priced:
            daily[row["day"]] += cost

    return {
        "cost_usd": round(total_cost, 6),
        "priced_tokens": int(total_priced),
        "total_tokens": int(total_tokens),
        "coverage": round(total_priced / total_tokens, 4) if total_tokens else 0.0,
        "by_model": sorted(by_model.values(), key=lambda r: -r["cost_usd"]),
        "daily": [{"day": d, "cost_usd": round(v, 6)} for d, v in sorted(daily.items())],
        "unpriced": [{"model": k, "tokens": v} for k, v in sorted(unpriced.items(), key=lambda x: -x[1])],
        "table": _pricing.table_status(),
    }


@router.get("/pricing")
async def pricing_status():
    """价格表本身：版本、每条价的出处与置信度。别名规则一并下发，便于自查。"""
    if _pricing is None:
        return {"available": False}
    return {"available": True, **_pricing.table_status()}


# --------------------------------------------------------------------------- stats


def _stats_payload(days: int) -> dict:
    from hermes_cli.web_routers.analytics import _get_usage_analytics, _open_session_db_for_profile
    from agent.insights import InsightsEngine

    raw = _get_usage_analytics(days=days)
    db = _open_session_db_for_profile(None, read_only=True)
    try:
        full = InsightsEngine(db).generate(days=days)
    finally:
        db.close()

    payload = {
        "days": days,
        "generated_at": time.time(),
        "fx": _fx_rate(),
        "totals": raw["totals"],
        "daily": raw["daily"],
        "by_model": raw["by_model"],
        "by_task": raw["by_task"],
        "overview": full["overview"],
        "platforms": full["platforms"],
        "tools": full["tools"],
        "skills": full["skills"],
        "activity": full["activity"],
        "top_sessions": full["top_sessions"],
    }

    if _pricing is not None:
        cutoff = time.time() - days * 86400
        try:
            repriced = _reprice(cutoff)
        except Exception as exc:
            # 静默吞掉会让页面退回 $0 而没人知道为什么；至少留下痕迹
            logger.warning("hermes-stats: 价格重算失败，回退 Hermes 自记成本: %s: %s",
                           type(exc).__name__, exc, exc_info=True)
            repriced = None
        if repriced:
            payload["pricing"] = repriced
            # 把 daily 的成本换成重算值，页面趋势图立刻跟着变准
            per_day = {d["day"]: d["cost_usd"] for d in repriced["daily"]}
            for row in payload["daily"]:
                if row.get("day") in per_day:
                    row["estimated_cost"] = per_day[row["day"]]

    # totals.*_tokens 只含主任务，overview 才含辅助任务（压缩/审批/视觉/后台复审）。
    # 底边栏 chip 要与页面 KPI 卡口径一致，故把含辅助的总量也放进 totals。
    overview = payload.get("overview") or {}
    payload["totals"]["total_input_tokens_all"] = overview.get("total_input_tokens")
    payload["totals"]["total_output_tokens_all"] = overview.get("total_output_tokens")
    payload["totals"]["total_cache_read_all"] = overview.get("total_cache_read_tokens")

    # 自报家门：改动是否真的生效，看这个字段最快。BUILD_ID 每次改后端就手动 +1，
    # 页面底部会显示它；不用再靠猜是缓存还是没重启。
    payload["build"] = {
        "id": _BUILD_ID,
        "module_file": __file__,
        "pricing_file": getattr(_pricing, "_PRICE_FILE", None) and str(_pricing._PRICE_FILE),
        "has_pricing": _pricing is not None,
        "pid": os.getpid(),
        "started": _PROCESS_START,
    }
    return payload


@router.get("/stats")
async def stats(days: int = Query(30, ge=1, le=_MAX_DAYS)):
    return await asyncio.to_thread(_stats_payload, days)


# --------------------------------------------------------------------------- cron


def _ts_day(raw) -> str:
    """归一化 execution 时间戳 → 'YYYY-MM-DD' 字符串（容错 ISO / epoch）。"""
    if not raw:
        return ""
    s = str(raw).strip()
    if not s:
        return ""
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone().strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        pass
    try:
        return datetime.fromtimestamp(float(raw)).strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        return s[:10]


def _cron_payload() -> dict:
    from hermes_constants import get_hermes_home

    home = Path(get_hermes_home())
    out: dict = {"generated_at": time.time(), "jobs": [], "by_day": [], "recent": [], "totals": {"runs": 0, "completed": 0, "failed": 0}}

    # 1) 任务定义 ~/.hermes/cron/jobs.json
    try:
        with open(home / "cron" / "jobs.json", encoding="utf-8") as f:
            data = json.load(f)
        entries = data if isinstance(data, list) else data.get("jobs", [])
        for j in entries:
            if not isinstance(j, dict):
                continue
            out["jobs"].append({
                "id": j.get("id"),
                "name": j.get("name") or j.get("title") or j.get("prompt", "")[:40],
                "schedule": j.get("schedule") or j.get("cron") or j.get("interval") or "",
                "enabled": bool(j.get("enabled", True)),
                "last_run_at": j.get("last_run_at"),
                "next_run": j.get("next_run"),
            })
    except (OSError, json.JSONDecodeError, TypeError):
        pass

    # 2) 执行台账 ~/.hermes/cron/executions.db
    dbp = home / "cron" / "executions.db"
    if dbp.exists():
        try:
            conn = sqlite3.connect(f"file:{dbp}?mode=ro", uri=True, timeout=5)
            try:
                cur = conn.execute(
                    "SELECT * FROM executions ORDER BY claimed_at DESC LIMIT 1000"
                )
                cols = [c[0] for c in cur.description]
                rows = [dict(zip(cols, r)) for r in cur.fetchall()]
            finally:
                conn.close()

            day_status: dict[str, Counter] = defaultdict(Counter)
            for r in rows:
                day = _ts_day(r.get("scheduled_instant") or r.get("claimed_at") or r.get("started_at"))
                status = r.get("status") or "unknown"
                if day:
                    day_status[day][status] += 1
                out["totals"]["runs"] += 1
                if status == "completed":
                    out["totals"]["completed"] += 1
                elif status == "failed":
                    out["totals"]["failed"] += 1
            out["recent"] = [
                {
                    "id": r.get("id"),
                    "job_id": r.get("job_id"),
                    "status": r.get("status"),
                    "claimed_at": r.get("claimed_at"),
                    "finished_at": r.get("finished_at"),
                    "error": (r.get("error") or "")[:200],
                }
                for r in rows[:50]
            ]
            out["by_day"] = [
                {
                    "day": d,
                    "completed": day_status[d].get("completed", 0),
                    "failed": day_status[d].get("failed", 0),
                    "other": sum(v for k, v in day_status[d].items() if k not in ("completed", "failed")),
                }
                for d in sorted(day_status)
            ]
        except sqlite3.Error:
            pass
    return out


@router.get("/cron")
async def cron():
    return await asyncio.to_thread(_cron_payload)


# --------------------------------------------------------------------------- system


def _system_payload() -> dict:
    from hermes_constants import get_hermes_home

    home = Path(get_hermes_home())
    out: dict = {"generated_at": time.time(), "hermes_home": str(home)}

    try:
        import importlib.metadata as md

        out["version"] = md.version("hermes_agent")
    except Exception:
        out["version"] = "unknown"

    out["model"] = None
    out["skin"] = None
    out["profile"] = home.name if home.parent.name == "profiles" else "default"
    try:
        import yaml

        with open(home / "config.yaml", encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
        m = cfg.get("model")
        if isinstance(m, dict):
            out["model"] = m.get("default") or m.get("name") or m.get("provider")
        else:
            out["model"] = m
        out["skin"] = (cfg.get("display") or {}).get("skin")
    except Exception:
        pass

    out["memory_chars"] = {}
    for name in ("MEMORY.md", "USER.md"):
        p = home / "memories" / name
        try:
            out["memory_chars"][name] = p.stat().st_size
        except OSError:
            out["memory_chars"][name] = 0

    try:
        out["skills_count"] = sum(1 for _ in (home / "skills").rglob("SKILL.md"))
    except OSError:
        out["skills_count"] = 0

    out["sessions_total"] = None
    try:
        from hermes_cli.web_routers.analytics import _open_session_db_for_profile

        db = _open_session_db_for_profile(None, read_only=True)
        try:
            out["sessions_total"] = db._conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
        finally:
            db.close()
    except Exception:
        pass

    return out


@router.get("/system")
async def system():
    return await asyncio.to_thread(_system_payload)