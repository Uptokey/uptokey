//! Extra integration coverage for the sidecar checklist:
//! size mismatch, malformed manifests, foreign/unreachable probes and
//! interrupted-update (atomic config) behavior. Uses tempdirs and ephemeral
//! loopback ports only; never touches a real proxy or installation.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;

use uptokey_tauri_lib::config;
use uptokey_tauri_lib::sidecar::{
    self, probe_health, sidecar_binary_name, verify_sidecar, ProbeOutcome, SidecarIntegrity,
    SidecarManifest,
};

fn write_binary(dir: &std::path::Path, bytes: &[u8]) -> std::path::PathBuf {
    let path = dir.join(sidecar_binary_name());
    let mut file = File::create(&path).expect("create binary");
    file.write_all(bytes).expect("write binary");
    file.flush().expect("flush");
    path
}

#[test]
fn schema2_rejects_unlisted_module_before_consuming_harness_resources() {
    let parent =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../output/sidecar-tree-tests");
    fs::create_dir_all(&parent).unwrap();
    let fixture = tempfile::tempdir_in(parent).unwrap();
    let root = fixture.path();
    let node = write_binary(root, b"synthetic node, never execute");
    fs::write(root.join("cli.js"), b"synthetic cli").unwrap();
    let files = [
        (sidecar_binary_name().to_string(), node),
        ("cli.js".to_string(), root.join("cli.js")),
    ]
    .into_iter()
    .map(|(name, path)| {
        (
            name,
            sidecar::AttestedFile {
                sha256: sidecar::sha256_hex(&path).unwrap(),
                size_bytes: fs::metadata(path).unwrap().len(),
            },
        )
    })
    .collect();
    let manifest = SidecarManifest {
        schema_version: 2,
        binary_name: sidecar_binary_name().into(),
        build_version: "0.1.0-test".into(),
        target: if cfg!(windows) { "win32" } else { "linux" }.into(),
        runtime: Some("node".into()),
        entry: Some("cli.js".into()),
        files,
        ..Default::default()
    };
    write_manifest(root, &manifest);
    assert!(matches!(verify_sidecar(root), SidecarIntegrity::Ok { .. }));
    fs::create_dir_all(root.join("harness/node_modules")).unwrap();
    fs::write(
        root.join("harness/node_modules/extra.js"),
        b"unattested module",
    )
    .unwrap();
    assert_eq!(
        verify_sidecar(root),
        SidecarIntegrity::Invalid("file_unattested:harness/node_modules/extra.js".into())
    );
}

fn write_manifest(dir: &std::path::Path, manifest: &SidecarManifest) {
    let json = serde_json::to_string_pretty(manifest).expect("serialize manifest");
    fs::write(dir.join("manifest.json"), json).expect("write manifest");
}

fn valid_manifest(dir: &std::path::Path) -> SidecarManifest {
    let bin = write_binary(dir, b"dummy binary content for integrity tests");
    let size = fs::metadata(&bin).unwrap().len();
    let sha = sidecar::sha256_hex(&bin).expect("sha256");
    SidecarManifest {
        schema_version: 1,
        binary_name: sidecar_binary_name().to_string(),
        build_version: "0.0.0-test".into(),
        package_version: "0.0.0-test".into(),
        target: if cfg!(target_os = "windows") {
            "win32"
        } else {
            "unix"
        }
        .into(),
        sha256: sha,
        size_bytes: size,
        ..Default::default()
    }
}

#[test]
fn size_mismatch_is_invalid_not_missing() {
    let temp = tempfile::tempdir().expect("tempdir");
    let mut manifest = valid_manifest(temp.path());
    manifest.size_bytes += 1;
    write_manifest(temp.path(), &manifest);
    match verify_sidecar(temp.path()) {
        SidecarIntegrity::Invalid(reason) => assert_eq!(reason, "binary_size_mismatch"),
        other => panic!("expected Invalid(size), got {:?}", other),
    }
}

#[test]
fn missing_manifest_is_missing_not_invalid() {
    let temp = tempfile::tempdir().expect("tempdir");
    write_binary(temp.path(), b"orphan binary without manifest");
    match verify_sidecar(temp.path()) {
        SidecarIntegrity::Missing(reason) => assert_eq!(reason, "manifest_missing"),
        other => panic!("expected Missing, got {:?}", other),
    }
}

#[test]
fn malformed_manifest_json_is_missing() {
    let temp = tempfile::tempdir().expect("tempdir");
    fs::write(temp.path().join("manifest.json"), "{not json").expect("write");
    match verify_sidecar(temp.path()) {
        SidecarIntegrity::Missing(reason) => assert_eq!(reason, "manifest_invalid_json"),
        other => panic!("expected Missing(invalid_json), got {:?}", other),
    }
}

#[test]
fn unsupported_schema_is_missing() {
    let temp = tempfile::tempdir().expect("tempdir");
    let mut manifest = valid_manifest(temp.path());
    manifest.schema_version = 3;
    write_manifest(temp.path(), &manifest);
    match verify_sidecar(temp.path()) {
        SidecarIntegrity::Missing(reason) => assert_eq!(reason, "manifest_schema_unsupported"),
        other => panic!("expected Missing(schema), got {:?}", other),
    }
}

#[test]
fn wrong_binary_name_is_missing() {
    let temp = tempfile::tempdir().expect("tempdir");
    let mut manifest = valid_manifest(temp.path());
    manifest.binary_name = "something-else.exe".into();
    write_manifest(temp.path(), &manifest);
    match verify_sidecar(temp.path()) {
        SidecarIntegrity::Missing(reason) => {
            assert_eq!(reason, "manifest_binary_name_mismatch")
        }
        other => panic!("expected Missing(name), got {:?}", other),
    }
}

#[test]
fn non_hex_sha_is_missing() {
    let temp = tempfile::tempdir().expect("tempdir");
    let mut manifest = valid_manifest(temp.path());
    manifest.sha256 = "z".repeat(64);
    write_manifest(temp.path(), &manifest);
    match verify_sidecar(temp.path()) {
        SidecarIntegrity::Missing(reason) => assert_eq!(reason, "manifest_sha256_invalid"),
        other => panic!("expected Missing(sha), got {:?}", other),
    }
}

/// Serves one fixed HTTP response on an ephemeral loopback port.
fn serve_once(response: &'static str) -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind ephemeral");
    let port = listener.local_addr().expect("addr").port();
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buf = [0u8; 4096];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
    port
}

#[test]
fn foreign_service_on_port_is_never_adopted() {
    // "Estrangeiro": algo responde 200 mas não é o proxy Uptokey.
    let port = serve_once(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 16\r\nConnection: close\r\n\r\n{\"status\":\"busy\"}",
    );
    assert_eq!(
        probe_health("127.0.0.1", port, "dummy_secret", Duration::from_secs(2)),
        ProbeOutcome::Foreign
    );
}

#[test]
fn unreachable_port_is_not_a_proxy() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);
    assert_eq!(
        probe_health(
            "127.0.0.1",
            port,
            "dummy_secret",
            Duration::from_millis(500)
        ),
        ProbeOutcome::Unreachable
    );
}

#[test]
fn interrupted_update_never_promotes_a_partial_config() {
    // "Update interrompido": crash no meio da escrita deixa um .tmp truncado;
    // a config válida anterior continua valendo e o .tmp nunca é promovido.
    let temp = tempfile::tempdir().expect("tempdir");
    let dir = temp.path();
    fs::write(
        dir.join(config::CONFIG_FILE),
        "{\"schema_version\":2,\"theme\":\"dark\"}",
    )
    .expect("write valid config");
    fs::write(
        dir.join(format!("{}.tmp", config::CONFIG_FILE)),
        "{\"schema_version\":2,\"theme\":",
    )
    .expect("write truncated tmp");
    let loaded = config::load_or_migrate(dir);
    assert_eq!(loaded.theme.as_deref(), Some("dark"));
    assert_eq!(loaded.schema_version, 2);
}

#[test]
fn log_redaction_masks_canaries_and_keeps_plain_lines() {
    assert_eq!(
        sidecar::redact_line("use Bearer abcdefghijklmnopqrstuvwxyz0123456789 now"),
        "use Bearer [redacted] now"
    );
    assert!(
        sidecar::redact_line("token=utk_local_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee ok")
            .contains("utk_local_[redacted]")
    );
    assert!(sidecar::redact_line("key=sk-abcdefghijklmnopqr end").contains("[redacted]"));
    assert_eq!(
        sidecar::redact_line("-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----"),
        "[redacted:pem]"
    );
    assert_eq!(
        sidecar::redact_line("proxy listening on 127.0.0.1:21435 ready"),
        "proxy listening on 127.0.0.1:21435 ready"
    );
}

// ---------------------------------------------------------------------------
// Schema 2 (Node runtime empacotado, atestação de todos os arquivos)
// ---------------------------------------------------------------------------

use std::collections::BTreeMap;

fn write_attested(dir: &std::path::Path, rel: &str, bytes: &[u8]) {
    let path = dir.join(rel);
    fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
    let mut file = File::create(&path).expect("create attested file");
    file.write_all(bytes).expect("write");
    file.flush().expect("flush");
}

fn v2_files(dir: &std::path::Path) -> BTreeMap<String, sidecar::AttestedFile> {
    let mut files = BTreeMap::new();
    for rel in [
        sidecar_binary_name().to_string(),
        "cli.js".to_string(),
        "composition-worker.js".to_string(),
        "node_modules/better-sqlite3/build/Release/better_sqlite3.node".to_string(),
    ] {
        let path = dir.join(&rel);
        let bytes = format!("synthetic content for {}", rel);
        write_attested(dir, &rel, bytes.as_bytes());
        let size = fs::metadata(&path).unwrap().len();
        files.insert(
            rel,
            sidecar::AttestedFile {
                sha256: sidecar::sha256_hex(&path).expect("sha256"),
                size_bytes: size,
            },
        );
    }
    files
}

fn v2_manifest(
    _dir: &std::path::Path,
    files: &BTreeMap<String, sidecar::AttestedFile>,
) -> SidecarManifest {
    SidecarManifest {
        schema_version: 2,
        runtime: Some("node".into()),
        binary_name: sidecar_binary_name().to_string(),
        entry: Some("cli.js".into()),
        worker: Some("composition-worker.js".into()),
        build_version: "0.1.0-test.9".into(),
        package_version: "0.2.0".into(),
        target: if cfg!(target_os = "windows") {
            "win32"
        } else {
            "unix"
        }
        .into(),
        files: files.clone(),
        ..Default::default()
    }
}

#[test]
fn v2_node_manifest_verifies_all_attested_files() {
    let temp = tempfile::tempdir().expect("tempdir");
    let dir = temp.path();
    let files = v2_files(dir);
    write_manifest(dir, &v2_manifest(dir, &files));
    match verify_sidecar(dir) {
        SidecarIntegrity::Ok { version } => assert_eq!(version, "0.1.0-test.9"),
        other => panic!("expected Ok, got {:?}", other),
    }
}

#[test]
fn v2_tampered_addon_is_invalid() {
    let temp = tempfile::tempdir().expect("tempdir");
    let dir = temp.path();
    let files = v2_files(dir);
    write_manifest(dir, &v2_manifest(dir, &files));
    write_attested(
        dir,
        "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
        b"tampered",
    );
    match verify_sidecar(dir) {
        SidecarIntegrity::Invalid(reason) => {
            assert!(reason.contains("file_hash_mismatch") || reason.contains("file_size_mismatch"))
        }
        other => panic!("expected Invalid, got {:?}", other),
    }
}

#[test]
fn v2_missing_attested_file_is_missing() {
    let temp = tempfile::tempdir().expect("tempdir");
    let dir = temp.path();
    let files = v2_files(dir);
    write_manifest(dir, &v2_manifest(dir, &files));
    fs::remove_file(dir.join("composition-worker.js")).expect("remove");
    match verify_sidecar(dir) {
        SidecarIntegrity::Missing(reason) => assert!(reason.contains("composition-worker.js")),
        other => panic!("expected Missing, got {:?}", other),
    }
}

#[test]
fn v2_traversal_attested_name_is_rejected() {
    let temp = tempfile::tempdir().expect("tempdir");
    let dir = temp.path();
    let files = v2_files(dir);
    let mut manifest = v2_manifest(dir, &files);
    manifest.files.insert(
        "../escape.js".to_string(),
        sidecar::AttestedFile {
            sha256: "a".repeat(64),
            size_bytes: 10,
        },
    );
    write_manifest(dir, &manifest);
    match verify_sidecar(dir) {
        SidecarIntegrity::Missing(reason) => assert_eq!(reason, "manifest_file_name_invalid"),
        other => panic!("expected Missing, got {:?}", other),
    }
}

#[test]
fn v2_unattested_entry_is_rejected() {
    let temp = tempfile::tempdir().expect("tempdir");
    let dir = temp.path();
    let mut files = v2_files(dir);
    files.remove("cli.js");
    let mut manifest = v2_manifest(dir, &files);
    manifest.files = files;
    write_manifest(dir, &manifest);
    match verify_sidecar(dir) {
        SidecarIntegrity::Missing(reason) => assert_eq!(reason, "manifest_entry_not_attested"),
        other => panic!("expected Missing, got {:?}", other),
    }
}

#[test]
fn v2_manifest_rejects_arbitrary_runtime() {
    let temp = tempfile::tempdir().expect("tempdir");
    let dir = temp.path();
    let files = v2_files(dir);
    let mut manifest = v2_manifest(dir, &files);
    manifest.runtime = Some("deno".into());
    write_manifest(dir, &manifest);
    match verify_sidecar(dir) {
        SidecarIntegrity::Missing(reason) => assert_eq!(reason, "manifest_runtime_invalid"),
        other => panic!("expected Missing, got {:?}", other),
    }
}
