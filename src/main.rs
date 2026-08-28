use remote_caller::{app, config::Config, state::AppState};
use std::io::{self, Read};
use tokio::signal;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("hash-password") {
        let mut password = String::new();
        io::stdin()
            .read_to_string(&mut password)
            .expect("failed to read password from stdin");
        match remote_caller::auth::hash_password(password.trim_end_matches(&['\r', '\n'][..])) {
            Ok(hash) => println!("{hash}"),
            Err(error) => {
                eprintln!("cannot hash password: {error}");
                std::process::exit(2);
            }
        }
        return;
    }
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "remote_caller=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer().json())
        .init();

    let config = Config::from_env().unwrap_or_else(|error| {
        eprintln!("configuration error: {error}");
        std::process::exit(2);
    });
    let bind_addr = config.bind_addr;
    let embedded_turn = config.embedded_turn;
    #[cfg(target_os = "linux")]
    let turn_config = config.clone();
    let listener = tokio::net::TcpListener::bind(bind_addr)
        .await
        .expect("failed to bind server");
    tracing::info!(%bind_addr, "remote-caller listening");
    let state = AppState::new(config);
    let http_server = axum::serve(listener, app(state.clone())).with_graceful_shutdown(shutdown_signal(state.clone()));

    #[cfg(target_os = "linux")]
    if embedded_turn {
        tokio::select! {
            result = http_server => result.expect("HTTP server failed"),
            result = remote_caller::embedded_turn::run(turn_config, state) => {
                tracing::error!(error = %result.err().unwrap_or_else(|| "unexpected exit".into()), "embedded TURN server stopped");
                std::process::exit(1);
            }
        }
        return;
    }

    #[cfg(not(target_os = "linux"))]
    let _ = embedded_turn;
    http_server.await.expect("HTTP server failed");
}

async fn shutdown_signal(state: AppState) {
    let ctrl_c = async { signal::ctrl_c().await.expect("failed to install Ctrl+C handler") };
    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
    state.begin_shutdown();
    tracing::info!("shutdown signal received");
    // Give upgraded WebSockets a short chance to send a close frame before
    // Axum stops accepting and the runtime drops remaining I/O tasks.
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
}
