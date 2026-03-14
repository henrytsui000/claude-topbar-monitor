import Gio from 'gi://Gio';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _}
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ClaudeMonitorPreferences extends ExtensionPreferences {

    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('Settings'),
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        // ─── Info ───────────────────────────────────────────────────────

        const infoGroup = new Adw.PreferencesGroup({
            title: _('Data Source'),
            description: _('Usage is read from local Claude Code session logs in ~/.claude/projects/'),
        });
        page.add(infoGroup);

        // ─── Refresh ────────────────────────────────────────────────────

        const refreshGroup = new Adw.PreferencesGroup({
            title: _('Refresh'),
        });
        page.add(refreshGroup);

        const refreshRow = new Adw.SpinRow({
            title: _('Refresh Interval'),
            subtitle: _('How often to scan session logs (seconds)'),
            adjustment: new Gtk.Adjustment({
                lower: 30,
                upper: 3600,
                step_increment: 30,
                page_increment: 300,
                value: settings.get_int('refresh-interval'),
            }),
        });
        refreshGroup.add(refreshRow);
        settings.bind('refresh-interval', refreshRow, 'value', Gio.SettingsBindFlags.DEFAULT);

        // ─── Display ────────────────────────────────────────────────────

        const displayGroup = new Adw.PreferencesGroup({
            title: _('Panel Display'),
        });
        page.add(displayGroup);

        const modeRow = new Adw.ComboRow({
            title: _('Top Bar Display'),
            subtitle: _('What to show in the panel'),
            model: Gtk.StringList.new(['Daily Cost', 'Token Count', 'Both']),
        });
        displayGroup.add(modeRow);

        const modeMap = ['cost', 'tokens', 'both'];
        const currentMode = settings.get_string('display-mode');
        modeRow.set_selected(Math.max(0, modeMap.indexOf(currentMode)));

        modeRow.connect('notify::selected', () => {
            settings.set_string('display-mode', modeMap[modeRow.get_selected()] || 'cost');
        });

        settings.connect('changed::display-mode', () => {
            const mode = settings.get_string('display-mode');
            modeRow.set_selected(Math.max(0, modeMap.indexOf(mode)));
        });

        // ─── Panel Indicators ─────────────────────────────────────────

        const indicatorGroup = new Adw.PreferencesGroup({
            title: _('Panel Indicators'),
            description: _('Choose which rate limits to show in the top bar'),
        });
        page.add(indicatorGroup);

        const sessionRow = new Adw.SwitchRow({
            title: _('Session (S)'),
            subtitle: _('5-hour rolling usage window'),
        });
        indicatorGroup.add(sessionRow);
        settings.bind('panel-show-session', sessionRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        const weeklyRow = new Adw.SwitchRow({
            title: _('Weekly (W)'),
            subtitle: _('7-day rolling usage window'),
        });
        indicatorGroup.add(weeklyRow);
        settings.bind('panel-show-weekly', weeklyRow, 'active', Gio.SettingsBindFlags.DEFAULT);

        // ─── Position ─────────────────────────────────────────────────

        const positionGroup = new Adw.PreferencesGroup({
            title: _('Position'),
        });
        page.add(positionGroup);

        const positionRow = new Adw.ComboRow({
            title: _('Panel Position'),
            subtitle: _('Where to place the indicator (requires restart)'),
            model: Gtk.StringList.new(['Left', 'Right']),
        });
        positionGroup.add(positionRow);

        const posMap = ['left', 'right'];
        const currentPos = settings.get_string('panel-position');
        positionRow.set_selected(Math.max(0, posMap.indexOf(currentPos)));

        positionRow.connect('notify::selected', () => {
            settings.set_string('panel-position', posMap[positionRow.get_selected()] || 'left');
        });

        settings.connect('changed::panel-position', () => {
            const pos = settings.get_string('panel-position');
            positionRow.set_selected(Math.max(0, posMap.indexOf(pos)));
        });
    }
}
