"""Import a selected ZIP as a new isolated project; never execute archive content."""
import hashlib
import io
import os
import re
import shutil
import stat
import uuid
import zipfile

def import_workspace(data, root):
    if len(data) > 34 * 1024 * 1024:
        raise ValueError('archive_limit')
    excluded = {'.git', '.ssh', '.dsh', 'node_modules', '__pycache__', '__uptokey_export__'}
    records, names, total, skipped = [], {}, 0, 0
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if len(archive.infolist()) > 10000:
            raise ValueError('archive_entry_limit')
        for info in archive.infolist():
            name = info.orig_filename
            parts = name.rstrip('/').split('/')
            if not name or len(parts) > 64 or any(not p or p in ('.', '..') or any(c in p for c in '\\:\x00') or p.endswith((' ', '.')) or re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', p, re.I) for p in parts):
                raise ValueError('archive_path_invalid')
            mode = info.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if kind not in (0, stat.S_IFDIR if info.is_dir() else stat.S_IFREG) or info.flag_bits & 1:
                raise ValueError('archive_type_invalid')
            if any(p.lower() in excluded or p.lower() == '.env' or p.lower().startswith('.env.') or p.lower().endswith(('.pem', '.key')) for p in parts):
                skipped += 1
                continue
            # Reject duplicate, case-conflicting and file/directory-conflicting paths.
            for index in range(1, len(parts) + 1):
                path = '/'.join(parts[:index])
                directory = index < len(parts) or info.is_dir()
                key = path.casefold()
                previous = names.get(key)
                if previous and (previous[0] != path or not previous[1] or not directory or (index == len(parts) and previous[2])):
                    raise ValueError('archive_path_conflict')
                names[key] = (path, directory, index == len(parts) or bool(previous and previous[2]))
            if info.file_size > 24 * 1024 * 1024 or total + info.file_size > 32 * 1024 * 1024 or len(records) >= 5000:
                raise ValueError('archive_content_limit')
            if info.is_dir() and info.file_size:
                raise ValueError('archive_directory_invalid')
            # Bounded read also validates CRC before creating any destination.
            with archive.open(info) as source:
                content = source.read(info.file_size + 1)
            if len(content) != info.file_size:
                raise ValueError('archive_size_invalid')
            total += len(content)
            records.append((parts, info.is_dir(), content, bool(mode & 0o111)))
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    root_fd = os.open(root, flags)
    project = 'import-' + uuid.uuid4().hex
    created = False
    try:
        os.mkdir(project, 0o700, dir_fd=root_fd)
        created = True
        project_fd = os.open(project, flags, dir_fd=root_fd)
        try:
            for parts, directory, content, executable in records:
                fd = os.dup(project_fd)
                try:
                    for part in parts if directory else parts[:-1]:
                        try:
                            os.mkdir(part, 0o700, dir_fd=fd)
                        except FileExistsError:
                            pass
                        child = os.open(part, flags, dir_fd=fd)
                        os.close(fd)
                        fd = child
                    if not directory:
                        target = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700 if executable else 0o600, dir_fd=fd)
                        with os.fdopen(target, 'wb') as output:
                            output.write(content)
                finally:
                    os.close(fd)
        finally:
            os.close(project_fd)
        return {'imported': True, 'project': '/workspace/' + project, 'files': sum(not directory for _, directory, _, _ in records), 'contentBytes': total, 'excludedEntries': skipped, 'sha256': hashlib.sha256(data).hexdigest()}
    except Exception:
        if created:
            shutil.rmtree(project, dir_fd=root_fd)
        raise
    finally:
        os.close(root_fd)
