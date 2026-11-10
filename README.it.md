# Bitwarden SFTP Secrets

🇬🇧 [English](README.md) · 🇮🇹 **Italiano**

Estensione per VS Code che legge le credenziali FTP/SFTP da **Bitwarden** e le inserisce nel file
`.vscode/sftp.json` usato dall'estensione **SFTP** (Natizyskunk / liximomo), così username e password
non restano scritti in chiaro nel progetto.

## Come funziona

1. Nel progetto tieni un **template** `.vscode/sftp.template.json` (si può committare) con dei riferimenti a Bitwarden:

   ```jsonc
   {
     "name": "Sito cliente",
     "host": "ftp.cliente.it",
     "protocol": "ftp",
     "port": 21,
     "username": "{{bw:FTP Cliente:username}}",
     "password": "{{bw:FTP Cliente:password}}",
     "remotePath": "/public_html",
     "uploadOnSave": false
   }
   ```

2. Clicca su **🔒 SFTP** nella barra di stato (oppure *Bitwarden SFTP: Sblocca Bitwarden e genera sftp.json*),
   inserisci la master password: l'estensione genera `.vscode/sftp.json` con le credenziali vere
   (permessi `600`, aggiunto automaticamente al `.gitignore`). L'estensione SFTP lo rilegge da sola.
3. Carica i file come al solito.
4. Le credenziali vengono **rimosse da `sftp.json`**:
   - quando clicchi su **🔓 SFTP** (comando *Blocca*),
   - dopo `autoLockMinutes` minuti (default 30),
   - alla chiusura di VS Code,
   - al riavvio, se VS Code si era chiuso in modo anomalo.

## Sintassi dei riferimenti

| Riferimento | Valore |
|---|---|
| `{{bw:Nome elemento}}` | password (default) |
| `{{bw:Nome elemento:password}}` | password |
| `{{bw:Nome elemento:username}}` | nome utente |
| `{{bw:Nome elemento:uri}}` | primo URI |
| `{{bw:Nome elemento:notes}}` | note |
| `{{bw:Nome elemento:totp}}` | codice TOTP corrente |
| `{{bw:Nome elemento:field.porta}}` | campo personalizzato "porta" |

Al posto del nome puoi usare l'**ID** dell'elemento, che è più robusto se ci sono nomi duplicati.
Il comando *Inserisci riferimento a un elemento Bitwarden* mostra un elenco degli elementi e inserisce il riferimento con l'ID.
Il template può essere anche un array di configurazioni o usare `profiles`: tutte le stringhe vengono elaborate.

## Requisiti

- [Bitwarden CLI](https://bitwarden.com/help/cli/): `npm install -g @bitwarden/cli`
  (oppure scarica l'eseguibile e imposta `bitwardenSftp.cliPath`).
- Effettua **una volta** l'accesso da terminale: `bw login`
  (per il server EU prima `bw config server https://vault.bitwarden.eu`, per un server self-hosted il suo indirizzo).
- Estensione SFTP per VS Code (es. `Natizyskunk.sftp`).

## Migrare un progetto esistente

Apri il progetto che ha già `sftp.json` con la password in chiaro ed esegui
*Bitwarden SFTP: Crea template da sftp.json esistente*: scegli l'elemento Bitwarden, viene creato il template
con i riferimenti e `sftp.json` viene ripulito.
**Se il vecchio `sftp.json` era già stato committato su Git, cambia la password FTP**: resta nella cronologia.

## Impostazioni

| Impostazione | Default | Descrizione |
|---|---|---|
| `bitwardenSftp.cliPath` | `bw` | Percorso della Bitwarden CLI |
| `bitwardenSftp.templateFile` | `.vscode/sftp.template.json` | Template |
| `bitwardenSftp.outputFile` | `.vscode/sftp.json` | File generato |
| `bitwardenSftp.autoLockMinutes` | `30` | Rimozione automatica (0 = solo alla chiusura) |
| `bitwardenSftp.cleanupMode` | `strip` | `strip` = toglie solo i segreti, `delete` = elimina il file |
| `bitwardenSftp.rememberSession` | `false` | Salva la sessione Bitwarden nel portachiavi di sistema |
| `bitwardenSftp.manageGitignore` | `true` | Aggiunge `sftp.json` al `.gitignore` |

## Note sulla sicurezza

- La master password viene passata alla CLI tramite variabile d'ambiente (mai sulla riga di comando) e non viene salvata.
- La chiave di sessione resta in memoria; con `rememberSession` viene salvata nel SecretStorage di VS Code (portachiavi del SO).
- L'estensione SFTP legge solo da file, quindi **mentre è sbloccato** `sftp.json` contiene le credenziali in chiaro:
  è escluso da Git e ha permessi ristretti, e viene ripulito automaticamente; tienilo in conto per backup o sincronizzazioni cloud della cartella.
- Il protocollo FTP semplice trasmette comunque la password in chiaro in rete: se il server lo consente usa `sftp` o FTPS (`"secure": true`).

## Lingue

L'interfaccia è in inglese e in italiano: VS Code sceglie la lingua in base alla lingua dell'editor
(*Configure Display Language*). Per aggiungere una lingua, copia `package.nls.json` in `package.nls.<lingua>.json`
e `l10n/bundle.l10n.json` in `l10n/bundle.l10n.<lingua>.json` e traduci i valori.

## Build

```bash
npm install
npm run compile
npm run package   # crea bitwarden-sftp-x.y.z.vsix
```

Installazione: `code --install-extension bitwarden-sftp-0.1.0.vsix`
oppure da VS Code: *Estensioni → … → Installa da VSIX*.
