# Revisione di feat/tui-openclaw

Prima revisione del branch al commit `c297afe993d0ef2eadd8044c025e851d703a394f`.
Obiettivo: correggere errori riproducibili e ridurre il lavoro ridondante del client,
senza modificare le euristiche NPU/GPU del launcher. La successiva richiesta di
conservare l'aggiornamento automatico al primo avvio prevale sul precedente blocco: lo
stato corrente del bootstrap e' descritto in [REVISIONE_TECNICA.md](REVISIONE_TECNICA.md).

## Problemi riscontrati e correzioni

| Priorità | Problema nel branch esaminato | Correzione |
| --- | --- | --- |
| Alta | I comandi Python reintroducevano copia/hard-link e aggiornamenti automatici rimossi da main. L'updater selezionava una release diversa dalla revisione del runtime, sostituiva solo gli EXE e ignorava il codice d'uscita di `--version`. | Unificati launcher e TUI nel motore PowerShell: release dello stesso commit GenieX, ZIP con SHA-256, staging e sostituzione controllata. |
| Alta | Il rollback poteva scrivere attraverso hard-link, ignorava errori di ripristino, lasciava file nuovi e non garantiva il riavvio dopo un fallimento. L'aggiornamento GenieX ignorava l'esito della sincronizzazione. | Ripristino tramite directory precedente, senza copiare attraverso hard-link; backup conservato anche se il ripristino fallisce. Prove di guasto aggiunte. |
| Media | Un evento con `reasoning_content` e `content` perdeva la risposta per l'uso di `elif`; il pensiero era memorizzato come risposta. | Entrambi i campi vengono letti; filtro incrementale dei tag `<think>`, anche spezzati fra eventi. La cronologia conserva la risposta finale. |
| Media | Cancellazione o errori potevano lasciare turni incompleti; Ctrl+C prima dell'inizializzazione dei timing poteva generare un ulteriore errore. | Cronologia aggiornata solo dopo un turno completato con risposta; connessioni chiuse anche su errore/interruzione. |
| Media | Frammenti SSE contati come token, TTFT sostituito dal tempo di prefill. | Token da `timings`/`usage`; TTFT del client separato da prefill e decode del server. Metriche mancanti: `N/D`. |
| Media | Directory GenieX vuota riportata come allineata; conteggio fisso 16/16 e hard-link dichiarati anche per copie. Presenza dei file indicata come WHQL attivo. | Inventario non vuoto richiesto; conteggi e identità rilevati; nessuna verifica di firma, ABI o offload dedotta dalla presenza. Errori di lettura espliciti. |
| Media | Percorso workspace personale fisso; modelli sconosciuti dichiarati HTP0, 100%, contesto 65536; RAM fittizia nel fallback. | Workspace del checkout o `--workspace`; preset riletti con default `[*]`; informazioni non disponibili indicate come tali. |
| Media | Tag di release confrontato con SHA: aggiornamento quasi sempre segnalato; un errore HTTP poteva apparire come allineamento. | Confronto numerico solo fra build riconoscibili; esito non determinabile se manca la misura. Release GenieX consultate via API senza invocare updater. |
| Media | `/server stop` con URL remoto terminava processi locali. Avvio e arresto riportavano successi non verificati. | Gestione processi limitata a endpoint HTTP Windows locali; controlli con timeout e codici d'uscita; avvio verificato via HTTP. |
| Minore | Autocompletamento dopo uno spazio non funzionante; corrispondenza esatta del modello sensibile al caso; markup negli identificatori; codici d'uscita dei wrapper non propagati. | Completamento e selezione corretti, testo dinamico trattato come testo, codici d'uscita conservati. |

Le prime quattro anomalie sono state riprodotte prima della modifica: inventario vuoto
allineato; risposta sostituita dal ragionamento nello stesso evento; un frammento riportato
come un token; profilo NPU/64k inventato per un modello sconosciuto.

## Ottimizzazioni proporzionate

- Un client HTTP per sessione, chiuso all'uscita. Il corpo SSE viene consumato fino alla
  fine della risposta anche dopo `[DONE]`, permettendo il riuso della connessione.
- Un solo controllo HTTP all'avvio e nessun GET preliminare a ogni richiesta di chat.
- Controllo dimensioni prima degli hash, identità dei file per gli hard-link e riuso
  degli hash soltanto all'interno della stessa ispezione. Nessuna cache persistente
  basata su timestamp che possa nascondere modifiche al contenuto.
- Il controllo release non ricalcola gli hash del runtime.
- Parti della risposta accumulate in lista; parsing dei tag sul frammento corrente e
  sul solo suffisso incompleto, senza cercare nell'intera risposta a ogni evento.
- Rimossa la dipendenza `openai`, mai usata: le richieste sono già gestite da `httpx`.
- Limite di generazione predefinito 2048 token, configurabile: evita richieste senza
  limite dal client, inclusi eventuali token di ragionamento secondo il server.

Questi cambiamenti riducono richieste, riletture e dipendenze. Non misurano un aumento
dei token/s del modello né un miglioramento delle prestazioni NPU/GPU.

## Verifica riproducibile

```powershell
python -m pip install -r requirements.txt
python -m compileall -q tui.py stack_manager.py tests
python -m unittest discover -s tests -p "test_*.py" -v
python tui.py --help
```

Eseguiti localmente su Linux, Python 3.12: **38 test superati**, compilazione Python,
controllo statico `ruff check --select F` e `git diff --check`.
La suite include una prova HTTP/SSE reale su loopback: due POST sulla stessa connessione
TCP, cronologia della seconda richiesta senza ragionamento e metriche del server.
Le altre prove isolano errori HTTP, stream troncati, Ctrl+C, tag frammentati, metriche
assenti, letture negate, copie/hard-link, inventario vuoto e delega degli updater al motore condiviso. Il bootstrap e il rollback
sono verificati dalle suite PowerShell indicate nella revisione tecnica.

Il workflow `Python TUI checks` esegue la suite su Windows e Linux con Python 3.10 e
3.14, e controlla la sintassi del launcher in Windows PowerShell. Sono verifiche del
client; non eseguono modelli o installazioni GenieX.

## Limiti residui

- Nessuna nuova inferenza su Snapdragon, enumerazione hardware o misura energetica
  effettuata in questa revisione. Serve uno smoke test sul dispositivo per chat,
  ragionamento, Ctrl+C, benchmark e avvio/arresto del router reale.
- L'INI descrive un profilo locale, potenzialmente diverso da quello del server remoto.
  Non dimostra l'effettivo posizionamento di layer o operatori.
- Il contesto è una stima caratteri/3.6; non include la tokenizzazione esatta del template
  e non verifica occupazione della KV cache, limiti FastRPC o spazio per la risposta.
- I confronti SHA-256 identificano il contenuto presente; firma, ABI e correttezza
  numerica restano verifiche distinte. Un controllo durante modifiche esterne del
  runtime non è un'istantanea atomica dell'installazione.
- `/server stop` e `/server restart` mantengono la semantica esplicita per nome:
  arrestano tutti i processi locali `llama-server`, non una singola sessione.

Riferimenti: [politica di aggiornamento](REVISIONE_TECNICA.md),
[contratto di compatibilità](COMPATIBILITA.md),
[API server llama.cpp: timings, usage e reasoning](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).

---

# Rifattorizzazione Control Center: fluidità e UX (in corso)

Baseline e misure delle fasi di rifattorizzazione della TUI full-screen
(`hexagon_control/ui/`). Vincoli invariati: euristiche di `launch-hexagon.ps1`,
motore runtime-update/sync-geniex, formato INI (salvataggio atomico UTF-8 senza BOM),
contratti read-only, binding loopback, conferme distruttive, gestione link.

## FASE 0 — Baseline, CI e test di regressione

**Causa del fallimento CI** (run #8–#10, tutte le matrici): il test
`test_generate_kilo_config_structure` dipendeva da `hexagon-models.ini` — file
gitignored, assente nel checkout CI — e da un router live su 127.0.0.1:18803.
Riprodotto localmente spostando l'INI: `AssertionError: 0 not greater than 0`.
Correzione: test reso ermetico con INI di fixture in directory temporanea e
`fetch_live_models` disattivato. Riproduzione estesa: suite eseguita anche con
Python 3.10 e 3.14 (venv uv) — verde prima e dopo il fix.

**Misure baseline** (`python tools/benchmark_tui.py`, Windows ARM64, Python 3.13):

| Misura | Prima |
| --- | --- |
| `_top_status()` con router appeso (per redraw) | ~2000 ms (timeout HTTP 2 s) |
| `dashboard_renderable()` con router offline | ~2008 ms (solo health; +2 subprocess PowerShell su Windows) |
| `replace_body()` | 2 `set_document` (clear+append, frame vuoto intermedio) |
| keypress → risoluzione prompt (DummyOutput) | ~1 ms p50 (il lag reale deriva dal render bloccante) |

**Test di regressione fotografati** (`tests/test_tui_performance.py`), marcati
`expectedFailure` finché la fase che li risolve non li rende verdi:
- I/O bloccante nella toolbar di stato (guard `_in_render` in `Interface`);
- `replace_body()` non atomico (due aggiornamenti del documento);
- `server_processes()` con due query PowerShell invece di una sola CIM con
  `WorkingSetSize`.

Aggiunto `Interface._in_render`: flag di diagnostica attivo solo durante i callback
di layout, usato dai test per vietare I/O nel path di render (criterio 1).

## FASE 1 — I/O fuori dal render

**Cambiamenti**
- `hexagon_control/status_cache.py`: `TtlSnapshot`, cache aggiornata da un thread
  poller con TTL 3 s. `snapshot()` non esegue mai I/O e non solleva; un fetch
  fallito conserva l'ultimo valore buono (`last_error()` per la diagnostica).
- `ProcessController`: `_fetch_status` aggiorna in background health + processi
  con un'unica query CIM; `health_snapshot()` / `processes_snapshot()` per i
  lettori. Il poller parte in `ControlCenter.run()` e si ferma in `close()`.
- `server_processes()`: una sola query `Win32_Process` con `WorkingSetSize`
  (eliminato il secondo subprocess `Get-Process`); memoria in MB dalla stessa CIM.
- `ProcessController.start()`: callback `progress(secondi_trascorsi)` per lo
  spinner e `cancel_event` per annullare l'attesa arrestando il launcher posseduto.
- Toolbar, dashboard, schermate Router/Diagnostica/Kilo: letture solo da cache;
  le decisioni critiche (avvio router da chat/kilo) usano ancora `health()` grezza.

**Misure dopo** (`tools/benchmark_tui.py`):

| Misura | Prima | Dopo |
| --- | --- | --- |
| `_top_status()` con router appeso | ~2000 ms | ~0 ms |
| `dashboard_renderable()` offline | ~2008 ms | ~0 ms |

Nuovi test: `tests/test_status_cache.py` (7), progress/annullamento in
`test_control_center.py`, regressioni I/O-nel-render verdi in
`tests/test_tui_performance.py`. Rimane expectedFailure: atomicità di
`replace_body()` (FASE 2).

## FASE 2 — Event loop unico, render atomico, suspend/resume

**Architettura**
- Il loop di `Application.run_async` vive sul thread di `Interface.start()` (di
  norma il main); menu e schermate girano in un `ThreadPoolExecutor` dedicato
  (`ControlCenter.run`). Comunicazione via `call_soon_threadsafe` + eventi.
- Handshake senza busy-wait: `_ready`/`_finished` al posto del polling con
  `sleep(0.02)`; `Interface.wait_ready()` per chi usa l'interfaccia da altri
  thread. `stop()` attende il termine solo se chiamato da un altro thread.
- Stato del prompt protetto da `_state_lock` (transizioni e letture nelle
  callback di layout).
- `replace_body()` atomico: un solo `set_document` + un solo `invalidate`,
  nessun frame vuoto; le righe cliccabili vengono ricalcolate una sola volta
  sul testo nuovo. Benchmark: set_document 2 -> 1.
- `suspended()` non distrugge più l'app: usa il pattern `in_terminal` di
  prompt_toolkit (render sospeso, input staccato, redraw allo stato conservato).
  Corpo e scroll sopravvivono a chat/Kilo; nessuna uscita dall'alternate screen.
  La chat scrive ora sul terminale reale durante l'handover (prima finiva nel
  corpo invisibile).
- Errori del loop UI mai silenziati: eccezioni registrate in
  `Interface._last_app_error` (catena con l'handler di prompt_toolkit) e
  traccia su stderr; l'app resta attiva.
- `ControlCenter._menu_loop`: `exit_lifecycle` (conferma arresto server) avviene
  con l'app ancora attiva; se l'app muore da sola, i server attivi vengono
  segnalati su stdout.

**Misure dopo**: keypress -> risoluzione prompt p50 ~0,2 ms (era ~1,1 ms);
replace_body 1 aggiornamento documento (era 2).

API pubblica di `Interface` invariata (prompt, confirm, pause, table, result,
error, console, suspended); aggiornati i test harness (app avviata in thread)
e i tool `tools/benchmark_tui.py` / `tools/diagnose_tui.py`.

## FASE 3 — Rendering a colori e UX

**Cambiamenti**
- Colori reali: i renderable Rich sono convertiti in ANSI truecolor e poi in
  frammenti prompt_toolkit (`_render_rich`, `_BodyLexer`). Il corpo resta un
  `Buffer` con documento atomico; il testo plain coincide byte-per-byte col
  rendering `color_system=None` precedente (nessuna regressione sui test).
- Click per riga/colonna: `_scan_click_ranges` registra le occorrenze esatte
  delle etichette; `click_value_at(linea, colonna)` risolve la voce sotto il
  click (non piu' substringa, niente falsi positivi su righe con piu' voci).
  Hover (`_update_hover`) ed evidenziazione della selezione menu.
- Navigazione con frecce+Invio oltre ai tasti singoli; modalita' input esplicita
  (`Tab` o `/`) in cui la digitazione libera non e' intercettata dai single-key.
  `Esc` annulla davvero il prompt (prima applicava il default); `F1`/`F10`
  globali anche sui prompt non single-key.
- Scrollbar, `PgUp/PgDn/Home/End`, ricerca incrementale (`Ctrl+F`, Invio prossimo,
  Esc fine). Il cursore del corpo e' mantenuto alla prima riga visibile
  (`_sync_body_cursor`): `Window._scroll` porta il cursore in vista a ogni render,
  quindi senza questo accorgimento il refresh riportava la vista in fondo.
- Live dashboard aggiornato in place: `replace_body` conserva lo scroll e produce
  un solo frame (un `set_document`, redraw coalescati da `Application.invalidate`).
- Layout alla larghezza reale del terminale (80..200, niente minimo forzato 100);
  re-render al resize con debounce (`_on_before_render`).
- Errori visibili nella barra di stato (`report_error`); il refresh del dashboard
  non e' piu' silenziato. `Esc` sulla conferma di uscita lascia i server attivi
  (scelta sicura, nessuna azione distruttiva senza conferma).
- Handler eccezioni del loop headless-safe: l'handler predefinito di
  prompt_toolkit crea una `PromptSession` su console reale per "Press ENTER",
  che in headless genera una cascata di `NoConsoleScreenBufferError`. Ora gli
  errori sono registrati e stampati su stderr senza toccare la console.
- Le chiamate cross-thread (`_call_soon`) sono schedulate nel contesto
  dell'app session (`app.context`), evitando l'output Win32 di default.

**Misure dopo** (`tools/benchmark_tui.py`):

| Misura | Prima (FASE 2) | Dopo (FASE 3) |
| --- | --- | --- |
| `replace_body()` | 1 set_document | 1 set_document, 1 frame |
| keypress -> prompt p50 | ~0,2 ms | ~0,2 ms |
| larghezza corpo | min 100 (troncamento) | reale 80..200 |
| click | substringa (falsi positivi) | riga/colonna esatta |

Nuovi test: `tests/test_tui_ux.py` (26) — colori, hit-test, hover, scroll,
ricerca, navigazione, modalita' input, Esc/F1/F10, barra errori, uscita sicura.
Suite totale 169 test OK su Windows ARM64 / Python 3.13.

## FASE 4 — Avvio a caldo

**Cambiamenti**
- `tui-bootstrap.psm1`: cache calda (`tui-warm.json` nella cache directory).
  `Get-TuiWarmFingerprint` calcola un'impronta economica senza subprocess Python
  (SHA-256 di `requirements.txt` e del modulo bootstrap + mtime/size del python
  del venv). Se l'impronta e' invariata e il marker `requirements.sha256` prova
  che il pip era riuscito, `Resolve-HexagonTuiPython` restituisce subito il
  python del venv saltando `Find-TuiPython`, `Test-TuiPython` e il controllo
  `import rich,httpx,prompt_toolkit` (tre subprocess eliminati a ogni avvio).
- La cache calda e' scritta solo a provisioning riuscito; un pip fallito non
  lascia ne' marker ne' cache (retry possibile). Requirements o modulo cambiati
  invalidano l'impronta e rieseguono il provisioning.
- Catena `hexagon.bat → launch-tui.ps1 → bootstrap → python` invariata (richiesta
  dai test entrypoint); il percorso caldo la rende rapida senza bypassarla.
- L'handshake busy-wait era gia' stato rimosso in FASE 2 (`_ready`/`_finished`).
- Nuovo tool `tools/measure_startup.py`: misura il first frame headless.

**Misure** (Windows ARM64, venv esistente):

| Misura | Prima | Dopo |
| --- | --- | --- |
| `Resolve-HexagonTuiPython` a caldo | ~808 ms (3 subprocess) | ~238 ms (cache, 0 subprocess) |
| first frame headless (build+render) | — | ~10 ms |
| import Python (`hexagon_app.py`) | ~519 ms | ~519 ms (invariato) |

Stima first frame interattivo a caldo: ~240 ms (Resolve) + ~500 ms (import
Python) + ~10 ms (build/render) + ~300 ms (overhead cmd/PowerShell) ≈ **1,2 s**,
entro l'obiettivo ≤ ~2 s. Il primo setup (Python/venv/pip) resta invariato.

Verifiche: `tests/tui-bootstrap.ps1` 4/4 PASS, `tests/entrypoints.ps1` 6/6 PASS,
parse sintassi PowerShell 0 errori. Contratti read-only e sicurezza invariati.

## FASE 5 — Test, documentazione e CI

**Copertura test** (`python -m unittest discover -s tests -p "test_*.py"`):
- Cache/TTL: `tests/test_status_cache.py` (7) — snapshot non bloccante, errore che
  conserva l'ultimo valore buono, refresh sovrapposti ignorati, poller periodico.
- Atomicità del render: `tests/test_tui_performance.py` (1 set_document) e
  `tests/test_tui_ux.py` (1 frame per `replace_body`, scroll conservato).
- Hit-test per colonna, hover, navigazione frecce, modalità input, Esc/F1/F10,
  ricerca, scrollbar/PgUp/Home/End, resize, barra errori, uscita sicura:
  `tests/test_tui_ux.py` (27).
- I/O fuori dal render, query CIM unica: `tests/test_tui_performance.py`.
- Contratti read-only (`-ListOnly`/`-DryRun`/`-Json`), binding loopback, conferme
  distruttive, link senza sovrascrittura, INI atomico UTF-8 senza BOM:
  `tests/test_control_center.py` e suite PowerShell (`runtime-readonly.ps1`,
  `runtime-update.ps1`, `entrypoints.ps1`).

**Fallback headless invariato**: senza console l'interfaccia usa il prompt a riga
(`_prompt_fallback`); i test avviano l'app con pipe input + `DummyOutput`.

**Verifica riproducibile**

```powershell
python -m pip install -r requirements.txt
python -m compileall -q hexagon_control tests tools
python -m unittest discover -s tests -p "test_*.py"
python tools/benchmark_tui.py        # misure render/keypress
python tools/measure_startup.py      # first frame a caldo
```

Suite **169 test OK** su Windows ARM64 con Python 3.10, 3.13 e 3.14 (venv CI).
CI `Python TUI checks` (Windows/Linux, 3.10/3.14) e `PowerShell static checks`
(sintassi, bootstrap 4/4, entrypoint 6/6, runtime read-only/update).

**Riepilogo misure prima/dopo**

| Criterio | Prima | Dopo |
| --- | --- | --- |
| `_top_status()` con router appeso (per redraw) | ~2000 ms | ~0 ms (cache TTL) |
| `dashboard_renderable()` offline | ~2008 ms + 2 PowerShell | ~0 ms (cache, CIM unica) |
| `replace_body()` | 2 set_document (frame vuoto) | 1 set_document, 1 frame |
| keypress → prompt p50 | ~1 ms | ~0,2 ms |
| click | substringa (falsi positivi) | riga/colonna esatta + hover |
| colori Rich | persi (monocolore) | conservati (truecolor) |
| larghezza corpo | min 100, troncamento | reale 80..200, resize |
| scroll live dashboard | reset a ogni ciclo | conservato |
| `Esc` | applicava il default | annulla |
| `Resolve-HexagonTuiPython` a caldo | ~808 ms | ~238 ms (cache) |
| first frame interattivo a caldo | — | ~1,2 s (≤ 2 s) |

**Vincoli di non regressione rispettati**: euristiche di `launch-hexagon.ps1`,
motore runtime-update/sync-geniex, formato INI e salvataggio atomico, contratti
read-only, binding loopback, politica "nessun update né avvio server all'apertura",
conferme distruttive, gestione link. API pubblica di `Interface` invariata
(prompt, confirm, pause, table, result, error, console, suspended). Stack
`rich` + `prompt_toolkit` + `httpx`, nessuna nuova dipendenza.
