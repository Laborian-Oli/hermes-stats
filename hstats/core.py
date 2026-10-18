"""hstats 数据层 —— 读 Hermes 用量数据，算出可靠的成本与统计。

设计目标（按用户要求：可靠、真实、稳定、可获取）：

1. **只读**。永不写 state.db；以 URI `mode=ro` 打开，误写会直接报错而非静默污染。
2. **零运行时耦合**。不 import hermes_*，只用标准库 + sqlite3 + yaml。
   Hermes 自带的 analytics/insights 依赖 gateway 的包路径，在独立进程里
   不可用；这里自己算，口径写在下面，可核对、可审计。
3. **口径写死在代码里**。哪张表算哪个量、哪些算辅助任务、哪些计入成本，
   都有注释说明，避免「换个环境数字就变了」。

数据源（唯一权威）：~/.hermes/state.db
  - sessions：每个会话一行，含 token 汇总与 estimated_cost_usd
  - session_model_usage：(会话 × 模型 × 任务) 一行，是 token 的**唯一真源**
    sessions 侧的数值由它汇总而来，两者恒等（本模块有自检断言）。

任务口径（task 字段）：
  - 空串  = 主对话，计入「总 Tokens」与成本
  - approval / compression / vision / title_generation / background_review
          = 辅助任务。按用户 2026-10-10 的要求，默认**计入**总 Tokens，
          成本也计入（这些调用同样花钱）。
"""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

_MILLION = 1_000_000

# 计入总 Token 的辅助任务。白名单而非黑名单：新增任务类型默认计入，
# 符合「这些调用同样花钱」的事实；确有不计的再显式排除。
AUX_TASKS_INCLUDED = (
    "approval",
    "compression",
    "vision",
    "title_generation",
    "background_review",
)


# --------------------------------------------------------------------------- 读取


def default_db_path() -> Path:
    """定位 state.db。优先 HERMES_HOME，其次 ~/.hermes。"""
    import os

    home = os.getenv("HERMES_HOME")
    base = Path(home) if home else Path.home() / ".hermes"
    return base / "state.db"


def open_readonly(db_path: Optional[Path] = None, timeout: float = 5.0) -> sqlite3.Connection:
    """以只读模式打开 state.db。

    只读有两个好处：不会误伤生产数据；WAL 模式下与 Hermes 写入方并发不互锁。
    """
    path = Path(db_path or default_db_path())
    if not path.exists():
        raise FileNotFoundError(f"找不到 {path}；Hermes 是否已初始化过？")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=timeout)
    conn.row_factory = sqlite3.Row
    return conn


# --------------------------------------------------------------------------- 完整性


@dataclass
class Health:
    """数据健康检查结果。数据层对外承诺的第一件事。"""

    db_path: str
    db_size_bytes: int
    checked_at: str
    sessions: int = 0
    usage_rows: int = 0
    latest_usage_at: Optional[str] = None
    latest_usage_age_min: Optional[float] = None
    totals_match: bool = False          # sessions 表与 usage 表汇总是否恒等
    orphan_rows: int = 0                # usage 引用了不存在的会话
    null_model_rows: int = 0
    negative_token_rows: int = 0
    inverted_time_rows: int = 0         # last_seen < first_seen
    problems: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems

    def as_dict(self) -> dict[str, Any]:
        d = dict(self.__dict__)
        d["ok"] = self.ok
        return d


def check_health(db_path: Optional[Path] = None) -> Health:
    """跑一遍健康检查。数据层的第一原则是「先证明数据可信，再给数字」。"""
    path = Path(db_path or default_db_path())
    h = Health(db_path=str(path), db_size_bytes=path.stat().st_size,
               checked_at=datetime.now(timezone.utc).isoformat())
    conn = open_readonly(path)
    try:
        one = lambda sql: conn.execute(sql).fetchone()  # noqa: E731
        h.sessions = one("SELECT COUNT(*) FROM sessions")[0]
        h.usage_rows = one("SELECT COUNT(*) FROM session_model_usage")[0]

        latest = one("SELECT MAX(last_seen) FROM session_model_usage")[0]
        if latest:
            h.latest_usage_at = datetime.fromtimestamp(latest, timezone.utc).isoformat()
            h.latest_usage_age_min = round((time.time() - latest) / 60, 1)

        # sessions 的 token 是否等于 usage 表(task='') 的汇总——Hermes 的写入保证恒等，
        # 不等就说明有一侧被改过，此时所有下游数字都不可信。
        a = one("""SELECT COALESCE(SUM(COALESCE(input_tokens,0)),0),
                         COALESCE(SUM(COALESCE(cache_read_tokens,0)),0)
                  FROM sessions""")
        b = one("""SELECT COALESCE(SUM(COALESCE(input_tokens,0)),0),
                         COALESCE(SUM(COALESCE(cache_read_tokens,0)),0)
                  FROM session_model_usage WHERE task=''""")
        h.totals_match = (a[0], a[1]) == (b[0], b[1])

        h.orphan_rows = one("""SELECT COUNT(*) FROM session_model_usage u
                               WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id=u.session_id)""")[0]
        h.null_model_rows = one("""SELECT COUNT(*) FROM session_model_usage
                                   WHERE model IS NULL OR TRIM(model)=''""")[0]
        h.negative_token_rows = one("""SELECT COUNT(*) FROM session_model_usage
                                       WHERE COALESCE(input_tokens,0)<0
                                          OR COALESCE(output_tokens,0)<0
                                          OR COALESCE(cache_read_tokens,0)<0""")[0]
        h.inverted_time_rows = one("""SELECT COUNT(*) FROM session_model_usage
                                      WHERE last_seen < first_seen""")[0]

        if not h.totals_match:
            h.problems.append("sessions 与 session_model_usage 的 token 汇总不一致")
        if h.orphan_rows:
            h.problems.append(f"{h.orphan_rows} 行引用了不存在的会话")
        if h.null_model_rows:
            h.problems.append(f"{h.null_model_rows} 行模型名为空")
        if h.negative_token_rows:
            h.problems.append(f"{h.negative_token_rows} 行 token 为负")
        if h.inverted_time_rows:
            h.problems.append(f"{h.inverted_time_rows} 行时间倒挂")
        if h.latest_usage_age_min is not None and h.latest_usage_age_min > 60:
            h.problems.append(f"用量数据已 {h.latest_usage_age_min:.0f} 分钟未更新")
    finally:
        conn.close()
    return h


# --------------------------------------------------------------------------- 统计


def _task_clause(include_aux: bool) -> tuple[str, list]:
    """构造任务过滤片段。

    必须自带括号：调用方会在后面拼 `AND last_seen > ?`，而 SQL 里
    `A OR B AND C` 的优先级是 `A OR (B AND C)`——主对话行会绕过时间窗，
    把全历史都算进来（实测 30 天窗口会多算 5 倍）。这个坑踩过一次。
    """
    if include_aux:
        marks = ",".join("?" for _ in AUX_TASKS_INCLUDED)
        return f"(task='' OR task IN ({marks}))", list(AUX_TASKS_INCLUDED)
    return "(task='')", []


def usage_summary(days: int = 30, include_aux: bool = True,
                   db_path: Optional[Path] = None) -> dict[str, Any]:
    """窗口内的 token 汇总。include_aux 控制是否计入辅助任务。"""
    cutoff = time.time() - days * 86400
    where, params = _task_clause(include_aux)
    conn = open_readonly(db_path)
    try:
        rows = conn.execute(
                    f"""SELECT COUNT(DISTINCT session_id)                      AS sessions,
                               COUNT(DISTINCT model)                         AS models,
                               SUM(COALESCE(input_tokens, 0))                AS input_tokens,
                               SUM(COALESCE(output_tokens, 0))               AS output_tokens,
                               SUM(COALESCE(cache_read_tokens, 0))           AS cache_read_tokens,
                               SUM(COALESCE(cache_write_tokens, 0))          AS cache_write_tokens,
                               SUM(COALESCE(reasoning_tokens, 0))            AS reasoning_tokens,
                               SUM(COALESCE(api_call_count, 0))              AS api_calls
                        FROM session_model_usage
                        WHERE {where} AND last_seen > ?""", params + [cutoff]).fetchone()
    finally:
        conn.close()
    out = {k: int(rows[k] or 0) for k in rows.keys()}
    out["days"] = days
    out["include_aux"] = include_aux
    out["total_tokens"] = out["input_tokens"] + out["output_tokens"]
    out["total_with_cache"] = out["total_tokens"] + out["cache_read_tokens"]
    out["cache_share"] = round(
        out["cache_read_tokens"] / out["input_tokens"], 2) if out["input_tokens"] else 0.0
    return out


def usage_by_model(days: int = 30, include_aux: bool = True,
                   db_path: Optional[Path] = None) -> list[dict[str, Any]]:
    """按模型拆分的用量。模型是成本的主要维度，必须能拆开看。"""
    cutoff = time.time() - days * 86400
    where, params = _task_clause(include_aux)
    conn = open_readonly(db_path)
    try:
        rows = conn.execute(
            f"""SELECT COALESCE(model, '(未知)')                   AS model,
                       SUM(COALESCE(input_tokens, 0))                AS input_tokens,
                       SUM(COALESCE(output_tokens, 0))               AS output_tokens,
                       SUM(COALESCE(cache_read_tokens, 0))           AS cache_read_tokens,
                       SUM(COALESCE(cache_write_tokens, 0))          AS cache_write_tokens,
                       SUM(COALESCE(api_call_count, 0))              AS api_calls,
                       COUNT(DISTINCT session_id)                    AS sessions
                FROM session_model_usage
                WHERE {where} AND last_seen > ?
                GROUP BY model ORDER BY input_tokens + output_tokens DESC""",
            params + [cutoff]).fetchall()
    finally:
        conn.close()
    out = []
    for r in rows:
        d = {k: (r[k] if k == "model" else int(r[k] or 0)) for k in r.keys()}
        d["total_tokens"] = d["input_tokens"] + d["output_tokens"]
        out.append(d)
    return out


def usage_by_day(days: int = 30, include_aux: bool = True,
                  db_path: Optional[Path] = None) -> list[dict[str, Any]]:
    """按天（本地时区）拆分。趋势图的唯一数据源。"""
    cutoff = time.time() - days * 86400
    where, params = _task_clause(include_aux)
    conn = open_readonly(db_path)
    try:
        rows = conn.execute(
            f"""SELECT date(last_seen, 'unixepoch', 'localtime')      AS day,
                       SUM(COALESCE(input_tokens, 0))                AS input_tokens,
                       SUM(COALESCE(output_tokens, 0))               AS output_tokens,
                       SUM(COALESCE(cache_read_tokens, 0))           AS cache_read_tokens,
                       SUM(COALESCE(api_call_count, 0))              AS api_calls,
                       COUNT(DISTINCT session_id)                    AS sessions
                FROM session_model_usage
                WHERE {where} AND last_seen > ?
                GROUP BY day ORDER BY day""", params + [cutoff]).fetchall()
    finally:
        conn.close()
    out = []
    for r in rows:
        d = {k: (r[k] if k == "day" else int(r[k] or 0)) for k in r.keys()}
        d["total_tokens"] = d["input_tokens"] + d["output_tokens"]
        out.append(d)
    return out


def usage_by_task(days: int = 30, db_path: Optional[Path] = None) -> list[dict[str, Any]]:
    """按任务类型拆分。让「辅助任务吃掉多少」可见——这是之前最大的盲区。"""
    cutoff = time.time() - days * 86400
    conn = open_readonly(db_path)
    try:
        rows = conn.execute(
            """SELECT COALESCE(NULLIF(task,''), '(主对话)')          AS task,
                      SUM(COALESCE(input_tokens, 0))               AS input_tokens,
                      SUM(COALESCE(output_tokens, 0))              AS output_tokens,
                      SUM(COALESCE(cache_read_tokens, 0))          AS cache_read_tokens,
                      COUNT(DISTINCT session_id)                   AS sessions
               FROM session_model_usage WHERE last_seen > ?
               GROUP BY task ORDER BY input_tokens DESC""", (cutoff,)).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


def usage_by_source(days: int = 30, include_aux: bool = True,
                    db_path: Optional[Path] = None) -> list[dict[str, Any]]:
    """按来源（desktop / cron / cli …）拆分。知道钱花在哪条入口上。"""
    cutoff = time.time() - days * 86400
    where, params = _task_clause(include_aux)
    conn = open_readonly(db_path)
    try:
        rows = conn.execute(
            f"""SELECT COALESCE(s.source, '(未知)')                    AS source,
                       SUM(COALESCE(u.input_tokens, 0))              AS input_tokens,
                       SUM(COALESCE(u.output_tokens, 0))             AS output_tokens,
                       SUM(COALESCE(u.cache_read_tokens, 0))         AS cache_read_tokens,
                       COUNT(DISTINCT u.session_id)                  AS sessions
                FROM session_model_usage u
                JOIN sessions s ON s.id = u.session_id
                WHERE {where} AND u.last_seen > ?
                GROUP BY s.source ORDER BY input_tokens DESC""",
            params + [cutoff]).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


# --------------------------------------------------------------------------- 自检


def selfcheck(days: int = 30, db_path: Optional[Path] = None) -> dict[str, Any]:
    """一次性跑健康 + 汇总，用于 CI 或改动后回归。"""
    h = check_health(db_path)
    return {
        "health": h.as_dict(),
        "summary": usage_summary(days, True, db_path),
        "summary_main_only": usage_summary(days, False, db_path),
        "models": len(usage_by_model(days, True, db_path)),
        "days_with_data": len(usage_by_day(days, True, db_path)),
        "tasks": len(usage_by_task(days, db_path)),
        "sources": len(usage_by_source(days, True, db_path)),
    }


if __name__ == "__main__":  # 手动冒烟：python -m hstats
    print(json.dumps(selfcheck(), ensure_ascii=False, indent=2, default=str))