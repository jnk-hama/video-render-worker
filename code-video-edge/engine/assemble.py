# EDSR(4x)で拡大した色 + 4xに拡大して輪郭をくっきり戻した透明度 → 最終RGBA。background色を変えて合成確認も作る。
import sys, cv2, numpy as np
def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t)
for name in sys.argv[1:]:
    comp = cv2.imread(f"comp_{name}.png", cv2.IMREAD_UNCHANGED)
    a = comp[..., 3].astype(np.float32) / 255
    rgb = cv2.imread(f"sr_{name}_rgb.png")                       # BGR 4x
    H, W = rgb.shape[:2]
    a4 = cv2.resize(a, (W, H), interpolation=cv2.INTER_CUBIC)
    a4 = cv2.GaussianBlur(a4, (0, 0), 1.1)
    a4 = smoothstep(0.30, 0.70, a4)                              # 縁をくっきり（CGレンダーなので輪郭は鋭い）
    # 色は少しだけシャープに（EDSRの甘さを戻す）
    blur = cv2.GaussianBlur(rgb, (0, 0), 2.0)
    rgb = cv2.addWeighted(rgb, 1.35, blur, -0.35, 0)
    out = np.dstack([rgb, (a4 * 255 + 0.5).astype(np.uint8)])
    cv2.imwrite(f"final_{name}.png", out)
    print(name, out.shape)
