#!/usr/bin/env python3
# runfinal.py list.txt "extra args" [parallel]
import sys, subprocess, os, concurrent.futures as cf
os.chdir(os.path.dirname(os.path.abspath(__file__))); os.makedirs('logs', exist_ok=True)
lst, extra, par = sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 2
name = os.path.basename(lst)[:-4]
jobs = []
for i, line in enumerate(l.strip() for l in open(lst) if l.strip()):
    parts = line.split(); env = dict(os.environ)
    while '=' in parts[0]: k, v = parts.pop(0).split('=', 1); env[k] = v
    jobs.append((i, parts, env))
def run(j):
    i, parts, env = j
    with open(f'logs/{name}-{i:02d}-{parts[0][:-4]}.log', 'w') as f:
        return subprocess.call(['node', 'shoot.mjs', 'shots/' + parts[0], *parts[1:], *extra.split()], stdout=f, stderr=subprocess.STDOUT, env=env)
with cf.ThreadPoolExecutor(par) as ex: res = list(ex.map(run, jobs))
open(f'logs/done-{name}', 'w').write(str(res))
