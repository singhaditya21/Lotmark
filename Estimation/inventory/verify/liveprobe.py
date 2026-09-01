import sys,re,json,warnings,hashlib
warnings.filterwarnings("ignore")
import requests
from requests.adapters import HTTPAdapter
from concurrent.futures import ThreadPoolExecutor
import urllib3; urllib3.disable_warnings()

paths=[l.strip() for l in open(sys.argv[1]) if l.strip()]
mode=sys.argv[2]           # html | pdf
outf=sys.argv[3]
BASE="https://ipc.gov.in"
UA={"User-Agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}

sess_local={}
def sess():
    import threading
    t=threading.get_ident()
    if t not in sess_local:
        s=requests.Session(); s.headers.update(UA)
        a=HTTPAdapter(pool_connections=4,pool_maxsize=4,max_retries=1)
        s.mount("https://",a); sess_local[t]=s
    return sess_local[t]

def fingerprint(html):
    # structural signature: ordered distinctive class/id tokens of layout containers
    toks=re.findall(r'(?:class|id)="([^"]{0,120})"',html)
    keep=[]
    for t in toks:
        for w in t.split():
            if re.match(r'^(mod-|moduletable|blog|item-page|category|newsflash|breadcrumb|sp-|com-|contact|search|tags|pagination|article|nav|banner)',w):
                keep.append(w)
    sig=sorted(set(keep))
    return hashlib.md5(("|".join(sig)).encode()).hexdigest()[:10], len(sig), "|".join(sig[:40])

def one(p):
    url=BASE+p
    try:
        if mode=="pdf":
            r=sess().get(url,headers={"Range":"bytes=0-255"},timeout=25,allow_redirects=False,verify=False)
            loc=r.headers.get("Location","")
            ct=r.headers.get("Content-Type","")
            cr=r.headers.get("Content-Range","")
            magic = r.content[:5].decode('latin-1','replace') if r.content else ""
            return {"p":p,"code":r.status_code,"loc":loc,"ct":ct,"range":cr,"magic":magic}
        else:
            r=sess().get(url,timeout=30,allow_redirects=False,verify=False)
            loc=r.headers.get("Location","")
            if r.status_code!=200:
                return {"p":p,"code":r.status_code,"loc":loc,"size":0,"title":"","fp":"","nfp":0,"lang":"","links":0}
            html=r.content.decode('utf-8','replace')
            t=re.search(r'<title[^>]*>(.*?)</title>',html,re.S|re.I)
            title=re.sub(r'\s+',' ',t.group(1)).strip() if t else ""
            lang=re.search(r'<html[^>]*\blang="([^"]*)"',html,re.I)
            fp,nfp,sig=fingerprint(html)
            links=len(re.findall(r'href="',html))
            return {"p":p,"code":200,"loc":"","size":len(r.content),"title":title,"fp":fp,"nfp":nfp,"sig":sig,
                    "lang":lang.group(1) if lang else "","links":links}
    except Exception as e:
        return {"p":p,"code":-1,"loc":"","err":type(e).__name__}

with ThreadPoolExecutor(max_workers=8) as ex, open(outf,"w") as fo:
    n=0
    for res in ex.map(one,paths):
        fo.write(json.dumps(res)+"\n"); n+=1
        if n%250==0: print(f"  ...{n}/{len(paths)}",file=sys.stderr,flush=True)
print("done",n,file=sys.stderr)
