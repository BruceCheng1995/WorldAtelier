"""Install the fixed Linux editor into an image, with official asset checksums."""
import hashlib, pathlib, sys, urllib.request, zipfile

assets = {
    'amd64': ('x86_64', '6bcc59dfd1d670e918c77eae06e82b9dc5699de13d353dc3a4b3b6b307b6dc06'),
    'arm64': ('arm64', '6c4bcb78a760f4b3bd958d0ca92496b0d5929540a0d29b0f315087a96226714a'),
}
arch, output = sys.argv[1:]
if arch not in assets:
    raise SystemExit('Supported image architectures: amd64, arm64')
suffix, expected = assets[arch]
filename = f'Godot_v4.6-stable_linux.{suffix}'
archive = pathlib.Path('/tmp/world-atelier-godot.zip')
url = f'https://github.com/godotengine/godot-builds/releases/download/4.6-stable/{filename}.zip'
with urllib.request.urlopen(url, timeout=120) as response, archive.open('wb') as target:
    while chunk := response.read(1024 * 1024):
        target.write(chunk)
if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
    raise SystemExit('Official Godot archive checksum mismatch')
with zipfile.ZipFile(archive) as package:
    target = pathlib.Path(output)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(package.read(filename))
    target.chmod(0o755)
archive.unlink()
print(f'Installed official Godot 4.6 for {arch}', flush=True)
