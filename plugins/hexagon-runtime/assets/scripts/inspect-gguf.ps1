<#
.SYNOPSIS
    Ispezione binaria metadati GGUF tramite classe C# GgufModelMeta.
.DESCRIPTION
    Legge l'header GGUF ed estrae architettura, context_length, expert_count,
    quantizzazione e sliding window senza caricare i tensori in memoria.
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$Path,
    [switch]$Json
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Path)) {
    $err = @{ Error = "File non trovato: $Path" }
    if ($Json) { $err | ConvertTo-Json -Compress } else { Write-Error $err.Error }
    exit 1
}

$csharpCode = @'
using System;
using System.IO;
using System.Text;

public class GgufModelMeta {
    public string Architecture = "";
    public string ModelName = "";
    public ulong ContextLength = 0;
    public ulong EmbeddingLength = 0;
    public ulong BlockCount = 0;
    public ulong HeadCount = 0;
    public ulong HeadCountKv = 0;
    public ulong ExpertCount = 0;
    public ulong ExpertUsedCount = 0;
    public ulong SlidingWindow = 0;
    public uint FileType = 0;
    public ulong FileSizeBytes = 0;
    public string QuantName = "UNKNOWN";

    public static GgufModelMeta Parse(string path) {
        GgufModelMeta m = new GgufModelMeta();
        FileInfo fi = new FileInfo(path);
        m.FileSizeBytes = (ulong)fi.Length;

        using (FileStream fs = File.OpenRead(path))
        using (BinaryReader br = new BinaryReader(fs)) {
            string magic = Encoding.ASCII.GetString(br.ReadBytes(4));
            if (magic != "GGUF") return null;
            uint version = br.ReadUInt32();
            ulong tensorCount = br.ReadUInt64();
            ulong kvCount = br.ReadUInt64();

            for (ulong i = 0; i < kvCount; i++) {
                ulong kLen = br.ReadUInt64();
                if (kLen > 500 || kLen > (ulong)(fs.Length - fs.Position))
                    throw new InvalidDataException("GGUF metadata key length invalid");
                string key = Encoding.UTF8.GetString(br.ReadBytes((int)kLen));
                uint valType = br.ReadUInt32();

                if (valType == 8) { // string
                    ulong sLen = br.ReadUInt64();
                    if (sLen > 16UL * 1024 * 1024 || sLen > (ulong)(fs.Length - fs.Position))
                        throw new InvalidDataException("GGUF metadata string length invalid");
                    string s = Encoding.UTF8.GetString(br.ReadBytes((int)sLen));
                    if (key == "general.architecture") m.Architecture = s;
                    if (key == "general.name") m.ModelName = s;
                } else if (valType == 4) { // uint32
                    uint v = br.ReadUInt32();
                    if (key == "general.file_type") m.FileType = v;
                    if (key.EndsWith(".context_length")) m.ContextLength = v;
                    if (key.EndsWith(".embedding_length")) m.EmbeddingLength = v;
                    if (key.EndsWith(".block_count")) m.BlockCount = v;
                    if (key.EndsWith(".attention.head_count")) m.HeadCount = v;
                    if (key.EndsWith(".attention.head_count_kv")) m.HeadCountKv = v;
                    if (key.EndsWith(".expert_count")) m.ExpertCount = v;
                    if (key.EndsWith(".expert_used_count")) m.ExpertUsedCount = v;
                    if (key.EndsWith(".attention.sliding_window")) m.SlidingWindow = v;
                } else if (valType == 10) { // uint64
                    ulong v = br.ReadUInt64();
                    if (key.EndsWith(".context_length")) m.ContextLength = v;
                    if (key.EndsWith(".embedding_length")) m.EmbeddingLength = v;
                    if (key.EndsWith(".block_count")) m.BlockCount = v;
                    if (key.EndsWith(".attention.head_count")) m.HeadCount = v;
                    if (key.EndsWith(".attention.head_count_kv")) m.HeadCountKv = v;
                    if (key.EndsWith(".expert_count")) m.ExpertCount = v;
                    if (key.EndsWith(".expert_used_count")) m.ExpertUsedCount = v;
                    if (key.EndsWith(".attention.sliding_window")) m.SlidingWindow = v;
                } else if (valType == 9) { // array
                    uint elemType = br.ReadUInt32();
                    ulong arrLen = br.ReadUInt64();
                    if (elemType == 0 || elemType == 1 || elemType == 7) fs.Seek((long)arrLen, SeekOrigin.Current);
                    else if (elemType == 2 || elemType == 3) fs.Seek((long)(arrLen * 2), SeekOrigin.Current);
                    else if (elemType == 4 || elemType == 5 || elemType == 6) fs.Seek((long)(arrLen * 4), SeekOrigin.Current);
                    else if (elemType == 10 || elemType == 11 || elemType == 12) fs.Seek((long)(arrLen * 8), SeekOrigin.Current);
                    else if (elemType == 8) {
                        for (ulong a = 0; a < arrLen; a++) {
                            ulong sl = br.ReadUInt64();
                            fs.Seek((long)sl, SeekOrigin.Current);
                        }
                    }
                } else if (valType == 0 || valType == 1 || valType == 7) { br.ReadByte(); }
                else if (valType == 2 || valType == 3) { br.ReadInt16(); }
                else if (valType == 5 || valType == 6) { br.ReadInt32(); }
                else if (valType == 11 || valType == 12) { br.ReadInt64(); }
                else { throw new InvalidDataException("Unsupported GGUF metadata value type " + valType); }
            }
        }
        if (m.HeadCountKv == 0 && m.HeadCount > 0) m.HeadCountKv = m.HeadCount;

        switch (m.FileType) {
            case 0: m.QuantName = "F32"; break;
            case 1: m.QuantName = "F16"; break;
            case 2: m.QuantName = "Q4_0"; break;
            case 3: m.QuantName = "Q4_1"; break;
            case 7: m.QuantName = "Q8_0"; break;
            case 8: m.QuantName = "Q5_0"; break;
            case 9: m.QuantName = "Q5_1"; break;
            case 10: case 11: case 12: case 13: case 14: case 15: case 16: case 17: case 18: case 21:
                m.QuantName = "K-Quants"; break;
            case 19: case 20: case 22: case 23: case 24: case 25: case 26: case 27: case 28: case 29: case 30: case 31:
                m.QuantName = "IQ-Quants"; break;
            case 32: m.QuantName = "BF16"; break;
            default: m.QuantName = "Type_" + m.FileType; break;
        }
        return m;
    }
}
'@

try {
    Add-Type -TypeDefinition $csharpCode -ErrorAction Stop
} catch {
    if (-not ('GgufModelMeta' -as [type])) { throw }
}

try {
    $meta = [GgufModelMeta]::Parse($Path)
    if ($null -eq $meta) {
        $err = @{ Error = "Formato GGUF non valido o file illeggibile: $Path" }
        if ($Json) { $err | ConvertTo-Json -Compress } else { Write-Error $err.Error }
        exit 1
    }

    $out = [PSCustomObject]@{
        architecture = $meta.Architecture
        model_name = $meta.ModelName
        context_length = [long]$meta.ContextLength
        embedding_length = [long]$meta.EmbeddingLength
        block_count = [long]$meta.BlockCount
        head_count = [long]$meta.HeadCount
        head_count_kv = [long]$meta.HeadCountKv
        expert_count = [long]$meta.ExpertCount
        expert_used_count = [long]$meta.ExpertUsedCount
        sliding_window = [long]$meta.SlidingWindow
        file_type = [long]$meta.FileType
        file_size_bytes = [long]$meta.FileSizeBytes
        size_gb = [math]::Round($meta.FileSizeBytes / 1GB, 2)
        quant_name = $meta.QuantName
        is_moe = ($meta.ExpertCount -gt 0)
    }

    if ($Json) {
        $out | ConvertTo-Json -Compress
    } else {
        $out
    }
    exit 0
} catch {
    $err = @{ Error = $_.Exception.Message }
    if ($Json) { $err | ConvertTo-Json -Compress } else { Write-Error $err.Error }
    exit 1
}
