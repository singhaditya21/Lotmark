import re,json,sys,warnings,urllib.parse as up
warnings.filterwarnings("ignore")
import requests, urllib3; urllib3.disable_warnings()
from concurrent.futures import ThreadPoolExecutor
import threading
UA={"User-Agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}
BASE="https://ipc.gov.in"
seen=set(); lock=threading.Lock()
pages={}; assets=set()
SEEDS=["/","/PvPI/pv_home.html","/hi/","/about-us.html","/mandates.html","/news-highlights.html",
       "/e-services.html","/tenders.html","/careers.html","/rti.html","/employees-corner.html",
       "/orders-circulars-notices.html","/faq.html","/PvPI/","/sitemap.html","/site-map.html"]
tl=threading.local()
def S():
    if not hasattr(tl,'s'):
        tl.s=requests.Session(); tl.s.headers.update(UA)
        from requests.adapters import HTTPAdapter
        tl.s.mount("https://",HTTPAdapter(pool_connections=4,pool_maxsize=4,max_retries=1))
    return tl.s
SKIP=re.compile(r'\.(jpg|jpeg|png|gif|svg|ico|css|js|woff2?|ttf|eot|mp4|zip|webp|bmp)$',re.I)
DOC=re.compile(r'\.(pdf|docx?|xlsx?|pptx?|csv|txt|rtf)$',re.I)
def norm(href,cur):
    if not href: return None
    href=href.strip().split('#')[0]
    if not href or href.startswith(('mailto:','tel:','javascript:','data:')): return None
    u=up.urljoin(BASE+cur,href)
    p=up.urlsplit(u)
    if p.scheme not in ('http','https'): return None
    h=p.netloc.lower().split(':')[0]
    if h not in ('ipc.gov.in','www.ipc.gov.in'): return None
    path=re.sub(r'/{2,}','/',p.path) or '/'
    return path+(('?'+p.query) if p.query else '')
def fetch(path):
    try:
        r=S().get(BASE+path,timeout=30,allow_redirects=False,verify=False)
    except Exception: return path,None,[]
    if r.status_code!=200: return path,r.status_code,[]
    ct=r.headers.get('Content-Type','')
    if 'html' not in ct.lower(): return path,r.status_code,[]
    html=r.content.decode('utf-8','replace')
    t=re.search(r'<title[^>]*>(.*?)</title>',html,re.S|re.I)
    title=re.sub(r'\s+',' ',t.group(1)).strip() if t else ''
    out=[]
    for href in re.findall(r'href=["\']([^"\']+)["\']',html):
        n=norm(href,path)
        if n: out.append(n)
    pages[path]={"code":200,"title":title,"size":len(r.content)}
    return path,200,out
frontier=[p for p in SEEDS]
with lock:
    seen.update(frontier)
rounds=0
with ThreadPoolExecutor(max_workers=8) as ex:
    while frontier and rounds<14 and len(seen)<12000:
        rounds+=1
        print(f"round {rounds}: frontier={len(frontier)} seen={len(seen)}",file=sys.stderr,flush=True)
        nxt=[]
        for path,code,links in ex.map(fetch,frontier):
            for l in links:
                if SKIP.search(l.split('?')[0]): continue
                if DOC.search(l.split('?')[0]):
                    assets.add(l); continue
                with lock:
                    if l not in seen:
                        seen.add(l); nxt.append(l)
        frontier=nxt
json.dump({"pages":pages,"docs":sorted(assets),"seen":sorted(seen)},open("crawl.json","w"))
print("crawl done: html200=",len(pages)," docs=",len(assets)," urls_seen=",len(seen),file=sys.stderr)
