//! Canonical model/provider page validators, reused without policy changes.
//! Origin: quimera/tauri/src/bridge.rs; full source SHA256 636c0bcef5bcb3e4e31df0f0d6d0afabeb5f86c4486de32797ca9a90133dd352.
//! Only function visibility and module placement differ; tests are copied verbatim.

pub(super) fn verified_provider_portal(provider_id: &str) -> Result<tauri::Url, String> {
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

pub(super) fn verified_model_page_url(value: &str) -> Result<tauri::Url, String> {
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

#[cfg(test)]
mod tests {
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
