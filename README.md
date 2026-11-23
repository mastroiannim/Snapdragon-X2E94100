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

L'entry point consigliato e' **Kilo Code** con il plugin nativo `hexagon-runtime`
(architettura zero-setup: niente TUI Python, niente Control Center):

```powershell
.\setup-kilo.ps1              # verifica prerequisiti, runtime e sicurezza offline
.\launch-kilo.ps1             # avvia il router Hexagon su loopback e apre Kilo Code
```

Alla creazione di una sessione Kilo, il plugin `plugins/hexagon-runtime` allinea
automaticamente il runtime al commit GenieX, avvia `llama-server.exe` con
`ADSP_LIBRARY_PATH` se la porta 18803 e' libera e attende la readiness HTTP
(warm-up del grafo HTP). I launcher specializzati restano disponibili per
l'automazione e l'uso headless:

```powershell
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

Il vecchio aggiornamento automatico del commit `dbbb499` non deve essere usato su un'installazione da preservare. La versione del PR #1 lo disabilita rimuovendone il codice; conserva soltanto la verifica del runtime. Vedi le [precondizioni specifiche dell'innesto](docs/COMPATIBILITA.md#verifiche-innesto-geniex-llamacpp).

**Stato:** le scelte di dispositivo, gli split e le dimensioni di contesto del launcher sono *euristiche sperimentali*, non configurazioni ottimali dimostrate. L'enumerazione dei device non equivale a una prova di inferenza sulla NPU. Nessun limite universale di modello a 14-15 GB o di contesto a 4096/65536 token è stabilito da questo progetto.

- [Precondizioni di compatibilità e procedura di verifica](docs/COMPATIBILITA.md)
- [Guida Hexagon Local Coding Agent (Kilo Code)](docs/HEXAGON_LOCAL_CODING_AGENT.md)
- [Benchmark storici, con limitazioni metodologiche](BENCHMARK.md)
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
3. **Caricamento On-Demand & Budget RAM:** I modelli vengono caricati solo quando invocati dai client API (es. Cline). Il parametro `-ModelsMax` (default: `2`) mantiene in memoria contemporaneamente al massimo $N$ modelli, scaricando i meno recenti (LRU) per rimanere sempre all'interno del budget di 48 GB di RAM fisica LPDDR5X.
4. **Endpoint OpenAI compatibile:** Esponendo `/v1/models` e `/v1/chat/completions`, qualsiasi client o estensione (Cline, Continue, Roo Code) può passare da un modello all'altro semplicemente specificandone l'alias.

**Cronologia:** il PR #1 aveva rimosso l'installazione automatica. Nel branch
`feat/tui-openclaw` e' ripristinata con un motore condiviso (`runtime-update.psm1`),
preparazione separata e prove di errore/ripristino. I test del solo blocco `-Apply`
non sono piu' il criterio di verifica dell'updater.

`-ListOnly` e `-DryRun` possono ancora creare hard-link dei modelli durante la scansione;
la loro esclusione dal bootstrap riguarda il runtime, non tutti gli effetti del launcher.
Un hard-link non creato (per esempio tra volumi diversi) viene segnalato con un warning:
il modello resta nella sotto-cartella ma non è visibile al router.

Per integrazioni read-only usare `-ListOnly -Json`, `-Mode Direct -DryRun -Json` oppure
`-Mode Router -DryRun -Json`: questi contratti non creano link, non scrivono l'INI e non
avviano processi. L'output contiene metadati, euristiche, argomenti CLI e, per Router,
il contenuto INI proposto.

Il server espone un endpoint compatibile OpenAI sulla porta `18803`. Il binding predefinito è `127.0.0.1`. L'accesso LAN richiede `-BindHost` esplicito; **non esporre l'endpoint senza autenticazione su una rete non attendibile**.

## Plugin Kilo hexagon-runtime (architettura zero-setup)

La TUI Python e il Control Center (`tui.py`, `hexagon_app.py`, `hexagon_control/`)
sono stati rimossi. La gestione del runtime vive nel plugin TypeScript
`plugins/hexagon-runtime` (`@hexagon/kilo-plugin`), registrato in `kilo.json`:

```json
{ "plugin": ["./plugins/hexagon-runtime"] }
```

Il plugin usa l'API `@kilocode/plugin` (default export `Plugin = (input) => Promise<Hooks>`)
e mantiene `launch-hexagon.ps1` come unica fonte delle euristiche hardware:

- **`sync.ts`** — legge `LlamaCPP Runtime Hash` da `geniex.exe --version` e il commit
  da `llama-server.exe --version`; se disallineati o con file mancanti
  (`ggml-hexagon.dll`, `libggml-htp.cat`, `libggml-htp-v*.so`, `ggml-opencl.dll`)
  invoca `sync-geniex.ps1 -Apply -NoStopServer -Json`, lo stesso motore transazionale
  dei launcher PowerShell.
- **`process.ts`** — router su `127.0.0.1:18803`; se la porta non risponde avvia
  `llama-server.exe` con `ADSP_LIBRARY_PATH` impostato tassativamente sulla directory
  runtime (piu' `GGML_HEXAGON_OPBATCH`/`GGML_HEXAGON_VTCM_SIZE`). Verifica d'identita'
  del rispondente (`probeRouter`: shape OpenAI di `/v1/models` o `status` di `/health`):
  un llama-server gia' attivo non viene toccato, un processo estraneo sulla porta
  viene segnalato e l'avvio rifiutato. Zero-setup INI: se `hexagon-models.ini` manca,
  `ensureModelsIni` lo genera dalla preview `launch-hexagon.ps1 -Mode Router -DryRun -Json`
  (unica fonte delle euristiche hardware) e ne persiste `ini_content`. Parsing INI
  per device `HTP0` (NPU), `GPUOpenCL` e split ibridi.
- **`health.ts`** — polling `http://127.0.0.1:18803/health` ogni 1000 ms, fino a 30
  tentativi (30 s): il tempo di allocazione del grafo HTP sulla NPU. `probeHealth`
  distingue `ready`/`loading`/`down` per il watchdog.
- **`watchdog.ts`** — sorveglianza periodica (default 15 s) a tick non sovrapposti:
  se il router e' `down` recupera con `ensureServer` + `waitForHealth`; se e'
  `loading` (warm-up NPU) attende senza riavviare. Avviato dopo il bootstrap della
  prima sessione, fermato quando l'ultima sessione chiude o l'istanza viene dismessa.
- **`models.ts`** — contesti reali testati, senza i limiti dichiarati da GenieX:
  `Ornith-1.5-9B-Q4_0` e `MiniCPM5-2B-Q4_K_M` a 65.536 token; `flint-UD-Q4_K_XL` e
  `gpt-oss-20b-Q4_0` a 131.072 token. `buildHexagonProvider` costruisce la
  configurazione dinamica del provider (catalogo testato + sezioni INI, limiti di
  output con la stessa regola di `kilo_config.py`).
- **`tools.ts`** — agent tool per Kilo: `hexagon_status` (stato router, latenza,
  modelli caricati), `hexagon_sync` (riallineamento runtime forzato),
  `hexagon_bench` (token/s per profilo NPU/GPU da `benchmark-hexagon.ps1`, con
  telemetria PMIC completa: NPU/GPU/CPU/RAM/INFRA/SoC/Sistema in W e deviazione
  standard; i valori non misurati sono `null`, mai zero).
- **`index.ts`** — hook `config` per la configurazione dinamica del provider
  `hexagon` a runtime (senza scrivere `kilo.json`: opzioni utente e modelli ignoti
  al plugin preservati, contesti testati prioritari); hook `event`/`session.created`
  per il bootstrap automatico (sync → INI → avvio → health) e il ciclo di vita del
  watchdog (`session.deleted`, `server.instance.disposed`); hook `chat.params` che
  inietta `reasoning_effort: "none"` sui modelli del provider locale `hexagon`, per
  un tool-calling deterministico.

Gli helper Python superstiti (`stack_manager.py`, `kilo_config.py`) sono usati solo
dagli script PowerShell di setup/launcher; le dipendenze TUI (`rich`,
`prompt_toolkit`, `textual`) non sono piu' richieste.

## Verifiche riproducibili

Suite del plugin (mock di OS/subprocess/HTTP, nessun hardware Qualcomm richiesto):

```powershell
cd plugins\hexagon-runtime
npm install
npm run build                 # tsc, tipi @kilocode/plugin
npm test                      # Vitest + coverage v8 (soglie 90%)
```

Test PowerShell del core engine (invariati dopo il pivot):

```powershell
powershell -ExecutionPolicy Bypass -File tests\runtime-readonly.ps1
powershell -ExecutionPolicy Bypass -File tests\runtime-update.ps1
powershell -ExecutionPolicy Bypass -File tests\entrypoints.ps1
powershell -ExecutionPolicy Bypass -File tests\benchmark-profiles.ps1
```

Regressioni degli helper Python superstiti (`stack_manager`, `kilo_config`):

```powershell
python -m unittest discover -s tests -p "test_*.py" -v
```

Lo stato di avanzamento del pivot e' registrato in `.kilo/checkpoint.json`
(CP-0 → CP-5); il branch `backup/pre-kilo-pivot` conserva il punto di ripristino.


## Profilazione e risultati

**Compatibilità funzionale osservata nei percorsi esercitati; riproducibilità non ancora stabilita; universalità non dimostrata.** I benchmark storici riportano esecuzioni di `llama-bench.exe` con frontend `llama.cpp` e componenti runtime provenienti da GenieX sullo Snapdragon X2E94100. Sono evidenze di caricamento ed esecuzione del calcolo su modelli GGUF, oltre la sola enumerazione dei dispositivi. Un'esecuzione completata esclude un'incompatibilità ABI che impedisca quei percorsi, ma non certifica tutte le interfacce, la correttezza numerica degli output o il funzionamento di `llama-server.exe`.

Il manifest SHA-256 serve a identificare e riprodurre l'insieme di binari che ha funzionato; la sua assenza non annulla l'evidenza di esecuzione riportata. Un manifest acquisito oggi identifica l'installazione attuale e non ricostruisce automaticamente quella storica.

Il launcher usa classificazione GGUF, dimensione file, MoE/SWA e soglie dimensionali per proporre `HTP0`, `GPUOpenCL` o uno split. I rapporti come `80,20`, `75,25`, `50,50` **non sono probabilità né quote garantite di carico computazionale**, e la dimensione del GGUF non misura da sola pressione di mapping, occupazione della KV cache o supporto degli operatori.

Il [benchmark storico](BENCHMARK.md) conserva i valori acquisiti, ma non è una prova riproducibile dell'origine dei rallentamenti. Campioni di potenza e throughput non erano necessariamente riferiti alla stessa fase. Il separatore `/` è previsto da `llama-bench` per `-dev` e `-ts`: è indicato dall'help locale e confermato dal [parser della revisione storica e467e5b](https://github.com/ggml-org/llama.cpp/blob/e467e5b/tools/llama-bench/llama-bench.cpp). Non costituisce un errore dello script; la sintassi va distinta da quella degli altri frontend. Comandi effettivi e log rimangono necessari per documentare l'offload, indipendentemente dai separatori. Le colonne `J/token` storiche non devono essere citate come misura energetica validata.

Per stabilire la configurazione migliore servono, a parità di modello/quantizzazione/versione/contesto: log dei device e dell'offload, velocità prefill e decode separate, repliche, errori, temperatura, potenza di base e intervalli energetici sincronizzati.

## Fonti primarie

- [Qualcomm — GenieX Developer Preview (7 luglio 2026)](https://www.qualcomm.com/developer/blog/2026/06/geniex-developer-preview)
- [GenieX SDK — due runtime distinti: llama_cpp e qairt](https://github.com/qualcomm/GenieX/blob/main/sdk/README.md)
- [Qualcomm — How AI models reach Hexagon NPU (2 ottobre 2026)](https://www.qualcomm.com/developer/blog/2026/10/how-ai-models-reach-hexagon-npu-qairt-fastrpc-hexagon-explained)
- [llama.cpp — Snapdragon backend](https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/snapdragon/README.md)
- [llama.cpp — Hexagon developer details](https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/snapdragon/developer.md)
- [llama.cpp — Windows, driver e firma](https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/snapdragon/windows.md)
- [Microsoft — MCDM](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/mcdm)
