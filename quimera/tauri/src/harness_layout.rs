//! Explicit resource/state paths for the existing Harness host.
//!
//! This module validates paths, not package authenticity. A native installed
//! entry must first verify its schema-2 sidecar and derive these paths from the
//! Tauri resource/app-data directories. It must not redirect the core profile.
use std::{
    fs,
    path::{Component, Path, PathBuf},
};

/// Create only native host-derived state directories. Existing ancestors must
/// be real directories, never symlinks/reparse points. No core profile changes.
pub fn provision_state_directory(path: &Path) -> Result<(), &'static str> {
    // Verbatim Windows paths can expose a slash-containing component as Normal
    // even though the OS interprets it as traversal during directory creation.
    #[cfg(windows)]
    if path
        .as_os_str()
        .to_string_lossy()
        .split(['\\', '/'])
        .any(|part| matches!(part, "." | ".."))
    {
        return Err("harness_layout_path_invalid");
    }
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return Err("harness_layout_path_invalid");
    }
    if path.exists() {
        return checked_path(path, true).map(|_| ());
    }
    let parent = path.parent().ok_or("harness_layout_path_invalid")?;
    provision_state_directory(parent)?;
    fs::create_dir(path).map_err(|_| "harness_state_create_failed")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "harness_state_create_failed")?;
    }
    checked_path(path, true).map(|_| ())
}

#[derive(Clone, Debug)]
pub struct HarnessLayout {
    resource_lab: PathBuf,
    state_root: PathBuf,
    protected_source_root: PathBuf,
    node: PathBuf,
}

fn canonical_packaged_node(root: &Path, node: &Path, macos: bool) -> bool {
    node.parent() == Some(root)
        || (macos && node == root.join("UptokeyCore.app/Contents/MacOS/uptokey"))
}
impl HarnessLayout {
    /// Validate already existing paths without creating or moving state. The
    /// caller remains responsible for the executable/resource attestation.
    pub fn installed(
        resource_lab: &Path,
        state_root: &Path,
        protected_source_root: &Path,
        node: &Path,
    ) -> Result<Self, &'static str> {
        let layout = Self {
            resource_lab: checked_path(resource_lab, true)?,
            state_root: checked_path(state_root, true)?,
            protected_source_root: checked_path(protected_source_root, true)?,
            node: checked_path(node, false)?,
        };
        if intersects(&layout.resource_lab, &layout.state_root)
            || intersects(&layout.protected_source_root, &layout.state_root)
        {
            return Err("harness_layout_roots_overlap");
        }
        if !path_key(&layout.resource_lab).starts_with(&path_key(&layout.protected_source_root)) {
            return Err("harness_layout_protected_root_invalid");
        }
        if !matches!(
            layout.node.file_name().and_then(|name| name.to_str()),
            Some("node" | "node.exe" | "uptokey" | "uptokey-windows.exe")
        ) {
            return Err("harness_layout_node_invalid");
        }
        // Executables are immutable resources, never supplied from mutable state.
        if intersects(&layout.node, &layout.state_root) {
            return Err("harness_layout_node_invalid");
        }
        Ok(layout)
    }

    pub fn resource_lab(&self) -> &Path {
        &self.resource_lab
    }
    pub fn state_root(&self) -> &Path {
        &self.state_root
    }
    pub fn protected_source_root(&self) -> &Path {
        &self.protected_source_root
    }
    pub fn node(&self) -> &Path {
        &self.node
    }

    /// The canonical installed host supplies the already attested sidecar Node.
    /// Derive its manifest; never accept a manifest path from the WebView or env.
    /// Standalone/development Node retains the existing packaging metadata path.
    pub fn packaged_sidecar_manifest(&self) -> Result<Option<PathBuf>, &'static str> {
        self.revalidate()?;
        if !matches!(
            self.node.file_name().and_then(|name| name.to_str()),
            Some("uptokey" | "uptokey-windows.exe")
        ) {
            return Ok(None);
        }
        if !canonical_packaged_node(
            &self.protected_source_root,
            &self.node,
            cfg!(target_os = "macos"),
        ) || self.resource_lab
            != self
                .protected_source_root
                .join("harness/experiments/deepseek-workbench")
        {
            return Err("harness_layout_sidecar_invalid");
        }
        checked_path(&self.protected_source_root.join("manifest.json"), false).map(Some)
    }

    /// A WebView profile belongs to this Harness state root, never the core's
    /// operational profile or the immutable package resources.
    pub fn validate_profile(&self, profile: &Path) -> Result<(), &'static str> {
        self.revalidate()?;
        let actual = checked_path(profile, true)?;
        if actual != self.state_root.join(".local/desktop-profile") {
            return Err("harness_layout_profile_invalid");
        }
        Ok(())
    }

    /// Recheck before starting a helper; this is not a capability against a
    /// concurrently hostile filesystem or a substitute for package attestation.
    pub fn revalidate(&self) -> Result<(), &'static str> {
        Self::installed(
            &self.resource_lab,
            &self.state_root,
            &self.protected_source_root,
            &self.node,
        )
        .map(|_| ())
    }

    pub fn resource_file(&self, relative: &Path) -> Result<PathBuf, &'static str> {
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err("harness_layout_resource_invalid");
        }
        self.revalidate()?;
        checked_path(&self.resource_lab.join(relative), false)
    }

    /// Refuse snapshots of state/resources or a parent containing either tree.
    /// Only metadata is inspected here; the existing folder snapshotter retains
    /// its own finite admission, exclusions and read-only file checks.
    pub fn validate_import_source(&self, source: &Path) -> Result<(), &'static str> {
        self.revalidate()?;
        let source = checked_path(source, true)?;
        if intersects(&source, &self.state_root) || intersects(&source, &self.protected_source_root)
        {
            return Err("folder_protected_root");
        }
        Ok(())
    }
}

fn linked(meta: &fs::Metadata) -> bool {
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

fn checked_path(path: &Path, directory: bool) -> Result<PathBuf, &'static str> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return Err("harness_layout_path_invalid");
    }
    for (index, ancestor) in path.ancestors().enumerate() {
        let meta = fs::symlink_metadata(ancestor).map_err(|_| "harness_layout_path_unavailable")?;
        if linked(&meta) {
            return Err("harness_layout_link_rejected");
        }
        if (index > 0 || directory) && !meta.is_dir() || index == 0 && !directory && !meta.is_file()
        {
            return Err("harness_layout_type_invalid");
        }
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "harness_layout_path_unavailable")?;
    // Windows canonicalize adds the extended-length prefix; compare its actual
    // components, allowing only that spelling change and filesystem case.
    if path_key(path) != path_key(&canonical) {
        return Err("harness_layout_path_not_canonical");
    }
    Ok(canonical)
}

fn path_key(path: &Path) -> Vec<String> {
    path.components()
        .map(|part| {
            #[cfg(windows)]
            {
                use std::path::Prefix;
                if let Component::Prefix(prefix) = part {
                    match prefix.kind() {
                        Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
                            return format!("{}:", (letter as char).to_ascii_uppercase())
                        }
                        Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
                            return format!(
                                "UNC/{}/{}",
                                server.to_string_lossy(),
                                share.to_string_lossy()
                            )
                            .to_uppercase()
                        }
                        _ => {}
                    }
                }
                part.as_os_str().to_string_lossy().to_uppercase()
            }
            #[cfg(not(windows))]
            {
                part.as_os_str().to_string_lossy().into_owned()
            }
        })
        .collect()
}

fn intersects(left: &Path, right: &Path) -> bool {
    let left = path_key(left);
    let right = path_key(right);
    left.starts_with(&right) || right.starts_with(&left)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn packaged_node_accepts_only_the_exact_nested_macos_bundle() {
        let root = Path::new("sidecar");
        let nested = root.join("UptokeyCore.app/Contents/MacOS/uptokey");
        assert!(canonical_packaged_node(root, &root.join("uptokey"), false));
        assert!(canonical_packaged_node(root, &nested, true));
        assert!(!canonical_packaged_node(root, &nested, false));
        assert!(!canonical_packaged_node(
            root,
            &root.join("Other.app/Contents/MacOS/uptokey"),
            true
        ));
    }

    struct Fixture {
        root: PathBuf,
        resources: PathBuf,
        state: PathBuf,
        node: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            // Keep destructive fixture operations under the caller's writable
            // build workspace; Windows app-container TEMP can lack rename rights.
            let parent = Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("output/harness-layout-tests");
            fs::create_dir_all(&parent).unwrap();
            let root = parent.canonicalize().unwrap().join(format!(
                "uptokey-harness-layout-{}-{stamp}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            let resources = root.join("resources");
            let state = root.join("state");
            fs::create_dir(&resources).unwrap();
            fs::create_dir(&state).unwrap();
            fs::create_dir(resources.join("scripts")).unwrap();
            fs::write(
                resources.join("scripts/diagnostics.mjs"),
                b"// synthetic resource",
            )
            .unwrap();
            let node = resources.join(if cfg!(windows) { "node.exe" } else { "node" });
            fs::write(&node, b"synthetic executable metadata only").unwrap();
            Self {
                root,
                resources,
                state,
                node,
            }
        }
        fn layout(&self) -> HarnessLayout {
            HarnessLayout::installed(&self.resources, &self.state, &self.resources, &self.node)
                .unwrap()
        }
    }

    #[test]
    fn provision_state_creates_only_valid_directories_and_preserves_existing_bytes() {
        let fixture = Fixture::new();
        let target = fixture.state.join("new/.local/desktop-profile");
        provision_state_directory(&target).unwrap();
        fs::write(target.join("sentinel"), b"synthetic preserved bytes").unwrap();
        provision_state_directory(&target).unwrap();
        assert_eq!(
            fs::read(target.join("sentinel")).unwrap(),
            b"synthetic preserved bytes"
        );
        assert!(provision_state_directory(&target.join("sentinel/child")).is_err());
        assert!(provision_state_directory(Path::new("relative/state")).is_err());
        // PathBuf::join normalizes `..` for Windows verbatim paths; retain the
        // raw spelling so this actually exercises rejection, not a sibling.
        let traversal = PathBuf::from(format!("{}/../escape", fixture.state.display()));
        assert!(provision_state_directory(&traversal).is_err());
        assert!(!fixture.root.join("escape").exists());
    }

    #[test]
    fn installed_layout_manifest_is_derived_only_for_canonical_sidecar_tree() {
        let fixture = Fixture::new();
        assert_eq!(fixture.layout().packaged_sidecar_manifest().unwrap(), None);
        let lab = fixture
            .resources
            .join("harness/experiments/deepseek-workbench");
        fs::create_dir_all(&lab).unwrap();
        let node = fixture.resources.join(if cfg!(windows) {
            "uptokey-windows.exe"
        } else {
            "uptokey"
        });
        fs::write(&node, b"synthetic node").unwrap();
        fs::write(fixture.resources.join("manifest.json"), b"{}").unwrap();
        let layout =
            HarnessLayout::installed(&lab, &fixture.state, &fixture.resources, &node).unwrap();
        assert_eq!(
            layout.packaged_sidecar_manifest().unwrap(),
            Some(
                fixture
                    .resources
                    .canonicalize()
                    .unwrap()
                    .join("manifest.json")
            )
        );
        let wrong = HarnessLayout::installed(
            &fixture.resources,
            &fixture.state,
            &fixture.resources,
            &node,
        )
        .unwrap();
        assert_eq!(
            wrong.packaged_sidecar_manifest().unwrap_err(),
            "harness_layout_sidecar_invalid"
        );
        fs::remove_file(fixture.resources.join("manifest.json")).unwrap();
        assert!(layout.packaged_sidecar_manifest().is_err());
    }

    #[test]
    fn installed_layout_accepts_separate_existing_roots_without_creating_mutable_directories() {
        let fixture = Fixture::new();
        let layout = fixture.layout();
        assert_eq!(
            layout.resource_lab(),
            fixture.resources.canonicalize().unwrap()
        );
        assert_eq!(layout.state_root(), fixture.state.canonicalize().unwrap());
        assert!(layout
            .resource_file(Path::new("scripts/diagnostics.mjs"))
            .is_ok());
        assert_eq!(fs::read_dir(&fixture.state).unwrap().count(), 0);
        assert_eq!(fs::read_dir(&fixture.resources).unwrap().count(), 2);
        assert!(layout
            .resource_file(Path::new("../state/private.json"))
            .is_err());
    }

    #[test]
    fn installed_layout_rejects_overlap_missing_roots_and_incomplete_protection_without_writes() {
        let fixture = Fixture::new();
        let nested = fixture.resources.join("nested");
        fs::create_dir(&nested).unwrap();
        for (resource, state) in [
            (&fixture.resources, &fixture.resources),
            (&fixture.resources, &nested),
            (&nested, &fixture.resources),
        ] {
            assert_eq!(
                HarnessLayout::installed(resource, state, &fixture.resources, &fixture.node)
                    .unwrap_err(),
                "harness_layout_roots_overlap"
            );
        }
        let missing = fixture.root.join("missing");
        assert!(HarnessLayout::installed(
            &fixture.resources,
            &missing,
            &fixture.resources,
            &fixture.node
        )
        .is_err());
        assert!(!missing.exists());
        assert_eq!(
            HarnessLayout::installed(&fixture.resources, &fixture.state, &nested, &fixture.node)
                .unwrap_err(),
            "harness_layout_protected_root_invalid"
        );
        assert!(HarnessLayout::installed(
            Path::new("resources"),
            &fixture.state,
            &fixture.resources,
            &fixture.node
        )
        .is_err());
    }

    #[test]
    fn installed_layout_import_guard_rejects_state_resources_and_ancestors_but_allows_sibling_project(
    ) {
        let fixture = Fixture::new();
        let layout = fixture.layout();
        let project = fixture.root.join("synthetic-project");
        fs::create_dir(&project).unwrap();
        for path in [&fixture.resources, &fixture.state, &fixture.root] {
            assert_eq!(
                layout.validate_import_source(path),
                Err("folder_protected_root")
            );
        }
        assert!(layout.validate_import_source(&project).is_ok());
        fs::rename(&fixture.state, fixture.root.join("state-moved")).unwrap();
        assert!(layout.revalidate().is_err());
    }

    #[test]
    fn installed_layout_protected_package_rejects_state_in_sibling_resource_tree() {
        let fixture = Fixture::new();
        let package = fixture.resources.join("application");
        let lab = package.join("lab");
        let sibling = package.join("other-resources");
        fs::create_dir(&package).unwrap();
        fs::create_dir(&lab).unwrap();
        fs::create_dir(&sibling).unwrap();
        assert_eq!(
            HarnessLayout::installed(&lab, &sibling, &fixture.resources, &fixture.node)
                .unwrap_err(),
            "harness_layout_roots_overlap"
        );
        assert!(
            HarnessLayout::installed(&lab, &fixture.state, &fixture.resources, &fixture.node)
                .is_ok()
        );
    }

    #[test]
    fn installed_layout_runtime_name_admission_does_not_assert_binary_attestation() {
        let fixture = Fixture::new();
        for name in ["node", "node.exe", "uptokey", "uptokey-windows.exe"] {
            let node = fixture.resources.join(name);
            fs::write(&node, b"synthetic, not attested").unwrap();
            assert!(HarnessLayout::installed(
                &fixture.resources,
                &fixture.state,
                &fixture.resources,
                &node
            )
            .is_ok());
        }
        let invalid = fixture.resources.join("untrusted.exe");
        fs::write(&invalid, b"synthetic").unwrap();
        assert_eq!(
            HarnessLayout::installed(
                &fixture.resources,
                &fixture.state,
                &fixture.resources,
                &invalid
            )
            .unwrap_err(),
            "harness_layout_node_invalid"
        );
        let mutable = fixture.state.join("node.exe");
        fs::write(&mutable, b"synthetic").unwrap();
        assert_eq!(
            HarnessLayout::installed(
                &fixture.resources,
                &fixture.state,
                &fixture.resources,
                &mutable
            )
            .unwrap_err(),
            "harness_layout_node_invalid"
        );
    }

    #[cfg(unix)]
    #[test]
    fn installed_layout_rejects_symlinked_ancestor_before_accepting_resource_or_state() {
        let fixture = Fixture::new();
        let alias = fixture.root.join("alias");
        std::os::unix::fs::symlink(&fixture.resources, &alias).unwrap();
        assert_eq!(
            HarnessLayout::installed(&alias, &fixture.state, &fixture.root, &fixture.node)
                .unwrap_err(),
            "harness_layout_link_rejected"
        );
        assert_eq!(
            fixture
                .layout()
                .resource_file(Path::new("scripts/../../alias/scripts/diagnostics.mjs")),
            Err("harness_layout_resource_invalid")
        );
    }

    #[test]
    fn installed_layout_profile_is_exact_existing_state_profile() {
        let fixture = Fixture::new();
        let layout = fixture.layout();
        let local = fixture.state.join(".local");
        fs::create_dir(&local).unwrap();
        let profile = local.join("desktop-profile");
        fs::create_dir(&profile).unwrap();
        assert!(layout.validate_profile(&profile).is_ok());
        assert_eq!(
            layout.validate_profile(&fixture.state),
            Err("harness_layout_profile_invalid")
        );
        let other = local.join("other-profile");
        fs::create_dir(&other).unwrap();
        assert_eq!(
            layout.validate_profile(&other),
            Err("harness_layout_profile_invalid")
        );
        assert!(layout
            .validate_profile(&local.join("missing-profile"))
            .is_err());
        fs::rename(&local, fixture.state.join("moved-local")).unwrap();
        assert!(layout.validate_profile(&profile).is_err());
    }
}
