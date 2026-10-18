---
title: hermes-stats · Hermes 用量统计
aliases: [Hermes stats, Hermes 统计, hstats]
type: doc
tags: [hermes, stats, cost, dashboard]
summary: "Hermes 用量与成本的统计系统：独立数据层 hstats + 只读网页看板，另有 Desktop 插件形态。"
created: "2026-10-10T00:00:00+08:00"
updated: "2026-10-12T20:20:00+08:00"
---

# hermes-stats · Hermes 用量统计

[English](README.en.md) | 中文

统计自己的 Hermes 到底花了多少钱、跑了多少 token、哪些模型在吃额度。

形态有两套，同一份数据层：

- **hstats**（推荐）——独立 Python 数据层 + CLI + 只读网页看板。**不依赖 Desktop**，
  平时开着就能查，网页 <http://127.0.0.1:8130/>。
- **Desktop 插件**——给 Hermes Desktop 用的统计页与底边栏 chip，通过官方插件机制实现。
  界面不如网页，数据层也仍是旧实现，**建议只把网页当主力**。

## 壹、快速开始

### 1、网页看板（推荐）

已装成开机自启的常驻服务，直接开浏览器即可：

```bash
# 打开
http://127.0.0.1:8130/

# 改完代码后重启
systemctl --user restart hstats-web

# 看状态 / 日志
systemctl --user status hstats-web
journalctl --user -u hstats-web -f
```

服务文件在 `~/.config/systemd/user/hstats-web.service`，随登录自启，崩溃会自动拉起。

> [!warning] 不要用临时脚本起服务
> 用 `python -m hstats.web &` 或脚本里 `subprocess` 拉起，进程会挂在启动它的那个
> 会话下，**会话一结束服务就被回收，表现为「网页挂了」**。这坑踩过一次，
> 排查后改成了 systemd user 服务。

首次安装（换机器或重装后）：

```bash
cd ~/workspace/projects/hermes-stats
python3 -m venv .venv && .venv/bin/pip install pyyaml
cp ~/.config/systemd/user/hstats-web.service /tmp/     # 若需重装，见下方「安装为常驻服务」
systemctl --user daemon-reload && systemctl --user enable --now hstats-web
```

### 2、命令行

```bash
cd ~/workspace/projects/hermes-stats

.venv/bin/python -m hstats health        # 健康检查（先证明数据可信）
.venv/bin/python -m hstats summary 30    # token 汇总
.venv/bin/python -m hstats cost 30       # 成本明细（按模型）
.venv/bin/python -m hstats compare 30    # 与 Hermes 自记成本对照
.venv/bin/python -m hstats breakdown     # 按模型/任务/来源/天拆分
.venv/bin/python -m hstats json 30       # 全部数据，喂给脚本
```

`days` 默认 30，取值 1–365。全程只读 `~/.hermes/state.db`。

## 贰、口径说明

这些口径不对齐，看出来的数字就会互相打架：

- **总 token 含辅助任务**（压缩、审批、视觉、后台复审），主任务与辅助任务都计入
- **缓存读（cache read）单列**，不混进「输入+输出」。提示词缓存每轮重读、量级巨大，
  混入会明显虚高（典型能占到总量九成以上）
- 每日成本的少数几天能占掉八成，线性轴会把其余日期全压在基线上，此时自动切**对数刻度**
  并在标题里说明——不默默换刻度让人误读
- 「等效成本」是**按官方 API 单价估算**的，不等于实际账单；你若用 Token Plan 或套餐，
  实付金额取决于套餐规则
- **Hermes 自记成本**一栏只作**下界**参考：Hermes 对未登记价格的模型一律记 0，
  所以它系统性偏低（当前约 ¥57，而自算是 ¥335）

## 叁、成本怎么算的

Hermes 自己记的 `estimated_cost_usd` 字段大面积是 `unknown`——MiniMax M3 / M3.1 全系列
都记成 0，看板会把真金白银显示成 `¥0`。本项目改为**自带价格表重算**：

- 价格表：`hstats/price_table.yaml`，手写维护，也欢迎让 LLM 协助更新
- 计费口径：`cost = (输入 × r_in + 输出 × r_out + 缓存读 × r_cache) / 1e6`（与 Hermes 官方一致）
- **取官方划线原价，不取当前促销价**。例如 MiniMax-M3 现在长期 5 折（$0.30/$1.20/$0.06），
  本表记的是划线原价 $0.60/$2.40/$0.12——折算的是「按量付费要花多少」，
  避免折扣取消后数字凭空翻倍
- `MiniMax-M3.1-Flash-Preview` 官方尚未公布 API 定价，暂按 M3 原价估算，页面标注「估算」。
  Flash 定位比 M3 便宜，故此估算偏保守（偏高），属安全侧
- 本地端点（**仅 ollama :11434**）按 0 计；第三方中转站（poke2api、opencode-go）单价随套餐浮动，标「中转站」不估
- **查不到价的显示 `—`，不显示 `0`**。没有价格 ≠ 价格是 0

### 1、峰谷价与历史调价

**峰谷价**：DeepSeek 自 2026-08-16 起实行峰谷价，**峰价为谷价 2 倍**。
峰时段 = UTC 周一至周五 01:00–04:00 与 06:00–10:00（**北京时间 09–12 点、14–18 点**）；
周末与中国法定节假日全天为谷。价格表里填的是**峰价**，引擎按每条记录的调用时刻自动判峰/谷取值。

**历史调价**：用今天的价格算上个月的用量是错的。价格表的 `price_history` 段按生效日分段登记，
引擎按调用时刻取当时那档。选档规则：`from ≤ 调用日期 < until` 的最新一段命中则用历史价，
否则用 `models:` 里的当前价。

```yaml
price_history:
  deepseek-v4-flash:
    - from: "2026-08-16"
      until: "2026-09-10"
      time_tier: deepseek_peak_offpeak
      peak:     { input: 0.44, output: 1.32, cache_read: 0.014 }
      off_peak: { input: 0.22, output: 0.66,  cache_read: 0.007 }
    - from: "2026-09-10"          # 至今
      time_tier: deepseek_peak_offpeak
      peak:     { input: 0.30, output: 1.20, cache_read: 0.006 }
      off_peak: { input: 0.15, output: 0.60, cache_read: 0.003 }
```

**官方调价后要做的**：往 `price_history` 加一段，`from` 填公告生效日，并把 `models:` 改成同一组数字（保持同步）。
页面「价格来源」区块会把这些区间列出来，可当场核对。

### 2、改价 / 加模型

编辑 `hstats/price_table.yaml`（Desktop 插件那侧的发布源在 `plugin/dashboard/price_table.yaml`，
两边内容需同步），存盘即生效，刷新网页即可，无需改代码：

```yaml
models:
  新模型名:
    input: 0.60          # USD / 每百万 token
    output: 2.40
    cache_read: 0.12
    confidence: official  # official 官方价 / estimate 估算 / unknown 查不到
    source: "https://..."
    checked: "2026-10-10"
    note: "为什么是这个价"
```

模型名匹配不上表里的条目时，按 `aliases` 段从上往下第一条命中的正则兜底。新增端点前缀、模型改名等只需加一行 alias。

### 3、关于「本地」

`free_hosts` 只列**真在本机跑权重**的端点（当前只有 ollama :11434），这些按 ¥0 计但 token 照记。

> [!warning] 别把本机监听的代理端口也算成本地
> 历史上 `localhost:4000`（litellm）和 `localhost:20128`（all-in-one 聚合路由）都曾记录过，
> 但它们只是转发到付费模型——MiniMax-M3 经 4000 就转发了 4218 万 token，照样花钱。
> 判定逻辑只认真实 endpoint，新增本机推理端点时确认没接付费上游再加入。

### 4、已知仍会算不准的地方

- 一天之内若跨越调价日或峰谷切换，那天按最早一条记录判档，误差在一天量级内
- 中国法定节假日表未维护，落在节假日的调用按工作日峰/谷算
- `session_model_usage` 只记 token 不记当时的成交价，这是 Hermes 的存储设计，改不了；
  只能靠上面这套时间分段逼近

## 肆、网页看板

- **零依赖**：图表全是手写 SVG，不引 Chart.js 之类
- 配色为浅色 + 绿色系，参考 Wise 设计规范
- 卡片间距 28px，卡内标题与内容再留 20px
- 「按来源 / 按任务 / 按模型」用环形饼图；扇区超 6 个自动退回横条（再多没人能一眼分清）
- 活跃热力图有**自己的时间按钮**（一年 / 半年 / 季度），不跟顶部 7/30/90 联动

端点：

| 路径 | 用途 |
|---|---|
| `/` | 网页 |
| `/api/stats?days=30` | 主数据：健康检查、汇总、成本、分维度拆分、价格表、汇率 |
| `/api/activity?days=365` | 每日 token（供热力图） |
| `/api/health` | 仅健康检查（脚本 / CI 用） |
| `/static/*` | css / js（带目录穿越防护） |

只绑 `127.0.0.1`，不开 CORS。这是本机个人用的统计页——**需要局域网访问时必须先加鉴权**，
别直接把端口放出去。

详见 [hstats/web/README.md](hstats/web/README.md)。

## 伍、Desktop 插件（可选）

给喜欢在 Desktop 里看的人保留，通过**官方插件机制**实现，零核心代码改动。

### 1、安装

```bash
cd hermes-stats
cp -r plugin/. ~/.hermes/plugins/hermes-stats/        # 拷入插件内容（注意末尾的 /.）
hermes config set plugins.enabled '["hermes-stats"]'  # 开启后端数据端点
```

改完配置后**重启 Hermes Desktop**，后端半（/stats /cron /system 端点）即挂载。

### 2、使用

- 左侧边栏出现「**统计**」入口，或按 ⌘K 输入「统计中心」打开页面
- 底部状态栏右侧出现 `⚡ 今日…` 与 `📏 ctx…` 两个 chip，点击即跳统计页
- 页内可切换 7 / 30 / 90 天窗口，点「刷新」手动更新数据

### 3、开关

- **Desktop 半**（统计页 / chip / ⌘K）：Settings → Plugins 面板，每插件一行开关，**即时生效，无需重启**
- **后端半**（/stats /cron /system 数据端点）：`config.yaml → plugins.enabled`，改动后重启 gateway 生效

完全停用 = 面板关掉（立即）+ `hermes config set plugins.enabled '[]'`（下次重启生效）。

### 4、架构

```
~/.hermes/plugins/hermes-stats/
├── dashboard/manifest.json     # 插件清单（name + Python 后端入口）
├── dashboard/plugin_api.py     # FastAPI 端点 /stats /cron /system /pricing
├── dashboard/pricing.py       # 价格引擎：按 price_table.yaml 重算成本
├── dashboard/price_table.yaml  # 手写价格表
└── desktop/plugin.js           # Electron 渲染端：页面 + 状态栏 chip + ⌘K + i18n
```

> [!warning] 改后端后要同步到 `~/.hermes/plugins/hermes-stats/` 并**重启 Desktop**（gateway）。

## 陆、开发与自检

```bash
# 数据层自检（52 项：价格表 / 峰谷 / 口径 / 成本 / 每日自洽）
PYTHONPATH=. .venv/bin/python -m hstats.selftest

# 前端语法
node --check hstats/web/app.js
```

以下为插件开发者向（普通安装可忽略）：

- `dev/hs-render-test/`：真实数据 + React SSR 冒烟测试——保存代码前跑 `node smoke.mjs`，把「页面打开才炸」变成「保存前就能验」
- `dev/preview/render-preview.mjs`：生成 README 预览图（合成数据，不泄露真实用量）

改完前端想快速看一眼：

```bash
google-chrome-stable --headless --disable-gpu --no-sandbox \
  --virtual-time-budget=12000 --screenshot=/tmp/hs.png \
  --window-size=1280,2400 http://127.0.0.1:8130/
```

> [!tip] 验数字要看 DOM，不要只截图
> 开发中出现过截图「一片空白」实为 CSS 类名拼错的情况；而真正的问题（占比除错分母、
> 对数刻度画成了线性）也是靠算术复核才发现的。截图适合看布局，数字要验算：
> `google-chrome-stable --headless --dump-dom http://127.0.0.1:8130/`

## 柒、数据层为什么独立

`hstats/` 原本是 Desktop 的一个插件后端，那带来三个问题，都不是数据本身的问题：

1. 改后端必须重启 Desktop 才生效，而且曾多次重启无效
2. 插件宿主的模块搜索路径不含插件目录，`import pricing` 静默失败，
   页面于是显示错误的成本却毫无提示
3. 想查数据就得开着 Desktop

独立之后，同一份代码可以被 CLI、cron、网页、任何脚本直接调用，且**只读** `~/.hermes/state.db`，
永不写入生产库。详见 [hstats/README.md](hstats/README.md)。

## 捌、已知边界

- Desktop 插件依赖 Hermes Desktop 运行时插件 SDK；若 SDK 行为变化需同步适配
- 网页只读本机数据库，不写、不上传任何数据

## 玖、License

MIT — 见 [LICENSE](LICENSE)
