// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Removal confirmation for the item context menu

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Shell from 'gi://Shell';
import Pango from 'gi://Pango';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import { PackageInfo, previewRemoval, runRemoval } from './appOps.js';

function wrapped(text: string, styleClass: string): St.Label {
    const label = new St.Label({ text, style_class: styleClass });
    const ct = label.clutter_text as any;
    ct?.set_line_wrap?.(true);
    ct?.set_ellipsize?.(Pango.EllipsizeMode.NONE);
    return label;
}

function header(app: Shell.App, subtitle: string): St.BoxLayout {
    const row = new St.BoxLayout({ style_class: 'prompt-dialog-main-layout', vertical: false });
    const icon = (app as any).create_icon_texture?.(48);
    if (icon) row.add_child(icon);

    const col = new St.BoxLayout({ vertical: true, y_align: Clutter.ActorAlign.CENTER });
    col.add_child(wrapped(app.get_name() ?? '', 'prompt-dialog-headline'));
    if (subtitle)
        col.add_child(wrapped(subtitle, 'prompt-dialog-description'));
    row.add_child(col);
    return row;
}

/**
 * Remove, in two steps.
 *
 * The first dialog states what will run and what the package manager says it
 * would take with it, because `dnf remove` pulls dependants and a leaf
 * application can drag a long tail behind it. Only after that is the same
 * operation run for real, under pkexec where privilege is needed.
 *
 * A refusal is shown as a plain message with no confirm button at all: for the
 * packages that carry the session there is no prompt worth offering.
 *
 * @param app the application being removed
 * @param pkg its detected package
 * @param onFinished called once the dialog closes, with whether it removed
 */
export function showRemoveDialog(
    app: Shell.App,
    pkg: PackageInfo,
    onFinished: (removed: boolean) => void,
): void {
    if (pkg.refusal) {
        const dialog = new ModalDialog.ModalDialog({ styleClass: 'prompt-dialog' });
        dialog.contentLayout.add_child(header(app, pkg.refusal));
        dialog.addButton({
            label: 'Close',
            action: () => { dialog.close(); onFinished(false); },
            key: Clutter.KEY_Escape,
            default: true,
        });
        dialog.open();
        return;
    }

    const dialog = new ModalDialog.ModalDialog({ styleClass: 'prompt-dialog' });
    dialog.contentLayout.add_child(
        header(app, `Remove this application from the system?`));

    const detail = new St.BoxLayout({ vertical: true, style_class: 'prompt-dialog-main-layout' });
    detail.add_child(wrapped(`Runs:  ${pkg.argv.join(' ')}`, 'prompt-dialog-description'));

    const previewLabel = wrapped('Checking what this would remove…', 'prompt-dialog-description');
    detail.add_child(previewLabel);
    dialog.contentLayout.add_child(detail);

    // The transaction is the part worth reading, so the confirm button stays
    // out of reach until it has actually been fetched.
    let confirmButton: any = null;

    previewRemoval(pkg).then(preview => {
        previewLabel.set_text(preview
            ? `Removes:  ${preview}`
            : 'The package manager did not report what it would remove.');
        confirmButton?.set_reactive(true);
        confirmButton?.remove_style_pseudo_class?.('insensitive');
    }).catch(() => {
        previewLabel.set_text('Could not check what this would remove.');
        confirmButton?.set_reactive(true);
        confirmButton?.remove_style_pseudo_class?.('insensitive');
    });

    dialog.addButton({
        label: 'Cancel',
        action: () => { dialog.close(); onFinished(false); },
        key: Clutter.KEY_Escape,
    });

    confirmButton = dialog.addButton({
        label: 'Remove',
        action: () => {
            previewLabel.set_text('Removing…');
            runRemoval(pkg).then(result => {
                dialog.close();
                if (!result.ok)
                    showFailureDialog(app, result.message);
                onFinished(result.ok);
            });
        },
    });
    confirmButton?.set_reactive(false);
    confirmButton?.add_style_pseudo_class?.('insensitive');

    dialog.open();
}

function showFailureDialog(app: Shell.App, message: string): void {
    const dialog = new ModalDialog.ModalDialog({ styleClass: 'prompt-dialog' });
    dialog.contentLayout.add_child(header(app, 'The application was not removed.'));
    dialog.contentLayout.add_child(
        wrapped(message.split('\n').slice(0, 8).join('\n'), 'prompt-dialog-description'));
    dialog.addButton({
        label: 'Close',
        action: () => dialog.close(),
        key: Clutter.KEY_Escape,
        default: true,
    });
    dialog.open();
}
