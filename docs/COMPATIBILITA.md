# Contratto di compatibilità CPU / Adreno / Hexagon (Windows ARM64)

**Scopo.** Documentare le condizioni necessarie per tentare l'esecuzione GGUF con `llama.cpp` su Snapdragon X2E94100. Nessuna singola verifica garantisce la riuscita dell'inferenza. La seguente matrice separa: *requisito*, *evidenza controllabile*, *cosa non dimostra*.

| Ambito | Verifica minima | Limite dell'evidenza |
| --- | --- | --- |
| Host | Windows 11 ARM64, processore Snapdragon, eseguibili ARM64 | Non conferma compatibilità delle librerie DSP |
| Driver NPU | NPU visibile in Gestione dispositivi, driver/firmware Qualcomm corretti | Non conferma che un modello GGUF possa essere eseguito |
| Driver GPU | Adreno e piattaforma OpenCL presenti | Non prova kernel GGML/OpenCL supportati |
| FastRPC | Librerie/servizi FastRPC e accesso al DSP disponibili | MCDM e FastRPC sono componenti diversi |
| HTP | Versione architetturale del DSP coerente con `libggml-htp-vNN.so` e host stub | Il nome `vNN` non assicura compatibilità con driver/firmware |
| Build host | `llama-server.exe`, `ggml*.dll`, backend e dipendenze provenienti da build compatibile | Un hash di commit uguale non dimostra ABI e intero manifest |
| Firma HTP Windows | Catalogo `libggml-htp.cat` attendibile e artefatti DSP inclusi/associati correttamente | Un file `.cat` presente non equivale a verifica firma/accettazione runtime |
| Percorsi DSP | `ADSP_LIBRARY_PATH` risolve libreria HTP corretta e dipendenze | Non risolve driver mancanti o ABI incompatibile |
| Modello e memoria | GGUF caricato con operatori supportati, KV/contesto compatibili con risorse disponibili | Peso su disco o `-c` da soli non dimostrano fattibilità |
| Offload reale | Log dell'inferenza con backend HTP/GPU e risultato coerente | `--list-devices` è soltanto enumerazione |
| Riproducibilità | Hash SHA-256 di GGUF, eseguibili e DLL; driver, firmware, parametri e log | Non dimostra automaticamente superiorità prestazionale |

**SDK vs runtime:** Hexagon SDK, OpenCL SDK, compilatore e toolchain sono prerequisiti per **compilare** una build con i relativi backend; non vanno confusi con i driver e le librerie runtime necessari per **eseguire una build già pronta e compatibile**. I nomi dei device (per esempio `HTP0`, `HTP0:0`, `GPUOpenCL`) dipendono dalla versione del backend: utilizzare quelli realmente restituiti da `--list-devices`, non forzare nomi ipotetici.

## Verifiche innesto GenieX llama.cpp

**Oggetto della verifica:** questa è una **ricomposizione locale di binari**, non un backend nuovo e non una distribuzione riconosciuta dal progetto upstream. Nell'implementazione corrente di `sync-geniex.ps1`, i due insiemi hanno origini diverse:

| Provenienza | Componenti usati nel codice | Condizione necessaria |
| --- | --- | --- |
| Installazione `GenieX CLI\llama_cpp` | File runtime nella directory: DLL GGML/CPU/OpenCL/Hexagon, `libggml-htp-vNN.so`, `libggml-htp.cat` **se presenti in quella versione** | Provenienza, integrità e compatibilità con architettura HTP/driver; firma e relazione catalogo-artefatto |
| Release `ggml-org/llama.cpp` | Frontend Windows ARM64 selezionati dallo script (per esempio `llama-server.exe`) | Verifica effettiva del commit target, del set ABI e delle dipendenze; nessun fallback per vicinanza numerica |
| Sistema Windows Qualcomm | Driver MCDM, librerie/servizi FastRPC, firmware e runtime OpenCL | Disponibilità della specifica piattaforma host, non semplice esistenza dei file |
| GGUF locale | Modello, metadata, pesi e KV cache | Architettura e operatori supportati; dimensioni di contesto fattibili nel runtime effettivo |

**Perché è importante:** il post [Qualcomm GenieX Developer Preview, pubblicato il 7 luglio 2026](https://www.qualcomm.com/developer/blog/2026/06/geniex-developer-preview) documenta un'infrastruttura che include **sia** `llama.cpp` **sia** QAIRT/QNN, oltre a un server proprio. L'innesto del repository riusa la variante **`llama_cpp`** distribuita con GenieX sotto un frontend nativo `llama-server.exe` distinto: **non è corretto attribuirlo a un uso del runtime QAIRT** e non è corretto sostenere che GenieX fosse privo di server.

### Evidenza già disponibile e limiti

**Compatibilità funzionale osservata nei percorsi esercitati; riproducibilità non ancora stabilita; universalità non dimostrata.** I benchmark storici riportano esecuzioni di `llama-bench.exe` con frontend `llama.cpp` e componenti runtime provenienti da GenieX sullo Snapdragon X2E94100. Sono evidenze di caricamento ed esecuzione del calcolo su modelli GGUF, oltre la sola enumerazione dei dispositivi. Un'esecuzione completata esclude un'incompatibilità ABI che impedisca quei percorsi, ma non certifica tutte le interfacce, la correttezza numerica degli output o il funzionamento di `llama-server.exe`.

Il manifest SHA-256 serve a identificare e riprodurre l'insieme di binari che ha funzionato; la sua assenza non annulla l'evidenza di esecuzione riportata. Un manifest acquisito oggi identifica l'installazione attuale e non ricostruisce automaticamente quella storica.

| Livello di evidenza | Stato |
| --- | --- |
| Caricamento ed esecuzione dello stack composto su GGUF | Supportati dai benchmark riportati |
| Offload NPU/GPU e ripartizione per ciascun profilo | Da documentare con comandi effettivi e log di offload |
| Correttezza numerica e output generati | Non dimostrata dai soli token/s |
| Riproducibilità su una nuova installazione | Non ancora stabilita; richiede identità dei componenti, ambiente, parametri e replica |
| Compatibilità di altre versioni o percorsi del server | Non dimostrata dai test di llama-bench |
| J/token e soglia causale FastRPC | Ancora da verificare |

Il separatore `/` è previsto da `llama-bench` per `-dev` e `-ts`: è indicato dall'help locale e confermato dal [parser della revisione storica e467e5b](https://github.com/ggml-org/llama.cpp/blob/e467e5b/tools/llama-bench/llama-bench.cpp). Non costituisce un errore dello script; la sintassi va distinta da quella degli altri frontend. Comandi effettivi e log rimangono necessari per documentare l'offload, indipendentemente dai separatori. Le etichette “100% NPU/GPU” del registro storico indicano il profilo dichiarato, non una misura dell'offload di tutti gli operatori.

### Verifiche per identificare e riprodurre una composizione

1. **Inventario:** acquisire manifest con `sha256`, percorso, architettura, provenienza, versione GenieX, `LlamaCPP Runtime Hash` e versione del frontend `llama.cpp` per **ogni** file realmente caricato, non soltanto per gli `.exe`.
2. **Identità build:** risolvere l'esatta revisione (commit completo, non tag simile), e verificare l'insieme di ABI/exports/imports fra `llama-server.exe`, `llama-common.dll`, `ggml.dll` e tutti i backend. Un hash abbreviato uguale non copre modifiche downstream o opzioni di compilazione.
3. **Firma HTP:** verificare il catalogo *e* la sua associazione ai `libggml-htp-vNN.so` effettivamente caricati. Non assumere che copiare il `.cat` o avere un certificato attendibile renda affidabili binari modificati.
4. **Dipendenze e device:** annotare `ADSP_LIBRARY_PATH` effettivo e la risoluzione delle DLL; usare `--list-devices` come diagnostica preliminare, non come prova di inferenza/offload.
5. **Smoke test e log:** in ambiente separato, eseguire un modello GGUF noto e registrare log di backend, operatori offloaded, errori, contesto e versione. Separare il corretto avvio dell'HTTP server dalla riuscita dell'inferenza sulla NPU.
6. **Installazione:** non sovrascrivere file fino a download completo, hash/manifest verificato, staging e rollback testato. Gli hard-link funzionano soltanto quando filesystem e volume lo consentono; essendo legami allo **stesso contenuto su disco**, modifiche in-place possono alterare anche i file di partenza. Preferire copie immutabili verificabili nei test.
7. **Licenze e distribuzione:** la licenza BSD-3-Clause dichiarata per il codice GenieX non estende automaticamente i suoi termini a ogni SDK, DLL, firmware, catalogo o driver distribuito insieme al prodotto. Verificare le licenze/notice specifiche prima di redistribuire un bundle misto. Una installazione locale non prova supporto o certificazione Qualcomm.

**Stato reale degli script:** in `main`, `sync-geniex.ps1` interroga GenieX, seleziona asset upstream con una ricerca che **può ripiegare su release non esattamente corrispondenti**, estrae byte ZIP via HTTP Range, elimina e rimpiazza file, collega il runtime da GenieX e considera `--version` un controllo positivo. Questi passaggi **non soddisfano** le verifiche di integrità e tracciabilità sopra elencate e non garantiscono che un aggiornamento mantenga la compatibilità osservata nei benchmark. Il [PR #1](https://github.com/mastroiannim/Snapdragon-X2E94100/pull/1) propone una modalità read-only di default e rimuove parte dei fallback, ma non certifica una composizione affidabile né la sicurezza dell'estrattore ZIP. In assenza di quelle prove, **non eseguire aggiornamenti su installazioni da preservare**.

## Percorso dati e confini di responsabilità

`llama-server.exe` orchestra il grafo GGML. Il backend host `ggml-hexagon` dialoga con i kernel dell'artefatto HTP `libggml-htp-vNN.so` tramite interfacce host/DSP, trasportate da FastRPC. Per QNN/QAIRT esiste un percorso distinto con proprie librerie stub/skel versionate. Non è corretto imporre **i vincoli di build di QAIRT a ogni modello GGUF**.

Su Windows l'accesso NPU avviene tramite infrastruttura Qualcomm che comprende driver MCDM e servizi FastRPC: **il driver MCDM non è un sinonimo di driver FastRPC**. Il firmware e i driver dipendono dal dispositivo e dalla sua revisione.

Per modelli grandi, la finestra di indirizzamento della singola sessione HTP (ordine di alcuni GiB) non coincide con la quantità totale di RAM né con un limite di peso modello. L'upstream descrive tecniche di mapping/unmapping dei buffer e/o split fra sessioni/device, che possono variare fra release. Le soglie 6/13,5/15 GiB del launcher rimangono decisioni sperimentali da validare. **Non inferire automaticamente che l'uso elevato di CPU sia un fallback causato da FastRPC.**

## Verifiche locali non distruttive

Eseguire da PowerShell in un ambiente di test, adattando il percorso dell'installazione:

```powershell
$bin = Join-Path $env:USERPROFILE 'llama-cpp\llama-bin-win-cpu-arm64'
$server = Join-Path $bin 'llama-server.exe'

# Fingerprint del binario e informazioni del runtime
Get-FileHash $server -Algorithm SHA256
& $server --version

# Enumerazione dispositivi: condizione necessaria, non sufficiente
& $server --list-devices

# Verifica della firma del catalogo, se signtool.exe è installato e nel PATH
# Verificare anche che il catalogo corrisponda agli artefatti DSP utilizzati.
& signtool.exe verify /v /pa (Join-Path $bin 'libggml-htp.cat')

# Nel processo corrente: risoluzione delle librerie DSP
$env:ADSP_LIBRARY_PATH = $bin
```

La verifica con `signtool` conferma la firma del catalogo nelle condizioni dell'host, **non** sostituisce la verifica dell'appartenenza degli artefatti al catalogo né un caricamento reale su HTP. Non adottare test-signing, installazione certificati personali o disabilitazione Secure Boot senza una decisione esplicita sull'ambiente di sviluppo e sulle implicazioni di sicurezza. Le build con certificati attendibili per test sono possibili, **non equivalgono a un pacchetto WHQL di produzione**.

## Politica dei componenti

1. **Identificare** SO/architettura host, SoC, HTP `vNN`, driver NPU, FastRPC, firmware, OpenCL, eseguibili e DLL.
2. **Acquisire manifest verificabile** con file, SHA-256, versione/commit e provenienza. Lo stesso commit è un controllo parziale, non un attestato di compatibilità.
3. **Verificare catalogo e corrispondenza HTP** con i requisiti Windows; non usare un catalogo per “sanare” un artefatto di provenienza diversa.
4. **Evitare sincronizzazioni implicite.** Lo `sync-geniex.ps1` di `main` può effettuare modifiche. Il codice del [PR #1](https://github.com/mastroiannim/Snapdragon-X2E94100/pull/1) propone una modalità read-only predefinita, ma il suo ramo `-Apply` resta sperimentale.
5. **Richiedere prova di inferenza**, non fermarsi a `--version` e `--list-devices`. Documentare offload, throughput, stato errore e impronta software.

## Diagnosi senza attribuzione causale automatica

| Sintomo | Indagine minima | Conclusione non consentita |
| --- | --- | --- |
| `HTP0` assente | Driver, registrazione backend, DLL dipendenti, firmware | “Il modello è troppo grande” |
| Fallimento caricamento `.so` | Percorso `ADSP_LIBRARY_PATH`, versione HTP, catalogo/firma, log FastRPC | “Il problema è sicuramente la firma WHQL” |
| Errore inizializzazione `ggml` | Coerenza binari, simboli esportati, toolchain/ABI e versione | “Gli hash di commit combaciano quindi è compatibile” |
| OOM / errore allocazione | Log sessione HTP, mapping, KV cache, contesto, split e RAM | “FastRPC ha un limite globale di 15 GB” |
| CPU alta / prefill lento | Profilo operatori, log offload, contesa DDR, batch, temperatura, driver | “C'è necessariamente fallback CPU” |
| `--list-devices` riuscito | Eseguire e loggare un test di inferenza | “NPU e GPU sono state validate” |

## Fonti

- [Qualcomm: QAIRT, FastRPC, stub/skel e domini di compatibilità](https://www.qualcomm.com/developer/blog/2026/10/how-ai-models-reach-hexagon-npu-qairt-fastrpc-hexagon-explained) — documento generale, esempio QAIRT non identico al backend GGML.
- [GGML Hexagon: backend, memoria e modelli grandi](https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/snapdragon/developer.md).
- [GGML Windows Snapdragon: driver, `.cat`, test-signing](https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/snapdragon/windows.md).
- [Microsoft Compute Driver Model](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/mcdm).
