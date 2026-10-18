"""hstats 成本计算 —— 在 core 的原始用量上套价格表，算出等效成本。

与 core 的分工：
  core.py   只负责「有多少 token」，不碰价格
  cost.py   只负责「这些 token 值多少钱」，不碰 SQL 以外的业务逻辑

为什么单独一层：价格会变（峰谷、历史调价），用量口径不该跟着变。
拆开后，改价格只动 price_table.yaml，改口径只动 core.py。

误差策略（用户 2026-10-11 要求：能精确就精确，有误差宁可高估）：
  1. 峰谷价按每条记录的调用时刻判定，不用整段一刀切
  2. 历史调价按调用日期取当时那档价
  3. 汇总粒度取「天 × 星期」——再细会增加查询成本，再粗（整段判一次）
     会把大量谷时段误判成峰，实测偏差可达 -26%，属于不可接受的低估
  4. 拿不准时取高的一档：中国法定节假日未维护，落在节假日的调用
     会按工作日判峰，方向恰好是高估
  5. 查不到价的模型不猜，计入「未定价」并单列，绝不按 0 混进总额
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Any, Optional

from . import pricing
from .core import AUX_TASKS_INCLUDED, default_db_path, open_readonly


def _task_clause(include_aux: bool) -> tuple[str, list]:
    if include_aux:
        marks = ",".join("?" for _ in AUX_TASKS_INCLUDED)
        return f"(task='' OR task IN ({marks}))", list(AUX_TASKS_INCLUDED)
    return "(task='')", []


def compute_cost(days: int = 30, include_aux: bool = True,
                 db_path: Optional[Path] = None) -> dict[str, Any]:
    """算出窗口内的等效成本，返回总额、分模型、分天与覆盖情况。

    覆盖（coverage）必须和总额一起看：覆盖 89% 意味着总额只是已定价那部分，
    不是全部开销。把它一起返回，调用方就不可能误报一个「看起来完整」的数字。
    """
    cutoff = time.time() - days * 86400
    where, params = _task_clause(include_aux)
    conn = open_readonly(db_path)
    try:
        # 「天 × 星期」粒度：单条记录平均跨度 8.2 小时，按天汇总后同段内的
        # 调用几乎总在同一档；比整段判一次的偏差小一个数量理。
        # day / dow 必须与下面 daily 序列一样取 localtime：两边时区不一致时，
        # 跨 UTC 零点的记录会被分到不同日期，导致「每日合计 ≠ 总计」。
        rows = conn.execute(
            f"""SELECT model, billing_base_url,
                       date(last_seen, 'unixepoch', 'localtime')        AS day,
                       CAST(strftime('%w', last_seen, 'unixepoch', 'localtime') AS INTEGER) AS dow,
                       MIN(last_seen)                                   AS ts,
                       SUM(COALESCE(input_tokens, 0))                  AS i,
                       SUM(COALESCE(output_tokens, 0))                 AS o,
                       SUM(COALESCE(cache_read_tokens, 0))             AS cr,
                       SUM(COALESCE(cache_write_tokens, 0))            AS cw
                FROM session_model_usage
                WHERE {where} AND last_seen > ?
                GROUP BY model, billing_base_url, day, dow""",
            params + [cutoff]).fetchall()
        day_rows = conn.execute(
            f"""SELECT date(last_seen, 'unixepoch', 'localtime')       AS day,
                       model, billing_base_url, MIN(last_seen)         AS ts,
                       SUM(COALESCE(input_tokens, 0))                  AS i,
                       SUM(COALESCE(output_tokens, 0))                 AS o,
                       SUM(COALESCE(cache_read_tokens, 0))             AS cr,
                       SUM(COALESCE(cache_write_tokens, 0))            AS cw
                FROM session_model_usage
                WHERE {where} AND last_seen > ?
                GROUP BY day, model, billing_base_url""",
            params + [cutoff]).fetchall()
    finally:
        conn.close()

    by_model: dict[str, dict[str, Any]] = {}
    # 同一模型可能同时落在已定价与未定价的端点上（如 qwen 经 ollama 免费、
    # 又有一档无 base_url 查不到价）。合并时若只用单一 status，就会出现
    # 「表里标本地免费、未定价清单里又出现同一个模型」的自相矛盾。
    # 改为累加一个「未定价 token」计数，让两种状态同时可见。
    unpriced: dict[str, int] = {}
    total_usd = 0.0
    priced_tokens = 0
    all_tokens = 0

    for row in rows:
        rate = pricing.lookup(row["model"], row["billing_base_url"], ts=row["ts"])
        i, o, cr, cw = row["i"] or 0, row["o"] or 0, row["cr"] or 0, row["cw"] or 0
        tokens = i + o + cr + cw
        priced = pricing.is_priced(rate)
        cost = pricing.compute(i, o, cr, cw, rate) if priced else 0.0

        name = row["model"] or "(未知模型)"
        slot = by_model.setdefault(name, {
            "model": name, "cost_usd": 0.0, "tokens": 0, "unpriced_tokens": 0,
            "status": rate.status,
            "status_label": pricing.STATUS_LABELS.get(rate.status, rate.status),
            "confidence": rate.confidence, "note": rate.note,
            "source": rate.source, "checked": rate.checked,
            "mixed": False,
        })
        slot["cost_usd"] += cost
        slot["tokens"] += tokens
        if priced:
            if slot["unpriced_tokens"] > 0 and slot["status"] != rate.status:
                slot["mixed"] = True                 # 同一模型两种口径，标出来
            slot.update(status=rate.status,
                        status_label=pricing.STATUS_LABELS.get(rate.status, rate.status),
                        confidence=rate.confidence, note=rate.note,
                        source=rate.source, checked=rate.checked)
        else:
            slot["unpriced_tokens"] += tokens

        total_usd += cost
        all_tokens += tokens
        if priced:
            priced_tokens += tokens
        else:
            unpriced[name] = unpriced.get(name, 0) + tokens

    daily: dict[str, float] = {}
    for row in day_rows:
        rate = pricing.lookup(row["model"], row["billing_base_url"], ts=row["ts"])
        if pricing.is_priced(rate):
            daily[row["day"]] = daily.get(row["day"], 0.0) + pricing.compute(
                row["i"] or 0, row["o"] or 0, row["cr"] or 0, row["cw"] or 0, rate)

    return {
        "days": days,
        "include_aux": include_aux,
        "cost_usd": round(total_usd, 6),
        "priced_tokens": priced_tokens,
        "total_tokens": all_tokens,
        "coverage": round(priced_tokens / all_tokens, 4) if all_tokens else 0.0,
        "by_model": sorted(by_model.values(), key=lambda r: -r["cost_usd"]),
        "daily": [{"day": d, "cost_usd": round(v, 6)} for d, v in sorted(daily.items())],
        "unpriced": [{"model": k, "tokens": v} for k, v in
                     sorted(unpriced.items(), key=lambda x: -x[1])],
        "price_table": pricing.table_status(),
    }


def compare_to_hermes(days: int = 30, db_path: Optional[Path] = None) -> dict[str, Any]:
    """把自算成本与 Hermes 自记的 estimated_cost_usd 对照。

    两者本来就不该相等：Hermes 对没登记价格的模型记 0（unknown），
    且它的峰谷口径未知。自算是准的，Hermes 是粗的——这个函数存在的意义
    是让「差多少、为什么差」随时可查，而不是让人对着两个数字猜。
    """
    cutoff = time.time() - days * 86400
    conn = open_readonly(db_path)
    try:
        rows = conn.execute(
            """SELECT COALESCE(model,'(未知)')                        AS model,
                      COALESCE(SUM(estimated_cost_usd), 0)             AS hermes_usd
               FROM session_model_usage WHERE last_seen > ?
               GROUP BY model ORDER BY hermes_usd DESC""", (cutoff,)).fetchall()
    finally:
        conn.close()

    hermes_by_model = {r["model"]: r["hermes_usd"] for r in rows}
    mine = compute_cost(days, True, db_path)
    mine_by_model = {m["model"]: m["cost_usd"] for m in mine["by_model"]}

    per_model = []
    for name in sorted(set(hermes_by_model) | set(mine_by_model)):
        h = hermes_by_model.get(name, 0.0)
        m = mine_by_model.get(name, 0.0)
        per_model.append({
            "model": name,
            "hermes_usd": round(h, 4),
            "hstats_usd": round(m, 4),
            "delta_usd": round(m - h, 4),
            "note": "" if abs(m - h) < 0.005 else
                    ("Hermes 未登记价格记 0" if h == 0 and m > 0 else "口径不同"),
        })
    return {
        "days": days,
        "hermes_total_usd": round(sum(hermes_by_model.values()), 4),
        "hstats_total_usd": mine["cost_usd"],
        "coverage": mine["coverage"],
        "per_model": per_model,
    }


if __name__ == "__main__":  # 手动冒烟
    import json

    print(json.dumps(compute_cost(30), ensure_ascii=False, indent=2, default=str))