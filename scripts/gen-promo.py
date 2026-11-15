#!/usr/bin/env python3
# scripts/gen-promo.py — 生成 README 顶部宣传图 assets/promo.png（开发期工具，不随 npm 发布）。
#
# 为什么是 Python：本仓库的 Node 侧只有 fzstd 一个运行时依赖，没有图像库；Pillow 只在这台
# 开发机上可用。图形主体（圆角方框 + 双向箭头）与 assets/icon.svg 的路径数据保持一致——
# 改图标时这里的三组坐标要同步改，再重跑：python scripts/gen-promo.py
#
# 尺寸 1600x554（README 里按 100% 宽显示），左侧文字、右侧图标卡片。
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "promo.png")

W, H = 1600, 554
BRAND = (91, 108, 255)
BRAND_LIGHT = (185, 194, 255)
TEXT = (240, 243, 255)
DIM = (166, 176, 214)

MSYH = "C:/Windows/Fonts/msyh.ttc"
MSYH_B = "C:/Windows/Fonts/msyhbd.ttc"
SEGOE = "C:/Windows/Fonts/segoeui.ttf"
SEGOE_SB = "C:/Windows/Fonts/seguisb.ttf"

# 与 assets/icon.svg 同源（viewBox 0 0 1024 1024）
RING = (96, 96, 928, 928, 128, 112)   # x0,y0,x1,y1,radius,thickness
UPPER = [(272, 360), (600, 360), (600, 320), (752, 400), (600, 480), (600, 440), (272, 440)]
LOWER = [(752, 584), (424, 584), (424, 544), (272, 624), (424, 704), (424, 664), (752, 664)]


def font(path, size):
    return ImageFont.truetype(path, size)


def draw_mark(canvas, cx, cy, size, color):
    """把新图标画到 canvas 上（在 1024 网格里栅格化后贴到以 cx,cy 为中心的 size 方块）。"""
    s = size
    icon = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(icon)
    k = s / 1024
    x0, y0, x1, y1, r, w = RING
    box = (x0 * k, y0 * k, x1 * k, y1 * k)
    d.rounded_rectangle(box, radius=r * k, outline=color, width=max(1, round(w * k)))
    for poly in (UPPER, LOWER):
        d.polygon([(x * k, y * k) for x, y in poly], fill=color)
    canvas.alpha_composite(icon, (int(cx - s / 2), int(cy - s / 2)))


def fit_text(draw, text, path, start, max_w):
    """从 start 号字开始逐号缩小，直到放得进 max_w。"""
    size = start
    while size > 10:
        f = font(path, size)
        if draw.textlength(text, font=f) <= max_w:
            return f
        size -= 2
    return font(path, 11)


def main():
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    t = np.clip(xx / W * 0.62 + yy / H * 0.38, 0.0, 1.0)
    c0 = np.array([17, 23, 54], dtype=np.float32)
    c1 = np.array([66, 82, 214], dtype=np.float32)
    rgb = c0[None, None, :] + (c1 - c0)[None, None, :] * t[:, :, None]

    # 图标后面的柔光
    gx, gy = 1320.0, H / 2
    dist = np.sqrt((xx - gx) ** 2 + (yy - gy) ** 2)
    glow = np.clip(1.0 - dist / 430.0, 0.0, 1.0) ** 2 * 58.0
    rgb = np.clip(rgb + glow[:, :, None], 0, 255).astype(np.uint8)

    img = Image.fromarray(rgb, "RGB").convert("RGBA")
    d = ImageDraw.Draw(img)

    # 右侧图标卡片（白底 + 阴影），卡片里放品牌色新图标
    card = (1146, 87, 1506, 447)
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        (card[0] + 6, card[1] + 14, card[2] + 6, card[3] + 14), radius=76, fill=(4, 8, 26, 150)
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    img.alpha_composite(shadow)
    d.rounded_rectangle(card, radius=76, fill=(255, 255, 255, 255))
    draw_mark(img, (card[0] + card[2]) / 2, (card[1] + card[3]) / 2, 264, BRAND)

    left_x = 96
    max_w = card[0] - left_x - 56

    f_title = fit_text(d, "DSH Session Migration", SEGOE_SB, 78, max_w)
    d.text((left_x, 96), "DSH Session Migration", font=f_title, fill=TEXT)

    f_cn = font(MSYH_B, 42)
    d.text((left_x, 196), "会话迁移", font=f_cn, fill=BRAND_LIGHT)

    f_en = font(SEGOE, 27)
    d.text((left_x, 254), "Move agent sessions between tools — both ways.", font=f_en, fill=DIM)

    f_line = font(MSYH, 25)
    d.text((left_x, 322), "导入 37 种来源 · 导出回 Claude Code / Codex / Kimi / opencode",
           font=f_line, fill=TEXT)
    d.text((left_x, 364), "自动生成交接书 + 完整历史归档，目标工具直接接着干",
           font=f_line, fill=DIM)

    f_foot = font(SEGOE, 21)
    d.text((left_x, 434), "DeepSeek Harness plugin · import · export · handoff", font=f_foot, fill=(154, 166, 208))

    img.convert("RGB").save(OUT, "PNG", optimize=True)
    print("wrote", OUT, os.path.getsize(OUT), img.size)


if __name__ == "__main__":
    main()
