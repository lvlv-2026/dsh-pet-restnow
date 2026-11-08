from PIL import Image, ImageDraw, ImageFilter

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

top = (34, 48, 78)
bot = (58, 92, 150)
grad = Image.new("RGBA", (1, S))
gd = ImageDraw.Draw(grad)
for y in range(S):
    t = y / (S - 1)
    gd.point((0, y), fill=(
        int(top[0] + (bot[0] - top[0]) * t),
        int(top[1] + (bot[1] - top[1]) * t),
        int(top[2] + (bot[2] - top[2]) * t),
        255,
    ))
grad = grad.resize((S, S))

mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
img.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(img)

glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(glow).ellipse([-S * 0.35, -S * 0.55, S * 0.75, S * 0.35], fill=(255, 255, 255, 26))
img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(S * 0.05)))
d = ImageDraw.Draw(img)

d.ellipse([S * 0.20, S * 0.40, S * 0.66, S * 0.66], fill=(242, 247, 255, 255))
d.polygon([(S * 0.63, S * 0.53), (S * 0.80, S * 0.42), (S * 0.80, S * 0.64)], fill=(214, 230, 250, 255))
d.polygon([(S * 0.40, S * 0.42), (S * 0.47, S * 0.30), (S * 0.55, S * 0.42)], fill=(210, 228, 248, 255))
d.ellipse([S * 0.30, S * 0.47, S * 0.345, S * 0.515], fill=(38, 56, 92, 255))
d.ellipse([S * 0.335, S * 0.545, S * 0.395, S * 0.585], fill=(255, 168, 150, 160))

cx, cy, r = S * 0.735, S * 0.735, S * 0.155
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(255, 122, 69, 255), outline=(255, 255, 255, 235), width=int(S * 0.012))
bw = r * 0.20
bh = r * 0.86
for dx in (-r * 0.26, r * 0.26):
    d.rounded_rectangle([cx + dx - bw / 2, cy - bh / 2, cx + dx + bw / 2, cy + bh / 2], radius=bw * 0.35, fill=(255, 255, 255, 255))

img = img.resize((512, 512), Image.LANCZOS)
img.save(r"D:\Deepseek\dsh-pet-restnow\icon.png")
print("saved", img.size)
