#!/usr/bin/env python3
"""Original synthesized score and combat feedback; standard-library reproducible assets."""
import pathlib,wave,math,struct,random
root=pathlib.Path(__file__).resolve().parents[1]/'runtimes/godot/assets/audio';root.mkdir(parents=True,exist_ok=True)
rate=22050
rng=random.Random(711)
def render(name,duration,sample):
    with wave.open(str(root/(name+'.wav')),'wb') as out:
        out.setnchannels(1);out.setsampwidth(2);out.setframerate(rate)
        out.writeframes(b''.join(struct.pack('<h',int(max(-.95,min(.95,sample(i/rate)))*32767)) for i in range(int(duration*rate))))
def tone(f,t):return math.sin(math.tau*f*t)
render('strike',.22,lambda t:(rng.uniform(-1,1)*.2+tone(150+1800*t,t)*.18)*math.sin(math.pi*t/.22)**2)
render('hit',.20,lambda t:(tone(120-230*t,t)*.5+rng.uniform(-1,1)*.3)*math.exp(-22*t))
render('dash',.30,lambda t:rng.uniform(-1,1)*.35*math.sin(math.pi*t/.30)**2)
render('collect',.65,lambda t:(tone(659 if t<.15 else 988,t)+.5*tone(1318,t))*.16*math.exp(-5*t))
render('beacon',2.4,lambda t:sum(tone(f,t) for f in (261.63,329.63,392,523.25))*.1*min(1,t*6)*math.exp(-1.3*t))
render('heal',1.1,lambda t:(tone(523.25,t)+tone(783.99,t))*.1*math.sin(math.pi*t/1.1))
render('danger',.65,lambda t:(tone(73.4,t)+tone(146.8,t)*.3+rng.uniform(-1,1)*.12)*.2*math.exp(-5*t))
# 32-second Cmaj7-Am7-Fmaj7-Gsus2 loop with a soft arpeggio, no external recordings.
chords=[(130.81,164.81,196,246.94),(110,130.81,164.81,196),(87.31,110,130.81,164.81),(98,146.83,196,220)]
def score(t):
    section=int(t//8)%4;within=t%8;notes=chords[section];envelope=min(1,within*1.5,(8-within)*1.5)
    pad=sum(tone(f,t)+.14*tone(f*2,t) for f in notes)*.035*envelope
    beat=t%1;note=notes[int(t)%4]*4
    pluck=tone(note,t)*math.exp(-beat*5)*.035
    return pad+pluck
render('first_light',32,score)
print('Generated 8 original WAV assets')
