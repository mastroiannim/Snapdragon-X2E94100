# Test del parser GGUF condiviso (inspect-gguf.ps1) e caricamento da launch-hexagon.ps1.
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$inspectScript = Join-Path $repo 'plugins\hexagon-runtime\assets\scripts\inspect-gguf.ps1'
$launchScript = Join-Path $repo 'launch-hexagon.ps1'
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('hexagon-gguf-tests-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($tempRoot)

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Write-GgufString([System.IO.BinaryWriter]$bw, [string]$value) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($value)
    $bw.Write([uint64]$bytes.Length)
    $bw.Write($bytes)
}

function Write-GgufHeader([System.IO.BinaryWriter]$bw, [uint64]$kvCount) {
    $bw.Write([System.Text.Encoding]::ASCII.GetBytes('GGUF'))
    $bw.Write([uint32]3)      # version
    $bw.Write([uint64]0)      # tensorCount
    $bw.Write($kvCount)
}

function Write-GgufKvString([System.IO.BinaryWriter]$bw, [string]$key, [string]$value) {
    Write-GgufString $bw $key
    $bw.Write([uint32]8)
    Write-GgufString $bw $value
}

function Write-GgufKvUInt32([System.IO.BinaryWriter]$bw, [string]$key, [uint32]$value) {
    Write-GgufString $bw $key
    $bw.Write([uint32]4)
    $bw.Write($value)
}

function Write-GgufKvInt32([System.IO.BinaryWriter]$bw, [string]$key, [int32]$value) {
    Write-GgufString $bw $key
    $bw.Write([uint32]5)
    $bw.Write($value)
}

function Write-GgufKvInt64([System.IO.BinaryWriter]$bw, [string]$key, [int64]$value) {
    Write-GgufString $bw $key
    $bw.Write([uint32]11)
    $bw.Write($value)
}

function Assert-ParseThrows([string]$path, [string]$label) {
    $rejected = $false
    try {
        [void][GgufModelMeta]::Parse($path)
    } catch {
        $rejected = $true
    }
    Assert-True $rejected "Malformed/truncated GGUF was silently accepted ($label)"
}

try {
    # 1. Verifica estrazione da launch-hexagon.ps1
    $launchRaw = Get-Content -LiteralPath $launchScript -Raw
    Assert-True (-not ($launchRaw -match 'public\s+class\s+GgufModelMeta')) 'launch-hexagon.ps1 must not inline GgufModelMeta'
    Assert-True ($launchRaw -match 'inspect-gguf\.ps1') 'launch-hexagon.ps1 must load inspect-gguf.ps1'

    # 2. Caricamento diretto del parser condiviso (e verifica idempotenza)
    & $inspectScript -TypeOnly
    & $inspectScript -TypeOnly
    Assert-True ($null -ne ('GgufModelMeta' -as [type])) 'GgufModelMeta type not loaded via inspect-gguf.ps1 -TypeOnly'

    # 3. Mappatura file_type
    foreach ($case in @(
        @{ FType = 7;  Expected = 'Q8_0' },
        @{ FType = 15; Expected = 'K-Quants' },
        @{ FType = 19; Expected = 'IQ-Quants' },
        @{ FType = 23; Expected = 'IQ-Quants' },
        @{ FType = 32; Expected = 'BF16' },
        @{ FType = 36; Expected = 'TQ1_0' },
        @{ FType = 37; Expected = 'TQ2_0' },
        @{ FType = 38; Expected = 'MXFP4' },
        @{ FType = 39; Expected = 'Type_39' }
    )) {
        $fixture = Join-Path $tempRoot ("ftype-" + $case.FType + ".gguf")
        $bw = New-Object System.IO.BinaryWriter([System.IO.File]::Create($fixture))
        try {
            Write-GgufHeader $bw 3
            Write-GgufKvString $bw 'general.architecture' 'qwen35'
            Write-GgufKvUInt32 $bw 'qwen35.context_length' 8192
            Write-GgufKvUInt32 $bw 'general.file_type' ([uint32]$case.FType)
        } finally { $bw.Dispose() }
        $meta = [GgufModelMeta]::Parse($fixture)
        Assert-True ($meta.Architecture -eq 'qwen35' -and $meta.ContextLength -eq 8192 -and $meta.QuantName -eq $case.Expected) `
            "GGUF parser mismatch for file_type $($case.FType): got $($meta.QuantName)"
    }

    # 4. Fixture complessa: INT32, INT64, array annidati (2 e 3 livelli) + chiavi clip.vision.* su modello qwen35
    $complexFixture = Join-Path $tempRoot 'multimodal-int32-nested.gguf'
    $bw = New-Object System.IO.BinaryWriter([System.IO.File]::Create($complexFixture))
    try {
        # 18 KV entries totali (inclusi array annidati PRIMA di alcune chiavi critiche)
        Write-GgufHeader $bw 18
        Write-GgufKvString $bw 'general.architecture' 'qwen35'
        Write-GgufKvString $bw 'general.name' 'Qwen35 Vision Test'
        Write-GgufKvInt32 $bw 'general.file_type' 15

        # Array annidato vuoto (valType=9, elemType=9, arrLen=0)
        Write-GgufString $bw 'test.nested_empty'
        $bw.Write([uint32]9); $bw.Write([uint32]9); $bw.Write([uint64]0)

        # Array annidato 2 livelli: array di array di stringhe [["alpha","beta"],["gamma"]]
        Write-GgufString $bw 'test.nested_strings'
        $bw.Write([uint32]9); $bw.Write([uint32]9); $bw.Write([uint64]2)
        $bw.Write([uint32]8); $bw.Write([uint64]2); Write-GgufString $bw 'alpha'; Write-GgufString $bw 'beta'
        $bw.Write([uint32]8); $bw.Write([uint64]1); Write-GgufString $bw 'gamma'

        # Array annidato 3 livelli: array -> array -> array -> int32
        Write-GgufString $bw 'test.nested_int32'
        $bw.Write([uint32]9); $bw.Write([uint32]9); $bw.Write([uint64]1)
        $bw.Write([uint32]9); $bw.Write([uint64]1)
        $bw.Write([uint32]5); $bw.Write([uint64]2); $bw.Write([int32]10); $bw.Write([int32]-20)

        # Chiavi modello in INT32 e INT64
        Write-GgufKvInt32 $bw 'qwen35.context_length' 131072
        Write-GgufKvInt32 $bw 'qwen35.embedding_length' 5120
        Write-GgufKvInt32 $bw 'qwen35.block_count' 40
        Write-GgufKvInt32 $bw 'qwen35.attention.head_count' 40
        Write-GgufKvInt64 $bw 'qwen35.attention.head_count_kv' 8
        Write-GgufKvInt32 $bw 'qwen35.expert_count' 64
        Write-GgufKvInt64 $bw 'qwen35.expert_used_count' 4
        Write-GgufKvInt32 $bw 'qwen35.attention.sliding_window' 512

        # Chiavi clip.vision.* (NON devono sovrascrivere qwen35.*)
        Write-GgufKvInt32 $bw 'clip.vision.context_length' 512
        Write-GgufKvInt32 $bw 'clip.vision.embedding_length' 1152
        Write-GgufKvInt32 $bw 'clip.vision.block_count' 27
        Write-GgufKvInt32 $bw 'clip.vision.attention.head_count' 16
    } finally { $bw.Dispose() }

    $meta = [GgufModelMeta]::Parse($complexFixture)
    Assert-True ($meta.Architecture -eq 'qwen35') "Architecture mismatch: $($meta.Architecture)"
    Assert-True ($meta.ModelName -eq 'Qwen35 Vision Test') "ModelName mismatch: $($meta.ModelName)"
    Assert-True ($meta.FileType -eq 15 -and $meta.QuantName -eq 'K-Quants') "INT32 file_type mismatch: $($meta.QuantName)"
    Assert-True ($meta.ContextLength -eq 131072) "INT32 context_length mismatch: $($meta.ContextLength)"
    Assert-True ($meta.EmbeddingLength -eq 5120) "clip.vision overwrote embedding_length: $($meta.EmbeddingLength)"
    Assert-True ($meta.BlockCount -eq 40) "clip.vision overwrote block_count: $($meta.BlockCount)"
    Assert-True ($meta.HeadCount -eq 40) "clip.vision overwrote head_count: $($meta.HeadCount)"
    Assert-True ($meta.HeadCountKv -eq 8) "INT64 head_count_kv mismatch: $($meta.HeadCountKv)"
    Assert-True ($meta.ExpertCount -eq 64 -and $meta.ExpertUsedCount -eq 4) "MoE INT32/INT64 mismatch"
    Assert-True ($meta.SlidingWindow -eq 512) "SlidingWindow INT32 mismatch: $($meta.SlidingWindow)"

    # 5. Fixture clip standalone (general.architecture = 'clip' + clip.vision.*)
    $clipFixture = Join-Path $tempRoot 'mmproj-clip.gguf'
    $bw = New-Object System.IO.BinaryWriter([System.IO.File]::Create($clipFixture))
    try {
        Write-GgufHeader $bw 5
        Write-GgufKvString $bw 'general.architecture' 'clip'
        Write-GgufKvInt32 $bw 'general.file_type' 1
        Write-GgufKvInt32 $bw 'clip.vision.embedding_length' 1152
        Write-GgufKvInt32 $bw 'clip.vision.block_count' 27
        Write-GgufKvInt32 $bw 'clip.vision.attention.head_count' 16
    } finally { $bw.Dispose() }
    $clipMeta = [GgufModelMeta]::Parse($clipFixture)
    Assert-True ($clipMeta.Architecture -eq 'clip' -and $clipMeta.QuantName -eq 'F16') 'clip architecture/ftype mismatch'
    Assert-True ($clipMeta.EmbeddingLength -eq 1152 -and $clipMeta.BlockCount -eq 27 -and $clipMeta.HeadCount -eq 16 -and $clipMeta.HeadCountKv -eq 16) `
        'clip.vision.* fields not parsed on clip architecture'

    # 6. Chiave <arch> prima di general.architecture + INT32 negativo ignorato
    $lateArchFixture = Join-Path $tempRoot 'late-arch.gguf'
    $bw = New-Object System.IO.BinaryWriter([System.IO.File]::Create($lateArchFixture))
    try {
        Write-GgufHeader $bw 3
        Write-GgufKvInt32 $bw 'llama.context_length' 16384
        Write-GgufKvInt32 $bw 'llama.expert_count' -1
        Write-GgufKvString $bw 'general.architecture' 'llama'
    } finally { $bw.Dispose() }
    $lateMeta = [GgufModelMeta]::Parse($lateArchFixture)
    Assert-True ($lateMeta.Architecture -eq 'llama' -and $lateMeta.ContextLength -eq 16384 -and $lateMeta.ExpertCount -eq 0) `
        'Late general.architecture or negative INT32 failed'

    # 7. File troncati / malformati / bounds check
    $badKey = Join-Path $tempRoot 'bad-key.gguf'
    $bw = New-Object System.IO.BinaryWriter([System.IO.File]::Create($badKey))
    try {
        Write-GgufHeader $bw 1
        $bw.Write([uint64]600)
    } finally { $bw.Dispose() }
    Assert-ParseThrows $badKey 'invalid key length'

    $truncHeader = Join-Path $tempRoot 'trunc-header.gguf'
    [System.IO.File]::WriteAllBytes($truncHeader, [System.Text.Encoding]::ASCII.GetBytes('GGUF' + '1234'))
    Assert-ParseThrows $truncHeader 'truncated header'

    $truncKv = Join-Path $tempRoot 'trunc-kv.gguf'
    $bw = New-Object System.IO.BinaryWriter([System.IO.File]::Create($truncKv))
    try {
        Write-GgufHeader $bw 2
        Write-GgufKvString $bw 'general.architecture' 'qwen35'
        Write-GgufString $bw 'qwen35.context_length'
        $bw.Write([uint32]4)
        # Manca il valore uint32 -> file troncato a meta' KV
    } finally { $bw.Dispose() }
    Assert-ParseThrows $truncKv 'truncated mid-KV'

    $oobArray = Join-Path $tempRoot 'oob-array.gguf'
    $bw = New-Object System.IO.BinaryWriter([System.IO.File]::Create($oobArray))
    try {
        Write-GgufHeader $bw 1
        Write-GgufString $bw 'test.oob'
        $bw.Write([uint32]9)
        $bw.Write([uint32]9)
        $bw.Write([uint64]1000000)
    } finally { $bw.Dispose() }
    Assert-ParseThrows $oobArray 'out-of-bounds nested array'

    # 8. CLI inspect-gguf.ps1 -Json (valido + troncato)
    $shell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    $cliJson = & $shell -NoProfile -ExecutionPolicy Bypass -File $inspectScript -Path $complexFixture -Json
    Assert-True ($LASTEXITCODE -eq 0) "inspect-gguf.ps1 failed on valid fixture: $cliJson"
    $cliObj = $cliJson | ConvertFrom-Json
    Assert-True ($cliObj.architecture -eq 'qwen35' -and $cliObj.context_length -eq 131072 -and $cliObj.block_count -eq 40 -and $cliObj.is_moe -eq $true) `
        "CLI JSON output mismatch: $cliJson"

    $errJson = & $shell -NoProfile -ExecutionPolicy Bypass -File $inspectScript -Path $truncKv -Json
    Assert-True ($LASTEXITCODE -ne 0) 'inspect-gguf.ps1 must exit non-zero on truncated file'
    $errObj = $errJson | ConvertFrom-Json
    Assert-True (-not [string]::IsNullOrWhiteSpace($errObj.Error)) 'inspect-gguf.ps1 must return Error JSON field'

    # 9. Integrazione launch-hexagon.ps1 (-ListOnly -Json e -Mode Router -DryRun -Json) con file troncato ignorato
    $modelsDir = Join-Path $tempRoot 'models'
    [void][IO.Directory]::CreateDirectory($modelsDir)
    Copy-Item -LiteralPath $complexFixture -Destination (Join-Path $modelsDir 'multimodal.gguf')
    Copy-Item -LiteralPath $truncKv -Destination (Join-Path $modelsDir 'broken.gguf')
    Copy-Item -LiteralPath $clipFixture -Destination (Join-Path $modelsDir 'clip-only.gguf')

    $listOut = & $shell -NoProfile -ExecutionPolicy Bypass -File $launchScript -ListOnly -Json -ModelsDir $modelsDir
    Assert-True ($LASTEXITCODE -eq 0) "launch-hexagon.ps1 -ListOnly -Json failed: $listOut"
    $listObj = ($listOut -join "`n") | ConvertFrom-Json
    Assert-True (@($listObj.models).Count -eq 2) "Expected 2 valid GGUFs (broken skipped), got $(@($listObj.models).Count)"

    $routerOut = & $shell -NoProfile -ExecutionPolicy Bypass -File $launchScript -Mode Router -DryRun -Json -ModelsDir $modelsDir
    Assert-True ($LASTEXITCODE -eq 0) "launch-hexagon.ps1 -Mode Router -DryRun -Json failed: $routerOut"
    $routerObj = ($routerOut -join "`n") | ConvertFrom-Json
    Assert-True (@($routerObj.models).Count -eq 1 -and $routerObj.models[0].alias -eq 'multimodal') 'Router preview should include only standalone valid LLM'

    # 10. Allineamento euristiche IQ-Quants (GPUOpenCL) vs MXFP4 MoE vs TQ1_0
    $heurDir = Join-Path $tempRoot 'heuristics-models'
    [void][IO.Directory]::CreateDirectory($heurDir)

    $iqFixture = Join-Path $heurDir 'test-iq3.gguf'
    $bw = New-Object System.IO.BinaryWriter([System.IO.File]::Create($iqFixture))
    try {
        Write-GgufHeader $bw 4
        Write-GgufKvString $bw 'general.architecture' 'llama'
        Write-GgufKvUInt32 $bw 'llama.context_length' 131072
        Write-GgufKvUInt32 $bw 'llama.block_count' 32
        Write-GgufKvUInt32 $bw 'general.file_type' 20
    } finally { $bw.Dispose() }

    $mxfp4Fixture = Join-Path $heurDir 'test-mxfp4-moe.gguf'
    $bw = New-Object System.IO.BinaryWriter([System.IO.File]::Create($mxfp4Fixture))
    try {
        Write-GgufHeader $bw 6
        Write-GgufKvString $bw 'general.architecture' 'qwen3moe'
        Write-GgufKvUInt32 $bw 'qwen3moe.context_length' 131072
        Write-GgufKvUInt32 $bw 'qwen3moe.block_count' 32
        Write-GgufKvUInt32 $bw 'qwen3moe.expert_count' 32
        Write-GgufKvUInt32 $bw 'qwen3moe.expert_used_count' 4
        Write-GgufKvUInt32 $bw 'general.file_type' 38
    } finally { $bw.Dispose() }

    $tq1Fixture = Join-Path $heurDir 'test-tq1.gguf'
    $bw = New-Object System.IO.BinaryWriter([System.IO.File]::Create($tq1Fixture))
    try {
        Write-GgufHeader $bw 4
        Write-GgufKvString $bw 'general.architecture' 'llama'
        Write-GgufKvUInt32 $bw 'llama.context_length' 131072
        Write-GgufKvUInt32 $bw 'llama.block_count' 32
        Write-GgufKvUInt32 $bw 'general.file_type' 36
    } finally { $bw.Dispose() }

    $heurOut = & $shell -NoProfile -ExecutionPolicy Bypass -File $launchScript -ListOnly -Json -ModelsDir $heurDir
    Assert-True ($LASTEXITCODE -eq 0) "launch-hexagon.ps1 -ListOnly -Json (heuristics) failed: $heurOut"
    $heurObj = ($heurOut -join "`n") | ConvertFrom-Json
    $iqRow = @($heurObj.models | Where-Object { $_.alias -eq 'test-iq3' })[0]
    $mxRow = @($heurObj.models | Where-Object { $_.alias -eq 'test-mxfp4-moe' })[0]
    $tqRow = @($heurObj.models | Where-Object { $_.alias -eq 'test-tq1' })[0]
    Assert-True ($iqRow.device -eq 'GPUOpenCL') "Expected IQ-Quant device GPUOpenCL, got $($iqRow.device)"
    Assert-True ($mxRow.device -eq 'HTP0,GPUOpenCL' -and $mxRow.tensor_split -eq '80,20') "Expected MXFP4 MoE HTP0,GPUOpenCL 80,20, got $($mxRow.device) $($mxRow.tensor_split)"
    Assert-True ($tqRow.device -eq 'HTP0' -and $tqRow.quantization -eq 'TQ1_0') "Expected TQ1_0 device HTP0, got $($tqRow.device) quant=$($tqRow.quantization)"

    Write-Host 'GGUF_PARSER_TESTS=PASS (INT32/INT64, nested arrays, clip.vision.*, Type_36+/MXFP4/IQ heuristics, truncation, launcher integration)'
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
