Il segreto sta nell'aver **scavalcato completamente sia il runtime statico QNN/QAIRT sia i limiti del wrapper GenieX**, combinando il meglio di due mondi che normalmente su Windows ARM64 restano separati.

Ecco cosa succede sotto il cofano, perché funziona senza limiti di contesto e cosa serve per avviarlo:

---

### Prerequisiti per avere lo stack funzionante

Per eseguire correttamente lo stack con accelerazione NPU Hexagon (`HTP0`), il sistema deve soddisfare i seguenti requisiti:

1. **Hardware e Sistema Operativo:**
   * **Windows 11 ARM64** su piattaforma **Qualcomm Snapdragon X Series** (Snapdragon X Elite / Plus o **Snapdragon X2 Elite**).
   * Driver NPU Qualcomm MCDM / FastRPC di sistema attivi (`qcnspmcdm*.sys` e `C:\Windows\System32\libcdsprpc.dll`).

2. **Qualcomm GenieX CLI installato:**
   * Deve essere installato **GenieX CLI** nel percorso predefinito `%LOCALAPPDATA%\GenieX CLI` (o specificato tramite il parametro `-GenieXDir` in [sync-geniex.ps1](sync-geniex.ps1)).
   * La sottocartella `%LOCALAPPDATA%\GenieX CLI\llama_cpp` fornisce le librerie core (`ggml.dll`, `ggml-hexagon.dll`, `ggml-opencl.dll`), il binario DSP (`libggml-htp-v81.so` / `v73` / `v75` / `v79`) e soprattutto il catalogo **`libggml-htp.cat` firmato WHQL**.

3. **Connessione Internet (solo al primo avvio o dopo un update di GenieX):**
   * Necessaria a [sync-geniex.ps1](sync-geniex.ps1) per interrogare le API GitHub di `ggml-org/llama.cpp` e scaricare selettivamente via HTTP Range gli eseguibili frontend (`llama-server.exe`, `llama-cli.exe`, `llama-bench.exe`, ecc.) compilati dallo stesso identico commit di GenieX.
   * La cartella di destinazione (`%USERPROFILE%\llama-cpp\llama-bin-win-cpu-arm64`) viene creata e popolata automaticamente dallo script se non esiste.

4. **Modelli GGUF:**
   * Uno o più modelli `.gguf` presenti in `%USERPROFILE%\.cache\geniex\models` (scaricabili tramite GenieX o copiati manualmente in qualsiasi sottocartella: [llama-server.bat](llama-server.bat) provvede automaticamente a indicizzarli tramite HardLink nella directory principale dei modelli).
   * **Nota sui formati quantizzati per la NPU:** il backend `ggml-hexagon` accelera nativamente sul DSP i formati `Q4_0`, `Q4_K`, `Q8_0` e `MXFP4` (i pesi `repack` vengono gestiti direttamente sulle unità HVX/HMX).

---

### Avvio rapido e Auto-Configurazione Intelligente

1. **Avvio immediato (consigliato):**
   * Fai doppio clic su [llama-server.bat](llama-server.bat) (o eseguilo dal prompt):
   * [llama-server.bat](llama-server.bat) interroga l'Auto-Configuratore [launch-hexagon.ps1](launch-hexagon.ps1), che scansiona i metadati binari del modello selezionato (o seleziona automaticamente il top-performer `LFM2.5-24B-A2B-QAD-Q4_0.gguf` a **~46 token/s**), calcola la ripartizione Ibrida ottimale tra NPU Hexagon e GPU Adreno (`HTP0,GPUOpenCL -ts 80,20`), imposta il limite FastRPC sul contesto e avvia `llama-server.exe` sulla porta standard `18803`.

2. **Scelta manuale del modello o elenco opzioni:**
   ```powershell
   # Visualizza tutti i modelli disponibili e il profilo hardware calcolato:
   .\llama-server.bat -ListOnly

   # Avvia un modello specifico con auto-configurazione dei flag ottimali:
   .\llama-server.bat LFM2.5-24B-A2B-QAD-Q4_0.gguf
   .\llama-server.bat qwen2.5-coder-14b-instruct-q4_0.gguf
   .\llama-server.bat flint-UD-Q4_K_XL.gguf

   # Simulazione (mostra i metadati estratti e i parametri calcolati senza avviare il processo):
   .\launch-hexagon.ps1 -Model "LFM2.5-24B" -DryRun
   ```

3. **Configurazione in Cline / VS Code:**
   * **API Provider:** `OpenAI Compatible`
   * **Base URL:** `http://127.0.0.1:18803/v1`
   * **API Key:** `sk-no-key-required` (qualsiasi valore)
   * **Model ID:** `LFM2.5-24B-A2B-QAD-Q4_0` (o il modello avviato)
   * **Model Context Window:** `64000` (o `65536`)
   * **Max Output Tokens:** `4096`

4. Per rieseguire la telemetria energetica comparativa sul tuo hardware, lancia [benchmark-hexagon.ps1](benchmark-hexagon.ps1) (report completo in [BENCHMARK.md](BENCHMARK.md)).

---

### 1. Perché di solito la NPU Qualcomm ha il limite del contesto fisso (es. 4096)?
Nello stack tradizionale Qualcomm (**QAIRT / QNN / SNPE / Genie**, cioè quelle ~650 MB di DLL `QnnHtp.dll` e `QairtHtpPrepare.dll` che avevi prima nella cartella), il modello deve essere compilato **in anticipo (Ahead-of-Time)** in un grafo monolitico statico per la NPU:
* I pesi e la forma di tutti i tensori (inclusa la KV-cache) vengono "congelati" dentro file `.bin` / `.dlc`.
* Questo ti costringe a usare solo modelli pre-convertiti per la tua specifica architettura e fissa un tetto rigido alla finestra di contesto (spesso 4096 token).

### 2. Come funziona invece `ggml-hexagon` (Esecuzione dinamica *Op-by-Op* sul DSP)
Il backend nativo **`ggml-hexagon.dll`** + **`libggml-htp-v81.so`** non usa QNN/SNPE per compilare l'intero modello:
* Mantiene il **grafo dinamico di `llama.cpp`** sulla CPU e usa la NPU Hexagon esattamente come se fosse una GPU CUDA: invia le singole operazioni matematiche (MatMul quantizzate `Q4_0`, `Q4_K`, `Q8_0`, `MXFP4`, Flash Attention, RoPE, RMSNorm, MoE) in tempo reale tramite una coda FastRPC (`dspqueue`) direttamente alle unità vettoriali (**8 HVX**) e matriciali (**2 HMX**) della NPU.
* Sullo **Snapdragon X2 Elite (`v81`)** sfrutta inoltre il **DMA64** con memoria condivisa (`fastrpc_mmap`) fino a **~80 GB di VMEM**: la KV-cache cresce dinamicamente in RAM condivisa e la NPU legge direttamente i buffer del `.gguf` generico, permettendoti di impostare `-c 131072` (o qualsiasi altra dimensione) su qualunque GGUF standard.

---

### 3. I 3 ostacoli su Windows che abbiamo aggirato

Se questo backend esiste in `llama.cpp`, perché scaricando `llama.cpp` da GitHub non funzionava? Per tre motivi precisi che abbiamo risolto:

1. **Il blocco della firma digitale WHQL su Windows (`libggml-htp.cat`):**
   * Su Windows 11 con Secure Boot attivo, il driver kernel Qualcomm (`qcnspmcdm8480.sys`) rifiuta di caricare sul DSP della NPU qualsiasi binario `.so` (`libggml-htp-v81.so`) che non sia certificato da **Microsoft Windows Hardware Compatibility Publisher (WHQL)**.
   * Le build ufficiali di GitHub (`ggml-org/llama.cpp`) non hanno la chiave privata di Qualcomm/Microsoft per firmare il catalogo, quindi **non includono il backend Hexagon per Windows**.
   * **Qualcomm GenieX CLI**, invece, distribuisce nella sua cartella interna proprio `libggml-htp-v81.so` accompagnato dal catalogo **`libggml-htp.cat` firmato WHQL**, ma non fornisce `llama-server.exe` né `llama-cli.exe` (e il comando `geniex` impone i suoi default, come `--nctx 4096`).

2. **L'innesto chirurgico tra gli eseguibili di GitHub e le DLL firmate di GenieX:**
   * Le DLL di GenieX sono compilate da uno specifico commit di `llama.cpp` (`e467e5b`) con il registro `ggml_backend_hexagon_reg` integrato in `ggml.dll`.
   * Se provi a usare un `llama-server.exe` di una build diversa (come la `b11887`), l'ABI C++ di `llama-common.dll` non coincide e il programma va in crash all'avvio (`0xC0000139`).
   * Con lo script [sync-geniex.ps1](sync-geniex.ps1) abbiamo interrogato `geniex.exe --version`, risalito automaticamente all'esatta build GitHub corrispondente a quel commit (`b11643`), estratto via HTTP Range **solo i frontend (`llama-server.exe`, `llama-cli.exe`, `*-impl.dll`)** e collegato via HardLink tutte le DLL e i `.so` firmati WHQL di GenieX.

3. **La variabile segreta del driver FastRPC (`ADSP_LIBRARY_PATH`):**
   * Quando `ggml-hexagon.dll` chiede al driver di sistema `libcdsprpc.dll` di aprire l'URI `file:///libggml-htp-v81.so?...&_dom=cdsp`, il driver **non cerca nella cartella dell'eseguibile**, ma legge la variabile d'ambiente `ADSP_LIBRARY_PATH` per trovare sia il file `.so` sia il catalogo `.cat` da validare con `CryptCATOpen`.
   * Senza quella variabile restituiva `0x80000406` (`AEE_ERESOURCENOTFOUND`). Impostando `ADSP_LIBRARY_PATH` sulla cartella dei binari (anche a livello utente per le istanze figlie lanciate dal router di `llama-server.exe`), il driver FastRPC valida la firma Microsoft/Qualcomm e apre la sessione `HTP0` al primo colpo.

---

### 4. Benchmark Prestazionali ed Efficienza Energetica (`HTP0` vs `GPUOpenCL` vs Ibrido)

Tramite [benchmark-hexagon.ps1](benchmark-hexagon.ps1) abbiamo misurato su **Snapdragon X2 Elite** (Hexagon `v81` + Adreno `X2-90`) sia i token/s sia i consumi energetici reali per singolo rail hardware del PMIC (`NPU`, `GPU`, `CPU`, `RAM`, `INFRA`, `SoC`). Il report completo è disponibile in **[BENCHMARK.md](BENCHMARK.md)**.

#### Sintesi dei risultati principali

| Modello | Taglia | Profilo | Prefill `pp512` (t/s) | Gen `tg` (t/s) | Potenza `SoC` in Gen (W) | Energia per Token (`J/tok`) |
| :--- | :---: | :--- | ---: | ---: | ---: | ---: |
| **`Qwen3.6-35B-A3B-Q4_0`** *(MoE 35B)* | **19.4 GB** | `HTP0` (100% NPU) | 30.0 *(Fallback CPU)* | 20.24 | 48.72 W *(CPU 41.0W, Sys 88W)* | 2.407 J/tok |
| **`Qwen3.6-35B-A3B-Q4_0`** *(MoE 35B)* | **19.4 GB** | `HTP0,GPUOpenCL` (`50,50`) | 31.9 | **22.71 (+12.2%)** | 34.85 W *(CPU 25.7W, Sys 64W)* | **1.535 J/tok (-36% J)** |
| **`Qwen3.6-35B-A3B-Q4_0`** *(MoE 35B)* | **19.4 GB** | `GPUOpenCL` (100% GPU) | **152.2 (5.1x)** | **25.26 (+24.8%)** | **31.93 W** *(GPU 7.1W, Sys 60W)* | **1.264 J/tok (-47% J)** |
| **`Qwen3.8-27B-Q4_0`** *(Dense 27B)* | **15.2 GB** | `HTP0` (100% NPU) | 32.7 | 5.42 | 16.86 W *(NPU 5.9W, CPU 6.2W)* | 3.111 J/tok |
| **`Qwen3.8-27B-Q4_0`** *(Dense 27B)* | **15.2 GB** | `HTP0,GPUOpenCL` (`75,25`) | 27.8 | **5.81 (+7.2%)** | **16.73 W** *(NPU 3.5W, GPU 5.5W)* | **2.880 J/tok (-7.4% J)** |
| **`Qwen3.8-27B-Q4_0`** *(Dense 27B)* | **15.2 GB** | `GPUOpenCL` (100% GPU) | **71.0 (2.2x)** | **5.86 (+8.1%)** | 19.52 W *(GPU 12.3W, CPU 3.2W)* | 3.331 J/tok |
| **`LFM2.5-24B-A2B-Q4_0`** *(MoE 24B)* | **12.6 GB** | `HTP0` (100% NPU) | **802.0** | 38.43 | **18.20 W** *(NPU 4.1W, CPU 10.3W)* | **0.474 J/tok** |
| **`LFM2.5-24B-A2B-Q4_0`** *(MoE 24B)* | **12.6 GB** | `HTP0,GPUOpenCL` (`50,50`) | 778.5 | **41.90 (+9.0%)** | 21.28 W *(NPU 2.1W, GPU 4.8W)* | 0.508 J/tok |
| **`Ornith-1.5-9B-Q4_0`** *(Dense 9B)* | **5.1 GB** | `HTP0` (100% NPU) | **750.9** | 15.40 | 19.94 W *(NPU 4.8W, CPU 10.4W)* | 1.295 J/tok |
| **`Ornith-1.5-9B-Q4_0`** *(Dense 9B)* | **5.1 GB** | `HTP0,GPUOpenCL` (`75,25`) | 594.1 | **17.20 (+11.7%)** | **17.37 W** *(NPU 3.2W, GPU 4.5W)* | **1.010 J/tok (-22% J)** |
| **`Spark-X2.5-4B-Q4_K_M`** *(K-Quants)* | **2.4 GB** | `HTP0` (100% NPU) | **1554.3** | **30.61** | — | — |
| **`Spark-X2.5-4B-Q4_K_M`** *(K-Quants)* | **2.4 GB** | `HTP0,GPUOpenCL` (`50,50`) | 538.4 (-65%) | 28.79 (-6%) | — | — |

#### Punti chiave emersi dai test: la soglia dei ~14–15 GB

1. **Sotto i ~13 GB (`Qwen-0.8B`, `Spark-4B`, `Ornith-9B`, `LFM2.5-24B-A2B` da 12.6 GB) domina `HTP0` (100% NPU):**
   * Finché il modello entra interamente nel pool FastRPC DMA64 della NPU, `HTP0` macina **750–3800 token/s** in prefill assorbendo solo **`14.9–18.2 W` di SoC** (`50.4 token/Joule`, cioè **4.73x più efficiente della GPU**).
   * Su modelli Dense da 9B, un leggero split `-ts 75,25` può comunque dimezzare il *busy-polling* CPU in generazione (`10.4 W → 4.8 W`), migliorando i token/s del `+11.7%` e l'efficienza del `+28%`.
2. **Sopra i ~15 GB (`Qwen3.8-27B` da 15.2 GB e `Qwen3.6-35B-A3B` da 19.4 GB) il pool FastRPC NPU satura e l'ibrido / GPU diventano essenziali:**
   * Superata la soglia di ~14–15 GB di pesi, la sessione CDSP della sola NPU (`HTP0`) non riesce più a mappare tutti i layer/esperti in DMA e riversa le operazioni in fallback sulla CPU Oryon: sul `35B-A3B` la sola CPU schizza a **`41.0 W`** (portando il laptop a **`88.1 W`**!) e il prefill crolla a **`30.0 t/s`**.
   * Attivando **`-dev HTP0,GPUOpenCL -ts 50,50`** (che lascia solo ~7.6–9.7 GB sulla NPU e sposta il resto sulla GPU Adreno) o **`-dev GPUOpenCL`**, il fallback CPU scompare: sul `35B-A3B` il consumo del portatile scende di **24–28 Watt** (`88 W → 60–64 W`), la generazione sale da **`20.2 a 22.7 / 25.3 t/s` (+25%)** e il prefill su `GPUOpenCL` balza a **`152.2 t/s` (5.1x più veloce)** dimezzando i Joule per token (`2.41 → 1.26 J/tok`).

---

### 5. L'Auto-Configuratore Intelligente ([launch-hexagon.ps1](launch-hexagon.ps1))

Invece di affidarsi a configurazioni manuali o generiche, [launch-hexagon.ps1](launch-hexagon.ps1) include un parser C# ad alte prestazioni che legge direttamente l'header binario del file `.gguf` in meno di 100 ms ed estrae:
1. **Architettura e Famiglia:** `lfm2moe`, `flint`, `qwen2`, `spark`, ecc.
2. **Topologia di Calcolo:** Modello denso vs Mixture-of-Experts (`expert_count` ed `expert_used_count`).
3. **Meccanismo di Attention:** Full Causal vs Sliding Window Attention (`attention.sliding_window`).
4. **Formato di Quantizzazione:** `Q4_0`, `Q4_K_M`, `Q4_K_XL`, `Q8_0`.
5. **Geometria dei Tensori:** Conteggio layer, teste di Query e teste KV (`attention.head_count_kv`).

#### Matrice Decisionale Euristica

| Categoria Modello | Rilevamento Metadati | Configurazione Calcolata | Motivazione Hardware |
| :--- | :--- | :--- | :--- |
| **MoE Leggero**<br>*(es. `LFM2.5-24B-A2B`)* | `expert_count > 0`, `expert_used_count <= 4`, peso $\le 13$ GB | **`-dev HTP0,GPUOpenCL -ts 80,20 -c 65536`** | Solo ~2B di parametri attivi per token. Lo split 80/20 sfrutta due canali bus paralleli (crossbar SoC) raggiungendo il picco assoluto di generazione (**~46 token/s**). |
| **MoE con Sliding Window**<br>*(es. `Flint Preview`)* | `expert_count > 0`, `sliding_window > 0` | **`-dev HTP0,GPUOpenCL -ts 85,15 -c 131072`** | La finestra di attenzione a 513 token limita drasticamente la memoria KV; permette contesti fino a 131k token mantenendo velocità stabile (~6.7 t/s). |
| **Dense Medio**<br>*(es. `Qwen 2.5 Coder 14B`)* | `expert_count == 0`, $7 \text{ GB} \le \text{peso} \le 13.5 \text{ GB}$ | **`-dev HTP0,GPUOpenCL -ts 75,25 -c 65536`** | Su contesti lunghi (>30k token) la sola NPU saturerebbe il bus DMA a 2.9 t/s; l'offload del 25% su GPU Adreno sblocca il collo di bottiglia della memoria. Contesto limitato a 64k per rispettare il tetto FastRPC di 1 GiB. |
| **Dense Compatto**<br>*(es. `Spark 4B`, `Ornith 9B`)* | `expert_count == 0`, $\text{peso} \le 6 \text{ GB}$ | **`-dev HTP0 -c 65536`** | Pesi e KV entrano interamente nel dominio DMA della NPU Hexagon: massima efficienza (14–18W SoC) e prefill istantaneo (750–1550 t/s). |
| **Giganti > 15 GB**<br>*(es. `Qwen 27B`, `Qwen 35B`)* | $\text{peso} > 14.5 \text{ GB}$ | **`-dev HTP0,GPUOpenCL -ts 50,50 -c 65536`** | Previene la saturazione del descrittore FastRPC e azzera il fallback termico della CPU (-25W sul sistema). |
