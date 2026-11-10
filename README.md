# Bitwarden SFTP Secrets

🇬🇧 **English** · 🇮🇹 [Italiano](README.it.md)

A VS Code extension that reads your FTP/SFTP credentials from **Bitwarden** and writes them into the
`.vscode/sftp.json` file used by the **SFTP** extension (Natizyskunk / liximomo), so usernames and passwords
are not kept in plain text in your project.

## How it works

1. Keep a **template** in your project, `.vscode/sftp.template.json` (safe to commit), with references to Bitwarden:

   ```jsonc
   {
     "name": "Client website",
     "host": "ftp.example.com",
     "protocol": "ftp",
     "port": 21,
     "username": "{{bw:Client FTP:username}}",
     "password": "{{bw:Client FTP:password}}",
     "remotePath": "/public_html",
     "uploadOnSave": false
   }
   ```

2. Click **🔒 SFTP** in the status bar (or run *Bitwarden SFTP: Unlock Bitwarden and generate sftp.json*)
   and enter your master password. The extension generates `.vscode/sftp.json` with the real credentials
   (file mode `600`, automatically added to `.gitignore`). The SFTP extension reloads it on its own.
3. Upload your files as usual.
4. The credentials are **removed from `sftp.json`**:
   - when you click **🔓 SFTP** (*Lock* command),
   - after `autoLockMinutes` minutes (default 30),
   - when VS Code closes,
   - on the next start, if VS Code crashed while unlocked.

## Reference syntax

| Reference | Value |
|---|---|
| `{{bw:Item name}}` | password (default) |
| `{{bw:Item name:password}}` | password |
| `{{bw:Item name:username}}` | username |
| `{{bw:Item name:uri}}` | first URI |
| `{{bw:Item name:notes}}` | notes |
| `{{bw:Item name:totp}}` | current TOTP code |
| `{{bw:Item name:field.port}}` | custom field named "port" |

You can use the item **ID** instead of its name; IDs are safer when several items share a name.
The *Insert Bitwarden item reference* command lists your items and inserts the reference with the ID.
The template can also be an array of configurations or use `profiles`: every string value is processed.
A `port` value read from Bitwarden is written as a number.

## Requirements

- [Bitwarden CLI](https://bitwarden.com/help/cli/): `npm install -g @bitwarden/cli`
  (or download the binary and set `bitwardenSftp.cliPath`).
- Log in **once** from a terminal with `bw login`.
  If your vault is on the EU server, first run `bw config server https://vault.bitwarden.eu`;
  for a self-hosted server use its address.
- An SFTP extension for VS Code (e.g. `Natizyskunk.sftp`).

## Migrating an existing project

Open a project whose `sftp.json` still holds the password in plain text and run
*Bitwarden SFTP: Create template from existing sftp.json*. Pick the Bitwarden item: the template is created
with the references and `sftp.json` is cleaned.
**If the old `sftp.json` was ever committed to Git, change the FTP password**: it stays in the history.

## Settings

| Setting | Default | Description |
|---|---|---|
| `bitwardenSftp.cliPath` | `bw` | Path to the Bitwarden CLI |
| `bitwardenSftp.templateFile` | `.vscode/sftp.template.json` | Template file |
| `bitwardenSftp.outputFile` | `.vscode/sftp.json` | Generated file |
| `bitwardenSftp.autoLockMinutes` | `30` | Automatic cleanup (0 = only when VS Code closes) |
| `bitwardenSftp.cleanupMode` | `strip` | `strip` removes only the secrets, `delete` removes the file |
| `bitwardenSftp.rememberSession` | `false` | Store the Bitwarden session in the OS keychain |
| `bitwardenSftp.manageGitignore` | `true` | Add `sftp.json` to `.gitignore` |

## Security notes

- The master password is passed to the CLI through an environment variable (never on the command line) and is not stored.
- The session key stays in memory; with `rememberSession` it is stored in VS Code SecretStorage (the OS keychain).
- The SFTP extension only reads from a file, so **while unlocked** `sftp.json` contains the credentials in plain text.
  It is excluded from Git, has restricted permissions and is cleaned automatically; keep this in mind for backups
  or cloud sync of the project folder.
- Plain FTP still sends the password unencrypted over the network: use `sftp`, or FTPS (`"secure": true`), when the server supports it.

## Languages

The UI is available in English and Italian; VS Code picks the language from the editor's display language
(*Configure Display Language*). To add a language, copy `package.nls.json` to `package.nls.<locale>.json`
and `l10n/bundle.l10n.json` to `l10n/bundle.l10n.<locale>.json`, then translate the values.
Run `npm run l10n` after changing messages in the code to refresh `l10n/bundle.l10n.json`.

## Build

```bash
npm install
npm run compile
npm run package   # creates bitwarden-sftp-x.y.z.vsix
```

Install with `code --install-extension bitwarden-sftp-0.1.0.vsix`,
or in VS Code: *Extensions → … → Install from VSIX*.

## License

MIT
