# Piano Operativo di Pivoting: Hexagon TUI -> Kilo Plugin (Snapdragon X2 Elite)

Documento di specifica e piano di esecuzione per **elaborazione agentica autonoma**.
Contiene protocolli di avanzamento a fasi rigide, criteri di gate e **checkpoint formali con meccanismi di rollback e ripristino** in caso di blocco del flusso.

---

## 🎯 Obiettivo Strategico

1. **Eliminazione aggressiva dello stack Python TUI / Control Center:** Rimuovere `tui.py`, `hexagon_app.py`, `hexagon_control/`, i test UI e le dipendenze console Windows ARM64.
2. **Preservazione del Core Engine Snapdragon:** Mantenere e blindare l'innesto dei binari GenieX (`ggml-hexagon.dll`, `libggml-htp.cat`, `libggml-htp-v*.so`, `ggml-opencl.dll`) in `llama-server.exe` nativo ARM64 con contesti estesi (65.536–131.072 token) e tool calling.
3. **Sviluppo del Plugin Kilo Nativo (`@kilocode/plugin`):** Spostare la gestione di healthcheck, auto-start con `ADSP_LIBRARY_PATH`, sync runtime e discovery modelli dentro un plugin TypeScript.
4. **Test di Copertura Esclusivi sul Plugin:** Costruire una suite Vitest ad alta affidabilità con mock del sistema operativo e dei subprocess.

---

## 🛑 Protocollo Checkpoint e Recupero Errori

Ogni fase termina con un **Gate di Validazione**. Se il gate fallisce, l'agente applica il protocollo di fallback corrispondente senza procedere alla fase successiva.

```
       [ Fase 0: Baseline & Safety Tag ] ───▶ CP-0
                      │
       [ Fase 1: Aggressive Cleanup ]    ───▶ CP-1 (Gate: Core PS1 intatti)
                      │
       [ Fase 2: Scaffolding Plugin ]    ───▶ CP-2 (Gate: npm/tsc verde)
                      │
       [ Fase 3: Implementazione TS ]    ───▶ CP-3 (Gate: Build TS verde)
                      │
       [ Fase 4: Test Suite Vitest ]     ───▶ CP-4 (Gate: 100% test pass)
                      │
       [ Fase 5: Integrazione Kilo ]     ───▶ CP-5 (Gate: E2E Kilo OK)
```

### File di Stato Autonomo
L'agente registra l'avanzamento aggiornando il file `.kilo/checkpoint.json`:
```json
{
  "last_completed_checkpoint": "CP-0",
  "timestamp": "2026-11-23T17:40:00Z",
  "status": "IN_PROGRESS",
  "failed_step": null,
  "recovery_action": null
}
```

---

## 📌 FASE 0: Snapshot di Sicurezza e Baseline

### Azioni dell'Agente:
1. Verificare lo stato di Git: `git status --porcelain`.
2. Creare un branch o tag di ripristino immediato:
   ```powershell
   git branch -f backup/pre-kilo-pivot HEAD
   ```
3. Inizializzare `.kilo/checkpoint.json` impostando `last_completed_checkpoint: "CP-0"`.

### 🏁 Gate CP-0:
- Il branch `backup/pre-kilo-pivot` esiste.
- Workspace pronto per modifiche distruttive.

### ⚠️ Fallback / Ripristino:
- Se il workspace è sporco con modifiche non committate dell'utente, salvarle con `git stash save "pivot-stash"`.

---

## 📌 FASE 1: Refactoring Aggressivo (Cancellazione UI Python)

### Azioni dell'Agente:
1. **Rimuovere file e directory della TUI e Control Center:**
   ```powershell
   Remove-Item -LiteralPath "tui.py" -Force -ErrorAction SilentlyContinue
   Remove-Item -LiteralPath "tui.bat" -Force -ErrorAction SilentlyContinue
   Remove-Item -LiteralPath "tui-bootstrap.psm1" -Force -ErrorAction SilentlyContinue
   Remove-Item -LiteralPath "hexagon_app.py" -Force -ErrorAction SilentlyContinue
   Remove-Item -LiteralPath "hexagon.bat" -Force -ErrorAction SilentlyContinue
   Remove-Item -LiteralPath "hexagon_control" -Recurse -Force -ErrorAction SilentlyContinue
   ```
2. **Rimuovere test Python e piani obsoleti:**
   ```powershell
   Remove-Item -LiteralPath "tests/test_tui.py" -Force -ErrorAction SilentlyContinue
   Remove-Item -LiteralPath "tests/test_tui_ux.py" -Force -ErrorAction SilentlyContinue
   Remove-Item -LiteralPath "tests/test_tui_http.py" -Force -ErrorAction SilentlyContinue
   Remove-Item -LiteralPath "tests/test_tui_performance.py" -Force -ErrorAction SilentlyContinue
   Remove-Item -LiteralPath "tests/test_control_center.py" -Force -ErrorAction SilentlyContinue
   Remove-Item -LiteralPath "tests/test_control_center_ui.py" -Force -ErrorAction SilentlyContinue
   Remove-Item -LiteralPath "tests/tui-bootstrap.ps1" -Force -ErrorAction SilentlyContinue
   Remove-Item -LiteralPath "tests/test_status_cache.py" -Force -ErrorAction SilentlyContinue
   Remove-Item -LiteralPath ".kilo/plans/1795443621998-tui-command-button-ux-plan.md" -Force -ErrorAction SilentlyContinue
   ```
3. **Ripulire dipendenze Python:**
   - Svuotare o eliminare `requirements.txt` (niente `rich`, `prompt_toolkit`, `textual`).
4. **Verificare integrità dei file Core mantenuti:**
   - `runtime-update.psm1`
   - `sync-geniex.ps1`
   - `launch-hexagon.ps1`
   - `hexagon-models.ini`
   - `benchmark-hexagon.ps1`
   - `setup-kilo.ps1`
   - `launch-kilo.ps1`

### 🏁 Gate CP-1:
Eseguire il controllo di integrità PowerShell esistente:
```powershell
powershell -ExecutionPolicy Bypass -File tests/runtime-readonly.ps1
```
Il test deve restituire exit code 0.

### ⚠️ Fallback / Ripristino:
Se sono stati eliminati file core per errore:
```powershell
git checkout backup/pre-kilo-pivot -- runtime-update.psm1 sync-geniex.ps1 launch-hexagon.ps1 hexagon-models.ini
```

---

## 📌 FASE 2: Scaffolding Modulo Plugin Kilo (`plugins/hexagon-runtime`)

### Azioni dell'Agente:
1. Creare la directory di lavoro `plugins/hexagon-runtime/`.
2. Inizializzare `package.json`:
   ```json
   {
     "name": "@hexagon/kilo-plugin",
     "version": "1.0.0",
     "description": "Snapdragon X2 Elite hardware orchestrator for Kilo Code",
     "main": "dist/index.js",
     "types": "dist/index.d.ts",
     "scripts": {
       "build": "tsc",
       "test": "vitest run --coverage",
       "test:watch": "vitest"
     },
     "devDependencies": {
       "@kilocode/plugin": "^1.0.0",
       "@types/node": "^20.11.0",
       "typescript": "^5.3.3",
       "vitest": "^1.2.0"
     }
   }
   ```
3. Creare `tsconfig.json` con `target: "ES2022"`, `module: "NodeNext"`, `declaration: true`.
4. Creare `vitest.config.ts`.
5. Installare le dipendenze: `npm install` all'interno della directory del plugin.

### 🏁 Gate CP-2:
- Esecuzione `npm run build` restituisce exit code 0.
- `npx vitest run` esegue senza crash di configurazione.

### ⚠️ Fallback / Ripristino:
- Se npm fallisce per rete o permessi, verificare Node v20+ su host; se bloccato, verificare proxy o ripulire `node_modules` e reinstallare.

---

## 📌 FASE 3: Implementazione TypeScript del Plugin

Implementare i moduli in `plugins/hexagon-runtime/src/`:

1. **`sync.ts` — Verifica e Aggiornamento Stack:**
   - Esegue `geniex.exe --version` ed estrae `LlamaCPP Runtime Hash: ([a-f0-9]+)`.
   - Esegue `llama-server.exe --version` ed estrae il commit b*.
   - Se disallineato o mancante, invoca:
     `powershell -ExecutionPolicy Bypass -File ../../sync-geniex.ps1 -Apply -NoStopServer -Json`
   - Valida la presenza di `ggml-hexagon.dll`, `libggml-htp.cat`, `libggml-htp-v*.so`, `ggml-opencl.dll`.

2. **`process.ts` — Gestione Processo & Routing:**
   - Porta router: `18803`, Host: `127.0.0.1`.
   - Se non attivo, avvia `llama-server.exe` impostando tassativamente nell'ambiente:
     ```typescript
     env: { ...process.env, ADSP_LIBRARY_PATH: runtimeDirectory }
     ```
   - Parsing dei parametri da `hexagon-models.ini` per HTP0 (NPU) e GPUOpenCL.

3. **`health.ts` — Polling & Readiness:**
   - Polling HTTP su `http://127.0.0.1:18803/health` con retry ogni 1000ms fino a max 30s (necessario per allocazione del grafo HTP).

4. **`models.ts` — Context Window Senza Limiti GenieX:**
   - Espone i contesti reali testati:
     - `Ornith-1.5-9B-Q4_0`: 65.536 token.
     - `MiniCPM5-2B-Q4_K_M`: 65.536 token.
     - `flint-UD-Q4_K_XL`: 131.072 token.
     - `gpt-oss-20b-Q4_0`: 131.072 token.

5. **`tools.ts` — Agent Tools per Kilo:**
   - `hexagon_status`: riporta stato router, latenza e modello caricato.
   - `hexagon_sync`: trigger manuale per forzare il riallineamento runtime.
   - `hexagon_bench`: lancia `benchmark-hexagon.ps1` e restituisce token/s.

6. **`index.ts` — Export Default del Plugin:**
   - Implementa l'oggetto `{ id: "hexagon-runtime", server: pluginInit }`.
   - Hook `session.created`: avvio o verifica del server locale.
   - Hook `chat.params`: iniezione di `reasoning_effort: "none"` sui modelli locali per garantire tool-calling deterministico.

### 🏁 Gate CP-3:
- Compilazione TypeScript: `npm run build` genera i file in `dist/` senza errori di tipi (`tsc --noEmit`).

### ⚠️ Fallback / Ripristino:
- Se la compilazione fallisce con errori di tipi di `@kilocode/plugin`, utilizzare fallback ad interfaccia strutturale TypeScript locale con i tipi esatti dell'API Kilo.

---

## 📌 FASE 4: Test di Copertura Rigorosi (Solo su Plugin)

Creare ed eseguire la suite Vitest in `plugins/hexagon-runtime/tests/`:

1. **`sync.test.ts`:**
   - Test matching hash identico (nessun aggiornamento richiesto).
   - Test mismatch hash con trigger corretto di `sync-geniex.ps1`.
   - Test gestione assenza di `geniex.exe` con errore descrittivo.
2. **`process.test.ts`:**
   - Test passaggio della variabile d'ambiente `ADSP_LIBRARY_PATH`.
   - Test generazione corretta degli argomenti CLI per `llama-server.exe` (context 65536, device HTP0).
   - Test isolamento e non interferenza se il server è già in esecuzione.
3. **`health.test.ts`:**
   - Test successo immediato su risposta HTTP 200.
   - Test retry loop durante il warm-up NPU prima del timeout.
   - Test timeout dopo 30 tentativi falliti con errore appropriato.
4. **`tools.test.ts` & `plugin.test.ts`:**
   - Test esecuzione tool `hexagon_status` e formattazione JSON.
   - Test hook `chat.params` con mutazione `reasoning_effort: "none"`.

### 🏁 Gate CP-4:
Eseguire nella cartella del plugin:
```powershell
npm test
```
- 100% dei test superati.
- Copertura superiore al 90% sui moduli in `src/`.

### ⚠️ Fallback / Ripristino:
- Se un test fallisce, l'agente deve isolare il modulo specifico (`npx vitest run tests/<modulo>.test.ts`), correggere la logica o il mock e ri-eseguire.

---

## 📌 FASE 5: Collegamento a Kilo e Validazione Finale

### Azioni dell'Agente:
1. Registrare il plugin in `kilo.json` nella root del repository:
   ```json
   {
     "$schema": "https://app.kilo.ai/config.json",
     "plugin": [
       "./plugins/hexagon-runtime"
     ]
   }
   ```
2. Aggiornare `README.md` rimuovendo i riferimenti a `tui.py`, `tui.bat` e `hexagon.bat`, sostituendoli con l'architettura zero-setup guidata da Kilo Code.
3. Eseguire la diagnostica finale:
   ```powershell
   powershell -ExecutionPolicy Bypass -File setup-kilo.ps1
   ```

### 🏁 Gate CP-5 (Definition of Done):
- `setup-kilo.ps1` valida l'integrità del sistema.
- Il repository è privo di codice Python legato alla TUI.
- Il plugin è compilato e testato.
- Registrare lo stato finale in `.kilo/checkpoint.json`:
  ```json
  {
    "last_completed_checkpoint": "CP-5",
    "timestamp": "COMPLETED",
    "status": "SUCCESS"
  }
  ```

---

## 🚀 Istruzioni di Avvio Rapido per l'Agente

Per avviare l'elaborazione autonoma, l'agente deve eseguire:
1. Leggere `.kilo/checkpoint.json` se esistente per determinare il punto di ripresa.
2. Iniziare dalla prima fase non completata (`CP-0` -> `CP-1` -> ... -> `CP-5`).
3. Non passare alla fase successiva finché il Gate di validazione non produce exit code 0.
