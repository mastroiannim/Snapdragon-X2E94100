# Legacy Python Modules (Deprecated)

Questi moduli Python (`stack_manager.py`, `kilo_config.py`, `requirements.txt` e i relativi test unitari) sono **formalmente deprecati** e spostati in `legacy/`.

L'intero runtime, la pianificazione hardware `hexagon-models.ini`, la sincronizzazione di `kilo.json`, l'ispezione dello stack GenieX/llama.cpp e la validazione offline/schema sono ora implementati nativamente in TypeScript in [`@hexagon/kilo-plugin`](../plugins/hexagon-runtime/):

| Funzione legacy | Sostituto nativo TypeScript (`plugins/hexagon-runtime/dist/cli.js`) |
| --- | --- |
| `python kilo_config.py --generate --port <P>` | `node plugins/hexagon-runtime/dist/cli.js setup --workspace --port <P> --host <H>` |
| `python kilo_config.py --check` | `node plugins/hexagon-runtime/dist/cli.js validate` |
| `python kilo_config.py --status` / `stack_manager.py` | `node plugins/hexagon-runtime/dist/cli.js status --check-runtime --port <P> --host <H>` |
| Generazione `hexagon-models.ini` | `generateModelsIni` / `ensureModelsIni` (`src/discovery.ts`, `src/process.ts`) |

`setup-kilo.ps1` e `launch-kilo.ps1` non richiedono piu' `python` nel `PATH`.
