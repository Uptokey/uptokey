//! Compile-time Harness overlay, shared by the build script and its tests.
use serde_json::Value;

fn merge(target: &mut Value, patch: Value) {
    if let Value::Object(patch) = patch {
        if !target.is_object() {
            *target = serde_json::json!({});
        }
        let target = target.as_object_mut().unwrap();
        for (key, value) in patch {
            if value.is_null() {
                target.remove(&key);
            } else {
                merge(target.entry(key).or_insert(Value::Null), value);
            }
        }
    } else {
        *target = patch;
    }
}

pub fn overlay(harness: &str, incoming: Option<&str>) -> Result<String, &'static str> {
    let canonical: Value =
        serde_json::from_str(harness).map_err(|_| "harness_build_config_invalid")?;
    if !canonical.is_object() {
        return Err("harness_build_config_invalid");
    }
    let mut effective = canonical.clone();
    if let Some(raw) = incoming {
        let patch: Value = serde_json::from_str(raw).map_err(|_| "harness_build_config_invalid")?;
        if !patch.is_object() {
            return Err("harness_build_config_invalid");
        }
        merge(&mut effective, patch);
    }
    // Preserve CLI packaging adjustments (resources, NSIS and platforms), while
    // selecting Harness assets and the narrow Harness capabilities reliably.
    for (group, key) in [
        ("build", "frontendDist"),
        ("build", "devUrl"),
        ("app", "windows"),
        ("app", "withGlobalTauri"),
    ] {
        let value = canonical[group]
            .get(key)
            .ok_or("harness_build_config_invalid")?
            .clone();
        if !effective[group].is_object() {
            effective[group] = serde_json::json!({});
        }
        effective[group][key] = value;
    }
    effective["app"]["security"] = effective["app"]
        .get("security")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    effective["app"]["security"]["capabilities"] = canonical["app"]["security"]
        .get("capabilities")
        .ok_or("harness_build_config_invalid")?
        .clone();
    serde_json::to_string(&effective).map_err(|_| "harness_build_config_invalid")
}

#[cfg(test)]
mod tests {
    use super::*;
    const HARNESS: &str = include_str!("../tauri.harness.conf.json");

    #[test]
    fn direct_cargo_build_selects_harness_assets_and_capabilities() {
        let value: Value = serde_json::from_str(&overlay(HARNESS, None).unwrap()).unwrap();
        assert_eq!(value["app"]["windows"], serde_json::json!([]));
        assert_eq!(value["app"]["withGlobalTauri"], false);
        assert_eq!(
            value["build"]["frontendDist"],
            "../../experiments/deepseek-workbench/desktop/assets"
        );
        assert!(value["build"]["devUrl"].is_null());
        assert!(value["app"]["security"]["capabilities"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("harness-account")));
    }

    #[test]
    fn cli_packaging_changes_survive_but_cannot_restore_legacy_ui_or_acl() {
        let incoming = serde_json::json!({"bundle":{"resources":["private-staging/"],"windows":{"nsis":{"installMode":"currentUser"}}},"app":{"windows":[{"label":"main"}],"withGlobalTauri":true,"security":{"capabilities":["default"]}},"build":{"frontendDist":"legacy-pwa","devUrl":"http://localhost:5273"}});
        let value: Value =
            serde_json::from_str(&overlay(HARNESS, Some(&incoming.to_string())).unwrap()).unwrap();
        assert_eq!(
            value["bundle"]["resources"],
            incoming["bundle"]["resources"]
        );
        assert_eq!(
            value["bundle"]["windows"]["nsis"]["installMode"],
            "currentUser"
        );
        assert_eq!(value["app"]["windows"], serde_json::json!([]));
        assert_eq!(value["app"]["withGlobalTauri"], false);
        assert!(!value["app"]["security"]["capabilities"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("default")));
        assert_ne!(value["build"]["frontendDist"], "legacy-pwa");
        assert!(value["build"]["devUrl"].is_null());
    }

    #[test]
    fn malformed_or_nonobject_build_configuration_fails_closed() {
        for incoming in ["broken", "null", "[]"] {
            assert!(overlay(HARNESS, Some(incoming)).is_err());
        }
        assert!(overlay("{}", None).is_err());
    }

    #[cfg(feature = "harness-entry")]
    #[test]
    fn compiled_context_has_harness_windows_assets_and_capabilities() {
        let context: tauri::Context<tauri::Wry> =
            tauri::generate_context!("tauri.harness.conf.json");
        let value = serde_json::to_value(context.config()).unwrap();
        assert_eq!(value["app"]["windows"], serde_json::json!([]));
        assert_eq!(value["app"]["withGlobalTauri"], false);
        assert!(value["app"]["security"]["capabilities"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("harness-account")));
        assert!(context.assets().get(&"index.html".into()).is_some());
        assert!(context.assets().get(&"recovery.html".into()).is_some());
        assert!(context.assets().get(&"stopped.html".into()).is_some());
    }
}
