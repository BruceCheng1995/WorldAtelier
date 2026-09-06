#!/usr/bin/env python3
"""Fetch only the official 4.6-stable macOS template from the official TPZ via HTTP ranges."""
import io, json, pathlib, urllib.request, zipfile, hashlib
SOURCE='https://github.com/godotengine/godot-builds/releases/download/4.6-stable/Godot_v4.6-stable_export_templates.tpz'
class RemoteArchive(io.RawIOBase):
    def __init__(self,url):
        request=urllib.request.Request(url,method='HEAD')
        with urllib.request.urlopen(request,timeout=60) as r:
            self.url=r.url;self.length=int(r.headers['Content-Length'])
        self.pos=0
    def seekable(self):return True
    def readable(self):return True
    def tell(self):return self.pos
    def seek(self,n,whence=0):
        self.pos=n if whence==0 else self.pos+n if whence==1 else self.length+n
        return self.pos
    def read(self,size=-1):
        if size<0:size=self.length-self.pos
        size=min(size,self.length-self.pos)
        if size<=0:return b''
        req=urllib.request.Request(self.url,headers={'Range':f'bytes={self.pos}-{self.pos+size-1}'})
        with urllib.request.urlopen(req,timeout=180) as r:
            if r.status!=206:raise RuntimeError('Official download endpoint ignored HTTP range')
            data=r.read()
        if len(data)!=size:raise RuntimeError('Truncated official archive range')
        self.pos+=size;return data
folder=pathlib.Path.home()/'Library/Application Support/Godot/export_templates/4.6.stable'
folder.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(RemoteArchive(SOURCE)) as archive:
    for name in ['templates/macos.zip','templates/version.txt']:
        info=archive.getinfo(name)
        print(f'Fetching {name}: compressed={info.compress_size:,} bytes',flush=True)
        data=archive.read(info) # ZipFile verifies CRC from the official central directory.
        target=folder/pathlib.Path(name).name
        target.write_bytes(data)
        print(json.dumps({'file':str(target),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'source':SOURCE}),flush=True)
