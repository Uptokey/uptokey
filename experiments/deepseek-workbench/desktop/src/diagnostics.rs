use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

const ACCOUNT_INPUT_LIMIT: usize = 16 * 1024;
const ACCOUNT_BODY_LIMIT: usize = 256 * 1024;
const ACCOUNT_OUTPUT_LIMIT: usize = ACCOUNT_BODY_LIMIT + 1024;
const WORKSPACE_ARCHIVE_LIMIT: usize = 34 * 1024 * 1024;
const WORKSPACE_ENCRYPTED_LIMIT: usize = 35 * 1024 * 1024;
const WORKSPACE_ENCRYPTED_MAGIC: &[u8; 8] = b"UPTKEX01";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceArchiveFormat {
    Encrypted,
    Zip,
}

pub fn workspace_archive_format(path: &Path) -> Result<WorkspaceArchiveFormat, &'static str> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("uptokey") => Ok(WorkspaceArchiveFormat::Encrypted),
        Some("zip") => Ok(WorkspaceArchiveFormat::Zip),
        _ => Err("workspace-format-invalid"),
    }
}

pub(super) fn validate_account_request(
    path: &str,
    input: &serde_json::Value,
) -> Result<(), &'static str> {
    if !matches!(
        path,
        "status"
            | "usage"
            | "available"
            | "requests"
            | "login"
            | "connection"
            | "logout"
            | "adopt"
            | "unlink"
            | "request"
            | "approve"
            | "consume"
            | "control"
    ) || !input.is_object()
    {
        return Err("account_request_invalid");
    }
    if serde_json::to_vec(input)
        .map_err(|_| "account_request_invalid")?
        .len()
        > ACCOUNT_INPUT_LIMIT
    {
        return Err("account_request_too_large");
    }
    if matches!(
        path,
        "status" | "usage" | "available" | "requests" | "connection"
    ) && input.as_object().is_some_and(|input| !input.is_empty())
    {
        return Err("account_request_invalid");
    }
    Ok(())
}

fn validate_account_response(
    receipt: serde_json::Value,
) -> Result<serde_json::Value, &'static str> {
    let object = receipt.as_object().ok_or("account_response_invalid")?;
    if object.len() != 2
        || !object.contains_key("body")
        || !object
            .get("status")
            .and_then(|value| value.as_u64())
            .is_some_and(|status| (100..=599).contains(&status))
        || serde_json::to_vec(&receipt["body"])
            .map_err(|_| "account_response_invalid")?
            .len()
            > ACCOUNT_BODY_LIMIT
    {
        return Err("account_response_invalid");
    }
    Ok(receipt)
}

fn validate_provider_model_refresh(
    receipt: serde_json::Value,
) -> Result<serde_json::Value, &'static str> {
    let object = receipt
        .as_object()
        .ok_or("provider_model_refresh_invalid")?;
    if object.len() != 5
        || !matches!(object.get("providerId").and_then(|v|v.as_str()),Some(value) if !value.is_empty()&&value.len()<=64)
        || !matches!(object.get("selectedModel").and_then(|v|v.as_str()),Some(value) if !value.is_empty()&&value.len()<=200)
        || object.get("changed").and_then(|v| v.as_bool()).is_none()
        || object.get("reloaded").and_then(|v| v.as_bool()) != Some(true)
    {
        return Err("provider_model_refresh_invalid");
    }
    let models = object
        .get("models")
        .and_then(|v| v.as_array())
        .ok_or("provider_model_refresh_invalid")?;
    if models.is_empty()||models.len()>256||models.iter().any(|v|!matches!(v.as_str(),Some(value) if !value.is_empty()&&value.len()<=200&&!value.bytes().any(|b|b<0x20||b==0x7f)))
        ||!models.iter().any(|v|v==object.get("selectedModel").unwrap()){return Err("provider_model_refresh_invalid")}
    Ok(receipt)
}

#[derive(Clone)]
pub struct Exporter {
    node: PathBuf,
    root: PathBuf,
    script: PathBuf,
    layout: Option<crate::harness_layout::HarnessLayout>,
}
enum ExportDirectory {
    Workspace,
    Diagnostics,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderImport {
    pub imported: bool,
    pub project: String,
    pub files: usize,
    pub content_bytes: u64,
    pub excluded_entries: usize,
}
impl Exporter {
    fn state_root(&self) -> &Path {
        self.layout
            .as_ref()
            .map_or(self.root.as_path(), |layout| layout.state_root())
    }
    /// The installed entry verifies its sidecar/resources separately. This
    /// constructor only consumes the explicit, validated resource/state layout.
    pub fn from_layout(layout: crate::harness_layout::HarnessLayout) -> Result<Self, &'static str> {
        let script = layout.resource_file(Path::new("scripts/diagnostics.mjs"))?;
        Ok(Self {
            node: layout.node().to_path_buf(),
            root: layout.resource_lab().to_path_buf(),
            script,
            layout: Some(layout),
        })
    }
    fn computer_resource_command(&self) -> Result<Command, &'static str> {
        let pointer = self.root.join(".local/computer-resource-current.json");
        if !pointer.is_file()
            || pointer
                .canonicalize()
                .map_err(|_| "computer-resource-unavailable")?
                != pointer
        {
            return Err("computer-resource-unavailable");
        }
        let mut command = self.controlled_command(&self.node)?;
        Self::computer_display_environment(&mut command);
        // Trusted verifier is compiled into the host: no resource JS runs before attestation.
        command.args([
            "--input-type=module",
            "-e",
            include_str!("../../../../quimera/tauri/computer-use/resource-launcher.mjs"),
            "--",
            "--computer-resource",
        ]);
        command
            .arg(pointer)
            .arg(self.state_root().join(".local/computer-state"));
        Ok(command)
    }
    /// Only these fixed, locally packaged programs may serve a native window grant.
    pub fn computer_list_command(&self) -> Result<Command, &'static str> {
        let mut command = self.computer_resource_command()?;
        command.arg("--list-windows");
        Ok(command)
    }
    pub fn computer_session_command(
        &self,
        window_id: u32,
        pid: u32,
    ) -> Result<Command, &'static str> {
        if window_id == 0 || pid == 0 {
            return Err("computer-selection-invalid");
        }
        let mut command = self.computer_resource_command()?;
        command.args([
            "--window-id",
            &window_id.to_string(),
            "--pid",
            &pid.to_string(),
        ]);
        Ok(command)
    }
    fn computer_display_environment(command: &mut Command) {
        for key in [
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "XAUTHORITY",
            "DBUS_SESSION_BUS_ADDRESS",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
    }
    #[allow(dead_code)] // Development CLI adapter; installed host uses from_layout.
    pub fn new(profile: &Path, node: &Path) -> Result<Self, &'static str> {
        let profile = profile
            .canonicalize()
            .map_err(|_| "diagnostics-profile-invalid")?;
        if profile.file_name().and_then(|x| x.to_str()) != Some("desktop-profile")
            || profile
                .parent()
                .and_then(|p| p.file_name())
                .and_then(|x| x.to_str())
                != Some(".local")
        {
            return Err("diagnostics-profile-invalid");
        }
        let root = profile
            .parent()
            .and_then(|p| p.parent())
            .ok_or("diagnostics-root-invalid")?
            .to_path_buf();
        let script = root.join("scripts/diagnostics.mjs");
        if script
            .canonicalize()
            .map_err(|_| "diagnostics-script-unavailable")?
            != script
        {
            return Err("diagnostics-script-invalid");
        }
        if !node.is_absolute()
            || !node.is_file()
            || !matches!(
                node.file_name().and_then(|x| x.to_str()),
                Some("node") | Some("node.exe")
            )
        {
            return Err("diagnostics-node-invalid");
        }
        Ok(Self {
            node: node.to_path_buf(),
            root,
            script,
            layout: None,
        })
    }
    pub fn export(&self) -> Result<PathBuf, &'static str> {
        let receipt = self.run(&self.script, &["--export"], 20)?;
        if receipt.get("exported").and_then(|v| v.as_bool()) != Some(true) {
            return Err("diagnostics-export-failed");
        }
        let path = PathBuf::from(
            receipt
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("diagnostics-path-invalid")?,
        );
        validate_output(self.state_root(), &path)?;
        Ok(path)
    }
    /// Start Save As in the fixed lab export directory, never an OS-selected
    /// personal default. This only selects a location; it grants no write access.
    pub fn workspace_export_directory(&self) -> Result<PathBuf, &'static str> {
        self.export_directory(ExportDirectory::Workspace)
    }
    pub fn diagnostics_export_directory(&self) -> Result<PathBuf, &'static str> {
        self.export_directory(ExportDirectory::Diagnostics)
    }
    fn export_directory(&self, kind: ExportDirectory) -> Result<PathBuf, &'static str> {
        let validate = |path: &Path| -> Result<(), &'static str> {
            let meta = std::fs::symlink_metadata(path)
                .map_err(|_| "workspace-export-directory-unavailable")?;
            let linked = meta.file_type().is_symlink();
            #[cfg(windows)]
            let linked = {
                use std::os::windows::fs::MetadataExt;
                linked || meta.file_attributes() & 0x400 != 0
            };
            if !meta.is_dir()
                || linked
                || path
                    .canonicalize()
                    .map_err(|_| "workspace-export-directory-unavailable")?
                    != path
            {
                return Err("workspace-export-directory-invalid");
            }
            Ok(())
        };
        if let Some(layout) = &self.layout {
            layout.revalidate()?;
        }
        validate(self.state_root())?;
        let mut directory = self.state_root().to_path_buf();
        for part in [
            "output",
            match kind {
                ExportDirectory::Workspace => "exports",
                ExportDirectory::Diagnostics => "diagnostics",
            },
        ] {
            directory.push(part);
            match std::fs::create_dir(&directory) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err("workspace-export-directory-unavailable"),
            }
            validate(&directory)?;
        }
        Ok(directory)
    }
    #[allow(dead_code)] // Explicit development CLI export; native menu streams bytes.
    pub fn export_workspace(&self) -> Result<PathBuf, &'static str> {
        let script = self.root.join("scripts/export-workspace.mjs");
        if script
            .canonicalize()
            .map_err(|_| "workspace-script-unavailable")?
            != script
        {
            return Err("workspace-script-invalid");
        }
        let receipt = self.run(&script, &[], 70)?;
        if receipt.get("exported").and_then(|v| v.as_bool()) != Some(true) {
            return Err("workspace-export-failed");
        }
        let path = PathBuf::from(
            receipt
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("workspace-path-invalid")?,
        );
        validate_export(self.state_root(), &path, "exports", "zip")?;
        Ok(path)
    }
    pub fn import_workspace(&self, path: &Path) -> Result<String, &'static str> {
        let script = self.root.join("scripts/import-workspace.mjs");
        if script
            .canonicalize()
            .map_err(|_| "workspace-script-unavailable")?
            != script
        {
            return Err("workspace-script-invalid");
        }
        let path = path.to_str().ok_or("workspace-path-invalid")?;
        let receipt = self.run(&script, &[path], 70)?;
        imported_project(&receipt)
    }
    pub fn import_workspace_encrypted(&self, path: &Path) -> Result<String, &'static str> {
        let script = self.root.join("scripts/import-workspace-encrypted.mjs");
        if script
            .canonicalize()
            .map_err(|_| "workspace-script-unavailable")?
            != script
        {
            return Err("workspace-script-invalid");
        }
        let path = path.to_str().ok_or("workspace-path-invalid")?;
        let receipt = self.run(&script, &[path], 140)?;
        imported_project(&receipt)
    }
    pub fn export_workspace_bytes(&self) -> Result<Vec<u8>, &'static str> {
        let script = self.root.join("scripts/export-workspace.mjs");
        if script
            .canonicalize()
            .map_err(|_| "workspace-script-unavailable")?
            != script
        {
            return Err("workspace-script-invalid");
        }
        let (archive, _) = self
            .run_piped(
                &script,
                &["--stream"],
                &[],
                70,
                WORKSPACE_ARCHIVE_LIMIT,
                false,
            )
            .map_err(|_| "workspace-export-failed")?;
        if archive.len() < 22 || !archive.starts_with(b"PK\x03\x04") {
            return Err("workspace-export-invalid");
        }
        Ok(archive)
    }
    pub fn export_workspace_encrypted_bytes(&self) -> Result<Vec<u8>, &'static str> {
        let script = self.root.join("scripts/export-workspace-encrypted.mjs");
        if script
            .canonicalize()
            .map_err(|_| "workspace-script-unavailable")?
            != script
        {
            return Err("workspace-script-invalid");
        }
        let (archive, _) = self
            .run_piped(
                &script,
                &["--stream"],
                &[],
                140,
                WORKSPACE_ENCRYPTED_LIMIT,
                false,
            )
            .map_err(|_| "workspace-export-failed")?;
        if archive.len() < 32 || !archive.starts_with(WORKSPACE_ENCRYPTED_MAGIC) {
            return Err("workspace-export-invalid");
        }
        Ok(archive)
    }
    fn import_workspace_bytes(&self, archive: &[u8]) -> Result<String, &'static str> {
        if archive.is_empty() || archive.len() > WORKSPACE_ARCHIVE_LIMIT {
            return Err("workspace-zip-invalid");
        }
        let script = self.root.join("scripts/import-workspace-bytes.mjs");
        if script
            .canonicalize()
            .map_err(|_| "workspace-script-unavailable")?
            != script
        {
            return Err("workspace-script-invalid");
        }
        let (raw, _) = self
            .run_piped(&script, &[], archive, 70, 65536, false)
            .map_err(|_| "workspace-import-failed")?;
        let receipt = serde_json::from_slice(&raw).map_err(|_| "workspace-import-invalid")?;
        imported_project(&receipt)
    }
    pub fn import_folder(&self, path: &Path) -> Result<FolderImport, &'static str> {
        let protected = if let Some(layout) = &self.layout {
            layout.validate_import_source(path)?;
            layout.protected_source_root()
        } else {
            self.root
                .parent()
                .and_then(Path::parent)
                .ok_or("folder-protected-root-invalid")?
        };
        let snapshot = crate::folder_snapshot::snapshot_folder(path, protected)?;
        let project = self.import_workspace_bytes(&snapshot.archive)?;
        Ok(FolderImport {
            imported: true,
            project,
            files: snapshot.files,
            content_bytes: snapshot.bytes,
            excluded_entries: snapshot.excluded,
        })
    }
    pub fn reconnect_services(&self) -> Result<crate::local_connections::Connections, &'static str> {
        let script = self.root.join("scripts/reconnect.mjs");
        if script
            .canonicalize()
            .map_err(|_| "reconnect-script-unavailable")?
            != script
        {
            return Err("reconnect-script-invalid");
        }
        let receipt = self.run(&script, &[], 50)?;
        crate::local_connections::Connections::from_receipt(&receipt)
    }
    pub fn product_contract(&self) -> Result<serde_json::Value, &'static str> {
        let script = self.root.join("scripts/product-contract.mjs");
        if script
            .canonicalize()
            .map_err(|_| "product-contract-unavailable")?
            != script
        {
            return Err("product-contract-invalid");
        }
        let manifest = self
            .layout
            .as_ref()
            .map(|layout| layout.packaged_sidecar_manifest())
            .transpose()?
            .flatten();
        let args = match manifest.as_ref() {
            Some(path) => vec![
                "--sidecar-manifest",
                path.to_str().ok_or("product-contract-path-invalid")?,
            ],
            None => vec![],
        };
        let receipt = self.run(&script, &args, 20).map_err(|code| {
            // Fixed native error identifiers only; never helper output or credentials.
            eprintln!("Uptokey Harness: product-contract-helper-{code}");
            "product-contract-unavailable"
        })?;
        crate::product_contract::validate(&receipt)?;
        Ok(receipt)
    }
    pub fn import_public_api(
        &self,
        path: &Path,
    ) -> Result<crate::public_api::PublicApiImport, &'static str> {
        let script = self.root.join("scripts/import-public-api.mjs");
        if script
            .canonicalize()
            .map_err(|_| "api-script-unavailable")?
            != script
        {
            return Err("api-script-invalid");
        }
        let receipt = self.run(&script, &[path.to_str().ok_or("api-path-invalid")?], 45)?;
        crate::public_api::imported_api(&receipt)
    }
    pub fn restart_runtime(&self) -> Result<serde_json::Value, &'static str> {
        let script = self.root.join("scripts/restart-runtime.mjs");
        if script
            .canonicalize()
            .map_err(|_| "restart-script-unavailable")?
            != script
        {
            return Err("restart-script-invalid");
        }
        let receipt = self.run(&script, &["--native"], 150)?;
        if receipt.get("restarted").and_then(|v| v.as_bool()) != Some(true)
            || receipt.get("webReady").and_then(|v| v.as_bool()) != Some(true)
        {
            return Err("restart-unverified");
        }
        Ok(receipt)
    }
    pub fn runtime_state(&self, start: bool) -> Result<serde_json::Value, &'static str> {
        let script = self.root.join("scripts/restart-runtime.mjs");
        if script
            .canonicalize()
            .map_err(|_| "restart-script-unavailable")?
            != script
        {
            return Err("restart-script-invalid");
        }
        let receipt = self.run(
            &script,
            &[if start { "--start" } else { "--stop" }, "--native"],
            if start { 1800 } else { 150 },
        )?;
        if receipt.get("state").and_then(|v| v.as_str())
            != Some(if start { "running" } else { "stopped" })
            || (start && receipt.get("webReady").and_then(|v| v.as_bool()) != Some(true))
        {
            return Err("runtime-transition-unverified");
        }
        Ok(receipt)
    }
    #[allow(dead_code)] // Development CLI; installed account uses the canonical bridge.
    pub fn account(&self, login: bool) -> Result<serde_json::Value, &'static str> {
        let script = self.root.join("scripts/account.mjs");
        if script
            .canonicalize()
            .map_err(|_| "account-script-unavailable")?
            != script
        {
            return Err("account-script-invalid");
        }
        self.run(&script, &[if login { "login" } else { "status" }], 20)
    }
    pub fn account_request(
        &self,
        path: &str,
        input: serde_json::Value,
    ) -> Result<serde_json::Value, &'static str> {
        validate_account_request(path, &input)?;
        let script = self.root.join("scripts/canonical-account.mjs");
        if script
            .canonicalize()
            .map_err(|_| "account_script_unavailable")?
            != script
        {
            return Err("account_script_invalid");
        }
        let payload = serde_json::to_vec(&serde_json::json!({"path":path,"input":input}))
            .map_err(|_| "account_request_invalid")?;
        let timeout = if path == "control"
            && matches!(
                input.get("operation").and_then(|value| value.as_str()),
                Some("subscription.checkout" | "subscription.portal")
            ) {
            40
        } else {
            20
        };
        validate_account_response(self.run_input_json(&script, &payload, timeout, false)?)
    }
    pub fn refresh_provider_models(
        &self,
        provider_id: &str,
    ) -> Result<serde_json::Value, &'static str> {
        let script = self.root.join("scripts/provider-model-refresh.mjs");
        if script
            .canonicalize()
            .map_err(|_| "provider_model_refresh_unavailable")?
            != script
        {
            return Err("provider_model_refresh_unavailable");
        }
        let payload = serde_json::to_vec(&serde_json::json!({"providerId":provider_id}))
            .map_err(|_| "provider_model_refresh_invalid")?;
        let receipt = self
            .run_input_json(&script, &payload, 40, true)
            .map_err(|_| "provider_model_refresh_unavailable")?;
        if receipt.get("error").is_some() {
            return Err("provider_model_refresh_failed");
        }
        validate_provider_model_refresh(receipt)
    }
    pub fn approved_context_list(&self) -> Result<crate::approved_context::Listing, &'static str> {
        crate::approved_context::parse_listing(
            self.approved_context_request(serde_json::json!({"operation":"list"}), 60)?,
        )
    }
    pub fn approved_context_import(
        &self,
        selection: &crate::approved_context::Selection,
    ) -> Result<String, &'static str> {
        // At most 60s of core reads + 5s executor admission + the existing 60s
        // finite importer. The outer deadline must not orphan its local commit.
        crate::approved_context::parse_import(self.approved_context_request(
            serde_json::json!({"operation":"import","selection":selection}),
            130,
        )?)
    }
    pub fn approved_context_revoke(&self) -> Result<u64, &'static str> {
        crate::approved_context::parse_revoke(
            self.approved_context_request(serde_json::json!({"operation":"revoke"}), 20)?,
        )
    }
    pub fn approved_context_connect_begin(
        &self,
    ) -> Result<crate::approved_context::ConnectionBegin, &'static str> {
        crate::approved_context::parse_connection_begin(
            self.approved_context_request(serde_json::json!({"operation":"connect-begin"}), 20)?,
        )
    }
    pub fn approved_context_connect_consume(
        &self,
        session: &crate::approved_context::ConnectionSession,
    ) -> Result<u64, &'static str> {
        crate::approved_context::parse_connection_complete(
            self.approved_context_request(
                serde_json::json!({"operation":"connect-consume","session":session}),
                20,
            )?,
            session,
        )
    }
    fn approved_context_request(
        &self,
        input: serde_json::Value,
        timeout_seconds: u64,
    ) -> Result<serde_json::Value, &'static str> {
        let script = self.root.join("scripts/approved-context.mjs");
        if script
            .canonicalize()
            .map_err(|_| "context_client_unavailable")?
            != script
        {
            return Err("context_client_unavailable");
        }
        let payload = serde_json::to_vec(&input).map_err(|_| "context_request_invalid")?;
        if payload.len() > ACCOUNT_INPUT_LIMIT {
            return Err("context_request_invalid");
        }
        let receipt = self
            .run_input_json(&script, &payload, timeout_seconds, true)
            .map_err(|_| "context_client_unavailable")?;
        if let Some(code) = receipt.get("error").and_then(|value| value.as_str()) {
            return Err(match code {
                "context_not_linked" => "context_not_linked",
                "context_link_required" => "context_link_required",
                "context_changed" => "context_changed",
                "context_link_changed" => "context_link_changed",
                "context_selection_stale" => "context_selection_stale",
                "context_snapshot_changed" => "context_snapshot_changed",
                "context_snapshot_denied" => "context_snapshot_denied",
                "context_pairing_required" => "context_pairing_required",
                "context_link_pending" => "context_link_pending",
                "context_link_expired" => "context_link_expired",
                "context_connection_invalid" => "context_connection_invalid",
                "context_link_invalid" => "context_link_invalid",
                "context_scope_denied" => "context_scope_denied",
                "context_rate_limited" => "context_rate_limited",
                _ => "context_client_unavailable",
            });
        }
        Ok(receipt)
    }
    // Bounded stdin/stdout and a hard deadline, shared with the canonical account transport.
    // Only the context helper may return its fixed error envelope after a nonzero exit.
    fn run_input_json(
        &self,
        script: &Path,
        payload: &[u8],
        timeout_seconds: u64,
        allow_error_receipt: bool,
    ) -> Result<serde_json::Value, &'static str> {
        let (raw, success) = self.run_piped(
            script,
            &[],
            payload,
            timeout_seconds,
            ACCOUNT_OUTPUT_LIMIT,
            allow_error_receipt,
        )?;
        let value: serde_json::Value =
            serde_json::from_slice(&raw).map_err(|_| "account_response_invalid")?;
        if !success
            && !(value.as_object().is_some_and(|value| value.len() == 1)
                && value
                    .get("error")
                    .and_then(|value| value.as_str())
                    .is_some_and(|code| {
                        !code.is_empty()
                            && code.len() <= 128
                            && code
                                .bytes()
                                .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
                    }))
        {
            return Err("account_unavailable");
        }
        Ok(value)
    }
    // Drain stdout concurrently with stdin: a bounded ZIP can exceed the pipe
    // capacity in either direction. No native workspace transport needs a spool.
    fn run_piped(
        &self,
        script: &Path,
        args: &[&str],
        payload: &[u8],
        timeout_seconds: u64,
        output_limit: usize,
        allow_error_receipt: bool,
    ) -> Result<(Vec<u8>, bool), &'static str> {
        let mut command = self.helper_command(script)?;
        command.args(args);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = command.spawn().map_err(|_| "account_unavailable")?;
        let mut stdin = child.stdin.take().ok_or("account_unavailable")?;
        let stdout = child.stdout.take().ok_or("account_unavailable")?;
        let (write_tx, write_rx) = mpsc::channel();
        let payload = payload.to_vec();
        std::thread::spawn(move || {
            let written = stdin.write_all(&payload).map_err(|_| "account_unavailable");
            drop(stdin);
            let _ = write_tx.send(written);
        });
        let (read_tx, read_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut raw = Vec::new();
            let result = stdout
                .take((output_limit + 1) as u64)
                .read_to_end(&mut raw)
                .map_err(|_| "account_unavailable")
                .and(if raw.len() > output_limit {
                    Err("account_response_too_large")
                } else {
                    Ok(raw)
                });
            let _ = read_tx.send(result);
        });
        let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
        let mut output = None;
        let mut written = false;
        let outcome = loop {
            if !written {
                match write_rx.try_recv() {
                    Ok(Ok(())) => written = true,
                    Ok(Err(error)) => break Err(error),
                    Err(mpsc::TryRecvError::Disconnected) => break Err("account_unavailable"),
                    Err(mpsc::TryRecvError::Empty) => {}
                }
            }
            if output.is_none() {
                match read_rx.try_recv() {
                    Ok(Ok(raw)) => output = Some(raw),
                    Ok(Err(error)) => break Err(error),
                    Err(mpsc::TryRecvError::Disconnected) => break Err("account_unavailable"),
                    Err(mpsc::TryRecvError::Empty) => {}
                }
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() && !allow_error_receipt {
                        break Err("account_unavailable");
                    };
                    if written && output.is_some() {
                        break Ok((output.take().unwrap(), status.success()));
                    }
                }
                Ok(None) => {}
                Err(_) => break Err("account_unavailable"),
            }
            if Instant::now() >= deadline {
                break Err("account_timeout");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        if outcome.is_err() {
            let _ = child.kill();
            let _ = child.wait();
        }
        outcome
    }
    fn helper_command(&self, script: &Path) -> Result<Command, &'static str> {
        if let Some(layout) = &self.layout {
            let relative = script
                .strip_prefix(&self.root)
                .map_err(|_| "harness_layout_resource_invalid")?;
            if layout.resource_file(relative)? != script {
                return Err("harness_layout_resource_invalid");
            }
        }
        let mut command = self.controlled_command(&self.node)?;
        command.arg(script);
        Ok(command)
    }
    fn controlled_command(&self, executable: &Path) -> Result<Command, &'static str> {
        if let Some(layout) = &self.layout {
            layout.revalidate()?;
        }
        let mut command = Command::new(executable);
        command.current_dir(&self.root).env_clear();
        for (key, value) in std::env::vars_os() {
            let normalized = key.to_string_lossy().to_ascii_uppercase();
            if matches!(
                normalized.as_str(),
                "PATH"
                    | "PATHEXT"
                    | "SYSTEMROOT"
                    | "WINDIR"
                    | "TEMP"
                    | "TMP"
                    | "USERPROFILE"
                    | "USERNAME"
                    | "USERDOMAIN"
                    | "HOMEDRIVE"
                    | "HOMEPATH"
                    | "USER"
                    | "LOGNAME"
                    | "APPDATA"
                    | "LOCALAPPDATA"
                    | "PROGRAMDATA"
                    | "COMSPEC"
                    | "HOME"
                    | "XDG_RUNTIME_DIR"
            ) {
                command.env(key, value);
            }
        }
        if let Some(layout) = &self.layout {
            command.env("UPTOKEY_HARNESS_STATE_ROOT", layout.state_root());
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        Ok(command)
    }
    fn run(
        &self,
        script: &Path,
        args: &[&str],
        timeout_seconds: u64,
    ) -> Result<serde_json::Value, &'static str> {
        // Drain while the helper runs. Waiting for exit before reading can
        // deadlock on a full pipe, even for a valid receipt below our limit.
        // Reuse the bounded native transport; empty input closes stdin at once.
        let (output, success) = self
            .run_piped(script, args, &[], timeout_seconds, 65536, true)
            .map_err(|code| match code {
                "account_timeout" => "diagnostics-timeout",
                "account_unavailable" | "account_response_too_large" => "diagnostics-export-failed",
                code => code,
            })?;
        if !success {
            if script.file_name().and_then(|s| s.to_str()) == Some("restart-runtime.mjs") {
                if let Some(code) = runtime_failure_code(&output) {
                    return Err(code);
                }
            }
            return Err("diagnostics-export-failed");
        }
        let receipt: serde_json::Value =
            serde_json::from_slice(&output).map_err(|_| "diagnostics-receipt-invalid")?;
        Ok(receipt)
    }
}
fn runtime_failure_code(output: &[u8]) -> Option<&'static str> {
    if output.len() > 1024 {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(output).ok()?;
    if value.get("restarted")?.as_bool()? {
        return None;
    }
    match value.get("error")?.as_str()? {
        "runtime-stage-engine" => Some("runtime-stage-engine"),
        "runtime-stage-inspection" => Some("runtime-stage-inspection"),
        "runtime-stage-archive" => Some("runtime-stage-archive"),
        "runtime-stage-fresh-start" => Some("runtime-stage-fresh-start"),
        "runtime-stage-recovery" => Some("runtime-stage-recovery"),
        "runtime-stage-provision" => Some("runtime-stage-provision"),
        "runtime-stage-connect" => Some("runtime-stage-connect"),
        "runtime-stage-web" => Some("runtime-stage-web"),
        _ => None,
    }
}
fn imported_project(receipt: &serde_json::Value) -> Result<String, &'static str> {
    let project = receipt
        .get("project")
        .and_then(|v| v.as_str())
        .ok_or("workspace-import-invalid")?;
    let suffix = project
        .strip_prefix("/workspace/import-")
        .ok_or("workspace-import-invalid")?;
    if receipt.get("imported").and_then(|v| v.as_bool()) != Some(true)
        || suffix.len() != 32
        || !suffix.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("workspace-import-invalid");
    }
    Ok(project.to_owned())
}
fn validate_output(root: &Path, path: &Path) -> Result<(), &'static str> {
    validate_export(root, path, "diagnostics", "json")
}
fn validate_export(
    root: &Path,
    path: &Path,
    folder: &str,
    extension: &str,
) -> Result<(), &'static str> {
    let directory = root.join("output").join(folder);
    if path.extension().and_then(|x| x.to_str()) != Some(extension) {
        return Err("diagnostics-path-invalid");
    }
    let directory = directory
        .canonicalize()
        .map_err(|_| "diagnostics-path-invalid")?;
    let actual = path
        .canonicalize()
        .map_err(|_| "diagnostics-path-invalid")?;
    if !directory.starts_with(root)
        || actual.parent() != Some(directory.as_path())
        || !actual.is_file()
        || std::fs::symlink_metadata(path)
            .map_err(|_| "diagnostics-path-invalid")?
            .file_type()
            .is_symlink()
    {
        return Err("diagnostics-path-invalid");
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    #[test]
    fn runtime_failure_receipt_only_accepts_fixed_bounded_codes() {
        assert_eq!(
            super::runtime_failure_code(br#"{"restarted":false,"error":"runtime-stage-archive"}"#),
            Some("runtime-stage-archive")
        );
        assert_eq!(
            super::runtime_failure_code(br#"{"restarted":false,"error":"PRIVATE_CANARY"}"#),
            None
        );
        assert_eq!(
            super::runtime_failure_code(br#"{"restarted":true,"error":"runtime-stage-archive"}"#),
            None
        );
        assert_eq!(super::runtime_failure_code(&[b'x'; 1025]), None);
    }
    use super::*;
    fn source_lab() -> PathBuf {
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join(file!());
        source
            .canonicalize()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf()
    }
    fn pipe_fixture(program: &str) -> (Exporter, PathBuf) {
        let lab = source_lab();
        let directory = lab.join("output/native-zip-memory");
        std::fs::create_dir_all(&directory).unwrap();
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let script = directory.join(format!("transport-{}-{suffix}.mjs", std::process::id()));
        std::fs::write(&script, program).unwrap();
        (
            Exporter {
                node: PathBuf::from("node"),
                root: lab.to_path_buf(),
                script: script.clone(),
                layout: None,
            },
            script,
        )
    }
    #[test]
    fn workspace_pipe_drains_before_writing_input_and_preserves_binary() {
        let (exporter,script)=pipe_fixture("import fs from 'node:fs';const out=Buffer.alloc(512*1024,90);let offset=0;while(offset<out.length)offset+=fs.writeSync(1,out,offset,out.length-offset);const input=fs.readFileSync(0);if(input.length!==1024*1024||input.some(x=>x!==165))process.exit(2);fs.writeSync(1,Buffer.from([0,255,128,10]));");
        let (bytes, success) = exporter
            .run_piped(
                &script,
                &[],
                &vec![165; 1024 * 1024],
                10,
                512 * 1024 + 4,
                false,
            )
            .unwrap();
        assert!(success);
        assert_eq!(bytes.len(), 512 * 1024 + 4);
        assert!(bytes[..512 * 1024].iter().all(|byte| *byte == 90));
        assert_eq!(&bytes[512 * 1024..], &[0, 255, 128, 10]);
    }
    #[test]
    fn generic_helper_drains_receipts_larger_than_pipe_capacity() {
        let (exporter, script) = pipe_fixture(
            "import fs from 'node:fs';fs.writeSync(1,JSON.stringify({data:'x'.repeat(60000)}));",
        );
        let result = exporter.run(&script, &[], 10);
        std::fs::remove_file(script).unwrap();
        assert_eq!(result.unwrap()["data"].as_str().unwrap().len(), 60000);
    }
    #[test]
    fn generic_helper_stops_oversized_output_before_its_timeout() {
        let (exporter, script) =
            pipe_fixture("process.stdout.write(Buffer.alloc(1024*1024));setInterval(()=>{},1000);");
        let start = Instant::now();
        let result = exporter.run(&script, &[], 10);
        std::fs::remove_file(script).unwrap();
        assert_eq!(result, Err("diagnostics-export-failed"));
        assert!(start.elapsed() < Duration::from_secs(5));
    }
    #[test]
    fn workspace_pipe_refuses_excess_output_and_stalled_helper() {
        let (exporter, script) =
            pipe_fixture("process.stdout.write(Buffer.alloc(65537));setInterval(()=>{},1000);");
        assert_eq!(
            exporter.run_piped(&script, &[], &[], 10, 65536, false),
            Err("account_response_too_large")
        );
        let (exporter, script) = pipe_fixture("setInterval(()=>{},1000);");
        let start = Instant::now();
        assert_eq!(
            exporter.run_piped(&script, &[], &[], 1, 65536, false),
            Err("account_timeout")
        );
        assert!(start.elapsed() < Duration::from_secs(5));
    }
    #[test]
    fn workspace_archive_format_requires_an_explicit_supported_extension() {
        assert_eq!(
            workspace_archive_format(Path::new("backup.uptokey")),
            Ok(WorkspaceArchiveFormat::Encrypted)
        );
        assert_eq!(
            workspace_archive_format(Path::new("BACKUP.ZIP")),
            Ok(WorkspaceArchiveFormat::Zip)
        );
        for path in ["backup", "backup.json", "backup.uptokey.zip.exe"] {
            assert_eq!(
                workspace_archive_format(Path::new(path)),
                Err("workspace-format-invalid")
            );
        }
    }
    #[test]
    fn refactored_pipe_preserves_context_error_envelope_rules() {
        let (exporter,script)=pipe_fixture("process.stdin.resume();process.stdout.write(JSON.stringify({error:'context_changed'}));process.exitCode=1;");
        assert_eq!(
            exporter.run_input_json(&script, b"{}", 10, true).unwrap(),
            serde_json::json!({"error":"context_changed"})
        );
        assert_eq!(
            exporter.run_input_json(&script, b"{}", 10, false),
            Err("account_unavailable")
        );
        let (exporter,script)=pipe_fixture("process.stdin.resume();process.stdout.write(JSON.stringify({error:'context_changed',extra:true}));process.exitCode=1;");
        assert_eq!(
            exporter.run_input_json(&script, b"{}", 10, true),
            Err("account_unavailable")
        );
    }
    fn export_directory_fixture() -> Exporter {
        // Retain these tiny, uniquely named fixtures for inspection. Never reset
        // the real output/exports or recursively remove an export fixture.
        let lab = source_lab();
        let mut parent = lab;
        for part in ["output", "native-export", "fixtures"] {
            parent.push(part);
            match std::fs::create_dir(&parent) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => panic!("fixture parent unavailable: {error}"),
            }
            let meta = std::fs::symlink_metadata(&parent).unwrap();
            assert!(meta.is_dir() && !meta.file_type().is_symlink());
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                assert_eq!(meta.file_attributes() & 0x400, 0);
            }
            assert_eq!(parent.canonicalize().unwrap(), parent);
        }
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = parent.join(format!("save-directory-{}-{suffix}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        Exporter {
            node: PathBuf::new(),
            script: PathBuf::new(),
            root: root.canonicalize().unwrap(),
            layout: None,
        }
    }
    fn installed_layout_fixture() -> Exporter {
        let fixture = export_directory_fixture();
        let resources = fixture.root.join("resources");
        let state = fixture.root.join("state");
        for path in [&resources, &state] {
            std::fs::create_dir(path).unwrap();
        }
        std::fs::create_dir(resources.join("scripts")).unwrap();
        std::fs::create_dir(resources.join(".local")).unwrap();
        for name in [
            "diagnostics.mjs",
            "canonical-account.mjs",
            "provider-model-refresh.mjs",
            "export-workspace.mjs",
            "approved-context.mjs",
        ] {
            std::fs::write(
                resources.join("scripts").join(name),
                b"// synthetic helper, never executed",
            )
            .unwrap();
        }
        std::fs::write(
            resources.join(".local/computer-resource-current.json"),
            b"{}",
        )
        .unwrap();
        let node = resources.join(if cfg!(windows) { "node.exe" } else { "node" });
        std::fs::write(&node, b"synthetic runtime, never executed").unwrap();
        let layout =
            crate::harness_layout::HarnessLayout::installed(&resources, &state, &resources, &node)
                .unwrap();
        Exporter::from_layout(layout).unwrap()
    }
    #[test]
    fn installed_layout_helpers_read_resources_and_receive_only_harness_state_override() {
        let exporter = installed_layout_fixture();
        for name in [
            "diagnostics.mjs",
            "canonical-account.mjs",
            "provider-model-refresh.mjs",
            "export-workspace.mjs",
            "approved-context.mjs",
        ] {
            let script = exporter.root.join("scripts").join(name);
            let command = exporter.helper_command(&script).unwrap();
            assert_eq!(command.get_program(), exporter.node.as_os_str());
            assert_eq!(command.get_current_dir(), Some(exporter.root.as_path()));
            assert_eq!(command.get_args().next(), Some(script.as_os_str()));
            let state = command
                .get_envs()
                .find(|(key, _)| *key == std::ffi::OsStr::new("UPTOKEY_HARNESS_STATE_ROOT"))
                .unwrap();
            assert_eq!(state.1, Some(exporter.state_root().as_os_str()));
            assert!(!command
                .get_envs()
                .any(|(key, _)| key == std::ffi::OsStr::new("UPTOKEY_QUIMERA_DATA_DIR")));
        }
        assert_eq!(std::fs::read_dir(exporter.state_root()).unwrap().count(), 0);
        let outside = exporter.state_root().join("diagnostics.mjs");
        std::fs::write(&outside, b"// not a resource").unwrap();
        assert!(exporter.helper_command(&outside).is_err());
    }
    #[test]
    fn installed_layout_computer_pointer_is_resource_but_session_state_is_mutable() {
        let exporter = installed_layout_fixture();
        let pointer = exporter.root.join(".local/computer-resource-current.json");
        let state = exporter.state_root().join(".local/computer-state");
        for command in [
            exporter.computer_list_command().unwrap(),
            exporter.computer_session_command(123, 456).unwrap(),
        ] {
            let args = command.get_args().collect::<Vec<_>>();
            assert!(args.contains(&pointer.as_os_str()));
            assert!(args.contains(&state.as_os_str()));
            assert!(!args.contains(&exporter.root.join(".local/computer-state").as_os_str()));
        }
        assert_eq!(std::fs::read_dir(exporter.state_root()).unwrap().count(), 0);
        assert!(!exporter.root.join(".local/computer-state").exists());
    }
    #[test]
    fn installed_layout_exports_and_import_guards_use_explicit_state_boundary() {
        let exporter = installed_layout_fixture();
        let resource_count = std::fs::read_dir(&exporter.root).unwrap().count();
        assert_eq!(
            exporter.diagnostics_export_directory().unwrap(),
            exporter.state_root().join("output/diagnostics")
        );
        assert_eq!(
            exporter.workspace_export_directory().unwrap(),
            exporter.state_root().join("output/exports")
        );
        let receipt = exporter
            .state_root()
            .join("output/diagnostics/synthetic.json");
        std::fs::write(&receipt, b"{}").unwrap();
        assert!(validate_output(exporter.state_root(), &receipt).is_ok());
        assert!(validate_output(&exporter.root, &receipt).is_err());
        assert_eq!(
            exporter.import_folder(exporter.state_root()).err(),
            Some("folder_protected_root")
        );
        assert_eq!(
            exporter.import_folder(&exporter.root).err(),
            Some("folder_protected_root")
        );
        assert_eq!(
            std::fs::read_dir(&exporter.root).unwrap().count(),
            resource_count
        );
        assert!(!exporter.root.join("output").exists());
    }
    #[test]
    fn installed_layout_default_development_constructor_retains_original_paths() {
        let installed = installed_layout_fixture();
        let profile = installed.root.join(".local/desktop-profile");
        std::fs::create_dir(&profile).unwrap();
        let exporter = Exporter::new(&profile, &installed.node).unwrap();
        assert!(exporter.layout.is_none());
        assert_eq!(exporter.state_root(), exporter.root);
        let command = exporter.helper_command(&exporter.script).unwrap();
        assert!(!command
            .get_envs()
            .any(|(key, _)| key == std::ffi::OsStr::new("UPTOKEY_HARNESS_STATE_ROOT")));
        assert_eq!(
            exporter.diagnostics_export_directory().unwrap(),
            exporter.root.join("output/diagnostics")
        );
    }
    #[test]
    fn diagnostics_export_directory_creates_only_its_fixed_directory_and_is_idempotent() {
        let exporter = export_directory_fixture();
        assert!(!exporter.root.join("output").exists());
        let expected = exporter.root.join("output/diagnostics");
        assert_eq!(exporter.diagnostics_export_directory().unwrap(), expected);
        let canary = expected.join("keep-canary.json");
        std::fs::write(&canary, b"{\"synthetic\":true}").unwrap();
        assert_eq!(exporter.diagnostics_export_directory().unwrap(), expected);
        assert_eq!(std::fs::read(&canary).unwrap(), b"{\"synthetic\":true}");
        assert!(!exporter.root.join("output/exports").exists());
        assert_eq!(
            std::fs::read_dir(exporter.root.join("output"))
                .unwrap()
                .count(),
            1
        );
    }
    #[test]
    fn workspace_export_directory_creates_fixed_missing_directories_and_is_idempotent() {
        let exporter = export_directory_fixture();
        assert!(!exporter.root.join("output").exists());
        let expected = exporter.root.join("output/exports");
        assert_eq!(exporter.workspace_export_directory().unwrap(), expected);
        let canary = expected.join("keep-canary.bin");
        std::fs::write(&canary, b"synthetic-do-not-change").unwrap();
        assert_eq!(exporter.workspace_export_directory().unwrap(), expected);
        assert_eq!(std::fs::read(&canary).unwrap(), b"synthetic-do-not-change");
        assert!(expected.is_dir());
        assert_eq!(std::fs::read_dir(&exporter.root).unwrap().count(), 1);
    }
    #[test]
    fn workspace_export_directory_refuses_blocking_files_without_changing_canaries() {
        for blocked in ["output", "exports"] {
            let exporter = export_directory_fixture();
            let canary = exporter.root.join("keep-canary.bin");
            std::fs::write(&canary, b"root-canary").unwrap();
            let blocker = if blocked == "output" {
                exporter.root.join("output")
            } else {
                let output = exporter.root.join("output");
                std::fs::create_dir(&output).unwrap();
                output.join("exports")
            };
            std::fs::write(&blocker, b"existing-blocker").unwrap();
            assert_eq!(
                exporter.workspace_export_directory(),
                Err("workspace-export-directory-invalid")
            );
            assert_eq!(std::fs::read(&blocker).unwrap(), b"existing-blocker");
            assert_eq!(std::fs::read(&canary).unwrap(), b"root-canary");
            assert_eq!(std::fs::read_dir(&exporter.root).unwrap().count(), 2);
            if blocked == "exports" {
                assert_eq!(
                    std::fs::read_dir(exporter.root.join("output"))
                        .unwrap()
                        .count(),
                    1
                );
            }
        }
    }
    #[test]
    fn account_transport_rejects_paths_and_oversize_payloads() {
        assert!(validate_account_request("status", &serde_json::json!({})).is_ok());
        assert!(validate_account_request("connection", &serde_json::json!({})).is_ok());
        assert!(
            validate_account_request("connection", &serde_json::json!({"purpose":"account"}))
                .is_err()
        );
        for path in [
            "../status",
            "/local/account/status",
            "status?x=1",
            "connect-hosted",
            "https://example.com",
        ] {
            assert!(validate_account_request(path, &serde_json::json!({})).is_err());
        }
        assert!(validate_account_request("status", &serde_json::json!({"extra":true})).is_err());
        assert!(validate_account_request("login", &serde_json::Value::Null).is_err());
        assert!(validate_account_request(
            "control",
            &serde_json::json!({"data":"x".repeat(ACCOUNT_INPUT_LIMIT)})
        )
        .is_err());
    }
    #[test]
    fn account_response_envelope_is_bounded_and_exact() {
        assert!(validate_account_response(
            serde_json::json!({"status":200,"body":{"authenticated":false}})
        )
        .is_ok());
        for invalid in [
            serde_json::json!({"status":200,"body":{},"token":"synthetic"}),
            serde_json::json!({"status":600,"body":{}}),
            serde_json::json!({"status":200.5,"body":{}}),
            serde_json::json!({"body":{}}),
            serde_json::json!({"status":200,"body":{"value":"x".repeat(ACCOUNT_BODY_LIMIT)}}),
        ] {
            assert!(validate_account_response(invalid).is_err());
        }
    }
    #[test]
    fn provider_model_refresh_response_is_public_bounded_and_exact() {
        assert!(validate_provider_model_refresh(serde_json::json!({"providerId":"deepseek","selectedModel":"deepseek-chat","models":["deepseek-chat","deepseek-reasoner"],"changed":true,"reloaded":true})).is_ok());
        for invalid in [
            serde_json::json!({"providerId":"deepseek","selectedModel":"deepseek-chat","models":["deepseek-chat"],"changed":true,"reloaded":true,"token":"secret"}),
            serde_json::json!({"providerId":"deepseek","selectedModel":"missing","models":["deepseek-chat"],"changed":true,"reloaded":true}),
            serde_json::json!({"providerId":"deepseek","selectedModel":"deepseek-chat","models":["bad\nmodel"],"changed":true,"reloaded":true}),
        ] {
            assert!(validate_provider_model_refresh(invalid).is_err());
        }
    }
    #[test]
    fn rejects_paths_outside_diagnostics_before_opening() {
        let root = Path::new("/synthetic/lab");
        for candidate in [
            "/synthetic/private.json",
            "/synthetic/lab/output/diagnostics/file.exe",
            "/synthetic/lab/output/diagnostics/../private.json",
        ] {
            assert!(validate_output(root, Path::new(candidate)).is_err());
        }
    }
}
