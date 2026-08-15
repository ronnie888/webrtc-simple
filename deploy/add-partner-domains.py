#!/usr/bin/env python3
"""Add 4 partner domains to an enumero node: nginx maps + CSP + embed.html gate,
plus a favicon 204 rule. Surgical inserts only - NEVER regenerates from template
(regen wipes the /admin block; see ENUMERO guide section 7).

Idempotent: re-running is a no-op. Writes timestamped backups. Verifies the
/admin block survives before it will let nginx -t run.
"""
import re
import shutil
import sys
import time

# Usage: sudo python3 add-partner-domains.py <anchor-domain> <new> [new...]
# The anchor is any partner ALREADY present in all three layers on this node;
# each new domain is inserted as its twin. Defaults match the 2026-08-12
# enumero rollout.
NEW = sys.argv[2:] or ['gamespanalo.com', 'gamespanalo.net', 'gamespanalo.app', 'paldohere.vip']
ANCHOR = sys.argv[1] if len(sys.argv) > 1 else 'paldohere.net'

NGINX = '/etc/nginx/nginx.conf'
EMBED = '/var/www/webrtc-simple/embed.html'
STAMP = time.strftime('%Y%m%d-%H%M%S')

changed = []


def backup(path):
    dst = f'{path}.bak-partners-{STAMP}'
    shutil.copy2(path, dst)
    return dst


# ---------------------------------------------------------------- nginx maps
def patch_maps(s):
    """Insert a twin map line after EVERY anchor line (referer map AND origin
    map both carry one). Dot-escaping differs per node, so match whatever this
    node actually uses instead of assuming."""
    esc = ANCHOR.replace('.', r'\.')
    # Match the anchor line in either escaped or unescaped form, keep its indent.
    pat = re.compile(
        r'^([ \t]*~\*\^https\?://\(www\\\.\)\?)(' + re.escape(ANCHOR) + '|' + re.escape(esc) + r')(\s+1;)$',
        re.M)
    hits = pat.findall(s)
    if not hits:
        raise SystemExit(f'FATAL: no map line for anchor {ANCHOR} - wrong node or format drift')

    def repl(m):
        prefix, matched, tail = m.group(1), m.group(2), m.group(3)
        # Mirror the node's own escaping style.
        escaped_style = '\\.' in matched
        lines = [m.group(0)]
        for d in NEW:
            dom = d.replace('.', r'\.') if escaped_style else d
            lines.append(f'{prefix}{dom}{tail}')
        return '\n'.join(lines)

    out = pat.sub(repl, s)
    return out, len(hits)


# ---------------------------------------------------------------------- CSP
def patch_csp(s):
    """Append bare+www origins for each new domain right after the anchor pair
    inside the frame-ancestors list."""
    anchor_pair = f'https://{ANCHOR} https://www.{ANCHOR}'
    if anchor_pair not in s:
        raise SystemExit(f'FATAL: CSP anchor pair for {ANCHOR} not found')
    add = ''.join(f' https://{d} https://www.{d}' for d in NEW)
    return s.replace(anchor_pair, anchor_pair + add, 1)


# ------------------------------------------------------------------ favicon
def patch_favicon(s):
    """Silence favicon.ico 403 console noise. Insert before `location = /embed`."""
    if 'location = /favicon.ico' in s:
        return s, False
    m = re.search(r'^([ \t]*)location = /embed \{', s, re.M)
    if not m:
        raise SystemExit('FATAL: `location = /embed` not found for favicon insert')
    ind = m.group(1)
    block = (f'{ind}# Browsers request this unprompted; we have no icon. 204 keeps\n'
             f'{ind}# the console clean instead of logging a gate 403 every load.\n'
             f'{ind}location = /favicon.ico {{ access_log off; return 204; }}\n\n')
    return s[:m.start()] + block + s[m.start():], True


# --------------------------------------------------------------- embed gate
def embed_anchor(s):
    """Locate the anchor inside the ALLOWED array.

    Two shapes occur in the wild: the anchor alone on its line (enumero) or
    packed mid-line with other domains (sabongflix). Prefer the own-line form
    so the insert stays readable, else fall back to the packed one. Returns
    (end_offset, indent) or None.
    """
    own = re.search(r"^([ \t]*)'" + re.escape(ANCHOR) + r"',[ \t]*$", s, re.M)
    if own:
        return own.end(), own.group(1)
    # Packed: 'a','anchor','b'  — or last in the array with no trailing comma.
    packed = re.search(r"'" + re.escape(ANCHOR) + r"',?", s)
    if not packed:
        return None
    line_start = s.rfind('\n', 0, packed.start()) + 1
    ind = re.match(r'[ \t]*', s[line_start:]).group(0)
    # Insert after the anchor's whole line, not mid-line, to keep the array tidy.
    line_end = s.find('\n', packed.end())
    if line_end == -1:
        line_end = packed.end()
    # Whether the INSERTED line needs a trailing comma depends on what follows
    # it, not on the anchor's own line. If more entries come after, the new line
    # must end with a comma or it abuts the next string and the whole script is
    # a SyntaxError - which blanks the player, not just the gate.
    rest = s[line_end:]
    close = rest.find(']')
    more_entries_follow = "'" in rest[:close] if close != -1 else False
    # The anchor's line itself must also end with a comma before we append.
    lead = '' if s[line_start:line_end].rstrip().endswith(',') else ','
    return line_end, ind, lead, more_entries_follow


def patch_embed(s):
    """Add the domains to the ALLOWED array on their own line after the anchor."""
    found = embed_anchor(s)
    if not found:
        raise SystemExit(f'FATAL: ALLOWED entry for {ANCHOR} not found in embed.html')
    if len(found) == 2:
        end, ind = found
        return s[:end] + '\n' + ind + ','.join(f"'{d}'" for d in NEW) + ',' + s[end:]
    end, ind, lead, more_entries_follow = found
    tail = ',' if more_entries_follow else ''
    return (s[:end] + lead + '\n' + ind
            + ','.join(f"'{d}'" for d in NEW) + tail + s[end:])


def main():
    # Validate BOTH files before writing EITHER. A mid-run abort used to leave
    # nginx patched and embed.html untouched, which is the one state that looks
    # deployed while the JS gate still rejects the new partner.
    if not all(d in open(EMBED, encoding='utf-8').read() for d in NEW):
        if not embed_anchor(open(EMBED, encoding='utf-8').read()):
            raise SystemExit(f'FATAL: ALLOWED entry for {ANCHOR} not found in {EMBED} '
                             f'- pick an anchor already in the array. Nothing written.')

    # ---- nginx ----
    src = open(NGINX, encoding='utf-8').read()
    orig = src
    if all(d in src for d in NEW):
        print('nginx: domains already present, skipping maps+CSP')
    else:
        src, nmaps = patch_maps(src)
        src = patch_csp(src)
        print(f'nginx: inserted twins after {nmaps} anchor map lines + CSP')
        changed.append('maps+csp')

    src, fav = patch_favicon(src)
    print(f'nginx: favicon rule {"ADDED" if fav else "already present"}')
    if fav:
        changed.append('favicon')

    if src != orig:
        # Guard: the regen trap wipes /admin. Refuse to write if we lost it.
        if src.count('location /admin') != orig.count('location /admin'):
            raise SystemExit('FATAL: /admin block count changed - refusing to write')
        if len(src) < len(orig):
            raise SystemExit('FATAL: config SHRANK - refusing to write')
        print('nginx backup:', backup(NGINX))
        open(NGINX, 'w', encoding='utf-8', newline='').write(src)
        print(f'nginx: written ({len(orig)} -> {len(src)} bytes)')
    else:
        print('nginx: no change needed')

    # ---- embed.html ----
    e = open(EMBED, encoding='utf-8').read()
    if all(d in e for d in NEW):
        print('embed: domains already present, skipping')
    else:
        new_e = patch_embed(e)
        print('embed backup:', backup(EMBED))
        open(EMBED, 'w', encoding='utf-8', newline='').write(new_e)
        print(f'embed: written ({len(e)} -> {len(new_e)} bytes)')
        changed.append('embed')

    print('CHANGED:', ','.join(changed) if changed else 'nothing')


if __name__ == '__main__':
    main()
