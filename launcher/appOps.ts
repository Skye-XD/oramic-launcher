// SPDX-License-Identifier: GPL-2.0-or-later
// Ormic Launcher — Application operations behind the item context menu
//
// Removal is the dangerous one, so the shape here is deliberate:
//
// • Detection reads the .desktop file's *path*, not the application id.
//   Flatpak and snap export their entries into known directories, and rpm can
//   be asked which package owns a file. An id can collide; a path cannot.
//
// • A protected list refuses outright. These are packages whose removal takes
//   the session, the package manager or the boot path with it, and no
//   confirmation prompt is worth offering for them.
//
// • Nothing is removed with an unattended yes until the caller has seen the
//   transaction. `previewRemoval` runs the package manager in its own dry-run
//   mode and returns exactly what it says it would remove, which for rpm is
//   the part that matters: `dnf remove` pulls dependants, so removing one leaf
//   can cascade. The caller shows that list, and only then does `runRemoval`
//   execute the same operation for real.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import { logDebug } from '../utils.js';

export type PackageKind = 'flatpak-user' | 'flatpak-system' | 'rpm' | 'snap' | 'unknown';

export interface PackageInfo {
    kind: PackageKind;
    /** Package or application id as its manager knows it. */
    name: string;
    /** Path of the .desktop entry the application was found through. */
    desktopPath: string | null;
    /** Argv that removes it, shown to the user verbatim before it runs. */
    argv: string[];
    /** Set when removal is refused outright; the reason is user-facing. */
    refusal: string | null;
}

// Removing any of these takes the session, the package manager, or the boot
// path with it. Matched against the owning rpm package name.
const PROTECTED_PACKAGES = new Set([
    'bash', 'coreutils', 'dbus', 'dbus-broker', 'dnf', 'dnf5', 'filesystem',
    'gdm', 'glibc', 'gnome-console', 'gnome-control-center', 'gnome-keyring',
    'gnome-session', 'gnome-settings-daemon', 'gnome-shell', 'gnome-software',
    'grub2-common', 'kernel', 'kernel-core', 'mutter', 'nautilus',
    'NetworkManager', 'pipewire', 'polkit', 'rpm', 'shadow-utils', 'systemd',
    'wireplumber', 'xdg-desktop-portal', 'xdg-desktop-portal-gnome',
]);

function run(argv: string[]): Promise<{ ok: boolean; out: string; err: string }> {
    return new Promise(resolve => {
        let proc: Gio.Subprocess;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            resolve({ ok: false, out: '', err: String(e) });
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, out, err] = (p as Gio.Subprocess).communicate_utf8_finish(res);
                resolve({ ok: (p as Gio.Subprocess).get_successful(), out: out ?? '', err: err ?? '' });
            } catch (e) {
                resolve({ ok: false, out: '', err: String(e) });
            }
        });
    });
}

export function appFromDesktopId(desktopId: string | undefined): Shell.App | null {
    if (!desktopId) return null;
    return Shell.AppSystem.get_default().lookup_app(desktopId) ?? null;
}

export function desktopPathOf(app: Shell.App | null): string | null {
    const info = app?.get_app_info() as any;
    return info?.get_filename?.() ?? null;
}

/**
 * Work out how the application was installed, and how it would be removed.
 *
 * Detection is by .desktop path because that is what the package managers
 * agree on: flatpak and snap export into fixed directories, and rpm answers
 * `-qf` for any file it owns.
 */
export async function detectPackage(app: Shell.App): Promise<PackageInfo> {
    const desktopPath = desktopPathOf(app);
    const base: PackageInfo = {
        kind: 'unknown', name: '', desktopPath, argv: [], refusal: null,
    };

    if (!desktopPath) {
        return { ...base, refusal: _noPathRefusal() };
    }

    // Flatpak exports under .../flatpak/exports/share/applications/<id>.desktop
    if (desktopPath.includes('/flatpak/exports/')) {
        const id = GLib.path_get_basename(desktopPath).replace(/\.desktop$/, '');
        const user = desktopPath.startsWith(GLib.get_home_dir());
        return {
            ...base,
            kind: user ? 'flatpak-user' : 'flatpak-system',
            name: id,
            argv: user
                ? ['flatpak', 'uninstall', '--user', '--assumeyes', id]
                : ['pkexec', 'flatpak', 'uninstall', '--assumeyes', id],
        };
    }

    if (desktopPath.startsWith('/var/lib/snapd/desktop/applications/')) {
        const name = GLib.path_get_basename(desktopPath).replace(/\.desktop$/, '').split('_')[0];
        return {
            ...base, kind: 'snap', name,
            argv: ['pkexec', 'snap', 'remove', name],
        };
    }

    const owner = await run(['rpm', '-qf', '--queryformat', '%{NAME}', desktopPath]);
    if (owner.ok && owner.out && !owner.out.includes('not owned')) {
        const name = owner.out.trim();
        if (PROTECTED_PACKAGES.has(name)) {
            return {
                ...base, kind: 'rpm', name,
                refusal: `${name} is part of the desktop or the package manager. ` +
                    'Removing it would break the session, so this is not offered.',
            };
        }
        return {
            ...base, kind: 'rpm', name,
            argv: ['pkexec', 'dnf', 'remove', '--assumeyes', name],
        };
    }

    return { ...base, refusal: _noPathRefusal() };
}

function _noPathRefusal(): string {
    return 'No package owns this application, so nothing here knows how to ' +
        'remove it. It was probably installed by hand.';
}

/**
 * Ask the package manager what it *would* remove, without removing anything.
 *
 * This is the whole reason removal is a two-step here: `dnf remove` takes
 * dependants with it, so a leaf application can pull a long tail behind it.
 *
 * @param pkg the package to preview
 * @returns lines describing the transaction, or null when it cannot be previewed
 */
export async function previewRemoval(pkg: PackageInfo): Promise<string | null> {
    if (pkg.kind === 'rpm') {
        // --assumeno prints the transaction and exits without doing it.
        const r = await run(['dnf', 'remove', '--assumeno', pkg.name]);
        const text = `${r.out}\n${r.err}`;

        // Parse by section rather than by row shape: dnf prints a header and
        // six columns per package, and there can be several "Removing ...:"
        // blocks (the package, its dependants, then unused dependencies). A
        // blank line ends a block. Row-shape matching was tried and matched
        // nothing at all, which failed silently into dumping raw output.
        const names: string[] = [];
        let size = '';
        let inRemoving = false;
        for (const line of text.split('\n')) {
            if (/^\s*Removing[^:]*:\s*$/.test(line)) { inRemoving = true; continue; }
            if (/^\s*Transaction Summary/.test(line) || !line.trim()) inRemoving = false;
            if (line.startsWith('After this operation')) size = line.trim();
            if (inRemoving) {
                const m = line.match(/^\s+(\S+)\s/);
                if (m) names.push(m[1]);
            }
        }

        if (names.length) {
            const list = names.length > 12
                ? `${names.slice(0, 12).join(', ')} and ${names.length - 12} more`
                : names.join(', ');
            return `${names.length} package(s): ${list}${size ? `\n${size}` : ''}`;
        }
        return text.trim() ? text.trim().split('\n').slice(0, 12).join('\n') : null;
    }

    if (pkg.kind === 'flatpak-user' || pkg.kind === 'flatpak-system')
        return `flatpak application ${pkg.name}`;

    if (pkg.kind === 'snap')
        return `snap ${pkg.name}`;

    return null;
}

/**
 * Remove the package. Only ever called after the caller has shown the user
 * both `pkg.argv` and the preview.
 *
 * @param pkg the package to remove
 * @returns whether it succeeded, with the manager's own output on failure
 */
export async function runRemoval(pkg: PackageInfo): Promise<{ ok: boolean; message: string }> {
    if (pkg.refusal || !pkg.argv.length)
        return { ok: false, message: pkg.refusal ?? 'Nothing to run.' };

    logDebug('appOps', `removing: ${pkg.argv.join(' ')}`);
    const r = await run(pkg.argv);
    if (r.ok)
        return { ok: true, message: '' };

    // pkexec exits 126/127 when the authentication dialog is dismissed.
    const combined = `${r.err}\n${r.out}`.trim();
    return { ok: false, message: combined || 'The removal did not complete.' };
}

/**
 * Reveal the application's .desktop entry in the file manager.
 *
 * @param app the application to reveal
 * @returns whether a path was found to open
 */
export function showInFiles(app: Shell.App): boolean {
    const path = desktopPathOf(app);
    if (!path) return false;

    // The file manager's own D-Bus interface selects the file rather than
    // merely opening its directory, which is what "Show in Finder" does.
    try {
        Gio.DBus.session.call(
            'org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
            'org.freedesktop.FileManager1', 'ShowItems',
            new GLib.Variant('(ass)', [[Gio.File.new_for_path(path).get_uri()], '']),
            null, Gio.DBusCallFlags.NONE, -1, null, null);
        return true;
    } catch (e) {
        logDebug('appOps', `ShowItems failed, opening the folder instead: ${e}`);
        const dir = GLib.path_get_dirname(path);
        Gio.AppInfo.launch_default_for_uri(
            Gio.File.new_for_path(dir).get_uri(), null);
        return true;
    }
}

/**
 * The facts worth showing for an application, as label/value pairs.
 *
 * macOS splits this between Get Info and Quick Look; there is not enough here
 * to justify two surfaces, so it is one.
 *
 * @param app the application to describe
 * @param pkg its package, when already detected
 * @returns rows to render
 */
export function infoRows(app: Shell.App, pkg: PackageInfo | null): [string, string][] {
    const info = app.get_app_info() as any;
    const rows: [string, string][] = [];

    const desc = info?.get_description?.();
    if (desc) rows.push(['Description', desc]);

    const exec = info?.get_executable?.();
    if (exec) rows.push(['Command', exec]);

    const cats = info?.get_categories?.();
    if (cats) rows.push(['Categories', String(cats).replace(/;/g, ', ').replace(/, $/, '')]);

    if (pkg) {
        const kind = pkg.kind === 'flatpak-user' ? 'Flatpak (user)'
            : pkg.kind === 'flatpak-system' ? 'Flatpak (system)'
            : pkg.kind === 'rpm' ? 'RPM package'
            : pkg.kind === 'snap' ? 'Snap'
            : 'Unknown';
        rows.push(['Installed as', pkg.name ? `${kind} — ${pkg.name}` : kind]);
    }

    const path = desktopPathOf(app);
    if (path) rows.push(['Entry', path]);

    return rows;
}
