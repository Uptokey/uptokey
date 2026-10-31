//! Resource admission for the canonical Harness window. This does not start a
//! supervisor, core, engine or helper. All state must already be provisioned by
//! the host outside the immutable bundle; no profile environment is changed.
use crate::{
    config::OperationalProfile,
    harness_layout::HarnessLayout,
    sidecar::{load_manifest, verify_sidecar, SidecarIntegrity},
};
use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const STATE_SELECTION: &str = "harness-state.json";
const SELECTION_LIMIT: u64 = 8192;

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StateSelection {
    schema: u8,
    state_root: PathBuf,
}

fn selection_invalid() -> String {
    "harness_state_selection_invalid".into()
}

// Reuse the original directory admission without creating a missing metadata
// parent during a read. The eventual write provisions only native app-data.
fn check_selection_parent(directory: &Path) -> Result<(), String> {
    if !directory.is_absolute()
        || directory.components().any(|part| {
            matches!(
                part,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )
        })
    {
        return Err(selection_invalid());
    }
    #[cfg(windows)]
    if directory
        .as_os_str()
        .to_string_lossy()
        .split(['\\', '/'])
        .any(|part| matches!(part, "." | ".."))
    {
        return Err(selection_invalid());
    }
    let mut existing = directory;
    loop {
        match fs::symlink_metadata(existing) {
            Ok(_) => {
                return crate::harness_layout::provision_state_directory(existing)
                    .map_err(|_| selection_invalid())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                existing = existing.parent().ok_or_else(selection_invalid)?;
            }
            Err(_) => return Err(selection_invalid()),
        }
    }
}

fn selection_file_metadata(path: &Path) -> Result<Option<fs::Metadata>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(selection_invalid()),
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(selection_invalid());
        }
    }
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() == 0
        || metadata.len() > SELECTION_LIMIT
    {
        return Err(selection_invalid());
    }
    Ok(Some(metadata))
}

fn read_selection(directory: &Path) -> Result<Option<StateSelection>, String> {
    check_selection_parent(directory)?;
    let path = directory.join(STATE_SELECTION);
    if selection_file_metadata(&path)?.is_none() {
        return Ok(None);
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    } // FILE_FLAG_OPEN_REPARSE_POINT
    let file = options.open(&path).map_err(|_| selection_invalid())?;
    let opened = file.metadata().map_err(|_| selection_invalid())?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if opened.file_attributes() & 0x400 != 0 {
            return Err(selection_invalid());
        }
    }
    if !opened.is_file() || opened.len() == 0 || opened.len() > SELECTION_LIMIT {
        return Err(selection_invalid());
    }
    let mut bytes = Vec::new();
    file.take(SELECTION_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| selection_invalid())?;
    if bytes.len() as u64 > SELECTION_LIMIT {
        return Err(selection_invalid());
    }
    let value: StateSelection = serde_json::from_slice(&bytes).map_err(|_| selection_invalid())?;
    if value.schema != 1 {
        return Err(selection_invalid());
    }
    Ok(Some(value))
}

fn confirm_selection(layout: &HarnessLayout, saved: &StateSelection) -> Result<(), String> {
    // This validates saved roots even when the host supplied an explicit env
    // root. A broken prior selection is never bypassed or silently replaced.
    let previous = HarnessLayout::installed(
        layout.resource_lab(),
        &saved.state_root,
        layout.protected_source_root(),
        layout.node(),
    )
    .map_err(|_| selection_invalid())?;
    if previous.state_root() != layout.state_root() {
        return Err("harness_state_selection_conflict".into());
    }
    Ok(())
}

fn persist_selection(directory: &Path, layout: &HarnessLayout) -> Result<(), String> {
    layout.revalidate().map_err(str::to_owned)?;
    crate::harness_layout::provision_state_directory(directory)
        .or_else(|_| crate::harness_layout::provision_state_directory(directory))
        .map_err(|_| selection_invalid())?;
    // App-data metadata cannot be redirected into the immutable resource tree.
    HarnessLayout::installed(
        layout.resource_lab(),
        directory,
        layout.protected_source_root(),
        layout.node(),
    )
    .map_err(|_| selection_invalid())?;
    let bytes = serde_json::to_vec(&StateSelection {
        schema: 1,
        state_root: layout.state_root().to_owned(),
    })
    .map_err(|_| selection_invalid())?;
    if bytes.len() as u64 > SELECTION_LIMIT {
        return Err(selection_invalid());
    }
    let temporary = directory.join(format!(".harness-state-{:016x}.tmp", rand::random::<u64>()));
    let mut created = false;
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|_| selection_invalid())?;
        created = true;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| selection_invalid())?;
        drop(file);
        // Unlike rename, hard_link creates the destination atomically without
        // replacing another process's committed selection. No partial JSON is
        // exposed. Unsupported filesystems fail closed.
        match fs::hard_link(&temporary, directory.join(STATE_SELECTION)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(selection_invalid()),
        }
        let saved = read_selection(directory)?.ok_or_else(selection_invalid)?;
        confirm_selection(layout, &saved)
    })();
    // Only the exact fresh temporary file is removed; never the committed file.
    if created {
        let _ = fs::remove_file(&temporary);
    }
    result
}

const LAB: &str = "harness/experiments/deepseek-workbench";
const REQUIRED: &[&str] = &[
    "harness/experiments/deepseek-workbench/scripts/diagnostics.mjs",
    "harness/experiments/deepseek-workbench/scripts/product-contract.mjs",
    "harness/experiments/deepseek-workbench/scripts/account.mjs",
    "harness/experiments/deepseek-workbench/scripts/restart-runtime.mjs",
    "harness/experiments/deepseek-workbench/scripts/installed-runtime.mjs",
    "harness/experiments/deepseek-workbench/scripts/podman-secret-input.mjs",
    "harness/quimera/tauri/scripts/verify-sidecar.mjs",
    "harness/quimera/tauri/tauri.harness.conf.json",
    "harness/experiments/deepseek-workbench/.local/computer-resource-current.json",
    "harness/quimera/tauri/Cargo.toml",
    "harness/quimera/tauri/tauri.conf.json",
    "harness/.github/workflows/ci.yml",
    "harness/runtime/harness.oci.tar",
    "harness/runtime/harness-runtime.json",
];

pub fn state_directory(app_data_dir: &Path, profile: &OperationalProfile) -> PathBuf {
    profile.storage_dir(app_data_dir.join("harness"), "harness")
}

/// Installed layout only; intentionally no checkout/legacy fallback. The
/// existing host-only Harness state override selects already existing state,
/// independently of the core's OperationalProfile. Helpers and WebView derive
/// their state from this one admitted layout, never from another env lookup.
pub fn admit_installed(
    resource_dir: &Path,
    app_data_dir: &Path,
    profile: &OperationalProfile,
) -> Result<HarnessLayout, String> {
    admit_selected_state(
        resource_dir,
        app_data_dir,
        profile,
        std::env::var_os("UPTOKEY_HARNESS_STATE_ROOT"),
    )
}

fn admit_selected_state(
    resource_dir: &Path,
    app_data_dir: &Path,
    profile: &OperationalProfile,
    explicit: Option<OsString>,
) -> Result<HarnessLayout, String> {
    // Metadata follows the same host profile isolation as the Harness state.
    // An explicit operational profile must never inherit a personal handoff.
    let selection_directory = profile.storage_dir(app_data_dir.to_owned(), "harness-state");
    let saved = read_selection(&selection_directory)?;
    let remember = explicit.is_some();
    let state = match explicit {
        // An explicit host location must already exist. In particular, never
        // provision an arbitrary env path before HarnessLayout validates its
        // canonical ancestry, type and separation from immutable resources.
        Some(path) => PathBuf::from(path),
        None if saved.is_some() => saved.as_ref().unwrap().state_root.clone(),
        None => {
            let state = state_directory(app_data_dir, profile);
            crate::harness_layout::provision_state_directory(&state).map_err(str::to_owned)?;
            state
        }
    };
    let layout = admit_sidecar(&resource_dir.join("resources/sidecar"), &state)?;
    if let Some(saved) = &saved {
        confirm_selection(&layout, saved)?;
    }
    if remember {
        persist_selection(&selection_directory, &layout)?;
    }
    Ok(layout)
}

/// Shared by installed admission and an offline acceptance observer. This must
/// run even when SupervisorHandle has adopted an existing daemon: adoption
/// verifies the remote identity, not the local Node/helper bytes.
pub fn admit_sidecar(sidecar: &Path, state: &Path) -> Result<HarnessLayout, String> {
    let manifest = load_manifest(sidecar)?;
    if !manifest.is_node_runtime()
        || REQUIRED
            .iter()
            .any(|name| !manifest.files.contains_key(*name))
        || manifest
            .files
            .contains_key("harness/quimera/tauri/resources/sidecar/manifest.json")
    {
        return Err("harness_sidecar_resources_incomplete".into());
    }
    let layout = HarnessLayout::installed(
        &sidecar.join(LAB),
        state,
        sidecar,
        &sidecar.join(&manifest.binary_name),
    )
    .map_err(str::to_owned)?;
    layout
        .packaged_sidecar_manifest()
        .map_err(str::to_owned)?
        .ok_or("harness_sidecar_manifest_unavailable")?;
    match verify_sidecar(sidecar) {
        SidecarIntegrity::Ok { .. } => {}
        SidecarIntegrity::Missing(reason) | SidecarIntegrity::Invalid(reason) => {
            return Err(reason)
        }
    }
    if load_manifest(sidecar)? != manifest {
        return Err("harness_sidecar_manifest_changed".into());
    }
    layout.revalidate().map_err(str::to_owned)?;
    Ok(layout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::{self, AttestedFile, SidecarManifest};
    use std::fs;

    struct Fixture {
        _temporary: tempfile::TempDir,
        root: PathBuf,
        resources: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let parent =
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../../output/harness-host-tests");
            fs::create_dir_all(&parent).unwrap();
            let temporary = tempfile::tempdir_in(parent).unwrap();
            let root = temporary.path().canonicalize().unwrap();
            let resources = root.join("application");
            let sidecar = resources.join("resources/sidecar");
            fs::create_dir_all(&sidecar).unwrap();
            let mut files = std::collections::BTreeMap::new();
            for name in REQUIRED
                .iter()
                .copied()
                .chain([sidecar::sidecar_binary_name(), "cli.js"])
            {
                let path = sidecar.join(name);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(&path, b"synthetic attested fixture, never executed").unwrap();
                files.insert(
                    name.to_owned(),
                    AttestedFile {
                        sha256: sidecar::sha256_hex(&path).unwrap(),
                        size_bytes: fs::metadata(&path).unwrap().len(),
                    },
                );
            }
            let manifest = SidecarManifest {
                schema_version: 2,
                binary_name: sidecar::sidecar_binary_name().into(),
                build_version: "0.0.0-test".into(),
                target: if cfg!(windows) {
                    "win32"
                } else if cfg!(target_os = "macos") {
                    "darwin"
                } else {
                    "linux"
                }
                .into(),
                runtime: Some("node".into()),
                entry: Some("cli.js".into()),
                files,
                ..Default::default()
            };
            fs::write(
                sidecar.join("manifest.json"),
                serde_json::to_vec(&manifest).unwrap(),
            )
            .unwrap();
            Self {
                _temporary: temporary,
                root,
                resources,
            }
        }
        fn admit(
            &self,
            profile: &OperationalProfile,
            explicit: Option<&Path>,
        ) -> Result<HarnessLayout, String> {
            admit_selected_state(
                &self.resources,
                &self.root.join("app-data"),
                profile,
                explicit.map(|path| path.as_os_str().to_owned()),
            )
        }
    }

    #[test]
    fn installed_default_and_override_use_one_admitted_state_for_helpers_and_webview() {
        let fixture = Fixture::new();
        let profile = OperationalProfile::default();
        let existing = fixture.root.join("original-harness");
        fs::create_dir(&existing).unwrap();
        fs::write(existing.join("sentinel"), b"preserve").unwrap();
        for (explicit, expected) in [
            (None, fixture.root.join("app-data/harness")),
            (Some(existing.as_path()), existing.clone()),
        ] {
            let layout = fixture.admit(&profile, explicit).unwrap();
            assert_eq!(layout.state_root(), expected);
            let webview = layout.state_root().join(".local/desktop-profile");
            crate::harness_layout::provision_state_directory(&webview).unwrap();
            layout.validate_profile(&webview).unwrap();
            assert_eq!(
                layout.resource_lab(),
                fixture.resources.join("resources/sidecar").join(LAB)
            );
        }
        assert_eq!(fs::read(existing.join("sentinel")).unwrap(), b"preserve");
        assert_eq!(profile, OperationalProfile::default());
    }

    #[test]
    fn explicit_missing_relative_empty_and_file_states_are_rejected_without_creation() {
        let fixture = Fixture::new();
        let profile = OperationalProfile::default();
        let missing = fixture.root.join("never-create/nested");
        let file = fixture.root.join("file");
        fs::write(&file, b"existing file").unwrap();
        for path in [&missing, &file, Path::new("relative-state"), Path::new("")] {
            assert!(fixture.admit(&profile, Some(path)).is_err());
        }
        assert!(!fixture.root.join("never-create").exists());
        assert!(!fixture.root.join("app-data").exists());
    }

    #[test]
    fn explicit_state_cannot_overlap_resources_or_replace_core_profile() {
        let fixture = Fixture::new();
        let core_profile = OperationalProfile {
            data_dir: Some(fixture.root.join("core-profile")),
            secret_service: Some("com.uptokey.quimera.proxy.fixture".into()),
        };
        let before = core_profile.clone();
        assert!(fixture
            .admit(&core_profile, Some(&fixture.resources))
            .is_err());
        assert!(fixture.admit(&core_profile, Some(&fixture.root)).is_err());
        let existing = fixture.root.join("harness-state");
        fs::create_dir(&existing).unwrap();
        assert_eq!(
            fixture
                .admit(&core_profile, Some(&existing))
                .unwrap()
                .state_root(),
            existing
        );
        assert_eq!(before, core_profile);
        assert!(!fixture.root.join("core-profile/desktop/harness").exists());
        assert!(fixture
            .root
            .join("core-profile/desktop/harness-state")
            .join(STATE_SELECTION)
            .is_file());
    }

    #[test]
    fn existing_core_profile_default_retains_original_storage_convention() {
        let fixture = Fixture::new();
        let root = fixture.root.join("core-profile");
        let profile = OperationalProfile {
            data_dir: Some(root.clone()),
            secret_service: None,
        };
        assert_eq!(
            fixture.admit(&profile, None).unwrap().state_root(),
            root.join("desktop/harness")
        );
    }

    #[test]
    fn persisted_handoff_cannot_escape_core_profile_isolation() {
        let fixture = Fixture::new();
        let personal = fixture.root.join("personal-harness");
        fs::create_dir(&personal).unwrap();
        fixture
            .admit(&OperationalProfile::default(), Some(&personal))
            .unwrap();
        let personal_record = fixture.root.join("app-data").join(STATE_SELECTION);
        let original = fs::read(&personal_record).unwrap();
        let isolated_root = fixture.root.join("isolated-core");
        let isolated = OperationalProfile {
            data_dir: Some(isolated_root.clone()),
            secret_service: None,
        };
        assert_eq!(
            fixture.admit(&isolated, None).unwrap().state_root(),
            isolated_root.join("desktop/harness")
        );
        let isolated_handoff = fixture.root.join("isolated-harness");
        fs::create_dir(&isolated_handoff).unwrap();
        fixture.admit(&isolated, Some(&isolated_handoff)).unwrap();
        assert!(isolated_root
            .join("desktop/harness-state")
            .join(STATE_SELECTION)
            .is_file());
        assert_eq!(
            fixture.admit(&isolated, None).unwrap().state_root(),
            isolated_handoff
        );
        assert_eq!(
            fixture
                .admit(&OperationalProfile::default(), None)
                .unwrap()
                .state_root(),
            personal
        );
        assert_eq!(fs::read(&personal_record).unwrap(), original);
    }

    #[test]
    fn explicit_linked_state_or_ancestor_is_rejected() {
        let fixture = Fixture::new();
        let target = fixture.root.join("actual");
        fs::create_dir_all(target.join("child")).unwrap();
        let alias = fixture.root.join("alias");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &alias).unwrap();
        #[cfg(windows)]
        if let Err(error) = std::os::windows::fs::symlink_dir(&target, &alias) {
            // Windows can deny fixture symlink creation without developer
            // mode; production still uses HarnessLayout's reparse rejection.
            assert_eq!(error.raw_os_error(), Some(1314));
            return;
        }
        for path in [&alias, &alias.join("child")] {
            assert!(fixture
                .admit(&OperationalProfile::default(), Some(path))
                .is_err());
        }
    }

    #[test]
    fn admitted_handoff_reopens_same_root_without_env_and_stores_only_public_metadata() {
        let fixture = Fixture::new();
        let state = fixture.root.join("preview-state");
        fs::create_dir_all(state.join(".local/desktop-profile")).unwrap();
        fs::write(
            state.join(".local/desktop-profile/sentinel"),
            b"existing profile",
        )
        .unwrap();
        let before = fixture
            .admit(&OperationalProfile::default(), Some(&state))
            .unwrap();
        let raw = fs::read(fixture.root.join("app-data").join(STATE_SELECTION)).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&raw).unwrap(),
            serde_json::json!({"schema":1,"stateRoot":before.state_root()})
        );
        let reopened = fixture.admit(&OperationalProfile::default(), None).unwrap();
        assert_eq!(reopened.state_root(), before.state_root());
        reopened
            .validate_profile(&state.join(".local/desktop-profile"))
            .unwrap();
        assert_eq!(
            fs::read(state.join(".local/desktop-profile/sentinel")).unwrap(),
            b"existing profile"
        );
        assert!(!fixture.root.join("app-data/harness").exists());
    }

    #[test]
    fn invalid_selection_never_falls_back_or_accepts_an_explicit_bypass() {
        for raw in [
            b"".as_slice(),
            b"{}",
            b"{broken",
            b"{\"schema\":2,\"stateRoot\":\"absent\"}",
            b"{\"schema\":1,\"stateRoot\":\"absent\",\"token\":\"forbidden\"}",
        ] {
            let fixture = Fixture::new();
            let directory = fixture.root.join("app-data");
            fs::create_dir(&directory).unwrap();
            fs::write(directory.join(STATE_SELECTION), raw).unwrap();
            let explicit = fixture.root.join("explicit");
            fs::create_dir(&explicit).unwrap();
            assert!(fixture.admit(&OperationalProfile::default(), None).is_err());
            assert!(fixture
                .admit(&OperationalProfile::default(), Some(&explicit))
                .is_err());
            assert!(!directory.join("harness").exists());
            assert_eq!(fs::read(directory.join(STATE_SELECTION)).unwrap(), raw);
        }
    }

    #[test]
    fn missing_saved_root_is_not_recreated_and_conflicting_selection_is_not_overwritten() {
        let fixture = Fixture::new();
        let first = fixture.root.join("first");
        let second = fixture.root.join("second");
        fs::create_dir(&first).unwrap();
        fs::create_dir(&second).unwrap();
        fixture
            .admit(&OperationalProfile::default(), Some(&first))
            .unwrap();
        let path = fixture.root.join("app-data").join(STATE_SELECTION);
        let original = fs::read(&path).unwrap();
        assert_eq!(
            fixture
                .admit(&OperationalProfile::default(), Some(&second))
                .unwrap_err(),
            "harness_state_selection_conflict"
        );
        assert_eq!(fs::read(&path).unwrap(), original);
        fs::rename(&first, fixture.root.join("retained-first")).unwrap();
        assert!(fixture.admit(&OperationalProfile::default(), None).is_err());
        assert!(fixture
            .admit(&OperationalProfile::default(), Some(&second))
            .is_err());
        assert!(!first.exists());
        assert!(!fixture.root.join("app-data/harness").exists());
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn selection_publication_is_atomic_and_same_or_conflicting_writers_never_overwrite() {
        for same in [true, false] {
            let fixture = Fixture::new();
            let first = fixture.root.join("first");
            let second = fixture.root.join("second");
            fs::create_dir(&first).unwrap();
            fs::create_dir(&second).unwrap();
            let sidecar = fixture.resources.join("resources/sidecar");
            let layouts = [
                admit_sidecar(&sidecar, &first).unwrap(),
                admit_sidecar(&sidecar, if same { &first } else { &second }).unwrap(),
            ];
            let directory = fixture.root.join("app-data");
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let mut results = Vec::new();
            std::thread::scope(|scope| {
                let workers: Vec<_> = layouts
                    .iter()
                    .map(|layout| {
                        let barrier = barrier.clone();
                        let directory = &directory;
                        scope.spawn(move || {
                            barrier.wait();
                            persist_selection(directory, layout)
                        })
                    })
                    .collect();
                for worker in workers {
                    results.push(worker.join().unwrap());
                }
            });
            assert_eq!(
                results.iter().filter(|result| result.is_ok()).count(),
                if same { 2 } else { 1 }
            );
            if !same {
                assert!(results
                    .iter()
                    .any(|result| result.as_ref().err().map(String::as_str)
                        == Some("harness_state_selection_conflict")));
            }
            let saved = read_selection(&directory).unwrap().unwrap();
            assert!(layouts
                .iter()
                .any(|layout| confirm_selection(layout, &saved).is_ok()));
            assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        }
    }

    #[test]
    fn oversized_and_nonfile_selections_are_rejected_without_default_creation() {
        let fixture = Fixture::new();
        let directory = fixture.root.join("app-data");
        fs::create_dir(&directory).unwrap();
        let path = directory.join(STATE_SELECTION);
        fs::write(&path, vec![b' '; (SELECTION_LIMIT + 1) as usize]).unwrap();
        assert!(fixture.admit(&OperationalProfile::default(), None).is_err());
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(fixture.admit(&OperationalProfile::default(), None).is_err());
        assert!(!directory.join("harness").exists());
    }

    #[test]
    fn linked_selection_file_and_linked_metadata_parent_are_rejected() {
        let fixture = Fixture::new();
        let directory = fixture.root.join("app-data");
        fs::create_dir(&directory).unwrap();
        let outside = fixture.root.join("other-record");
        fs::write(&outside, b"{}").unwrap();
        let alias = directory.join(STATE_SELECTION);
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &alias).unwrap();
        #[cfg(windows)]
        if let Err(error) = std::os::windows::fs::symlink_file(&outside, &alias) {
            assert_eq!(error.raw_os_error(), Some(1314));
            return;
        }
        assert!(fixture.admit(&OperationalProfile::default(), None).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"{}");
        let parent_alias = fixture.root.join("app-data-link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&directory, &parent_alias).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&directory, &parent_alias).unwrap();
        assert!(read_selection(&parent_alias).is_err());
        assert!(!directory.join("harness").exists());
    }
}
