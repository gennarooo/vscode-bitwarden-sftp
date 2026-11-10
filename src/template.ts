/**
 * Template handling.
 *
 * Any string value in the template may contain references like:
 *   {{bw:<item id or name>}}            -> password (default)
 *   {{bw:<item id or name>:username}}
 *   {{bw:<item id or name>:uri}}
 *   {{bw:<item id or name>:field.<custom field name>}}
 */

export const KNOWN_FIELDS = ['password', 'username', 'uri', 'notes', 'totp', 'name'];

const PLACEHOLDER = /\{\{\s*bw:([^}]+?)\s*\}\}/g;

export interface Reference {
  item: string;
  field: string;
}

export function parseReference(raw: string): Reference {
  const idx = raw.lastIndexOf(':');
  if (idx > 0) {
    const field = raw.slice(idx + 1).trim();
    if (KNOWN_FIELDS.includes(field) || field.startsWith('field.')) {
      return { item: raw.slice(0, idx).trim(), field };
    }
  }
  return { item: raw.trim(), field: 'password' };
}

export function hasPlaceholder(value: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(value);
}

type Resolver = (ref: Reference) => Promise<string>;

async function replaceInString(value: string, resolve: Resolver): Promise<string> {
  const matches = [...value.matchAll(PLACEHOLDER)];
  if (matches.length === 0) {
    return value;
  }
  let out = '';
  let last = 0;
  for (const m of matches) {
    out += value.slice(last, m.index!);
    out += await resolve(parseReference(m[1]));
    last = m.index! + m[0].length;
  }
  return out + value.slice(last);
}

/** Recursively replaces the references with the values taken from Bitwarden. */
export async function resolveTemplate(node: unknown, resolve: Resolver): Promise<unknown> {
  if (typeof node === 'string') {
    return replaceInString(node, resolve);
  }
  if (Array.isArray(node)) {
    const out = [];
    for (const v of node) {
      out.push(await resolveTemplate(v, resolve));
    }
    return out;
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      const r = await resolveTemplate(v, resolve);
      // sftp.json expects a number for "port".
      out[k] = k === 'port' && typeof r === 'string' && /^\d+$/.test(r) ? Number(r) : r;
    }
    return out;
  }
  return node;
}

/** Removes all keys whose value contains a reference (used to write a "safe" sftp.json). */
export function stripTemplate(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(stripTemplate);
  }
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && hasPlaceholder(v)) {
        continue;
      }
      out[k] = stripTemplate(v);
    }
    return out;
  }
  return node;
}

/** Strips JSON comments (// and /* *\/) and trailing commas, as allowed in VS Code config files. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') { out += n ?? ''; i++; }
      else if (c === '"') { inString = false; }
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') { i++; } out += '\n'; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { i++; } i++; continue; }
    out += c;
  }
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}
