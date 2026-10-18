"""hstats CLI —— 数据层自检与查询入口。

用法：
    python -m hstats health           # 数据健康检查（先证明可信，再谈数字）
    python -m hstats summary [days]   # token 汇总
    python -m hstats cost [days]      # 成本明细
    python -m hstats compare [days]   # 与 Hermes 自记成本对照
    python -m hstats breakdown        # 按模型/任务/来源/天拆分
    python -m hstats json             # 一次性输出全部（JSON，给别的程序用）

设计：任何命令都不依赖 Hermes 运行时，任何命令都不写 state.db。
"""

from __future__ import annotations

import json
import sys

from . import core, cost


def _fmt_int(n) -> str:
    return f"{int(n):,}"


def cmd_health() -> int:
    h = core.check_health()
    print(f"数据库      {h.db_path}")
    print(f"大小        {h.db_size_bytes / 1e6:.0f} MB")
    print(f"检查时间    {h.checked_at}")
    print(f"最新用量    {h.latest_usage_at}  （{h.latest_usage_age_min} 分钟前）")
    print(f"会话数      {_fmt_int(h.sessions)}")
    print(f"用量行数    {_fmt_int(h.usage_rows)}")
    print(f"汇总一致    {'是' if h.totals_match else '否 <- 数据不可信'}")
    print(f"孤儿行      {h.orphan_rows}    空模型 {h.null_model_rows}"
          f"    负值 {h.negative_token_rows}    时间倒挂 {h.inverted_time_rows}")
    print()
    if h.ok:
        print("结论：数据可信")
        return 0
    print("结论：存在问题，数字不可信")
    for p in h.problems:
        print(f"  - {p}")
    return 1


def cmd_summary(days: int) -> int:
    s = core.usage_summary(days, True)
    m = core.usage_summary(days, False)
    print(f"=== 近 {days} 天 ===")
    print(f"{'口径':<10}{'输入':>15}{'输出':>13}{'缓存读':>17}")
    print(f"{'含辅助':<10}{_fmt_int(s['input_tokens']):>15}{_fmt_int(s['output_tokens']):>13}{_fmt_int(s['cache_read_tokens']):>17}")
    print(f"{'仅主任务':<10}{_fmt_int(m['input_tokens']):>15}{_fmt_int(m['output_tokens']):>13}{_fmt_int(m['cache_read_tokens']):>17}")
    print()
    print(f"会话 {_fmt_int(s['sessions'])}  模型 {s['models']}  API 调用 {_fmt_int(s['api_calls'])}")
    print(f"缓存读是输入的 {s['cache_share']:.1f} 倍 —— 提示词缓存在 Agent 场景里占绝对大头")
    print(f"辅助任务占输入的 {(1 - m['input_tokens'] / s['input_tokens']) * 100:.1f}%")
    return 0


def cmd_cost(days: int) -> int:
    c = cost.compute_cost(days)
    print(f"=== 近 {days} 天成本（USD）===")
    print(f"{'模型':<32}{'成本':>12}{'状态':>10}{'token':>16}")
    for m in c["by_model"]:
        print(f"{m['model']:<32}{m['cost_usd']:>12.4f}{m['status_label']:>10}{_fmt_int(m['tokens']):>16}")
    print(f"{'合计':<32}{c['cost_usd']:>12.4f}")
    print()
    print(f"定价覆盖 {c['coverage'] * 100:.1f}%  （{_fmt_int(c['priced_tokens'])} / {_fmt_int(c['total_tokens'])} token）")
    if c["unpriced"]:
        print("未定价（未计入合计，不是 0）：")
        for u in c["unpriced"]:
            if u["tokens"]:
                print(f"  {u['model']:<30} {_fmt_int(u['tokens'])} token")
    return 0


def cmd_compare(days: int) -> int:
    r = cost.compare_to_hermes(days)
    print(f"=== 近 {days} 天：hstats 自算 vs Hermes 自记（USD）===")
    print(f"{'模型':<32}{'Hermes':>10}{'hstats':>10}{'差额':>10}  说明")
    for m in r["per_model"]:
        print(f"{m['model']:<32}{m['hermes_usd']:>10.4f}{m['hstats_usd']:>10.4f}"
              f"{m['delta_usd']:>+10.4f}  {m['note']}")
    print(f"{'合计':<32}{r['hermes_total_usd']:>10.4f}{r['hstats_total_usd']:>10.4f}"
          f"{r['hstats_total_usd'] - r['hermes_total_usd']:>+10.4f}")
    print()
    print("说明：Hermes 对未登记价格的模型记 0（status=unknown），hstats 按价格表估算。")
    print("      hstats 的数字更高是预期的——它没漏掉 MiniMax / gpt-5.6 这些模型。")
    return 0


def cmd_breakdown(days: int) -> int:
    for title, rows, key in (
        ("按模型", core.usage_by_model(days), "model"),
        ("按任务", core.usage_by_task(days), "task"),
        ("按来源", core.usage_by_source(days), "source"),
    ):
        print(f"=== {title} ===")
        for r in rows:
            name = str(r.get(key) or r.get("model") or r.get("source"))
            print(f"  {name:<32}{_fmt_int(r['input_tokens']):>14}"
                  f"{_fmt_int(r['output_tokens']):>13}{_fmt_int(r['cache_read_tokens']):>16}")
        print()
    day_rows = core.usage_by_day(days)
    print(f"=== 按天（共 {len(day_rows)} 天，仅列最近 7 天）===")
    for r in day_rows[-7:]:
        print(f"  {r['day']}  in={_fmt_int(r['input_tokens']):>12}  "
              f"out={_fmt_int(r['output_tokens']):>10}  sessions={r['sessions']}")
    return 0


def cmd_json(days: int) -> int:
    print(json.dumps({
        "health": core.check_health().as_dict(),
        "summary": core.usage_summary(days, True),
        "summary_main_only": core.usage_summary(days, False),
        "cost": cost.compute_cost(days),
        "compare": cost.compare_to_hermes(days),
        "by_model": core.usage_by_model(days),
        "by_task": core.usage_by_task(days),
        "by_source": core.usage_by_source(days),
        "by_day": core.usage_by_day(days),
    }, ensure_ascii=False, indent=2, default=str))
    return 0


_USAGE = """hstats —— Hermes 用量数据层

  python -m hstats health          数据健康检查（先证明可信）
  python -m hstats summary [days]  token 汇总
  python -m hstats cost [days]     成本明细
  python -m hstats compare [days]  与 Hermes 自记成本对照
  python -m hstats breakdown       分维度拆分
  python -m hstats json [days]     全部数据（JSON）

days 默认 30。只读 state.db，不写、不依赖 Hermes 运行时。
"""


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in ("-h", "--help", "help"):
        print(_USAGE)
        return 0
    cmd = args[0]
    rest = args[1:]
    days = int(rest[0]) if rest and rest[0].isdigit() else 30
    if cmd == "health":
        return cmd_health()
    if cmd == "summary":
        return cmd_summary(days)
    if cmd == "cost":
        return cmd_cost(days)
    if cmd == "compare":
        return cmd_compare(days)
    if cmd == "breakdown":
        return cmd_breakdown(days)
    if cmd == "json":
        return cmd_json(days)
    print(_USAGE)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())