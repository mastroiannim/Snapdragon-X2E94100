# Revisione tecnica e protocollo di validazione

## Ambito

Correzioni conservative agli script di avvio, benchmark e sincronizzazione per Windows ARM64 Snapdragon X2E94100. Questo PR deriva da un'analisi statica del codice; **non** costituisce una validazione su hardware Hexagon/Adreno.

## Problemi affrontati

- Argomenti di benchmark multi-device e tensor split corretti con virgole (es. `HTP0,GPUOpenCL` e `75,25`).
- Sincronizzazione runtime solamente su richiesta esplicita (`-SyncRuntime`).
- Binding HTTP predefinito su `127.0.0.1` invece di tutte le interfacce.
- Rimozione dei fallback di selezione release non verificati; controllo degli eseguibili estratti prima di eliminare i binari esistenti.
- Propagazione degli errori di aggiornamento dopo il rollback.
- Selezione del modello non ambigua e limite del contesto coerente con i metadati GGUF.
- Benchmark con cinque ripetizioni predefinite, log distinti conservati, exit code controllati e output `BENCHMARK_AUTO.md`, senza sovrascrivere i benchmark storici.
- Potenza: campionamento non più filtrato in base alla potenza NPU/GPU; resta un indicatore preliminare, non un valore energetico isolato della fase decode.

## Verifiche ancora necessarie

- [ ] Verificare sintassi e semantica delle opzioni con la release effettivamente installata di `llama.cpp`.
- [ ] `llama-server.exe --list-devices`: presenza di `HTP0` e `GPUOpenCL`.
- [ ] Smoke test inference sullo stesso GGUF: solo NPU, solo GPU e split 75/25, 50/50, 25/75.
- [ ] Analisi dei log del backend per confermare l'effettivo offload, non soltanto il device discovery.
- [ ] Test in sandbox dell'aggiornamento: mismatch commit, archivio incompleto, rete indisponibile e rollback.
- [ ] Misure prefill e decode a parità di contesto, modello, quantizzazione, temperatura e versione.
- [ ] Campionamento energetico sincronizzato con la fase di generazione e baseline idle.
- [ ] Qualificare nel README le affermazioni sulle soglie dimensionali e sull'ottimalità degli split.

## Limitazioni residue

Il sincronizzatore contiene ancora un estrattore ZIP HTTP Range personalizzato: richiede una successiva revisione specifica per integrità crittografica, ZIP64, controllo dei limiti e gestione completa degli errori. La scoperta dei device non equivale a validazione runtime. Non sono stati eseguiti test PowerShell o Windows ARM64 in questa revisione.

Fonti: [llama.cpp multi-GPU](https://github.com/ggml-org/llama.cpp/blob/master/docs/multi-gpu.md), [Snapdragon backend](https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/snapdragon/README.md).
