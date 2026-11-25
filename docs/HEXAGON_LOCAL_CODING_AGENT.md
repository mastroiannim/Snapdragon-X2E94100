# Get Started: Hexagon Kilo Plugin

Guida operativa per installare, configurare e usare **Kilo Code** in locale e offline su **Windows 11 ARM64 (Qualcomm Snapdragon X2 Elite)** con il plugin [`@hexagon/kilo-plugin`](../plugins/hexagon-runtime/package.json) e `llama-server.exe` accelerato su NPU Hexagon (`HTP0`) e GPU Adreno (`GPUOpenCL`).

---

## 1. Prerequisiti

1. **Piattaforma:** Windows 11 **ARM64** su Snapdragon supportato, con driver NPU/FastRPC e OpenCL funzionanti.
2. **Qualcomm GenieX CLI:** installato in `%LOCALAPPDATA%\GenieX CLI` (o nel `PATH`) con almeno un modello `.gguf` scaricato nella cache `%USERPROFILE%\.cache\geniex\models` (es. tramite `geniex pull`).
3. **Node.js (v20+)** e **Kilo Code CLI** (`@kilocode/cli`, comando `kilo` disponibile nel `PATH`).

> [!NOTE]
> Internet serve solo al primo allineamento per scaricare i frontend Windows ARM64 di `llama.cpp` corrispondenti al commit di GenieX (con verifica SHA-256). Dopo la preparazione, il runtime lavora esclusivamente in locale su `http://127.0.0.1:18803/v1`.

---

## 2. Primo avvio in 3 passi

Esegui i comandi dalla root del repository:

### Passo 1 — Compila il plugin

*(Necessario la prima volta o dopo un aggiornamento del repository.)*

```powershell
cd plugins\hexagon-runtime
npm install
npm run build
cd ..\..
```

### Passo 2 — Controlla prerequisiti e sicurezza offline

```powershell
.\setup-kilo.ps1 -VerifyOffline
```

Verifica piattaforma ARM64, Node.js, Kilo CLI, allineamento tra GenieX e `llama-server.exe`, firma del catalogo `libggml-htp.cat`, presenza dei modelli GGUF, sicurezza loopback di [kilo.json](../kilo.json) e integrità dei ruoli in [.kilo/agents/](../.kilo/agents/code.md).

### Passo 3 — Configura il workspace e avvia Kilo Code

```powershell
node .\plugins\hexagon-runtime\dist\cli.js setup --workspace
kilo
```

In alternativa puoi avviare direttamente con il launcher PowerShell o con doppio clic da Esplora File:

```powershell
.\launch-kilo.ps1        # oppure .\launch-kilo.bat
```

### Cosa fa automaticamente il plugin all'avvio della sessione

1. **Allineamento runtime (`sync`):** controlla il commit tra `geniex.exe` e `%USERPROFILE%\llama-cpp\llama-bin-win-cpu-arm64`; se mancante o disallineato esegue l'aggiornamento atomico con backup e rollback automatico (`sync-geniex.ps1`).
2. **Catalogo modelli (`hexagon-models.ini`):** scansiona `%USERPROFILE%\.cache\geniex\models` (associando eventuali `mmproj*.gguf` multimodali) e assegna a ciascun modello il backend (`HTP0`, `GPUOpenCL` o split ibrido) e il contesto supportato.
3. **Avvio router (`127.0.0.1:18803`):** se la porta è libera, avvia `llama-server.exe` con `ADSP_LIBRARY_PATH` impostato sulla directory runtime e attende `/health` (fino a 30 secondi per il warm-up del grafo HTP). Se sulla porta risponde già un altro `llama-server`, lo riusa senza interferire; se risponde un processo estraneo, annulla l'avvio.
4. **Continuità e tool calling:** un watchdog controlla `/health` ogni 15 secondi e sui modelli locali viene impostato `reasoning_effort: "none"` per rendere affidabili le chiamate ai tool.

---

## 3. Usare Hexagon anche fuori da questo repository

Kilo Code legge la configurazione del workspace corrente (`kilo.json`). Per avere il provider `hexagon` e il plugin pronti in **qualsiasi progetto sul tuo PC**:

```powershell
node .\plugins\hexagon-runtime\dist\cli.js setup --global
```

Il comando registra il provider e il percorso locale del plugin in `%USERPROFILE%\.config\kilo\kilo.jsonc` (o `kilo.json` se già presente), creando prima un backup con timestamp e rifiutandosi di sovrascrivere file non validi. Da quel momento puoi aprire qualsiasi cartella ed eseguire direttamente `kilo`.

---

## 4. Selezione modelli e ruoli agente

### Modelli predefiniti e rilevamento automatico

Durante il setup e all'avvio del plugin, i modelli disponibili vengono scoperti dinamicamente nella cache GGUF:

- Se presenti, vengono privilegiati `Ornith-1.5-9B-Q4_0` come modello principale (`model`, contesto `65.536`) e `MiniCPM5-2B-Q4_K_M` come modello rapido (`small_model`, contesto `65.536`) per esplorazione e domande brevi.
- Se quei due modelli non sono presenti, il plugin sceglie automaticamente la coppia migliore tra i `.gguf` disponibili (escludendo eventuali modelli marcati `incompatible` nel registro locale).
- Puoi sempre impostare manualmente i modelli preferiti:
  ```powershell
  node .\plugins\hexagon-runtime\dist\cli.js setup --workspace --main-model "<id-modello>" --small-model "<id-small>"
  ```
  oppure al lancio con `.\launch-kilo.ps1 -Model "hexagon/<id>" -SmallModel "hexagon/<id>"`.

### Ruoli disponibili (`.kilo/agents/`)

| Ruolo | Modalità | Uso consigliato | Permessi di modifica / comandi |
| :--- | :--- | :--- | :--- |
| `code` | `primary` | Sviluppo e modifiche al codice | `edit: ask`, `write: ask`, `bash: ask` |
| `plan` | `primary` | Progettazione e piani operativi | Scrive solo in `plans/*.md` / `.kilo/plans/*.md`, `bash: deny` |
| `debug` | `primary` | Diagnosi errori ed esecuzione test | `edit: ask`, `write: ask`, `bash: ask` |
| `ask` | `primary` | Spiegazioni e ispezione runtime | `edit: deny`, `write: deny`, `bash: ask` (include `hexagon_status` / `hexagon_models`) |
| `explore` | `subagent` | Ricerca veloce nel repository | Sola lettura (`edit/write/bash/task: deny`) |
| `reviewer` | `subagent` | Revisione diff e sicurezza | Sola lettura (`edit/write/bash/task: deny`) |

Per avviare direttamente uno specifico ruolo o inviare un singolo prompt non interattivo:

```powershell
.\launch-kilo.ps1 -Agent plan
.\launch-kilo.ps1 -Agent ask -Message "Verifica quali modelli GGUF sono disponibili"
```

---

## 5. Tool disponibili dentro Kilo Code

Durante una sessione, l'agente dispone di 7 tool dedicati per gestire e diagnosticare lo stack Hexagon:

| Tool | Cosa fa |
| :--- | :--- |
| `hexagon_status` | Stato del router (`127.0.0.1:18803`), latenza `/health`, modelli caricati, telemetria offload/warm-up dai log e allineamento binario GenieX. |
| `hexagon_models` | Elenca tutti i `.gguf` trovati in cache con stato (`certified`, `untested`, `incompatible`), dimensione e profilo hardware calcolato. |
| `hexagon_qualify` | Esegue il Qualification Gate (`llama-bench`) su un singolo modello per promuoverlo a `certified` o isolarlo come `incompatible` in `%LOCALAPPDATA%\Hexagon\models-registry.json`. |
| `hexagon_bench` | Esegue un benchmark empirico (`model`, `device`, `tensorSplit` opzionali) riportando velocità (`t/s`), offload e consumi PMIC quando disponibili. |
| `hexagon_sync` | Riallinea manualmente `llama.cpp` ai binari GenieX e aggiorna catalogo INI e router. |
| `hexagon_restart` | Arresta e riavvia in modo controllato il router `llama-server.exe` ricaricando `hexagon-models.ini`. |
| `hexagon_setup` | Allinea il provider `hexagon` in `kilo.json` (`workspace: true`) o nella configurazione globale (`workspace: false`). |

> [!TIP]
> Il watcher periodico in background sincronizza il catalogo modelli senza eseguire benchmark pesanti automatici. Per abilitare anche la qualificazione automatica in background sui nuovi `.gguf`, imposta la variabile d'ambiente `HEXAGON_ENABLE_AUTO_BENCHMARK=1` prima di avviare `kilo`.

---

## 6. Riferimento rapido comandi

### CLI del plugin (`cli.js`)

```powershell
# Configura il workspace o il profilo globale (opzioni: --port, --host, --models-dir, --ini, --main-model, --small-model, --json)
node .\plugins\hexagon-runtime\dist\cli.js setup --workspace
node .\plugins\hexagon-runtime\dist\cli.js setup --global

# Stato completo di router, modelli caricati e runtime GenieX
node .\plugins\hexagon-runtime\dist\cli.js status --check-runtime

# Aggiorna hexagon-models.ini dai GGUF in cache e ricarica il router se necessario
node .\plugins\hexagon-runtime\dist\cli.js sync

# Valida schema kilo.json, loopback obbligatorio e agenti .kilo/agents/*.md
node .\plugins\hexagon-runtime\dist\cli.js validate --workspace .
```

### Script wrapper Windows

| Comando | Uso |
| :--- | :--- |
| `.\setup-kilo.ps1 [-CheckOnly] [-VerifyOffline]` | Controllo prerequisiti, integrità runtime e conformità offline. |
| `.\launch-kilo.ps1 [-CheckOnly] [-GenerateConfigOnly] [-NoAutoStart] [-Pure]` | Avvio integrato router + Kilo Code (o sola verifica / rigenerazione `kilo.json`). |
| `.\launch-hexagon.ps1 [-Mode Router \| Direct] [-ListOnly] [-DryRun] [-Model <file>]` | Avvio diretto o router standalone di `llama-server.exe` senza Kilo (`llama-server.bat` / `llama-server-all.bat`). |

---

## 7. Diagnostica e risoluzione problemi

- **Log del server:** `%LOCALAPPDATA%\Hexagon\logs\llama-server.log`
- **Registro qualificazione modelli:** `%LOCALAPPDATA%\Hexagon\models-registry.json`
- **File preset generato:** `hexagon-models.ini` (nella root del workspace o in `%LOCALAPPDATA%\Hexagon\hexagon-models.ini`)

Problemi frequenti:

- **`geniex.exe non trovato`:** installa Qualcomm GenieX CLI e assicurati che sia in `%LOCALAPPDATA%\GenieX CLI` o nel `PATH`.
- **Nessun modello trovato:** scarica almeno un `.gguf` nella cache di GenieX (`%USERPROFILE%\.cache\geniex\models`) oppure specifica `--models-dir <percorso>`.
- **Porta `18803` occupata da un altro processo:** libera la porta o usa una porta diversa con `--port <N>` / `-Port <N>`.
- **Errore di caricamento NPU/GPU o timeout `/health`:** verifica `.\launch-kilo.ps1 -CheckOnly`, controlla i log in `%LOCALAPPDATA%\Hexagon\logs\llama-server.log` e consulta la checklist tecnica in [COMPATIBILITA.md](COMPATIBILITA.md).
- **Avvertenze:** progetto sperimentale indipendente, non supportato ufficialmente da Qualcomm né da Kilo Code; mantenere il binding su `127.0.0.1` su reti non attendibili.
