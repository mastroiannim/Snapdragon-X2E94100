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

Eseguiti localmente su Linux, Python 3.12: **37 test superati**, compilazione Python,
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
