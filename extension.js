import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Rsvg from 'gi://Rsvg';
import cairo from 'gi://cairo';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// ─── Pricing per million tokens (USD) ───────────────────────────────────────

const MODEL_PRICING = {
    'opus':   {input: 15.0,  output: 75.0, cache_read: 1.50,  cache_write: 18.75},
    'sonnet': {input: 3.0,   output: 15.0, cache_read: 0.30,  cache_write: 3.75},
    'haiku':  {input: 0.80,  output: 4.0,  cache_read: 0.08,  cache_write: 1.0},
};

const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';

// ─── Progress bar helpers ───────────────────────────────────────────────────

const BAR_FILLED = '\u2588';  // █
const BAR_EMPTY  = '\u2591';  // ░
const BAR_WIDTH  = 15;

function makeProgressBar(pct) {
    const clamped = Math.max(0, Math.min(100, pct));
    const filled = Math.round((clamped / 100) * BAR_WIDTH);
    const empty = BAR_WIDTH - filled;
    return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(empty);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTokens(count) {
    if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`;
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
    return `${count}`;
}

function formatCost(cost) {
    if (cost >= 100) return `$${cost.toFixed(0)}`;
    if (cost >= 10)  return `$${cost.toFixed(1)}`;
    return `$${cost.toFixed(2)}`;
}

function getPricing(modelName) {
    const name = (modelName || '').toLowerCase();
    if (name.includes('opus'))   return MODEL_PRICING.opus;
    if (name.includes('sonnet')) return MODEL_PRICING.sonnet;
    if (name.includes('haiku'))  return MODEL_PRICING.haiku;
    return MODEL_PRICING.sonnet;
}

function formatTimeRemaining(resetIso) {
    if (!resetIso) return '';
    try {
        const resetMs = Date.parse(resetIso);
        const nowMs = Date.now();
        let diffSec = Math.max(0, Math.floor((resetMs - nowMs) / 1000));
        if (diffSec <= 0) return 'now';
        const hours = Math.floor(diffSec / 3600);
        diffSec %= 3600;
        const mins = Math.floor(diffSec / 60);
        if (hours > 0) return `${hours}h ${mins}m`;
        return `${mins}m`;
    } catch (_) {
        return '';
    }
}

function todayDateStr() {
    return GLib.DateTime.new_now_utc().format('%Y-%m-%d');
}

function thisMonthPrefix() {
    return GLib.DateTime.new_now_utc().format('%Y-%m');
}

// ─── Read OAuth credentials ─────────────────────────────────────────────────

function readOAuthToken() {
    const credPath = GLib.build_filenamev([GLib.get_home_dir(), '.claude', '.credentials.json']);
    try {
        const [ok, contents] = GLib.file_get_contents(credPath);
        if (!ok) return null;
        const text = new TextDecoder('utf-8').decode(contents);
        const creds = JSON.parse(text);
        const oauth = creds.claudeAiOauth;
        if (!oauth || !oauth.accessToken) return null;
        if (oauth.expiresAt && oauth.expiresAt < Date.now()) return null;
        return {
            token: oauth.accessToken,
            plan: oauth.subscriptionType || 'unknown',
            tier: oauth.rateLimitTier || '',
        };
    } catch (_) {
        return null;
    }
}

// ─── Local usage scanner ────────────────────────────────────────────────────

function scanUsageFromLogs() {
    const summary = {
        dailyCost: 0, monthlyCost: 0,
        dailyInput: 0, dailyOutput: 0,
        monthlyInput: 0, monthlyOutput: 0,
        byModelToday: {},
        byModelMonth: {},
        sessionCount: 0,
        error: null,
    };

    const projectsDir = GLib.build_filenamev([GLib.get_home_dir(), '.claude', 'projects']);
    const projectsDirFile = Gio.File.new_for_path(projectsDir);
    if (!projectsDirFile.query_exists(null)) {
        summary.error = 'No Claude data found (~/.claude/projects)';
        return summary;
    }

    const today = todayDateStr();
    const monthPrefix = thisMonthPrefix();

    const jsonlFiles = [];
    collectJsonlFiles(projectsDirFile, jsonlFiles);

    for (const filePath of jsonlFiles) {
        const file = Gio.File.new_for_path(filePath);
        try {
            const info = file.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
            const mtime = info.get_modification_date_time();
            if (mtime && mtime.format('%Y-%m') < monthPrefix)
                continue;
        } catch (_) {
            continue;
        }

        try {
            const [ok, contents] = GLib.file_get_contents(filePath);
            if (!ok) continue;

            const text = new TextDecoder('utf-8').decode(contents);
            const lines = text.split('\n');
            let sessionCounted = false;

            for (const line of lines) {
                if (!line || !line.includes('"usage"'))
                    continue;

                let entry;
                try { entry = JSON.parse(line); } catch (_) { continue; }

                const msg = entry.message;
                if (!msg || !msg.usage) continue;

                const timestamp = entry.timestamp || '';
                if (!timestamp) continue;

                const dateStr = timestamp.substring(0, 10);
                const monthStr = timestamp.substring(0, 7);
                if (monthStr < monthPrefix) continue;

                const usage = msg.usage;
                const model = msg.model || 'unknown';
                const pricing = getPricing(model);

                const inputTok = usage.input_tokens || 0;
                const outputTok = usage.output_tokens || 0;
                const cacheRead = usage.cache_read_input_tokens || 0;
                const cacheWrite = usage.cache_creation_input_tokens || 0;

                const totalInput = inputTok + cacheRead;
                const cost =
                    (inputTok / 1e6) * pricing.input +
                    (cacheRead / 1e6) * pricing.cache_read +
                    (cacheWrite / 1e6) * pricing.cache_write +
                    (outputTok / 1e6) * pricing.output;

                summary.monthlyCost += cost;
                summary.monthlyInput += totalInput;
                summary.monthlyOutput += outputTok;

                if (!summary.byModelMonth[model])
                    summary.byModelMonth[model] = {cost: 0, input: 0, output: 0};
                summary.byModelMonth[model].cost += cost;
                summary.byModelMonth[model].input += totalInput;
                summary.byModelMonth[model].output += outputTok;

                if (dateStr === today) {
                    summary.dailyCost += cost;
                    summary.dailyInput += totalInput;
                    summary.dailyOutput += outputTok;

                    if (!summary.byModelToday[model])
                        summary.byModelToday[model] = {cost: 0, input: 0, output: 0};
                    summary.byModelToday[model].cost += cost;
                    summary.byModelToday[model].input += totalInput;
                    summary.byModelToday[model].output += outputTok;

                    if (!sessionCounted) {
                        summary.sessionCount++;
                        sessionCounted = true;
                    }
                }
            }
        } catch (_) {
            continue;
        }
    }

    return summary;
}

function collectJsonlFiles(dir, result) {
    try {
        const enumerator = dir.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE, null
        );
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            const child = dir.get_child(name);
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                collectJsonlFiles(child, result);
            else if (name.endsWith('.jsonl') && !name.endsWith('.wakatime'))
                result.push(child.get_path());
        }
        enumerator.close(null);
    } catch (_) {}
}

// ─── Extension ──────────────────────────────────────────────────────────────

export default class ClaudeMonitorExtension extends Extension {

    enable() {
        this._settings = this.getSettings();
        this._session = new Soup.Session();
        this._cancellable = new Gio.Cancellable();
        this._rateLimit = null;
        this._enabled = true;

        // Build indicator
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});

        // Custom drawn icon: Claude logo + session clock arc
        this._iconPath = GLib.build_filenamev([this.path, 'icons', 'claude-symbolic.svg']);
        this._sessionPct = 0;

        this._canvas = new St.DrawingArea({
            width: 20,
            height: 20,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._canvasRepaintId = this._canvas.connect('repaint', (area) => {
            this._drawIcon(area);
        });

        this._label = new St.Label({
            text: ' \u2026',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._canvas);
        box.add_child(this._label);
        this._indicator.add_child(box);

        this._buildMenu();
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'left');

        this._settingsChangedId = this._settings.connect('changed', () => {
            this._restartTimer();
        });

        this._refresh();
        this._startTimer();
    }

    disable() {
        this._enabled = false;

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        this._stopTimer();

        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (this._canvas && this._canvasRepaintId) {
            this._canvas.disconnect(this._canvasRepaintId);
            this._canvasRepaintId = null;
        }

        this._session = null;
        this._rateLimit = null;
        this._settings = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._label = null;
        this._canvas = null;
    }

    // ─── Icon drawing ───────────────────────────────────────────────────

    _drawIcon(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const size = Math.min(w, h);
        const cx = w / 2;
        const cy = h / 2;
        const r = size / 2 - 1;

        // Get the panel foreground color from theme
        const themeNode = area.get_theme_node();
        const color = themeNode.get_foreground_color();
        const fr = color.red / 255;
        const fg = color.green / 255;
        const fb = color.blue / 255;
        const fa = color.alpha / 255;

        // Draw the Claude logo SVG
        try {
            const handle = Rsvg.Handle.new_from_file(this._iconPath);
            const dim = handle.get_intrinsic_dimensions();
            const svgW = dim.out_width?.length || 1200;
            const svgH = dim.out_height?.length || 1200;

            cr.save();
            // Scale SVG to fit in icon area with padding for the arc
            const iconSize = size * 0.7;
            const scale = iconSize / Math.max(svgW, svgH);
            const offsetX = cx - (svgW * scale) / 2;
            const offsetY = cy - (svgH * scale) / 2;
            cr.translate(offsetX, offsetY);
            cr.scale(scale, scale);

            // Render SVG with theme color
            cr.setSourceRGBA(fr, fg, fb, fa);
            const viewport = new Rsvg.Rectangle({x: 0, y: 0, width: svgW, height: svgH});
            handle.render_document(cr, viewport);
            cr.restore();
        } catch (e) {
            // Fallback: draw a simple dot
            cr.setSourceRGBA(fr, fg, fb, fa);
            cr.arc(cx, cy, size * 0.25, 0, 2 * Math.PI);
            cr.fill();
        }

        // Draw session usage arc (clock-style, from 12 o'clock clockwise)
        const pct = this._sessionPct;
        if (pct > 0) {
            const startAngle = -Math.PI / 2;  // 12 o'clock
            const endAngle = startAngle + (pct / 100) * 2 * Math.PI;
            const arcR = r;

            // Color based on usage level
            if (pct >= 80) {
                cr.setSourceRGBA(1.0, 0.3, 0.3, 0.9);       // red
            } else if (pct >= 50) {
                cr.setSourceRGBA(1.0, 0.75, 0.2, 0.9);      // amber
            } else {
                cr.setSourceRGBA(1.0, 1.0, 1.0, 0.7);       // white
            }

            cr.setLineWidth(1.5);
            cr.arc(cx, cy, arcR, startAngle, endAngle);
            cr.stroke();
        }

        // Faint full circle outline (white)
        cr.setSourceRGBA(1.0, 1.0, 1.0, 0.2);
        cr.setLineWidth(1.0);
        cr.arc(cx, cy, r, 0, 2 * Math.PI);
        cr.stroke();

        cr.$dispose();
    }

    // ─── Timer ──────────────────────────────────────────────────────────

    _startTimer() {
        const interval = this._settings.get_int('refresh-interval');
        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, interval,
            () => {
                if (!this._enabled) return GLib.SOURCE_REMOVE;
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = null;
        }
    }

    _restartTimer() {
        this._stopTimer();
        this._startTimer();
    }

    // ─── Menu ───────────────────────────────────────────────────────────

    _buildMenu() {
        const menu = this._indicator.menu;
        menu.removeAll();

        const rlHeader = new PopupMenu.PopupMenuItem('Plan Usage', {reactive: false});
        menu.addMenuItem(rlHeader);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._planItem = new PopupMenu.PopupMenuItem('  Plan: loading\u2026', {reactive: false});
        menu.addMenuItem(this._planItem);

        this._fiveHourItem = new PopupMenu.PopupMenuItem('  Session: loading\u2026', {reactive: false});
        menu.addMenuItem(this._fiveHourItem);

        this._sevenDayItem = new PopupMenu.PopupMenuItem('  Weekly: loading\u2026', {reactive: false});
        menu.addMenuItem(this._sevenDayItem);

        this._sevenDaySonnetItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._sevenDaySonnetItem.visible = false;
        menu.addMenuItem(this._sevenDaySonnetItem);

        this._sevenDayOpusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._sevenDayOpusItem.visible = false;
        menu.addMenuItem(this._sevenDayOpusItem);

        this._extraUsageItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._extraUsageItem.visible = false;
        menu.addMenuItem(this._extraUsageItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Token Usage'));

        this._dailyItem = new PopupMenu.PopupMenuItem('Today: loading\u2026', {reactive: false});
        menu.addMenuItem(this._dailyItem);

        this._monthlyItem = new PopupMenu.PopupMenuItem('This month: loading\u2026', {reactive: false});
        menu.addMenuItem(this._monthlyItem);

        this._tokensInItem = new PopupMenu.PopupMenuItem('  Input:  \u2026', {reactive: false});
        menu.addMenuItem(this._tokensInItem);

        this._tokensOutItem = new PopupMenu.PopupMenuItem('  Output: \u2026', {reactive: false});
        menu.addMenuItem(this._tokensOutItem);

        this._sessionsItem = new PopupMenu.PopupMenuItem('  Sessions: \u2026', {reactive: false});
        menu.addMenuItem(this._sessionsItem);

        this._modelTodaySection = new PopupMenu.PopupSubMenuMenuItem('By Model (Today)');
        menu.addMenuItem(this._modelTodaySection);

        this._modelMonthSection = new PopupMenu.PopupSubMenuMenuItem('By Model (Month)');
        menu.addMenuItem(this._modelMonthSection);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._statusItem = new PopupMenu.PopupMenuItem('Last update: never', {reactive: false});
        menu.addMenuItem(this._statusItem);

        this._errorItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this._errorItem.visible = false;
        menu.addMenuItem(this._errorItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refreshItem = new PopupMenu.PopupMenuItem('\u21bb Refresh Now');
        refreshItem.connect('activate', () => this._refresh());
        menu.addMenuItem(refreshItem);

        const settingsItem = new PopupMenu.PopupMenuItem('\u2699 Settings');
        settingsItem.connect('activate', () => this.openPreferences());
        menu.addMenuItem(settingsItem);
    }

    // ─── Data ───────────────────────────────────────────────────────────

    _refresh() {
        if (!this._enabled) return;
        const summary = scanUsageFromLogs();
        this._updateLocalDisplay(summary);
        this._fetchRateLimits();
    }

    _fetchRateLimits() {
        if (!this._enabled) return;

        const oauth = readOAuthToken();
        if (!oauth) {
            this._planItem.label.set_text('  Plan: not logged in');
            this._fiveHourItem.label.set_text('  Session: n/a');
            this._sevenDayItem.label.set_text('  Weekly: n/a');
            return;
        }

        this._planItem.label.set_text(
            `  Plan: ${oauth.plan}${oauth.tier ? ` (${oauth.tier.replace(/^default_claude_/, '')})` : ''}`
        );

        const message = Soup.Message.new('GET', USAGE_API_URL);
        message.request_headers.append('Authorization', `Bearer ${oauth.token}`);
        message.request_headers.append('anthropic-beta', 'oauth-2025-04-20');

        this._session.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, this._cancellable,
            (session, result) => {
                if (!this._enabled) return;

                try {
                    const bytes = session.send_and_read_finish(result);
                    const statusCode = message.get_status();

                    if (statusCode === 429) {
                        this._errorItem.label.set_text('\u26a0 Usage API rate limited, showing cached data');
                        this._errorItem.visible = true;
                        return;
                    }

                    if (statusCode !== 200) {
                        console.error(`[Claude Monitor] Usage API: HTTP ${statusCode}`);
                        this._fiveHourItem.label.set_text('  Session: API error');
                        this._sevenDayItem.label.set_text('  Weekly: API error');
                        return;
                    }

                    const text = new TextDecoder('utf-8').decode(bytes.get_data());
                    const data = JSON.parse(text);
                    this._rateLimit = data;
                    this._updateRateLimitDisplay(data);
                    this._errorItem.visible = false;
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.error(`[Claude Monitor] Usage API error: ${e.message}`);
                }
            }
        );
    }

    _updateRateLimitDisplay(rl) {
        if (!this._enabled) return;

        if (rl.five_hour) {
            const pct = rl.five_hour.utilization;
            const reset = formatTimeRemaining(rl.five_hour.resets_at);
            const bar = makeProgressBar(pct);
            this._fiveHourItem.label.set_text(
                `  Session  ${bar}  ${pct.toFixed(0)}%${reset ? `  \u23f1 ${reset}` : ''}`
            );
        }

        if (rl.seven_day) {
            const pct = rl.seven_day.utilization;
            const reset = formatTimeRemaining(rl.seven_day.resets_at);
            const bar = makeProgressBar(pct);
            this._sevenDayItem.label.set_text(
                `  Weekly   ${bar}  ${pct.toFixed(0)}%${reset ? `  \u23f1 ${reset}` : ''}`
            );
        }

        if (rl.seven_day_sonnet) {
            const pct = rl.seven_day_sonnet.utilization;
            const reset = formatTimeRemaining(rl.seven_day_sonnet.resets_at);
            const bar = makeProgressBar(pct);
            this._sevenDaySonnetItem.label.set_text(
                `  Sonnet   ${bar}  ${pct.toFixed(0)}%${reset ? `  \u23f1 ${reset}` : ''}`
            );
            this._sevenDaySonnetItem.visible = true;
        } else {
            this._sevenDaySonnetItem.visible = false;
        }

        if (rl.seven_day_opus) {
            const pct = rl.seven_day_opus.utilization;
            const reset = formatTimeRemaining(rl.seven_day_opus.resets_at);
            const bar = makeProgressBar(pct);
            this._sevenDayOpusItem.label.set_text(
                `  Opus     ${bar}  ${pct.toFixed(0)}%${reset ? `  \u23f1 ${reset}` : ''}`
            );
            this._sevenDayOpusItem.visible = true;
        } else {
            this._sevenDayOpusItem.visible = false;
        }

        if (rl.extra_usage) {
            const eu = rl.extra_usage;
            if (eu.is_enabled) {
                const bar = makeProgressBar(eu.utilization);
                this._extraUsageItem.label.set_text(
                    `  Extra    ${bar}  ${formatCost(eu.used_credits)} / ${formatCost(eu.monthly_limit)}`
                );
            } else {
                this._extraUsageItem.label.set_text('  Extra usage: disabled');
            }
            this._extraUsageItem.visible = true;
        } else {
            this._extraUsageItem.visible = false;
        }

        // Update icon arc
        if (rl.five_hour) {
            this._sessionPct = rl.five_hour.utilization;
            this._canvas?.queue_repaint();
        }

        this._updatePanelLabel();
    }

    _updatePanelLabel() {
        if (!this._enabled) return;

        const mode = this._settings.get_string('display-mode');
        const rl = this._rateLimit;

        if (mode === 'tokens') return;

        if (rl && rl.five_hour) {
            const showSession = this._settings.get_boolean('panel-show-session');
            const showWeekly = this._settings.get_boolean('panel-show-weekly');
            const h5 = rl.five_hour.utilization;
            const d7 = rl.seven_day ? rl.seven_day.utilization : 0;

            const parts = [];
            if (showSession) parts.push(`S ${h5.toFixed(0)}%`);
            if (showWeekly)  parts.push(`W ${d7.toFixed(0)}%`);

            if (parts.length > 0)
                this._label.set_text(` ${parts.join(' \u2502 ')}`);
            else
                this._label.set_text('');
        }
    }

    _updateLocalDisplay(s) {
        if (!this._enabled) return;

        if (s.error) {
            this._errorItem.label.set_text(`\u26a0 ${s.error}`);
            this._errorItem.visible = true;
        }

        const mode = this._settings.get_string('display-mode');
        if (mode === 'tokens')
            this._label.set_text(` ${formatTokens(s.dailyInput + s.dailyOutput)} tok`);
        else if (!this._rateLimit)
            this._label.set_text(` ${formatCost(s.dailyCost)}/day`);

        this._dailyItem.label.set_text(
            `Today: ${formatCost(s.dailyCost)}  (${formatTokens(s.dailyInput)} in / ${formatTokens(s.dailyOutput)} out)`
        );
        this._monthlyItem.label.set_text(
            `This month: ${formatCost(s.monthlyCost)}  (${formatTokens(s.monthlyInput)} in / ${formatTokens(s.monthlyOutput)} out)`
        );
        this._tokensInItem.label.set_text(`  Input:  ${formatTokens(s.dailyInput)} tokens`);
        this._tokensOutItem.label.set_text(`  Output: ${formatTokens(s.dailyOutput)} tokens`);
        this._sessionsItem.label.set_text(`  Sessions: ${s.sessionCount}`);

        this._modelTodaySection.menu.removeAll();
        const modelsToday = Object.entries(s.byModelToday).sort((a, b) => b[1].cost - a[1].cost);
        if (modelsToday.length === 0) {
            this._modelTodaySection.menu.addMenuItem(
                new PopupMenu.PopupMenuItem('No usage today', {reactive: false})
            );
        } else {
            for (const [model, data] of modelsToday) {
                const shortName = model.replace(/^claude-/, '').replace(/-\d.*$/, '');
                const text = `${shortName}: ${formatCost(data.cost)} (${formatTokens(data.input)} in / ${formatTokens(data.output)} out)`;
                this._modelTodaySection.menu.addMenuItem(
                    new PopupMenu.PopupMenuItem(text, {reactive: false})
                );
            }
        }

        this._modelMonthSection.menu.removeAll();
        const modelsMonth = Object.entries(s.byModelMonth).sort((a, b) => b[1].cost - a[1].cost);
        if (modelsMonth.length === 0) {
            this._modelMonthSection.menu.addMenuItem(
                new PopupMenu.PopupMenuItem('No usage this month', {reactive: false})
            );
        } else {
            for (const [model, data] of modelsMonth) {
                const shortName = model.replace(/^claude-/, '').replace(/-\d.*$/, '');
                const text = `${shortName}: ${formatCost(data.cost)} (${formatTokens(data.input)} in / ${formatTokens(data.output)} out)`;
                this._modelMonthSection.menu.addMenuItem(
                    new PopupMenu.PopupMenuItem(text, {reactive: false})
                );
            }
        }

        const now = GLib.DateTime.new_now_local();
        this._statusItem.label.set_text(`Last update: ${now.format('%H:%M:%S')}`);
    }
}
