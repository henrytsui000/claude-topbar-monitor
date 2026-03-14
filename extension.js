import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

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

function todayDateStr() {
    return GLib.DateTime.new_now_utc().format('%Y-%m-%d');
}

function thisMonthPrefix() {
    return GLib.DateTime.new_now_utc().format('%Y-%m');
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
        this._enabled = true;

        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            icon_name: 'dialog-information-symbolic',
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            text: 'Claude: \u2026',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this._indicator.add_child(box);

        this._buildMenu();
        Main.panel.addToStatusArea(this.uuid, this._indicator);

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
        this._settings = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._label = null;
        this._icon = null;
    }

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

    _buildMenu() {
        const menu = this._indicator.menu;
        menu.removeAll();

        const header = new PopupMenu.PopupMenuItem('Claude Code Usage', {reactive: false});
        menu.addMenuItem(header);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._dailyItem = new PopupMenu.PopupMenuItem('Today: loading\u2026', {reactive: false});
        menu.addMenuItem(this._dailyItem);

        this._monthlyItem = new PopupMenu.PopupMenuItem('This month: loading\u2026', {reactive: false});
        menu.addMenuItem(this._monthlyItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Tokens Today'));

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

    _refresh() {
        if (!this._enabled) return;
        const summary = scanUsageFromLogs();
        this._updateDisplay(summary);
    }

    _updateDisplay(s) {
        if (!this._enabled) return;

        if (s.error) {
            this._errorItem.label.set_text(`\u26a0 ${s.error}`);
            this._errorItem.visible = true;
        } else {
            this._errorItem.visible = false;
        }

        const mode = this._settings.get_string('display-mode');
        if (mode === 'tokens')
            this._label.set_text(`Claude: ${formatTokens(s.dailyInput + s.dailyOutput)} tok`);
        else if (mode === 'both')
            this._label.set_text(`Claude: ${formatCost(s.dailyCost)} | ${formatTokens(s.dailyInput + s.dailyOutput)}`);
        else
            this._label.set_text(`Claude: ${formatCost(s.dailyCost)}/day`);

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
