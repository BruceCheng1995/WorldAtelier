#!/usr/bin/env python3
"""Install selected official Godot 4.6 export templates; never downloads SDKs or credentials."""
import argparse, hashlib, io, json, os, pathlib, subprocess, sys, zipfile

SOURCE = 'https://github.com/godotengine/godot-builds/releases/download/4.6-stable/Godot_v4.6-stable_export_templates.tpz'
TARGETS = {'windows': ['windows_release_x86_64.exe'], 'linux': ['linux_release.x86_64'],
           'macos': ['macos.zip'], 'web': ['web_nothreads_release.zip'],
           'android': ['android_release.apk'], 'ios': ['ios.zip']}

class RemoteArchive(io.RawIOBase):
    def __init__(self):
        headers = subprocess.check_output(['curl','-fsSLI','--retry','3','--retry-all-errors','--connect-timeout','15','--max-time','60',SOURCE], text=True)
        self.url = SOURCE
        self.length = int([line.split(':',1)[1].strip() for line in headers.splitlines() if line.lower().startswith('content-length:')][-1])
        self.pos = 0
    def seekable(self): return True
    def readable(self): return True
    def tell(self): return self.pos
    def seek(self, n, whence=0):
        self.pos = n if whence == 0 else self.pos+n if whence == 1 else self.length+n
        return self.pos
    def read(self, size=-1):
        size = min(self.length-self.pos, self.length-self.pos if size < 0 else size)
        if size <= 0: return b''
        data = subprocess.check_output(['curl','-fsSL','--retry','3','--retry-all-errors','--connect-timeout','15','--max-time','180','--range',f'{self.pos}-{self.pos+size-1}',self.url])
        if len(data) != size: raise RuntimeError('Truncated archive range')
        self.pos += size
        return data

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('targets', nargs='+', choices=TARGETS)
parser.add_argument('--directory')
options = parser.parse_args()
default = pathlib.Path.home()/('Library/Application Support/Godot/export_templates/4.6.stable' if sys.platform == 'darwin' else '.local/share/godot/export_templates/4.6.stable')
folder = pathlib.Path(options.directory or os.environ.get('WORLD_ATELIER_EXPORT_TEMPLATES') or default)
folder.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(RemoteArchive()) as archive:
    for filename in ['version.txt'] + [f for target in options.targets for f in TARGETS[target]]:
        target = folder/filename
        if target.exists():
            print(json.dumps({'file': filename, 'status': 'already_installed'}), flush=True)
            continue
        info = archive.getinfo('templates/'+filename)
        print(json.dumps({'file': filename, 'compressed_bytes': info.compress_size, 'status': 'downloading'}), flush=True)
        data = archive.read(info)  # ZipFile verifies CRC from the official archive.
        temporary = target.with_suffix(target.suffix+'.part')
        temporary.write_bytes(data)
        temporary.replace(target)
        if filename.startswith('linux_'): target.chmod(0o755)
        print(json.dumps({'file': filename, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'source': SOURCE}), flush=True)
