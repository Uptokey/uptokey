//! A bounded, read-only snapshot of an explicitly selected project folder.
//!
//! ZIP generation reuses zip 4.6.1 (MIT), Stored compression. Admission mirrors
//! the names/size/type policy of scripts/workspace-import.py; that existing
//! importer remains responsible for ZIP parsing and isolated materialization.
//! Known credential/cache names are excluded before opening or inspecting them.
//! This is not a universal secret scanner or a defense against a compromised OS.
use std::{
    collections::HashSet,
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Cursor, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    time::SystemTime,
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

const MAX_TOTAL: u64 = 32 * 1024 * 1024;
const MAX_FILE: u64 = 24 * 1024 * 1024;
const MAX_ENTRIES: usize = 5000;
const MAX_DEPTH: usize = 64;
const MAX_ARCHIVE: u64 = 34 * 1024 * 1024;
const MAX_NAME_BYTES: usize = 4096;
pub type SnapshotError = &'static str;

pub struct Snapshot {
    /// The finite ZIP is owned by this snapshot and never spooled to a path.
    pub archive: Vec<u8>,
    pub files: usize,
    pub bytes: u64,
    /// Excluded entries seen at admitted directory levels; skipped subtrees
    /// are counted once, without enumerating their contents.
    pub excluded: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Directory,
    File,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    kind: Kind,
    size: u64,
    modified: SystemTime,
    identity: (u64, u64),
    links: u64,
    executable: bool,
    readonly: bool,
}
struct Entry {
    path: PathBuf,
    name: String,
    before: Stamp,
    children: Vec<Entry>,
}
#[derive(Default)]
struct Budget {
    seen: usize,
    files: usize,
    bytes: u64,
    excluded: usize,
    names: HashSet<String>,
}
impl Budget {
    fn visit(&mut self, depth: usize) -> Result<(), SnapshotError> {
        self.seen += 1;
        if self.seen > MAX_ENTRIES || depth > MAX_DEPTH {
            return Err("folder_entry_limit");
        }
        Ok(())
    }
    fn record(&mut self, name: &str, meta: &Stamp) -> Result<(), SnapshotError> {
        if name.len() > MAX_NAME_BYTES || !self.names.insert(collision_key(name)) {
            return Err("folder_name_conflict");
        }
        if meta.kind == Kind::File {
            if meta.size > MAX_FILE
                || self
                    .bytes
                    .checked_add(meta.size)
                    .is_none_or(|total| total > MAX_TOTAL)
            {
                return Err("folder_content_limit");
            }
            self.files += 1;
            self.bytes += meta.size;
        }
        Ok(())
    }
}

fn excluded_name(name: &str) -> bool {
    let name = name.to_lowercase();
    name == ".env"
        || name.starts_with(".env.")
        || name.ends_with(".key")
        || name.ends_with(".pem")
        || matches!(
            name.as_str(),
            ".git"
                | ".ssh"
                | ".dsh"
                | ".codex"
                | ".agents"
                | ".aws"
                | "node_modules"
                | "__pycache__"
                | "__uptokey_export__"
                | "cache"
                | "caches"
                | ".cache"
                | ".next"
                | ".nuxt"
                | ".svelte-kit"
                | ".turbo"
                | ".vite"
                | ".pytest_cache"
                | ".mypy_cache"
                | ".ruff_cache"
        )
}
fn valid_component(name: &str) -> bool {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.ends_with([' ', '.'])
        || name.encode_utf16().count() > 255
        || name.chars().any(|ch| {
            ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
        })
    {
        return false;
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ')
        .to_uppercase();
    !matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) && !((stem.starts_with("COM") || stem.starts_with("LPT"))
        && matches!(
            &stem[3..],
            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
        ))
}
// A conservative Unicode caseless key, including expanding uppercase mappings
// (ß/ligatures), final sigma and lowercased compatibility letters (Kelvin).
// Python's canonical importer independently applies its full casefold policy.
fn collision_key(name: &str) -> String {
    name.chars()
        .flat_map(char::to_lowercase)
        .flat_map(char::to_uppercase)
        .collect()
}

#[cfg(windows)]
fn reparse_attributes(attributes: u32) -> bool {
    attributes & 0x400 != 0
}

fn is_reparse(meta: &Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        reparse_attributes(meta.file_attributes())
    }
    #[cfg(not(windows))]
    {
        false
    }
}
fn identity(file: &File, meta: &Metadata) -> Result<((u64, u64), u64), SnapshotError> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, GetFileType, BY_HANDLE_FILE_INFORMATION, FILE_TYPE_DISK,
        };
        let handle = file.as_raw_handle();
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // The handle belongs to this File and info is a valid writable value.
        if unsafe { GetFileType(handle) } != FILE_TYPE_DISK
            || unsafe { GetFileInformationByHandle(handle, &mut info) } == 0
        {
            return Err("folder_metadata_unavailable");
        }
        if reparse_attributes(info.dwFileAttributes) {
            return Err("folder_link_rejected");
        }
        let _ = meta;
        Ok((
            (
                info.dwVolumeSerialNumber as u64,
                ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
            ),
            info.nNumberOfLinks as u64,
        ))
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = file;
        Ok(((meta.dev(), meta.ino()), meta.nlink()))
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (file, meta);
        Err("folder_platform_unsupported")
    }
}
fn executable(meta: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        false
    }
}
fn stamp(file: &File) -> Result<Stamp, SnapshotError> {
    let meta = file.metadata().map_err(|_| "folder_metadata_unavailable")?;
    if is_reparse(&meta) {
        return Err("folder_link_rejected");
    }
    let kind = if meta.is_dir() {
        Kind::Directory
    } else if meta.is_file() {
        Kind::File
    } else {
        return Err("folder_type_rejected");
    };
    let (identity, links) = identity(file, &meta)?;
    if kind == Kind::File && links != 1 {
        return Err("folder_link_rejected");
    }
    Ok(Stamp {
        kind,
        size: meta.len(),
        modified: meta.modified().map_err(|_| "folder_metadata_unavailable")?,
        identity,
        links,
        executable: executable(&meta),
        readonly: meta.permissions().readonly(),
    })
}
fn open_read(path: &Path, directory: bool) -> Result<File, SnapshotError> {
    let meta = fs::symlink_metadata(path).map_err(|_| "folder_metadata_unavailable")?;
    if is_reparse(&meta) {
        return Err("folder_link_rejected");
    }
    if directory != meta.is_dir() || (!directory && !meta.is_file()) {
        return Err("folder_type_rejected");
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        };
        options.share_mode(FILE_SHARE_READ).custom_flags(
            FILE_FLAG_OPEN_REPARSE_POINT
                | if directory {
                    FILE_FLAG_BACKUP_SEMANTICS
                } else {
                    0
                },
        );
    }
    let file = options.open(path).map_err(|_| "folder_open_failed")?;
    let opened = stamp(&file)?;
    if (opened.kind == Kind::Directory) != directory
        || opened.size != meta.len()
        || opened.modified != meta.modified().map_err(|_| "folder_metadata_unavailable")?
    {
        return Err("folder_changed");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.identity != (meta.dev(), meta.ino()) {
            return Err("folder_changed");
        }
    }
    let after = fs::symlink_metadata(path).map_err(|_| "folder_changed")?;
    if is_reparse(&after) {
        return Err("folder_link_rejected");
    }
    Ok(file)
}
fn no_reparse_ancestors(path: &Path) -> Result<(), SnapshotError> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err("folder_path_invalid");
    }
    for ancestor in path.ancestors() {
        let meta = fs::symlink_metadata(ancestor).map_err(|_| "folder_metadata_unavailable")?;
        if is_reparse(&meta) {
            return Err("folder_link_rejected");
        }
        if !meta.is_dir() {
            return Err("folder_type_rejected");
        }
    }
    Ok(())
}
fn canonical_directory(path: &Path) -> Result<(PathBuf, File), SnapshotError> {
    no_reparse_ancestors(path)?;
    let canonical = fs::canonicalize(path).map_err(|_| "folder_path_invalid")?;
    no_reparse_ancestors(&canonical)?;
    let guard = open_read(&canonical, true)?;
    Ok((canonical, guard))
}
fn path_key(path: &Path) -> Vec<String> {
    path.components()
        .map(|part| {
            let value = part.as_os_str().to_string_lossy();
            #[cfg(windows)]
            {
                value.to_uppercase()
            }
            #[cfg(not(windows))]
            {
                value.into_owned()
            }
        })
        .collect()
}
fn intersects(left: &Path, right: &Path) -> bool {
    let left = path_key(left);
    let right = path_key(right);
    left.starts_with(&right) || right.starts_with(&left)
}
fn source_allowed(source: &Path, protected: &Path, home: Option<&Path>) -> bool {
    source.parent().is_some()
        && !intersects(source, protected)
        && !home.is_some_and(|home| path_key(source) == path_key(home))
}

fn plan_directory(
    path: &Path,
    name: String,
    before: Stamp,
    depth: usize,
    budget: &mut Budget,
) -> Result<Entry, SnapshotError> {
    let guard = open_read(path, true)?;
    if stamp(&guard)? != before {
        return Err("folder_changed");
    }
    let mut children = Vec::new();
    for row in fs::read_dir(path).map_err(|_| "folder_read_failed")? {
        let row = row.map_err(|_| "folder_read_failed")?;
        budget.visit(depth + 1)?;
        let raw = row.file_name();
        let part = raw.to_str().ok_or("folder_name_invalid")?;
        if excluded_name(part) {
            budget.excluded += 1;
            continue;
        }
        if !valid_component(part) {
            return Err("folder_name_invalid");
        }
        let relative = if name.is_empty() {
            part.to_owned()
        } else {
            format!("{name}/{part}")
        };
        let child_path = path.join(&raw);
        let meta = fs::symlink_metadata(&child_path).map_err(|_| "folder_metadata_unavailable")?;
        if is_reparse(&meta) {
            return Err("folder_link_rejected");
        }
        if !meta.is_dir() && !meta.is_file() {
            return Err("folder_type_rejected");
        }
        let child = open_read(&child_path, meta.is_dir())?;
        let child_stamp = stamp(&child)?;
        drop(child);
        budget.record(&relative, &child_stamp)?;
        children.push(if child_stamp.kind == Kind::Directory {
            plan_directory(&child_path, relative, child_stamp, depth + 1, budget)?
        } else {
            Entry {
                path: child_path,
                name: relative,
                before: child_stamp,
                children: Vec::new(),
            }
        });
    }
    if stamp(&guard)? != before {
        return Err("folder_changed");
    }
    children.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(Entry {
        path: path.to_path_buf(),
        name,
        before,
        children,
    })
}

struct BoundedZip {
    inner: Cursor<Vec<u8>>,
    limit: u64,
}
impl BoundedZip {
    fn new(limit: u64) -> Self {
        Self {
            inner: Cursor::new(Vec::with_capacity(limit as usize)),
            limit,
        }
    }
}
impl Write for BoundedZip {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self
            .inner
            .position()
            .checked_add(bytes.len() as u64)
            .is_none_or(|end| end > self.limit)
        {
            return Err(io::Error::new(io::ErrorKind::FileTooLarge, "archive_limit"));
        }
        self.inner.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl Seek for BoundedZip {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let next = match from {
            SeekFrom::Start(next) => next as i128,
            SeekFrom::End(offset) => self.inner.get_ref().len() as i128 + offset as i128,
            SeekFrom::Current(offset) => self.inner.position() as i128 + offset as i128,
        };
        if next < 0 || next > self.limit as i128 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "archive_limit"));
        }
        self.inner.seek(SeekFrom::Start(next as u64))
    }
}
fn pack(entry: &Entry, writer: &mut ZipWriter<BoundedZip>) -> Result<(), SnapshotError> {
    let mut handle = open_read(&entry.path, entry.before.kind == Kind::Directory)?;
    if stamp(&handle)? != entry.before {
        return Err("folder_changed");
    }
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    if entry.before.kind == Kind::Directory {
        if !entry.name.is_empty() {
            writer
                .add_directory(&entry.name, options.unix_permissions(0o700))
                .map_err(|_| "folder_archive_failed")?;
        }
        for child in &entry.children {
            pack(child, writer)?;
        }
    } else {
        writer
            .start_file(
                &entry.name,
                options.unix_permissions(if entry.before.executable {
                    0o700
                } else {
                    0o600
                }),
            )
            .map_err(|_| "folder_archive_failed")?;
        let mut copied = 0u64;
        let mut buffer = [0u8; 65536];
        loop {
            let length = handle.read(&mut buffer).map_err(|_| "folder_read_failed")?;
            if length == 0 {
                break;
            }
            copied = copied
                .checked_add(length as u64)
                .ok_or("folder_content_limit")?;
            if copied > entry.before.size || copied > MAX_FILE {
                return Err("folder_changed");
            }
            writer
                .write_all(&buffer[..length])
                .map_err(|_| "folder_archive_limit")?;
        }
        if copied != entry.before.size {
            return Err("folder_changed");
        }
    }
    if stamp(&handle)? != entry.before {
        return Err("folder_changed");
    }
    let path_meta = fs::symlink_metadata(&entry.path).map_err(|_| "folder_changed")?;
    if is_reparse(&path_meta) {
        return Err("folder_changed");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if (path_meta.dev(), path_meta.ino()) != entry.before.identity {
            return Err("folder_changed");
        }
    }
    Ok(())
}
fn verify_unchanged(entry: &Entry) -> Result<(), SnapshotError> {
    let handle = open_read(&entry.path, entry.before.kind == Kind::Directory)?;
    if stamp(&handle)? != entry.before {
        return Err("folder_changed");
    }
    for child in &entry.children {
        verify_unchanged(child)?;
    }
    if stamp(&handle)? != entry.before {
        return Err("folder_changed");
    }
    Ok(())
}

/// Snapshot one selected project. All paths must exist and be absolute. Source
/// must be disjoint from the private protected tree. Existing sources are never
/// changed. The returned object owns bounded ZIP bytes for the original importer.
pub fn snapshot_folder(source: &Path, protected_root: &Path) -> Result<Snapshot, SnapshotError> {
    if source.components().any(
        |part| matches!(part,Component::Normal(name) if name.to_str().is_some_and(excluded_name)),
    ) {
        return Err("folder_source_rejected");
    }
    let (protected, _protected_guard) = canonical_directory(protected_root)?;
    // Read only path/metadata for home detection; never enumerate home/profile.
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .and_then(|home| fs::canonicalize(PathBuf::from(home)).ok());
    no_reparse_ancestors(source)?;
    let source = fs::canonicalize(source).map_err(|_| "folder_path_invalid")?;
    if !source_allowed(&source, &protected, home.as_deref()) {
        return Err("folder_source_rejected");
    }
    let (source, source_guard) = canonical_directory(&source)?;
    let mut budget = Budget::default();
    let root = plan_directory(
        &source,
        String::new(),
        stamp(&source_guard)?,
        0,
        &mut budget,
    )?;
    let mut writer = ZipWriter::new(BoundedZip::new(MAX_ARCHIVE));
    pack(&root, &mut writer)?;
    let archive_bytes = writer
        .finish()
        .map_err(|_| "folder_archive_failed")?
        .inner
        .into_inner();
    verify_unchanged(&root)?;
    Ok(Snapshot {
        archive: archive_bytes,
        files: budget.files,
        bytes: budget.bytes,
        excluded: budget.excluded,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        ffi::OsStr,
        sync::atomic::{AtomicU64, Ordering},
        time::UNIX_EPOCH,
    };
    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);
    struct Fixture {
        root: PathBuf,
        source: PathBuf,
        protected: PathBuf,
        base: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let base = fs::canonicalize(std::env::temp_dir()).unwrap();
            let root = base.join(format!(
                "uptokey-folder-tests-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            let source = root.join("project");
            let protected = root.join("private");
            for path in [&source, &protected] {
                fs::create_dir(path).unwrap()
            }
            Self {
                root,
                source,
                protected,
                base,
            }
        }
        fn snapshot(&self) -> Result<Snapshot, SnapshotError> {
            snapshot_folder(&self.source, &self.protected)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Ok(path) = fs::canonicalize(&self.root) {
                if path.parent() == Some(self.base.as_path())
                    && path
                        .file_name()
                        .and_then(OsStr::to_str)
                        .is_some_and(|name| name.starts_with("uptokey-folder-tests-"))
                {
                    let _ = fs::remove_dir_all(path);
                }
            }
        }
    }
    #[test]
    fn binary_empty_directories_and_exclusions_roundtrip_without_source_change() {
        let f = Fixture::new();
        fs::write(f.source.join("binary.dat"), [0, 255, 17, 0, 3]).unwrap();
        fs::create_dir(f.source.join("empty")).unwrap();
        for name in [".env", ".env.local", "private.KEY", "cert.PEM"] {
            fs::write(f.source.join(name), b"synthetic-excluded").unwrap()
        }
        for name in [
            ".git",
            ".ssh",
            ".dsh",
            ".codex",
            ".agents",
            ".aws",
            "node_modules",
            ".cache",
        ] {
            fs::create_dir(f.source.join(name)).unwrap();
            fs::write(f.source.join(name).join("do-not-include"), b"synthetic").unwrap()
        }
        let snapshot = f.snapshot().unwrap();
        assert_eq!(snapshot.files, 1);
        assert_eq!(snapshot.bytes, 5);
        assert_eq!(snapshot.excluded, 12);
        let mut archive = zip::ZipArchive::new(Cursor::new(&snapshot.archive)).unwrap();
        assert_eq!(archive.len(), 2);
        let mut data = Vec::new();
        archive
            .by_name("binary.dat")
            .unwrap()
            .read_to_end(&mut data)
            .unwrap();
        assert_eq!(data, [0, 255, 17, 0, 3]);
        assert!(archive.by_name("empty/").unwrap().is_dir());
        drop(archive);
        assert_eq!(fs::read(f.source.join("binary.dat")).unwrap(), data);
        let unrelated = f.root.join("keep.txt");
        fs::write(&unrelated, b"keep").unwrap();
        drop(snapshot);
        assert!(unrelated.exists());
        assert_eq!(fs::read_dir(&f.root).unwrap().count(), 3);
    }
    #[test]
    fn ambiguous_names_and_caseless_collisions_are_rejected() {
        for name in [
            "",
            ".",
            "..",
            "trailing.",
            "trailing ",
            "CON",
            "con.txt",
            "CON .txt",
            "LPT1",
            "COM9.json",
            "COM¹.txt",
            "a:b",
            "a\\b",
            "a/b",
            "a?b",
            "x\0y",
        ] {
            assert!(!valid_component(name), "{name:?}")
        }
        assert!(valid_component("projeto-ação.ts"));
        for (left, right) in [
            ("Readme.md", "README.MD"),
            ("Straße.txt", "STRASSE.TXT"),
            ("Key.txt", "key.txt"),
            ("ς.txt", "σ.txt"),
        ] {
            assert_eq!(collision_key(left), collision_key(right));
        }
        let mut budget = Budget::default();
        let f = Fixture::new();
        let path = f.source.join("a");
        fs::write(&path, b"a").unwrap();
        let meta = stamp(&open_read(&path, false).unwrap()).unwrap();
        assert!(budget.record("A.txt", &meta).is_ok());
        assert!(budget.record("a.TXT", &meta).is_err());
    }
    #[test]
    fn private_tree_ancestors_and_home_are_rejected() {
        let f = Fixture::new();
        assert!(snapshot_folder(&f.protected, &f.protected).is_err());
        assert!(snapshot_folder(&f.root, &f.protected).is_err());
        let inside = f.protected.join("project");
        fs::create_dir(&inside).unwrap();
        assert!(snapshot_folder(&inside, &f.protected).is_err());
        let root = f.root.ancestors().last().unwrap();
        assert!(!source_allowed(root, &f.protected, None));
        assert!(!source_allowed(&f.source, &f.protected, Some(&f.source)));
    }
    #[test]
    fn oversized_sparse_files_are_rejected_without_reading_content() {
        let f = Fixture::new();
        File::create(f.source.join("too-large"))
            .unwrap()
            .set_len(MAX_FILE + 1)
            .unwrap();
        assert!(matches!(f.snapshot(), Err("folder_content_limit")));
        assert_eq!(fs::read_dir(&f.root).unwrap().count(), 2);
        fs::remove_file(f.source.join("too-large")).unwrap();
        for name in ["a", "b"] {
            File::create(f.source.join(name))
                .unwrap()
                .set_len(17 * 1024 * 1024)
                .unwrap()
        }
        assert!(matches!(f.snapshot(), Err("folder_content_limit")));
        assert_eq!(fs::read_dir(&f.root).unwrap().count(), 2);
    }
    #[test]
    fn hardlinks_are_rejected_before_pack() {
        let f = Fixture::new();
        fs::write(f.source.join("original"), b"synthetic").unwrap();
        fs::hard_link(f.source.join("original"), f.source.join("alias")).unwrap();
        assert!(matches!(f.snapshot(), Err("folder_link_rejected")));
        assert_eq!(fs::read_dir(&f.root).unwrap().count(), 2);
    }
    #[test]
    fn changes_between_plan_and_pack_are_detected() {
        let f = Fixture::new();
        let path = f.source.join("changing");
        fs::write(&path, b"before").unwrap();
        let root_handle = open_read(&f.source, true).unwrap();
        let mut budget = Budget::default();
        let plan = plan_directory(
            &f.source,
            String::new(),
            stamp(&root_handle).unwrap(),
            0,
            &mut budget,
        )
        .unwrap();
        fs::write(&path, b"changed-size").unwrap();
        let mut writer = ZipWriter::new(BoundedZip::new(MAX_ARCHIVE));
        assert!(matches!(pack(&plan, &mut writer), Err("folder_changed")));
    }
    #[test]
    fn entry_depth_and_archive_memory_limits_are_enforced() {
        let mut budget = Budget::default();
        for _ in 0..MAX_ENTRIES {
            budget.visit(1).unwrap()
        }
        assert!(budget.visit(1).is_err());
        assert!(Budget::default().visit(MAX_DEPTH + 1).is_err());
        let mut writer = BoundedZip::new(4);
        writer.write_all(b"1234").unwrap();
        assert!(writer.write_all(b"5").is_err());
        assert!(writer.seek(SeekFrom::Start(5)).is_err());
        assert_eq!(writer.inner.get_ref().len(), 4);
    }
    #[cfg(unix)]
    #[test]
    fn unix_symlinks_and_special_files_are_rejected() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        fs::write(f.root.join("outside"), b"synthetic").unwrap();
        symlink(f.root.join("outside"), f.source.join("link")).unwrap();
        assert!(matches!(f.snapshot(), Err("folder_link_rejected")));
    }
    #[cfg(windows)]
    #[test]
    fn windows_reparse_flag_and_regular_handle_are_checked() {
        // Exercise the same reparse-bit guard used for path and handle metadata;
        // creating a real junction/symlink requires separate platform privileges.
        assert!(reparse_attributes(0x400));
        assert!(reparse_attributes(0x410));
        assert!(!reparse_attributes(0x10));
        let f = Fixture::new();
        fs::write(f.source.join("regular"), b"synthetic").unwrap();
        assert!(!is_reparse(
            &fs::symlink_metadata(f.source.join("regular")).unwrap()
        ));
        assert!(f.snapshot().is_ok());
    }
}
