//! Uptokey desktop shell — biblioteca interna.
//!
//! A casca Tauri supervisiona o `proxy-local` canônico (sidecar compilado) e
//! expõe à WebView uma bridge tipada mínima. Nenhum segredo BYOK, token,
//! prompt ou caminho de usuário passa por IPC, logs, argv ou ambiente.

pub mod account_urls;
pub mod bridge;
pub mod config;
pub mod diagnostics;
pub mod harness_host;
pub mod harness_layout;
pub mod sidecar;
pub mod supervisor;
