"""hstats —— Hermes 用量与成本数据层。

只依赖标准库 + sqlite3 + PyYAML，不 import 任何 hermes_* 模块，
因此可在任意 Python 进程、cron、CLI 里独立运行。
"""

__version__ = "1.0.0"
