use std::{collections::HashMap, net::SocketAddr};

use turn_server::{
    config::{Auth, Config as TurnConfig, Interface, Log, Server, Ssl},
    prelude::PortRange,
};

use crate::{auth, config::Config};

pub async fn run(config: Config) -> Result<(), String> {
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
        configured_accounts = static_credentials.len(),
        "embedded TURN server starting with private per-account credentials"
    );

    turn_server::start_server(TurnConfig {
        server: Server {
            port_range,
            max_threads: std::thread::available_parallelism().map_or(2, usize::from),
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
    })
    .await
    .map_err(|error| error.to_string())
}
