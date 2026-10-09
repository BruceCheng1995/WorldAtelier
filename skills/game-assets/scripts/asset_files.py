#!/usr/bin/env python3
"""Download and unpack asset files without putting their contents in context."""
import argparse, hashlib, json, math, os
from pathlib import Path
import re, shutil, stat, time, unicodedata, uuid, zipfile
import urllib.error, urllib.parse, urllib.request


def positive(value):
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("must be a finite positive number")
    return number


class AssetRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        old, new = urllib.parse.urlsplit(req.full_url), urllib.parse.urlsplit(newurl)
        if new.scheme not in ("http", "https") or (old.scheme == "https" and new.scheme != "https"):
            raise ValueError("unsafe download redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(args):
    url = urllib.parse.urlsplit(args.url)
    if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password:
        raise ValueError("a public HTTP or HTTPS file URL is required")
    request = urllib.request.Request(args.url, headers={"User-Agent": "WorldAtelier-GameAssets/1.0"})
    out = Path(args.out).absolute()
    out.parent.mkdir(parents=True, exist_ok=True)
    out = out.parent.resolve() / out.name
    directory = os.open(out.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    temporary, limit = ".asset-" + uuid.uuid4().hex + ".part", int(args.max_mib * 1024 * 1024)
    temporary_created = False
    try:
        try:
            os.stat(out.name, dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise FileExistsError()
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        temporary_created = True
        started, digest, size, prefix = time.monotonic(), hashlib.sha256(), 0, b""
        with os.fdopen(fd, "wb") as target, urllib.request.build_opener(AssetRedirect()).open(request, timeout=args.timeout) as response:
            content_type = response.headers.get_content_type()
            length = response.headers.get("Content-Length")
            if length is not None and not length.isdecimal():
                raise ValueError("invalid download size header")
            expected = int(length) if length is not None else None
            if content_type in ("text/html", "application/xhtml+xml"):
                raise ValueError("download returned an HTML page, not an asset")
            if expected is not None and (expected <= 0 or expected > limit):
                raise ValueError("download size is empty or exceeds the limit")
            while True:
                chunk = response.read(64 * 1024)
                if time.monotonic() - started > args.timeout:
                    raise ValueError("download timeout")
                if not chunk:
                    break
                size += len(chunk)
                if size > limit:
                    raise ValueError("download exceeds the size limit")
                prefix = (prefix + chunk[:1024])[:1024]
                digest.update(chunk)
                target.write(chunk)
            if not size or (expected is not None and size != expected):
                raise ValueError("empty or incomplete download")
            if re.search(br"<(?:!doctype\s+html|html(?:\s|>))", prefix.lower()):
                raise ValueError("download returned an HTML page, not an asset")
            target.flush()
            os.fsync(target.fileno())
        os.link(temporary, out.name, src_dir_fd=directory, dst_dir_fd=directory, follow_symlinks=False)
        return {"path": str(out), "sha256": digest.hexdigest(), "size": size, "content_type": content_type}
    finally:
        try:
            if temporary_created:
                os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass
        os.close(directory)


def unpack(args):
    out, created = Path(args.out).absolute(), False
    limit, size, count = int(args.max_mib * 1024 * 1024), 0, 0
    fd = os.open(args.archive, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise ValueError("archive must be a regular file")
    try:
        with os.fdopen(fd, "rb") as source, zipfile.ZipFile(source) as archive:
            entries, paths = archive.infolist(), {}
            if len(entries) > args.max_files:
                raise ValueError("archive exceeds the file count limit")
            for entry in entries:
                name, mode = entry.orig_filename, stat.S_IFMT(entry.external_attr >> 16)
                parts = name[:-1].split("/") if entry.is_dir() else name.split("/")
                if name != entry.filename or "\\" in name or re.search(r"[\x00-\x1f\x7f:]", name) or any(p in ("", ".", "..") or p.endswith((".", " ")) for p in parts):
                    raise ValueError("archive contains an unsafe path")
                key = unicodedata.normalize("NFC", "/".join(parts)).casefold()
                if key in paths or mode not in (0, stat.S_IFREG, stat.S_IFDIR) or entry.flag_bits & 1 or (mode == stat.S_IFDIR and not entry.is_dir()) or (entry.is_dir() and entry.file_size):
                    raise ValueError("archive contains duplicate, encrypted or non-regular entries")
                paths[key] = entry.is_dir()
                size += entry.file_size
                if size > limit:
                    raise ValueError("archive exceeds the expanded size limit")
            for key in paths:
                if any(paths.get("/".join(key.split("/")[:i])) is False for i in range(1, len(key.split("/")))):
                    raise ValueError("archive contains a file/directory path conflict")
            out.parent.mkdir(parents=True, exist_ok=True)
            out = out.parent.resolve() / out.name
            out.mkdir(mode=0o700)
            created, size = True, 0
            for entry in entries:
                target = out / entry.filename
                if entry.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as reader, os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb") as writer:
                    while chunk := reader.read(64 * 1024):
                        size += len(chunk)
                        if size > limit:
                            raise ValueError("archive exceeds the actual expanded size limit")
                        writer.write(chunk)
                count += 1
        return {"path": str(out), "files": count, "size": size}
    except BaseException:
        if created:
            shutil.rmtree(out)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    download = commands.add_parser("fetch")
    download.add_argument("--url", required=True)
    download.add_argument("--timeout", type=positive, default=60)
    extract = commands.add_parser("unpack")
    extract.add_argument("--archive", required=True)
    extract.add_argument("--max-files", type=int, default=2000)
    for command, limit in ((download, 64), (extract, 256)):
        command.add_argument("--out", required=True)
        command.add_argument("--max-mib", type=positive, default=limit)
    args = parser.parse_args()
    try:
        if getattr(args, "max_files", 1) <= 0:
            raise ValueError("max-files must be positive")
        print(json.dumps(fetch(args) if args.command == "fetch" else unpack(args)))
    except Exception as error:
        reason = "destination already exists" if isinstance(error, FileExistsError) else str(error) if type(error) is ValueError else "asset file operation failed (" + type(error).__name__ + ")"
        if isinstance(error, urllib.error.HTTPError):
            reason = "download failed (HTTP " + str(error.code) + ")"
        elif isinstance(error, urllib.error.URLError):
            reason = "download connection failed (" + type(error.reason).__name__ + ")"
        print(json.dumps({"error": reason}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
