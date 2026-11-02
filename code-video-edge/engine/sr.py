import sys, time, cv2, numpy as np
name = sys.argv[1]; model = sys.argv[2] if len(sys.argv) > 2 else "edsr"
im = cv2.imread(f"comp_{name}.png", cv2.IMREAD_UNCHANGED)       # BGRA
bgr = im[..., :3]; a = im[..., 3]
sr = cv2.dnn_superres.DnnSuperResImpl_create()
sr.readModel("models/EDSR_x4.pb"); sr.setModel("edsr", 4)
t = time.time()
# 透明部をまわりの色で埋めてから拡大（黒いにじみを作らない）
mask = (a < 8).astype(np.uint8) * 255
filled = cv2.inpaint(bgr, mask, 3, cv2.INPAINT_TELEA)
up = sr.upsample(filled)
print(name, "EDSR", bgr.shape[:2], "->", up.shape[:2], round(time.time() - t, 1), "s")
cv2.imwrite(f"sr_{name}_rgb.png", up)
