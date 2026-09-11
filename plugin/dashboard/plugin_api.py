"""hermes-stats — Hermes Desktop 统计中心 · Python 后端。

只读聚合 Hermes 会话 / 用量 / cron 数据，供桌面插件 /stats 页面与状态栏消费。
运行于 gateway 进程内；import 的均为官方既有模块，不修改任何核心代码。

路由挂载于 /api/plugins/hermes-stats/ 之下（桌面插件 ctx.rest 命名空间）。
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Query

router = APIRouter()

_MAX_DAYS = 365


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

    return {
        "days": days,
        "generated_at": time.time(),
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