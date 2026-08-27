#!/usr/bin/env node
/**
 * apply-images.mjs — write photo assignments from image-map.json into the
 * <image-slot> elements of the amazingcthomes pages.
 *
 * The pages use the <image-slot> custom element from image-slot.js. Its
 * `src` attribute is author-controlled and passes through to the rendered
 * <img> unchanged, so filling a slot means setting src (and fit) on the
 * tag. This script is the repeatable way to do that: edit
 * tools/image-map.json, re-run, done. It is idempotent — running it twice
 * produces the same file.
 *
 * Usage
 *   node tools/apply-images.mjs [options]
 *
 * Options
 *   --root <dir>         Project root. Default: the parent of this script.
 *   --map <file>         Mapping JSON. Default: <root>/tools/image-map.json
 *   --images-dir <name>  Image folder, relative to each page.
 *                        Default: the map's "imagesDir".
 *   --pages <a,b,...>    Restrict to these page filenames.
 *                        Default: every key under the map's "pages".
 *   --fit <cover|contain> Value written to each filled slot's fit attribute.
 *                        Default: cover.
 *   --tint <0..1|keep>   Rewrite the `.duotone::after { opacity: N }` rule
 *                        in each page's <style> block. `keep` leaves it
 *                        alone. Default: the map's "tint", else keep.
 *   --backup / --no-backup
 *                        Write <page>.bak-<ISO timestamp> before changing
 *                        it. Default: --backup.
 *   --restore            Restore each page from its newest .bak-* file and
 *                        exit. Makes no other changes.
 *   --verify             Check that every mapped image exists on disk.
 *                        Exits 1 if any is missing. Implied by every run;
 *                        use alone to check without writing.
 *   --dry-run            Report what would change; write nothing.
 *   --quiet              Only print warnings and errors.
 *   -h, --help           This message.
 *
 * Exit codes
 *   0 success   1 missing image / missing slot / bad arguments   2 I/O error
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// ── argument parsing ────────────────────────────────────────────────────
function parseArgs(argv) {
  const flags = {
    root: resolve(SCRIPT_DIR, '..'),
    map: null,
    imagesDir: null,
    pages: null,
    fit: 'cover',
    tint: null,
    backup: true,
    restore: false,
    verify: false,
    dryRun: false,
    quiet: false,
    help: false,
  };
  const takesValue = new Set(['--root', '--map', '--images-dir', '--pages', '--fit', '--tint']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (takesValue.has(a)) {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value`);
      if (a === '--root') flags.root = resolve(v);
      else if (a === '--map') flags.map = resolve(v);
      else if (a === '--images-dir') flags.imagesDir = v;
      else if (a === '--pages') flags.pages = v.split(',').map((s) => s.trim()).filter(Boolean);
      else if (a === '--fit') flags.fit = v;
      else if (a === '--tint') flags.tint = v;
    } else if (a === '--backup') flags.backup = true;
    else if (a === '--no-backup') flags.backup = false;
    else if (a === '--restore') flags.restore = true;
    else if (a === '--verify') flags.verify = true;
    else if (a === '--dry-run') flags.dryRun = true;
    else if (a === '--quiet') flags.quiet = true;
    else if (a === '-h' || a === '--help') flags.help = true;
    else fail(`unknown argument: ${a}`);
  }
  if (!flags.map) flags.map = join(flags.root, 'tools', 'image-map.json');
  if (flags.fit !== 'cover' && flags.fit !== 'contain') fail('--fit must be cover or contain');
  if (flags.tint !== null && flags.tint !== 'keep') {
    const n = Number(flags.tint);
    if (!Number.isFinite(n) || n < 0 || n > 1) fail('--tint must be a number 0..1, or keep');
  }
  return flags;
}

function fail(msg) {
  console.error(`apply-images: ${msg}`);
  process.exit(1);
}

function help() {
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('/**'), src.indexOf('*/') + 2);
  console.log(block.replace(/^\s*\/\*\*|\s*\*\/$/g, '').replace(/^ \* ?/gm, ''));
}

// ── HTML attribute helpers ──────────────────────────────────────────────
// Operates on a single `<image-slot ...>` opening tag as a string.
const escapeAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

function setAttr(tag, name, value) {
  const existing = new RegExp(`\\s${name}="[^"]*"`);
  const attr = ` ${name}="${escapeAttr(value)}"`;
  if (existing.test(tag)) return tag.replace(existing, attr);
  // Insert just before the tag's closing bracket, self-closing or not.
  return tag.replace(/\s*\/?>$/, (end) => attr + end);
}

function removeAttr(tag, name) {
  return tag.replace(new RegExp(`\\s${name}="[^"]*"`), '');
}

const SLOT_TAG = /<image-slot\b[^>]*>/g;
const ID_ATTR = /\bid="([^"]*)"/;

/**
 * Rewrite every mapped <image-slot> in `html`.
 * Returns { html, applied: [{id, file}], cleared: [id], missingSlots: [id] }.
 */
function applyToHtml(html, slotMap, imagesDir, fit) {
  const seen = new Set();
  const applied = [];
  const cleared = [];

  const out = html.replace(SLOT_TAG, (tag) => {
    const m = ID_ATTR.exec(tag);
    if (!m) return tag;
    const id = m[1];
    if (!(id in slotMap)) return tag;
    seen.add(id);
    const file = slotMap[id];
    if (file === null || file === undefined || file === '') {
      cleared.push(id);
      return removeAttr(tag, 'src');
    }
    // Forward slashes: this is a URL, not a filesystem path, on every OS.
    let next = setAttr(tag, 'fit', fit);
    next = setAttr(next, 'src', `${imagesDir}/${file}`);
    applied.push({ id, file });
    return next;
  });

  const missingSlots = Object.keys(slotMap).filter((id) => !seen.has(id));
  return { html: out, applied, cleared, missingSlots };
}

// Rewrites `.duotone::after { opacity: N; }` if the rule is present.
const TINT_RULE = /(\.duotone::after\s*\{[^}]*?opacity:\s*)([0-9.]+)(\s*;?[^}]*\})/;
function applyTint(html, tint) {
  if (!TINT_RULE.test(html)) return { html, changed: false, found: false };
  let changed = false;
  const out = html.replace(TINT_RULE, (full, head, cur, tail) => {
    if (Number(cur) === Number(tint)) return full;
    changed = true;
    return `${head}${tint}${tail}`;
  });
  return { html: out, changed, found: true };
}

// ── backup / restore ────────────────────────────────────────────────────
const bakPrefix = (page) => `${basename(page)}.bak-`;

function newestBackup(root, page) {
  const prefix = bakPrefix(page);
  const candidates = readdirSync(root).filter((f) => f.startsWith(prefix)).sort();
  return candidates.length ? join(root, candidates[candidates.length - 1]) : null;
}

function writeBackup(root, page) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(root, `${bakPrefix(page)}${stamp}`);
  copyFileSync(join(root, page), dest);
  return dest;
}

// ── main ────────────────────────────────────────────────────────────────
function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) return help();

  const log = flags.quiet ? () => {} : (...a) => console.log(...a);

  if (!existsSync(flags.map)) fail(`map not found: ${flags.map}`);
  let map;
  try {
    map = JSON.parse(readFileSync(flags.map, 'utf8'));
  } catch (e) {
    fail(`could not parse ${flags.map}: ${e.message}`);
  }
  if (!map.pages || typeof map.pages !== 'object') fail('map has no "pages" object');

  const imagesDir = flags.imagesDir ?? map.imagesDir ?? 'houseimages';
  const tint = flags.tint !== null ? flags.tint : (map.tint ?? 'keep');
  const pageNames = flags.pages ?? Object.keys(map.pages);

  // --restore short-circuits everything else.
  if (flags.restore) {
    let restored = 0;
    for (const page of pageNames) {
      const bak = newestBackup(flags.root, page);
      if (!bak) {
        console.warn(`  no backup found for ${page}`);
        continue;
      }
      if (flags.dryRun) log(`  would restore ${page} from ${basename(bak)}`);
      else {
        copyFileSync(bak, join(flags.root, page));
        log(`  restored ${page} from ${basename(bak)}`);
      }
      restored++;
    }
    log(`\n${restored} page(s) restored${flags.dryRun ? ' (dry run)' : ''}.`);
    return;
  }

  // Verify every referenced image exists before touching any page — a
  // half-applied map is worse than a refusal.
  const missingImages = [];
  const referenced = new Set();
  for (const page of pageNames) {
    const slots = map.pages[page];
    if (!slots) fail(`page not in map: ${page}`);
    for (const file of Object.values(slots)) {
      if (!file) continue;
      referenced.add(file);
      if (!existsSync(join(flags.root, imagesDir, file))) missingImages.push(file);
    }
  }
  if (missingImages.length) {
    console.error(`apply-images: missing from ${imagesDir}/ -> ${[...new Set(missingImages)].join(', ')}`);
    process.exit(1);
  }
  log(`Verified ${referenced.size} image file(s) in ${imagesDir}/.`);

  if (flags.verify && !flags.dryRun && process.argv.includes('--verify') && process.argv.length === 3) {
    return; // --verify used on its own: check and stop.
  }

  // Report images on disk that the map never places.
  if (existsSync(join(flags.root, imagesDir))) {
    const onDisk = readdirSync(join(flags.root, imagesDir))
      .filter((f) => /\.(png|jpe?g|webp|avif|gif)$/i.test(f));
    const unused = onDisk.filter((f) => !referenced.has(f));
    if (unused.length) log(`Unplaced in ${imagesDir}/: ${unused.join(', ')}`);
  }

  let exitCode = 0;
  for (const page of pageNames) {
    const full = join(flags.root, page);
    if (!existsSync(full)) fail(`page not found: ${full}`);
    const before = readFileSync(full, 'utf8');

    const r = applyToHtml(before, map.pages[page], imagesDir, flags.fit);
    let after = r.html;

    let tintNote = '';
    if (tint !== 'keep') {
      const t = applyTint(after, Number(tint));
      after = t.html;
      if (!t.found) tintNote = `  (no .duotone::after rule found — tint skipped)`;
      else if (t.changed) tintNote = `  tint -> ${tint}`;
    }

    log(`\n${page}`);
    log(`  ${r.applied.length} slot(s) filled, ${r.cleared.length} left empty${tintNote}`);
    for (const { id, file } of r.applied) log(`    ${id.padEnd(14)} ${imagesDir}/${file}`);
    for (const id of r.cleared) log(`    ${id.padEnd(14)} (placeholder)`);
    if (r.missingSlots.length) {
      console.warn(`  WARNING mapped ids with no matching slot in the page: ${r.missingSlots.join(', ')}`);
      exitCode = 1;
    }

    if (after === before) {
      log('  no change');
      continue;
    }
    if (flags.dryRun) {
      log('  would write (dry run)');
      continue;
    }
    try {
      if (flags.backup) log(`  backup -> ${basename(writeBackup(flags.root, page))}`);
      writeFileSync(full, after, 'utf8');
      log('  written');
    } catch (e) {
      console.error(`apply-images: could not write ${page}: ${e.message}`);
      process.exit(2);
    }
  }

  process.exit(exitCode);
}

main();
