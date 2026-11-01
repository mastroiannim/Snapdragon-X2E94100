# Revisione tecnica: bootstrap e aggiornamento automatico

## Obiettivo e comportamento

L'aggiornamento automatico e' conservato, incluso il primo avvio senza llama.cpp.
Su Windows ARM64 l'unico software da installare manualmente e' GenieX Qualcomm.
I launcher preparano il runtime e la TUI prepara anche Python e i pacchetti necessari.
I modelli GGUF nella cache GenieX sono contenuti di input, non vengono sostituiti dal setup.

Il blocco introdotto nel PR #1 e nel commit TUI `031b480` e' superato da questa revisione.
Quella rimozione era una scelta di perimetro, non la dimostrazione che gli aggiornamenti
riusciti nell'installazione originale fossero errati.

## Implementazione condivisa

- `runtime-update.psm1`: unica implementazione dell'installazione e del ripristino.
- `sync-geniex.ps1`: entry point PowerShell con risultato JSON e codice d'uscita.
- `launch-hexagon.ps1`: Apply automatico prima di richiedere `llama-server.exe`;
  `-CheckRuntime` mantiene il solo controllo. ListOnly/DryRun saltano il bootstrap.
- `stack_manager.py`: delega sync e update alla stessa procedura PowerShell.
- `launch-tui.ps1` / `tui.bat`: bootstrap runtime, Python e ambiente dedicato; URL remoti
  esclusi dall'amministrazione locale. La TUI avvia il router locale se offline.

La sorgente dei backend resta `GenieX CLI\llama_cpp`; `geniex.exe` viene cercato anche
nel PATH. La versione installata determina il commit frontend: non si installa la release
piu' recente di llama.cpp indipendentemente da GenieX. `/stack update-geniex` invoca il
comando ufficiale di aggiornamento, poi riallinea la copia locale.

## Download ed estrazione

La ricerca usa la vecchia stima del numero b* solo come ottimizzazione; ogni candidato
viene risolto a SHA completo, inclusi tag annotati. Il fallback cerca tag dello stesso
commit, senza accettare build vicine o risultati non verificati dopo errori API.

Lo ZIP CPU Windows ARM64 viene scaricato interamente: la release b11938, corrispondente
al runtime `19cce6919` di GenieX 0.10.0, pesa circa 13 MB. Questa scelta riduce il codice
rispetto al parser ZIP su HTTP Range originale e permette di verificare il digest completo
pubblicato da GitHub. Non e' un rifiuto dell'HTTP Range come tecnica.

Prima dell'installazione: dimensione e SHA-256, estrazione .NET, rifiuto di nomi duplicati
o percorsi anomali, presenza dei tre frontend, architettura PE ARM64, hash dei file GenieX,
versione e device HTP0/GPUOpenCL. Il manifest registra i componenti effettivi.

## Sostituzione e ripristino

1. Preparazione in una directory adiacente con nome unico, protetta da lock esclusivo.
2. Copia della configurazione esistente e preparazione dei nuovi componenti.
3. Verifiche in staging prima di toccare la directory attiva.
4. Arresto dei soli processi della destinazione, se presenti; `-NoStopServer` rifiuta
   invece l'aggiornamento. Per il riavvio sono conservati gli argomenti originali;
   il router ricrea i propri figli.
5. Rinomina dell'installazione precedente come backup e promozione dello staging.
6. Verifica del frontend nella posizione definitiva; ripristino su errore.

Un fallimento prima della sostituzione lascia intatti i file installati. Un backup
non viene ottenuto con una copia che potrebbe risultare parziale: e' la directory
precedente rinominata. Se anche il ripristino fallisce, la procedura restituisce errore
e conserva il percorso del backup. Il primo setup fallito non lascia una destinazione
parzialmente installata. Anche i fallimenti di riavvio sono riportati.

Le copie sono predefinite per isolare successive scritture del vendor. L'opzione
`-UseHardLinks` conserva hard-link con fallback alla copia; ogni sostituzione dello
staging rimuove prima il vecchio nome. Prima di `/stack update-geniex` vengono separate
le copie da eventuali collegamenti legacy. Le variabili ambiente utente non sono modificate.

## Provisioning della TUI

Riusa Python 3.10+ se trovato nell'installazione gestita, nel PATH o nei percorsi Python
registrati. Altrimenti scarica l'installer ufficiale CPython 3.13.13 ARM64 (AMD64 per
host x64), ne verifica lo SHA-256 fissato e lo installa per l'utente, senza launcher,
associazioni o modifiche al PATH. I digest provengono dai file `.exe.sigstore` pubblicati
su [python.org](https://www.python.org/ftp/python/3.13.13/).

Crea `%LOCALAPPDATA%\HexagonClaw\tui-env`, installa solo wheel senza richiedere compilatori
e conserva il fingerprint delle requirements soltanto dopo il successo e la verifica degli
import. Avvii successivi evitano pip se non serve. Un fallimento resta riprovabile;
un lock impedisce provisioning concorrenti sulla stessa directory.

## Verifiche

- 37 regressioni Python, compresa una prova HTTP/SSE reale su loopback.
- `tests/runtime-update.ps1`: 21 scenari con installazione inizialmente assente,
  idempotenza senza rete, corrispondenza commit, tag annotati, SHA/ZIP, errori di staging,
  rinomina, controllo successivo e ripristino; backup e sorgenti confrontati per contenuto.
- `tests/tui-bootstrap.ps1`: 4 scenari di provisioning senza Python, riuso, requirements
  modificate e recupero dopo errore pip. Installer e pip sono simulati in questa suite.
- `tests/entrypoints.ps1`: processi Windows separati per il launcher reale da directory
  llama.cpp assente e per il passaggio argomenti/codice d'uscita del launcher TUI.
  EXE e device sono fixture: questa prova non simula un'inferenza.
- `tests/runtime-readonly.ps1`: controllo esplicito senza Apply, file e ambiente invariati.
- Suite esistente dei cinque profili benchmark, parser GGUF C# e sintassi PowerShell.
- Download reale b11938: verificati dimensione, SHA-256, estrazione e architettura ARM64
  di `llama-server.exe`, `llama-cli.exe` e `llama-bench.exe`.

Le suite del bootstrap e del rollback sono eseguite anche dal workflow Windows PowerShell
5.1. I test Python sono eseguiti su Windows/Linux con Python 3.10 e 3.14.

## Limiti dell'evidenza

Non e' stata eseguita una nuova inferenza su Snapdragon in questa revisione. Stesso commit,
hash e device enumerati non certificano ABI completa, firma/catalogo o correttezza numerica.
Le prove storiche GPU, HTP0 e split 50/50 restano documentate nel PR #2.

Occorrono Internet e una release ARM64 pubblicata per il commit richiesto al primo setup;
se questa non esiste o non ha digest, il programma segnala il problema conservando lo stack
precedente. Un runtime gia' allineato viene riusato senza rete. Driver e firmware OEM devono
essere funzionanti sull'host. Le euristiche, gli split e il contesto del launcher rimangono
sperimentali; questa modifica non dichiara miglioramenti delle prestazioni NPU/GPU.
