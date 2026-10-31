# llama.cpp su Snapdragon X2E94100 (Windows ARM64)

Progetto sperimentale per eseguire modelli GGUF con `llama.cpp` su CPU Oryon, GPU Adreno (`GPUOpenCL`) e NPU Hexagon (`HTP0`), anche in combinazione quando il backend e il modello lo consentono.

## Il punto distintivo: riuso selettivo del runtime GenieX

Il progetto nasce da un **innesto di componenti binari già distribuiti con GenieX** in un'installazione autonoma di `llama.cpp`. Non è un nuovo driver NPU, non modifica il firmware e non “sblocca” FastRPC. Consente di sperimentare con le opzioni native di `llama-server.exe` mantenendo, quando l'insieme di componenti è effettivamente compatibile, i backend GGML/HTP e OpenCL forniti con GenieX.

Il [post ufficiale GenieX Developer Preview, pubblicato il 7 luglio 2026](https://www.qualcomm.com/developer/blog/2026/06/geniex-developer-preview) chiarisce che GenieX **include già `llama.cpp`** e offre **anche un proprio server locale compatibile OpenAI**. GenieX espone separatamente un runtime `llama_cpp` per GGUF (CPU/GPU/HTP) e un runtime `qairt` per i pacchetti QAIRT precompilati; il nostro innesto riguarda il **primo**, non sostituisce né riutilizza automaticamente i kernel del secondo.

### Come e' stato realizzato l'innesto storico

Il sincronizzatore originario (`main` al commit `dbbb499`) operava cosi':

1. Ispezionava `%LOCALAPPDATA%\GenieX CLI\llama_cpp` e interrogava `geniex.exe --version --skip-update` per ottenere `LlamaCPP Runtime Hash`.
2. Tentava di selezionare una release Windows ARM64 di `ggml-org/llama.cpp` per recuperare i frontend. La ricerca includeva fallback approssimativi, senza certificare la corrispondenza del commit o dell'ABI.
3. Collegava tramite hard-link, con fallback alla copia, i componenti di `GenieX CLI\llama_cpp` nella cartella dei frontend.
4. Il launcher impostava `ADSP_LIBRARY_PATH` e avviava `llama-server.exe`.

**Con la modifica del [PR #1](https://github.com/mastroiannim/Snapdragon-X2E94100/pull/1), il sincronizzatore diventa un controllo in sola lettura dei binari runtime.** Il downloader, la sostituzione dei file e il rollback sono rimossi. `-Apply` viene rifiutato prima di ogni controllo, anche con `-AutoConfirm`. La preparazione di una nuova composizione richiede una procedura separata; lo script aggiornato non installa il runtime.

```text
GenieX CLI installato                      Release llama.cpp (Windows ARM64)
    |                                                |
    +-- llama_cpp: DLL GGML, backend,                +-- frontend eseguibili
    |   artefatti HTP .so e catalogo .cat                 |
    |                                                |
    +--------- collegamento/copia ---------------------+
                         |
                  cartella llama-bin
                         |
                llama-server.exe + GGML
                         |
            GPUOpenCL / FastRPC / HTP0
```

**Il risultato è una composizione sperimentale, non un pacchetto ufficiale né una compatibilità garantita da Qualcomm.** La firma e il catalogo del DSP non sanano un'incompatibilità fra DLL e frontend. La licenza BSD-3-Clause del *progetto open source GenieX* non dimostra, da sola, il diritto di ridistribuire ogni artefatto SDK, runtime o catalogo incluso in un installer: vanno esaminati provenienza e termini di ciascun componente. Il repository descrive l'impiego locale dei componenti; non deve presentare un bundle misto come certificato o supportato ufficialmente.

Il vecchio aggiornamento automatico del commit `dbbb499` non deve essere usato su un'installazione da preservare. La versione del PR #1 lo disabilita rimuovendone il codice; conserva soltanto la verifica del runtime. Vedi le [precondizioni specifiche dell'innesto](docs/COMPATIBILITA.md#verifiche-innesto-geniex-llamacpp).

**Stato:** le scelte di dispositivo, gli split e le dimensioni di contesto del launcher sono *euristiche sperimentali*, non configurazioni ottimali dimostrate. L'enumerazione dei device non equivale a una prova di inferenza sulla NPU. Nessun limite universale di modello a 14-15 GB o di contesto a 4096/65536 token è stabilito da questo progetto.

- [Precondizioni di compatibilità e procedura di verifica](docs/COMPATIBILITA.md)
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

**Distinguere le versioni:** nel `main` originario (`dbbb499`) il launcher invocava automaticamente il sincronizzatore con `-AutoConfirm`, potendo sostituire binari e DLL. Il PR #1 rimuove quella chiamata: l'opzione `-CheckRuntime` richiede soltanto un controllo, e interrompe l'avvio se fallisce. Verificare di usare la versione aggiornata prima di affidarsi a questo comportamento.

Anche dopo questa modifica, `-ListOnly` e `-DryRun` possono creare hard-link dei modelli durante la scansione: non sono operazioni completamente read-only. La sola lettura del controllore riguarda i binari runtime.

Il server espone un endpoint compatibile OpenAI sulla porta `18803`. Il binding predefinito è `127.0.0.1`. L'accesso LAN richiede `-BindHost` esplicito; **non esporre l'endpoint senza autenticazione su una rete non attendibile**.

## Hexagon Claw TUI (Interfaccia Terminale in Stile OpenClaw)

È inclusa una **Text User Interface (TUI)** avanzata in stile **OpenClaw** (`🐉`), ottimizzata per interagire con `llama-server` e monitorare l'hardware Qualcomm Snapdragon X2 Elite Extreme direttamente da riga di comando.

### Installazione Dipendenze
```bash
pip install -r requirements.txt
```

### Avvio della TUI
```cmd
.\tui.bat                               # Avvio rapido con supporto UTF-8 per console Windows
```
*oppure tramite PowerShell o Python:*
```powershell
.\launch-tui.ps1                        # Launcher PowerShell
python tui.py --model "LFM2.5-24B"      # Con modello specifico iniziale
```

### Caratteristiche Principali
* **Header & Telemetria Hardware:** Banner informativo persistente con stato del server (ping ms), modello attivo, accelerazione hardware (`HTP0`, `GPUOpenCL`, split vettoriale), consumo RAM LPDDR5X (ctypes nativo) e velocità di generazione ($t/s$).
* **Streaming & Pensiero Deep Thought:** Streaming dei token in tempo reale con estrazione e formattazione distinta dei blocchi di ragionamento (`<think> ... </think>`).
* **Autocompletamento Comandi Slash:** Suggerimenti interattivi durante la digitazione (`/`):
  * `/models`: Elenco completo dei modelli disponibili sul router con strategie hardware.
  * `/model <nome>`: Cambio istantaneo del modello attivo (caricato on-demand dal router).
  * `/status`: Dashboard approfondita su architettura SoC, 18 core Oryon, NPU Hexagon e GPU Adreno.
  * `/stack [status|check|sync|update-*]`: Gestione e manutenzione dello stack software e runtime:
    * `/stack status`: Verifica integrità, versioni GenieX CLI (v0.10.0), QAIRT (2.50), commit llama.cpp e stato dei 16 file di runtime GGML e driver NPU WHQL.
    * `/stack check`: Controllo online su GitHub Releases per nuove build Windows ARM64 e aggiornamenti Qualcomm.
    * `/stack sync`: Sincronizzazione sicura delle DLL e degli artefatti DSP da GenieX a llama-bin con backup preventivo e gestione dei lock NTFS.
    * `/stack update-geniex`: Esecuzione dell'aggiornamento ufficiale di GenieX CLI (`geniex update`).
    * `/stack update-llama`: Aggiornamento selettivo dei binari frontend preservando categoricamente i driver NPU.
  * `/bench [n_tokens]`: Benchmark prestazionale live con misurazione TTFT e velocità di decodifica ($t/s$).
  * `/server [status|start|stop]`: Monitoraggio e controllo del processo `llama-server`.
  * `/clear` o `/new`: Reset della conversazione e del contesto.
  * `/system [prompt]`: Ispezione o modifica del system prompt.
  * `/temp <val>`: Regolazione della temperatura di campionamento.
  * `/tokens`: Analisi della finestra di contesto e occupazione stimata della KV cache.

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
