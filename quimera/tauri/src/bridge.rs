//! Bridge de comandos Tauri tipados – expõe operações ao frontend.
use crate::config;
use crate::sidecar::{probe_health, ProbeOutcome, PROXY_HOST, PROXY_PORT};
use crate::supervisor::{restart_confirmation_timeout, ProxyStateView, SupervisorHandle};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::Duration;
use tauri::{AppHandle, Manager, State, Window};
use tauri_plugin_notification::NotificationExt;

#[path = "browser.rs"]
mod browser;

// Trusted first-party context transfer. The existing TUI credential is resolved
// only inside the verified canonical CLI; neither bearer nor code contents cross IPC.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceContextApproval {
    pub id: String,
    pub user_code: String,
    pub conversation_id: String,
    pub expected_revision: u64,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceContextMetadata {
    pub id: String,
    pub title: String,
    pub revision: u64,
    pub project_id: String,
}

const CONTEXT_HELPER_TIMEOUT: Duration = Duration::from_secs(30);
const CONTEXT_OUTPUT_LIMIT: usize = 65_536;

fn context_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                *byte == b'-'
            } else {
                byte.is_ascii_digit() || (b'a'..=b'f').contains(byte)
            }
        })
        && bytes[14] == b'4'
        && b"89ab".contains(&bytes[19])
}

fn context_project_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 100
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
}

fn context_conversation_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) {
                *byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

fn validate_context_approval(request: &WorkspaceContextApproval) -> Result<(), String> {
    if !context_uuid(&request.id)
        || !context_conversation_id(&request.conversation_id)
        || request.user_code.len() != 8
        || !request.user_code.bytes().all(|c| c.is_ascii_hexdigit())
        || request.expected_revision == 0
        || request.expected_revision > 9_007_199_254_740_991
    {
        return Err("context_link_invalid_request".into());
    }
    Ok(())
}

fn public_context_error(value: &serde_json::Value) -> String {
    match value
        .get("error")
        .and_then(|v| v.get("code"))
        .and_then(|v| v.as_str())
    {
        Some(
            code @ ("unauthorized"
            | "context_link_invalid_request"
            | "context_scope_denied"
            | "context_link_invalid"
            | "context_not_owned"
            | "context_link_pending_or_expired"
            | "context_link_conflict"
            | "context_project_required"
            | "local_auth_rate_limited"
            | "tui_client_identity_invalid"
            | "tui_client_identity_unavailable"
            | "tui_native_key_missing"
            | "tui_native_key_invalid"
            | "tui_native_key_unavailable"
            | "context_link_invalid_response"),
        ) => code.into(),
        _ => "context_link_failed".into(),
    }
}

fn parse_context_list(value: serde_json::Value) -> Result<Vec<WorkspaceContextMetadata>, String> {
    let raw = value
        .get("contexts")
        .and_then(|v| v.as_array())
        .ok_or_else(|| public_context_error(&value))?;
    if raw.len() > 50 {
        return Err("context_link_invalid_response".into());
    }
    let mut ids = std::collections::HashSet::new();
    raw.iter()
        .map(|item| {
            let row: WorkspaceContextMetadata = serde_json::from_value(item.clone())
                .map_err(|_| "context_link_invalid_response".to_string())?;
            if !context_conversation_id(&row.id)
                || !context_project_id(&row.project_id)
                || !ids.insert(row.id.clone())
                || row.title.encode_utf16().count() > 256
                || row.title.chars().any(|c| c.is_control())
                || row.revision == 0
                || row.revision > 9_007_199_254_740_991
            {
                return Err("context_link_invalid_response".into());
            }
            Ok(row)
        })
        .collect()
}

fn no_reparse_path(path: &std::path::Path) -> Result<(), String> {
    for component in path.ancestors() {
        let meta = std::fs::symlink_metadata(component)
            .map_err(|_| "context_helper_integrity_failed".to_string())?;
        if meta.file_type().is_symlink() {
            return Err("context_helper_integrity_failed".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err("context_helper_integrity_failed".into());
            }
        }
    }
    Ok(())
}

fn context_runtime_entry_valid(manifest: &crate::sidecar::SidecarManifest, macos: bool) -> bool {
    let expected = if macos && manifest.binary_name == "UptokeyCore.app/Contents/MacOS/uptokey" {
        "UptokeyCore.app/Contents/MacOS/cli.js"
    } else {
        "cli.js"
    };
    manifest.entry.as_deref() == Some(expected)
}
fn verified_context_command(
    sidecar_dir: &std::path::Path,
    operation: &str,
) -> Result<std::process::Command, String> {
    if !["list", "approve"].contains(&operation) {
        return Err("context_link_invalid_request".into());
    }
    no_reparse_path(sidecar_dir)?;
    let root = sidecar_dir
        .canonicalize()
        .map_err(|_| "context_helper_integrity_failed".to_string())?;
    let manifest_path = root.join("manifest.json");
    no_reparse_path(&manifest_path)?;
    if std::fs::metadata(&manifest_path)
        .map_err(|_| "context_helper_integrity_failed".to_string())?
        .len()
        > 8 * 1024 * 1024
    {
        return Err("context_helper_integrity_failed".into());
    }
    let before = crate::sidecar::sha256_hex(&manifest_path)?;
    let manifest = crate::sidecar::load_manifest(&root)
        .map_err(|_| "context_helper_integrity_failed".to_string())?;
    if !manifest.is_node_runtime()
        || !context_runtime_entry_valid(&manifest, cfg!(target_os = "macos"))
    {
        return Err("context_helper_runtime_unsupported".into());
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ContextAttestation {
        entry: String,
        files: Vec<String>,
        external_specifiers: Vec<String>,
    }
    let raw: serde_json::Value = serde_json::from_slice(
        &std::fs::read(&manifest_path)
            .map_err(|_| "context_helper_integrity_failed".to_string())?,
    )
    .map_err(|_| "context_helper_integrity_failed".to_string())?;
    let context: ContextAttestation = serde_json::from_value(
        raw.get("contextHelper")
            .cloned()
            .ok_or("context_helper_integrity_failed")?,
    )
    .map_err(|_| "context_helper_integrity_failed".to_string())?;
    let base = if cfg!(target_os = "macos")
        && manifest.binary_name == "UptokeyCore.app/Contents/MacOS/uptokey"
    {
        "UptokeyCore.app/Contents/MacOS/"
    } else {
        ""
    };
    let core_root = root.join(base);
    if context.entry != format!("{base}workspace-context-helper.js")
        || context.external_specifiers != ["@napi-rs/keyring", "undici"]
        || context.files.len() > 384
    {
        return Err("context_helper_integrity_failed".into());
    }
    let names: std::collections::BTreeSet<String> = context
        .files
        .iter()
        .map(|name| {
            name.strip_prefix(base)
                .map(str::to_owned)
                .ok_or_else(|| "context_helper_integrity_failed".to_string())
        })
        .collect::<Result<_, _>>()?;
    let binary_name = manifest
        .binary_name
        .strip_prefix(base)
        .ok_or("context_helper_integrity_failed")?;
    if names.len() != context.files.len()
        || !names.contains(binary_name)
        || !names.contains("workspace-context-helper.js")
        || !names.contains("package.json")
        || !names.contains("node_modules/@napi-rs/keyring/package.json")
        || !names.contains("node_modules/@napi-rs/keyring/index.js")
        || !names.contains("node_modules/undici/package.json")
        || !names.contains("node_modules/undici/index.js")
        || (cfg!(target_os = "macos")
            && [
                "cli.js",
                "composition-worker.js",
                "service-schema-worker.js",
                "uptokey-macos-protected-keyring.node",
            ]
            .iter()
            .any(|name| !names.contains(*name)))
    {
        return Err("context_helper_integrity_failed".into());
    }
    if names.iter().any(|name| {
        ![binary_name, "workspace-context-helper.js", "package.json"].contains(&name.as_str())
            && !(cfg!(target_os = "macos")
                && [
                    "cli.js",
                    "composition-worker.js",
                    "service-schema-worker.js",
                    "uptokey-macos-protected-keyring.node",
                ]
                .contains(&name.as_str()))
            && !name.starts_with("node_modules/@napi-rs/keyring/")
            && !name.starts_with("node_modules/@napi-rs/keyring-")
            && !name.starts_with("node_modules/undici/")
    }) {
        return Err("context_helper_integrity_failed".into());
    }
    for name in &names {
        let attested_name = format!("{base}{name}");
        let attested = manifest
            .files
            .get(&attested_name)
            .ok_or("context_helper_integrity_failed")?;
        let path = root.join(&attested_name);
        no_reparse_path(&path)?;
        if !path
            .canonicalize()
            .map_err(|_| "context_helper_integrity_failed".to_string())?
            .starts_with(&root)
        {
            return Err("context_helper_integrity_failed".into());
        }
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|_| "context_helper_integrity_failed".to_string())?;
        if !meta.is_file()
            || meta.len() != attested.size_bytes
            || crate::sidecar::sha256_hex(&path)? != attested.sha256
        {
            return Err("context_helper_integrity_failed".into());
        }
    }
    let undici: serde_json::Value = serde_json::from_slice(
        &std::fs::read(core_root.join("node_modules/undici/package.json"))
            .map_err(|_| "context_helper_integrity_failed".to_string())?,
    )
    .map_err(|_| "context_helper_integrity_failed".to_string())?;
    if undici["name"] != "undici"
        || undici["version"] != "7.30.0"
        || undici["main"] != "index.js"
        || ["dependencies", "optionalDependencies", "peerDependencies"]
            .iter()
            .any(|key| {
                undici
                    .get(key)
                    .is_some_and(|value| !value.as_object().is_some_and(|map| map.is_empty()))
            })
    {
        return Err("context_helper_integrity_failed".into());
    }
    // Attest the entire small declared package closure, including package.json
    // resolution, and reject files omitted from the focused declaration.
    let packages: std::collections::BTreeSet<_> = names
        .iter()
        .filter_map(|name| {
            if !name.starts_with("node_modules/") {
                return None;
            }
            let parts: Vec<_> = name.split('/').collect();
            if parts.len() >= 3 && parts[1] == "undici" {
                return Some(core_root.join("node_modules/undici"));
            }
            if parts.len() < 4 || parts[1] != "@napi-rs" || !parts[2].starts_with("keyring") {
                return None;
            }
            Some(core_root.join(parts[..3].join("/")))
        })
        .collect();
    if packages.is_empty() || !names.iter().any(|name| name.ends_with(".node")) {
        return Err("context_helper_integrity_failed".into());
    }
    let mut queue: Vec<_> = packages.into_iter().collect();
    while let Some(dir) = queue.pop() {
        no_reparse_path(&dir)?;
        for entry in
            std::fs::read_dir(&dir).map_err(|_| "context_helper_integrity_failed".to_string())?
        {
            let entry = entry.map_err(|_| "context_helper_integrity_failed".to_string())?;
            no_reparse_path(&entry.path())?;
            let meta = entry
                .metadata()
                .map_err(|_| "context_helper_integrity_failed".to_string())?;
            if meta.is_dir() {
                queue.push(entry.path());
            } else {
                let rel = entry
                    .path()
                    .strip_prefix(&core_root)
                    .map_err(|_| "context_helper_integrity_failed".to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                if !names.contains(&rel) {
                    return Err("context_helper_integrity_failed".into());
                }
            }
        }
    }
    if crate::sidecar::sha256_hex(&manifest_path)? != before {
        return Err("context_helper_integrity_failed".into());
    }
    let mut command = std::process::Command::new(root.join(&manifest.binary_name));
    command
        .arg(root.join(&context.entry))
        .arg(operation)
        .current_dir(&root)
        .env_clear()
        .envs(crate::sidecar::validated_child_env()?)
        .stdin(if operation == "approve" {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    Ok(command)
}

#[cfg(test)]
mod workspace_context_tests {
    use super::*;
    use crate::sidecar::{sha256_hex, sidecar_binary_name, AttestedFile, SidecarManifest};
    use std::collections::BTreeMap;
    use std::fs;

    #[test]
    fn context_runtime_entry_matches_the_attested_macos_bundle() {
        let mut manifest = crate::sidecar::SidecarManifest {
            binary_name: "UptokeyCore.app/Contents/MacOS/uptokey".into(),
            entry: Some("UptokeyCore.app/Contents/MacOS/cli.js".into()),
            ..Default::default()
        };
        assert!(super::context_runtime_entry_valid(&manifest, true));
        assert!(!super::context_runtime_entry_valid(&manifest, false));
        manifest.entry = Some("cli.js".into());
        assert!(!super::context_runtime_entry_valid(&manifest, true));
    }
    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let mut files = vec![
            sidecar_binary_name(),
            "cli.js",
            "workspace-context-helper.js",
            "package.json",
            "node_modules/@napi-rs/keyring/package.json",
            "node_modules/@napi-rs/keyring/index.js",
            "node_modules/@napi-rs/keyring-win32-x64-msvc/package.json",
            "node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.node",
            "node_modules/undici/package.json",
            "node_modules/undici/index.js",
            "node_modules/undici/lib/core/util.js",
        ];
        if cfg!(target_os = "macos") {
            files.extend([
                "composition-worker.js",
                "service-schema-worker.js",
                "uptokey-macos-protected-keyring.node",
            ]);
        }
        let mut attest = BTreeMap::new();
        for &name in &files {
            let path = dir.path().join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let content: &[u8] = if name == "node_modules/undici/package.json" {
                br#"{"name":"undici","version":"7.30.0","main":"index.js"}"#
            } else {
                b"synthetic attested fixture"
            };
            fs::write(&path, content).unwrap();
            attest.insert(
                name.to_string(),
                AttestedFile {
                    sha256: sha256_hex(&path).unwrap(),
                    size_bytes: fs::metadata(path).unwrap().len(),
                },
            );
        }
        let manifest = SidecarManifest {
            schema_version: 2,
            binary_name: sidecar_binary_name().into(),
            build_version: "0.1.0-test".into(),
            target: (if cfg!(windows) {
                "win32"
            } else if cfg!(target_os = "macos") {
                "darwin"
            } else {
                "linux"
            })
            .into(),
            runtime: Some("node".into()),
            entry: Some("cli.js".into()),
            files: attest,
            ..Default::default()
        };
        let mut value = serde_json::to_value(manifest).unwrap();
        value["contextHelper"] = serde_json::json!({"entry":"workspace-context-helper.js","files":files.into_iter().filter(|n|cfg!(target_os = "macos") || *n!="cli.js").collect::<Vec<_>>(),"externalSpecifiers":["@napi-rs/keyring","undici"]});
        fs::write(
            dir.path().join("manifest.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        dir
    }

    #[test]
    fn context_approval_is_exact_owner_conversation_cas() {
        let input = serde_json::json!({"id":"f76ef1cd-2a7c-4ce0-9d73-c2d9b6b55b52","userCode":"A1B2C3D4","conversationId":"6e8a4f83-b723-44d6-8b80-5c7406d42be6","expectedRevision":7});
        let request: WorkspaceContextApproval = serde_json::from_value(input.clone()).unwrap();
        assert!(validate_context_approval(&request).is_ok());
        let mut extra = input;
        extra["owner"] = serde_json::json!("spoof");
        assert!(serde_json::from_value::<WorkspaceContextApproval>(extra).is_err());
        let mut invalid = request;
        invalid.expected_revision = 0;
        assert!(validate_context_approval(&invalid).is_err());
    }
    #[test]
    fn context_metadata_rejects_unlinked_and_duplicate_rows() {
        let row = serde_json::json!({"id":"f76ef1cd-2a7c-4ce0-9d73-c2d9b6b55b52","title":"Chosen project","revision":7,"projectId":"6e8a4f83-b723-44d6-8b80-5c7406d42be6"});
        assert_eq!(
            parse_context_list(serde_json::json!({"contexts":[row.clone()]})).unwrap()[0].revision,
            7
        );
        assert!(parse_context_list(serde_json::json!({"contexts":[row.clone(),row]})).is_err());
        assert!(parse_context_list(serde_json::json!({"contexts":[{"id":"bad","title":"empty project","revision":7,"projectId":null}]})).is_err());
    }
    #[test]
    fn context_project_metadata_matches_canonical_workspace_identifier_boundary() {
        for id in [
            "project_legacy-1",
            "A",
            "6E8A4F83-B723-44D6-8B80-5C7406D42BE6",
        ] {
            assert!(context_project_id(id));
        }
        assert!(context_project_id(&"A".repeat(100)));
        for id in ["", "../project", "project/path", " project", "project\n"] {
            assert!(!context_project_id(id));
        }
        assert!(!context_project_id(&"A".repeat(101)));
    }
    #[test]
    fn context_conversation_metadata_uses_canonical_general_uuid_without_weakening_challenge() {
        let conversation = "A1B2C3D4-1234-7234-1234-A1B2C3D4E5F6";
        assert!(context_conversation_id(conversation));
        assert!(!context_uuid(conversation));
        let request = WorkspaceContextApproval {
            id: "f76ef1cd-2a7c-4ce0-9d73-c2d9b6b55b52".into(),
            user_code: "A1B2C3D4".into(),
            conversation_id: conversation.into(),
            expected_revision: 1,
        };
        assert!(validate_context_approval(&request).is_ok());
        assert!(parse_context_list(serde_json::json!({"contexts":[{"id":conversation,"title":"Canonical","revision":1,"projectId":"project_legacy-1"}]})).is_ok());
    }
    #[test]
    fn context_error_never_reflects_arbitrary_helper_output() {
        assert_eq!(
            public_context_error(&serde_json::json!({"error":{"code":"PRIVATE_CANARY"}})),
            "context_link_failed"
        );
    }
    #[test]
    fn context_helper_command_has_only_fixed_attested_entry_and_operation() {
        let dir = fixture();
        let command = verified_context_command(dir.path(), "list").unwrap();
        let args: Vec<_> = command
            .get_args()
            .map(|x| x.to_string_lossy().to_string())
            .collect();
        assert_eq!(
            args,
            vec![
                dir.path()
                    .canonicalize()
                    .unwrap()
                    .join("workspace-context-helper.js")
                    .to_string_lossy()
                    .to_string(),
                "list".into()
            ]
        );
        assert!(verified_context_command(dir.path(), "arbitrary-command").is_err());
        assert!(!command
            .get_envs()
            .any(|(name, value)| name == "NODE_OPTIONS" && value.is_none()));
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn context_helper_rejects_unattested_protected_keyring_binding() {
        let dir = fixture();
        let manifest = dir.path().join("manifest.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        value["contextHelper"]["files"]
            .as_array_mut()
            .unwrap()
            .retain(|entry| entry.as_str() != Some("uptokey-macos-protected-keyring.node"));
        fs::write(manifest, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(verified_context_command(dir.path(), "list").is_err());
    }
    #[test]
    fn context_helper_refuses_tampered_entry_runtime_and_addon() {
        for name in [
            "workspace-context-helper.js",
            sidecar_binary_name(),
            "node_modules/@napi-rs/keyring-win32-x64-msvc/keyring.node",
            "node_modules/undici/index.js",
            "node_modules/undici/lib/core/util.js",
        ] {
            let dir = fixture();
            fs::write(dir.path().join(name), b"tampered").unwrap();
            assert!(verified_context_command(dir.path(), "list").is_err());
        }
    }
    #[test]
    fn context_helper_refuses_omitted_package_file_and_dependency_drift() {
        let dir = fixture();
        fs::write(
            dir.path()
                .join("node_modules/@napi-rs/keyring/unattested.js"),
            b"unexpected package executable",
        )
        .unwrap();
        assert!(verified_context_command(dir.path(), "approve").is_err());
        let dir = fixture();
        let path = dir.path().join("manifest.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        value["contextHelper"]["externalSpecifiers"] =
            serde_json::json!(["@napi-rs/keyring", "unexpected-package"]);
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(verified_context_command(dir.path(), "list").is_err());
    }
    #[test]
    fn context_helper_refuses_unattested_manifest_path() {
        let dir = fixture();
        let path = dir.path().join("manifest.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        value["contextHelper"]["files"][0] = serde_json::json!("../outside.bin");
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(verified_context_command(dir.path(), "list").is_err());
    }
    #[test]
    fn context_helper_refuses_undici_omission_and_extra_nested_file() {
        let dir = fixture();
        let manifest = dir.path().join("manifest.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        value["contextHelper"]["files"]
            .as_array_mut()
            .unwrap()
            .retain(|name| name != "node_modules/undici/lib/core/util.js");
        fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(verified_context_command(dir.path(), "list").is_err());
        let dir = fixture();
        fs::write(
            dir.path()
                .join("node_modules/undici/lib/core/unattested.js"),
            b"extra",
        )
        .unwrap();
        assert!(verified_context_command(dir.path(), "list").is_err());
    }
    #[test]
    fn context_helper_refuses_undici_version_drift_even_when_rehashed() {
        let dir = fixture();
        let name = "node_modules/undici/package.json";
        let package = dir.path().join(name);
        fs::write(
            &package,
            br#"{"name":"undici","version":"7.31.0","main":"index.js"}"#,
        )
        .unwrap();
        let manifest = dir.path().join("manifest.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
        value["files"][name] = serde_json::json!({"sha256":sha256_hex(&package).unwrap(), "size_bytes":fs::metadata(package).unwrap().len()});
        fs::write(&manifest, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(verified_context_command(dir.path(), "list").is_err());
    }
    #[test]
    fn context_pipe_rejects_oversize_without_retaining_raw_output() {
        let rx = context_pipe(
            std::io::Cursor::new(vec![b'x'; 70_000]),
            CONTEXT_OUTPUT_LIMIT,
        );
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1)).unwrap(),
            Err("context_helper_output_limit".into())
        );
    }
    #[test]
    fn context_process_fixture() {
        if let Ok(mode) = std::env::var("UPTOKEY_CONTEXT_SYNTHETIC_CHILD") {
            if mode == "timeout" {
                std::thread::sleep(Duration::from_secs(10));
            } else {
                use std::io::Write;
                std::io::stdout().write_all(&vec![b'x'; 70_000]).unwrap();
            }
        }
    }
    #[test]
    fn context_child_timeout_kills_only_owned_synthetic_process() {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "bridge::workspace_context_tests::context_process_fixture",
                "--nocapture",
            ])
            .env("UPTOKEY_CONTEXT_SYNTHETIC_CHILD", "timeout")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let started = std::time::Instant::now();
        assert_eq!(
            run_context_process(command, None, Duration::from_millis(120)),
            Err("context_helper_timeout".into())
        );
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}

struct ContextChild {
    child: std::process::Child,
    #[cfg(windows)]
    job: windows_sys::Win32::Foundation::HANDLE,
}

impl ContextChild {
    fn own(child: std::process::Child) -> Result<Self, String> {
        let mut owned = Self {
            child,
            #[cfg(windows)]
            job: 0,
        };
        #[cfg(windows)]
        unsafe {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::System::JobObjects::*;
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job == 0 {
                return Err("context_helper_unavailable".into());
            }
            owned.job = job;
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            ) == 0
                || AssignProcessToJobObject(job, owned.child.as_raw_handle() as _) == 0
            {
                return Err("context_helper_unavailable".into());
            }
        }
        Ok(owned)
    }
}

impl Drop for ContextChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        #[cfg(windows)]
        unsafe {
            if self.job != 0 {
                windows_sys::Win32::Foundation::CloseHandle(self.job);
            }
        }
    }
}

fn context_pipe<R: std::io::Read + Send + 'static>(
    mut reader: R,
    limit: usize,
) -> Receiver<Result<Vec<u8>, String>> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 4096];
        let result = loop {
            match reader.read(&mut chunk) {
                Ok(0) => break Ok(bytes),
                Ok(n) if bytes.len() + n <= limit => bytes.extend_from_slice(&chunk[..n]),
                Ok(_) => break Err("context_helper_output_limit".into()),
                Err(_) => break Err("context_helper_unavailable".into()),
            }
        };
        let _ = tx.send(result);
    });
    rx
}

fn run_context_process(
    mut command: std::process::Command,
    input: Option<&[u8]>,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    use std::io::Write;
    let deadline = std::time::Instant::now() + timeout;
    let mut owned = ContextChild::own(
        command
            .spawn()
            .map_err(|_| "context_helper_unavailable".to_string())?,
    )?;
    let out = context_pipe(
        owned
            .child
            .stdout
            .take()
            .ok_or("context_helper_unavailable")?,
        CONTEXT_OUTPUT_LIMIT,
    );
    let err = context_pipe(
        owned
            .child
            .stderr
            .take()
            .ok_or("context_helper_unavailable")?,
        8192,
    );
    if let Some(bytes) = input {
        if bytes.len() > 4096 {
            return Err("context_link_invalid_request".into());
        }
        owned
            .child
            .stdin
            .take()
            .ok_or("context_helper_unavailable")?
            .write_all(bytes)
            .map_err(|_| "context_helper_unavailable".to_string())?;
    }
    let mut output = None;
    let mut stderr_done = false;
    let status = loop {
        if output.is_none() {
            match out.try_recv() {
                Ok(Ok(bytes)) => output = Some(bytes),
                Ok(Err(code)) => return Err(code),
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    return Err("context_helper_unavailable".into())
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => (),
            }
        }
        if !stderr_done {
            match err.try_recv() {
                Ok(Ok(_)) => stderr_done = true,
                Ok(Err(code)) => return Err(code),
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    return Err("context_helper_unavailable".into())
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => (),
            }
        }
        if std::time::Instant::now() >= deadline {
            return Err("context_helper_timeout".into());
        }
        if let Some(status) = owned
            .child
            .try_wait()
            .map_err(|_| "context_helper_unavailable".to_string())?
        {
            if output.is_some() && stderr_done {
                break status;
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let value: serde_json::Value = serde_json::from_slice(&output.unwrap_or_default())
        .map_err(|_| "context_link_invalid_response".to_string())?;
    if !status.success() {
        return Err(public_context_error(&value));
    }
    Ok(value)
}

fn context_helper(
    sidecar_dir: std::path::PathBuf,
    approval: Option<WorkspaceContextApproval>,
) -> Result<serde_json::Value, String> {
    let start = std::time::Instant::now();
    if let Some(request) = &approval {
        validate_context_approval(request)?;
    }
    let command = verified_context_command(
        &sidecar_dir,
        if approval.is_some() {
            "approve"
        } else {
            "list"
        },
    )?;
    let remaining = CONTEXT_HELPER_TIMEOUT
        .checked_sub(start.elapsed())
        .ok_or("context_helper_timeout")?;
    let input = approval
        .map(|request| serde_json::to_vec(&request))
        .transpose()
        .map_err(|_| "context_link_invalid_request".to_string())?;
    run_context_process(command, input.as_deref(), remaining)
}

#[tauri::command]
pub async fn list_workspace_contexts(
    app: AppHandle,
) -> Result<Vec<WorkspaceContextMetadata>, String> {
    let resource = app
        .path()
        .resource_dir()
        .map_err(|_| "context_helper_unavailable".to_string())?;
    let sidecar_dir = crate::sidecar::resolve_sidecar_dir(&resource);
    let value = tauri::async_runtime::spawn_blocking(move || context_helper(sidecar_dir, None))
        .await
        .map_err(|_| "context_helper_unavailable".to_string())??;
    parse_context_list(value)
}

#[tauri::command]
pub async fn approve_workspace_context(
    app: AppHandle,
    request: WorkspaceContextApproval,
) -> Result<bool, String> {
    validate_context_approval(&request)?;
    let resource = app
        .path()
        .resource_dir()
        .map_err(|_| "context_helper_unavailable".to_string())?;
    let sidecar_dir = crate::sidecar::resolve_sidecar_dir(&resource);
    let value =
        tauri::async_runtime::spawn_blocking(move || context_helper(sidecar_dir, Some(request)))
            .await
            .map_err(|_| "context_helper_unavailable".to_string())??;
    if value.as_object().is_some_and(|object| {
        object.len() == 1 && object.get("approved") == Some(&serde_json::Value::Bool(true))
    }) {
        Ok(true)
    } else {
        Err("context_link_invalid_response".into())
    }
}

#[tauri::command]
pub fn proxy_address() -> String {
    format!("http://{}:{}", PROXY_HOST, PROXY_PORT)
}

fn is_proxy_ready(view: &ProxyStateView) -> bool {
    matches!(view, ProxyStateView::Ready { .. })
}

fn receive_restart_confirmation(
    confirmation: Receiver<ProxyStateView>,
    timeout: Duration,
) -> Result<ProxyStateView, RecvTimeoutError> {
    confirmation.recv_timeout(timeout)
}

async fn restart_confirmed(
    state: &SupervisorHandle,
    timeout: Duration,
) -> Result<ProxyStateView, ()> {
    let confirmation = state.request_restart_confirmed().map_err(|_| ())?;
    tauri::async_runtime::spawn_blocking(move || {
        receive_restart_confirmation(confirmation, timeout)
    })
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}

#[tauri::command]
pub async fn proxy_start(state: State<'_, SupervisorHandle>) -> Result<String, String> {
    // A ready daemon may be owned by this shell or reused from another client.
    if is_proxy_ready(&state.current()) {
        return Ok(proxy_address());
    }
    if let Ok(view) = restart_confirmed(&state, restart_confirmation_timeout()).await {
        if is_proxy_ready(&view) {
            return Ok(proxy_address());
        }
    }
    Err("proxy_start_timeout_or_failed".into())
}

#[tauri::command]
pub async fn proxy_stop(state: State<'_, SupervisorHandle>) -> Result<(), String> {
    // Stop monitoring/recovery in either ownership mode. The supervisor only
    // terminates its own child; an adopted daemon is never stopped or killed.
    match state.current() {
        ProxyStateView::Ready { .. }
        | ProxyStateView::Starting { .. }
        | ProxyStateView::Degraded { .. }
        | ProxyStateView::Failed { .. } => {
            state.request_stop();
            // Wait for the Stopped state (up to 10 s).
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while std::time::Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(200));
                if let ProxyStateView::Stopped = state.current() {
                    return Ok(());
                }
            }
            Err("proxy_stop_timeout".into())
        }
        ProxyStateView::Stopped => Ok(()),
    }
}

#[tauri::command]
pub async fn proxy_restart(state: State<'_, SupervisorHandle>) -> Result<String, String> {
    if let Ok(view) = restart_confirmed(&state, restart_confirmation_timeout()).await {
        if is_proxy_ready(&view) {
            return Ok(proxy_address());
        }
    }
    Err("proxy_restart_timeout".into())
}

#[tauri::command]
pub fn proxy_status(state: State<'_, SupervisorHandle>) -> Result<String, String> {
    let view = state.current();
    serde_json::to_string(&view).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn proxy_health(state: State<'_, SupervisorHandle>) -> Result<bool, String> {
    match probe_health(
        PROXY_HOST,
        PROXY_PORT,
        &state.ipc_secret,
        Duration::from_secs(2),
    ) {
        ProbeOutcome::Identified(_) => Ok(true),
        ProbeOutcome::Foreign => Ok(false),
        ProbeOutcome::Unreachable => Ok(false),
    }
}

// ---------------------------------------------------------------------------
// Native folder picker (selection only; never grants write access)
// ---------------------------------------------------------------------------

/// Abre o diálogo nativo de seleção de pasta. Devolve apenas o caminho
/// escolhido (ou `None` ao cancelar). Selecionar pasta NÃO concede escrita:
/// toda escrita continua governada pelo proxy (W5/consentimento), e o caminho
/// volta como string para registro de raiz de projeto na PWA.
#[tauri::command]
pub async fn pick_folder(window: Window) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let selected = tauri::async_runtime::spawn_blocking(move || {
        let picker = window.dialog().file();
        #[cfg(desktop)]
        let picker = picker.set_parent(&window);
        picker.blocking_pick_folder()
    })
    .await
    .map_err(|_| "dialog_unavailable".to_string())?;
    match selected {
        Some(path) => {
            let candidate = path
                .into_path()
                .map_err(|e| format!("dialog_path_unavailable:{}", e))?;
            Ok(Some(candidate.to_string_lossy().to_string()))
        }
        None => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// Theme & configuration bridge
// ---------------------------------------------------------------------------

fn verified_account_login_url(url: &str, origin: &str) -> Result<tauri::Url, String> {
    if url.len() > 2048 || url.bytes().any(|byte| byte <= 0x20 || byte == 0x7f) {
        return Err("account_login_url_invalid".into());
    }
    if origin.len() > 2048 || origin.bytes().any(|byte| byte <= 0x20 || byte == 0x7f) {
        return Err("account_service_origin_invalid".into());
    }
    let configured = tauri::Url::parse(origin).map_err(|_| "account_service_origin_invalid")?;
    if configured.origin().ascii_serialization() != origin
        || !configured.username().is_empty()
        || configured.password().is_some()
        || configured.query().is_some()
        || configured.fragment().is_some()
        || !(configured.scheme() == "https"
            || configured.scheme() == "http"
                && matches!(
                    configured.host_str(),
                    Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
                ))
    {
        return Err("account_service_origin_invalid".into());
    }
    let parsed = tauri::Url::parse(url).map_err(|_| "account_login_url_invalid")?;
    if url.len() > 2048
        || parsed.origin() != configured.origin()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
        || parsed.path() != "/api/account/native/authorize"
    {
        return Err("account_login_url_invalid".into());
    }
    let mut ids = 0;
    let mut languages = 0;
    for (key, value) in parsed.query_pairs() {
        match key.as_ref() {
            "id" => {
                ids += 1;
                let bytes = value.as_bytes();
                if bytes.len() != 36
                    || bytes[14] != b'4'
                    || !matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
                    || bytes.iter().enumerate().any(|(index, byte)| {
                        if matches!(index, 8 | 13 | 18 | 23) {
                            *byte != b'-'
                        } else {
                            !byte.is_ascii_hexdigit() || byte.is_ascii_uppercase()
                        }
                    })
                {
                    return Err("account_login_url_invalid".into());
                }
            }
            "lang" => {
                languages += 1;
                if !matches!(
                    value.as_ref(),
                    "en" | "pt-BR" | "es" | "fr" | "de" | "it" | "ja" | "ko" | "zh-CN" | "ar"
                ) {
                    return Err("account_login_url_invalid".into());
                }
            }
            _ => return Err("account_login_url_invalid".into()),
        }
    }
    if ids != 1 || languages > 1 {
        return Err("account_login_url_invalid".into());
    }
    Ok(parsed)
}

#[tauri::command]
pub async fn open_account_login(url: String) -> Result<(), String> {
    let configured = std::env::var("UPTOKEY_ACCOUNT_SERVICE_ORIGIN").ok();
    let origin = crate::account_urls::service_origin(configured.as_deref())?;
    let verified = verified_account_login_url(&url, &origin)?;
    open_verified_browser_url(verified).await
}

#[tauri::command]
pub async fn open_subscription_url(url: String) -> Result<(), String> {
    open_verified_browser_url(crate::account_urls::subscription_url(&url)?)
        .await
        .map_err(|_| "subscription_browser_unavailable".into())
}

async fn open_verified_browser_url(verified: tauri::Url) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || browser::open(&verified))
        .await
        .map_err(|_| "account_browser_unavailable".to_string())?
}

fn verified_provider_portal(provider_id: &str) -> Result<tauri::Url, String> {
    let value = match provider_id {
        "deepseek" => "https://platform.deepseek.com/",
        "openrouter" => "https://openrouter.ai/settings/credits",
        "gemini" => "https://aistudio.google.com/",
        "groq" => "https://console.groq.com/",
        "anthropic" => "https://console.anthropic.com/",
        "mistral" => "https://console.mistral.ai/",
        "cerebras" => "https://cloud.cerebras.ai/",
        "together" => "https://api.together.ai/",
        "openai" => "https://platform.openai.com/",
        "custom-openai" => "https://platform.openai.com/",
        "custom-ovhcloud" => "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/",
        "custom-cloudflare" => "https://dash.cloudflare.com/",
        "custom-google-cloud" => "https://console.cloud.google.com/",
        "custom-kimi" => "https://platform.moonshot.ai/console/api-keys",
        "custom-fireworks" => "https://fireworks.ai/account/api-keys",
        "custom-sambanova" => "https://cloud.sambanova.ai/",
        "custom-deepinfra" => "https://deepinfra.com/dash/api_keys",
        "custom-siliconflow" => "https://cloud.siliconflow.com/",
        "custom-nebius" => "https://tokenfactory.nebius.com/",
        "custom-novita" => "https://novita.ai/",
        "custom-minimax" => "https://platform.minimax.io/",
        "custom-pollinations" => "https://enter.pollinations.ai/",
        "uptokey-support" => "https://github.com/sponsors/Uptokey",
        _ => return Err("provider_portal_id_invalid".into()),
    };
    tauri::Url::parse(value).map_err(|_| "provider_portal_id_invalid".into())
}

#[tauri::command]
pub async fn open_provider_portal(provider_id: String) -> Result<(), String> {
    open_verified_browser_url(verified_provider_portal(&provider_id)?)
        .await
        .map_err(|_| "provider_portal_browser_unavailable".into())
}

fn verified_model_page_url(value: &str) -> Result<tauri::Url, String> {
    if value.len() > 2048 || value.bytes().any(|byte| byte <= 0x20 || byte == 0x7f) {
        return Err("model_page_url_invalid".into());
    }
    let url = tauri::Url::parse(value).map_err(|_| "model_page_url_invalid")?;
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("model_page_url_invalid".into());
    }
    let segments: Vec<_> = url.path().trim_matches('/').split('/').collect();
    let safe_segment = |segment: &&str| {
        !segment.is_empty()
            && !matches!(*segment, "." | "..")
            && segment
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    };
    // Registry tags are part of the path, never a URL port or shell command.
    let safe_model_tag = |segment: &str| match segment.split_once(':') {
        Some((name, tag)) => safe_segment(&name) && safe_segment(&tag),
        None => safe_segment(&segment),
    };
    let allowed = match url.host_str() {
        Some("ollama.com") => {
            url.path() == "/download"
                || (segments.len() == 2 || segments.len() == 3 && segments[2] == "tags")
                    && segments[0] == "library"
                    && safe_model_tag(segments[1])
        }
        Some("huggingface.co") => {
            (segments.len() == 2
                || segments.len() == 5
                    && segments[2] == "blob"
                    && segments[3] == "main"
                    && segments[4].ends_with(".safetensors"))
                && segments.iter().all(safe_segment)
                && !matches!(
                    segments[0],
                    "api" | "settings" | "oauth" | "login" | "logout" | "security"
                )
        }
        Some("lmstudio.ai" | "jan.ai") => url.path() == "/download",
        Some("docs.uptokey.com") => {
            matches!(
                segments[0],
                "en" | "pt-br" | "es" | "fr" | "de" | "it" | "ja" | "ko" | "zh-cn" | "ar"
            ) && (segments.len() == 1
                || segments.len() == 3
                    && segments[1] == "concepts"
                    && segments[2] == "local-models")
        }
        _ => false,
    };
    if !allowed {
        return Err("model_page_url_invalid".into());
    }
    Ok(url)
}

#[tauri::command]
pub async fn open_model_page(url: String) -> Result<(), String> {
    open_verified_browser_url(verified_model_page_url(&url)?)
        .await
        .map_err(|_| "model_page_browser_unavailable".into())
}

#[cfg(test)]
mod account_login_url_tests {
    use super::verified_account_login_url;
    const ID: &str = "12345678-1234-4234-8234-123456789abc";
    #[test]
    fn allows_only_configured_service_and_exact_challenge() {
        for lang in [
            "en", "pt-BR", "es", "fr", "de", "it", "ja", "ko", "zh-CN", "ar",
        ] {
            assert!(verified_account_login_url(
                &format!(
                    "https://account.example/api/account/native/authorize?id={ID}&lang={lang}"
                ),
                "https://account.example"
            )
            .is_ok());
        }
        assert!(verified_account_login_url(
            &format!("http://localhost:3000/api/account/native/authorize?id={ID}"),
            "http://localhost:3000"
        )
        .is_ok());
    }
    #[test]
    fn refuses_cross_origin_arbitrary_paths_and_duplicate_queries() {
        for suffix in [
            format!("/auth/login?id={ID}"),
            format!("/api/account/native/authorize?id={ID}&id={ID}"),
            format!("/api/account/native/authorize?id={ID}&returnTo=https://evil.example"),
            format!("/api/account/native/authorize?id={ID}#fragment"),
            format!("/api/account/native/authorize?id={ID}&lang=unknown"),
        ] {
            assert!(verified_account_login_url(
                &format!("https://account.example{suffix}"),
                "https://account.example"
            )
            .is_err());
        }
        assert!(verified_account_login_url(
            &format!("https://evil.example/api/account/native/authorize?id={ID}"),
            "https://account.example"
        )
        .is_err());
        assert!(verified_account_login_url(
            &format!("http://cloud.example/api/account/native/authorize?id={ID}"),
            "http://cloud.example"
        )
        .is_err());
        assert!(verified_account_login_url(
            &format!("https://account.example/api/account/native/authorize?id={ID}\n"),
            "https://account.example"
        )
        .is_err());
    }
    #[test]
    fn provider_portals_accept_only_curated_provider_ids() {
        use super::verified_provider_portal;
        for (id, expected) in [
            ("deepseek", "https://platform.deepseek.com/"),
            ("openrouter", "https://openrouter.ai/settings/credits"),
            ("gemini", "https://aistudio.google.com/"),
            ("groq", "https://console.groq.com/"),
            ("anthropic", "https://console.anthropic.com/"),
            ("mistral", "https://console.mistral.ai/"),
            ("cerebras", "https://cloud.cerebras.ai/"),
            ("together", "https://api.together.ai/"),
            ("openai", "https://platform.openai.com/"),
            ("custom-openai", "https://platform.openai.com/"),
            (
                "custom-ovhcloud",
                "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/",
            ),
            ("custom-cloudflare", "https://dash.cloudflare.com/"),
            ("custom-google-cloud", "https://console.cloud.google.com/"),
            (
                "custom-kimi",
                "https://platform.moonshot.ai/console/api-keys",
            ),
            ("custom-fireworks", "https://fireworks.ai/account/api-keys"),
            ("custom-sambanova", "https://cloud.sambanova.ai/"),
            ("custom-deepinfra", "https://deepinfra.com/dash/api_keys"),
            ("custom-siliconflow", "https://cloud.siliconflow.com/"),
            ("custom-nebius", "https://tokenfactory.nebius.com/"),
            ("custom-novita", "https://novita.ai/"),
            ("custom-minimax", "https://platform.minimax.io/"),
            ("custom-pollinations", "https://enter.pollinations.ai/"),
            ("uptokey-support", "https://github.com/sponsors/Uptokey"),
        ] {
            assert_eq!(verified_provider_portal(id).unwrap().as_str(), expected);
        }
        for id in [
            "",
            "custom-localai",
            "deepseek ",
            "https://evil.example/",
            "custom-kimi?key=secret",
            "../openrouter",
            "__proto__",
        ] {
            assert!(verified_provider_portal(id).is_err());
        }
    }
    #[test]
    fn official_model_pages_never_accept_credentials_or_arbitrary_targets() {
        use super::verified_model_page_url;
        for value in [
            "https://ollama.com/download",
            "https://ollama.com/library/qwen3",
            "https://ollama.com/library/qwen3/tags",
            "https://huggingface.co/Qwen/Qwen3-8B",
            "https://lmstudio.ai/download",
            "https://jan.ai/download",
        ] {
            assert!(verified_model_page_url(value).is_ok());
        }
        for lang in [
            "en", "pt-br", "es", "fr", "de", "it", "ja", "ko", "zh-cn", "ar",
        ] {
            assert!(verified_model_page_url(&format!(
                "https://docs.uptokey.com/{lang}/concepts/local-models"
            ))
            .is_ok());
            assert!(verified_model_page_url(&format!("https://docs.uptokey.com/{lang}/")).is_ok());
            for suffix in ["?token=secret", "#token", "/login", "/settings"] {
                assert!(verified_model_page_url(&format!(
                    "https://docs.uptokey.com/{lang}{suffix}"
                ))
                .is_err());
            }
        }
        for value in [
            "https://ollama.com/library/qwen3/admin",
            "https://ollama.com/library/qwen3/tags/download",
            "https://ollama.com/library/qwen3/tags?token=secret",
        ] {
            assert!(verified_model_page_url(value).is_err());
        }
        for value in [
            "https://evil.example/Qwen/Qwen3-8B",
            "http://ollama.com/download",
            "https://huggingface.co/a/b?token=secret",
            "https://user:secret@huggingface.co/a/b",
            "https://huggingface.co/api/models",
            "https://ollama.com/library/a\n",
            "https://huggingface.co/a/b#token",
            "https://lmstudio.ai/admin",
            "http://jan.ai/download",
            "https://jan.ai/download?key=secret",
            "https://user:secret@lmstudio.ai/download",
            "https://lmstudio.ai:444/download",
            "https://jan.ai/download#key",
            "https://docs.uptokey.com/en/concepts/local-models?token=secret",
            "https://docs.uptokey.com/unknown/concepts/local-models",
            "https://docs.uptokey.com/en/concepts/credentials",
            "https://docs.uptokey.com.evil.example/en/concepts/local-models",
        ] {
            assert!(verified_model_page_url(value).is_err());
        }
    }
    #[test]
    fn exact_model_variants_and_public_weight_pages_retain_the_same_url_boundary() {
        use super::verified_model_page_url;
        for value in [
            "https://ollama.com/library/qwen2.5:1.5b",
            "https://ollama.com/library/phi4-mini:latest",
            "https://ollama.com/library/gemma4:e4b",
            "https://ollama.com/library/qwen3:4b-q4_K_M",
            "https://huggingface.co/openai/whisper-large-v3/blob/main/model.safetensors",
        ] {
            assert!(verified_model_page_url(value).is_ok(), "{value}");
        }
        for value in [
            "https://ollama.com/library/qwen3:",
            "https://ollama.com/library/qwen3:4b:extra",
            "https://ollama.com/library/qwen3%3A4b",
            "https://ollama.com/library/qwen3:4b/admin",
            "https://ollama.com:444/library/qwen3:4b",
            "https://ollama.com/library/qwen3:4b?token=secret",
            "https://huggingface.co/openai/whisper-large-v3/resolve/main/model.safetensors",
            "https://huggingface.co/openai/whisper-large-v3/blob/main/script.js",
            "https://huggingface.co/settings/model/blob/main/model.safetensors",
            "https://huggingface.co/openai/whisper-large-v3/blob/main/model.safetensors?token=secret",
        ] { assert!(verified_model_page_url(value).is_err(), "{value}"); }
    }
}

#[tauri::command]
pub fn get_system_theme(window: Window) -> Result<String, String> {
    match window.theme() {
        Ok(tauri::Theme::Dark) => Ok("dark".into()),
        Ok(tauri::Theme::Light) => Ok("light".into()),
        Ok(_) => Ok("system".into()),
        Err(e) => Err(e.to_string()),
    }
}

fn shell_config_directory(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let default = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(app
        .state::<config::OperationalProfile>()
        .storage_dir(default, "shell"))
}

#[tauri::command]
pub fn get_preferred_theme(app: AppHandle) -> Result<String, String> {
    let config_dir = shell_config_directory(&app)?;
    let cfg = config::load_or_migrate(&config_dir);
    Ok(cfg.theme.unwrap_or_else(|| "system".into()))
}

#[tauri::command]
pub fn set_preferred_theme(app: AppHandle, mode: String) -> Result<(), String> {
    let config_dir = shell_config_directory(&app)?;
    let mut cfg = config::load_or_migrate(&config_dir);
    cfg.theme = Some(mode);
    config::save(&config_dir, &cfg)
}

#[tauri::command]
pub fn resolve_theme(app: AppHandle, window: Window) -> Result<String, String> {
    let config_dir = shell_config_directory(&app)?;
    let cfg = config::load_or_migrate(&config_dir);
    match cfg.theme.as_deref() {
        Some("dark") => Ok("dark".into()),
        Some("light") => Ok("light".into()),
        Some("system") | None => get_system_theme(window),
        Some(other) => Ok(other.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Notification bridge (sanitized, no secret leakage)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn notification_show(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Diagnostics export – uses diagnostics module for sanitization.
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn diagnostics_export(
    state: State<'_, SupervisorHandle>,
    app: AppHandle,
) -> Result<String, String> {
    let version = app.package_info().version.to_string();
    let bundle_id = app.config().identifier.clone();
    let config_dir = shell_config_directory(&app)?;
    let cfg = config::load_or_migrate(&config_dir);

    let payload = crate::diagnostics::build_diagnostics(
        &version,
        &bundle_id,
        &state.current(),
        None,
        cfg.schema_version,
        &[],
    );

    let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let log_dir = app
        .state::<config::OperationalProfile>()
        .storage_dir(log_dir, "logs");
    crate::diagnostics::export_diagnostics(&log_dir, &payload)
        .map(|p| p.to_string_lossy().to_string())
}

#[cfg(test)]
mod readiness_tests {
    use super::{is_proxy_ready, receive_restart_confirmation};
    use crate::supervisor::ProxyStateView;
    use std::sync::mpsc::{sync_channel, RecvTimeoutError};
    use std::time::Duration;

    #[test]
    fn stale_ready_does_not_complete_an_unacknowledged_restart() {
        let stale = ProxyStateView::Ready {
            version: "v0.1.0-beta.7".into(),
            owned: true,
            pid: Some(1234),
        };
        assert!(is_proxy_ready(&stale));
        let (_reply, confirmation) = sync_channel(1);
        assert_eq!(
            receive_restart_confirmation(confirmation, Duration::from_millis(5)),
            Err(RecvTimeoutError::Timeout)
        );
    }

    #[test]
    fn waits_accept_the_new_owned_or_adopted_confirmation() {
        for owned in [true, false] {
            let settled = ProxyStateView::Ready {
                version: "v0.1.0-beta.7".into(),
                owned,
                pid: owned.then_some(1234),
            };
            let (reply, confirmation) = sync_channel(1);
            reply.send(settled.clone()).unwrap();
            let view =
                receive_restart_confirmation(confirmation, Duration::from_millis(5)).unwrap();
            assert_eq!(view, settled);
            assert!(is_proxy_ready(&view));
        }
    }

    #[test]
    fn failed_confirmation_does_not_become_ready() {
        let (reply, confirmation) = sync_channel(1);
        reply
            .send(ProxyStateView::Failed {
                kind: "readiness_timeout".into(),
            })
            .unwrap();
        let view = receive_restart_confirmation(confirmation, Duration::from_millis(5)).unwrap();
        assert!(!is_proxy_ready(&view));
    }

    #[test]
    fn accepts_ready_daemons_independently_of_ownership() {
        for owned in [true, false] {
            assert!(is_proxy_ready(&ProxyStateView::Ready {
                version: "v0.1.0-beta.7".into(),
                owned,
                pid: owned.then_some(1234),
            }));
        }
    }

    #[test]
    fn rejects_every_nonready_state() {
        for view in [
            ProxyStateView::Stopped,
            ProxyStateView::Starting { attempt: 1 },
            ProxyStateView::Degraded {
                reason: "version_mismatch".into(),
            },
            ProxyStateView::Failed {
                kind: "foreign_process_on_port".into(),
            },
        ] {
            assert!(!is_proxy_ready(&view));
        }
    }
}
