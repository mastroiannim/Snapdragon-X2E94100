<#
.SYNOPSIS
    Ispezione binaria metadati GGUF tramite classe C# GgufModelMeta.
.DESCRIPTION
    Legge l'header GGUF ed estrae architettura, context_length, expert_count,
    quantizzazione e sliding window senza caricare i tensori in memoria.
#>
[CmdletBinding(DefaultParameterSetName='Inspect')]
param(
    [Parameter(Mandatory=$true, ParameterSetName='Inspect', Position=0)]
    [string]$Path,
    [Parameter(ParameterSetName='Inspect')]
    [switch]$Json,
    [Parameter(Mandatory=$true, ParameterSetName='TypeOnly')]
    [switch]$TypeOnly
)

$ErrorActionPreference = "Stop"

if (-not $TypeOnly -and -not (Test-Path -LiteralPath $Path)) {
    $err = @{ Error = "File non trovato: $Path" }
    if ($Json) { $err | ConvertTo-Json -Compress } else { Write-Error $err.Error }
    exit 1
}

$csharpCode = @'
using System;
using System.Collections.Generic;
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

    private const int MaxArrayNestingDepth = 64;
    private const ulong MaxStringLength = 16UL * 1024 * 1024;
    private static readonly string[] ArchitectureFields = new string[] {
        "context_length",
        "embedding_length",
        "block_count",
        "attention.head_count",
        "attention.head_count_kv",
        "expert_count",
        "expert_used_count",
        "attention.sliding_window"
    };

    private static ulong RemainingBytes(FileStream fs) {
        long rem = fs.Length - fs.Position;
        return rem > 0 ? (ulong)rem : 0UL;
    }

    private static void SkipBytes(FileStream fs, ulong count) {
        if (count > RemainingBytes(fs)) {
            throw new InvalidDataException("GGUF metadata extends past end of file");
        }
        fs.Seek((long)count, SeekOrigin.Current);
    }

    private static byte[] ReadExactBytes(FileStream fs, BinaryReader br, ulong len, ulong maxLen, string errorMessage) {
        if (len > maxLen || len > RemainingBytes(fs)) {
            throw new InvalidDataException(errorMessage);
        }
        byte[] data = br.ReadBytes((int)len);
        if ((ulong)data.Length != len) {
            throw new InvalidDataException("GGUF file truncated while reading string/bytes");
        }
        return data;
    }

    private static int FixedScalarSize(uint valType) {
        switch (valType) {
            case 0: case 1: case 7: return 1;
            case 2: case 3: return 2;
            case 4: case 5: case 6: return 4;
            case 10: case 11: case 12: return 8;
            default: return 0;
        }
    }

    private static void SkipString(FileStream fs, BinaryReader br) {
        ulong sl = br.ReadUInt64();
        if (sl > MaxStringLength || sl > RemainingBytes(fs)) {
            throw new InvalidDataException("GGUF metadata string length invalid");
        }
        SkipBytes(fs, sl);
    }

    private static void SkipArray(FileStream fs, BinaryReader br, int depth) {
        if (depth > MaxArrayNestingDepth) {
            throw new InvalidDataException("GGUF array nesting depth exceeded");
        }
        uint elemType = br.ReadUInt32();
        ulong arrLen = br.ReadUInt64();
        ulong remaining = RemainingBytes(fs);
        int fixedSize = FixedScalarSize(elemType);
        if (fixedSize > 0) {
            ulong size = (ulong)fixedSize;
            if (arrLen > remaining / size) {
                throw new InvalidDataException("GGUF array length exceeds remaining file size");
            }
            SkipBytes(fs, arrLen * size);
        } else if (elemType == 8) {
            if (arrLen > remaining / 8UL) {
                throw new InvalidDataException("GGUF string array length exceeds remaining file size");
            }
            for (ulong a = 0; a < arrLen; a++) {
                SkipString(fs, br);
            }
        } else if (elemType == 9) {
            if (arrLen > remaining / 12UL) {
                throw new InvalidDataException("GGUF nested array length exceeds remaining file size");
            }
            for (ulong a = 0; a < arrLen; a++) {
                SkipArray(fs, br, depth + 1);
            }
        } else {
            throw new InvalidDataException("Unsupported GGUF metadata array element type " + elemType);
        }
    }

    private static bool IsTrackedNumericKey(string key) {
        if (key == "general.file_type") return true;
        for (int i = 0; i < ArchitectureFields.Length; i++) {
            if (key.EndsWith("." + ArchitectureFields[i], StringComparison.Ordinal)) {
                return true;
            }
        }
        return false;
    }

    private static ulong ResolveField(Dictionary<string, ulong> numericKvs, string arch, string field) {
        ulong val;
        if (!string.IsNullOrEmpty(arch)) {
            if (numericKvs.TryGetValue(arch + "." + field, out val)) {
                return val;
            }
            if (string.Equals(arch, "clip", StringComparison.OrdinalIgnoreCase) &&
                numericKvs.TryGetValue("clip.vision." + field, out val)) {
                return val;
            }
            return 0;
        }
        string suffix = "." + field;
        foreach (KeyValuePair<string, ulong> entry in numericKvs) {
            if (entry.Key.EndsWith(suffix, StringComparison.Ordinal) &&
                !entry.Key.StartsWith("clip.", StringComparison.OrdinalIgnoreCase)) {
                return entry.Value;
            }
        }
        return 0;
    }

    public static GgufModelMeta Parse(string path) {
        GgufModelMeta m = new GgufModelMeta();
        FileInfo fi = new FileInfo(path);
        m.FileSizeBytes = (ulong)fi.Length;

        Dictionary<string, ulong> numericKvs = new Dictionary<string, ulong>(StringComparer.Ordinal);

        try {
            using (FileStream fs = File.OpenRead(path))
            using (BinaryReader br = new BinaryReader(fs)) {
                if (fs.Length < 4) return null;
                string magic = Encoding.ASCII.GetString(ReadExactBytes(fs, br, 4, 4, "GGUF magic header invalid"));
                if (magic != "GGUF") return null;
                if (fs.Length < 24) {
                    throw new InvalidDataException("GGUF header truncated");
                }
                uint version = br.ReadUInt32();
                if (version == 0) {
                    throw new InvalidDataException("Unsupported GGUF version 0");
                }
                ulong tensorCount = br.ReadUInt64();
                ulong kvCount = br.ReadUInt64();
                if (kvCount > RemainingBytes(fs) / 12UL) {
                    throw new InvalidDataException("GGUF metadata entry count exceeds file size");
                }

                for (ulong i = 0; i < kvCount; i++) {
                    ulong kLen = br.ReadUInt64();
                    string key = Encoding.UTF8.GetString(ReadExactBytes(fs, br, kLen, 500, "GGUF metadata key length invalid"));
                    uint valType = br.ReadUInt32();

                    if (valType == 8) { // string
                        ulong sLen = br.ReadUInt64();
                        string s = Encoding.UTF8.GetString(ReadExactBytes(fs, br, sLen, MaxStringLength, "GGUF metadata string length invalid"));
                        if (key == "general.architecture") m.Architecture = s;
                        if (key == "general.name") m.ModelName = s;
                    } else if (valType == 4) { // uint32
                        ulong v = br.ReadUInt32();
                        if (IsTrackedNumericKey(key)) numericKvs[key] = v;
                    } else if (valType == 5) { // int32
                        int v = br.ReadInt32();
                        if (v >= 0 && IsTrackedNumericKey(key)) numericKvs[key] = (ulong)v;
                    } else if (valType == 10) { // uint64
                        ulong v = br.ReadUInt64();
                        if (IsTrackedNumericKey(key)) numericKvs[key] = v;
                    } else if (valType == 11) { // int64
                        long v = br.ReadInt64();
                        if (v >= 0 && IsTrackedNumericKey(key)) numericKvs[key] = (ulong)v;
                    } else if (valType == 9) { // array
                        SkipArray(fs, br, 0);
                    } else if (valType == 0 || valType == 1 || valType == 7) {
                        SkipBytes(fs, 1);
                    } else if (valType == 2 || valType == 3) {
                        SkipBytes(fs, 2);
                    } else if (valType == 6) {
                        SkipBytes(fs, 4);
                    } else if (valType == 12) {
                        SkipBytes(fs, 8);
                    } else {
                        throw new InvalidDataException("Unsupported GGUF metadata value type " + valType);
                    }
                }
            }
        } catch (EndOfStreamException ex) {
            throw new InvalidDataException("GGUF file truncated or incomplete", ex);
        }

        ulong fileTypeVal;
        if (numericKvs.TryGetValue("general.file_type", out fileTypeVal) && fileTypeVal <= uint.MaxValue) {
            m.FileType = (uint)fileTypeVal;
        }
        m.ContextLength = ResolveField(numericKvs, m.Architecture, "context_length");
        m.EmbeddingLength = ResolveField(numericKvs, m.Architecture, "embedding_length");
        m.BlockCount = ResolveField(numericKvs, m.Architecture, "block_count");
        m.HeadCount = ResolveField(numericKvs, m.Architecture, "attention.head_count");
        m.HeadCountKv = ResolveField(numericKvs, m.Architecture, "attention.head_count_kv");
        m.ExpertCount = ResolveField(numericKvs, m.Architecture, "expert_count");
        m.ExpertUsedCount = ResolveField(numericKvs, m.Architecture, "expert_used_count");
        m.SlidingWindow = ResolveField(numericKvs, m.Architecture, "attention.sliding_window");

        if (m.HeadCountKv == 0 && m.HeadCount > 0) m.HeadCountKv = m.HeadCount;

        switch (m.FileType) {
            case 0: m.QuantName = "F32"; break;
            case 1: m.QuantName = "F16"; break;
            case 2: m.QuantName = "Q4_0"; break;
            case 3: m.QuantName = "Q4_1"; break;
            case 7: m.QuantName = "Q8_0"; break;
            case 8: m.QuantName = "Q5_0"; break;
            case 9: m.QuantName = "Q5_1"; break;
            // general.file_type uses llama_ftype, NOT ggml_type.
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

if ($TypeOnly) {
    return
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
