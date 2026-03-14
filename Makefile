UUID = claude-monitor@henrytsui.dev
EXT_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
DIST_FILES = extension.js prefs.js metadata.json stylesheet.css schemas/

.PHONY: build install uninstall pack clean

build:
	glib-compile-schemas schemas/

install: build
	mkdir -p $(EXT_DIR)
	cp extension.js prefs.js metadata.json stylesheet.css $(EXT_DIR)/
	cp -r schemas $(EXT_DIR)/
	@echo ""
	@echo "Installed. Restart GNOME Shell, then run:"
	@echo "  gnome-extensions enable $(UUID)"

uninstall:
	gnome-extensions disable $(UUID) 2>/dev/null || true
	rm -rf $(EXT_DIR)

pack: build
	@rm -f $(UUID).zip
	zip -r $(UUID).zip $(DIST_FILES)
	@echo "Created $(UUID).zip — ready for extensions.gnome.org"

clean:
	rm -f schemas/gschemas.compiled
	rm -f $(UUID).zip
