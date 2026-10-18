"""hstats 数据层回归测试。

重点不是覆盖率，是守住三件「错了就静默算错钱」的事：
  1. 价格表格式正确（解析结果符合预期结构）
  2. 峰谷判定与历史调价选档正确（时间相关逻辑最容易悄悄退化）
  3. 数据口径自洽（含辅助 vs 仅主任务、时间窗不被 OR 绕过）

跑：.venv/bin/python -m hstats.selftest
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone

from . import core, cost, pricing

_FAILED: list[str] = []
_PASSED = 0


def check(label: str, got, want) -> None:
    global _PASSED
    if got == want:
        _PASSED += 1
        print(f"  ✓ {label}")
    else:
        _FAILED.append(f"{label}: got={got!r} want={want!r}")
        print(f"  ✗ {label}\n      实得 {got!r}\n      期望 {want!r}")


def ts(y, m, d, hh=0, mm=0) -> float:
    return datetime(y, m, d, hh, mm, tzinfo=timezone.utc).timestamp()


# --------------------------------------------------------------------------- 价格表


def test_price_table() -> None:
    print("\n=== 价格表结构 ===")
    raw = pricing._load_raw()
    check("有 models 段", isinstance(raw.get("models"), dict), True)
    check("deepseek-flash 在表内", "deepseek-flash" in raw["models"], True)

    ds = raw["models"]["deepseek-flash"]
    check("填的是峰价（基准）", ds["input"], 0.30)
    check("off_peak 是峰价的一半", ds["off_peak"]["input"], 0.15)
    check("标记为峰谷价", ds.get("time_tier"), "deepseek_peak_offpeak")

    check("有历史价段", "deepseek-v4-flash" in (raw.get("price_history") or {}), True)
    check("free_hosts 只含 ollama",
          any("11434" in h for h in raw.get("free_hosts", [])), True)
    check("代理端口未混入 free_hosts",
          any("4000" in h for h in raw.get("free_hosts", [])), False)


def test_peak_rules() -> None:
    print("\n=== 峰谷判定 ===")
    # 2026-10-06 是周二
    check("周二 UTC02:00 是峰", pricing.is_deepseek_peak(ts(2026, 10, 6, 2)), True)
    check("周二 UTC04:00 是谷（边界后）", pricing.is_deepseek_peak(ts(2026, 10, 6, 4)), False)
    check("周二 UTC07:00 是峰", pricing.is_deepseek_peak(ts(2026, 10, 6, 7)), True)
    check("周二 UTC10:00 是谷（边界后）", pricing.is_deepseek_peak(ts(2026, 10, 6, 10)), False)
    check("周二 UTC13:00 是谷", pricing.is_deepseek_peak(ts(2026, 10, 6, 13)), False)
    # 2026-10-10 是周六
    check("周六 UTC02:00 是谷（周末全天谷）", pricing.is_deepseek_peak(ts(2026, 10, 10, 2)), False)
    check("周日 UTC07:00 是谷", pricing.is_deepseek_peak(ts(2026, 10, 11, 7)), False)


def test_rate_lookup() -> None:
    print("\n=== 取价：峰谷 + 历史 + 端点 ===")
    url = "https://api.deepseek.com/v1"

    r = pricing.lookup("deepseek-flash", url, ts=ts(2026, 10, 6, 2))
    check("工作日峰时取峰价", r.input, 0.30)
    r = pricing.lookup("deepseek-flash", url, ts=ts(2026, 10, 6, 13))
    check("工作日谷时取谷价", r.input, 0.15)
    r = pricing.lookup("deepseek-flash", url, ts=ts(2026, 10, 10, 7))
    check("周末取谷价", r.input, 0.15)

    # 历史价：deepseek-v4-flash 在 2026-08-16~09-10 是更贵的一档
    r = pricing.lookup("deepseek-v4-flash", url, ts=ts(2026, 8, 20, 2))
    check("调价前取历史价", r.input, 0.44)
    check("标记为来自 history", r.priced_from, "history")
    r = pricing.lookup("deepseek-v4-flash", url, ts=ts(2026, 10, 6, 2))
    check("调价后取现价", r.input, 0.30)

    # 端点判定：真本地免费，代理不免费
    r = pricing.lookup("qwen3.5:9b", "http://localhost:11434/v1")
    check("ollama 算本地免费", r.status, "free")
    r = pricing.lookup("MiniMax-M3", "http://localhost:4000/v1", ts=ts(2026, 10, 6, 2))
    check("litellm 代理不免费", r.status != "free", True)
    r = pricing.lookup("gpt-5.6-terra", "https://www.poke2api.com/v1")
    check("中转站标 relay", r.status, "relay")
    r = pricing.lookup("某个没见过的模型", url)
    check("未知模型标 unknown", r.status, "unknown")


def test_cost_math() -> None:
    print("\n=== 成本公式 ===")
    r = pricing.lookup("deepseek-flash", "https://api.deepseek.com/v1", ts=ts(2026, 10, 6, 13))
    # 谷价：100万 in + 100万 out + 100万 cache_read = .15 + .60 + .003
    got = pricing.compute(1_000_000, 1_000_000, 1_000_000, 0, r)
    check("三项相加", round(got, 6), round(0.15 + 0.60 + 0.003, 6))
    check("零 token 得零成本", pricing.compute(0, 0, 0, 0, r), 0.0)
    check("未定价模型算不出钱",
          pricing.compute(1000, 1000, 1000, 0, pricing.lookup("无此模型", None)), 0.0)


def test_unknown_not_zero() -> None:
    print("\n=== 未定价不冒充 0 ===")
    r = pricing.lookup("gpt-5.6-terra", "https://www.poke2api.com/v1")
    check("中转站 is_priced 为假", pricing.is_priced(r), False)
    check("中转站算不出钱", pricing.compute(1_000_000, 1_000_000, 0, 0, r), 0.0)


# --------------------------------------------------------------------------- 数据口径


def test_data_scope() -> None:
    print("\n=== 数据口径（真实库）===")
    with_aux = core.usage_summary(30, True)
    main_only = core.usage_summary(30, False)
    check("含辅助 ≥ 仅主任务", with_aux["input_tokens"] >= main_only["input_tokens"], True)
    # 主任务占比应在 70%~95% 之间（即辅助占 5%~30%）。
    # 注意是主/含，不是含/主——写反会让 13% 的辅助看起来像 87%。
    main_share = main_only["input_tokens"] / with_aux["input_tokens"]
    check("主任务占比 70%~95%", 0.70 < main_share < 0.95, True)
    check("30 天不超过全历史", with_aux["input_tokens"] < 130_000_000, True)

    # 时间窗必须真的生效：1 天窗口的量必须远小于 30 天
    d1 = core.usage_summary(1, True)
    check("1 天量远小于 30 天", d1["input_tokens"] < with_aux["input_tokens"], True)

    tasks = {t["task"] for t in core.usage_by_task(30)}
    check("含主对话任务", "(主对话)" in tasks, True)
    check("含辅助任务类型", len(tasks) > 1, True)

    by_model = core.usage_by_model(30)
    check("按模型能拆开", len(by_model) >= 3, True)
    check("按来源能拆开", len(core.usage_by_source(30)) >= 3, True)


def test_health() -> None:
    print("\n=== 健康检查 ===")
    h = core.check_health()
    check("汇总一致", h.totals_match, True)
    check("无孤儿行", h.orphan_rows, 0)
    check("无空模型", h.null_model_rows, 0)
    check("无负值", h.negative_token_rows, 0)
    check("数据新鲜（<30 分钟）", h.latest_usage_age_min < 30, True)
    check("整体健康", h.ok, True)


def test_cost_coverage() -> None:
    print("\n=== 成本覆盖率 ===")
    c = cost.compute_cost(30)
    check("有成本产出", c["cost_usd"] > 0, True)
    check("覆盖率在 0~1", 0 < c["coverage"] <= 1, True)
    check("覆盖率高（>90%）", c["coverage"] > 0.90, True)
    check("未定价单列而非混进总额", isinstance(c["unpriced"], list), True)
    cmp_ = cost.compare_to_hermes(30)
    check("自算高于 Hermes 自记（Hermes 对未登记价记 0）",
          cmp_["hstats_total_usd"] > cmp_["hermes_total_usd"], True)


def test_daily_sums_to_total() -> None:
    """每日序列必须精确加总到总计。

    两个查询按不同维度分组，若一边取 UTC、一边取本地时区，跨 UTC 零点的
    记录会被分到不同日期，图上「每日合计」就对不上卡片金额——而标题偏偏
    写着「合计即上方卡片金额」。这个断言就是守住那行标题的。
    """
    print("\n=== 每日序列自洽 ===")
    for days in (7, 30, 90):
        c = cost.compute_cost(days)
        s = sum(x["cost_usd"] for x in c["daily"])
        gap = abs(c["cost_usd"] - s)
        check(f"{days} 天：每日合计 == 总计（差 < $0.01）", gap < 0.01, True)


def main() -> int:
    for fn in (test_price_table, test_peak_rules, test_rate_lookup, test_cost_math,
               test_unknown_not_zero, test_data_scope, test_health, test_cost_coverage,
               test_daily_sums_to_total):
        fn()
    print()
    if _FAILED:
        print(f"失败 {len(_FAILED)} 项 / 共 {_PASSED + len(_FAILED)} 项")
        for f in _FAILED:
            print(f"  - {f}")
        return 1
    print(f"全部通过：{_PASSED} 项")
    return 0


if __name__ == "__main__":
    sys.exit(main())