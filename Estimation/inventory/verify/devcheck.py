import json,re,random,warnings,sys
warnings.filterwarnings("ignore")
import requests,urllib3; urllib3.disable_warnings()
from concurrent.futures import ThreadPoolExecutor
import threading
UA={"User-Agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"}
tl=threading.local()
def S():
    if not hasattr(tl,'s'):
        tl.s=requests.Session(); tl.s.headers.update(UA)
    return tl.s
dev=re.compile(r'[ऀ-ॿ]')
lat=re.compile(r'[A-Za-z]')
paths=[l.strip() for l in open(sys.argv[1]) if l.strip()]
def one(p):
    try:
        r=S().get("https://ipc.gov.in"+p,timeout=30,verify=False,allow_redirects=False)
        if r.status_code!=200: return {"p":p,"code":r.status_code}
        h=r.content.decode('utf-8','replace')
        body=None
        seg=body.group(1)[:200000] if body else h
        seg=re.sub(r'<script.*?</script>|<style.*?</style>','',seg,flags=re.S|re.I)
        txt=re.sub(r'<[^>]+>',' ',seg)
        # trim trailing nav/footer noise crudely
        nd=len(dev.findall(txt)); nl=len(lat.findall(txt))
        charset=r.headers.get('Content-Type','')
        meta=re.search(r'charset=["\']?([\w-]+)',h[:2000],re.I)
        return {"p":p,"code":200,"dev":nd,"lat":nl,"hdr_ct":charset,"meta_charset":meta.group(1) if meta else ""}
    except Exception as e: return {"p":p,"code":-1,"err":str(e)[:60]}
with ThreadPoolExecutor(max_workers=8) as ex, open(sys.argv[2],"w") as fo:
    for r in ex.map(one,paths): fo.write(json.dumps(r)+"\n")
print("done",len(paths),file=sys.stderr)
