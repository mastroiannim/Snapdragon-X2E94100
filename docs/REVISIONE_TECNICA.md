# Seconda revisione critica — PR #1

**Criterio:** cambiare il minimo necessario per correggere errori dimostrabili; preservare i parametri runtime già scelti finché non esiste una prova comparativa. Le prove puntuali del runtime corrente (GPU, HTP0 e split 50/50) sono documentate nel [PR #2](https://github.com/mastroiannim/Snapdragon-X2E94100/pull/2); non costituiscono validazione del downloader o di tutti i parametri del launcher.

## Risultati verificabili

1. **Sintassi dei dispositivi**: per `llama-bench`, `/` separa device e pesi nella stessa configurazione, mentre `,` seleziona varianti di benchmark. I profili usano `-dev HTP0/GPUOpenCL -ts 75/25` (e 50/50, 25/75), con `-sm layer` esplicito. Il report accetta soltanto una riga JSON con device ordinati, pesi, split-mode e numero di token coerenti con la richiesta; non prende piu' il primo elemento di risultati multipli. La sintassi del benchmark va distinta da quella di `llama-server`.
2. **Binding HTTP**: `127.0.0.1` riduce l'esposizione involontaria rispetto a `0.0.0.0`. L'accesso LAN richiede `-BindHost` esplicito.
3. **Loader e VTCM**: `-lm auto` e `-lm mlock` non sono equivalenti. La rimozione di `GGML_HEXAGON_VTCM_SIZE=8M` non era giustificata da un test: entrambi i valori originali sono stati conservati, senza dichiararli ottimali.
4. **Controllo runtime**: `launch-hexagon.ps1 -CheckRuntime` esegue una verifica di allineamento, non una sincronizzazione. `sync-geniex.ps1` e' read-only per default; `-Apply` sblocca il vecchio percorso di aggiornamento, ancora **sperimentale e non validato**.
5. **Rollback**: un backup preesistente non viene sovrascritto; un backup incompleto non puo' essere usato per ripristinare; una copia valida non viene eliminata soltanto perche' `--list-devices` termina con successo.
6. **Benchmark**: un PMIC assente non invalida la misura di throughput. Le stime di potenza rimangono indicative dell'intero processo; `J/token` e `token/J` sono omessi finche' non esistano finestre temporali omogenee con baseline idle.
7. **GGUF**: `general.file_type` usa la famiglia `llama_ftype`, non `ggml_type`; corretto `BF16=32`, `IQ2_XXS=19` e la distinzione K/IQ. Metadata e stringhe anomale vengono rifiutate invece di produrre risultati parziali. Il parser NON e' ancora un validatore completo del formato.
8. **Verifica automatica**: un workflow PowerShell controlla il parsing degli script, la compilazione del C#, le fixture GGUF e i [test dei profili benchmark](../tests/benchmark-profiles.ps1). Questi ultimi coprono le cinque configurazioni, prefill/decode, JSON incoerenti o multipli, assenza PMIC, omissione dei risultati rifiutati e report Markdown con 11 colonne e valori interpolati correttamente.

## Verifica della correzione dei profili — 31 ottobre 2026

- Test di regressione locali superati per tutte le cinque configurazioni, con output sintetici positivi e negativi. Sono test del codice del report, senza eseguibili fittizi avviati o driver richiesti.
- Binario reale `llama-bench` b11938 / 19cce6919: quattro righe JSON dalla variante con virgole; il nuovo controllo le rifiuta. La prova del parser con `GPUOpenCL/GPUOpenCL -ts 50/50` e `-ngl 0` produce una sola riga coerente. Questo secondo comando verifica la sintassi e non e' una prova ibrida hardware.
- Un test reale con `GPUOpenCL`, Qwen3.5-0.8B-Q4_0 e `-ngl 99` produce una riga JSON accettata dal nuovo controllo.
- Parsing PowerShell e fixture GGUF della CI rieseguiti localmente. L'esito Windows PowerShell 5.1 e' verificato dal workflow sul commit aggiornato.
- Nessun nuovo test NPU 75/25 o 25/75 eseguito dalla sessione ristretta. L'esecuzione reale 50/50 documentata nel PR #2 resta evidenza separata; non e' presentata come una prova del benchmark automatico con Flash Attention attiva.
- Nessuna modifica al downloader, al rollback, alle euristiche del launcher o ai valori energetici storici in questa correzione.

## Rischi residui: non occultarli

| Priorita' | Fatto | Trattamento |
| --- | --- | --- |
| **Bloccante per aggiornamento runtime** | L'estrattore ZIP HTTP Range e' artigianale: non verifica checksum/firma dell'asset, CRC, limiti e tutti i casi ZIP64 | Evitare `-Apply` finche' non viene sostituito con una procedura transazionale e verificata |
| **Alta** | `--list-devices` prova enumerazione, NON corretta esecuzione dei kernel HTP/GPU | Eseguire inference smoke test con log di offload |
| **Alta** | Il ramo `-Mode Router` utilizza euristiche derivate dal modello selezionato per una directory che puo' contenere modelli diversi | Non affermare che il router abbia configurazioni per-modello ottimali |
| **Alta** | Il parser GGUF C# ha alcuni bounds checks e rifiuta tipi non supportati, ma non verifica completamente gli array o tutte le varianti del formato | Da correggere con fixture GGUF valide, troncate e avversarie; non inserire nuovi fallback silenziosi |
| **Alta, metodologica** | I campioni energetici non sono allineati alle fasi prefill/decode e mancano le baseline | Nessun rapporto J/token valido al momento |
| **Media** | Le soglie dimensionali (6/13,5/15 GB), gli split e i limiti del contesto sono euristiche, NON leggi hardware | Misurare isolando variabili, riportare distribuzioni e intervalli |
| **Media** | La cartella dei modelli viene modificata tramite hard-link anche prima del `-DryRun` | Separare discovery, planning ed effetti collaterali in un successivo intervento mirato |
| **Media** | Il README e il benchmark storico contengono spiegazioni causali forti non ancora dimostrate | Conservare i risultati originali come storici, ma non presentarli come conferme |

## Test prima dell'hardware

- [ ] CI Windows: parse PowerShell 5.1, compilazione C# e fixture GGUF deterministiche (nessun backend richiesto)
- [ ] Controllo statico del diff: esclusione modifiche non motivate a flags di caricamento, SWA, DMA e split
- [ ] Test locale su installazione fittizia: `-CheckRuntime` e `sync-geniex.ps1` senza `-Apply` non devono toccare i binari
- [ ] Simulare backup non creato, backup incompleto, backup preesistente, errore download e disco pieno
- [ ] Separare la futura reimplementazione del downloader dal PR di stabilizzazione

## Test su hardware (soltanto in seguito)

1. Registrare commit effettivo dei binari, driver, GGUF hash, versione Windows, condizioni di potenza e dispositivi disponibili.
2. Eseguire un modello valido con CPU, HTP0, GPUOpenCL, HTP0+GPUOpenCL, mantenendo uguali token, contesto, batch e quantizzazione.
3. Dimostrare offload effettivo dai log; non confondere discovery con elaborazione.
4. Misurare separatamente prefill/decode; campionare energia su identico intervallo temporale, e stimare la quota incrementale sopra idle.
5. Ripetere e registrare dispersione, temperatura e throttling. Non dichiarare optimalita' senza confronto.

**Non autorizzare merge** soltanto perche' il parsing PowerShell e' verde: la CI e' un controllo preliminare, non una certificazione runtime.

## Riferimenti upstream

- [Opzioni di llama-server e list-devices](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [llama-bench: sintassi e semantica del timing](https://github.com/ggml-org/llama.cpp/blob/master/tools/llama-bench/README.md)
- [Snapdragon multi-device e memorie](https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/snapdragon/README.md)
- [GGML Hexagon developer guide](https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/snapdragon/developer.md)

