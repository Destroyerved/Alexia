//! Interactive `ratatui` + `crossterm` Terminal Command Center (`alexia --tui` / `alexia --cli`).

use crate::agents::{
    chaos::{reset_environment, run_scenario, scenario_catalog},
    AppContext,
};
use anyhow::Result;
use crossterm::{
    event::{self, Event as TermEvent, KeyCode, KeyEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, Paragraph, Tabs, Wrap},
    Frame, Terminal,
};
use std::io;
use std::sync::Arc;
use std::time::Duration;

const TAB_TITLES: &[&str] = &[
    "1:Overview",
    "2:Incidents",
    "3:WAF Firewall",
    "4:Approvals (TOTP)",
    "5:Chaos Lab",
    "6:Audit Chain",
];

struct TuiApp {
    ctx: Arc<AppContext>,
    tab: usize,
    cursor: usize,
    status_banner: String,
    totp_prompt_active: bool,
    totp_buffer: String,
}

impl TuiApp {
    fn new(ctx: Arc<AppContext>) -> Self {
        Self {
            ctx,
            tab: 0,
            cursor: 0,
            status_banner: "Alexia v3.0 Pure-Rust Guardian Active — Tab/1-6 switch views, j/k move, Enter act, p pause, q quit".into(),
            totp_prompt_active: false,
            totp_buffer: String::new(),
        }
    }
}

pub async fn run_tui(ctx: Arc<AppContext>) -> Result<()> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = TuiApp::new(ctx);
    let res = tui_loop(&mut terminal, &mut app).await;

    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    res
}

async fn tui_loop(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut TuiApp,
) -> Result<()> {
    loop {
        terminal.draw(|f| render_ui(f, app))?;

        if event::poll(Duration::from_millis(200))? {
            if let TermEvent::Key(key) = event::read()? {
                if key.kind != KeyEventKind::Press {
                    continue;
                }

                if app.totp_prompt_active {
                    match key.code {
                        KeyCode::Esc => {
                            app.totp_prompt_active = false;
                            app.totp_buffer.clear();
                            app.status_banner = "Cancelled TOTP approval.".into();
                        }
                        KeyCode::Backspace => {
                            app.totp_buffer.pop();
                        }
                        KeyCode::Char(c) if c.is_ascii_digit() && app.totp_buffer.len() < 6 => {
                            app.totp_buffer.push(c);
                        }
                        KeyCode::Enter => {
                            let code = app.totp_buffer.clone();
                            app.totp_prompt_active = false;
                            app.totp_buffer.clear();

                            let pending = app.ctx.approvals.list_pending();
                            if let Some(target_app) = pending.get(app.cursor) {
                                let (ok, user_opt) = app.ctx.auth.verify_totp(&code, None);
                                if !ok {
                                    app.status_banner = "Step-Up DENIED: Invalid 6-digit RFC 6238 TOTP code.".into();
                                } else {
                                    let actor = format!("operator:{}", user_opt.unwrap_or_else(|| "tui".into()));
                                    match app
                                        .ctx
                                        .executor
                                        .decide_and_execute(
                                            &target_app.action_id,
                                            "approved",
                                            &actor,
                                            Some("totp_tui"),
                                            None,
                                        )
                                        .await
                                    {
                                        Ok(_) => {
                                            app.status_banner = format!(
                                                "Approved & executed `{}` on `{}`.",
                                                target_app.action_name, target_app.target
                                            );
                                        }
                                        Err(e) => {
                                            app.status_banner = format!("Execution error: {}", e);
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                    continue;
                }

                match key.code {
                    KeyCode::Char('q') | KeyCode::Esc => break,
                    KeyCode::Tab => {
                        app.tab = (app.tab + 1) % TAB_TITLES.len();
                        app.cursor = 0;
                    }
                    KeyCode::Char('1') => { app.tab = 0; app.cursor = 0; }
                    KeyCode::Char('2') => { app.tab = 1; app.cursor = 0; }
                    KeyCode::Char('3') => { app.tab = 2; app.cursor = 0; }
                    KeyCode::Char('4') => { app.tab = 3; app.cursor = 0; }
                    KeyCode::Char('5') => { app.tab = 4; app.cursor = 0; }
                    KeyCode::Char('6') => { app.tab = 5; app.cursor = 0; }
                    KeyCode::Down | KeyCode::Char('j') => {
                        app.cursor = app.cursor.saturating_add(1);
                    }
                    KeyCode::Up | KeyCode::Char('k') => {
                        app.cursor = app.cursor.saturating_sub(1);
                    }
                    KeyCode::Char('p') => {
                        app.ctx.executor.set_paused(true, "operator:tui");
                        app.status_banner = "EMERGENCY KILL-SWITCH: Autonomy PAUSED.".into();
                    }
                    KeyCode::Char('r') => {
                        if app.tab == 3 {
                            let pending = app.ctx.approvals.list_pending();
                            if let Some(item) = pending.get(app.cursor) {
                                let _ = app
                                    .ctx
                                    .executor
                                    .decide_and_execute(&item.action_id, "rejected", "operator:tui", None, None)
                                    .await;
                                app.status_banner = format!("Rejected `{}`.", item.action_name);
                            }
                        } else if app.tab == 4 {
                            let _ = reset_environment(&app.ctx).await;
                            app.status_banner = "Environment reset: WAF cleared & target workspace restored.".into();
                        }
                    }
                    KeyCode::Enter => {
                        if app.tab == 3 {
                            if !app.ctx.approvals.list_pending().is_empty() {
                                app.totp_prompt_active = true;
                                app.totp_buffer.clear();
                                app.status_banner = "Enter 6-digit RFC 6238 TOTP code and press Enter (Esc to cancel):".into();
                            }
                        } else if app.tab == 4 {
                            let catalog = scenario_catalog();
                            if let Some(sc) = catalog.get(app.cursor) {
                                let id = sc["id"].as_str().unwrap_or("S1").to_string();
                                app.status_banner = format!("Running live Chaos Lab exercise {}...", id);
                                terminal.draw(|f| render_ui(f, app))?;
                                match run_scenario(&app.ctx, &id).await {
                                    Ok(res) => {
                                        app.status_banner = format!(
                                            "[{}] {}",
                                            id,
                                            res["description"].as_str().unwrap_or("Completed")
                                        );
                                    }
                                    Err(e) => {
                                        app.status_banner = format!("[{}] Error: {}", id, e);
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    Ok(())
}

fn render_ui(f: &mut Frame, app: &TuiApp) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(10),
            Constraint::Length(3),
        ])
        .split(f.area());

    let titles: Vec<Line> = TAB_TITLES.iter().map(|t| Line::from(*t)).collect();
    let tabs = Tabs::new(titles)
        .select(app.tab)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(" Alexia v3.0 — Autonomous DevSecOps Guardian (Pure Rust) "),
        )
        .highlight_style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD));
    f.render_widget(tabs, chunks[0]);

    render_tab_body(f, app, chunks[1]);

    let footer_text = if app.totp_prompt_active {
        format!(" TOTP STEP-UP CODE: [{}] ", "*".repeat(app.totp_buffer.len()))
    } else {
        format!(" {} ", app.status_banner)
    };
    let footer_style = if app.totp_prompt_active {
        Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(Color::Green)
    };
    let footer = Paragraph::new(footer_text)
        .style(footer_style)
        .block(Block::default().borders(Borders::ALL));
    f.render_widget(footer, chunks[2]);
}

fn render_tab_body(f: &mut Frame, app: &TuiApp, area: Rect) {
    match app.tab {
        0 => {
            let (chain_ok, rows, _) = app.ctx.db.verify_audit_chain();
            let incs = app.ctx.bus.list_incidents(None, 50);
            let pending = app.ctx.approvals.list_pending();
            let blocked = app.ctx.firewall.list_blocked_ips();
            let llm_st = app.ctx.llm.provider_status();

            let lines = vec![
                Line::from(vec![
                    Span::styled("Autonomy Mode:      ", Style::default().add_modifier(Modifier::BOLD)),
                    Span::styled(
                        if app.ctx.executor.is_paused() { "PAUSED (Kill-Switch Engaged)" } else { "ACTIVE (Autonomous Tier-0 + Gated Tier-1)" },
                        Style::default().fg(if app.ctx.executor.is_paused() { Color::Red } else { Color::Green }),
                    ),
                ]),
                Line::from(format!(
                    "LLM Engine:         {} (mode={})",
                    llm_st["provider"].as_str().unwrap_or("none"),
                    llm_st["mode"].as_str().unwrap_or("rule_engine_fallback")
                )),
                Line::from(format!("Tracked Incidents:  {}", incs.len())),
                Line::from(format!("Pending Approvals:  {}", pending.len())),
                Line::from(format!("WAF Blocked IPs:    {}", blocked.len())),
                Line::from(format!(
                    "SHA-256 Audit:      {} ({} linked blocks verified)",
                    if chain_ok { "VERIFIED INTACT" } else { "TAMPER DETECTED!" },
                    rows
                )),
                Line::from(""),
                Line::from("Supervised Targets:"),
            ];
            let mut full_lines = lines;
            for t in app.ctx.supervisor.list_targets(false) {
                full_lines.push(Line::from(format!(
                    "  • {} [{}] -> upstream={} (mem_limit={}MB)",
                    t.name, t.runtime, t.upstream_url, t.memory_limit_mb
                )));
            }
            let p = Paragraph::new(full_lines)
                .wrap(Wrap { trim: false })
                .block(Block::default().borders(Borders::ALL).title(" Guardian Posture "));
            f.render_widget(p, area);
        }
        1 => {
            let incs = app.ctx.bus.list_incidents(None, 40);
            let items: Vec<ListItem> = if incs.is_empty() {
                vec![ListItem::new("No incidents recorded yet (clean boot). Trigger S1-S9 in Tab 5 to test live exercises.")]
            } else {
                incs.iter()
                    .enumerate()
                    .map(|(idx, i)| {
                        let marker = if idx == app.cursor { "▶ " } else { "  " };
                        ListItem::new(format!(
                            "{}[{}] ({}) {} — {} [owner={}]",
                            marker,
                            i.status.to_uppercase(),
                            i.severity,
                            i.id,
                            i.title,
                            i.owner_agent
                        ))
                    })
                    .collect()
            };
            let list = List::new(items)
                .block(Block::default().borders(Borders::ALL).title(" Live Incidents "));
            f.render_widget(list, area);
        }
        2 => {
            let ips = app.ctx.firewall.list_blocked_ips();
            let items: Vec<ListItem> = if ips.is_empty() {
                vec![ListItem::new("WAF IP Blocklist is empty — zero active bans.")]
            } else {
                ips.iter()
                    .map(|b| {
                        ListItem::new(format!(
                            "  BLOCKED {} — {} ({}s remaining)",
                            b["ip"].as_str().unwrap_or(""),
                            b["reason"].as_str().unwrap_or(""),
                            b["seconds_remaining"].as_u64().unwrap_or(0)
                        ))
                    })
                    .collect()
            };
            let list = List::new(items)
                .block(Block::default().borders(Borders::ALL).title(" Sentinel Inline WAF Blocklist "));
            f.render_widget(list, area);
        }
        3 => {
            let pending = app.ctx.approvals.list_pending();
            let items: Vec<ListItem> = if pending.is_empty() {
                vec![ListItem::new("No pending Tier-1 approvals.")]
            } else {
                pending
                    .iter()
                    .enumerate()
                    .map(|(idx, a)| {
                        let marker = if idx == app.cursor { "▶ " } else { "  " };
                        ListItem::new(format!(
                            "{}[TIER-{}] {} on `{}` — {} (Enter=Approve w/ TOTP, r=Reject)",
                            marker, a.tier, a.action_name, a.target, a.reason
                        ))
                    })
                    .collect()
            };
            let list = List::new(items).block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(" Human-in-the-Loop Approvals (RFC 6238 TOTP Step-Up) "),
            );
            f.render_widget(list, area);
        }
        4 => {
            let catalog = scenario_catalog();
            let items: Vec<ListItem> = catalog
                .iter()
                .enumerate()
                .map(|(idx, sc)| {
                    let marker = if idx == app.cursor { "▶ " } else { "  " };
                    ListItem::new(format!(
                        "{}[{}] {} — {}",
                        marker,
                        sc["id"].as_str().unwrap_or(""),
                        sc["title"].as_str().unwrap_or(""),
                        sc["subtitle"].as_str().unwrap_or("")
                    ))
                })
                .collect();
            let list = List::new(items).block(
                Block::default()
                    .borders(Borders::ALL)
                    .title(" Chaos Lab Fault-Injection Exercises (Enter=Run, r=Reset) "),
            );
            f.render_widget(list, area);
        }
        _ => {
            let (valid, rows, _) = app.ctx.db.verify_audit_chain();
            let entries = app.ctx.db.list_audit_entries(25);
            let items: Vec<ListItem> = entries
                .iter()
                .map(|e| {
                    ListItem::new(format!(
                        "  #{:04} {} | {:<26} | {:<18} | sha256={}…",
                        e.id,
                        &e.timestamp[..e.timestamp.len().min(19)],
                        e.event_type,
                        e.actor,
                        &e.entry_hash[..16]
                    ))
                })
                .collect();
            let title = format!(
                " SHA-256 Audit Hash Chain ({} blocks — {}) ",
                rows,
                if valid { "VERIFIED" } else { "BROKEN!" }
            );
            let list = List::new(items).block(Block::default().borders(Borders::ALL).title(title));
            f.render_widget(list, area);
        }
    }
}
