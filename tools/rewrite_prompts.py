"""rewrite_prompts.py —— 把仓库的 109 条官方动作提示词改写成「橘发猫耳女仆」版本。

只会做机械替换（角色外观词），不改动作设计：
  蓝发女仆 / 蓝发 → 橘发猫耳女仆 / 橘发
  鲸鱼尾巴、鲸尾、鲸鱼 → 猫尾、猫咪
  呆毛 → 猫耳
  DeepSeek 蓝鲸图案 / 小蓝鲸 → 围裙橘猫徽章 / 小橘猫幻影
输出：cat-pet/prompts/桌面宠物 10 秒动作提示词-橘猫.md，并打印每处替换的计数与受影响的小节。
"""
from __future__ import annotations

import re
from pathlib import Path

SRC = Path(__file__).resolve().parents[2] / "dsh-pet" / "prompts" / "桌面宠物 10 秒动作提示词.md"
OUT = Path(__file__).resolve().parents[1] / "prompts" / "桌面宠物 10 秒动作提示词-橘猫.md"

# 顺序有讲究：先长词后短词
PAIRS: list[tuple[str, str]] = [
    ("DeepSeek蓝鲸图案", "围裙上的橘猫徽章"),
    ("DeepSeek 蓝鲸图案", "围裙上的橘猫徽章"),
    ("小蓝鲸", "小橘猫幻影"),
    ("蓝鲸", "橘猫幻影"),
    ("Q版蓝发女仆", "Q版橘发猫耳女仆"),
    ("蓝发女仆", "橘发猫耳女仆"),
    ("蓝发", "橘发"),
    ("鲸鱼尾巴", "橘色条纹猫尾"),
    ("鲸尾", "猫尾"),
    ("鲸鱼", "猫咪"),
    ("呆毛", "猫耳"),
    ("耳侧的鳍饰", "耳侧的猫耳绒毛"),
    ("鳍饰", "绒毛"),
]


def main() -> int:
    text = SRC.read_text(encoding="utf-8")
    counts = {k: text.count(k) for k, _ in PAIRS}
    out = text
    for old, new in PAIRS:
        out = out.replace(old, new)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(out, encoding="utf-8")

    print("替换计数：")
    for k, v in counts.items():
        if v:
            print(f"  {k} × {v} → {dict(PAIRS)[k]}")
    left = {k: len(re.findall(k, out)) for k in ("鲸", "蓝发", "呆毛", "女仆")}
    print("残留：", left)
    print("小节数：", len(re.findall(r"^## ", out, re.M)))
    print("输出：", OUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
