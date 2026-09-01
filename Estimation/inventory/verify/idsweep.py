import json,re,sys,warnings,threading
warnings.filterwarnings("ignore")
import requests,urllib3; urllib3.disable_warnings()
from concurrent.futures import ThreadPoolExecutor
UA={"User-Agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"}
tl=threading.local()
def S():
    if not hasattr(tl,'s'):
        tl.s=requests.Session(); tl.s.headers.update(UA)
    return tl.s
def one(i):
    u=f"https://ipc.gov.in/index.php?option=com_content&view=article&id={i}"
    try:
        r=S().get(u,timeout=30,verify=False,allow_redirects=False)
        if r.status_code!=200: return {"id":i,"code":r.status_code}
        h=r.content.decode('utf-8','replace')
        a=h.find('class="item-page'); b=h.find('class="right-content',a if a>0 else 0)
        seg=h[a:b] if (a>0 and b>a) else ""
        hh=re.search(r'<h[12][^>]*>(.*?)</h[12]>',seg,re.S|re.I)
        head=re.sub(r'\s+',' ',re.sub(r'<[^>]+>','',hh.group(1))).strip() if hh else ''
        txt=re.sub(r'<[^>]+>',' ',re.sub(r'<script.*?</script>','',seg,flags=re.S))
        return {"id":i,"code":200,"head":head[:90],"words":len(txt.split())}
    except Exception as e: return {"id":i,"code":-1}
ids=range(int(sys.argv[1]),int(sys.argv[2])+1)
with ThreadPoolExecutor(max_workers=8) as ex, open(sys.argv[3],"w") as fo:
    n=0
    for r in ex.map(one,ids):
        fo.write(json.dumps(r)+"\n"); n+=1
        if n%400==0: print(f"  {n}",file=sys.stderr,flush=True)
print("done",file=sys.stderr)
