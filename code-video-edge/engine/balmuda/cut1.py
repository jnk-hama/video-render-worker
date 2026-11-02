import sys, numpy as np, cv2
from PIL import Image
from rembg import remove, new_session
n = sys.argv[1]
s = new_session("birefnet-general", providers=["CPUExecutionProvider"])
o = remove(Image.open(f'p2/{n}_sr.png').convert('RGB'), session=s, post_process_mask=False)
a = np.array(o)
m = (a[:, :, 3] > 40).astype(np.uint8); _, lab, st, _ = cv2.connectedComponentsWithStats(m, 8)
k = 1 + np.argmax(st[1:, cv2.CC_STAT_AREA]); a[:, :, 3] = np.where(lab == k, a[:, :, 3], 0)   # 文字（WHITE 等）を落とす
o = Image.fromarray(a); o = o.crop(o.getbbox()); o.save(f'p2/kettle_{n}.png'); print(n, o.size)
