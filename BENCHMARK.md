# Benchmark Report: Prestazioni ed Efficienza Energetica NPU (`HTP0`) vs GPU (`GPUOpenCL`) vs Ibrido (`HTP0,GPUOpenCL`)

**Piattaforma di test:**
* **SoC:** Qualcomm Snapdragon X2 Elite Extreme (`X2E94100`)
* **NPU:** Hexagon `v81` (`HTP0`, DMA64 attivo, 8 HVX + 2 HMX)
* **GPU:** Qualcomm Adreno X2-90 (`GPUOpenCL`, OpenCL 3.0)
* **Telemetria Energetica:** Contatori hardware PMIC Qualcomm via Windows EMI (`Win32_PerfRawData_PowerMeterCounter_EnergyMeter`) sui rail `NPU`, `GPU`, `CPU_CLUSTER_0/1/2`, `MEMORY`, `INFRA`, `SOC` e `SYSTEM`.
* **Runtime:** `llama.cpp` `0.6.0-dev` (build `b11643`, commit `e467e5b` / GenieX `v0.9.3`), `-ngl 999 -fa on -b 4096 -ub 512 -t 12`
* **Script di riproduzione:** [benchmark-hexagon.ps1](benchmark-hexagon.ps1)

---

## 1. Risultati per Categoria di Modello (da 0.5 GB a 19.4 GB)

### A. Fascia "Enorme" (> 15 GB): Superamento della soglia FastRPC NPU

#### 1. `Qwen_Qwen3.6-35B-A3B-Q4_0.gguf` (35.5B MoE / 3B attivi — **19.41 GiB**)

| Configurazione (`-dev` / `-ts`) | Prefill `pp512` (t/s) | Gen `tg64` (t/s) | `NPU` (W) | `GPU` (W) | `CPU` (W) | **Totale `SoC` (W)** | Totale `Sistema` (W) | **Costo Gen (`J/tok`)** |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **`HTP0` (100% NPU)** | 29.98 | 20.24 | 3.25 W | 0.04 W | **41.00 W** | **48.72 W** | **88.06 W** | 2.407 J/tok |
| **`HTP0/GPUOpenCL` (`75/25`)** | 26.94 | 21.15 (+4.5%) | 1.50 W | 2.99 W | 28.19 W | 36.05 W | 66.30 W | 1.704 J/tok (-29%) |
| **`HTP0/GPUOpenCL` (`50/50`)** | 31.93 | 22.71 (+12.2%) | 1.12 W | 4.60 W | 25.67 W | 34.85 W | 64.43 W | 1.535 J/tok (-36%) |
| **`GPUOpenCL` (100% GPU)** | **152.17 (5.1x)** | **25.26 (+24.8%)** | 0.00 W | 7.07 W | **21.43 W** | **31.93 W** | **60.44 W** | **1.264 J/tok (-47%)** |

#### 2. `Qwen3.8-27B-Q4_0.gguf` (27B Dense — **15.23 GiB**)

| Configurazione (`-dev` / `-ts`) | Prefill `pp512` (t/s) | Gen `tg64` (t/s) | `NPU` (W) | `GPU` (W) | `CPU` (W) | **Totale `SoC` (W)** | Totale `Sistema` (W) | **Costo Gen (`J/tok`)** |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **`HTP0` (100% NPU)** | 32.67 | 5.42 | 5.94 W | 0.03 W | 6.17 W | 16.86 W | 36.66 W | 3.111 J/tok |
| **`HTP0/GPUOpenCL` (`75/25`)** | 27.81 | 5.81 (+7.2%) | 3.47 W | 5.54 W | 3.27 W | **16.73 W** | **36.65 W** | **2.880 J/tok (-7.4%)** |
| **`HTP0/GPUOpenCL` (`50/50`)** | 30.94 | **5.87 (+8.3%)** | 2.02 W | 8.70 W | 3.23 W | 18.28 W | 39.27 W | 3.114 J/tok |
| **`GPUOpenCL` (100% GPU)** | **70.95 (2.2x)** | 5.86 (+8.1%) | 0.00 W | 12.26 W | 3.19 W | 19.52 W | 41.10 W | 3.331 J/tok |

> [!IMPORTANT]
> **La soglia critica dei ~14–15 GB sul dominio FastRPC della NPU (`HTP0`):**
> * Fino a **~13 GB** (es. `LFM2.5-24B-A2B` da 12.6 GiB), il modello risiede interamente nei buffer DMA64 FastRPC della NPU Hexagon e `HTP0` vola a **802 t/s** in prefill con soli **18.2 W** di SoC.
> * Oltre **~15 GB** (`Qwen3.8-27B` da 15.2 GiB e `Qwen3.6-35B-A3B` da 19.4 GiB), il pool FastRPC della NPU satura la finestra di mappatura sessione e riversa i calcoli in fallback sulla CPU Oryon (che sul 35B MoE schizza a **41 W di sola CPU** e **88 W di sistema**, facendo crollare il prefill da ~800 t/s a **30 t/s**).
> * Su questi modelli "enormi", scaricare metà o tutto il modello sulla GPU Adreno (`-ts 50,50` o `-dev GPUOpenCL`) **elimina l'ingorgo FastRPC/CPU**, riduce il consumo del laptop di **24–28 Watt** (`88 W → 60–64 W`) e rende `GPUOpenCL` fino a **5.1 volte più veloce in prefill (`152.2 t/s`)** e **+25% più veloce in generazione (`25.3 t/s`)**!

---

### B. Fascia Media e MoE Compatti (5 GB – 13 GB): Dentro il pool DMA64 NPU

#### 1. `LFM2.5-24B-A2B-QAD-Q4_0.gguf` (24B MoE / 2B attivi — **12.64 GiB**)

| Configurazione (`-dev` / `-ts`) | Prefill `pp512` (t/s) | Gen `tg128` (t/s) | `NPU` (W) | `GPU` (W) | `CPU` (W) | **Totale `SoC` (W)** | Totale `Sistema` (W) | **Costo Gen (`J/tok`)** |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **`HTP0` (100% NPU)** | **801.98** | 38.43 | 4.05 W | 0.03 W | 10.25 W | **18.20 W** | **39.21 W** | **0.474 J/tok (Migliore)** |
| **`HTP0/GPUOpenCL` (`50/50`)** | 778.53 (-2.9%) | **41.90 (+9.0%)** | 2.14 W | 4.77 W | 10.30 W | 21.28 W | 44.77 W | 0.508 J/tok |
| **`GPUOpenCL` (100% GPU)** | 792.47 (-1.2%) | 41.82 (+8.8%) | 0.00 W | 10.76 W | 14.95 W | 30.29 W | 57.32 W | 0.724 J/tok (+53% J) |

#### 2. `Ornith-1.5-9B-Q4_0.gguf` (8.95B Dense — **5.10 GiB**)

| Configurazione (`-dev` / `-ts`) | Prefill `pp512` (t/s) | Gen `tg128` (t/s) | `SoC` in Prefill (W) | `SoC` in Gen (W) | **Energia Prefill (`J/1k tok`)** | **Costo Gen (`J/tok`)** |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| **`HTP0` (100% NPU)** | **750.87** | 15.40 | **14.89 W** | 19.94 W | **19.83 J (Migliore)** | 1.295 J/tok |
| **`HTP0/GPUOpenCL` (`75/25`)** | 594.11 (-21%) | **17.20 (+11.7%)** | — | **17.37 W** | — | **1.010 J/tok (-22% J)** |
| **`HTP0/GPUOpenCL` (`50/50`)** | 433.94 (-42%) | **17.01 (+10.5%)** | 24.52 W | 19.50 W | 56.51 J (2.85x) | 1.146 J/tok (-11.5% J) |
| **`GPUOpenCL` (100% GPU)** | 300.75 (-60%) | 17.19 (+11.6%) | 28.21 W | 21.21 W | 93.80 J (4.73x) | 1.234 J/tok |

---

### C. Fascia Leggera (< 5 GB) e Modelli `Q4_K_M`

#### 1. `Spark-X2.5-4B-Q4_K_M.gguf` (4.11B K-Quants — **2.42 GiB**)

| Configurazione (`-dev` / `-ts`) | Prefill `pp512` (t/s) | Δ Prefill vs `HTP0` | Generazione `tg128` (t/s) | Δ Gen vs `HTP0` |
| :--- | ---: | ---: | ---: | ---: |
| **`HTP0` (100% NPU)** | **1554.33** ± 11.50 | *Baseline* | **30.61** ± 0.05 | *Baseline* |
| **`HTP0/GPUOpenCL` (`75/25`)** | 807.24 ± 12.58 | -48.1% | 29.65 ± 0.35 | -3.1% |
| **`HTP0/GPUOpenCL` (`50/50`)** | 538.38 ± 16.99 | -65.4% | 28.79 ± 0.43 | -5.9% |
| **`GPUOpenCL` (100% GPU)** | 270.80 ± 23.74 | -82.6% | 25.08 ± 1.26 | -18.1% |

#### 2. `Qwen3.5-0.8B-Q4_0.gguf` (0.8B — **473 MiB**) + Scalabilità Contesto (`@ d4096`)

| Configurazione (`-dev` / `-ts`) | `pp512 @ d0` (t/s) | `tg128 @ d0` (t/s) | `pp512 @ d4096` (t/s) | `tg64 @ d4096` (t/s) | Degrado Prefill a 4k |
| :--- | ---: | ---: | ---: | ---: | ---: |
| **`HTP0` (100% NPU)** | **3796.87** | **96.47** | **3452.43** | 80.92 | **Solo -9.1%** |
| **`HTP0/GPUOpenCL` (`50/50`)** | 2815.83 | 86.33 | 1498.29 | 74.29 | -46.8% |
| **`GPUOpenCL` (100% GPU)** | 2216.31 | 92.79 | 950.89 | **84.67** | -57.1% |

---

## 2. Regola Decisionale Definitiva per Snapdragon X2 Elite

| Dimensione / Tipo Modello | Backend Ottimale | Perché |
| :--- | :--- | :--- |
| **Modelli ≤ 13 GB (`Q4_0` o `Q4_K_M`, Dense o MoE)**<br>*(es. `Qwen-0.8B`, `Spark-4B`, `Ornith-9B`, `LFM2.5-24B-A2B`)* | **`-dev HTP0`** *(100% NPU)*<br>*(oppure `-ts 75,25` solo su Dense 9B)* | Entrano interamente nel dominio FastRPC DMA64 della NPU: prefill istantaneo (**750–3800 t/s**), consumo minimo (**15–19 W SoC**) e degrado quasi nullo su contesti lunghi. |
| **Modelli Enormi > 15 GB (`Q4_0` Dense o MoE)**<br>*(es. `Qwen3.8-27B` 15.2 GB, `Qwen3.6-35B-A3B` 19.4 GB)* | **`-dev GPUOpenCL`** oppure **`-dev HTP0,GPUOpenCL -ts 50,50`** | Oltre ~14–15 GB la sessione FastRPC della sola NPU va in saturazione e scarica i calcoli sulla CPU (portando il sistema a **88 W** e tagliando il prefill a `30 t/s`). Usare `GPUOpenCL` o lo split `50,50` evita il fallback CPU, risparmia **24–28 W** e quintuplica il prefill (**152 t/s** sul 35B MoE). |
