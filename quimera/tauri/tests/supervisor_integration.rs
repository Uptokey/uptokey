//! Integration tests for sidecar verification and supervisor behavior.

use std::fs::{self, File};
use std::io::Write;
use tempfile::tempdir;

use uptokey_tauri_lib::sidecar::{self, sidecar_binary_name, verify_sidecar, SidecarIntegrity};

fn create_dummy_binary(dir: &std::path::Path) -> std::path::PathBuf {
    let bin_name = sidecar_binary_name();
    let bin_path = dir.join(bin_name);
    let mut file = File::create(&bin_path).expect("create dummy binary");
    // Write simple contents.
    write!(file, "dummy binary content").expect("write dummy");
    // Ensure file is flushed.
    file.flush().expect("flush");
    bin_path
}

fn write_manifest(dir: &std::path::Path, size: u64, sha256: &str) {
    let manifest = sidecar::SidecarManifest {
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
        sha256: sha256.to_string(),
        size_bytes: size,
        ..Default::default()
    };
    let manifest_path = dir.join("manifest.json");
    let json = serde_json::to_string_pretty(&manifest).expect("serialize manifest");
    fs::write(&manifest_path, json).expect("write manifest");
}

#[test]
fn test_verify_sidecar_valid() {
    let temp = tempdir().expect("tempdir");
    let sidecar_dir = temp.path();
    // Create dummy binary.
    let bin_path = create_dummy_binary(sidecar_dir);
    let size = fs::metadata(&bin_path).unwrap().len();
    let sha = sidecar::sha256_hex(&bin_path).expect("sha256");
    // Write manifest that matches.
    write_manifest(sidecar_dir, size, &sha);
    // Verify.
    match verify_sidecar(sidecar_dir) {
        SidecarIntegrity::Ok { version } => {
            assert_eq!(version, "0.0.0-test");
        }
        other => panic!("expected Ok, got {:?}", other),
    }
}

#[test]
fn test_verify_sidecar_missing_binary() {
    let temp = tempdir().expect("tempdir");
    let sidecar_dir = temp.path();
    // No binary, but write a manifest with expected size/hash of empty file.
    let dummy_bin_name = sidecar_binary_name();
    let dummy_path = sidecar_dir.join(dummy_bin_name);
    // Create empty file to get size 0 and hash of empty.
    File::create(&dummy_path).expect("create empty");
    let size = 0u64;
    let sha = sidecar::sha256_hex(&dummy_path).expect("sha256 empty");
    write_manifest(sidecar_dir, size, &sha);
    // Remove the binary to simulate missing.
    fs::remove_file(&dummy_path).expect("remove binary");
    match verify_sidecar(sidecar_dir) {
        SidecarIntegrity::Missing(_msg) => {}
        other => panic!("expected Missing, got {:?}", other),
    }
}

#[test]
fn test_verify_sidecar_invalid_hash() {
    let temp = tempdir().expect("tempdir");
    let sidecar_dir = temp.path();
    let bin_path = create_dummy_binary(sidecar_dir);
    let size = fs::metadata(&bin_path).unwrap().len();
    // Intentionally wrong hash.
    let wrong_hash = "0".repeat(64);
    write_manifest(sidecar_dir, size, &wrong_hash);
    match verify_sidecar(sidecar_dir) {
        SidecarIntegrity::Invalid(_msg) => {}
        other => panic!("expected Invalid, got {:?}", other),
    }
}

/// When the canonical sidecar is prepared on this runner, its real manifest
/// (schema 1 or 2) must pass the same Rust verification the supervisor uses.
/// Hermetic: silently skips when no sidecar is prepared.
#[test]
fn real_prepared_sidecar_passes_rust_verification_when_present() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("sidecar");
    if !dir.join("manifest.json").exists() {
        return;
    }
    match verify_sidecar(&dir) {
        SidecarIntegrity::Ok { .. } => {}
        other => panic!("prepared sidecar failed verification: {:?}", other),
    }
}
