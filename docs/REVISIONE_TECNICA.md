# Revisione tecnica — PR #1

## Ambito valutato per il merge

Questa PR migliora il comportamento del launcher e i report di benchmark su un runtime gia' installato. **L'aggiornamento automatico e' escluso dall'ambito:** il downloader HTTP Range, l'installazione tramite hard-link/copia e il rollback sono rimossi da `sync-geniex.ps1`. Il codice precedente resta consultabile nella cronologia Git.

`sync-geniex.ps1` esegue soltanto confronti di versioni e SHA-256 ed enumerazione dei dispositivi. Mantiene `-Apply` come opzione riconoscibile, ma la rifiuta prima di discovery, processi figli, modifiche all'ambiente o operazioni sui file. `-AutoConfirm` e' ignorata e non puo' aggirare il blocco. Un esito negativo non suggerisce di usare Apply e non tenta riparazioni.

Il launcher non richiama piu' automaticamente il vecchio aggiornamento. Con `-CheckRuntime` esegue il controllo e interrompe l'avvio se questo fallisce. Il controllo non certifica l'ABI completa o la correttezza numerica dell'inferenza.

## Correzioni incluse

- Bind HTTP predefinito `127.0.0.1`; accesso LAN soltanto con parametro esplicito.
- Benchmark: `/` separa device e pesi dello stesso test, mentre `,` seleziona varianti. Sono presenti HTP0, GPUOpenCL e gli split HTP0/GPUOpenCL 75/25, 50/50 e 25/75, con `-sm layer` esplicito.
- Accettata una sola riga JSON per invocazione, con device nell'ordine richiesto, pesi, split-mode, prompt/generazione/profondita' coerenti e statistiche valide. I risultati multipli o incoerenti sono segnalati ed esclusi dal report.
- Tabella Markdown con 11 colonne e valori modello/test interpolati correttamente. Report predefinito BENCHMARK_AUTO.md, separato dal registro storico.
- Throughput conservato senza PMIC; potenze mancanti N/D. Nessun rapporto J/token ricavato da finestre temporali incompatibili.
- Parser GGUF: corretta l'enumerazione llama_ftype, controlli su chiavi/stringhe e limite di contesto del modello. Le euristiche e i parametri originari di caricamento/VTCM sono conservati senza presentarli come ottimali.

## Verifiche effettuate

| Controllo | Evidenza |
| --- | --- |
| Sintassi PowerShell, C# GGUF e fixture | Suite locale e workflow Windows PowerShell 5.1 |
| Cinque profili, prefill/decode e report | Test deterministici positivi/negativi, inclusa la mancata pubblicazione dei JSON rifiutati |
| Regressione delle virgole | Il binario reale b11938 / 19cce6919 genera quattro varianti; il controllo corretto le rifiuta |
| Sintassi con slash | GPUOpenCL/GPUOpenCL, split 50/50 e ngl 0: una sola riga JSON coerente; prova del parser, non test ibrido hardware |
| GPU reale | Qwen3.5-0.8B-Q4_0 con GPUOpenCL e ngl 99: una riga JSON accettata |
| Apply disabilitato | Test in processo separato con Apply, Apply+AutoConfirm e percorsi mancanti: rifiuto anticipato, nessun file fixture modificato o backup creato |
| Controllo senza GenieX | Errore esplicito con e senza AutoConfirm; nessuna modifica alle fixture |
| Runtime locale in sola lettura | Nel contesto ristretto il controllo fallisce; hash dei 47 file runtime confrontati e variabile utente ADSP_LIBRARY_PATH invariati |

I test di rifiuto dell'aggiornamento sono in [tests/runtime-readonly.ps1](../tests/runtime-readonly.ps1); quelli di profili e report in [tests/benchmark-profiles.ps1](../tests/benchmark-profiles.ps1). Entrambi sono eseguiti dal workflow Windows.

Le prove reali GPU, HTP0 e HTP0/GPUOpenCL 50/50 sono documentate nel [PR #2](https://github.com/mastroiannim/Snapdragon-X2E94100/pull/2). Non costituiscono test di tutte le opzioni del launcher o del benchmark automatico. Non sono stati eseguiti nuovi test NPU 75/25 o 25/75 dalla sessione ristretta.

## Limiti residui dell'uso sperimentale

- Le euristiche dimensionali, gli split e il contesto non sono ottimali dimostrati; il router applica default globali che possono essere inadatti ad altri modelli nella directory.
- Il parser GGUF non e' un validatore completo di array, nesting, metadata avversari o tensori. Ha letto i metadata degli 11 modelli locali durante la revisione; questa evidenza non equivale a validazione completa del formato.
- ListOnly e DryRun possono ancora creare hard-link dei modelli durante la scansione. La sola lettura qui garantita riguarda i binari runtime del controllore, non tutti gli effetti del launcher.
- L'enumerazione non prova l'offload. Correttezza numerica, superiorita' prestazionale, sovrapposizione temporale dei kernel NPU/GPU e misure energetiche sincronizzate restano verifiche distinte.

Questi limiti delimitano le funzionalita' sperimentali incluse. Le prove del downloader e del rollback non sono piu' una precondizione per il merge di questa PR, perche' quei percorsi non sono eseguibili ne' presenti nello script aggiornato.

## Reintroduzione futura dell'aggiornamento

Richiede un intervento separato con download ed estrazione standard, verifica di integrita' e provenienza, staging verificato, sostituzione controllata e test di guasto/ripristino. Un aggiornamento non dovra' essere riattivato soltanto perche' --list-devices termina con successo.

## Riferimenti

- [llama-bench: parser della revisione usata](https://github.com/ggml-org/llama.cpp/blob/19cce6919/tools/llama-bench/llama-bench.cpp)
- [Backend Snapdragon](https://github.com/ggml-org/llama.cpp/blob/19cce6919/docs/backend/snapdragon/README.md)

