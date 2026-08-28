use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::Duration,
};

use turn_server::{
    config::{Auth, Config as TurnConfig, Interface, Log, Server, Ssl},
    prelude::PortRange,
};

use crate::{auth, config::Config, state::AppState};

pub async fn run(config: Config, state: AppState) -> Result<(), String> {
    let public_ip = config
        .turn_public_ip
        .ok_or_else(|| "TURN_PUBLIC_IP is required".to_string())?;
    if config.turn_secret.is_none() {
        return Err("TURN_SECRET is required".into());
    }

    // turn-server 4.1.4 intentionally does not validate TURN REST timestamp
    // usernames. For this private application we instead populate the static
    // credential table only with configured application accounts. This keeps
    // the TURN data plane pure Rust, rejects arbitrary usernames, and avoids
    // pretending credentials expire when the embedded server cannot enforce it.
    let mut static_credentials = HashMap::new();
    for user in &config.auth_users {
        let (username, credential) = auth::turn_credentials(&config, &user.username)
            .ok_or_else(|| "failed to derive TURN credential".to_string())?;
        static_credentials.insert(username, credential);
    }

    let address = |ip, port| SocketAddr::new(ip, port);
    let mut interfaces = vec![
        Interface::Udp {
            listen: address(config.turn_bind_ip, config.turn_port),
            external: address(public_ip, config.turn_port),
            idle_timeout: 120,
            mtu: 1_200,
        },
        Interface::Tcp {
            listen: address(config.turn_bind_ip, config.turn_port),
            external: address(public_ip, config.turn_port),
            idle_timeout: 120,
            ssl: None,
        },
    ];

    if let (Some(certificate_chain), Some(private_key)) = (config.turn_tls_cert.clone(), config.turn_tls_key.clone()) {
        interfaces.push(Interface::Tcp {
            listen: address(config.turn_bind_ip, config.turn_tls_port),
            external: address(public_ip, config.turn_tls_port),
            idle_timeout: 120,
            ssl: Some(Ssl {
                private_key,
                certificate_chain,
            }),
        });
    }

    let port_range: PortRange = format!("{}..{}", config.turn_relay_min_port, config.turn_relay_max_port)
        .parse()
        .map_err(|error| format!("invalid TURN relay port range: {error}"))?;

    tracing::info!(
        udp_port = config.turn_port,
        tcp_port = config.turn_port,
        tls_port = config.turn_tls_cert.as_ref().map(|_| config.turn_tls_port),
        relay_min = config.turn_relay_min_port,
        relay_max = config.turn_relay_max_port,
        max_sessions = config.turn_max_sessions,
        configured_accounts = static_credentials.len(),
        "embedded TURN server starting with private per-account credentials"
    );

    let server = turn_server::start_server(TurnConfig {
        server: Server {
            port_range,
            max_threads: std::thread::available_parallelism().map_or(2, usize::from),
            max_sessions: config.turn_max_sessions,
            realm: config.turn_realm,
            interfaces,
        },
        auth: Auth {
            static_credentials,
            static_auth_secret: None,
            enable_hooks_auth: false,
        },
        log: Log::default(),
        api: None,
        prometheus: None,
        hooks: None,
    });
    tokio::pin!(server);

    let probe_ip = match config.turn_bind_ip {
        IpAddr::V4(ip) if ip.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(ip) if ip.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        ip => ip,
    };
    let probe = wait_until_listening(SocketAddr::new(probe_ip, config.turn_port));
    tokio::pin!(probe);
    tokio::select! {
        result = &mut server => {
            state.set_turn_ready(false);
            return result.map_err(|error| error.to_string());
        }
        result = &mut probe => result?,
    }

    state.set_turn_ready(true);
    tracing::info!("embedded TURN server is ready");
    let result = server.await.map_err(|error| error.to_string());
    state.set_turn_ready(false);
    result
}

async fn wait_until_listening(address: SocketAddr) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if tokio::net::TcpStream::connect(address).await.is_ok() {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!("TURN TCP listener did not become ready at {address}"));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use turn_server::{
        codec::{
            crypto::{Password, generate_password},
            message::attributes::PasswordAlgorithm,
        },
        config::{Auth, Config as TurnConfig, Server},
        handler::Handler,
        service::{
            ServiceHandler, Transport,
            session::{
                Identifier, MAX_SESSION_LIFETIME, Session, SessionManager,
                SessionManagerOptions,
            },
        },
        statistics::Statistics,
    };

    #[derive(Clone)]
    struct TestHandler;

    impl ServiceHandler for TestHandler {
        async fn get_password(
            &self,
            _id: &Identifier,
            username: &str,
            algorithm: PasswordAlgorithm,
        ) -> Option<Password> {
            Some(generate_password(username, "password", "test-realm", algorithm))
        }
    }

    fn identifier(source_port: u16) -> Identifier {
        Identifier {
            source: format!("127.0.0.1:{source_port}").parse().unwrap(),
            external: "127.0.0.1:3478".parse().unwrap(),
            interface: "127.0.0.1:3478".parse().unwrap(),
            transport: Transport::Udp,
        }
    }

    fn manager(max_sessions: usize) -> std::sync::Arc<SessionManager<TestHandler>> {
        SessionManager::new_bounded(
            SessionManagerOptions {
                port_range: "49160..49175".parse().unwrap(),
                handler: TestHandler,
            },
            max_sessions,
        )
    }

    #[test]
    fn turn_session_table_is_hard_bounded() {
        let sessions = manager(4);
        for port in 20_000..20_004 {
            assert!(
                sessions
                    .get_session_or_default(&identifier(port))
                    .get_ref()
                    .is_some()
            );
        }

        assert_eq!(sessions.sessions_len(), 4);
        assert_eq!(sessions.max_sessions(), 4);
        assert!(
            sessions
                .get_session_or_default(&identifier(20_004))
                .get_ref()
                .is_none()
        );
        assert_eq!(sessions.sessions_len(), 4);
    }

    #[tokio::test]
    async fn turn_allocation_lifetime_is_capped() {
        let sessions = manager(4);
        let id = identifier(20_000);
        assert!(sessions.get_session_or_default(&id).get_ref().is_some());
        assert!(
            sessions
                .get_password(&id, "caller-one", PasswordAlgorithm::Md5)
                .await
                .is_some()
        );
        assert!(sessions.allocate(&id, Some(u32::MAX)).is_some());

        let expires = match sessions.get_session(&id).get_ref().unwrap() {
            Session::Authenticated { expires, .. } => *expires,
            Session::New { .. } => panic!("expected an authenticated session"),
        };
        assert!((MAX_SESSION_LIFETIME..=MAX_SESSION_LIFETIME + 10).contains(&expires));
        assert!(!sessions.refresh(&id, MAX_SESSION_LIFETIME as u32 + 1));
    }

    #[tokio::test]
    async fn turn_static_auth_accepts_only_configured_credentials() {
        let mut static_credentials = HashMap::new();
        static_credentials.insert("remote-caller:alice".into(), "derived-password".into());
        let handler = Handler::new(
            TurnConfig {
                server: Server {
                    realm: "test-realm".into(),
                    ..Server::default()
                },
                auth: Auth {
                    static_credentials,
                    static_auth_secret: None,
                    enable_hooks_auth: false,
                },
                ..TurnConfig::default()
            },
            Statistics::default(),
        )
        .await
        .unwrap();
        let id = identifier(20_000);
        let expected = generate_password(
            "remote-caller:alice",
            "derived-password",
            "test-realm",
            PasswordAlgorithm::Md5,
        );

        assert_eq!(
            handler
                .get_password(&id, "remote-caller:alice", PasswordAlgorithm::Md5)
                .await,
            Some(expected)
        );
        assert!(
            handler
                .get_password(&id, "remote-caller:bob", PasswordAlgorithm::Md5)
                .await
                .is_none()
        );
    }
}
