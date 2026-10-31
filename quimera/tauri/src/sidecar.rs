//! Sidecar `proxy-local`: localização por recurso empacotado, verificação de
//! integridade (manifesto + SHA-256 de todos os arquivos atestados), probe de
//! identidade `/health`, spawn com ambiente sanitizado e encerramento limitado
//! ao processo filho criado por esta instância.
//!
//! Dois layouts de manifesto são aceitos:
//! - schema 1 (legado): binário único compilado;
//! - schema 2 (runtime Node empacotado): `uptokey-windows.exe`/`uptokey` é o
//!   runtime Node (com ABI compatível com as bibliotecas nativas), `cli.js` é
//!   a entrada do CLI e `composition-worker.js` é o worker real — todos
//!   atestados por SHA-256 no manifesto. O protocolo e o armazenamento
//!   permanecem os do core; nenhum worker é substituído por stub.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::net::TcpStream;
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub const PROXY_HOST: &str = "127.0.0.1";
pub const PROXY_PORT: u16 = 21435;
pub const HEALTH_PATH: &str = "/health";

/// Nome exigido pelo `compiledLaunch` do cli.ts canônico por plataforma.
pub fn sidecar_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "uptokey-windows.exe"
    } else {
        "uptokey"
    }
}

// ---------------------------------------------------------------------------
// Manifesto e verificação de integridade
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct AttestedFile {
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct SidecarManifest {
    pub schema_version: u32,
    #[serde(default)]
    pub binary_name: String,
    #[serde(default)]
    pub build_version: String,
    #[serde(default)]
    pub package_version: String,
    #[serde(default)]
    pub target: String,
    /// Schema 1 (binário único compilado) — atestação do binário.
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub size_bytes: u64,
    /// Schema 2 (runtime Node empacotado) — atestação de todos os arquivos.
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub entry: Option<String>,
    #[serde(default)]
    pub worker: Option<String>,
    #[serde(default)]
    pub files: BTreeMap<String, AttestedFile>,
}

impl SidecarManifest {
    pub fn is_node_runtime(&self) -> bool {
        self.schema_version == 2 && self.runtime.as_deref() == Some("node")
    }
}

/// Nome de arquivo relativo seguro para atestação: apenas segmentos normais,
/// barras diretas, sem `..`, sem absoluto, sem backslash, sem NUL.
fn valid_rel_path(name: &str) -> bool {
    if name.is_empty() || name.len() > 1024 || name.contains('\0') {
        return false;
    }
    if name.contains('\\') {
        return false;
    }
    let path = Path::new(name);
    if path.is_absolute() {
        return false;
    }
    path.components().all(|c| matches!(c, Component::Normal(_)))
        && name
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

#[derive(Debug, Clone, PartialEq)]
pub enum SidecarIntegrity {
    Ok { version: String },
    Missing(String),
    Invalid(String),
}

pub fn load_manifest(sidecar_dir: &Path) -> Result<SidecarManifest, String> {
    let path = sidecar_dir.join("manifest.json");
    let raw = fs::read_to_string(&path).map_err(|_| "manifest_missing".to_string())?;
    let manifest: SidecarManifest =
        serde_json::from_str(&raw).map_err(|_| "manifest_invalid_json".to_string())?;
    match manifest.schema_version {
        1 => validate_schema1(&manifest)?,
        2 => validate_schema2(&manifest)?,
        _ => return Err("manifest_schema_unsupported".into()),
    }
    Ok(manifest)
}

const MACOS_BUNDLE_BINARY: &str = "UptokeyCore.app/Contents/MacOS/uptokey";
const MACOS_BUNDLE_PREFIX: &str = "UptokeyCore.app/Contents/MacOS/";

fn valid_binary_name(manifest: &SidecarManifest, macos: bool) -> bool {
    manifest.binary_name == sidecar_binary_name()
        || (macos && manifest.schema_version == 2 && manifest.binary_name == MACOS_BUNDLE_BINARY)
}
fn validate_common(manifest: &SidecarManifest) -> Result<(), String> {
    if !valid_binary_name(manifest, cfg!(target_os = "macos")) {
        return Err("manifest_binary_name_mismatch".into());
    }
    if !is_semverish(&manifest.build_version) {
        return Err("manifest_version_invalid".into());
    }
    let expected_target = if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        return Err("manifest_target_invalid".into());
    };
    if manifest.target != expected_target {
        return Err("manifest_target_invalid".into());
    }
    Ok(())
}

fn is_hex64_lower(value: &str) -> bool {
    value.len() == 64
        && value.chars().all(|c| c.is_ascii_hexdigit())
        && value == value.to_lowercase()
}

fn validate_schema1(manifest: &SidecarManifest) -> Result<(), String> {
    validate_common(manifest)?;
    if !is_hex64_lower(&manifest.sha256) {
        return Err("manifest_sha256_invalid".into());
    }
    if manifest.size_bytes == 0 {
        return Err("manifest_size_invalid".into());
    }
    Ok(())
}

fn validate_schema2(manifest: &SidecarManifest) -> Result<(), String> {
    validate_common(manifest)?;
    if manifest.runtime.as_deref() != Some("node") {
        return Err("manifest_runtime_invalid".into());
    }
    let entry = manifest.entry.as_deref().ok_or("manifest_entry_missing")?;
    if !valid_rel_path(entry) {
        return Err("manifest_entry_invalid".into());
    }
    if let Some(worker) = manifest.worker.as_deref() {
        if !valid_rel_path(worker) {
            return Err("manifest_worker_invalid".into());
        }
    }
    if manifest.files.is_empty() {
        return Err("manifest_files_missing".into());
    }
    for (name, file) in &manifest.files {
        if !valid_rel_path(name) {
            return Err("manifest_file_name_invalid".into());
        }
        if !is_hex64_lower(&file.sha256) {
            return Err("manifest_file_sha256_invalid".into());
        }
        if file.size_bytes == 0 {
            return Err("manifest_file_size_invalid".into());
        }
    }
    if manifest.binary_name == MACOS_BUNDLE_BINARY {
        let expected_entry = format!("{MACOS_BUNDLE_PREFIX}cli.js");
        let expected_worker = format!("{MACOS_BUNDLE_PREFIX}composition-worker.js");
        if entry != expected_entry
            || manifest.worker.as_deref() != Some(expected_worker.as_str())
            || [
                "UptokeyCore.app/Contents/MacOS/service-schema-worker.js",
                "UptokeyCore.app/Contents/MacOS/workspace-context-helper.js",
                "UptokeyCore.app/Contents/MacOS/uptokey-macos-protected-keyring.node",
                "UptokeyCore.app/Contents/Info.plist",
                "UptokeyCore.app/Contents/embedded.provisionprofile",
                "UptokeyCore.app/Contents/_CodeSignature/CodeResources",
            ]
            .iter()
            .any(|name| !manifest.files.contains_key(*name))
        {
            return Err("manifest_macos_bundle_incomplete".into());
        }
    }
    if !manifest.files.contains_key(entry) {
        return Err("manifest_entry_not_attested".into());
    }
    if !manifest.files.contains_key(&manifest.binary_name) {
        return Err("manifest_binary_not_attested".into());
    }
    Ok(())
}

pub fn is_semverish(v: &str) -> bool {
    let core = v.split('-').next().unwrap_or("");
    let mut parts = core.split('.');
    matches!(parts.next(), Some(p) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        && matches!(parts.next(), Some(p) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        && matches!(parts.next(), Some(p) if !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
        && parts.next().is_none()
}

pub fn sha256_hex(path: &Path) -> Result<String, String> {
    sha256_hex_while(path, &|| true)
}

fn sha256_hex_while(path: &Path, current: &dyn Fn() -> bool) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|_| "sidecar_read_failed".to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        if !current() {
            return Err("sidecar_verification_cancelled".into());
        }
        let n = file
            .read(&mut buf)
            .map_err(|_| "sidecar_read_failed".to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(to_hex(&hasher.finalize()))
}

pub fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// Verifica manifesto + todos os arquivos atestados. Nunca executa um binário
/// que falhe aqui. Schema 1 valida o binário único; schema 2 valida cada
/// arquivo listado (runtime, entrada, worker e bibliotecas nativas).
pub fn verify_sidecar(sidecar_dir: &Path) -> SidecarIntegrity {
    verify_sidecar_while(sidecar_dir, &|| true)
}

// Match the build-time verifier: an extra module could alter Node resolution
// even when all listed files still match. Reject redirects and unlisted files
// before hashing or executing anything in a schema-2 resource tree.
fn verify_resource_tree(
    root: &Path,
    directory: &Path,
    manifest: &SidecarManifest,
    current: &dyn Fn() -> bool,
) -> Result<(), String> {
    if !current() {
        return Err("sidecar_verification_cancelled".into());
    }
    let meta = fs::symlink_metadata(directory).map_err(|_| "sidecar_tree_unavailable")?;
    let redirected = meta.file_type().is_symlink();
    #[cfg(windows)]
    let redirected = {
        use std::os::windows::fs::MetadataExt;
        redirected || meta.file_attributes() & 0x400 != 0
    };
    if redirected || !meta.is_dir() {
        return Err("sidecar_tree_invalid".into());
    }
    for entry in fs::read_dir(directory).map_err(|_| "sidecar_tree_unavailable")? {
        let entry = entry.map_err(|_| "sidecar_tree_unavailable")?;
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|_| "sidecar_tree_unavailable")?;
        let redirected = meta.file_type().is_symlink();
        #[cfg(windows)]
        let redirected = {
            use std::os::windows::fs::MetadataExt;
            redirected || meta.file_attributes() & 0x400 != 0
        };
        if redirected {
            return Err("sidecar_tree_redirected".into());
        }
        if meta.is_dir() {
            verify_resource_tree(root, &path, manifest, current)?;
        } else {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "sidecar_tree_invalid")?;
            let name = relative
                .to_str()
                .ok_or("sidecar_tree_invalid")?
                .replace('\\', "/");
            if !meta.is_file() || (name != "manifest.json" && !manifest.files.contains_key(&name)) {
                return Err(format!("file_unattested:{name}"));
            }
        }
    }
    Ok(())
}

pub fn verify_sidecar_while(sidecar_dir: &Path, current: &dyn Fn() -> bool) -> SidecarIntegrity {
    if !current() {
        return SidecarIntegrity::Invalid("sidecar_verification_cancelled".into());
    }
    let manifest = match load_manifest(sidecar_dir) {
        Ok(m) => m,
        Err(e) => return SidecarIntegrity::Missing(e),
    };
    if !manifest.is_node_runtime() {
        let binary = sidecar_dir.join(&manifest.binary_name);
        let meta = match fs::metadata(&binary) {
            Ok(m) if m.is_file() => m,
            _ => return SidecarIntegrity::Missing("binary_missing".into()),
        };
        if meta.len() != manifest.size_bytes {
            return SidecarIntegrity::Invalid("binary_size_mismatch".into());
        }
        return match sha256_hex_while(&binary, current) {
            Ok(hash) if hash == manifest.sha256 => SidecarIntegrity::Ok {
                version: manifest.build_version,
            },
            Ok(_) => SidecarIntegrity::Invalid("binary_hash_mismatch".into()),
            Err(e) => SidecarIntegrity::Invalid(e),
        };
    }
    if let Err(reason) = verify_resource_tree(sidecar_dir, sidecar_dir, &manifest, current) {
        return SidecarIntegrity::Invalid(reason);
    }
    for (name, attested) in &manifest.files {
        if !current() {
            return SidecarIntegrity::Invalid("sidecar_verification_cancelled".into());
        }
        let file = sidecar_dir.join(name);
        let meta = match fs::symlink_metadata(&file) {
            Ok(m) if m.file_type().is_file() && !m.file_type().is_symlink() => m,
            _ => return SidecarIntegrity::Missing(format!("file_missing:{}", name)),
        };
        if meta.len() != attested.size_bytes {
            return SidecarIntegrity::Invalid(format!("file_size_mismatch:{}", name));
        }
        match sha256_hex_while(&file, current) {
            Ok(hash) if hash == attested.sha256 => {}
            Ok(_) => return SidecarIntegrity::Invalid(format!("file_hash_mismatch:{}", name)),
            Err(e) => return SidecarIntegrity::Invalid(e),
        }
    }
    SidecarIntegrity::Ok {
        version: manifest.build_version,
    }
}

/// Localiza o diretório do sidecar a partir do diretório de recursos do bundle.
///
/// O instalador NSIS/MSI deposita `resources/sidecar/` dentro do diretório do
/// executável (`resource_dir`), resultando em `<resource_dir>/resources/sidecar/`.
/// Em desenvolvimento (`cargo run` sem bundle), os artefatos ficam em
/// `<crate>/resources/sidecar/`.
///
/// Ordem de busca:
/// 1. `<resource_dir>/resources/sidecar/` — caminho do pacote instalado
/// 2. `<resource_dir>/sidecar/`          — fallback legado
/// 3. `<crate>/resources/sidecar/`       — árvore de desenvolvimento
pub fn resolve_sidecar_dir(resource_dir: &Path) -> PathBuf {
    // Caminho do pacote instalado (NSIS/MSI preservam a hierarquia bundle).
    let installed = resource_dir.join("resources").join("sidecar");
    if installed.join("manifest.json").exists() {
        return installed;
    }
    // Fallback legado: sidecar diretamente dentro do resource_dir.
    let flat = resource_dir.join("sidecar");
    if flat.join("manifest.json").exists() {
        return flat;
    }
    // Development fallback must never embed a builder's private source path
    // or make a production app depend on that checkout.
    #[cfg(debug_assertions)]
    {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("sidecar");
        if dev.join("manifest.json").exists() {
            return dev;
        }
    }
    // Nenhum encontrado — retorna o caminho do pacote para falha explícita.
    installed
}

// ---------------------------------------------------------------------------
// Probe de identidade do proxy (HTTP loopback mínimo, sem dependências)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct HealthInfo {
    pub version: String,
    pub started_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProbeOutcome {
    /// Respondeu e a identidade é a do proxy canônico Uptokey.
    Identified(HealthInfo),
    /// Algo respondeu na porta, mas não é o proxy Uptokey (não tocar!).
    Foreign,
    /// Nada respondeu.
    Unreachable,
}

pub fn probe_health(host: &str, port: u16, ipc_secret: &str, timeout: Duration) -> ProbeOutcome {
    match http_get(host, port, HEALTH_PATH, ipc_secret, timeout) {
        Some((200, body)) => match parse_health_identity(&body) {
            Some(info) => ProbeOutcome::Identified(info),
            None => ProbeOutcome::Foreign,
        },
        Some((_, _)) => ProbeOutcome::Foreign,
        None => ProbeOutcome::Unreachable,
    }
}

fn parse_health_identity(body: &str) -> Option<HealthInfo> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    if value.get("status")?.as_str()? != "ok" {
        return None;
    }
    if value.get("data_plane")?.as_str()? != "local" {
        return None;
    }
    let version = value.get("version")?.as_str()?.to_string();
    let semver = version.strip_prefix('v').unwrap_or(&version);
    if !is_semverish(semver) {
        return None;
    }
    let started_at = value
        .get("started_at")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Some(HealthInfo {
        version,
        started_at,
    })
}

fn http_get(
    host: &str,
    port: u16,
    path: &str,
    ipc_secret: &str,
    timeout: Duration,
) -> Option<(u16, String)> {
    let deadline = Instant::now() + timeout;
    let addr = format!("{}:{}", host, port);
    let mut stream = TcpStream::connect(&addr).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .ok()?;
    stream
        .set_write_timeout(Some(Duration::from_millis(500)))
        .ok()?;
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: uptokey-tauri-health\r\nAuthorization: Bearer {}\r\nAccept: application/json\r\nConnection: close\r\n\r\n",
        path, addr, ipc_secret
    );
    use std::io::Write;
    stream.write_all(request.as_bytes()).ok()?;
    let mut raw = Vec::with_capacity(8192);
    let mut buf = [0u8; 8192];
    loop {
        if Instant::now() > deadline || raw.len() > 256 * 1024 {
            return None;
        }
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => raw.extend_from_slice(&buf[..n]),
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                if Instant::now() > deadline {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    }
    let text = String::from_utf8_lossy(&raw);
    let mut parts = text.splitn(2, "\r\n\r\n");
    let head = parts.next()?;
    let body = parts.next().unwrap_or("");
    let status: u16 = head
        .lines()
        .next()?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()?;
    // Respostas chunked do servidor loopback são decodificadas de forma mínima.
    let decoded = if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        decode_chunked(body)
    } else {
        body.to_string()
    };
    Some((status, decoded))
}

fn decode_chunked(body: &str) -> String {
    let bytes = body.as_bytes();
    let mut out = String::new();
    let mut pos = 0usize;
    while let Some(i) = find_subslice(&bytes[pos..], b"\r\n") {
        let line_end = pos + i;
        let size_str = String::from_utf8_lossy(&bytes[pos..line_end]);
        let size = match usize::from_str_radix(size_str.trim(), 16) {
            Ok(s) => s,
            Err(_) => break,
        };
        pos = line_end + 2;
        if size == 0 {
            break;
        }
        if pos + size > bytes.len() {
            break;
        }
        out.push_str(&String::from_utf8_lossy(&bytes[pos..pos + size]));
        pos += size + 2;
    }
    out
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

// ---------------------------------------------------------------------------
// Spawn / encerramento do processo filho
// ---------------------------------------------------------------------------

/// Variáveis de ambiente que o sidecar pode herdar: apenas caminhos de sistema
/// não secretos e a origem pública do serviço de conta. Nenhuma variável de
/// sessão, token ou configuração privada do serviço de conta passa.
pub fn sanitized_child_env() -> Vec<(String, String)> {
    sanitized_child_env_from(|key| std::env::var(key).ok())
}

/// Explicit operational profiles are shared by the daemon and trusted helpers.
/// Unset overrides retain the canonical default; invalid overrides never fall
/// back silently to a different profile.
pub fn validated_child_env() -> Result<Vec<(String, String)>, String> {
    validated_child_env_from(|key| std::env::var(key).ok())
}

fn validated_child_env_from(
    mut lookup: impl FnMut(&str) -> Option<String>,
) -> Result<Vec<(String, String)>, String> {
    let profile = crate::config::OperationalProfile::from_lookup(&mut lookup)?;
    let mut out = sanitized_child_env_from(&mut lookup);
    let configured = out
        .iter()
        .find(|(key, _)| key == "UPTOKEY_ACCOUNT_SERVICE_ORIGIN")
        .map(|(_, value)| value.as_str());
    let origin = crate::account_urls::service_origin(configured)?;
    if configured.is_none() {
        out.push(("UPTOKEY_ACCOUNT_SERVICE_ORIGIN".into(), origin));
    }
    for key in [
        "UPTOKEY_QUIMERA_DATA_DIR",
        "UPTOKEY_QUIMERA_CONTROL_DATA_DIR",
    ] {
        if let Some(value) = lookup(key) {
            validate_profile_directory(&value)?;
            out.push((key.to_string(), value));
        }
    }
    // This existing nonsecret runner opt-in is required by some configured OCI
    // hosts; only its exact boolean representation may cross this boundary.
    if let Some(service) = profile.secret_service {
        out.push(("UPTOKEY_SECRET_SERVICE".into(), service));
    }
    if let Some(value) = lookup("UPTOKEY_RUNNER_ALLOW_ROOTFUL") {
        if value != "0" && value != "1" {
            return Err("sidecar_runner_configuration_invalid".into());
        }
        out.push(("UPTOKEY_RUNNER_ALLOW_ROOTFUL".into(), value));
    }
    Ok(out)
}

pub(crate) fn validate_profile_directory(value: &str) -> Result<(), String> {
    let invalid = || "sidecar_profile_invalid".to_string();
    let path = Path::new(value);
    if value.is_empty()
        || value.trim() != value
        || value.chars().any(char::is_control)
        || !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
        || path.components().any(|part| match part {
            Component::Normal(name) => name
                .to_string_lossy()
                .trim_end_matches([' ', '.'])
                .eq_ignore_ascii_case(".uptokey"),
            _ => false,
        })
    {
        return Err(invalid());
    }
    for ancestor in path.ancestors() {
        let metadata = match fs::symlink_metadata(ancestor) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(invalid()),
        };
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(invalid());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

fn sanitized_child_env_from(
    mut lookup: impl FnMut(&str) -> Option<String>,
) -> Vec<(String, String)> {
    const ALLOWED_WINDOWS: &[&str] = &[
        "PATH",
        "SystemRoot",
        "WINDIR",
        "SystemDrive",
        "COMSPEC",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "PROGRAMDATA",
        "PATHEXT",
        "NUMBER_OF_PROCESSORS",
    ];
    const ALLOWED_UNIX: &[&str] = &[
        "PATH",
        "HOME",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "XDG_RUNTIME_DIR",
        "XDG_DATA_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_DIRS",
        "DBUS_SESSION_BUS_ADDRESS",
    ];
    let allowed: &[&str] = if cfg!(target_os = "windows") {
        ALLOWED_WINDOWS
    } else {
        ALLOWED_UNIX
    };
    let mut out = Vec::new();
    for key in allowed {
        if let Some(value) = lookup(key) {
            out.push((key.to_string(), value));
        }
    }
    if let Some(value) = lookup("UPTOKEY_ACCOUNT_SERVICE_ORIGIN") {
        out.push(("UPTOKEY_ACCOUNT_SERVICE_ORIGIN".to_string(), value));
    }
    out
}

pub fn spawn_sidecar(
    sidecar_dir: &Path,
    manifest: &SidecarManifest,
    ipc_secret: &str,
) -> Result<Child, String> {
    let binary = sidecar_dir.join(&manifest.binary_name);
    if !binary.is_file() {
        return Err("sidecar_binary_missing".to_string());
    }
    let mut cmd = Command::new(&binary);
    if manifest.is_node_runtime() {
        // Runtime Node empacotado: a entrada real é um arquivo .js atestado.
        let entry = manifest
            .entry
            .as_deref()
            .ok_or_else(|| "sidecar_entry_missing".to_string())?;
        let entry_path = sidecar_dir.join(entry);
        if !entry_path.is_file() {
            return Err("sidecar_entry_missing".to_string());
        }
        cmd.arg(&entry_path);
    }
    cmd.arg("proxy")
        .arg("start")
        .current_dir(sidecar_dir)
        .env_clear()
        .envs(validated_child_env()?)
        .env("UPTOKEY_IPC_SECRET", ipc_secret)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[allow(unused_mut)]
    let mut child = cmd
        .spawn()
        .map_err(|_| "sidecar_spawn_failed".to_string())?;

    #[cfg(target_os = "windows")]
    bind_owned_child(&mut child, assign_owned_job)?;
    Ok(child)
}

#[cfg(any(windows, test))]
fn bind_owned_child(
    child: &mut Child,
    bind: impl FnOnce(&Child) -> Result<(), String>,
) -> Result<(), String> {
    if let Err(reason) = bind(child) {
        // Child::drop does not terminate a process. An unsuccessful job bind
        // must reap only the process this launch created before returning.
        terminate_child(child, Duration::from_secs(5));
        return Err(reason);
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn assign_owned_job(child: &Child) -> Result<(), String> {
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job == 0 {
                return Err("job_object_create_failed".to_string());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let set_ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            );
            if set_ok == 0 {
                CloseHandle(job);
                return Err("job_object_set_limits_failed".to_string());
            }
            let assign_ok = AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE);
            if assign_ok == 0 {
                CloseHandle(job);
                return Err("job_object_assign_failed".to_string());
            }
            // Leak the job handle: it stays alive until our process dies,
            // guaranteeing KILL_ON_JOB_CLOSE takes the sidecar with us.
        }
    }
    Ok(())
}

/// Encerramento gracioso em Unix (SIGTERM → espera → SIGKILL); no Windows o
/// TerminateProcess do `kill()` é o único mecanismo suportado pelo runtime
/// compilado — o proxy persiste estado de forma atômica (atomic-json), e só
/// encerramos o PID filho criado por esta instância.
pub fn terminate_child(child: &mut Child, grace: Duration) -> bool {
    #[cfg(unix)]
    {
        let pid = child.id() as libc::pid_t;
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
        let deadline = Instant::now() + grace;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return true,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(50))
                }
                Ok(None) => {
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                    }
                    let _ = child.wait();
                    return true;
                }
                Err(_) => return false,
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = grace;
        let _ = child.kill();
        child.wait().is_ok()
    }
}

// ---------------------------------------------------------------------------
// Redação de log do sidecar
// ---------------------------------------------------------------------------

/// Redige padrões de credencial antes de qualquer persistência de log.
/// Canários cobertos por teste: tokens de cliente, Bearer, chaves de provedor
/// e PEM. Nunca redige parcialmente: ou a linha sai mascarada ou não sai.
pub fn redact_line(input: &str) -> String {
    let mut line = input.to_string();
    // Prefixed tokens must run before kv markers so that utk_local_ in
    // "token=utk_local_..." is caught by prefix, not partially by kv.
    line = mask_prefixed_token(&line, "utk_local_", 24);
    line = mask_prefixed_token(&line, "sk-", 16);
    line = mask_prefixed_token(&line, "gsk_", 16);
    line = mask_prefixed_token(&line, "AIza", 20);
    line = mask_prefixed_token(&line, "xox", 20);
    for prefix in ["Bearer ", "bearer "] {
        line = mask_after_marker(&line, prefix);
    }
    for marker in ["token=", "key=", "secret=", "authorization:"] {
        line = mask_kv_marker(&line, marker);
    }
    if line.contains("-----BEGIN") && line.contains("PRIVATE KEY-----") {
        return "[redacted:pem]".to_string();
    }
    line
}

fn mask_after_marker(line: &str, marker: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(idx) = rest.find(marker) {
        out.push_str(&rest[..idx + marker.len()]);
        let after = &rest[idx + marker.len()..];
        let end = after
            .find(|c: char| c.is_whitespace() || c == '"')
            .unwrap_or(after.len());
        out.push_str("[redacted]");
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

fn mask_kv_marker(line: &str, marker: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(idx) = rest.to_lowercase().find(marker) {
        out.push_str(&rest[..idx + marker.len()]);
        let after = &rest[idx + marker.len()..];
        if let Some(stripped) = after.strip_prefix("utk_local_[redacted]") {
            out.push_str("utk_local_[redacted]");
            rest = stripped;
            continue;
        }
        let end = after
            .find(|c: char| c.is_whitespace() || c == '"')
            .unwrap_or(after.len());
        out.push_str("[redacted]");
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

fn mask_prefixed_token(line: &str, prefix: &str, min_tail: usize) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(idx) = rest.find(prefix) {
        out.push_str(&rest[..idx]);
        let after = &rest[idx..];
        let end = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.'))
            .unwrap_or(after.len());
        if end >= prefix.len() + min_tail {
            out.push_str(prefix);
            out.push_str("[redacted]");
        } else {
            out.push_str(&after[..end]);
        }
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod portable_layout_tests {

    #[test]
    fn sidecar_manifest_rejects_wrong_platform() {
        let expected = if cfg!(windows) {
            "win32"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        };
        let mut manifest = super::SidecarManifest {
            schema_version: 2,
            binary_name: super::sidecar_binary_name().into(),
            build_version: "0.2.0".into(),
            target: expected.into(),
            ..Default::default()
        };
        assert!(super::validate_common(&manifest).is_ok());
        manifest.target = if expected == "darwin" {
            "linux"
        } else {
            "darwin"
        }
        .into();
        assert_eq!(
            super::validate_common(&manifest).unwrap_err(),
            "manifest_target_invalid"
        );
    }

    #[test]
    fn nested_macos_binary_is_exact_and_only_schema_two() {
        let mut manifest = super::SidecarManifest {
            schema_version: 2,
            binary_name: super::MACOS_BUNDLE_BINARY.into(),
            ..Default::default()
        };
        assert!(super::valid_binary_name(&manifest, true));
        assert!(!super::valid_binary_name(&manifest, false));
        manifest.schema_version = 1;
        assert!(!super::valid_binary_name(&manifest, true));
        manifest.schema_version = 2;
        manifest.binary_name = "Other.app/Contents/MacOS/uptokey".into();
        assert!(!super::valid_binary_name(&manifest, true));
    }
    #[test]
    fn installed_resources_win_over_a_legacy_sibling() {
        let root = tempfile::tempdir().unwrap();
        let installed = root.path().join("resources").join("sidecar");
        let legacy = root.path().join("sidecar");
        std::fs::create_dir_all(&installed).unwrap();
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(installed.join("manifest.json"), b"{}").unwrap();
        std::fs::write(legacy.join("manifest.json"), b"{}").unwrap();
        assert_eq!(super::resolve_sidecar_dir(root.path()), installed);
    }

    #[test]
    fn existing_flat_packages_remain_usable() {
        let root = tempfile::tempdir().unwrap();
        let legacy = root.path().join("sidecar");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("manifest.json"), b"{}").unwrap();
        assert_eq!(super::resolve_sidecar_dir(root.path()), legacy);
    }
}

#[cfg(test)]
mod child_environment_tests {
    use super::*;

    #[test]
    fn forwards_public_account_origin_without_reading_private_account_configuration() {
        let mut requested = Vec::new();
        let actual = super::sanitized_child_env_from(|key| {
            requested.push(key.to_string());
            match key {
                "UPTOKEY_ACCOUNT_SERVICE_ORIGIN" => Some("http://localhost:3000".to_string()),
                "AUTH0_SECRET" | "AUTH0_CLIENT_SECRET" | "UPTOKEY_ACCOUNT_BROKER_DIR" => {
                    panic!("private account configuration was requested")
                }
                _ => None,
            }
        });
        assert_eq!(
            actual,
            vec![(
                "UPTOKEY_ACCOUNT_SERVICE_ORIGIN".to_string(),
                "http://localhost:3000".to_string()
            )]
        );
        assert_eq!(
            requested
                .iter()
                .filter(|key| key.as_str() == "UPTOKEY_ACCOUNT_SERVICE_ORIGIN")
                .count(),
            1
        );
    }

    #[test]
    fn preserves_exact_operational_profiles_and_existing_runner_opt_in() {
        let fixture = tempfile::tempdir().unwrap();
        let data = fixture.path().join("proxy").to_string_lossy().into_owned();
        let control = fixture
            .path()
            .join("control-plane")
            .to_string_lossy()
            .into_owned();
        let actual = validated_child_env_from(|key| match key {
            "UPTOKEY_QUIMERA_DATA_DIR" => Some(data.clone()),
            "UPTOKEY_QUIMERA_CONTROL_DATA_DIR" => Some(control.clone()),
            "UPTOKEY_RUNNER_ALLOW_ROOTFUL" => Some("1".into()),
            "UPTOKEY_ACCOUNT_SERVICE_ORIGIN" => Some("http://localhost:3000".into()),
            "UPTOKEY_SECRET_SERVICE" => Some("com.uptokey.quimera.proxy.profile-test".into()),
            "AUTH0_SECRET"
            | "AUTH0_CLIENT_SECRET"
            | "UPTOKEY_ACCOUNT_BROKER_DIR"
            | "UPTOKEY_TUI_TOKEN" => panic!("secret override requested"),
            _ => None,
        })
        .unwrap();
        assert_eq!(
            actual,
            vec![
                (
                    "UPTOKEY_ACCOUNT_SERVICE_ORIGIN".into(),
                    "http://localhost:3000".into()
                ),
                ("UPTOKEY_QUIMERA_DATA_DIR".into(), data),
                ("UPTOKEY_QUIMERA_CONTROL_DATA_DIR".into(), control),
                (
                    "UPTOKEY_SECRET_SERVICE".into(),
                    "com.uptokey.quimera.proxy.profile-test".into()
                ),
                ("UPTOKEY_RUNNER_ALLOW_ROOTFUL".into(), "1".into()),
            ]
        );
        assert!(!fixture.path().join("proxy").exists());
        assert!(!fixture.path().join("control-plane").exists());
    }

    #[test]
    fn absence_retains_default_and_invalid_override_never_silently_falls_back() {
        assert_eq!(
            validated_child_env_from(|_| None).unwrap(),
            vec![(
                "UPTOKEY_ACCOUNT_SERVICE_ORIGIN".into(),
                crate::account_urls::ACCOUNT_ORIGIN.into()
            )]
        );
        let fixture = tempfile::tempdir().unwrap();
        let invalid = [
            "relative/profile".into(),
            "".into(),
            " bad ".into(),
            fixture
                .path()
                .join(".uptokey")
                .to_string_lossy()
                .into_owned(),
            format!("{}{}", fixture.path().display(), '\n'),
        ];
        for value in invalid {
            for key in [
                "UPTOKEY_QUIMERA_DATA_DIR",
                "UPTOKEY_QUIMERA_CONTROL_DATA_DIR",
            ] {
                assert_eq!(
                    validated_child_env_from(|requested| {
                        (requested == key).then(|| value.clone())
                    })
                    .unwrap_err(),
                    "sidecar_profile_invalid"
                );
            }
        }
        assert_eq!(
            validated_child_env_from(|key| {
                (key == "UPTOKEY_RUNNER_ALLOW_ROOTFUL").then(|| "true".into())
            })
            .unwrap_err(),
            "sidecar_runner_configuration_invalid"
        );
    }

    #[test]
    fn rejects_existing_file_and_link_ancestors() {
        let fixture = tempfile::tempdir().unwrap();
        let file = fixture.path().join("file");
        fs::write(&file, b"fixture").unwrap();
        assert!(validate_profile_directory(&file.to_string_lossy()).is_err());
        assert!(validate_profile_directory(&file.join("child").to_string_lossy()).is_err());
        #[cfg(unix)]
        {
            let link = fixture.path().join("linked");
            std::os::unix::fs::symlink(fixture.path(), &link).unwrap();
            assert!(validate_profile_directory(&link.join("child").to_string_lossy()).is_err());
        }
        #[cfg(windows)]
        {
            let link = fixture.path().join("linked");
            // A junction does not require enabling Developer Mode or changing
            // policy. Its target and lifetime are confined to this fixture.
            let result =
                Command::new(std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()))
                    .args(["/d", "/c", "mklink", "/J"])
                    .arg(&link)
                    .arg(fixture.path())
                    .output()
                    .unwrap();
            assert!(result.status.success());
            assert!(validate_profile_directory(&link.join("child").to_string_lossy()).is_err());
            fs::remove_dir(&link).unwrap();
        }
    }

    #[test]
    fn operational_profile_child_fixture() {
        if std::env::var("UPTOKEY_PROFILE_CHILD_FIXTURE").as_deref() != Ok("1") {
            return;
        }
        assert_eq!(
            std::env::var("UPTOKEY_QUIMERA_DATA_DIR").unwrap(),
            std::env::var("UPTOKEY_EXPECT_DATA_DIR").unwrap()
        );
        assert_eq!(
            std::env::var("UPTOKEY_QUIMERA_CONTROL_DATA_DIR").unwrap(),
            std::env::var("UPTOKEY_EXPECT_CONTROL_DIR").unwrap()
        );
        assert_eq!(
            std::env::var("UPTOKEY_RUNNER_ALLOW_ROOTFUL").as_deref(),
            Ok("1")
        );
        assert!(std::env::var("AUTH0_SECRET").is_err());
        assert_eq!(
            std::env::var("UPTOKEY_SECRET_SERVICE").as_deref(),
            Ok("com.uptokey.quimera.proxy.child-test")
        );
        assert!(std::env::var("UPTOKEY_TUI_TOKEN").is_err());
        println!("operational_profile_child_verified");
    }

    #[test]
    fn operational_profiles_reach_a_real_child_without_secret_inheritance() {
        let fixture = tempfile::tempdir().unwrap();
        let data = fixture.path().join("proxy").to_string_lossy().into_owned();
        let control = fixture
            .path()
            .join("control-plane")
            .to_string_lossy()
            .into_owned();
        let environment = validated_child_env_from(|key| match key {
            "UPTOKEY_QUIMERA_DATA_DIR" => Some(data.clone()),
            "UPTOKEY_QUIMERA_CONTROL_DATA_DIR" => Some(control.clone()),
            "UPTOKEY_RUNNER_ALLOW_ROOTFUL" => Some("1".into()),
            "UPTOKEY_ACCOUNT_SERVICE_ORIGIN" => None,
            "UPTOKEY_SECRET_SERVICE" => Some("com.uptokey.quimera.proxy.child-test".into()),
            _ => std::env::var(key).ok(),
        })
        .unwrap();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "sidecar::child_environment_tests::operational_profile_child_fixture",
                "--nocapture",
            ])
            .env_clear()
            .envs(environment)
            .env("UPTOKEY_PROFILE_CHILD_FIXTURE", "1")
            .env("UPTOKEY_EXPECT_DATA_DIR", &data)
            .env("UPTOKEY_EXPECT_CONTROL_DIR", &control)
            .stdin(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let output = command.output().unwrap();
        assert!(output.status.success());
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("operational_profile_child_verified")
        );
        assert!(!fixture.path().join("proxy").exists());
        assert!(!fixture.path().join("control-plane").exists());
    }

    #[test]
    fn owned_job_child_fixture() {
        if std::env::var("UPTOKEY_JOB_CHILD_FIXTURE").as_deref() == Ok("1") {
            std::thread::sleep(Duration::from_secs(10));
        }
    }

    #[test]
    fn failed_job_binding_terminates_and_reaps_only_the_new_owned_child() {
        for reason in [
            "job_object_create_failed",
            "job_object_set_limits_failed",
            "job_object_assign_failed",
        ] {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "sidecar::child_environment_tests::owned_job_child_fixture",
                    "--nocapture",
                ])
                .env("UPTOKEY_JOB_CHILD_FIXTURE", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x0800_0000);
            }
            let mut child = command.spawn().unwrap();
            assert!(child.try_wait().unwrap().is_none());
            assert_eq!(
                bind_owned_child(&mut child, |_| Err(reason.into())).unwrap_err(),
                reason
            );
            assert!(child.try_wait().unwrap().is_some());
        }
    }

    #[test]
    fn verification_cancellation_is_observed_between_hash_chunks_without_weakening_hashes() {
        let fixture = tempfile::tempdir().unwrap();
        let file = fixture.path().join("fixture.bin");
        let bytes = vec![42u8; 128 * 1024];
        fs::write(&file, &bytes).unwrap();
        let complete = sha256_hex(&file).unwrap();
        assert_eq!(complete, to_hex(&Sha256::digest(&bytes)));
        assert_eq!(sha256_hex_while(&file, &|| true).unwrap(), complete);
        let chunks = std::cell::Cell::new(0);
        assert_eq!(
            sha256_hex_while(&file, &|| {
                chunks.set(chunks.get() + 1);
                chunks.get() < 2
            })
            .unwrap_err(),
            "sidecar_verification_cancelled"
        );
        assert_eq!(chunks.get(), 2);
        assert_eq!(
            verify_sidecar_while(fixture.path(), &|| false),
            SidecarIntegrity::Invalid("sidecar_verification_cancelled".into())
        );
    }
}
