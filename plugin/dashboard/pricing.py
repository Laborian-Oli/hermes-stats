"""hermes-stats 价格引擎 —— 按自带 price_table.yaml 估算等效成本。

为什么不直接用 state.db 里 Hermes 自己记的 estimated_cost_usd：
实测那条字段大面积是 unknown/none（MiniMax M3、M3.1、gpt-5.6 全系列都是 0），
且把 Hermes 的 estimate_usage_cost() 重跑一遍也复现不出已存的数字。
所以这里自己按 token × 单价算，口径可控、可随价格表更新而变。

计费口径（与 Hermes 官方一致，三项相加）：
    cost = (input × r_in + output × r_out + cache_read × r_cache) / 1e6

价格表刻意取「官方划线原价」而非当前促销价：折算的是按量付费要花多少，
避免折扣取消后数字凭空翻倍。详见 price_table.yaml 里的说明。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

_PRICE_FILE = Path(__file__).parent / "price_table.yaml"
_MILLION = 1_000_000

# 中文标签：页面直接拿去显示，状态一目了然
STATUS_LABELS = {
    "official": "官方价",
    "estimate": "估算",
    "free": "本地免费",
    "relay": "中转站",
    "unknown": "无价格",
}


@dataclass(frozen=True)
class Rate:
    """某个模型在某时刻的三项单价，单位 USD / 每百万 token。"""
    key: str
    input: Optional[float]
    output: Optional[float]
    cache_read: Optional[float]
    cache_write: Optional[float]
    confidence: str
    status: str
    note: str = ""
    source: str = ""
    checked: str = ""
    # 峰谷：本次取值落在哪一档（peak / off_peak / 固定价时为 None）
    tier: Optional[str] = None
    # 这一档价从哪来：'current' 直接取 models，'history' 取自 price_history
    priced_from: str = "current"


def is_deepseek_peak(ts: float) -> bool:
    """DeepSeek 峰时段判定（UTC）。峰价为谷价 2 倍。

    官方规则：UTC 周一至周五 01:00-04:00 与 06:00-10:00 为峰；
    周末与中国法定节假日全天为谷。法定节假日表不在此维护——
    落在节假日的少量调用会按工作日峰/谷算，误差可接受。
    """
    dt = datetime.fromtimestamp(ts, timezone.utc)
    if dt.weekday() >= 5:                      # 5=周六 6=周日
        return False
    return (1 <= dt.hour < 4) or (6 <= dt.hour < 10)


def _history_entry(key: str, ts: Optional[float]) -> Optional[dict]:
    """挑出该模型在 ts 时刻生效的那一档历史价。"""
    history = (_load_raw().get("price_history") or {}).get(key)
    if not history or ts is None:
        return None
    day = datetime.fromtimestamp(ts, timezone.utc).date()
    chosen = None
    for entry in history:
        start = entry.get("from")
        if not start:
            continue
        try:
            start_day = date.fromisoformat(str(start))
        except ValueError:
            continue
        if start_day > day:
            continue
        until = entry.get("until")
        if until:
            try:
                if day >= date.fromisoformat(str(until)):
                    continue
            except ValueError:
                pass
        if chosen is None or str(start) > str(chosen.get("from")):
            chosen = entry
    return chosen


@dataclass
class CostRollup:
    """一次聚合的成本结果。"""
    cost_usd: float = 0.0
    priced_tokens: int = 0
    total_tokens: int = 0
    missing_models: dict[str, int] = field(default_factory=dict)
    status: str = "official"

    @property
    def coverage(self) -> float:
        """已定价 token 占全部 token 的比例，0~1。"""
        return self.priced_tokens / self.total_tokens if self.total_tokens else 0.0


@lru_cache(maxsize=1)
def _load_raw() -> dict:
    import yaml

    with open(_PRICE_FILE, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _compiled_aliases() -> list[tuple[re.Pattern, str, Optional[str]]]:
    out = []
    for rule in _load_raw().get("aliases") or []:
        try:
            out.append((re.compile(rule["match"], re.I), rule.get("why", ""), rule.get("use")))
        except (re.error, KeyError, TypeError):
            continue
    return out


def _netloc(value: str) -> str:
    """把 base_url 或 host 串统一成 `host:port`（小写、补默认端口），用于精确比对。"""
    v = (value or "").strip().lower()
    if "://" in v:
        v = urlsplit(v).netloc
    v = v.split("/", 1)[0]
    if not v:
        return ""
    if ":" not in v:
        v += ":443" if value.strip().lower().startswith("https") else ":80"
    return v


def _is_free_host(base_url: Optional[str]) -> bool:
    """真本地推理端点（ollama 等）不花钱，但 token 照记。

    判定要 host:port 全等匹配，不能用子串包含 —— `localhost:4000` 会被
    `localhost` 匹配上，但那是转发到付费模型的 litellm 代理，照样花钱。
    """
    if not base_url:
        return False
    netloc = _netloc(base_url)
    if not netloc:
        return False
    return netloc in {_netloc(h) for h in (_load_raw().get("free_hosts") or []) if h}


def _is_relay(base_url: Optional[str]) -> bool:
    if not base_url:
        return False
    relays = _load_raw().get("relay_providers") or []
    return any(r and r in base_url for r in relays)


def _resolve_key(model: Optional[str]) -> Optional[str]:
    """模型名 → 价格表 key。先精确匹配，再走别名规则。"""
    models = _load_raw().get("models") or {}
    if not model:
        return None
    name = model.strip()
    if name in models:
        return name
    low = name.lower()
    if low in models:
        return low
    # 小写形式再找一次（表里的 key 都是小写）
    for k in models:
        if k.lower() == low:
            return k
    for pattern, _why, target in _compiled_aliases():
        if pattern.search(name):
            return target
    return None


def lookup(model: Optional[str], base_url: Optional[str] = None,
           ts: Optional[float] = None) -> Rate:
    """查一次调用的费率。顺序：本地免费 → 中转站 → 历史价 → 精确价 → 别名 → 未知。

    ts 是这次调用的时间戳（epoch 秒）。给了才能应用两类规则：
      1. 峰谷价：DeepSeek 按时段翻倍，按调用时刻判峰/谷
      2. 历史价：官方调过价时，按调用时刻取当时那档，而不是今天这档
    """
    if _is_free_host(base_url):
        return Rate("__free__", 0.0, 0.0, 0.0, 0.0, "free", "free",
                    note="本地端点，不产生 API 费用")
    if _is_relay(base_url):
        return Rate("__relay__", None, None, None, None, "relay", "relay",
                    note="第三方中转站，单价随套餐浮动，不估")

    key = _resolve_key(model)
    if key is None:
        return Rate("__unknown__", None, None, None, None, "unknown", "unknown",
                    note="价格表里没有这个模型")
    entry = (_load_raw().get("models") or {}).get(key) or {}
    conf = entry.get("confidence", "unknown")
    note = str(entry.get("note") or "").strip()

    # 1) 历史价优先：调用时刻若早于当前价生效日，用当时那档
    hist = _history_entry(key, ts)
    src: dict = entry
    priced_from = "current"
    if hist is not None:
        src = hist
        priced_from = "history"
        note = str(hist.get("note") or note).strip()

    # 2) 峰谷价：按调用时刻落在峰时段还是谷时段取对应档
    tier: Optional[str] = None
    if entry.get("time_tier") == "deepseek_peak_offpeak" and ts is not None:
        tier = "peak" if is_deepseek_peak(ts) else "off_peak"
        band = (src.get(tier) or {}) if isinstance(src.get(tier), dict) else {}
        if band:
            src = {**{k: v for k, v in src.items() if k not in ("peak", "off_peak")}, **band}

    return Rate(
        key=key,
        input=src.get("input"),
        output=src.get("output"),
        cache_read=src.get("cache_read"),
        cache_write=src.get("cache_write"),
        confidence=conf,
        status=conf,
        note=note,
        source=str(entry.get("source") or ""),
        checked=str(entry.get("checked") or ""),
        tier=tier,
        priced_from=priced_from,
    )


def compute(input_tokens: int = 0, output_tokens: int = 0, cache_read: int = 0,
            cache_write: int = 0, rate: Optional[Rate] = None) -> float:
    """按费率算成本（USD）。缓存读占绝大多数，所以它的单价直接决定总账。"""
    if rate is None or rate.input is None:
        return 0.0
    total = 0.0
    for tokens, unit in (
        (input_tokens, rate.input),
        (output_tokens, rate.output),
        (cache_read, rate.cache_read),
        (cache_write, rate.cache_write),
    ):
        # 某项没有单价但确实有量 → 记 0 会在页面上骗人，交给上层按 unknown 处理
        if tokens and unit is None:
            return 0.0
        if tokens and unit:
            total += tokens * unit / _MILLION
    return total


def is_priced(rate: Rate) -> bool:
    return rate.status in ("official", "estimate", "free")


def table_status() -> dict:
    """给 /stats 页面附带的元信息：价格表版本、覆盖情况、每条价格的出处。"""
    raw = _load_raw()
    models = raw.get("models") or {}
    return {
        "version": raw.get("version"),
        "updated": raw.get("updated"),
        "currency": "USD",
        "labels": STATUS_LABELS,
        "entries": [
            {
                "key": k,
                "input": v.get("input"),
                "output": v.get("output"),
                "cache_read": v.get("cache_read"),
                "confidence": v.get("confidence", "unknown"),
                "note": str(v.get("note") or "").strip(),
                "source": v.get("source", ""),
                "checked": v.get("checked", ""),
                "time_tier": v.get("time_tier"),
                "peak": v.get("peak"),
                "off_peak": v.get("off_peak"),
            }
            for k, v in models.items() if not v.get("hidden")
        ],
        "alias_rules": [
            {"match": r.get("match"), "use": r.get("use"), "why": r.get("why", "")}
            for r in (raw.get("aliases") or [])
        ],
        "price_history": {
            k: [
                {
                    "from": e.get("from"),
                    "until": e.get("until"),
                    "note": str(e.get("note") or "").strip(),
                }
                for e in (v or [])
            ]
            for k, v in (raw.get("price_history") or {}).items()
        },
    }