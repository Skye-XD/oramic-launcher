// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Right-click menu for a grid item
//
// Kept to what macOS offers on an application: Open, Show in Finder, Get Info
// and Quick Look. Quick Look and Get Info are one entry here because there is
// not enough to show to justify two, and Share is left out because nothing on
// this desktop would receive it. Remove is the addition.
//
// The menu lives in uiGroup rather than inside the launcher card, so while it
// is up the launcher's own focus-based dismissal has to be held off -- see
// `onGrabChanged`, which the extension uses for exactly that.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { logDebug, idleOnce } from '../utils.js';
import { detectPackage, showInFiles, showProperties } from './appOps.js';
import { showRemoveDialog } from './ItemDialogs.js';

export interface ItemMenuCallbacks {
    /** Launch the application, exactly as a plain click would. */
    activate: () => void;
    /**
     * Raised while the menu or one of its dialogs holds a grab. The launcher
     * dismisses itself when focus leaves its card, which a menu in uiGroup
     * would otherwise trigger immediately.
     */
    onGrabChanged: (held: boolean) => void;
    /** Close the launcher, once an action has taken over from it. */
    dismiss: () => void;
}

export class ItemMenuController {
    private _manager: PopupMenu.PopupMenuManager | null = null;
    private _menu: PopupMenu.PopupMenu | null = null;
    private _anchor: St.Widget | null = null;
    private _owner: Clutter.Actor;

    constructor(owner: Clutter.Actor) {
        this._owner = owner;
    }

    destroy(): void {
        this._menu?.destroy();
        this._menu = null;
        this._anchor?.destroy();
        this._anchor = null;
        this._manager = null;
    }

    /**
     * Open the context menu for one grid item.
     *
     * @param source the item actor the menu points at
     * @param app the application it represents
     * @param cb what the menu is allowed to do to the launcher
     */
    open(app: Shell.App, cb: ItemMenuCallbacks): void {
        // Close before destroying: a menu still holding its grab throws
        // "incorrect pop" when torn down out of order.
        if (this._menu) {
            this._menu.close();
            this._menu.destroy();
            this._menu = null;
        }
        this._anchor?.destroy();

        // A PopupMenu anchors to an actor, so to open at the pointer it gets a
        // one-pixel invisible one placed there. Anchoring to the card instead
        // centred the menu over a 100px tile, which is nowhere near the click.
        const [px, py] = global.get_pointer();
        const anchor = new St.Widget({ x: px, y: py, width: 1, height: 1, opacity: 0 });
        Main.uiGroup.add_child(anchor);
        this._anchor = anchor;

        this._manager ??= new PopupMenu.PopupMenuManager(this._owner);
        // 0.0 aligns the menu's edge to the anchor rather than centring it, so
        // it hangs down-right of the cursor the way a context menu should.
        const menu = new PopupMenu.PopupMenu(anchor as any, 0.0, St.Side.TOP);
        menu.actor.add_style_class_name('ormic-item-menu');
        this._menu = menu;

        // Set when an entry hands over to a dialog, so closing the menu does
        // not release the hold in the gap before that dialog takes its own.
        let handingOver = false;

        const add = (label: string, fn: () => void, opensDialog = false) => {
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => {
                if (opensDialog) handingOver = true;
                menu.close();
                fn();
            });
            menu.addMenuItem(item);
            return item;
        };

        add('Open', () => { cb.activate(); });

        add('Show in Files', () => {
            if (showInFiles(app)) cb.dismiss();
        });

        // Detection is only needed for the two entries below, and it shells
        // out, so it runs once per menu rather than once per click.
        const pkgPromise = detectPackage(app);

        // The file manager's own properties window, not something drawn
        // here: a shell extension runs inside the compositor and cannot map a
        // real toplevel. The launcher goes away first, as macOS closes
        // Launchpad when Get Info opens.
        add('Get Info', () => {
            showProperties(app);
            cb.dismiss();
        });

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const removeItem = add('Uninstall', () => {
            cb.dismiss();
            pkgPromise.then(pkg => {
                showRemoveDialog(app, pkg, () => cb.onGrabChanged(false));
            });
        }, true);

        // Greyed until detection answers: an application no package owns
        // cannot be removed, and saying so up front beats a dialog that only
        // exists to refuse.
        removeItem.setSensitive(false);
        pkgPromise.then(pkg => {
            removeItem.setSensitive(true);
            if (pkg.refusal)
                removeItem.label.set_text('Uninstall (protected)');
        }).catch(() => removeItem.setSensitive(false));

        this._manager.addMenu(menu);
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();

        menu.connect('open-state-changed', (_m: any, isOpen: boolean) => {
            logDebug('ItemMenu', `open-state-changed ${isOpen} handingOver=${handingOver}`);
            // Released on an idle tick, not here: key focus returns to the
            // card after the ungrab, and clearing the hold synchronously
            // leaves a frame where the watcher sees focus nowhere and
            // dismisses the launcher the menu was opened from.
            if (!isOpen && !handingOver)
                idleOnce(() => cb.onGrabChanged(false));
        });

        // Before open(), not from open-state-changed: PopupMenuManager grabs
        // from that same signal and connected first, so by the time our
        // handler ran the grab had already moved key focus, the launcher's
        // focus watcher had dismissed it, and its teardown popped a grab that
        // was no longer top of the stack.
        cb.onGrabChanged(true);
        menu.open();
    }

    /** Whether a menu is currently on screen. */
    get isOpen(): boolean {
        return !!this._menu?.isOpen;
    }

    close(): void {
        this._menu?.close();
    }
}
