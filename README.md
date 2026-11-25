# llama.cpp su Snapdragon X2E94100 (Windows ARM64)

Progetto sperimentale per eseguire modelli GGUF con `llama.cpp` su CPU Oryon, GPU Adreno (`GPUOpenCL`) e NPU Hexagon (`HTP0`), anche in combinazione quando il backend e il modello lo consentono.

## Il punto distintivo: riuso selettivo del runtime GenieX

Il progetto nasce da un **innesto di componenti binari già distribuiti con GenieX** in un'installazione autonoma di `llama.cpp`. Non è un nuovo driver NPU, non modifica il firmware e non “sblocca” FastRPC. Consente di sperimentare con le opzioni native di `llama-server.exe` mantenendo, quando l'insieme di componenti è effettivamente compatibile, i backend GGML/HTP e OpenCL forniti con GenieX.

Il [post ufficiale GenieX Developer Preview, pubblicato il 7 luglio 2026](https://www.qualcomm.com/developer/blog/2026/06/geniex-developer-preview) chiarisce che GenieX **include già `llama.cpp`** e offre **anche un proprio server locale compatibile OpenAI**. GenieX espone separatamente un runtime `llama_cpp` per GGUF (CPU/GPU/HTP) e un runtime `qairt` per i pacchetti QAIRT precompilati; il nostro innesto riguarda il **primo**, non sostituisce né riutilizza automaticamente i kernel del secondo.

### Primo avvio e aggiornamento automatico

Su **Windows 11 ARM64**, l'unico prerequisito software da installare manualmente e'
**GenieX CLI di Qualcomm**, con il runtime `llama_cpp`. Il primo setup usa Internet;
non richiede Git, CMake, Visual Studio, SDK Hexagon/QNN o una precedente installazione
llama.cpp. I modelli GGUF sono contenuti di input: il launcher usa quelli presenti
nella cache di GenieX (`geniex pull`), oppure la directory specificata con `-ModelsDir`.

L'entry point consigliato e' **Kilo Code** con il plugin nativo `@hexagon/kilo-plugin`
(architettura disaccoppiata e distribuibile, zero-setup):

```powershell
# 1. Setup una tantum del provider locale (100% TypeScript):
node .\plugins\hexagon-runtime\dist\cli.js setup --workspace

# 2. Avvio diretto di Kilo Code (da qualsiasi cartella o progetto):
kilo
```

Alla creazione di una sessione Kilo, il plugin `plugins/hexagon-runtime` allinea
automaticamente il runtime al commit GenieX (utilizzando gli script incorporati nel pacchetto),
avvia `llama-server.exe` con `ADSP_LIBRARY_PATH` se la porta 18803 e' libera e attende la readiness HTTP
(warm-up del grafo HTP).

I launcher PowerShell e batch restano disponibili per retrocompatibilita', automazione e uso headless:
```powershell
.\launch-kilo.ps1        # launcher integrato locale
.\setup-kilo.ps1         # verifica prerequisiti, runtime e sicurezza offline
.\llama-server-all.bat   # prepara il runtime e avvia il router
.\llama-server.bat       # prepara il runtime e avvia un singolo modello
```

### Hexagon Local Coding Agent (Kilo Code)

Il progetto include l'integrazione con **Kilo Code CLI** (`@kilocode/cli`) per eseguire flussi agentici di programmazione completi (lettura codice, multi-file edit, esecuzione test, diagnosi errori, code review) interamente in locale e offline su Snapdragon X2 Elite Extreme:

```powershell
.\setup-kilo.ps1              # Verifica 11 prerequisiti, integrità runtime e sicurezza offline
.\launch-kilo.ps1             # Avvia il router Hexagon su loopback e apre Kilo Code
.\launch-kilo.ps1 -CheckOnly  # Controllo diagnostico non intrusivo dello stato
```

Per l'architettura dettagliata, la matrice dei modelli (Ornith 1.5 9B, MiniCPM5, Qwen Coder 14B), i ruoli personalizzati (`.kilo/agents`) e i benchmark, consultare [docs/HEXAGON_LOCAL_CODING_AGENT.md](docs/HEXAGON_LOCAL_CODING_AGENT.md).

La stessa procedura e' usata al primo avvio e quando cambia il runtime GenieX:

1. Legge `LlamaCPP Runtime Hash` da GenieX e controlla i file installati.
   Se il runtime e' gia' allineato, non scarica nulla.
2. Quando occorrono i frontend, risolve una release Windows ARM64 con lo **stesso
   commit**. La stima del numero b* serve alla ricerca; nessuna build vicina viene
   accettata al posto di quella richiesta.
3. Scarica lo ZIP completo e ne verifica dimensione e SHA-256 pubblicato da GitHub.
   Per GenieX 0.10.0, la release b11938 corrisponde a `19cce6919` e lo ZIP CPU ARM64
   pesa circa 13 MB. L'estrazione usa le librerie ZIP standard di .NET.
4. Prepara una directory separata con frontend e copie del runtime GenieX; verifica
   eseguibili ARM64, hash, versione ed enumerazione HTP0/GPUOpenCL. Registra il
   manifest `hexagon-runtime.json`. Questi controlli non sostituiscono l'inferenza.
5. Solo dopo la preparazione sostituisce la directory installata, conservando quella
   precedente come backup. Errori di preparazione lasciano intatta l'installazione;
   errori dopo la sostituzione attivano il ripristino. Un ripristino fallito viene
   segnalato e conserva il backup.

I launcher aggiornano automaticamente prima dell'avvio. `sync-geniex.ps1` senza
opzioni resta un controllo; `-Apply` e l'alias legacy `-AutoConfirm` abilitano il setup.
`-CheckRuntime` sul launcher richiede il solo controllo. `-ListOnly` e `-DryRun` non
installano il runtime e funzionano anche senza `llama-server.exe`.

Le copie sono il default per isolare i file da successive scritture di GenieX.
`sync-geniex.ps1 -Apply -UseHardLinks` mantiene l'opzione hard-link con fallback alla
copia: in quel caso origine e destinazione condividono i dati. Un aggiornamento
arresta e riavvia soltanto i processi `llama-server.exe` della directory interessata;
`-NoStopServer` consente invece di rifiutare la sostituzione se sono attivi.

**Il risultato è una composizione sperimentale, non un pacchetto ufficiale né una compatibilità garantita da Qualcomm.** La firma e il catalogo del DSP non sanano un'incompatibilità fra DLL e frontend. La licenza BSD-3-Clause del *progetto open source GenieX* non dimostra, da sola, il diritto di ridistribuire ogni artefatto SDK, runtime o catalogo incluso in un installer: vanno esaminati provenienza e termini di ciascun componente. Il repository descrive l'impiego locale dei componenti; non deve presentare un bundle misto come certificato o supportato ufficialmente.

Il vecchio aggiornamento automatico del commit `dbbb499` è stato sostituito da un motore transazionale (`runtime-update.psm1`) con verifica di hash e ripristino sicuro da backup. Vedi le [precondizioni specifiche dell'innesto](docs/COMPATIBILITA.md#verifiche-innesto-geniex-llamacpp).

**Stato:** le scelte di dispositivo, gli split e le dimensioni di contesto del launcher sono *euristiche sperimentali*, non configurazioni ottimali dimostrate. L'enumerazione dei device non equivale a una prova di inferenza sulla NPU. Nessun limite universale di modello a 14-15 GB o di contesto a 4096/65536 token è stabilito da questo progetto.

- [Precondizioni di compatibilità e procedura di verifica](docs/COMPATIBILITA.md)
- [Guida Hexagon Local Coding Agent (Kilo Code)](docs/HEXAGON_LOCAL_CODING_AGENT.md)
- [Launcher](launch-hexagon.ps1) · [Benchmark](benchmark-hexagon.ps1) · [Sincronizzatore sperimentale](sync-geniex.ps1)

## Architettura: due percorsi distinti

**QAIRT/QNN:** Qualcomm AI Runtime fornisce API, strumenti e backend per CPU/GPU/HTP. Nella via QNN HTP, le librerie host e le componenti DSP/stub/skel devono essere compatibili con sistema operativo, architettura host, versione HTP e runtime. QAIRT non implica per definizione un contesto fisso a 4096 token o l'obbligo di un unico grafo monolitico statico.

**GGML Hexagon di llama.cpp (questo progetto):**

```text
GGUF -> llama-server.exe / GGML
                 |
                 v
    ggml-hexagon.dll (host ARM64)
                 |
         interfaccia stub / FastRPC
                 |
           skel e dispatcher
                 |
    libggml-htp-vNN.so (kernel HTP)
                 |
           NPU Hexagon
```

Il backend GGML usa un proprio percorso di esecuzione sul DSP, senza richiedere la compilazione dei modelli GGUF tramite QNN. **Non bypassa FastRPC, i servizi/driver di piattaforma, i requisiti di firma su Windows o il firmware DSP.** L'HTP esegue gli operatori che il backend supporta; gli altri possono restare su CPU o altri device. Una configurazione `-dev HTP0,GPUOpenCL` non garantisce che tutti gli operatori siano offloaded.

Su Windows Snapdragon, **MCDM (Microsoft Compute Driver Model)** offre l'infrastruttura driver compute/NPU; **FastRPC** svolge il trasporto delle chiamate tra processor domains con proprie librerie di servizio. Qualcomm distingue espressamente MCDM da FastRPC: il primo non va denominato semplicemente “driver FastRPC”.

Il backend GGML utilizza memoria DDR condivisa e VTCM per dati temporanei. Lo spazio di indirizzamento di una **singola sessione HTP** non coincide con la dimensione massima del GGUF: la gestione di modelli grandi dipende dalla versione del backend, dal mapping dei buffer e/o dalla suddivisione tra sessioni/device. Il rallentamento osservato su alcuni modelli non dimostra, da solo, saturazione FastRPC o fallback CPU. Nemmeno uno split CPU/NPU/GPU prova l'esistenza di canali DDR fisicamente indipendenti.

Riferimenti: [Qualcomm, FastRPC e stub/skel](https://www.qualcomm.com/developer/blog/2026/10/how-ai-models-reach-hexagon-npu-qairt-fastrpc-hexagon-explained) · [GGML Hexagon: architettura e memoria](https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/snapdragon/developer.md).

## Requisiti prima dell'uso

1. **Host e piattaforma.** Windows 11 **ARM64** su Snapdragon supportato; driver NPU, servizi FastRPC e firmware compatibili con il dispositivo. Per la GPU occorrono anche driver Adreno/OpenCL funzionanti. Le librerie host (`.exe`, `.dll`) devono essere compilate per ARM64.
2. **Versione HTP corretta.** Il backend host e l'artefatto DSP `libggml-htp-vNN.so` devono corrispondere all'architettura Hexagon effettiva (per esempio v81 sul sistema oggetto degli esperimenti); non selezionare una `vNN` dalla sola dimensione del modello.
3. **Compatibilità dell'insieme di binari.** `llama-server.exe`, librerie `llama`/`ggml`, backend GPU/HTP, DLL dipendenti e artefatti DSP devono provenire da una combinazione compatibile. **Stesso commit è un indizio importante ma non sufficiente** per provare ABI, set di backend, driver e firma.
4. **Catalogo HTP attendibile.** Su Windows il catalogo `libggml-htp.cat` deve essere correttamente firmato da un certificato attendibile e riferito agli artefatti HTP installati. Non è obbligatoriamente una firma WHQL Qualcomm: la documentazione upstream descrive anche certificati di test propri, in un *ambiente di sviluppo configurato esplicitamente* per test-signing. Non disabilitare Secure Boot o le protezioni del sistema come procedura predefinita.
5. **Percorsi e modelli.** Questo launcher presume `%USERPROFILE%\llama-cpp\llama-bin-win-cpu-arm64` per il server e `%USERPROFILE%\.cache\geniex\models` per i GGUF. `ADSP_LIBRARY_PATH` deve risolvere le librerie DSP compatibili; il launcher la imposta per il processo e gli eventuali figli.
6. **Conferma reale.** Verificare `--version`, `--list-devices`, caricamento di un GGUF compatibile e log di offload durante *un'inferenza effettiva*. La sola presenza di `HTP0` o `GPUOpenCL` nell'elenco non basta.

**GenieX non è prerequisito universale del backend GGML Hexagon**, perché una build autonoma può generare i propri backend. **Per l'innesto specifico implementato da questo repository è invece la sorgente locale delle DLL GGML e degli artefatti HTP**, dunque `sync-geniex.ps1` richiede GenieX installato. Non presentare il riuso di tali file come supporto ufficiale alla combinazione con frontend di un'altra release: i benchmark storici supportano la compatibilità funzionale nei percorsi esercitati; manifest, hash, dipendenze e log servono a documentare l'insieme effettivamente utilizzato e a stabilirne la riproducibilità.

Per controlli non distruttivi, prerequisiti dettagliati, diagnosi e tracciabilità dei componenti vedere [docs/COMPATIBILITA.md](docs/COMPATIBILITA.md).

## Uso del launcher e versioni dello script

```powershell
# Solo inventario (non avvia il server)
.\launch-hexagon.ps1 -ListOnly

# Pianificazione degli argomenti per un modello specifico (non avvia il server)
.\launch-hexagon.ps1 -Model "LFM2.5-24B" -DryRun

# Avvio diretto del singolo modello consigliato o specificato
.\launch-hexagon.ps1 -Model "nome-modello.gguf"

# Modalità ROUTER: espone TUTTI i modelli contemporaneamente con configurazione hardware ottimale per ciascuno
.\launch-hexagon.ps1 -Mode Router

# Anteprima del file INI generato per il Router (senza avviare il server)
.\launch-hexagon.ps1 -Mode Router -DryRun

# Oppure tramite wrapper batch:
.\llama-server.bat                     # Avvia il modello top-performer (LFM 2.5 24B)
.\llama-server-all.bat                 # Avvia TUTTI i modelli in modalità Router
```

### Dettagli Modalità Router (`-Mode Router`)
La modalità Router sfrutta il routing nativo di `llama-server` (`--models-dir`, `--models-preset`, `--models-max`):
1. **Analisi istantanea dei metadati GGUF:** Lo script scansiona la cartella modelli (`%USERPROFILE%\.cache\geniex\models`) ed estrae architettura, quantizzazione, teste KV, Sliding Window e parametri MoE tramite parser C# in-memory.
2. **Generazione automatica `hexagon-models.ini`:** Genera un file di preset INI ottimizzato (senza BOM UTF-8) che imposta per ciascun modello il device corretto (`HTP0`, `GPUOpenCL` o split ibrido 80/20, 75/25, 50/50) e la finestra di contesto conforme al limite buffer DMA FastRPC (< 1 GiB).
3. **Caricamento On-Demand & Budget RAM:** I modelli vengono caricati solo quando invocati dai client API (es. Kilo Code). Il parametro `-ModelsMax` (default: `2`) mantiene in memoria contemporaneamente al massimo $N$ modelli, scaricando i meno recenti (LRU) per rimanere sempre all'interno del budget di 48 GB di RAM fisica LPDDR5X.
4. **Endpoint OpenAI compatibile:** Esponendo `/v1/models` e `/v1/chat/completions`, Kilo Code e qualsiasi altro client compatibile OpenAI possono passare da un modello all'altro semplicemente specificandone l'alias.

L'installazione e l'aggiornamento automatico del runtime si basano sul modulo condiviso `runtime-update.psm1`, con preparazione separata in directory di staging e prove di ripristino/rollback transazionale.

`-ListOnly` e `-DryRun` possono ancora creare hard-link dei modelli durante la scansione;
la loro esclusione dal bootstrap riguarda il runtime, non tutti gli effetti del launcher.
Un hard-link non creato (per esempio tra volumi diversi) viene segnalato con un warning:
il modello resta nella sotto-cartella ma non è visibile al router.

Per integrazioni read-only usare `-ListOnly -Json`, `-Mode Direct -DryRun -Json` oppure
`-Mode Router -DryRun -Json`: questi contratti non creano link, non scrivono l'INI e non
avviano processi. L'output contiene metadati, euristiche, argomenti CLI e, per Router,
il contenuto INI proposto.

Il server espone un endpoint compatibile OpenAI sulla porta `18803`. Il binding predefinito è `127.0.0.1`. L'accesso LAN richiede `-BindHost` esplicito; **non esporre l'endpoint senza autenticazione su una rete non attendibile**.

## Plugin Kilo hexagon-runtime (architettura zero-setup e autoconsistente)

La gestione del runtime vive nel plugin TypeScript `plugins/hexagon-runtime` (`@hexagon/kilo-plugin`), registrato in `kilo.json`:

```json
{ "plugin": ["./plugins/hexagon-runtime"] }
```

Il plugin è **completamente autoconsistente**: racchiude nei propri asset (`assets/scripts/`) tutti gli helper necessari (`inspect-gguf.ps1`, `sync-geniex.ps1`, `benchmark-hexagon.ps1`, `runtime-update.psm1`) e non ha alcuna dipendenza da tool esterni.

### Moduli architetturali

- **`discovery.ts`** — discovery intelligente dei modelli presenti in `%USERPROFILE%\.cache\geniex\models`:
  - Ispezione rapida dei metadati GGUF (architettura, contesto, KV heads, MoE, quantizzazione) tramite il parser binario C# in-memory `inspect-gguf.ps1` (<50 ms per file, zero memoria allocata per tensori).
  - Separazione automatica dei proiettori multimodali (`mmproj-*.gguf`), che non compaiono come LLM testuali ma vengono associati come proiettori compagni al modello genitore.
  - Calcolo euristico dei profili hardware conformi alle caratteristiche fisiche dello Snapdragon X2 Elite: HTP0 puro (NPU) per modelli compatti <= 6 GB, ibrido HTP0+GPU (80/20, 75/25, 50/50) per modelli medi e MoE, forzatura 100% NPU per LFM2.5 per prevenire crash GPU (`0xC0000005`), e limitazione del contesto a 64k token sui modelli pesanti per evitare l'errore DMA FastRPC (`0x200`).
- **`qualify.ts`** — Qualification Gate hardware e persistenza del registro modelli:
  - Classificazione a 3 stati di affidabilità:
    - `CERTIFIED`: modelli empiricamente qualificati con benchmark reali, contesti lunghi verificati e telemetria PMIC salvata.
    - `UNTESTED`: modelli rilevati nella cache ma non ancora qualificati; restano utilizzabili con allocazione hardware conservativa.
    - `INCOMPATIBLE`: modelli che hanno fallito il caricamento o causato crash hardware (isolati dal catalogo per evitare loop di errore).
  - Registro persistente memorizzato in `%LOCALAPPDATA%\Hexagon\models-registry.json`.
- **`watcher.ts`** — sorveglianza in background: monitora periodicamente la directory modelli ed esegue automaticamente la qualificazione hardware non-bloccante non appena un nuovo file `.gguf` viene completato o scaricato nella cache.
- **`sync.ts`** — sincronizzazione runtime con GenieX: confronta `LlamaCPP Runtime Hash` e il commit di `llama-server.exe`; se disallineati o con binari mancanti (`ggml-hexagon.dll`, `libggml-htp.cat`, `libggml-htp-v*.so`, `ggml-opencl.dll`), invoca l'updater transazionale `assets/scripts/sync-geniex.ps1` con rollback automatico in caso di errore.
- **`process.ts`** — gestione router su `127.0.0.1:18803`: verifica d'identità del rispondente (`probeRouter` su `/v1/models` e `/health`), avvio trasparente di `llama-server.exe` con `ADSP_LIBRARY_PATH` vincolato e isolamento delle porte.
- **`health.ts` & `watchdog.ts`** — probing dello stato del server con tolleranza per il warm-up del grafo HTP (fino a 30s) e sorveglianza periodica (default 15s) a tick non sovrapposti per garantire alta disponibilità.
- **`models.ts` & `config.ts`** — contesti reali testati (`Ornith-1.5-9B-Q4_0` a 65.536 token, `flint-UD-Q4_K_XL` a 131.072 token) e installazione automatica della configurazione provider in `kilo.json`.
- **`tools.ts`** — tool esposti all'agente Kilo:
  - `hexagon_status`: stato del router, latenza di risposta, modelli caricati e risorse.
  - `hexagon_sync`: riallineamento manuale del runtime binario con GenieX.
  - `hexagon_bench`: benchmark empirico con telemetria PMIC hardware (potenza NPU, GPU, CPU, RAM, SoC e t/s).
  - `hexagon_setup`: allineamento automatico della configurazione provider locale in `kilo.json`.
  - `hexagon_models`: catalogo completo dei modelli rilevati con stato di certificazione, dimensione e split hardware.
  - `hexagon_qualify`: esecuzione immediata del Qualification Gate hardware su uno specifico modello locale.
- **`index.ts`** — integrazione lifecycle Kilo Code (hook `config`, `session.created`, `chat.params` con iniezione di `reasoning_effort: "none"` per determinismo agentico).

## Verifiche riproducibili

Suite del plugin (mock di OS/subprocess/HTTP, nessun hardware Qualcomm richiesto):

```powershell
cd plugins\hexagon-runtime
npm install
npm run build                 # tsc, tipi @kilocode/plugin
npm test                      # Vitest + coverage v8 (soglie 90%)
```

Test PowerShell del core engine:

```powershell
powershell -ExecutionPolicy Bypass -File tests\runtime-readonly.ps1
powershell -ExecutionPolicy Bypass -File tests\runtime-update.ps1
powershell -ExecutionPolicy Bypass -File tests\entrypoints.ps1
powershell -ExecutionPolicy Bypass -File tests\benchmark-profiles.ps1
```


## Profilazione e risultati

**Compatibilità funzionale osservata nei percorsi esercitati; riproducibilità non ancora stabilita; universalità non dimostrata.** I benchmark storici riportano esecuzioni di `llama-bench.exe` con frontend `llama.cpp` e componenti runtime provenienti da GenieX sullo Snapdragon X2E94100. Sono evidenze di caricamento ed esecuzione del calcolo su modelli GGUF, oltre la sola enumerazione dei dispositivi. Un'esecuzione completata esclude un'incompatibilità ABI che impedisca quei percorsi, ma non certifica tutte le interfacce, la correttezza numerica degli output o il funzionamento di `llama-server.exe`.

Il manifest SHA-256 serve a identificare e riprodurre l'insieme di binari che ha funzionato; la sua assenza non annulla l'evidenza di esecuzione riportata. Un manifest acquisito oggi identifica l'installazione attuale e non ricostruisce automaticamente quella storica.

Il launcher usa classificazione GGUF, dimensione file, MoE/SWA e soglie dimensionali per proporre `HTP0`, `GPUOpenCL` o uno split. I rapporti come `80,20`, `75,25`, `50,50` **non sono probabilità né quote garantite di carico computazionale**, e la dimensione del GGUF non misura da sola pressione di mapping, occupazione della KV cache o supporto degli operatori.

## Fonti primarie

- [Qualcomm — GenieX Developer Preview (7 luglio 2026)](https://www.qualcomm.com/developer/blog/2026/06/geniex-developer-preview)
- [GenieX SDK — due runtime distinti: llama_cpp e qairt](https://github.com/qualcomm/GenieX/blob/main/sdk/README.md)
- [Qualcomm — How AI models reach Hexagon NPU (2 ottobre 2026)](https://www.qualcomm.com/developer/blog/2026/10/how-ai-models-reach-hexagon-npu-qairt-fastrpc-hexagon-explained)
- [llama.cpp — Snapdragon backend](https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/snapdragon/README.md)
- [llama.cpp — Hexagon developer details](https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/snapdragon/developer.md)
- [llama.cpp — Windows, driver e firma](https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/snapdragon/windows.md)
- [Microsoft — MCDM](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/mcdm)
