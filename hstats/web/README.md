---
title: hstats 网页端
aliases: [hstats web, 用量看板]
type: doc
tags: [hermes, stats, dashboard]
summary: "hstats 的只读网页看板：手写 SVG 图表、零前端依赖，systemd 常驻于 127.0.0.1:8130。"
created: "2026-10-11T00:00:00+08:00"
updated: "2026-10-12T20:20:00+08:00"
---

# hstats 网页端

独立网页，不依赖 Hermes Desktop，也不需要开着 Desktop 才能看。

## 壹、起服务

**推荐：走 systemd user 服务**（已装成自启，会话结束不受影响）

```bash
systemctl --user restart hstats-web     # 改完代码重启
systemctl --user status hstats-web      # 看状态
journalctl --user -u hstats-web -f      # 看日志
```

服务文件 `~/.config/systemd/user/hstats-web.service`，首次安装或换机器时：

```bash
cp ~/.config/systemd/user/hstats-web.service ~/.config/systemd/user/   # 若尚未就位
systemctl --user daemon-reload && systemctl --user enable --now hstats-web
```

> [!warning] 不要用临时脚本起服务
> `python -m hstats.web &` 或脚本里 `subprocess` 拉起的进程，会挂在启动它的那个
> 会话下，**会话一结束就被回收，表现为「网页挂了」**。这坑踩过一次，改 systemd 解决。

临时前台跑（调试用，Ctrl-C 结束）：

```bash
cd ~/workspace/projects/hermes-stats
PYTHONPATH=. .venv/bin/python -m hstats.web            # 默认 127.0.0.1:8130
PYTHONPATH=. .venv/bin/python -m hstats.web --port 9000
```

浏览器打开 <http://127.0.0.1:8130/>

只绑 `127.0.0.1`，不开 CORS（浏览器同源即可）。这是本机个人用的统计页——
**需要局域网访问时必须先加鉴权**，别直接把端口放出去。

## 贰、端点

| 路径 | 用途 |
|---|---|
| `/` | 网页 |
| `/api/stats?days=30` | 主数据：健康检查、汇总、成本、分维度拆分、价格表、汇率 |
| `/api/activity?days=365` | 一年每日 token（供热力图；不跟主窗口联动） |
| `/api/health` | 仅健康检查（脚本/CI 用） |
| `/static/*` | css / js（带目录穿越防护） |

`days` 取值 1–365，`aux=0` 可切回「仅主任务」口径。响应带 5 秒缓存，
避免刷新页面时反复扫 296MB 的库。

## 叁、设计参照

配色与布局参考 Wise 设计系统的**浅色 + 绿色系**（早期版本是暗色蓝系，已改）：

- 白底 `#ffffff`、次级面 `#f2f5f1`、主强调绿 `#1f9d55`、次级绿 `#4cbb7a`、青绿 `#0f9b8e`
- 近黑墨字带绿 undertone `#0e1a10`、分隔线 `#e3e8e2`
- 14px 圆角卡片、胶囊按钮；**间距一律走 CSS 变量**：卡片间距 28px、
  卡内标题与内容 20px、卡内分图 28px
- 日历热力图参照 GitHub 贡献图那种年历，格子间距 2px（连成一片，不是一颗颗孤立小方块）

## 肆、实现上的几个决定

**零依赖**：图表全是手写 SVG，不引 Chart.js 之类。少一层依赖就少一处
「环境变了图就画不出来」的风险；代价是网格、tooltip、坐标轴都得自己写。

**成本全程用 USD 算账，人民币只在最后一步显示。** 汇率由服务端下发，
拿不到时页面退回 USD 并明示，不拿猜的常数折成 ¥——猜出来的「人民币金额」
比诚实的美元数字更糟。

**每个数字都标明口径。** 这一版踩过的坑几乎都是口径没说清：

- 覆盖率必须写清分母（是全部 token 含缓存，不是只算输入输出）
- 模型表的 Tokens 含缓存读，KPI 卡的 Tokens 不含——两者差 30 倍，
  不写清楚就像 bug
- 价格表那栏是「价格表 key」（小写连字符，为便于正则匹配），
  与上面表格的厂商原名是两套命名
- 同一模型混了已定价与未定价端点时（qwen 经 ollama 免费、另有一档查不到价），
  标「混合口径」并列出未计 token 数

**偏态数据不硬套线性轴。** 每日成本里少数几天占大头，线性轴会把其余日期
全压在基线、浪费八成画布，此时自动切对数并**在标题里说明**——不默默换
刻度让人误读。对数轴的 0 无意义，统一抬到 1，刻度在对数空间等距。

**0 值不画假柱子。** 值 0 时画 1px 的柱子会被误读成「每天都有小额消费」。

**分布图里小于 1% 的项合并成「其他 N 项」。** 一排看不见的条只会让人
以为是空数据。

## 伍、自检

```bash
PYTHONPATH=. .venv/bin/python -m hstats.selftest     # 52 项，覆盖价格表/峰谷/口径/成本/每日自洽
```

改完前端想快速看一眼：

```bash
google-chrome-stable --headless --disable-gpu --no-sandbox \
  --virtual-time-budget=12000 --screenshot=/tmp/hs.png \
  --window-size=1280,2400 http://127.0.0.1:8130/
```

**注意**：读渲染结果要看 DOM（`--dump-dom`）而不是只截图。开发中出现过两次
截图看着「一片空白」，实际是 CSS 类名拼错、看图误判；而真正的问题
（占比除错了分母、对数刻度其实画成了线性）也是靠算术复核才发现的。
截图适合看布局，数字要验算。

## 陆、与 Desktop 插件的关系

两者现在各读各的：`hstats/` 走自己的数据层，Desktop 插件仍是旧实现。
建议后续让插件改为读 `hstats`，避免两份口径长期并存打架。