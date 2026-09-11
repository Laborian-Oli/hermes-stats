# hermes-stats · Hermes Desktop 统计中心

[English](README.en.md) | 中文

给 Hermes Desktop 加一个数据丰富的统计中心：侧栏**统计**页、状态栏常驻数据 chip、⌘K 快速入口。全部通过**官方插件机制**实现，零核心代码改动，数据**只读**复用官方 insights / dashboard analytics 管线。

## 预览

![统计中心预览](assets/preview.png)

> 预览图为合成数据示意，非真实用量。

## 功能

| 部分 | 内容 |
|---|---|
| 📄 统计页 `/stats` | 总览卡 · Token 趋势（输入/输出/缓存读）· 会话与成本 · 平台/模型分布环图 · 模型成本表 · 工具/技能排行 · 活跃模式 · Cron 执行 · 系统信息 |
| 🔋 状态栏双 chip | `⚡ 今日 tokens · 成本`（5 分钟刷新）+ `📏 当前会话上下文用量`（10 秒实时） |
| ⌘K | 「统计中心」命令直达 |
| 🔤 i18n | 中文 / English / 繁體中文 / 日本語 词包，跟随桌面语言 |

## Token 口径说明

- 主数字 = 输入 + 输出（与大多数人理解的“tokens”一致）
- **缓存读（cache read）单列**，不混入总量——提示词缓存下它每轮重读、量级巨大，混入会明显虚高（典型情况下可占总量九成以上）
- 输入趋势图用**对数刻度**（用量跨度可达几百倍，线性会被离群日压爆）；输出为线性自有标尺
- 成本为 0 表示该模型无定价数据（数据源口径，非 bug）

## 安装

```bash
cd hermes-stats
cp -r plugin/. ~/.hermes/plugins/hermes-stats/        # 拷入插件内容（注意末尾的 /.）
hermes config set plugins.enabled '["hermes-stats"]'  # 开启后端数据端点
```

改完配置后**重启 Hermes Desktop**，后端半（/stats /cron /system 端点）即挂载。

## 使用

重启后：

- 左侧边栏出现「**统计**」入口，或按 ⌘K 输入「统计中心」打开页面
- 底部状态栏右侧出现 `⚡ 今日…` 与 `📏 ctx…` 两个 chip，点击即跳统计页
- 页内可切换 7 / 30 / 90 天窗口，点「刷新」手动更新数据

## 开关

- **Desktop 半**（统计页 / chip / ⌘K）：Settings → Plugins 面板，每插件一行开关，**即时生效，无需重启**
- **后端半**（/stats /cron /system 数据端点）：`config.yaml → plugins.enabled`，改动后重启 gateway 生效

完全停用 = 面板关掉（立即）+ `hermes config set plugins.enabled '[]'`（下次重启生效）。

## 架构

```
~/.hermes/plugins/hermes-stats/
├── dashboard/manifest.json     # 插件清单（name + Python 后端入口）
├── dashboard/plugin_api.py     # FastAPI 端点 /stats /cron /system（复用官方统计函数，只读）
└── desktop/plugin.js           # Electron 渲染端：页面 + 状态栏 chip + ⌘K + i18n
```

## 开发

以下为插件开发者向（普通安装可忽略）：

- `dev/hs-render-test/`：真实数据 + React SSR 冒烟测试——保存代码前跑 `node smoke.mjs`，把“页面打开才炸”变成“保存前就能验”
- `dev/preview/render-preview.mjs`：生成 README 预览图（合成数据，不泄露真实用量）

测试脚本通过 `HERMES_HOME` / `HERMES_SRC` / `HS_PORT` / `HS_TOKEN` 环境变量定位运行时，无需改代码。

## 已知边界

- 依赖 Hermes Desktop 运行时插件 SDK；若 SDK 行为变化（如 `useQuery` 在插件运行时不可用——本项目已改自写轮询 hook 规避），需同步适配

## License

MIT — 见 [LICENSE](LICENSE)