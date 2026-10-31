//! Public account destinations. No credentials or account state are configured here.

#[cfg(test)]
pub const ACCOUNT_ORIGIN: &str = "https://app.uptokey.com";

#[cfg(test)]
pub fn service_origin(value: Option<&str>) -> Result<String, String> {
    let value = value.unwrap_or(ACCOUNT_ORIGIN);
    if value.len() > 2048 || value.bytes().any(|b| b <= 0x20 || b == 0x7f) {
        return Err("account_service_origin_invalid".into());
    }
    let url = tauri::Url::parse(value).map_err(|_| "account_service_origin_invalid")?;
    if url.origin().ascii_serialization() != value
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https"
            || url.scheme() == "http"
                && matches!(
                    url.host_str(),
                    Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
                ))
    {
        return Err("account_service_origin_invalid".into());
    }
    Ok(value.into())
}

pub fn subscription_url(value: &str) -> Result<tauri::Url, String> {
    let invalid = || "subscription_url_invalid".to_string();
    if value.len() > 8192 || value.bytes().any(|b| b <= 0x20 || b == 0x7f) {
        return Err(invalid());
    }
    let url = tauri::Url::parse(value).map_err(|_| invalid())?;
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid());
    }
    let id = |value: &str, prefix: &str| {
        value.strip_prefix(prefix).is_some_and(|part| {
            part.len() == 26
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
    };
    match url.host_str() {
        Some("uptokey.com") if url.path() == "/checkout" => {
            if value.len() > 4096 || url.fragment().is_some() {
                return Err(invalid());
            }
            let mut transactions = 0;
            let mut languages = 0;
            for (key, value) in url.query_pairs() {
                match key.as_ref() {
                    "_ptxn" if id(&value, "txn_") => transactions += 1,
                    "lang"
                        if matches!(
                            value.as_ref(),
                            "en" | "pt-BR"
                                | "es"
                                | "fr"
                                | "de"
                                | "it"
                                | "ja"
                                | "ko"
                                | "zh-CN"
                                | "ar"
                        ) =>
                    {
                        languages += 1
                    }
                    _ => return Err(invalid()),
                }
            }
            if transactions != 1 || languages > 1 {
                return Err(invalid());
            }
        }
        Some("customer-portal.paddle.com" | "sandbox-customer-portal.paddle.com")
            if id(url.path().strip_prefix('/').unwrap_or(""), "cpl_") =>
        {
            if value.len() > 4096 || url.fragment().is_some() {
                return Err(invalid());
            }
            let mut tokens = 0;
            for (key, value) in url.query_pairs() {
                if key != "token" || value.is_empty() || value.chars().any(char::is_control) {
                    return Err(invalid());
                }
                tokens += 1;
            }
            if tokens > 1 {
                return Err(invalid());
            }
        }
        Some("checkout.stripe.com") => {
            let session = url.path().strip_prefix("/c/pay/").unwrap_or("");
            let key = session
                .strip_prefix("cs_live_")
                .or_else(|| session.strip_prefix("cs_test_"));
            if !key.is_some_and(|part| {
                (10..=240).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_alphanumeric())
            }) || url.query().is_some()
                || url.as_str() != value
            {
                return Err(invalid());
            }
        }
        Some("billing.stripe.com") => {
            let session = url.path().strip_prefix("/p/session/").unwrap_or("");
            if value.len() > 4096
                || !(10..=1024).contains(&session.len())
                || !session
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
                || url.query().is_some()
                || url.fragment().is_some()
                || url.as_str() != value
            {
                return Err(invalid());
            }
        }
        _ => return Err(invalid()),
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_origin_defaults_without_secret_and_validates_explicit_override() {
        assert_eq!(service_origin(None).unwrap(), ACCOUNT_ORIGIN);
        assert_eq!(
            service_origin(Some("http://localhost:31316")).unwrap(),
            "http://localhost:31316"
        );
        for bad in [
            "",
            " https://app.uptokey.com",
            "http://example.com",
            "https://app.uptokey.com/path",
            "https://app.uptokey.com?token=x",
            "https://user@app.uptokey.com",
        ] {
            assert!(service_origin(Some(bad)).is_err(), "{bad}");
        }
    }

    #[test]
    fn subscription_opener_preserves_verified_checkout_locale_and_portal() {
        let transaction = "txn_aaaaaaaaaaaaaaaaaaaaaaaaaa";
        for lang in [
            "en", "pt-BR", "es", "fr", "de", "it", "ja", "ko", "zh-CN", "ar",
        ] {
            let url = format!("https://uptokey.com/checkout?_ptxn={transaction}&lang={lang}");
            assert_eq!(subscription_url(&url).unwrap().as_str(), url);
        }
        for host in [
            "customer-portal.paddle.com",
            "sandbox-customer-portal.paddle.com",
        ] {
            let url =
                format!("https://{host}/cpl_bbbbbbbbbbbbbbbbbbbbbbbbbb?token=fixture.signature");
            assert_eq!(subscription_url(&url).unwrap().as_str(), url);
        }
    }

    #[test]
    fn subscription_opener_preserves_stripe_hosted_urls_without_modification() {
        for mode in ["live", "test"] {
            for fragment in ["", "#fidFixture%2Fopaque%2Bpayload"] {
                let url =
                    format!("https://checkout.stripe.com/c/pay/cs_{mode}_a1234567890BcD{fragment}");
                assert_eq!(subscription_url(&url).unwrap().as_str(), url);
            }
        }
        for session in ["a1234567890BcD", "test_a1234567890BcD"] {
            let url = format!("https://billing.stripe.com/p/session/{session}");
            assert_eq!(subscription_url(&url).unwrap().as_str(), url);
        }
    }

    #[test]
    fn subscription_opener_rejects_unbound_stripe_destinations() {
        for bad in [
            "https://checkout.stripe.com.evil.test/c/pay/cs_live_a1234567890",
            "https://user@checkout.stripe.com/c/pay/cs_live_a1234567890",
            "https://checkout.stripe.com:444/c/pay/cs_live_a1234567890",
            "https://checkout.stripe.com:443/c/pay/cs_live_a1234567890",
            "http://checkout.stripe.com/c/pay/cs_live_a1234567890",
            "https://checkout.stripe.com/c/pay/cs_live_short",
            "https://checkout.stripe.com/c/pay/cs_live_a1234567890/extra",
            "https://checkout.stripe.com/c/pay/cs_live_a1234567890?lang=en",
            "https://checkout.stripe.com/c/pay/cs_live_a1234567890?returnTo=https://evil.test",
            "https://checkout.stripe.com/c/pay/cs_live_a1234567890%2Fextra",
            "https://billing.stripe.com.evil.test/p/session/a1234567890",
            "https://billing.stripe.com/p/session/short",
            "https://billing.stripe.com/p/session/a1234567890/extra",
            "https://billing.stripe.com/p/session/a1234567890?redirect=https://evil.test",
            "https://billing.stripe.com/p/session/a1234567890#fragment",
            "https://billing.stripe.com/p/session/a1234567890-hyphen",
            "https://checkout.stripe.com/p/session/a1234567890",
            "https://billing.stripe.com/c/pay/cs_live_a1234567890",
        ] {
            assert!(subscription_url(bad).is_err(), "{bad}");
        }
        let too_long = format!(
            "https://checkout.stripe.com/c/pay/cs_live_{}",
            "a".repeat(241)
        );
        assert!(subscription_url(&too_long).is_err());
    }

    #[test]
    fn subscription_opener_rejects_redirects_duplicates_paths_and_schemes() {
        for bad in [
            "https://uptokey.com/checkout?_ptxn=txn_aaaaaaaaaaaaaaaaaaaaaaaaaa&returnTo=https://evil.test",
            "https://uptokey.com/checkout?_ptxn=txn_aaaaaaaaaaaaaaaaaaaaaaaaaa&lang=ar&lang=en",
            "https://uptokey.com/checkout?_ptxn=txn_aaaaaaaaaaaaaaaaaaaaaaaaaa&_ptxn=txn_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            "https://uptokey.com/checkout?_ptxn=invalid", "https://uptokey.com/checkout?lang=en",
            "https://www.uptokey.com/checkout?_ptxn=txn_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            "http://uptokey.com/checkout?_ptxn=txn_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            "https://user@uptokey.com/checkout?_ptxn=txn_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            "https://uptokey.com:444/checkout?_ptxn=txn_aaaaaaaaaaaaaaaaaaaaaaaaaa",
            "https://uptokey.com/checkout?_ptxn=txn_aaaaaaaaaaaaaaaaaaaaaaaaaa#fragment",
            "https://customer-portal.paddle.com.evil.test/cpl_bbbbbbbbbbbbbbbbbbbbbbbbbb?token=x",
            "https://customer-portal.paddle.com//cpl_bbbbbbbbbbbbbbbbbbbbbbbbbb?token=x",
            "https://customer-portal.paddle.com/cpl_bbbbbbbbbbbbbbbbbbbbbbbbbb?token=x&redirect=https://evil.test",
            "https://customer-portal.paddle.com/cpl_bbbbbbbbbbbbbbbbbbbbbbbbbb?token=x&token=y",
            "javascript:alert(1)", "file:///C:/secret",
        ] { assert!(subscription_url(bad).is_err(), "{bad}"); }
    }
}
