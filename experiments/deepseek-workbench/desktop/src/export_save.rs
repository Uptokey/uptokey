//! Save an already-generated lab export to an explicitly selected new file.
//! No archive extraction, opener, overwrite, or access to another workspace.
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{Cursor, Read, Write},
    path::{Component, Path, PathBuf},
    time::SystemTime,
};

const MAX_ARCHIVE: u64 = 34 * 1024 * 1024;
const MAX_DIAGNOSTICS: u64 = 64 * 1024;
type SaveError = &'static str;

#[derive(Clone, Copy)]
enum Format {
    #[cfg(test)]
    Zip,
    DiagnosticsJson,
}
impl Format {
    fn limit(self) -> u64 {
        match self {
            #[cfg(test)]
            Self::Zip => MAX_ARCHIVE,
            Self::DiagnosticsJson => MAX_DIAGNOSTICS,
        }
    }
    fn accepts_path(self, path: &Path) -> bool {
        match self {
            #[cfg(test)]
            Self::Zip => valid_zip_path(path),
            Self::DiagnosticsJson => valid_path(path, "json"),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Stamp {
    identity: (u64, u64),
    size: u64,
    modified: SystemTime,
    links: u64,
}

fn reparse(meta: &Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}
fn stamp(file: &File) -> Result<Stamp, SaveError> {
    let meta = file.metadata().map_err(|_| "export_metadata_failed")?;
    if !meta.is_file() || reparse(&meta) {
        return Err("export_file_rejected");
    }
    #[cfg(windows)]
    let (identity, links) = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, GetFileType, BY_HANDLE_FILE_INFORMATION, FILE_TYPE_DISK,
        };
        let handle = file.as_raw_handle();
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // Both values belong to this call; the handle remains owned by File.
        if unsafe { GetFileType(handle) } != FILE_TYPE_DISK
            || unsafe { GetFileInformationByHandle(handle, &mut info) } == 0
        {
            return Err("export_metadata_failed");
        }
        if info.dwFileAttributes & 0x400 != 0 {
            return Err("export_file_rejected");
        }
        (
            (
                info.dwVolumeSerialNumber as u64,
                ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
            ),
            info.nNumberOfLinks as u64,
        )
    };
    #[cfg(unix)]
    let (identity, links) = {
        use std::os::unix::fs::MetadataExt;
        ((meta.dev(), meta.ino()), meta.nlink())
    };
    #[cfg(not(any(windows, unix)))]
    let (identity, links) = return Err("export_platform_unsupported");
    if links != 1 {
        return Err("export_file_rejected");
    }
    Ok(Stamp {
        identity,
        size: meta.len(),
        modified: meta.modified().map_err(|_| "export_metadata_failed")?,
        links,
    })
}
fn valid_component(part: &std::ffi::OsStr) -> bool {
    let Some(name) = part.to_str() else {
        return false;
    };
    if name.is_empty()
        || name.ends_with([' ', '.'])
        || name.chars().any(|ch| {
            ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '/' | '\\')
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
fn valid_path(path: &Path, extension: &str) -> bool {
    path.is_absolute()
        && path
            .extension()
            .and_then(|part| part.to_str())
            .is_some_and(|part| part.eq_ignore_ascii_case(extension))
        && path.components().all(|part| match part {
            Component::Normal(part) => valid_component(part),
            Component::ParentDir | Component::CurDir => false,
            _ => true,
        })
}
fn valid_zip_path(path: &Path) -> bool {
    valid_path(path, "zip")
}
// Holding these directory handles prevents replacement of the selected path's
// ancestors on Windows. Reparse points are refused rather than followed.
fn guard_parents(path: &Path) -> Result<Vec<File>, SaveError> {
    let parent = path.parent().ok_or("export_path_invalid")?;
    let mut guards = Vec::new();
    for ancestor in parent.ancestors() {
        if guards.len() >= 128 {
            return Err("export_path_invalid");
        }
        let before = fs::symlink_metadata(ancestor).map_err(|_| "export_parent_unavailable")?;
        if !before.is_dir() || reparse(&before) {
            return Err("export_parent_rejected");
        }
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
                FILE_SHARE_WRITE,
            };
            options
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
        }
        let file = options
            .open(ancestor)
            .map_err(|_| "export_parent_unavailable")?;
        let after = file.metadata().map_err(|_| "export_metadata_failed")?;
        if !after.is_dir() || reparse(&after) {
            return Err("export_parent_rejected");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if (before.dev(), before.ino()) != (after.dev(), after.ino()) {
                return Err("export_parent_rejected");
            }
        }
        guards.push(file);
    }
    Ok(guards)
}
fn open_source(path: &Path, limit: u64) -> Result<File, SaveError> {
    let before = fs::symlink_metadata(path).map_err(|_| "export_source_unavailable")?;
    if !before.is_file() || reparse(&before) {
        return Err("export_file_rejected");
    }
    if before.len() == 0 || before.len() > limit {
        return Err("export_size_limit");
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        };
        options
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options
        .open(path)
        .map_err(|_| "export_source_unavailable")?;
    let opened = stamp(&file)?;
    if opened.size != before.len()
        || opened.modified != before.modified().map_err(|_| "export_metadata_failed")?
    {
        return Err("export_source_changed");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.identity != (before.dev(), before.ino()) {
            return Err("export_source_changed");
        }
    }
    Ok(file)
}
fn path_stamp(path: &Path) -> Result<Stamp, SaveError> {
    let meta = fs::symlink_metadata(path).map_err(|_| "export_file_changed")?;
    if !meta.is_file() || reparse(&meta) {
        return Err("export_file_rejected");
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        options
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    stamp(&options.open(path).map_err(|_| "export_file_changed")?)
}
struct Destination {
    path: PathBuf,
    file: Option<File>,
    identity: (u64, u64),
    committed: bool,
}
impl Destination {
    fn create(path: &Path) -> Result<Self, SaveError> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
            };
            options
                .share_mode(FILE_SHARE_READ)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
        }
        let file = options.open(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "export_destination_exists"
            } else {
                "export_destination_unavailable"
            }
        })?;
        let identity = stamp(&file)?.identity;
        Ok(Self {
            path: path.to_path_buf(),
            file: Some(file),
            identity,
            committed: false,
        })
    }
}
impl Drop for Destination {
    fn drop(&mut self) {
        let ours = !self.committed
            && path_stamp(&self.path).is_ok_and(|current| current.identity == self.identity);
        drop(self.file.take());
        // A new destination is the only possible cleanup target. If its identity
        // changed or cannot be established, retain it rather than delete it.
        if ours && path_stamp(&self.path).is_ok_and(|current| current.identity == self.identity) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Copy a generated ZIP without replacing any existing destination. The caller
/// owns SaveDialog and the generated export's scope; this helper never opens UI.
#[cfg(test)]
pub fn save_export(source: &Path, destination: &Path) -> Result<(), SaveError> {
    save_format(source, destination, Format::Zip)
}
/// Save the bounded native ZIP response directly to its selected destination.
/// Container and local-entry structure are checked in memory before creating
/// any file. The existing exporter owns content/CRC generation; no archive
/// entry is decompressed, extracted or executed here.
pub fn save_export_bytes(bytes: &[u8], destination: &Path) -> Result<(), &'static str> {
    if !valid_zip_path(destination) {
        return Err("export_path_invalid");
    }
    if bytes.is_empty() || bytes.len() as u64 > MAX_ARCHIVE {
        return Err("export_size_limit");
    }
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "export_format_invalid")?;
    let central = archive.central_directory_start();
    for index in 0..archive.len() {
        // Raw access admits both Stored and Python's Deflated export without
        // enabling another decompressor in this native application.
        let entry = archive
            .by_index_raw(index)
            .map_err(|_| "export_format_invalid")?;
        let end = entry
            .data_start()
            .checked_add(entry.compressed_size())
            .ok_or("export_format_invalid")?;
        if entry.encrypted()
            || entry
                .header_start()
                .checked_add(30)
                .is_none_or(|minimum| entry.data_start() < minimum)
            || end > central
            || central > bytes.len() as u64
            || !(entry.compression() == zip::CompressionMethod::STORE
                || entry.compression() == zip::CompressionMethod::DEFLATE)
        {
            return Err("export_format_invalid");
        }
    }
    let _destination_parents = guard_parents(destination)?;
    write_destination(bytes, destination, || Ok(()))
}
/// Diagnostics are generated by the existing runtime-health producer. This
/// verifies a bounded JSON object, not a second diagnostics sanitizer/schema.
pub fn save_diagnostics(source: &Path, destination: &Path) -> Result<(), SaveError> {
    save_format(source, destination, Format::DiagnosticsJson)
}
fn save_format(source: &Path, destination: &Path, format: Format) -> Result<(), SaveError> {
    if !format.accepts_path(source) || !format.accepts_path(destination) {
        return Err("export_path_invalid");
    }
    let _source_parents = guard_parents(source)?;
    let _destination_parents = guard_parents(destination)?;
    let mut input = open_source(source, format.limit())?;
    let before = stamp(&input)?;
    if before.size == 0 || before.size > format.limit() {
        return Err("export_size_limit");
    }
    // Admit the entire source before creating a destination. Allocation and
    // reads are bounded by its checked length; a separate byte detects growth.
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(before.size as usize)
        .map_err(|_| "export_memory_unavailable")?;
    bytes.resize(before.size as usize, 0);
    input
        .read_exact(&mut bytes)
        .map_err(|_| "export_source_changed")?;
    let mut extra = [0u8; 1];
    if input
        .read(&mut extra)
        .map_err(|_| "export_source_unavailable")?
        != 0
        || stamp(&input)? != before
        || path_stamp(source)? != before
    {
        return Err("export_source_changed");
    }
    let result = (|| {
        if matches!(format, Format::DiagnosticsJson)
            && !serde_json::from_slice::<serde_json::Value>(&bytes)
                .map_err(|_| "export_format_invalid")?
                .is_object()
        {
            return Err("export_format_invalid");
        }
        write_destination(&bytes, destination, || {
            if stamp(&input)? != before || path_stamp(source)? != before {
                return Err("export_file_changed");
            }
            Ok(())
        })
    })();
    bytes.fill(0);
    result
}
fn write_destination(
    bytes: &[u8],
    destination: &Path,
    verify: impl FnOnce() -> Result<(), SaveError>,
) -> Result<(), SaveError> {
    let mut output = Destination::create(destination)?;
    let file = output.file.as_mut().ok_or("export_save_failed")?;
    file.write_all(bytes).map_err(|_| "export_save_failed")?;
    file.flush().map_err(|_| "export_save_failed")?;
    file.sync_all().map_err(|_| "export_save_failed")?;
    let written = stamp(file)?;
    if written.identity != output.identity
        || written.size != bytes.len() as u64
        || path_stamp(destination)? != written
    {
        return Err("export_file_changed");
    }
    verify()?;
    drop(output.file.take());
    output.committed = true;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    struct Fixture {
        root: PathBuf,
        source: PathBuf,
        destination: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "uptokey-export-save-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir(&root).unwrap();
            let source = root.join("generated.zip");
            fs::write(&source, b"PK\x03\x04synthetic-workspace-export").unwrap();
            Self {
                source,
                destination: root.join("selected.zip"),
                root,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if self.root.is_absolute()
                && self.root.parent() == Some(std::env::temp_dir().as_path())
                && self
                    .root
                    .file_name()
                    .is_some_and(|part| part.to_string_lossy().starts_with("uptokey-export-save-"))
            {
                let _ = fs::remove_dir_all(&self.root);
            }
        }
    }
    fn memory_zip() -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file(
                "src/marker.txt",
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(b"uptokey-memory-export-canary").unwrap();
        writer.finish().unwrap().into_inner()
    }
    #[test]
    fn memory_export_saves_valid_zip_to_only_the_selected_new_destination() {
        let f = Fixture::new();
        let bytes = memory_zip();
        let before = fs::read(&f.source).unwrap();
        assert_eq!(save_export_bytes(&bytes, &f.destination), Ok(()));
        assert_eq!(fs::read(&f.destination).unwrap(), bytes);
        assert_eq!(fs::read(&f.source).unwrap(), before);
        assert_eq!(fs::read_dir(&f.root).unwrap().count(), 2);
        assert_eq!(
            save_export_bytes(&bytes, &f.destination),
            Err("export_destination_exists")
        );
        assert_eq!(fs::read(&f.destination).unwrap(), bytes);
    }
    #[test]
    fn memory_export_rejects_invalid_local_header_and_truncation_before_creating_destination() {
        let f = Fixture::new();
        let bytes = memory_zip();
        let mut corrupt = bytes.clone();
        corrupt[26..28].copy_from_slice(&u16::MAX.to_le_bytes());
        for invalid in [
            &bytes[..bytes.len() - 12],
            corrupt.as_slice(),
            b"PK\x03\x04invalid".as_slice(),
        ] {
            assert_eq!(
                save_export_bytes(invalid, &f.destination),
                Err("export_format_invalid")
            );
            assert!(!f.destination.exists());
        }
    }
    #[test]
    #[ignore = "explicit laboratory acceptance: supply UPTOKEY_EXPORT_ACCEPTED_FIXTURE"]
    fn memory_export_accepts_existing_python_deflated_archive_without_new_codec_features() {
        let f = Fixture::new();
        let path = std::env::var_os("UPTOKEY_EXPORT_ACCEPTED_FIXTURE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../output/exports/uptokey-workspace-1792795528565.zip")
            });
        let bytes =
            fs::read(path).expect("accepted synthetic Python export fixture must be available");
        let mut archive = zip::ZipArchive::new(Cursor::new(&bytes)).unwrap();
        assert!((0..archive.len()).all(|index| archive.by_index_raw(index).is_ok()));
        assert!(
            (0..archive.len()).any(|index| archive.by_index_raw(index).unwrap().compression()
                == zip::CompressionMethod::DEFLATE)
        );
        assert_eq!(save_export_bytes(&bytes, &f.destination), Ok(()));
        assert_eq!(fs::read(&f.destination).unwrap(), bytes);
    }
    #[test]
    fn memory_export_rejects_empty_oversized_and_invalid_destination_without_new_file() {
        let f = Fixture::new();
        assert_eq!(
            save_export_bytes(&[], &f.destination),
            Err("export_size_limit")
        );
        let oversized = vec![0u8; MAX_ARCHIVE as usize + 1];
        assert_eq!(
            save_export_bytes(&oversized, &f.destination),
            Err("export_size_limit")
        );
        assert_eq!(
            save_export_bytes(&memory_zip(), &f.root.join("target:stream.zip")),
            Err("export_path_invalid")
        );
        assert!(!f.destination.exists());
        assert_eq!(fs::read_dir(&f.root).unwrap().count(), 1);
    }
    #[cfg(unix)]
    #[test]
    fn memory_export_refuses_parent_and_target_links_without_touching_canary() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let bytes = memory_zip();
        let link = f.root.join("link.zip");
        symlink(&f.source, &link).unwrap();
        let before = fs::read(&f.source).unwrap();
        assert!(save_export_bytes(&bytes, &link).is_err());
        assert_eq!(fs::read(&f.source).unwrap(), before);
        let directory = f.root.join("linked-parent");
        symlink(&f.root, &directory).unwrap();
        assert_eq!(
            save_export_bytes(&bytes, &directory.join("selected.zip")),
            Err("export_parent_rejected")
        );
        assert!(!f.destination.exists());
    }
    #[test]
    fn diagnostics_save_copies_object_and_preserves_source_and_existing_destination() {
        let f = Fixture::new();
        let source = f.root.join("runtime.json");
        let destination = f.root.join("saved.json");
        let bytes=b"{\"schema\":1,\"application\":\"uptokey-harness-lab\",\"privateDataExported\":false}\n";
        fs::write(&source, bytes).unwrap();
        assert_eq!(save_diagnostics(&source, &destination), Ok(()));
        assert_eq!(fs::read(&destination).unwrap(), bytes);
        assert_eq!(fs::read(&source).unwrap(), bytes);
        assert_eq!(
            save_diagnostics(&source, &destination),
            Err("export_destination_exists")
        );
        assert_eq!(fs::read(&destination).unwrap(), bytes);
    }
    #[test]
    fn diagnostics_save_rejects_oversize_before_creating_destination() {
        let f = Fixture::new();
        let source = f.root.join("runtime.json");
        let destination = f.root.join("saved.json");
        File::create(&source)
            .unwrap()
            .set_len(MAX_DIAGNOSTICS + 1)
            .unwrap();
        assert_eq!(
            save_diagnostics(&source, &destination),
            Err("export_size_limit")
        );
        assert!(!destination.exists());
        assert_eq!(fs::metadata(&source).unwrap().len(), MAX_DIAGNOSTICS + 1);
    }
    #[test]
    fn diagnostics_save_rejects_invalid_format_without_touching_existing_files() {
        let f = Fixture::new();
        let source = f.root.join("runtime.json");
        let destination = f.root.join("saved.json");
        for bytes in [
            b"[]".as_slice(),
            b"true".as_slice(),
            b"{malformed".as_slice(),
        ] {
            fs::write(&source, bytes).unwrap();
            assert_eq!(
                save_diagnostics(&source, &destination),
                Err("export_format_invalid")
            );
            assert!(!destination.exists());
            assert_eq!(fs::read(&source).unwrap(), bytes);
        }
        fs::write(&source, b"{}").unwrap();
        assert_eq!(
            save_diagnostics(&source, &f.destination),
            Err("export_path_invalid")
        );
        assert_eq!(
            save_diagnostics(&f.source, &destination),
            Err("export_path_invalid")
        );
        assert!(!destination.exists());
        fs::write(&source, b"[]").unwrap();
        fs::write(&destination, b"existing-canary").unwrap();
        assert!(save_diagnostics(&source, &destination).is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"existing-canary");
    }
    #[test]
    fn saves_bytes_and_keeps_source() {
        let f = Fixture::new();
        let before = fs::read(&f.source).unwrap();
        assert_eq!(save_export(&f.source, &f.destination), Ok(()));
        assert_eq!(fs::read(&f.destination).unwrap(), before);
        assert_eq!(fs::read(&f.source).unwrap(), before);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&f.destination).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn existing_file_directory_and_source_are_never_replaced() {
        let f = Fixture::new();
        let before = fs::read(&f.source).unwrap();
        fs::write(&f.destination, b"keep-existing").unwrap();
        assert_eq!(
            save_export(&f.source, &f.destination),
            Err("export_destination_exists")
        );
        assert_eq!(fs::read(&f.destination).unwrap(), b"keep-existing");
        assert_eq!(
            save_export(&f.source, &f.source),
            Err("export_destination_exists")
        );
        assert_eq!(fs::read(&f.source).unwrap(), before);
        let directory = f.root.join("directory.zip");
        fs::create_dir(&directory).unwrap();
        assert!(save_export(&f.source, &directory).is_err());
        assert!(directory.is_dir());
    }
    #[test]
    fn rejects_relative_paths_nonzip_ads_and_device_names() {
        let f = Fixture::new();
        for path in [
            PathBuf::from("relative.zip"),
            f.root.join("not-a-zip.txt"),
            f.root.join("target:stream.zip"),
            f.root.join("NUL.zip"),
            f.root.join("trailing .zip "),
            f.root.join(".. escape").join(".. ").join("x.zip"),
        ] {
            assert_eq!(
                save_export(&f.source, &path),
                Err("export_path_invalid"),
                "{path:?}"
            );
        }
        assert!(!f.destination.exists());
    }
    #[test]
    fn rejects_empty_and_oversized_sources_before_creating_destination() {
        let f = Fixture::new();
        File::create(&f.source)
            .unwrap()
            .set_len(MAX_ARCHIVE + 1)
            .unwrap();
        assert_eq!(
            save_export(&f.source, &f.destination),
            Err("export_size_limit")
        );
        assert!(!f.destination.exists());
        assert_eq!(fs::metadata(&f.source).unwrap().len(), MAX_ARCHIVE + 1);
        File::create(&f.source).unwrap();
        assert_eq!(
            save_export(&f.source, &f.destination),
            Err("export_size_limit")
        );
        assert!(!f.destination.exists());
    }
    #[test]
    fn rejects_missing_and_directory_sources_without_output() {
        let f = Fixture::new();
        let directory = f.root.join("folder.zip");
        fs::create_dir(&directory).unwrap();
        assert!(save_export(&directory, &f.destination).is_err());
        assert!(save_export(&f.root.join("missing.zip"), &f.destination).is_err());
        assert!(!f.destination.exists());
        assert!(save_export(&f.source, &f.root.join("missing").join("selected.zip")).is_err());
    }
    #[test]
    fn removes_only_its_own_uncommitted_destination() {
        let f = Fixture::new();
        {
            let mut partial = Destination::create(&f.destination).unwrap();
            partial
                .file
                .as_mut()
                .unwrap()
                .write_all(b"partial")
                .unwrap();
        }
        assert!(!f.destination.exists());
        assert!(f.source.exists());
        fs::write(&f.destination, b"existing").unwrap();
        assert!(Destination::create(&f.destination).is_err());
        assert_eq!(fs::read(&f.destination).unwrap(), b"existing");
    }
    #[test]
    fn source_changes_are_detected_by_identity_and_size() {
        let f = Fixture::new();
        let before = path_stamp(&f.source).unwrap();
        fs::write(&f.source, b"changed").unwrap();
        assert_ne!(path_stamp(&f.source).unwrap(), before);
        assert!(!f.destination.exists());
        assert!(valid_zip_path(&f.root.join("UPPER.ZIP")));
    }
    #[cfg(unix)]
    #[test]
    fn refuses_source_target_and_parent_symlinks_preserving_external_files() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let outside = f.root.join("external.zip");
        fs::write(&outside, b"keep").unwrap();
        let link = f.root.join("link.zip");
        symlink(&outside, &link).unwrap();
        assert!(save_export(&link, &f.destination).is_err());
        assert!(save_export(&f.source, &link).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"keep");
        let parent = f.root.join("parent");
        symlink(&f.root, &parent).unwrap();
        assert!(save_export(&f.source, &parent.join("selected.zip")).is_err());
        assert!(!f.destination.exists());
    }
}
