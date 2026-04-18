#!/usr/bin/env python3
# Python replacement for tools/zipdir/zipdir.c, used when cross-compiling
# to targets where we cannot build the native C tool (e.g. Emscripten on a
# Windows host without a working native C toolchain).
#
# Usage: zipdir.py [-dfuq] <zip file> <directory> [<directory> ...]
#   -d   deflate (default — zipfile always deflates when compresslevel>0)
#   -f   force: always rebuild the archive
#   -u   update: only rebuild if any source file is newer than the zip
#   -q   quiet: do not list files processed
#
# Mirrors the real zipdir enough for the UZDoom build to work. Base
# directory names are NOT stored in the zip (matches zipdir.c behavior);
# subdirectories ARE stored.

import os
import sys
import zipfile
import stat

def die(msg):
    sys.stderr.write("zipdir.py: " + msg + "\n")
    sys.exit(1)

def collect(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        filenames.sort()
        for name in filenames:
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            out.append((full, rel))
    return out

def main(argv):
    flags = {"deflate": True, "force": False, "update": False, "quiet": False}
    args = []
    i = 1
    while i < len(argv):
        a = argv[i]
        if a.startswith("-") and len(a) > 1 and not a[1].isdigit():
            for ch in a[1:]:
                if ch == "d": flags["deflate"] = True
                elif ch == "f": flags["force"] = True
                elif ch == "u": flags["update"] = True
                elif ch == "q": flags["quiet"] = True
                else: die("unknown flag: -" + ch)
        else:
            args.append(a)
        i += 1

    if len(args) < 2:
        die("usage: zipdir.py [-dfuq] <zipfile> <dir> [<dir>...]")

    zippath = args[0]
    dirs = args[1:]

    entries = []
    for d in dirs:
        if not os.path.isdir(d):
            die("not a directory: " + d)
        entries.extend(collect(d))

    if flags["update"] and not flags["force"] and os.path.exists(zippath):
        zip_mtime = os.path.getmtime(zippath)
        newest = max((os.path.getmtime(f) for f, _ in entries), default=0)
        if newest <= zip_mtime:
            if not flags["quiet"]:
                print("zipdir.py: {0} is up to date".format(zippath), flush=True)
            return 0

    tmp = zippath + ".tmp"
    mode = zipfile.ZIP_DEFLATED if flags["deflate"] else zipfile.ZIP_STORED
    with zipfile.ZipFile(tmp, "w", compression=mode, compresslevel=9 if flags["deflate"] else None) as zf:
        for full, rel in entries:
            if not flags["quiet"]:
                print("  adding: " + rel, flush=True)
            zf.write(full, arcname=rel)

    if os.path.exists(zippath):
        os.remove(zippath)
    os.rename(tmp, zippath)
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv))
