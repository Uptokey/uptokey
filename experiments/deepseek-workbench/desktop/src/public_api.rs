// Retain the receipt of a saved API until the original client is mounted.
// Availability is checked against the live MCP tools by the client bridge.
pub const INITIALIZATION_SCRIPT: &str = r#"(function(){'use strict';const pending=new Map();let sequence=0;const id=/^[a-z][a-z0-9-]{0,31}$/,hash=/^[a-f0-9]{64}$/;Object.defineProperty(window,'UptokeyHarnessPublicApis',{value:Object.freeze({enqueue(value){if(!value||!id.test(value.apiId??'')||!hash.test(value.schemaSha256??'')||!Number.isSafeInteger(value.operations)||value.operations<1||(!pending.has(value.apiId)&&pending.size>=32))return false;const request=Object.freeze({apiId:value.apiId,schemaSha256:value.schemaSha256,operations:value.operations,requestId:'api_'+(++sequence)});pending.set(request.apiId,request);window.dispatchEvent(new Event('uptokey:public-api-queued'));return true;},take(){const requests=Array.from(pending.values());pending.clear();return requests;}})});})();"#;

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicApiImport {
    pub api_id: String,
    pub schema_sha256: String,
    pub operations: usize,
}

#[derive(Default)]
pub struct Delivery {
    sequence: std::sync::atomic::AtomicU64,
    pending: std::sync::Mutex<Option<(String, std::sync::mpsc::Sender<bool>)>>,
}
impl Delivery {
    pub fn begin(&self) -> Result<(String, std::sync::mpsc::Receiver<bool>), &'static str> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "api-delivery-unavailable")?;
        if pending.is_some() {
            return Err("api-delivery-busy");
        }
        let id = format!(
            "delivery_{}",
            self.sequence
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let (sender, receiver) = std::sync::mpsc::channel();
        *pending = Some((id.clone(), sender));
        Ok((id, receiver))
    }
    pub fn acknowledge(&self, id: &str, queued: bool) -> bool {
        let Ok(mut pending) = self.pending.lock() else {
            return false;
        };
        if !pending.as_ref().is_some_and(|(expected, _)| expected == id) {
            return false;
        }
        let Some((_, sender)) = pending.take() else {
            return false;
        };
        sender.send(queued).is_ok()
    }
    pub fn cancel(&self, id: &str) {
        if let Ok(mut pending) = self.pending.lock() {
            if pending.as_ref().is_some_and(|(expected, _)| expected == id) {
                *pending = None;
            }
        }
    }
}

#[tauri::command]
pub fn harness_public_api_queued(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Delivery>,
    request_id: String,
    queued: bool,
) -> Result<(), &'static str> {
    if window.label() != "workbench"
        || !window
            .url()
            .is_ok_and(|url| crate::local_origin(&url) && url.path() == "/")
        || request_id.len() > 64
        || !request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err("api-delivery-denied");
    }
    if !state.acknowledge(&request_id, queued) {
        return Err("api-delivery-expired");
    };
    Ok(())
}

pub fn delivery_script(receipt: &PublicApiImport, id: &str) -> Result<String, &'static str> {
    let receipt = serde_json::to_string(receipt).map_err(|_| "api-registration-invalid")?;
    let id = serde_json::to_string(id).map_err(|_| "api-registration-invalid")?;
    Ok(format!(
        r#"(()=>{{let queued=false;try{{queued=window.UptokeyHarnessPublicApis?.enqueue({receipt})===true;}}catch{{}}if(typeof window.__TAURI_INTERNALS__?.invoke==='function')void window.__TAURI_INTERNALS__.invoke('harness_public_api_queued',{{requestId:{id},queued}}).catch(()=>{{}});}})();"#
    ))
}

pub fn imported_api(receipt: &serde_json::Value) -> Result<PublicApiImport, &'static str> {
    let id = receipt
        .get("apiId")
        .and_then(|value| value.as_str())
        .ok_or("api-registration-invalid")?;
    let hash = receipt
        .get("schemaSha256")
        .and_then(|value| value.as_str())
        .ok_or("api-registration-invalid")?;
    let operations = receipt
        .get("operations")
        .and_then(|value| value.as_u64())
        .and_then(|n| usize::try_from(n).ok())
        .filter(|n| *n > 0)
        .ok_or("api-registration-invalid")?;
    if !id.starts_with("api-")
        || id.len() > 32
        || !id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || receipt.get("registered").and_then(|value| value.as_str())
            != Some(format!("uptokey-api-{id}").as_str())
        || hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("api-registration-invalid");
    }
    Ok(PublicApiImport {
        api_id: id.to_owned(),
        schema_sha256: hash.to_owned(),
        operations,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn receipt() -> serde_json::Value {
        serde_json::json!({"registered":"uptokey-api-api-example-com-12345678","apiId":"api-example-com-12345678","schemaSha256":"a".repeat(64),"operations":2})
    }
    #[test]
    fn preserves_exact_api_receipt_for_readiness_not_success() {
        let value = imported_api(&receipt()).unwrap();
        assert_eq!(value.operations, 2);
        assert_eq!(
            serde_json::to_value(value).unwrap(),
            serde_json::json!({"apiId":"api-example-com-12345678","schemaSha256":"a".repeat(64),"operations":2})
        );
    }
    #[test]
    fn rejects_mismatched_or_injectable_api_receipts() {
        for (key, value) in [
            ("apiId", serde_json::json!("api-../../other")),
            (
                "apiId",
                serde_json::json!("api-".to_owned() + &"a".repeat(29)),
            ),
            ("registered", serde_json::json!("uptokey-api-other")),
            ("schemaSha256", serde_json::json!("A".repeat(64))),
            ("schemaSha256", serde_json::json!("a".repeat(63))),
            ("operations", serde_json::json!(0)),
            ("operations", serde_json::json!(1.5)),
        ] {
            let mut receipt = receipt();
            receipt[key] = value;
            assert!(imported_api(&receipt).is_err());
        }
    }
    #[test]
    fn delivery_ack_is_single_use_exact_and_does_not_turn_rejection_into_success() {
        let state = Delivery::default();
        let (id, receiver) = state.begin().unwrap();
        assert!(state.begin().is_err());
        assert!(!state.acknowledge("wrong", true));
        assert!(state.acknowledge(&id, false));
        assert!(!receiver.recv().unwrap());
        assert!(!state.acknowledge(&id, true));
        let (next, next_receiver) = state.begin().unwrap();
        assert_ne!(id, next);
        state.cancel(&id);
        assert!(state.acknowledge(&next, true));
        assert!(next_receiver.recv().unwrap());
        let (last, last_receiver) = state.begin().unwrap();
        state.cancel(&last);
        assert!(last_receiver.recv().is_err());
    }
}
