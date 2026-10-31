"""Unpack only the finite OCI layout envelope; never extract layer filesystems."""
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tarfile

MAX_BLOB = 8 * 1024 ** 3
MAX_TOTAL = 16 * 1024 ** 3
REGULAR = re.compile(r"(?:oci-layout|index\.json|blobs/sha256/[a-f0-9]{64})\Z")


def unpack(source, destination):
    source, destination = Path(source).absolute(), Path(destination).absolute()
    for path in (source, destination.parent):
        if path.resolve(strict=True) != path or path.is_symlink():
            raise ValueError('oci_path_alias')
    if not source.is_file() or destination.exists() or destination.is_symlink():
        raise ValueError('oci_destination_invalid')
    destination.mkdir(mode=0o700)
    names, total, files = set(), 0, 0
    # tarfile parses the format. We deliberately do not use extract/extractall.
    with tarfile.open(source, mode='r|') as archive:
        for member in archive:
            name = member.name
            if name in names or len(names) >= 300:
                raise ValueError('oci_duplicate_or_excess_entries')
            names.add(name)
            if member.isdir() and name.rstrip('/') in ('blobs', 'blobs/sha256'):
                continue
            if not member.isfile() or not REGULAR.fullmatch(name):
                raise ValueError('oci_entry_invalid')
            if member.size <= 0 or member.size > MAX_BLOB:
                raise ValueError('oci_entry_size_invalid')
            total += member.size
            if total > MAX_TOTAL:
                raise ValueError('oci_layout_too_large')
            target = destination.joinpath(*name.split('/'))
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            stream = archive.extractfile(member)
            if stream is None:
                raise ValueError('oci_entry_missing')
            with stream, open(target, 'xb') as output:
                shutil.copyfileobj(stream, output, 1024 * 1024)
            os.chmod(target, 0o600)
            if target.stat().st_size != member.size:
                raise ValueError('oci_entry_truncated')
            files += 1
    if not {'index.json', 'oci-layout'}.issubset(names):
        raise ValueError('oci_metadata_missing')
    return {'files': files, 'bytes': total, 'layerFilesystemsExtracted': False}


if __name__ == '__main__':
    try:
        print(json.dumps(unpack(*sys.argv[1:])))
    except Exception:
        print('oci_archive_unpack_failed', file=sys.stderr)
        sys.exit(1)
