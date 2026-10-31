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
