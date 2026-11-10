import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Bitwarden, BitwardenError, BwItem } from './bitwarden';
import { parseJsonc, resolveTemplate, stripTemplate } from './template';

const SESSION_KEY = 'bitwardenSftp.session';
const GENERATED_KEY = 'bitwardenSftp.generatedFiles';

let bw: Bitwarden;
let ctx: vscode.ExtensionContext;
let statusItem: vscode.StatusBarItem;
let lockTimer: NodeJS.Timeout | undefined;
let output: vscode.OutputChannel;

function cfg() {
  return vscode.workspace.getConfiguration('bitwardenSftp');
}

function log(msg: string) {
  output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Tracking of generated files (so they can be cleaned even after a crash)
// ---------------------------------------------------------------------------

interface Generated {
  output: string;
  template: string;
}

function getGenerated(): Generated[] {
  return ctx.workspaceState.get<Generated[]>(GENERATED_KEY, []);
}

async function setGenerated(list: Generated[]) {
  await ctx.workspaceState.update(GENERATED_KEY, list);
}

function foldersWithTemplate(): { folder: vscode.WorkspaceFolder; template: string; output: string }[] {
  const res = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const template = path.join(folder.uri.fsPath, cfg().get<string>('templateFile', '.vscode/sftp.template.json'));
    const outFile = path.join(folder.uri.fsPath, cfg().get<string>('outputFile', '.vscode/sftp.json'));
    if (fs.existsSync(template)) {
      res.push({ folder, template, output: outFile });
    }
  }
  return res;
}

/** Synchronous cleanup: also used in deactivate(), where async work may not complete. */
function cleanupSync(list: Generated[]) {
  const mode = cfg().get<string>('cleanupMode', 'strip');
  for (const g of list) {
    try {
      if (!fs.existsSync(g.output)) {
        continue;
      }
      if (mode === 'delete' || !fs.existsSync(g.template)) {
        fs.unlinkSync(g.output);
      } else {
        const safe = stripTemplate(parseJsonc(fs.readFileSync(g.template, 'utf8')));
        fs.writeFileSync(g.output, JSON.stringify(safe, null, 2) + '\n', { mode: 0o600 });
      }
    } catch (e) {
      // Last resort: never leave the secrets on disk.
      try { fs.unlinkSync(g.output); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Session handling
// ---------------------------------------------------------------------------

async function ensureUnlocked(): Promise<boolean> {
  if (!bw.getSession() && cfg().get<boolean>('rememberSession')) {
    bw.setSession(await ctx.secrets.get(SESSION_KEY));
  }

  let status = await bw.status();
  if (status === 'unlocked') {
    return true;
  }
  if (status === 'unauthenticated') {
    const choice = await vscode.window.showErrorMessage(
      vscode.l10n.t('You are not logged in to the Bitwarden CLI. Run "bw login" once in a terminal, then try again.'),
      vscode.l10n.t('Open terminal')
    );
    if (choice) {
      const t = vscode.window.createTerminal('Bitwarden login');
      t.show();
      t.sendText(`${cfg().get<string>('cliPath', 'bw')} login`);
    }
    return false;
  }

  // locked (or stored session expired)
  bw.setSession(undefined);
  const pw = await vscode.window.showInputBox({
    title: 'Bitwarden',
    prompt: vscode.l10n.t('Bitwarden master password'),
    password: true,
    ignoreFocusOut: true,
  });
  if (!pw) {
    return false;
  }
  const session = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Unlocking Bitwarden…') },
    () => bw.unlock(pw)
  );
  if (cfg().get<boolean>('rememberSession')) {
    await ctx.secrets.store(SESSION_KEY, session);
  }
  status = await bw.status();
  return status === 'unlocked';
}

function scheduleAutoLock() {
  if (lockTimer) {
    clearTimeout(lockTimer);
    lockTimer = undefined;
  }
  const minutes = cfg().get<number>('autoLockMinutes', 30);
  if (minutes > 0) {
    lockTimer = setTimeout(() => {
      lock(false).then(() =>
        vscode.window.showInformationMessage(vscode.l10n.t('Bitwarden SFTP: credentials removed from sftp.json (auto-lock).'))
      );
    }, minutes * 60_000);
  }
}

function updateStatus(unlocked: boolean) {
  if (foldersWithTemplate().length === 0) {
    statusItem.hide();
    return;
  }
  statusItem.text = unlocked ? '$(unlock) SFTP' : '$(lock) SFTP';
  statusItem.tooltip = unlocked
    ? vscode.l10n.t('Bitwarden credentials active in sftp.json – click to lock')
    : vscode.l10n.t('SFTP credentials locked – click to unlock with Bitwarden');
  statusItem.command = unlocked ? 'bitwardenSftp.lock' : 'bitwardenSftp.unlockAndApply';
  statusItem.show();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function ensureGitignore(folder: vscode.WorkspaceFolder, outFile: string) {
  if (!cfg().get<boolean>('manageGitignore', true)) {
    return;
  }
  const gi = path.join(folder.uri.fsPath, '.gitignore');
  const rel = path.relative(folder.uri.fsPath, outFile).split(path.sep).join('/');
  const content = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const lines = content.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(rel) || lines.includes('/' + rel)) {
    return;
  }
  const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(gi, `${prefix}# Generated by Bitwarden SFTP: contains credentials\n${rel}\n`);
  log(`Added ${rel} to ${gi}`);
}

async function apply(silent = false): Promise<void> {
  const targets = foldersWithTemplate();
  if (targets.length === 0) {
    if (!silent) {
      vscode.window.showWarningMessage(
        vscode.l10n.t('No template found ({0}). Use "Bitwarden SFTP: Create template from existing sftp.json".', String(cfg().get('templateFile')))
      );
    }
    return;
  }
  if (!(await ensureUnlocked())) {
    return;
  }

  const generated = getGenerated().filter((g) => !targets.some((t) => t.output === g.output));
  for (const t of targets) {
    const template = parseJsonc(fs.readFileSync(t.template, 'utf8'));
    const resolved = await resolveTemplate(template, (ref) => bw.getField(ref.item, ref.field));
    await ensureGitignore(t.folder, t.output);
    fs.mkdirSync(path.dirname(t.output), { recursive: true });
    fs.writeFileSync(t.output, JSON.stringify(resolved, null, 2) + '\n', { mode: 0o600 });
    generated.push({ output: t.output, template: t.template });
    log(`Generated ${t.output}`);
  }
  await setGenerated(generated);
  scheduleAutoLock();
  updateStatus(true);
  if (!silent) {
    vscode.window.showInformationMessage(vscode.l10n.t('Bitwarden SFTP: credentials loaded ({0} folder(s)).', targets.length));
  }
}

async function lock(lockVault = true): Promise<void> {
  if (lockTimer) {
    clearTimeout(lockTimer);
    lockTimer = undefined;
  }
  cleanupSync(getGenerated());
  await setGenerated([]);
  await ctx.secrets.delete(SESSION_KEY);
  if (lockVault) {
    try { await bw.lock(); } catch (e) { log(`bw lock: ${e}`); }
  } else {
    bw.setSession(undefined);
  }
  updateStatus(false);
  log('Credentials removed');
}

async function pickItem(): Promise<BwItem | undefined> {
  if (!(await ensureUnlocked())) {
    return undefined;
  }
  const items = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reading Bitwarden items…') },
    () => bw.listItems()
  );
  const pick = await vscode.window.showQuickPick(
    items.filter((i) => i.login).map((i) => ({
      label: i.name,
      description: i.login?.username ?? '',
      detail: i.login?.uris?.[0]?.uri ?? undefined,
      item: i,
    })),
    { title: vscode.l10n.t('Choose the Bitwarden item'), matchOnDescription: true, matchOnDetail: true }
  );
  return pick?.item;
}

async function insertPlaceholder() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const item = await pickItem();
  if (!item) {
    return;
  }
  const custom = (item.fields ?? []).filter((f) => f.name).map((f) => `field.${f.name}`);
  const field = await vscode.window.showQuickPick(['password', 'username', 'uri', 'totp', 'notes', ...custom], {
    title: vscode.l10n.t('Field of "{0}"', item.name),
  });
  if (!field) {
    return;
  }
  await editor.edit((e) => e.replace(editor.selection, `{{bw:${item.id}:${field}}}`));
}

async function createTemplate() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showWarningMessage(vscode.l10n.t('Open a project folder first.'));
    return;
  }
  const outFile = path.join(folder.uri.fsPath, cfg().get<string>('outputFile', '.vscode/sftp.json'));
  const tplFile = path.join(folder.uri.fsPath, cfg().get<string>('templateFile', '.vscode/sftp.template.json'));
  if (fs.existsSync(tplFile)) {
    vscode.window.showWarningMessage(vscode.l10n.t('The template already exists.'));
    await vscode.window.showTextDocument(vscode.Uri.file(tplFile));
    return;
  }

  let config: unknown = {
    name: 'My server',
    host: 'ftp.example.com',
    protocol: 'ftp',
    port: 21,
    remotePath: '/public_html',
    uploadOnSave: false,
  };
  if (fs.existsSync(outFile)) {
    config = parseJsonc(fs.readFileSync(outFile, 'utf8'));
  }

  const item = await pickItem();
  const ref = item ? item.id : 'ITEM_NAME_OR_ID';
  const fillIn = (c: Record<string, unknown>) => {
    c.username = `{{bw:${ref}:username}}`;
    c.password = `{{bw:${ref}:password}}`;
    delete c.passphrase;
  };
  if (Array.isArray(config)) {
    config.forEach((c) => fillIn(c as Record<string, unknown>));
  } else {
    fillIn(config as Record<string, unknown>);
  }

  fs.mkdirSync(path.dirname(tplFile), { recursive: true });
  fs.writeFileSync(tplFile, JSON.stringify(config, null, 2) + '\n');
  await ensureGitignore(folder, outFile);
  if (fs.existsSync(outFile)) {
    // The old sftp.json contained plain-text credentials: replace it with a safe version.
    await setGenerated([...getGenerated(), { output: outFile, template: tplFile }]);
    cleanupSync([{ output: outFile, template: tplFile }]);
  }
  await vscode.window.showTextDocument(vscode.Uri.file(tplFile));
  updateStatus(false);
  vscode.window.showInformationMessage(
    vscode.l10n.t('Template created. Change the FTP password if the old sftp.json was ever committed to Git.')
  );
}

function wrap(fn: () => Promise<unknown>) {
  return async () => {
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof BitwardenError ? e.message : String(e);
      log(`Error: ${msg}`);
      vscode.window.showErrorMessage(`Bitwarden SFTP: ${msg}`);
    }
  };
}

// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  ctx = context;
  output = vscode.window.createOutputChannel('Bitwarden SFTP');
  bw = new Bitwarden(() => cfg().get<string>('cliPath', 'bw'));
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);

  // If VS Code crashed while unlocked, remove leftover secrets.
  const leftover = getGenerated();
  if (leftover.length > 0) {
    cleanupSync(leftover);
    void setGenerated([]);
    log('Removed credentials left over from a previous session');
  }

  context.subscriptions.push(
    output,
    statusItem,
    vscode.commands.registerCommand('bitwardenSftp.unlockAndApply', wrap(() => apply())),
    vscode.commands.registerCommand('bitwardenSftp.lock', wrap(() => lock())),
    vscode.commands.registerCommand('bitwardenSftp.sync', wrap(async () => {
      if (await ensureUnlocked()) {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Syncing Bitwarden…') },
          () => bw.sync()
        );
        if (getGenerated().length > 0) {
          await apply(true);
        }
        vscode.window.showInformationMessage(vscode.l10n.t('Bitwarden vault synced.'));
      }
    })),
    vscode.commands.registerCommand('bitwardenSftp.createTemplate', wrap(createTemplate)),
    vscode.commands.registerCommand('bitwardenSftp.insertPlaceholder', wrap(insertPlaceholder)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => updateStatus(getGenerated().length > 0))
  );

  // Regenerate when the template changes while unlocked.
  const watcher = vscode.workspace.createFileSystemWatcher('**/' + path.basename(cfg().get<string>('templateFile', '.vscode/sftp.template.json')));
  const onTemplate = wrap(async () => {
    if (getGenerated().length > 0 && bw.getSession()) {
      await apply(true);
    } else {
      updateStatus(false);
    }
  });
  watcher.onDidChange(onTemplate);
  watcher.onDidCreate(onTemplate);
  context.subscriptions.push(watcher);

  updateStatus(false);

  // With a remembered session, unlock silently at startup.
  if (cfg().get<boolean>('rememberSession')) {
    void (async () => {
      const s = await context.secrets.get(SESSION_KEY);
      if (s) {
        bw.setSession(s);
        try {
          if ((await bw.status()) === 'unlocked') {
            await apply(true);
          }
        } catch (e) {
          log(`Automatic unlock failed: ${e}`);
        }
      }
    })();
  }
}

export function deactivate() {
  if (lockTimer) {
    clearTimeout(lockTimer);
  }
  if (ctx) {
    cleanupSync(getGenerated());
  }
}
