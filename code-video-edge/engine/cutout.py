import sys, time
from PIL import Image
from rembg import remove, new_session
sess = new_session("birefnet-general", providers=["CPUExecutionProvider"])
for i in sys.argv[1:]:
    t=time.time()
    im = Image.open(f"assets/img{i}.jpg").convert("RGB")
    out = remove(im, session=sess, only_mask=False, post_process_mask=False)
    out.save(f"cut{i}.png"); print(i, out.size, round(time.time()-t,1), "s", flush=True)
