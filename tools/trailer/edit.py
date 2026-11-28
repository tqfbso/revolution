#!/usr/bin/env python3
"""Cut the trailer. python3 edit.py [wide|tall] [--draft]
Reads frame folders in out/, writes build/<name>.mp4. Missing frames are held or shown as black."""
import os, sys, subprocess, glob, shlex
os.chdir(os.path.dirname(os.path.abspath(__file__)))
MODE = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('-') else 'wide'
DRAFT = '--draft' in sys.argv
FPS = 24
BOLD = '/usr/share/fonts/opentype/inter/InterDisplay-Bold.otf'
MED = '/usr/share/fonts/opentype/inter/InterDisplay-Medium.otf'
MONO = [f for f in glob.glob('/usr/share/fonts/**/JetBrainsMono-Regular.*', recursive=True)] or [MED]
MONO = MONO[0]

def T(text, a, b, size=54, y='h*0.80', font=MED, sp=0, fade=0.5, color='white'):
    return dict(text=text, a=a, b=b, size=size, y=y, font=font, fade=fade, color=color)

if MODE == 'wide':
    W, H, SRC = 1920, 1080, '1920x804'
    S = 1.0
    # (kind, source, skip seconds, duration, fade in, fade out, [texts])
    CUT = [
        ('shot', 'sleep', 0, 5.5, 1.5, 0.4, [T('Nobody heard them coming.', 1.6, 5.0)]),
        ('shot', 'column-axis', 0, 4.5, 0.3, 0.5, []),
        ('black', None, 0, 2.5, 0, 0, [T('Russia has invaded.', 0.2, 2.3, 64, 'h*0.47')]),
        ('shot', 'helis-over', 0, 3.5, 0.3, 0.5, []),
        ('black', None, 0, 2.5, 0, 0, [T('The army lasted nine days.', 0.2, 2.3, 64, 'h*0.47')]),
        ('black', None, 0, 4.0, 0, 0, [T('"If you can hear this, you are the resistance."', 0.3, 3.8, 40, 'h*0.47', MONO, color='0xd8d2c4')]),
        ('shot', 'ambush-side', 0, 10, 0.4, 0, []),
        ('shot', 'night-low', 0, 3.5, 0, 0, []),
        ('shot', 'kowloon-side', 0, 3.5, 0, 0, []),
        ('shot', 'night-menu', 0, 3.5, 0, 0.25, []),
        ('black', None, 0, 2.0, 0, 0, []),
        ('shot', 'collapse-wide', 0, 7, 0, 0, []),
        ('shot', 'clash-line', 0, 4.5, 0, 0, []),
        ('shot', 'kowloon-axis', 0, 4.5, 0, 0, []),
        ('shot', 'clash-hud', 0, 4.5, 0, 0.3, []),
        ('black', None, 0, 6.5, 0, 0, [T('REBELLION', 0.15, 6.2, 190, 'h*0.40', BOLD, fade=0.25),
                                       T('A WAR FOR EVERY STREET', 1.2, 6.2, 34, 'h*0.62', MED)]),
        ('black', None, 0, 7.0, 0, 0, [T('Play free in your browser.', 0.4, 6.0, 58, 'h*0.44'),
                                       T('tqfbso.github.io/revolution', 1.2, 6.0, 34, 'h*0.56', MONO, color='0xd8d2c4')]),
    ]
    # (file, start s, volume, extra filter)
    SFX = [
        ('flare', 0.0, 0.55, 'afade=t=in:d=1.5'),
        ('tanks', 5.3, 0.8, 'afade=t=in:d=0.3,afade=t=out:st=4.2:d=0.6'),
        ('tanks', 12.4, 0.35, 'afade=t=in:d=0.3,afade=t=out:st=3:d=0.6,atrim=0:3.7'),
        ('vo', 18.9, 1.0, 'RADIO'),
        ('firefight', 22.4, 0.7, 'afade=t=in:d=0.6'),
        ('flare', 28.4, 0.5, 'atrim=3:8,asetpts=PTS-STARTPTS'),
        ('firefight', 32.4, 0.75, 'atrim=0:10.6,afade=t=out:st=10.2:d=0.4'),
        ('collapse', 44.7, 1.0, ''),
        ('battle', 51.8, 0.7, 'afade=t=in:d=0.3'),
        ('firefight', 56.5, 0.7, 'atrim=0:4.6,afade=t=out:st=4.2:d=0.4'),
        ('battle', 61.0, 0.7, 'atrim=0:4.8,afade=t=out:st=3.8:d=1.0'),
    ]
    MUSIC_AT = 0.0
    OUT = 'rebellion-trailer'
else:
    W, H, SRC = 1080, 1920, '1080x1920'
    CUT = [
        ('shot', 'night-menu', 0, 3.0, 0.3, 0, [T('Russia has invaded.', 0.3, 2.8, 62, 'h*0.16', BOLD)]),
        ('shot', 'ambush-side', 0, 4.0, 0, 0, [T('A rebellion has risen.', 0.2, 3.8, 62, 'h*0.16', BOLD)]),
        ('shot', 'kowloon-axis', 0, 3.5, 0, 0, []),
        ('shot', 'collapse-wide', 0, 5.0, 0, 0, []),
        ('shot', 'clash-line', 0, 3.5, 0, 0.3, []),
        ('black', None, 0, 5.0, 0, 0, [T('REBELLION', 0.15, 4.8, 150, 'h*0.42', BOLD, fade=0.25),
                                       T('Play free in your browser.', 1.0, 4.8, 44, 'h*0.53')]),
    ]
    SFX = [
        ('firefight', 0.0, 0.7, 'afade=t=in:d=0.4'),
        ('firefight', 7.0, 0.7, 'atrim=0:3.6,afade=t=out:st=3.2:d=0.4'),
        ('collapse', 10.3, 1.0, ''),
        ('battle', 15.4, 0.7, 'atrim=0:3.8,afade=t=out:st=3:d=0.8'),
    ]
    MUSIC_AT = -34.5   # start inside the build so the drop lands on the collapse
    OUT = 'rebellion-trailer-vertical'

os.makedirs('build/seg', exist_ok=True)
def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode: print(' '.join(shlex.quote(c) for c in cmd)); print(r.stderr[-3000:]); sys.exit(1)

def esc(s): return s.replace('\\', '\\\\').replace(':', '\\:').replace("'", "’").replace(',', '\\,').replace('%', '\\%')
def texts(ts):
    out = []
    for t in ts:
        a, b, f = t['a'], t['b'], t['fade']
        alpha = f"if(lt(t\\,{a})\\,0\\,if(lt(t\\,{a+f})\\,(t-{a})/{f}\\,if(lt(t\\,{b-f})\\,1\\,if(lt(t\\,{b})\\,({b}-t)/{f}\\,0))))"
        out.append(f"drawtext=fontfile={t['font']}:text='{esc(t['text'])}':fontsize={t['size']}:fontcolor={t['color']}:alpha='{alpha}':x=(w-text_w)/2:y={t['y']}-text_h/2:shadowcolor=black@0.6:shadowx=0:shadowy=2")
    return out

segs, total = [], 0.0
for i, (kind, src, skip, dur, fi, fo, ts) in enumerate(CUT):
    seg = f'build/seg/{MODE}-{i:02d}.mp4'; segs.append(seg)
    n = round(dur * FPS)
    vf = []
    frames = sorted(glob.glob(f'out/{src}-{SRC}/f*.jpg')) if kind == 'shot' else []
    if frames:
        lst = f'build/seg/{MODE}-{i:02d}.txt'
        first = round(skip * FPS)
        pick = [frames[min(first + k, len(frames) - 1)] for k in range(n)]
        if len(frames) < first + n: print(f'  {src}: only {len(frames)} of {first + n} frames, holding last')
        open(lst, 'w').write(''.join(f"file '{os.path.abspath(p)}'\nduration {1/FPS}\n" for p in pick))
        inp = ['-f', 'concat', '-safe', '0', '-i', lst]
        if MODE == 'wide':
            vf += ['eq=contrast=1.06:saturation=0.94:gamma=0.98', 'vignette=PI/5.5',
                   f'pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:black']
        else:
            vf += ['eq=contrast=1.06:saturation=0.94:gamma=0.98', 'vignette=PI/5.5', f'scale={W}:{H}:flags=lanczos']
        vf += ['noise=alls=5:allf=t']
    else:
        if kind == 'shot': print(f'  {src}: no frames yet, black placeholder')
        inp = ['-f', 'lavfi', '-i', f'color=c=0x050505:s={W}x{H}:r={FPS}']
        if kind == 'shot': ts = ts + [T(f'[{src}]', 0, dur, 40, 'h*0.5', MONO, fade=0.01, color='gray')]
    if fi: vf.append(f'fade=t=in:st=0:d={fi}')
    if fo: vf.append(f'fade=t=out:st={dur - fo}:d={fo}')
    vf += texts(ts)
    vf.append('format=yuv420p')
    run(['ffmpeg', '-y', '-v', 'error', *inp, '-t', f'{dur}', '-r', str(FPS), '-vf', ','.join(vf),
         '-c:v', 'libx264', '-preset', 'veryfast' if DRAFT else 'slow', '-crf', '20' if DRAFT else '15', '-pix_fmt', 'yuv420p', seg])
    print(f'{total:6.2f}  {kind:5} {src or "":15} {dur}'); total += dur
print('total', total)

open(f'build/{MODE}-list.txt', 'w').write(''.join(f"file '{os.path.abspath(s)}'\n" for s in segs))
run(['ffmpeg', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', f'build/{MODE}-list.txt', '-c', 'copy', f'build/{MODE}-video.mp4'])

RADIO = 'highpass=f=450,lowpass=f=3200,acompressor=threshold=-22dB:ratio=6:makeup=6,acrusher=bits=9:mix=0.25,volume=1.6'
ins, fc, labels = ['-i', 'audio/music.mp3'], [], []
if MUSIC_AT < 0:
    fc.append(f'[1:a]atrim={-MUSIC_AT}:{-MUSIC_AT + total},asetpts=PTS-STARTPTS,afade=t=in:d=0.4,afade=t=out:st={total - 2.5}:d=2.5,volume=0.9[m]')
else:
    fc.append(f'[1:a]atrim=0:{total},afade=t=out:st={total - 2}:d=2,volume=0.9[m]')
labels.append('[m]')
for k, (name, at, vol, flt) in enumerate(SFX):
    ins += ['-i', f'audio/{name}.mp3']
    chain = [RADIO if flt == 'RADIO' else flt] if flt else []
    chain += [f'volume={vol}', f'adelay={int(at * 1000)}:all=1']
    fc.append(f'[{k + 2}:a]' + ','.join(chain) + f'[s{k}]'); labels.append(f'[s{k}]')
if any(f == 'RADIO' for *_, f in SFX):   # radio hiss under the voice line
    at = next(a for n, a, v, f in SFX if f == 'RADIO')
    fc.append(f'anoisesrc=d=4.6:c=pink:a=0.05,highpass=f=800,lowpass=f=5000,afade=t=in:d=0.15,afade=t=out:st=4.2:d=0.4,adelay={int((at - 0.4) * 1000)}:all=1[hiss]'); labels.append('[hiss]')
fc.append(''.join(labels) + f'amix=inputs={len(labels)}:normalize=0:duration=longest,loudnorm=I=-15:TP=-1.5:LRA=11,apad,atrim=0:{total}[a]')
out = f'build/{OUT}{"-draft" if DRAFT else ""}.mp4'
run(['ffmpeg', '-y', '-v', 'error', '-i', f'build/{MODE}-video.mp4', *ins, '-filter_complex', ';'.join(fc),
     '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-movflags', '+faststart', out])
print('wrote', out)
