---
title: hstats —— 数据层
aliases: [hstats, Hermes 数据层]
type: doc
tags: [hermes, stats]
summary: "Hermes 用量与成本的独立只读数据层：不依赖 Desktop，可被 CLI/cron/网页直接调用。"
created: "2026-10-11T00:00:00+08:00"
updated: "2026-10-12T20:20:00+08:00"
---

# hstats —— 数据层

Hermes 用量与成本的独立数据层。**只读** `~/.hermes/state.db`，不写、不依赖
Hermes Desktop、不依赖 gateway。

## 壹、为什么独立

它原本是 Hermes Desktop 的一个插件后端。那带来三个问题，都不是数据本身的问题：

1. 改后端必须重启 Desktop 才生效，而且曾多次重启无效
2. 插件宿主的模块搜索路径不含插件目录，`import pricing` 静默失败，
   页面于是显示错误的成本却毫无提示
3. 想查数据就得开着 Desktop

独立之后，同一份代码可以被 CLI、cron、网页、任何脚本直接调用。

## 贰、跑

```bash
cd ~/workspace/projects/hermes-stats
.venv/bin/python -m hstats health        # 数据健康检查（先证明可信）
.venv/bin/python -m hstats summary 30   # token 汇总
.venv/bin/python -m hstats cost 30      # 成本明细
.venv/bin/python -m hstats compare 30   # 与 Hermes 自记成本对照
.venv/bin/python -m hstats breakdown    # 按模型/任务/来源/天拆分
.venv/bin/python -m hstats json 30      # 全部数据（JSON）
.venv/bin/python -m hstats.selftest     # 回归测试（49 项）
```

`health` 返回非 0 表示数据不可信，此时任何下游数字都不该用。

## 叁、结构

| 文件 | 职责 |
|---|---|
| `core.py` | 读原始用量、健康检查、四个维度拆分。**不碰价格** |
| `cost.py` | 在 core 的数字上套价格表算钱。**不改口径** |
| `pricing.py` | 价格表解析、峰谷判定、历史选档 |
| `price_table.yaml` | 手写价格表，改价只动这里 |
| `selftest.py` | 回归测试 |
| `__main__.py` | CLI |

拆开的原因：价格会变（峰谷、调价），用量口径不该跟着变。改价格只动
`price_table.yaml`，改口径只动 `core.py`，互不干扰。

## 肆、口径（都写在代码注释里，可核对）

**数据源**：`session_model_usage` 是 token 的唯一真源；`sessions` 表的汇总
由它派生，`check_health` 会断言两者恒等。

**辅助任务**：`task` 字段为空是主对话，其余（approval / compression /
vision / title_generation / background_review）是辅助任务。按 2026-10-10 的
决定**默认计入**总 Token 与成本——这些调用同样花钱。实测约占输入的 13%。
`include_aux=False` 可切回仅主任务。

**时间窗**：按 `last_seen`（本次调用的时刻）过滤，不是 `started_at`。
长会话的开始时间可能落在窗口外但窗口内有调用，按 `last_seen` 才不会漏。
这使本层比 Hermes 官方 `totals` 多算约 5%——差额正是那些跨窗长会话，
属于本层更合理，不是错误。

**峰谷价**：DeepSeek 峰价为谷价 2 倍，峰时段为 UTC 周一至周五
01:00–04:00 与 06:00–10:00（北京时间 09–12、14–18）。按每条记录的调用
时刻判定，汇总粒度取「天 × 星期」。

**历史调价**：`price_table.yaml` 的 `price_history` 段按生效日登记，
按调用日期取当时那档价。

**误差方向**：拿不准时取高的一档（用户 2026-10-11 要求「宁可高估不要低估」）。
中国法定节假日未维护，落在节假日的调用会按工作日判峰，方向恰好是高估。

**未定价不冒充 0**：查不到价的模型单独列在 `unpriced` 里，不进总额。
第三方中转站（单价随套餐浮动）标 relay 不估。真本地推理端点（ollama:11434）
按 0 计但 token 照记——注意别把本机监听的 litellm/聚合路由端口也算成免费，
那些只是转发到付费模型。

## 伍、与 Hermes 自记成本的差异

`compare` 命令会逐模型列出对照。实测 30 天：

| 模型 | Hermes | hstats | 说明 |
|---|---|---|---|
| MiniMax-M3.1 | 0 | 22.65 | Hermes 未登记该模型价格，记 0 |
| deepseek-flash | 8.31 | 12.23 | Hermes 只算了谷价，hstats 按时段精确定价 |
| 合计 | 8.34 | 34.92 | |

hstats 更高是预期的：它没漏掉 MiniMax 与 gpt-5.6，且峰时段按峰价计。
Hermes 的数字可以用作下界参考，不能当账单。

## 陆、已知边界

- `session_model_usage` 只记 token 不记当时的成交价（Hermes 的存储设计，
  改不了）。历史价靠 `price_history` 逼近，不是还原。
- 一天内跨越调价日或峰谷切换时，按当天最早一条记录判档，误差在一天量级内。
- 中国法定节假日表未维护。
- 中转站（poke2api / opencode-go）按月费或倍率计费，单价不稳定，一律不估。

## 柒、依赖

只需 PyYAML（本项目 `.venv/` 已装）。不依赖 Hermes 包、fastapi 或任何
Desktop 运行时——已用 `sys.path` 检查与项目外运行验证。