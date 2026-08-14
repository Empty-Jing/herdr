use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

use super::all_agent_panel_entries;
use crate::app::state::Palette;
use crate::app::AppState;
use crate::ui::text::{display_width, truncate_end};

const MIN_WIDTH: u16 = 18;

#[derive(Debug, Clone, PartialEq)]
struct Window {
    remaining: f64,
    minutes: u64,
}

#[derive(Debug, Clone, PartialEq)]
struct Card {
    status: String,
    unlimited: bool,
    message: Option<String>,
    windows: Vec<Window>,
    reset_at: Option<u64>,
}

fn is_openai_quota_agent(agent: Option<crate::detect::Agent>) -> bool {
    matches!(
        agent,
        Some(crate::detect::Agent::OpenCode | crate::detect::Agent::Pi)
    )
}

fn active_card(app: &AppState) -> Option<Card> {
    let entries = all_agent_panel_entries(app);
    let active = entries.iter().find(|entry| {
        is_openai_quota_agent(entry.agent)
            && app.is_active_pane(entry.ws_idx, entry.tab_idx, entry.pane_id)
    })?;
    card_from_tokens(&active.tokens).or_else(|| {
        entries
            .iter()
            .filter(|entry| is_openai_quota_agent(entry.agent))
            .find_map(|entry| card_from_tokens(&entry.tokens))
    })
}

pub(super) fn available(app: &AppState) -> bool {
    active_card(app).is_some()
}

fn card_from_tokens(tokens: &std::collections::HashMap<String, String>) -> Option<Card> {
    let status = tokens.get("quota_status")?.clone();
    if tokens.get("quota_provider").map(String::as_str) != Some("openai") {
        return None;
    }

    let mut windows = Vec::new();
    for prefix in ["quota_primary", "quota_secondary"] {
        let remaining = tokens
            .get(&format!("{prefix}_remaining"))
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite())
            .map(|value| value.clamp(0.0, 100.0));
        let minutes = tokens
            .get(&format!("{prefix}_minutes"))
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0);
        if let (Some(remaining), Some(minutes)) = (remaining, minutes) {
            windows.push(Window { remaining, minutes });
        }
    }

    Some(Card {
        status,
        unlimited: tokens.get("quota_unlimited").map(String::as_str) == Some("true"),
        message: tokens.get("quota_message").cloned(),
        windows,
        reset_at: ["quota_primary_reset", "quota_secondary_reset"]
            .into_iter()
            .find_map(|key| tokens.get(key)?.parse::<u64>().ok()),
    })
}

fn card_height(card: &Card) -> u16 {
    let content_rows = card.windows.len().max(1) + usize::from(card.reset_at.is_some());
    (content_rows.min(u16::MAX as usize) as u16).saturating_add(2)
}

pub(super) fn height_in_body(app: &AppState, body: Rect) -> u16 {
    if body.width.saturating_sub(2) < MIN_WIDTH {
        return 0;
    }
    let Some(card) = active_card(app) else {
        return 0;
    };
    let height = card_height(&card);
    if height < body.height {
        height
    } else {
        0
    }
}

pub(super) fn render(app: &AppState, frame: &mut Frame, area: Rect) {
    let Some(card) = active_card(app) else {
        return;
    };
    let p = &app.palette;
    let border_color = match card.status.as_str() {
        "ok" => p.accent,
        "signed_out" | "stale" => p.peach,
        _ => p.overlay0,
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .title(Span::styled(
            " OpenAI ",
            Style::default()
                .fg(border_color)
                .add_modifier(Modifier::BOLD),
        ))
        .border_style(Style::default().fg(border_color));
    frame.render_widget(block, area);

    let inner = Rect::new(
        area.x.saturating_add(1),
        area.y.saturating_add(1),
        area.width.saturating_sub(2),
        area.height.saturating_sub(2),
    );
    if card.status == "ok" && !card.windows.is_empty() {
        for (index, window) in card.windows.iter().enumerate() {
            let y = inner.y.saturating_add(index as u16);
            if y >= inner.y.saturating_add(inner.height) {
                break;
            }
            frame.render_widget(
                Paragraph::new(window_line(window, inner.width, p)),
                Rect::new(inner.x, y, inner.width, 1),
            );
        }
        if let Some(reset_at) = card.reset_at {
            let y = inner.y.saturating_add(card.windows.len() as u16);
            if y < inner.y.saturating_add(inner.height) {
                let reset = format_reset_time(reset_at, unix_now());
                frame.render_widget(
                    Paragraph::new(truncate_end(&format!(" {reset}"), inner.width as usize))
                        .style(Style::default().fg(p.overlay1)),
                    Rect::new(inner.x, y, inner.width, 1),
                );
            }
        }
        return;
    }

    let text = if card.status == "ok" && card.unlimited {
        " Unlimited".to_string()
    } else {
        format!(
            " {}",
            card.message
                .as_deref()
                .unwrap_or(match card.status.as_str() {
                    "ok" => "No quota windows reported.",
                    "signed_out" => "OpenAI sign-in is required.",
                    "stale" => "OpenAI quota data is stale.",
                    _ => "OpenAI quota is unavailable.",
                })
        )
    };
    frame.render_widget(
        Paragraph::new(truncate_end(&text, inner.width as usize))
            .style(Style::default().fg(p.overlay1)),
        inner,
    );
}

fn window_line<'a>(window: &Window, width: u16, palette: &Palette) -> Line<'a> {
    let duration = format_duration(window.minutes);
    let prefix = format!(" {:>4} ", duration);
    let percent = format!(" {:>5}", format_percent(window.remaining));
    let fixed_width = display_width(&prefix) + display_width(&percent);
    let bar_width = (width as usize).saturating_sub(fixed_width).max(1);
    let filled = ((window.remaining / 100.0) * bar_width as f64).round() as usize;
    let filled = filled.min(bar_width);
    Line::from(vec![
        Span::styled(prefix, Style::default().fg(palette.overlay1)),
        Span::styled("█".repeat(filled), Style::default().fg(palette.accent)),
        Span::styled(
            "░".repeat(bar_width.saturating_sub(filled)),
            Style::default().fg(palette.surface1),
        ),
        Span::styled(percent, Style::default().fg(palette.text)),
    ])
}

fn format_percent(remaining: f64) -> String {
    if remaining.fract().abs() < f64::EPSILON {
        format!("{remaining:.0}%")
    } else {
        format!("{remaining:.1}%")
    }
}

fn format_duration(minutes: u64) -> String {
    if minutes.is_multiple_of(7 * 24 * 60) {
        let weeks = minutes / (7 * 24 * 60);
        if weeks == 1 {
            "week".to_string()
        } else {
            format!("{weeks} weeks")
        }
    } else if minutes.is_multiple_of(24 * 60) {
        format!("{}d", minutes / (24 * 60))
    } else if minutes.is_multiple_of(60) {
        format!("{}h", minutes / 60)
    } else {
        format!("{minutes}m")
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

fn format_reset_time(reset_at: u64, now: u64) -> String {
    if reset_at <= now {
        return "Updating quota".to_string();
    }
    let minutes = reset_at.saturating_sub(now).saturating_add(59) / 60;
    if minutes < 60 {
        return format!("resets in {minutes}m");
    }
    let hours = minutes / 60;
    let remaining_minutes = minutes % 60;
    if hours < 24 {
        if remaining_minutes == 0 {
            return format!("resets in {hours}h");
        }
        return format!("resets in {hours}h {remaining_minutes}m");
    }
    let days = hours / 24;
    format!("resets in {days}d {}h", hours % 24)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duration_and_percentage_labels_are_data_driven() {
        assert_eq!(format_duration(45), "45m");
        assert_eq!(format_duration(90), "90m");
        assert_eq!(format_duration(300), "5h");
        assert_eq!(format_duration(2_880), "2d");
        assert_eq!(format_duration(10_080), "week");
        assert_eq!(format_duration(20_160), "2 weeks");
        assert_eq!(format_percent(87.5), "87.5%");
    }

    #[test]
    fn reset_labels_match_quota_float_format() {
        let now = 1_000_000;

        assert_eq!(format_reset_time(now + 30 * 60, now), "resets in 30m");
        assert_eq!(format_reset_time(now + 90 * 60, now), "resets in 1h 30m");
        assert_eq!(
            format_reset_time(now + (2 * 24 + 3) * 60 * 60, now),
            "resets in 2d 3h"
        );
        assert_eq!(format_reset_time(now, now), "Updating quota");
    }
}
