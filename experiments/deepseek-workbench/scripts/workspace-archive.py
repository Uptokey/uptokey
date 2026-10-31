"""Local project ZIP using directory descriptors; never follows links outside workspace."""
import hashlib
import io
import json
import os
import stat
import zipfile

def workspace_archive(root):
    output = io.BytesIO()
    entries, excluded, total = [], 0, 0
    # The importer admits 5,000 content records (directories included). Its
    # reserved manifest is skipped, so reserve one extra ZIP member for it.
    members, max_members = 1, 5001
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    excluded_dirs = {'.git', '.ssh', '.dsh', 'node_modules', '__pycache__', '__uptokey_export__'}
    def admit_member():
        nonlocal members
        if members >= max_members:
            raise ValueError('workspace_export_limit')
        members += 1
    def walk(fd, prefix, archive, depth=0):
        nonlocal excluded, total
        if depth > 64:
            raise ValueError('workspace_depth_limit')
        for name in sorted(os.listdir(fd)):
            if name in excluded_dirs or name == '.env' or name.startswith('.env.') or name.lower().endswith(('.pem', '.key')):
                excluded += 1
                continue
            if any(c in name for c in ('\\', ':', '\x00')) or name in ('.', '..'):
                raise ValueError('workspace_name_invalid')
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            path = prefix + name
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, directory_flags, dir_fd=fd)
                try:
                    if os.fstat(child).st_ino != info.st_ino:
                        raise ValueError('workspace_changed')
                    admit_member()
                    archive.writestr(path + '/', b'')
                    walk(child, path + '/', archive, depth + 1)
                finally:
                    os.close(child)
                continue
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                excluded += 1
                continue
            admit_member()
            if info.st_size > 24 * 1024 * 1024 or total + info.st_size > 32 * 1024 * 1024:
                raise ValueError('workspace_export_limit')
            file_fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            with os.fdopen(file_fd, 'rb') as source:
                before = os.fstat(source.fileno())
                if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_ino != info.st_ino:
                    raise ValueError('workspace_changed')
                data = source.read(24 * 1024 * 1024 + 1)
                after = os.fstat(source.fileno())
                if len(data) != info.st_size or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                    raise ValueError('workspace_changed')
            total += len(data)
            entry = zipfile.ZipInfo(path)
            entry.create_system = 3
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = (stat.S_IFREG | (0o700 if before.st_mode & 0o111 else 0o600)) << 16
            archive.writestr(entry, data)
            entries.append({'path': path, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    fd = os.open(root, directory_flags)
    try:
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
            walk(fd, '', archive)
            archive.writestr('__uptokey_export__/manifest.json', json.dumps({'schema': 1, 'files': entries, 'excludedEntries': excluded, 'contentBytes': total}))
    finally:
        os.close(fd)
    return output.getvalue()
