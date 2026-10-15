// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Grid Item Component

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';

import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { SearchResult } from '../types.js';
import { appFromDesktopId } from '../launcher/appOps.js';
import { logDebug, boxLayoutParams } from '../utils.js';

export class GridItem extends St.Button {
    static {
        GObject.registerClass({ GTypeName: 'OrmicGridItem' }, this);
    }

    declare private _result: SearchResult;
    declare private _iconBin: St.Bin;
    declare private _nameLabel: St.Label;
    declare private _activateCb: (() => void) | null;
    declare private _hoverCb: (() => void) | null;
    declare private _menuCb: (() => void) | null;
    declare private _dragStartCb: (() => void) | null;
    declare private _app: Shell.App | null;
    declare private _iconSize: number;
    declare private _dragProxy: any;
    declare private _dndGesture: any;

    _init() {
        super._init({
            style_class: 'ormic-grid-item',
            reactive: true, track_hover: true, can_focus: false,
        });

        const box = new St.BoxLayout({
            ...boxLayoutParams(true),
            style_class: 'ormic-grid-item-box',
            x_expand: true, y_expand: true,
        });
        (box.layout_manager as Clutter.BoxLayout).spacing = 4;

        this._iconBin = new St.Bin({ style_class: 'ormic-grid-icon-bin' });
        box.add_child(this._iconBin);

        this._nameLabel = new St.Label({
            style_class: 'ormic-grid-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._nameLabel.clutter_text.line_wrap = false;
        box.add_child(this._nameLabel);

        this.set_child(box);

        this.connect('clicked', () => {
            logDebug('GridItem', `clicked on ${this._result.name}`);
            if (this._activateCb) this._activateCb();
        });

        // Secondary press, not 'clicked': St.Button only reports primary
        // there. The card's drag handler runs in the capture phase but lets
        // any button but the first through, so this is reached.
        this.connect('button-press-event', (_a: any, ev: any) => {
            if (ev.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;
            if (!this._menuCb)
                return Clutter.EVENT_PROPAGATE;
            this._menuCb();
            return Clutter.EVENT_STOP;
        });

        this._initDrag();

        this.connect('notify::hover', () => {
            if (this.hover && this._hoverCb) this._hoverCb();
            else if (!this.hover) this.setSelected(false);
        });
    }

    setup(result: SearchResult, onActivate: () => void, onHover: () => void, iconSize = 52,
          onMenu: (() => void) | null = null, onDragStart: (() => void) | null = null) {
        this._result = result;
        this._activateCb = onActivate;
        this._hoverCb = onHover;
        this._menuCb = onMenu;
        this._dragStartCb = onDragStart;
        this._iconSize = iconSize;
        // Items are pooled, so whether this one can be dragged out is decided
        // per result: only an installed application can go into the dock.
        this._app = appFromDesktopId(result.desktopId);
        this._dndGesture.enabled = !!this._app;

        this.setSelected(false);

        const cardW = iconSize + 20;
        const cardH = iconSize + 34;
        const binRadius = Math.round(iconSize * 0.22);
        this.set_style(`width: ${cardW}px; height: ${cardH}px;`);
        this._iconBin.set_style(`width: ${iconSize}px; border-radius: ${binRadius}px;`);

        let iconWidget: any = null;
        if (result.createIcon) {
            iconWidget = result.createIcon(iconSize - 8);
        } else if (result.icon) {
            iconWidget = result.icon;
        }

        if (iconWidget) {
            iconWidget.set_size(iconSize - 8, iconSize - 8);
            this._iconBin.set_child(iconWidget);
        } else {
            this._iconBin.set_child(new St.Icon({
                icon_name: result.iconName ?? 'application-x-executable-symbolic',
                icon_size: iconSize - 8,
                style_class: 'ormic-grid-icon-sym',
            }));
        }

        this._nameLabel.text = result.name;
    }

    get result() { return this._result; }

    /** True when pressing here starts an app drag rather than a card move. */
    get isAppDraggable() { return !!this._app; }

    /**
     * Drag an application out of the grid, onto the dock to keep it there.
     *
     * The dash accepts a drop only from a genuine AppDisplay.AppIcon (and the
     * stock grid's own drag handlers call actor methods on the source), so the
     * drag is carried by a real AppIcon that is never shown: DND reads the
     * delegate only after drag-begin, which is where it is made. The overview's
     * item-drag signals are what make the dock open a gap under the pointer and
     * close it again, exactly as for a drag that starts on a dock icon.
     */
    _initDrag() {
        this._dragProxy = null;
        const draggable = DND.makeDraggable(this, {});
        this._dndGesture = this.get_actions().find((a: any) => a instanceof St.DndStartGesture);

        draggable.connect('drag-begin', () => {
            if (!this._app) return;
            const proxy: any = new AppDisplay.AppIcon(this._app, { isDraggable: false });
            const size = this._iconSize - 8;
            proxy.getDragActor = () => this._app!.create_icon_texture(size);
            proxy.getDragActorSource = () => this._iconBin;
            this._dragProxy = proxy;
            (this as any)._delegate = proxy;
            Main.overview.beginItemDrag(proxy);
            // The launcher covers the dock; get out of the way, as Launchpad
            // does once an icon is dragged out of it.
            this._dragStartCb?.();
        });
        draggable.connect('drag-cancelled', () => {
            if (this._dragProxy) Main.overview.cancelledItemDrag(this._dragProxy);
        });
        draggable.connect('drag-end', () => {
            const proxy = this._dragProxy;
            if (!proxy) return;
            Main.overview.endItemDrag(proxy);
            this._dragProxy = null;
            (this as any)._delegate = null;
            proxy.destroy();
        });
    }

    setSelected(on: boolean) {
        if (on) this.add_style_class_name('selected');
        else this.remove_style_class_name('selected');
    }
}