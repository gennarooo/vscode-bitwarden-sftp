import { execFile } from 'child_process';
import * as vscode from 'vscode';

export type VaultStatus = 'unauthenticated' | 'locked' | 'unlocked';

export interface BwItem {
  id: string;
  name: string;
  login?: {
    username?: string | null;
    password?: string | null;
    totp?: string | null;
    uris?: { uri?: string | null }[] | null;
  } | null;
  notes?: string | null;
  fields?: { name?: string | null; value?: string | null }[] | null;
}

export class BitwardenError extends Error {}

/** Thin wrapper around the Bitwarden CLI (`bw`). */
export class Bitwarden {
  private session: string | undefined;
  private cache = new Map<string, BwItem>();

  constructor(private cliPath: () => string) {}

  setSession(session: string | undefined) {
    this.session = session;
    this.cache.clear();
  }

  getSession() {
    return this.session;
  }

  private run(args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv, BW_NOINTERACTION: 'true' };
    if (this.session) {
      env.BW_SESSION = this.session;
    }
    // On Windows "bw" is usually "bw.cmd" (npm) and needs a shell: quote arguments by hand.
    const win = process.platform === 'win32';
    const quote = (a: string) => (/^[\w.\-\/:=]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);
    const cmd = win ? quote(this.cliPath()) : this.cliPath();
    const finalArgs = win ? args.map(quote) : args;
    return new Promise((resolve, reject) => {
      execFile(
        cmd,
        finalArgs,
        { env, maxBuffer: 32 * 1024 * 1024, windowsHide: true, shell: win },
        (err, stdout, stderr) => {
          if (err) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
              reject(new BitwardenError(vscode.l10n.t(
                'Bitwarden CLI not found ("{0}"). Install it with "npm i -g @bitwarden/cli" or set "bitwardenSftp.cliPath".',
                this.cliPath())));
              return;
            }
            const msg = (stderr || stdout || err.message).toString().trim();
            reject(new BitwardenError(msg || vscode.l10n.t('Unknown Bitwarden CLI error')));
            return;
          }
          resolve(stdout.toString());
        }
      );
    });
  }

  async status(): Promise<VaultStatus> {
    const out = await this.run(['status']);
    try {
      return JSON.parse(out).status as VaultStatus;
    } catch {
      throw new BitwardenError(vscode.l10n.t('Unexpected output from "bw status": {0}', out));
    }
  }

  /** Unlocks the vault and keeps the session key in memory. The password goes through an env var, never argv. */
  async unlock(masterPassword: string): Promise<string> {
    const varName = 'BW_SFTP_MASTER_PW';
    const out = await this.run(['unlock', '--raw', '--passwordenv', varName], { [varName]: masterPassword });
    const session = out.trim();
    if (!session) {
      throw new BitwardenError(vscode.l10n.t('Unlock failed: no session returned.'));
    }
    this.setSession(session);
    return session;
  }

  async lock(): Promise<void> {
    try {
      await this.run(['lock']);
    } finally {
      this.setSession(undefined);
    }
  }

  async sync(): Promise<void> {
    await this.run(['sync']);
    this.cache.clear();
  }

  async listItems(search?: string): Promise<BwItem[]> {
    const args = ['list', 'items'];
    if (search) {
      args.push('--search', search);
    }
    return JSON.parse(await this.run(args)) as BwItem[];
  }

  /** Gets an item by id or by exact name (an error is raised if the name is ambiguous). */
  async getItem(ref: string): Promise<BwItem> {
    const cached = this.cache.get(ref);
    if (cached) {
      return cached;
    }
    let item: BwItem;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) {
      item = JSON.parse(await this.run(['get', 'item', ref])) as BwItem;
    } else {
      const matches = (await this.listItems(ref)).filter((i) => i.name === ref);
      if (matches.length === 0) {
        throw new BitwardenError(vscode.l10n.t('No Bitwarden item named "{0}".', ref));
      }
      if (matches.length > 1) {
        throw new BitwardenError(vscode.l10n.t('More than one item is named "{0}": use the item ID instead.', ref));
      }
      item = matches[0];
    }
    this.cache.set(ref, item);
    return item;
  }

  async getTotp(id: string): Promise<string> {
    return (await this.run(['get', 'totp', id])).trim();
  }

  /**
   * Reads a field from an item.
   * Supported fields: password, username, uri, notes, totp, name, field.<custom field name>
   */
  async getField(ref: string, field: string): Promise<string> {
    const item = await this.getItem(ref);
    let value: string | null | undefined;
    switch (field) {
      case 'password': value = item.login?.password; break;
      case 'username': value = item.login?.username; break;
      case 'uri': value = item.login?.uris?.[0]?.uri; break;
      case 'notes': value = item.notes; break;
      case 'name': value = item.name; break;
      case 'totp': value = await this.getTotp(item.id); break;
      default:
        if (field.startsWith('field.')) {
          const name = field.slice('field.'.length);
          value = item.fields?.find((f) => f.name === name)?.value;
        } else {
          throw new BitwardenError(vscode.l10n.t('Unsupported field "{0}".', field));
        }
    }
    if (value === null || value === undefined) {
      throw new BitwardenError(vscode.l10n.t('Item "{0}" has no "{1}" field.', item.name, field));
    }
    return value;
  }
}
