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
dev=re.compile(r'[ऀ-ॿ]'); lat=re.compile(r'[A-Za-z]')
paths=[l.strip() for l in open(sys.argv[1]) if l.strip()]
def one(p):
    try:
        r=S().get("https://ipc.gov.in"+p,timeout=30,verify=False,allow_redirects=False)
        if r.status_code!=200: return {"p":p,"code":r.status_code}
        h=r.content.decode('utf-8','replace')
        i=h.find('class="item-page')
        j=h.find('class="right-content', i if i>0 else 0)
        seg = h[i:j] if (i>0 and j>i) else ""
        seg=re.sub(r'<script.*?</script>|<style.*?</style>|<!--.*?-->','',seg,flags=re.S|re.I)
        txt=re.sub(r'<[^>]+>',' ',seg)
        t=re.search(r'<title[^>]*>(.*?)</title>',h,re.S|re.I)
        title=re.sub(r'\s+',' ',t.group(1)).strip() if t else ''
        # page heading
        hh=re.search(r'<h[12][^>]*>(.*?)</h[12]>',seg,re.S|re.I)
        head=re.sub(r'<[^>]+>','',hh.group(1)).strip() if hh else ''
        return {"p":p,"code":200,"bdev":len(dev.findall(txt)),"blat":len(lat.findall(txt)),
                "blen":len(txt.split()),"tdev":len(dev.findall(title)),"tlat":len(lat.findall(title)),
                "hdev":len(dev.findall(head)),"hlat":len(lat.findall(head)),"head":head[:70],"title":title[:70]}
    except Exception as e: return {"p":p,"code":-1,"err":str(e)[:50]}
with ThreadPoolExecutor(max_workers=8) as ex, open(sys.argv[2],"w") as fo:
    for r in ex.map(one,paths): fo.write(json.dumps(r)+"\n")
print("done",len(paths),file=sys.stderr)
