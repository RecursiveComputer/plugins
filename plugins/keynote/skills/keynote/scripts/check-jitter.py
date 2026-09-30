# Frame-to-frame global motion on static structure (walls), after the camera move settles.
# Usage: check-jitter.py CLIP.mp4 [SETTLE_SECONDS]  (gate: rms < 0.15 px after the camera locks)
import cv2, numpy as np, sys
fn=sys.argv[1]; t0=float(sys.argv[2]) if len(sys.argv)>2 else 0
cap=cv2.VideoCapture(fn); fps=cap.get(5); frames=[]
while True:
    ok,f=cap.read()
    if not ok: break
    frames.append(cv2.cvtColor(f,cv2.COLOR_BGR2GRAY).astype(np.float32))
frames=frames[int(t0*fps):]
win=cv2.createHanningWindow(frames[0].shape[::-1],cv2.CV_32F)
d=[cv2.phaseCorrelate(frames[i-1],frames[i],win)[0] for i in range(1,len(frames))]
dx=np.array([v[0] for v in d]); dy=np.array([v[1] for v in d])
same=sum(1 for i in range(1,len(frames)) if np.mean(np.abs(frames[i]-frames[i-1]))<0.05)
print(f"{fn.split('/')[-1]:32s} fps {fps:.0f}  step px: rms {np.sqrt(np.mean(dx**2+dy**2)):.2f}  max {np.max(np.hypot(dx,dy)):.2f}   repeated frames {same}/{len(frames)-1}")
