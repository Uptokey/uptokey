use serde_json::Value;
use std::collections::BTreeSet;

const REQUIRED_CAPABILITIES: [&str; 18] = [
    "account",
    "subscription_catalog",
    "local_models",
    "hosted_models",
    "byok",
    "files",
    "projects",
    "public_api",
    "mcp_tools",
    "approved_context_snapshot",
    "sessions",
    "encrypted_workspace",
    "encrypted_export",
    "notifications",
    "theme",
    "legacy_session_recovery",
    "runtime_supervision",
    "diagnostics",
];

fn object<'a>(
    value: &'a Value,
    key: &str,
) -> Result<&'a serde_json::Map<String, Value>, &'static str> {
    value
        .get(key)
        .and_then(Value::as_object)
        .ok_or("product-contract-invalid")
}

fn exact_keys(object: &serde_json::Map<String, Value>, expected: &[&str]) -> bool {
    object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
}

fn exact_strings(value: &Value, expected: &[&str]) -> bool {
    let Some(values) = value.as_array() else {
        return false;
    };
    let actual: BTreeSet<_> = values.iter().filter_map(Value::as_str).collect();
    actual.len() == values.len() && actual == expected.iter().copied().collect()
}

fn contains_credential(value: &Value) -> bool {
    match value {
        Value::String(value) => {
            value.starts_with("utk_local_")
                || value.starts_with("sk-")
                || value.starts_with("Bearer ")
        }
        Value::Array(values) => values.iter().any(contains_credential),
        Value::Object(values) => values.values().any(contains_credential),
        _ => false,
    }
}

pub fn validate(value: &Value) -> Result<(), &'static str> {
    let root = value.as_object().ok_or("product-contract-invalid")?;
    if !exact_keys(
        root,
        &[
            "schemaVersion",
            "product",
            "nativeHost",
            "packaging",
            "proxy",
            "secrets",
            "privacy",
            "capabilities",
            "platformStatus",
            "live",
        ],
    ) || value.get("schemaVersion").and_then(Value::as_u64) != Some(1)
        || value.get("product").and_then(Value::as_str) != Some("uptokey")
        || contains_credential(value)
    {
        return Err("product-contract-invalid");
    }

    let host = object(value, "nativeHost")?;
    if !exact_keys(host, &["runtime", "framework", "platforms"])
        || host.get("runtime").and_then(Value::as_str) != Some("rust")
        || host.get("framework").and_then(Value::as_str) != Some("tauri")
        || !exact_strings(
            host.get("platforms").ok_or("product-contract-invalid")?,
            &["windows", "linux", "macos"],
        )
    {
        return Err("product-contract-invalid");
    }

    let packaging = object(value, "packaging")?;
    if !exact_keys(
        packaging,
        &[
            "owner",
            "bundleActive",
            "attestedSidecar",
            "windows",
            "linux",
            "macos",
            "ciWindows",
            "ciLinux",
            "ciMacos",
        ],
    ) || packaging.get("owner").and_then(Value::as_str) != Some("quimera/tauri")
        || [
            "bundleActive",
            "attestedSidecar",
            "windows",
            "linux",
            "macos",
            "ciWindows",
            "ciLinux",
            "ciMacos",
        ]
        .iter()
        .any(|key| packaging.get(*key).and_then(Value::as_bool) != Some(true))
    {
        return Err("product-contract-invalid");
    }

    let proxy = object(value, "proxy")?;
    if !exact_keys(proxy, &["owner", "endpoint", "loopback", "keyResolution"])
        || proxy.get("owner").and_then(Value::as_str) != Some("uptokey-core")
        || proxy.get("endpoint").and_then(Value::as_str) != Some("http://127.0.0.1:21435")
        || proxy.get("loopback").and_then(Value::as_bool) != Some(true)
        || proxy.get("keyResolution").and_then(Value::as_str) != Some("core-only")
    {
        return Err("product-contract-invalid");
    }

    let secrets = object(value, "secrets")?;
    if !exact_keys(
        secrets,
        &[
            "custody",
            "visibleToHarness",
            "persistedByHarness",
            "exportedByHarness",
        ],
    ) || secrets.get("custody").and_then(Value::as_str) != Some("operating-system-native-vault")
        || [
            "visibleToHarness",
            "persistedByHarness",
            "exportedByHarness",
        ]
        .iter()
        .any(|key| secrets.get(*key).and_then(Value::as_bool) != Some(false))
    {
        return Err("product-contract-invalid");
    }

    let privacy = object(value, "privacy")?;
    if !exact_keys(
        privacy,
        &[
            "localKeyKnowledge",
            "controlPlaneKeyRetention",
            "remoteProviderReceivesInferenceContent",
            "globalZeroKnowledge",
        ],
    ) || privacy.get("localKeyKnowledge").and_then(Value::as_str) != Some("core-only")
        || privacy
            .get("controlPlaneKeyRetention")
            .and_then(Value::as_bool)
            != Some(false)
        || privacy
            .get("remoteProviderReceivesInferenceContent")
            .and_then(Value::as_bool)
            != Some(true)
        || privacy.get("globalZeroKnowledge").and_then(Value::as_bool) != Some(false)
    {
        return Err("product-contract-invalid");
    }

    if !exact_strings(
        value
            .get("capabilities")
            .ok_or("product-contract-invalid")?,
        &REQUIRED_CAPABILITIES,
    ) {
        return Err("product-contract-invalid");
    }
    let platforms = object(value, "platformStatus")?;
    if !exact_keys(platforms, &["windows", "linux", "macos"])
        || platforms.values().any(|item| {
            !matches!(
                item.as_str(),
                Some(
                    "acceptance-pending"
                        | "current-host-verified"
                        | "native-acceptance-reused"
                        | "source-compatible-host-acceptance-pending"
                )
            )
        })
    {
        return Err("product-contract-invalid");
    }

    let live = object(value, "live")?;
    if !exact_keys(
        live,
        &[
            "coreReachable",
            "bridgeReachable",
            "controllerRunning",
            "executorRunning",
            "modelCount",
            "connectionCount",
            "accountState",
        ],
    ) || [
        "coreReachable",
        "bridgeReachable",
        "controllerRunning",
        "executorRunning",
    ]
    .iter()
    .any(|key| live.get(*key).and_then(Value::as_bool) != Some(true))
        || live.get("modelCount").and_then(Value::as_u64).is_none()
        || live
            .get("connectionCount")
            .and_then(Value::as_u64)
            .is_none()
        || !matches!(
            live.get("accountState").and_then(Value::as_str),
            // AccountPublicSession uses connected/connecting/unavailable. Keep
            // legacy projections readable; this status never grants admission.
            Some(
                "signed_out"
                    | "connecting"
                    | "connected"
                    | "unavailable"
                    | "authenticated"
                    | "retrying"
            )
        )
    {
        return Err("product-contract-unavailable");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        serde_json::json!({
            "schemaVersion":1,"product":"uptokey",
            "nativeHost":{"runtime":"rust","framework":"tauri","platforms":["windows","linux","macos"]},
            "packaging":{"owner":"quimera/tauri","bundleActive":true,"attestedSidecar":true,"windows":true,"linux":true,"macos":true,"ciWindows":true,"ciLinux":true,"ciMacos":true},
            "proxy":{"owner":"uptokey-core","endpoint":"http://127.0.0.1:21435","loopback":true,"keyResolution":"core-only"},
            "secrets":{"custody":"operating-system-native-vault","visibleToHarness":false,"persistedByHarness":false,"exportedByHarness":false},
            "privacy":{"localKeyKnowledge":"core-only","controlPlaneKeyRetention":false,"remoteProviderReceivesInferenceContent":true,"globalZeroKnowledge":false},
            "capabilities":REQUIRED_CAPABILITIES,
            "platformStatus":{"windows":"current-host-verified","linux":"native-acceptance-reused","macos":"source-compatible-host-acceptance-pending"},
            "live":{"coreReachable":true,"bridgeReachable":true,"controllerRunning":true,"executorRunning":true,"modelCount":6,"connectionCount":1,"accountState":"signed_out"}
        })
    }
    #[test]
    fn accepts_unverified_platforms_without_claiming_acceptance() {
        let mut value = fixture();
        for platform in ["windows", "linux", "macos"] {
            value["platformStatus"][platform] = Value::String("acceptance-pending".into());
        }
        assert_eq!(validate(&value), Ok(()));
    }
    #[test]
    fn accepts_complete_contract() {
        assert_eq!(validate(&fixture()), Ok(()))
    }
    #[test]
    fn canonical_account_states_do_not_prevent_startup_or_bypass_core_health() {
        for state in [
            "signed_out",
            "connecting",
            "connected",
            "unavailable",
            "authenticated",
            "retrying",
        ] {
            let mut value = fixture();
            value["live"]["accountState"] = Value::String(state.into());
            assert_eq!(validate(&value), Ok(()), "{state}");
            value["live"]["coreReachable"] = Value::Bool(false);
            assert_eq!(
                validate(&value),
                Err("product-contract-unavailable"),
                "{state}"
            );
        }
        for state in [
            serde_json::json!("unknown"),
            serde_json::json!(true),
            serde_json::Value::Null,
        ] {
            let mut value = fixture();
            value["live"]["accountState"] = state;
            assert_eq!(validate(&value), Err("product-contract-unavailable"));
        }
    }
    #[test]
    fn rejects_global_zero_knowledge_claim() {
        let mut value = fixture();
        value["privacy"]["globalZeroKnowledge"] = Value::Bool(true);
        assert_eq!(validate(&value), Err("product-contract-invalid"))
    }
    #[test]
    fn rejects_secret_material() {
        let mut value = fixture();
        value["live"]["accountState"] = Value::String("utk_local_credential".into());
        assert_eq!(validate(&value), Err("product-contract-invalid"))
    }
    #[test]
    fn rejects_missing_legacy_capability() {
        let mut value = fixture();
        value["capabilities"]
            .as_array_mut()
            .unwrap()
            .retain(|item| item != "legacy_session_recovery");
        assert_eq!(validate(&value), Err("product-contract-invalid"))
    }
    #[test]
    fn rejects_unreachable_core() {
        let mut value = fixture();
        value["live"]["coreReachable"] = Value::Bool(false);
        assert_eq!(validate(&value), Err("product-contract-unavailable"))
    }
}
