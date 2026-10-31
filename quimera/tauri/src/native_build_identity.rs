//! Read-only native identity, deliberately separate from the core updater.
pub const COMMAND: &str = "--native-build-identity";
pub const SCHEMA: &str = "uptokey-native-build-identity-v1";

pub fn valid_source_commit(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

/// None continues normal startup. Every identity-related malformed invocation exits.
pub fn dispatch(args: &[String]) -> Option<Result<String, &'static str>> {
    if !args.iter().any(|arg| arg.contains("build-identity")) {
        return None;
    }
    if args.len() != 1 || args[0] != COMMAND {
        return Some(Err("native_build_identity_arguments_invalid"));
    }
    Some(identity(option_env!("UPTOKEY_RELEASE_SOURCE_COMMIT")))
}

fn identity(commit: Option<&str>) -> Result<String, &'static str> {
    let commit = commit
        .filter(|value| valid_source_commit(value))
        .ok_or("native_build_identity_source_commit_missing_or_invalid")?;
    Ok(serde_json::json!({
        "schema": SCHEMA,
        "product": "uptokey-tauri",
        "version": env!("CARGO_PKG_VERSION"),
        "defaultInterface": if cfg!(feature = "harness-entry") { "Harness" } else { "shell" },
        "target": { "os": std::env::consts::OS, "arch": std::env::consts::ARCH },
        "sourceCommit": commit,
    })
    .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commit_is_exact_lowercase_sha40() {
        assert!(valid_source_commit(&"a1".repeat(20)));
        for value in [
            "",
            &"a".repeat(39),
            &"a".repeat(41),
            &"A".repeat(40),
            &"g".repeat(40),
        ] {
            assert!(!valid_source_commit(value));
        }
    }

    #[test]
    fn missing_or_invalid_commit_fails_closed() {
        assert!(identity(None).is_err());
        assert!(identity(Some("invalid")).is_err());
        let value: serde_json::Value =
            serde_json::from_str(&identity(Some(&"a".repeat(40))).unwrap()).unwrap();
        assert_eq!(value["schema"], SCHEMA);
        assert_eq!(value["product"], "uptokey-tauri");
        assert_eq!(value["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(
            value["defaultInterface"],
            if cfg!(feature = "harness-entry") {
                "Harness"
            } else {
                "shell"
            }
        );
        assert_eq!(value["target"]["os"], std::env::consts::OS);
        assert_eq!(value["target"]["arch"], std::env::consts::ARCH);
        assert_eq!(value["sourceCommit"], "a".repeat(40));
        assert_eq!(value.as_object().unwrap().len(), 6);
    }

    #[test]
    fn mixed_or_malformed_identity_never_continues_startup() {
        for args in [
            vec![COMMAND, "--harness"],
            vec!["--help", COMMAND],
            vec![COMMAND, COMMAND],
            vec!["--native-build-identity=true"],
            vec!["native-build-identity"],
            vec!["build-identity"],
        ] {
            assert!(
                dispatch(&args.into_iter().map(String::from).collect::<Vec<_>>())
                    .unwrap()
                    .is_err()
            );
        }
        assert!(dispatch(&[]).is_none());
        assert!(dispatch(&["--harness".into()]).is_none());
        assert!(dispatch(&[COMMAND.into()]).is_some());
    }
}
