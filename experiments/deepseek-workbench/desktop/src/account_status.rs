//! Safe CLI projection of the same canonical status response used by the avatar.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// Selected public fields and state vocabulary from
// proxy/core/src/account-login-protocol.ts: AccountPublicSession.
// The existing Node transport applies readAccountPublicSession before this
// projection. Do not forward its optional profile or any other response data.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountStatus {
    configured: bool,
    authenticated: bool,
    login_available: bool,
    state: AccountState,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum AccountState {
    SignedOut,
    Connecting,
    Connected,
    Unavailable,
}

fn project(mut receipt: Value) -> Result<Value, &'static str> {
    let envelope = receipt.as_object_mut().ok_or("account_response_invalid")?;
    if envelope.len() != 2 || !envelope.contains_key("body") {
        return Err("account_response_invalid");
    }
    let status = envelope.get("status").and_then(Value::as_u64)
        .filter(|status| (100..=599).contains(status)).ok_or("account_response_invalid")?;
    if status != 200 { return Err("account_unavailable"); }
    let summary: AccountStatus = serde_json::from_value(envelope.remove("body").unwrap())
        .map_err(|_| "account_response_invalid")?;
    let connected = matches!(summary.state, AccountState::Connected);
    if summary.authenticated != connected || summary.authenticated && !summary.configured {
        return Err("account_response_invalid");
    }
    serde_json::to_value(summary).map_err(|_| "account_response_invalid")
}

pub fn read_status(
    request: impl FnOnce(&str, Value) -> Result<Value, &'static str>,
) -> Result<Value, &'static str> {
    project(request("status", json!({}))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(state: &str) -> Value {
        json!({"configured":true,"authenticated":state=="connected","loginAvailable":true,"state":state})
    }

    #[test]
    fn account_status_uses_only_canonical_status_and_filters_private_response_data() {
        let result = read_status(|path, input| {
            assert_eq!(path, "status");
            assert_eq!(input, json!({}));
            let mut session = body("connected");
            session["profile"] = json!({"displayName":"synthetic-private-name","email":"synthetic@example.invalid"});
            session["loginUrl"] = json!("https://example.invalid/private");
            session["token"] = json!("synthetic-private-token");
            session["requiresSignIn"] = json!(false);
            Ok(json!({"status":200,"body":session}))
        }).unwrap();
        assert_eq!(result, body("connected"));
        assert_eq!(result.as_object().unwrap().len(), 4);
        let printed = result.to_string();
        for private in ["profile", "synthetic", "loginUrl", "token", "requiresSignIn"] {
            assert!(!printed.contains(private));
        }
    }

    #[test]
    fn account_status_preserves_canonical_states_without_fabricating_availability() {
        for state in ["signed_out", "connecting", "connected", "unavailable"] {
            let session = body(state);
            assert_eq!(project(json!({"status":200,"body":session.clone()})).unwrap(), session);
        }
        let session = json!({"configured":false,"authenticated":false,"loginAvailable":false,"state":"signed_out"});
        assert_eq!(project(json!({"status":200,"body":session.clone()})).unwrap(), session);
        assert_eq!(read_status(|_, _| Err("account_timeout")), Err("account_timeout"));
    }

    #[test]
    fn account_status_rejects_failed_or_malformed_transport_envelopes() {
        for status in [401, 403, 429, 503] {
            assert_eq!(project(json!({"status":status,"body":{"error":"synthetic-private-error"}})), Err("account_unavailable"));
        }
        for receipt in [
            Value::Null, json!([]), json!({}), json!({"body":body("signed_out")}),
            json!({"status":200}), json!({"status":"200","body":body("signed_out")}),
            json!({"status":200.0,"body":body("signed_out")}),
            json!({"status":600,"body":body("signed_out")}),
            json!({"status":200,"body":body("signed_out"),"token":"synthetic-private-token"}),
        ] {
            assert_eq!(project(receipt), Err("account_response_invalid"));
        }
    }

    #[test]
    fn account_status_rejects_invalid_public_fields_and_inconsistent_sessions() {
        for field in ["configured", "authenticated", "loginAvailable"] {
            for wrong in [Value::Null, json!("true"), json!(1)] {
                let mut session = body("signed_out"); session[field] = wrong;
                assert_eq!(project(json!({"status":200,"body":session})), Err("account_response_invalid"));
            }
            let mut session = body("signed_out"); session.as_object_mut().unwrap().remove(field);
            assert_eq!(project(json!({"status":200,"body":session})), Err("account_response_invalid"));
        }
        for session in [
            json!({"configured":true,"authenticated":false,"loginAvailable":true,"state":"future"}),
            json!({"configured":true,"authenticated":true,"loginAvailable":true,"state":"signed_out"}),
            json!({"configured":true,"authenticated":false,"loginAvailable":true,"state":"connected"}),
            json!({"configured":false,"authenticated":true,"loginAvailable":true,"state":"connected"}),
        ] {
            assert_eq!(project(json!({"status":200,"body":session})), Err("account_response_invalid"));
        }
    }
}
