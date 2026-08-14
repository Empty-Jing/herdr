use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

use crate::app::state::Palette;
use crate::app::AppState;
use crate::ui::text::{display_width, truncate_end};

const MAX_ROWS: usize = 12;
const MAX_LABEL_WIDTH: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
struct MemoryRow {
    name: String,
    current: u64,
    maximum: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Card {
    status: String,
    message: Option<String>,
    rows: Vec<MemoryRow>,
}

fn active_card(app: &AppState) -> Option<Card> {
    let tokens = app.metadata_tokens.values();
    let status = tokens.get("memory_status")?.clone();
    let rows = (0..MAX_ROWS)
        .filter_map(|index| parse_row(tokens.get(&format!("memory_row_{index}"))?))
        .collect::<Vec<_>>();
    if status == "ok" && rows.is_empty() {
        return None;
    }
    Some(Card {
        status,
        message: tokens.get("memory_message").cloned(),
        rows,
    })
}

fn parse_row(value: &str) -> Option<MemoryRow> {
    let mut fields = value.split('|');
    let name = fields.next()?.trim();
    let current = fields.next()?.parse::<u64>().ok()?;
    let maximum = fields.next()?.parse::<u64>().ok()?;
    if name.is_empty() || maximum == 0 || fields.next().is_some() {
        return None;
    }
    Some(MemoryRow {
        name: name.to_string(),
        current,
        maximum,
    })
}

fn card_height(card: &Card) -> u16 {
    let rows = if card.status == "ok" {
        card.rows.len().max(1)
    } else {
        1
    };
    (rows.min(u16::MAX as usize) as u16).saturating_add(2)
}

fn required_inner_width(card: &Card) -> usize {
    card.rows
        .iter()
        .map(|row| {
            display_width(&display_name(&row.name))
                + 1
                + display_width(&format!(" {:.0}%", percentage(row)))
        })
        .max()
        .unwrap_or(13)
}

pub(super) fn height_in_body(app: &AppState, body: Rect) -> u16 {
    let Some(card) = active_card(app) else {
        return 0;
    };
    if (body.width.saturating_sub(4) as usize) < required_inner_width(&card) {
        return 0;
    }
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
    let palette = &app.palette;
    let border_color = match card.status.as_str() {
        "ok" => palette.accent,
        "stale" => palette.peach,
        _ => palette.overlay0,
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .title(Span::styled(
            " Memory ",
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
    if card.status != "ok" {
        let message = card
            .message
            .as_deref()
            .unwrap_or(if card.status == "stale" {
                "Memory data is stale."
            } else {
                "Memory data is unavailable."
            });
        frame.render_widget(
            Paragraph::new(format!(" {message}")).style(Style::default().fg(palette.overlay1)),
            inner,
        );
        return;
    }

    let label_width = card
        .rows
        .iter()
        .map(|row| display_width(&display_name(&row.name)))
        .max()
        .unwrap_or(0);
    for (index, row) in card.rows.iter().enumerate() {
        let y = inner.y.saturating_add(index as u16);
        if y >= inner.y.saturating_add(inner.height) {
            break;
        }
        frame.render_widget(
            Paragraph::new(memory_line(row, label_width, inner.width, palette)),
            Rect::new(inner.x, y, inner.width, 1),
        );
    }
}

fn memory_line<'a>(row: &MemoryRow, label_width: usize, width: u16, palette: &Palette) -> Line<'a> {
    let label = format!("{:<label_width$}", display_name(&row.name));
    let percent_value = percentage(row);
    let percent = format!(" {percent_value:.0}%");
    let fixed_width = display_width(&label) + display_width(&percent);
    let bar_width = (width as usize).saturating_sub(fixed_width).max(1);
    let ratio = (row.current as f64 / row.maximum as f64).clamp(0.0, 1.0);
    let filled = ((ratio * bar_width as f64).round() as usize).min(bar_width);
    let over_threshold = percent_value > 90.0;
    let usage_color = if over_threshold {
        palette.red
    } else {
        palette.accent
    };
    Line::from(vec![
        Span::styled(label, Style::default().fg(palette.overlay1)),
        Span::styled("█".repeat(filled), Style::default().fg(usage_color)),
        Span::styled(
            "░".repeat(bar_width.saturating_sub(filled)),
            Style::default().fg(palette.surface1),
        ),
        Span::styled(
            percent,
            Style::default().fg(if over_threshold {
                palette.red
            } else {
                palette.text
            }),
        ),
    ])
}

fn display_name(name: &str) -> String {
    truncate_end(name, MAX_LABEL_WIDTH)
}

fn percentage(row: &MemoryRow) -> f64 {
    row.current as f64 / row.maximum as f64 * 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ordered_memory_rows() {
        let row = parse_row("chenjing54|5368709120|53687091200").unwrap();
        assert_eq!(row.name, "chenjing54");
        assert_eq!(percentage(&row), 10.0);
    }

    #[test]
    fn rejects_malformed_or_unlimited_rows() {
        assert!(parse_row("chenjing54|bad|50").is_none());
        assert!(parse_row("chenjing54|5|0").is_none());
        assert!(parse_row("chenjing54|5|50|extra").is_none());
    }

    #[test]
    fn long_user_names_are_bounded() {
        assert_eq!(display_width(&display_name("chenjing54")), MAX_LABEL_WIDTH);
        assert_eq!(display_name("xiezx11"), "xiezx11");
    }

    #[test]
    fn over_limit_percentage_keeps_numeric_overage_and_uses_warning_color() {
        let row = MemoryRow {
            name: "user".into(),
            current: 60 * 1024_u64.pow(3),
            maximum: 50 * 1024_u64.pow(3),
        };
        let palette = Palette::catppuccin();
        let text = memory_line(&row, 4, 30, &palette)
            .spans
            .iter()
            .map(|span| span.content.as_ref())
            .collect::<String>();
        assert!(text.contains("120%"));
        assert!(!text.contains("50G"));
        let line = memory_line(&row, 4, 30, &palette);
        assert_eq!(line.spans[1].style.fg, Some(palette.red));
        assert_eq!(line.spans[3].style.fg, Some(palette.red));
    }

    #[test]
    fn ninety_percent_does_not_use_warning_color() {
        let row = MemoryRow {
            name: "user".into(),
            current: 45 * 1024_u64.pow(3),
            maximum: 50 * 1024_u64.pow(3),
        };
        let palette = Palette::catppuccin();
        let line = memory_line(&row, 4, 30, &palette);
        assert_eq!(line.spans[1].style.fg, Some(palette.accent));
        assert_eq!(line.spans[3].style.fg, Some(palette.text));
    }
}
