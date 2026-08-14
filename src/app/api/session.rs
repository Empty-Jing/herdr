use crate::api::schema::{ResponseResult, SessionReportMetadataParams, SessionSnapshot};
use crate::app::App;

use super::super::api_helpers::{normalize_metadata_source, normalize_metadata_ttl};
use super::responses::encode_success;

impl App {
    pub(super) fn handle_session_report_metadata(
        &mut self,
        id: String,
        params: SessionReportMetadataParams,
    ) -> String {
        let source = match normalize_metadata_source(params.source) {
            Ok(source) => source,
            Err(message) => {
                return super::responses::encode_error(id, "invalid_metadata_source", message)
            }
        };
        let ttl = match normalize_metadata_ttl(params.ttl_ms) {
            Ok(ttl) => ttl,
            Err(message) => {
                return super::responses::encode_error(id, "invalid_metadata_ttl", message)
            }
        };
        let tokens = match super::super::api_helpers::normalize_metadata_tokens(params.tokens) {
            Ok(tokens) => tokens,
            Err(message) => {
                return super::responses::encode_error(id, "invalid_metadata_token", message)
            }
        };
        if !crate::metadata_tokens::sequence_is_fresh(
            &self.state.metadata_token_sequences,
            &source,
            params.seq,
        ) {
            return encode_success(id, ResponseResult::Ok {});
        }
        if self.state.metadata_tokens.key_count_after_patch(&tokens)
            > super::super::api_helpers::MAX_METADATA_TOKEN_KEYS_PER_RESOURCE
        {
            return super::responses::encode_error(
                id,
                "metadata_token_limit",
                format!(
                    "session metadata may contain at most {} tokens",
                    super::super::api_helpers::MAX_METADATA_TOKEN_KEYS_PER_RESOURCE
                ),
            );
        }
        match crate::metadata_tokens::accept_sequence(
            &mut self.state.metadata_token_sequences,
            &source,
            params.seq,
        ) {
            Ok(true) => {}
            Ok(false) => return encode_success(id, ResponseResult::Ok {}),
            Err(()) => {
                return super::responses::encode_error(
                    id,
                    "metadata_sequence_source_limit",
                    format!(
                        "session metadata may track at most {} sequenced sources",
                        crate::metadata_tokens::MAX_SEQUENCE_SOURCES
                    ),
                );
            }
        }
        let changed = self
            .state
            .metadata_tokens
            .patch(tokens, ttl, std::time::Instant::now());
        if changed {
            self.sync_agent_metadata_deadline();
            self.emit_session_token_updated();
        }
        encode_success(id, ResponseResult::Ok {})
    }

    pub(super) fn handle_session_snapshot(&mut self, id: String) -> String {
        encode_success(
            id,
            ResponseResult::SessionSnapshot {
                snapshot: Box::new(self.session_snapshot()),
            },
        )
    }

    fn session_snapshot(&self) -> SessionSnapshot {
        let focused_workspace_id = self
            .state
            .active
            .map(|ws_idx| self.public_workspace_id(ws_idx));
        let focused_tab_id = self.state.active.and_then(|ws_idx| {
            let ws = self.state.workspaces.get(ws_idx)?;
            self.public_tab_id(ws_idx, ws.active_tab)
        });
        let focused_pane_id = self.state.active.and_then(|ws_idx| {
            let ws = self.state.workspaces.get(ws_idx)?;
            self.public_pane_id(ws_idx, ws.focused_pane_id()?)
        });

        let mut workspaces = Vec::new();
        let mut tabs = Vec::new();
        let mut layouts = Vec::new();
        for (ws_idx, ws) in self.state.workspaces.iter().enumerate() {
            workspaces.push(self.workspace_info(ws_idx));
            for tab_idx in 0..ws.tabs.len() {
                if let Some(tab) = self.tab_info(ws_idx, tab_idx) {
                    tabs.push(tab);
                }
                if let Some(layout) = self.pane_layout_snapshot(ws_idx, tab_idx) {
                    layouts.push(layout);
                }
            }
        }

        SessionSnapshot {
            version: crate::build_info::version(),
            protocol: crate::protocol::PROTOCOL_VERSION,
            focused_workspace_id,
            focused_tab_id,
            focused_pane_id,
            tokens: self.state.metadata_tokens.values(),
            workspaces,
            tabs,
            panes: self.collect_panes_for_workspace(None).unwrap_or_default(),
            layouts,
            agents: self.collect_agent_infos(),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::api::schema::{EmptyParams, ErrorResponse, Method, ResponseResult, SuccessResponse};
    use crate::{config::Config, workspace::Workspace};

    fn app_with_two_tabs() -> crate::app::App {
        let (_api_tx, api_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut app = crate::app::App::new(
            &Config::default(),
            true,
            None,
            api_rx,
            crate::api::EventHub::default(),
        );
        let mut workspace = Workspace::test_new("snapshot");
        workspace.test_add_tab(None);
        app.state.workspaces = vec![workspace];
        app.state.ensure_test_terminals();
        app.state.active = Some(0);
        app
    }

    #[test]
    fn session_snapshot_bootstraps_runtime_resources() {
        let mut app = app_with_two_tabs();
        let response = app.handle_api_request(crate::api::schema::Request {
            id: "req_snapshot".into(),
            method: Method::SessionSnapshot(EmptyParams::default()),
        });

        let success: SuccessResponse = serde_json::from_str(&response).unwrap();
        let ResponseResult::SessionSnapshot { snapshot } = success.result else {
            panic!("expected session snapshot response");
        };
        assert_eq!(success.id, "req_snapshot");
        assert_eq!(snapshot.workspaces.len(), 1);
        assert_eq!(snapshot.tabs.len(), 2);
        assert_eq!(snapshot.panes.len(), 2);
        assert_eq!(snapshot.layouts.len(), 2);
        assert_eq!(
            snapshot.focused_workspace_id.as_deref(),
            Some(snapshot.workspaces[0].workspace_id.as_str())
        );
        assert_eq!(
            snapshot.focused_tab_id.as_deref(),
            Some(snapshot.tabs[0].tab_id.as_str())
        );
        assert_eq!(
            snapshot.focused_pane_id.as_deref(),
            Some(snapshot.panes[0].pane_id.as_str())
        );
        assert!(snapshot.tokens.is_empty());
    }

    #[test]
    fn session_metadata_patches_snapshot_and_emits_full_tokens() {
        use std::collections::HashMap;

        use crate::api::schema::{EventData, SessionReportMetadataParams};

        let event_hub = crate::api::EventHub::default();
        let (_api_tx, api_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut app =
            crate::app::App::new(&Config::default(), true, None, api_rx, event_hub.clone());

        for (seq, tokens, expected) in [
            (
                1,
                HashMap::from([
                    ("summary".into(), Some("reviewing".into())),
                    ("model".into(), Some("opus".into())),
                ]),
                HashMap::from([
                    ("summary".into(), "reviewing".into()),
                    ("model".into(), "opus".into()),
                ]),
            ),
            (
                2,
                HashMap::from([
                    ("summary".into(), Some("done".into())),
                    ("model".into(), None),
                ]),
                HashMap::from([("summary".into(), "done".into())]),
            ),
        ] {
            let response = app.handle_api_request(crate::api::schema::Request {
                id: format!("req-{seq}"),
                method: Method::SessionReportMetadata(SessionReportMetadataParams {
                    source: "user:test".into(),
                    tokens,
                    seq: Some(seq),
                    ttl_ms: None,
                }),
            });
            let success: SuccessResponse = serde_json::from_str(&response).unwrap();
            assert_eq!(success.result, ResponseResult::Ok {});
            assert_eq!(app.session_snapshot().tokens, expected);
        }

        let response = app.handle_session_report_metadata(
            "stale".into(),
            SessionReportMetadataParams {
                source: "user:test".into(),
                tokens: HashMap::from([("summary".into(), Some("stale".into()))]),
                seq: Some(1),
                ttl_ms: None,
            },
        );
        let success: SuccessResponse = serde_json::from_str(&response).unwrap();
        assert_eq!(success.result, ResponseResult::Ok {});
        assert_eq!(
            app.session_snapshot().tokens,
            HashMap::from([("summary".into(), "done".into())])
        );

        assert!(event_hub.events_after(0).iter().any(|(_, event)| matches!(
            &event.data,
            EventData::SessionMetadataUpdated { tokens }
                if tokens == &HashMap::from([("summary".into(), "done".into())])
        )));
    }

    #[test]
    fn session_metadata_ttl_expiry_emits_empty_full_snapshot() {
        use std::collections::HashMap;

        use crate::api::schema::{EventData, SessionReportMetadataParams};

        let event_hub = crate::api::EventHub::default();
        let (_api_tx, api_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut app =
            crate::app::App::new(&Config::default(), true, None, api_rx, event_hub.clone());
        let response = app.handle_session_report_metadata(
            "req".into(),
            SessionReportMetadataParams {
                source: "user:test".into(),
                tokens: HashMap::from([("summary".into(), Some("temporary".into()))]),
                seq: None,
                ttl_ms: Some(1),
            },
        );
        let _: SuccessResponse = serde_json::from_str(&response).unwrap();
        let deadline = app.agent_metadata_deadline.expect("session token deadline");

        app.expire_metadata_at(deadline, deadline);

        assert!(app.session_snapshot().tokens.is_empty());
        assert!(event_hub.events_after(0).iter().any(|(_, event)| matches!(
            &event.data,
            EventData::SessionMetadataUpdated { tokens } if tokens.is_empty()
        )));
    }

    #[test]
    fn session_report_metadata_reuses_ttl_limits() {
        use std::collections::HashMap;

        use crate::api::schema::SessionReportMetadataParams;

        let (_api_tx, api_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut app = crate::app::App::new(
            &Config::default(),
            true,
            None,
            api_rx,
            crate::api::EventHub::default(),
        );
        for ttl_ms in [
            0,
            crate::app::api_helpers::METADATA_TTL_MAX_MS.saturating_add(1),
        ] {
            let response = app.handle_session_report_metadata(
                "req".into(),
                SessionReportMetadataParams {
                    source: "user:test".into(),
                    tokens: HashMap::from([("summary".into(), Some("temporary".into()))]),
                    seq: None,
                    ttl_ms: Some(ttl_ms),
                },
            );
            let error: ErrorResponse = serde_json::from_str(&response).unwrap();
            assert_eq!(error.error.code, "invalid_metadata_ttl");
        }
    }
}
